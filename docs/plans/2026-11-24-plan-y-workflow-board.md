# Plan Y: A workflow's own board. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workflow file name the board its tasks go on, with `board: <name>`. Chat on any board and the terminal with no `--board` put the tasks there; a different `--board`, and a run on another board, are refused `other_board`; preview's DAG carries the board, and an apply of a DAG whose workflow's file names another board is refused. A missing or archived board refuses a start, a preview and an apply, and is said at startup, in `mt service check` and in the lists; `mt workflow check` says boards are checked by the gateway. Chat's `/kanban task list` takes `board:<name>`, and a start's reply points to it when the board is not the chat's.

**Architecture:** one phase, no migration.

- **The pure parts** (`src/kanban/workflow.ts`, Task 1): the key, `startBoard`, `workflowBoard` with its three answers, `withBoards` and the two problems.
- **The service** (`src/kanban/service.ts`, Tasks 2 to 4): the routing and the board's refusals; step 0; apply against its workflow's file; the lists and two reads for chat.
- **The boards at a path** (`src/db/boards-at.ts`, Task 5): the read-only read the startup and the terminal's preview share, with `openDbReadOnly`'s busy timeout.
- **The fronts** (Tasks 6 to 10): the startup and `mt service check`; `mt workflow check`; the terminal's `start`, `preview` and `list`; chat's start, preview and list renderers; chat's `task list board:`.
- **The documents** (Task 11): the guide, the README, the examples' tests.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3 11, `yaml` 2. No new dependency. No migration.

**Spec:** `docs/specs/2026-11-16-workflows-design.md` §19, as approved at `345ecea`, with its notes in §1, §4 to §7, §9, §10 and §14, and the kanban spec's notes in §16.3 and §16.4. Below, "§19.n" is that spec's.

---

## Ground rules

