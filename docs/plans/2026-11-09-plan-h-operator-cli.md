# Plan H: The operator at a terminal. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three changes to manus-team. First, boards are listed with `/kanban board list [all]`, which replaces `/kanban boards` and `/kanban boards all` outright, at the same tier and with the same output. Second, whoever runs the gateway gets chat's board commands at a terminal: `mt kanban board list|create|set|archive`, and `mt kanban new|list|show|assign|link|unblock|stop|archive|comment`, with chat's semantics, built as `mt kanban gate` is: they open the board's database through `KanbanService` beside a running gateway, record who acted as `operator:<login>`, print plain text or, with `--json`, one line of JSON, and after a change ask the running gateway, over its `0600` socket, for a dispatcher pass at once. They never mix with the worker CLI a board run's agent reports through. Third, the default database file is `team.db`, not `gateway.db`, with no transition code: the file is moved by hand at deploy time.

**Architecture:**
- **The database's name** (`src/config.ts`): `$MT_HOME/team.db` unless `MT_DB` or `db:` names one; every test fixture follows.
- **Chat** (`src/kanban/chat-parse.ts`, `chat.ts`, `chat-render.ts`): the verb `board list` in place of `boards`; and the parts the terminal shares, exported: `boardSetting` (a board's setting as typed), `tooBig` (a new task's limits), `listed` (which tasks a list shows, in what order), `counted` and `runState`.
- **The board** (`src/kanban/types.ts`, `service.ts`): a task created at a terminal is created via `{ kind: 'operator' }`, which no chat follows. `db/kanban.ts` is unchanged, and stays the board's only writer.
- **The nudge** (`src/kanban/worker.ts`): `{"nudge": true}`, the one request on the worker socket that needs no token. It asks for a dispatcher pass, one per tick however many arrive, and does nothing else.
- **The dispatcher** (`src/kanban/dispatcher.ts`): each pass first cancels the turn of every run of its own that a person's action decided (`cancelled`, `superseded`), whoever made the change, so a stop or an assign made at the terminal reaches the running agent as chat's does.
- **The terminal** (`src/cli/operator.ts`, `plain.ts`, `args.ts`, `gate.ts`, `kanban.ts`, `mt.ts`): the operator's commands, their plain-text rendering, the board opening shared with `mt kanban gate`, the nudge client, and the routing that decides, from the shell's environment and the command's name, whether `mt kanban …` is the operator's or the worker's.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3, `node:util` `parseArgs`.

**Spec:** `docs/specs/2026-11-02-kanban-design.md`, which this plan's commit updates: §2.6 (the operator's commands and the database's name), §3 and §3.1 (`team.db`, `created_via`), §6.2 (the pass cancelling decided runs), §7.3 (two grammars), §9.1 and §16.3 to §16.8 (`board list`), §10 (the terminal and the nudge) and §12 (the H row). `docs/architecture.md` §3 names `team.db` from the same commit.

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on a branch `operator-cli` from `main`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, never run real bytesec, and never read or write `~/.manus-team`. No test reads the real home: each gets a made-up `MT_HOME` and `HOME`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npx vitest run --project unit` gives `Tests  1433 passed (1433)`. `npx vitest run --project e2e` gives `Tests  99 passed (99)`. `npm run typecheck` reports no errors.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text is whole lines, and appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given.
- **`db/kanban.ts` stays the board's only writer**, and every change, from chat or the terminal, goes through `KanbanService`. This plan changes neither the writer nor `src/db/WRITERS.md`.
- **Words a person sees** (replies, `mt` output, the README and the guide) never name a plan, and do not use the long dash.
- **No real agent.** No test runs bytesec. The end-to-end test runs the fake CLI agent, `tests/fakes/cli-agent.mjs`, unchanged.

## Decisions

Each has its reason. *The user's decision* marks those the user made, before this plan was written or on its first draft; every decision is now settled. The first draft's review findings are listed after the limitations, with what became of each.

1. **`/kanban board list [all]` replaces `/kanban boards [all]`.** *The user's decision.* Same tier (talk), same output, its usage line and help line under `board`. No alias: `/kanban boards` is answered as an unknown command, which points at `/kanban help`. `/kanban list` stays the task list.
2. **Chat's board commands at the terminal.** *The user's decision.* `mt kanban board list|create|set|archive`, and `mt kanban new|list|show|assign|link|unblock|stop|archive|comment`, with chat's semantics. The tiers are chat's, and whoever has a shell as the gateway's user holds operator tier: they could edit `config.yaml` anyway. Built as `mt kanban gate` is: the same `openBoard`, now shared and exported from `src/cli/gate.ts`, through `KanbanService`, WAL and the writer's busy retries, recorded as `operator:<login>`. Not offered: chat's `workspace`, a person's `done`, `block`, `review`, `approve` and `changes`, and `gate`, which the terminal has had already.
3. **No `board use`.** *The user's decision.* `mt kanban board use` is a usage error saying why. `new` and `list` take `--board <name>`, `default` unless given.
4. **`--board` on every operator command that takes a task.** *The user's decision*, on the first draft, which had it on `new` and `list` only. `show`, `assign`, `link`, `unblock`, `stop`, `archive` and `comment` take `--board <name>` too. With it, the command is refused `other_board` (`task k_… is on board default, not web-app`) unless the task is on that board, and for `link` unless both are; a board that does not exist is refused `unknown_board`, as `list` refuses one; and nothing is changed. Without it, a task on any board, by id, as chat (spec §16.4). `board set` and `board archive` name their board positionally, and are as they were. `--board` is trimmed, and a blank one is a wrong command line, exit 2, on every command.
5. **`new`'s shape.** *The user's decision*, in outline; the shape is this plan's. `mt kanban new <title words…> [--board] [--assignee] [--reviewer] [--workspace] [--parent …] [--outcome] [--verify] [--constraints] [--boundaries] [--stop-when] [--body "…" | --body-file <path|->] [--json]`. The title is every word that is not a flag, joined with spaces, as `gate add`'s command is. `--parent` may be repeated, and each may hold several ids separated by spaces or commas, as chat's `parent:`. A flag with an empty value is a usage error, as chat's empty field is refused. **The body is never read from stdin unasked:** `--body-file -` reads it, and is refused at once on a terminal, as the worker CLI refuses one; so a script's pipe is never swallowed and a terminal never waits. `--body` and `--body-file` together are a usage error. Chat's limits hold: a title of at most 512 bytes, a body of at most 64 KiB, each contract field at most 8 KiB (`tooBig`, shared with chat), and a comment at most 16 KiB.
6. **Output.** *The user's decision*: plain text by default, `--json` for scripts; exit 0 done, 1 refused, 2 a wrong command line, as `mt kanban gate`. Plain text is chat's wording without Lark markdown, every piece masked and stripped of control characters, so an escape sequence in a title cannot drive the terminal (`src/cli/plain.ts`). With `--json`, one line, `{"ok": true, …}` or `{"ok": false, "code": …, "message": …}`, every string masked by the socket's own `maskAll`, and the characters JSON leaves as they are that a terminal or a reader may act on (DEL and the C1 controls, U+007F to U+009F, U+2028, U+2029 and the bidi controls) written as `\uXXXX` (`jsonLine`). Plain text drops, before it masks, the characters that show nothing (`INVISIBLE` in `src/text.ts`: the bidi controls U+202A to U+202E and U+2066 to U+2069, the zero-width characters U+200B to U+200D and U+FEFF, and the marks U+200E, U+200F and U+061C), as it drops control characters, so an override cannot make a line read as something it is not and a secret split by one is still masked; and it makes U+2028 and U+2029 line breaks. The masker itself matches past those characters too (Review follow-ups, item 1). A wrong command line is said on stderr with the usage, exit 2, with or without `--json`: it is found before the flags are read. `list` prints every task, not chat's first 30.
7. **The grammar: whose `mt kanban <command>` it is.** The worker's names are `show|complete|review|changes|block|comment|create|link`; three of them, `show`, `comment` and `link`, are the operator's too. `src/cli/mt.ts` decides:
   - `complete`, `review`, `changes`, `block` and `create` are always the worker's; outside a run they answer `not_in_a_run` in JSON, as today.
   - `gate`, `board`, `new`, `list`, `assign`, `unblock`, `stop` and `archive` are always the operator's.
   - `show`, `comment` and `link`, and any name neither has, are the worker's in a board run's shell (`MT_KANBAN_RUN` or `MT_KANBAN_TOKEN` set, as `mt kanban gate` already reads it), and the operator's elsewhere.

   And the shapes never overlap: the worker's commands take no arguments and read JSON on stdin, the operator's `show`, `comment` and `link` always take a task id. So in a run's shell `mt kanban show k_1` is the worker's `bad_request`, exit 2, never the operator's show; and outside one `mt kanban show` is a usage error, never the worker's. An agent always gets the worker's JSON for a name it might mean.
8. **The operator's commands refuse to run in a board run's shell.** *The user's decision*, as recommended: as `mt kanban gate` does today, with the same message, exit 1, before the database is opened, and, since the review, before the command line is parsed or stdin read: `mt.ts` checks for a run's shell first, so an agent gets the refusal whatever it typed (in JSON when `--json` is among its words). An agent runs as the gateway's user, with a shell, so it can reach these commands; refusing them where the run's variables are set stops an agent acting as the operator by accident, outside its token's scope (spec §7.2). It is not a security boundary, and the plan says so (Known limitations); it is not one for `gate` today either. Allowing them would make every agent an operator for the asking.
9. **The nudge.** *The user's decision*: a request that only triggers `pass()`, needs no token, and is harmless. It is exactly `{"nudge": true}`, one line on `$MT_HOME/run/kanban.sock` (or the socket's fallback path, computed by the same `workerSocketPath`), answered `{"ok": true}`; any other shape is an ordinary request and refused `bad_request` as today. It is handled in `WorkerApi.handle`, before the token, and calls the API's `changed`, which the gateway already wires to `dispatcher.pass()`, throttled: a nudge's pass runs on the next tick, and at most one runs in each 100 ms (`NUDGE_INTERVAL_MS`); a nudge inside that window brings one more pass at its end, which every later nudge in the window shares, so the last nudge is never lost and a loop of them runs ten passes a second at most. (The first draft said a burst asked for one pass on the next tick; nudges from the socket arrive on separate ticks, so each got its own. The review changed it.) A pass still waiting is dropped when the gateway stops. Harmless because it names nothing, carries nothing and changes nothing, and a pass is what the sweep does every `sweep_interval_s` anyway; and only the gateway's user can connect (`0600` in a `0700` directory). The CLI waits up to 2 s for the answer.
10. **Which changes nudge.** *The user's decision*, as recommended: those chat follows with the dispatcher's pass: `new`, `assign`, `unblock`, `stop`, `archive` and `board set`. Not `link`, `comment`, `board create` or `board archive`, which make nothing claimable and decide no run. So "the same semantics as chat" is literal. With `--json` the answer carries `"nudged": true|false`.
11. **When no gateway answers**, the change stands, `mt` exits 0, and says on stderr: `mt: no gateway answered at <socket> (<why>); the change stands, and running the command again would make it twice: a running gateway acts on it at its next sweep, and a stopped one when it next starts`. `<why>` never says to try again: `ENOENT; is the gateway running?`, or for a refused or dropped connection `ECONNREFUSED; it may be busy, or stopped`. **When the board is off** (the config does not set `kanban.enabled`, or sets it to false, which `loadTeamSettings` now reads as `kanbanEnabled`, absent when unset), no gateway is asked and none would sweep, so `mt` says instead: `mt: the board is off on this gateway (its config does not set kanban.enabled): the change is recorded, and nothing runs it until the board is turned on and the gateway restarted`, with `sets kanban.enabled to false` in place of `does not set kanban.enabled` when it is false; `--json` says `"nudged": false`.
12. **A pass cancels the turns of runs a person's action decided.** *The user's decision*, as recommended. Chat cancels the turn of an agent run its `assign`, `stop` or `archive` decided by calling `dispatcher.cancel()` in process; a terminal cannot. So each `pass()` first cancels, through the same `cancel()`, every run this process started that is not being cancelled yet and whose outcome is `cancelled` or `superseded` (`SUPERSEDING_OUTCOMES`). The nudge brings that pass at once, and the sweep within `sweep_interval_s` if the nudge was lost. A run that decided itself, by its report, ends its own turn and is left alone, and so is one already closing. Each run's cancel is caught and noted, so one failure never ends the pass; a cancel that failed after marking the run is sent by the next sweep, as one made while an agent was still starting is. Chosen over a nudge naming the run to cancel, which would be more than "nothing but a pass", and over leaving the agent working until `max_runtime_s`, holding its workspace and its slot. The review's dry run showed it is needed: without it the end-to-end stop waits on its agent for ever.
13. **A task created at a terminal** is created via `{ kind: 'operator' }`, a third `CreatedVia` shape the service accepts (with no other field), so the writer subscribes no chat to it. Its creator is `operator:<login>`. A chat's idempotency key (`lark:…`) is refused for it, as for a run.
14. **No people from the terminal.** *The user's decision*, as recommended: `assign`, `--assignee` and `--reviewer` take a role; a person (`@Name` or `lark:<union_id>`) is refused `person_not_assignable`, saying to use chat. Being assigned needs talk tier (spec §4.2), which is decided by the gateway's Lark allowlist; the terminal, like `mt kanban gate`, reads no Lark settings. Chosen over loading the gateway's whole config, which needs its Lark secret in the shell, and over taking the operator's word for it.
15. **The service the terminal builds** is the gateway's: its roles and workspaces, from the shell's config, and `supervisedRoles: true`, so a supervised role is accepted as chat accepts it. `mt kanban gate`'s service gets the same; it changes nothing for gates.
16. **Shared, not copied.** The parsing, validation and rendering choices are chat's own functions: `boardSetting`, `tooBig`, `isPerson` and `LIST_FILTERS` from `chat-parse.ts`; `listed`, `counted` and `runState` from `chat-render.ts`. Only the words and the markup differ: chat's are Lark markdown, the terminal's plain text.
17. **The database is `team.db`.** *The user's decision*, with no transition code. Nothing else keys on the file's name: the gateway's lock is `$MT_HOME/run/gateway.pid` and its socket `$MT_HOME/run/kanban.sock`, both named by the home; the `mt` commands find the database by the gateway's own rule (`MT_DB`, else `db:`, else `$MT_HOME/team.db`, `loadTeamSettings`); `MT_DB` and `db:` name a file and are untouched, so a deployment that sets either keeps its file and must not move it; the backups are named by hand (`gateway-v5.db` from the boards' smoke test, `gateway-pre-rename.db` below); `.gitignore` ignores `*.db`. The plans already written keep `gateway.db`, as history.
18. **A title is one line.** `mt kanban new` refuses, as a wrong command line, a title holding a line break, U+2028, U+2029, any other control character or a bidi control, rather than changing it silently, checked on the joined words before they are trimmed, so a trailing newline or a leading tab is refused too: chat's title is a single line by construction, and a script that passes a multi-line title has a bug it should hear about. `tooBig` then checks its size.
19. **A body file is a regular file.** `--body-file <path>` refuses a directory, a device such as `/dev/null`, and a FIFO, which could block or never end, before reading; its size is checked before it is read. `-` is stdin, read with the 64 KiB cap.
20. **The command line's parts in one module.** `UsageError`, `parse`, `refuse` and `table` move from `mt.ts` to `src/cli/args.ts`, which imports nothing of `mt`'s at run time, and `gate.ts`, `role.ts`, `workspace.ts`, `plain.ts` and `operator.ts` import them from there; `mt.ts` is imported only for types. So `mt.ts` → `operator.ts` → `plain.ts` → `mt.ts`, and the older `mt.ts` → `gate.ts` → `mt.ts`, are no longer cycles.

## Known limitations

- **Not a security boundary.** The operator's commands, like `mt kanban gate`, refuse a board run's shell by its variables. An agent runs as the gateway's user: it could unset `MT_KANBAN_RUN` and `MT_KANBAN_TOKEN`, run them, or open `team.db` with `sqlite3` itself. The boundary between users is the file's and the socket's owner, as before.
- **No chat follows a task created at a terminal**: nobody hears its notices, and a supervised role's approval requests on it reach nobody, as for any task no chat follows. `mt kanban show` and `list` are how to watch it.
- **No people from the terminal** (Decision 14).
- **No idempotency key on `mt kanban new`**: a script that retries a `new` whose answer it lost makes a second task.
- **No `workspace`, and no person's reports, at the terminal** (Decision 2).
- **A run decided at the terminal while no gateway answers** has its turn cancelled at the gateway's next sweep, within `kanban.sweep_interval_s`.
- **A stop, an assign or an archive from the terminal of a task whose run has already reported** leaves that run's turn to end by itself: the pass cancels only runs a person's action decided (`cancelled`, `superseded`), and such a run keeps its own outcome. Chat's commands cancel it. The run closes when its agent's turn ends, which `stop`'s reply says.
- **Masking at the terminal** uses the secrets that shell knows: every role's values, and the Lark app secret if `LARK_APP_SECRET` is set there. A `passEnv` name unset in the shell is said to be unmasked.
- **The nudge runs a pass in the gateway's process**, at most one in each 100 ms however many arrive (Decision 9); a same-user process could still connect in a loop and keep it at that rate, as it could stop the gateway outright.
- **A flaky gate test.** `tests/kanban-gates.e2e.ts`, "stops a gate when the gateway stops, keeping what it wrote", failed once under load during the first draft's review. It was not reproduced here (twelve runs of it beside two concurrent unit runs all passed), and the failing assertion was not recorded, so no fix is added: loosening one of its five assertions blind could hide a real fault. If it fails again, note which assertion: its signal check (`SIGTERM`, or exit 143) would fail if the shell were only killed by the `SIGKILL` 2 s later.

## Review of the first draft

An independent dry run of the first draft confirmed every quoted text and every count, and that Task 6 is needed. Its findings, and what became of each:

| Finding | Outcome |
|---|---|
| A start before the deploy's `mv` makes an empty `team.db`, whose leftover `-wal` would be replayed into the moved file | The deploy warns, before step 1, not to start the new build or let a service manager restart the old one until step 3 is done; step 3 changes to the home and stops if any `team.db`, `team.db-wal` or `team.db-shm` exists |
| `#cancelDecided` could throw out of `pass()`, and cancelled runs already closing | Each run's cancel is caught and noted, runs already closing are skipped; a test makes the cancel throw (Task 6) |
| The limitation on runs that had already reported named archive only; `stop`'s reply said "it is being closed" | The limitation covers stop, assign and archive; the reply says "it closes when its agent's turn ends" (Task 10) |
| With the board off, the no-answer message promised a sweep that never comes | `kanbanEnabled` is read, and the board's being off is said instead (Decision 11, Task 9) |
| `--board` was not trimmed everywhere; `board list ALL` was refused | `boardFlag` trims it and refuses a blank one on every command; `all` is read in any case (Tasks 9 and 10) |
| A title could hold a newline or a control character | Refused as a wrong command line (Decision 18, Task 10) |
| Bidi controls in plain text; C1 controls, U+2028, U+2029 and bidi controls in JSON | Dropped from plain text; escaped in JSON by `jsonLine`; both tested (Decision 6, Tasks 8 and 9) |
| The README said `operator:<your login>` | It says the login of the account the command runs as, the service account under `sudo -u` (Task 12) |
| `--body-file` would read a FIFO or a device | Refused unless a regular file; tested with a directory, `/dev/null` and a FIFO (Decision 19, Task 10) |
| `mt.ts` → `operator.ts` → `plain.ts` → `mt.ts` was a cycle | `src/cli/args.ts` (Decision 20, Task 7) |
| A flood of nudges ran a pass each | Coalesced to one per tick (Decision 9, Task 5); throttled to one in each 100 ms after the review (Review follow-ups, item 3) |
| `tests/kanban-gates.e2e.ts` failed once under load | Not reproduced; recorded, not changed (Known limitations) |

## File map