- **Where to work.** The worktree `/Users/x/Develop/manus/prime-gateway-wt2`, branch `workflow-board`, which holds the spec and this plan. Never edit `/Users/x/Develop/manus/prime-gateway` or `/Users/x/Develop/manus/prime-gateway-work`; never start the gateway, reach Lark or the network, or touch `~/.manus-team`. Every test makes its own home in a temporary directory.
- **Commits.** One a task, test first, named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's and stays untracked. Plain-English messages: no trailer, no mention of Claude or AI, no Chinese text, no long dash. The letters `p`, `g`, `w` in that order must not appear in anything written. No plan letter in a word a person sees.
- **Node 22.** `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every npm or vitest command.
- **Baseline.** At `345ecea`, `npx vitest run --project unit` gives `Tests  7 failed | 3361 passed (3368)`: the five tests of `tests/docs-examples.test.ts` and the one of `tests/docs-wake.test.ts` that read weekly-report, which names `board: reports` since the spec's commit, and `tests/update-run.test.ts`, which flakes under load (run it alone: it passes). `npx vitest run --project e2e` gives `Tests  183 passed (183)`. Main's baseline is 3368 unit and 183 e2e.
- **The plan follows the code.** Where a step turns out wrong while building, the plan is fixed in the same commit as the task.
- **Finding edits.** Each edit is found by its quoted text, not by line number.
- **One writer.** `src/db/kanban.ts` is unchanged: nothing here writes a new row.

## Decisions

Each tied to §19.

1. **No migration** (§19.1): the key is a file's, the board a row that already exists.
2. **`startBoard` is pure and shared** (§19.2): the service and the terminal's preview route through one function, so the table's six rows are one code path.
3. **The service tells a chat's board from an asked one by `createdVia.kind`** (§19.2): `chat` overruled by the file; `operator` overruled only when `StartRequest.board` is absent, which the terminal now leaves out unless `--board` is given, in both of its calls (§19.10, decision 12).
4. **Step 0 waives only the board** (§19.2, decision 1): `keyRefused` is called again with `want.board` set to the instance's board, so the source and the name still refuse.
5. **`workflowBoard` reuses the entry rules of `readWorkflow`** (`notAWorkflow`, `readFile`) and parses with the same `yaml` call, so its `unreadable` is `readWorkflow`'s `unknown_workflow` and file errors, and nothing new decides what a workflow file is.
6. **The boards at a path are read in one module**, `src/db/boards-at.ts` (§19.4), by the startup and the terminal's preview, so `user_version` below 6, a missing database and a database that cannot be read are judged once.
7. **`withBoards` takes a map from name to archived**, built from `boardsOf(db, { archived: true })` in the service and from `boardsAt` elsewhere, so one pure function judges every list.
8. **Chat's list keeps today's words without `board:`** (§19.5): `renderList` gains an optional `named` argument; the strings without it are not touched.

## File map

| File | Change |
|---|---|
| `src/kanban/workflow.ts` | `board` key, `Workflow.board`, `startBoard`, `workflowBoard`, `withBoards`, `missingBoardProblem`, `archivedBoardProblem` |
| `src/kanban/service.ts` | routing in the expansion, the board's messages, step 0, apply's check, `workflows()` and `#usable` with boards, `workflowBoard(name)`, `boardNamed(name)` |
| `src/db/open.ts` | `openDbReadOnly(path, busyTimeoutMs?)` |
| `src/db/boards-at.ts` | new: `boardsAt(dbPath)` |
| `src/index.ts` | `startupWorkflows` with the boards |
| `src/cli/workflow.ts` | `okLine`'s `; board b`, the note |
| `src/cli/operator.ts` | `start`'s board only when given, `preview`'s routing and board check, `list`'s `--json` `board` |
| `src/cli/plain.ts` | `workflowsText`' ` · board b` |
| `src/kanban/chat-parse.ts` | `task list` with `board:<name>` |
| `src/kanban/chat.ts` | the start's archived check, the renderers given the chat's board, `list` on a named board |
| `src/kanban/chat-render.ts` | `renderStarted`, `renderPreview`, `renderWorkflows`, `renderList` |
| `docs/kanban-guide.md`, `README.md` | §19.8's edits |
| `tests/docs-examples.test.ts`, `tests/docs-wake.test.ts` | the board assertion; `reports` created |
| `tests/kanban-workflow-board.test.ts` | new: Tasks 1 to 4 |
| `tests/kanban-workflow-board-fronts.test.ts` | new: Tasks 5 to 10 |

---

## Task 1: The key, the routing and the light read

**Files:** `src/kanban/workflow.ts`; test `tests/kanban-workflow-board.test.ts` (new).

- [ ] **Step 1: Write the tests.** A `describe('the board key')`: `board: vi` read into `workflow.board`; absent and `board:` with nothing after it both `undefined`; `""`, `none`, `all`, `"{{team}}"`, `Vi`, `vi-`, `3` and `[vi]` each refused with a problem starting `board`. A `describe('startBoard')` with the six rows of §19.2's table, and the file with no board giving each path's own. A `describe('workflowBoard')`: a missing file, a symlink, a directory, a file over 64 KiB and one that does not parse give `{ file: 'unreadable' }`; a file with no key, a list at the root and `board: none` give `{ file: 'read', board: undefined }`; `board: vi` gives `{ file: 'read', board: 'vi' }`, also when the file is otherwise broken (an unknown role). A `describe('withBoards')`: a usable workflow on a missing board and one on an archived board moved to `broken` with §19.4's problems; one naming no board, and one naming `default` with only `default` known, kept.
- [ ] **Step 2: Verify they fail.** `npx vitest run tests/kanban-workflow-board.test.ts`: the file fails to collect, `Error: unknown setting board (known: description, params, steps)`, as its `describe('startBoard')` parses a file at collection.
- [ ] **Step 2a: Update** `tests/kanban-workflow-file.test.ts`'s unknown-key test to `unknown setting name (known: description, board, params, steps)`.
- [ ] **Step 3: Implement.**
  - `checkWorkflow`: `'board'` in the root's `reject` list; after `description`:

    ```ts
    let board: string | undefined;
    if (root['board'] !== undefined && root['board'] !== null) {
      const b = text(root['board'], 'board');
      const bad = nameProblem('board', b);
      if (bad !== undefined) fail(`board: ${bad}`);
      board = b;
    }
    ```

    and `board` in the returned workflow; `Workflow` gains `board: string | undefined`.
  - `startBoard(w, path: BoardPath): Result<{ board: string; fromFile: boolean }>`, `BoardPath` being `{ kind: 'chat'; board: string } | { kind: 'terminal'; board: string | undefined } | { kind: 'run'; board: string }`, with §19.2's two messages.
  - `workflowBoard(dir, name): WorkflowBoardRead`, `{ file: 'unreadable' } | { file: 'read'; board: string | undefined }`: `NAME_PATTERN`, `statOf`, `notAWorkflow` and `readFile` as `readWorkflow` uses them, then `parseYaml` in a `try`, a root that `isRecord`, and a `board` that is text with no `nameProblem('board', …)`.
  - `missingBoardProblem(b)`, `archivedBoardProblem(b)`, and `withBoards(list, boards: ReadonlyMap<string, boolean>)`.
- [ ] **Step 4: Run everything.** Unit: `Tests  1 failed | 3376 passed (3377)`: the nine new tests pass, and the docs tests that only needed the key accepted pass with it (their starts still land on `default`, which their assertions do not yet check); the one failure is `docs-examples`' "says what each documented mt workflow check says", fixed by Task 7. Typecheck clean.
- [ ] **Step 5: Commit** "Read a workflow file's board, route a start by it, and judge the boards a list names".

## Task 2: The service routes a start and a preview, and names the workflow in a board's refusal

**Files:** `src/kanban/service.ts`; test `tests/kanban-workflow-board.test.ts`.

- [ ] **Step 1: Tests**, on a service over a test database with `vi` created and `vi-sync.yaml` naming `board: vi`:
  - a chat start from `default` makes the instance on `vi`, its members on `vi`, the chat following them; a file with no board starts on the chat's;
  - an operator start with no board on `vi`, with `board: 'vi'` on `vi`, with `board: 'x'` refused `other_board`, `workflow vi-sync puts its tasks on board vi, not x`, nothing made;
  - a run whose task is on `vi` makes it there; on `default`, refused `other_board`, `workflow vi-sync puts its tasks on board vi, and a run's work stays on its task's board, default`;
  - `vi` missing, then archived: start and preview refused `unknown_board` and `board_archived` with §19.4's messages, nothing made; a file with no board on an archived chat board keeps `board … is archived; nothing is added to it`;
  - the preview's DAG carries `board: 'vi'`.
- [ ] **Step 2: Verify they fail**: with the tests on Task 1's tree, the five new tests fail, the chat start on `default` (`Tests  5 failed | 9 passed (14)`).
- [ ] **Step 3: Implement.** `#expanded(req, on)` routes with `startBoard` after `#workflow`, the path built from `req.createdVia.kind`, and returns `board` and `fromFile`; `expand` takes the routed board. `previewWorkflow` and `startWorkflow` use it for `#checkDag` and `#write`. `#checkDag(dag, onBoard, createdBy, createdVia, workflow?)` says `workflow ${w} is not usable: ${missingBoardProblem(b)}` when given the name.
- [ ] **Step 4: Run everything.** Unit: `Tests  4 failed | 3378 passed (3382)`, five new. The terminal's start still passes `--board`'s default, `default`, so a terminal start of weekly-report is now refused `other_board`: `docs-examples`' terminal start and cron script tests and `docs-wake`'s start fail until Task 8, and its `mt workflow check` test until Task 7. (`tests/update-run.test.ts` may add a flake; it passes alone.)
- [ ] **Step 5: Commit** "Put a workflow's tasks on its file's board, refusing another --board and a run on another board".

## Task 3: Step 0 allows for the file's board

**Files:** `src/kanban/service.ts`; test `tests/kanban-workflow-board.test.ts`.