| File | Responsibility |
|---|---|
| `src/config.ts`, `config.example.yaml` (modify) | `$MT_HOME/team.db`; `TeamSettings.kanbanEnabled` |
| `src/kanban/chat-parse.ts` (modify) | `board list` in place of `boards`; `BoardSetting`, `boardSetting`, `tooBig` |
| `src/kanban/chat.ts` (modify) | `board list`'s tier and answer; `tooBig` |
| `src/kanban/chat-render.ts` (modify) | the help line; `listed`, `counted`, `runState` exported |
| `src/kanban/service.ts`, `src/db/kanban-read.ts` (modify) | `{ kind: 'operator' }` accepted; comments naming `board list` |
| `src/kanban/types.ts` (modify) | `CreatedVia`'s operator shape; `SUPERSEDING_OUTCOMES` exported |
| `src/kanban/worker.ts` (modify) | `NUDGE`, answered before the token, its passes one per tick |
| `src/kanban/dispatcher.ts` (modify) | `#cancelDecided` at the start of each pass, which never throws |
| `src/kanban/socket.ts` (modify) | `maskAll` exported |
| `src/cli/args.ts` (create) | `UsageError`, `parse`, `refuse`, `table`, moved from `mt.ts` |
| `src/cli/role.ts`, `src/cli/workspace.ts` (modify) | import them from `args.ts` |
| `src/cli/plain.ts` (create) | the board as plain text: `boardsText`, `listText`, `showText`, `line`, `who`, `BIDI` |
| `src/cli/gate.ts` (modify) | `inBoardRun`, `openBoard`, `withBoard` shared, with the refusal's form and the unset note given, and `kanbanEnabled` |
| `src/cli/kanban.ts` (modify) | `ask` with a timeout, and `why`, exported |
| `src/cli/operator.ts` (create) | the operator's commands, `nudgeGateway`, `jsonLine`, `boardFlag` |
| `src/cli/mt.ts` (modify) | whose command it is; the usage; its helpers from `args.ts` |
| `README.md`, `docs/kanban-guide.md` (modify) | `board list`, `team.db`, the terminal |
| `tests/config.test.ts`, `tests/gateway-startup.test.ts`, `tests/helpers/db.ts`, `tests/kanban-boards-schema.test.ts`, `tests/mt-gate.test.ts`, `tests/mt-role.test.ts`, `tests/mt-workspace.test.ts`, `tests/workspace-registry.test.ts`, `tests/workspaces.test.ts` (modify) | `team.db` |
| `tests/kanban-board-chat-parse.test.ts`, `tests/kanban-board-chat.test.ts` (modify) | `board list` |
| `tests/kanban-command-parts.test.ts`, `tests/kanban-operator-created.test.ts`, `tests/kanban-worker-nudge.test.ts`, `tests/kanban-cancel-decided.test.ts`, `tests/mt-plain.test.ts`, `tests/mt-kanban-operator.test.ts`, `tests/mt-kanban-operator-tasks.test.ts`, `tests/mt-operator.e2e.ts` (create) | |

Running counts, unit then end to end: Task 1 1433 / 99, Task 2 1434 / 99, Task 3 1438 / 99, Task 4 1440 / 99, Task 5 1444 / 99, Task 6 1447 / 99, Task 7 1447 / 99, Task 8 1451 / 99, Task 9 1462 / 99, Task 10 1475 / 99, Task 11 1475 / 101, Task 12 1475 / 101, the review follow-ups 1512 / 101.

---

### Task 1: The database is team.db

**Files:**
- Modify: `src/config.ts`, `config.example.yaml`, `tests/config.test.ts`, `tests/gateway-startup.test.ts`, `tests/helpers/db.ts`, `tests/kanban-boards-schema.test.ts`, `tests/mt-gate.test.ts`, `tests/mt-role.test.ts`, `tests/mt-workspace.test.ts`, `tests/workspace-registry.test.ts`, `tests/workspaces.test.ts`

The default file becomes `$MT_HOME/team.db` (Decision 17). The tests that name the file are renamed with it; those that put a database in an `mt` fixture's home fail until the default moves, since `mt` finds it by the gateway's rule. No count changes.

- [ ] **Step 1.1: Change the tests.**

In `tests/config.test.ts`, replace:

```ts
    expect(cfg.dbPath).toBe(join(HOME, 'gateway.db'));
```

with:

```ts
    expect(cfg.dbPath).toBe(join(HOME, 'team.db'));
```

In `tests/config.test.ts`, replace:

```ts
    expect(cfg.dbPath).toBe(join(dir, 'gateway.db'));
```

with:

```ts
    expect(cfg.dbPath).toBe(join(dir, 'team.db'));
```

In `tests/config.test.ts`, replace:

```ts
      dbPath: '/srv/mt/gateway.db',
```

with:

```ts
      dbPath: '/srv/mt/team.db',
```

In `tests/gateway-startup.test.ts`, replace:

```ts
    MT_DB: join(home, 'gateway.db'),
```

with:

```ts
    MT_DB: join(home, 'team.db'),
```

In `tests/helpers/db.ts`, replace:

```ts
  const db = openDb(join(dir, 'gateway.db'));
```

with:

```ts
  const db = openDb(join(dir, 'team.db'));
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
  const d = openDb(join(dir, 'gateway.db'));
```

with:

```ts
  const d = openDb(join(dir, 'team.db'));
```

In `tests/mt-gate.test.ts`, replace:

```ts
  gateway = openDb(join(f.home, 'gateway.db'));
```

with:

```ts
  gateway = openDb(join(f.home, 'team.db'));
```

In `tests/mt-gate.test.ts`, replace:

```ts
      err: `mt: there is no board at ${join(f.home, 'gateway.db')}: the gateway creates its database when it first starts`,
```

with:

```ts
      err: `mt: there is no board at ${join(f.home, 'team.db')}: the gateway creates its database when it first starts`,
```

In `tests/mt-gate.test.ts`, replace:

```ts
  it("writes beside the gateway's reads, which see it at once", () => {
    const shell = openDb(join(f.home, 'gateway.db'));
    try {
```

with:

```ts
  it("writes beside the gateway's reads, which see it at once", () => {
    const shell = openDb(join(f.home, 'team.db'));
    try {
```

In `tests/mt-gate.test.ts`, replace:

```ts
    const shell = openDb(join(f.home, 'gateway.db'));
```

with:

```ts
    const shell = openDb(join(f.home, 'team.db'));
```

In `tests/mt-role.test.ts`, replace:

```ts
    fx = mtFixture();
    const db = openDb(join(fx.home, 'gateway.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['researcher', '/elsewhere']]), 0);
```

with:

```ts
    fx = mtFixture();
    const db = openDb(join(fx.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['researcher', '/elsewhere']]), 0);
```

In `tests/mt-role.test.ts`, replace:

```ts
    const dbPath = join(fx.root, 'gateway.db');
```

with:

```ts
    const dbPath = join(fx.root, 'team.db');
```

In `tests/mt-role.test.ts`, replace:

```ts
    const db = openDb(join(fx.home, 'gateway.db'));
```

with:

```ts
    const db = openDb(join(fx.home, 'team.db'));
```

In `tests/mt-workspace.test.ts`, replace:

```ts
    fx = mtFixture();
    const db = openDb(join(fx.home, 'gateway.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['docs', '/elsewhere']]), 0);
```

with:

```ts
    fx = mtFixture();
    const db = openDb(join(fx.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['docs', '/elsewhere']]), 0);
```

In `tests/mt-workspace.test.ts`, replace:

```ts
    const db = openDb(join(fx.home, 'gateway.db'));
```

with:

```ts
    const db = openDb(join(fx.home, 'team.db'));
```

In `tests/workspace-registry.test.ts`, replace:

```ts
      const path = join(dir, 'gateway.db');
      expect(registrationsAt(path)).toEqual(new Map());
```

with:

```ts
      const path = join(dir, 'team.db');
      expect(registrationsAt(path)).toEqual(new Map());
```

In `tests/workspace-registry.test.ts`, replace:

```ts
    expect(registrationsAt(join(t.dir, 'gateway.db'))).toEqual(new Map([['default', '/srv/a']]));
```

with:

```ts
    expect(registrationsAt(join(t.dir, 'team.db'))).toEqual(new Map([['default', '/srv/a']]));
```

In `tests/workspace-registry.test.ts`, replace:

```ts
      const path = join(dir, 'gateway.db');
```

with:

```ts
      const path = join(dir, 'team.db');
```

In `tests/workspaces.test.ts`, replace:

```ts
  db = join(home, 'gateway.db');
```

with:

```ts
  db = join(home, 'team.db');
```

In `tests/workspaces.test.ts`, replace:

```ts
    const r = resolveWorkspaces({ default: link }, join(link, 'not-yet-home'), join(link, 'not-yet-home', 'gateway.db'));
```

with:

```ts
    const r = resolveWorkspaces({ default: link }, join(link, 'not-yet-home'), join(link, 'not-yet-home', 'team.db'));
```

In `tests/workspaces.test.ts`, replace:

```ts
    const otherDb = join(elsewhere, 'gateway.db');
```

with:

```ts
    const otherDb = join(elsewhere, 'team.db');
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/config.test.ts tests/mt-gate.test.ts tests/mt-role.test.ts tests/mt-workspace.test.ts`. Expected: `Tests  13 failed | 130 passed (143)`: the default is still `gateway.db`, so `mt` finds no board, and no registered workspace, in the fixture's home.

- [ ] **Step 1.3: Implement.**

In `src/config.ts`, replace:

```ts
    dbPath: envString(env, 'MT_DB') ?? file.db ?? join(home, 'gateway.db'),
```

with:

```ts
    dbPath: envString(env, 'MT_DB') ?? file.db ?? join(home, 'team.db'),
```

In `config.example.yaml`, replace:

```yaml
# db: /var/lib/manus-team/gateway.db
```

with:

```yaml
# db: /var/lib/manus-team/team.db
```

- [ ] **Step 1.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1433 passed (1433)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors. Run `git grep -n "gateway\.db" -- src tests config.example.yaml README.md`. Expected: only `tests/gateway-startup.test.ts`'s three uses of `gateway.db`, the gateway's database property, which is not a file name.

- [ ] **Step 1.5: Commit.**

```bash
git add src/config.ts config.example.yaml tests/config.test.ts tests/gateway-startup.test.ts tests/helpers/db.ts tests/kanban-boards-schema.test.ts tests/mt-gate.test.ts tests/mt-role.test.ts tests/mt-workspace.test.ts tests/workspace-registry.test.ts tests/workspaces.test.ts
git commit -m "Call the gateway's database team.db by default, in the configuration, its example and every test that names the file; MT_DB and db: still name any file"
```

---

### Task 2: /kanban board list

**Files:**
- Modify: `src/kanban/chat-parse.ts`, `src/kanban/chat.ts`, `src/kanban/chat-render.ts`, `src/kanban/service.ts`, `src/db/kanban-read.ts`, `tests/kanban-board-chat-parse.test.ts`, `tests/kanban-board-chat.test.ts`

`board list [all]` takes `boards [all]`'s place, with its tier and its output (Decision 1). `boards` becomes an unknown command.

- [ ] **Step 2.1: Change the tests.**

In `tests/kanban-board-chat-parse.test.ts`, replace:

```ts
/** `/kanban boards` and `/kanban board …` as typed (spec §16). */

describe('parseKanban: boards', () => {
  it('reads /kanban boards, with all for the archived ones too', () => {
    expect(parseKanban('boards')).toEqual({ ok: true, command: { verb: 'boards', archived: false } });
    expect(parseKanban('Boards ALL')).toEqual({ ok: true, command: { verb: 'boards', archived: true } });
    expect(parseKanban('boards web-app')).toEqual({ ok: false, usage: `Usage: \`${USAGE.boards}\`` });
```

with:

```ts
/** `/kanban board …` as typed (spec §16). */