- [ ] **Step 1: Tests.** A chat start keyed `lark:om_1` on `vi`, repeated from a chat on `default`: `existing: true`; repeated after the file is removed, or made unparseable: `existing: true`; after the file names `research`, or no board: `other_board`. The same for an operator start with `--key` and no board; with `board: 'default'` given, `other_board` as today. A key reused for another workflow whose file is missing, the instance on another board: `invalid`.
- [ ] **Step 2: Verify they fail**: on Task 2's tree the three new tests fail, the first repeat `other_board` (`Tests  3 failed | 14 passed (17)`).
- [ ] **Step 3: Implement.** The service's `workflowBoard(name)`, the light read over `this.#workflowsDir`, `unreadable` without one, is added here, as step 0 is its first reader. `#repeat(key, want, fileOf?: string)`: when `keyRefused` answers `other_board`, `fileOf` names the workflow and the instance is on another board than `want.board`, `this.workflowBoard(fileOf)` is read; on `unreadable`, or `read` naming the instance's board, `keyRefused(keyed, { ...want, board: keyed.instance.board })` decides. `startWorkflow` passes the workflow's name for a chat start, and for an operator start with no `board`.
- [ ] **Step 4: Run everything.** Unit: `Tests  4 failed | 3381 passed (3385)`, three new; the same four docs failures as Task 2.
- [ ] **Step 5: Commit** "Answer a start's repeat on its file's board, waiving only the board when the file cannot be read".

## Task 4: Apply against its workflow's file, and the lists and reads for chat

**Files:** `src/kanban/service.ts`; test `tests/kanban-workflow-board.test.ts`.

- [ ] **Step 1: Tests.** A preview's DAG applied on `vi`; its `board` edited to `default`, or deleted: `apply` and a dry run refused `other_board`, `the DAG names workflow vi-sync, which puts its tasks on board vi, not default`; with `workflow: null`, made on `default`; with the file removed, made; a repeat answered before the check. `vi` archived after the preview: the apply refused with the workflow's message. `workflows()` lists a workflow on a missing board as not usable; `startWorkflow` of an unknown name leaves it out of the usable ones. `workflowBoard('vi-sync')` and `boardNamed('vi')`.
- [ ] **Step 2: Verify they fail**: on Task 3's tree four of the five new tests fail, the edited DAG made (`Tests  4 failed | 18 passed (22)`); the one with `workflow: null` and a removed file passes there already, a guard that the check stays narrow.
- [ ] **Step 3: Implement.** In `applyDag`, after the repeat and for a caller not a run, with `shaped.dag.workflow !== null`: `workflowBoard`; on `{ file: 'read', board }` a board other than `shaped.dag.board ?? DEFAULT_BOARD` refused, and the same board passed to `#checkDag` as the workflow's. `#boards()` from `boardsOf(this.#db, { archived: true })`; `workflows()` and `#usable` apply `withBoards`. `boardNamed(name)` is `getBoard`.
- [ ] **Step 4: Run everything.** Unit: `Tests  4 failed | 3386 passed (3390)`, five new; the same four docs failures.
- [ ] **Step 5: Commit** "Hold an applied DAG to its workflow's board, and judge the boards in the service's lists".

## Task 5: The boards at a path

**Files:** `src/db/open.ts`, `src/db/boards-at.ts` (new); test `tests/kanban-workflow-board-fronts.test.ts` (new).

- [ ] **Step 1: Tests.** `boardsAt` of no file: `default` alone; of a database at `user_version` 5: `default` alone; of a migrated one with `vi` and an archived `old`: all three, `old` archived; of a database held by `BEGIN EXCLUSIVE` in a second connection with a journal mode that blocks readers (`journal_mode = DELETE`): `{ ok: false }` with a reason matching `/locked|busy/i`, after the busy timeout. Three tests.
- [ ] **Step 2: Verify they fail**: the file fails to collect, as `src/db/boards-at.ts` does not exist.
- [ ] **Step 3: Implement.** `openDbReadOnly(path, busyTimeoutMs?)` sets the pragma when given. `boardsAt(dbPath): { ok: true; boards: Map<string, boolean> } | { ok: false; why: string }`, opening with 1000 ms, `user_version` below 6 giving `default` alone, and closing in `finally`.
- [ ] **Step 4: Run everything.** Unit: `Tests  4 failed | 3389 passed (3393)`, three new; the same four docs failures.
- [ ] **Step 5: Commit** "Read the boards at a database path, read-only, for the startup and the terminal".

## Task 6: The startup and mt service check

**Files:** `src/index.ts`; test `tests/kanban-workflow-board-fronts.test.ts`.

- [ ] **Step 1: Tests**, three, in `tests/kanban-workflow-board-fronts.test.ts`'s `describe('the startup')`. `loadStartup` over a home whose workflow names `vi`: with no database, `workflow vi-sync is not usable: its board vi does not exist (create it with /kanban board create vi, or mt kanban board create vi)` and `not usable: vi-sync` in the summary; with `vi` archived, the archived words; with `vi` live, usable; a workflow naming `default`, usable with no database; a locked database, the line `workflow boards are not checked: the database cannot be read: …`, the workflow judged by its file.
- [ ] **Step 2: Verify they fail**: on Task 5's tree the three fail, the workflow usable (`Tests  3 failed | 3 passed (6)`).
- [ ] **Step 3: Implement.** `startupWorkflows` reads `boardsAt(config.dbPath)`, applies `withBoards`, and puts the unreadable line first. *After the final review:* it reads the boards only when a usable workflow names one, so with none it opens nothing and says nothing of boards.
- [ ] **Step 4: Run everything.** Unit: `Tests  4 failed | 3392 passed (3396)`, three new; the same four docs failures. `mt service check` needs no change: its `startupWarnings` prints every line but the summary as a warning, which `tests/kanban-workflow-check.test.ts`'s "mt service check's warnings" already tests.
- [ ] **Step 5: Commit** "Say at startup when a workflow's board is missing or archived".

## Task 7: mt workflow check

**Files:** `src/cli/workflow.ts`; test `tests/kanban-workflow-board-fronts.test.ts`.

- [ ] **Step 1: Tests**, two, through `runMt`. `mt workflow check vi-sync`: `vi-sync: ok, 1 step; params: none; board vi`, then `note: the gateway checks the board when the workflow is used, not here: this check opens no database`, exit 0 with no board `vi` anywhere; a check of every file prints the note once for two such workflows, none when no workflow names a board.
- [ ] **Step 2: Verify they fail**: on Task 6's tree both fail, with no `; board vi` (`Tests  2 failed | 6 passed (8)`).
- [ ] **Step 3: Implement.** `okLine` adds `; board ${w.board}`; `BOARDS_NOTE` after the lines, before the ignored entries, when a usable workflow it printed names a board, and after the one line of a check by name.
- [ ] **Step 4: Run everything.** Unit: `Tests  4 failed | 3394 passed (3398)`, two new, one of the failures `tests/update-run.test.ts`'s flake (it passes alone); `docs-examples`' "says what each documented mt workflow check says" passes, and the three start failures of Task 2 remain.
- [ ] **Step 5: Commit** "Name a workflow's board in mt workflow check, saying the gateway checks it".

## Task 8: The terminal's start, preview and list

**Files:** `src/cli/operator.ts`, `src/cli/plain.ts`; tests `tests/kanban-workflow-board-fronts.test.ts`, `tests/mt-wake-shell.test.ts`.

- [ ] **Step 1: Tests**, through `runMt` over a home:
  - `mt kanban workflow start vi-sync` with no `--board`: `on board vi`; `--board vi` the same; `--board x` refused, `mt: workflow vi-sync puts its tasks on board vi, not x`;
  - in `tests/mt-wake-shell.test.ts`, a woken turn's shell (its `setup(true)`), a start with no `--board` and no `--wake` of a file naming `vi` whose second step says `wake: true`: both members on `vi`, the second's wake set as the setter at depth 2, the first's not;
  - `preview vi-sync --json`: `"board": "vi"`; with `vi` missing, refused on stderr with the workflow's message and nothing on stdout; with no database at all, refused as missing; a file naming no board with `--board nowhere`: made, as today; a database that cannot be read: the stderr line `mt: the boards are not checked: the database cannot be read: …`, exit 0, stdout the DAG alone; an unknown name: the message leaving out a workflow on a missing board;
  - `mt kanban workflow list`: `vi-sync: params none · board vi`, `--json` `board: 'vi'`, and `null` for a file naming none.