describe('parseKanban: boards', () => {
  it('reads /kanban board list, with all for the archived ones too', () => {
    expect(parseKanban('board list')).toEqual({ ok: true, command: { verb: 'board list', archived: false } });
    expect(parseKanban('Board LIST ALL')).toEqual({ ok: true, command: { verb: 'board list', archived: true } });
    expect(parseKanban('board list web-app')).toEqual({ ok: false, usage: `Usage: \`${USAGE['board list']}\`` });
  });

  it('no longer knows /kanban boards: board list replaced it', () => {
    expect(parseKanban('boards')).toEqual({ ok: false, usage: 'Unknown `/kanban` command `boards`. `/kanban help` lists them.' });
    expect(parseKanban('boards all')).toEqual({ ok: false, usage: 'Unknown `/kanban` command `boards`. `/kanban help` lists them.' });
```

In `tests/kanban-board-chat.test.ts`, replace:

```ts
 * Boards in chat (spec §16): `/kanban boards` and `/kanban board …`, each chat
```

with:

```ts
 * Boards in chat (spec §16): `/kanban board list` and the rest of `/kanban board …`, each chat
```

In `tests/kanban-board-chat.test.ts`, replace:

```ts
describe('/kanban boards and /kanban board create', () => {
  it('lists default, and the boards an operator creates, marking this chat’s', async () => {
    expect(await say('boards')).toBe(
```

with:

```ts
describe('/kanban board list and /kanban board create', () => {
  it('lists default, and the boards an operator creates, marking this chat’s', async () => {
    expect(await say('board list')).toBe(
```

In `tests/kanban-board-chat.test.ts`, replace:

```ts
    expect((await say('boards', TEAM, GUEST)).split('\n').slice(0, 2)).toEqual(['**default** (this chat): no tasks', '**web-app**: no tasks']);
```

with:

```ts
    expect((await say('board list', TEAM, GUEST)).split('\n').slice(0, 2)).toEqual(['**default** (this chat): no tasks', '**web-app**: no tasks']);
```

In `tests/kanban-board-chat.test.ts`, replace:

```ts
    expect((await say('boards')).split('\n')[1]).toBe('**web-app**: no tasks · workspace web');
```

with:

```ts
    expect((await say('board list')).split('\n')[1]).toBe('**web-app**: no tasks · workspace web');
```

In `tests/kanban-board-chat.test.ts`, replace:

```ts
    expect((await say('boards')).split('\n')[1]).toBe('**web-app** (archived, this chat): no tasks');
    expect(await say('boards', OTHER)).not.toContain('**web-app**');
    expect((await say('boards all', OTHER)).split('\n')[1]).toBe('**web-app** (archived): no tasks');
```

with:

```ts
    expect((await say('board list')).split('\n')[1]).toBe('**web-app** (archived, this chat): no tasks');
    expect(await say('board list', OTHER)).not.toContain('**web-app**');
    expect((await say('board list all', OTHER)).split('\n')[1]).toBe('**web-app** (archived): no tasks');
```

In `tests/kanban-board-chat.test.ts`, replace:

```ts
    expect(help).toContain('`/kanban boards [all]` (anyone allowed)');
```

with:

```ts
    expect(help).toContain('`/kanban board list [all]` (anyone allowed)');
    expect(help).not.toContain('/kanban boards');
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-board-chat-parse.test.ts tests/kanban-board-chat.test.ts`. Expected: `Tests  6 failed | 8 passed (14)`.

- [ ] **Step 2.3: Implement.**

In `src/kanban/chat-parse.ts`, replace:

```ts
  | { verb: 'boards'; archived: boolean }
```

with:

```ts
  | { verb: 'board list'; archived: boolean }
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  boards: '/kanban boards [all]',
```

with:

```ts
  'board list': '/kanban board list [all]',
```

In `src/kanban/chat-parse.ts`, replace:

```ts
    case 'boards': {
      const w = words(rest, 0) ?? words(rest, 1);
      const all = w?.[0]?.toLowerCase();
      if (w === undefined || (all !== undefined && all !== 'all')) return usage('boards');
      return { ok: true, command: { verb: 'boards', archived: all === 'all' } };
    }
    case 'board':
```

with:

```ts
    case 'board':
```

In `src/kanban/chat-parse.ts`, replace:

```ts
 * `/kanban board create|use|archive <name>`, and `/kanban board set <name>` with
 * `max_running <number|none>` or `workspace <workspace|none>` (spec §16).
```

with:

```ts
 * `/kanban board list [all]`, `/kanban board create|use|archive <name>`, and
 * `/kanban board set <name>` with `max_running <number|none>` or
 * `workspace <workspace|none>` (spec §16).
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  const sub = rawSub.toLowerCase();
  if (sub === 'create' || sub === 'use' || sub === 'archive') {
```

with:

```ts
  const sub = rawSub.toLowerCase();
  if (sub === 'list') {
    const w = words(rest, 0) ?? words(rest, 1);
    const all = w?.[0]?.toLowerCase();
    if (w === undefined || (all !== undefined && all !== 'all')) return usage('board list');
    return { ok: true, command: { verb: 'board list', archived: all === 'all' } };
  }
  if (sub === 'create' || sub === 'use' || sub === 'archive') {
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  const verbs = (['board create', 'board use', 'board set', 'board archive'] as const).map((v) => `\`${USAGE[v]}\``);
```

with:

```ts
  const verbs = (['board list', 'board create', 'board use', 'board set', 'board archive'] as const).map((v) => `\`${USAGE[v]}\``);
```

In `src/kanban/chat.ts`, replace:

```ts
  boards: 'talk',
```

with:

```ts
  'board list': 'talk',
```

In `src/kanban/chat.ts`, replace:

```ts
      case 'boards': {
```

with:

```ts
      case 'board list': {
```

In `src/kanban/chat-render.ts`, replace:

```ts
    [USAGE.boards, talk],
```

with:

```ts
    [USAGE['board list'], talk],
```

In `src/kanban/chat-render.ts`, replace:

```ts
 * `/kanban boards` (spec §16): each board, its tasks by phase, its own
```

with:

```ts
 * `/kanban board list` (spec §16): each board, its tasks by phase, its own
```

In `src/kanban/service.ts`, replace:

```ts
  /** The boards, with their tasks by phase: `/kanban boards`. `including`: a chat's own board, archived or not. */
```

with:

```ts
  /** The boards, with their tasks by phase: `/kanban board list`. `including`: a chat's own board, archived or not. */
```

In `src/db/kanban-read.ts`, replace:

```ts
/** A board, and how many of its tasks are in each phase: what `/kanban boards` shows. */
```

with:

```ts
/** A board, and how many of its tasks are in each phase: what `/kanban board list` shows. */
```

- [ ] **Step 2.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1434 passed (1434)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.5: Commit.**

```bash
git add src/kanban/chat-parse.ts src/kanban/chat.ts src/kanban/chat-render.ts src/kanban/service.ts src/db/kanban-read.ts tests/kanban-board-chat-parse.test.ts tests/kanban-board-chat.test.ts
git commit -m "List the boards with /kanban board list, which replaces /kanban boards at the same tier and with the same answer, so every board command is under board"
```

---

### Task 3: The parts chat and the terminal share

**Files:**
- Create: `tests/kanban-command-parts.test.ts`
- Modify: `src/kanban/chat-parse.ts`, `src/kanban/chat.ts`, `src/kanban/chat-render.ts`

Chat's validation and its list's choices, exported so the terminal uses them rather than copies (Decision 16): a board's setting as typed, a new task's limits, which tasks a list shows and in what order, a board's counts, and a run's state. Chat's behaviour is unchanged, and its tests prove it.

- [ ] **Step 3.1: Write the failing tests.**

Create `tests/kanban-command-parts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { boardSetting, tooBig } from '../src/kanban/chat-parse.js';
import { listed } from '../src/kanban/chat-render.js';
import type { BoardEntry } from '../src/db/kanban-read.js';
import type { DisplayStatus } from '../src/kanban/status.js';
import { WORKER_LIMITS } from '../src/kanban/worker.js';

/**
 * The parts of a `/kanban` command that chat and the terminal share: a board's
 * setting, a new task's limits, and which tasks a list shows, in what order.
 */

describe('boardSetting', () => {
  it('reads max_running as a whole number from 1, or none, and workspace as a name, or none', () => {
    expect(boardSetting('max_running', '2')).toEqual({ maxRunning: 2 });
    expect(boardSetting('MAX_RUNNING', 'None')).toEqual({ maxRunning: null });
    expect(boardSetting('workspace', 'web')).toEqual({ workspace: 'web' });
    expect(boardSetting('Workspace', 'NONE')).toEqual({ workspace: null });
    for (const [setting, value] of [
      ['max_running', '0'],
      ['max_running', '01'],
      ['max_running', 'two'],
      ['max_running', '99999999999999999999'],
      ['colour', 'blue'],
    ] as const) {
      expect(boardSetting(setting, value)).toBeUndefined();
    }
  });
});

describe('tooBig', () => {
  it('says which part of a new task is over its limit, the field named as the caller says', () => {
    const fits = { title: 't', body: 'b', contract: { outcome: 'o' } };
    expect(tooBig(fits)).toBeUndefined();
    expect(tooBig({ ...fits, title: 'x'.repeat(WORKER_LIMITS.title + 1) })).toBe(
      `A title is at most ${WORKER_LIMITS.title} bytes; put the rest in the body.`,
    );
    expect(tooBig({ ...fits, body: 'x'.repeat(WORKER_LIMITS.body + 1) })).toBe(`A body is at most ${WORKER_LIMITS.body} bytes.`);
    const contract = { stop_when: 'x'.repeat(WORKER_LIMITS.contractField + 1) };
    expect(tooBig({ ...fits, contract })).toBe(`The contract's stop_when is at most ${WORKER_LIMITS.contractField} bytes.`);
    expect(tooBig({ ...fits, contract }, (f) => `<${f}>`)).toBe(
      `The contract's <stop_when> is at most ${WORKER_LIMITS.contractField} bytes.`,
    );
  });
});

describe('listed', () => {
  const entry = (taskId: string, status: DisplayStatus) => ({ task: { taskId }, status }) as unknown as BoardEntry;
  const board = [entry('k_1', 'done'), entry('k_2', 'ready'), entry('k_3', 'running'), entry('k_4', 'blocked'), entry('k_5', 'ready')];
  const ids = (entries: BoardEntry[]) => entries.map((e) => e.task.taskId);

  it('shows the active tasks, grouped by status, running first and blocked last', () => {
    expect(ids(listed(board, undefined))).toEqual(['k_3', 'k_2', 'k_5', 'k_4']);
  });

  it("with a status, those of it; with all, every task, in the board's order", () => {
    expect(ids(listed(board, 'ready'))).toEqual(['k_2', 'k_5']);
    expect(ids(listed(board, 'all'))).toEqual(['k_1', 'k_2', 'k_3', 'k_4', 'k_5']);
    expect(listed(board, 'archived')).toEqual([]);
  });
});
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-command-parts.test.ts`. Expected: `Tests  4 failed (4)`: `boardSetting`, `tooBig` and `listed` are not exported yet.

- [ ] **Step 3.3: Implement.**

In `src/kanban/chat-parse.ts`, replace:

```ts
import type { Contract } from './types.js';
```

with:

```ts
import type { Contract } from './types.js';
import { WORKER_LIMITS } from './worker.js';
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  | BoardCommand;

/** `/kanban board …` (spec §16): a board's name as typed, which the service checks. */
```

with:

```ts
  | BoardCommand;

/** What `board set` changes (spec §16.6): a board's own max_running, or its workspace; null clears either. */
export interface BoardSetting {
  maxRunning?: number | null;
  workspace?: string | null;
}

/** `/kanban board …` (spec §16): a board's name as typed, which the service checks. */
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  | { verb: 'board set'; board: string; change: { maxRunning?: number | null; workspace?: string | null } };
```

with:

```ts
  | { verb: 'board set'; board: string; change: BoardSetting };
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  return forDisplay(`${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`);
```

with:

```ts
  return forDisplay(`${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`);
}

/**
 * `board set`'s setting and value, as typed, in chat or at a terminal (spec
 * §16.3): `max_running` a whole number from 1, or `none`; `workspace` a name, or
 * `none`, which the service checks. Undefined for anything else.
 */
export function boardSetting(setting: string, value: string): BoardSetting | undefined {
  const none = value.toLowerCase() === 'none';
  switch (setting.toLowerCase()) {
    case 'max_running': {
      const n = Number(value);
      if (!none && !(/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(n))) return undefined;
      return { maxRunning: none ? null : n };
    }
    case 'workspace':
      return { workspace: none ? null : value };
    default:
      return undefined;
  }
}

/**
 * What a new task may hold, from chat or a terminal: the limits a worker's `mt
 * kanban create` has (`WORKER_LIMITS`), so a task is the same size whoever made
 * it. Undefined when it fits; otherwise why not, with a contract field's name
 * given through `name`, which chat escapes.
 */
export function tooBig(
  task: { title: string; body: string; contract: Contract },
  name: (field: string) => string = (field) => field,
): string | undefined {
  const size = (text: string) => Buffer.byteLength(text, 'utf8');
  if (size(task.title) > WORKER_LIMITS.title) {
    return `A title is at most ${WORKER_LIMITS.title} bytes; put the rest in the body.`;
  }
  if (size(task.body) > WORKER_LIMITS.body) return `A body is at most ${WORKER_LIMITS.body} bytes.`;
  for (const [field, value] of Object.entries(task.contract)) {
    if (value !== undefined && size(value) > WORKER_LIMITS.contractField) {
      return `The contract's ${name(field)} is at most ${WORKER_LIMITS.contractField} bytes.`;
    }
  }
  return undefined;
```

In `src/kanban/chat-parse.ts`, replace:

```ts
    const none = value.toLowerCase() === 'none';
    switch (setting.toLowerCase()) {
      case 'max_running': {
        const n = Number(value);
        if (!none && !(/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(n))) return usage('board set');
        return { ok: true, command: { verb: 'board set', board, change: { maxRunning: none ? null : n } } };
      }
      case 'workspace':
        return { ok: true, command: { verb: 'board set', board, change: { workspace: none ? null : value } } };
      default:
        return usage('board set');
    }
```

with:

```ts
    const change = boardSetting(setting, value);
    return change === undefined ? usage('board set') : { ok: true, command: { verb: 'board set', board, change } };
```

In `src/kanban/chat.ts`, replace:

```ts
  parseKanban,
```

with:

```ts
  parseKanban,
  tooBig,
```

In `src/kanban/chat.ts`, replace:

```ts
} from './types.js';
import { WORKER_LIMITS } from './worker.js';

/**
```

with:

```ts
} from './types.js';

/**
```

In `src/kanban/chat.ts`, replace:

```ts
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
```

with:

```ts
  'Lark did not say who you are (no union_id came with the message), and the board records who changes it. Ask the operator to check the app can read user ids.';

/** A refusal, in words for chat: the board's message, on one line, since it can quote what the sender typed. */
```

In `src/kanban/chat.ts`, replace:

```ts
    const tooBig = oversized(command);
    if (tooBig !== undefined) return tooBig;
```

with:

```ts
    const big = tooBig(command, forDisplay);
    if (big !== undefined) return big;
```

In `src/kanban/chat-render.ts`, replace:

```ts
/**
 * `/kanban list` (spec §9.1): a board by derived status, the active tasks unless a
```

with:

```ts
/**
 * The tasks `list` shows, in chat or at a terminal (spec §9.1): the active ones,
 * grouped by status in that order, unless a filter is given; with one, those of
 * that status, or every one for `all`, in the board's order.
 */
export function listed(entries: readonly BoardEntry[], filter: DisplayStatus | 'all' | undefined): BoardEntry[] {
  const shown = entries.filter((e) =>
    filter === undefined ? ACTIVE.includes(e.status) : filter === 'all' || e.status === filter,
  );
  return filter === undefined ? ACTIVE.flatMap((status) => shown.filter((e) => e.status === status)) : shown;
}

/**
 * `/kanban list` (spec §9.1): a board by derived status, the active tasks unless a
```

In `src/kanban/chat-render.ts`, replace:

```ts
  const shown = entries.filter((e) =>
    filter === undefined ? ACTIVE.includes(e.status) : filter === 'all' || e.status === filter,
  );
  if (shown.length === 0) {
```

with:

```ts
  const ordered = listed(entries, filter);
  if (ordered.length === 0) {
```

In `src/kanban/chat-render.ts`, replace:

```ts
  const ordered =
    filter === undefined ? ACTIVE.flatMap((status) => shown.filter((e) => e.status === status)) : [...shown];
  const lines = ordered
```

with:

```ts
  const lines = ordered
```

In `src/kanban/chat-render.ts`, replace:

```ts
/** How many of a board's tasks are where, leaving out what is none. */
function counted(s: BoardSummary): string {
```

with:

```ts
/** How many of a board's tasks are where, leaving out what is none: chat's and the terminal's board list. */
export function counted(s: BoardSummary): string {
```

In `src/kanban/chat-render.ts`, replace:

```ts
function runLine(run: RunRow): string {
  const outcome = run.outcome === null ? (run.endedAt === null ? 'working' : 'undecided') : run.outcome;
```

with:

```ts
/** A run's outcome, or `working` while it is open and undecided, or `undecided` once closed without one. */
export function runState(run: RunRow): string {
  return run.outcome === null ? (run.endedAt === null ? 'working' : 'undecided') : run.outcome;
}

function runLine(run: RunRow): string {
  const outcome = runState(run);
```

- [ ] **Step 3.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1438 passed (1438)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.5: Commit.**

```bash
git add src/kanban/chat-parse.ts src/kanban/chat.ts src/kanban/chat-render.ts tests/kanban-command-parts.test.ts
git commit -m "Export the parts of a board command that do not depend on chat: a board's setting as typed, a new task's limits, which tasks a list shows and in what order, a board's counts and a run's state"
```

---

### Task 4: A task the operator created

**Files:**
- Create: `tests/kanban-operator-created.test.ts`
- Modify: `src/kanban/types.ts`, `src/kanban/service.ts`

`{ kind: 'operator' }` is the third shape of `CreatedVia` (Decision 13). The writer subscribes a chat only for a chat's task, and a run's task's followers only for a run's, so it needs no change.

- [ ] **Step 4.1: Write the failing tests.**

Create `tests/kanban-operator-created.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * A task an operator creates at a terminal (spec §3.1, §2.6): created via the
 * operator, by `operator:<login>`, and followed by no chat.
 */

const ME = 'operator:alice';
let t: TestDb;
let service: KanbanService;

beforeEach(() => {
  t = testDb();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
});

afterEach(() => t.close());

describe('a task created by the operator', () => {
  it('records the operator as its creator, and no chat follows it', () => {
    const r = service.create({ title: 'From a shell', assignee: 'implementer', createdBy: ME, createdVia: { kind: 'operator' } });
    if (!r.ok) throw new Error(r.message);
    expect(getTask(t.db, r.task.taskId)).toMatchObject({ createdBy: ME, createdVia: { kind: 'operator' }, createdFromTask: null });
    expect(subscriptionsOf(t.db, r.task.taskId)).toEqual([]);
    expect(eventsOf(t.db, r.task.taskId).map((e) => [e.kind, e.actor])).toEqual([['created', ME]]);
  });

  it("refuses an operator's created_via with anything more in it, and a chat's idempotency key", () => {
    const via = { kind: 'operator', conversationId: 'oc_chat' } as unknown as CreatedVia;
    expect(service.create({ title: 'x', createdBy: ME, createdVia: via })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'created_via is a chat, with text fields, a run id, or the operator',
    });
    expect(service.create({ title: 'x', createdBy: ME, createdVia: { kind: 'operator' }, idempotencyKey: 'lark:om_1' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-operator-created.test.ts`. Expected: `Tests  2 failed (2)`: the service refuses the shape, with the old message.

- [ ] **Step 4.3: Implement.**

In `src/kanban/types.ts`, replace:

```ts
/** Where a task came from: the chat it was created in, or the run that created it (spec §3.1). */
export type CreatedVia =
  | { kind: 'chat'; channel: string; appId: string; conversationId: string; threadId: string }
  | { kind: 'run'; runId: string };
```

with:

```ts
/**
 * Where a task came from (spec §3.1): the chat it was created in, the run that
 * created it, or an operator's `mt kanban new` at a terminal, which no chat
 * follows.
 */
export type CreatedVia =
  | { kind: 'chat'; channel: string; appId: string; conversationId: string; threadId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'operator' };
```

In `src/kanban/service.ts`, replace:

```ts
/** A refusal unless createdVia is one of the two shapes, with text fields. */
```

with:

```ts
/** A refusal unless createdVia is one of the three shapes, with text fields. */
```

In `src/kanban/service.ts`, replace:

```ts
      : via.kind === 'chat' &&
        isText(via.channel) &&
        isText(via.appId) &&
        isText(via.conversationId) &&
        isText(via.threadId));
  return fine ? undefined : board.refuse('invalid', 'created_via is a chat, with text fields, or a run id');
```

with:

```ts
      : via.kind === 'operator'
        ? Object.keys(via).length === 1
        : via.kind === 'chat' &&
          isText(via.channel) &&
          isText(via.appId) &&
          isText(via.conversationId) &&
          isText(via.threadId));
  return fine ? undefined : board.refuse('invalid', 'created_via is a chat, with text fields, a run id, or the operator');
```

- [ ] **Step 4.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1440 passed (1440)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.5: Commit.**

```bash
git add src/kanban/types.ts src/kanban/service.ts tests/kanban-operator-created.test.ts
git commit -m "Let a task be created by the operator, a third origin beside a chat and a run, which no chat follows"
```

---

### Task 5: The nudge

**Files:**
- Create: `tests/kanban-worker-nudge.test.ts`
- Modify: `src/kanban/worker.ts`

`{"nudge": true}`, and only that, asks for a pass, with no run and no token; a burst of nudges asks for one pass, on the next tick (Decision 9).

- [ ] **Step 5.1: Write the failing tests.**

Create `tests/kanban-worker-nudge.test.ts`:

```ts
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanService } from '../src/kanban/service.js';
import { listenWorker, type WorkerServer } from '../src/kanban/socket.js';
import { NUDGE, WorkerApi } from '../src/kanban/worker.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * The nudge (spec §7.3): the one request with no token, which asks for a
 * dispatcher pass and does nothing else.
 */

let t: TestDb;
let api: WorkerApi;
let passes: number;

beforeEach(() => {
  t = testDb();
  passes = 0;
  const service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
  api = new WorkerApi({ db: t.db, service, changed: () => (passes += 1) });
});

afterEach(() => t.close());

/** The next tick, when a nudge's pass runs. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('the nudge', () => {
  it('asks for a pass, with no run or token, and answers ok', async () => {
    expect(await api.handle({ ...NUDGE })).toEqual({ ok: true });
    await tick();
    expect(passes).toBe(1);
  });

  it('asks for one pass for a burst of nudges, and another for a nudge after it', async () => {
    for (let i = 0; i < 5; i += 1) expect(await api.handle({ ...NUDGE })).toEqual({ ok: true });
    expect(passes).toBe(0);
    await tick();
    expect(passes).toBe(1);
    await api.handle({ ...NUDGE });
    await tick();
    expect(passes).toBe(2);
  });

  it('is exactly {"nudge": true}: anything else is an ordinary request, refused without a pass', async () => {
    for (const raw of [{ nudge: 'yes' }, { nudge: true, run: 'r_1' }, { nudge: 1 }]) {
      expect(await api.handle(raw)).toMatchObject({ ok: false, code: 'bad_request' });
    }
    await tick();
    expect(passes).toBe(0);
  });

  it('is answered through the socket, as one line', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-nudge-')));
    let server: WorkerServer | undefined;
    try {
      server = await listenWorker(join(root, 'run', 'kanban.sock'), (req) => api.handle(req));
      const path = server.path;
      const line = await new Promise<string>((resolve, reject) => {
        const conn = createConnection(path);
        let got = '';
        conn.setEncoding('utf8');
        conn.on('data', (d: string) => (got += d));
        conn.once('error', reject);
        conn.once('close', () => resolve(got));
        conn.write(`${JSON.stringify(NUDGE)}\n`);
      });
      expect(line).toBe('{"ok":true}\n');
      await tick();
      expect(passes).toBe(1);
    } finally {
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-worker-nudge.test.ts`. Expected: `Tests  3 failed | 1 passed (4)`: there is no `NUDGE`, and the request is refused as one without a run.

- [ ] **Step 5.3: Implement.**

In `src/kanban/worker.ts`, replace:

```ts
const ENVELOPE = ['run', 'token', 'command', 'input'];

function isRecord(v: unknown): v is Record<string, unknown> {
```

with:

```ts
const ENVELOPE = ['run', 'token', 'command', 'input'];

/**
 * The one request that needs no token (spec §7.3, §10): it asks for a
 * dispatcher pass and does nothing else. An operator's `mt kanban` sends it after
 * a change made beside the gateway, so the change is acted on at once rather
 * than at the next sweep. It names nothing and changes nothing, and a pass is
 * what the sweep does every minute anyway, so whoever can reach the socket
 * gains nothing by it. A burst of nudges asks for one pass, on the next tick.
 */
export const NUDGE = { nudge: true } as const;

function isNudge(raw: Record<string, unknown>): boolean {
  return raw['nudge'] === true && Object.keys(raw).length === 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
```

In `src/kanban/worker.ts`, replace:

```ts
  readonly #nameOf: ((principal: string) => string | undefined) | undefined;
```

with:

```ts
  readonly #nameOf: ((principal: string) => string | undefined) | undefined;
  /** A nudge's pass is waiting for the next tick: the nudges after it until then ask for nothing more. */
  #nudged = false;
```

In `src/kanban/worker.ts`, replace:

```ts
    if (!isRecord(raw)) return refused('bad_request', 'a request is a JSON object');
```

with:

```ts
    if (!isRecord(raw)) return refused('bad_request', 'a request is a JSON object');
    if (isNudge(raw)) {
      if (!this.#nudged) {
        this.#nudged = true;
        setImmediate(() => {
          this.#nudged = false;
          this.#changed();
        });
      }
      return { ok: true };
    }
```

- [ ] **Step 5.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1444 passed (1444)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add src/kanban/worker.ts tests/kanban-worker-nudge.test.ts
git commit -m "Answer a nudge on the worker socket: the one request that needs no token, which asks for a dispatcher pass on the next tick, one for a burst of them, and does nothing else"
```

---

### Task 6: A pass cancels the turns of runs decided elsewhere

**Files:**
- Create: `tests/kanban-cancel-decided.test.ts`
- Modify: `src/kanban/types.ts`, `src/kanban/dispatcher.ts`

A stop made beside the gateway decides the run on the board, but nothing tells the dispatcher to cancel the agent's turn. Each pass now looks, skipping runs already closing, and a cancel that fails is noted without ending the pass (Decision 12).

- [ ] **Step 6.1: Write the failing tests.**

Create `tests/kanban-cancel-decided.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { dispatchHarness, holds, reportComplete, until, type DispatchHarness } from './helpers/dispatch.js';

/**
 * A run decided by a change the dispatcher was not told of (spec §2.6): an
 * operator's `mt kanban stop`, assign or archive, made beside the gateway. Its
 * next pass, which the change's nudge asks for, cancels the turn.
 */

const ME = 'operator:alice';
const open: DispatchHarness[] = [];

function harness(): DispatchHarness {
  const h = dispatchHarness();
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe('Dispatcher: a run decided elsewhere', () => {
  it('cancels, at the next pass, the turn of a run a stop decided, once, and closes it', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    const held = holds(implementer);
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');

    // As another process does it: through the board, and nothing told the dispatcher.
    expect(h.service.stop(task.taskId, ME).ok).toBe(true);
    expect(implementer.runtimes[0]?.cancels).toBe(0);
    h.dispatcher.pass();
    expect(implementer.runtimes[0]?.cancels).toBe(1);
    h.dispatcher.pass();
    expect(implementer.runtimes[0]?.cancels).toBe(1);

    held.end('cancelled');
    await h.dispatcher.idle();
    const [run] = runsOf(h.t.db, task.taskId);
    expect(run).toMatchObject({ outcome: 'cancelled' });
    expect(run?.endedAt).not.toBeNull();
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('blocked');
  });

  it('goes on with the pass when cancelling a run fails, and notes it', async () => {
    const h = harness();
    const stopped = h.create({ workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    expect(h.service.stop(stopped.taskId, ME).ok).toBe(true);
    const next = h.create({ workspace: 'api' });
    const started = holds(h.driver('implementer'));
    // The registry fails as the cancel asks it for the stopped run's actor.
    const liveActor = h.registry.liveActor.bind(h.registry);
    h.registry.liveActor = () => {
      throw new Error('the registry failed');
    };
    expect(() => h.dispatcher.pass()).not.toThrow();
    h.registry.liveActor = liveActor;
    const [run] = runsOf(h.t.db, stopped.taskId);
    expect(h.notes).toContain(`kanban: cancelling run ${run?.runId} failed: the registry failed`);
    await until(() => started.started, 'the next task to start');
    expect(runsOf(h.t.db, next.taskId)).toHaveLength(1);
    held.end('cancelled');
    started.end('completed');
    await h.dispatcher.idle();
  });

  it('leaves alone the turn of a run that decided itself, by its report', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    const held = holds(implementer);
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');

    await reportComplete(h, implementer);
    h.dispatcher.pass();
    expect(implementer.runtimes[0]?.cancels).toBe(0);
    held.end('completed');
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId)[0]).toMatchObject({ outcome: 'completed' });
  });
});
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-cancel-decided.test.ts`. Expected: `Tests  2 failed | 1 passed (3)`: the pass does not cancel the stopped run's turn, nor note a failed cancel.

- [ ] **Step 6.3: Implement.**

In `src/kanban/types.ts`, replace:

```ts
const SUPERSEDING_OUTCOMES = ['cancelled', 'superseded'] as const;
```

with:

```ts
export const SUPERSEDING_OUTCOMES = ['cancelled', 'superseded'] as const;
```

In `src/kanban/dispatcher.ts`, replace:

```ts
import type { CommentRow, RunKind, RunRow } from './types.js';
```

with:

```ts
import { SUPERSEDING_OUTCOMES, type CommentRow, type RunKind, type RunRow } from './types.js';
```

In `src/kanban/dispatcher.ts`, replace:

```ts
   * not end the turn. A board's own max_running holds inside the gateway's.
```

with:

```ts
   * not end the turn. A board's own max_running holds inside the gateway's.
   *
   * First, the turns of runs a person's action decided are cancelled, as
   * `cancel()` does when chat asks: a change made beside the gateway, by an
   * operator's `mt kanban` (spec §2.6), cannot ask, and its nudge, or the next
   * sweep, brings it here.
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    if (this.#stopped) return;
    let queues: Array<ReturnType<typeof claimableTasks>>;
```

with:

```ts
    if (this.#stopped) return;
    this.#cancelDecided();
    let queues: Array<ReturnType<typeof claimableTasks>>;
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    return true;
  }
```

with:

```ts
    return true;
  }

  /**
   * Cancel the turn of every run this process started that is not being
   * cancelled yet, and that a person's action decided -- `cancelled` by a stop,
   * `superseded` by an assign, an archive or an operator's answer to a review --
   * whoever made the change. A run that decided itself, by its report, ends its
   * own turn, and one already closing needs nothing. One run's failure is noted,
   * and never ends the pass.
   */
  #cancelDecided(): void {
    for (const open of [...this.#open.values()]) {
      if (open.cancelling || open.closing !== undefined) continue;
      try {
        const outcome = getRun(this.#deps.db, open.runId)?.outcome;
        if (outcome !== null && outcome !== undefined && (SUPERSEDING_OUTCOMES as readonly string[]).includes(outcome)) {
          this.cancel(open.runId);
        }
      } catch (err) {
        this.#note(`kanban: cancelling run ${open.runId} failed: ${message(err)}`);
      }
    }
  }
```

- [ ] **Step 6.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1447 passed (1447)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.5: Commit.**

```bash
git add src/kanban/types.ts src/kanban/dispatcher.ts tests/kanban-cancel-decided.test.ts
git commit -m "Cancel, at each dispatcher pass, the turn of any run a person's stop, assign or archive decided, whichever process made the change, noting rather than throwing a cancel that fails, so a change made beside the gateway reaches the agent"
```

---

### Task 7: The command line's parts in one module

**Files:**
- Create: `src/cli/args.ts`
- Modify: `src/cli/mt.ts`, `src/cli/gate.ts`, `src/cli/role.ts`, `src/cli/workspace.ts`

`UsageError`, `parse`, `refuse` and `table` move out of `mt.ts`, so the commands import them without importing `mt.ts`, which imports the commands (Decision 20). No behaviour changes, and no test is added: every `mt` test proves it.

- [ ] **Step 7.1: Implement.**

Create `src/cli/args.ts`:

```ts
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { MtIo } from './mt.js';

/**
 * The parts every `mt` command shares: reading its arguments, refusing, and
 * printing a table. Their own module, which imports nothing of `mt`'s at run
 * time, so the commands can use them without importing `mt.ts`, which imports
 * them.
 */

/** A wrong command line: said with the usage, exit 2. */
export class UsageError extends Error {}

/** Strict: an unknown option is a usage error, not something to guess at. */
export function parse<T extends NonNullable<ParseArgsConfig['options']>>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** Prints a refusal and returns its exit code. */
export function refuse(io: MtIo, message: string): number {
  io.err(`mt: ${message}`);
  return 1;
}

/** Rows as aligned columns, for the list commands. */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
}
```

In `src/cli/mt.ts`, replace:

```ts
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ConfigError, type Env } from '../config.js';
```

with:

```ts
import { ConfigError, type Env } from '../config.js';
import { parse, refuse, UsageError } from './args.js';
```

In `src/cli/mt.ts`, replace:

```ts
class UsageError extends Error {}

/** Strict: an unknown option is a usage error, not something to guess at. */
function parse<T extends NonNullable<ParseArgsConfig['options']>>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function expectNothing(positionals: readonly string[], what: string): void {
  if (positionals.length > 0) throw new UsageError(`${what} takes no arguments`);
}

/** Prints a refusal and returns its exit code. */
export function refuse(io: MtIo, message: string): number {
  io.err(`mt: ${message}`);
  return 1;
}

/** Rows as aligned columns, for the list commands. */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
```

with:

```ts
function expectNothing(positionals: readonly string[], what: string): void {
  if (positionals.length > 0) throw new UsageError(`${what} takes no arguments`);
```

In `src/cli/gate.ts`, replace:

```ts
import { refuse, table, type MtIo } from './mt.js';
```

with:

```ts
import { refuse, table } from './args.js';
import type { MtIo } from './mt.js';
```

In `src/cli/role.ts`, replace:

```ts
import { refuse, table, type MtIo } from './mt.js';
```

with:

```ts
import { refuse, table } from './args.js';
import type { MtIo } from './mt.js';
```

In `src/cli/workspace.ts`, replace:

```ts
import { refuse, table, type Git, type MtIo } from './mt.js';
```

with:

```ts
import { refuse, table } from './args.js';
import type { Git, MtIo } from './mt.js';
```

- [ ] **Step 7.2: Run everything.** Run `grep -n "from './mt.js'" src/cli/*.ts`. Expected: five lines, each an `import type`. Run `npx vitest run --project unit`. Expected: `Tests  1447 passed (1447)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.3: Commit.**

```bash
git add src/cli/args.ts src/cli/mt.ts src/cli/gate.ts src/cli/role.ts src/cli/workspace.ts
git commit -m "Move the mt commands' shared parts, reading arguments, refusing and printing a table, into a module of their own, so no command imports mt.ts back"
```

---

### Task 8: The board as plain text

**Files:**
- Create: `src/cli/plain.ts`, `tests/mt-plain.test.ts`

What the terminal prints: chat's board list, task list and task view, in plain text, masked and stripped of control characters and bidi controls (Decision 6), using chat's `listed`, `counted` and `runState`.

- [ ] **Step 8.1: Write the failing tests.**

Create `tests/mt-plain.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardsText, line, listText, showText } from '../src/cli/plain.js';
import { KanbanService } from '../src/kanban/service.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/** The operator's `mt kanban` output (spec §2.6): the board as chat shows it, in plain text, masked. */

const ME = 'operator:alice';
let t: TestDb;
let service: KanbanService;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  service = new KanbanService({
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

function create(title: string, extra: { board?: string; body?: string } = {}): string {
  const r = service.create({ title, assignee: 'implementer', workspace: 'web', createdBy: ME, createdVia: { kind: 'operator' }, ...extra });
  if (!r.ok) throw new Error(r.message);
  return r.task.taskId;
}

describe('line', () => {
  it('drops the characters that reorder text, as it drops control characters', () => {
    expect(line('evil\u202Etxt.exe\u202C and \u2066isolated\u2069\u0007')).toBe('eviltxt.exe and isolated');
  });
});

describe('boardsText', () => {
  it('gives each board a line: its tasks by phase, its own settings, and whether it is archived', () => {
    expect(service.createBoard('web-app', ME).ok).toBe(true);
    expect(service.setBoard('web-app', { maxRunning: 1, workspace: 'web' }, ME).ok).toBe(true);
    expect(service.createBoard('old', ME).ok).toBe(true);
    expect(service.archiveBoard('old', ME).ok).toBe(true);
    create('one', { board: 'web-app' });
    expect(boardsText(service.boards({ archived: true }))).toEqual([
      'default: no tasks',
      'old (archived): no tasks',
      'web-app: 1 open · max_running 1 · workspace web',
    ]);
  });
});

describe('listText', () => {
  it('lists the active tasks as a table, every one, and says when there are none', () => {
    expect(listText(service.list('default'), undefined, 'default')).toEqual([
      'no open tasks on board default; mt kanban list all shows done and archived ones too',
    ]);
    expect(listText(service.list('default'), 'done', 'default')).toEqual(['no done tasks on board default']);
    const ids = Array.from({ length: 31 }, (_, i) => create(`task ${i}`));
    const lines = listText(service.list('default'), undefined, 'default');
    expect(lines).toHaveLength(32);
    expect(lines[0]).toMatch(/^task\s+status\s+assignee\s+title$/);
    expect(lines[1]).toMatch(new RegExp(`^${ids[0]}\\s+ready\\s+role implementer\\s+task 0$`));
  });
});

describe('showText', () => {
  it('shows the task, its board, body, gates and comments, masked, with no control characters', () => {
    addSecrets(['sk-live-1234567890']);
    const taskId = create('Fix \u001b[31mthe\u001b[0m parser', { body: 'Line one\r\nkey sk-live-1234567890' });
    expect(service.addGate(taskId, { command: 'npm test', timeoutS: 120 }, ME).ok).toBe(true);
    expect(service.comment(taskId, 'look at the lexer', ME, { steers: true }).ok).toBe(true);
    const shown = service.show(taskId);
    const gates = service.listGates(taskId);
    if (!shown.ok || !gates.ok) throw new Error('not shown');
    expect(showText(shown.view, gates.gates)).toEqual([
      `Fix [31mthe[0m parser (${taskId}): ready`,
      'assignee: role implementer · reviewer: nobody · workspace: web · board: default',
      '',
      '    Line one',
      '    key ••••',
      '',
      'gates:',
      `  1. npm test (120 s, by ${ME})`,
      'comments (1 of 1):',
      `  ${ME}:`,
      '    look at the lexer',
    ]);
  });
});
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-plain.test.ts`. Expected: `Test Files  1 failed (1)`, with no test run: there is no `src/cli/plain.ts` to import.

- [ ] **Step 8.3: Implement.**

Create `src/cli/plain.ts`:

```ts
import type { BoardEntry, BoardSummary, TaskView } from '../db/kanban-read.js';
import { counted, listed, runState } from '../kanban/chat-render.js';
import type { DisplayStatus } from '../kanban/status.js';
import type { Assignee, GateRow } from '../kanban/types.js';
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import { table } from './args.js';

/**
 * What the operator's `mt kanban` prints (spec §2.6): the board as chat shows it
 * (`chat-render.ts`), as plain text for a terminal rather than Lark markdown.
 * Which tasks a list shows, in what order, and how a board's tasks are counted
 * are chat's own functions, so the two never disagree.
 *
 * Every piece is masked, and stripped of control characters and of the
 * characters that reorder text (bidi embeddings, overrides and isolates), first:
 * a task's text is untrusted, an escape sequence in a title would drive the
 * terminal, and an override would make a line read as something it is not.
 * Nothing is escaped, since a terminal renders no markdown.
 */

const LOW_SURROGATE = /^[\uDC00-\uDFFF]/;

/** The characters that reorder what follows them: U+202A to U+202E, and U+2066 to U+2069. */
export const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;

/** Masked and stripped, with every line break a newline. */
function clean(text: string): string {
  return redactKnownSecrets(stripControl(text)).replace(BIDI, '').replace(/\r\n?/g, '\n');
}

/** The first `max` UTF-16 units at most, with `marker` when anything was cut, on a character boundary. */
function cut(text: string, max: number, marker: string): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - marker.length)).replace(/[\uD800-\uDBFF]$/, '') + marker;
}

/** One line: masked, its spaces collapsed, cut with a marker. */
export function line(text: string, max = 200): string {
  return cut(clean(text).replace(/\s+/g, ' ').trim(), max, '…');
}

/** Free text from its start, indented under its label. */
function indented(text: string, max: number, by = '    '): string[] {
  return cut(clean(text).trim(), max, '\n… (truncated)')
    .split('\n')
    .map((l) => `${by}${l}`.trimEnd());
}

/** Free text from its end, as an agent's output is read: masked whole, then its last `max` characters. */
function tailOf(text: string, max: number): string[] {
  const whole = clean(text).trim();
  const kept = whole.length <= max ? whole : `… (earlier output cut)\n${whole.slice(-max).replace(LOW_SURROGATE, '').trimStart()}`;
  return kept.split('\n').map((l) => `    ${l}`.trimEnd());
}

export function who(a: Assignee | null): string {
  if (a === null) return 'nobody';
  return a.kind === 'role' ? `role ${line(a.name, 80)}` : line(a.name, 80);
}

/** `mt kanban board list` (spec §16.3): each board, its tasks by phase, and its own settings. */
export function boardsText(summaries: readonly BoardSummary[]): string[] {
  return summaries.map((s) => {
    const b = s.board;
    const settings = [
      ...(b.maxRunning === null ? [] : [`max_running ${b.maxRunning}`]),
      ...(b.workspace === null ? [] : [`workspace ${line(b.workspace, 80)}`]),
    ];
    const archived = b.archivedAt === null ? '' : ' (archived)';
    return `${line(b.name, 80)}${archived}: ${counted(s)}${settings.map((x) => ` · ${x}`).join('')}`;
  });
}

/** `mt kanban list` (spec §9.1): one board's tasks, as chat lists them, every one rather than the first 30. */
export function listText(
  entries: readonly BoardEntry[],
  filter: DisplayStatus | 'all' | undefined,
  board: string,
): string[] {
  const shown = listed(entries, filter);
  const on = `on board ${line(board, 80)}`;
  if (shown.length === 0) {
    return [
      filter === undefined
        ? `no open tasks ${on}; mt kanban list all shows done and archived ones too`
        : `no ${filter === 'all' ? '' : `${filter} `}tasks ${on}`,
    ];
  }
  const rows = shown.map((e) => [e.task.taskId, e.status, who(e.task.assignee), line(e.task.title, 120)]);
  return table([['task', 'status', 'assignee', 'title'], ...rows]);
}

/** `mt kanban show` (spec §9.1): what chat's shows, the task's board always named. */
export function showText(view: TaskView, gates: readonly GateRow[]): string[] {
  const { task } = view;
  const out: string[] = [
    `${line(task.title)} (${task.taskId}): ${view.status}`,
    `assignee: ${who(task.assignee)} · reviewer: ${who(task.reviewer)} · workspace: ${task.workspace === null ? 'not yet fixed' : line(task.workspace, 80)} · board: ${line(task.board, 80)}`,
  ];
  if (task.phase === 'blocked' && task.blockKind !== null) {
    out.push(`blocked (${task.blockKind}): ${line(task.blockReason ?? '', 500)}`);
  }
  if (view.parents.length > 0) out.push(`parents: ${view.parents.map((p) => `${p.taskId} (${p.phase})`).join(', ')}`);
  if (view.children.length > 0) out.push(`children: ${view.children.map((c) => `${c.taskId} (${c.phase})`).join(', ')}`);
  if (task.body.trim() !== '') out.push('', ...indented(task.body, 4000), '');
  const contract = Object.entries(task.contract).filter(([, v]) => v !== undefined && v.trim() !== '');
  if (contract.length > 0) {
    out.push('contract:');
    for (const [field, value] of contract) out.push(`  ${field}: ${line(value ?? '', 400)}`);
  }
  if (gates.length > 0) {
    out.push('gates:');
    for (const g of gates) out.push(`  ${g.id}. ${line(g.command, 300)} (${g.timeoutS} s, by ${line(g.createdBy, 80)})`);
  }
  if (view.runs.length > 0) {
    out.push('runs:');
    for (const run of view.runs.slice(-5)) {
      const said = run.summary ?? run.error;
      const head = `  #${run.attempt} ${run.kind} · ${who(run.assignee)} · ${runState(run)}`;
      out.push(said === null || said === '' ? head : `${head}: ${line(said, 300)}`);
    }
    const output = view.runs.at(-1)?.lastOutput ?? null;
    if (output !== null && output.trim() !== '') out.push('latest output:', ...tailOf(output, 2000));
  }
  if (view.comments.length > 0) {
    const shown = view.comments.slice(-5);
    out.push(`comments (${shown.length} of ${view.comments.length}):`);
    for (const c of shown) out.push(`  ${line(c.author, 80)}:`, ...indented(c.body, 1000));
  }
  return out;
}
```

- [ ] **Step 8.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1451 passed (1451)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.5: Commit.**

```bash
git add src/cli/plain.ts tests/mt-plain.test.ts
git commit -m "Render the board as plain text for a terminal: the boards, a board's tasks and one task, as chat shows them, masked and without control or bidi characters"
```

---

### Task 9: The operator's board commands, and whose command it is

**Files:**
- Create: `src/cli/operator.ts`, `tests/mt-kanban-operator.test.ts`
- Modify: `src/config.ts`, `src/cli/gate.ts`, `src/cli/kanban.ts`, `src/cli/mt.ts`, `src/kanban/socket.ts`, `tests/config.test.ts`

The frame every operator command runs in: the board opened as `mt kanban gate` opens it, now shared, with `kanban.enabled` read from the config; a refusal said on stderr or in JSON (`jsonLine`); the nudge after a change, what is said when no gateway answers, and what is said when the board is off (Decisions 9 to 11); and the first commands, `board list|create|set|archive` (Decision 3). `mt.ts` decides whose command a line is (Decisions 7 and 8). The task commands follow in Task 10; until then `mt kanban show` outside a run is a usage error.

- [ ] **Step 9.1: Write the failing tests.**

In `tests/config.test.ts`, replace:

```ts
    expect(s).toEqual({ home: c.home, configPath: c.configPath, dbPath: c.dbPath, workspaces: c.workspaces, agent: c.agent });
```

with:

```ts
    expect(s).toEqual({
      home: c.home,
      configPath: c.configPath,
      dbPath: c.dbPath,
      kanbanEnabled: c.kanban.enabled,
      workspaces: c.workspaces,
      agent: c.agent,
    });
```

Create `tests/mt-kanban-operator.test.ts`:

```ts
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonLine } from '../src/cli/operator.js';
import { boardsOf, getBoard } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The operator's `mt kanban` (spec §2.6): chat's board commands at a terminal,
 * in the gateway's own database, through the board's service, beside a gateway
 * that has it open; and the nudge that asks that gateway for a pass.
 */

let f: MtFixture;
/** The gateway's connection to its database. */
let gateway: Db;
/** The gateway's socket, when a test starts one, and the requests it was sent. */
let server: WorkerServer | undefined;
let requests: unknown[];
const ME = `operator:${userInfo().username}`;

beforeEach(() => {
  clearSecrets();
  f = mtFixture((workspace) =>
    [
      `workspace: ${workspace}`,
      'kanban:',
      '  enabled: true',
      'agent:',
      '  driver: structured-cli',
      '  command: bytesec',
      '  unsupervised: true',
      '',
    ].join('\n'),
  );
  gateway = openDb(join(f.home, 'team.db'));
  migrate(gateway, SCHEMA_DIR);
  server = undefined;
  requests = [];
});

afterEach(async () => {
  clearSecrets();
  await server?.close();
  gateway.close();
  f.cleanup();
});

/** As the operator's shell runs it: a made-up home. */
function mt(argv: string[], env: Record<string, string | undefined> = {}) {
  return f.run(['kanban', ...argv], { env: { HOME: f.root, ...env } });
}

/** A gateway listening on the home's socket, answering a nudge as the real one does. */
async function listening(): Promise<void> {
  server = await listenWorker(workerSocketPath(f.home), (req) => {
    requests.push(req);
    return { ok: true };
  });
}

describe('mt kanban board', () => {
  it('creates, sets, lists and archives a board, as the operator', async () => {
    expect(await mt(['board', 'create', 'web-app'])).toEqual({
      code: 0,
      out: 'created board web-app; mt kanban new --board web-app adds a task to it',
      err: '',
    });
    expect(getBoard(gateway, 'web-app')).toMatchObject({ createdBy: ME });
    await listening();
    expect(await mt(['board', 'set', 'web-app', 'max_running', '1'])).toEqual({
      code: 0,
      out: 'board web-app runs at most 1 agent at once now',
      err: '',
    });
    expect(await mt(['board', 'set', 'web-app', 'workspace', 'default'])).toMatchObject({
      code: 0,
      out: "board web-app's tasks work in default now, unless their own workspace, their role's or their parents' says otherwise",
    });
    expect(getBoard(gateway, 'web-app')).toMatchObject({ maxRunning: 1, workspace: 'default', updatedBy: ME });
    expect(await mt(['board', 'list'])).toEqual({
      code: 0,
      out: ['default: no tasks', 'web-app: no tasks · max_running 1 · workspace default'].join('\n'),
      err: '',
    });
    expect(await mt(['board', 'archive', 'web-app'])).toMatchObject({ code: 0 });
    expect((await mt(['board', 'list'])).out).toBe('default: no tasks');
    expect((await mt(['board', 'list', 'all'])).out).toContain('web-app (archived): no tasks');
    expect((await mt(['board', 'list', 'ALL'])).out).toContain('web-app (archived): no tasks');
  });

  it('prints one line of JSON with --json, a refusal too', async () => {
    const made = await mt(['board', 'create', 'web-app', '--json']);
    expect(made.code).toBe(0);
    expect(JSON.parse(made.out)).toEqual({ ok: true, board: { name: 'web-app', max_running: null, workspace: null, archived: false } });
    const listed = JSON.parse((await mt(['board', 'list', '--json'])).out) as { boards: Array<{ name: string; counts: object }> };
    expect(listed.boards.map((b) => b.name)).toEqual(['default', 'web-app']);
    expect(listed.boards[0]?.counts).toEqual({ open: 0, review: 0, blocked: 0, done: 0, archived: 0 });
    const again = await mt(['board', 'create', 'web-app', '--json']);
    expect(again).toMatchObject({ code: 1, err: '' });
    expect(JSON.parse(again.out)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses what the board refuses, with exit 1, and a wrong command line with exit 2', async () => {
    expect(await mt(['board', 'archive', 'default'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: board default is where every chat starts; it is never archived',
    });
    expect(await mt(['board', 'set', 'nowhere', 'max_running', '2'])).toMatchObject({ code: 1, err: 'mt: there is no board nowhere' });
    for (const argv of [
      ['board'],
      ['board', 'create'],
      ['board', 'create', 'a', 'b'],
      ['board', 'set', 'web-app', 'max_running', '0'],
      ['board', 'set', 'web-app', 'colour', 'blue'],
      ['board', 'list', 'archived'],
      ['board', 'rename', 'web-app'],
      ['board', 'create', 'web-app', '--board', 'x'],
    ]) {
      expect((await mt(argv)).code).toBe(2);
    }
    expect(boardsOf(gateway).map((b) => b.name)).toEqual(['default']);
  });

  it('has no use: a terminal has no chat to move', async () => {
    const r = await mt(['board', 'use', 'default']);
    expect(r.code).toBe(2);
    expect(r.err.split('\n')[0]).toBe('mt: kanban board use moves a chat, and a terminal has none: give new and list --board <name>');
  });

  it("refuses in a board run's shell, where it is not the operator's", async () => {
    for (const name of ['MT_KANBAN_RUN', 'MT_KANBAN_TOKEN']) {
      expect(await mt(['board', 'create', 'web-app'], { [name]: 'set' })).toEqual({
        code: 1,
        out: '',
        err:
          "mt: mt kanban board create is an operator's command, not a board run's: this shell has MT_KANBAN_RUN or " +
          'MT_KANBAN_TOKEN set. Run it from your own shell',
      });
    }
    expect(boardsOf(gateway).map((b) => b.name)).toEqual(['default']);
  });
});

describe('the nudge after a change', () => {
  it('asks a running gateway for a pass, with the one request that needs no token', async () => {
    await listening();
    await mt(['board', 'create', 'web-app']);
    expect(requests).toEqual([]);
    const r = await mt(['board', 'set', 'web-app', 'max_running', '2', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, nudged: true });
    expect(requests).toEqual([{ nudge: true }]);
  });

  it('says when no gateway answered, and the change stands', async () => {
    await mt(['board', 'create', 'web-app']);
    const r = await mt(['board', 'set', 'web-app', 'max_running', '2']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('board web-app runs at most 2 agents at once now');
    expect(r.err).toBe(
      `mt: no gateway answered at ${workerSocketPath(f.home)} (ENOENT; is the gateway running?); the change stands: ` +
        'a running gateway acts on it at its next sweep, and a stopped one when it next starts',
    );
    expect(getBoard(gateway, 'web-app')?.maxRunning).toBe(2);
    const quiet = await mt(['board', 'set', 'web-app', 'max_running', '1', '--json']);
    expect(JSON.parse(quiet.out)).toMatchObject({ ok: true, nudged: false });
  });
});

describe('a gateway whose board is off', () => {
  it('says the change is recorded and nothing runs it, and asks no gateway', async () => {
    writeFileSync(f.configPath, `workspace: ${f.workspace}\nagent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n`);
    await listening();
    await mt(['board', 'create', 'web-app']);
    const r = await mt(['board', 'set', 'web-app', 'max_running', '2', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, nudged: false });
    expect(r.err).toBe(
      'mt: the board is off on this gateway (its config does not set kanban.enabled): the change is recorded, ' +
        'and nothing runs it until the board is turned on and the gateway restarted',
    );
    expect(requests).toEqual([]);
  });
});

describe('jsonLine', () => {
  it('escapes what a terminal may act on that JSON leaves alone, and reads back the same', () => {
    const value = { text: 'a\u0085b\u2028c\u2029d\u202Ee\u2066f\u0007g' };
    const out = jsonLine(value);
    expect(out).toBe('{"text":"a\\u0085b\\u2028c\\u2029d\\u202ee\\u2066f\\u0007g"}');
    expect(JSON.parse(out)).toEqual(value);
  });
});

describe('mt kanban: whose command it is', () => {
  it("keeps the worker's own commands the worker's outside a run, which says it needs one", async () => {
    const r = await mt(['complete']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: 'not_in_a_run' });
  });

  it('answers a name neither has with the usage outside a run, and with JSON inside one', async () => {
    const outside = await mt(['finish']);
    expect(outside.code).toBe(2);
    expect(outside.err.split('\n')[0]).toBe('mt: unknown command: kanban finish');
    const inside = await mt(['finish'], { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 't', MT_KANBAN_SOCKET: '/nowhere' });
    expect(inside.code).toBe(2);
    expect(JSON.parse(inside.out)).toMatchObject({ ok: false, code: 'unknown_command' });
  });
});
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/config.test.ts tests/mt-kanban-operator.test.ts`. Expected: `Test Files  2 failed (2)` and `Tests  1 failed | 72 passed (73)`: the settings have no `kanbanEnabled`, and `tests/mt-kanban-operator.test.ts` cannot import `src/cli/operator.ts`, so none of its tests runs.

- [ ] **Step 9.3: Implement.**

In `src/config.ts`, replace:

```ts
  dbPath: string;
  /** Workspace name → declared absolute path. Always has `default`. */
```

with:

```ts
  dbPath: string;
  /** `kanban.enabled`: whether the gateway runs the board, so the operator's `mt kanban` can say when it does not. */
  kanbanEnabled?: boolean;
  /** Workspace name → declared absolute path. Always has `default`. */
```

In `src/config.ts`, replace:

```ts
    dbPath: envString(env, 'MT_DB') ?? file.db ?? join(home, 'team.db'),
```

with:

```ts
    dbPath: envString(env, 'MT_DB') ?? file.db ?? join(home, 'team.db'),
    kanbanEnabled: file.kanban.enabled ?? KANBAN_DEFAULTS.enabled,
```

In `src/cli/gate.ts`, replace:

```ts
import { loadTeamSettings } from '../config.js';
```

with:

```ts
import { loadTeamSettings, type Env } from '../config.js';
```

In `src/cli/gate.ts`, replace:

```ts
interface Board {
  service: KanbanService;
```

with:

```ts
/**
 * A board run's shell: the environment the gateway gives a run's agent (spec
 * §7.2). The operator's commands refuse to run in one, and there `mt kanban show`,
 * `comment` and `link` are the worker's.
 */
export function inBoardRun(env: Env): boolean {
  return env['MT_KANBAN_RUN'] !== undefined || env['MT_KANBAN_TOKEN'] !== undefined;
}

/** How an operator's command says it refused, and its exit code: on stderr, or as JSON for `--json`. */
export type Refuse = (code: string, message: string) => number;

export interface BoardAccess {
  service: KanbanService;
  /** The gateway's home, where its socket is (spec §7.2). */
  home: string;
  /** `kanban.enabled`: whether the gateway runs the board at all. */
  kanbanEnabled: boolean;
```

In `src/cli/gate.ts`, replace:

```ts
/** The board, as the gateway's own service over its database; or why not, already said. */
function openBoard(io: MtIo, what: string): Board | number {
  if (io.env['MT_KANBAN_RUN'] !== undefined || io.env['MT_KANBAN_TOKEN'] !== undefined) {
    return refuse(
      io,
```

with:

```ts
export interface OpenOptions {
  /** How a refusal is said; on stderr, as `mt: …`, unless given. */
  refuse?: Refuse;
  /** What a `passEnv` name unset in this shell means for the command; a gate's refusal of a secret, unless given. */
  unsetNote?: string;
}

/** The board, as the gateway's own service over its database; or why not, already said. */
export function openBoard(io: MtIo, what: string, opts: OpenOptions = {}): BoardAccess | number {
  const no = opts.refuse ?? ((_code: string, message: string) => refuse(io, message));
  if (inBoardRun(io.env)) {
    return no(
      'operator_command',
```

In `src/cli/gate.ts`, replace:

```ts
    io.err(`mt: ${unset.join(', ')} not set in this shell, so a gate holding those values cannot be refused here`);
  }
  if (!existsSync(settings.dbPath)) {
    return refuse(io, `there is no board at ${settings.dbPath}: the gateway creates its database when it first starts`);
```

with:

```ts
    io.err(`mt: ${unset.join(', ')} not set in this shell, so ${opts.unsetNote ?? 'a gate holding those values cannot be refused here'}`);
  }
  if (!existsSync(settings.dbPath)) {
    return no('no_board', `there is no board at ${settings.dbPath}: the gateway creates its database when it first starts`);
```

In `src/cli/gate.ts`, replace:

```ts
  } catch (err) {
    return refuse(io, failed(err));
  }
```

with:

```ts
  } catch (err) {
    return no('failed', failed(err));
  }
```

In `src/cli/gate.ts`, replace:

```ts
    db.close();
    return refuse(io, failed(err));
  }
```

with:

```ts
    db.close();
    return no('failed', failed(err));
  }
```

In `src/cli/gate.ts`, replace:

```ts
    return refuse(io, `the database at ${settings.dbPath} has no board yet: start the gateway once, so it is migrated`);
  }
  const service = new KanbanService({ db, roles: team.roles, workspaces: new Set(team.workspaces.keys()) });
  return { service, close: () => db.close() };
```

with:

```ts
    return no('no_board', `the database at ${settings.dbPath} has no board yet: start the gateway once, so it is migrated`);
  }
  // As the gateway builds its own: a supervised role's approvals go to the chat that follows its task (spec §7.1).
  const service = new KanbanService({
    db,
    roles: team.roles,
    workspaces: new Set(team.workspaces.keys()),
    supervisedRoles: true,
  });
  return { service, home: settings.home, kanbanEnabled: settings.kanbanEnabled === true, close: () => db.close() };
```

In `src/cli/gate.ts`, replace:

```ts
function withBoard(io: MtIo, what: string, fn: (b: Board) => number): number {
  const board = openBoard(io, what);
```

with:

```ts
/** `fn` on the board, which is closed after it; a failure of the database's is said, masked, as a refusal. */
export function withBoard(io: MtIo, what: string, fn: (b: BoardAccess) => number, opts: OpenOptions = {}): number {
  const no = opts.refuse ?? ((_code: string, message: string) => refuse(io, message));
  const board = openBoard(io, what, opts);
```

In `src/cli/gate.ts`, replace:

```ts
    if (busy(err)) return refuse(io, 'the board is busy: the gateway kept its database locked; try again');
    return refuse(io, failed(err));
```

with:

```ts
    if (busy(err)) return no('busy', 'the board is busy: the gateway kept its database locked; try again');
    return no('failed', failed(err));
```

In `src/cli/kanban.ts`, replace:

```ts
/** One request line to the socket, and the gateway's one answer line. */
function ask(socket: string, line: string): Promise<string> {
```

with:

```ts
/** One request line to the socket, and the gateway's one answer line, waited for up to `timeoutMs`. */
export function ask(socket: string, line: string, timeoutMs = ANSWER_TIMEOUT_MS): Promise<string> {
```

In `src/cli/kanban.ts`, replace:

```ts
    conn.setTimeout(ANSWER_TIMEOUT_MS, () => conn.destroy(new Error('no answer in time')));
```

with:

```ts
    conn.setTimeout(timeoutMs, () => conn.destroy(new Error('no answer in time')));
```

In `src/cli/kanban.ts`, replace:

```ts
function why(err: unknown): string {
```

with:

```ts
export function why(err: unknown): string {
```

In `src/kanban/socket.ts`, replace:

```ts
/** Every string in a response, keys too, masked: JSON escaping would hide a secret holding `"` or `\`. */
function maskAll(value: unknown): unknown {
```

with:

```ts
/**
 * Every string in a response, keys too, masked: JSON escaping would hide a
 * secret holding `"` or `\`. The operator's `mt kanban --json` masks its output so too.
 */
export function maskAll(value: unknown): unknown {
```

Create `src/cli/operator.ts`:

```ts
import { boardSetting } from '../kanban/chat-parse.js';
import type { KanbanService } from '../kanban/service.js';
import { maskAll, workerSocketPath } from '../kanban/socket.js';
import type { BoardRow, Refusal } from '../kanban/types.js';
import { NUDGE } from '../kanban/worker.js';
import { parse, UsageError } from './args.js';
import { operatorName, withBoard } from './gate.js';
import { ask, why } from './kanban.js';
import type { MtIo } from './mt.js';
import { BIDI, boardsText, line } from './plain.js';

/**
 * The operator's `mt kanban` (spec §2.6): chat's `/kanban` commands at a
 * terminal, with chat's semantics and an operator's authority -- whoever runs
 * them is the gateway's user, who could edit its files anyway. They write the
 * board's database beside a running gateway, through `KanbanService`, as `mt
 * kanban gate` does, and record who acted as `operator:<login>`.
 *
 * **Never the worker's.** These refuse to run in a board run's shell, and there
 * `show`, `comment` and `link` are the worker's commands (spec §7.3); the
 * worker's take no arguments and read JSON on stdin, these take their task and
 * text as arguments. `src/cli/mt.ts` decides which a command line is.
 *
 * **Output** is plain text, masked, or with `--json` one line of JSON, as the
 * worker's is: `{"ok": true, ...}` or `{"ok": false, "code": ..., "message": ...}`.
 * Exit codes: 0 done, 1 refused, 2 the command line was wrong.
 *
 * **A nudge after a change.** A change that chat follows with a dispatcher pass
 * is followed here by a request for one, over the gateway's socket: the one
 * request that needs no token, and does nothing else (`NUDGE`). A gateway that
 * does not answer, stopped, loses nothing: the change stands, and its next
 * sweep, or its next start, acts on it. A gateway whose config does not set
 * `kanban.enabled` is not asked, and the command says nothing will run the
 * change until the board is turned on.
 */

/** How long a nudge waits for the gateway's answer: a pass is quick, and the change is made already. */
export const NUDGE_TIMEOUT_MS = 2_000;

/** What a command did: the lines to print, the JSON to print instead, and whether to nudge the gateway. */
interface Done {
  ok: true;
  lines: string[];
  json: Record<string, unknown>;
  nudge?: boolean;
}

type Outcome = Done | { ok: false; code: string; message: string };

/** A refusal as the board said it, masked and on one line: it may quote what was typed. */
function refused(r: Refusal | { code: string; message: string }): Outcome {
  return { ok: false, code: r.code, message: line(r.message, 600) };
}

/** `--json` on every command. */
const JSON_FLAG = { json: { type: 'boolean' } } as const;

/**
 * Characters JSON leaves as they are that a terminal or a reader may act on: C1
 * controls, the line and paragraph separators, and the bidi controls. Escaped
 * as `\uXXXX`, which every JSON reader reads back as the same string.
 */
const UNSAFE_IN_JSON = /[\u0080-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/** One line of JSON, masked, with nothing in it a terminal acts on. */
export function jsonLine(value: unknown): string {
  return JSON.stringify(maskAll(value)).replace(UNSAFE_IN_JSON, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** `--board <name>`, trimmed; a blank one is a wrong command line. */
export function boardFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value.trim();
  if (name === '') throw new UsageError('--board needs a board name');
  return name;
}

function boardJson(b: BoardRow): Record<string, unknown> {
  return { name: b.name, max_running: b.maxRunning, workspace: b.workspace, archived: b.archivedAt !== null };
}

/**
 * Ask the gateway at `home` for a dispatcher pass, at the socket it listens on:
 * `failed` says why not, in a few words, when it did not answer.
 */
export async function nudgeGateway(home: string, timeoutMs = NUDGE_TIMEOUT_MS): Promise<{ socket: string; failed?: string }> {
  let socket: string;
  try {
    socket = workerSocketPath(home);
  } catch (err) {
    return { socket: home, failed: err instanceof Error ? err.message : String(err) };
  }
  try {
    const answer: unknown = JSON.parse(await ask(socket, `${JSON.stringify(NUDGE)}\n`, timeoutMs));
    if ((answer as { ok?: unknown } | null)?.ok === true) return { socket };
    return { socket, failed: 'it did not take the nudge' };
  } catch (err) {
    return { socket, failed: err instanceof SyntaxError ? 'it gave no answer' : why(err) };
  }
}

/**
 * Run `fn` on the board, as the operator, then print what it did -- in JSON for
 * `--json` -- and nudge the gateway after a change that asks for it.
 */
async function act(
  io: MtIo,
  json: boolean,
  what: string,
  fn: (service: KanbanService, by: string) => Outcome,
): Promise<number> {
  const no = (code: string, message: string): number => {
    if (json) io.out(jsonLine({ ok: false, code, message }));
    else io.err(`mt: ${message.replace(BIDI, '')}`);
    return 1;
  };
  let outcome: Outcome | undefined;
  let home = '';
  let enabled = true;
  const code = withBoard(
    io,
    what,
    (board) => {
      home = board.home;
      enabled = board.kanbanEnabled;
      outcome = fn(board.service, operatorName(io));
      return 0;
    },
    { refuse: no, unsetNote: 'those values are not masked here' },
  );
  if (outcome === undefined) return code;
  if (!outcome.ok) return no(outcome.code, outcome.message);
  const done: Done = outcome;
  let nudged: boolean | undefined;
  if (done.nudge === true && !enabled) {
    nudged = false;
    io.err(
      "mt: the board is off on this gateway (its config does not set kanban.enabled): the change is recorded, " +
        'and nothing runs it until the board is turned on and the gateway restarted',
    );
  } else if (done.nudge === true) {
    const r = await nudgeGateway(home);
    nudged = r.failed === undefined;
    if (r.failed !== undefined) {
      io.err(
        `mt: no gateway answered at ${r.socket} (${r.failed}); the change stands: a running gateway acts on it ` +
          'at its next sweep, and a stopped one when it next starts',
      );
    }
  }
  if (json) io.out(jsonLine({ ok: true, ...done.json, ...(nudged === undefined ? {} : { nudged }) }));
  else for (const l of done.lines) io.out(l);
  return 0;
}

/** `mt kanban board list|create|set|archive` (spec §16.3). There is no `use`: a terminal is no chat. */
async function board(args: readonly string[], io: MtIo): Promise<number> {
  const [sub, ...rest] = args;
  const { values, positionals } = parse(rest, JSON_FLAG);
  const json = values.json === true;
  switch (sub) {
    case 'list': {
      const [word, extra] = positionals;
      const all = word?.toLowerCase();
      if (extra !== undefined || (all !== undefined && all !== 'all')) throw new UsageError('kanban board list takes at most all');
      return act(io, json, 'mt kanban board list', (service) => {
        const summaries = service.boards({ archived: all === 'all' });
        return {
          ok: true,
          lines: boardsText(summaries),
          json: { boards: summaries.map((s) => ({ ...boardJson(s.board), counts: s.counts })) },
        };
      });
    }
    case 'create':
    case 'archive': {
      const [name, extra] = positionals;
      if (name === undefined || extra !== undefined) throw new UsageError(`kanban board ${sub} takes one name`);
      return act(io, json, `mt kanban board ${sub}`, (service, by) => {
        const r = sub === 'create' ? service.createBoard(name, by) : service.archiveBoard(name, by);
        if (!r.ok) return refused(r);
        const lines =
          sub === 'create'
            ? [`created board ${line(r.board.name, 80)}; mt kanban new --board ${line(r.board.name, 80)} adds a task to it`]
            : [`archived board ${line(r.board.name, 80)}: its tasks stay, and mt kanban show still shows them; nothing more is added to it`];
        return { ok: true, lines, json: { board: boardJson(r.board) } };
      });
    }
    case 'set': {
      const [name, setting, value, extra] = positionals;
      const change = setting === undefined || value === undefined ? undefined : boardSetting(setting, value);
      if (name === undefined || change === undefined || extra !== undefined) {
        throw new UsageError('kanban board set takes a name, then max_running <number|none> or workspace <workspace|none>');
      }
      return act(io, json, 'mt kanban board set', (service, by) => {
        const r = service.setBoard(name, change, by);
        if (!r.ok) return refused(r);
        const b = r.board;
        const said =
          change.maxRunning !== undefined
            ? b.maxRunning === null
              ? `board ${line(b.name, 80)} has no max_running of its own now: the gateway's kanban.max_running holds`
              : `board ${line(b.name, 80)} runs at most ${b.maxRunning} agent${b.maxRunning === 1 ? '' : 's'} at once now`
            : `board ${line(b.name, 80)}'s tasks work in ${line(b.workspace ?? 'default', 80)} now, unless their own workspace, their role's or their parents' says otherwise`;
        // A higher limit, or a workspace, can make a task claimable.
        return { ok: true, lines: [said], json: { board: boardJson(b) }, nudge: true };
      });
    }
    case 'use':
      throw new UsageError('kanban board use moves a chat, and a terminal has none: give new and list --board <name>');
    default:
      throw new UsageError('kanban board takes list, create, set or archive');
  }
}

/** `mt kanban <command>` outside a board run: the operator's. */
export async function operatorCommand(command: string | undefined, rest: readonly string[], io: MtIo): Promise<number> {
  switch (command) {
    case 'board':
      return board(rest, io);
    default:
      throw new UsageError(`unknown command: kanban${command === undefined ? '' : ` ${command}`}`);
  }
}
```

In `src/cli/mt.ts`, replace:

```ts
import { gateAdd, gateList, gateRemove } from './gate.js';
import { kanbanCommand } from './kanban.js';
```

with:

```ts
import { gateAdd, gateList, gateRemove, inBoardRun } from './gate.js';
import { kanbanCommand } from './kanban.js';
import { operatorCommand } from './operator.js';
```

In `src/cli/mt.ts`, replace:

```ts
 * `mt kanban` is the one that talks to the gateway, through its socket, and only
 * with the authority of a run's token, from the run's environment.
 *
 * `mt kanban gate` is the operator's, and the one exception to writing files
 * only: it writes the board's database, through the board's own service (spec §7.7).
```

with:

```ts
 * In a board run's shell, `mt kanban` is the worker CLI, which talks to the
 * gateway through its socket, with the authority of the run's token, from the
 * run's environment (spec §7.3).
 *
 * Elsewhere it is the operator's (spec §2.6): chat's `/kanban` commands, and `mt
 * kanban gate`, the exception to writing files only. They write the board's
 * database, through the board's own service, and after a change ask the gateway
 * for a dispatcher pass, a request that needs no token and does nothing else.
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban <show|complete|review|changes|block|comment|create|link> < input.json',
```

with:

```ts
  '  mt kanban board list [all] [--json]',
  '  mt kanban board create <name> [--json]',
  '  mt kanban board set <name> max_running <number|none> [--json]',
  '  mt kanban board set <name> workspace <workspace|none> [--json]',
  '  mt kanban board archive <name> [--json]',
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban gate remove <task_id> <gate_id>',
```

with:

```ts
  '  mt kanban gate remove <task_id> <gate_id>',
  "in a board run's shell, where the gateway sets MT_KANBAN_RUN, MT_KANBAN_TOKEN and MT_KANBAN_SOCKET:",
  '  mt kanban <show|complete|review|changes|block|comment|create|link> < input.json',
```

In `src/cli/mt.ts`, replace:

```ts
  throw new UsageError('kanban gate takes add, list or remove');
```

with:

```ts
  throw new UsageError('kanban gate takes add, list or remove');
}

/** The worker CLI's commands that no operator's has: the worker's wherever they are typed. */
const WORKER_ONLY: readonly string[] = ['complete', 'review', 'changes', 'block', 'create'];
/** The operator's commands that the worker CLI has not got: the operator's wherever they are typed. */
const OPERATOR_ONLY: readonly string[] = ['gate', 'board'];

/**
 * Whose `mt kanban <command>` this is: the worker CLI's (spec §7.3) or the
 * operator's (spec §2.6). In a board run's shell, every name both have, and any
 * name neither has, is the worker's, so an agent always gets the worker's JSON
 * answer; the operator's commands refuse to run there. Elsewhere they are the
 * operator's, and the worker's own names say they work only inside a run.
 */
function isWorkers(command: string | undefined, io: MtIo): boolean {
  if (command !== undefined && WORKER_ONLY.includes(command)) return true;
  if (command !== undefined && OPERATOR_ONLY.includes(command)) return false;
  return inBoardRun(io.env);
```

In `src/cli/mt.ts`, replace:

```ts
    if (group === 'kanban' && command === 'gate') return gate(rest, io);
    if (group === 'kanban') return await kanbanCommand(command, rest, io);
```

with:

```ts
    if (group === 'kanban' && isWorkers(command, io)) return await kanbanCommand(command, rest, io);
    if (group === 'kanban' && command === 'gate') return gate(rest, io);
    if (group === 'kanban') return await operatorCommand(command, rest, io);
```

- [ ] **Step 9.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1462 passed (1462)`; `tests/mt-gate.test.ts` and `tests/mt-kanban.test.ts` pass unchanged. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.5: Commit.**

```bash
git add src/config.ts src/cli/gate.ts src/cli/kanban.ts src/cli/mt.ts src/cli/operator.ts src/kanban/socket.ts tests/config.test.ts tests/mt-kanban-operator.test.ts
git commit -m "Add the operator's mt kanban board list, create, set and archive, which write the board beside the gateway as mt kanban gate does, print plain text or JSON, and nudge the gateway after a change, or say its board is off; and decide from the shell and the name whether mt kanban is the operator's or a board run's"
```

---

### Task 10: The operator's task commands

**Files:**
- Create: `tests/mt-kanban-operator-tasks.test.ts`
- Modify: `src/cli/operator.ts`, `src/cli/mt.ts`

`new`, `list`, `show`, `assign`, `link`, `unblock`, `stop`, `archive` and `comment`, with chat's semantics and replies (Decisions 2, 4, 5, 13, 14, 18 and 19); every one that names a task takes `--board`, and is refused off it.

- [ ] **Step 10.1: Write the failing tests.**

Create `tests/mt-kanban-operator-tasks.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { commentsOf, eventsOf, getRun, getTask, parentsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { claimed } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The operator's task commands (spec §2.6, §9.1): `mt kanban new`, `list`,
 * `show`, `assign`, `link`, `unblock`, `stop`, `archive` and `comment`, with
 * chat's semantics, as the operator, beside a gateway that has the board open.
 */

let f: MtFixture;
let gateway: Db;
let server: WorkerServer | undefined;
let nudges: number;
const ME = `operator:${userInfo().username}`;

beforeEach(async () => {
  clearSecrets();
  f = mtFixture((workspace) =>
    [
      `workspace: ${workspace}`,
      'kanban:',
      '  enabled: true',
      'agent:',
      '  driver: structured-cli',
      '  command: bytesec',
      '  unsupervised: true',
      '  passEnv: [API_KEY]',
      '',
    ].join('\n'),
  );
  gateway = openDb(join(f.home, 'team.db'));
  migrate(gateway, SCHEMA_DIR);
  nudges = 0;
  server = await listenWorker(workerSocketPath(f.home), () => {
    nudges += 1;
    return { ok: true };
  });
});

afterEach(async () => {
  clearSecrets();
  await server?.close();
  gateway.close();
  f.cleanup();
});

interface Run {
  stdin?: string;
  tty?: boolean;
  env?: Record<string, string | undefined>;
}

/** As the operator's shell runs it, with stdin when given. */
async function mt(argv: string[], opts: Run = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['kanban', ...argv], {
    env: { ...f.env, HOME: f.root, API_KEY: 'sk-live-1234567890', ...opts.env },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdinIsTTY: opts.tty ?? false,
    stdin: async (max) => {
      const text = opts.stdin ?? '';
      return Buffer.byteLength(text) > max ? undefined : text;
    },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** The id `mt kanban new` printed. */
function created(out: string): string {
  const m = /^created (k_[0-9a-z]+):/.exec(out);
  if (m?.[1] === undefined) throw new Error(`not created: ${out}`);
  return m[1];
}

describe('mt kanban new', () => {
  it("creates a task as the operator, with chat's fields as flags, followed by no chat, and nudges the gateway", async () => {
    const parent = created((await mt(['new', 'Parent', '--assignee', 'default'])).out);
    const r = await mt([
      'new', 'Draft', 'the', 'summary',
      '--assignee', 'default',
      '--workspace', 'default',
      '--parent', parent,
      '--outcome', 'a page',
      '--verify', 'it links every source',
      '--stop-when', 'it is ten pages',
      '--body', 'Use last quarter as the model.',
    ]);
    expect(r).toMatchObject({ code: 0, err: '' });
    const taskId = created(r.out);
    expect(r.out).toBe(`created ${taskId}: Draft the summary, for role default, in default, on board default`);
    expect(getTask(gateway, taskId)).toMatchObject({
      title: 'Draft the summary',
      body: 'Use last quarter as the model.',
      contract: { outcome: 'a page', verification: 'it links every source', stop_when: 'it is ten pages' },
      createdBy: ME,
      createdVia: { kind: 'operator' },
      board: 'default',
    });
    expect(parentsOf(gateway, taskId).map((p) => p.taskId)).toEqual([parent]);
    expect(subscriptionsOf(gateway, taskId)).toEqual([]);
    expect(nudges).toBe(2);
  });

  it('reads the body from a file, or from stdin with --body-file -, and refuses a terminal there', async () => {
    const file = join(f.root, 'body.md');
    writeFileSync(file, 'From a file.\r\nTwo lines.\n');
    const fromFile = created((await mt(['new', 'A', '--body-file', file])).out);
    expect(getTask(gateway, fromFile)?.body).toBe('From a file.\nTwo lines.');
    const fromStdin = created((await mt(['new', 'B', '--body-file', '-'], { stdin: 'From stdin.' })).out);
    expect(getTask(gateway, fromStdin)?.body).toBe('From stdin.');
    expect(await mt(['new', 'C', '--body-file', '-'], { tty: true })).toEqual({
      code: 1,
      out: '',
      err: 'mt: --body-file - reads the body on stdin; stdin is a terminal: redirect a file or pipe it',
    });
    expect(await mt(['new', 'D', '--body-file', join(f.root, 'nowhere.md')])).toMatchObject({
      code: 1,
      err: `mt: cannot read the body from ${join(f.root, 'nowhere.md')}: ENOENT`,
    });
  });

  it('reads a body only from a regular file: not a directory, a device or a FIFO, which could block', async () => {
    const dir = join(f.root, 'a-dir');
    mkdirSync(dir);
    const fifo = join(f.root, 'a-fifo');
    execFileSync('mkfifo', [fifo]);
    for (const path of [dir, '/dev/null', fifo]) {
      expect(await mt(['new', 'E', '--body-file', path])).toEqual({
        code: 1,
        out: '',
        err: `mt: ${path} is not a regular file: give a file, or - for stdin`,
      });
    }
    expect(gateway.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });

  it('refuses a title holding a line break or a control character, as a wrong command line', async () => {
    for (const title of ['two\nlines', 'a\u0007bell', 'a\u2028separator']) {
      const r = await mt(['new', title]);
      expect(r.code).toBe(2);
      expect(r.err.split('\n')[0]).toBe('mt: a title is one line, with no control characters');
    }
    expect(gateway.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });

  it("refuses what chat refuses: a person, an unknown role, an archived board, a task over chat's limits", async () => {
    expect(await mt(['new', 'x', '--assignee', 'lark:on_bob'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: "lark:on_bob" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
    });
    expect(await mt(['new', 'x', '--reviewer', '@Bob'])).toMatchObject({ code: 1 });
    expect(await mt(['new', 'x', '--assignee', 'implementr'])).toMatchObject({ code: 1, err: 'mt: role "implementr" is not configured' });
    expect(await mt(['new', 'x', '--board', 'nowhere'])).toMatchObject({ code: 1, err: 'mt: there is no board nowhere; no task is added to it' });
    expect(await mt(['new', 'x'.repeat(513)])).toMatchObject({ code: 1, err: 'mt: A title is at most 512 bytes; put the rest in the body.' });
    const json = await mt(['new', 'x', '--assignee', 'implementr', '--json']);
    expect(JSON.parse(json.out)).toEqual({ ok: false, code: 'unknown_role', message: 'role "implementr" is not configured' });
    expect(gateway.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
    expect(nudges).toBe(0);
  });

  it('answers a wrong command line with exit 2', async () => {
    for (const argv of [
      ['new'],
      ['new', 'x', '--body', 'a', '--body-file', 'b'],
      ['new', 'x', '--outcome', ''],
      ['new', 'x', '--parent', ','],
      ['new', 'x', '--priority', '3'],
      ['new', 'x', '--board', '  '],
      ['list', '--board', ''],
    ]) {
      expect((await mt(argv)).code).toBe(2);
    }
  });

  it('puts the task on the board --board names, and lists that board', async () => {
    expect((await mt(['board', 'create', 'web-app'])).code).toBe(0);
    const taskId = created((await mt(['new', 'On web', '--board', 'web-app'])).out);
    expect(getTask(gateway, taskId)?.board).toBe('web-app');
    expect((await mt(['list'])).out).toBe('no open tasks on board default; mt kanban list all shows done and archived ones too');
    const listed = await mt(['list', '--board', 'web-app', '--json']);
    expect(JSON.parse(listed.out)).toEqual({
      ok: true,
      board: 'web-app',
      tasks: [{ task_id: taskId, status: 'ready', title: 'On web', assignee: null, assignee_kind: null }],
    });
    expect(await mt(['list', '--board', 'nowhere'])).toMatchObject({ code: 1, err: 'mt: there is no board nowhere' });
    expect((await mt(['list', 'finished'])).code).toBe(2);
  });
});

describe('the task commands', () => {
  it('shows a task, in plain text or JSON, and refuses one that does not exist', async () => {
    const taskId = created((await mt(['new', 'Show me', '--assignee', 'default', '--body', 'key sk-live-1234567890'])).out);
    const shown = await mt(['show', taskId]);
    expect(shown.out.split('\n')).toEqual([
      `Show me (${taskId}): ready`,
      'assignee: role default · reviewer: nobody · workspace: not yet fixed · board: default',
      '',
      '    key ••••',
      '',
    ]);
    const json = JSON.parse((await mt(['show', taskId, '--json'])).out) as { task: { body: string; board: string } };
    expect(json.task).toMatchObject({ body: 'key ••••', board: 'default' });
    expect(await mt(['show', 'k_missing'])).toMatchObject({ code: 1, err: 'mt: no task k_missing' });
  });

  it('assigns, stops, unblocks, comments, links and archives, as the operator, nudging after what chat follows with a pass', async () => {
    const taskId = created((await mt(['new', 'Work', '--assignee', 'default'])).out);
    const child = created((await mt(['new', 'Later'])).out);
    nudges = 0;
    const run = claimed(gateway, taskId);

    expect((await mt(['stop', taskId])).out).toBe(
      `stopped ${taskId}: its run was cancelled, and the task is blocked (needs_input); mt kanban unblock ${taskId} runs it again`,
    );
    expect(getRun(gateway, run.runId)?.outcome).toBe('cancelled');
    expect((await mt(['unblock', taskId, 'try', 'again'])).out).toBe(`${taskId} is unblocked, back to open`);
    expect((await mt(['assign', taskId, 'default'])).out).toBe(`${taskId} is already assigned to role default`);
    expect((await mt(['comment', taskId, 'look', 'at', 'the', 'lexer'])).out).toBe(
      `comment added to ${taskId}: an agent working on it gets it when its current turn ends; otherwise the next run reads it`,
    );
    expect(commentsOf(gateway, taskId).map((c) => [c.author, c.body])).toEqual([[ME, 'try again'], [ME, 'look at the lexer']]);
    expect((await mt(['link', taskId, child])).out).toBe(`${child} now waits for ${taskId}`);
    expect((await mt(['link', taskId, child])).out).toBe(`${child} already waits for ${taskId}`);
    expect((await mt(['assign', child, 'default'])).out).toBe(`${child} is now for role default`);
    expect((await mt(['archive', child])).out).toBe(`archived ${child}`);
    // stop, unblock, the second assign and archive; not comment or link, as in chat.
    expect(nudges).toBe(4);
    expect(eventsOf(gateway, taskId).filter((e) => e.actor === ME).map((e) => e.kind)).toEqual([
      'created',
      'stopped',
      'unblocked',
      'commented',
      'commented',
    ]);
  });

  it('with --board, acts only on a task on that board, both tasks for link, and refuses a board that does not exist', async () => {
    expect((await mt(['board', 'create', 'web-app'])).code).toBe(0);
    const here = created((await mt(['new', 'Here', '--board', 'web-app', '--assignee', 'default'])).out);
    const there = created((await mt(['new', 'There', '--assignee', 'default'])).out);
    const other = (id: string) => ({ code: 1, out: '', err: `mt: task ${id} is on board default, not web-app` });
    for (const argv of [
      ['show', there],
      ['assign', there, 'default'],
      ['unblock', there],
      ['stop', there],
      ['archive', there],
      ['comment', there, 'hello'],
      ['link', here, there],
    ]) {
      expect(await mt([...argv, '--board', 'web-app'])).toEqual(other(there));
    }
    expect(await mt(['link', there, here, '--board', 'web-app'])).toEqual(other(there));
    const json = await mt(['stop', there, '--board', 'web-app', '--json']);
    expect(JSON.parse(json.out)).toEqual({ ok: false, code: 'other_board', message: `task ${there} is on board default, not web-app` });
    expect(await mt(['show', here, '--board', 'nowhere'])).toEqual({ code: 1, out: '', err: 'mt: there is no board nowhere' });
    expect(await mt(['show', 'k_missing', '--board', 'web-app'])).toMatchObject({ code: 1, err: 'mt: no task k_missing' });
    expect(eventsOf(gateway, there).map((e) => e.kind)).toEqual(['created']);

    // On its own board, and without --board on any.
    expect((await mt(['show', here, '--board', ' web-app '])).out.split('\n')[0]).toBe(`Here (${here}): ready`);
    expect((await mt(['comment', here, 'hi', '--board', 'web-app'])).code).toBe(0);
    expect((await mt(['archive', here, '--board', 'web-app'])).out).toBe(`archived ${here}`);
    expect((await mt(['archive', there])).out).toBe(`archived ${there}`);
  });

  it('answers a wrong command line with exit 2', async () => {
    for (const argv of [['show', 'k_1', '--board', ''], ['stop', 'k_1', '--board', ' '], ['show'], ['show', 'a', 'b'], ['assign', 'k_1'], ['link', 'k_1'], ['stop', 'k_1', 'now'], ['comment', 'k_1'], ['unblock']]) {
      expect((await mt(argv)).code).toBe(2);
    }
  });
});

describe("in a board run's shell", () => {
  const RUN = { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 'not-a-token', MT_KANBAN_SOCKET: '/nowhere.sock' };

  it("refuses the operator's commands, and changes nothing", async () => {
    for (const argv of [['new', 'x'], ['list'], ['assign', 'k_1', 'default'], ['unblock', 'k_1'], ['stop', 'k_1'], ['archive', 'k_1']]) {
      const r = await mt(argv, { env: RUN });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/is an operator's command, not a board run's/);
    }
    expect(gateway.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });

  it("takes show, comment and link as the worker's, which never take the operator's arguments", async () => {
    for (const argv of [['show', 'k_1'], ['comment', 'k_1', 'hello'], ['link', 'k_1', 'k_2']]) {
      const r = await mt(argv, { env: RUN });
      expect(r.code).toBe(2);
      expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: 'bad_request' });
    }
  });
});
```

- [ ] **Step 10.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-kanban-operator-tasks.test.ts`. Expected: `Tests  10 failed | 3 passed (13)`: the task commands are usage errors, or the worker's.

- [ ] **Step 10.3: Implement.**

In `src/cli/operator.ts`, replace:

```ts
import { boardSetting } from '../kanban/chat-parse.js';
import type { KanbanService } from '../kanban/service.js';
import { maskAll, workerSocketPath } from '../kanban/socket.js';
import type { BoardRow, Refusal } from '../kanban/types.js';
import { NUDGE } from '../kanban/worker.js';
```

with:

```ts
import { readFileSync, statSync } from 'node:fs';
import { listed } from '../kanban/chat-render.js';
import { boardSetting, isPerson, LIST_FILTERS, tooBig, type NewTaskCommand } from '../kanban/chat-parse.js';
import type { KanbanService } from '../kanban/service.js';
import { maskAll, workerSocketPath } from '../kanban/socket.js';
import { DEFAULT_BOARD, type BoardRow, type Contract, type Refusal } from '../kanban/types.js';
import { NUDGE, WORKER_LIMITS } from '../kanban/worker.js';
import { visible } from '../names.js';
```

In `src/cli/operator.ts`, replace:

```ts
import { BIDI, boardsText, line } from './plain.js';
```

with:

```ts
import { BIDI, boardsText, line, listText, showText, who } from './plain.js';
```

In `src/cli/operator.ts`, replace:

```ts
}

/** `mt kanban <command>` outside a board run: the operator's. */
```

with:

```ts
}

/** A refusal made before the board is opened: a body that cannot be read, or is too big. */
function early(io: MtIo, json: boolean, code: string, message: string): number {
  if (json) io.out(jsonLine({ ok: false, code, message }));
  else io.err(`mt: ${line(message, 600)}`);
  return 1;
}

/**
 * A person is given work from chat, by @-mention, where the gateway can check
 * they have talk tier (spec §4.2): a terminal has no allowlist to check against.
 */
function personRefused(name: string): Outcome | undefined {
  if (!isPerson(name)) return undefined;
  return refused({
    code: 'person_not_assignable',
    message: `${JSON.stringify(name)} is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier`,
  });
}

/** One task id, and nothing else. */
function oneTask(positionals: readonly string[], what: string): string {
  const [taskId, extra] = positionals;
  if (taskId === undefined || extra !== undefined) throw new UsageError(`kanban ${what} takes a task id`);
  return taskId;
}

/** `--board` on a command that takes it, with `--json`. */
const BOARD_FLAGS = { ...JSON_FLAG, board: { type: 'string' } } as const;

/** A refusal unless a board of this name exists, archived or not. */
function noSuchBoard(service: KanbanService, board: string): Outcome | undefined {
  if (service.boards({ archived: true }).some((s) => s.board.name === board)) return undefined;
  return refused({ code: 'unknown_board', message: `there is no board ${visible(board)}` });
}

/**
 * With `--board`, a refusal unless the board exists and every task named is on
 * it (spec §16.4); without, nothing: a task id names its task on any board, as in chat.
 */
function offBoard(service: KanbanService, board: string | undefined, ...taskIds: string[]): Outcome | undefined {
  if (board === undefined) return undefined;
  const missing = noSuchBoard(service, board);
  if (missing !== undefined) return missing;
  for (const taskId of taskIds) {
    const r = service.show(taskId);
    if (!r.ok) return refused(r);
    const task = r.view.task;
    if (task.board !== board) {
      return refused({ code: 'other_board', message: `task ${task.taskId} is on board ${visible(task.board)}, not ${visible(board)}` });
    }
  }
  return undefined;
}

/** The new task's body: `--body`, or `--body-file`, `-` for stdin; or why not, already said. */
async function bodyOf(values: { body?: string | undefined; 'body-file'?: string | undefined }, io: MtIo, json: boolean): Promise<string | number> {
  const file = values['body-file'];
  if (values.body !== undefined && file !== undefined) throw new UsageError('kanban new takes --body or --body-file, not both');
  if (file === undefined) return values.body ?? '';
  const max = WORKER_LIMITS.body;
  if (file === '-') {
    if (io.stdinIsTTY === true) {
      return early(io, json, 'invalid', '--body-file - reads the body on stdin; stdin is a terminal: redirect a file or pipe it');
    }
    const text = await (io.stdin?.(max) ?? Promise.resolve(''));
    return text ?? early(io, json, 'too_large', `A body is at most ${max} bytes.`);
  }
  try {
    // A regular file only: a FIFO or a device could block, or never end.
    const st = statSync(file);
    if (!st.isFile()) return early(io, json, 'invalid', `${file} is not a regular file: give a file, or - for stdin`);
    if (st.size > max) return early(io, json, 'too_large', `A body is at most ${max} bytes.`);
    return readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    return early(io, json, 'invalid', `cannot read the body from ${file}: ${code}`);
  }
}

/** The flags of `mt kanban new`, and the contract field each fills (spec §4.3). */
const CONTRACT_FLAGS = {
  outcome: 'outcome',
  verify: 'verification',
  constraints: 'constraints',
  boundaries: 'boundaries',
  'stop-when': 'stop_when',
} as const;

/** `mt kanban new <title> [--board …] [--assignee …] …` (spec §9.1): `/kanban new`'s fields as flags. */
async function create(rest: readonly string[], io: MtIo): Promise<number> {
  const text = { type: 'string' } as const;
  const { values, positionals } = parse(rest, {
    ...JSON_FLAG,
    board: text,
    assignee: text,
    reviewer: text,
    workspace: text,
    parent: { type: 'string', multiple: true },
    outcome: text,
    verify: text,
    constraints: text,
    boundaries: text,
    'stop-when': text,
    body: text,
    'body-file': text,
  });
  const json = values.json === true;
  const title = positionals.join(' ').trim();
  if (title === '') throw new UsageError('kanban new takes a title');
  // One line, as chat's title is: a line break or a control character is refused, not silently changed.
  if (/[\p{Cc}\u2028\u2029]/u.test(title)) throw new UsageError('a title is one line, with no control characters');
  for (const flag of ['board', 'assignee', 'reviewer', 'workspace', ...Object.keys(CONTRACT_FLAGS)] as const) {
    const v = values[flag as keyof typeof values];
    if (typeof v === 'string' && v.trim() === '') throw new UsageError(`--${flag} needs a value`);
  }
  const parents = (values.parent ?? []).flatMap((p) => p.split(/[\s,]+/)).filter((p) => p !== '');
  if (values.parent !== undefined && parents.length === 0) throw new UsageError('--parent needs a value');
  const body = await bodyOf(values, io, json);
  if (typeof body === 'number') return body;
  const contract: Contract = {};
  for (const [flag, field] of Object.entries(CONTRACT_FLAGS)) {
    const v = values[flag as keyof typeof CONTRACT_FLAGS];
    if (v !== undefined) contract[field] = v.trim();
  }
  const command: NewTaskCommand = {
    verb: 'new',
    title,
    body: body.replace(/\r\n?/g, '\n').trimEnd(),
    parents,
    contract,
    ...(values.assignee === undefined ? {} : { assignee: values.assignee.trim() }),
    ...(values.reviewer === undefined ? {} : { reviewer: values.reviewer.trim() }),
    ...(values.workspace === undefined ? {} : { workspace: values.workspace.trim() }),
  };
  const big = tooBig(command);
  if (big !== undefined) return early(io, json, 'too_large', big);
  const board = boardFlag(values.board) ?? DEFAULT_BOARD;
  return act(io, json, 'mt kanban new', (service, by) => {
    for (const name of [command.assignee, command.reviewer]) {
      const person = name === undefined ? undefined : personRefused(name);
      if (person !== undefined) return person;
    }
    const r = service.create({
      board,
      title: command.title,
      ...(command.body === '' ? {} : { body: command.body }),
      contract: command.contract,
      ...(command.assignee === undefined ? {} : { assignee: command.assignee }),
      ...(command.reviewer === undefined ? {} : { reviewer: command.reviewer }),
      ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
      ...(command.parents.length === 0 ? {} : { parents: command.parents }),
      createdBy: by,
      createdVia: { kind: 'operator' },
    });
    if (!r.ok) return refused(r);
    const { task } = r;
    const whom = task.assignee === null ? `nobody yet (mt kanban assign ${task.taskId} <role> gives it to someone)` : who(task.assignee);
    const where = task.workspace === null ? '' : `, in ${line(task.workspace, 80)}`;
    return {
      ok: true,
      lines: [`created ${task.taskId}: ${line(task.title)}, for ${whom}${where}, on board ${line(task.board, 80)}`],
      json: { task_id: task.taskId, board: task.board },
      nudge: true,
    };
  });
}

/** `mt kanban list [<status>|all] [--board <name>]` (spec §9.1): one board's tasks, `default`'s unless named. */
function list(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [word, extra] = positionals;
  const filter = word === undefined ? undefined : LIST_FILTERS.find((f) => f === word.toLowerCase());
  if (extra !== undefined || (word !== undefined && filter === undefined)) {
    throw new UsageError(`kanban list takes at most one of ${LIST_FILTERS.join(', ')}`);
  }
  const board = boardFlag(values.board) ?? DEFAULT_BOARD;
  return act(io, values.json === true, 'mt kanban list', (service) => {
    const missing = noSuchBoard(service, board);
    if (missing !== undefined) return missing;
    const entries = service.list(board);
    const tasks = listed(entries, filter).map((e) => ({
      task_id: e.task.taskId,
      status: e.status,
      title: e.task.title,
      assignee: e.task.assignee?.name ?? null,
      assignee_kind: e.task.assignee?.kind ?? null,
    }));
    return { ok: true, lines: listText(entries, filter, board), json: { board, tasks } };
  });
}

/** `mt kanban show <task> [--board <name>]`: a task on any board, by id, or on the one named (spec §16.4). */
function show(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const taskId = oneTask(positionals, 'show');
  const board = boardFlag(values.board);
  return act(io, values.json === true, 'mt kanban show', (service) => {
    const guard = offBoard(service, board, taskId);
    if (guard !== undefined) return guard;
    const r = service.show(taskId);
    if (!r.ok) return refused(r);
    const gates = service.listGates(taskId);
    const g = gates.ok ? gates.gates : [];
    const { task } = r.view;
    return {
      ok: true,
      lines: showText(r.view, g),
      json: {
        task: {
          task_id: task.taskId,
          title: task.title,
          body: task.body,
          contract: task.contract,
          assignee: task.assignee?.name ?? null,
          reviewer: task.reviewer?.name ?? null,
          workspace: task.workspace,
          phase: task.phase,
          status: r.view.status,
          board: task.board,
          block_kind: task.blockKind,
          block_reason: task.blockReason,
        },
        parents: r.view.parents.map((p) => ({ task_id: p.taskId, phase: p.phase })),
        children: r.view.children.map((c) => ({ task_id: c.taskId, phase: c.phase })),
        gates: g.map((x) => ({ gate_id: x.id, command: x.command, timeout_s: x.timeoutS, by: x.createdBy })),
        runs: r.view.runs.map((run) => ({
          run_id: run.runId,
          attempt: run.attempt,
          kind: run.kind,
          assignee: run.assignee.name,
          outcome: run.outcome,
          summary: run.summary,
          error: run.error,
        })),
        comments: r.view.comments.map((c) => ({ author: c.author, body: c.body, created_at: c.createdAt })),
      },
    };
  });
}

/** `mt kanban assign <task> <role>`: an undecided run ends `superseded`, and the gateway's pass cancels its turn. */
function assign(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [taskId, name, extra] = positionals;
  if (taskId === undefined || name === undefined || extra !== undefined) throw new UsageError('kanban assign takes a task id and a role');
  const board = boardFlag(values.board);
  return act(io, values.json === true, 'mt kanban assign', (service, by) => {
    const person = personRefused(name);
    if (person !== undefined) return person;
    const guard = offBoard(service, board, taskId);
    if (guard !== undefined) return guard;
    const now = service.show(taskId);
    const current = now.ok ? now.view.task.assignee : null;
    if (current !== null && current.name === name) {
      return { ok: true, lines: [`${now.ok ? now.view.task.taskId : taskId} is already assigned to ${who(current)}`], json: { task_id: taskId, changed: false } };
    }
    const r = service.assign(taskId, name, by);
    if (!r.ok) return refused(r);
    const ended = r.run === undefined ? '' : `; its run ${r.run.runId} was ${r.run.outcome ?? 'ended'}`;
    return {
      ok: true,
      lines: [`${r.task.taskId} is now for ${who(r.task.assignee)}${ended}`],
      json: { task_id: r.task.taskId, changed: true, run_id: r.run?.runId ?? null, run_outcome: r.run?.outcome ?? null },
      nudge: true,
    };
  });
}

/** `mt kanban link <parent> <child>`. */
function link(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [parentId, childId, extra] = positionals;
  if (parentId === undefined || childId === undefined || extra !== undefined) {
    throw new UsageError('kanban link takes a parent task id and a child task id');
  }
  const board = boardFlag(values.board);
  return act(io, values.json === true, 'mt kanban link', (service, by) => {
    const guard = offBoard(service, board, parentId, childId);
    if (guard !== undefined) return guard;
    const r = service.link(parentId, childId, by);
    if (!r.ok) return refused(r);
    const [p, c] = [line(parentId, 80), line(childId, 80)];
    return { ok: true, lines: [r.added ? `${c} now waits for ${p}` : `${c} already waits for ${p}`], json: { added: r.added } };
  });
}

/** `mt kanban unblock <task> [comment]`, `stop <task>` and `archive <task>`: chat's, with the same outcomes. */
function decide(verb: 'unblock' | 'stop' | 'archive', rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [taskId, ...words] = positionals;
  if (taskId === undefined || (verb !== 'unblock' && words.length > 0)) {
    throw new UsageError(`kanban ${verb} takes a task id${verb === 'unblock' ? ', and a comment if you like' : ''}`);
  }
  const comment = words.join(' ').trim();
  const board = boardFlag(values.board);
  return act(io, values.json === true, `mt kanban ${verb}`, (service, by) => {
    const guard = offBoard(service, board, taskId);
    if (guard !== undefined) return guard;
    switch (verb) {
      case 'unblock': {
        const r = service.unblock(taskId, by, comment === '' ? undefined : comment);
        if (!r.ok) return refused(r);
        const t = r.task;
        return { ok: true, lines: [`${t.taskId} is unblocked, back to ${t.phase}`], json: { task_id: t.taskId, phase: t.phase }, nudge: true };
      }
      case 'stop': {
        const r = service.stop(taskId, by);
        if (!r.ok) return refused(r);
        const id = r.task.taskId;
        const said =
          r.run.outcome === 'cancelled'
            ? `stopped ${id}: its run was cancelled, and the task is blocked (needs_input); mt kanban unblock ${id} runs it again`
            : `${id}'s run had already reported (${r.run.outcome ?? 'undecided'}); it closes when its agent's turn ends, and the task keeps that outcome`;
        return { ok: true, lines: [said], json: { task_id: id, run_id: r.run.runId, run_outcome: r.run.outcome }, nudge: true };
      }
      case 'archive': {
        const r = service.archive(taskId, by);
        if (!r.ok) return refused(r);
        return { ok: true, lines: [`archived ${r.task.taskId}`], json: { task_id: r.task.taskId }, nudge: true };
      }
    }
  });
}

/** `mt kanban comment <task> <text>`: an operator's comment, which steers the task's agent (spec §7.5). */
function comment(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [taskId, ...words] = positionals;
  const text = words.join(' ').trim();
  if (taskId === undefined || text === '') throw new UsageError('kanban comment takes a task id and the comment');
  const board = boardFlag(values.board);
  if (Buffer.byteLength(text, 'utf8') > WORKER_LIMITS.comment) {
    return Promise.resolve(early(io, values.json === true, 'too_large', `A comment is at most ${WORKER_LIMITS.comment} bytes.`));
  }
  return act(io, values.json === true, 'mt kanban comment', (service, by) => {
    const guard = offBoard(service, board, taskId);
    if (guard !== undefined) return guard;
    const r = service.comment(taskId, text, by, { steers: true });
    if (!r.ok) return refused(r);
    const id = r.comment.taskId;
    return {
      ok: true,
      lines: [`comment added to ${id}: an agent working on it gets it when its current turn ends; otherwise the next run reads it`],
      json: { task_id: id, comment_id: r.comment.id },
    };
  });
}

/** `mt kanban <command>` outside a board run: the operator's. */
```

In `src/cli/operator.ts`, replace:

```ts
      return board(rest, io);
```

with:

```ts
      return board(rest, io);
    case 'new':
      return create(rest, io);
    case 'list':
      return list(rest, io);
    case 'show':
      return show(rest, io);
    case 'assign':
      return assign(rest, io);
    case 'link':
      return link(rest, io);
    case 'unblock':
    case 'stop':
    case 'archive':
      return decide(command, rest, io);
    case 'comment':
      return comment(rest, io);
```

In `src/cli/mt.ts`, replace:

```ts
import { parse, refuse, UsageError } from './args.js';
```

with:

```ts
import { parse, refuse, UsageError } from './args.js';
import { LIST_FILTERS } from '../kanban/chat-parse.js';
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban board archive <name> [--json]',
```

with:

```ts
  '  mt kanban board archive <name> [--json]',
  '  mt kanban new <title> [--board <name>] [--assignee <role>] [--reviewer <role>] [--workspace <name>]',
  '      [--parent <task>]... [--outcome "..."] [--verify "..."] [--constraints "..."] [--boundaries "..."]',
  '      [--stop-when "..."] [--body "..." | --body-file <path|->] [--json]',
  `  mt kanban list [${LIST_FILTERS.join('|')}] [--board <name>] [--json]`,
  '  mt kanban show <task_id> [--board <name>] [--json]',
  '  mt kanban assign <task_id> <role> [--board <name>] [--json]',
  '  mt kanban link <parent_id> <child_id> [--board <name>] [--json]',
  '  mt kanban unblock <task_id> [comment...] [--board <name>] [--json]',
  '  mt kanban stop <task_id> [--board <name>] [--json]',
  '  mt kanban archive <task_id> [--board <name>] [--json]',
  '  mt kanban comment <task_id> <text...> [--board <name>] [--json]',
```

In `src/cli/mt.ts`, replace:

```ts
const OPERATOR_ONLY: readonly string[] = ['gate', 'board'];
```

with:

```ts
const OPERATOR_ONLY: readonly string[] = ['gate', 'board', 'new', 'list', 'assign', 'unblock', 'stop', 'archive'];
```

- [ ] **Step 10.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1475 passed (1475)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.5: Commit.**

```bash
git add src/cli/operator.ts src/cli/mt.ts tests/mt-kanban-operator-tasks.test.ts
git commit -m "Add the operator's mt kanban new, list, show, assign, link, unblock, stop, archive and comment, with chat's meaning and answers: new takes chat's lines as flags, a one-line title, and its body from a flag, a regular file or stdin; a person is given work only from chat; and --board keeps a command to the tasks on that board"
```

---

### Task 11: The operator at a terminal, end to end

**Files:**
- Create: `tests/mt-operator.e2e.ts`

The real `mt`, as its own process through the shim the gateway writes, beside a real dispatcher, socket and fake CLI agent. The test never asks the dispatcher for a pass: the nudge starts a task created at the terminal, and cancels the turn of a run stopped there. Without Task 6 the second test's `idle()` would wait on the hanging agent for ever.

- [ ] **Step 11.1: Write the test.**

Create `tests/mt-operator.e2e.ts`:

```ts
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { KanbanService } from '../src/kanban/service.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * The operator's `mt kanban` end to end (spec §2.6): the real `mt`, as a process
 * of its own, writing the board a gateway has open, and nudging it over the real
 * socket. The gateway's dispatcher is never asked for a pass by the test: the
 * nudge is what starts a task created at the terminal, and what cancels the
 * turn of a run stopped there.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

interface Gateway {
  t: TestDb;
  dispatcher: Dispatcher;
  registry: SessionRegistry;
  server: WorkerServer;
  dir: string;
  home: string;
  log: string;
}

let g: Gateway | undefined;

beforeEach(() => clearSecrets());
afterEach(async () => {
  clearSecrets();
  if (g === undefined) return;
  await g.registry.closeAll();
  await g.dispatcher.idle(5_000);
  await g.server.close();
  g.t.close();
  rmSync(g.dir, { recursive: true, force: true });
  g = undefined;
});

/** A gateway's board, dispatcher and socket, with the role default run by the fake CLI agent in `mode`. */
async function gateway(mode: string): Promise<Gateway> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-op-e2e-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
  // What the operator's mt reads: the gateway's config, whose agent block is the role default.
  writeFileSync(
    join(home, 'config.yaml'),
    [
      `workspace: ${workspace}`,
      'kanban:',
      '  enabled: true',
      'agent:',
      '  driver: structured-cli',
      '  command: bytesec',
      '  unsupervised: true',
      '',
    ].join('\n'),
  );
  const log = join(dir, 'invocations.log');
  const t = testDb();
  const roles = new Map([['default', role('default')]]);
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']) });
  const drivers = new Map<string, Driver>([
    [
      'default',
      createCliDriver({
        command: process.execPath,
        args: [AGENT],
        env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: log, FAKE_CLI_SESSIONS: join(dir, 'sessions') },
      }),
    ],
  ]);
  let dispatcher: Dispatcher | undefined;
  const registry = new SessionRegistry({
    db: t.db,
    drivers,
    channels: new Map<string, Channel>([['kanban', new KanbanSink()]]),
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
    settings: { maxRunning: 2, defaultMaxRuntimeS: 600, strandedAfterS: 1800, sweepIntervalS: 60, nudgeLimit: 2 },
    worker: { socket, mtDir: writeMtShim(home), path: process.env['PATH'] },
  });
  const d = dispatcher;
  const api = new WorkerApi({ db: t.db, service, changed: () => d.pass() });
  const server = await listenWorker(socket, (request, signal) => api.handle(request, { signal }));
  g = { t, dispatcher, registry, server, dir, home, log };
  return g;
}

/** The operator's `mt kanban …`, as a process: the gateway's own build, through the shim it wrote. */
function operator(gw: Gateway, args: string[]): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const env = { MT_HOME: gw.home, MT_DB: join(gw.t.dir, 'team.db'), PATH: process.env['PATH'] ?? '', HOME: gw.dir };
    const child = spawn(join(gw.home, 'bin', 'mt'), ['kanban', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.on('data', (d: string) => (err += d));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, out: out.trim(), err: err.trim() }));
  });
}

async function waitFor(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`gave up waiting for ${what}`);
}

describe('the operator at a terminal, end to end', () => {
  it('creates a task the running gateway starts at once, nudged, and its agent completes', async () => {
    const gw = await gateway('kanban');
    const r = await operator(gw, ['new', 'Write the parser', '--assignee', 'default', '--workspace', 'default']);
    expect(r).toMatchObject({ status: 0, err: '' });
    const taskId = /^created (k_[0-9a-z]+):/.exec(r.out)?.[1] ?? '';
    expect(getTask(gw.t.db, taskId)?.createdVia).toEqual({ kind: 'operator' });

    await gw.dispatcher.idle();
    expect(getTask(gw.t.db, taskId)?.phase).toBe('done');
    expect(runsOf(gw.t.db, taskId)[0]).toMatchObject({ outcome: 'completed', summary: 'did: Write the parser' });
  });

  it("stops a running agent's run, whose turn the gateway cancels once nudged", async () => {
    const gw = await gateway('hang');
    const made = await operator(gw, ['new', 'Never finishes', '--assignee', 'default', '--workspace', 'default']);
    const taskId = /^created (k_[0-9a-z]+):/.exec(made.out)?.[1] ?? '';
    await waitFor(() => existsSync(gw.log) && readFileSync(gw.log, 'utf8').trim() !== '', 'the agent to start');

    const stopped = await operator(gw, ['stop', taskId]);
    expect(stopped).toMatchObject({ status: 0, err: '' });
    expect(stopped.out).toMatch(new RegExp(`^stopped ${taskId}: its run was cancelled`));

    await gw.dispatcher.idle();
    const [run] = runsOf(gw.t.db, taskId);
    expect(run).toMatchObject({ outcome: 'cancelled' });
    expect(run?.endedAt).not.toBeNull();
    expect(getTask(gw.t.db, taskId)?.phase).toBe('blocked');
  });
});
```

- [ ] **Step 11.2: Run it.** Run `npx vitest run --project e2e tests/mt-operator.e2e.ts`. Expected: `Tests  2 passed (2)`: what it proves was built in Tasks 5, 6, 9 and 10.

- [ ] **Step 11.3: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1475 passed (1475)`. Run `npx vitest run --project e2e`. Expected: `Tests  101 passed (101)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 11.4: Commit.**

```bash
git add tests/mt-operator.e2e.ts
git commit -m "Test the operator's mt kanban end to end: a task created at a terminal is started by the running gateway once nudged, and a run stopped there has its agent's turn cancelled"
```

---

### Task 12: The README and the guide

**Files:**
- Modify: `README.md`, `docs/kanban-guide.md`

`board list` where `boards` was, `team.db` where the database is named, the operator's commands in the README's `mt` section with `--board`, who they record and their limitations, and a section of the guide on the terminal. The spec and `docs/architecture.md` are already updated, by this plan's own commit.

- [ ] **Step 12.1: Write.**

In `README.md`, replace:

```markdown
| `db`, `downloads` | `MT_DB`, `MT_DOWNLOAD_DIR` | Derived from `MT_HOME` unless set. |
```

with:

```markdown
| `db`, `downloads` | `MT_DB`, `MT_DOWNLOAD_DIR` | `$MT_HOME/team.db` and `$MT_HOME/downloads` unless set. |
```

In `README.md`, replace:

```markdown
`mt` creates and checks roles and workspaces, and is how a board run's agent reports. In a
checkout, run it as `npm run -s mt -- …`.
```

with:

```markdown
`mt` creates and checks roles and workspaces, drives the board from a terminal, and is how a
board run's agent reports. In a checkout, run it as `npm run -s mt -- …`.
```

In `README.md`, replace:

```markdown
mt kanban <show|complete|review|changes|block|comment|create|link> < input.json
```

with:

```markdown
mt kanban board list [all]
mt kanban board create <name>
mt kanban board set <name> max_running <number|none>
mt kanban board set <name> workspace <workspace|none>
mt kanban board archive <name>
mt kanban new <title> [--board <name>] [--assignee <role>] [--reviewer <role>] [--workspace <name>]
    [--parent <task_id>]... [--outcome "..."] [--verify "..."] [--constraints "..."]
    [--boundaries "..."] [--stop-when "..."] [--body "..." | --body-file <path|->]
mt kanban list [todo|ready|running|review|reviewing|blocked|done|archived|all] [--board <name>]
mt kanban show <task_id> [--board <name>]
mt kanban assign <task_id> <role> [--board <name>]
mt kanban link <parent_id> <child_id> [--board <name>]
mt kanban unblock <task_id> [comment...] [--board <name>]
mt kanban stop <task_id> [--board <name>]
mt kanban archive <task_id> [--board <name>]
mt kanban comment <task_id> <text...> [--board <name>]
```

In `README.md`, replace:

````markdown
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

with:

````markdown
mt kanban gate remove <task_id> <gate_id>

# only in a board run's shell, where the gateway sets MT_KANBAN_RUN, MT_KANBAN_TOKEN and MT_KANBAN_SOCKET:
mt kanban <show|complete|review|changes|block|comment|create|link> < input.json
```

The role, workspace and operator's board commands find the home, config file and database the
way the gateway does (`MT_HOME`, `MT_CONFIG`, `MT_DB`; the database is `$MT_HOME/team.db` unless
set), from the shell they run in, and need no Lark settings. The role and workspace commands
only write files and never contact the gateway; changes take effect at the next start. The
operator's `mt kanban` commands are the one exception: they write the board's database, beside
a running gateway, through the board's own service, and take effect at once.

- `role create` writes `config.yaml` (from the role `default`, or `--clone-from`), a starter
````

In `README.md`, replace:

```markdown
- `kanban` is for the agent of a board run, not for a person: it works only with the run's
  `MT_KANBAN_RUN`, `MT_KANBAN_TOKEN` and `MT_KANBAN_SOCKET`, which the gateway gives each run.
```

with:

```markdown
- The operator's `kanban` commands are chat's `/kanban` commands at a terminal, with the same
  meaning, for whoever runs the gateway: `board list`, `create`, `set` and `archive`, and `new`,
  `list`, `show`, `assign`, `link`, `unblock`, `stop`, `archive` and `comment`. There is no
  `board use`, since a terminal is no chat: `new` and `list` take `--board <name>`, `default`
  unless given. The commands that name a task work on a task on any board, by id; given
  `--board <name>`, they refuse (`other_board`) a task on another board, and `link` refuses
  unless both tasks are on it. A `--board` naming no board is refused. They record who acted as
  `operator:<login>`, the login of the account the command runs as: run under `sudo -u`, that
  is the service account, not you. `new` takes `/kanban new`'s lines as flags; its title is the
  words that are not flags, on one line, and its body `--body`, or `--body-file` with a regular
  file, or `-` for stdin.
  `assign`, `--assignee` and `--reviewer` take a role: a person is given work from chat, by
  @-mention, where the gateway can check their tier. A task created here is followed by no
  chat, so nobody is told when it is done or blocks: `mt kanban show` and `list` tell you. Each
  prints plain text, or with `--json` one line of JSON, `{"ok": true, ...}` or
  `{"ok": false, "code": "...", "message": "..."}`; each exits 0 when done, 1 when refused, and
  2 for a wrong command line, said on stderr. After `new`, `assign`, `unblock`, `stop`,
  `archive` and `board set`, as after their chat forms, the gateway is asked over its socket to
  look for work at once, which also cancels the turn of an agent run the change ended; if no
  gateway answers, the change stands, and the gateway acts on it at its next sweep, or when it
  next starts. If the config does not set `kanban.enabled`, they say the board is off: the
  change is recorded, and nothing runs it until the board is turned on. They refuse to run in a
  board run's shell, where `MT_KANBAN_RUN` or `MT_KANBAN_TOKEN` is set.
- `kanban` in a board run's shell is for the run's agent, not for a person: it works only with
  the run's `MT_KANBAN_RUN`, `MT_KANBAN_TOKEN` and `MT_KANBAN_SOCKET`, which the gateway gives
  each run. There, `show`, `comment` and `link` are the agent's, which take no arguments, and
  the operator's commands are refused; elsewhere, `complete`, `review`, `changes`, `block` and
  `create` say they work only inside a run.
```

In `README.md`, replace:

```markdown
| `/kanban boards [all]` | talk: each board, its tasks, its own limit and workspace, and which one this chat is on |
```

with:

```markdown
| `/kanban board list [all]` | talk: each board, its tasks, its own limit and workspace, and which one this chat is on |
```

In `README.md`, replace:

```markdown
holds across boards. See section 10 of [docs/kanban-guide.md](docs/kanban-guide.md).
```

with:

```markdown
holds across boards. See section 10 of [docs/kanban-guide.md](docs/kanban-guide.md). From a
terminal, `mt kanban board …` and `mt kanban new|list --board <name>` do the same (see "The mt
command" above).
```

In `README.md`, replace:

```markdown
  reported once a slot frees and a pass tries it.
```

with:

```markdown
  reported once a slot frees and a pass tries it.
- A task created with `mt kanban new` is followed by no chat: nobody hears its notices, and a
  supervised role's approval requests on it reach nobody, as for any task no chat follows.
- `mt kanban` at a terminal cannot give a person work: assign people from chat.
- `mt kanban` refuses to run in a board run's shell, but that is not a security boundary: an
  agent runs as your user, could unset `MT_KANBAN_RUN` and `MT_KANBAN_TOKEN`, and could write
  the database itself. The same holds for `mt kanban gate`.
```

In `docs/kanban-guide.md`, replace:

```markdown
| Anyone at talk tier | `/kanban help`, `list`, `show`, `comment`, `gate list`, `boards` |
```

with:

```markdown
| Anyone at talk tier | `/kanban help`, `list`, `show`, `comment`, `gate list`, `board list` |
```

In `docs/kanban-guide.md`, replace:

````markdown
/kanban boards
```
````

with:

````markdown
/kanban board list
```
````

In `docs/kanban-guide.md`, replace:

```markdown
`/kanban boards all` lists archived boards too.
```

with:

```markdown
`/kanban board list all` lists archived boards too.
```

In `docs/kanban-guide.md`, replace:

```markdown
next `/kanban new`, and its `/kanban boards` still lists it, marked archived. `default` is never
```

with:

```markdown
next `/kanban new`, and its `/kanban board list` still lists it, marked archived. `default` is never
```

In `docs/kanban-guide.md`, replace:

````markdown
## 11. Rules of thumb
````

with:

````markdown
## 11. From a terminal

Whoever runs the gateway can drive the board from a shell on its host, with `mt kanban`: chat's
commands, with the same meaning, recorded as `operator:<login>`, the login of the account `mt`
runs as (under `sudo -u`, the service account). It needs no Lark settings,
and works beside the running gateway.

```
mt kanban board create web-app
mt kanban new "Draft the Q3 summary" --board web-app --assignee docs-writer --workspace docs \
    --outcome "a page in the team wiki" --verify "the page links every source" \
    --body "Use last quarter's page as the model."
mt kanban list --board web-app
mt kanban show k_…
mt kanban stop k_…
```

> created k\_…: Draft the Q3 summary, for role docs-writer, in docs, on board web-app

- There is no `board use`: a terminal is no chat. `new` and `list` take `--board <name>`, and
  are on `default` without it.
- The commands that name a task (`show`, `assign`, `link`, `unblock`, `stop`, `archive` and
  `comment`) work on a task on any board, by id. Give them `--board <name>` to be sure: a task
  on another board is then refused, and for `link` both tasks must be on it.

  > mt: task k\_… is on board default, not web-app
- `new` takes the lines of `/kanban new` as flags: `--assignee`, `--reviewer`, `--workspace`,
  `--parent` (as often as needed), `--outcome`, `--verify`, `--constraints`, `--boundaries` and
  `--stop-when`. The body is `--body "…"`, or `--body-file` with a file, or `-` to read it from
  stdin.
- Only roles: give a person work from chat, by @-mention.
- No chat follows a task created here, so nobody is told when it is done or blocks. Look with
  `mt kanban show`, or create it from chat if a group should hear.
- After a change, the running gateway is told to look for work at once, and to stop the agent
  of a run the change ended. If no gateway answers, `mt` says so; the change stands, and the
  gateway acts on it at its next sweep, or when it next starts. If the board is off on the
  gateway (`kanban.enabled` unset), `mt` says that instead: nothing runs the change until it
  is turned on.
- Add `--json` for one line of JSON, for scripts. `mt` exits 0 when done, 1 when refused, and
  2 for a wrong command line.

## 12. Rules of thumb
````

- [ ] **Step 12.2: Check.** Run `git grep -n -i "p[g]w" -- . ':!package-lock.json'`. Expected: no output. Run `git diff -U0 docs/kanban-guide.md README.md | grep '^+' | grep -c "$(printf '\342\200\224')"`, which counts the long dashes added. Expected: `0`. Run `git grep -n "kanban boards" -- README.md docs/kanban-guide.md src`. Expected: no output. Run `npx vitest run --project unit`. Expected: `Tests  1475 passed (1475)`. Run `npx vitest run --project e2e`. Expected: `Tests  101 passed (101)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 12.3: Commit.**

```bash
git add README.md docs/kanban-guide.md
git commit -m "Describe the operator's mt kanban commands in the README and the usage guide, list boards with /kanban board list there, and name the database team.db"
```

---

## Done when

- `npx vitest run --project unit` gives `Tests  1512 passed (1512)` (1475 at Task 12, before the review follow-ups). `npx vitest run --project e2e` gives `Tests  101 passed (101)`. `npm run typecheck` reports no errors. All under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- The default database is `$MT_HOME/team.db`, and `mt` finds it there (`tests/config.test.ts`, `tests/mt-gate.test.ts`).
- `/kanban board list [all]` answers as `/kanban boards` did, and `/kanban boards` is unknown (`tests/kanban-board-chat-parse.test.ts`, `tests/kanban-board-chat.test.ts`).
- The operator's `mt kanban board …` and task commands work beside the gateway's open database, as `operator:<login>`, in plain text and JSON, with exits 0, 1 and 2, and each command that names a task keeps to the board `--board` names (`tests/mt-kanban-operator.test.ts`, `tests/mt-kanban-operator-tasks.test.ts`).
- In a board run's shell the operator's commands are refused and `show`, `comment` and `link` are the worker's; outside one the worker's own names say they need a run (the same files, and `tests/mt-kanban.test.ts` unchanged).
- A change from the terminal nudges a running gateway, whose pass starts new work and cancels the turn of a run the change decided; with no gateway, the change stands and `mt` says so; with the board off, `mt` says that (`tests/kanban-worker-nudge.test.ts`, `tests/kanban-cancel-decided.test.ts`, `tests/mt-kanban-operator.test.ts`, `tests/mt-operator.e2e.ts`).
- `grep -n "from './mt.js'" src/cli/*.ts` shows only `import type` lines.

## Before using it: the deploy, and a smoke test against the live gateway

For the user, once the plan is built. The database is moved by hand, since the build has no transition code (Decision 17). If the service sets `MT_DB`, or `config.yaml` sets `db:`, the file is named there and keeps its name: skip step 3. Run the `sqlite3` and `mv` lines as the gateway's own user.

**Start neither build, and make sure no service manager (launchd, systemd, a supervisor) restarts the old one, from step 1 until step 5 starts the new one.** What each does if started at the wrong moment, whether or not `kanban.enabled` is set:

- **The old build** reads `gateway.db`. Started before the move, it opens the real database and writes to it, `-wal` included, so a move made while it runs splits the database from what it is still writing: stop it again before step 3. Started after the move, it finds no `gateway.db`, creates and migrates an empty one, and runs on that: the board looks empty, and whatever is created then is in the wrong file.
- **The new build** reads `team.db`. Started before the move, it creates and migrates an empty `team.db`, with its `-wal` and `-shm`; the move would put `gateway.db` beside that leftover `team.db-wal`, which SQLite would replay into the moved file, so step 3 stops if it finds any of them. Started after the move, it opens the moved database, as intended.

Either way the gateway's startup log names the file it opened, as `schema at version 6 (<path>)`, so a wrong file shows at once. Every step below works in `"${MT_HOME:-$HOME/.manus-team}"`, the gateway's home; set `MT_HOME` first if the service sets it.

1. Stop the gateway.
2. Back up, from the home:
   ```bash
   cd "${MT_HOME:-$HOME/.manus-team}" || exit 1
   [ -e gateway.db ] || { echo "no gateway.db here: stop"; exit 1; }
   sqlite3 gateway.db ".backup gateway-pre-rename.db" || exit 1
   ```
   (`.backup` takes what is still in the `-wal` file too, which a `cp` could miss.)
3. `mv` gateway.db, gateway.db-wal and gateway.db-shm (if they exist) to team.db, team.db-wal and team.db-shm, after checking that `gateway.db` is there and none of the new names is:
   ```bash
   cd "${MT_HOME:-$HOME/.manus-team}" || exit 1
   [ -e gateway.db ] || { echo "no gateway.db here: stop"; exit 1; }
   for f in team.db team.db-wal team.db-shm; do [ -e "$f" ] && { echo "$f exists: stop"; exit 1; }; done
   mv gateway.db team.db || exit 1
   if [ -e gateway.db-wal ]; then mv gateway.db-wal team.db-wal || exit 1; fi
   if [ -e gateway.db-shm ]; then mv gateway.db-shm team.db-shm || exit 1; fi
   ```
   Run each block in a subshell (`( … )`) or a script, so its `exit` does not close your terminal. All three move together: SQLite finds a database's WAL by its name, and a `-wal` left behind would lose what is in it. If the check stops it on a `team.db`, a new build has started since step 1: stop it, and count the tasks in the stray file before removing anything, `sqlite3 team.db "SELECT count(*) FROM kanban_tasks"`. It should print `0`, or fail with `no such table` if it was not migrated; then remove `team.db`, `team.db-wal` and `team.db-shm` and run step 3 again. Any other number means tasks were created in it: stop, and keep all the files until you have looked.
4. Merge `operator-cli` into `main`, and update the checkout the gateway runs from.
5. Start the gateway. Its log says `schema at version 6 (…/team.db)`. Check that the task count is unchanged, and that no `gateway.db` was created beside it:
   ```bash
   cd "${MT_HOME:-$HOME/.manus-team}" || exit 1
   sqlite3 team.db "PRAGMA user_version; SELECT count(*) FROM kanban_tasks"
   sqlite3 gateway-pre-rename.db "SELECT count(*) FROM kanban_tasks"
   [ -e gateway.db ] && echo "a gateway.db was created: an old build ran"
   ```
   The first prints `6` and the same count as the second; the last prints nothing.

Then, with `kanban.enabled: true`, on a role on a cheap model; `<role>` below is its name. In a checkout, `mt` is `npm run -s mt -- …`, run from a shell as the gateway's user, which is the login the board records.

6. In a chat with the bot: `/kanban board list` answers as `/kanban boards` used to; `/kanban boards` says it is an unknown command.
7. `mt kanban board list` prints `default: …` with its counts, as chat does.
8. `mt kanban new "Smoke: reply with the word hello" --assignee <role>` prints `created k_…: …, on board default`, and nothing on stderr: the gateway answered the nudge. The task starts at once, with no sweep to wait for; `mt kanban show k_…` reaches `done`.
9. `mt kanban new "Smoke: count slowly to 600, one number a second" --assignee <role>`, and once `mt kanban show` says `running`, `mt kanban stop k_… --board default`: it prints `stopped k_…: its run was cancelled, …`, the agent's process ends within seconds, and `show` says `blocked`, with the run `cancelled`. `mt kanban show k_… --board smoke` is refused: there is no board smoke.
10. `mt kanban list all --json` prints one line of JSON with both tasks. `MT_KANBAN_RUN=x mt kanban list` is refused as an operator's command; `mt kanban complete` answers `not_in_a_run`.
11. Clean up: `mt kanban archive k_…` for each, which prints `archived k_…`.

## Review follow-ups

A review of the built branch, at 1475 unit and 101 end-to-end tests, found these. Each fix was test first; the counts after them are 1512 unit and 101 end to end, with `npx tsc --noEmit` clean and the name grep empty.

| # | Finding | Outcome |
|---|---|---|
| 1 | A bidi control inside a secret defeated the terminal's mask: `clean()` removed bidi controls after masking, so `line('key sk-live-12<U+202E>34567890')` printed the secret. Chat had the same gap: `masked()`, the escapers, notices, cards and the router's answers masked before anything removed such a character, so a secret split by a zero-width or bidi character showed in Lark with an invisible break | Two parts. The terminal's `clean()` now strips control characters, then `INVISIBLE` (the bidi controls U+202A to U+202E and U+2066 to U+2069, the zero-width characters U+200B to U+200D and U+FEFF, and the marks U+200E, U+200F and U+061C, in `src/text.ts`), then masks, then makes CR, CRLF, U+2028 and U+2029 newlines. For chat and every other display, the shared place is `redactKnownSecrets` in `src/secrets.ts`: it matches each secret both as written and on the text with those characters skipped, and masks the span with them inside it; two spans apart only by such characters become one `••••`; a secret registered with one is known without it too; and `withholdSecretPrefix` and `withholdSecretSuffix` withhold a fragment split by one. Chosen over stripping them before display, which would harm legitimate text: the zero-width joiner holds emoji sequences together (a family emoji falls apart without it), the non-joiner is part of Persian and Indic spelling, and the direction marks keep right-to-left text with numbers and punctuation in order. Outside a secret they are kept, and tested so. Tested with the secret split by each of the twelve characters in `line`, a body (`indented`) and an output (`tailOf`), and through `forDisplay`, `forMarkdown`, `forPlainText` and `/kanban show` and `list` |
| 2 | `jsonLine` left DEL unescaped | The range is `\u007F-\u009F` |
| 3 | Socket nudges each got their own pass, since they arrive on separate ticks, so Decision 9 overstated the coalescing | Throttled: at most one nudge-driven pass in each 100 ms (`NUDGE_INTERVAL_MS`), with a trailing timer so the last nudge in a window is never lost; `WorkerApi.stop()`, called as the gateway stops, drops a waiting one. Tested with fake timers. Decision 9, the known limitation, and the spec's §7.3 and §10 say so |
| 4 | The title was trimmed before the control-character check, so `$'line\n'` and a leading tab were accepted | The joined words are checked first, then trimmed |
| 5 | A title could hold a bidi control | Refused with the control characters: `a title is one line, with no control characters and no bidi controls` |
| 6 | After a change, a refused or dropped socket said "try again", which for `new` would create a second task | The nudge's own reason, `ECONNREFUSED; it may be busy, or stopped`, and the message says the change stands and running the command again would make it twice. The worker CLI's `why()` is unchanged: its request was not made |
| 7 | In a run's shell, an operator's command parsed its arguments, and could read stdin, before refusing | `mt.ts` checks `inBoardRun` before parsing an operator's command: the refusal comes first, in JSON when `--json` is among the words, and names the subcommand (`mt kanban board set`, `mt kanban gate add`). Tested with a stdin that records being read |
| 8 | Nits | `assign` trims its role; the "already assigned" JSON gives the task's own id, as its text does (ids are matched exactly, so this changes no answer today); the board-off message says `sets kanban.enabled to false` when the config does, and `does not set kanban.enabled` when it is absent: `TeamSettings.kanbanEnabled` is now absent when unset |
| 9 | The deploy's smoke test used `~/.manus-team` in some steps, moved without checking `gateway.db` was there, removed a stray `team.db` unseen, and did not say what each build does when started at the wrong moment | Every step works in `"${MT_HOME:-$HOME/.manus-team}"`; the backup and the move refuse when `gateway.db` is missing, and each `mv` is followed by `|| exit 1`; a stray `team.db` has its tasks counted before it is removed; and the section says what the old build and the new build each do if started before or after the move |
| 10 | The startup log did not name the database | `schema at version 6 (<path>)`; a test asserts it (none asserted the old line) |
| 11 | `chat-parse.ts`, described as pure, imported `worker.js` at run time for `WORKER_LIMITS` | `WORKER_LIMITS` moved to the leaf module `src/kanban/limits.ts`, which both import; `worker.ts` re-exports it, so its importers are unchanged |