- [ ] **Step 2: Verify they fail**: on Task 7's tree the five terminal tests and the woken shell's fail, the start refused `other_board` for `--board`'s default (`Tests  6 failed | 22 passed (28)` over the two files).
- [ ] **Step 3: Implement.** `start` passes `board` only when `--board` is given, in its preview and its start (`onBoard`). `preview` routes with `startBoard`; when the file names a board it reads `boardsAt(settings.dbPath)`, refusing a missing or archived one with the workflow's message, and saying the stderr line on `ok: false`; its `unknown_workflow` reads the boards only when a usable workflow names one. `workflowsText` and the list's JSON name the board.
- [ ] **Step 4: Run everything.** Unit: `Tests  2 failed | 3402 passed (3404)`, six new; `docs-examples` passes whole, its home having `reports`; `docs-wake`'s start now fails only for want of `reports` in its home (`unknown_board`), fixed in Task 11; the other failure is `tests/update-run.test.ts`'s flake.
- [ ] **Step 5: Commit** "Route the terminal's start and preview by the file's board, and name it in the list".

## Task 9: Chat's start, preview and workflow list

**Files:** `src/kanban/chat.ts`, `src/kanban/chat-render.ts`; test `tests/kanban-workflow-board-fronts.test.ts`.

- [ ] **Step 1: Tests**, four, through a `KanbanChat` in a direct message, as `tests/kanban-workflow-chat.test.ts` builds one, its board moved with `/kanban board use`:
  - `/kanban workflow start vi-sync` from a chat on `default`: ``Started vi-sync as `w_…`, 1 task, on board **vi**:``, the task line, then ``Its tasks are on board **vi**: `/kanban task list board:vi` lists that board.``, then the line saying who hears; from a chat on `vi`, no pointer; a file naming `default` from a chat on `vi`: named `**default**`, with the pointer;
  - a chat on an archived board starts it on `vi`; a file with no board there gets today's sentence;
  - a preview names the board as the reply does;
  - `/kanban workflow list`: `- **vi-sync** · params: none · board **vi**`.
- [ ] **Step 2: Verify they fail**: on Task 8's tree the four fail, no pointer and the start refused for the archived chat board (`Tests  4 failed | 13 passed (17)`).
- [ ] **Step 3: Implement.** `#startWorkflow` makes its archived check only when `service.workflowBoard(name)` is not `{ file: 'read', board }` with a board. `renderStarted(reply, where, whom, nameOf, chatBoard?)` names the board when it is not `default` or not `chatBoard`, and adds the pointer as the first of the fixed last lines; `renderPreview(…, chatBoard?)` names it alike; `renderWorkflows` adds ` · board **b**`.
- [ ] **Step 4: Run everything.** Unit: `Tests  1 failed | 3407 passed (3408)`, four new; the one failure is `docs-wake`'s, for want of `reports`.
- [ ] **Step 5: Commit** "Name a workflow's board in chat's reply, preview and list, and point to its task list".

## Task 10: Chat's task list on a named board

**Files:** `src/kanban/chat-parse.ts`, `src/kanban/chat.ts`, `src/kanban/chat-render.ts`; tests `tests/kanban-chat-parse.test.ts`, `tests/kanban-workflow-board-fronts.test.ts`.

- [ ] **Step 1: Tests.** The parse, added to `tests/kanban-chat-parse.test.ts`'s "parses each" test: `list board:vi`, `list blocked board:vi`, `list board:vi blocked`, `list BOARD:vi` give `{ verb: 'list', filter, board: 'vi' }`; `list` and `list blocked` keep `{ verb: 'list', filter }` with no `board` key; `board:`, `board: vi`, two `board:` tokens, two filters, three words and an unknown word give the usage line `/kanban task list [todo|ready|running|review|reviewing|blocked|done|archived|all] [board:<name>]`. Through chat, four new tests: a task on `vi` listed from a chat on `default` under `Board **vi**:`; `board:nowhere` answered `Not done: there is no board nowhere`; an archived `vi` under `Board **vi** is archived: nothing is added to it.`; with nothing open, the empty answer with `/kanban task list all board:vi`; `board:default` named; a sender with talk tier but not operator tier answered, where a start is refused (talk tier itself is the router's check, before `KanbanChat`, as for every `/kanban` command); the chat's own `task list` unchanged.
- [ ] **Step 2: Verify they fail**: on Task 9's tree the parse test and the four chat tests fail, `list board:vi` the usage line (`Tests  5 failed | 31 passed (36)` over the two files).
- [ ] **Step 3: Implement.** The parse takes up to two words, at most one of each kind, `board:` matched in any case. Chat's `list` with a board asks `boardNamed`, and gives `renderList(entries, filter, name, nameOf, { archived })`; `renderList`'s fifth argument changes the header and the hints, today's words kept without it.
- [ ] **Step 4: Run everything.** Unit: `Tests  1 failed | 3411 passed (3412)`, four new; no other test quotes the list's usage line. The one failure is `docs-wake`'s.
- [ ] **Step 5: Commit** "Let chat's task list name a board".

## Task 11: The documents

**Files:** `docs/kanban-guide.md`, `README.md`, `tests/docs-examples.test.ts`, `tests/docs-wake.test.ts`.

- [ ] **Step 1: Tests.** `tests/docs-examples.test.ts`: the terminal start test asserts the answer's `board` is `reports` for weekly-report, and the chat start test the instance's board; `tests/docs-wake.test.ts` creates `reports` (`createBoard`, on the database it migrates) before its start.
- [ ] **Step 2: Verify**: `docs-wake`'s start, which failed `unknown_board` since Task 8, passes; both files `Tests  37 passed (37)`.
- [ ] **Step 3: The documents.** The guide's §12 ("The file", "Starting it", "From a terminal, and from an agent") and §10's task-list bullet; the README's workflow notes, its chat command table's `/kanban task list` row, and its line on what acts on the chat's board.
- [ ] **Step 4: Run everything.** Unit: `Tests  3412 passed (3412)`, 44 more than the baseline's 3368; e2e `Tests  183 passed (183)`; typecheck and `npm run build` clean.
- [ ] **Step 5: Commit** "Document a workflow's board and chat's board option in the guide and the README".

---

## Smoke checklist

On a test home, never `~/.manus-team`:

1. `mt workflow check` of a file naming `vi`: its line ends `; board vi`, then the note.
2. Start the gateway on that home with no board `vi`: the startup line says `its board vi does not exist (…)`; `mt service check` warns the same.
3. `/kanban board create vi`, then from a chat on `default`: `/kanban workflow start vi-sync`; the reply names **vi** and points to `/kanban task list board:vi`, which lists the task.
4. `mt kanban workflow start vi-sync --board default`: refused `other_board`.
5. `mt kanban workflow preview vi-sync --json > dag.json`, edit `board` to `default`, `mt kanban workflow apply dag.json --dry-run`: refused `other_board`.
6. `/kanban board archive vi` once its tasks are done: the next start is refused with the archived words, and `/kanban workflow list` shows the workflow as not usable.

## After the final review

One commit, "Say in chat's help where a start's tasks go, and read boards at startup only when a workflow names one": chat's help names the file's board and `task list board:`; the startup reads boards only when a usable workflow names one; seven tests more (step 0 with a non-mapping root and an out-of-grammar board, an instance on the path's board answered without reading the file, an apply with an unparseable file or one naming no board, the reply's pointer kept when task lines are cut, the list's 30-line hint carrying `board:`, a sender without talk tier never reaching the board through the router, the startup reading no database when no workflow names a board). Unit `Tests  3419 passed (3419)`, e2e `Tests  183 passed (183)`, typecheck and `npm run build` clean.
