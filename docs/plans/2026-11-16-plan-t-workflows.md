# Plan T: Workflows. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a team write a graph of tasks once, as a YAML file under `$MT_HOME/workflows`, and start it many times: `/kanban workflow start vendor-eval topic="log storage" vendors=acme,globex` reads the file, fills in its params, expands each `for_each` step into one task an item, and makes every task, link and gate at once, in one transaction, as one instance, `w_…`, which the starting chat follows in a thread of its own. A start is an expansion into a DAG and an apply of it: `preview` shows the expansion and makes nothing; at the terminal `preview --json` writes the DAG as a file, which `mt kanban workflow apply` makes, with `--dry-run` to check it first. An agent starts a workflow with `mt kanban start-workflow`, and makes a graph of its own at once with `mt kanban apply-dag`, which takes no gates. `list`, `instances`, `show` and `archive` see and manage instances, whose status is derived. Nothing in the kernel knows about workflows: an instance and its members are two tables of their own.

**Architecture:**
- **The refactors first** (`tsconfig.json`, `src/text.ts`, `src/cli/kanban.ts`, `src/cli/mt.ts`, `src/cli/operator.ts`, `src/kanban/socket.ts`, `src/kanban/task-checks.ts`, `src/kanban/gate-command.ts`): `ES2024.String` in the lib; every worker command's stdin, the operator's body and a socket request read as bytes and decoded strictly as UTF-8; `create`'s per-task checks as a pure `checkTask`/`taskProblems` and `assignable`; `holdsSecret` in a module of its own. Each keeps behaviour as it was, and has its own test.
- **The schema** (`schema/009_workflows.sql`): `kanban_workflow_instances`, with the DAG, its hash and its source, and `kanban_workflow_tasks`, a member's ref, step, item and position, both unique per instance.
- **The pure modules** (`src/kanban/dag.ts`, `src/kanban/workflow.ts`): the DAG's shape, defaults, canonical form, hash, sizes and per-task checks; the file's parse and checks, the params, the expansion, the directory, the startup's lines and the derived status.
- **The writer and its reads** (`src/db/kanban.ts`, `src/db/kanban-read.ts`): `createTask`'s, `addGate`'s and `archive`'s writes shared as `insertTask`, `insertGate` and `archiveIn`; `applyDag`, `archiveWorkflow` and `threadSubscriptions`; an instance, its members, its related tasks and a board's instances.
- **The service** (`src/kanban/service.ts`): `previewWorkflow`, `startWorkflow`, `applyDag` with `dryRun`, `workflows`, `instances`, `instance` and `archiveWorkflow`.
- **The fronts** (`src/kanban/chat-parse.ts`, `src/kanban/chat.ts`, `src/kanban/chat-render.ts`, `src/kanban/worker.ts`, `src/kanban/prompt.ts`, `src/cli/operator.ts`, `src/cli/plain.ts`, `src/cli/gate.ts`, `src/cli/workflow.ts`, `src/cli/mt.ts`, `src/index.ts`, `src/cli/service.ts`): chat's `/kanban workflow`, the worker's two commands, the terminal's `mt kanban workflow`, `mt workflow check`, the startup's lines and `mt service check`'s warnings.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`), vitest, better-sqlite3 11, `yaml` 2.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §21 (from line 4033 to the end), with the edits it makes to §1 (line 49), §2.6 (lines 450, 487 and 569 to 572), §7.1 (line 1217), §7.3 (lines 1313 to 1325), §9.1 (line 1691), and plan T's row in §12 (line 2212).

---

## Ground rules

- **Where to work.**
  - Use the worktree beside the main checkout, `/Users/x/Develop/manus/prime-gateway-wt2`, on the branch `workflows`, which holds this plan, from `e73ee3e`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, never reach the real Lark or the network, and never read or write `~/.manus-team`. Every test makes its own home in a temporary directory, its own database, and its own workflow files; the end-to-end test runs the fake CLI agent through the real socket, over the fake Lark channel.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npx vitest run --project unit` gives `Tests  1999 passed (1999)`. `npx vitest run --project e2e` gives `Tests  164 passed (164)`. `npm run typecheck` reports no errors. One unit test, `tests/update-run.test.ts`'s "kills the whole group at its time limit", is known to fail now and then under load; run the suite again before looking into a single failure.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text is whole lines, and appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given. Every step of this plan was applied in that order, from `e73ee3e`, in a throwaway copy, and gave the counts and failures it states; the plan's own text was then applied in a second fresh copy, which gave them again.
- **One writer.** `db/` modules stay the only writers of a database: `db/kanban.ts` writes both new tables, every task, link, gate, member and subscription a workflow makes, and every event. The service, chat, the worker API and the terminal only call it. `src/db/WRITERS.md` says so (Tasks 10 and 11).
- **Words a person sees** (replies, refusals, `mt` output, the log, the README and the guide) never name a plan, and do not use the long dash.
- **No real agent.** No test runs bytesec.

## Decisions

Each has its reason. Where the code and the spec disagree, the code is the fact, and the decision says which reading keeps the spec's intent; those are listed again under "Where the code forced a reading" below.

1. **The DAG has a module of its own, `src/kanban/dag.ts`**, which `workflow.ts` re-exports (`checkDagShape`, `readDag`), as §21.15 names them there: the DAG is read without any workflow file (an agent's, the terminal's), and the database's reads (`kanban-read.ts`) import its type without the file's parser.
2. **A step's parents are written above it.** §21.5 says the expansion writes tasks "in step order, then item order, and a step's parents come before it in a file with no cycle", which holds only for a file written in that order; a file listing a child first, with no cycle, would expand to a DAG with a parent after its child, which the DAG's own check refuses. The file's check refuses it instead, after the cycle check, naming the step: "steps.a.parents names b, which is written after it: write a step below its parents". Step order stays the file's, as §21.1 asks.
3. **A file is parsed with `parse(text, { logLevel: 'error' })`.** The parser's default warns on stderr when a key is itself a mapping, which an unquoted `{{x}}` makes; the check reports it as a problem instead, so a warning would only be noise in `mt` and the gateway's log. A duplicated key is still the parser's error.
4. **A problem names its place, not the file.** `section` and `reject` prefix their message with a path; the check gives them `<name>.yaml` and takes it off, so a problem reads `unknown setting steps.evaluate.timeout (known: …)`, and the startup line `workflow onboarding is not usable: …` names the workflow once.
5. **A dot-entry is reported once and ignored**, as §21.1 lists it with a badly named file and a symlink; `discoverRoles` skips dot-entries silently, which the spec does not ask of workflows.
6. **The list rules apply to every list param**: an empty list, an empty item, an item twice and an item holding a known secret are refused whether or not a `for_each` takes it, as an item that lands in text only would label nothing and read badly. Items are trimmed, and compared as given.
7. **`@` is resolved for any value starting with it, quoted or not**, in a param that lands in a person field, `"{{owner}}"`, `{ person: "{{owner}}" }`, or `"{{item}}"` in a for_each step, where each item is resolved. The parser matches mention names only for an unquoted value, as §21.6 says; a quoted `"@Alice Smith"` is whole anyway. Talk tier is the service's check, as `create`'s.
8. **Chat's `personOf` says its refusal plainly**, mirroring `#mentioned`'s three cases, as the service's refusal is escaped again by `refused`; `#mentioned`'s own replies are already escaped.
9. **Who previews** is the sender's principal, or `''` with no union_id: a preview makes nothing, so the union_id check that guards a change does not apply, and `checkTask` needs only text.
10. **`mt service check`'s warnings are the lines that say something is wrong**: a broken workflow and an entry that is no workflow. The summary line, `workflows: …`, is the gateway's note of what it found, not a warning; printed as one, every healthy check would warn.
11. **The stored DAG is the canonical form of the masked DAG**, compact; `show --dag` indents it. The hash stored beside it is of the unmasked canonical form, taken before masking (§21.7).
12. **A dry run and a repeat change nothing, so they tell the dispatcher nothing**: no nudge at the terminal for `--dry-run` or an `existing` answer, and no `changed()` from the worker for `dry_run`. A dry run whose key already made an instance answers `existing: true` with its id, as an apply would.
13. **A key is refused for another use in this order**: another board's (`other_board`), another kind's (a start's key given to an apply or the reverse), then another workflow's name for a start or another DAG's hash for an apply (`invalid`). The writer's race guard and the service's step 0 share `keyRefused`.
14. **The terminal's preview writes a refusal on stderr even with `--json`**, as §21.6 asks so a refused `preview --json > dag.json` leaves no half file; every other workflow command answers `--json` refusals on stdout, as the operator's commands do.
15. **`mt kanban apply-dag` refuses only its size before sending.** Its shape is checked to measure it, and a `too_large` is said there; any other refusal of the shape is left to the gateway, which says it the same way, so the CLI holds no second copy of the rules.
16. **`list` and `instances` at the terminal open the board**, as every operator command does, so on a database not yet migrated they are refused `no_board` with the rest (§21.16), though `list` reads only files.
17. **`--dag` and `--json` together** are a usage error: both print JSON, of different things.
18. **An instance's "done" count is its finished members**, done or archived, as the status counts an archived member as finished (§21.10).
19. **Times in `instances` and `show` are UTC, to the minute**, as no other board reply has a time to follow.
20. **`unknown_workflow`'s message** is `there is no workflow <name>; the usable ones are a, b; their params: a takes …; b takes …`, the names first, then the params, each part cut so the whole stays within 4 KiB, saying `and N more` and `the params of N more left out`.

## Known limitations

From spec §21.17, kept as it says: no conditions and no loops; no item pairing; params are text and lists of text, no literal `{{` in a text field, no `"` inside a chat value, no comma inside a terminal item; at most 100 tasks an instance, one board, 192 KiB from a run and 1 MiB elsewhere; no apply from chat and no preview for agents; a DAG's parents are its own refs; no gates and no workflow name from an agent's DAG; no edits at the level of an instance; no bound on workflows started from workflows; a person's name in text is their principal when the same param names a person field; the terminal checks against its own shell's configuration; the reply lists 30 tasks; no history of an instance beyond its row and its tasks' events. Besides:

- **A workflow file is read as UTF-8 with replacement**, as a role's `config.yaml` is (§21.1 "parsed as a role's `config.yaml` is"); a DAG, a worker's input and a body are read strictly.
- **The hold window.** Every member is held from the start until its reply's thread is known, as one task is (§19.4); a notice a member records in that moment goes to the group at chat scope, as plan L accepts for one task.
- **`show` in chat cuts its lines to fit**, the related tasks among them, and says how many were cut; the terminal's gives every one.

## Where the code forced a reading

- **`createGateway(config, team)` takes no `loadStartup` result.** §21.4 says `createGateway` notes the lines `loadStartup` returns; `main` passes `config` and `team` alone. `createGateway` gains a third, optional argument, `{ workflows }`, which `main` passes; a test or a caller that gives none notes none.
- **`mt service check` with a unit never called `loadStartup`.** Only its no-unit path did, through the build's `dist/index.js`. So the check could print the build's workflow lines with a unit too, as §21.4 asks, it now calls that `loadStartup` after the module load, with the service's environment and the stand-in for each passEnv name the service lacks, as its no-unit path does for this shell; a build whose `loadStartup` returns no `workflows`, from before this plan, prints none.
- **`threadSubscription` is replaced, not kept beside the list form.** §21.8 says `threadSubscriptions` "replaces" it; the service's and chat's callers, and the tests of the move, take the list form, with `moved` a count.
- **`WorkerCode` already had `too_large`.** §21.15 adds it to `RefusalCode`, as the service refuses sizes itself; it moves there, and `WorkerCode`, which includes every `RefusalCode`, loses its own.
- **`#idempotencyKey(req)` took a `CreateRequest`.** An instance is keyed as a task (§21.6), so it takes the key and the `createdVia`; its messages are unchanged.
- **`nameProblem` knew three kinds.** A workflow's, a step's and a param's names are in the role grammar (§21.1); it gains `workflow`, `step` and `param`, whose messages name them so.
- **`openBoard` looked for `kanban_gates` only.** The workflow commands look for the workflows' tables (§21.7), with an option, `workflows`, and the same words: "the database at … has no workflows yet: start the gateway once, so it is migrated".
- **`taskProblems` with no talk check refuses a person "yet … until the board is in Lark"**, the service's words when no people are wired. At the terminal §2.6's words are the operator's: `checkDagTasks` refuses any person there with `personRefused`'s, "is a person: give a person work from chat, by @-mention, …".
- **A members table `WITHOUT ROWID` has no `rowid`**: its order is `position`, and a test that needs the order members were made in reads it through `kanban_tasks`.
- **The router names a task in two log lines.** §21.9 says it is unchanged but for the name in them: an id starting `w_` is said as an instance's tasks.

## File map

| File | Responsibility |
|---|---|
| `tsconfig.json` (modify) | `ES2024.String` in `lib` |
| `src/text.ts` (modify) | `decodeUtf8` |
| `src/cli/kanban.ts` (modify) | `readAll` as bytes; every worker command decoded strictly; `apply-dag`'s 192 KiB checked before sending |
| `src/kanban/socket.ts` (modify) | a request decoded strictly, `bad_request` when it is not UTF-8 |
| `src/kanban/task-checks.ts` (create) | `checkTask`, `taskProblems`, `assignable`, `TaskFacts` |
| `src/kanban/gate-command.ts` (create) | `holdsSecret`, `gateProblem`, `gatesProblem` |
| `schema/009_workflows.sql` (create) | `kanban_workflow_instances`, `kanban_workflow_tasks`, their indexes, `idx_kanban_tasks_created_from` |
| `src/core/ids.ts` (modify) | `newWorkflowId` |
| `src/kanban/dag.ts` (create) | the DAG: `checkDagShape`, `readDag`, `canonicalDag`, `dagFile`, `maskDag`, `checkDagTasks`, `DAG_LIMITS` |
| `src/kanban/workflow.ts` (create) | the file: `checkWorkflow`, `readWorkflow`, `listWorkflows`, `workflowLines`, `paramsLine`, `usableMessage`; `paramValues`, `expand`; `instanceStatus` |
| `src/kanban/types.ts`, `src/names.ts` (modify) | `too_large` and `unknown_workflow`; `nameProblem`'s kinds |
| `src/db/kanban.ts` (modify) | `insertTask`, `insertGate`, `archiveIn`; `threadSubscriptions`; `applyDag`, `keyRefused`, `archiveWorkflow`; `BOARD_KEYS` |
| `src/db/kanban-read.ts` (modify) | `InstanceRow`, `MemberRow`, `hasWorkflows`, `getInstance`, `instanceByKey`, `membersOf`, `memberOf`, `instancesOn`, `relatedTasks`; `TaskView.member` |
| `src/db/WRITERS.md` (modify) | the two tables' rows; `threadSubscriptions` |
| `src/kanban/service.ts` (modify) | `workflowsDir`; `previewWorkflow`, `startWorkflow`, `applyDag`, `workflows`, `instances`, `instance`, `archiveWorkflow`, `threadSubscriptions` |
| `src/kanban/chat-parse.ts`, `src/kanban/chat.ts`, `src/kanban/chat-render.ts`, `src/core/router.ts` (modify) | `/kanban workflow`, its pairs, tiers, holds, thread and replies |
| `src/kanban/worker.ts`, `src/kanban/prompt.ts` (modify) | `start-workflow`, `apply-dag`, the `params` field; the work protocol |
| `src/cli/workflow.ts` (create) | `mt workflow check` |
| `src/cli/mt.ts`, `src/cli/operator.ts`, `src/cli/plain.ts`, `src/cli/gate.ts` (modify) | `mt workflow check`, the `workflow` group, `mt kanban workflow …`, `loadOperator` |
| `src/index.ts`, `src/cli/service.ts` (modify) | `loadStartup`'s `workflows`, `createGateway`'s note; `mt service check`'s warnings |
| `README.md`, `docs/kanban-guide.md`, `config.example.yaml` (modify) | the documents |
| `tests/helpers/workflow.ts` (create) | `VENDOR_EVAL`, the example of §21.1 |
| `tests/fakes/cli-agent.mjs` (modify) | `kanban-body` |
| `tests/well-formed.test.ts`, `tests/strict-utf8.test.ts`, `tests/kanban-task-checks.test.ts`, `tests/kanban-gate-command.test.ts`, `tests/kanban-workflow-schema.test.ts`, `tests/kanban-dag.test.ts`, `tests/kanban-workflow-file.test.ts`, `tests/kanban-workflow-expand.test.ts`, `tests/kanban-workflow-check.test.ts`, `tests/kanban-workflow-writer.test.ts`, `tests/kanban-workflow-service.test.ts`, `tests/kanban-workflow-instances.test.ts`, `tests/kanban-workflow-chat-parse.test.ts`, `tests/kanban-workflow-chat.test.ts`, `tests/kanban-workflow-worker.test.ts`, `tests/mt-kanban-workflow.test.ts`, `tests/kanban-workflow-task-show.test.ts`, `tests/kanban-workflow.e2e.ts` (create) | |
| `tests/mt-kanban.test.ts`, `tests/mt-kanban-operator-tasks.test.ts`, `tests/mt-kanban-worktree.test.ts`, `tests/gateway-startup.test.ts`, `tests/kanban-boards-schema.test.ts`, `tests/kanban-schema.test.ts`, `tests/kanban-thread-roots.test.ts`, `tests/kanban-worktree-schema.test.ts`, `tests/kanban-worker.test.ts`, `tests/mt.test.ts` (modify) | the stdin fakes; the schema's version; the list form of the move; the worker's command list |

Running counts, unit then end to end: Task 1 2000 / 164, Task 2 2006 / 164, Task 3 2011 / 164, Task 4 2013 / 164, Task 5 2018 / 164, Task 6 2048 / 164, Task 7 2069 / 164, Task 8 2087 / 164, Task 9 2096 / 164, Task 10 2098 / 164, Task 11 2109 / 164, Task 12 2125 / 164, Task 13 2132 / 164, Task 14 2138 / 164, Task 15 2151 / 164, Task 16 2160 / 164, Task 17 2173 / 164, Task 18 2175 / 164, Task 19 2175 / 168, Task 20 2175 / 168.

How §21.16's tests map to the tasks: the file's keys, names, grammar, symlink and dot-entry, size, parents, cycle, for_each, references, list param in a name field, `required` and `default`, gates (`{{`, `$NAME`, mask, secret, size, timeout, 21, 601 s, 300 s by default), literal roles and workspaces, supervised roles, the foreseeable workspace conflict and step order (Task 7); a start's params on each path, the pair's first `=`, lists, quotes, a text param twice, sizes, title characters, items, `@` for a person field only, substitution once in every text field, names checked, all to all, a fan-in, 101 tasks (Task 8, the parser's pairs in Task 14); the repeated key before the file is read, a key reused, the namespaces, another board, an archived instance's key, the board in each path, a run's start on its task's board and created from it, one failure naming step and item with nothing written, the person at the terminal and without tier, `unknown_workflow` cut at 4 KiB (Task 12); every write in one transaction, a refusal rolling it back, the `created` events, the gate's `created_by`, the stored DAG masked but its gates with the hash taken before, the members' unique ref as a backstop (Task 11); the status table, `list` with a broken file, `instances` and `all`, `show`'s members, related tasks and another instance as one line, `archive` (Task 13, and the replies in Task 15); the DAG's every key and default, an unknown key, `null`, lone surrogates, the canonical form and its hash, its sizes, from a run the settings, gates, `workflow` and `params`, refs and parents, 0 and 101 tasks, `{{` kept, the BOM (Tasks 6 and 17); `taskProblems` and `create`'s refusals in order, `assignable` (Task 3); broken bytes from every worker command, a file and stdin, and the socket (Tasks 2 and 17); preview and apply: the preview's `--json` byte for byte, a refusal on stderr, a dry run, an apply of a preview, what changed between them, a repeat and a key's other use, the hash in no output, a preview opening no database, a dry run's gate commands, "(no workflow)", `show --dag` applied again (Tasks 12 and 17); chat's reply, 30 lines under 3,800 characters, the thread, the holds released, every subscription moved in one call, a start in a direct message and inside a thread, the tiers, a sender with no union_id (Task 15); the startup's lines, `workflows: none`, a broken workflow not stopping the start, `mt workflow check` with and without a name, its exit codes, in a run's shell, `mt service check`'s warnings (Task 9); the worker's `apply-dag` with refs, its key taken off first, its 192 KiB before sending, `start-workflow`'s schema and `unknown_workflow`, `mt kanban workflow start` refused in a run's shell naming `start-workflow` (Task 16); the workflow commands refused `no_board` on an unmigrated database (Task 17) and `task show` working there (Task 18); and the end-to-end list (Task 19).

---

### Task 1: The type checker's lib, for `isWellFormed`

**Files:**

- Create: `tests/well-formed.test.ts`
- Modify: `tsconfig.json`

Spec §21.15. The DAG's checks refuse a string that is not well formed (spec §21.5), with `String.prototype.isWellFormed`, which Node 22 has and the type checker's `ES2023` lib does not declare. `tsconfig.json` gains `"ES2024.String"` beside `"ES2023"`; `tsconfig.build.json` extends it. Nothing else changes, so a test that calls it is enough: it passes under vitest, which does not type-check, and fails `npm run typecheck` until the lib is there.

- [ ] **Step 1.1: Write the tests.**

Create `tests/well-formed.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

/**
 * `String.prototype.isWellFormed`, which the DAG's checks use (spec §21.5), is
 * in the build's lib: `ES2024.String` beside `ES2023`. A lone surrogate, which
 * JSON's `\ud800` escape can give, is no text.
 */
describe('isWellFormed', () => {
  it('tells text from a lone surrogate', () => {
    expect('vendor-eval'.isWellFormed()).toBe(true);
    expect('Évaluer 🙂'.isWellFormed()).toBe(true);
    expect('\ud800'.isWellFormed()).toBe(false);
    expect((JSON.parse('"a\\udc00b"') as string).isWellFormed()).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/well-formed.test.ts`. Expected: `Tests  1 passed (1)`: vitest does not type-check. Run `npm run typecheck`. Expected: `error TS2550: Property 'isWellFormed' does not exist on type …. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2024' or later.`, once for each call.

- [ ] **Step 1.3: Implement.**

In `tsconfig.json`, replace:

```json
    "lib": ["ES2023"],
```

with:

```json
    "lib": ["ES2023", "ES2024.String"],
```

- [ ] **Step 1.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2000 passed (2000)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.5: Commit.**

```bash
git add tests/well-formed.test.ts tsconfig.json
git commit -m "Add ES2024.String to the type checker's lib, for String.prototype.isWellFormed"
```

---

### Task 2: Strict UTF-8: stdin as bytes, and the socket's decoding

**Files:**

- Create: `tests/strict-utf8.test.ts`
- Modify: `src/cli/kanban.ts`, `src/cli/mt.ts`, `src/cli/operator.ts`, `src/kanban/socket.ts`, `src/text.ts`, `tests/mt-kanban-operator-tasks.test.ts`, `tests/mt-kanban-worktree.test.ts`, `tests/mt-kanban.test.ts`

Spec §21.5. Text is read strictly as UTF-8 on every path a DAG can take, and so on every path of the same kind: `readAll` (`src/cli/kanban.ts`) returns the bytes it read, `MtIo.stdin` answers `Uint8Array | undefined`, and every worker command decodes its input with `decodeUtf8` (`src/text.ts`, a fatal `TextDecoder` with `ignoreBOM: true`), refusing bytes that are not UTF-8 as `invalid` and a byte order mark as not JSON. The operator's `--body-file` decodes the same way, from a file and from stdin, and the worker socket (`src/kanban/socket.ts`) refuses a request that is not UTF-8 as `bad_request`. The test fakes the spec names, `tests/mt-kanban.test.ts`, `tests/mt-kanban-operator-tasks.test.ts` (twice) and `tests/mt-kanban-worktree.test.ts`, return `Buffer.from(text)`. Every UTF-8 input reads as before.

- [ ] **Step 2.1: Write the tests.**

In `tests/mt-kanban-operator-tasks.test.ts`, replace:

```ts
      return Buffer.byteLength(text) > max ? undefined : text;
```

with:

```ts
      return Buffer.byteLength(text) > max ? undefined : Buffer.from(text);
```

In `tests/mt-kanban-operator-tasks.test.ts`, replace:

```ts
        return 'body';
```

with:

```ts
        return Buffer.from('body');
```

In `tests/mt-kanban-worktree.test.ts`, replace:

```ts
    stdin: async () => '',
```

with:

```ts
    stdin: async () => Buffer.from(''),
```

In `tests/mt-kanban.test.ts`, replace:

```ts
      return Buffer.byteLength(text) > max ? undefined : text;
```

with:

```ts
      return Buffer.byteLength(text) > max ? undefined : Buffer.from(text);
```

Create `tests/strict-utf8.test.ts`:

```ts
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAll } from '../src/cli/kanban.js';
import { runMt } from '../src/cli/mt.js';
import { listenWorker, type WorkerServer } from '../src/kanban/socket.js';
import { decodeUtf8 } from '../src/text.js';

/**
 * Text read strictly as UTF-8 (spec §21.5): every worker command's stdin, the
 * operator's body from a file or stdin, and a request to the worker socket.
 * Bytes that are not UTF-8 are refused, never read with U+FFFD in their place,
 * and a byte order mark is kept, so JSON with one is not JSON.
 */

/** Two bytes that are no UTF-8: a lone continuation byte, and one that never starts a character. */
const BROKEN = Buffer.from([0x7b, 0x22, 0x62, 0x6f, 0x64, 0x79, 0x22, 0x3a, 0x22, 0x80, 0xff, 0x22, 0x7d]);
const BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"body": "x"}')]);

let root: string;
let server: WorkerServer | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-utf8-')));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** `mt` as a run's shell or the operator's runs it, with these bytes on stdin. */
async function mt(argv: string[], stdin: Uint8Array, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(argv, {
    env: { MT_HOME: join(root, 'home'), PATH: process.env['PATH'], HOME: root, ...env },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdinIsTTY: false,
    stdin: async (max) => (stdin.length > max ? undefined : stdin),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const RUN = { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 'tok', MT_KANBAN_SOCKET: '/nonexistent/kanban.sock' };

describe('decodeUtf8', () => {
  it('reads UTF-8, refuses a broken byte, and keeps a byte order mark', () => {
    expect(decodeUtf8(Buffer.from('Évaluer 🙂'))).toBe('Évaluer 🙂');
    expect(decodeUtf8(BROKEN)).toBeUndefined();
    expect(decodeUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toBeUndefined();
    expect(decodeUtf8(BOM)?.charCodeAt(0)).toBe(0xfeff);
  });
});

describe('readAll', () => {
  it('answers the bytes the stream gave, or undefined past its cap', async () => {
    const bytes = await readAll(Readable.from([Buffer.from([0x61, 0x80]), Buffer.from([0x62])]), 16);
    expect(bytes === undefined ? undefined : [...bytes]).toEqual([0x61, 0x80, 0x62]);
    expect(await readAll(Readable.from([Buffer.alloc(17)]), 16)).toBeUndefined();
  });
});

describe('a worker command', () => {
  it('refuses input that is not UTF-8, before the gateway is asked', async () => {
    for (const command of ['comment', 'complete', 'create']) {
      const r = await mt(['kanban', command], BROKEN, RUN);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out)).toEqual({
        ok: false,
        code: 'invalid',
        message: `mt kanban ${command} reads one JSON object on stdin, in UTF-8, and this is not UTF-8`,
      });
    }
  });

  it('refuses input with a byte order mark as not JSON', async () => {
    const r = await mt(['kanban', 'comment'], BOM, RUN);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({
      ok: false,
      code: 'invalid',
      message: 'mt kanban comment reads one JSON object on stdin, and this is not JSON',
    });
  });
});

describe("the operator's body", () => {
  it('refuses a body file, or a body on stdin, that is not UTF-8', async () => {
    const file = join(root, 'body.md');
    writeFileSync(file, BROKEN);
    expect(await mt(['kanban', 'task', 'new', 'A title', '--body-file', file], new Uint8Array())).toEqual({
      code: 1,
      out: '',
      err: `mt: the body in ${file} is not UTF-8`,
    });
    expect(await mt(['kanban', 'task', 'new', 'A title', '--body-file', '-'], BROKEN)).toEqual({
      code: 1,
      out: '',
      err: 'mt: the body on stdin is not UTF-8',
    });
  });
});

describe('the worker socket', () => {
  /** Send bytes, and read everything the server sends back until it closes. */
  function send(path: string, bytes: Uint8Array): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let got = '';
      socket.setEncoding('utf8');
      socket.on('data', (d: string) => (got += d));
      socket.on('error', reject);
      socket.on('close', () => resolve(got));
      socket.write(bytes);
    });
  }

  it('refuses a request that is not UTF-8 as bad_request, and reads one that is', async () => {
    const seen: unknown[] = [];
    server = await listenWorker(join(root, 'run', 'kanban.sock'), (request) => {
      seen.push(request);
      return { ok: true };
    });
    expect(JSON.parse(await send(server.path, Buffer.concat([BROKEN, Buffer.from('\n')])))).toEqual({
      ok: false,
      code: 'bad_request',
      message: 'a request is one line of JSON, in UTF-8',
    });
    expect(JSON.parse(await send(server.path, Buffer.from('{"body": "Évaluer 🙂"}\n')))).toEqual({ ok: true });
    expect(seen).toEqual([{ body: 'Évaluer 🙂' }]);
  });
});
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/strict-utf8.test.ts`. Expected: `Tests  5 failed | 1 passed (6)`; the first failure: `TypeError: (0 , decodeUtf8) is not a function`.

- [ ] **Step 2.3: Implement.**

In `src/cli/kanban.ts`, replace:

```ts
import { WORKER_COMMANDS } from '../kanban/worker.js';
```

with:

```ts
import { WORKER_COMMANDS } from '../kanban/worker.js';
import { decodeUtf8 } from '../text.js';
```

In `src/cli/kanban.ts`, replace:

```ts
/** All of a stream, or undefined once it passes `maxBytes`. */
export async function readAll(stream: Readable, maxBytes: number): Promise<string | undefined> {
```

with:

```ts
/** All of a stream, as the bytes it gave, or undefined once it passes `maxBytes`. */
export async function readAll(stream: Readable, maxBytes: number): Promise<Uint8Array | undefined> {
```

In `src/cli/kanban.ts`, replace:

```ts
  return Buffer.concat(chunks).toString('utf8');
```

with:

```ts
  return Buffer.concat(chunks);
```

In `src/cli/kanban.ts`, replace:

```ts
    const text = await (io.stdin?.(DEFAULT_MAX_REQUEST_BYTES) ?? Promise.resolve(''));
    if (text === undefined) {
      say({ ok: false, code: 'too_large', message: `the input is over ${DEFAULT_MAX_REQUEST_BYTES} bytes` });
```

with:

```ts
    const bytes = await (io.stdin?.(DEFAULT_MAX_REQUEST_BYTES) ?? Promise.resolve(new Uint8Array()));
    if (bytes === undefined) {
      say({ ok: false, code: 'too_large', message: `the input is over ${DEFAULT_MAX_REQUEST_BYTES} bytes` });
      return 1;
    }
    // Strictly: a broken byte is refused, never stored as a replacement character (spec §21.5).
    const text = decodeUtf8(bytes);
    if (text === undefined) {
      say({ ok: false, code: 'invalid', message: `mt kanban ${command} reads one JSON object on stdin, in UTF-8, and this is not UTF-8` });
```

In `src/cli/mt.ts`, replace:

```ts
  /** All of stdin, or undefined once it passes `maxBytes`: `mt kanban`'s input. */
  stdin?: (maxBytes: number) => Promise<string | undefined>;
```

with:

```ts
  /** All of stdin, as bytes, or undefined once it passes `maxBytes`: `mt kanban`'s input, decoded by the command. */
  stdin?: (maxBytes: number) => Promise<Uint8Array | undefined>;
```

In `src/cli/operator.ts`, replace:

```ts
import { BIDI, INVISIBLE } from '../text.js';
```

with:

```ts
import { BIDI, decodeUtf8, INVISIBLE } from '../text.js';
```

In `src/cli/operator.ts`, replace:

```ts
    const text = await (io.stdin?.(max) ?? Promise.resolve(''));
    return text ?? early(io, json, 'too_large', `A body is at most ${max} bytes.`);
```

with:

```ts
    const bytes = await (io.stdin?.(max) ?? Promise.resolve(new Uint8Array()));
    if (bytes === undefined) return early(io, json, 'too_large', `A body is at most ${max} bytes.`);
    return decodeUtf8(bytes) ?? early(io, json, 'invalid', 'the body on stdin is not UTF-8');
```

In `src/cli/operator.ts`, replace:

```ts
    return readFileSync(file, 'utf8');
```

with:

```ts
    const text = decodeUtf8(readFileSync(file));
    return text ?? early(io, json, 'invalid', `the body in ${file} is not UTF-8`);
```

In `src/kanban/socket.ts`, replace:

```ts
import { redactKnownSecrets } from '../secrets.js';
```

with:

```ts
import { redactKnownSecrets } from '../secrets.js';
import { decodeUtf8 } from '../text.js';
```

In `src/kanban/socket.ts`, replace:

```ts
      let request: unknown;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
```

with:

```ts
      // Strictly: bytes that are not UTF-8 are refused, never read with replacement characters (spec §21.5).
      const text = decodeUtf8(Buffer.concat(chunks));
      if (text === undefined) {
        reply({ ok: false, code: 'bad_request', message: 'a request is one line of JSON, in UTF-8' });
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(text);
```

In `src/text.ts`, replace:

```ts
  );
}
```

with:

```ts
  );
}

/**
 * Bytes as text, when they are UTF-8; undefined when they are not, rather than
 * any byte replaced by U+FFFD, which would make text other than the one sent. A
 * byte order mark is kept, as a leading U+FEFF, so JSON with one is refused as
 * not JSON rather than read as if it had none (spec §21.5).
 */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 2.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2006 passed (2006)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.5: Commit.**

```bash
git add src/cli/kanban.ts src/cli/mt.ts src/cli/operator.ts src/kanban/socket.ts src/text.ts tests/mt-kanban-operator-tasks.test.ts tests/mt-kanban-worktree.test.ts tests/mt-kanban.test.ts tests/strict-utf8.test.ts
git commit -m "Read every worker command's stdin, the operator's body and a socket request as bytes, decoded strictly as UTF-8, so a broken byte or a byte order mark is refused rather than replaced"
```

---

### Task 3: `taskProblems` and `assignable`, out of the service

**Files:**

- Create: `src/kanban/task-checks.ts`, `tests/kanban-task-checks.test.ts`
- Modify: `src/kanban/service.ts`

Spec §21.6, §21.15. The terminal's preview opens no database, so it has no `KanbanService` to judge a task with. `create`'s per-task checks, its body, `#contract` and `#assignable`, move into `src/kanban/task-checks.ts`, pure, with their messages unchanged and in today's order: the title, `createdBy`, `createdVia`, the types of the body, workspace, board and parents, the contract, the workspace being configured, the numbers, the crash rule, the assignee, the reviewer. `checkTask(req, facts)` answers the checked contract and names, `taskProblems(req, facts)` the first refusal; the facts are the roles, the workspaces, `supervisedRoles` and an optional `canTalk`, absent when no person can be given work. `assignable(name, facts)` is the one assignable check, which `create`, `assign`, `assignReviewer` and a named reviewer of `requestReview` all call. `#idempotencyKey` stays in the service, as it reads the database for a run's task. The test walks a request with every field wrong through `create` and through `taskProblems`, fixing one at a time, so each refusal is seen in its order, before the move and after.

- [ ] **Step 3.1: Write the tests.**

Create `tests/kanban-task-checks.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import { assignable, taskProblems, type TaskFacts } from '../src/kanban/task-checks.js';
import type { Role } from '../src/roles.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * `create`'s per-task checks, moved into a pure `taskProblems` (spec §21.15):
 * the same refusals, each in today's order, through `create` and through the
 * function; and the pure `assignable` that `assign`, `assignReviewer`, a named
 * reviewer and `create` share.
 */

const ROLES: ReadonlyMap<string, Role> = new Map([
  ['implementer', role('implementer')],
  ['watched', role('watched', { agent: { ...role('watched').agent, unsupervised: false } })],
]);

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const service = (people?: (p: string) => boolean): KanbanService =>
  new KanbanService({
    db: h.db,
    roles: ROLES,
    workspaces: WORKSPACES,
    ...(people === undefined ? {} : { people: { canTalk: people } }),
  });
const facts = (canTalk?: (p: string) => boolean): TaskFacts => ({
  roles: ROLES,
  workspaces: WORKSPACES,
  supervisedRoles: false,
  ...(canTalk === undefined ? {} : { canTalk }),
});

/** Every field wrong at once: each fix in turn uncovers the next refusal, in create's order. */
const WRONG = {
  title: ' ',
  createdBy: 7,
  createdVia: { kind: 'nowhere' },
  body: 1,
  workspace: 2,
  board: 3,
  parents: 'k_1',
  contract: { colour: 'red' },
  priority: 1.5,
  retryOnCrash: 'never',
  assignee: 'ghost',
  reviewer: 'watched',
} as unknown as CreateRequest;

const STEPS: Array<[Record<string, unknown>, string, string]> = [
  [{}, 'invalid', 'a task needs a title'],
  [{ title: 'Write the notes' }, 'invalid', 'created_by is text'],
  [{ createdBy: ALICE }, 'invalid', 'created_via is a chat, with text fields, a run id, or the operator'],
  [{ createdVia: VIA }, 'invalid', 'a body is text'],
  [{ body: 'The body.' }, 'invalid', 'a workspace is a name'],
  [{ workspace: 'nowhere' }, 'invalid', 'a board is a name'],
  [{ board: 'default' }, 'invalid', 'parents are a list of task ids'],
  [{ parents: [] }, 'invalid', 'unknown contract field "colour"'],
  [{ contract: { outcome: 7 } }, 'invalid', 'contract field outcome must be text'],
  [{ contract: { outcome: 'notes' } }, 'unknown_workspace', 'workspace "nowhere" is not configured'],
  [{ workspace: 'docs' }, 'invalid', 'priority must be a whole number, and failure_limit and max_runtime_s at least 1'],
  [{ priority: 2, failureLimit: 0 }, 'invalid', 'priority must be a whole number, and failure_limit and max_runtime_s at least 1'],
  [{ failureLimit: 3 }, 'invalid', 'retry_on_crash must be always or if-no-side-effects'],
  [{ retryOnCrash: 'if-no-side-effects' }, 'unknown_role', 'role "ghost" is not configured'],
  [
    { assignee: 'implementer' },
    'supervised_role',
    'role "watched" has a supervised agent; its approval requests would reach nobody until the board is in Lark',
  ],
];

describe("create's refusals, and taskProblems's", () => {
  it('are the same, each in its order, until the task is made', () => {
    const board = service();
    let req: Record<string, unknown> = { ...WRONG };
    for (const [fix, code, message] of STEPS) {
      req = { ...req, ...fix };
      const refusal = { ok: false, code, message };
      expect(board.create(req as unknown as CreateRequest)).toEqual(refusal);
      expect(taskProblems(req as unknown as CreateRequest, facts())).toEqual(refusal);
    }
    req = { ...req, reviewer: 'implementer' };
    expect(taskProblems(req as unknown as CreateRequest, facts())).toBeUndefined();
    const made = board.create(req as unknown as CreateRequest);
    expect(made).toMatchObject({ ok: true, existing: false, task: { title: 'Write the notes', workspace: 'docs', priority: 2 } });
  });

  it('refuses a request that is no object, as create does', () => {
    const refusal = { ok: false, code: 'invalid', message: 'a task to create is an object' };
    expect(service().create(null as unknown as CreateRequest)).toEqual(refusal);
    expect(taskProblems(null as unknown as CreateRequest, facts())).toEqual(refusal);
  });

  it('refuses a person without a talk check, and checks their tier with one', () => {
    const req: CreateRequest = { title: 'T', assignee: 'lark:on_bob', createdBy: ALICE, createdVia: VIA };
    const yet = {
      ok: false,
      code: 'person_not_assignable',
      message: '"lark:on_bob" cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark',
    };
    expect(service().create(req)).toEqual(yet);
    expect(taskProblems(req, facts())).toEqual(yet);
    const noTier = {
      ok: false,
      code: 'person_not_assignable',
      message:
        '"lark:on_bob" cannot be given work: being assigned lets a person report on the task, which needs talk tier, ' +
        'and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it',
    };
    expect(service(() => false).create(req)).toEqual(noTier);
    expect(taskProblems(req, facts(() => false))).toEqual(noTier);
    expect(taskProblems(req, facts((p) => p === 'lark:on_bob'))).toBeUndefined();
    expect(service((p) => p === 'lark:on_bob').create(req)).toMatchObject({ ok: true, task: { assignee: { kind: 'human', name: 'lark:on_bob' } } });
  });

  it('leaves the key to the service: one in chat\'s namespace from the terminal is refused only by create', () => {
    const req: CreateRequest = { title: 'T', assignee: 'implementer', createdBy: 'operator:me', createdVia: { kind: 'operator' }, idempotencyKey: 'lark:x' };
    expect(taskProblems(req, facts())).toBeUndefined();
    expect(service().create(req)).toEqual({ ok: false, code: 'invalid', message: 'an idempotency key starting lark: is for chat' });
  });
});

describe('assignable', () => {
  it('refuses for assign, assignReviewer and a named reviewer as before', async () => {
    const board = service();
    const made = board.create({ title: 'T', assignee: 'implementer', createdBy: ALICE, createdVia: VIA });
    if (!made.ok) throw new Error(made.message);
    const id = made.task.taskId;
    const cases: Array<[unknown, string, string]> = [
      [7, 'invalid', 'an assignee or reviewer is a role name or a person, as text'],
      ['  ', 'invalid', 'an assignee or reviewer needs a name'],
      ['lark:bad name', 'invalid', '"lark:bad name" is neither a role name nor a person (lark:<union_id>)'],
      ['ghost', 'unknown_role', 'role "ghost" is not configured'],
      ['watched', 'supervised_role', 'role "watched" has a supervised agent; its approval requests would reach nobody until the board is in Lark'],
    ];
    for (const [name, code, message] of cases) {
      const refusal = { ok: false, code, message };
      expect(assignable(name, facts())).toEqual(refusal);
      expect(board.assign(id, name as string, ALICE)).toEqual(refusal);
      expect(board.assignReviewer(id, name as string, ALICE)).toEqual(refusal);
      expect(await board.requestReview(id, { kind: 'person', principal: ALICE }, { summary: 'done', reviewer: name as string })).toEqual(refusal);
    }
    expect(assignable('implementer', facts())).toEqual({ ok: true, assignee: { kind: 'role', name: 'implementer' } });
    expect(assignable('watched', { ...facts(), supervisedRoles: true })).toEqual({ ok: true, assignee: { kind: 'role', name: 'watched' } });
  });
});
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-task-checks.test.ts`. Expected: `Tests  no tests`: the file fails to load, `Error: Cannot find module '../src/kanban/task-checks.js' imported from '<worktree>/tests/kanban-task-checks.test.ts'`.

- [ ] **Step 3.3: Implement.**

In `src/kanban/service.ts`, replace:

```ts
import { gateEnv, runGates, spawnGate, type GateResult, type GateRunner } from './gates.js';
```

with:

```ts
import { gateEnv, runGates, spawnGate, type GateResult, type GateRunner } from './gates.js';
import { assignable, checkTask, isRecord, isText, isTextList, type TaskFacts } from './task-checks.js';
```

In `src/kanban/service.ts`, replace:

```ts
  BLOCK_KINDS,
  CONTRACT_FIELDS,
```

with:

```ts
  BLOCK_KINDS,
```

In `src/kanban/service.ts`, replace:

```ts

/** A person's principal, as channels identify them. */
const PERSON = /^lark:[A-Za-z0-9_-]+$/;

```

with:

```ts

```

In `src/kanban/service.ts`, replace:

```ts
// wrong type is refused as `invalid`, never thrown, and never reaches a write.

function isText(v: unknown): v is string {
  return typeof v === 'string';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTextList(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every(isText);
}

/** Absent, or a whole number SQLite stores exactly, at least `min`. */
function isWhole(n: unknown, min: number): boolean {
  return n === undefined || (Number.isSafeInteger(n) && (n as number) >= min);
}
```

with:

```ts
// wrong type is refused as `invalid`, never thrown, and never reaches a write.
```

In `src/kanban/service.ts`, replace:

```ts
const COMMIT = /^[0-9a-f]{7,64}$/;

/** A refusal unless createdVia is one of the three shapes, with text fields. */
function createdViaRefused(via: unknown): Refusal | undefined {
  const fine =
    isRecord(via) &&
    (via.kind === 'run'
      ? isText(via.runId)
      : via.kind === 'operator'
        ? Object.keys(via).length === 1
        : via.kind === 'chat' &&
          isText(via.channel) &&
          isText(via.appId) &&
          isText(via.conversationId) &&
          isText(via.threadId) &&
          (via.rootId === undefined || isText(via.rootId)));
  return fine ? undefined : board.refuse('invalid', 'created_via is a chat, with text fields, a run id, or the operator');
}
```

with:

```ts
const COMMIT = /^[0-9a-f]{7,64}$/;
```

In `src/kanban/service.ts`, replace:

```ts
    if (!isRecord(req)) return board.refuse('invalid', 'a task to create is an object');
    if (!isText(req.title) || req.title.trim() === '') return board.refuse('invalid', 'a task needs a title');
    if (!isText(req.createdBy)) return board.refuse('invalid', 'created_by is text');
    const via = createdViaRefused(req.createdVia);
    if (via !== undefined) return via;
    if (req.body !== undefined && !isText(req.body)) return board.refuse('invalid', 'a body is text');
    if (req.workspace !== undefined && !isText(req.workspace)) return board.refuse('invalid', 'a workspace is a name');
    if (req.board !== undefined && !isText(req.board)) return board.refuse('invalid', 'a board is a name');
    if (req.parents !== undefined && !isTextList(req.parents)) {
      return board.refuse('invalid', 'parents are a list of task ids');
    }
    const contract = this.#contract(req.contract);
    if (!contract.ok) return contract;
    if (req.workspace !== undefined && !this.#workspaces.has(req.workspace)) {
      return board.refuse('unknown_workspace', `workspace ${visible(JSON.stringify(req.workspace))} is not configured`);
    }
    if (
      !isWhole(req.priority, Number.MIN_SAFE_INTEGER) ||
      !isWhole(req.failureLimit, 1) ||
      !isWhole(req.maxRuntimeS, 1)
    ) {
      return board.refuse('invalid', 'priority must be a whole number, and failure_limit and max_runtime_s at least 1');
    }
    if (req.retryOnCrash !== undefined && req.retryOnCrash !== 'always' && req.retryOnCrash !== 'if-no-side-effects') {
      return board.refuse('invalid', 'retry_on_crash must be always or if-no-side-effects');
    }
    const assignee = req.assignee === undefined ? undefined : this.#assignable(req.assignee);
    if (assignee !== undefined && !assignee.ok) return assignee;
    const reviewer = req.reviewer === undefined ? undefined : this.#assignable(req.reviewer);
    if (reviewer !== undefined && !reviewer.ok) return reviewer;
```

with:

```ts
    // The checks a task gets however it is made (spec §21.15), then its key, which reads the database.
    const checked = checkTask(req, this.#facts());
    if (!checked.ok) return checked;
```

In `src/kanban/service.ts`, replace:

```ts
        contract: contract.contract,
        assignee: assignee?.assignee ?? null,
        reviewer: reviewer?.assignee ?? null,
```

with:

```ts
        contract: checked.contract,
        assignee: checked.assignee ?? null,
        reviewer: checked.reviewer ?? null,
```

In `src/kanban/service.ts`, replace:

```ts
    const who = this.#assignable(assignee);
```

with:

```ts
    const who = assignable(assignee, this.#facts());
```

In `src/kanban/service.ts`, replace:

```ts
    const who = this.#assignable(reviewer);
```

with:

```ts
    const who = assignable(reviewer, this.#facts());
```

In `src/kanban/service.ts`, replace:

```ts
      const who = this.#assignable(reviewer);
```

with:

```ts
      const who = assignable(reviewer, this.#facts());
```

In `src/kanban/service.ts`, replace:

```ts
   * A name the board may hand work to: a configured role whose agent runs
   * unsupervised, or a person with talk tier once people can be reached.
   */
  #assignable(name: unknown): Result<{ assignee: Assignee }> {
    if (!isText(name)) return board.refuse('invalid', 'an assignee or reviewer is a role name or a person, as text');
    if (name.trim() === '') return board.refuse('invalid', 'an assignee or reviewer needs a name');
    // Echoed quoted: a name is the caller's text, and may hold anything.
    const quoted = JSON.stringify(name);
    if (name.includes(':')) {
      if (!PERSON.test(name)) {
        return board.refuse('invalid', `${quoted} is neither a role name nor a person (lark:<union_id>)`);
      }
      if (this.#people === undefined) {
        return board.refuse(
          'person_not_assignable',
          `${quoted} cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark`,
        );
      }
      if (!this.#people.canTalk(name)) {
        // Being assigned is permission to report on the task (spec §4.2). A person is
        // known by the open_id Lark last gave with their union_id, from chat.
        return board.refuse(
          'person_not_assignable',
          `${quoted} cannot be given work: being assigned lets a person report on the task, which needs talk tier, ` +
            'and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it',
        );
      }
      return { ok: true, assignee: { kind: 'human', name } };
    }
    const role = this.#roles.get(name);
    if (role === undefined) return board.refuse('unknown_role', `role ${quoted} is not configured`);
    if (!role.agent.unsupervised && !this.#supervisedRoles) {
      return board.refuse(
        'supervised_role',
        `role ${quoted} has a supervised agent; its approval requests would reach nobody until the board is in Lark`,
      );
    }
    return { ok: true, assignee: { kind: 'role', name } };
```

with:

```ts
   * What a task is checked against (spec §21.15): the team as this process holds
   * it, and the people, who need talk tier, once people can be reached.
   */
  #facts(): TaskFacts {
    const people = this.#people;
    return {
      roles: this.#roles,
      workspaces: this.#workspaces,
      supervisedRoles: this.#supervisedRoles,
      ...(people === undefined ? {} : { canTalk: (principal: string) => people.canTalk(principal) }),
    };
```

In `src/kanban/service.ts`, replace:

```ts
  }

  /** A contract has only the five fields, each text (spec §4.3). */
  #contract(raw: unknown): Result<{ contract: Contract }> {
    if (raw === undefined) return { ok: true, contract: {} };
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return board.refuse('invalid', 'a contract is an object of text fields');
    }
    const contract: Contract = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = CONTRACT_FIELDS.find((f) => f === key);
      if (field === undefined) return board.refuse('invalid', `unknown contract field ${JSON.stringify(key)}`);
      if (typeof value !== 'string') return board.refuse('invalid', `contract field ${field} must be text`);
      contract[field] = value;
    }
    return { ok: true, contract };
  }
```

with:

```ts
  }
```

Create `src/kanban/task-checks.ts`:

```ts
import { visible } from '../names.js';
import type { Role } from '../roles.js';
import type { CreateRequest } from './service.js';
import { CONTRACT_FIELDS, type Assignee, type Contract, type Refusal, type Result } from './types.js';

/**
 * The checks a task gets before it is made (spec §21.15): `KanbanService.create`'s,
 * moved out of the service with their messages unchanged, so that one function
 * judges a task however it is made -- by `create`, by a workflow's start or
 * apply, and by the terminal's preview, which opens no database. Pure: the team
 * and the people come as facts, and nothing here reads a database.
 */

/** What a task is checked against. No check reads the isolated workspaces, so they are not here. */
export interface TaskFacts {
  roles: ReadonlyMap<string, Role>;
  /** The configured workspace names. */
  workspaces: ReadonlySet<string>;
  /** Accept roles whose agent asks for approval. */
  supervisedRoles: boolean;
  /**
   * Whether a person has talk tier (spec §4.2). Absent, nothing can deliver a
   * card to a person, so no person can be given work.
   */
  canTalk?: (principal: string) => boolean;
}

/** A task to check: what `create` takes, but its key, which the service checks, as it reads the database. */
export type TaskRequest = Omit<CreateRequest, 'idempotencyKey'>;

/** A task's checked parts: its contract, and who it is for and reviewed by. */
export interface CheckedTask {
  contract: Contract;
  assignee: Assignee | undefined;
  reviewer: Assignee | undefined;
}

// Every check takes what an agent's JSON or chat sent, typed or not: a wrong
// type is refused as `invalid`, never thrown.

export function isText(v: unknown): v is string {
  return typeof v === 'string';
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isTextList(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every(isText);
}

/** Absent, or a whole number SQLite stores exactly, at least `min`. */
function isWhole(n: unknown, min: number): boolean {
  return n === undefined || (Number.isSafeInteger(n) && (n as number) >= min);
}

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

/** A person's principal, as channels identify them. */
const PERSON = /^lark:[A-Za-z0-9_-]+$/;

/** A refusal unless createdVia is one of the three shapes, with text fields. */
function createdViaRefused(via: unknown): Refusal | undefined {
  const fine =
    isRecord(via) &&
    (via.kind === 'run'
      ? isText(via.runId)
      : via.kind === 'operator'
        ? Object.keys(via).length === 1
        : via.kind === 'chat' &&
          isText(via.channel) &&
          isText(via.appId) &&
          isText(via.conversationId) &&
          isText(via.threadId) &&
          (via.rootId === undefined || isText(via.rootId)));
  return fine ? undefined : refuse('invalid', 'created_via is a chat, with text fields, a run id, or the operator');
}

/** A contract has only the five fields, each text (spec §4.3). */
function contractOf(raw: unknown): Result<{ contract: Contract }> {
  if (raw === undefined) return { ok: true, contract: {} };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return refuse('invalid', 'a contract is an object of text fields');
  }
  const contract: Contract = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = CONTRACT_FIELDS.find((f) => f === key);
    if (field === undefined) return refuse('invalid', `unknown contract field ${JSON.stringify(key)}`);
    if (typeof value !== 'string') return refuse('invalid', `contract field ${field} must be text`);
    contract[field] = value;
  }
  return { ok: true, contract };
}

/**
 * A name the board may hand work to: a configured role whose agent runs
 * unsupervised, unless supervised roles are accepted, or a person with talk tier
 * once people can be reached. `assign`, `assignReviewer`, a named reviewer of
 * `requestReview`, and `create` all ask it.
 */
export function assignable(name: unknown, facts: TaskFacts): Result<{ assignee: Assignee }> {
  if (!isText(name)) return refuse('invalid', 'an assignee or reviewer is a role name or a person, as text');
  if (name.trim() === '') return refuse('invalid', 'an assignee or reviewer needs a name');
  // Echoed quoted: a name is the caller's text, and may hold anything.
  const quoted = JSON.stringify(name);
  if (name.includes(':')) {
    if (!PERSON.test(name)) {
      return refuse('invalid', `${quoted} is neither a role name nor a person (lark:<union_id>)`);
    }
    if (facts.canTalk === undefined) {
      return refuse(
        'person_not_assignable',
        `${quoted} cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark`,
      );
    }
    if (!facts.canTalk(name)) {
      // Being assigned is permission to report on the task (spec §4.2). A person is
      // known by the open_id Lark last gave with their union_id, from chat.
      return refuse(
        'person_not_assignable',
        `${quoted} cannot be given work: being assigned lets a person report on the task, which needs talk tier, ` +
          'and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it',
      );
    }
    return { ok: true, assignee: { kind: 'human', name } };
  }
  const role = facts.roles.get(name);
  if (role === undefined) return refuse('unknown_role', `role ${quoted} is not configured`);
  if (!role.agent.unsupervised && !facts.supervisedRoles) {
    return refuse(
      'supervised_role',
      `role ${quoted} has a supervised agent; its approval requests would reach nobody until the board is in Lark`,
    );
  }
  return { ok: true, assignee: { kind: 'role', name } };
}

/**
 * A task's checks, in `create`'s order: the title, `createdBy`, `createdVia`, the
 * types of the body, workspace, board and parents, the contract, the workspace
 * being configured, the numbers, the crash rule, the assignee, the reviewer. The
 * first problem is the refusal; otherwise the checked contract and names.
 */
export function checkTask(req: TaskRequest, facts: TaskFacts): Result<CheckedTask> {
  if (!isRecord(req)) return refuse('invalid', 'a task to create is an object');
  if (!isText(req.title) || req.title.trim() === '') return refuse('invalid', 'a task needs a title');
  if (!isText(req.createdBy)) return refuse('invalid', 'created_by is text');
  const via = createdViaRefused(req.createdVia);
  if (via !== undefined) return via;
  if (req.body !== undefined && !isText(req.body)) return refuse('invalid', 'a body is text');
  if (req.workspace !== undefined && !isText(req.workspace)) return refuse('invalid', 'a workspace is a name');
  if (req.board !== undefined && !isText(req.board)) return refuse('invalid', 'a board is a name');
  if (req.parents !== undefined && !isTextList(req.parents)) {
    return refuse('invalid', 'parents are a list of task ids');
  }
  const contract = contractOf(req.contract);
  if (!contract.ok) return contract;
  if (req.workspace !== undefined && !facts.workspaces.has(req.workspace)) {
    return refuse('unknown_workspace', `workspace ${visible(JSON.stringify(req.workspace))} is not configured`);
  }
  if (!isWhole(req.priority, Number.MIN_SAFE_INTEGER) || !isWhole(req.failureLimit, 1) || !isWhole(req.maxRuntimeS, 1)) {
    return refuse('invalid', 'priority must be a whole number, and failure_limit and max_runtime_s at least 1');
  }
  if (req.retryOnCrash !== undefined && req.retryOnCrash !== 'always' && req.retryOnCrash !== 'if-no-side-effects') {
    return refuse('invalid', 'retry_on_crash must be always or if-no-side-effects');
  }
  const assignee = req.assignee === undefined ? undefined : assignable(req.assignee, facts);
  if (assignee !== undefined && !assignee.ok) return assignee;
  const reviewer = req.reviewer === undefined ? undefined : assignable(req.reviewer, facts);
  if (reviewer !== undefined && !reviewer.ok) return reviewer;
  return { ok: true, contract: contract.contract, assignee: assignee?.assignee, reviewer: reviewer?.assignee };
}

/** The first problem `checkTask` finds, or undefined for a task `create` would take, but for its key. */
export function taskProblems(req: TaskRequest, facts: TaskFacts): Refusal | undefined {
  const checked = checkTask(req, facts);
  return checked.ok ? undefined : checked;
}
```

- [ ] **Step 3.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2011 passed (2011)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.5: Commit.**

```bash
git add src/kanban/service.ts src/kanban/task-checks.ts tests/kanban-task-checks.test.ts
git commit -m "Move create's per-task checks into a pure taskProblems, and its assignable check into a pure assignable that assign, assignReviewer and a named reviewer share, with every refusal unchanged and in its order"
```

---

### Task 4: `holdsSecret`, in a module of its own

**Files:**

- Create: `src/kanban/gate-command.ts`, `tests/kanban-gate-command.test.ts`
- Modify: `src/kanban/service.ts`

Spec §21.15. A workflow's gate checks refuse a command holding a known secret as `addGate` does, with `holdsSecret`, today a private function of `service.ts`. It moves, unchanged, to `src/kanban/gate-command.ts`, which the service imports, so the pure workflow module never imports the service. The test pins the forms it finds, and `addGate`'s refusal through it.

- [ ] **Step 4.1: Write the tests.**

Create `tests/kanban-gate-command.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdsSecret } from '../src/kanban/gate-command.js';
import { KanbanService } from '../src/kanban/service.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, WORKSPACES, newTask } from './helpers/kanban.js';

/**
 * `holdsSecret`, in a module of its own that the service and a workflow's checks
 * both import (spec §21.15): the forms a shell would run as the secret, and
 * `addGate`'s refusal through it, unchanged.
 */

const SECRET = 'sk-live-1234567890';

let h: TestDb;
beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  h = testDb();
});
afterEach(() => {
  clearSecrets();
  h.close();
});

describe('holdsSecret', () => {
  it('finds a secret as written, split by a control character, quoted, escaped or continued', () => {
    expect(holdsSecret('npm test')).toBe(false);
    expect(holdsSecret('test -s notes.md && grep -q $TOKEN notes.md')).toBe(false);
    expect(holdsSecret(`curl -H "Authorization: ${SECRET}" x`)).toBe(true);
    expect(holdsSecret('curl sk-live-12345\u000767890')).toBe(true);
    expect(holdsSecret("curl 'sk-live-12345''67890'")).toBe(true);
    expect(holdsSecret('curl sk-live-12345\\67890')).toBe(true);
    expect(holdsSecret('curl sk-live-12345\\\n67890')).toBe(true);
    expect(holdsSecret('curl sk-live-12345\\\r\n\u000767890')).toBe(true);
  });
});

describe('addGate', () => {
  it('still refuses a command that holds a known secret, through it', () => {
    const service = new KanbanService({ db: h.db, roles: new Map([['implementer', role('implementer')]]), workspaces: WORKSPACES });
    const task = newTask(h.db);
    expect(service.addGate(task.taskId, { command: "echo 'sk-live-12345''67890'" }, ALICE)).toEqual({
      ok: false,
      code: 'invalid',
      message:
        "the gate's command holds a known secret, and a gate is stored and run as written; " +
        "pass the value through the agent's environment instead -- the role's .env, or agent.passEnv -- " +
        'and name it in the command, as $NAME',
    });
    expect(service.addGate(task.taskId, { command: 'npm test' }, ALICE)).toMatchObject({ ok: true, gate: { command: 'npm test' } });
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-gate-command.test.ts`. Expected: `Tests  no tests`: the file fails to load, `Error: Cannot find module '../src/kanban/gate-command.js' imported from '<worktree>/tests/kanban-gate-command.test.ts'`.

- [ ] **Step 4.3: Implement.**

Create `src/kanban/gate-command.ts`:

```ts
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';

/**
 * What a gate's command may hold (spec §7.7, §10.1): shared by `KanbanService`'s
 * `addGate` and a workflow's checks (spec §21.4), so the pure workflow module
 * need not import the service.
 */

/**
 * Whether a gate command holds a known secret (spec §10.1): as written, with its
 * control characters stripped, as the escapers match it, and with the shell's
 * quotes and backslashes taken out, so `sk\$x` or `'sk''x'` -- which the shell
 * runs as the secret -- count as well. A backslash-newline, which the shell
 * removes, is taken out first, and that form is matched with its control
 * characters stripped too.
 */
export function holdsSecret(command: string): boolean {
  // A backslash-newline is a continuation the shell removes, so it goes before the quotes do.
  const unquoted = command.replace(/\\\r?\n/g, '').replace(/['"\\]/g, '');
  const forms = [command, stripControl(command), unquoted, stripControl(unquoted)];
  return forms.some((form) => redactKnownSecrets(form) !== form);
}
```

In `src/kanban/service.ts`, replace:

```ts
import { stripControl } from '../text.js';
import { systemClock, type Clock } from '../time.js';
import { commitReader, type CommitReader } from './commit.js';
```

with:

```ts
import { systemClock, type Clock } from '../time.js';
import { commitReader, type CommitReader } from './commit.js';
import { holdsSecret } from './gate-command.js';
```

In `src/kanban/service.ts`, replace:

```ts
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file`);
}

/**
 * Whether a gate command holds a known secret (spec §10.1): as written, with its
 * control characters stripped, as the escapers match it, and with the shell's
 * quotes and backslashes taken out, so `sk\$x` or `'sk''x'` -- which the shell
 * runs as the secret -- count as well. A backslash-newline, which the shell
 * removes, is taken out first, and that form is matched with its control
 * characters stripped too.
 */
function holdsSecret(command: string): boolean {
  // A backslash-newline is a continuation the shell removes, so it goes before the quotes do.
  const unquoted = command.replace(/\\\r?\n/g, '').replace(/['"\\]/g, '');
  const forms = [command, stripControl(command), unquoted, stripControl(unquoted)];
  return forms.some((form) => redactKnownSecrets(form) !== form);
```

with:

```ts
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file`);
```

- [ ] **Step 4.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2013 passed (2013)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.5: Commit.**

```bash
git add src/kanban/gate-command.ts src/kanban/service.ts tests/kanban-gate-command.test.ts
git commit -m "Move holdsSecret out of the service into a module of its own, so a workflow's checks can use it without importing the service"
```

---

### Task 5: Migration 009: instances and their members

**Files:**

- Create: `schema/009_workflows.sql`, `tests/kanban-workflow-schema.test.ts`
- Modify: `src/core/ids.ts`, `tests/gateway-startup.test.ts`, `tests/kanban-boards-schema.test.ts`, `tests/kanban-schema.test.ts`, `tests/kanban-thread-roots.test.ts`, `tests/kanban-worktree-schema.test.ts`

Spec §21.7. `kanban_workflow_instances` holds an instance's name (null for a DAG with none), its DAG, the SHA-256 of its canonical form, its `source` (`start` or `apply`), its board, who made it and how, and its idempotency key, unique; `kanban_workflow_tasks`, `WITHOUT ROWID`, holds each member by its task's id, with its ref, step, item and position, `UNIQUE (instance_id, position)` and `UNIQUE (instance_id, ref)`. Foreign keys are allowed, as both tables are new. An index on `(board, created_at)` serves `instances`, and one on `kanban_tasks(created_from_task)` serves `show`'s related tasks. `newWorkflowId` (`src/core/ids.ts`) mints `w_…`. Five tests that pin the schema's version, or list the kanban tables, move to 9; WRITERS.md gains the tables' rows with their writer, in Task 11.

- [ ] **Step 5.1: Write the tests.**

In `tests/gateway-startup.test.ts`, replace:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 8 (${config.dbPath})\n`))).toBe(true);
```

with:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 9 (${config.dbPath})\n`))).toBe(true);
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
    expect(migrate(db, SCHEMA_DIR)).toBe(8);
```

with:

```ts
    expect(migrate(db, SCHEMA_DIR)).toBe(9);
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 8 });
```

with:

```ts
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 9 });
```

In `tests/kanban-schema.test.ts`, replace:

```ts
    // 004 adds a column to kanban_comments and an index, 005 the people table, 006 the boards' two tables, 007 and 008 a column each.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(8);
```

with:

```ts
    // 004 adds a column to kanban_comments and an index, 005 the people table, 006 the boards' two tables, 007 and 008 a column each,
    // 009 the workflows' two tables.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(9);
```

In `tests/kanban-schema.test.ts`, replace:

```ts
      { name: 'kanban_tasks', strict: 1 },
```

with:

```ts
      { name: 'kanban_tasks', strict: 1 },
      { name: 'kanban_workflow_instances', strict: 1 },
      { name: 'kanban_workflow_tasks', strict: 1 },
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(8);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(9);
```

Create `tests/kanban-workflow-schema.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newWorkflowId } from '../src/core/ids.js';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * Migration 009 (spec §21.7): an instance and its members, two tables of their
 * own, with their keys and indexes, and an index on a task's created_from_task.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function instance(id: string, extra: Record<string, unknown> = {}): void {
  const row = {
    instance_id: id,
    name: 'vendor-eval',
    dag: '{"format":1}',
    dag_sha256: 'a'.repeat(64),
    source: 'start',
    board: 'default',
    created_by: 'lark:on_alice',
    created_via: '{"kind":"operator"}',
    idempotency_key: null,
    created_at: NOW,
    ...extra,
  };
  h.db
    .prepare(`INSERT INTO kanban_workflow_instances (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
    .run(...Object.values(row));
}

function member(taskId: string, instanceId: string, ref: string, position: number): void {
  h.db
    .prepare('INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, ?, NULL, ?)')
    .run(taskId, instanceId, ref, ref, position);
}

const indexes = (table: string): string[] =>
  h.db
    .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'idx_%' ORDER BY name")
    .all(table)
    .map((r) => r.name);

describe('migration 009', () => {
  it('is version 9, with both tables STRICT and the members WITHOUT ROWID', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(9);
    const rows = h.db
      .prepare<[], { name: string; strict: number; wr: number }>(
        "SELECT name, strict, wr FROM pragma_table_list WHERE name LIKE 'kanban_workflow_%' ORDER BY name",
      )
      .all();
    expect(rows).toEqual([
      { name: 'kanban_workflow_instances', strict: 1, wr: 0 },
      { name: 'kanban_workflow_tasks', strict: 1, wr: 1 },
    ]);
    expect(indexes('kanban_workflow_instances')).toEqual(['idx_kanban_workflow_instances_board']);
    expect(indexes('kanban_tasks')).toContain('idx_kanban_tasks_created_from');
  });

  it('keeps a ref and a position unique in an instance, and a task in one instance at most', () => {
    const [a, b, c] = [newTask(h.db), newTask(h.db), newTask(h.db)];
    instance('w_1');
    instance('w_2');
    member(a.taskId, 'w_1', 'shortlist', 0);
    expect(() => member(b.taskId, 'w_1', 'shortlist', 1)).toThrow(/UNIQUE constraint failed/);
    expect(() => member(b.taskId, 'w_1', 'evaluate:1', 0)).toThrow(/UNIQUE constraint failed/);
    expect(() => member(a.taskId, 'w_2', 'shortlist', 0)).toThrow(/UNIQUE constraint failed/);
    member(b.taskId, 'w_1', 'evaluate:1', 1);
    member(c.taskId, 'w_2', 'shortlist', 0);
  });

  it('refuses a member of no task or no instance, an instance on no board, a key twice, and a source of another kind', () => {
    const a = newTask(h.db);
    instance('w_1', { idempotency_key: 'operator:k' });
    expect(() => member('k_none', 'w_1', 'x', 0)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => member(a.taskId, 'w_none', 'x', 0)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => instance('w_2', { board: 'nowhere' })).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => instance('w_3', { idempotency_key: 'operator:k' })).toThrow(/UNIQUE constraint failed/);
    expect(() => instance('w_4', { source: 'render' })).toThrow(/CHECK constraint failed/);
    expect(() => instance('w_5', { dag: 'not json' })).toThrow(/CHECK constraint failed/);
  });

  it('migrates a database at version 8, its tasks as they were', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-wf-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^00[1-8]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(8);
        const task = newTask(d);
        expect(migrate(d, SCHEMA_DIR)).toBe(9);
        expect(getTask(d, task.taskId)).toEqual(task);
        expect(d.prepare('SELECT count(*) AS n FROM kanban_workflow_instances').get()).toEqual({ n: 0 });
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('newWorkflowId', () => {
  it('is w_ and twelve characters of the ids alphabet, a new one each time', () => {
    const a = newWorkflowId();
    expect(a).toMatch(/^w_[0-9a-hjkmnp-tv-z]{12}$/);
    expect(newWorkflowId()).not.toBe(a);
  });
});
```

In `tests/kanban-worktree-schema.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(8);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(9);
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-schema.test.ts tests/kanban-schema.test.ts tests/kanban-boards-schema.test.ts tests/kanban-worktree-schema.test.ts tests/kanban-thread-roots.test.ts tests/gateway-startup.test.ts`. Expected: `Tests  10 failed | 37 passed (47)`; the first failure: `AssertionError: expected false to be true // Object.is equality`.

- [ ] **Step 5.3: Implement.**

Create `schema/009_workflows.sql`:

```sql
-- manus-team migration 009: workflows, their instances and their members
-- See docs/specs/2026-11-02-kanban-design.md §21.7.
--
-- An instance is one start of a workflow, or one apply of a DAG: the DAG it was
-- made from, and the tasks it made, its members. Nothing in the kernel reads
-- either table: kanban_tasks is unchanged, and the dispatcher, the claim, the
-- prompt and the notices know nothing of workflows (§1). Foreign keys are
-- allowed here, as both tables are new. db/kanban.ts is the only writer of both
-- (src/db/WRITERS.md): every row is written in the apply's transaction, with its
-- tasks, and never changed or removed.
CREATE TABLE kanban_workflow_instances (
  instance_id      TEXT PRIMARY KEY,                -- w_..., opaque
  name             TEXT,                            -- the workflow's, or null for a DAG with none
  dag              TEXT NOT NULL CHECK (json_valid(dag)),  -- the DAG it was made from (§21.5), masked
                                                    -- on write but its gates' commands
  dag_sha256       TEXT NOT NULL,                   -- of the DAG's canonical form, unmasked; never printed
  source           TEXT NOT NULL CHECK (source IN ('start', 'apply')),
  board            TEXT NOT NULL REFERENCES kanban_boards(name),
  created_by       TEXT NOT NULL,
  created_via      TEXT NOT NULL CHECK (json_valid(created_via)),  -- the chat, the run, or the operator
  idempotency_key  TEXT UNIQUE,
  created_at       INTEGER NOT NULL
) STRICT;

-- `instances` reads at most a board's 200 newest (§21.10).
CREATE INDEX idx_kanban_workflow_instances_board ON kanban_workflow_instances(board, created_at);

-- A task is a member of at most one instance; its ref is unique in its DAG, and
-- its position is its place in the DAG's array, from 0.
CREATE TABLE kanban_workflow_tasks (
  task_id      TEXT PRIMARY KEY REFERENCES kanban_tasks(task_id),
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  ref          TEXT NOT NULL,
  step         TEXT NOT NULL,
  item         TEXT,                                -- the for_each item, masked; null for none
  position     INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE (instance_id, position),
  UNIQUE (instance_id, ref)
) STRICT, WITHOUT ROWID;

-- An instance's related tasks are found by it (§21.10), and nothing indexed it
-- before. A new index writes no row of the table, and is built in this
-- migration's transaction.
CREATE INDEX idx_kanban_tasks_created_from ON kanban_tasks(created_from_task);

UPDATE schema_version SET version = 9;
```

In `src/core/ids.ts`, replace:

```ts
  return `r_${randomToken(12)}`;
```

with:

```ts
  return `r_${randomToken(12)}`;
}

/** One start of a workflow, or one apply of a DAG: an instance (spec §21.7). Opaque, as a task's id is. */
export function newWorkflowId(): string {
  return `w_${randomToken(12)}`;
```

- [ ] **Step 5.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2018 passed (2018)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add schema/009_workflows.sql src/core/ids.ts tests/gateway-startup.test.ts tests/kanban-boards-schema.test.ts tests/kanban-schema.test.ts tests/kanban-thread-roots.test.ts tests/kanban-workflow-schema.test.ts tests/kanban-worktree-schema.test.ts
git commit -m "Add migration 009: a workflow's instances, with their DAG, its hash and their source, and their members, with a unique ref and position, and an index on a task's created_from_task"
```

---

### Task 6: The DAG: its shape, defaults, canonical form and checks

**Files:**

- Create: `src/kanban/dag.ts`, `tests/kanban-dag.test.ts`
- Modify: `src/kanban/gate-command.ts`, `src/kanban/types.ts`, `src/kanban/worker.ts`

Spec §21.5. `src/kanban/dag.ts`, pure. `checkDagShape(raw, from)` checks the format (1 alone), every key at each level, an unknown one refused naming its place, every type, every string well formed, the refs (unique, 1 to 64 bytes of letters, digits, `.`, `_`, `:` and `-`) and parents (earlier refs, each once), `null` refused where a key's default is not `null`, where gates may come from (`terminal` and `expansion` take them, `run` refuses any), from a run the settings its `create` cannot set, a `workflow` name and params, and a gate holding the mask `••••`; then it fills in every default, makes the canonical form (compact JSON, the tables' key order, a contract's fields in `CONTRACT_FIELDS`' order, the params by name, unmasked), measures it against 192 KiB from a run and 1 MiB elsewhere, and hashes it. `readDag(text, from)` parses JSON first. `dagFile` is the canonical form indented by two spaces, `maskDag` the stored form, masked but for its gates. `checkDagTasks(dag, check)` is step 2's per-task check: `checkTask` for each task, `addGate`'s rules for each gate (`gateProblem`, `gatesProblem`, beside `holdsSecret` in `gate-command.ts`), a title of one line, `task new`'s sizes, a name or an item holding a known secret, any person at the terminal, and a task whose parents certainly work in different workspaces, each refusal naming the task by ref, step and item. `RefusalCode` gains `too_large` and `unknown_workflow`, `WorkerCode` losing its own `too_large`.

- [ ] **Step 6.1: Write the tests.**

Create `tests/kanban-dag.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DAG_LIMITS,
  canonicalDag,
  checkDagShape,
  checkDagTasks,
  dagFile,
  maskDag,
  readDag,
  type Dag,
  type DagCheck,
  type DagSource,
} from '../src/kanban/dag.js';
import { gateProblem, gatesProblem } from '../src/kanban/gate-command.js';
import type { Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA } from './helpers/kanban.js';

/**
 * The DAG (spec §21.5): its shape, every default, the canonical form and its
 * hash, the sizes, where gates may come from, what a run's DAG may not set, and
 * each task checked as create checks it.
 */

const SECRET = 'sk-live-1234567890';

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
});
afterEach(() => clearSecrets());

/** The example of §21.5, written out in full, as an expansion writes it. */
function example(): Record<string, unknown> {
  const task = (ref: string, step: string, item: string | null, title: string, parents: string[], extra: Record<string, unknown> = {}) => ({
    ref,
    step,
    item,
    title,
    body: null,
    assignee: 'worker',
    reviewer: null,
    workspace: null,
    priority: 0,
    contract: {},
    failure_limit: null,
    retry_on_crash: 'always',
    max_runtime_s: null,
    parents,
    gates: [],
    ...extra,
  });
  return {
    format: 1,
    workflow: 'vendor-eval',
    params: { topic: 'log storage', vendors: ['acme', 'globex'], reviewer: 'reviewer' },
    board: 'research',
    tasks: [
      task('shortlist', 'shortlist', null, 'Shortlist vendors for log storage', [], { contract: { outcome: 'a shortlist with one line per vendor' } }),
      task('evaluate:1', 'evaluate', 'acme', 'Evaluate acme for log storage', ['shortlist'], {
        gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }],
      }),
      task('evaluate:2', 'evaluate', 'globex', 'Evaluate globex for log storage', ['shortlist'], {
        gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }],
      }),
      task('recommend', 'recommend', null, 'Recommend a vendor for log storage', ['evaluate:1', 'evaluate:2'], {
        reviewer: 'reviewer',
        contract: { verification: "every score comes from a parent's summary" },
      }),
    ],
  };
}

/** The smallest DAG: one task with a ref and a title. */
const tiny = (task: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: 1,
  tasks: [{ ref: 'a', title: 'A task', ...task }],
  ...top,
});

function shaped(raw: unknown, from: DagSource = 'terminal'): Dag {
  const r = checkDagShape(raw, from);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.dag;
}

function refused(raw: unknown, from: DagSource = 'terminal'): { code: string; message: string } {
  const r = checkDagShape(raw, from);
  if (r.ok) throw new Error('the DAG was taken');
  return { code: r.code, message: r.message };
}

const sha = (raw: unknown): string => {
  const r = checkDagShape(raw, 'terminal');
  if (!r.ok) throw new Error(r.message);
  return r.sha256;
};

describe('a DAG, at the top level', () => {
  it('takes the example of the spec, and fills in every default of a task left out', () => {
    expect(shaped(example()).tasks.map((t) => [t.ref, t.parents])).toEqual([
      ['shortlist', []],
      ['evaluate:1', ['shortlist']],
      ['evaluate:2', ['shortlist']],
      ['recommend', ['evaluate:1', 'evaluate:2']],
    ]);
    expect(shaped(tiny())).toEqual({
      format: 1,
      workflow: null,
      params: {},
      board: null,
      tasks: [
        {
          ref: 'a',
          step: 'a',
          item: null,
          title: 'A task',
          body: null,
          assignee: null,
          reviewer: null,
          workspace: null,
          priority: 0,
          contract: {},
          failure_limit: null,
          retry_on_crash: 'always',
          max_runtime_s: null,
          parents: [],
          gates: [],
        },
      ],
    });
  });

  it('reads format 1 alone, and refuses an unknown key naming its place, at each level', () => {
    expect(refused({ tasks: [{ ref: 'a', title: 'A' }] })).toEqual({ code: 'invalid', message: 'a DAG needs its format, 1' });
    expect(refused(tiny({}, { format: 2 }))).toEqual({ code: 'invalid', message: 'the DAG is of format 2; this build reads format 1' });
    expect(refused(tiny({}, { format: '1' }))).toEqual({ code: 'invalid', message: 'the DAG is of format "1"; this build reads format 1' });
    expect(refused(tiny({}, { name: 'x' }))).toEqual({
      code: 'invalid',
      message: 'a DAG takes no key "name" (it takes format, workflow, params, board, tasks)',
    });
    expect(refused(tiny({ colour: 'red' })).message).toBe(
      'tasks[0] takes no key "colour" (it takes ref, step, item, title, body, assignee, reviewer, workspace, priority, contract, failure_limit, retry_on_crash, max_runtime_s, parents, gates)',
    );
    expect(refused(tiny({ contract: { outcome: 'x', colour: 'red' } })).message).toBe(
      'tasks[0] (a).contract takes no key "colour" (it takes outcome, verification, constraints, boundaries, stop_when)',
    );
    expect(refused(tiny({ gates: [{ command: 'true', timeout: 3 }] })).message).toBe(
      'tasks[0] (a).gates[0] takes no key "timeout" (it takes command, timeout_s)',
    );
    expect(refused('[]')).toEqual({ code: 'invalid', message: 'a DAG is a JSON object' });
  });

  it('takes 1 to 100 tasks', () => {
    expect(refused(tiny({}, { tasks: [] })).message).toBe('a DAG has 1 to 100 tasks; this one has 0');
    const many = Array.from({ length: 101 }, (_, i) => ({ ref: `t${i}`, title: `Task ${i}` }));
    expect(refused({ format: 1, tasks: many }).message).toBe('a DAG has 1 to 100 tasks; this one has 101');
    expect(shaped({ format: 1, tasks: many.slice(0, 100) }).tasks).toHaveLength(100);
  });

  it('takes a workflow name or null, a board or null, and params in the param grammar, text or lists of text', () => {
    expect(refused(tiny({}, { workflow: 'Vendor Eval' })).message).toBe("workflow is a workflow's name, or null for a DAG with none");
    expect(refused(tiny({}, { board: 7 })).message).toBe("board is a board's name, or null for the path's own");
    expect(refused(tiny({}, { params: { Topic: 'x' } })).message).toMatch(/^params\."Topic" is not a param name: /);
    expect(refused(tiny({}, { params: { topic: 7 } })).message).toBe('params.topic is text, or a list of text');
    expect(refused(tiny({}, { params: { topic: ['a', 1] } })).message).toBe('params.topic is text, or a list of text');
    expect(shaped(tiny({}, { params: { topic: 'x', vendors: ['a', 'b'] } })).params).toEqual({ topic: 'x', vendors: ['a', 'b'] });
  });

  it('refuses params past 64 KiB together', () => {
    const big = { a: 'x'.repeat(40_000), b: 'y'.repeat(30_000) };
    expect(refused(tiny({}, { params: big }))).toEqual({
      code: 'too_large',
      message: `the params are ${JSON.stringify(big).length} bytes as JSON; at most 65536 together`,
    });
  });

  it('refuses null where a key\'s default is not null, and takes it where it is', () => {
    for (const key of ['step', 'priority', 'contract', 'retry_on_crash', 'parents', 'gates']) {
      expect(refused(tiny({ [key]: null })).message).toBe(`tasks[0] (a).${key} is null; leave it out for its default`);
    }
    expect(refused(tiny({}, { params: null })).message).toBe('params is null; leave it out for its default');
    expect(shaped(tiny({ item: null, body: null, assignee: null, reviewer: null, workspace: null, failure_limit: null, max_runtime_s: null }, { workflow: null, board: null })).tasks[0]?.ref).toBe('a');
  });

  it('refuses a lone surrogate anywhere', () => {
    expect(refused(JSON.parse('{"format": 1, "tasks": [{"ref": "a", "title": "x\\ud800y"}]}'))).toEqual({
      code: 'invalid',
      message: 'tasks[0].title is not well formed text: a lone surrogate, as \\ud800 gives, is no text',
    });
    expect(refused(JSON.parse('{"format": 1, "params": {"topic": ["\\udc00"]}, "tasks": [{"ref": "a", "title": "x"}]}')).message).toMatch(
      /^params\.topic\[0\] is not well formed text/,
    );
  });
});

describe("a DAG's tasks", () => {
  it('needs a ref, unique, of 1 to 64 bytes of its characters, and a title', () => {
    expect(refused(tiny({ ref: undefined })).message).toBe('tasks[0] needs a ref');
    expect(refused(tiny({ ref: 'a b' })).message).toBe("tasks[0].ref is 1 to 64 bytes of letters, digits, '.', '_', ':' and '-'");
    expect(refused(tiny({ ref: 'x'.repeat(65) })).message).toBe("tasks[0].ref is 1 to 64 bytes of letters, digits, '.', '_', ':' and '-'");
    expect(refused(tiny({ ref: '' })).message).toBe("tasks[0].ref is 1 to 64 bytes of letters, digits, '.', '_', ':' and '-'");
    expect(shaped(tiny({ ref: 'A.b_c:1-x'.padEnd(64, 'z') })).tasks[0]?.ref).toHaveLength(64);
    expect(refused({ format: 1, tasks: [{ ref: 'a', title: 'A' }, { ref: 'a', title: 'B' }] }).message).toBe(
      'tasks[1].ref a is the ref of an earlier task too; a ref is unique in a DAG',
    );
    expect(refused(tiny({ title: undefined })).message).toBe('tasks[0] (a) needs a title, as text');
  });

  it('takes its step from its ref when absent, and refuses one of other characters', () => {
    expect(shaped(tiny({ ref: 'evaluate:1' })).tasks[0]?.step).toBe('evaluate:1');
    expect(refused(tiny({ step: 'not a step' })).message).toBe("tasks[0] (a).step is 1 to 64 bytes of letters, digits, '.', '_', ':' and '-'");
  });

  it('names only refs earlier in the array as parents, each once', () => {
    const two = (parents: unknown) => ({ format: 1, tasks: [{ ref: 'a', title: 'A' }, { ref: 'b', title: 'B', parents }] });
    expect(shaped(two(['a'])).tasks[1]?.parents).toEqual(['a']);
    expect(refused(two(['a', 'a'])).message).toBe('tasks[1] (b).parents names "a" twice');
    expect(refused(two(['c'])).message).toBe(
      'tasks[1] (b).parents names "c", which is no ref earlier in the DAG: a parent comes before its child, and is one of the DAG\'s own tasks',
    );
    expect(refused({ format: 1, tasks: [{ ref: 'a', title: 'A', parents: ['b'] }, { ref: 'b', title: 'B' }] }).message).toMatch(
      /^tasks\[0\] \(a\)\.parents names "b", which is no ref earlier/,
    );
    expect(refused(two(['b'])).message).toMatch(/^tasks\[1\] \(b\)\.parents names "b", which is no ref earlier/);
    expect(refused(two('a')).message).toBe('tasks[1] (b).parents is a list of refs');
  });

  it('checks every type', () => {
    expect(refused(tiny({ item: 3 })).message).toBe('tasks[0] (a).item is text, or null');
    expect(refused(tiny({ body: 3 })).message).toBe('tasks[0] (a).body is text, or null');
    expect(refused(tiny({ assignee: ['worker'] })).message).toBe('tasks[0] (a).assignee is text, or null');
    expect(refused(tiny({ priority: 1.5 })).message).toBe('tasks[0] (a).priority is a whole number');
    expect(refused(tiny({ contract: 'x' })).message).toBe('tasks[0] (a).contract is an object of text fields');
    expect(refused(tiny({ contract: { outcome: 3 } })).message).toBe('tasks[0] (a).contract.outcome is text');
    expect(refused(tiny({ failure_limit: '2' })).message).toBe('tasks[0] (a).failure_limit is a whole number, or null');
    expect(refused(tiny({ retry_on_crash: 'never' })).message).toBe('tasks[0] (a).retry_on_crash is always or if-no-side-effects');
    expect(refused(tiny({ gates: [{ command: 3 }] })).message).toBe('tasks[0] (a).gates[0].command is text');
    expect(refused(tiny({ gates: [{ command: 'true', timeout_s: 'x' }] })).message).toBe('tasks[0] (a).gates[0].timeout_s is a whole number of seconds');
    expect(refused(tiny({ item: 'x'.repeat(8 * 1024 + 1) }))).toEqual({ code: 'too_large', message: 'tasks[0] (a).item is 8193 bytes; an item is at most 8192' });
  });

  it('keeps a {{ as text, in a title and a gate', () => {
    const d = shaped(tiny({ title: 'Read {{topic}}', gates: [{ command: 'echo {{x}}' }] }));
    expect(d.tasks[0]).toMatchObject({ title: 'Read {{topic}}', gates: [{ command: 'echo {{x}}', timeout_s: 300 }] });
  });
});

describe('where gates may come from', () => {
  const gated = tiny({ gates: [{ command: 'test -s notes.md', timeout_s: 30 }] });

  it('takes them at the terminal and from an expansion, and refuses them from a run, where an empty list is no gate', () => {
    expect(shaped(gated, 'terminal').tasks[0]?.gates).toEqual([{ command: 'test -s notes.md', timeout_s: 30 }]);
    expect(shaped(gated, 'expansion').tasks[0]?.gates).toHaveLength(1);
    expect(refused(gated, 'run')).toEqual({
      code: 'invalid',
      message:
        "tasks[0] (a) has gates, and apply-dag takes none: a gate is a shell command, and defining one is the operator's; " +
        "a workflow file's gates come with start-workflow",
    });
    expect(shaped(tiny({ gates: [] }), 'run').tasks[0]?.gates).toEqual([]);
  });

  it('refuses a gate command holding the mask, from every path', () => {
    for (const from of ['terminal', 'expansion'] as const) {
      expect(refused(tiny({ gates: [{ command: `curl -H "x: ${MASK}" y` }] }), from)).toEqual({
        code: 'invalid',
        message: `tasks[0] (a).gates[0].command holds the mask ${MASK}: the DAG was printed masked, and a masked command would run broken; write the command out again`,
      });
    }
  });
});

describe("what a run's DAG may not set", () => {
  it('refuses priority, failure_limit, retry_on_crash and max_runtime_s unless at their defaults', () => {
    expect(shaped(tiny({ priority: 0, failure_limit: null, retry_on_crash: 'always', max_runtime_s: null }), 'run').tasks).toHaveLength(1);
    expect(refused(tiny({ priority: 5, retry_on_crash: 'if-no-side-effects' }), 'run').message).toBe(
      'tasks[0] (a) sets priority, retry_on_crash, and apply-dag takes no priority, failure_limit, retry_on_crash or max_runtime_s ' +
        "but at their defaults: they are the operator's, as mt kanban create takes none of them",
    );
    expect(refused(tiny({ failure_limit: 2 }), 'run').message).toMatch(/^tasks\[0\] \(a\) sets failure_limit, and apply-dag/);
    expect(refused(tiny({ max_runtime_s: 60 }), 'run').message).toMatch(/^tasks\[0\] \(a\) sets max_runtime_s, and apply-dag/);
    expect(shaped(tiny({ priority: 5 }), 'terminal').tasks[0]?.priority).toBe(5);
  });

  it('refuses a workflow name, and params unless absent or {}', () => {
    expect(refused(tiny({}, { workflow: 'vendor-eval' }), 'run').message).toBe(
      "apply-dag takes no workflow name: a name would say the operator's file made the instance; start-workflow starts a workflow",
    );
    expect(refused(tiny({}, { params: { topic: 'x' } }), 'run').message).toBe(
      'apply-dag takes no params: they would say a workflow was filled in, where an agent made its tasks',
    );
    expect(shaped(tiny({}, { workflow: null, params: {} }), 'run').workflow).toBeNull();
  });
});

describe('the canonical form', () => {
  it('is the same for a reindented file, reordered keys, and defaults written or left out', () => {
    const full = example();
    const reindented = JSON.parse(JSON.stringify(full, null, 7)) as Record<string, unknown>;
    const reordered = JSON.parse(
      JSON.stringify({ tasks: full['tasks'], board: full['board'], params: { vendors: ['acme', 'globex'], reviewer: 'reviewer', topic: 'log storage' }, workflow: full['workflow'], format: 1 }),
    ) as Record<string, unknown>;
    const sparse = {
      format: 1,
      workflow: 'vendor-eval',
      params: { topic: 'log storage', vendors: ['acme', 'globex'], reviewer: 'reviewer' },
      board: 'research',
      tasks: [
        { ref: 'shortlist', title: 'Shortlist vendors for log storage', assignee: 'worker', contract: { outcome: 'a shortlist with one line per vendor', boundaries: null } },
        { ref: 'evaluate:1', step: 'evaluate', item: 'acme', title: 'Evaluate acme for log storage', assignee: 'worker', body: '', parents: ['shortlist'], gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }] },
        { ref: 'evaluate:2', step: 'evaluate', item: 'globex', title: 'Evaluate globex for log storage', assignee: 'worker', parents: ['shortlist'], gates: [{ timeout_s: 30, command: 'test -s evaluation.md' }] },
        { ref: 'recommend', title: 'Recommend a vendor for log storage', assignee: 'worker', reviewer: 'reviewer', contract: { verification: "every score comes from a parent's summary" }, parents: ['evaluate:1', 'evaluate:2'] },
      ],
    };
    const hash = sha(full);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect([sha(reindented), sha(reordered), sha(sparse)]).toEqual([hash, hash, hash]);
    expect(canonicalDag(shaped(sparse))).toBe(canonicalDag(shaped(full)));
  });

  it('is another for one changed value, and writes the params by name, a contract in its order, compact', () => {
    const changed = example();
    (changed['tasks'] as Array<Record<string, unknown>>)[1]!['title'] = 'Evaluate acme for logs';
    expect(sha(changed)).not.toBe(sha(example()));
    const text = canonicalDag(shaped(tiny({ contract: { stop_when: 's', outcome: 'o' } }, { params: { zeta: 'z', alpha: 'a' } })));
    expect(text).toBe(
      '{"format":1,"workflow":null,"params":{"alpha":"a","zeta":"z"},"board":null,"tasks":[{"ref":"a","step":"a","item":null,"title":"A task",' +
        '"body":null,"assignee":null,"reviewer":null,"workspace":null,"priority":0,"contract":{"outcome":"o","stop_when":"s"},' +
        '"failure_limit":null,"retry_on_crash":"always","max_runtime_s":null,"parents":[],"gates":[]}]}',
    );
  });

  it('is unmasked, and its file form is the same indented by two spaces, a deleted default changing no hash', () => {
    const d = shaped(tiny({ title: `Use ${SECRET}` }));
    expect(canonicalDag(d)).toContain(SECRET);
    const file = dagFile(d);
    expect(file).toBe(JSON.stringify(JSON.parse(canonicalDag(d)), null, 2));
    const edited = JSON.parse(file) as { tasks: Array<Record<string, unknown>> };
    delete edited.tasks[0]!['priority'];
    delete edited.tasks[0]!['gates'];
    delete (edited as Record<string, unknown>)['params'];
    expect(sha(edited)).toBe(sha(JSON.parse(file)));
  });

  it('is measured: 192 KiB from a run, and 1 MiB elsewhere', () => {
    // One task whose body brings the canonical form to exactly `size` bytes.
    const sized = (size: number): Record<string, unknown> => {
      const base = canonicalDag(shaped(tiny({ body: 'x' })));
      return tiny({ body: 'x'.repeat(size - base.length + 1) });
    };
    expect(canonicalDag(shaped(sized(DAG_LIMITS.runBytes)))).toHaveLength(DAG_LIMITS.runBytes);
    expect(checkDagShape(sized(DAG_LIMITS.runBytes), 'run').ok).toBe(true);
    expect(refused(sized(DAG_LIMITS.runBytes + 1), 'run')).toEqual({
      code: 'too_large',
      message: `the DAG is ${DAG_LIMITS.runBytes + 1} bytes in its canonical form; it may be at most ${DAG_LIMITS.runBytes} from a run`,
    });
    expect(checkDagShape(sized(DAG_LIMITS.runBytes + 1), 'terminal').ok).toBe(true);
    expect(checkDagShape(sized(DAG_LIMITS.bytes), 'expansion').ok).toBe(true);
    expect(refused(sized(DAG_LIMITS.bytes + 1), 'terminal')).toEqual({
      code: 'too_large',
      message: `the DAG is ${DAG_LIMITS.bytes + 1} bytes in its canonical form; it may be at most ${DAG_LIMITS.bytes}`,
    });
  });
});

describe('readDag', () => {
  it('parses JSON, refusing what is not, a byte order mark included', () => {
    expect(readDag(JSON.stringify(tiny()), 'terminal').ok).toBe(true);
    expect(readDag('{"format": 1,', 'terminal')).toEqual({ ok: false, code: 'invalid', message: 'the DAG is not JSON' });
    expect(readDag(`\uFEFF${JSON.stringify(tiny())}`, 'terminal')).toEqual({ ok: false, code: 'invalid', message: 'the DAG is not JSON' });
  });
});

describe('maskDag', () => {
  it('masks every text but the gates, and keeps the names', () => {
    const d = shaped(
      tiny(
        { title: `T ${SECRET}`, body: SECRET, item: SECRET, contract: { outcome: SECRET }, assignee: 'worker', gates: [{ command: 'echo $TOKEN' }] },
        { params: { topic: SECRET, vendors: [SECRET, 'acme'] } },
      ),
    );
    expect(maskDag(d)).toEqual({
      ...d,
      params: { topic: MASK, vendors: [MASK, 'acme'] },
      tasks: [{ ...d.tasks[0], title: `T ${MASK}`, body: MASK, item: MASK, contract: { outcome: MASK } }],
    });
  });
});

describe('checkDagTasks', () => {
  const ROLES: ReadonlyMap<string, Role> = new Map([
    ['worker', role('worker')],
    ['reviewer', role('reviewer')],
    ['web-dev', role('web-dev', { workspace: 'web' })],
    ['api-dev', role('api-dev', { workspace: 'api' })],
    ['watched', role('watched', { agent: { ...role('watched').agent, unsupervised: false } })],
  ]);
  const check = (extra: Partial<DagCheck> = {}): DagCheck => ({
    facts: { roles: ROLES, workspaces: new Set(['default', 'web', 'api']), supervisedRoles: false, canTalk: (p) => p === 'lark:on_bob' },
    createdBy: ALICE,
    createdVia: VIA,
    ...extra,
  });
  const problem = (raw: unknown, extra: Partial<DagCheck> = {}) => checkDagTasks(shaped(raw), check(extra));

  it('takes the example, and refuses the whole DAG at its first failing task, naming its ref, step and item', () => {
    expect(problem(example())).toBeUndefined();
    const bad = example();
    (bad['tasks'] as Array<Record<string, unknown>>)[2]!['assignee'] = 'evaluator';
    expect(problem(bad)).toEqual({ ok: false, code: 'unknown_role', message: 'evaluate:2, step evaluate, item "globex": role "evaluator" is not configured' });
  });

  it('checks every field as create checks it', () => {
    expect(problem(tiny({ assignee: 'watched' }))).toMatchObject({ code: 'supervised_role' });
    expect(problem(tiny({ workspace: 'nowhere' }))).toEqual({ ok: false, code: 'unknown_workspace', message: 'a: workspace "nowhere" is not configured' });
    expect(problem(tiny({ reviewer: 'lark:on_eve' }))).toMatchObject({ code: 'person_not_assignable' });
    expect(problem(tiny({ reviewer: 'lark:on_bob' }))).toBeUndefined();
    expect(problem(tiny({ title: '  ' }))).toEqual({ ok: false, code: 'invalid', message: 'a: a task needs a title' });
    expect(problem(tiny({ failure_limit: 0 }))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a: priority must be a whole number, and failure_limit and max_runtime_s at least 1',
    });
  });

  it('refuses any person at the terminal', () => {
    expect(problem(tiny({ assignee: 'lark:on_bob' }), { createdVia: { kind: 'operator' }, createdBy: 'operator:me' })).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: 'a: "lark:on_bob" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
    });
  });

  it("holds a title to one line and task new's sizes", () => {
    expect(problem(tiny({ title: 'Two\nlines' }))).toEqual({ ok: false, code: 'invalid', message: 'a: its title is one line, with no control characters and no bidi controls' });
    expect(problem(tiny({ title: 'Mixed \u202Eup' }))).toMatchObject({ code: 'invalid' });
    expect(problem(tiny({ title: 'x'.repeat(513) }))).toEqual({ ok: false, code: 'too_large', message: 'a: its title is 513 bytes; at most 512' });
    expect(problem(tiny({ body: 'x'.repeat(64 * 1024 + 1) }))).toMatchObject({ code: 'too_large', message: 'a: its body is 65537 bytes; at most 65536' });
    expect(problem(tiny({ contract: { outcome: 'x'.repeat(8193) } }))).toMatchObject({ code: 'too_large', message: "a: its contract's outcome is 8193 bytes; at most 8192" });
  });

  it('refuses a name or an item holding a known secret', () => {
    expect(problem(tiny({ workspace: SECRET }))).toEqual({ ok: false, code: 'invalid', message: 'a: its workspace holds a known secret, and a name is stored as written' });
    expect(problem(tiny({ item: `acme ${SECRET}` }))?.message).toBe(
      `a, item "acme ${MASK}": its item holds a known secret: an item labels its task, and two differing only in a secret would be one label`,
    );
  });

  it('checks each gate as addGate would, a gate with no timeout counted as 300 s', () => {
    expect(problem(tiny({ gates: [{ command: `curl ${SECRET}` }] }))?.message).toBe(
      "a: its gates[0].command holds a known secret, and a gate is stored and run as written: pass the value through the role's environment and name it in the command, as $NAME",
    );
    expect(problem(tiny({ gates: [{ command: 'true', timeout_s: 601 }] }))?.message).toBe(
      "a: its gates[0].command has a timeout of 601 s; a gate's timeout is a whole number of seconds, from 1 to 600",
    );
    expect(problem(tiny({ gates: [{ command: 'a\0b' }] }))?.message).toBe('a: its gates[0].command holds a NUL, which no command can');
    expect(problem(tiny({ gates: [{ command: 'x'.repeat(4097) }] }))?.message).toBe('a: its gates[0].command is 4097 bytes; a gate command may be at most 4096');
    expect(problem(tiny({ gates: [{ command: 'one' }, { command: 'two' }, { command: 'three' }] }))?.message).toBe(
      'a: it has gates that would take up to 900 s together; at most 600 s, since a report waits for them',
    );
    expect(problem(tiny({ gates: Array.from({ length: 21 }, () => ({ command: 'true', timeout_s: 1 })) }))?.message).toBe(
      'a: it has 21 gates; a task may have at most 20',
    );
    expect(problem(tiny({ gates: [{ command: 'one' }, { command: 'two' }] }))).toBeUndefined();
  });

  it("refuses a task whose parents certainly work in different workspaces, and judges no parent whose workspace is decided later", () => {
    const fan = (child: Record<string, unknown>, second: Record<string, unknown> = { assignee: 'api-dev' }) => ({
      format: 1,
      tasks: [
        { ref: 'web', title: 'Web', assignee: 'web-dev' },
        { ref: 'api', title: 'API', ...second },
        { ref: 'join', title: 'Join', assignee: 'worker', parents: ['web', 'api'], ...child },
      ],
    });
    expect(problem(fan({}))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'join: its parents work in different workspaces, web and api, and it names none, nor does its role: it could not be given one at its claim; set its workspace',
    });
    expect(problem(fan({ workspace: 'web' }))).toBeUndefined();
    expect(problem(fan({ assignee: 'web-dev' }))).toBeUndefined();
    expect(problem(fan({}, { assignee: 'worker' }))).toBeUndefined();
    expect(problem(fan({}, { assignee: 'worker', workspace: 'web' }))).toBeUndefined();
  });
});

describe('gateProblem and gatesProblem', () => {
  it('are undefined for a gate addGate would take', () => {
    expect(gateProblem({ command: 'npm test', timeoutS: 300 })).toBeUndefined();
    expect(gatesProblem([{ timeoutS: 300 }, { timeoutS: 300 }])).toBeUndefined();
    expect(gateProblem({ command: '   ', timeoutS: 30 })).toBe('is a command, and this one is blank');
  });
});
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-dag.test.ts`. Expected: `Tests  no tests`: the file fails to load, `Error: Cannot find module '../src/kanban/dag.js' imported from '<worktree>/tests/kanban-dag.test.ts'`.

- [ ] **Step 6.3: Implement.**

Create `src/kanban/dag.ts`:

```ts
import { createHash } from 'node:crypto';
import { NAME_PATTERN, visible } from '../names.js';
import type { Role } from '../roles.js';
import { MASK, redactKnownSecrets } from '../secrets.js';
import { BIDI } from '../text.js';
import { gateProblem, gatesProblem } from './gate-command.js';
import { WORKER_LIMITS } from './limits.js';
import { checkTask, isRecord, type TaskFacts } from './task-checks.js';
import { CONTRACT_FIELDS, GATE_LIMITS, type Contract, type CreatedVia, type Refusal, type Result, type RetryOnCrash } from './types.js';

/**
 * The DAG (spec §21.5): the tasks a start or an apply makes, and their links, as
 * one JSON document. Whatever path made it -- a workflow's expansion, a file at
 * the terminal, an agent's `apply-dag` -- an instance is made from a DAG, and
 * stores the DAG it was made from. Pure: what needs the database, the board and
 * the key, is the service's.
 *
 * A DAG is read, checked for its shape, made canonical and measured before
 * anything else; then each task is checked as `create` checks it, and each gate
 * as `addGate`, just before the transaction.
 */

/** The one format this build reads. */
export const DAG_FORMAT = 1;

export const DAG_LIMITS = {
  /** Tasks in one DAG, and so in one instance. */
  tasks: 100,
  /** A ref's, and a step's, size in bytes. */
  refBytes: 64,
  /** A param's text, and each item of a list, in bytes. */
  valueBytes: 8 * 1024,
  /** Items in one list param. */
  listItems: 100,
  /** All the params together, serialized as JSON, in bytes. */
  paramsBytes: 64 * 1024,
  /** The canonical form from a run's `apply-dag`, which crosses the worker socket. */
  runBytes: 192 * 1024,
  /** The canonical form of a start's DAG, and of the terminal's apply. */
  bytes: 1024 * 1024,
  /** What the terminal's apply reads of a file or of stdin, before it is decoded. */
  rawBytes: 4 * 1024 * 1024,
} as const;

/** Where a DAG came from, which decides where its gates may come from (spec §21.5). */
export type DagSource = 'terminal' | 'expansion' | 'run';

export type ParamValue = string | string[];

export interface DagGate {
  command: string;
  timeout_s: number;
}

/** A task of a DAG, every key with its value or its default, as the canonical form writes it. */
export interface DagTask {
  ref: string;
  step: string;
  item: string | null;
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
  parents: string[];
  gates: DagGate[];
}

export interface Dag {
  format: typeof DAG_FORMAT;
  workflow: string | null;
  params: Record<string, ParamValue>;
  board: string | null;
  tasks: DagTask[];
}

/** A DAG that passed its shape check: its canonical form, and that form's SHA-256, unmasked. */
export interface ShapedDag {
  dag: Dag;
  canonical: string;
  sha256: string;
}

const TOP_KEYS = ['format', 'workflow', 'params', 'board', 'tasks'] as const;
const TASK_KEYS = [
  'ref',
  'step',
  'item',
  'title',
  'body',
  'assignee',
  'reviewer',
  'workspace',
  'priority',
  'contract',
  'failure_limit',
  'retry_on_crash',
  'max_runtime_s',
  'parents',
  'gates',
] as const;
const GATE_KEYS = ['command', 'timeout_s'] as const;

/** A ref, and a step: letters, digits, `.`, `_`, `:` and `-`. */
const REF = /^[A-Za-z0-9._:-]+$/;

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** A value a refusal quotes: masked, cut, and its invisible characters shown. */
function shown(text: string, max = 80): string {
  const masked = redactKnownSecrets(text);
  return visible(JSON.stringify(masked.length <= max ? masked : `${masked.slice(0, max)}…`));
}

/** The first string anywhere in `value` that is not well formed, by its place; undefined when every one is. */
function illFormed(value: unknown, place: string): string | undefined {
  const stack: Array<[unknown, string]> = [[value, place]];
  while (stack.length > 0) {
    const [v, at] = stack.pop() as [unknown, string];
    if (typeof v === 'string') {
      if (!v.isWellFormed()) return at;
    } else if (Array.isArray(v)) {
      v.forEach((inner, i) => stack.push([inner, `${at}[${i}]`]));
    } else if (v !== null && typeof v === 'object') {
      for (const [key, inner] of Object.entries(v)) {
        if (!key.isWellFormed()) return at;
        stack.push([inner, at === '' ? key : `${at}.${key}`]);
      }
    }
  }
  return undefined;
}

/** A refusal unless `obj` has only `known` keys, naming the first other one and its place. */
function unknownKey(obj: Record<string, unknown>, known: readonly string[], place: string): Refusal | undefined {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      const where = place === '' ? 'a DAG' : place;
      return refuse('invalid', `${where} takes no key ${shown(key, 64)} (it takes ${known.join(', ')})`);
    }
  }
  return undefined;
}

/** Absent, the default; null, refused, as the key's default is not null. */
function notNull(value: unknown, place: string): Refusal | undefined {
  return value === null ? refuse('invalid', `${place} is null; leave it out for its default`) : undefined;
}

/** Text, or null; absent, null. */
function textOrNull(value: unknown, place: string): Result<{ value: string | null }> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return refuse('invalid', `${place} is text, or null`);
  return { ok: true, value };
}

/** A whole number, or null; absent, null. */
function wholeOrNull(value: unknown, place: string): Result<{ value: number | null }> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Number.isSafeInteger(value)) return refuse('invalid', `${place} is a whole number, or null`);
  return { ok: true, value: value as number };
}

/** The params a DAG records (spec §21.5): each named in the param grammar, text or a list of text, 64 KiB together. */
export function paramsShape(raw: unknown, place = 'params'): Result<{ params: Record<string, ParamValue> }> {
  if (raw === undefined) return { ok: true, params: {} };
  if (!isRecord(raw)) return refuse('invalid', `${place} is an object of text and lists of text`);
  const params: Record<string, ParamValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME_PATTERN.test(name)) {
      return refuse(
        'invalid',
        `${place}.${shown(name, 64)} is not a param name: lowercase letters, digits and '-', starting with a letter, not ending with '-', at most 40 characters`,
      );
    }
    if (typeof value === 'string') params[name] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) params[name] = [...(value as string[])];
    else return refuse('invalid', `${place}.${name} is text, or a list of text`);
  }
  const size = bytes(JSON.stringify(params));
  if (size > DAG_LIMITS.paramsBytes) {
    return refuse('too_large', `the params are ${size} bytes as JSON; at most ${DAG_LIMITS.paramsBytes} together`);
  }
  return { ok: true, params };
}

/** The settings a run's DAG may not set but at their defaults, as its `create` takes none of them (spec §21.5). */
const RUN_DEFAULTS = { priority: 0, failure_limit: null, retry_on_crash: 'always', max_runtime_s: null } as const;

/** One task's shape, with every default filled in; `refs` holds the refs of the tasks before it. */
function taskShape(raw: unknown, i: number, refs: ReadonlySet<string>, from: DagSource): Result<{ task: DagTask }> {
  let place = `tasks[${i}]`;
  if (!isRecord(raw)) return refuse('invalid', `${place} is an object`);
  const unknown = unknownKey(raw, TASK_KEYS, place);
  if (unknown !== undefined) return unknown;
  const { ref } = raw;
  if (ref === undefined || ref === null) return refuse('invalid', `${place} needs a ref`);
  if (typeof ref !== 'string' || ref === '' || bytes(ref) > DAG_LIMITS.refBytes || !REF.test(ref)) {
    return refuse('invalid', `${place}.ref is 1 to ${DAG_LIMITS.refBytes} bytes of letters, digits, '.', '_', ':' and '-'`);
  }
  if (refs.has(ref)) return refuse('invalid', `${place}.ref ${ref} is the ref of an earlier task too; a ref is unique in a DAG`);
  place = `tasks[${i}] (${ref})`;
  const nulls: Refusal | undefined = ['step', 'priority', 'contract', 'retry_on_crash', 'parents', 'gates']
    .map((key) => notNull(raw[key], `${place}.${key}`))
    .find((r) => r !== undefined);
  if (nulls !== undefined) return nulls;
  const step = raw.step ?? ref;
  if (typeof step !== 'string' || step === '' || bytes(step) > DAG_LIMITS.refBytes || !REF.test(step)) {
    return refuse('invalid', `${place}.step is 1 to ${DAG_LIMITS.refBytes} bytes of letters, digits, '.', '_', ':' and '-'`);
  }
  const item = textOrNull(raw.item, `${place}.item`);
  if (!item.ok) return item;
  if (item.value !== null && bytes(item.value) > DAG_LIMITS.valueBytes) {
    return refuse('too_large', `${place}.item is ${bytes(item.value)} bytes; an item is at most ${DAG_LIMITS.valueBytes}`);
  }
  if (typeof raw.title !== 'string') return refuse('invalid', `${place} needs a title, as text`);
  const body = textOrNull(raw.body, `${place}.body`);
  if (!body.ok) return body;
  const names: Record<'assignee' | 'reviewer' | 'workspace', string | null> = { assignee: null, reviewer: null, workspace: null };
  for (const key of ['assignee', 'reviewer', 'workspace'] as const) {
    const v = textOrNull(raw[key], `${place}.${key}`);
    if (!v.ok) return v;
    names[key] = v.value;
  }
  const priority = raw.priority ?? 0;
  if (!Number.isSafeInteger(priority)) return refuse('invalid', `${place}.priority is a whole number`);
  const contract: Contract = {};
  if (raw.contract !== undefined) {
    if (!isRecord(raw.contract)) return refuse('invalid', `${place}.contract is an object of text fields`);
    const bad = unknownKey(raw.contract, CONTRACT_FIELDS, `${place}.contract`);
    if (bad !== undefined) return bad;
    for (const field of CONTRACT_FIELDS) {
      const v = raw.contract[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') return refuse('invalid', `${place}.contract.${field} is text`);
      contract[field] = v;
    }
  }
  const failureLimit = wholeOrNull(raw.failure_limit, `${place}.failure_limit`);
  if (!failureLimit.ok) return failureLimit;
  const maxRuntime = wholeOrNull(raw.max_runtime_s, `${place}.max_runtime_s`);
  if (!maxRuntime.ok) return maxRuntime;
  const retry = raw.retry_on_crash ?? 'always';
  if (retry !== 'always' && retry !== 'if-no-side-effects') {
    return refuse('invalid', `${place}.retry_on_crash is always or if-no-side-effects`);
  }
  const parentsRaw = raw.parents ?? [];
  if (!Array.isArray(parentsRaw) || !parentsRaw.every((p) => typeof p === 'string')) {
    return refuse('invalid', `${place}.parents is a list of refs`);
  }
  const parents = parentsRaw as string[];
  for (const [n, parent] of parents.entries()) {
    if (parents.indexOf(parent) !== n) return refuse('invalid', `${place}.parents names ${shown(parent, 64)} twice`);
    if (!refs.has(parent)) {
      return refuse(
        'invalid',
        `${place}.parents names ${shown(parent, 64)}, which is no ref earlier in the DAG: a parent comes before its child, and is one of the DAG's own tasks`,
      );
    }
  }
  const gatesRaw = raw.gates ?? [];
  if (!Array.isArray(gatesRaw)) return refuse('invalid', `${place}.gates is a list of { command, timeout_s }`);
  if (from === 'run' && gatesRaw.length > 0) {
    return refuse(
      'invalid',
      `${place} has gates, and apply-dag takes none: a gate is a shell command, and defining one is the operator's; ` +
        "a workflow file's gates come with start-workflow",
    );
  }
  const gates: DagGate[] = [];
  for (const [g, gate] of gatesRaw.entries()) {
    const at = `${place}.gates[${g}]`;
    if (!isRecord(gate)) return refuse('invalid', `${at} is an object, { command, timeout_s }`);
    const bad = unknownKey(gate, GATE_KEYS, at);
    if (bad !== undefined) return bad;
    if (typeof gate.command !== 'string') return refuse('invalid', `${at}.command is text`);
    const timeout = notNull(gate.timeout_s, `${at}.timeout_s`);
    if (timeout !== undefined) return timeout;
    const timeoutS = gate.timeout_s ?? GATE_LIMITS.defaultTimeoutS;
    if (!Number.isSafeInteger(timeoutS)) return refuse('invalid', `${at}.timeout_s is a whole number of seconds`);
    if (gate.command.includes(MASK)) {
      return refuse(
        'invalid',
        `${at}.command holds the mask ${MASK}: the DAG was printed masked, and a masked command would run broken; write the command out again`,
      );
    }
    gates.push({ command: gate.command, timeout_s: timeoutS as number });
  }
  const task: DagTask = {
    ref,
    step,
    item: item.value,
    title: raw.title,
    // "" is no body, as create stores either.
    body: body.value === '' ? null : body.value,
    ...names,
    priority: priority as number,
    contract,
    failure_limit: failureLimit.value,
    retry_on_crash: retry,
    max_runtime_s: maxRuntime.value,
    parents: [...parents],
    gates,
  };
  if (from === 'run') {
    const set = (Object.keys(RUN_DEFAULTS) as (keyof typeof RUN_DEFAULTS)[]).filter((key) => task[key] !== RUN_DEFAULTS[key]);
    if (set.length > 0) {
      return refuse(
        'invalid',
        `${place} sets ${set.join(', ')}, and apply-dag takes no priority, failure_limit, retry_on_crash or max_runtime_s ` +
          "but at their defaults: they are the operator's, as mt kanban create takes none of them",
      );
    }
  }
  return { ok: true, task };
}

/**
 * A DAG's shape (spec §21.5): its format, every key known, every type, every
 * string well formed, the refs and parents, where its gates came from, and from
 * a run the settings it may not set; then its canonical form, measured. Every
 * default filled in, so the DAG it answers is what the canonical form writes.
 */
export function checkDagShape(raw: unknown, from: DagSource): Result<ShapedDag> {
  if (!isRecord(raw)) return refuse('invalid', 'a DAG is a JSON object');
  const bad = illFormed(raw, '');
  if (bad !== undefined) {
    return refuse('invalid', `${bad === '' ? 'a key' : bad} is not well formed text: a lone surrogate, as \\ud800 gives, is no text`);
  }
  const unknown = unknownKey(raw, TOP_KEYS, '');
  if (unknown !== undefined) return unknown;
  if (raw.format === undefined || raw.format === null) return refuse('invalid', `a DAG needs its format, ${DAG_FORMAT}`);
  if (raw.format !== DAG_FORMAT) {
    return refuse('invalid', `the DAG is of format ${visible(String(JSON.stringify(raw.format))).slice(0, 32)}; this build reads format ${DAG_FORMAT}`);
  }
  const workflow = raw.workflow ?? null;
  if (workflow !== null && (typeof workflow !== 'string' || !NAME_PATTERN.test(workflow))) {
    return refuse('invalid', "workflow is a workflow's name, or null for a DAG with none");
  }
  if (from === 'run' && workflow !== null) {
    return refuse(
      'invalid',
      "apply-dag takes no workflow name: a name would say the operator's file made the instance; start-workflow starts a workflow",
    );
  }
  const nulled = notNull(raw.params, 'params');
  if (nulled !== undefined) return nulled;
  const params = paramsShape(raw.params);
  if (!params.ok) return params;
  if (from === 'run' && Object.keys(params.params).length > 0) {
    return refuse('invalid', 'apply-dag takes no params: they would say a workflow was filled in, where an agent made its tasks');
  }
  const board = raw.board ?? null;
  if (board !== null && typeof board !== 'string') return refuse('invalid', "board is a board's name, or null for the path's own");
  if (!Array.isArray(raw.tasks)) return refuse('invalid', 'a DAG needs its tasks, a list');
  if (raw.tasks.length === 0 || raw.tasks.length > DAG_LIMITS.tasks) {
    return refuse('invalid', `a DAG has 1 to ${DAG_LIMITS.tasks} tasks; this one has ${raw.tasks.length}`);
  }
  const refs = new Set<string>();
  const tasks: DagTask[] = [];
  for (const [i, t] of raw.tasks.entries()) {
    const shaped = taskShape(t, i, refs, from);
    if (!shaped.ok) return shaped;
    refs.add(shaped.task.ref);
    tasks.push(shaped.task);
  }
  const dag: Dag = { format: DAG_FORMAT, workflow, params: params.params, board, tasks };
  const canonical = canonicalDag(dag);
  const size = bytes(canonical);
  const most = from === 'run' ? DAG_LIMITS.runBytes : DAG_LIMITS.bytes;
  if (size > most) {
    return refuse('too_large', `the DAG is ${size} bytes in its canonical form; it may be at most ${most}${from === 'run' ? ' from a run' : ''}`);
  }
  return { ok: true, dag, canonical, sha256: createHash('sha256').update(canonical, 'utf8').digest('hex') };
}

/**
 * A DAG read from text (spec §21.5): parsed as JSON, then shaped. Text with a
 * byte order mark, which a strict decoding keeps, is not JSON.
 */
export function readDag(text: string, from: DagSource): Result<ShapedDag> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not quoted: the text is the caller's, and may hold anything.
    return refuse('invalid', 'the DAG is not JSON');
  }
  return checkDagShape(raw, from);
}

/** The canonical object: every key in the tables' order, every default written, a contract's fields in order, the params by name. */
function canonicalObject(dag: Dag): Record<string, unknown> {
  const params: Record<string, ParamValue> = {};
  for (const name of Object.keys(dag.params).sort()) params[name] = dag.params[name] as ParamValue;
  return {
    format: dag.format,
    workflow: dag.workflow,
    params,
    board: dag.board,
    tasks: dag.tasks.map((t) => {
      const contract: Contract = {};
      for (const field of CONTRACT_FIELDS) if (t.contract[field] !== undefined) contract[field] = t.contract[field];
      return {
        ref: t.ref,
        step: t.step,
        item: t.item,
        title: t.title,
        body: t.body,
        assignee: t.assignee,
        reviewer: t.reviewer,
        workspace: t.workspace,
        priority: t.priority,
        contract,
        failure_limit: t.failure_limit,
        retry_on_crash: t.retry_on_crash,
        max_runtime_s: t.max_runtime_s,
        parents: t.parents,
        gates: t.gates.map((g) => ({ command: g.command, timeout_s: g.timeout_s })),
      };
    }),
  };
}

/** The canonical form (spec §21.5): compact JSON, unmasked, what a DAG is measured and hashed by on every path. */
export function canonicalDag(dag: Dag): string {
  return JSON.stringify(canonicalObject(dag));
}

/** The canonical form indented by two spaces: `preview --json`'s file, and `show --dag`'s, before they are masked. */
export function dagFile(dag: Dag): string {
  return JSON.stringify(canonicalObject(dag), null, 2);
}

/**
 * The DAG as an instance stores it (spec §21.7): every text masked, value by
 * value, as an event payload is, but its gates' commands, stored as written, as
 * `kanban_gates` stores them. Names, refs and steps identify, and are kept.
 */
export function maskDag(dag: Dag): Dag {
  const mask = redactKnownSecrets;
  const params: Record<string, ParamValue> = {};
  for (const [name, value] of Object.entries(dag.params)) params[name] = typeof value === 'string' ? mask(value) : value.map(mask);
  return {
    ...dag,
    params,
    tasks: dag.tasks.map((t) => {
      const contract: Contract = {};
      for (const field of CONTRACT_FIELDS) {
        const v = t.contract[field];
        if (v !== undefined) contract[field] = mask(v);
      }
      return {
        ...t,
        item: t.item === null ? null : mask(t.item),
        title: mask(t.title),
        body: t.body === null ? null : mask(t.body),
        contract,
      };
    }),
  };
}

/** A task as a refusal names it (spec §21.6): its ref, its step when that is not its ref, and its item. */
export function taskPlace(t: Pick<DagTask, 'ref' | 'step' | 'item'>): string {
  return `${t.ref}${t.step === t.ref ? '' : `, step ${t.step}`}${t.item === null ? '' : `, item ${shown(t.item)}`}`;
}

/** What a title may not hold: a line break or any other control character, and a bidi control (spec §21.2). */
export function titleRefused(text: string): boolean {
  return /[\p{Cc}\u2028\u2029]/u.test(text) || new RegExp(BIDI.source).test(text);
}

/** How the tasks of a DAG are checked (spec §21.6 step 2): who makes them, and whether a person may be named. */
export interface DagCheck {
  facts: TaskFacts;
  createdBy: string;
  createdVia: CreatedVia;
}

/** The workspace a task certainly works in, before any claim: its own, or its role's (spec §2.3 rules 1 and 2). */
function certainWorkspace(t: DagTask, roles: ReadonlyMap<string, Role>): string | undefined {
  if (t.workspace !== null) return t.workspace;
  if (t.assignee === null || t.assignee.includes(':')) return undefined;
  return roles.get(t.assignee)?.workspace;
}

/**
 * Each task of a shaped DAG checked as `create` checks it (spec §21.6 step 2),
 * each gate as `addGate`, plus every name and item holding no known secret, a
 * title of one line, `task new`'s sizes, and a task whose parents certainly work
 * in different workspaces refused. The first failure refuses the whole DAG,
 * naming the task. A person is checked by `facts.canTalk`; at the terminal,
 * which has no talk check, any person is refused.
 */
export function checkDagTasks(dag: Dag, check: DagCheck): Refusal | undefined {
  const byRef = new Map(dag.tasks.map((t) => [t.ref, t]));
  const terminal = check.createdVia.kind === 'operator';
  for (const t of dag.tasks) {
    const at = taskPlace(t);
    const no = (code: Refusal['code'], why: string): Refusal => refuse(code, `${at}: ${why}`);
    if (t.title.trim() === '') return no('invalid', 'a task needs a title');
    if (titleRefused(t.title)) return no('invalid', 'its title is one line, with no control characters and no bidi controls');
    if (bytes(t.title) > WORKER_LIMITS.title) return no('too_large', `its title is ${bytes(t.title)} bytes; at most ${WORKER_LIMITS.title}`);
    if (t.body !== null && bytes(t.body) > WORKER_LIMITS.body) {
      return no('too_large', `its body is ${bytes(t.body)} bytes; at most ${WORKER_LIMITS.body}`);
    }
    for (const field of CONTRACT_FIELDS) {
      const v = t.contract[field];
      if (v !== undefined && bytes(v) > WORKER_LIMITS.contractField) {
        return no('too_large', `its contract's ${field} is ${bytes(v)} bytes; at most ${WORKER_LIMITS.contractField}`);
      }
    }
    for (const key of ['assignee', 'reviewer', 'workspace'] as const) {
      const v = t[key];
      // Names are stored unmasked, as they identify: one holding a secret is refused (spec §21.2).
      if (v !== null && redactKnownSecrets(v) !== v) return no('invalid', `its ${key} holds a known secret, and a name is stored as written`);
    }
    if (t.item !== null && redactKnownSecrets(t.item) !== t.item) {
      return no('invalid', 'its item holds a known secret: an item labels its task, and two differing only in a secret would be one label');
    }
    if (terminal) {
      for (const v of [t.assignee, t.reviewer]) {
        if (v !== null && v.includes(':')) {
          return no(
            'person_not_assignable',
            `${shown(v)} is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier`,
          );
        }
      }
    }
    const checked = checkTask(
      {
        title: t.title,
        ...(t.body === null ? {} : { body: t.body }),
        contract: t.contract,
        ...(t.assignee === null ? {} : { assignee: t.assignee }),
        ...(t.reviewer === null ? {} : { reviewer: t.reviewer }),
        ...(t.workspace === null ? {} : { workspace: t.workspace }),
        priority: t.priority,
        ...(t.failure_limit === null ? {} : { failureLimit: t.failure_limit }),
        retryOnCrash: t.retry_on_crash,
        ...(t.max_runtime_s === null ? {} : { maxRuntimeS: t.max_runtime_s }),
        createdBy: check.createdBy,
        createdVia: check.createdVia,
      },
      check.facts,
    );
    if (!checked.ok) return no(checked.code, checked.message);
    for (const [g, gate] of t.gates.entries()) {
      const problem = gateProblem({ command: gate.command, timeoutS: gate.timeout_s });
      if (problem !== undefined) return no('invalid', `its gates[${g}].command ${problem}`);
    }
    const together = gatesProblem(t.gates.map((g) => ({ timeoutS: g.timeout_s })));
    if (together !== undefined) return no('invalid', `it ${together}`);
    if (certainWorkspace(t, check.facts.roles) === undefined && t.parents.length > 1) {
      const theirs = [
        ...new Set(
          t.parents.map((p) => byRef.get(p)).flatMap((p) => (p === undefined ? [] : [certainWorkspace(p, check.facts.roles)])),
        ),
      ].filter((w): w is string => w !== undefined);
      if (theirs.length > 1) {
        return no(
          'invalid',
          `its parents work in different workspaces, ${theirs.join(' and ')}, and it names none, nor does its role: ` +
            'it could not be given one at its claim; set its workspace',
        );
      }
    }
  }
  return undefined;
}
```

In `src/kanban/gate-command.ts`, replace:

```ts
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
```

with:

```ts
import { MASK, redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import { GATE_LIMITS } from './types.js';
```

In `src/kanban/gate-command.ts`, replace:

```ts
}
```

with:

```ts
}

/**
 * Why a gate a workflow or a DAG puts on a task could not be added, as `addGate`
 * would refuse it (spec §21.4, §21.5), or undefined: a command, not blank, with
 * no NUL, of at most 4 KiB, holding neither the mask nor a known secret, and a
 * timeout from 1 to 600 s. Said after the gate's place, as `<place> <problem>`.
 */
export function gateProblem(gate: { command: string; timeoutS: number }): string | undefined {
  const { command } = gate;
  if (command.trim() === '') return 'is a command, and this one is blank';
  if (command.includes('\0')) return 'holds a NUL, which no command can';
  const size = Buffer.byteLength(command, 'utf8');
  if (size > GATE_LIMITS.commandBytes) return `is ${size} bytes; a gate command may be at most ${GATE_LIMITS.commandBytes}`;
  if (command.includes(MASK)) {
    return `holds the mask ${MASK}: it was copied from masked output, and a masked command would run broken; write the command out again`;
  }
  if (holdsSecret(command)) {
    return (
      'holds a known secret, and a gate is stored and run as written: ' +
      "pass the value through the role's environment and name it in the command, as $NAME"
    );
  }
  if (!Number.isSafeInteger(gate.timeoutS) || gate.timeoutS < 1 || gate.timeoutS > GATE_LIMITS.maxTimeoutS) {
    return `has a timeout of ${String(gate.timeoutS)} s; a gate's timeout is a whole number of seconds, from 1 to ${GATE_LIMITS.maxTimeoutS}`;
  }
  return undefined;
}

/** Why a task's gates together could not be added, or undefined: at most 20, and 600 s together (spec §7.7). */
export function gatesProblem(gates: readonly { timeoutS: number }[]): string | undefined {
  if (gates.length > GATE_LIMITS.perTask) return `has ${gates.length} gates; a task may have at most ${GATE_LIMITS.perTask}`;
  const total = gates.reduce((sum, g) => sum + g.timeoutS, 0);
  if (total > GATE_LIMITS.totalTimeoutS) {
    return `has gates that would take up to ${total} s together; at most ${GATE_LIMITS.totalTimeoutS} s, since a report waits for them`;
  }
  return undefined;
}
```

In `src/kanban/types.ts`, replace:

```ts
  | 'other_board';
```

with:

```ts
  | 'other_board'
  /** Something over its size: a DAG, the params, a value or a task's field (spec §21.5). */
  | 'too_large'
  /** No usable workflow file of that name (spec §21.6). */
  | 'unknown_workflow';
```

In `src/kanban/worker.ts`, replace:

```ts
  | 'unknown_command'
  /** A request, or a field of one, over its size. */
  | 'too_large'
```

with:

```ts
  | 'unknown_command'
```

- [ ] **Step 6.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2048 passed (2048)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.5: Commit.**

```bash
git add src/kanban/dag.ts src/kanban/gate-command.ts src/kanban/types.ts src/kanban/worker.ts tests/kanban-dag.test.ts
git commit -m "Add the DAG: its format, its shape with every default filled in, its canonical form, measured and hashed, where gates may come from, what a run's DAG may not set, and each task checked as create checks it"
```

---

### Task 7: A workflow file and its checks

**Files:**

- Create: `src/kanban/workflow.ts`, `tests/helpers/workflow.ts`, `tests/kanban-workflow-file.test.ts`
- Modify: `src/names.ts`

Spec §21.1, §21.2, §21.4. `src/kanban/workflow.ts`. `checkWorkflow(name, text, facts)` parses with the `yaml` package's `parse` (YAML 1.2's core schema; a duplicated key is the parser's error; warnings silenced with `logLevel: 'error'`, as a key that is a mapping would otherwise warn on stderr), checks the keys with `config.ts`'s `section` and `reject` at every level, their place named and the file's name taken off, the names in the role grammar (`nameProblem` gains `workflow`, `step` and `param`), `item` reserved, the params (`required` or a `default`, never both or neither), the parents (steps of the file, never itself, no cycle, named `a -> b -> a`, each written above its child), `for_each` over a declared list param, every `{{` opening a reference to a declared param or `{{item}}` in a for_each step, a name field one whole reference or a name written out that `create` would take, no list param there, the gates (no `{{`, no mask, `addGate`'s rules), and a step whose parents certainly disagree on a workspace. A mapping where text belongs says to quote a `{{`. `listWorkflows(dir, facts)` reads the directory: usable, broken with why, and each entry that is no workflow (a dot-entry, a name out of the grammar, a symlink, not a regular `.yaml` file) said once; a file past 64 KiB is broken. `readWorkflow` reads one by name, `unknown_workflow` for none. `workflowLines` gives the startup's lines, `paramsLine` a workflow's params. The example of spec §21.1 is `tests/helpers/workflow.ts`'s `VENDOR_EVAL`.

- [ ] **Step 7.1: Write the tests.**

Create `tests/helpers/workflow.ts`:

```ts
/**
 * Building blocks for tests of workflows (spec §21): the example of the spec, as
 * a file, and a home's workflows directory to write files into.
 */

/** The example of spec §21.1, as written there. */
export const VENDOR_EVAL = `description: Shortlist vendors, evaluate each in parallel, then recommend one
params:
  topic:    { required: true, description: what is being bought }
  vendors:  { list: true, required: true }
  reviewer: { default: reviewer }
steps:
  shortlist:
    title: Shortlist vendors for {{topic}}
    assignee: worker
    outcome: a shortlist with one line per vendor
  evaluate:
    for_each: vendors
    parents: [shortlist]
    title: Evaluate {{item}} for {{topic}}
    assignee: worker
    gates:
      - command: test -s evaluation.md
        timeout_s: 30
  recommend:
    parents: [evaluate]
    title: Recommend a vendor for {{topic}}
    assignee: worker
    reviewer: { role: "{{reviewer}}" }
    verify: every score comes from a parent's summary
`;
```

Create `tests/kanban-workflow-file.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkWorkflow,
  listWorkflows,
  paramsLine,
  readWorkflow,
  workflowLines,
  type WorkflowFacts,
} from '../src/kanban/workflow.js';
import type { Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { role } from './helpers/dispatch.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A workflow file and its checks (spec §21.1 to §21.4): the keys at every level,
 * the names, the params, the parents, for_each, the references, the roles and
 * workspaces written out, the gates, and the workspaces a step's parents
 * certainly work in. And the directory: what is ignored, and the startup lines.
 */

const ROLES: ReadonlyMap<string, Role> = new Map([
  ['worker', role('worker')],
  ['reviewer', role('reviewer')],
  ['web-dev', role('web-dev', { workspace: 'web' })],
  ['api-dev', role('api-dev', { workspace: 'api' })],
  ['watched', role('watched', { agent: { ...role('watched').agent, unsupervised: false } })],
]);
const FACTS: WorkflowFacts = { roles: ROLES, workspaces: new Set(['default', 'web', 'api']), supervisedRoles: false };

const SECRET = 'sk-live-1234567890';
let dir: string;
beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  dir = mkdtempSync(join(tmpdir(), 'mt-wf-file-'));
});
afterEach(() => {
  clearSecrets();
  rmSync(dir, { recursive: true, force: true });
});

/** The problem a file's check finds, or undefined. */
function problem(text: string, facts: WorkflowFacts = FACTS): string | undefined {
  const r = checkWorkflow('test', text, facts);
  return r.ok ? undefined : r.problem;
}

/** A file of one step, `a`, with these lines under it, and these params. */
const oneStep = (lines: string, params = ''): string =>
  `${params === '' ? '' : `params:\n${params}\n`}steps:\n  a:\n    title: A task\n${lines}`;

describe('the example of the spec', () => {
  it('is usable, its steps and params in the order written', () => {
    const r = checkWorkflow('vendor-eval', VENDOR_EVAL, FACTS);
    if (!r.ok) throw new Error(r.problem);
    const w = r.workflow;
    expect(w.description).toBe('Shortlist vendors, evaluate each in parallel, then recommend one');
    expect(w.steps.map((s) => s.name)).toEqual(['shortlist', 'evaluate', 'recommend']);
    expect(w.params.map((p) => p.name)).toEqual(['topic', 'vendors', 'reviewer']);
    expect(paramsLine(w)).toBe('topic (required), vendors (list, required), reviewer (default reviewer)');
    expect(w.steps[1]).toMatchObject({ forEach: 'vendors', parents: ['shortlist'], gates: [{ command: 'test -s evaluation.md', timeoutS: 30 }] });
    expect(w.steps[2]).toMatchObject({ reviewer: { value: '{{reviewer}}', must: 'role' }, contract: { verification: "every score comes from a parent's summary" } });
  });

  it('keeps the steps in the order written, whatever their names', () => {
    const r = checkWorkflow('order', 'steps:\n  zeta: { title: Z }\n  alpha: { title: A }\n  mid: { title: M, parents: [zeta, alpha] }\n', FACTS);
    expect(r.ok && r.workflow.steps.map((s) => s.name)).toEqual(['zeta', 'alpha', 'mid']);
  });
});

describe('the keys', () => {
  it('refuses an unknown one at each level, naming it and its place', () => {
    expect(problem('steps:\n  a: { title: A }\nname: x\n')).toBe('unknown setting name (known: description, params, steps)');
    expect(problem(oneStep('    timeout: 3\n'))).toMatch(/^unknown setting steps\.a\.timeout \(known: title, body, assignee, /);
    expect(problem(oneStep('', '  topic: { required: true, kind: text }'))).toBe(
      'unknown setting params.topic.kind (known: list, required, default, description)',
    );
    expect(problem(oneStep('    gates:\n      - { command: "true", timeout: 3 }\n'))).toBe(
      'unknown setting steps.a.gates[0].timeout (known: command, timeout_s)',
    );
    expect(problem(oneStep('    reviewer: { team: x }\n'))).toBe('unknown setting steps.a.reviewer.team (known: role, person)');
    expect(problem(oneStep('    token: x\n'))).toMatch(/^steps\.a\.token looks like a credential/);
  });

  it('refuses a duplicated key, as the parser does, and YAML that does not parse', () => {
    expect(problem('steps:\n  a: { title: A }\n  a: { title: B }\n')).toMatch(/^the YAML does not parse: Map keys must be unique/);
    expect(problem('steps: [\n')).toMatch(/^the YAML does not parse: /);
  });

  it('says to quote a value that starts with {{', () => {
    expect(problem(oneStep('    assignee: {{owner}}\n', '  owner: { required: true }'))).toBe(
      'steps.a.assignee is a mapping, where text belongs: a value that starts with {{ must be quoted, as "{{name}}"',
    );
    const unquoted = 'params:\n  topic: { required: true }\nsteps:\n  a:\n    title: {{topic}}\n';
    expect(problem(unquoted)).toBe('steps.a.title is a mapping, where text belongs: a value that starts with {{ must be quoted, as "{{name}}"');
    expect(problem(oneStep('    reviewer: { role: {{owner}} }\n', '  owner: { required: true }'))).toBe(
      'steps.a.reviewer.role is a mapping, where text belongs: a value that starts with {{ must be quoted, as "{{name}}"',
    );
  });

  it('reads yes as text, and checks the types', () => {
    expect(problem(oneStep('    body: yes\n'))).toBeUndefined();
    expect(problem(oneStep('    body: 3\n'))).toBe('steps.a.body is text');
    expect(problem(oneStep('    priority: high\n'))).toBe('steps.a.priority is a whole number');
    expect(problem(oneStep('    failure_limit: 0\n'))).toBe('steps.a.failure_limit is a whole number, at least 1');
    expect(problem(oneStep('    max_runtime_s: 1.5\n'))).toBe('steps.a.max_runtime_s is a whole number, at least 1');
    expect(problem(oneStep('    retry_on_crash: never\n'))).toBe('steps.a.retry_on_crash is always or if-no-side-effects');
    expect(problem(oneStep('    parents: a\n'))).toBe('steps.a.parents is a list of step names');
    expect(problem(oneStep('    gates: true\n'))).toBe('steps.a.gates is a list of { command, timeout_s }');
    expect(problem(oneStep('    gates:\n      - { timeout_s: 3 }\n'))).toBe('steps.a.gates[0] needs a command');
    expect(problem('steps:\n  a: { body: B }\n')).toBe('steps.a needs a title');
    expect(problem('description: x\n')).toBe('the file needs steps, at least one');
    expect(problem('steps: {}\n')).toBe('the file needs steps, at least one');
    expect(problem('- a\n')).toBe('the file must be a mapping');
  });
});

describe('the names', () => {
  it('holds steps and params to the grammar, and keeps item for the for_each item', () => {
    expect(problem('steps:\n  Shortlist: { title: A }\n')).toMatch(/^steps\.Shortlist: step name "Shortlist" must be lowercase letters/);
    expect(problem(oneStep('', '  Topic: { required: true }'))).toMatch(/^params\.Topic: param name "Topic" must be lowercase letters/);
    expect(problem(oneStep('', '  item: { required: true }'))).toBe("params.item: item is the for_each item's name, and no param's");
  });
});

describe('the params', () => {
  it('is required or has a default, never both and never neither', () => {
    expect(problem(oneStep('', '  topic: { required: true, default: x }'))).toBe('params.topic is required and has a default: say one or the other');
    expect(problem(oneStep('', '  topic: { description: what }'))).toBe(
      'params.topic is neither required nor given a default: a {{topic}} left out would have no value',
    );
    expect(problem(oneStep('', '  topic: { required: false }'))).toMatch(/^params\.topic is neither required nor given a default/);
    expect(problem(oneStep('', '  vendors: { list: true, default: acme }'))).toBe('params.vendors.default is a list of text, as the param is a list');
    expect(problem(oneStep('', '  topic: { default: [a] }'))).toBe('params.topic.default is text');
    expect(problem(oneStep('', '  topic: { list: yes, required: true }'))).toBe('params.topic.list is true or false');
  });
});

describe('the parents and for_each', () => {
  it('names a step of the file, never itself, with no cycle, each written above its children', () => {
    expect(problem(oneStep('    parents: [b]\n'))).toBe('steps.a.parents names "b", which is no step of this file');
    expect(problem(oneStep('    parents: [a]\n'))).toBe('steps.a.parents names the step itself');
    expect(problem('steps:\n  a: { title: A, parents: [b] }\n  b: { title: B, parents: [c] }\n  c: { title: C, parents: [a] }\n')).toBe(
      "the steps' parents make a cycle: a -> b -> c -> a",
    );
    expect(problem('steps:\n  a: { title: A, parents: [b] }\n  b: { title: B }\n')).toBe(
      'steps.a.parents names b, which is written after it: write a step below its parents',
    );
    expect(problem('steps:\n  a: { title: A }\n  b: { title: B, parents: [a, a] }\n')).toBe('steps.b.parents names a twice');
  });

  it('takes for_each over a declared list param, and {{item}} only in a for_each step', () => {
    expect(problem(oneStep('    for_each: topic\n', '  topic: { required: true }'))).toBe(
      'steps.a.for_each names topic, a text param: for_each takes a list param',
    );
    expect(problem(oneStep('    for_each: vendors\n'))).toBe('steps.a.for_each names "vendors", which is no param this file declares');
    expect(problem('steps:\n  a:\n    title: Evaluate {{item}}\n')).toBe('steps.a.title uses {{item}}, which only a for_each step has');
    expect(problem(oneStep('    for_each: vendors\n    body: About {{item}}\n', '  vendors: { list: true, required: true }'))).toBeUndefined();
  });
});

describe('the references', () => {
  it('opens every {{ to a declared param, in every text field', () => {
    for (const key of ['body', 'outcome', 'verify', 'constraints', 'boundaries', 'stop_when']) {
      expect(problem(oneStep(`    ${key}: "about {{topik}}"\n`, '  topic: { required: true }'))).toBe(
        `steps.a.${key} names {{topik}}, which is no param this file declares`,
      );
    }
    expect(problem(oneStep('    body: "about {{ topic }}"\n', '  topic: { required: true }'))).toBe(
      "steps.a.body has a {{ that opens no reference: write {{name}}, a param's name with no spaces; a literal {{ cannot be written",
    );
    expect(problem(oneStep('    body: "a {{topic}} and {{topic}}, {{vendors}}"\n', '  topic: { required: true }\n  vendors: { list: true, required: true }'))).toBeUndefined();
  });

  it('takes one whole reference in a name field, never a list param, and never parts', () => {
    const params = '  owner: { required: true }\n  vendors: { list: true, required: true }';
    expect(problem(oneStep('    assignee: "{{owner}}"\n', params))).toBeUndefined();
    expect(problem(oneStep('    reviewer: { person: "{{owner}}" }\n', params))).toBeUndefined();
    expect(problem(oneStep('    assignee: "{{vendors}}"\n', params))).toBe(
      'steps.a.assignee names {{vendors}}, a list param: a name field takes one name, so a text param or {{item}}',
    );
    expect(problem(oneStep('    assignee: "team-{{owner}}"\n', params))).toBe(
      'steps.a.assignee is a name, or one whole reference such as "{{name}}": a name is never put together from parts',
    );
    expect(problem(oneStep('    workspace: "{{ghost}}"\n', params))).toBe('steps.a.workspace names {{ghost}}, which is no param this file declares');
    expect(problem(oneStep('    for_each: vendors\n    assignee: "{{item}}"\n', params))).toBeUndefined();
    expect(problem(oneStep('    assignee: "{{item}}"\n', params))).toBe('steps.a.assignee uses {{item}}, which only a for_each step has');
  });
});

describe('roles and workspaces written out', () => {
  it('are configured and usable, as create asks of them; a person is checked at a start', () => {
    expect(problem(oneStep('    assignee: evaluator\n'))).toBe('steps.a.assignee: role "evaluator" is not configured');
    expect(problem(oneStep('    reviewer: watched\n'))).toBe(
      'steps.a.reviewer: role "watched" has a supervised agent; its approval requests would reach nobody until the board is in Lark',
    );
    expect(problem(oneStep('    reviewer: watched\n'), { ...FACTS, supervisedRoles: true })).toBeUndefined();
    expect(problem(oneStep('    workspace: nowhere\n'))).toBe('steps.a.workspace: workspace "nowhere" is not configured');
    expect(problem(oneStep('    assignee: lark:on_alice\n'))).toBeUndefined();
    expect(problem(oneStep('    assignee: "lark:not one"\n'))).toBe('steps.a.assignee: "lark:not one" is neither a role name nor a person (lark:<union_id>)');
    expect(problem(oneStep('    assignee: { role: lark:on_alice }\n'))).toBe('steps.a.assignee.role is a role\'s place, and "lark:on_alice" is a person');
    expect(problem(oneStep('    assignee: { person: worker }\n'))).toBe('steps.a.assignee.person is a person\'s place, and "worker" is a role\'s name');
  });
});

describe('the gates', () => {
  const gate = (command: string, timeout = '') => oneStep(`    gates:\n      - command: ${JSON.stringify(command)}${timeout === '' ? '' : `\n        timeout_s: ${timeout}`}\n`);

  it('refuses a {{ and the mask, and takes $NAME', () => {
    expect(problem(gate('test -s {{file}}'))).toBe(
      'steps.a.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead',
    );
    expect(problem(gate('curl -H "x: $TOKEN" https://example.com'))).toBeUndefined();
    expect(problem(gate(`curl ${MASK}`))).toBe(
      `steps.a.gates[0].command holds the mask ${MASK}: it was copied from masked output, and a masked command would run broken; write the command out again`,
    );
  });

  it('refuses one holding a known secret, too long, too slow, twenty-one, and 601 s together, a gate with no timeout counted as 300 s', () => {
    expect(problem(gate(`curl ${SECRET}`))).toMatch(/^steps\.a\.gates\[0\]\.command holds a known secret, and a gate is stored and run as written/);
    expect(problem(gate('x'.repeat(4097)))).toBe('steps.a.gates[0].command is 4097 bytes; a gate command may be at most 4096');
    expect(problem(gate('true', '601'))).toBe("steps.a.gates[0].command has a timeout of 601 s; a gate's timeout is a whole number of seconds, from 1 to 600");
    const many = Array.from({ length: 21 }, () => '      - { command: "true", timeout_s: 1 }').join('\n');
    expect(problem(oneStep(`    gates:\n${many}\n`))).toBe('steps.a has 21 gates; a task may have at most 20');
    expect(problem(oneStep('    gates:\n      - { command: one, timeout_s: 301 }\n      - { command: two, timeout_s: 300 }\n'))).toBe(
      'steps.a has gates that would take up to 601 s together; at most 600 s, since a report waits for them',
    );
    expect(problem(oneStep('    gates:\n      - { command: one }\n      - { command: two }\n      - { command: three }\n'))).toBe(
      'steps.a has gates that would take up to 900 s together; at most 600 s, since a report waits for them',
    );
  });
});

describe('the workspaces a step\'s parents work in', () => {
  const fan = (child: string, second = 'assignee: api-dev') =>
    `steps:\n  web: { title: Web, assignee: web-dev }\n  api: { title: API, ${second} }\n  join: { title: Join, parents: [web, api]${child} }\n`;

  it('refuses a step whose parents certainly disagree and which names none, nor does its role', () => {
    expect(problem(fan(', assignee: worker'))).toBe(
      'steps.join has parents in different workspaces, web and api, and names no workspace, nor does its role: ' +
        'its tasks could not be given one at their claim; set steps.join.workspace',
    );
    expect(problem(fan(''))).toMatch(/^steps\.join has parents in different workspaces/);
    expect(problem(fan(', assignee: worker, workspace: web'))).toBeUndefined();
    expect(problem(fan(', assignee: web-dev'))).toBeUndefined();
  });

  it('does not judge a parent whose workspace is decided later, or a step whose role comes from a param', () => {
    expect(problem(fan(', assignee: worker', 'assignee: worker'))).toBeUndefined();
    expect(problem(fan(', assignee: worker', 'assignee: worker, workspace: "{{where}}"').replace('steps:', 'params:\n  where: { default: api }\nsteps:'))).toBeUndefined();
    expect(problem(fan(', assignee: "{{who}}"').replace('steps:', 'params:\n  who: { default: worker }\nsteps:'))).toBeUndefined();
  });
});

describe('the directory', () => {
  it('lists the usable workflows and the broken ones, ignoring a badly named file, a symlink and a dot-entry with one note each', () => {
    const wf = join(dir, 'workflows');
    mkdirSync(wf);
    writeFileSync(join(wf, 'vendor-eval.yaml'), VENDOR_EVAL);
    writeFileSync(join(wf, 'onboarding.yaml'), 'steps:\n  welcome:\n    title: Welcome\n    gates:\n      - command: "echo {{name}}"\n');
    writeFileSync(join(wf, 'Bad_Name.yaml'), VENDOR_EVAL);
    writeFileSync(join(wf, 'notes.txt'), 'x');
    writeFileSync(join(wf, '.hidden.yaml'), VENDOR_EVAL);
    mkdirSync(join(wf, 'dir.yaml'));
    symlinkSync(join(wf, 'vendor-eval.yaml'), join(wf, 'linked.yaml'));
    const list = listWorkflows(wf, FACTS);
    expect(list.usable.map((w) => w.name)).toEqual(['vendor-eval']);
    expect(list.broken).toEqual([
      { name: 'onboarding', problem: 'steps.welcome.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead' },
    ]);
    expect(list.ignored).toEqual([
      `ignoring ${join(wf, '.hidden.yaml')}: a dot-entry, so not a workflow`,
      expect.stringMatching(new RegExp(`^ignoring ${join(wf, 'Bad_Name.yaml')}: workflow name "Bad_Name" must be lowercase letters`)),
      `ignoring ${join(wf, 'dir.yaml')}: not a regular file, so not a workflow`,
      `ignoring ${join(wf, 'linked.yaml')}: a symlink, which is not followed: a workflow is a file of its own in the home`,
      `ignoring ${join(wf, 'notes.txt')}: not a .yaml file, so not a workflow`,
    ]);
    expect(workflowLines(list)).toEqual([
      'workflow onboarding is not usable: steps.welcome.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead',
      ...list.ignored,
      'workflows: vendor-eval; not usable: onboarding',
    ]);
  });

  it('says workflows: none for a directory that is missing or empty', () => {
    expect(workflowLines(listWorkflows(join(dir, 'missing'), FACTS))).toEqual(['workflows: none']);
    mkdirSync(join(dir, 'empty'));
    expect(workflowLines(listWorkflows(join(dir, 'empty'), FACTS))).toEqual(['workflows: none']);
  });

  it('refuses a file past 64 KiB', () => {
    writeFileSync(join(dir, 'big.yaml'), `${VENDOR_EVAL}# ${'x'.repeat(64 * 1024)}\n`);
    expect(listWorkflows(dir, FACTS).broken).toEqual([{ name: 'big', problem: expect.stringMatching(/^the file is \d+ bytes; a workflow is at most 65536$/) }]);
  });

  it('reads one workflow by name: unknown_workflow for no usable file, invalid for a broken one', () => {
    writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
    writeFileSync(join(dir, 'broken.yaml'), 'steps: {}\n');
    symlinkSync(join(dir, 'vendor-eval.yaml'), join(dir, 'linked.yaml'));
    expect(readWorkflow(dir, 'vendor-eval', FACTS)).toMatchObject({ ok: true, workflow: { name: 'vendor-eval' } });
    expect(readWorkflow(dir, 'missing', FACTS)).toEqual({ ok: false, code: 'unknown_workflow', message: 'there is no workflow missing' });
    expect(readWorkflow(dir, '../roles', FACTS)).toEqual({ ok: false, code: 'unknown_workflow', message: 'there is no workflow "../roles"' });
    expect(readWorkflow(dir, 'linked', FACTS)).toMatchObject({ ok: false, code: 'unknown_workflow', message: expect.stringMatching(/is a symlink/) });
    expect(readWorkflow(dir, 'broken', FACTS)).toEqual({ ok: false, code: 'invalid', message: 'workflow broken is not usable: the file needs steps, at least one' });
  });
});
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-file.test.ts`. Expected: `Tests  no tests`: the file fails to load, `Error: Cannot find module '../src/kanban/workflow.js' imported from '<worktree>/tests/kanban-workflow-file.test.ts'`.

- [ ] **Step 7.3: Implement.**

Create `src/kanban/workflow.ts`:

```ts
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError, reject, section } from '../config.js';
import { NAME_PATTERN, nameProblem, visible } from '../names.js';
import type { Role } from '../roles.js';
import { gateProblem, gatesProblem } from './gate-command.js';
import { assignable, isRecord, type TaskFacts } from './task-checks.js';
import { GATE_LIMITS, type Contract, type Refusal, type Result, type RetryOnCrash } from './types.js';

export { checkDagShape, readDag } from './dag.js';

/**
 * Workflows (spec §21): a graph of tasks written once, in a YAML file under
 * `$MT_HOME/workflows`, and started many times. This module reads a file and
 * checks it (spec §21.1 to §21.4), expands it with its params into a DAG (spec
 * §21.5), and derives an instance's status (spec §21.10). Pure but for reading
 * the directory: the service, `mt workflow check` and the startup check all
 * call it, so a file is judged the same way everywhere. Nothing in the kernel
 * knows about workflows (spec §1).
 */

export const WORKFLOW_LIMITS = {
  /** A workflow file's size, in bytes. */
  fileBytes: 64 * 1024,
} as const;

/** A param (spec §21.2): text, or a list with `list: true`; required, or with a default. */
export interface WorkflowParam {
  name: string;
  list: boolean;
  required: boolean;
  default: string | string[] | undefined;
  description: string | undefined;
}

/** A name field as written: a name, or one whole reference, `{{name}}`; with `{ role }` or `{ person }`, which it must be. */
export interface NameSpec {
  value: string;
  must: 'role' | 'person' | undefined;
}

export interface WorkflowGate {
  command: string;
  /** As written, or the default, 300 s, as `addGate` stores one with none. */
  timeoutS: number;
}

/** A step (spec §21.1): `KanbanService.create`'s fields, `addGate`'s gates, `parents` and `for_each`. */
export interface WorkflowStep {
  name: string;
  title: string;
  body: string | undefined;
  assignee: NameSpec | undefined;
  reviewer: NameSpec | undefined;
  workspace: string | undefined;
  priority: number | undefined;
  /** As written, before substitution: `verify` is `verification`. */
  contract: Contract;
  failureLimit: number | undefined;
  retryOnCrash: RetryOnCrash | undefined;
  maxRuntimeS: number | undefined;
  gates: WorkflowGate[];
  parents: string[];
  forEach: string | undefined;
}

export interface Workflow {
  name: string;
  description: string | undefined;
  params: WorkflowParam[];
  /** In the file's order, which is the order their tasks are made in, and `show` lists them in. */
  steps: WorkflowStep[];
}

/** What a file is checked against: the team. A person is checked at a start, where talk tier is known. */
export type WorkflowFacts = Pick<TaskFacts, 'roles' | 'workspaces' | 'supervisedRoles'>;

/** A workflow file that is not usable, and why. */
export interface BrokenWorkflow {
  name: string;
  problem: string;
}

/** The directory, as read now: the usable workflows, the broken ones, and the entries that are no workflow. */
export interface WorkflowList {
  usable: Workflow[];
  broken: BrokenWorkflow[];
  ignored: string[];
}

/** The fields of a step's text, where `{{name}}` is substituted, and the contract field each fills. */
const TEXT_FIELDS = {
  title: undefined,
  body: undefined,
  outcome: 'outcome',
  verify: 'verification',
  constraints: 'constraints',
  boundaries: 'boundaries',
  stop_when: 'stop_when',
} as const;

const STEP_KEYS = [
  'title',
  'body',
  'assignee',
  'reviewer',
  'workspace',
  'priority',
  'outcome',
  'verify',
  'constraints',
  'boundaries',
  'stop_when',
  'failure_limit',
  'retry_on_crash',
  'max_runtime_s',
  'gates',
  'parents',
  'for_each',
] as const;

/** The for_each item's name, which no param may take (spec §21.1). */
export const ITEM = 'item';

/** `reject`'s hints, for a key that looks like a credential, or `env`. */
const HINTS = {
  secret: "A workflow holds no credential: a gate names one as $NAME, from the role's environment.",
  env: "A gate takes a value from the role's environment, as $NAME, and a workflow sets none.",
};

/** A reference: `{{name}}`, a name in the grammar, with no spaces. */
const REFERENCE = /^\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/;

/** A file's problem, thrown inside the check and caught as its result. */
class Problem extends Error {}

function fail(message: string): never {
  throw new Problem(message);
}

/** A name a problem quotes: as JSON, its invisible characters shown. */
function q(text: string): string {
  return visible(JSON.stringify(text.length <= 80 ? text : `${text.slice(0, 80)}…`));
}

/** Text, or a problem saying so; a mapping where text belongs says to quote a `{{`. */
function text(value: unknown, place: string): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    fail(`${place} is a mapping, where text belongs: a value that starts with {{ must be quoted, as "{{name}}"`);
  }
  return fail(`${place} is text`);
}

function optionalText(value: unknown, place: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, place);
}

function whole(value: unknown, place: string, min: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    return fail(min === Number.MIN_SAFE_INTEGER ? `${place} is a whole number` : `${place} is a whole number, at least ${min}`);
  }
  return value as number;
}

/** A name field: text, or `{ role: … }` or `{ person: … }`. */
function nameSpec(value: unknown, place: string, path: string): NameSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return { value, must: undefined };
  // An unquoted `{{owner}}` is read as a mapping whose key is another: say to quote it.
  if (isRecord(value) && Object.keys(value).some((key) => key.startsWith('{'))) text(value, place);
  const map = section(path, place, value);
  reject(path, place, map, ['role', 'person'], HINTS);
  const keys = Object.keys(map);
  if (keys.length !== 1) fail(`${place} is a name, or one of { role: … } and { person: … }`);
  const must = keys[0] as 'role' | 'person';
  return { value: text(map[must], `${place}.${must}`), must };
}

/** Each `{{` in a text field opens a reference to a declared param, or to `item` in a for_each step (spec §21.2). */
function references(value: string, place: string, params: ReadonlyMap<string, WorkflowParam>, forEach: boolean): void {
  for (let at = value.indexOf('{{'); at !== -1; at = value.indexOf('{{', at + 2)) {
    const m = REFERENCE.exec(value.slice(at));
    if (m === null) {
      fail(`${place} has a {{ that opens no reference: write {{name}}, a param's name with no spaces; a literal {{ cannot be written`);
    }
    const name = m[1] ?? '';
    if (name === ITEM) {
      if (!forEach) fail(`${place} uses {{item}}, which only a for_each step has`);
    } else if (!params.has(name)) {
      fail(`${place} names {{${name}}}, which is no param this file declares`);
    }
  }
}

/** The param a name field refers to, whole, or undefined for a name written out; a problem for anything between. */
function referenceOf(value: string, place: string): string | undefined {
  if (!value.includes('{{')) return undefined;
  const m = REFERENCE.exec(value);
  if (m === null || m[0] !== value) {
    fail(`${place} is a name, or one whole reference such as "{{name}}": a name is never put together from parts`);
  }
  return m[1];
}

/** A param from the file (spec §21.2). */
function paramOf(name: string, value: unknown, path: string): WorkflowParam {
  const place = `params.${name}`;
  const problem = nameProblem('param', name);
  if (problem !== undefined) fail(`${place}: ${problem}`);
  if (name === ITEM) fail(`${place}: item is the for_each item's name, and no param's`);
  const map = section(path, place, value ?? {});
  reject(path, place, map, ['list', 'required', 'default', 'description'], HINTS);
  for (const key of ['list', 'required'] as const) {
    if (map[key] !== undefined && typeof map[key] !== 'boolean') fail(`${place}.${key} is true or false`);
  }
  const list = map['list'] === true;
  const required = map['required'] === true;
  const raw = map['default'];
  let fallback: string | string[] | undefined;
  if (raw !== undefined && raw !== null) {
    if (list) {
      if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) fail(`${place}.default is a list of text, as the param is a list`);
      fallback = [...(raw as string[])];
    } else {
      fallback = text(raw, `${place}.default`);
    }
  }
  if (required && fallback !== undefined) fail(`${place} is required and has a default: say one or the other`);
  if (!required && fallback === undefined) {
    fail(`${place} is neither required nor given a default: a {{${name}}} left out would have no value`);
  }
  return { name, list, required, default: fallback, description: optionalText(map['description'], `${place}.description`) };
}

/** A step from the file (spec §21.1), its fields checked as `create` checks them. */
function stepOf(name: string, value: unknown, path: string): WorkflowStep {
  const place = `steps.${name}`;
  const problem = nameProblem('step', name);
  if (problem !== undefined) fail(`${place}: ${problem}`);
  const map = section(path, place, value ?? {});
  reject(path, place, map, STEP_KEYS, HINTS);
  if (map['title'] === undefined || map['title'] === null) fail(`${place} needs a title`);
  const contract: Contract = {};
  for (const [key, field] of Object.entries(TEXT_FIELDS)) {
    if (field === undefined) continue;
    const v = optionalText(map[key], `${place}.${key}`);
    if (v !== undefined) contract[field] = v;
  }
  const retry = map['retry_on_crash'];
  if (retry !== undefined && retry !== null && retry !== 'always' && retry !== 'if-no-side-effects') {
    fail(`${place}.retry_on_crash is always or if-no-side-effects`);
  }
  const gatesRaw = map['gates'] ?? [];
  if (!Array.isArray(gatesRaw)) fail(`${place}.gates is a list of { command, timeout_s }`);
  const gates = (gatesRaw as unknown[]).map((g, i): WorkflowGate => {
    const at = `${place}.gates[${i}]`;
    const gate = section(path, at, g);
    reject(path, at, gate, ['command', 'timeout_s'], HINTS);
    if (gate['command'] === undefined || gate['command'] === null) fail(`${at} needs a command`);
    const command = text(gate['command'], `${at}.command`);
    const timeoutS = gate['timeout_s'] === undefined || gate['timeout_s'] === null ? GATE_LIMITS.defaultTimeoutS : gate['timeout_s'];
    if (!Number.isSafeInteger(timeoutS)) fail(`${at}.timeout_s is a whole number of seconds`);
    return { command, timeoutS: timeoutS as number };
  });
  const parentsRaw = map['parents'] ?? [];
  if (!Array.isArray(parentsRaw) || !parentsRaw.every((p) => typeof p === 'string')) {
    fail(`${place}.parents is a list of step names`);
  }
  return {
    name,
    title: text(map['title'], `${place}.title`),
    body: optionalText(map['body'], `${place}.body`),
    assignee: nameSpec(map['assignee'], `${place}.assignee`, path),
    reviewer: nameSpec(map['reviewer'], `${place}.reviewer`, path),
    workspace: optionalText(map['workspace'], `${place}.workspace`),
    priority: whole(map['priority'], `${place}.priority`, Number.MIN_SAFE_INTEGER),
    contract,
    failureLimit: whole(map['failure_limit'], `${place}.failure_limit`, 1),
    retryOnCrash: retry === undefined || retry === null ? undefined : (retry as RetryOnCrash),
    maxRuntimeS: whole(map['max_runtime_s'], `${place}.max_runtime_s`, 1),
    gates,
    parents: [...(parentsRaw as string[])],
    forEach: optionalText(map['for_each'], `${place}.for_each`),
  };
}

/** A cycle among the steps, as `a -> b -> a`, or undefined: a walk of the parents (spec §21.4). */
function cycleOf(steps: readonly WorkflowStep[]): string | undefined {
  const parents = new Map(steps.map((s) => [s.name, s.parents]));
  const done = new Set<string>();
  const walk = (name: string, path: string[]): string | undefined => {
    const at = path.indexOf(name);
    if (at !== -1) return [...path.slice(at), name].join(' -> ');
    if (done.has(name)) return undefined;
    for (const parent of parents.get(name) ?? []) {
      const found = walk(parent, [...path, name]);
      if (found !== undefined) return found;
    }
    done.add(name);
    return undefined;
  };
  for (const s of steps) {
    const found = walk(s.name, []);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The workspace a step's tasks certainly work in, before any claim: its own, written out, or its role's (spec §2.3). */
function certainOf(step: WorkflowStep, roles: ReadonlyMap<string, Role>): string | undefined {
  if (step.workspace !== undefined) return step.workspace.includes('{{') ? undefined : step.workspace;
  const who = step.assignee;
  if (who === undefined || who.value.includes('{{') || who.value.includes(':')) return undefined;
  return roles.get(who.value)?.workspace;
}

/** Whether a step's own workspace is decided only at its claim: none of its own, written or a reference, and none from its role. */
function judgeable(step: WorkflowStep, roles: ReadonlyMap<string, Role>): boolean {
  if (step.workspace !== undefined) return false;
  const who = step.assignee;
  if (who !== undefined && who.value.includes('{{')) return false;
  if (who === undefined || who.value.includes(':')) return true;
  return roles.get(who.value)?.workspace === undefined;
}

/** A name field's checks: a reference to a text param or the item, or a name written out that `create` would take. */
function checkName(
  spec: NameSpec | undefined,
  place: string,
  params: ReadonlyMap<string, WorkflowParam>,
  forEach: boolean,
  facts: WorkflowFacts,
  kind: 'person' | 'workspace',
): void {
  if (spec === undefined) return;
  const where = spec.must === undefined ? place : `${place}.${spec.must}`;
  const ref = referenceOf(spec.value, where);
  if (ref !== undefined) {
    if (ref === ITEM) {
      if (!forEach) fail(`${where} uses {{item}}, which only a for_each step has`);
      return;
    }
    const param = params.get(ref);
    if (param === undefined) fail(`${where} names {{${ref}}}, which is no param this file declares`);
    if (param.list) fail(`${where} names {{${ref}}}, a list param: a name field takes one name, so a text param or {{item}}`);
    return;
  }
  const value = spec.value;
  if (kind === 'workspace') {
    if (!facts.workspaces.has(value)) fail(`${where}: workspace ${q(value)} is not configured`);
    return;
  }
  if (value.includes(':')) {
    if (spec.must === 'role') fail(`${where} is a role's place, and ${q(value)} is a person`);
    // A person written out is checked at a start, where talk tier is known.
    const r = assignable(value, { ...facts, canTalk: () => true });
    if (!r.ok) fail(`${where}: ${r.message}`);
    return;
  }
  if (spec.must === 'person') fail(`${where} is a person's place, and ${q(value)} is a role's name`);
  const r = assignable(value, facts);
  if (!r.ok) fail(`${where}: ${r.message}`);
}

/** The checks of the file alone and the team (spec §21.4), on what `stepOf` and `paramOf` read. */
function checkWhole(steps: readonly WorkflowStep[], params: ReadonlyMap<string, WorkflowParam>, facts: WorkflowFacts): void {
  const names = new Set(steps.map((s) => s.name));
  for (const s of steps) {
    const place = `steps.${s.name}`;
    for (const parent of s.parents) {
      if (parent === s.name) fail(`${place}.parents names the step itself`);
      if (!names.has(parent)) fail(`${place}.parents names ${q(parent)}, which is no step of this file`);
      if (s.parents.indexOf(parent) !== s.parents.lastIndexOf(parent)) fail(`${place}.parents names ${parent} twice`);
    }
  }
  const cycle = cycleOf(steps);
  if (cycle !== undefined) fail(`the steps' parents make a cycle: ${cycle}`);
  const seen = new Set<string>();
  for (const s of steps) {
    const place = `steps.${s.name}`;
    // The tasks are made in the file's order, so a parent is written above its child (spec §21.5).
    const later = s.parents.find((p) => !seen.has(p));
    if (later !== undefined) fail(`${place}.parents names ${later}, which is written after it: write a step below its parents`);
    seen.add(s.name);
    if (s.forEach !== undefined) {
      const param = params.get(s.forEach);
      if (param === undefined) fail(`${place}.for_each names ${q(s.forEach)}, which is no param this file declares`);
      if (!param.list) fail(`${place}.for_each names ${s.forEach}, a text param: for_each takes a list param`);
    }
    const forEach = s.forEach !== undefined;
    references(s.title, `${place}.title`, params, forEach);
    if (s.body !== undefined) references(s.body, `${place}.body`, params, forEach);
    for (const [key, field] of Object.entries(TEXT_FIELDS)) {
      const v = field === undefined ? undefined : s.contract[field];
      if (v !== undefined) references(v, `${place}.${key}`, params, forEach);
    }
    checkName(s.assignee, `${place}.assignee`, params, forEach, facts, 'person');
    checkName(s.reviewer, `${place}.reviewer`, params, forEach, facts, 'person');
    checkName(s.workspace === undefined ? undefined : { value: s.workspace, must: undefined }, `${place}.workspace`, params, forEach, facts, 'workspace');
    for (const [i, gate] of s.gates.entries()) {
      const at = `${place}.gates[${i}].command`;
      // Never a param in a gate (spec §21.2): it would let whoever starts a workflow write shell.
      if (gate.command.includes('{{')) fail(`${at} holds {{, and a gate is a shell command: name the value as an environment variable instead`);
      const problem = gateProblem(gate);
      if (problem !== undefined) fail(`${at} ${problem}`);
    }
    const together = gatesProblem(s.gates);
    if (together !== undefined) fail(`${place} ${together}`);
    if (judgeable(s, facts.roles)) {
      const theirs = [...new Set(s.parents.map((p) => steps.find((x) => x.name === p)).flatMap((p) => (p === undefined ? [] : [certainOf(p, facts.roles)])))].filter(
        (w): w is string => w !== undefined,
      );
      if (theirs.length > 1) {
        fail(
          `${place} has parents in different workspaces, ${theirs.join(' and ')}, and names no workspace, nor does its role: ` +
            `its tasks could not be given one at their claim; set ${place}.workspace`,
        );
      }
    }
  }
}

/**
 * A workflow file's checks (spec §21.4), from its text and the team: the YAML,
 * the keys and their types at every level, the names, the parents, for_each,
 * every reference, the roles and workspaces written out, the gates, and a step
 * whose parents certainly disagree on a workspace. The first problem, by its
 * place, or the workflow.
 */
export function checkWorkflow(name: string, source: string, facts: WorkflowFacts): { ok: true; workflow: Workflow } | { ok: false; problem: string } {
  // section and reject name the file; a problem names its place in it instead.
  const path = `${name}.yaml`;
  try {
    let parsed: unknown;
    try {
      parsed = parseYaml(source, { logLevel: 'error' });
    } catch (err) {
      // Its first line: the parser's message goes on to quote the file.
      fail(`the YAML does not parse: ${(err as Error).message.split('\n')[0] ?? ''}`);
    }
    const root = section(path, '', parsed ?? {});
    reject(path, '', root, ['description', 'params', 'steps'], HINTS);
    const description = optionalText(root['description'], 'description');
    const paramsMap = root['params'] === undefined || root['params'] === null ? {} : section(path, 'params', root['params']);
    const params = Object.entries(paramsMap).map(([n, v]) => paramOf(n, v, path));
    if (root['steps'] === undefined || root['steps'] === null) fail('the file needs steps, at least one');
    const stepsMap = section(path, 'steps', root['steps']);
    const steps = Object.entries(stepsMap).map(([n, v]) => stepOf(n, v, path));
    if (steps.length === 0) fail('the file needs steps, at least one');
    checkWhole(steps, new Map(params.map((p) => [p.name, p])), facts);
    return { ok: true, workflow: { name, description, params, steps } };
  } catch (err) {
    if (err instanceof Problem) return { ok: false, problem: err.message };
    if (err instanceof ConfigError) {
      const prefix = `${path}: `;
      return { ok: false, problem: err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message };
    }
    throw err;
  }
}

/** Why an entry of the directory is no workflow, or undefined for one that is: a regular `<name>.yaml`, the name in the grammar. */
function notAWorkflow(dir: string, entry: string): string | undefined {
  if (entry.startsWith('.')) return 'a dot-entry, so not a workflow';
  if (!entry.endsWith('.yaml')) return 'not a .yaml file, so not a workflow';
  const stat = lstatSync(join(dir, entry), { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() === true) return 'a symlink, which is not followed: a workflow is a file of its own in the home';
  if (stat?.isFile() !== true) return 'not a regular file, so not a workflow';
  return nameProblem('workflow', entry.slice(0, -'.yaml'.length));
}

/** A file's text, or why it cannot be a workflow: past 64 KiB. */
function readFile(path: string): { ok: true; text: string } | { ok: false; problem: string } {
  const size = lstatSync(path).size;
  if (size > WORKFLOW_LIMITS.fileBytes) return { ok: false, problem: `the file is ${size} bytes; a workflow is at most ${WORKFLOW_LIMITS.fileBytes}` };
  return { ok: true, text: readFileSync(path, 'utf8') };
}

/**
 * The directory, read now (spec §21.4): every usable workflow, by name, each
 * broken one with why, and every entry that is no workflow, said once. A
 * missing directory has none.
 */
export function listWorkflows(dir: string, facts: WorkflowFacts): WorkflowList {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { usable: [], broken: [], ignored: [] };
    throw new ConfigError(`cannot read ${dir}: ${(err as Error).message}`);
  }
  const out: WorkflowList = { usable: [], broken: [], ignored: [] };
  for (const entry of entries) {
    const why = notAWorkflow(dir, entry);
    if (why !== undefined) {
      out.ignored.push(`ignoring ${join(dir, entry)}: ${why}`);
      continue;
    }
    const name = entry.slice(0, -'.yaml'.length);
    const read = readFile(join(dir, entry));
    const checked = read.ok ? checkWorkflow(name, read.text, facts) : read;
    if (checked.ok) out.usable.push(checked.workflow);
    else out.broken.push({ name, problem: checked.problem });
  }
  return out;
}

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

/**
 * One workflow, read and checked now (spec §21.4): `unknown_workflow` for a name
 * with no usable file of its own, `invalid` for a file that is broken.
 */
export function readWorkflow(dir: string, name: string, facts: WorkflowFacts): Result<{ workflow: Workflow }> {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return refuse('unknown_workflow', `there is no workflow ${q(String(name))}`);
  const entry = `${name}.yaml`;
  const stat = lstatSync(join(dir, entry), { throwIfNoEntry: false });
  if (stat === undefined) return refuse('unknown_workflow', `there is no workflow ${name}`);
  const why = notAWorkflow(dir, entry);
  if (why !== undefined) return refuse('unknown_workflow', `there is no workflow ${name}: ${join(dir, entry)} is ${why}`);
  const read = readFile(join(dir, entry));
  const checked = read.ok ? checkWorkflow(name, read.text, facts) : read;
  if (!checked.ok) return refuse('invalid', `workflow ${name} is not usable: ${checked.problem}`);
  return { ok: true, workflow: checked.workflow };
}

/** A workflow's params, as `list` and `mt workflow check` say them: `topic (required), vendors (list, required), reviewer (default reviewer)`. */
export function paramsLine(w: Workflow): string {
  if (w.params.length === 0) return 'none';
  return w.params
    .map((p) => {
      const how = [
        ...(p.list ? ['list'] : []),
        p.required ? 'required' : `default ${Array.isArray(p.default) ? p.default.join(', ') : (p.default ?? '')}`,
      ];
      return `${p.name} (${how.join(', ')})`;
    })
    .join(', ');
}

/**
 * The startup's lines (spec §21.4): one a broken workflow, one an entry that is
 * no workflow, then `workflows: <usable>; not usable: <broken>`, or
 * `workflows: none` for a missing or empty directory. Notes, which the gateway
 * masks: a broken workflow does not stop it.
 */
export function workflowLines(list: WorkflowList): string[] {
  const usable = list.usable.map((w) => w.name);
  const broken = list.broken.map((b) => b.name);
  return [
    ...list.broken.map((b) => `workflow ${b.name} is not usable: ${b.problem}`),
    ...list.ignored,
    `workflows: ${usable.length === 0 ? 'none' : usable.join(', ')}${broken.length === 0 ? '' : `; not usable: ${broken.join(', ')}`}`,
  ];
}
```

In `src/names.ts`, replace:

```ts
/** Why `name` is not a valid role, workspace or board name, or undefined if it is. */
export function nameProblem(kind: 'role' | 'workspace' | 'board', name: string): string | undefined {
```

with:

```ts
/**
 * Why `name` is not a valid role, workspace or board name, or undefined if it is.
 * A workflow, and its steps and params, are named in the same grammar (spec §21.1).
 */
export function nameProblem(kind: 'role' | 'workspace' | 'board' | 'workflow' | 'step' | 'param', name: string): string | undefined {
```

- [ ] **Step 7.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2069 passed (2069)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.5: Commit.**

```bash
git add src/kanban/workflow.ts src/names.ts tests/helpers/workflow.ts tests/kanban-workflow-file.test.ts
git commit -m "Read and check a workflow file: the YAML, the keys at every level, the names, the params, the parents, for_each, every reference, the roles and workspaces written out, the gates, and a step whose parents certainly disagree on a workspace"
```

---

### Task 8: Params, substitution and the expansion

**Files:**

- Create: `tests/kanban-workflow-expand.test.ts`
- Modify: `src/kanban/workflow.ts`

Spec §21.2, §21.3, §21.5, §21.6. `paramValues(w, given, personOf)` reads each path's params against the file: chat's pairs, a quoted value one item and an unquoted one split at its commas; the terminal's, split at every comma; a run's JSON, a string or a list of strings, the other type refused. Every param declared, the required ones given, the defaults filled in, a text param given once, a list's items trimmed, none empty, twice or holding a known secret, an empty list refused, a value of at most 8 KiB, a list of at most 100 items, the params at most 64 KiB as JSON, a value landing in a title on one line, and a value starting with `@` resolved by `personOf` only for a param that lands in a person field, `"{{owner}}"` or `{ person: "{{owner}}" }`. `expand(w, given, board, personOf)` makes the DAG: one task a step, or one an item for a for_each step, `<step>:<n>`; every text field substituted once, a value put in as written; a name field's value checked as a name, a role's place refusing a person and a person's place a role's name; parents all to all; at most 100 tasks. Every key is written out, as spec §21.5 asks of an expanded DAG.

- [ ] **Step 8.1: Write the tests.**

Create `tests/kanban-workflow-expand.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalDag, checkDagShape, type Dag } from '../src/kanban/dag.js';
import type { Result } from '../src/kanban/types.js';
import { checkWorkflow, expand, paramValues, type GivenParams, type Workflow, type WorkflowFacts } from '../src/kanban/workflow.js';
import type { Role } from '../src/roles.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { role } from './helpers/dispatch.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A workflow's params and its expansion into a DAG (spec §21.2, §21.3, §21.5):
 * each path's params, the defaults, the sizes, substitution once in every text
 * field, names checked as names, @ resolved only for a person field, for_each,
 * all to all, and the hundred tasks.
 */

const ROLES: ReadonlyMap<string, Role> = new Map([
  ['worker', role('worker')],
  ['reviewer', role('reviewer')],
]);
const FACTS: WorkflowFacts = { roles: ROLES, workspaces: new Set(['default', 'web']), supervisedRoles: false };
const SECRET = 'sk-live-1234567890';

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
});
afterEach(() => clearSecrets());

function workflow(text: string, name = 'test'): Workflow {
  const r = checkWorkflow(name, text, FACTS);
  if (!r.ok) throw new Error(r.problem);
  return r.workflow;
}

const vendorEval = (): Workflow => workflow(VENDOR_EVAL, 'vendor-eval');
const json = (params: unknown): GivenParams => ({ from: 'json', params });
const chat = (...pairs: Array<[string, string, boolean?]>): GivenParams => ({
  from: 'chat',
  pairs: pairs.map(([key, value, quoted]) => ({ key, value, quoted: quoted === true })),
});
const terminal = (...pairs: Array<[string, string]>): GivenParams => ({ from: 'terminal', pairs: pairs.map(([key, value]) => ({ key, value })) });

function dagOf(r: Result<{ dag: Dag }>): Dag {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.dag;
}

const refusal = (r: Result<object>): { code: string; message: string } | undefined => (r.ok ? undefined : { code: r.code, message: r.message });

describe('the expansion of the example', () => {
  it('makes the DAG of the spec, every key written, its params with their default', () => {
    const dag = dagOf(expand(vendorEval(), json({ topic: 'log storage', vendors: ['acme', 'globex'] }), 'research'));
    expect(dag).toEqual({
      format: 1,
      workflow: 'vendor-eval',
      params: { topic: 'log storage', vendors: ['acme', 'globex'], reviewer: 'reviewer' },
      board: 'research',
      tasks: [
        {
          ref: 'shortlist',
          step: 'shortlist',
          item: null,
          title: 'Shortlist vendors for log storage',
          body: null,
          assignee: 'worker',
          reviewer: null,
          workspace: null,
          priority: 0,
          contract: { outcome: 'a shortlist with one line per vendor' },
          failure_limit: null,
          retry_on_crash: 'always',
          max_runtime_s: null,
          parents: [],
          gates: [],
        },
        expect.objectContaining({ ref: 'evaluate:1', step: 'evaluate', item: 'acme', title: 'Evaluate acme for log storage', parents: ['shortlist'], gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }] }),
        expect.objectContaining({ ref: 'evaluate:2', step: 'evaluate', item: 'globex', title: 'Evaluate globex for log storage', parents: ['shortlist'] }),
        expect.objectContaining({
          ref: 'recommend',
          item: null,
          reviewer: 'reviewer',
          parents: ['evaluate:1', 'evaluate:2'],
          contract: { verification: "every score comes from a parent's summary" },
        }),
      ],
    });
    expect(checkDagShape(dag, 'expansion').ok).toBe(true);
  });

  it('writes a DAG whose canonical form is the same twice', () => {
    const once = dagOf(expand(vendorEval(), json({ topic: 'x', vendors: ['a'] }), 'default'));
    const twice = dagOf(expand(vendorEval(), json({ vendors: ['a'], topic: 'x' }), 'default'));
    expect(canonicalDag(twice)).toBe(canonicalDag(once));
  });
});

describe('the params', () => {
  it('refuses a missing required one, an unknown one, and fills in a default', () => {
    expect(refusal(expand(vendorEval(), json({ vendors: ['a'] }), 'default'))).toEqual({
      code: 'invalid',
      message: 'workflow vendor-eval needs param topic: what is being bought',
    });
    expect(refusal(expand(vendorEval(), json({ topic: 'x', vendors: ['a'], topik: 'y' }), 'default'))).toEqual({
      code: 'invalid',
      message: 'workflow vendor-eval takes no param "topik" (it takes topic, vendors, reviewer)',
    });
    expect(dagOf(expand(vendorEval(), json({ topic: 'x', vendors: ['a'], reviewer: 'worker' }), 'default')).tasks.at(-1)?.reviewer).toBe('worker');
  });

  it("refuses a run's JSON of the wrong type", () => {
    expect(refusal(expand(vendorEval(), json({ topic: ['x'], vendors: ['a'] }), 'default'))?.message).toBe('param topic is text: give it as text');
    expect(refusal(expand(vendorEval(), json({ topic: 'x', vendors: 'a, b' }), 'default'))?.message).toBe('param vendors is a list: give a list of text');
    expect(refusal(expand(vendorEval(), json(['x']), 'default'))?.message).toBe('params is an object of text and lists of text');
  });

  it('reads chat\'s pairs: a list by commas and by repeating, a quoted value as one item, a text param once', () => {
    const w = vendorEval();
    expect(dagOf(expand(w, chat(['topic', 'x'], ['vendors', 'acme, globex'], ['vendors', 'initech']), 'default')).params['vendors']).toEqual([
      'acme',
      'globex',
      'initech',
    ]);
    expect(dagOf(expand(w, chat(['topic', 'x'], ['vendors', 'Acme, Inc', true], ['vendors', 'globex']), 'default')).params['vendors']).toEqual([
      'Acme, Inc',
      'globex',
    ]);
    expect(refusal(expand(w, chat(['topic', 'x'], ['topic', 'y'], ['vendors', 'a']), 'default'))?.message).toBe('param topic is given twice; it takes one value');
  });

  it("splits the terminal's list at every comma, and adds a repeated key's items", () => {
    const dag = dagOf(expand(vendorEval(), terminal(['topic', 'a, b'], ['vendors', 'acme,globex'], ['vendors', 'initech']), 'default'));
    expect(dag.params).toMatchObject({ topic: 'a, b', vendors: ['acme', 'globex', 'initech'] });
  });

  it('refuses an empty list, an empty item, an item twice, and an item holding a known secret', () => {
    const w = vendorEval();
    expect(refusal(expand(w, json({ topic: 'x', vendors: [] }), 'default'))?.message).toBe(
      'param vendors is an empty list, and a step over it would make no tasks',
    );
    expect(refusal(expand(w, chat(['topic', 'x'], ['vendors', 'acme,,globex']), 'default'))?.message).toBe('param vendors has an empty item');
    expect(refusal(expand(w, chat(['topic', 'x'], ['vendors', 'acme, acme ']), 'default'))?.message).toBe(
      'param vendors names "acme" twice; each item labels its task',
    );
    expect(refusal(expand(w, json({ topic: 'x', vendors: [`acme ${SECRET}`] }), 'default'))?.message).toBe('an item of param vendors holds a known secret');
  });

  it('holds a value to 8 KiB, a list to 100 items, and the params to 64 KiB together', () => {
    const w = vendorEval();
    expect(refusal(expand(w, json({ topic: 'x'.repeat(8193), vendors: ['a'] }), 'default'))).toEqual({
      code: 'too_large',
      message: 'param topic is 8193 bytes; at most 8192',
    });
    expect(refusal(expand(w, json({ topic: 'x', vendors: Array.from({ length: 101 }, (_, i) => `v${i}`) }), 'default'))).toEqual({
      code: 'too_large',
      message: 'param vendors has 101 items; a list has at most 100',
    });
    expect(refusal(expand(w, json({ topic: 'x', vendors: ['y'.repeat(8193)] }), 'default'))).toEqual({
      code: 'too_large',
      message: 'an item of param vendors is 8193 bytes; at most 8192',
    });
    const wide = workflow(
      `params:\n${Array.from({ length: 9 }, (_, i) => `  p${i}: { required: true }`).join('\n')}\nsteps:\n  a: { title: A }\n`,
    );
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, 'z'.repeat(8000)]));
    expect(refusal(expand(wide, json(nine), 'default'))).toEqual({
      code: 'too_large',
      message: `the params are ${JSON.stringify(nine).length} bytes as JSON; at most 65536 together`,
    });
    for (const via of [chat(...Object.entries(nine).map(([k, v]): [string, string] => [k, v])), terminal(...Object.entries(nine))]) {
      expect(refusal(expand(wide, via, 'default'))?.code).toBe('too_large');
    }
  });

  it('refuses a line break, a control character or a bidi control in a value that lands in a title, and takes one in a body', () => {
    const w = vendorEval();
    for (const bad of ['two\nlines', 'tab\there', 'bell\u0007', 'flip\u202Eit']) {
      expect(refusal(expand(w, json({ topic: bad, vendors: ['a'] }), 'default'))).toEqual({
        code: 'invalid',
        message: 'param topic lands in a title, which is one line: it may hold no line break, control character or bidi control',
      });
    }
    expect(refusal(expand(w, json({ topic: 'x', vendors: ['two\nlines'] }), 'default'))?.message).toMatch(/^param vendors lands in a title/);
    const bodied = workflow('params:\n  notes: { required: true }\nsteps:\n  a: { title: A, body: "{{notes}}" }\n');
    expect(dagOf(expand(bodied, json({ notes: 'two\nlines' }), 'default')).tasks[0]?.body).toBe('two\nlines');
  });

  it('refuses a lone surrogate in a value', () => {
    expect(refusal(expand(vendorEval(), json(JSON.parse('{"topic": "x\\ud800", "vendors": ["a"]}')), 'default'))?.message).toBe(
      'param topic is not well formed text: a lone surrogate is no text',
    );
  });
});

describe('substitution', () => {
  const every = `params:
  topic: { required: true }
  vendors: { list: true, required: true }
steps:
  a:
    title: "T {{topic}}"
    body: "B {{topic}} among {{vendors}}"
    outcome: "O {{topic}}"
    verify: "V {{topic}}"
    constraints: "C {{topic}}"
    boundaries: "Bd {{topic}}"
    stop_when: "S {{topic}}"
`;

  it('fills every text field, a list joined by commas, once: a value holding {{ is left as written', () => {
    const dag = dagOf(expand(workflow(every), json({ topic: '{{vendors}}', vendors: ['acme', 'globex'] }), 'default'));
    expect(dag.tasks[0]).toMatchObject({
      title: 'T {{vendors}}',
      body: 'B {{vendors}} among acme, globex',
      contract: {
        outcome: 'O {{vendors}}',
        verification: 'V {{vendors}}',
        constraints: 'C {{vendors}}',
        boundaries: 'Bd {{vendors}}',
        stop_when: 'S {{vendors}}',
      },
    });
  });

  it('puts a name in a name field, checked as a name, and never a part of one', () => {
    const named = workflow(`params:
  who: { default: worker }
  where: { default: web }
steps:
  a: { title: A, assignee: "{{who}}", workspace: "{{where}}", reviewer: { role: "{{who}}" } }
`);
    expect(dagOf(expand(named, json({}), 'default')).tasks[0]).toMatchObject({ assignee: 'worker', reviewer: 'worker', workspace: 'web' });
    expect(refusal(expand(named, json({ who: 'Not A Role' }), 'default'))?.message).toMatch(
      /^param who fills steps\.a\.assignee, a role name, and "Not A Role" is none: role name/,
    );
    expect(refusal(expand(named, json({ where: '../etc' }), 'default'))?.message).toMatch(
      /^param where fills steps\.a\.workspace, a workspace name, and "\.\.\/etc" is none: workspace name/,
    );
    expect(refusal(expand(named, json({ who: 'lark:on_bob' }), 'default'))?.message).toBe(
      'param who fills steps.a.reviewer, a role\'s place, and "lark:on_bob" is a person',
    );
    expect(refusal(expand(named, json({ who: SECRET }), 'default'))?.message).toBe(
      'param who fills steps.a.assignee, and its value holds a known secret: a name is stored as written',
    );
    const person = workflow('params:\n  owner: { required: true }\nsteps:\n  a: { title: A, assignee: { person: "{{owner}}" } }\n');
    expect(refusal(expand(person, json({ owner: 'worker' }), 'default'))?.message).toBe(
      'param owner fills steps.a.assignee, a person\'s place, and "worker" is a role\'s name',
    );
  });

  it('resolves @ only for a param that lands in a person field, the principal in its text too, and keeps it elsewhere', () => {
    const w = workflow(`params:
  owner: { required: true }
  note: { required: true }
steps:
  a: { title: "For {{owner}}: {{note}}", assignee: "{{owner}}" }
`);
    const asked: string[] = [];
    const personOf = (value: string) => {
      asked.push(value);
      return value === '@Alice Smith' ? { ok: true as const, principal: 'lark:on_alice' } : { ok: false as const, code: 'invalid' as const, message: `${value} is not mentioned` };
    };
    const dag = dagOf(expand(w, chat(['owner', '@Alice Smith'], ['note', '@Alice Smith said so']), 'default', personOf));
    expect(asked).toEqual(['@Alice Smith']);
    expect(dag.tasks[0]).toMatchObject({ assignee: 'lark:on_alice', title: 'For lark:on_alice: @Alice Smith said so' });
    expect(refusal(expand(w, chat(['owner', '@Bob'], ['note', 'x']), 'default', personOf))).toEqual({ code: 'invalid', message: '@Bob is not mentioned' });
  });

  it('resolves @ in the items of a list a person field takes as {{item}}', () => {
    const w = workflow('params:\n  owners: { list: true, required: true }\nsteps:\n  a: { title: "Ask {{item}}", for_each: owners, assignee: "{{item}}" }\n');
    const personOf = (value: string) => ({ ok: true as const, principal: `lark:on_${value.slice(1).toLowerCase()}` });
    expect(dagOf(expand(w, chat(['owners', '@Ann,@Bo']), 'default', personOf)).tasks.map((t) => [t.item, t.assignee])).toEqual([
      ['lark:on_ann', 'lark:on_ann'],
      ['lark:on_bo', 'lark:on_bo'],
    ]);
  });
});

describe('for_each', () => {
  it('makes one task an item, in order, with a fan-in on every one of them', () => {
    const dag = dagOf(expand(vendorEval(), json({ topic: 'x', vendors: ['c', 'a', 'b'] }), 'default'));
    expect(dag.tasks.map((t) => [t.ref, t.item, t.parents])).toEqual([
      ['shortlist', null, []],
      ['evaluate:1', 'c', ['shortlist']],
      ['evaluate:2', 'a', ['shortlist']],
      ['evaluate:3', 'b', ['shortlist']],
      ['recommend', null, ['evaluate:1', 'evaluate:2', 'evaluate:3']],
    ]);
  });

  it('links two for_each steps over one list all to all', () => {
    const w = workflow(`params:
  vendors: { list: true, required: true }
steps:
  evaluate: { title: "Evaluate {{item}}", for_each: vendors }
  review: { title: "Review {{item}}", for_each: vendors, parents: [evaluate] }
`);
    const dag = dagOf(expand(w, json({ vendors: ['a', 'b'] }), 'default'));
    expect(dag.tasks.map((t) => [t.ref, t.parents])).toEqual([
      ['evaluate:1', []],
      ['evaluate:2', []],
      ['review:1', ['evaluate:1', 'evaluate:2']],
      ['review:2', ['evaluate:1', 'evaluate:2']],
    ]);
  });

  it('refuses a start that would make 101 tasks', () => {
    const w = workflow(`params:
  a: { list: true, required: true }
steps:
  one: { title: "One {{item}}", for_each: a }
  two: { title: "Two {{item}}", for_each: a }
`);
    const fifty = Array.from({ length: 50 }, (_, i) => `x${i}`);
    expect(dagOf(expand(w, json({ a: fifty }), 'default')).tasks).toHaveLength(100);
    const more = workflow(`params:
  a: { list: true, required: true }
steps:
  one: { title: "One {{item}}", for_each: a }
  two: { title: "Two {{item}}", for_each: a }
  three: { title: Three }
`);
    expect(refusal(expand(more, json({ a: fifty }), 'default'))).toEqual({
      code: 'invalid',
      message: 'workflow test would make 101 tasks with these params; an instance has at most 100',
    });
  });
});

describe('paramValues', () => {
  it('answers each param once, a list as its trimmed items', () => {
    const r = paramValues(vendorEval(), chat(['topic', ' x '], ['vendors', ' a , b ']));
    expect(r.ok && Object.fromEntries(r.values)).toEqual({ topic: ' x ', vendors: ['a', 'b'], reviewer: 'reviewer' });
  });
});
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-expand.test.ts`. Expected: `Tests  18 failed (18)`; the first failure: `TypeError: (0 , expand) is not a function`.

- [ ] **Step 8.3: Implement.**

In `src/kanban/workflow.ts`, replace:

```ts
import type { Role } from '../roles.js';
```

with:

```ts
import type { Role } from '../roles.js';
import { redactKnownSecrets } from '../secrets.js';
import { DAG_FORMAT, DAG_LIMITS, titleRefused, type Dag, type DagTask, type ParamValue } from './dag.js';
```

In `src/kanban/workflow.ts`, replace:

```ts
  ];
}
```

with:

```ts
  ];
}

// ---------------------------------------------------------------------------
// Params and the expansion (spec §21.2, §21.3, §21.5)
// ---------------------------------------------------------------------------

/** A pair as chat's parser reads it (spec §21.6): a quoted value is one item of a list, never split. */
export interface ParamPair {
  key: string;
  value: string;
  quoted: boolean;
}

/**
 * The params a start was given, as each path gives them (spec §21.6): chat's
 * pairs, the terminal's `--param key=value`, already unquoted by the shell, or
 * a run's JSON, where nothing is split.
 */
export type GivenParams =
  | { from: 'chat'; pairs: readonly ParamPair[] }
  | { from: 'terminal'; pairs: readonly { key: string; value: string }[] }
  | { from: 'json'; params: unknown };

/** How a value starting with `@`, in a param that lands in a person field, becomes a principal: chat's, by the message's mentions. */
export type PersonOf = (value: string) => Result<{ principal: string }>;

/** A name a param's refusal quotes: masked, as it is free text. */
function said(value: string): string {
  return q(redactKnownSecrets(value));
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** The params that land in a person field, as `"{{owner}}"` or `{ person: "{{owner}}" }`, and the list a person field's `{{item}}` comes from. */
function personParams(w: Workflow): Set<string> {
  const out = new Set<string>();
  for (const s of w.steps) {
    for (const spec of [s.assignee, s.reviewer]) {
      if (spec === undefined || spec.must === 'role') continue;
      const ref = REFERENCE.exec(spec.value)?.[1];
      if (ref === ITEM && s.forEach !== undefined) out.add(s.forEach);
      else if (ref !== undefined && ref !== ITEM) out.add(ref);
    }
  }
  return out;
}

/** The params whose values land in a title, by `{{name}}`, or by `{{item}}` in a for_each step. */
function titleParams(w: Workflow): Set<string> {
  const out = new Set<string>();
  for (const s of w.steps) {
    for (const m of s.title.matchAll(/\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/g)) {
      const name = m[1] ?? '';
      if (name === ITEM && s.forEach !== undefined) out.add(s.forEach);
      else if (name !== ITEM) out.add(name);
    }
  }
  return out;
}

/**
 * The params of a start, against the file (spec §21.2): every one declared,
 * the required ones given, the defaults filled in, a text param given once, a
 * list's items trimmed, none empty or twice or holding a known secret, the
 * sizes, a value landing in a title on one line, and `@` resolved only in a
 * param that lands in a person field. What a refusal says names the param.
 */
export function paramValues(w: Workflow, given: GivenParams, personOf?: PersonOf): Result<{ values: Map<string, ParamValue> }> {
  const declared = new Map(w.params.map((p) => [p.name, p]));
  const takes = w.params.length === 0 ? 'it takes none' : `it takes ${w.params.map((p) => p.name).join(', ')}`;
  const unknown = (key: string): Refusal => refuse('invalid', `workflow ${w.name} takes no param ${said(key)} (${takes})`);
  const raw = new Map<string, ParamValue>();
  if (given.from === 'json') {
    const params = given.params ?? {};
    if (!isRecord(params)) return refuse('invalid', 'params is an object of text and lists of text');
    for (const [key, value] of Object.entries(params)) {
      const p = declared.get(key);
      if (p === undefined) return unknown(key);
      if (p.list) {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return refuse('invalid', `param ${key} is a list: give a list of text`);
        raw.set(key, [...(value as string[])]);
      } else {
        if (typeof value !== 'string') return refuse('invalid', `param ${key} is text: give it as text`);
        raw.set(key, value);
      }
    }
  } else {
    for (const pair of given.pairs) {
      const p = declared.get(pair.key);
      if (p === undefined) return unknown(pair.key);
      const before = raw.get(pair.key);
      if (!p.list) {
        if (before !== undefined) return refuse('invalid', `param ${pair.key} is given twice; it takes one value`);
        raw.set(pair.key, pair.value);
        continue;
      }
      // A quoted value from chat is one item; anything else is split at its commas (spec §21.6).
      const items = given.from === 'chat' && (pair as ParamPair).quoted ? [pair.value] : pair.value.split(',');
      raw.set(pair.key, [...((before as string[] | undefined) ?? []), ...items]);
    }
  }
  const values = new Map<string, ParamValue>();
  const persons = personParams(w);
  const titled = titleParams(w);
  for (const p of w.params) {
    let value = raw.get(p.name) ?? p.default;
    if (value === undefined) return refuse('invalid', `workflow ${w.name} needs param ${p.name}${p.description === undefined ? '' : `: ${p.description}`}`);
    if (Array.isArray(value)) {
      if (value.length > DAG_LIMITS.listItems) return refuse('too_large', `param ${p.name} has ${value.length} items; a list has at most ${DAG_LIMITS.listItems}`);
      const items = value.map((v) => v.trim());
      if (items.length === 0) return refuse('invalid', `param ${p.name} is an empty list, and a step over it would make no tasks`);
      for (const [n, item] of items.entries()) {
        if (item === '') return refuse('invalid', `param ${p.name} has an empty item`);
        if (bytesOf(item) > DAG_LIMITS.valueBytes) return refuse('too_large', `an item of param ${p.name} is ${bytesOf(item)} bytes; at most ${DAG_LIMITS.valueBytes}`);
        if (items.indexOf(item) !== n) return refuse('invalid', `param ${p.name} names ${said(item)} twice; each item labels its task`);
        if (redactKnownSecrets(item) !== item) return refuse('invalid', `an item of param ${p.name} holds a known secret`);
      }
      value = items;
    } else if (bytesOf(value) > DAG_LIMITS.valueBytes) {
      return refuse('too_large', `param ${p.name} is ${bytesOf(value)} bytes; at most ${DAG_LIMITS.valueBytes}`);
    }
    const texts = typeof value === 'string' ? [value] : value;
    if (!texts.every((t) => t.isWellFormed())) return refuse('invalid', `param ${p.name} is not well formed text: a lone surrogate is no text`);
    if (titled.has(p.name) && texts.some((t) => titleRefused(t))) {
      return refuse('invalid', `param ${p.name} lands in a title, which is one line: it may hold no line break, control character or bidi control`);
    }
    if (persons.has(p.name) && personOf !== undefined) {
      const resolved: string[] = [];
      for (const t of texts) {
        if (!t.startsWith('@')) {
          resolved.push(t);
          continue;
        }
        const r = personOf(t);
        if (!r.ok) return r;
        resolved.push(r.principal);
      }
      value = typeof value === 'string' ? (resolved[0] ?? '') : resolved;
    }
    values.set(p.name, value);
  }
  const size = bytesOf(JSON.stringify(Object.fromEntries(values)));
  if (size > DAG_LIMITS.paramsBytes) return refuse('too_large', `the params are ${size} bytes as JSON; at most ${DAG_LIMITS.paramsBytes} together`);
  return { ok: true, values };
}

/** A name a field's reference gave, checked as a name (spec §21.2): in the grammar, or a person's principal where a person may go. */
function nameGiven(value: string, place: string, spec: NameSpec, kind: 'person' | 'workspace', param: string): Refusal | undefined {
  const fills = `param ${param} fills ${place}`;
  if (redactKnownSecrets(value) !== value) return refuse('invalid', `${fills}, and its value holds a known secret: a name is stored as written`);
  if (kind === 'person' && value.includes(':')) {
    if (spec.must === 'role') return refuse('invalid', `${fills}, a role's place, and ${said(value)} is a person`);
    return undefined;
  }
  if (kind === 'person' && spec.must === 'person') return refuse('invalid', `${fills}, a person's place, and ${said(value)} is a role's name`);
  if (!NAME_PATTERN.test(value)) {
    return refuse('invalid', `${fills}, a ${kind === 'workspace' ? 'workspace' : 'role'} name, and ${said(value)} is none: ${nameProblem(kind === 'workspace' ? 'workspace' : 'role', value) ?? ''}`);
  }
  return undefined;
}

/**
 * The expansion (spec §21.3, §21.5): the file made, with its params, into a DAG
 * of every task and link, every key written out. Each for_each step makes one
 * task an item, `<step>:<n>`; a step naming a for_each step as a parent waits
 * for all of its tasks, all to all. Substitution is text, once: a value is put
 * in as written, and not read again for braces. The DAG is shaped, measured and
 * its tasks checked by the caller, as any DAG is.
 */
export function expand(w: Workflow, given: GivenParams, board: string, personOf?: PersonOf): Result<{ dag: Dag }> {
  const params = paramValues(w, given, personOf);
  if (!params.ok) return params;
  const values = params.values;
  const textOf = (name: string): string => {
    const v = values.get(name);
    return Array.isArray(v) ? v.join(', ') : (v ?? '');
  };
  const refsOf = new Map<string, string[]>();
  const tasks: DagTask[] = [];
  for (const s of w.steps) {
    const items: Array<string | null> = s.forEach === undefined ? [null] : [...((values.get(s.forEach) as string[] | undefined) ?? [])];
    const refs: string[] = [];
    for (const [n, item] of items.entries()) {
      const sub = (t: string): string => t.replace(/\{\{([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\}\}/g, (_m, name: string) => (name === ITEM ? (item ?? '') : textOf(name)));
      const name = (spec: NameSpec | undefined, place: string, kind: 'person' | 'workspace'): Result<{ value: string | null }> => {
        if (spec === undefined) return { ok: true, value: null };
        const ref = REFERENCE.exec(spec.value)?.[1];
        if (ref === undefined || REFERENCE.exec(spec.value)?.[0] !== spec.value) return { ok: true, value: spec.value };
        const value = ref === ITEM ? (item ?? '') : textOf(ref);
        const bad = nameGiven(value, place, spec, kind, ref === ITEM ? (s.forEach ?? ITEM) : ref);
        return bad ?? { ok: true, value };
      };
      const assignee = name(s.assignee, `steps.${s.name}.assignee`, 'person');
      if (!assignee.ok) return assignee;
      const reviewer = name(s.reviewer, `steps.${s.name}.reviewer`, 'person');
      if (!reviewer.ok) return reviewer;
      const workspace = name(s.workspace === undefined ? undefined : { value: s.workspace, must: undefined }, `steps.${s.name}.workspace`, 'workspace');
      if (!workspace.ok) return workspace;
      const contract: Contract = {};
      for (const [field, value] of Object.entries(s.contract) as [keyof Contract, string][]) contract[field] = sub(value);
      const ref = s.forEach === undefined ? s.name : `${s.name}:${n + 1}`;
      refs.push(ref);
      const body = s.body === undefined ? null : sub(s.body);
      tasks.push({
        ref,
        step: s.name,
        item,
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
      });
    }
    refsOf.set(s.name, refs);
    if (tasks.length > DAG_LIMITS.tasks) {
      const total = w.steps.reduce((sum, x) => sum + (x.forEach === undefined ? 1 : ((values.get(x.forEach) as string[] | undefined)?.length ?? 0)), 0);
      return refuse('invalid', `workflow ${w.name} would make ${total} tasks with these params; an instance has at most ${DAG_LIMITS.tasks}`);
    }
  }
  return { ok: true, dag: { format: DAG_FORMAT, workflow: w.name, params: Object.fromEntries(values), board, tasks } };
}
```

- [ ] **Step 8.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2087 passed (2087)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.5: Commit.**

```bash
git add src/kanban/workflow.ts tests/kanban-workflow-expand.test.ts
git commit -m "Expand a workflow with its params into a DAG: each path's params against the file, the defaults and sizes, substitution once in every text field, names checked as names, @ resolved only for a person field, for_each all to all, and at most 100 tasks"
```

---

### Task 9: The checks' output: `mt workflow check`, the startup, `mt service check`

**Files:**

- Create: `src/cli/workflow.ts`, `tests/kanban-workflow-check.test.ts`
- Modify: `src/cli/mt.ts`, `src/cli/service.ts`, `src/index.ts`

Spec §2.6, §21.4. `mt workflow check [<name>]` (`src/cli/workflow.ts`) finds the home, the config and the roles as `roleCheck` does, this shell over the gateway's `.env` (never the file in a board run's shell, where it says its secret check is weaker), loads the team with `unsetPassEnv`, saying the names left unset on stderr, and registers the team's secrets and the Lark app secret; then prints a line a workflow, sorted by name, and the entries it ignored. Exit 0 when all are usable, 1 when one is not or a named one has no file, 2 for a wrong command line; it opens no database. `loadStartup` (`src/index.ts`) runs the check with the gateway's facts and returns `workflows`, its lines, which `createGateway(config, team, { workflows })` notes after the roles' line, a broken workflow not stopping it. `mt service check` prints the lines that say something is wrong as `warning:` lines, from the `loadStartup` of the build it checks, with a unit and without, and passes.

- [ ] **Step 9.1: Write the tests.**

Create `tests/kanban-workflow-check.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { loadConfig } from '../src/config.js';
import { createGateway, loadStartup } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam } from '../src/team.js';
import { serviceFake, type ServiceFake } from './helpers/service.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * The checks' output (spec §21.4): `mt workflow check`, with and without a
 * name, its exit codes, in a run's shell; the startup's lines, which a broken
 * workflow does not stop; and `mt service check`'s warnings, which pass.
 */

const BROKEN = 'steps:\n  welcome:\n    title: Welcome\n    gates:\n      - command: "echo {{name}}"\n';
const BROKEN_PROBLEM = 'steps.welcome.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead';

/** A config whose default role is the agent block's, so the example's `worker` and `reviewer` need role directories. */
function roles(home: string, names: readonly string[], extra = ''): void {
  for (const name of names) {
    mkdirSync(join(home, 'roles', name), { recursive: true });
    writeFileSync(join(home, 'roles', name, 'config.yaml'), `agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n${extra}`);
  }
}

function workflows(home: string, files: Record<string, string>): string {
  const dir = join(home, 'workflows');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('mt workflow check', () => {
  let f: MtFixture;
  beforeEach(() => {
    clearSecrets();
    f = mtFixture();
    roles(f.home, ['worker', 'reviewer']);
  });
  afterEach(() => {
    clearSecrets();
    f.cleanup();
  });

  it('prints a line a workflow, then what it ignored; exit 0 when all are usable, 1 when one is not', async () => {
    const dir = workflows(f.home, { 'vendor-eval.yaml': VENDOR_EVAL, 'notes.txt': 'x' });
    const ok = await f.run(['workflow', 'check']);
    expect(ok).toEqual({
      code: 0,
      out: [
        'vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)',
        `ignoring ${join(dir, 'notes.txt')}: not a .yaml file, so not a workflow`,
      ].join('\n'),
      err: '',
    });
    workflows(f.home, { 'onboarding.yaml': BROKEN });
    const broken = await f.run(['workflow', 'check']);
    expect(broken.code).toBe(1);
    expect(broken.out.split('\n')).toEqual([
      `onboarding: not usable: ${BROKEN_PROBLEM}`,
      'vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)',
      `ignoring ${join(dir, 'notes.txt')}: not a .yaml file, so not a workflow`,
    ]);
  });

  it('checks one workflow by name: 0 usable, 1 not, 1 for a name with no file, 2 for two names', async () => {
    const dir = workflows(f.home, { 'vendor-eval.yaml': VENDOR_EVAL, 'onboarding.yaml': BROKEN });
    expect(await f.run(['workflow', 'check', 'vendor-eval'])).toMatchObject({ code: 0, out: expect.stringMatching(/^vendor-eval: ok, 3 steps; /) });
    expect(await f.run(['workflow', 'check', 'onboarding'])).toEqual({ code: 1, out: `onboarding: not usable: ${BROKEN_PROBLEM}`, err: '' });
    expect(await f.run(['workflow', 'check', 'release'])).toEqual({ code: 1, out: `release: no workflow file ${join(dir, 'release.yaml')}`, err: '' });
    const two = await f.run(['workflow', 'check', 'a', 'b']);
    expect(two.code).toBe(2);
    expect(two.err).toMatch(/^mt: workflow check takes at most one name/);
  });

  it('says so when there is no workflow', async () => {
    expect(await f.run(['workflow', 'check'])).toEqual({ code: 0, out: `no workflows: ${join(f.home, 'workflows')} is missing or empty`, err: '' });
  });

  it("refuses a gate holding a secret of the gateway's .env, and says which passEnv names this shell leaves unset", async () => {
    writeFileSync(join(f.home, '.env'), 'LARK_APP_SECRET=lark-secret-123456\n', { mode: 0o600 });
    roles(f.home, ['needs-token'], '  passEnv: [GH_TOKEN]\n');
    workflows(f.home, { 'leaky.yaml': 'steps:\n  a:\n    title: A\n    gates:\n      - command: "curl lark-secret-123456"\n' });
    const r = await f.run(['workflow', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).toBe(
      "leaky: not usable: steps.a.gates[0].command holds a known secret, and a gate is stored and run as written: pass the value through the role's environment and name it in the command, as $NAME",
    );
    expect(r.err).toBe('mt: needs-token: GH_TOKEN not set in this shell, so a gate holding those values cannot be refused here');
  });

  it("works in a board run's shell, saying its secret check is weaker there", async () => {
    workflows(f.home, { 'vendor-eval.yaml': VENDOR_EVAL });
    const r = await f.run(['workflow', 'check'], { env: { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 'tok' } });
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toEqual([
      "note: this is a board run's shell, which reads neither the gateway's .env nor its secrets, so a gate holding one of them cannot be refused here",
      'vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)',
    ]);
  });
});

describe('the startup', () => {
  let root: string;
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    clearSecrets();
    root = mkdtempSync(join(tmpdir(), 'mt-wf-startup-'));
    const home = join(root, 'home');
    mkdirSync(join(root, 'repo'), { recursive: true });
    mkdirSync(home);
    roles(home, ['worker', 'reviewer']);
    env = {
      MT_HOME: home,
      MT_WORKSPACE: join(root, 'repo'),
      MT_OWNER_OPEN_ID: 'ou_owner',
      LARK_APP_ID: 'cli_app',
      LARK_APP_SECRET: 'app-secret-123456',
      MT_AGENT_COMMAND: 'bytesec',
      MT_AGENT_DRIVER: 'structured-cli',
      MT_AGENT_UNSUPERVISED: 'true',
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearSecrets();
    rmSync(root, { recursive: true, force: true });
  });

  it('says workflows: none for no directory, and lists the usable and the broken without stopping', () => {
    expect(loadStartup(env).workflows).toEqual(['workflows: none']);
    workflows(join(root, 'home'), { 'vendor-eval.yaml': VENDOR_EVAL, 'onboarding.yaml': BROKEN });
    expect(loadStartup(env).workflows).toEqual([`workflow onboarding is not usable: ${BROKEN_PROBLEM}`, 'workflows: vendor-eval; not usable: onboarding']);
  });

  it("notes the lines after the roles' line", async () => {
    workflows(join(root, 'home'), { 'vendor-eval.yaml': VENDOR_EVAL, 'onboarding.yaml': BROKEN });
    const started = loadStartup(env);
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk).replace(/^\S+ /, '').trimEnd());
      return true;
    });
    const config = loadConfig(env, () => undefined);
    const gateway = await createGateway(config, loadTeam(config, env), { workflows: started.workflows });
    try {
      const roles = lines.findIndex((l) => l.startsWith('roles: '));
      expect(roles).toBeGreaterThan(-1);
      expect(lines.slice(roles + 1, roles + 3)).toEqual([`workflow onboarding is not usable: ${BROKEN_PROBLEM}`, 'workflows: vendor-eval; not usable: onboarding']);
    } finally {
      await gateway.stop();
    }
  });
});

describe("mt service check's warnings", () => {
  let fx: ServiceFake;
  afterEach(() => {
    clearSecrets();
    fx.cleanup();
  });

  async function check(): Promise<{ code: number; out: string[]; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(['service', 'check'], {
      env: { PATH: '/usr/bin:/bin', HOME: fx.home },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      service: fx.deps(),
    });
    return { code, out, err: err.join('\n') };
  }

  for (const unit of [true, false]) {
    it(`prints the build's unusable workflows as warnings, and passes, ${unit ? 'with a unit' : 'with no unit'}`, async () => {
      fx = await serviceFake();
      workflows(fx.mtHome, { 'onboarding.yaml': BROKEN, 'leaky.yaml': 'steps:\n  a:\n    title: A\n    gates:\n      - command: "echo {{x}}"\n' });
      if (unit) fx.install();
      const r = await check();
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out.filter((l) => l.startsWith('warning: '))).toEqual([
        'warning: workflow leaky is not usable: steps.a.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead',
        `warning: workflow onboarding is not usable: ${BROKEN_PROBLEM}`,
      ]);
      expect(r.out.at(-1)).toMatch(/^ok: this build would start as /);
    });
  }
});
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-check.test.ts`. Expected: `Tests  9 failed (9)`; the first failure: `AssertionError: expected { code: 2, out: '', …(1) } to deeply equal { code: +0, …(2) }`.

- [ ] **Step 9.3: Implement.**

In `src/cli/mt.ts`, replace:

```ts
import { updateCommand, type UpdateDeps } from './update.js';
```

with:

```ts
import { updateCommand, type UpdateDeps } from './update.js';
import { workflowCheck } from './workflow.js';
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt role check [<name>]',
```

with:

```ts
  '  mt role check [<name>]',
  '  mt workflow check [<name>]',
```

In `src/cli/mt.ts`, replace:

```ts
    }
    if (group === 'workspace' && command === 'add') {
```

with:

```ts
    }
    if (group === 'workflow' && command === 'check') {
      // Files only, and no authority: any shell, a board run's included (spec §21.4).
      const [name, extra] = parse(rest, {}).positionals;
      if (extra !== undefined) throw new UsageError('workflow check takes at most one name');
      return workflowCheck(name, io);
    }
    if (group === 'workspace' && command === 'add') {
```

In `src/cli/service.ts`, replace:

```ts
  private checkEnvironment(file: GatewayEnvFile, path: string): { warnings: string[]; problem: string | undefined } {
```

with:

```ts
  private checkEnvironment(file: GatewayEnvFile, path: string): { warnings: string[]; problem: string | undefined; unset: string[] } {
```

In `src/cli/service.ts`, replace:

```ts
    return { warnings: out, problem: problems[0] };
```

with:

```ts
    return { warnings: out, problem: problems[0], unset: [...new Set(names.map((entry) => entry.split(': ')[1] ?? ''))] };
```

In `src/cli/service.ts`, replace:

```ts
    await this.loadModules(recorded.path);
```

with:

```ts
    const gateway = await this.loadModules(recorded.path);
    // The build's own startup, as the service starts it, each unset passEnv name given a stand-in:
    // for its warnings, the workflows it would find unusable (spec §21.4).
    const loadStartup = gateway['loadStartup'];
    if (typeof loadStartup === 'function') {
      addSecrets([STAND_IN]);
      const env: Record<string, string | undefined> = { HOME: deps.home, PATH: recorded.path, MT_HOME: t.mtHome };
      for (const name of checked.unset) env[name] = STAND_IN;
      let started: unknown;
      try {
        started = loadStartup(env);
      } catch (err) {
        throw new CommandFailed(`the gateway would not start: ${errorText(err)}`);
      }
      this.startupWarnings(started);
    }
```

In `src/cli/service.ts`, replace:

```ts
    try {
      loadStartup(copy);
    } catch (err) {
      throw new CommandFailed(`the gateway would not start: ${errorText(err)}`);
    }
    io.out('ok: this build would start as a gateway started by hand from this shell');
    return 0;
```

with:

```ts
    let started: unknown;
    try {
      started = loadStartup(copy);
    } catch (err) {
      throw new CommandFailed(`the gateway would not start: ${errorText(err)}`);
    }
    this.startupWarnings(started);
    io.out('ok: this build would start as a gateway started by hand from this shell');
    return 0;
  }

  /**
   * The startup's workflow lines that say something is wrong (spec §21.4), as
   * warnings: a broken workflow, or an entry that is no workflow. The gateway
   * would start, so the check does not fail on them. The summary line, which
   * names the usable ones, is the gateway's note, not a warning. A build from
   * before workflows answers none.
   */
  private startupWarnings(started: unknown): void {
    const lines = (started as { workflows?: unknown } | null)?.workflows;
    if (!Array.isArray(lines)) return;
    for (const line of lines) {
      if (typeof line === 'string' && !line.startsWith('workflows: ')) this.io.out(redactKnownSecrets(`warning: ${line}`));
    }
```

Create `src/cli/workflow.ts`:

```ts
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadTeamSettings, type Env } from '../config.js';
import { readGatewayEnv, withGatewayEnv } from '../gateway-env.js';
import { listWorkflows, paramsLine, readWorkflow, type Workflow, type WorkflowFacts } from '../kanban/workflow.js';
import { addSecrets, redactKnownSecrets } from '../secrets.js';
import { loadTeam, teamSecrets } from '../team.js';
import { refuse } from './args.js';
import { inBoardRun } from './gate.js';
import type { MtIo } from './mt.js';

/**
 * `mt workflow check [<name>]` (spec §2.6, §21.4): a workflow file's checks,
 * without starting it. It reads files only, and needs no authority, so it works
 * in any shell, a board run's included; it opens no database. It finds the home,
 * the config and the roles as the gateway does, this shell's environment over
 * the gateway's .env, and registers the secrets the gateway would, so a gate
 * holding one is refused here as at a start.
 *
 * Exit 0 when every workflow checked is usable, 1 otherwise, and 2 for a wrong
 * command line.
 */

function okLine(w: Workflow): string {
  return `${w.name}: ok, ${w.steps.length} step${w.steps.length === 1 ? '' : 's'}; params: ${paramsLine(w)}`;
}

export function workflowCheck(only: string | undefined, io: MtIo): number {
  // As roleCheck reads it (spec §2.6): never the gateway's .env in a board run's shell.
  const run = inBoardRun(io.env);
  let env: Env = io.env;
  const unset: string[] = [];
  let facts: WorkflowFacts;
  let dir: string;
  try {
    if (!run) env = withGatewayEnv(io.env, readGatewayEnv(io.env));
    const settings = loadTeamSettings(env, undefined, { unsetPassEnv: unset });
    const team = loadTeam(settings, env, { unsetPassEnv: unset });
    const lark = env['LARK_APP_SECRET'];
    addSecrets([...(lark === undefined || lark === '' ? [] : [lark]), ...teamSecrets(team)]);
    // As the gateway's own service judges a task: a supervised role's approvals reach the chat following it.
    facts = { roles: team.roles, workspaces: new Set(team.workspaces.keys()), supervisedRoles: true };
    dir = join(settings.home, 'workflows');
  } catch (err) {
    if (err instanceof ConfigError) return refuse(io, `the team does not load, so no workflow can be checked: ${err.message}`);
    throw err;
  }
  if (unset.length > 0) {
    io.err(`mt: ${[...new Set(unset)].join(', ')} not set in this shell, so a gate holding those values cannot be refused here`);
  }
  if (run) {
    io.out("note: this is a board run's shell, which reads neither the gateway's .env nor its secrets, so a gate holding one of them cannot be refused here");
  }
  const say = (line: string): void => io.out(redactKnownSecrets(line));
  if (only !== undefined) {
    if (lstatSync(join(dir, `${only}.yaml`), { throwIfNoEntry: false }) === undefined) {
      say(`${only}: no workflow file ${join(dir, `${only}.yaml`)}`);
      return 1;
    }
    const r = readWorkflow(dir, only, facts);
    if (r.ok) {
      say(okLine(r.workflow));
      return 0;
    }
    say(`${only}: not usable: ${r.message.replace(/^workflow \S+ is not usable: /, '').replace(/^there is no workflow \S+: /, '')}`);
    return 1;
  }
  const list = listWorkflows(dir, facts);
  const lines = [
    ...list.usable.map((w) => ({ name: w.name, line: okLine(w) })),
    ...list.broken.map((b) => ({ name: b.name, line: `${b.name}: not usable: ${b.problem}` })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (lines.length === 0 && list.ignored.length === 0) say(`no workflows: ${dir} is missing or empty`);
  for (const l of lines) say(l.line);
  for (const l of list.ignored) say(l);
  return list.broken.length === 0 ? 0 : 1;
}
```

In `src/index.ts`, replace:

```ts
import { TaskDirectories } from './kanban/worktree.js';
```

with:

```ts
import { TaskDirectories } from './kanban/worktree.js';
import { listWorkflows, workflowLines } from './kanban/workflow.js';
```

In `src/index.ts`, replace:

```ts
export function loadStartup(env: Env = process.env): { config: GatewayConfig; team: Team; gatewayEnv: GatewayEnvFile } {
```

with:

```ts
export function loadStartup(env: Env = process.env): { config: GatewayConfig; team: Team; gatewayEnv: GatewayEnvFile; workflows: string[] } {
```

In `src/index.ts`, replace:

```ts
  return { config, team, gatewayEnv: loaded.file };
```

with:

```ts
  return { config, team, gatewayEnv: loaded.file, workflows: startupWorkflows(config, team) };
}

/**
 * The workflow check's lines (spec §21.4): notes, as a broken workflow does not
 * stop the gateway; only it is unusable. With the team as the gateway's service
 * judges it, supervised roles accepted. `mt service check` prints them too.
 */
function startupWorkflows(config: GatewayConfig, team: Team): string[] {
  const dir = join(config.home, 'workflows');
  try {
    return workflowLines(
      listWorkflows(dir, { roles: team.roles, workspaces: new Set(team.workspaces.keys()), supervisedRoles: true }),
    );
  } catch (err) {
    return [`workflows: none; ${dir} cannot be read: ${err instanceof Error ? err.message : String(err)}`];
  }
```

In `src/index.ts`, replace:

```ts
export async function createGateway(config: GatewayConfig, team: Team): Promise<Gateway> {
```

with:

```ts
/** What `loadStartup` found beside the config and the team: the workflow check's lines, noted after the roles' (spec §21.4). */
export interface StartupNotes {
  workflows?: readonly string[];
}

export async function createGateway(config: GatewayConfig, team: Team, startup: StartupNotes = {}): Promise<Gateway> {
```

In `src/index.ts`, replace:

```ts
      `workspaces: ${[...team.workspaces.keys()].sort().join(', ')}`,
  );

```

with:

```ts
      `workspaces: ${[...team.workspaces.keys()].sort().join(', ')}`,
  );
  for (const line of startup.workflows ?? []) note(line);

```

In `src/index.ts`, replace:

```ts
  const { config, team, gatewayEnv } = loadStartup();
```

with:

```ts
  const { config, team, gatewayEnv, workflows } = loadStartup();
```

In `src/index.ts`, replace:

```ts
  const gateway = await createGateway(config, team);
```

with:

```ts
  const gateway = await createGateway(config, team, { workflows });
```

- [ ] **Step 9.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2096 passed (2096)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.5: Commit.**

```bash
git add src/cli/mt.ts src/cli/service.ts src/cli/workflow.ts src/index.ts tests/kanban-workflow-check.test.ts
git commit -m "Check the workflow files with mt workflow check, at startup through loadStartup, whose lines the gateway notes after the roles', and in mt service check, which prints the unusable ones as warnings and passes"
```

---

### Task 10: The writer's shared inserts, and `threadSubscriptions`

**Files:**

- Modify: `src/db/WRITERS.md`, `src/db/kanban.ts`, `src/kanban/chat.ts`, `src/kanban/service.ts`, `tests/kanban-thread-roots.test.ts`

Spec §21.8. Behaviour unchanged: `createTask`'s insert (the row, its links, its subscriptions and its `created` event) becomes `insertTask`, `addGate`'s limits and insert `insertGate`, and `archive`'s body `archiveIn`, each taking extra payload keys, so a workflow's tasks, gates and archives are made exactly as any. `threadSubscriptions(db, taskIds, at, threadId, rootId)` replaces `threadSubscription`, moving every listed task's subscription in one transaction under the same rules, and answers how many moved; the service's `threadSubscriptions` replaces its `threadSubscription`, and `KanbanChat.threaded` calls it with one task. The existing tests of the move call the list form, with `moved` a count, and two new ones move several at once and refuse a list that is not of text. WRITERS.md's `kanban_subscriptions` row names it.

- [ ] **Step 10.1: Write the tests.**

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
import { advanceSubscription, createTask, threadSubscription } from '../src/db/kanban.js';
```

with:

```ts
import { advanceSubscription, createTask, threadSubscriptions } from '../src/db/kanban.js';
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
describe('threadSubscription', () => {
```

with:

```ts
describe('threadSubscriptions', () => {
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
    const events = eventsOf(h.db, task.taskId).length;
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: true });
```

with:

```ts
    const events = eventsOf(h.db, task.taskId).length;
    expect(threadSubscriptions(h.db, [task.taskId], CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: 1 });
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_other', 'om_other')).toEqual({ ok: true, moved: false });
```

with:

```ts
    expect(threadSubscriptions(h.db, [task.taskId], CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: 0 });
    expect(threadSubscriptions(h.db, [task.taskId], CHAT, 'omt_other', 'om_other')).toEqual({ ok: true, moved: 0 });
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
    expect(threadSubscription(h.db, task.taskId, { ...CHAT, appId: 'cli_other' }, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, task.taskId, { ...CHAT, conversationId: 'oc_other' }, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, inThread.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: true });
```

with:

```ts
    expect(threadSubscriptions(h.db, [task.taskId], { ...CHAT, appId: 'cli_other' }, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: 0 });
    expect(threadSubscriptions(h.db, [task.taskId], { ...CHAT, conversationId: 'oc_other' }, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: 0 });
    expect(threadSubscriptions(h.db, [inThread.taskId], CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: 0 });
    expect(threadSubscriptions(h.db, [task.taskId], CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: 1 });
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
    expect(service.threadSubscription(task.taskId, CHAT, '', 'om_cmd')).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.threadSubscription(task.taskId, CHAT, 'omt_new', '')).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.threadSubscription(task.taskId, { ...CHAT, appId: 7 } as unknown as typeof CHAT, 'omt_new', 'om_cmd')).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(service.threadSubscription(task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: true });
  });
});
```

with:

```ts
    expect(service.threadSubscriptions([task.taskId], CHAT, '', 'om_cmd')).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.threadSubscriptions([task.taskId], CHAT, 'omt_new', '')).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.threadSubscriptions([task.taskId], { ...CHAT, appId: 7 } as unknown as typeof CHAT, 'omt_new', 'om_cmd')).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(service.threadSubscriptions([task.taskId], CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: 1 });
  });

  it("moves every task's subscription in one call, a task named twice once, and those already moved stay", () => {
    const tasks = [newTask(h.db, { createdVia: VIA }), newTask(h.db, { createdVia: VIA }), newTask(h.db, { createdVia: VIA })];
    const ids = tasks.map((t) => t.taskId);
    expect(threadSubscriptions(h.db, [ids[0] ?? ''], CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: 1 });
    expect(threadSubscriptions(h.db, [...ids, ids[1] ?? ''], CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: 2 });
    for (const id of ids) expect(subscriptionsOf(h.db, id).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_new', 'om_cmd']]);
    expect(threadSubscriptions(h.db, [], CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: 0 });
  });

  it('refuses through the service a list that is not of text', () => {
    const service = new KanbanService({ db: h.db, roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])), workspaces: WORKSPACES });
    expect(service.threadSubscriptions([7] as unknown as string[], CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: false, code: 'invalid', message: 'task ids are text' });
  });
});

```

- [ ] **Step 10.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-thread-roots.test.ts`. Expected: `Tests  5 failed | 4 passed (9)`; the first failure: `TypeError: (0 , threadSubscriptions) is not a function`.

- [ ] **Step 10.3: Implement.**

In `src/db/WRITERS.md`, replace:

```markdown
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4). `root_message_id` (migration 008) is written at the insert, for a task created in a thread, from `createdVia.rootId`, or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. `thread_id` and `root_message_id` are written once more, together, by `threadSubscription`, which moves a subscription still at chat scope with no root into the thread its task's "Created" reply opened, writing no event either. No root is changed once written. Never deleted. |
```

with:

```markdown
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4). `root_message_id` (migration 008) is written at the insert, for a task created in a thread, from `createdVia.rootId`, or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. `thread_id` and `root_message_id` are written once more, together, by `threadSubscriptions`, which moves each subscription of its tasks still at chat scope with no root into the thread their "Created" reply opened, in one transaction: one task's for `/kanban task new`, every member's for a workflow's start (spec §21.9), writing no event either. No root is changed once written. Never deleted. |
```

In `src/db/kanban.ts`, replace:

```ts

    const taskId = newTaskId();
    d.prepare(
      `INSERT INTO kanban_tasks
         (task_id, title, body, contract, assignee_kind, assignee, reviewer_kind, reviewer,
          workspace, phase, priority, idempotency_key, failure_limit, retry_on_crash,
          max_runtime_s, created_by, created_via, created_at, created_from_task, board)
       VALUES (?, ?, ?, jsonb(?), ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, jsonb(?), ?, ?, ?)`,
    ).run(
      taskId,
      mask(t.title),
      mask(t.body ?? ''),
      JSON.stringify(maskContract(t.contract ?? {})),
      t.assignee?.kind ?? null,
      t.assignee?.name ?? null,
      t.reviewer?.kind ?? null,
      t.reviewer?.name ?? null,
      t.workspace ?? null,
      t.priority ?? 0,
      t.idempotencyKey ?? null,
      t.failureLimit ?? null,
      t.retryOnCrash ?? 'always',
      t.maxRuntimeS ?? null,
      t.createdBy,
      JSON.stringify(t.createdVia),
      now,
      createdFromTask,
      board,
    );
    const link = d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)');
    for (const parent of parents) link.run(parent, taskId, now);
    subscribe(d, taskId, t.createdVia, createdFromTask, now);
    record(
      d,
      {
        taskId,
        kind: 'created',
        actor: t.createdBy,
        payload: {
          title: t.title,
          assignee: t.assignee?.name ?? null,
          assigneeKind: t.assignee?.kind ?? null,
          reviewer: t.reviewer?.name ?? null,
          reviewerKind: t.reviewer?.kind ?? null,
          workspace: t.workspace ?? null,
          parents,
          createdFromTask,
          board,
        },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), existing: false };
  });
```

with:

```ts
    const taskId = insertTask(d, { ...t, board, createdFromTask, parents }, now);
    return { ok: true, task: mustGet(d, taskId), existing: false };
  });
}

/** A task as `insertTask` writes it: its board and its creating task worked out, its parents checked. */
interface TaskInsert extends NewTask {
  board: string;
  createdFromTask: string | null;
  parents: readonly string[];
}

/**
 * The insert every task is made by, `createTask`'s and a workflow's alike (spec
 * §21.8): the row, its links, its subscriptions and its `created` event, whose
 * payload gains `payload`'s keys. Inside the caller's transaction, which has
 * checked everything; answers the new task's id.
 */
function insertTask(d: Db, t: TaskInsert, now: number, payload: Record<string, unknown> = {}): string {
  const { board, createdFromTask, parents } = t;
  const taskId = newTaskId();
  d.prepare(
    `INSERT INTO kanban_tasks
       (task_id, title, body, contract, assignee_kind, assignee, reviewer_kind, reviewer,
        workspace, phase, priority, idempotency_key, failure_limit, retry_on_crash,
        max_runtime_s, created_by, created_via, created_at, created_from_task, board)
     VALUES (?, ?, ?, jsonb(?), ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, jsonb(?), ?, ?, ?)`,
  ).run(
    taskId,
    mask(t.title),
    mask(t.body ?? ''),
    JSON.stringify(maskContract(t.contract ?? {})),
    t.assignee?.kind ?? null,
    t.assignee?.name ?? null,
    t.reviewer?.kind ?? null,
    t.reviewer?.name ?? null,
    t.workspace ?? null,
    t.priority ?? 0,
    t.idempotencyKey ?? null,
    t.failureLimit ?? null,
    t.retryOnCrash ?? 'always',
    t.maxRuntimeS ?? null,
    t.createdBy,
    JSON.stringify(t.createdVia),
    now,
    createdFromTask,
    board,
  );
  const link = d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)');
  for (const parent of parents) link.run(parent, taskId, now);
  subscribe(d, taskId, t.createdVia, createdFromTask, now);
  record(
    d,
    {
      taskId,
      kind: 'created',
      actor: t.createdBy,
      payload: {
        title: t.title,
        assignee: t.assignee?.name ?? null,
        assigneeKind: t.assignee?.kind ?? null,
        reviewer: t.reviewer?.name ?? null,
        reviewerKind: t.reviewer?.kind ?? null,
        workspace: t.workspace ?? null,
        parents,
        createdFromTask,
        board,
        ...payload,
      },
    },
    now,
  );
  return taskId;
```

In `src/db/kanban.ts`, replace:

```ts
 * Move a task's subscription at a chat into the thread its "Created" reply
 * opened (spec §19.4): its `thread_id` from '' to the thread's, and its root to
 * the command message, in one transaction. Only a subscription of this task, at
 * this chat, for this bot, still at chat scope with no root, moves, so a second
 * call changes nothing. Its cursor moves with it: nothing already sent is sent
 * again, and nothing pending is lost. It writes no event, as a cursor's move
 * writes none.
 */
export function threadSubscription(db: Db, taskId: string, at: ChatAt, threadId: string, rootId: string): Result<{ moved: boolean }> {
  return tx(db, (d) => {
    if (threadId === '' || rootId === '') return refuse('invalid', 'a thread and its root are not empty');
    // OR IGNORE: a subscription of the task already in that thread is left as it is.
    const { changes } = d
      .prepare(
        `UPDATE OR IGNORE kanban_subscriptions SET thread_id = ?, root_message_id = ?
          WHERE task_id = ? AND channel = ? AND account_id = ? AND conversation_id = ?
            AND thread_id = '' AND root_message_id IS NULL`,
      )
      .run(threadId, rootId, taskId, at.channel, at.appId, at.conversationId);
    return { ok: true, moved: changes === 1 };
```

with:

```ts
 * Move the tasks' subscriptions at a chat into the thread their "Created" reply
 * opened (spec §19.4, §21.9): each one's `thread_id` from '' to the thread's,
 * and its root to the command message, all in one transaction: one task for
 * `/kanban task new`, every member of an instance for a workflow's start. Only
 * a subscription of these tasks, at this chat, for this bot, still at chat
 * scope with no root, moves, so a second call changes nothing. Its cursor moves
 * with it: nothing already sent is sent again, and nothing pending is lost. It
 * writes no event, as a cursor's move writes none. Answers how many moved.
 */
export function threadSubscriptions(
  db: Db,
  taskIds: readonly string[],
  at: ChatAt,
  threadId: string,
  rootId: string,
): Result<{ moved: number }> {
  return tx(db, (d) => {
    if (threadId === '' || rootId === '') return refuse('invalid', 'a thread and its root are not empty');
    // OR IGNORE: a subscription of the task already in that thread is left as it is.
    const move = d.prepare(
      `UPDATE OR IGNORE kanban_subscriptions SET thread_id = ?, root_message_id = ?
        WHERE task_id = ? AND channel = ? AND account_id = ? AND conversation_id = ?
          AND thread_id = '' AND root_message_id IS NULL`,
    );
    let moved = 0;
    for (const taskId of new Set(taskIds)) {
      moved += move.run(threadId, rootId, taskId, at.channel, at.appId, at.conversationId).changes;
    }
    return { ok: true, moved };
```

In `src/db/kanban.ts`, replace:

```ts
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
```

with:

```ts
    return insertGate(d, taskId, gate, by, now);
  });
}

/**
 * The insert every gate is added by, `addGate`'s and a workflow's alike (spec
 * §21.8): GATE_LIMITS checked against the task's gates so far, inside the
 * caller's transaction, then the row and its `gate_added` event, whose payload
 * gains `payload`'s keys.
 */
function insertGate(
  d: Db,
  taskId: string,
  gate: { command: string; timeoutS: number },
  by: string,
  now: number,
  payload: Record<string, unknown> = {},
): Result<{ gate: GateRow }> {
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
    {
      taskId,
      kind: 'gate_added',
      actor: by,
      payload: { gateId: id, command: gate.command, timeoutS: gate.timeoutS, ...payload },
    },
    now,
  );
  return {
    ok: true,
    gate: { id, taskId, command: gate.command, timeoutS: gate.timeoutS, createdBy: by, createdAt: now },
  };
```

In `src/db/kanban.ts`, replace:

```ts
    const run = supersede(d, openRunOf(d, taskId), now);
    d.prepare(
      `UPDATE kanban_tasks SET phase = 'archived', blocked_from = NULL, closed_at = coalesce(closed_at, ?)
        WHERE task_id = ?`,
    ).run(now, taskId);
    record(d, { taskId, runId: run?.runId ?? null, kind: 'archived', actor: by, payload: { from: task.phase } }, now);
    return { ok: true, task: mustGet(d, taskId), run };
  });
```

with:

```ts
    return { ok: true, ...archiveIn(d, task, by, now) };
  });
}

/**
 * The body every archive runs, `archive`'s and a workflow's alike (spec §21.8),
 * inside the caller's transaction, on a task not yet archived: its open run
 * superseded if undecided, the task archived, keeping the time it was done, and
 * its `archived` event, whose payload gains `payload`'s keys.
 */
function archiveIn(
  d: Db,
  task: TaskRow,
  by: string,
  now: number,
  payload: Record<string, unknown> = {},
): { task: TaskRow; run: RunRow | undefined } {
  const run = supersede(d, openRunOf(d, task.taskId), now);
  d.prepare(
    `UPDATE kanban_tasks SET phase = 'archived', blocked_from = NULL, closed_at = coalesce(closed_at, ?)
      WHERE task_id = ?`,
  ).run(now, task.taskId);
  record(
    d,
    { taskId: task.taskId, runId: run?.runId ?? null, kind: 'archived', actor: by, payload: { from: task.phase, ...payload } },
    now,
  );
  return { task: mustGet(d, task.taskId), run };
```

In `src/kanban/chat.ts`, replace:

```ts
      const r = this.#deps.service.threadSubscription(taskId, chatAt(key), threadId, messageId);
```

with:

```ts
      const r = this.#deps.service.threadSubscriptions([taskId], chatAt(key), threadId, messageId);
```

In `src/kanban/service.ts`, replace:

```ts
   * A task's subscription at this chat moved into the thread its "Created" reply
   * opened, with the command message as its root (spec §19.4): `KanbanChat`'s,
   * once Lark answered the reply with its thread.
   */
  threadSubscription(taskId: string, at: ChatAt, threadId: string, rootId: string): Result<{ moved: boolean }> {
    const ids = idsRefused(taskId, threadId, rootId);
```

with:

```ts
   * The tasks' subscriptions at this chat moved into the thread their "Created"
   * reply opened, with the command message as its root, in one call (spec
   * §19.4, §21.9): `KanbanChat`'s, once Lark answered the reply with its thread.
   * One task for `/kanban task new`; every member for a workflow's start.
   */
  threadSubscriptions(taskIds: readonly string[], at: ChatAt, threadId: string, rootId: string): Result<{ moved: number }> {
    if (!isTextList(taskIds)) return board.refuse('invalid', 'task ids are text');
    const ids = idsRefused(threadId, rootId);
```

In `src/kanban/service.ts`, replace:

```ts
    return board.threadSubscription(this.#db, taskId, at, threadId, rootId);
```

with:

```ts
    return board.threadSubscriptions(this.#db, taskIds, at, threadId, rootId);
```

- [ ] **Step 10.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2098 passed (2098)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.5: Commit.**

```bash
git add src/db/WRITERS.md src/db/kanban.ts src/kanban/chat.ts src/kanban/service.ts tests/kanban-thread-roots.test.ts
git commit -m "Share createTask's insert, addGate's and archive's with helpers a workflow's writes will use, and move a list of tasks' subscriptions into their thread in one call, threadSubscriptions, in place of threadSubscription"
```

---

### Task 11: `applyDag` and `archiveWorkflow`, the writer's

**Files:**

- Create: `tests/kanban-workflow-writer.test.ts`
- Modify: `src/db/WRITERS.md`, `src/db/kanban-read.ts`, `src/db/kanban.ts`

Spec §21.7, §21.8, §21.10. In `src/db/kanban.ts`: `applyDag(db, instance, members, now)` makes a checked DAG in one `tx`: the board worked out (a run's task's for a run), the key looked up again through `keyRefused` (a repeat answered `existing: true`, another board's `other_board`, another kind's, another workflow's or another DAG's hash `invalid`), the board checked live; then the instance row with its DAG masked but for its gates, and each task through `insertTask`, its `created` event carrying `workflow`, `workflowName`, `ref`, `step` and `item`, its gates through `insertGate` with `created_by` the instance's maker and `workflow` in `gate_added`, and its member row, the item masked. `BOARD_KEYS` gains `workflow`, `workflowName`, `ref` and `step`. `archiveWorkflow` archives every member not yet archived through `archiveIn`, `workflow` in each event, answering the runs it decided. In `src/db/kanban-read.ts`: `InstanceRow`, `MemberRow`, `hasWorkflows`, `getInstance`, `instanceByKey`, `membersOf`, `memberOf` (undefined on a database with no members table), `instancesOn` (newest first, at most a limit, with the total) and `relatedTasks`. WRITERS.md gains the two tables' rows.

- [ ] **Step 11.1: Write the tests.**

Create `tests/kanban-workflow-writer.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDag, archiveBoard, archiveWorkflow, createBoard, createTask, type NewInstance, type NewMember } from '../src/db/kanban.js';
import {
  eventsOf,
  gatesOf,
  getInstance,
  getRun,
  getTask,
  hasWorkflows,
  instancesOn,
  memberOf,
  membersOf,
  parentsOf,
  relatedTasks,
  subscriptionsOf,
} from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { checkDagShape, type Dag } from '../src/kanban/dag.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * The writer of a workflow's instance (spec §21.8): everything in one
 * transaction, a refusal rolling all of it back, each task's `created` event
 * carrying the instance, the gates' `created_by`, the key looked up again, the
 * stored DAG masked but for its gates; the archive of every member; and the
 * reads of an instance, its members and its related tasks.
 */

const SECRET = 'sk-live-1234567890';
let h: TestDb;
beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  h = testDb();
});
afterEach(() => {
  clearSecrets();
  h.close();
});

/** A DAG of a root, two items after it, and a fan-in after both, its second item's gate given. */
function dag(extra: Record<string, unknown> = {}): { dag: Dag; sha256: string } {
  const r = checkDagShape(
    {
      format: 1,
      workflow: 'vendor-eval',
      params: { topic: `logs ${SECRET}` },
      board: 'default',
      tasks: [
        { ref: 'shortlist', title: 'Shortlist', assignee: 'worker' },
        { ref: 'evaluate:1', step: 'evaluate', item: 'acme', title: 'Evaluate acme', assignee: 'worker', parents: ['shortlist'] },
        {
          ref: 'evaluate:2',
          step: 'evaluate',
          item: `globex ${SECRET}`,
          title: `Evaluate globex ${SECRET}`,
          assignee: 'worker',
          parents: ['shortlist'],
          gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }],
        },
        { ref: 'recommend', title: 'Recommend', assignee: 'worker', parents: ['evaluate:1', 'evaluate:2'] },
      ],
      ...extra,
    },
    'expansion',
  );
  if (!r.ok) throw new Error(r.message);
  return { dag: r.dag, sha256: r.sha256 };
}

function instance(over: Partial<NewInstance> = {}): NewInstance {
  const d = dag();
  return { name: 'vendor-eval', dag: d.dag, sha256: d.sha256, source: 'start', board: 'default', createdBy: ALICE, createdVia: VIA, idempotencyKey: null, ...over };
}

/** The writer's members for a DAG, as the service makes them. */
function members(d: Dag): NewMember[] {
  return d.tasks.map((t) => ({
    task: { title: t.title, assignee: t.assignee === null ? null : { kind: 'role', name: t.assignee } },
    ref: t.ref,
    step: t.step,
    item: t.item,
    parents: t.parents.map((p) => d.tasks.findIndex((x) => x.ref === p)),
    gates: t.gates.map((g) => ({ command: g.command, timeoutS: g.timeout_s })),
  }));
}

function apply(over: Partial<NewInstance> = {}, list?: NewMember[]) {
  const i = instance(over);
  const r = applyDag(h.db, i, list ?? members(i.dag), NOW);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r;
}

const count = (table: string): number => (h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const counts = () => ['kanban_tasks', 'kanban_links', 'kanban_gates', 'kanban_workflow_instances', 'kanban_workflow_tasks', 'kanban_events', 'kanban_subscriptions'].map(count);

describe('applyDag', () => {
  it('makes every task, link, gate and member, in order, on the board', () => {
    const r = apply();
    expect(r.existing).toBe(false);
    expect(r.instance).toMatchObject({ name: 'vendor-eval', source: 'start', board: 'default', createdBy: ALICE, createdVia: VIA, idempotencyKey: null });
    expect(r.instance.instanceId).toMatch(/^w_/);
    expect(r.members.map((m) => [m.position, m.ref, m.step, m.item])).toEqual([
      [0, 'shortlist', 'shortlist', null],
      [1, 'evaluate:1', 'evaluate', 'acme'],
      [2, 'evaluate:2', 'evaluate', `globex ${MASK}`],
      [3, 'recommend', 'recommend', null],
    ]);
    const [shortlist, e1, e2, recommend] = r.members.map((m) => m.task);
    expect(parentsOf(h.db, recommend?.taskId ?? '').map((p) => p.taskId).sort()).toEqual([e1?.taskId, e2?.taskId].sort());
    expect(parentsOf(h.db, e1?.taskId ?? '').map((p) => p.taskId)).toEqual([shortlist?.taskId]);
    expect(e2?.title).toBe(`Evaluate globex ${MASK}`);
    expect(gatesOf(h.db, e2?.taskId ?? '')).toEqual([expect.objectContaining({ command: 'test -s evaluation.md', timeoutS: 30, createdBy: ALICE })]);
    expect(counts()).toEqual([4, 4, 1, 1, 4, 5, 4]);
    expect(membersOf(h.db, r.instance.instanceId).map((m) => m.taskId)).toEqual(r.members.map((m) => m.taskId));
  });

  it('writes each task its own created event, carrying the instance, and each gate its gate_added', () => {
    const r = apply();
    const e2 = r.members[2]?.task.taskId ?? '';
    const events = eventsOf(h.db, e2);
    expect(events.map((e) => e.kind)).toEqual(['created', 'gate_added']);
    expect(events[0]?.payload).toMatchObject({
      title: `Evaluate globex ${MASK}`,
      workflow: r.instance.instanceId,
      workflowName: 'vendor-eval',
      ref: 'evaluate:2',
      step: 'evaluate',
      item: `globex ${MASK}`,
    });
    expect(events[1]).toMatchObject({ actor: ALICE, payload: { command: 'test -s evaluation.md', timeoutS: 30, workflow: r.instance.instanceId } });
  });

  it('stores the DAG masked but for its gates, and the hash it was given, taken before masking', () => {
    const plain = dag();
    const r = apply({ dag: plain.dag, sha256: plain.sha256 });
    const stored = getInstance(h.db, r.instance.instanceId);
    expect(stored?.dagSha256).toBe(plain.sha256);
    expect(stored?.dag.params).toEqual({ topic: `logs ${MASK}` });
    expect(stored?.dag.tasks[2]).toMatchObject({ title: `Evaluate globex ${MASK}`, item: `globex ${MASK}`, gates: [{ command: 'test -s evaluation.md', timeout_s: 30 }] });
  });

  it('subscribes the chat to every task, and from a run gives each its task\'s subscriptions, on its board, created from it', () => {
    const r = apply();
    for (const m of r.members) expect(subscriptionsOf(h.db, m.taskId)).toEqual([expect.objectContaining({ conversationId: 'oc_chat', threadId: '' })]);
    const planner = newTask(h.db, { createdVia: { ...VIA, threadId: 'omt_topic', rootId: 'om_root' } as CreatedVia });
    const run = claimed(h.db, planner.taskId);
    const fromRun = apply({ createdVia: { kind: 'run', runId: run.runId }, createdBy: `run:${run.runId}`, board: 'elsewhere', source: 'apply', name: null });
    expect(fromRun.instance.board).toBe('default');
    for (const m of fromRun.members) {
      expect(m.task.createdFromTask).toBe(planner.taskId);
      expect(subscriptionsOf(h.db, m.taskId)).toEqual([expect.objectContaining({ threadId: 'omt_topic', rootMessageId: 'om_root' })]);
    }
    const operator = apply({ createdVia: { kind: 'operator' }, createdBy: 'operator:me' });
    for (const m of operator.members) expect(subscriptionsOf(h.db, m.taskId)).toEqual([]);
  });

  it('rolls everything back on a refusal inside the transaction', () => {
    const before = counts();
    const list = members(dag().dag);
    const tooMany = { ...list[3]!, gates: Array.from({ length: 21 }, () => ({ command: 'true', timeoutS: 1 })) };
    const r = applyDag(h.db, instance(), [list[0]!, list[1]!, list[2]!, tooMany], NOW);
    expect(r).toEqual({ ok: false, code: 'invalid', message: expect.stringMatching(/^recommend: task k_\w+ has 20 gates, the most a task may have$/) });
    expect(counts()).toEqual(before);
    createBoard(h.db, 'old', ALICE, NOW);
    archiveBoard(h.db, 'old', ALICE, NOW);
    expect(applyDag(h.db, instance({ board: 'old' }), members(dag().dag), NOW)).toEqual({
      ok: false,
      code: 'board_archived',
      message: 'board old is archived; nothing is added to it',
    });
    expect(applyDag(h.db, instance({ board: 'nowhere' }), members(dag().dag), NOW)).toMatchObject({ ok: false, code: 'unknown_board' });
    expect(counts()).toEqual(before);
  });

  it('is refused by the members\' unique ref, a backstop, rolling all of it back', () => {
    const before = counts();
    const list = members(dag().dag);
    expect(() => applyDag(h.db, instance(), [list[0]!, { ...list[1]!, ref: 'shortlist' }], NOW)).toThrow(/UNIQUE constraint failed: kanban_workflow_tasks.instance_id, kanban_workflow_tasks.ref/);
    expect(counts()).toEqual(before);
  });

  it('answers a repeated key with its instance, existing, making nothing; refuses another board, kind, workflow or DAG', () => {
    const first = apply({ idempotencyKey: 'operator:k' });
    const before = counts();
    const again = apply({ idempotencyKey: 'operator:k' });
    expect(again).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
    expect(again.members.map((m) => m.taskId)).toEqual(first.members.map((m) => m.taskId));
    expect(counts()).toEqual(before);
    createBoard(h.db, 'research', ALICE, NOW);
    const id = first.instance.instanceId;
    const refused = (over: Partial<NewInstance>) => applyDag(h.db, instance({ idempotencyKey: 'operator:k', ...over }), [], NOW);
    expect(refused({ board: 'research' })).toEqual({ ok: false, code: 'other_board', message: `instance ${id} was made with this idempotency key on board default, not research` });
    expect(refused({ source: 'apply' })).toEqual({
      ok: false,
      code: 'invalid',
      message: `this idempotency key was used to start a workflow, as ${id}; a key used by a start is not used by an apply, nor the reverse`,
    });
    expect(refused({ name: 'release' })).toEqual({ ok: false, code: 'invalid', message: `this idempotency key was used to start workflow vendor-eval, as ${id}, not release` });
    expect(counts()).toEqual(before);
    const applied = apply({ idempotencyKey: 'operator:a', source: 'apply' });
    const other = dag({ board: null });
    const after = counts();
    expect(applyDag(h.db, instance({ idempotencyKey: 'operator:a', source: 'apply', dag: other.dag, sha256: other.sha256 }), [], NOW)).toEqual({
      ok: false,
      code: 'invalid',
      message: `this idempotency key was used to apply another DAG, as ${applied.instance.instanceId}`,
    });
    expect(counts()).toEqual(after);
  });

  it("keeps an archived instance's key used", () => {
    const first = apply({ idempotencyKey: 'operator:k' });
    expect(archiveWorkflow(h.db, first.instance.instanceId, ALICE, NOW).ok).toBe(true);
    expect(apply({ idempotencyKey: 'operator:k' })).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
  });
});

describe('archiveWorkflow', () => {
  it('archives every member in one transaction, superseding an undecided run, and leaves related tasks alone', () => {
    const r = apply();
    const [shortlist] = r.members;
    const run = claimed(h.db, shortlist?.taskId ?? '');
    const follow = createTask(h.db, { title: 'A follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW);
    if (!follow.ok) throw new Error(follow.message);
    const done = archiveWorkflow(h.db, r.instance.instanceId, ALICE, NOW + 1);
    if (!done.ok) throw new Error(done.message);
    expect(done.archived.map((t) => t.taskId)).toEqual(r.members.map((m) => m.taskId));
    expect(done.runs.map((x) => [x.runId, x.outcome])).toEqual([[run.runId, 'superseded']]);
    expect(getRun(h.db, run.runId)?.outcome).toBe('superseded');
    for (const m of r.members) {
      expect(getTask(h.db, m.taskId)?.phase).toBe('archived');
      expect(eventsOf(h.db, m.taskId).at(-1)).toMatchObject({ kind: 'archived', payload: { workflow: r.instance.instanceId } });
    }
    expect(getTask(h.db, follow.task.taskId)?.phase).toBe('open');
    expect(relatedTasks(h.db, r.instance.instanceId).map((t) => t.taskId)).toEqual([follow.task.taskId]);
    const events = count('kanban_events');
    expect(archiveWorkflow(h.db, r.instance.instanceId, ALICE, NOW + 2)).toMatchObject({ ok: true, archived: [], runs: [] });
    expect(count('kanban_events')).toBe(events);
    expect(archiveWorkflow(h.db, 'w_none', ALICE, NOW)).toEqual({ ok: false, code: 'not_found', message: 'no workflow instance w_none' });
  });
});

describe("an instance's reads", () => {
  it('lists a board\'s instances newest first, with how many in all, and finds a member\'s instance', () => {
    const a = apply();
    h.db.prepare('UPDATE kanban_workflow_instances SET created_at = ? WHERE instance_id = ?').run(NOW - 10, a.instance.instanceId);
    const b = apply({ idempotencyKey: 'operator:b' });
    expect(instancesOn(h.db, 'default', 200).instances.map((i) => i.instanceId)).toEqual([b.instance.instanceId, a.instance.instanceId]);
    expect(instancesOn(h.db, 'default', 1)).toMatchObject({ total: 2, instances: [{ instanceId: b.instance.instanceId }] });
    const m = b.members[1];
    expect(memberOf(h.db, m?.taskId ?? '')).toEqual({
      taskId: m?.taskId,
      instanceId: b.instance.instanceId,
      ref: 'evaluate:1',
      step: 'evaluate',
      item: 'acme',
      position: 1,
      name: 'vendor-eval',
    });
    expect(memberOf(h.db, newTask(h.db).taskId)).toBeUndefined();
  });

  it('finds a related task by a link from a member, and reads nothing on a database with no workflows yet', () => {
    const r = apply();
    const linked = newTask(h.db, { parents: [r.members[3]?.taskId ?? ''] });
    expect(relatedTasks(h.db, r.instance.instanceId).map((t) => t.taskId)).toEqual([linked.taskId]);
    const dir = mkdtempSync(join(tmpdir(), 'mt-wf-old-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) if (/^00[1-8]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      const old = openDb(join(dir, 'team.db'));
      try {
        migrate(old, only);
        expect(hasWorkflows(old)).toBe(false);
        expect(memberOf(old, newTask(old).taskId)).toBeUndefined();
      } finally {
        old.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 11.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-writer.test.ts`. Expected: `Tests  11 failed (11)`; the first failure: `TypeError: (0 , applyDag) is not a function`.

- [ ] **Step 11.3: Implement.**

In `src/db/WRITERS.md`, replace:

```markdown
| `kanban_chat_boards` | `db/kanban.ts` | One row per conversation and bot, written by `useBoard`; a chat with none is on `default`. |
```

with:

```markdown
| `kanban_chat_boards` | `db/kanban.ts` | One row per conversation and bot, written by `useBoard`; a chat with none is on `default`. |
| `kanban_workflow_instances` | `db/kanban.ts` | Added by `applyDag` (migration 009), in the transaction that makes every task, link, gate and member of the instance, a start's included (spec §21.8); never updated or deleted. `dag` is the DAG it was made from, its string values masked on write but its gates' commands; `dag_sha256` is of its canonical form, unmasked, and never printed. `idempotency_key` is kept for good, an archived instance's included. |
| `kanban_workflow_tasks` | `db/kanban.ts` | Added by `applyDag`, one row a task it made, in its transaction; never added later, changed or removed: a member is exactly what the apply made (spec §21.7). `item` is masked on write. Read by the workflow commands and by `task show`'s one line, and by nothing in the kernel. |
```

In `src/db/kanban-read.ts`, replace:

```ts
import type { Db } from './open.js';
```

with:

```ts
import type { Db } from './open.js';
import type { Dag } from '../kanban/dag.js';
```

In `src/db/kanban-read.ts`, replace:

```ts
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_runs'").get() !== undefined;
}
```

with:

```ts
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_runs'").get() !== undefined;
}

// ---------------------------------------------------------------------------
// Workflows (spec §21.7, §21.10)
// ---------------------------------------------------------------------------

/** One start of a workflow, or one apply of a DAG (spec §21.7). */
export interface InstanceRow {
  instanceId: string;
  /** The workflow's name, or null for a DAG with none. */
  name: string | null;
  /** The DAG it was made from, as stored: masked but for its gates. */
  dag: Dag;
  /** Of the DAG's canonical form, unmasked: how a repeated key tells the same DAG from another. Never printed. */
  dagSha256: string;
  source: 'start' | 'apply';
  board: string;
  createdBy: string;
  createdVia: CreatedVia;
  idempotencyKey: string | null;
  createdAt: number;
}

/** A task an instance made: its ref and step in the DAG, its item, and its place in the DAG's array. */
export interface MemberRow {
  taskId: string;
  instanceId: string;
  ref: string;
  step: string;
  item: string | null;
  position: number;
}

interface InstanceRaw {
  instance_id: string;
  name: string | null;
  dag: string;
  dag_sha256: string;
  source: string;
  board: string;
  created_by: string;
  created_via: string;
  idempotency_key: string | null;
  created_at: number;
}

interface MemberRaw {
  task_id: string;
  instance_id: string;
  ref: string;
  step: string;
  item: string | null;
  position: number;
}

const INSTANCE_COLS = 'instance_id, name, dag, dag_sha256, source, board, created_by, created_via, idempotency_key, created_at';
const MEMBER_COLS = 'task_id, instance_id, ref, step, item, position';

function decodeInstance(r: InstanceRaw): InstanceRow {
  return {
    instanceId: r.instance_id,
    name: r.name,
    dag: JSON.parse(r.dag) as Dag,
    dagSha256: r.dag_sha256,
    source: r.source as InstanceRow['source'],
    board: r.board,
    createdBy: r.created_by,
    createdVia: JSON.parse(r.created_via) as CreatedVia,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  };
}

function decodeMember(r: MemberRaw): MemberRow {
  return { taskId: r.task_id, instanceId: r.instance_id, ref: r.ref, step: r.step, item: r.item, position: r.position };
}

/** Whether the database has the workflows' tables: one not yet migrated to 009 has none (spec §21.7). */
export function hasWorkflows(db: Db): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_workflow_tasks'").get() !== undefined;
}

export function getInstance(db: Db, instanceId: string): InstanceRow | undefined {
  const row = db.prepare<[string], InstanceRaw>(`SELECT ${INSTANCE_COLS} FROM kanban_workflow_instances WHERE instance_id = ?`).get(instanceId);
  return row === undefined ? undefined : decodeInstance(row);
}

export function instanceByKey(db: Db, idempotencyKey: string): InstanceRow | undefined {
  const row = db
    .prepare<[string], InstanceRaw>(`SELECT ${INSTANCE_COLS} FROM kanban_workflow_instances WHERE idempotency_key = ?`)
    .get(idempotencyKey);
  return row === undefined ? undefined : decodeInstance(row);
}

/** An instance's members, in their DAG's order. */
export function membersOf(db: Db, instanceId: string): MemberRow[] {
  return db
    .prepare<[string], MemberRaw>(`SELECT ${MEMBER_COLS} FROM kanban_workflow_tasks WHERE instance_id = ? ORDER BY position`)
    .all(instanceId)
    .map(decodeMember);
}

/**
 * The instance a task is a member of, with the instance's workflow name, for
 * `task show`'s line (spec §21.10); undefined for a task that is none's, and on
 * a database not yet migrated, which has no members table.
 */
export function memberOf(db: Db, taskId: string): (MemberRow & { name: string | null }) | undefined {
  if (!hasWorkflows(db)) return undefined;
  const row = db
    .prepare<[string], MemberRaw & { name: string | null }>(
      `SELECT m.task_id, m.instance_id, m.ref, m.step, m.item, m.position, i.name
         FROM kanban_workflow_tasks m JOIN kanban_workflow_instances i ON i.instance_id = m.instance_id
        WHERE m.task_id = ?`,
    )
    .get(taskId);
  return row === undefined ? undefined : { ...decodeMember(row), name: row.name };
}

/** A board's instances, newest first, at most `limit` (spec §21.10), and how many it has in all. */
export function instancesOn(db: Db, board: string, limit: number): { instances: InstanceRow[]; total: number } {
  const instances = db
    .prepare<[string, number], InstanceRaw>(
      `SELECT ${INSTANCE_COLS} FROM kanban_workflow_instances WHERE board = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(board, limit)
    .map(decodeInstance);
  const total = db.prepare<[string], { n: number }>('SELECT count(*) AS n FROM kanban_workflow_instances WHERE board = ?').get(board)?.n ?? 0;
  return { instances, total };
}

/**
 * An instance's related tasks (spec §21.10): tasks that are not its members and
 * have a member as a parent, or as their `created_from_task`, oldest first.
 */
export function relatedTasks(db: Db, instanceId: string): TaskRow[] {
  return db
    .prepare<[string, string, string], TaskRaw>(
      `SELECT ${TASK_COLS} FROM kanban_tasks
        WHERE task_id NOT IN (SELECT task_id FROM kanban_workflow_tasks WHERE instance_id = ?)
          AND (created_from_task IN (SELECT task_id FROM kanban_workflow_tasks WHERE instance_id = ?)
               OR task_id IN (SELECT l.child_id FROM kanban_links l JOIN kanban_workflow_tasks m ON m.task_id = l.parent_id
                               WHERE m.instance_id = ?))
        ORDER BY created_at, rowid`,
    )
    .all(instanceId, instanceId, instanceId)
    .map(decodeTask);
}
```

In `src/db/kanban.ts`, replace:

```ts
import { newRunId, newTaskId } from '../core/ids.js';
import { isResumableProviderId } from '../provider-id.js';
import { NAME_PATTERN, RESERVED_BOARD_NAMES, visible } from '../names.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
```

with:

```ts
import { newRunId, newTaskId, newWorkflowId } from '../core/ids.js';
import { isResumableProviderId } from '../provider-id.js';
import { NAME_PATTERN, RESERVED_BOARD_NAMES, visible } from '../names.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { canonicalDag, maskDag, type Dag } from '../kanban/dag.js';
```

In `src/db/kanban.ts`, replace:

```ts
  getBoard,
```

with:

```ts
  getBoard,
  getInstance,
```

In `src/db/kanban.ts`, replace:

```ts
  isFinished,
```

with:

```ts
  instanceByKey,
  isFinished,
  membersOf,
```

In `src/db/kanban.ts`, replace:

```ts
  subscriptionsOf,
```

with:

```ts
  subscriptionsOf,
  type InstanceRow,
  type MemberRow,
```

In `src/db/kanban.ts`, replace:

```ts
  'board',
```

with:

```ts
  'board',
  // A workflow's instance, its name, and a member's ref and step (spec §21.8); its item is a param's text, and masked.
  'workflow',
  'workflowName',
  'ref',
  'step',
```

In `src/db/kanban.ts`, replace:

```ts
    return { ok: true, n: run.submissions };
  });
}
```

with:

```ts
    return { ok: true, n: run.submissions };
  });
}

// ---------------------------------------------------------------------------
// Workflows (spec §21.7, §21.8)
// ---------------------------------------------------------------------------

/** An instance to make: its name, its checked DAG and that DAG's hash, unmasked, and who makes it, how. */
export interface NewInstance {
  name: string | null;
  dag: Dag;
  sha256: string;
  source: 'start' | 'apply';
  /** The board it goes on; a run's goes on its task's, whatever this says. */
  board: string;
  createdBy: string;
  createdVia: CreatedVia;
  /** Namespaced as a task's (spec §3.1), or null for none. */
  idempotencyKey: string | null;
}

/** One of the DAG's tasks, as the writer makes it: its fields, its member fields, its parents as earlier positions, and its gates. */
export interface NewMember {
  task: Pick<
    NewTask,
    'title' | 'body' | 'contract' | 'assignee' | 'reviewer' | 'workspace' | 'priority' | 'failureLimit' | 'retryOnCrash' | 'maxRuntimeS'
  >;
  ref: string;
  step: string;
  item: string | null;
  /** The positions of its parents, each earlier in the array than it. */
  parents: readonly number[];
  gates: readonly { command: string; timeoutS: number }[];
}

/** What an apply made, or found made with its key: the instance, and its members with their tasks, in position order. */
export interface AppliedDag {
  instance: InstanceRow;
  members: Array<MemberRow & { task: TaskRow }>;
  existing: boolean;
}

/** An instance's members, each with its task. */
function membersWithTasks(d: Db, instanceId: string): Array<MemberRow & { task: TaskRow }> {
  return membersOf(d, instanceId).map((m) => ({ ...m, task: mustGet(d, m.taskId) }));
}

/**
 * Why a key's instance is not this start's or apply's (spec §21.6 step 0), or
 * undefined when it is a repeat: another board's is `other_board`; another
 * kind's, another workflow's, or another DAG's, `invalid`, naming it.
 */
export function keyRefused(
  existing: InstanceRow,
  want: { board: string; source: 'start' | 'apply'; name: string | null; sha256?: string },
): Refusal | undefined {
  const id = existing.instanceId;
  if (existing.board !== want.board) {
    return refuse('other_board', `instance ${id} was made with this idempotency key on board ${existing.board}, not ${want.board}`);
  }
  if (existing.source !== want.source) {
    return refuse(
      'invalid',
      `this idempotency key was used ${existing.source === 'start' ? 'to start a workflow' : 'to apply a DAG'}, as ${id}; ` +
        'a key used by a start is not used by an apply, nor the reverse',
    );
  }
  if (want.source === 'start' && existing.name !== want.name) {
    return refuse('invalid', `this idempotency key was used to start workflow ${existing.name ?? '(no workflow)'}, as ${id}, not ${want.name ?? '(no workflow)'}`);
  }
  if (want.source === 'apply' && want.sha256 !== undefined && existing.dagSha256 !== want.sha256) {
    return refuse('invalid', `this idempotency key was used to apply another DAG, as ${id}`);
  }
  return undefined;
}

/**
 * Make a checked DAG on the board, in one transaction (spec §21.8): the board
 * worked out (a run's task's for a run), the key looked up again, the guard
 * against two racing, the board checked live; then the instance with its DAG,
 * masked but for its gates; then each task through `insertTask`, with its
 * subscriptions and its `created` event carrying the instance, its links, its
 * gates through `insertGate`, and its member row. A refusal, or a member's
 * repeated ref, rolls everything back: all of it is made, or none.
 */
export function applyDag(db: Db, instance: NewInstance, members: readonly NewMember[], now: number): Result<AppliedDag> {
  return tx(db, (d) => {
    let board = instance.board;
    let createdFromTask: string | null = null;
    if (instance.createdVia.kind === 'run') {
      const run = getRun(d, instance.createdVia.runId);
      if (run === undefined) return refuse('not_found', `no run ${instance.createdVia.runId}`);
      createdFromTask = run.taskId;
      // A run's work stays on its task's board (spec §16.5).
      board = mustGet(d, run.taskId).board;
    }
    if (instance.idempotencyKey !== null) {
      const existing = instanceByKey(d, instance.idempotencyKey);
      if (existing !== undefined) {
        const refused = keyRefused(existing, { board, source: instance.source, name: instance.name, sha256: instance.sha256 });
        if (refused !== undefined) return refused;
        return { ok: true, instance: existing, members: membersWithTasks(d, existing.instanceId), existing: true };
      }
    }
    const live = liveBoard(d, board);
    if (!live.ok) return refuse(live.code, `${live.message}; nothing is added to it`);
    const instanceId = newWorkflowId();
    d.prepare(
      `INSERT INTO kanban_workflow_instances
         (instance_id, name, dag, dag_sha256, source, board, created_by, created_via, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      instanceId,
      instance.name,
      canonicalDag(maskDag(instance.dag)),
      instance.sha256,
      instance.source,
      board,
      instance.createdBy,
      JSON.stringify(instance.createdVia),
      instance.idempotencyKey,
      now,
    );
    const member = d.prepare(
      'INSERT INTO kanban_workflow_tasks (task_id, instance_id, ref, step, item, position) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const ids: string[] = [];
    for (const [position, m] of members.entries()) {
      const parents = m.parents.map((p) => {
        const id = ids[p];
        if (id === undefined) throw new Error(`member ${m.ref} names a parent at ${p}, which is not earlier`);
        return id;
      });
      const taskId = insertTask(
        d,
        { ...m.task, board, createdFromTask, parents, idempotencyKey: null, createdBy: instance.createdBy, createdVia: instance.createdVia },
        now,
        { workflow: instanceId, workflowName: instance.name, ref: m.ref, step: m.step, item: m.item },
      );
      for (const gate of m.gates) {
        // The apply put it on the task, for whoever made the instance (spec §21.8).
        const added = insertGate(d, taskId, gate, instance.createdBy, now, { workflow: instanceId });
        if (!added.ok) return refuse(added.code, `${m.ref}: ${added.message}`);
      }
      member.run(taskId, instanceId, m.ref, m.step, m.item === null ? null : mask(m.item), position);
      ids.push(taskId);
    }
    const made = getInstance(d, instanceId);
    if (made === undefined) throw new Error(`instance ${instanceId} vanished inside its own transaction`);
    return { ok: true, instance: made, members: membersWithTasks(d, instanceId), existing: false };
  });
}

/**
 * Archive an instance (spec §21.8, §21.10): every member not already archived,
 * in one transaction, through `archiveIn`, each `archived` event carrying the
 * instance. Answers the members it archived, and the runs it decided, whose
 * turns the caller cancels; none for an instance wholly archived already.
 */
export function archiveWorkflow(
  db: Db,
  instanceId: string,
  by: string,
  now: number,
): Result<{ instance: InstanceRow; archived: TaskRow[]; runs: RunRow[] }> {
  return tx(db, (d) => {
    const instance = getInstance(d, instanceId);
    if (instance === undefined) return refuse('not_found', `no workflow instance ${instanceId}`);
    const archived: TaskRow[] = [];
    const runs: RunRow[] = [];
    for (const m of membersOf(d, instanceId)) {
      const task = mustGet(d, m.taskId);
      if (task.phase === 'archived') continue;
      const r = archiveIn(d, task, by, now, { workflow: instanceId });
      archived.push(r.task);
      if (r.run !== undefined) runs.push(r.run);
    }
    return { ok: true, instance, archived, runs };
  });
}
```

- [ ] **Step 11.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2109 passed (2109)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 11.5: Commit.**

```bash
git add src/db/WRITERS.md src/db/kanban-read.ts src/db/kanban.ts tests/kanban-workflow-writer.test.ts
git commit -m "Write a workflow's instance in one transaction with applyDag, every task, link, gate and member, its tasks' created events carrying the instance and the key looked up again; archive every member with archiveWorkflow; and read an instance, its members and its related tasks"
```

---

### Task 12: The service: preview, start and apply

**Files:**

- Create: `tests/kanban-workflow-service.test.ts`
- Modify: `src/kanban/service.ts`

Spec §21.6. `KanbanServiceDeps.workflowsDir`. `previewWorkflow(req)`: the file read now, the expansion, the shape, and step 2's checks, the board's and the people's included, never the key's; nothing written. `startWorkflow(req)`: the workflow name's type, the board (a run's task's whatever else, else the one asked for, else `default`), the key namespaced as a task's and looked up first, read-only, so a repeat is answered even with the file removed or broken; then the expansion, step 2 and the writer. `applyDag(req)`: the DAG shaped, made canonical and measured first (`run` for a run's, else `terminal`), a run's DAG naming another board refused `other_board`; then the key, compared by the DAG's hash; step 2, and with `dryRun` an answer of what it would make or the instance its key made; else the writer. Step 2 (`#checkDag`) is the board as the database has it now and `checkDagTasks` with the team and the people as the process holds them. An unknown workflow is `unknown_workflow`, its message naming the usable ones and their params, cut at 4 KiB. `#idempotencyKey` now takes the key and the `createdVia`, its messages unchanged.

- [ ] **Step 12.1: Write the tests.**

Create `tests/kanban-workflow-service.test.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveBoard, archiveWorkflow, createBoard } from '../src/db/kanban.js';
import { eventsOf, getInstance, getTask, parentsOf } from '../src/db/kanban-read.js';
import { dagFile, type Dag } from '../src/kanban/dag.js';
import { KanbanService, type ApplyRequest, type StartRequest, type WorkflowMade } from '../src/kanban/service.js';
import type { CreatedVia, Result } from '../src/kanban/types.js';
import type { Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A start, a preview and an apply through the service (spec §21.6): the key
 * looked up first, the file read now, the checks, the one transaction, the
 * board in each path, the keys in their namespaces, a dry run, and what changes
 * between a preview and its apply.
 */

const SECRET = 'sk-live-1234567890';
const OPERATOR: CreatedVia = { kind: 'operator' };
const BOB = 'lark:on_bob';

let h: TestDb;
let dir: string;
let talks: Set<string>;
let roles: Map<string, Role>;
let service: KanbanService;

beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  h = testDb();
  dir = join(h.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
  talks = new Set([BOB]);
  roles = new Map([
    ['worker', role('worker')],
    ['reviewer', role('reviewer')],
    ['implementer', role('implementer')],
  ]);
  service = new KanbanService({
    db: h.db,
    roles,
    workspaces: new Set(['default', 'web']),
    people: { canTalk: (p) => talks.has(p) },
    supervisedRoles: true,
    workflowsDir: dir,
  });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

const PARAMS = { from: 'json', params: { topic: 'log storage', vendors: ['acme', 'globex'] } } as const;

function start(over: Partial<StartRequest> = {}): Result<WorkflowMade> {
  return service.startWorkflow({ workflow: 'vendor-eval', params: PARAMS, createdBy: ALICE, createdVia: VIA, ...over });
}

function made(r: Result<object>): WorkflowMade {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  if (!('instance' in r)) throw new Error('a dry run');
  return r as unknown as WorkflowMade;
}

const tasks = (): number => (h.db.prepare('SELECT count(*) AS n FROM kanban_tasks').get() as { n: number }).n;
const instances = (): number => (h.db.prepare('SELECT count(*) AS n FROM kanban_workflow_instances').get() as { n: number }).n;

function preview(over: Partial<StartRequest> = {}): Dag {
  const r = service.previewWorkflow({ workflow: 'vendor-eval', params: PARAMS, createdBy: 'operator:me', createdVia: OPERATOR, ...over });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.dag;
}

function apply(dag: unknown, over: Partial<ApplyRequest> = {}) {
  return service.applyDag({ dag, createdBy: 'operator:me', createdVia: OPERATOR, ...over });
}

describe('startWorkflow', () => {
  it("makes the expansion's tasks, links and gates, each created event carrying the instance, the chat following every one", () => {
    const r = made(start());
    expect(r.existing).toBe(false);
    expect(r.instance).toMatchObject({ name: 'vendor-eval', source: 'start', board: 'default' });
    expect(r.tasks.map((t) => [t.ref, t.task.title, t.task.assignee?.name])).toEqual([
      ['shortlist', 'Shortlist vendors for log storage', 'worker'],
      ['evaluate:1', 'Evaluate acme for log storage', 'worker'],
      ['evaluate:2', 'Evaluate globex for log storage', 'worker'],
      ['recommend', 'Recommend a vendor for log storage', 'worker'],
    ]);
    expect(r.tasks[3]?.task.reviewer).toEqual({ kind: 'role', name: 'reviewer' });
    expect(parentsOf(h.db, r.tasks[3]?.taskId ?? '').length).toBe(2);
    for (const t of r.tasks) {
      expect(eventsOf(h.db, t.taskId)[0]).toMatchObject({ kind: 'created', actor: ALICE, payload: { workflow: r.instance.instanceId, workflowName: 'vendor-eval', ref: t.ref, step: t.step, item: t.item } });
    }
  });

  it('refuses a broken file, an unknown workflow naming the usable ones, and one failure refuses the whole start, naming the task', () => {
    writeFileSync(join(dir, 'broken.yaml'), 'steps: {}\n');
    expect(start({ workflow: 'broken' })).toEqual({ ok: false, code: 'invalid', message: 'workflow broken is not usable: the file needs steps, at least one' });
    expect(start({ workflow: 'vendor-evl' })).toEqual({
      ok: false,
      code: 'unknown_workflow',
      message: 'there is no workflow vendor-evl; the usable ones are vendor-eval; their params: vendor-eval takes topic (required), vendors (list, required), reviewer (default reviewer)',
    });
    roles.delete('reviewer');
    expect(start()).toEqual({ ok: false, code: 'unknown_role', message: 'recommend: role "reviewer" is not configured' });
    roles.set('reviewer', role('reviewer'));
    writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL.replace('    title: Evaluate {{item}} for {{topic}}\n    assignee: worker\n', '    title: Evaluate {{item}} for {{topic}}\n    assignee: "{{item}}"\n'));
    expect(start({ params: { from: 'json', params: { topic: 'x', vendors: ['worker', 'evaluator'] } } })).toEqual({
      ok: false,
      code: 'unknown_role',
      message: 'evaluate:2, step evaluate, item "evaluator": role "evaluator" is not configured',
    });
    expect([tasks(), instances()]).toEqual([0, 0]);
  });

  it('cuts the message of unknown_workflow at 4 KiB, the names first, saying what was left out', () => {
    for (let i = 0; i < 300; i += 1) writeFileSync(join(dir, `w${String(i).padStart(3, '0')}-${'x'.repeat(20)}.yaml`), VENDOR_EVAL);
    const r = start({ workflow: 'nope' });
    expect(r.ok).toBe(false);
    const message = r.ok ? '' : r.message;
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(4096);
    expect(message).toMatch(/^there is no workflow nope; the usable ones are vendor-eval, w000-x+, w001-x+, /);
    expect(message).toMatch(/ and \d+ more(; the params of \d+ more left out)?$/);
  });

  it('answers a repeated key before the file is read, even once it is removed or broken, and refuses it for another workflow', () => {
    const first = made(start({ idempotencyKey: 'lark:om_1' }));
    rmSync(join(dir, 'vendor-eval.yaml'));
    expect(made(start({ idempotencyKey: 'lark:om_1' }))).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
    writeFileSync(join(dir, 'vendor-eval.yaml'), 'steps: {}\n');
    talks.clear();
    expect(made(start({ idempotencyKey: 'lark:om_1' })).tasks.map((t) => t.taskId)).toEqual(first.tasks.map((t) => t.taskId));
    writeFileSync(join(dir, 'release.yaml'), 'steps:\n  ship: { title: Ship, assignee: worker }\n');
    expect(start({ workflow: 'release', idempotencyKey: 'lark:om_1' })).toEqual({
      ok: false,
      code: 'invalid',
      message: `this idempotency key was used to start workflow vendor-eval, as ${first.instance.instanceId}, not release`,
    });
    expect(instances()).toBe(1);
  });

  it("keeps each path's keys in their namespace, refusing another's, and another board's key other_board", () => {
    expect(start({ idempotencyKey: 'operator:x' })).toEqual({ ok: false, code: 'invalid', message: 'an idempotency key starting operator: is for the terminal' });
    expect(start({ createdVia: OPERATOR, createdBy: 'operator:me', idempotencyKey: 'lark:om_1' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'an idempotency key starting lark: is for chat',
    });
    const term = made(start({ createdVia: OPERATOR, createdBy: 'operator:me', idempotencyKey: 'k' }));
    expect(term.instance.idempotencyKey).toBe('operator:k');
    createBoard(h.db, 'research', ALICE, NOW);
    expect(start({ createdVia: OPERATOR, createdBy: 'operator:me', idempotencyKey: 'k', board: 'research' })).toEqual({
      ok: false,
      code: 'other_board',
      message: `instance ${term.instance.instanceId} was made with this idempotency key on board default, not research`,
    });
    const planner = newTask(h.db, { assignee: { kind: 'role', name: 'implementer' } });
    const run = claimed(h.db, planner.taskId);
    const fromRun = made(start({ createdVia: { kind: 'run', runId: run.runId }, createdBy: `run:${run.runId}`, idempotencyKey: 'k' }));
    expect(fromRun.instance.idempotencyKey).toBe(`run-task:${planner.taskId}:k`);
  });

  it("puts a start on chat's or the terminal's board, refusing an archived one, and a run's on its task's, created from its task", () => {
    createBoard(h.db, 'research', ALICE, NOW);
    expect(made(start({ board: 'research' })).instance.board).toBe('research');
    createBoard(h.db, 'old', ALICE, NOW);
    archiveBoard(h.db, 'old', ALICE, NOW);
    expect(start({ board: 'old' })).toEqual({ ok: false, code: 'board_archived', message: 'board old is archived; nothing is added to it' });
    expect(start({ board: 'nowhere' })).toEqual({ ok: false, code: 'unknown_board', message: 'there is no board nowhere' });
    const planner = newTask(h.db, { assignee: { kind: 'role', name: 'implementer' } });
    const run = claimed(h.db, planner.taskId);
    const r = made(start({ createdVia: { kind: 'run', runId: run.runId }, createdBy: `run:${run.runId}`, board: 'research' }));
    expect(r.instance.board).toBe('default');
    for (const t of r.tasks) expect(t.task).toMatchObject({ board: 'default', createdFromTask: planner.taskId });
  });

  it('refuses any person at the terminal, and one without talk tier from chat', () => {
    const owned = 'params:\n  owner: { required: true }\nsteps:\n  a: { title: A, assignee: "{{owner}}" }\n';
    writeFileSync(join(dir, 'owned.yaml'), owned);
    const params = { from: 'json', params: { owner: BOB } } as const;
    expect(start({ workflow: 'owned', params, createdVia: OPERATOR, createdBy: 'operator:me' })).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: 'a: "lark:on_bob" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
    });
    expect(made(start({ workflow: 'owned', params })).tasks[0]?.task.assignee).toEqual({ kind: 'human', name: BOB });
    talks.clear();
    expect(start({ workflow: 'owned', params })).toMatchObject({ ok: false, code: 'person_not_assignable', message: expect.stringMatching(/^a: "lark:on_bob" cannot be given work: being assigned/) });
  });
});

describe('previewWorkflow', () => {
  it('makes nothing, refuses as a start would, and checks no key', () => {
    const dag = preview();
    expect(dag.tasks.map((t) => t.ref)).toEqual(['shortlist', 'evaluate:1', 'evaluate:2', 'recommend']);
    expect([tasks(), instances()]).toEqual([0, 0]);
    expect(service.previewWorkflow({ workflow: 'vendor-eval', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'workflow vendor-eval needs param topic: what is being bought',
    });
    made(start({ idempotencyKey: 'lark:om_1' }));
    expect(service.previewWorkflow({ workflow: 'vendor-eval', params: PARAMS, idempotencyKey: 'lark:om_1', createdBy: ALICE, createdVia: VIA }).ok).toBe(true);
  });
});

describe('applyDag', () => {
  it('makes what a start makes, from a preview, and stores the DAG with no file', () => {
    const dag = JSON.parse(dagFile(preview())) as unknown;
    const r = made(apply(dag));
    expect(r.instance).toMatchObject({ name: 'vendor-eval', source: 'apply' });
    expect(r.tasks.map((t) => [t.ref, t.task.title])).toEqual(made(start()).tasks.map((t) => [t.ref, t.task.title]));
    rmSync(join(dir, 'vendor-eval.yaml'));
    expect(getInstance(h.db, r.instance.instanceId)?.dag.tasks).toHaveLength(4);
  });

  it('refuses an unknown key, the wrong shape, before any existing answer, with a key already used', () => {
    const dag = JSON.parse(dagFile(preview())) as Record<string, unknown>;
    made(apply(dag, { idempotencyKey: 'k' }));
    expect(apply({ ...dag, colour: 'red' }, { idempotencyKey: 'k' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a DAG takes no key "colour" (it takes format, workflow, params, board, tasks)',
    });
  });

  it('answers a repeat of one DAG existing, refuses another DAG, and refuses a start\'s key and the reverse', () => {
    const dag = JSON.parse(dagFile(preview())) as Record<string, unknown>;
    const first = made(apply(dag, { idempotencyKey: 'k' }));
    const reindented = JSON.parse(JSON.stringify(dag, null, 9)) as unknown;
    expect(made(apply(reindented, { idempotencyKey: 'k' }))).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
    const other = JSON.parse(dagFile(preview({ params: { from: 'json', params: { topic: 'other', vendors: ['acme'] } } }))) as unknown;
    expect(apply(other, { idempotencyKey: 'k' })).toEqual({ ok: false, code: 'invalid', message: `this idempotency key was used to apply another DAG, as ${first.instance.instanceId}` });
    expect(start({ createdVia: OPERATOR, createdBy: 'operator:me', idempotencyKey: 'k' })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^this idempotency key was used to apply a DAG/) });
    made(start({ createdVia: OPERATOR, createdBy: 'operator:me', idempotencyKey: 's' }));
    expect(apply(dag, { idempotencyKey: 's' })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^this idempotency key was used to start a workflow/) });
  });

  it('with dryRun makes every check and writes nothing, answering what it would make, or the instance its key made', () => {
    const dag = JSON.parse(dagFile(preview())) as Record<string, unknown>;
    const dry = apply(dag, { dryRun: true });
    expect(dry).toMatchObject({ ok: true, dryRun: true, existing: false, instanceId: null, board: 'default' });
    expect(dry.ok && 'dryRun' in dry ? dry.tasks.map((t) => [t.ref, t.gates]) : []).toEqual([
      ['shortlist', []],
      ['evaluate:1', [{ command: 'test -s evaluation.md', timeout_s: 30 }]],
      ['evaluate:2', [{ command: 'test -s evaluation.md', timeout_s: 30 }]],
      ['recommend', []],
    ]);
    expect([tasks(), instances()]).toEqual([0, 0]);
    roles.delete('worker');
    expect(apply(dag, { dryRun: true })).toEqual({ ok: false, code: 'unknown_role', message: 'shortlist: role "worker" is not configured' });
    roles.set('worker', role('worker'));
    const first = made(apply(dag, { idempotencyKey: 'k' }));
    expect(apply(dag, { idempotencyKey: 'k', dryRun: true })).toMatchObject({ ok: true, dryRun: true, existing: true, instanceId: first.instance.instanceId });
  });

  it('checks again what changed since the preview: a role removed, a person without talk tier, a board archived', () => {
    createBoard(h.db, 'research', ALICE, NOW);
    const dag = JSON.parse(dagFile(preview({ board: 'research' }))) as Record<string, unknown>;
    roles.delete('reviewer');
    expect(apply(dag)).toEqual({ ok: false, code: 'unknown_role', message: 'recommend: role "reviewer" is not configured' });
    roles.set('reviewer', role('reviewer'));
    archiveBoard(h.db, 'research', ALICE, NOW);
    expect(apply(dag)).toEqual({ ok: false, code: 'board_archived', message: 'board research is archived; nothing is added to it' });
    const person = { format: 1, tasks: [{ ref: 'ask', title: 'Ask Bob', assignee: BOB }] };
    const planner = newTask(h.db, { assignee: { kind: 'role', name: 'implementer' } });
    const run = claimed(h.db, planner.taskId);
    const viaRun = { createdVia: { kind: 'run', runId: run.runId } as CreatedVia, createdBy: `run:${run.runId}` };
    expect(apply(person, viaRun).ok).toBe(true);
    talks.clear();
    expect(apply(person, viaRun)).toMatchObject({ ok: false, code: 'person_not_assignable' });
  });

  it('changes nothing for a file edited after its preview: the DAG is what is made', () => {
    const dag = JSON.parse(dagFile(preview())) as unknown;
    writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL.replace('Shortlist vendors for', 'Shortlist suppliers for'));
    expect(made(apply(dag)).tasks[0]?.task.title).toBe('Shortlist vendors for log storage');
  });

  it("takes gates at the terminal, refuses one holding the mask, and from a run refuses gates and a board not its task's", () => {
    const gated = { format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'worker', gates: [{ command: 'npm test' }] }] };
    expect(made(apply(gated)).tasks[0]?.task.taskId).toMatch(/^k_/);
    expect(apply({ format: 1, tasks: [{ ref: 'a', title: 'A', gates: [{ command: `curl ${MASK}` }] }] })).toMatchObject({ ok: false, code: 'invalid' });
    const planner = newTask(h.db, { assignee: { kind: 'role', name: 'implementer' } });
    const run = claimed(h.db, planner.taskId);
    const viaRun = { createdVia: { kind: 'run', runId: run.runId } as CreatedVia, createdBy: `run:${run.runId}` };
    expect(apply(gated, viaRun)).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/apply-dag takes none/) });
    createBoard(h.db, 'research', ALICE, NOW);
    const plain = { format: 1, board: 'research', tasks: [{ ref: 'a', title: 'A', assignee: 'worker' }] };
    expect(apply(plain, viaRun)).toEqual({ ok: false, code: 'other_board', message: "the DAG is for board research, and a run's work stays on its task's board, default" });
    const none = made(apply({ ...plain, board: null }, viaRun));
    expect(none.instance).toMatchObject({ name: null, board: 'default' });
    expect(none.tasks[0]?.task.createdFromTask).toBe(planner.taskId);
    expect(made(apply({ ...plain, board: 'default' }, viaRun)).instance.board).toBe('default');
  });

  it("stores a DAG's texts masked but its gates, and an archived instance's key stays used", () => {
    const dag = { format: 1, params: {}, tasks: [{ ref: 'a', title: `Use ${SECRET}`, assignee: 'worker', gates: [{ command: 'test -s $OUT' }] }] };
    const r = made(apply(dag, { idempotencyKey: 'k' }));
    expect(getInstance(h.db, r.instance.instanceId)?.dag.tasks[0]).toMatchObject({ title: `Use ${MASK}`, gates: [{ command: 'test -s $OUT', timeout_s: 300 }] });
    expect(getTask(h.db, r.tasks[0]?.taskId ?? '')?.title).toBe(`Use ${MASK}`);
    archiveWorkflow(h.db, r.instance.instanceId, ALICE, NOW);
    expect(made(apply(dag, { idempotencyKey: 'k' })).existing).toBe(true);
  });
});
```

- [ ] **Step 12.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-service.test.ts`. Expected: `Tests  16 failed (16)`; the first failure: `TypeError: service.startWorkflow is not a function`.

- [ ] **Step 12.3: Implement.**

In `src/kanban/service.ts`, replace:

```ts
  getTask,
```

with:

```ts
  getTask,
  instanceByKey,
  membersOf,
```

In `src/kanban/service.ts`, replace:

```ts
  type CardReading,
```

with:

```ts
  type CardReading,
  type InstanceRow,
  type MemberRow,
```

In `src/kanban/service.ts`, replace:

```ts
import { commitReader, type CommitReader } from './commit.js';
```

with:

```ts
import { commitReader, type CommitReader } from './commit.js';
import { checkDagShape, checkDagTasks, type Dag, type DagTask, type ShapedDag } from './dag.js';
```

In `src/kanban/service.ts`, replace:

```ts
import { limitsReached, workspaceBusy } from './waiting.js';
```

with:

```ts
import { limitsReached, workspaceBusy } from './waiting.js';
import {
  expand,
  listWorkflows,
  paramsLine,
  readWorkflow,
  type GivenParams,
  type PersonOf,
  type Workflow,
  type WorkflowFacts,
} from './workflow.js';
```

In `src/kanban/service.ts`, replace:

```ts
  maxRunningPerRole?: number;
```

with:

```ts
  maxRunningPerRole?: number;
  /**
   * Where the workflow files are, `$MT_HOME/workflows` (spec §21.1), read at each
   * preview and start. Absent -- tests of the board alone -- there are none.
   */
  workflowsDir?: string;
```

In `src/kanban/service.ts`, replace:

```ts
  board?: string;
```

with:

```ts
  board?: string;
}

/** A workflow to start (spec §21.6), as chat, the terminal or a run asks for it. Nothing is checked yet. */
export interface StartRequest {
  workflow: string;
  params: GivenParams;
  /** Chat's: a value starting with `@`, in a param that lands in a person field, as the principal it mentions. */
  personOf?: PersonOf;
  /** As a task's: chat's message, the terminal's `--key`, a run's `idempotency_key`; namespaced here. */
  idempotencyKey?: string;
  createdBy: string;
  createdVia: CreatedVia;
  /** Chat's board, or the terminal's `--board`, else `default`; a run's is its task's, whatever this says. */
  board?: string;
}

/** A DAG to make (spec §21.6), parsed but not yet checked: the terminal's file, or a run's `apply-dag` input without its own keys. */
export interface ApplyRequest {
  dag: unknown;
  idempotencyKey?: string;
  /** Every check, and nothing written (spec §21.6). */
  dryRun?: boolean;
  createdBy: string;
  createdVia: CreatedVia;
}

/** What a start or an apply made, or found made with its key: the instance, and its members with their tasks. */
export interface WorkflowMade {
  instance: InstanceRow;
  tasks: Array<MemberRow & { task: TaskRow }>;
  existing: boolean;
}

/** A dry run's answer (spec §21.6): what the apply would make, or the instance its key already made; nothing written. */
export interface WorkflowDryRun {
  dryRun: true;
  existing: boolean;
  instanceId: string | null;
  board: string;
  tasks: DagTask[];
}

/** How long `unknown_workflow`'s message may be, in bytes: a gate refusal's output's size (spec §21.6). */
export const WORKFLOW_MESSAGE_BYTES = 4 * 1024;

/** An instance's members, each with its task. */
function madeTasks(db: Db, instanceId: string): Array<MemberRow & { task: TaskRow }> {
  return membersOf(db, instanceId).flatMap((m) => {
    const task = getTask(db, m.taskId);
    return task === undefined ? [] : [{ ...m, task }];
  });
```

In `src/kanban/service.ts`, replace:

```ts
  readonly #maxRunningPerRole: number | undefined;
```

with:

```ts
  readonly #maxRunningPerRole: number | undefined;
  readonly #workflowsDir: string | undefined;
```

In `src/kanban/service.ts`, replace:

```ts
    this.#maxRunningPerRole = deps.maxRunningPerRole;
```

with:

```ts
    this.#maxRunningPerRole = deps.maxRunningPerRole;
    this.#workflowsDir = deps.workflowsDir;
```

In `src/kanban/service.ts`, replace:

```ts
    const key = this.#idempotencyKey(req);
```

with:

```ts
    const key = this.#idempotencyKey(req.idempotencyKey, req.createdVia);
```

In `src/kanban/service.ts`, replace:

```ts

  /** Who the next claim is for, resolved against the team as it is now. */
```

with:

```ts

  // -------------------------------------------------------------------------
  // Workflows (spec §21.6)
  // -------------------------------------------------------------------------

  /** The team, as a workflow file is checked against it (spec §21.4). */
  #workflowFacts(): WorkflowFacts {
    return { roles: this.#roles, workspaces: this.#workspaces, supervisedRoles: this.#supervisedRoles };
  }

  /**
   * A workflow, read now (spec §21.4), or the refusal a start gets: for no
   * usable file of that name, `unknown_workflow`, naming the usable ones and
   * their params, cut at 4 KiB, the names first.
   */
  #workflow(name: unknown): Result<{ workflow: Workflow }> {
    const dir = this.#workflowsDir;
    const read =
      dir === undefined ? board.refuse('unknown_workflow', `there is no workflow ${visible(JSON.stringify(String(name)))}`) : readWorkflow(dir, name as string, this.#workflowFacts());
    if (read.ok || read.code !== 'unknown_workflow') return read;
    return board.refuse('unknown_workflow', this.#usable(read.message));
  }

  /** `message`, then the usable workflows and their params, at most 4 KiB: the names first, then the params, saying how many were left out. */
  #usable(message: string): string {
    const usable = this.#workflowsDir === undefined ? [] : listWorkflows(this.#workflowsDir, this.#workflowFacts()).usable;
    if (usable.length === 0) return `${message}; there are no usable workflows`;
    const max = WORKFLOW_MESSAGE_BYTES;
    // Room kept at each step for what may still be said after it.
    const room = 64;
    const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') + room <= max;
    let text = `${message}; the usable ones are`;
    let names = 0;
    for (const w of usable) {
      const next = `${text}${names === 0 ? ' ' : ', '}${w.name}`;
      if (!fits(next)) break;
      text = next;
      names += 1;
    }
    if (names < usable.length) text += ` and ${usable.length - names} more`;
    let params = 0;
    for (const w of usable.slice(0, names)) {
      const next = `${text}${params === 0 ? '; their params: ' : '; '}${w.name} takes ${paramsLine(w)}`;
      if (!fits(next)) break;
      text = next;
      params += 1;
    }
    if (params < names) text += `; the params of ${names - params} more left out`;
    return text;
  }

  /** The board a start or an apply goes on (spec §21.6): a run's task's, whatever else; otherwise the one asked for, else `default`. */
  #boardFor(via: CreatedVia, asked: string | null | undefined): Result<{ board: string; run?: RunRow }> {
    if (via.kind !== 'run') return { ok: true, board: asked ?? DEFAULT_BOARD };
    const run = getRun(this.#db, via.runId);
    if (run === undefined) return board.refuse('not_found', `no run ${via.runId}`);
    const task = getTask(this.#db, run.taskId);
    if (task === undefined) return board.refuse('not_found', `no task ${run.taskId}`);
    return { ok: true, board: task.board, run };
  }

  /**
   * Step 2 of an apply (spec §21.6): the board as the database has it now, then
   * every task checked as `create` would, every gate as `addGate`, every name,
   * against the team and the people as this process holds them, just before the
   * transaction, so a refusal costs none.
   */
  #checkDag(dag: Dag, onBoard: string, createdBy: string, createdVia: CreatedVia): Refusal | undefined {
    const found = getBoard(this.#db, onBoard);
    if (found === undefined) return board.refuse('unknown_board', `there is no board ${visible(onBoard)}`);
    if (found.archivedAt !== null) return board.refuse('board_archived', `board ${onBoard} is archived; nothing is added to it`);
    return checkDagTasks(dag, { facts: this.#facts(), createdBy, createdVia });
  }

  /** The writer's members of a checked DAG: each task's fields, its parents as earlier positions, its gates. */
  #members(dag: Dag): board.NewMember[] {
    const at = new Map(dag.tasks.map((t, i) => [t.ref, i]));
    const as = (name: string | null): Assignee | null => (name === null ? null : { kind: name.includes(':') ? 'human' : 'role', name });
    return dag.tasks.map((t) => ({
      task: {
        title: t.title,
        ...(t.body === null ? {} : { body: t.body }),
        contract: t.contract,
        assignee: as(t.assignee),
        reviewer: as(t.reviewer),
        workspace: t.workspace,
        priority: t.priority,
        failureLimit: t.failure_limit,
        retryOnCrash: t.retry_on_crash,
        maxRuntimeS: t.max_runtime_s,
      },
      ref: t.ref,
      step: t.step,
      item: t.item,
      parents: t.parents.map((p) => at.get(p) ?? -1),
      gates: t.gates.map((g) => ({ command: g.command, timeoutS: g.timeout_s })),
    }));
  }

  /** A start's expansion (spec §21.6 step 1): the file read now, its params, the DAG made, shaped and measured. */
  #expanded(req: StartRequest, onBoard: string): Result<ShapedDag & { workflow: Workflow }> {
    if (!isRecord(req)) return board.refuse('invalid', 'a start is an object');
    if (!isText(req.workflow)) return board.refuse('invalid', "a workflow is a workflow's name, as text");
    const read = this.#workflow(req.workflow);
    if (!read.ok) return read;
    const expanded = expand(read.workflow, req.params, onBoard, req.personOf);
    if (!expanded.ok) return expanded;
    const shaped = checkDagShape(expanded.dag, 'expansion');
    if (!shaped.ok) return shaped;
    return { ...shaped, workflow: read.workflow };
  }

  /**
   * What a start would make, making nothing (spec §21.6): every check a start
   * makes before its transaction, the board's and the people's included, but
   * not the key's, as a preview has none of its own.
   */
  previewWorkflow(req: StartRequest): Result<{ dag: Dag; workflow: Workflow }> {
    const on = this.#boardFor(req.createdVia, req.board);
    if (!on.ok) return on;
    const shaped = this.#expanded(req, on.board);
    if (!shaped.ok) return shaped;
    const refused = this.#checkDag(shaped.dag, on.board, req.createdBy, req.createdVia);
    if (refused !== undefined) return refused;
    return { ok: true, dag: shaped.dag, workflow: shaped.workflow };
  }

  /**
   * Start a workflow (spec §21.6): its key looked up first, read-only, so a
   * repeat is answered whatever the file says now; then the expansion, the
   * checks, and the one transaction. The caller tells the dispatcher.
   */
  startWorkflow(req: StartRequest): Result<WorkflowMade> {
    if (!isRecord(req)) return board.refuse('invalid', 'a start is an object');
    if (!isText(req.workflow)) return board.refuse('invalid', "a workflow is a workflow's name, as text");
    const on = this.#boardFor(req.createdVia, req.board);
    if (!on.ok) return on;
    const key = this.#idempotencyKey(req.idempotencyKey, req.createdVia);
    if (!key.ok) return key;
    const repeat = key.key === null ? undefined : this.#repeat(key.key, { board: on.board, source: 'start', name: req.workflow });
    if (repeat !== undefined) return repeat;
    const shaped = this.#expanded(req, on.board);
    if (!shaped.ok) return shaped;
    const refused = this.#checkDag(shaped.dag, on.board, req.createdBy, req.createdVia);
    if (refused !== undefined) return refused;
    return this.#write(shaped, { name: shaped.workflow.name, source: 'start', board: on.board, key: key.key, createdBy: req.createdBy, createdVia: req.createdVia });
  }

  /**
   * Make a DAG (spec §21.6), at the terminal or from a run: read already, it is
   * shaped, made canonical and measured first, as an unknown key or the wrong
   * shape is no DAG at all; then its key is looked up, compared by the DAG's
   * hash; then the checks, and with `dryRun` nothing more; else the one
   * transaction. A run's DAG takes no gates, and its board is its task's.
   */
  applyDag(req: ApplyRequest): Result<WorkflowMade | WorkflowDryRun> {
    if (!isRecord(req)) return board.refuse('invalid', 'an apply is an object');
    const shaped = checkDagShape(req.dag, req.createdVia?.kind === 'run' ? 'run' : 'terminal');
    if (!shaped.ok) return shaped;
    const on = this.#boardFor(req.createdVia, shaped.dag.board);
    if (!on.ok) return on;
    if (on.run !== undefined && shaped.dag.board !== null && shaped.dag.board !== on.board) {
      return board.refuse(
        'other_board',
        `the DAG is for board ${visible(shaped.dag.board)}, and a run's work stays on its task's board, ${on.board}`,
      );
    }
    const key = this.#idempotencyKey(req.idempotencyKey, req.createdVia);
    if (!key.ok) return key;
    const want = { board: on.board, source: 'apply' as const, name: shaped.dag.workflow, sha256: shaped.sha256 };
    const repeat = key.key === null ? undefined : this.#repeat(key.key, want);
    if (repeat !== undefined) {
      if (!repeat.ok || req.dryRun !== true) return repeat;
      return { ok: true, dryRun: true, existing: true, instanceId: repeat.instance.instanceId, board: on.board, tasks: shaped.dag.tasks };
    }
    const refused = this.#checkDag(shaped.dag, on.board, req.createdBy, req.createdVia);
    if (refused !== undefined) return refused;
    if (req.dryRun === true) return { ok: true, dryRun: true, existing: false, instanceId: null, board: on.board, tasks: shaped.dag.tasks };
    return this.#write(shaped, { name: shaped.dag.workflow, source: 'apply', board: on.board, key: key.key, createdBy: req.createdBy, createdVia: req.createdVia });
  }

  /** A key's instance, read-only (spec §21.6 step 0): the repeat's answer, or why the key is another's; undefined for a key not used. */
  #repeat(key: string, want: Parameters<typeof board.keyRefused>[1]): Result<WorkflowMade> | undefined {
    const existing = instanceByKey(this.#db, key);
    if (existing === undefined) return undefined;
    const refused = board.keyRefused(existing, want);
    if (refused !== undefined) return refused;
    return { ok: true, instance: existing, tasks: madeTasks(this.#db, existing.instanceId), existing: true };
  }

  /** The one transaction (spec §21.6 step 3). */
  #write(
    shaped: ShapedDag,
    i: { name: string | null; source: 'start' | 'apply'; board: string; key: string | null; createdBy: string; createdVia: CreatedVia },
  ): Result<WorkflowMade> {
    const r = board.applyDag(
      this.#db,
      {
        name: i.name,
        dag: shaped.dag,
        sha256: shaped.sha256,
        source: i.source,
        board: i.board,
        createdBy: i.createdBy,
        createdVia: i.createdVia,
        idempotencyKey: i.key,
      },
      this.#members(shaped.dag),
      this.#clock.now(),
    );
    if (!r.ok) return r;
    return { ok: true, instance: r.instance, tasks: r.members, existing: r.existing };
  }

  /** Who the next claim is for, resolved against the team as it is now. */
```

In `src/kanban/service.ts`, replace:

```ts
   * terminal gets its own tasks back, never a chat's or a run's.
   */
  #idempotencyKey(req: CreateRequest): Result<{ key: string | null }> {
    const key: unknown = req.idempotencyKey;
```

with:

```ts
   * terminal gets its own tasks back, never a chat's or a run's. A workflow's
   * instance is keyed the same way (spec §21.6).
   */
  #idempotencyKey(key: unknown, via: CreatedVia): Result<{ key: string | null }> {
```

In `src/kanban/service.ts`, replace:

```ts
    if (req.createdVia.kind !== 'chat' && key.startsWith(CHAT_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${CHAT_KEY} is for chat`);
    }
    if (req.createdVia.kind !== 'operator' && key.startsWith(OPERATOR_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${OPERATOR_KEY} is for the terminal`);
    }
    if (req.createdVia.kind === 'operator') return { ok: true, key: `${OPERATOR_KEY}${key}` };
    if (req.createdVia.kind !== 'run') return { ok: true, key };
    const run = getRun(this.#db, req.createdVia.runId);
    if (run === undefined) return board.refuse('not_found', `no run ${req.createdVia.runId}`);
```

with:

```ts
    if (via.kind !== 'chat' && key.startsWith(CHAT_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${CHAT_KEY} is for chat`);
    }
    if (via.kind !== 'operator' && key.startsWith(OPERATOR_KEY)) {
      return board.refuse('invalid', `an idempotency key starting ${OPERATOR_KEY} is for the terminal`);
    }
    if (via.kind === 'operator') return { ok: true, key: `${OPERATOR_KEY}${key}` };
    if (via.kind !== 'run') return { ok: true, key };
    const run = getRun(this.#db, via.runId);
    if (run === undefined) return board.refuse('not_found', `no run ${via.runId}`);
```

- [ ] **Step 12.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2125 passed (2125)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 12.5: Commit.**

```bash
git add src/kanban/service.ts tests/kanban-workflow-service.test.ts
git commit -m "Preview, start and apply a workflow through the service: the key looked up first, the file read at each start, the board in each path, every task and gate checked just before the one transaction, and a dry run that writes nothing"
```

---

### Task 13: The service: list, instances, show and archive

**Files:**

- Create: `tests/kanban-workflow-instances.test.ts`
- Modify: `src/kanban/service.ts`, `src/kanban/workflow.ts`

Spec §21.10. `instanceStatus(phases)` (`workflow.ts`), pure: archived when every member is, done when every one is done or archived, blocked when any is, with the count, running otherwise. The service's `workflows()` reads the directory now; `instances(board, all)` reads the board's 200 newest, the running and blocked unless `all`, with the total; `instance(id)` gives the members with their display status, the file's description while it is there, the related tasks apart, and another instance whose members are related as one entry; `archiveWorkflow(id, by)` archives every member through the writer.

- [ ] **Step 13.1: Write the tests.**

Create `tests/kanban-workflow-instances.test.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archive, block, closeRun, complete, createTask } from '../src/db/kanban.js';
import { getRun, getTask } from '../src/db/kanban-read.js';
import { KanbanService, type WorkflowMade } from '../src/kanban/service.js';
import type { Phase, Result } from '../src/kanban/types.js';
import { instanceStatus } from '../src/kanban/workflow.js';
import { clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * Seeing and managing workflows (spec §21.10): the derived status, `list`,
 * `instances`, `show`'s members and related tasks, and `archive`.
 */

let h: TestDb;
let dir: string;
let service: KanbanService;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  dir = join(h.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
  service = new KanbanService({
    db: h.db,
    roles: new Map([
      ['worker', role('worker')],
      ['reviewer', role('reviewer')],
    ]),
    workspaces: new Set(['default']),
    supervisedRoles: true,
    workflowsDir: dir,
  });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

function start(key?: string): WorkflowMade {
  const r: Result<WorkflowMade> = service.startWorkflow({
    workflow: 'vendor-eval',
    params: { from: 'json', params: { topic: 'logs', vendors: ['acme', 'globex'] } },
    createdBy: ALICE,
    createdVia: VIA,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r;
}

/** A member done, through its run. */
function finish(taskId: string): void {
  const run = claimed(h.db, taskId);
  const r = complete(h.db, taskId, { kind: 'run', runId: run.runId }, { summary: 'done' }, NOW);
  if (!r.ok) throw new Error(r.message);
  // Its turn over: the workspace is free for the next.
  if (!closeRun(h.db, run.runId, NOW).ok) throw new Error(`run ${run.runId} did not close`);
}

describe('instanceStatus', () => {
  it('is archived, done, blocked with its count, or running, counting an archived member as finished', () => {
    const of = (...phases: Phase[]) => instanceStatus(phases);
    expect(of('archived', 'archived')).toEqual({ status: 'archived', done: 2, total: 2, blocked: 0 });
    expect(of('done', 'archived', 'done')).toEqual({ status: 'done', done: 3, total: 3, blocked: 0 });
    expect(of('done', 'blocked', 'blocked', 'open')).toEqual({ status: 'blocked', done: 1, total: 4, blocked: 2 });
    expect(of('done', 'open', 'review')).toEqual({ status: 'running', done: 1, total: 3, blocked: 0 });
  });
});

describe('workflows', () => {
  it('lists the usable files and each broken one with why, read at each call', () => {
    writeFileSync(join(dir, 'broken.yaml'), 'steps: {}\n');
    const list = service.workflows();
    expect(list.usable.map((w) => w.name)).toEqual(['vendor-eval']);
    expect(list.broken).toEqual([{ name: 'broken', problem: 'the file needs steps, at least one' }]);
    rmSync(join(dir, 'broken.yaml'));
    expect(service.workflows().broken).toEqual([]);
  });
});

describe('instances', () => {
  it('lists the running and blocked by default, newest first, and every one with all', () => {
    const a = start();
    for (const t of a.tasks) archive(h.db, t.taskId, ALICE, NOW);
    const b = start();
    const c = start();
    const r = block(h.db, c.tasks[0]?.taskId ?? '', { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which logs?' }, NOW);
    expect(r.ok).toBe(true);
    const ids = (all: boolean) => service.instances('default', all).instances.map((i) => [i.instance.instanceId, i.status]);
    expect(ids(false)).toEqual(
      expect.arrayContaining([
        [b.instance.instanceId, 'running'],
        [c.instance.instanceId, 'blocked'],
      ]),
    );
    expect(ids(false)).toHaveLength(2);
    expect(ids(true)).toHaveLength(3);
    expect(service.instances('default', true)).toMatchObject({ total: 3, read: 3 });
    expect(service.instances('elsewhere', true)).toEqual({ instances: [], total: 0, read: 0 });
  });
});

describe('instance', () => {
  it("gives the members in position order with their status, the file's description, and the related tasks apart", () => {
    const r = start();
    const shortlist = r.tasks[0]?.taskId ?? '';
    finish(shortlist);
    const run = claimed(h.db, r.tasks[1]?.taskId ?? '');
    const follow = createTask(h.db, { title: 'Follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW);
    if (!follow.ok) throw new Error(follow.message);
    const shown = service.instance(r.instance.instanceId);
    if (!shown.ok) throw new Error(shown.message);
    const v = shown.view;
    expect(v.description).toBe('Shortlist vendors, evaluate each in parallel, then recommend one');
    expect(v.members.map((m) => [m.ref, m.item, m.status])).toEqual([
      ['shortlist', null, 'done'],
      ['evaluate:1', 'acme', 'running'],
      ['evaluate:2', 'globex', 'ready'],
      ['recommend', null, 'todo'],
    ]);
    expect(v.related.map((x) => x.task.taskId)).toEqual([follow.task.taskId]);
    expect(v).toMatchObject({ status: 'running', done: 1, total: 4, blocked: 0, relatedInstances: [] });
    rmSync(join(dir, 'vendor-eval.yaml'));
    expect(service.instance(r.instance.instanceId)).toMatchObject({ ok: true, view: { description: undefined } });
    expect(service.instance('w_none')).toEqual({ ok: false, code: 'not_found', message: 'no workflow instance w_none' });
  });

  it('shows another instance its deciding step started as one related line', () => {
    const first = start();
    const decider = first.tasks[0]?.taskId ?? '';
    const run = claimed(h.db, decider);
    const second = service.startWorkflow({
      workflow: 'vendor-eval',
      params: { from: 'json', params: { topic: 'more', vendors: ['initech'] } },
      createdBy: `run:${run.runId}`,
      createdVia: { kind: 'run', runId: run.runId },
    });
    if (!second.ok) throw new Error(second.message);
    const shown = service.instance(first.instance.instanceId);
    expect(shown.ok && shown.view.related).toEqual([]);
    expect(shown.ok && shown.view.relatedInstances).toEqual([{ instanceId: second.instance.instanceId, name: 'vendor-eval', tasks: 3 }]);
  });
});

describe('archiveWorkflow', () => {
  it('archives every member, superseding an undecided run, a done task keeping its time, and a second archive changes nothing', () => {
    const r = start();
    const shortlist = r.tasks[0]?.taskId ?? '';
    finish(shortlist);
    const doneAt = getTask(h.db, shortlist)?.closedAt;
    const run = claimed(h.db, r.tasks[1]?.taskId ?? '');
    const done = service.archiveWorkflow(r.instance.instanceId, ALICE);
    if (!done.ok) throw new Error(done.message);
    expect(done.archived).toHaveLength(4);
    expect(done.runs.map((x) => x.runId)).toEqual([run.runId]);
    expect(getRun(h.db, run.runId)?.outcome).toBe('superseded');
    expect(getTask(h.db, shortlist)).toMatchObject({ phase: 'archived', closedAt: doneAt });
    expect(service.instance(r.instance.instanceId)).toMatchObject({ ok: true, view: { status: 'archived', done: 4 } });
    expect(service.archiveWorkflow(r.instance.instanceId, ALICE)).toMatchObject({ ok: true, archived: [], runs: [] });
    expect(service.archiveWorkflow(r.instance.instanceId, ' ')).toEqual({ ok: false, code: 'invalid', message: 'who archives is text, not blank' });
  });

  it('counts a member archived by hand among done ones as finished', () => {
    const r = start();
    for (const t of r.tasks.slice(0, 3)) finish(t.taskId);
    archive(h.db, r.tasks[3]?.taskId ?? '', ALICE, NOW);
    expect(service.instance(r.instance.instanceId)).toMatchObject({ ok: true, view: { status: 'done', done: 4, total: 4 } });
  });
});
```

- [ ] **Step 13.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-instances.test.ts`. Expected: `Tests  7 failed (7)`; the first failure: `TypeError: (0 , instanceStatus) is not a function`.

- [ ] **Step 13.3: Implement.**

In `src/kanban/service.ts`, replace:

```ts
  getRun,
  getTask,
  instanceByKey,
  membersOf,
  runsOf,
```

with:

```ts
  getInstance,
  getRun,
  getTask,
  instanceByKey,
  instancesOn,
  memberOf,
  membersOf,
  relatedTasks,
  runsOf,
  statusOf,
```

In `src/kanban/service.ts`, replace:

```ts
import {
  expand,
```

with:

```ts
import type { DisplayStatus } from './status.js';
import {
  expand,
  instanceStatus,
```

In `src/kanban/service.ts`, replace:

```ts
  type PersonOf,
  type Workflow,
  type WorkflowFacts,
```

with:

```ts
  type InstanceState,
  type PersonOf,
  type Workflow,
  type WorkflowFacts,
  type WorkflowList,
```

In `src/kanban/service.ts`, replace:

```ts
  tasks: DagTask[];
}

```

with:

```ts
  tasks: DagTask[];
}

/** An instance as `instances` lists it: the row, and its status. */
export interface InstanceSummary extends InstanceState {
  instance: InstanceRow;
}

/** One instance as `show` gives it (spec §21.10). */
export interface InstanceView extends InstanceState {
  instance: InstanceRow;
  /** The workflow file's description, while the file is there and usable; undefined otherwise. */
  description: string | undefined;
  members: Array<MemberRow & { task: TaskRow; status: DisplayStatus }>;
  /** Tasks that are not members, with a member as a parent or as their created_from_task, and not another instance's. */
  related: Array<{ task: TaskRow; status: DisplayStatus }>;
  /** Other instances whose members are related to this one, as a deciding step's start makes: one line each. */
  relatedInstances: Array<{ instanceId: string; name: string | null; tasks: number }>;
}

/** How many of a board's newest instances `instances` reads (spec §21.7). */
export const INSTANCES_READ = 200;

```

In `src/kanban/service.ts`, replace:

```ts

  /** Who the next claim is for, resolved against the team as it is now. */
```

with:

```ts

  /** The workflow files as the directory holds them now (spec §21.10): `list`'s. */
  workflows(): WorkflowList {
    return this.#workflowsDir === undefined ? { usable: [], broken: [], ignored: [] } : listWorkflows(this.#workflowsDir, this.#workflowFacts());
  }

  /**
   * A board's instances, newest first (spec §21.10): of its 200 most recent, the
   * running and blocked ones, or with `all` every one, each with its status; and
   * how many the board has in all.
   */
  instances(onBoard: string, all = false): { instances: InstanceSummary[]; total: number; read: number } {
    if (!isText(onBoard)) return { instances: [], total: 0, read: 0 };
    const { instances, total } = instancesOn(this.#db, onBoard, INSTANCES_READ);
    const summaries = instances.map((instance) => ({ instance, ...this.#state(instance.instanceId) }));
    return {
      instances: all ? summaries : summaries.filter((s) => s.status === 'running' || s.status === 'blocked'),
      total,
      read: instances.length,
    };
  }

  /** An instance's status, from its members' phases. */
  #state(instanceId: string): InstanceState {
    return instanceStatus(madeTasks(this.#db, instanceId).map((m) => m.task.phase));
  }

  /**
   * One instance in detail, on any board, by id (spec §21.10): its members, in
   * position order, with their display status; its description, while its file
   * is still there; and its related tasks, apart, a member of another instance
   * among them shown as that instance.
   */
  instance(instanceId: string): Result<{ view: InstanceView }> {
    if (!isText(instanceId)) return board.refuse('invalid', 'an instance id is text');
    const instance = getInstance(this.#db, instanceId);
    if (instance === undefined) return board.refuse('not_found', `no workflow instance ${visible(instanceId)}`);
    const members = madeTasks(this.#db, instanceId).map((m) => ({ ...m, status: statusOf(this.#db, m.task) }));
    const related: InstanceView['related'] = [];
    const others = new Map<string, { instanceId: string; name: string | null; tasks: number }>();
    for (const task of relatedTasks(this.#db, instanceId)) {
      const member = memberOf(this.#db, task.taskId);
      if (member === undefined) {
        related.push({ task, status: statusOf(this.#db, task) });
        continue;
      }
      const seen = others.get(member.instanceId) ?? { instanceId: member.instanceId, name: member.name, tasks: 0 };
      seen.tasks += 1;
      others.set(member.instanceId, seen);
    }
    const file = instance.name === null || this.#workflowsDir === undefined ? undefined : readWorkflow(this.#workflowsDir, instance.name, this.#workflowFacts());
    return {
      ok: true,
      view: {
        instance,
        description: file?.ok === true ? file.workflow.description : undefined,
        members,
        related,
        relatedInstances: [...others.values()],
        ...instanceStatus(members.map((m) => m.task.phase)),
      },
    };
  }

  /**
   * Archive every member of an instance not already archived, in one transaction
   * (spec §21.10): an undecided run superseded, whose turn the caller cancels; a
   * done task keeps the time it was done; related tasks are left alone. Who may
   * is the caller's: an operator, as for archiving a task.
   */
  archiveWorkflow(instanceId: string, by: string): Result<{ instance: InstanceRow; archived: TaskRow[]; runs: RunRow[] }> {
    if (!isText(instanceId)) return board.refuse('invalid', 'an instance id is text');
    if (!isText(by) || by.trim() === '') return board.refuse('invalid', 'who archives is text, not blank');
    return board.archiveWorkflow(this.#db, instanceId, by, this.#clock.now());
  }

  /** Who the next claim is for, resolved against the team as it is now. */
```

In `src/kanban/workflow.ts`, replace:

```ts
import { GATE_LIMITS, type Contract, type Refusal, type Result, type RetryOnCrash } from './types.js';
```

with:

```ts
import { GATE_LIMITS, type Contract, type Phase, type Refusal, type Result, type RetryOnCrash } from './types.js';
```

In `src/kanban/workflow.ts`, replace:

```ts
  return { ok: true, dag: { format: DAG_FORMAT, workflow: w.name, params: Object.fromEntries(values), board, tasks } };
}
```

with:

```ts
  return { ok: true, dag: { format: DAG_FORMAT, workflow: w.name, params: Object.fromEntries(values), board, tasks } };
}

// ---------------------------------------------------------------------------
// An instance's status (spec §21.10)
// ---------------------------------------------------------------------------

export type InstanceStatus = 'archived' | 'done' | 'blocked' | 'running';

/** An instance's status, with how many of its members are finished, of how many, and how many are blocked. */
export interface InstanceState {
  status: InstanceStatus;
  /** Done or archived: an archived member counts as finished, as an archived parent does for its children (spec §4.1). */
  done: number;
  total: number;
  blocked: number;
}

/**
 * An instance's status, derived from its members' phases, never stored (spec
 * §21.10): archived when every member is, done when every member is done or
 * archived, blocked when any is, and running otherwise. Blocked is checked before
 * running, as a blocked task is what a person must act on.
 */
export function instanceStatus(phases: readonly Phase[]): InstanceState {
  const total = phases.length;
  const done = phases.filter((p) => p === 'done' || p === 'archived').length;
  const blocked = phases.filter((p) => p === 'blocked').length;
  const status: InstanceStatus = phases.every((p) => p === 'archived')
    ? 'archived'
    : done === total
      ? 'done'
      : blocked > 0
        ? 'blocked'
        : 'running';
  return { status, done, total, blocked };
}
```

- [ ] **Step 13.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2132 passed (2132)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 13.5: Commit.**

```bash
git add src/kanban/service.ts src/kanban/workflow.ts tests/kanban-workflow-instances.test.ts
git commit -m "See and manage workflows through the service: the files as they are now, a board's instances with their derived status, one instance with its members and related tasks, and the archive of every member"
```

---

### Task 14: `/kanban workflow` in chat: the parser

**Files:**

- Create: `tests/kanban-workflow-chat-parse.test.ts`
- Modify: `src/kanban/chat-parse.ts`, `src/kanban/chat.ts`

Spec §21.6, §21.10. `src/kanban/chat-parse.ts` gains the `workflow` group: `list`, `instances [all]`, `show <instance>`, `archive <instance>`, `preview <name> key=value …` and `start <name> key=value …`, with a usage line each and the verbs listed for none or an unknown one. `parseKanban(arg, mentions)` takes the message's mention names, and `parsePairs` reads the pairs: separated by spaces, tabs or line breaks, each split at its first `=`, the key in the param grammar, a value up to the next space or quoted with `"…"` or `“…”` and no escape, an unquoted value starting with `@` matched whole against the longest mention name it begins with, a stray word refused with the usage line and, after a value ending in `,`, the hint to quote. Each pair is `{ key, value, quoted }`, knowing no workflow. `KanbanChat`'s tiers gain the six verbs, talk for the four that make nothing; the commands answer in the next task.

- [ ] **Step 14.1: Write the tests.**

Create `tests/kanban-workflow-chat-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseKanban, parsePairs, typed } from '../src/kanban/chat-parse.js';

/**
 * `/kanban workflow …` as typed in chat (spec §21.6, §21.10): its verbs, and a
 * preview's or a start's pairs, with quotes, lists, @-mentions whose names hold
 * spaces, a pair split at its first `=`, and a stray word refused.
 */

const pairs = (text: string, mentions: readonly string[] = []) => {
  const r = parsePairs(text, mentions);
  if (!r.ok) throw new Error(r.usage);
  return r.pairs.map((p) => [p.key, p.value, p.quoted]);
};
const refused = (text: string, mentions: readonly string[] = []) => {
  const r = parsePairs(text, mentions);
  if (r.ok) throw new Error('the pairs were taken');
  return r.usage;
};

describe('/kanban workflow', () => {
  it('reads each verb', () => {
    expect(parseKanban('workflow list')).toEqual({ ok: true, command: { verb: 'workflow list' } });
    expect(parseKanban('workflow instances')).toEqual({ ok: true, command: { verb: 'workflow instances', all: false } });
    expect(parseKanban('workflow instances ALL')).toEqual({ ok: true, command: { verb: 'workflow instances', all: true } });
    expect(parseKanban('workflow show w_abc')).toEqual({ ok: true, command: { verb: 'workflow show', instanceId: 'w_abc' } });
    expect(parseKanban('workflow archive w_abc')).toEqual({ ok: true, command: { verb: 'workflow archive', instanceId: 'w_abc' } });
    expect(parseKanban('workflow preview vendor-eval topic=logs')).toEqual({
      ok: true,
      command: { verb: 'workflow preview', name: 'vendor-eval', pairs: [{ key: 'topic', value: 'logs', quoted: false }] },
    });
    expect(parseKanban('workflow start vendor-eval\ntopic="log storage"\nvendors=acme,globex')).toEqual({
      ok: true,
      command: {
        verb: 'workflow start',
        name: 'vendor-eval',
        pairs: [
          { key: 'topic', value: 'log storage', quoted: true },
          { key: 'vendors', value: 'acme,globex', quoted: false },
        ],
      },
    });
    expect(typed('workflow start')).toBe('/kanban workflow start');
  });

  it('lists its verbs with none or an unknown one, and gives the usage of a verb missing its argument', () => {
    const takes =
      '`/kanban workflow` takes `/kanban workflow list`, `/kanban workflow instances [all]`, `/kanban workflow show <instance>`, ' +
      '`/kanban workflow preview <name> key=value ...`, `/kanban workflow start <name> key=value ...`, `/kanban workflow archive <instance>`.';
    expect(parseKanban('workflow')).toEqual({ ok: false, usage: takes });
    expect(parseKanban('workflow run x')).toEqual({ ok: false, usage: takes });
    expect(parseKanban('workflow start')).toEqual({ ok: false, usage: 'Usage: `/kanban workflow start <name> key=value ...`' });
    expect(parseKanban('workflow show')).toEqual({ ok: false, usage: 'Usage: `/kanban workflow show <instance>`' });
    expect(parseKanban('workflow instances some')).toEqual({ ok: false, usage: 'Usage: `/kanban workflow instances [all]`' });
    expect(parseKanban('workflow list x')).toEqual({ ok: false, usage: 'Usage: `/kanban workflow list`' });
  });
});

describe('the pairs', () => {
  it('splits a pair at its first =, separated by spaces, tabs or line breaks', () => {
    expect(pairs('query=a=b\tnote=x\n\nempty=')).toEqual([
      ['query', 'a=b', false],
      ['note', 'x', false],
      ['empty', '', false],
    ]);
  });

  it('takes "…" and “…” as quotes, with no escape, a quoted value one item whatever its commas', () => {
    expect(pairs('vendors="Acme, Inc" vendors=globex')).toEqual([
      ['vendors', 'Acme, Inc', true],
      ['vendors', 'globex', false],
    ]);
    expect(pairs('topic=“log storage” note=”')).toEqual([
      ['topic', 'log storage', true],
      ['note', '”', false],
    ]);
    expect(pairs('topic="two\nlines"')).toEqual([['topic', 'two\nlines', true]]);
    expect(refused('topic="open')).toBe('The value of `topic` opens a quote it does not close. Usage: `/kanban workflow start <name> key=value ...`');
    expect(refused('topic="a"b')).toBe(
      'The quoted value of `topic` ends at its closing quote: put a space after it. Usage: `/kanban workflow start <name> key=value ...`',
    );
  });

  it('takes an @-mention whose name holds a space whole, the longest first, and leaves any other @ to the next space', () => {
    expect(pairs('owner=@Alice Smith note=x', ['Alice', 'Alice Smith'])).toEqual([
      ['owner', '@Alice Smith', false],
      ['note', 'x', false],
    ]);
    expect(pairs('owner=@Alice note=x', ['Alice', 'Alice Smith'])).toEqual([
      ['owner', '@Alice', false],
      ['note', 'x', false],
    ]);
    expect(refused('owner=@Bob Jones', ['Alice Smith'])).toMatch(/^`Jones` is not a `key=value` pair\./);
  });

  it('refuses a stray word with the usage, and with a hint after a value ending in a comma', () => {
    expect(refused('topic=logs please')).toBe('`please` is not a `key=value` pair. Usage: `/kanban workflow start <name> key=value ...`');
    expect(refused('vendors=acme, globex')).toBe(
      '`globex` is not a `key=value` pair. Quote a value with spaces, as `vendors="acme, globex"`, or leave no space after its commas. ' +
        'Usage: `/kanban workflow start <name> key=value ...`',
    );
    expect(refused('Topic=x')).toBe('`Topic` is not a param name. Usage: `/kanban workflow start <name> key=value ...`');
    expect(parseKanban('workflow preview vendor-eval oops')).toEqual({
      ok: false,
      usage: '`oops` is not a `key=value` pair. Usage: `/kanban workflow preview <name> key=value ...`',
    });
  });
});
```

- [ ] **Step 14.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-chat-parse.test.ts`. Expected: `Tests  6 failed (6)`; the first failure: `AssertionError: expected { ok: false, …(1) } to deeply equal { ok: true, …(1) }`.

- [ ] **Step 14.3: Implement.**

In `src/kanban/chat-parse.ts`, replace:

```ts
import { forDisplay } from '../channel/escape.js';
```

with:

```ts
import { forDisplay } from '../channel/escape.js';
import { NAME_PATTERN } from '../names.js';
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  | BoardCommand;
```

with:

```ts
  | BoardCommand
  | WorkflowCommand;

/** A param as chat gives it (spec §21.6): its key, its value, and whether it was quoted, which keeps a list's item whole. */
export interface ParamPair {
  key: string;
  value: string;
  quoted: boolean;
}

/** `/kanban workflow …` (spec §21.10): the workflow files, a chat board's instances, and a start or its preview. */
export type WorkflowCommand =
  | { verb: 'workflow list' }
  | { verb: 'workflow instances'; all: boolean }
  | { verb: 'workflow show' | 'workflow archive'; instanceId: string }
  | { verb: 'workflow preview' | 'workflow start'; name: string; pairs: ParamPair[] };
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  'board archive': '/kanban board archive <name>',
} as const;
```

with:

```ts
  'board archive': '/kanban board archive <name>',
  'workflow list': '/kanban workflow list',
  'workflow instances': '/kanban workflow instances [all]',
  'workflow show': '/kanban workflow show <instance>',
  'workflow preview': '/kanban workflow preview <name> key=value ...',
  'workflow start': '/kanban workflow start <name> key=value ...',
  'workflow archive': '/kanban workflow archive <instance>',
} as const;

/** The verbs of `/kanban workflow …`, in the order the help lists them. */
export const WORKFLOW_VERBS = ['list', 'instances', 'show', 'preview', 'start', 'archive'] as const;
```

In `src/kanban/chat-parse.ts`, replace:

```ts
 * Parse what follows `/kanban`: `help`, or a group, `task`, `board` or `gate`,
 * and its verb. The router gives the whole argument, newlines kept: `/kanban
 * task new` and `/kanban task comment` take several lines.
 */
export function parseKanban(arg: string): ParsedKanban {
```

with:

```ts
 * Parse what follows `/kanban`: `help`, or a group, `task`, `board`, `gate` or
 * `workflow`, and its verb. The router gives the whole argument, newlines kept:
 * `/kanban task new` and `/kanban task comment` take several lines. `mentions`
 * are the names the message's @-mentions show, which a param's value starting
 * with `@` is matched against, as such a name may hold spaces (spec §21.6).
 */
export function parseKanban(arg: string, mentions: readonly string[] = []): ParsedKanban {
```

In `src/kanban/chat-parse.ts`, replace:

```ts
      return parseBoard(rest);
```

with:

```ts
      return parseBoard(rest);
    case 'workflow':
      return parseWorkflow(rest, mentions);
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  return { ok: true, command: out };
}
```

with:

```ts
  return { ok: true, command: out };
}

/** What `/kanban workflow` says with no verb, or one it does not take. */
const WORKFLOW_TAKES = `\`/kanban workflow\` takes ${WORKFLOW_VERBS.map((v) => `\`${USAGE[`workflow ${v}`]}\``).join(', ')}.`;

/** `/kanban workflow list|instances [all]|show <id>|archive <id>|preview <name> …|start <name> …` (spec §21.10). */
function parseWorkflow(text: string, mentions: readonly string[]): ParsedKanban {
  const [rawVerb, rest] = shift(text.replace(START_ZW, '$1'));
  const verb = rawVerb.toLowerCase();
  switch (verb) {
    case 'list':
      return words(rest, 0) === undefined ? usage('workflow list') : { ok: true, command: { verb: 'workflow list' } };
    case 'instances': {
      const w = words(rest, 0) ?? words(rest, 1);
      const all = w?.[0]?.toLowerCase();
      if (w === undefined || (all !== undefined && all !== 'all')) return usage('workflow instances');
      return { ok: true, command: { verb: 'workflow instances', all: all === 'all' } };
    }
    case 'show':
    case 'archive': {
      const w = words(rest, 1);
      const command = `workflow ${verb}` as const;
      return w?.[0] === undefined ? usage(command) : { ok: true, command: { verb: command, instanceId: w[0] } };
    }
    case 'preview':
    case 'start': {
      const command = `workflow ${verb}` as const;
      const [name, after] = shift(rest);
      if (name === '') return usage(command);
      const pairs = parsePairs(after, mentions, command);
      return pairs.ok ? { ok: true, command: { verb: command, name, pairs: pairs.pairs } } : pairs;
    }
    default:
      return { ok: false, usage: WORKFLOW_TAKES };
  }
}

/** The quotes a value may open with, and the ones each may close with: a typed `"` may arrive as `“` and `”` (spec §21.6). */
const QUOTES: Readonly<Record<string, readonly string[]>> = { '"': ['"', '”'], '“': ['”', '"'] };

/**
 * A preview's or a start's params (spec §21.6): `key=value` pairs separated by
 * spaces, tabs or line breaks, each split at its first `=`, the key in the
 * param grammar. A value runs to the next space, or is quoted, with no escape;
 * an unquoted value starting with `@` takes the longest of the message's
 * mention names it begins with, whole. A word that is no pair is refused with
 * the usage line, and after a value ending in `,`, a hint.
 */
export function parsePairs(
  text: string,
  mentions: readonly string[],
  verb: 'workflow preview' | 'workflow start' = 'workflow start',
): { ok: true; pairs: ParamPair[] } | { ok: false; usage: string } {
  const names = [...new Set(mentions.filter((m) => m !== ''))].sort((a, b) => b.length - a.length);
  const pairs: ParamPair[] = [];
  const space = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
  let i = 0;
  while (i < text.length) {
    if (space(text[i])) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < text.length && !space(text[end]) && text[end] !== '=') end += 1;
    const key = text.slice(i, end);
    if (text[end] !== '=') {
      const last = pairs.at(-1);
      const hint =
        last !== undefined && !last.quoted && last.value.endsWith(',')
          ? ' Quote a value with spaces, as `vendors="acme, globex"`, or leave no space after its commas.'
          : '';
      return { ok: false, usage: `\`${echoed(key, 80)}\` is not a \`key=value\` pair.${hint} Usage: \`${USAGE[verb]}\`` };
    }
    if (!NAME_PATTERN.test(key)) {
      return { ok: false, usage: `\`${echoed(key, 80)}\` is not a param name. Usage: \`${USAGE[verb]}\`` };
    }
    i = end + 1;
    const open = text[i] ?? '';
    const closes = QUOTES[open];
    if (closes !== undefined) {
      let close = i + 1;
      while (close < text.length && !closes.includes(text[close] ?? '')) close += 1;
      if (close >= text.length) return { ok: false, usage: `The value of \`${key}\` opens a quote it does not close. Usage: \`${USAGE[verb]}\`` };
      if (!space(text[close + 1])) {
        return { ok: false, usage: `The quoted value of \`${key}\` ends at its closing quote: put a space after it. Usage: \`${USAGE[verb]}\`` };
      }
      pairs.push({ key, value: text.slice(i + 1, close), quoted: true });
      i = close + 1;
      continue;
    }
    const mention = text[i] === '@' ? names.find((n) => text.startsWith(`@${n}`, i) && space(text[i + n.length + 1])) : undefined;
    let stop = mention === undefined ? i : i + mention.length + 1;
    while (stop < text.length && !space(text[stop])) stop += 1;
    pairs.push({ key, value: text.slice(i, stop), quoted: false });
    i = stop;
  }
  return { ok: true, pairs };
}
```

In `src/kanban/chat.ts`, replace:

```ts
  'board archive': 'operate',
```

with:

```ts
  'board archive': 'operate',
  // A start starts agents, unsupervised, in workspaces, as task new does; a preview makes nothing (spec §21.6).
  'workflow list': 'talk',
  'workflow instances': 'talk',
  'workflow show': 'talk',
  'workflow preview': 'talk',
  'workflow start': 'operate',
  'workflow archive': 'operate',
```

- [ ] **Step 14.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2138 passed (2138)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 14.5: Commit.**

```bash
git add src/kanban/chat-parse.ts src/kanban/chat.ts tests/kanban-workflow-chat-parse.test.ts
git commit -m "Parse /kanban workflow and its verbs in chat, with a start's and a preview's key=value pairs: quotes, lists, a pair split at its first =, an @-mention matched whole against the message's mention names, and a stray word refused with a hint"
```

---

### Task 15: `/kanban workflow` in chat: the commands and their replies

**Files:**

- Create: `tests/kanban-workflow-chat.test.ts`
- Modify: `src/core/router.ts`, `src/kanban/chat-render.ts`, `src/kanban/chat.ts`

Spec §21.9, §21.10. `KanbanChat`: the parse given the mention names; `list`, `instances`, `show` and `preview` at talk tier, `start` and `archive` at operator tier, after the union_id check. A start goes on the chat's board, refused when it is archived, keyed by `lark:<message_id>`, with `personOf` turning a mentioned `@Name` into its principal for a person field; in a group at chat scope every member is held before the dispatcher is told, and the answer names the instance as its `thread`, in both wordings; `threaded` moves every member's subscription in one `threadSubscriptions` call when its id starts `w_`, and releases every hold. The board's id rendering takes `w_…`. `chat-render.ts`: `renderStarted` (at most 30 task lines, titles cut at 80, lines dropped from the end until the whole is under 3,800 characters, then how many more and the `show` that lists them, then who hears, a person's card in the thread's or the chat's words), `renderPreview`, `renderWorkflows`, `renderInstances`, `renderInstance` (cut to fit, saying what was cut), `previewLines`, `fitted` and the help's six lines. The router's log line names an instance as one.

- [ ] **Step 15.1: Write the tests.**

Create `tests/kanban-workflow-chat.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getInstance, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { createBoard } from '../src/db/kanban.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { WORKFLOW_REPLY_MAX, renderStarted } from '../src/kanban/chat-render.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import type { TaskRow } from '../src/kanban/types.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import type { BindingKey, InboundMention, InboundMessage, Principal } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { NOW } from './helpers/kanban.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * `/kanban workflow …` in chat (spec §21.6, §21.9, §21.10): the tiers, a start's
 * reply in its two wordings and its thread, every member held and moved in one
 * call, the reply cut to fit, @-mentions, the preview, and list, instances,
 * show and archive.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };
const AT_ALICE: InboundMention = { key: '@_user_1', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' };
const AT_AL: InboundMention = { key: '@_user_2', name: 'Alice', openId: 'ou_al', unionId: 'on_al' };
const TEAM: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };
const TOPIC: BindingKey = { ...TEAM, threadId: 'omt_topic' };
const HEARS = 'hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.';
const START = 'workflow start vendor-eval topic="log storage" vendors=acme,globex';

let t: TestDb;
let dir: string;
let people: PeopleDirectory;
let service: KanbanService;
let passes: number;
/** For each pass, whether every member of the newest instance was held then. */
let heldAtPass: boolean[];
let chat: KanbanChat;
let seq = 0;

function members(): string[] {
  return t.db
    .prepare<[], { task_id: string }>('SELECT m.task_id FROM kanban_workflow_tasks m JOIN kanban_tasks t ON t.task_id = m.task_id ORDER BY t.rowid')
    .all()
    .map((r) => r.task_id);
}

beforeEach(() => {
  t = testDb();
  dir = join(t.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, GUEST.openId, 'ou_alice', 'ou_al'] });
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }) });
  service = new KanbanService({
    db: t.db,
    roles: new Map([['worker', role('worker')], ['reviewer', role('reviewer')]]),
    workspaces: new Set(['default']),
    people,
    supervisedRoles: true,
    workflowsDir: dir,
  });
  passes = 0;
  heldAtPass = [];
  const c: KanbanChat = new KanbanChat({
    service,
    hasTier: (p, tier) => tier === 'talk' || p.openId === OWNER.openId,
    people,
    appId: 'cli_app',
    changed: () => {
      passes += 1;
      heldAtPass.push(members().every((id) => c.held(id)));
    },
  });
  chat = c;
});
afterEach(() => t.close());

function message(key: BindingKey, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: `om_${++seq}`,
    appId: 'cli_app',
    chatId: key.conversationId,
    chatType: 'group',
    threadId: key.threadId,
    sender: OWNER,
    senderIsBot: false,
    text: '',
    mentionedBot: true,
    mentionAll: false,
    mentions: [AT_ALICE, AT_AL],
    attachments: [],
    createTime: 0,
    ...over,
  };
}

function instanceOf(text: string): string {
  const m = /as `(w_[0-9a-z]+)`/.exec(text);
  if (m?.[1] === undefined) throw new Error(`not started: ${text}`);
  return m[1];
}

describe('/kanban workflow start', () => {
  it('answers in a group at chat scope in the thread\'s words, the chat\'s beside them, naming the instance, every member held when the dispatcher is told, once', async () => {
    const answer = await chat.run(START, message(TEAM), TEAM);
    const id = instanceOf(answer.text);
    const ids = members();
    const lines = (where: string) =>
      [
        `Started vendor-eval as \`${id}\`, 4 tasks:`,
        `- \`${ids[0]}\` Shortlist vendors for log storage, for role worker`,
        `- \`${ids[1]}\` Evaluate acme for log storage, for role worker`,
        `- \`${ids[2]}\` Evaluate globex for log storage, for role worker`,
        `- \`${ids[3]}\` Recommend a vendor for log storage, for role worker`,
        `${where} ${HEARS}`,
      ].join('\n');
    expect(answer).toEqual({ text: lines('This thread'), quoted: lines('This chat'), thread: id });
    expect(passes).toBe(1);
    expect(heldAtPass).toEqual([true]);
    for (const m of ids) expect(chat.held(m)).toBe(true);
  });

  it('moves every member into the thread in one call when the router says where the reply went, and releases them all', async () => {
    const msg = message(TEAM);
    const answer = await chat.run(START, msg, TEAM);
    chat.threaded(answer.thread ?? '', TEAM, msg.messageId, 'omt_new');
    for (const m of members()) {
      expect(chat.held(m)).toBe(false);
      expect(subscriptionsOf(t.db, m).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_new', msg.messageId]]);
    }
  });

  it('stays at chat scope with no thread, its holds released', async () => {
    const msg = message(TEAM);
    const answer = await chat.run(START, msg, TEAM);
    chat.threaded(answer.thread ?? '', TEAM, msg.messageId, undefined);
    for (const m of members()) {
      expect(chat.held(m)).toBe(false);
      expect(subscriptionsOf(t.db, m).map((s) => s.threadId)).toEqual(['']);
    }
  });

  it("answers in a direct message in the chat's words alone, and inside a thread with a root in the thread's, holding none", async () => {
    const dm = await chat.run(START, message(TEAM, { chatType: 'p2p' }), TEAM);
    expect(dm).toEqual({ text: expect.stringMatching(new RegExp(`\\nThis chat ${HEARS.replace(/[.]/g, '\\.')}$`)) as string });
    const inTopic = await chat.run(START, message(TOPIC, { rootId: 'om_root' }), TOPIC);
    expect(inTopic.text).toMatch(/\nThis thread hears when each task/);
    expect(inTopic).not.toHaveProperty('thread');
    const instance = getInstance(t.db, instanceOf(inTopic.text));
    expect(instance?.createdVia).toEqual({ kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' });
  });

  it('answers a redelivery with the instance it made', async () => {
    const msg = message(TEAM);
    const first = await chat.run(START, msg, TEAM);
    expect(await chat.run(START, msg, TEAM)).toEqual({ text: `Already started, as \`${instanceOf(first.text)}\`.` });
  });

  it('needs operator tier and a union_id, and refuses on an archived board', async () => {
    expect(await chat.run(START, message(TEAM, { sender: GUEST }), TEAM)).toEqual({ text: '`/kanban workflow start` changes the board, and needs operator permission.' });
    const nobody = await chat.run(START, message(TEAM, { sender: { ...OWNER, unionId: null } }), TEAM);
    expect(nobody.text).toMatch(/^Lark did not say who you are/);
    expect(members()).toEqual([]);
  });

  it('resolves @-mentions only for a person field, the longest name first', async () => {
    writeFileSync(join(dir, 'ask.yaml'), 'params:\n  owner: { required: true }\n  note: { required: true }\nsteps:\n  ask: { title: "Ask {{owner}}: {{note}}", assignee: "{{owner}}" }\n');
    const answer = await chat.run('workflow start ask owner=@Alice Smith note=@Alice', message(TEAM), TEAM);
    const [task] = members();
    expect(getTask(t.db, task ?? '')).toMatchObject({ assignee: { kind: 'human', name: 'lark:on_alice' }, title: 'Ask lark:on_alice: @Alice' });
    expect(answer.text).toContain("A person's card comes in this thread when their task is ready, or by direct message if they are not in this group.");
    expect((await chat.run('workflow start ask owner=@Bob note=x', message(TEAM), TEAM)).text).toBe(
      'Not done: @Bob is not someone this message mentions: type @ and pick them, so Lark says who they are',
    );
  });

  it('says why not, on one line, for a refusal', async () => {
    expect((await chat.run('workflow start vendor-eval vendors=acme', message(TEAM), TEAM)).text).toBe(
      'Not done: workflow vendor-eval needs param topic: what is being bought',
    );
    expect((await chat.run('workflow start nope', message(TEAM), TEAM)).text).toMatch(/^Not done: there is no workflow nope; the usable ones are vendor-eval/);
  });
});

describe("a start's reply", () => {
  it('lists at most 30 tasks, each title cut, says how many more, and stays under 3,800 characters with 100 tasks of 512-byte titles', () => {
    const tasks = Array.from({ length: 100 }, (_, i) => ({
      task: { taskId: `k_${String(i).padStart(12, '0')}`, title: `${'T'.repeat(500)} number ${i}`, assignee: { kind: 'role', name: 'worker' }, reviewer: null } as unknown as TaskRow,
    }));
    const text = renderStarted({ instance: { instanceId: 'w_aaaaaaaaaaaa', name: 'big', board: 'default' }, tasks }, 'thread', (a) => `role ${a.name}`);
    const lines = text.split('\n');
    expect(text.length).toBeLessThan(WORKFLOW_REPLY_MAX);
    const listed = lines.filter((l) => l.startsWith('- '));
    expect(listed.length).toBeLessThanOrEqual(30);
    expect(listed[0]).toBe(`- \`k_000000000000\` ${'T'.repeat(79)}…, for role worker`);
    expect(lines.at(-2)).toBe(`… and ${100 - listed.length} more: \`/kanban workflow show w_aaaaaaaaaaaa\` lists them all.`);
    expect(lines.at(-1)).toBe(`This thread ${HEARS}`);
  });
});

describe('/kanban workflow preview', () => {
  it('says what a start would make, with parents and gates, at talk tier, making nothing', async () => {
    const r = await chat.run('workflow preview vendor-eval topic=logs vendors=acme', message(TEAM, { sender: GUEST }), TEAM);
    expect(r).toEqual({
      text: [
        'vendor-eval would make 3 tasks:',
        '- `shortlist` Shortlist vendors for logs, for role worker',
        '- `evaluate:1` Evaluate acme for logs, for role worker, after `shortlist`, 1 gate',
        '- `recommend` Recommend a vendor for logs, for role worker, after `evaluate:1`',
        'Nothing was made: `/kanban workflow start vendor-eval`, with these params, makes it.',
      ].join('\n'),
    });
    expect(members()).toEqual([]);
    expect(passes).toBe(0);
    expect((await chat.run('workflow preview vendor-eval topic=logs', message(TEAM, { sender: GUEST }), TEAM)).text).toBe(
      'Not done: workflow vendor-eval needs param vendors',
    );
  });
});

describe('/kanban workflow list, instances, show and archive', () => {
  it('lists the workflows, broken ones with why', async () => {
    writeFileSync(join(dir, 'broken.yaml'), 'steps: {}\n');
    expect((await chat.run('workflow list', message(TEAM, { sender: GUEST }), TEAM)).text).toBe(
      [
        '**Workflows**',
        '- **broken** is not usable: the file needs steps, at least one',
        '- **vendor-eval**: Shortlist vendors, evaluate each in parallel, then recommend one · params: topic \\(required\\), vendors \\(list, required\\), reviewer \\(default reviewer\\)',
        '`/kanban workflow preview <name> key=value ...` shows what a start would make.',
      ].join('\n'),
    );
  });

  it("lists the chat board's instances, shows one, and archives it at operator tier", async () => {
    const id = instanceOf((await chat.run(START, message(TEAM), TEAM)).text);
    const listed = (await chat.run('workflow instances', message(TEAM, { sender: GUEST }), TEAM)).text;
    expect(listed).toMatch(new RegExp(`^Workflow instances:\\n- \`${id}\` \\*\\*vendor-eval\\*\\* running, 0 of 4 done · by Owner, \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC$`));
    const shown = (await chat.run(`workflow show ${id}`, message(TEAM, { sender: GUEST }), TEAM)).text.split('\n');
    expect(shown[0]).toBe(`**vendor-eval** \`${id}\`: running, 0 of 4 done`);
    expect(shown).toContain('Params: reviewer: reviewer · topic: log storage · vendors: acme, globex');
    expect(shown).toContain('**evaluate**');
    expect(shown.filter((l) => l.startsWith('- ')).map((l) => l.replace(/`k_[0-9a-z]+`/, 'K'))).toEqual([
      '- K ready · role worker',
      '- K acme: todo · role worker',
      '- K globex: todo · role worker',
      '- K todo · role worker',
    ]);
    expect((await chat.run(`workflow archive ${id}`, message(TEAM, { sender: GUEST }), TEAM)).text).toBe(
      '`/kanban workflow archive` changes the board, and needs operator permission.',
    );
    expect((await chat.run(`workflow archive ${id}`, message(TEAM), TEAM)).text).toBe(
      `Archived 4 tasks of \`${id}\` (vendor-eval). Its related tasks are left as they are.`,
    );
    expect((await chat.run(`workflow archive ${id}`, message(TEAM), TEAM)).text).toBe(`Every task of \`${id}\` is archived already; nothing changed.`);
    expect((await chat.run('workflow instances', message(TEAM), TEAM)).text).toBe(
      'No running or blocked workflow instances. `/kanban workflow instances all` shows done and archived ones too.',
    );
    expect((await chat.run('workflow show w_none', message(TEAM), TEAM)).text).toBe('Not done: no workflow instance w\\_none');
  });

  it("names an instance's board in show when it is not the chat's", async () => {
    createBoard(t.db, 'research', 'lark:on_owner', NOW);
    await chat.run('board use research', message(TEAM), TEAM);
    const id = instanceOf((await chat.run(START, message(TEAM), TEAM)).text);
    await chat.run('board use default', message(TEAM), TEAM);
    expect((await chat.run(`workflow show ${id}`, message(TEAM), TEAM)).text.split('\n')[0]).toBe(
      `**vendor-eval** \`${id}\`: running, 0 of 4 done · board: **research**`,
    );
  });
});
```

- [ ] **Step 15.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-chat.test.ts`. Expected: `Tests  10 failed | 3 passed (13)`; the first failure: `Error: not started: **The task board.** …`, as the start is answered with the help.

- [ ] **Step 15.3: Implement.**

In `src/core/router.ts`, replace:

```ts
      if (threadId === undefined) this.#note(`kanban: the reply to ${message.messageId} came back with no thread; task ${taskId} stays at chat scope`);
```

with:

```ts
      if (threadId === undefined) {
        const what = taskId.startsWith('w_') ? `instance ${taskId}'s tasks stay` : `task ${taskId} stays`;
        this.#note(`kanban: the reply to ${message.messageId} came back with no thread; ${what} at chat scope`);
      }
```

In `src/kanban/chat-render.ts`, replace:

```ts
    [USAGE['board archive'], operate],
```

with:

```ts
    [USAGE['board archive'], operate],
    [USAGE['workflow list'], talk],
    [USAGE['workflow instances'], talk],
    [USAGE['workflow show'], talk],
    [USAGE['workflow preview'], talk],
    [USAGE['workflow start'], operate],
    [USAGE['workflow archive'], operate],
```

In `src/kanban/chat-render.ts`, replace:

```ts
    "A board is a queue of tasks of its own. Each chat is on one, `default` until `/kanban board use` moves it, and its `/kanban task new` and `/kanban task list` act on that board; a task's follow-ups and parents are on its board.",
```

with:

```ts
    "A board is a queue of tasks of its own. Each chat is on one, `default` until `/kanban board use` moves it, and its `/kanban task new` and `/kanban task list` act on that board; a task's follow-ups and parents are on its board.",
    "A workflow is a graph of tasks written once, in a file the operator keeps; a start makes all of its tasks at once, on this chat's board, and this chat hears each of them.",
```

In `src/kanban/chat-render.ts`, replace:

```ts
    value: { kind: 'kanban', act: 'unblock', task: event.taskId, event: String(event.id), nonce: boardCardNonce(appId, event.taskId, ref) },
  };
}
```

with:

```ts
    value: { kind: 'kanban', act: 'unblock', task: event.taskId, event: String(event.id), nonce: boardCardNonce(appId, event.taskId, ref) },
  };
}

// ---------------------------------------------------------------------------
// Workflows (spec §21.9, §21.10)
// ---------------------------------------------------------------------------

/** How long a reply about a workflow may be: under 3,800 characters, the notices' own bound, as Lark takes 4,000 in one message. */
export const WORKFLOW_REPLY_MAX = 3_800;

/** A reply lists at most 30 tasks, as `/kanban task list` lists 30 lines. */
export const WORKFLOW_REPLY_TASKS = 30;

/** A title in a reply's line, cut at 80 characters. */
const WORKFLOW_TITLE_MAX = 80;

/**
 * `head` and as many of `lines` as fit, then `more(n)` for the `n` left out,
 * then `tail`: at most `WORKFLOW_REPLY_TASKS` lines, dropped from the end until
 * the whole is under `WORKFLOW_REPLY_MAX` (spec §21.9).
 */
export function fitted(head: readonly string[], lines: readonly string[], tail: readonly string[], more: (n: number) => string): string {
  let kept = Math.min(lines.length, WORKFLOW_REPLY_TASKS);
  const render = (n: number): string =>
    [...head, ...lines.slice(0, n), ...(n < lines.length ? [more(lines.length - n)] : []), ...tail].join('\n');
  while (kept > 0 && render(kept).length >= WORKFLOW_REPLY_MAX) kept -= 1;
  return render(kept);
}

/** One task of a DAG, as a preview says it, in chat and at the terminal alike (spec §21.6). */
export interface PreviewLine {
  ref: string;
  title: string;
  assignee: string | null;
  parents: readonly string[];
  gates: number;
}

/** A DAG's tasks, as a preview lists them: its ref, its title, its assignee, its parents' refs, and how many gates it has. */
export function previewLines(dag: { tasks: readonly { ref: string; title: string; assignee: string | null; parents: readonly string[]; gates: readonly unknown[] }[] }): PreviewLine[] {
  return dag.tasks.map((t) => ({ ref: t.ref, title: t.title, assignee: t.assignee, parents: t.parents, gates: t.gates.length }));
}

/** A DAG's name as a reply says it: its workflow's, or "(no workflow)" for one with none (spec §21.10). */
export function workflowName(name: string | null): string {
  return name ?? '(no workflow)';
}

/** `/kanban workflow preview` (spec §21.9): what a start would make, one line a task, and that nothing was made. */
export function renderPreview(
  name: string,
  dag: { board: string | null; tasks: readonly { ref: string; title: string; assignee: string | null; parents: readonly string[]; gates: readonly unknown[] }[] },
  whom: (name: string) => string,
): string {
  const board = dag.board === null || dag.board === DEFAULT_BOARD ? '' : `, on board **${label(dag.board)}**`;
  const n = dag.tasks.length;
  const lines = previewLines(dag).map((t) => {
    const after = t.parents.length === 0 ? '' : `, after ${t.parents.map((p) => `\`${label(p, 64)}\``).join(', ')}`;
    const gates = t.gates === 0 ? '' : `, ${t.gates} gate${t.gates === 1 ? '' : 's'}`;
    return `- \`${label(t.ref, 64)}\` ${label(t.title, WORKFLOW_TITLE_MAX)}, for ${t.assignee === null ? 'nobody yet' : whom(t.assignee)}${after}${gates}`;
  });
  return fitted(
    [`${label(name)} would make ${n} task${n === 1 ? '' : 's'}${board}:`],
    lines,
    [`Nothing was made: \`/kanban workflow start ${label(name)}\`, with these params, makes it.`],
    (more) => `… and ${more} more.`,
  );
}

/**
 * A start's reply (spec §21.9): the instance, one line a task in position order
 * with its id, its title and its assignee, and who hears, in the words of the
 * thread or of the chat.
 */
export function renderStarted(
  made: { instance: { instanceId: string; name: string | null; board: string }; tasks: readonly { task: TaskRow }[] },
  where: 'thread' | 'chat',
  whom: (a: Assignee) => string,
): string {
  const { instance, tasks } = made;
  const n = tasks.length;
  const board = instance.board === DEFAULT_BOARD ? '' : `, on board **${label(instance.board)}**`;
  const lines = tasks.map(
    ({ task }) => `- ${id(task.taskId)} ${label(task.title, WORKFLOW_TITLE_MAX)}, for ${task.assignee === null ? 'nobody yet' : whom(task.assignee)}`,
  );
  const person = tasks.some(({ task }) => task.assignee?.kind === 'human' || task.reviewer?.kind === 'human');
  const cards =
    !person
      ? ''
      : where === 'thread'
        ? " A person's card comes in this thread when their task is ready, or by direct message if they are not in this group."
        : ' A person is sent their card by direct message once their task is ready.';
  return fitted(
    [`Started ${label(workflowName(instance.name))} as ${id(instance.instanceId)}, ${n} task${n === 1 ? '' : 's'}${board}:`],
    lines,
    [
      `${where === 'thread' ? 'This thread' : 'This chat'} hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.${cards}`,
    ],
    (more) => `… and ${more} more: \`/kanban workflow show ${instance.instanceId}\` lists them all.`,
  );
}

/** `/kanban workflow list` (spec §21.10): each usable workflow with its description and params, and each that is not with why. */
export function renderWorkflows(list: {
  usable: readonly { name: string; description: string | undefined }[];
  broken: readonly { name: string; problem: string }[];
}, params: (name: string) => string): string {
  const lines = [
    ...list.usable.map((w) => ({
      name: w.name,
      line: `- **${label(w.name)}**${w.description === undefined ? '' : `: ${label(w.description, 200)}`} · params: ${label(params(w.name), 400)}`,
    })),
    ...list.broken.map((b) => ({ name: b.name, line: `- **${label(b.name)}** is not usable: ${label(b.problem, 300)}` })),
  ]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((l) => l.line);
  if (lines.length === 0) return 'No workflows: a workflow is a file, `$MT_HOME/workflows/<name>.yaml`, which the operator writes.';
  return fitted(['**Workflows**'], lines, ['`/kanban workflow preview <name> key=value ...` shows what a start would make.'], (more) => `… and ${more} more.`);
}

/** A time as a reply says it, to the minute, in UTC. */
export function whenText(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Who made an instance, as a reply names them: a person by the name Lark last gave, the operator by login, a run by its id. */
export function makerText(createdBy: string, nameOf: (principal: string) => string | undefined): string {
  if (createdBy.startsWith('operator:')) return `the operator ${label(createdBy.slice('operator:'.length), 80)}`;
  if (createdBy.startsWith('run:')) return `run ${id(createdBy.slice('run:'.length))}`;
  const name = nameOf(createdBy);
  return name === undefined ? label(createdBy, 80) : label(name, 80);
}

/** `/kanban workflow instances [all]` (spec §21.10): the board's instances, newest first, at most 30 lines. */
export function renderInstances(
  summaries: readonly { instance: { instanceId: string; name: string | null; createdBy: string; createdAt: number }; status: string; done: number; total: number; blocked: number }[],
  opts: { board: string; all: boolean; total: number; read: number; nameOf: (principal: string) => string | undefined },
): string {
  const on = opts.board === DEFAULT_BOARD ? '' : ` on board **${label(opts.board)}**`;
  const past = opts.total > opts.read ? [`Only the ${opts.read} newest are read; an older instance is shown by its id, with \`/kanban workflow show\`.`] : [];
  if (summaries.length === 0) {
    return [
      opts.all ? `No workflow instances${on}.` : `No running or blocked workflow instances${on}. \`/kanban workflow instances all\` shows done and archived ones too.`,
      ...past,
    ].join('\n');
  }
  const lines = summaries.map((s) => {
    const status = s.status === 'blocked' ? `blocked (${s.blocked})` : s.status;
    return `- ${id(s.instance.instanceId)} **${label(workflowName(s.instance.name))}** ${status}, ${s.done} of ${s.total} done · by ${makerText(s.instance.createdBy, opts.nameOf)}, ${whenText(s.instance.createdAt)}`;
  });
  return fitted([`Workflow instances${on}:`], lines, past, (more) => `… and ${more} more.`);
}

/** How an instance was made, as `show` says it: in chat, at the terminal, or by a run, by its task. */
function howMade(via: { kind: string }, fromTask: string | null): string {
  if (via.kind === 'chat') return 'in chat';
  if (via.kind === 'operator') return 'at the terminal';
  return fromTask === null ? 'by a run' : `by a run of ${id(fromTask)}`;
}

/** A param's value, as `show` says it: a list's items joined. */
function paramText(value: string | readonly string[]): string {
  return typeof value === 'string' ? value : value.join(', ');
}

/** `/kanban workflow show` (spec §21.10): the instance, its steps' tasks in position order, its related tasks apart, cut to fit. */
export function renderInstance(
  view: {
    instance: { instanceId: string; name: string | null; board: string; createdBy: string; createdVia: { kind: string }; createdAt: number; dag: { params: Readonly<Record<string, string | readonly string[]>> } };
    description: string | undefined;
    members: readonly { step: string; item: string | null; task: TaskRow; status: DisplayStatus }[];
    related: readonly { task: TaskRow; status: DisplayStatus }[];
    relatedInstances: readonly { instanceId: string; name: string | null; tasks: number }[];
    status: string;
    done: number;
    total: number;
    blocked: number;
  },
  chatBoard: string,
  whom: (a: Assignee | null) => string,
  nameOf: (principal: string) => string | undefined,
): string {
  const { instance } = view;
  const board = instance.board === chatBoard && chatBoard === DEFAULT_BOARD ? '' : ` · board: **${label(instance.board)}**`;
  const status = view.status === 'blocked' ? `blocked (${view.blocked})` : view.status;
  const head = [
    `**${label(workflowName(instance.name))}** ${id(instance.instanceId)}: ${status}, ${view.done} of ${view.total} done${board}`,
    ...(view.description === undefined ? [] : [label(view.description, 300)]),
    `Started by ${makerText(instance.createdBy, nameOf)}, ${howMade(instance.createdVia, view.members[0]?.task.createdFromTask ?? null)}, ${whenText(instance.createdAt)}`,
  ];
  const params = Object.entries(instance.dag.params);
  if (params.length > 0) head.push(`Params: ${params.map(([k, v]) => `${label(k, 40)}: ${label(paramText(v), 200)}`).join(' · ')}`);
  const lines: string[] = [];
  let step: string | undefined;
  for (const m of view.members) {
    if (m.step !== step) {
      step = m.step;
      lines.push(`**${label(m.step, 64)}**`);
    }
    const item = m.item === null ? '' : ` ${label(m.item, 80)}:`;
    const why = m.task.phase === 'blocked' && m.task.blockKind !== null ? ` (${forDisplay(m.task.blockKind)}): ${label(m.task.blockReason ?? '', 200)}` : '';
    lines.push(`- ${id(m.task.taskId)}${item} ${m.status}${why} · ${whom(m.task.assignee)}`);
  }
  if (view.related.length > 0 || view.relatedInstances.length > 0) {
    lines.push('**Related**, not members:');
    for (const r of view.related) lines.push(`- ${id(r.task.taskId)} ${label(r.task.title, WORKFLOW_TITLE_MAX)}: ${r.status}`);
    for (const o of view.relatedInstances) {
      lines.push(`- ${id(o.instanceId)} ${label(workflowName(o.name))}, ${o.tasks} task${o.tasks === 1 ? '' : 's'}: \`/kanban workflow show ${o.instanceId}\``);
    }
  }
  // Every line counts here, not only the tasks': as many as fit, then what was cut.
  let kept = lines.length;
  const render = (n: number): string =>
    [...head, ...lines.slice(0, n), ...(n < lines.length ? [`… and ${lines.length - n} more lines: \`mt kanban workflow show ${instance.instanceId}\` at the terminal gives every one.`] : [])].join('\n');
  while (kept > 0 && render(kept).length >= WORKFLOW_REPLY_MAX) kept -= 1;
  return render(kept);
}
```

In `src/kanban/chat.ts`, replace:

```ts
  type ReviewCommand,
```

with:

```ts
  type ReviewCommand,
  type ParamPair,
  type WorkflowCommand,
```

In `src/kanban/chat.ts`, replace:

```ts
  renderList,
```

with:

```ts
  renderInstance,
  renderInstances,
  renderList,
  renderPreview,
  renderStarted,
  renderWorkflows,
```

In `src/kanban/chat.ts`, replace:

```ts
import type { KanbanService } from './service.js';
```

with:

```ts
import type { KanbanService, WorkflowMade } from './service.js';
import { paramsLine } from './workflow.js';
```

In `src/kanban/chat.ts`, replace:

```ts
  type PersonReportsAs,
  type Refusal,
  type Reporter,
```

with:

```ts
  type CreatedVia,
  type PersonReportsAs,
  type Refusal,
  type Reporter,
  type Result,
```

In `src/kanban/chat.ts`, replace:

```ts
/** The board's own ids are code; anything else the sender typed is escaped like any text. */
function id(taskId: string): string {
  return /^[kr]_[0-9a-z]+$/.test(taskId) ? `\`${taskId}\`` : forDisplay(taskId);
```

with:

```ts
/** The board's own ids, a task's, a run's and an instance's, are code; anything else the sender typed is escaped like any text. */
function id(taskId: string): string {
  return /^[krw]_[0-9a-z]+$/.test(taskId) ? `\`${taskId}\`` : forDisplay(taskId);
}

/** An instance's id, `w_…` (spec §21.9): what `KanbanAnswer.thread` names for a start, where it names a task for `task new`. */
function isInstance(id: string): boolean {
  return id.startsWith('w_');
```

In `src/kanban/chat.ts`, replace:

```ts
    try {
      if (threadId === undefined || threadId === '') return;
      const r = this.#deps.service.threadSubscriptions([taskId], chatAt(key), threadId, messageId);
      if (!r.ok) this.#note(`kanban: task ${taskId} stays at chat scope: its subscription was not moved to thread ${threadId} (${r.code})`);
    } finally {
      this.#release(taskId);
    }
```

with:

```ts
    // An instance's reply is its every member's (spec §21.9): all moved in one call, and all released.
    const ids = isInstance(taskId) ? this.#members(taskId) : [taskId];
    try {
      if (threadId === undefined || threadId === '') return;
      const r = this.#deps.service.threadSubscriptions(ids, chatAt(key), threadId, messageId);
      if (!r.ok) {
        const what = isInstance(taskId) ? `instance ${taskId}'s tasks stay` : `task ${taskId} stays`;
        this.#note(`kanban: ${what} at chat scope: ${isInstance(taskId) ? 'their subscriptions were' : 'its subscription was'} not moved to thread ${threadId} (${r.code})`);
      }
    } finally {
      for (const id of ids) this.#release(id);
    }
  }

  /** An instance's members' task ids, or none for an id that is no instance's. */
  #members(instanceId: string): string[] {
    const r = this.#deps.service.instance(instanceId);
    return r.ok ? r.view.members.map((m) => m.taskId) : [];
```

In `src/kanban/chat.ts`, replace:

```ts
    const parsed = parseKanban(arg);
```

with:

```ts
    // The message's mention names, so a param's `@Alice Smith` is read whole (spec §21.6).
    const parsed = parseKanban(arg, (message.mentions ?? []).flatMap((m) => (m.name === null ? [] : [m.name])));
```

In `src/kanban/chat.ts`, replace:

```ts
      }
      default:
```

with:

```ts
      }
      case 'workflow list':
      case 'workflow instances':
      case 'workflow show':
      case 'workflow preview':
        return this.#workflowRead(command, message, key);
      default:
```

In `src/kanban/chat.ts`, replace:

```ts
      default:
        return renderHelp();
    }
```

with:

```ts
      case 'workflow start':
        return this.#startWorkflow(command, by, message, key);
      case 'workflow archive': {
        const r = service.archiveWorkflow(command.instanceId, by);
        if (!r.ok) return refused(r);
        if (r.archived.length === 0) return `Every task of ${id(r.instance.instanceId)} is archived already; nothing changed.`;
        for (const run of r.runs) this.#decided(run);
        this.#changed();
        const n = r.archived.length;
        return `Archived ${n} task${n === 1 ? '' : 's'} of ${id(r.instance.instanceId)} (${label(r.instance.name ?? '(no workflow)')}). Its related tasks are left as they are.`;
      }
      default:
        return renderHelp();
    }
  }

  /** `/kanban workflow list`, `instances`, `show` and `preview` (spec §21.10): talk tier, and making nothing. */
  #workflowRead(command: WorkflowCommand, message: InboundMessage, key: BindingKey): string {
    const service = this.#deps.service;
    const board = service.chatBoard(chatAt(key));
    const nameOf = (p: string): string | undefined => this.#deps.people.nameOf(p);
    switch (command.verb) {
      case 'workflow list': {
        const list = service.workflows();
        const byName = new Map(list.usable.map((w) => [w.name, w]));
        return renderWorkflows(list, (name) => {
          const w = byName.get(name);
          return w === undefined ? '' : paramsLine(w);
        });
      }
      case 'workflow instances': {
        const r = service.instances(board.name, command.all);
        return renderInstances(r.instances, { board: board.name, all: command.all, total: r.total, read: r.read, nameOf });
      }
      case 'workflow show': {
        const r = service.instance(command.instanceId);
        if (!r.ok) return refused(r);
        return renderInstance(r.view, board.name, (a) => (a === null ? 'nobody' : this.#whom(a)), nameOf);
      }
      case 'workflow preview': {
        // The start's checks without the start, its key's but none (spec §21.6).
        const r = service.previewWorkflow({
          workflow: command.name,
          params: { from: 'chat', pairs: command.pairs },
          personOf: (value) => this.#personOf(value, message),
          createdBy: principalOf(message.sender) ?? '',
          createdVia: this.#via(message, key),
          board: board.name,
        });
        if (!r.ok) return refused(r);
        return renderPreview(command.name, r.dag, (name) => this.#whom({ kind: name.includes(':') ? 'human' : 'role', name }));
      }
      default:
        return renderHelp();
    }
  }

  /** Where a command came from, as the board records it: this chat, and in a group's thread its root (spec §19.4). */
  #via(message: InboundMessage, key: BindingKey): CreatedVia {
    return {
      kind: 'chat',
      channel: key.channel,
      appId: key.appId,
      conversationId: key.conversationId,
      threadId: key.threadId,
      ...(message.chatType !== 'group' || key.threadId === '' || message.rootId === undefined ? {} : { rootId: message.rootId }),
    };
  }

  /**
   * `/kanban workflow start` (spec §21.6, §21.9): on the chat's board, keyed by
   * the message, every task followed by this chat. In a group at chat scope it
   * is answered in a thread of its own, the instance's, in both wordings, and
   * every member is held until the router says where its reply went.
   */
  #startWorkflow(command: { name: string; pairs: readonly ParamPair[] }, by: string, message: InboundMessage, key: BindingKey): string | KanbanAnswer {
    const board = this.#deps.service.chatBoard(chatAt(key));
    if (board.archivedAt !== null) {
      return `This chat is on board ${boardName(board)}, which is archived: \`/kanban board use <board>\` moves it to another first.`;
    }
    const r = this.#deps.service.startWorkflow({
      workflow: command.name,
      params: { from: 'chat', pairs: command.pairs },
      personOf: (value) => this.#personOf(value, message),
      idempotencyKey: `lark:${message.messageId}`,
      createdBy: by,
      createdVia: this.#via(message, key),
      board: board.name,
    });
    if (!r.ok) return refused(r);
    if (r.existing) return `Already started, as ${id(r.instance.instanceId)}.`;
    // Every member held from here, with no await before it, so the dispatcher's pass
    // below, and the card poster, find them held (spec §21.9).
    const thread = message.chatType === 'group' && key.threadId === '';
    if (thread) for (const t of r.tasks) this.#hold(t.taskId);
    try {
      this.#changed();
      if (thread) return { text: this.#started(r, 'thread'), quoted: this.#started(r, 'chat'), thread: r.instance.instanceId };
      return this.#started(r, message.chatType === 'group' && key.threadId !== '' && message.rootId !== undefined ? 'thread' : 'chat');
    } catch (err) {
      if (thread) for (const t of r.tasks) this.#release(t.taskId);
      throw err;
    }
  }

  #started(made: WorkflowMade, where: 'thread' | 'chat'): string {
    return renderStarted(made, where, (a) => this.#whom(a));
  }

  /**
   * A param's `@Name`, for a person field, as the principal of the person the
   * message mentions by that name (spec §21.6): as `assignee:` is read, but said
   * as a refusal the service gives, plain, for chat to escape.
   */
  #personOf(value: string, message: InboundMessage): Result<{ principal: string }> {
    const shown = value.slice(1).trim();
    const found = (message.mentions ?? []).filter((m) => m.name === shown || m.key === value);
    const unionIds = [...new Set(found.map((m) => m.unionId).filter((u): u is string => u !== null))];
    if (found.length === 0) {
      return { ok: false, code: 'invalid', message: `${value} is not someone this message mentions: type @ and pick them, so Lark says who they are` };
    }
    if (unionIds.length === 0) {
      return { ok: false, code: 'invalid', message: `Lark did not say who ${value} is (no union_id came with the mention); ask the operator to check the app can read user ids` };
    }
    if (unionIds.length > 1) return { ok: false, code: 'invalid', message: `more than one person mentioned is called ${value}; say which with lark:<union_id>` };
    return { ok: true, principal: personPrincipal(unionIds[0] ?? '') };
```

- [ ] **Step 15.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2151 passed (2151)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 15.5: Commit.**

```bash
git add src/core/router.ts src/kanban/chat-render.ts src/kanban/chat.ts tests/kanban-workflow-chat.test.ts
git commit -m "Answer /kanban workflow in chat: a start at operator tier, keyed by its message, every member held and moved into the instance's thread in one call, its reply in two wordings cut to fit; a preview at talk tier; and list, instances, show and archive"
```

---

### Task 16: The worker's `start-workflow` and `apply-dag`

**Files:**

- Create: `tests/kanban-workflow-worker.test.ts`
- Modify: `src/cli/kanban.ts`, `src/cli/mt.ts`, `src/kanban/prompt.ts`, `src/kanban/worker.ts`, `tests/kanban-worker.test.ts`, `tests/mt-kanban.test.ts`, `tests/mt.test.ts`

Spec §7.1, §7.3, §21.5, §21.6. `WORKER_COMMANDS` gains both. `start-workflow` takes `workflow`, `params` (a new field kind: an object of text and lists of text, within 64 KiB) and `idempotency_key`, checked by `badInput` as every command is, and answers `{ok, instance_id, existing, board, tasks: [{task_id, ref, step, item}]}`. `apply-dag` skips the flat schema: `idempotency_key` and `dry_run` are taken off, and the rest is the DAG, read by the service's own checks; with `dry_run` it answers `dry_run: true`, the tasks and their gates, and no `instance_id` unless its key made one, and tells the dispatcher nothing. The work protocol (`prompt.ts`) gains a line for each, and its closing sentence names both. `mt kanban apply-dag` refuses a DAG over 192 KiB in its canonical form before sending it, `too_large`. `mt kanban workflow …` is an operator's group, refused in a run's shell naming the two commands; the usage lists them. Three tests that pin the worker's command list gain them.

- [ ] **Step 16.1: Write the tests.**

In `tests/kanban-worker.test.ts`, replace:

```ts
      message: 'no command "finish" (one of show, complete, review, changes, block, comment, create, link)',
```

with:

```ts
      message: 'no command "finish" (one of show, complete, review, changes, block, comment, create, link, start-workflow, apply-dag)',
```

Create `tests/kanban-workflow-worker.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { createBoard } from '../src/db/kanban.js';
import { getTask, parentsOf } from '../src/db/kanban-read.js';
import { DAG_LIMITS, canonicalDag, checkDagShape } from '../src/kanban/dag.js';
import { briefFor } from '../src/kanban/brief.js';
import { composePrompt } from '../src/kanban/prompt.js';
import { KanbanService } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import type { RunRow } from '../src/kanban/types.js';
import { WorkerApi, type WorkerResponse } from '../src/kanban/worker.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * The worker's workflow commands (spec §21.6): `start-workflow`, its schema, its
 * answer and `unknown_workflow`; `apply-dag`, its own two keys taken off before
 * the DAG is checked, its dry run, and what a run's DAG may not hold; `mt kanban
 * apply-dag`'s own 192 KiB check; and `mt kanban workflow` refused in a run's
 * shell, naming them.
 */

let t: TestDb;
let service: KanbanService;
let api: WorkerApi;
let changes: number;
let ask: (command: string, input?: unknown) => Promise<WorkerResponse>;
let planner: string;
let runId: string;
let plannerRun: RunRow;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  const dir = join(t.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
  service = new KanbanService({
    db: t.db,
    roles: new Map([['worker', role('worker')], ['reviewer', role('reviewer')], ['planner', role('planner')]]),
    workspaces: new Set(['default']),
    clock: new ManualClock(),
    supervisedRoles: true,
    workflowsDir: dir,
  });
  changes = 0;
  api = new WorkerApi({ db: t.db, service, changed: () => (changes += 1) });
  const task = service.create({ title: 'Plan the work', assignee: 'planner', createdBy: ALICE, createdVia: VIA });
  if (!task.ok) throw new Error(task.message);
  planner = task.task.taskId;
  const token = mintToken();
  const claimed = service.claim(planner, { tokenHash: hashToken(token) });
  if (!claimed.ok) throw new Error(claimed.message);
  runId = claimed.run.runId;
  plannerRun = claimed.run;
  ask = (command, input = {}) => api.handle({ run: runId, token, command, input });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

describe('start-workflow', () => {
  it("starts a workflow on its task's board, created from its task, answering each task with its ref, and tells the dispatcher once", async () => {
    const r = await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: 'logs', vendors: ['acme'] }, idempotency_key: 'ls-1' });
    expect(r).toEqual({
      ok: true,
      instance_id: expect.stringMatching(/^w_/),
      existing: false,
      board: 'default',
      tasks: [
        { task_id: expect.stringMatching(/^k_/), ref: 'shortlist', step: 'shortlist', item: null },
        { task_id: expect.stringMatching(/^k_/), ref: 'evaluate:1', step: 'evaluate', item: 'acme' },
        { task_id: expect.stringMatching(/^k_/), ref: 'recommend', step: 'recommend', item: null },
      ],
    });
    expect(changes).toBe(1);
    const tasks = (r as unknown as { tasks: Array<{ task_id: string }> }).tasks;
    for (const x of tasks) expect(getTask(t.db, x.task_id)?.createdFromTask).toBe(planner);
    expect(await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: 'logs', vendors: ['acme'] }, idempotency_key: 'ls-1' })).toMatchObject({
      ok: true,
      existing: true,
      instance_id: (r as unknown as { instance_id: string }).instance_id,
    });
    const follow = await ask('create', { title: 'After the plan', body: '', assignee: 'worker' });
    expect(follow.ok).toBe(true);
    expect(await ask('link', { parent_id: tasks[2]?.task_id, child_id: (follow as unknown as { task_id: string }).task_id })).toEqual({ ok: true, added: true });
  });

  it('takes workflow, params and idempotency_key alone, each of its type, params absent as {}', async () => {
    expect(await ask('start-workflow', { workflow: 'vendor-eval', board: 'x' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'start-workflow takes no field "board" (it takes workflow, params, idempotency_key)',
    });
    expect(await ask('start-workflow', {})).toEqual({ ok: false, code: 'invalid', message: 'start-workflow needs workflow, as text' });
    expect(await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: 3 } })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'params is an object of text and lists of text',
    });
    expect(await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: 'x'.repeat(70_000) } })).toMatchObject({ ok: false, code: 'too_large' });
    expect(await ask('start-workflow', { workflow: 'vendor-eval' })).toEqual({ ok: false, code: 'invalid', message: 'workflow vendor-eval needs param topic: what is being bought' });
    expect(await ask('start-workflow', { workflow: 'vendor-eval', params: { topic: ['x'], vendors: ['a'] } })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'param topic is text: give it as text',
    });
  });

  it('refuses an unknown workflow as unknown_workflow, naming the usable ones and their params', async () => {
    expect(await ask('start-workflow', { workflow: 'vendor' })).toEqual({
      ok: false,
      code: 'unknown_workflow',
      message: 'there is no workflow vendor; the usable ones are vendor-eval; their params: vendor-eval takes topic (required), vendors (list, required), reviewer (default reviewer)',
    });
  });
});

describe('apply-dag', () => {
  const graph = {
    format: 1,
    tasks: [
      { ref: 'research', title: 'Research the options', assignee: 'worker' },
      { ref: 'a', title: 'Try A', assignee: 'worker', parents: ['research'] },
      { ref: 'b', title: 'Try B', assignee: 'worker', parents: ['research'] },
      { ref: 'compare', title: 'Compare A and B', assignee: 'worker', parents: ['a', 'b'] },
      { ref: 'write', title: 'Write it up', assignee: 'worker', parents: ['compare'] },
    ],
  };

  it('makes the graph all at once, answering each task with its ref, its key taken off before the DAG is checked', async () => {
    const r = await ask('apply-dag', { ...graph, idempotency_key: 'g-1' });
    expect(r).toMatchObject({ ok: true, existing: false, board: 'default' });
    const tasks = (r as unknown as { tasks: Array<{ task_id: string; ref: string }> }).tasks;
    expect(tasks.map((x) => x.ref)).toEqual(['research', 'a', 'b', 'compare', 'write']);
    expect(parentsOf(t.db, tasks[3]?.task_id ?? '').map((p) => p.taskId).sort()).toEqual([tasks[1]?.task_id, tasks[2]?.task_id].sort());
    expect(changes).toBe(1);
    expect(await ask('apply-dag', { ...graph, idempotency_key: 'g-1' })).toMatchObject({ ok: true, existing: true, instance_id: (r as unknown as { instance_id: string }).instance_id });
  });

  it('with dry_run checks it and makes nothing, answering dry_run with no instance id, or the instance its key made', async () => {
    const dry = await ask('apply-dag', { ...graph, dry_run: true });
    expect(dry).toEqual({
      ok: true,
      dry_run: true,
      existing: false,
      board: 'default',
      tasks: graph.tasks.map((x) => ({ ref: x.ref, step: x.ref, item: null, gates: [] })),
    });
    expect(changes).toBe(0);
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_workflow_instances').get()).toEqual({ n: 0 });
    expect(await ask('apply-dag', { ...graph, dry_run: true, tasks: [{ ref: 'x', title: 'X', assignee: 'ghost' }] })).toEqual({
      ok: false,
      code: 'unknown_role',
      message: 'x: role "ghost" is not configured',
    });
    const made = await ask('apply-dag', { ...graph, idempotency_key: 'g' });
    expect(await ask('apply-dag', { ...graph, idempotency_key: 'g', dry_run: true })).toMatchObject({
      ok: true,
      dry_run: true,
      existing: true,
      instance_id: (made as unknown as { instance_id: string }).instance_id,
    });
    expect(await ask('apply-dag', { ...graph, dry_run: 'yes' })).toEqual({ ok: false, code: 'invalid', message: 'dry_run is true or false' });
  });

  it("refuses gates, a setting create does not take, a workflow name, params, and another board", async () => {
    const one = (task: Record<string, unknown>, top: Record<string, unknown> = {}) => ask('apply-dag', { format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'worker', ...task }], ...top });
    expect(await one({ gates: [{ command: 'npm test' }] })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/apply-dag takes none/) });
    expect(await one({ max_runtime_s: 60 })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^tasks\[0\] \(a\) sets max_runtime_s/) });
    expect(await one({}, { workflow: 'vendor-eval' })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^apply-dag takes no workflow name/) });
    expect(await one({}, { params: { topic: 'x' } })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^apply-dag takes no params/) });
    createBoard(t.db, 'research', ALICE, NOW);
    expect(await one({}, { board: 'research' })).toEqual({ ok: false, code: 'other_board', message: "the DAG is for board research, and a run's work stays on its task's board, default" });
    expect(await one({}, { colour: 'red' })).toEqual({ ok: false, code: 'invalid', message: 'a DAG takes no key "colour" (it takes format, workflow, params, board, tasks)' });
    expect(await one({}, { idempotency_key: 7 })).toEqual({ ok: false, code: 'invalid', message: 'idempotency_key is text, of at most 256 bytes' });
    expect(changes).toBe(0);
  });
});

describe('the work protocol', () => {
  it('names start-workflow and apply-dag, saying apply-dag takes no gates', () => {
    const task = getTask(t.db, planner);
    if (task === undefined) throw new Error('no task');
    const prompt = composePrompt(briefFor(t.db, { run: plannerRun, task, roleMd: undefined, role: undefined }));
    expect(prompt).toContain('`mt kanban start-workflow < start.json`, with {"workflow": "...", "params": {...}}');
    expect(prompt).toContain('`mt kanban apply-dag < dag.json`');
    expect(prompt).toContain('makes a graph of tasks at once, all or none; it takes no gates.');
    expect(prompt).toContain('or start a workflow for it with `mt kanban start-workflow`, or make a graph of tasks at once with `mt kanban apply-dag`.');
  });
});

describe('mt kanban apply-dag and mt kanban workflow in a run\'s shell', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mt-wf-worker-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function mt(argv: string[], stdin = '') {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(argv, {
      env: { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 'tok', MT_KANBAN_SOCKET: join(root, 'none.sock'), HOME: root },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      stdinIsTTY: false,
      stdin: async (max) => (Buffer.byteLength(stdin) > max ? undefined : Buffer.from(stdin)),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('refuses a DAG over 192 KiB in its canonical form before sending it, and sends one within it', async () => {
    const base = { format: 1, tasks: [{ ref: 'a', title: 'A', body: 'x' }] };
    const shaped = checkDagShape(base, 'terminal');
    if (!shaped.ok) throw new Error(shaped.message);
    const pad = DAG_LIMITS.runBytes - canonicalDag(shaped.dag).length + 1;
    const over = { ...base, tasks: [{ ref: 'a', title: 'A', body: 'x'.repeat(pad + 1) }], dry_run: true };
    const r = await mt(['kanban', 'apply-dag'], JSON.stringify(over));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({
      ok: false,
      code: 'too_large',
      message: `the DAG is ${DAG_LIMITS.runBytes + 1} bytes in its canonical form; it may be at most ${DAG_LIMITS.runBytes} from a run`,
    });
    const within = await mt(['kanban', 'apply-dag'], JSON.stringify({ ...over, tasks: [{ ref: 'a', title: 'A', body: 'x'.repeat(pad) }] }));
    expect(JSON.parse(within.out)).toMatchObject({ ok: false, code: 'unreachable' });
  });

  it('refuses mt kanban workflow, naming start-workflow and apply-dag', async () => {
    const r = await mt(['kanban', 'workflow', 'start', 'vendor-eval', '--param', 'topic=x']);
    expect(r).toEqual({
      code: 1,
      out: '',
      err:
        "mt: mt kanban workflow start is an operator's command, not a board run's: this shell has MT_KANBAN_RUN or MT_KANBAN_TOKEN set. " +
        'Run it from your own shell; a board run starts a workflow with mt kanban start-workflow, and makes a DAG of its own with mt kanban apply-dag',
    });
    const json = await mt(['kanban', 'workflow', 'apply', 'dag.json', '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, code: 'operator_command' });
  });
});
```

In `tests/mt-kanban.test.ts`, replace:

```ts
    expect(out.join('\n')).toContain('mt kanban <show|complete|review|changes|block|comment|create|link> < input.json');
```

with:

```ts
    expect(out.join('\n')).toContain('mt kanban <show|complete|review|changes|block|comment|create|link|start-workflow|apply-dag> < input.json');
```

In `tests/mt.test.ts`, replace:

```ts
    expect(usage).toContain('  mt kanban <show|complete|review|changes|block|comment|create|link> < input.json');
```

with:

```ts
    expect(usage).toContain('  mt kanban <show|complete|review|changes|block|comment|create|link|start-workflow|apply-dag> < input.json');
```

- [ ] **Step 16.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-worker.test.ts`. Expected: `Tests  9 failed (9)`; the first failure: `AssertionError: expected { ok: false, …(2) } to deeply equal { ok: true, …(4) }`.

- [ ] **Step 16.3: Implement.**

In `src/cli/kanban.ts`, replace:

```ts
import type { Readable } from 'node:stream';
```

with:

```ts
import type { Readable } from 'node:stream';
import { checkDagShape } from '../kanban/dag.js';
```

In `src/cli/kanban.ts`, replace:

```ts
    }
  }
```

with:

```ts
    }
    // A DAG's canonical form over 192 KiB is refused here, before it is sent (spec §21.5); any other
    // refusal of its shape is the gateway's, which says it the same way.
    if (command === 'apply-dag' && typeof input === 'object' && input !== null && !Array.isArray(input)) {
      const { idempotency_key: _key, dry_run: _dryRun, ...dag } = input as Record<string, unknown>;
      const shaped = checkDagShape(dag, 'run');
      if (!shaped.ok && shaped.code === 'too_large') {
        say({ ok: false, code: 'too_large', message: shaped.message });
        return 1;
      }
    }
  }
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban <show|complete|review|changes|block|comment|create|link> < input.json',
```

with:

```ts
  `  mt kanban <${WORKER_COMMANDS.join('|')}> < input.json`,
```

In `src/cli/mt.ts`, replace:

```ts
const OPERATOR_GROUPS: readonly string[] = ['task', 'board', 'gate'];
```

with:

```ts
const OPERATOR_GROUPS: readonly string[] = ['task', 'board', 'gate', 'workflow'];
```

In `src/cli/mt.ts`, replace:

```ts
  gate: ['add', 'list', 'remove'],
```

with:

```ts
  gate: ['add', 'list', 'remove'],
  workflow: ['list', 'instances', 'show', 'preview', 'start', 'apply', 'archive'],
```

In `src/cli/mt.ts`, replace:

```ts
  const message = runShellRefusal(what);
```

with:

```ts
  // A run starts a workflow, or applies a DAG of its own, with the worker's commands (spec §21.6).
  const message =
    command === 'workflow'
      ? `${runShellRefusal(what)}; a board run starts a workflow with mt kanban start-workflow, and makes a DAG of its own with mt kanban apply-dag`
      : runShellRefusal(what);
```

In `src/kanban/prompt.ts`, replace:

```ts
- \`mt kanban link < link.json\`, with {"parent_id": "...", "child_id": "..."}, makes one task wait on another; it only works on a task that has not started yet, so sequence follow-ups by creating them in order, each naming the earlier ones in "parents".

When the task is done, the summary says what was done and where its results are, such as files, documents or links. Block only on genuine ambiguity, and say why. If the task names no reviewer and one of the task's children below reviews this task, report complete rather than review. If you find follow-up work, create a task for it with \`mt kanban create\` rather than doing it. Never put a secret in a summary, metadata or comment. Stop once you have reported.`;
```

with:

```ts
- \`mt kanban link < link.json\`, with {"parent_id": "...", "child_id": "..."}, makes one task wait on another; it only works on a task that has not started yet, so sequence follow-ups by creating them in order, each naming the earlier ones in "parents";
- \`mt kanban start-workflow < start.json\`, with {"workflow": "...", "params": {...}} and optionally "idempotency_key", starts a workflow the operator wrote, making all of its tasks at once; a refusal names the workflows there are, and their params;
- \`mt kanban apply-dag < dag.json\`, with {"format": 1, "tasks": [{"ref": "...", "title": "...", "assignee": ${WHO}, "parents": [refs of earlier tasks]}, ...]}, and optionally "idempotency_key" and "dry_run": true to check it and make nothing, makes a graph of tasks at once, all or none; it takes no gates.

When the task is done, the summary says what was done and where its results are, such as files, documents or links. Block only on genuine ambiguity, and say why. If the task names no reviewer and one of the task's children below reviews this task, report complete rather than review. If you find follow-up work, create a task for it with \`mt kanban create\` rather than doing it, or start a workflow for it with \`mt kanban start-workflow\`, or make a graph of tasks at once with \`mt kanban apply-dag\`. Never put a secret in a summary, metadata or comment. Stop once you have reported.`;
```

In `src/kanban/worker.ts`, replace:

```ts
import type { KanbanService } from './service.js';
```

with:

```ts
import { DAG_LIMITS } from './dag.js';
import type { KanbanService, WorkflowMade } from './service.js';
```

In `src/kanban/worker.ts`, replace:

```ts
export const WORKER_COMMANDS = ['show', 'complete', 'review', 'changes', 'block', 'comment', 'create', 'link'] as const;
```

with:

```ts
export const WORKER_COMMANDS = [
  'show',
  'complete',
  'review',
  'changes',
  'block',
  'comment',
  'create',
  'link',
  'start-workflow',
  'apply-dag',
] as const;
```

In `src/kanban/worker.ts`, replace:

```ts
  | { kind: 'contract' };
```

with:

```ts
  | { kind: 'contract' }
  /** A workflow's params (spec §21.6): an object of text and lists of text, within their sizes. */
  | { kind: 'params' };
```

In `src/kanban/worker.ts`, replace:

```ts
  link: { parent_id: name(), child_id: name() },
```

with:

```ts
  link: { parent_id: name(), child_id: name() },
  'start-workflow': { workflow: name(), params: { kind: 'params' }, idempotency_key: name(false) },
  // A DAG, read by the DAG's own checks (spec §21.5) rather than this flat schema; its two keys of its own are taken off first.
  'apply-dag': {},
```

In `src/kanban/worker.ts`, replace:

```ts
        break;
      case 'contract':
```

with:

```ts
        break;
      case 'params': {
        if (!isRecord(value) || !Object.values(value).every((v) => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')))) {
          return refused('invalid', `${key} is an object of text and lists of text`);
        }
        const size = bytes(JSON.stringify(value));
        if (size > DAG_LIMITS.paramsBytes) {
          return refused('too_large', `${key} is ${size} bytes as JSON; at most ${DAG_LIMITS.paramsBytes} together`);
        }
        break;
      }
      case 'contract':
```

In `src/kanban/worker.ts`, replace:

```ts
    const bad = badInput(command, input);
    if (bad !== undefined) return bad;
    const r = await this.#act(command, run, input, opts);
    if (r.ok && command !== 'show') this.#changed();
```

with:

```ts
    const bad = command === 'apply-dag' ? undefined : badInput(command, input);
    if (bad !== undefined) return bad;
    const r = await this.#act(command, run, input, opts);
    // A dry run made nothing, and so is no change to look at.
    if (r.ok && command !== 'show' && r['dry_run'] !== true) this.#changed();
```

In `src/kanban/worker.ts`, replace:

```ts
        return r.ok ? { ok: true, added: r.added } : refusal(r);
```

with:

```ts
        return r.ok ? { ok: true, added: r.added } : refusal(r);
      }
      case 'start-workflow': {
        // On the run's task's board, whatever else, created from its task (spec §21.6).
        const key = str('idempotency_key');
        const r = this.#service.startWorkflow({
          workflow: str('workflow') ?? '',
          params: { from: 'json', params: input['params'] ?? {} },
          ...(key === undefined ? {} : { idempotencyKey: key }),
          createdBy: actor,
          createdVia: { kind: 'run', runId: run.runId },
        });
        return r.ok ? madeAnswer(r) : refusal(r);
      }
      case 'apply-dag': {
        // Its own two keys, beside the DAG's, are taken off before the DAG is checked (spec §21.6).
        const { idempotency_key: key, dry_run: dryRun, ...dag } = input;
        if (key !== undefined && key !== null && (typeof key !== 'string' || bytes(key) > WORKER_LIMITS.name)) {
          return refused('invalid', `idempotency_key is text, of at most ${WORKER_LIMITS.name} bytes`);
        }
        if (dryRun !== undefined && dryRun !== null && typeof dryRun !== 'boolean') return refused('invalid', 'dry_run is true or false');
        const r = this.#service.applyDag({
          dag,
          ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
          ...(dryRun === true ? { dryRun: true } : {}),
          createdBy: actor,
          createdVia: { kind: 'run', runId: run.runId },
        });
        if (!r.ok) return refusal(r);
        if (!('dryRun' in r)) return madeAnswer(r);
        return {
          ok: true,
          dry_run: true,
          existing: r.existing,
          ...(r.instanceId === null ? {} : { instance_id: r.instanceId }),
          board: r.board,
          tasks: r.tasks.map((t) => ({ ref: t.ref, step: t.step, item: t.item, gates: t.gates })),
        };
```

In `src/kanban/worker.ts`, replace:

```ts

/** A report's answer: where the task is now, and the run's outcome. */
```

with:

```ts

/** A start's or an apply's answer (spec §21.6): the instance, and each task with its ref, so an agent finds the task it named. */
function madeAnswer(r: WorkflowMade): WorkerResponse {
  return {
    ok: true,
    instance_id: r.instance.instanceId,
    existing: r.existing,
    board: r.instance.board,
    tasks: r.tasks.map((t) => ({ task_id: t.taskId, ref: t.ref, step: t.step, item: t.item })),
  };
}

/** A report's answer: where the task is now, and the run's outcome. */
```

- [ ] **Step 16.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2160 passed (2160)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 16.5: Commit.**

```bash
git add src/cli/kanban.ts src/cli/mt.ts src/kanban/prompt.ts src/kanban/worker.ts tests/kanban-worker.test.ts tests/kanban-workflow-worker.test.ts tests/mt-kanban.test.ts tests/mt.test.ts
git commit -m "Add the worker's start-workflow and apply-dag, with a params field and the DAG's own checks, apply-dag's dry run and its 192 KiB checked before sending, their lines in the work protocol, and mt kanban workflow refused in a run's shell naming them"
```

---

### Task 17: `mt kanban workflow` at the terminal

**Files:**

- Create: `tests/mt-kanban-workflow.test.ts`
- Modify: `src/cli/gate.ts`, `src/cli/mt.ts`, `src/cli/operator.ts`, `src/cli/plain.ts`, `src/kanban/service.ts`, `src/kanban/workflow.ts`

Spec §2.6, §21.6, §21.10. `src/cli/gate.ts`: `loadOperator` is `openBoard`'s loading, the settings, the team, the secrets and the note on unset passEnv names, with no database; `openBoard` calls it, takes `workflows: true` to look for the workflows' tables and refuse `no_board` with "start the gateway once, so it is migrated", and gives the service `workflowsDir`. `src/cli/operator.ts`: `preview` (as `openBoard` loads, opening no database, supervised roles accepted and no person; `--json` writes the DAG file alone on stdout, a refusal on stderr), `start` and `apply` (a regular file or `-`, up to 4 MiB, decoded strictly, as JSON; `--dry-run` lists each gate's command), both with `--key`, answering every task, uncut, or the worker's shape with `--json`, then the nudge; `list`, `instances`, `show` (`--board` refusing `unknown_board` and `other_board`, `--dag` printing the stored DAG masked, never the hash) and `archive`. `usableMessage` moves into `workflow.ts`, shared by the service and the preview. `src/cli/plain.ts` gives their plain text, and `mt`'s usage lists them.

- [ ] **Step 17.1: Write the tests.**

Create `tests/mt-kanban-workflow.test.ts`:

```ts
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { createBoard } from '../src/db/kanban.js';
import { getInstance, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { MASK, clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { NOW } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * The operator's workflow commands (spec §21.6, §21.10): `mt kanban workflow
 * preview`, with `--json` writing the DAG file, `start`, `apply` and `apply
 * --dry-run`, `list`, `instances`, `show` with `--dag`, and `archive`; their
 * plain and `--json` answers, the nudge, and an unmigrated database.
 */

const ME = `operator:${userInfo().username}`;
const SECRET = 'sk-live-1234567890';

let f: MtFixture;
let gateway: Db;
let server: WorkerServer | undefined;
let nudges: number;

function config(enabled: boolean): (workspace: string) => string {
  return (workspace) =>
    [
      `workspace: ${workspace}`,
      ...(enabled ? ['kanban:', '  enabled: true'] : []),
      'agent:',
      '  driver: structured-cli',
      '  command: bytesec',
      '  unsupervised: true',
      '',
    ].join('\n');
}

async function setUp(enabled = true): Promise<void> {
  clearSecrets();
  f = mtFixture(config(enabled));
  for (const name of ['worker', 'reviewer']) {
    mkdirSync(join(f.home, 'roles', name), { recursive: true });
    writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  }
  mkdirSync(join(f.home, 'workflows'));
  writeFileSync(join(f.home, 'workflows', 'vendor-eval.yaml'), VENDOR_EVAL);
  writeFileSync(join(f.home, '.env'), `LARK_APP_SECRET=${SECRET}\n`, { mode: 0o600 });
  gateway = openDb(join(f.home, 'team.db'));
  migrate(gateway, SCHEMA_DIR);
  nudges = 0;
  server = await listenWorker(workerSocketPath(f.home), () => {
    nudges += 1;
    return { ok: true };
  });
}

beforeEach(async () => setUp());
afterEach(async () => {
  clearSecrets();
  await server?.close();
  server = undefined;
  gateway.close();
  f.cleanup();
});

async function mt(argv: string[], opts: { stdin?: string; env?: Record<string, string | undefined> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['kanban', 'workflow', ...argv], {
    env: { ...f.env, HOME: f.root, ...opts.env },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdinIsTTY: false,
    stdin: async (max) => {
      const text = opts.stdin ?? '';
      return Buffer.byteLength(text) > max ? undefined : Buffer.from(text);
    },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const PARAMS = ['--param', 'topic=log storage', '--param', 'vendors=acme,globex'];
const count = (table: string): number => (gateway.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('mt kanban workflow preview', () => {
  it('prints the same summary as chat, and with --json the DAG file, byte for byte the same twice, every key written', async () => {
    const plain = await mt(['preview', 'vendor-eval', ...PARAMS]);
    expect(plain.code).toBe(0);
    expect(plain.out.split('\n')).toEqual([
      'vendor-eval would make 4 tasks, on board default:',
      '  shortlist   Shortlist vendors for log storage   role worker',
      '  evaluate:1  Evaluate acme for log storage       role worker  after shortlist               1 gate',
      '  evaluate:2  Evaluate globex for log storage     role worker  after shortlist               1 gate',
      '  recommend   Recommend a vendor for log storage  role worker  after evaluate:1, evaluate:2',
      'nothing was made: mt kanban workflow start vendor-eval, with these params, makes it',
    ]);
    const a = await mt(['preview', 'vendor-eval', ...PARAMS, '--json']);
    const b = await mt(['preview', 'vendor-eval', ...PARAMS, '--json']);
    expect(a).toEqual(b);
    const dag = JSON.parse(a.out) as { board: string; tasks: Array<Record<string, unknown>> };
    expect(dag.board).toBe('default');
    expect(Object.keys(dag.tasks[1] ?? {})).toEqual([
      'ref', 'step', 'item', 'title', 'body', 'assignee', 'reviewer', 'workspace', 'priority', 'contract', 'failure_limit', 'retry_on_crash', 'max_runtime_s', 'parents', 'gates',
    ]);
    expect(a.out).toBe(JSON.stringify(dag, null, 2));
    expect([count('kanban_tasks'), count('kanban_workflow_instances')]).toEqual([0, 0]);
  });

  it('writes a refusal on stderr and nothing on stdout, and refuses a person as at the terminal', async () => {
    expect(await mt(['preview', 'vendor-eval', '--param', 'topic=x', '--json'])).toEqual({ code: 1, out: '', err: 'mt: workflow vendor-eval needs param vendors' });
    writeFileSync(join(f.home, 'workflows', 'ask.yaml'), 'params:\n  owner: { required: true }\nsteps:\n  ask: { title: Ask, assignee: "{{owner}}" }\n');
    expect((await mt(['preview', 'ask', '--param', 'owner=lark:on_bob'])).err).toBe(
      'mt: ask: "lark:on_bob" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
    );
    expect((await mt(['preview', 'nope'])).err).toMatch(/^mt: there is no workflow nope; the usable ones are /);
    expect((await mt(['preview', 'vendor-eval', '--param', 'topic'])).code).toBe(2);
  });

  it('opens no database: it works with none there', async () => {
    gateway.close();
    const { rmSync } = await import('node:fs');
    for (const name of readdirSync(f.home)) if (name.startsWith('team.db')) rmSync(join(f.home, name));
    expect((await mt(['preview', 'vendor-eval', ...PARAMS])).code).toBe(0);
    gateway = openDb(join(f.home, 'team.db'));
  });
});

describe('mt kanban workflow start', () => {
  it('starts it as the operator, answering every task, followed by no chat, and nudges the gateway', async () => {
    const r = await mt(['start', 'vendor-eval', ...PARAMS, '--key', 'ls-1']);
    expect(r.code).toBe(0);
    const [head, ...rows] = r.out.split('\n');
    expect(head).toMatch(/^started vendor-eval as w_[0-9a-z]+, on board default, 4 tasks$/);
    expect(rows.map((l) => l.trim().split(/\s{2,}/))).toEqual([
      [expect.stringMatching(/^k_/), 'shortlist', 'Shortlist vendors for log storage', 'role worker'],
      [expect.stringMatching(/^k_/), 'evaluate:1', 'Evaluate acme for log storage', 'role worker'],
      [expect.stringMatching(/^k_/), 'evaluate:2', 'Evaluate globex for log storage', 'role worker'],
      [expect.stringMatching(/^k_/), 'recommend', 'Recommend a vendor for log storage', 'role worker'],
    ]);
    expect(nudges).toBe(1);
    const id = /as (w_[0-9a-z]+)/.exec(head ?? '')?.[1] ?? '';
    const instance = getInstance(gateway, id);
    expect(instance).toMatchObject({ createdBy: ME, createdVia: { kind: 'operator' }, idempotencyKey: 'operator:ls-1' });
    const again = await mt(['start', 'vendor-eval', ...PARAMS, '--key', 'ls-1', '--json']);
    expect(JSON.parse(again.out)).toMatchObject({ ok: true, instance_id: id, existing: true, board: 'default', nudged: false });
    expect(nudges).toBe(1);
    const tasks = (JSON.parse(again.out) as { tasks: Array<{ task_id: string }> }).tasks;
    for (const t of tasks) expect(subscriptionsOf(gateway, t.task_id)).toEqual([]);
  });

  it("says the board is off when the config leaves kanban.enabled unset, and asks no gateway", async () => {
    await server?.close();
    server = undefined;
    gateway.close();
    f.cleanup();
    await setUp(false);
    const r = await mt(['start', 'vendor-eval', ...PARAMS, '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, existing: false, nudged: false });
    expect(r.err).toMatch(/^mt: the board is off on this gateway \(its config does not set kanban\.enabled\)/);
    expect(nudges).toBe(0);
  });

  it('puts it on --board, and refuses an unknown one', async () => {
    createBoard(gateway, 'research', ME, NOW);
    expect((await mt(['start', 'vendor-eval', ...PARAMS, '--board', 'research'])).out).toMatch(/on board research, 4 tasks/);
    expect(await mt(['start', 'vendor-eval', ...PARAMS, '--board', 'nowhere'])).toEqual({ code: 1, out: '', err: 'mt: there is no board nowhere' });
  });
});

describe('mt kanban workflow apply', () => {
  async function previewed(): Promise<string> {
    const path = join(f.root, 'dag.json');
    writeFileSync(path, (await mt(['preview', 'vendor-eval', ...PARAMS, '--json'])).out);
    return path;
  }

  it('with --dry-run makes every check, writes nothing, and lists each gate\'s command', async () => {
    const path = await previewed();
    const dry = await mt(['apply', path, '--dry-run']);
    expect(dry).toEqual({
      code: 0,
      out: [
        'would make 4 tasks, 4 links, 2 gates, on board default; nothing was made',
        '  shortlist  Shortlist vendors for log storage  role worker',
        '  evaluate:1  Evaluate acme for log storage  role worker, after shortlist',
        '    gate: test -s evaluation.md (up to 30 s)',
        '  evaluate:2  Evaluate globex for log storage  role worker, after shortlist',
        '    gate: test -s evaluation.md (up to 30 s)',
        '  recommend  Recommend a vendor for log storage  role worker, after evaluate:1, evaluate:2',
      ].join('\n'),
      err: '',
    });
    expect(JSON.parse((await mt(['apply', path, '--dry-run', '--json'])).out)).toMatchObject({ ok: true, dry_run: true, existing: false, board: 'default' });
    expect([count('kanban_tasks'), nudges]).toEqual([0, 0]);
  });

  it('makes exactly the DAG, a file edited since the preview changing nothing, a repeat by key existing', async () => {
    const path = await previewed();
    writeFileSync(join(f.home, 'workflows', 'vendor-eval.yaml'), 'steps: {}\n');
    const r = await mt(['apply', path, '--key', 'a-1', '--json']);
    const answer = JSON.parse(r.out) as { instance_id: string; existing: boolean; tasks: Array<{ ref: string }> };
    expect(answer).toMatchObject({ ok: true, existing: false, nudged: true });
    expect(answer.tasks.map((t) => t.ref)).toEqual(['shortlist', 'evaluate:1', 'evaluate:2', 'recommend']);
    expect((await mt(['apply', path, '--key', 'a-1'])).out.split('\n')[0]).toBe(
      `already made, as ${answer.instance_id}, on board default, 4 tasks; nothing new was made`,
    );
    expect(JSON.parse((await mt(['apply', path, '--key', 'a-1', '--dry-run', '--json'])).out)).toMatchObject({ dry_run: true, existing: true, instance_id: answer.instance_id });
  });

  it('reads stdin for -, refusing bytes that are not UTF-8, a byte order mark, and a file past 4 MiB', async () => {
    const dag = JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'worker' }] });
    expect((await mt(['apply', '-'], { stdin: dag })).out).toMatch(/^applied a DAG with no workflow as w_[0-9a-z]+, on board default, 1 task\n/);
    const broken = join(f.root, 'broken.json');
    writeFileSync(broken, Buffer.concat([Buffer.from('{"format": 1, "tasks": [{"ref": "a", "title": "'), Buffer.from([0xff]), Buffer.from('"}]}')]));
    expect(await mt(['apply', broken])).toEqual({ code: 1, out: '', err: `mt: the DAG in ${broken} is not UTF-8` });
    expect(await mt(['apply', '-'], { stdin: `\uFEFF${dag}` })).toEqual({ code: 1, out: '', err: 'mt: the DAG is not JSON' });
    const big = join(f.root, 'big.json');
    writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    expect(await mt(['apply', big])).toEqual({ code: 1, out: '', err: `mt: ${big} is ${4 * 1024 * 1024 + 1} bytes; a DAG file is read up to ${4 * 1024 * 1024}` });
  });
});

describe('mt kanban workflow list, instances, show and archive', () => {
  it('lists the files, the board\'s instances, shows one, its stored DAG masked with no hash, and archives it', async () => {
    writeFileSync(join(f.home, 'workflows', 'broken.yaml'), 'steps: {}\n');
    expect((await mt(['list'])).out.split('\n')).toEqual([
      'broken: not usable: the file needs steps, at least one',
      'vendor-eval: params topic (required), vendors (list, required), reviewer (default reviewer) · Shortlist vendors, evaluate each in parallel, then recommend one',
    ]);
    const started = JSON.parse((await mt(['start', 'vendor-eval', '--param', `topic=logs ${SECRET}`, '--param', 'vendors=acme', '--json'])).out) as { instance_id: string; tasks: Array<{ task_id: string }> };
    const id = started.instance_id;
    const listed = (await mt(['instances'])).out.split('\n');
    expect(listed[0]).toMatch(/^instance\s+workflow\s+status\s+members\s+by\s+when$/);
    expect(listed[1]).toMatch(new RegExp(`^${id}\\s+vendor-eval\\s+running\\s+0 of 3 done\\s+${ME}\\s+\\d{4}-`));
    const shown = (await mt(['show', id])).out.split('\n');
    expect(shown[0]).toBe(`vendor-eval (${id}): running, 0 of 3 done, on board default`);
    expect(shown).toContain(`params: reviewer: reviewer · topic: logs ${MASK} · vendors: acme`);
    const json = JSON.parse((await mt(['show', id, '--json'])).out) as { tasks: Array<{ phase: string; status: string }> };
    expect(json.tasks.map((t) => [t.phase, t.status])).toEqual([
      ['open', 'ready'],
      ['open', 'todo'],
      ['open', 'todo'],
    ]);
    const dag = (await mt(['show', id, '--dag'])).out;
    expect(JSON.parse(dag)).toMatchObject({ format: 1, workflow: 'vendor-eval', params: { topic: `logs ${MASK}` } });
    expect(dag).not.toContain(getInstance(gateway, id)?.dagSha256 ?? 'none');
    createBoard(gateway, 'research', ME, NOW);
    expect(await mt(['show', id, '--board', 'research'])).toEqual({ code: 1, out: '', err: `mt: instance ${id} is on board default, not research` });
    expect(await mt(['show', id, '--board', 'nowhere'])).toEqual({ code: 1, out: '', err: 'mt: there is no board nowhere' });
    const before = nudges;
    expect((await mt(['archive', id])).out).toBe(`archived 3 tasks of ${id} (vendor-eval); its related tasks are left as they are`);
    expect(nudges).toBe(before + 1);
    for (const t of started.tasks) expect(getTask(gateway, t.task_id)?.phase).toBe('archived');
    expect((await mt(['archive', id])).out).toBe(`every task of ${id} is archived already; nothing changed`);
    expect((await mt(['instances'])).out).toBe('no running or blocked workflow instances on board default; mt kanban workflow instances all shows done and archived ones too');
  });

  it('re-applies a shown DAG to make a like instance', async () => {
    const id = (JSON.parse((await mt(['start', 'vendor-eval', ...PARAMS, '--json'])).out) as { instance_id: string }).instance_id;
    const path = join(f.root, 'again.json');
    writeFileSync(path, (await mt(['show', id, '--dag'])).out);
    const again = JSON.parse((await mt(['apply', path, '--json'])).out) as { instance_id: string; tasks: unknown[] };
    expect(again.instance_id).not.toBe(id);
    expect(again.tasks).toHaveLength(4);
  });
});

describe("mt's usage", () => {
  it('lists the workflow commands', async () => {
    const out: string[] = [];
    expect(await runMt(['help'], { env: f.env, out: (l) => out.push(l), err: () => undefined })).toBe(0);
    const usage = out.join('\n');
    expect(usage).toContain('  mt workflow check [<name>]');
    expect(usage).toContain('  mt kanban workflow preview <name> [--board <name>] [--param <key>=<value>]... [--json]');
    expect(usage).toContain('  mt kanban workflow apply <dag.json|-> [--key <key>] [--dry-run] [--json]');
    expect((await mt(['nonsense'])).err).toMatch(/^mt: kanban workflow takes list, instances, show, preview, start, apply or archive/);
  });
});

describe('an unmigrated database', () => {
  it('refuses the workflow commands no_board, changing nothing', async () => {
    gateway.close();
    const { rmSync } = await import('node:fs');
    for (const name of readdirSync(f.home)) if (name.startsWith('team.db')) rmSync(join(f.home, name));
    const dir = mkdtempSync(join(f.root, 'schema-'));
    for (const name of readdirSync(SCHEMA_DIR)) if (/^00[1-8]_.*\.sql$/.test(name)) copyFileSync(join(SCHEMA_DIR, name), join(dir, name));
    gateway = openDb(join(f.home, 'team.db'));
    migrate(gateway, dir);
    const db = join(f.home, 'team.db');
    for (const argv of [['list'], ['instances'], ['start', 'vendor-eval', ...PARAMS], ['show', 'w_x']]) {
      expect(await mt(argv)).toEqual({ code: 1, out: '', err: `mt: the database at ${db} has no workflows yet: start the gateway once, so it is migrated` });
    }
    expect(JSON.parse((await mt(['list', '--json'])).out)).toMatchObject({ ok: false, code: 'no_board' });
  });
});
```

- [ ] **Step 17.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-kanban-workflow.test.ts`. Expected: `Tests  13 failed (13)`; the first failure: `AssertionError: expected 2 to be +0 // Object.is equality`.

- [ ] **Step 17.3: Implement.**

In `src/cli/gate.ts`, replace:

```ts
import { loadTeamSettings, type Env } from '../config.js';
```

with:

```ts
import { join } from 'node:path';
import { loadTeamSettings, type Env, type TeamSettings } from '../config.js';
```

In `src/cli/gate.ts`, replace:

```ts
import { loadTeam, teamSecrets } from '../team.js';
```

with:

```ts
import { loadTeam, teamSecrets, type Team } from '../team.js';
```

In `src/cli/gate.ts`, replace:

```ts
}

/** The board, as the gateway's own service over its database; or why not, already said. */
export function openBoard(io: MtIo, what: string, opts: OpenOptions = {}): BoardAccess | number {
```

with:

```ts
  /** The workflow commands need the workflows' tables too (spec §21.7): a database not migrated to them is refused. */
  workflows?: boolean;
}

/**
 * The gateway's settings and team, loaded as the gateway loads them, with the
 * secrets it would register, and the passEnv names this shell leaves unset said
 * on stderr; or why not, already said. What `openBoard` does before it opens the
 * database, and all the terminal's workflow preview does, which opens none (spec §21.6).
 */
export function loadOperator(io: MtIo, what: string, opts: OpenOptions = {}): { settings: TeamSettings; team: Team } | number {
```

In `src/cli/gate.ts`, replace:

```ts
  }
  if (!existsSync(settings.dbPath)) {
```

with:

```ts
  }
  return { settings, team };
}

/** The board, as the gateway's own service over its database; or why not, already said. */
export function openBoard(io: MtIo, what: string, opts: OpenOptions = {}): BoardAccess | number {
  const no = opts.refuse ?? ((_code: string, message: string) => refuse(io, message));
  const loaded = loadOperator(io, what, opts);
  if (typeof loaded === 'number') return loaded;
  const { settings, team } = loaded;
  if (!existsSync(settings.dbPath)) {
```

In `src/cli/gate.ts`, replace:

```ts
  try {
    migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_gates'").get();
```

with:

```ts
  // The table the command needs: the board's, or for the workflow commands the workflows' (spec §21.7).
  const table = opts.workflows === true ? 'kanban_workflow_instances' : 'kanban_gates';
  try {
    migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
```

In `src/cli/gate.ts`, replace:

```ts
    return no('no_board', `the database at ${settings.dbPath} has no board yet: start the gateway once, so it is migrated`);
```

with:

```ts
    const has = opts.workflows === true ? 'no workflows yet' : 'no board yet';
    return no('no_board', `the database at ${settings.dbPath} has ${has}: start the gateway once, so it is migrated`);
```

In `src/cli/gate.ts`, replace:

```ts
    ...(settings.kanban?.maxRunningPerRole === undefined ? {} : { maxRunningPerRole: settings.kanban.maxRunningPerRole }),
```

with:

```ts
    ...(settings.kanban?.maxRunningPerRole === undefined ? {} : { maxRunningPerRole: settings.kanban.maxRunningPerRole }),
    // As the gateway's: the operator's files, read at each preview and start (spec §21.1).
    workflowsDir: join(settings.home, 'workflows'),
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban gate remove <task_id> <gate_id>',
```

with:

```ts
  '  mt kanban gate remove <task_id> <gate_id>',
  '  mt kanban workflow list [--json]',
  '  mt kanban workflow instances [all] [--board <name>] [--json]',
  '  mt kanban workflow show <instance> [--board <name>] [--dag | --json]',
  '  mt kanban workflow preview <name> [--board <name>] [--param <key>=<value>]... [--json]',
  '  mt kanban workflow start <name> [--board <name>] [--param <key>=<value>]... [--key <key>] [--json]',
  '  mt kanban workflow apply <dag.json|-> [--key <key>] [--dry-run] [--json]',
  '  mt kanban workflow archive <instance> [--board <name>] [--json]',
```

In `src/cli/operator.ts`, replace:

```ts
import { listed, whenMade } from '../kanban/chat-render.js';
import { boardSetting, isPerson, LIST_FILTERS, tooBig, type NewTaskCommand } from '../kanban/chat-parse.js';
import type { KanbanService } from '../kanban/service.js';
```

with:

```ts
import { join } from 'node:path';
import { listed, previewLines, whenMade } from '../kanban/chat-render.js';
import { boardSetting, isPerson, LIST_FILTERS, tooBig, type NewTaskCommand } from '../kanban/chat-parse.js';
import { DAG_LIMITS, checkDagShape, checkDagTasks, dagFile } from '../kanban/dag.js';
import { WORKFLOW_MESSAGE_BYTES, type KanbanService, type WorkflowMade } from '../kanban/service.js';
import { expand, listWorkflows, paramsLine, readWorkflow, usableMessage } from '../kanban/workflow.js';
```

In `src/cli/operator.ts`, replace:

```ts
import { operatorName, withBoard } from './gate.js';
import { ask } from './kanban.js';
import type { MtIo } from './mt.js';
import { BIDI, decodeUtf8, INVISIBLE } from '../text.js';
import { boardsText, line, listText, showText, who } from './plain.js';
```

with:

```ts
import { loadOperator, operatorName, withBoard } from './gate.js';
import { ask } from './kanban.js';
import type { MtIo } from './mt.js';
import { BIDI, decodeUtf8, INVISIBLE } from '../text.js';
import { boardsText, dryRunText, instanceText, instancesText, line, listText, madeText, previewText, showText, who, workflowsText } from './plain.js';
```

In `src/cli/operator.ts`, replace:

```ts
  keyed?: boolean;
```

with:

```ts
  keyed?: boolean;
  /** What a keyed command returns when run again: its task, or a workflow's instance. */
  makes?: 'task' | 'instance';
```

In `src/cli/operator.ts`, replace:

```ts
  fn: (service: KanbanService, by: string) => Outcome,
```

with:

```ts
  fn: (service: KanbanService, by: string) => Outcome,
  opts: { workflows?: boolean } = {},
```

In `src/cli/operator.ts`, replace:

```ts
    { refuse: no, unsetNote: 'those values are not masked here' },
```

with:

```ts
    { refuse: no, unsetNote: 'those values are not masked here', ...(opts.workflows === true ? { workflows: true } : {}) },
```

In `src/cli/operator.ts`, replace:

```ts
          `${done.keyed === true ? 'with the same --key returns this task' : 'would make it twice'}: ` +
```

with:

```ts
          `${done.keyed === true ? `with the same --key returns this ${done.makes ?? 'task'}` : 'would make it twice'}: ` +
```

In `src/cli/operator.ts`, replace:

```ts
/** `mt kanban task …` and `mt kanban board …`, outside a board run: the operator's. */
export async function operatorCommand(command: string, rest: readonly string[], io: MtIo): Promise<number> {
  if (command === 'board') return board(rest, io);
  if (command === 'task') return task(rest, io);
  throw new UsageError(`unknown command: kanban ${command}`);
}
```

with:

```ts
/** `mt kanban task …`, `board …` and `workflow …`, outside a board run: the operator's. */
export async function operatorCommand(command: string, rest: readonly string[], io: MtIo): Promise<number> {
  if (command === 'board') return board(rest, io);
  if (command === 'task') return task(rest, io);
  if (command === 'workflow') return workflow(rest, io);
  throw new UsageError(`unknown command: kanban ${command}`);
}

// ---------------------------------------------------------------------------
// Workflows (spec §21.6, §21.10)
// ---------------------------------------------------------------------------

/** The verbs of `mt kanban workflow`. */
export const WORKFLOW_COMMANDS: readonly string[] = ['list', 'instances', 'show', 'preview', 'start', 'apply', 'archive'];

/** `--param key=value`, repeated, each split at its first `=` (spec §21.6); the shell has already removed the quotes. */
function paramPairs(values: readonly string[] | undefined): { key: string; value: string }[] {
  return (values ?? []).map((p) => {
    const eq = p.indexOf('=');
    if (eq <= 0) throw new UsageError('--param takes key=value');
    return { key: p.slice(0, eq), value: p.slice(eq + 1) };
  });
}

/** A key, one line, as `task new`'s is. */
function keyFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/[\p{Cc}\u2028\u2029]/u.test(value) || new RegExp(BIDI.source).test(value)) {
    throw new UsageError('a key is one line, with no control characters and no bidi controls');
  }
  const key = value.trim();
  if (key === '') throw new UsageError('--key needs a value');
  return key;
}

/** JSON indented by two spaces, masked, with nothing in it a terminal acts on: `preview --json`'s file and `show --dag`'s. */
function jsonFile(value: unknown): string {
  return JSON.stringify(maskAll(value), null, 2).replace(UNSAFE_IN_JSON, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A start's or an apply's answer in the worker's shape (spec §21.6). */
function madeJson(made: WorkflowMade): Record<string, unknown> {
  return {
    instance_id: made.instance.instanceId,
    existing: made.existing,
    board: made.instance.board,
    tasks: made.tasks.map((t) => ({ task_id: t.taskId, ref: t.ref, step: t.step, item: t.item })),
    // Nothing made, so the gateway was not asked to look.
    ...(made.existing ? { nudged: false } : {}),
  };
}

/**
 * `mt kanban workflow preview <name> [--board] [--param k=v]… [--json]` (spec
 * §21.6): loaded exactly as `openBoard` loads, opening no database; every check
 * a start makes but the board's, the people's and the key's, a person refused as
 * at the terminal. `--json` writes the DAG file alone on stdout; a refusal goes
 * to stderr, so it never leaves half a file.
 */
function preview(rest: readonly string[], io: MtIo): number {
  const { values, positionals } = parse(rest, { ...BOARD_FLAGS, param: { type: 'string', multiple: true } });
  const [name, extra] = positionals;
  if (name === undefined || extra !== undefined) throw new UsageError('kanban workflow preview takes a workflow name');
  const pairs = paramPairs(values.param);
  const boardName = boardFlag(values.board) ?? DEFAULT_BOARD;
  const json = values.json === true;
  const no = (_code: string, message: string): number => {
    io.err(`mt: ${line(message, 4096)}`);
    return 1;
  };
  const loaded = loadOperator(io, 'mt kanban workflow preview', { refuse: no, unsetNote: 'those values are not masked here' });
  if (typeof loaded === 'number') return loaded;
  const { settings, team } = loaded;
  // As openBoard's service judges a task: supervised roles accepted, and no person, as no talk check is here.
  const facts = { roles: team.roles, workspaces: new Set(team.workspaces.keys()), supervisedRoles: true };
  const dir = join(settings.home, 'workflows');
  const read = readWorkflow(dir, name, facts);
  if (!read.ok) {
    return no(read.code, read.code === 'unknown_workflow' ? usableMessage(read.message, listWorkflows(dir, facts).usable, WORKFLOW_MESSAGE_BYTES) : read.message);
  }
  const expanded = expand(read.workflow, { from: 'terminal', pairs }, boardName);
  if (!expanded.ok) return no(expanded.code, expanded.message);
  const shaped = checkDagShape(expanded.dag, 'expansion');
  if (!shaped.ok) return no(shaped.code, shaped.message);
  const refused = checkDagTasks(shaped.dag, { facts, createdBy: operatorName(io), createdVia: { kind: 'operator' } });
  if (refused !== undefined) return no(refused.code, refused.message);
  if (json) io.out(jsonFile(JSON.parse(dagFile(shaped.dag))));
  else for (const l of previewText(name, boardName, previewLines(shaped.dag))) io.out(l);
  return 0;
}

/** `mt kanban workflow start <name> [--board] [--param k=v]… [--key] [--json]` (spec §21.6). */
function start(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, { ...BOARD_FLAGS, param: { type: 'string', multiple: true }, key: { type: 'string' } });
  const [name, extra] = positionals;
  if (name === undefined || extra !== undefined) throw new UsageError('kanban workflow start takes a workflow name');
  const pairs = paramPairs(values.param);
  const boardName = boardFlag(values.board) ?? DEFAULT_BOARD;
  const key = keyFlag(values.key);
  return act(
    io,
    values.json === true,
    'mt kanban workflow start',
    (service, by) => {
      const r = service.startWorkflow({
        workflow: name,
        params: { from: 'terminal', pairs },
        ...(key === undefined ? {} : { idempotencyKey: key }),
        createdBy: by,
        createdVia: { kind: 'operator' },
        board: boardName,
      });
      if (!r.ok) return refused(r);
      return { ok: true, lines: madeText(r), json: madeJson(r), nudge: !r.existing, ...(key === undefined ? {} : { keyed: true }), makes: 'instance' };
    },
    { workflows: true },
  );
}

/** A DAG file read as `--body-file` reads a body (spec §21.6): a regular file, or `-` for stdin, up to 4 MiB, strictly as UTF-8, as JSON. */
async function dagOf(file: string, io: MtIo, json: boolean): Promise<unknown | number> {
  const max = DAG_LIMITS.rawBytes;
  let bytes: Uint8Array | undefined;
  if (file === '-') {
    if (io.stdinIsTTY === true) return early(io, json, 'invalid', 'apply - reads the DAG on stdin; stdin is a terminal: redirect a file or pipe it');
    bytes = await (io.stdin?.(max) ?? Promise.resolve(new Uint8Array()));
    if (bytes === undefined) return early(io, json, 'too_large', `the DAG on stdin is over ${max} bytes`);
  } else {
    try {
      // A regular file only: a FIFO or a device could block, or never end.
      const st = statSync(file);
      if (!st.isFile()) return early(io, json, 'invalid', `${file} is not a regular file: give a file, or - for stdin`);
      if (st.size > max) return early(io, json, 'too_large', `${file} is ${st.size} bytes; a DAG file is read up to ${max}`);
      bytes = readFileSync(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
      return early(io, json, 'invalid', `cannot read the DAG from ${file}: ${code}`);
    }
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) return early(io, json, 'invalid', `the DAG ${file === '-' ? 'on stdin' : `in ${file}`} is not UTF-8`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A byte order mark, kept by the strict decoding, is not JSON either.
    return early(io, json, 'invalid', 'the DAG is not JSON');
  }
}

/** `mt kanban workflow apply <dag.json|-> [--key] [--dry-run] [--json]` (spec §21.6): the DAG's board, else `default`. */
async function applyFile(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, { ...JSON_FLAG, key: { type: 'string' }, 'dry-run': { type: 'boolean' } });
  const [file, extra] = positionals;
  if (file === undefined || extra !== undefined) throw new UsageError('kanban workflow apply takes a DAG file, or - for stdin');
  const json = values.json === true;
  const key = keyFlag(values.key);
  const dryRun = values['dry-run'] === true;
  const dag = await dagOf(file, io, json);
  if (typeof dag === 'number') return dag;
  return act(
    io,
    json,
    'mt kanban workflow apply',
    (service, by) => {
      const r = service.applyDag({
        dag,
        ...(key === undefined ? {} : { idempotencyKey: key }),
        ...(dryRun ? { dryRun: true } : {}),
        createdBy: by,
        createdVia: { kind: 'operator' },
      });
      if (!r.ok) return refused(r);
      if (!('dryRun' in r)) {
        return { ok: true, lines: madeText(r), json: madeJson(r), nudge: !r.existing, ...(key === undefined ? {} : { keyed: true }), makes: 'instance' };
      }
      // Nothing written, so no nudge (spec §21.6).
      return {
        ok: true,
        lines: dryRunText(r),
        json: {
          dry_run: true,
          existing: r.existing,
          ...(r.instanceId === null ? {} : { instance_id: r.instanceId }),
          board: r.board,
          tasks: r.tasks.map((t) => ({ ref: t.ref, step: t.step, item: t.item, gates: t.gates })),
        },
      };
    },
    { workflows: true },
  );
}

/** `mt kanban workflow list` (spec §21.10): the files as they are now. */
function listWorkflowFiles(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, JSON_FLAG);
  if (positionals.length > 0) throw new UsageError('kanban workflow list takes no arguments');
  return act(
    io,
    values.json === true,
    'mt kanban workflow list',
    (service) => {
      const list = service.workflows();
      const params = new Map(list.usable.map((w) => [w.name, paramsLine(w)]));
      return {
        ok: true,
        lines: workflowsText(list, (name) => params.get(name) ?? ''),
        json: {
          workflows: list.usable.map((w) => ({
            name: w.name,
            description: w.description ?? null,
            params: w.params.map((p) => ({ name: p.name, list: p.list, required: p.required, default: p.default ?? null, description: p.description ?? null })),
          })),
          not_usable: list.broken,
        },
      };
    },
    { workflows: true },
  );
}

/** `mt kanban workflow instances [all] [--board]` (spec §21.10): `default`'s unless named. */
function instances(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [word, extra] = positionals;
  const all = word?.toLowerCase();
  if (extra !== undefined || (all !== undefined && all !== 'all')) throw new UsageError('kanban workflow instances takes at most all');
  const boardName = boardFlag(values.board) ?? DEFAULT_BOARD;
  return act(
    io,
    values.json === true,
    'mt kanban workflow instances',
    (service) => {
      const missing = noSuchBoard(service, boardName);
      if (missing !== undefined) return missing;
      const r = service.instances(boardName, all === 'all');
      return {
        ok: true,
        lines: instancesText(r.instances, { board: boardName, all: all === 'all', total: r.total, read: r.read }),
        json: {
          board: boardName,
          total: r.total,
          instances: r.instances.map((s) => ({
            instance_id: s.instance.instanceId,
            name: s.instance.name,
            status: s.status,
            done: s.done,
            total: s.total,
            created_by: s.instance.createdBy,
            created_at: s.instance.createdAt,
          })),
        },
      };
    },
    { workflows: true },
  );
}

/** With `--board`, a refusal unless the board exists and the instance is on it (spec §21.10). */
function instanceOffBoard(service: KanbanService, board: string | undefined, instanceId: string): Outcome | undefined {
  if (board === undefined) return undefined;
  const missing = noSuchBoard(service, board);
  if (missing !== undefined) return missing;
  const r = service.instance(instanceId);
  if (!r.ok) return refused(r);
  if (r.view.instance.board !== board) {
    return refused({ code: 'other_board', message: `instance ${instanceId} is on board ${visible(r.view.instance.board)}, not ${visible(board)}` });
  }
  return undefined;
}

/** `mt kanban workflow show <instance> [--board] [--dag] [--json]` (spec §21.10): everything, uncut; `--dag` the stored DAG. */
function showInstance(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, { ...BOARD_FLAGS, dag: { type: 'boolean' } });
  const [instanceId, extra] = positionals;
  if (instanceId === undefined || extra !== undefined) throw new UsageError('kanban workflow show takes an instance id');
  const board = boardFlag(values.board);
  if (values.dag === true && values.json === true) throw new UsageError('kanban workflow show takes --dag or --json, not both');
  let dagText: string | undefined;
  return act(
    io,
    values.json === true,
    'mt kanban workflow show',
    (service) => {
      const guard = instanceOffBoard(service, board, instanceId);
      if (guard !== undefined) return guard;
      const r = service.instance(instanceId);
      if (!r.ok) return refused(r);
      const v = r.view;
      // What was made, masked: never the hash (spec §21.7).
      if (values.dag === true) dagText = jsonFile(v.instance.dag);
      return {
        ok: true,
        lines: values.dag === true ? [] : instanceText(v),
        json: {
          instance: {
            instance_id: v.instance.instanceId,
            name: v.instance.name,
            board: v.instance.board,
            status: v.status,
            done: v.done,
            total: v.total,
            created_by: v.instance.createdBy,
            created_via: v.instance.createdVia.kind,
            created_at: v.instance.createdAt,
            params: v.instance.dag.params,
            description: v.description ?? null,
          },
          tasks: v.members.map((m) => ({
            task_id: m.taskId,
            ref: m.ref,
            step: m.step,
            item: m.item,
            title: m.task.title,
            assignee: m.task.assignee?.name ?? null,
            phase: m.task.phase,
            status: m.status,
          })),
          related: v.related.map((x) => ({ task_id: x.task.taskId, title: x.task.title, phase: x.task.phase, status: x.status })),
          related_instances: v.relatedInstances.map((o) => ({ instance_id: o.instanceId, name: o.name, tasks: o.tasks })),
        },
      };
    },
    { workflows: true },
  ).then((code) => {
    if (code === 0 && dagText !== undefined) io.out(dagText);
    return code;
  });
}

/** `mt kanban workflow archive <instance> [--board]` (spec §21.10): every member, in one transaction; the gateway's pass cancels the runs it decided. */
function archiveInstance(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [instanceId, extra] = positionals;
  if (instanceId === undefined || extra !== undefined) throw new UsageError('kanban workflow archive takes an instance id');
  const board = boardFlag(values.board);
  return act(
    io,
    values.json === true,
    'mt kanban workflow archive',
    (service, by) => {
      const guard = instanceOffBoard(service, board, instanceId);
      if (guard !== undefined) return guard;
      const r = service.archiveWorkflow(instanceId, by);
      if (!r.ok) return refused(r);
      const n = r.archived.length;
      const name = line(r.instance.name ?? '(no workflow)', 80);
      return {
        ok: true,
        lines: [n === 0 ? `every task of ${instanceId} is archived already; nothing changed` : `archived ${n} task${n === 1 ? '' : 's'} of ${instanceId} (${name}); its related tasks are left as they are`],
        json: { instance_id: instanceId, archived: r.archived.map((t) => t.taskId), runs: r.runs.map((x) => x.runId) },
        nudge: n > 0,
      };
    },
    { workflows: true },
  );
}

/** `mt kanban workflow <verb> …`. */
function workflow(args: readonly string[], io: MtIo): Promise<number> {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'list':
      return listWorkflowFiles(rest, io);
    case 'instances':
      return instances(rest, io);
    case 'show':
      return showInstance(rest, io);
    case 'preview':
      return Promise.resolve(preview(rest, io));
    case 'start':
      return start(rest, io);
    case 'apply':
      return applyFile(rest, io);
    case 'archive':
      return archiveInstance(rest, io);
    default:
      throw new UsageError(`kanban workflow takes ${WORKFLOW_COMMANDS.slice(0, -1).join(', ')} or ${WORKFLOW_COMMANDS.at(-1)}`);
  }
}
```

In `src/cli/plain.ts`, replace:

```ts
import { counted, listed, runState, waitingLine, workdirLine } from '../kanban/chat-render.js';
```

with:

```ts
import { counted, listed, runState, waitingLine, workdirLine, type PreviewLine } from '../kanban/chat-render.js';
```

In `src/cli/plain.ts`, replace:

```ts
  return out;
}
```

with:

```ts
  return out;
}

// ---------------------------------------------------------------------------
// Workflows (spec §21.6, §21.10)
// ---------------------------------------------------------------------------

/** A role or a person, as a DAG names them. */
function named(name: string | null): string {
  if (name === null) return 'nobody';
  return name.includes(':') ? line(name, 80) : `role ${line(name, 80)}`;
}

/**
 * `mt kanban workflow preview` (spec §21.6): what a start would make, as chat's
 * preview says it, a line a task with its ref, its title, its assignee, its
 * parents' refs and how many gates it has, and that nothing was made.
 */
export function previewText(name: string, board: string, lines: readonly PreviewLine[]): string[] {
  const n = lines.length;
  const rows = lines.map((t) => [
    line(t.ref, 64),
    line(t.title, 120),
    named(t.assignee),
    t.parents.length === 0 ? '' : `after ${t.parents.map((p) => line(p, 64)).join(', ')}`,
    t.gates === 0 ? '' : `${t.gates} gate${t.gates === 1 ? '' : 's'}`,
  ]);
  return [
    `${line(name, 80)} would make ${n} task${n === 1 ? '' : 's'}, on board ${line(board, 80)}:`,
    ...table(rows).map((r) => `  ${r}`),
    `nothing was made: mt kanban workflow start ${line(name, 80)}, with these params, makes it`,
  ];
}

/** A start's or an apply's answer (spec §21.6): the instance, then every task, uncut, with its ref, title and assignee. */
export function madeText(
  made: { instance: { instanceId: string; name: string | null; board: string; source: string }; tasks: readonly { taskId: string; ref: string; task: { title: string; assignee: Assignee | null } }[]; existing: boolean },
): string[] {
  const { instance } = made;
  const n = made.tasks.length;
  const what = instance.source === 'start' ? `started ${line(instance.name ?? '', 80)}` : instance.name === null ? 'applied a DAG with no workflow' : `applied ${line(instance.name, 80)}`;
  const head = made.existing
    ? `already made, as ${instance.instanceId}, on board ${line(instance.board, 80)}, ${n} task${n === 1 ? '' : 's'}; nothing new was made`
    : `${what} as ${instance.instanceId}, on board ${line(instance.board, 80)}, ${n} task${n === 1 ? '' : 's'}`;
  const rows = made.tasks.map((t) => [t.taskId, line(t.ref, 64), line(t.task.title, 200), who(t.task.assignee)]);
  return [head, ...table(rows).map((r) => `  ${r}`)];
}

/** `apply --dry-run`'s answer (spec §21.6): what the apply would make, each task followed by its gates' commands, masked; or the instance its key made. */
export function dryRunText(
  dry: { existing: boolean; instanceId: string | null; board: string; tasks: readonly { ref: string; title: string; assignee: string | null; parents: readonly string[]; gates: readonly { command: string; timeout_s: number }[] }[] },
): string[] {
  if (dry.existing) return [`already made, as ${dry.instanceId ?? ''}: the apply would make nothing new`];
  const tasks = dry.tasks.length;
  const links = dry.tasks.reduce((sum, t) => sum + t.parents.length, 0);
  const gates = dry.tasks.reduce((sum, t) => sum + t.gates.length, 0);
  const s = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const out = [`would make ${s(tasks, 'task')}, ${s(links, 'link')}, ${s(gates, 'gate')}, on board ${line(dry.board, 80)}; nothing was made`];
  for (const t of dry.tasks) {
    const after = t.parents.length === 0 ? '' : `, after ${t.parents.map((p) => line(p, 64)).join(', ')}`;
    out.push(`  ${line(t.ref, 64)}  ${line(t.title, 200)}  ${named(t.assignee)}${after}`);
    for (const g of t.gates) out.push(`    gate: ${line(g.command, 4096)} (up to ${g.timeout_s} s)`);
  }
  return out;
}

/** `mt kanban workflow list` (spec §21.10): every usable workflow with its params and description, and each broken one with why. */
export function workflowsText(
  list: { usable: readonly { name: string; description: string | undefined }[]; broken: readonly { name: string; problem: string }[] },
  params: (name: string) => string,
): string[] {
  const rows = [
    ...list.usable.map((w) => ({ name: w.name, text: `${line(w.name, 80)}: params ${line(params(w.name), 400)}${w.description === undefined ? '' : ` · ${line(w.description, 200)}`}` })),
    ...list.broken.map((b) => ({ name: b.name, text: `${line(b.name, 80)}: not usable: ${line(b.problem, 600)}` })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows.length === 0 ? ['no workflows: a workflow is a file, $MT_HOME/workflows/<name>.yaml'] : rows.map((r) => r.text);
}

/** A time as a terminal line says it, to the minute, in UTC. */
function when(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `mt kanban workflow instances [all]` (spec §21.10): a board's instances, newest first, every one rather than 30. */
export function instancesText(
  summaries: readonly { instance: { instanceId: string; name: string | null; createdBy: string; createdAt: number }; status: string; done: number; total: number; blocked: number }[],
  opts: { board: string; all: boolean; total: number; read: number },
): string[] {
  const on = `on board ${line(opts.board, 80)}`;
  const past = opts.total > opts.read ? [`only the ${opts.read} newest are read; an older instance is shown by its id, with mt kanban workflow show`] : [];
  if (summaries.length === 0) {
    return [opts.all ? `no workflow instances ${on}` : `no running or blocked workflow instances ${on}; mt kanban workflow instances all shows done and archived ones too`, ...past];
  }
  const rows = summaries.map((s) => [
    s.instance.instanceId,
    line(s.instance.name ?? '(no workflow)', 80),
    s.status === 'blocked' ? `blocked (${s.blocked})` : s.status,
    `${s.done} of ${s.total} done`,
    line(s.instance.createdBy, 80),
    when(s.instance.createdAt),
  ]);
  return [...table([['instance', 'workflow', 'status', 'members', 'by', 'when'], ...rows]), ...past];
}

/** `mt kanban workflow show` (spec §21.10): the instance, every member by step, and its related tasks apart, uncut. */
export function instanceText(view: {
  instance: { instanceId: string; name: string | null; board: string; createdBy: string; createdVia: { kind: string }; createdAt: number; dag: { params: Readonly<Record<string, string | readonly string[]>> } };
  description: string | undefined;
  members: readonly { step: string; item: string | null; task: { taskId: string; phase: string; blockKind: string | null; blockReason: string | null; assignee: Assignee | null; createdFromTask: string | null }; status: string }[];
  related: readonly { task: { taskId: string; title: string }; status: string }[];
  relatedInstances: readonly { instanceId: string; name: string | null; tasks: number }[];
  status: string;
  done: number;
  total: number;
  blocked: number;
}): string[] {
  const { instance } = view;
  const how =
    instance.createdVia.kind === 'chat'
      ? 'in chat'
      : instance.createdVia.kind === 'operator'
        ? 'at the terminal'
        : `by a run of ${view.members[0]?.task.createdFromTask ?? 'a task'}`;
  const out = [
    `${line(instance.name ?? '(no workflow)', 80)} (${instance.instanceId}): ${view.status === 'blocked' ? `blocked (${view.blocked})` : view.status}, ${view.done} of ${view.total} done, on board ${line(instance.board, 80)}`,
    ...(view.description === undefined ? [] : [line(view.description, 400)]),
    `started by ${line(instance.createdBy, 80)}, ${how}, ${when(instance.createdAt)}`,
  ];
  const params = Object.entries(instance.dag.params);
  if (params.length > 0) out.push(`params: ${params.map(([k, v]) => `${line(k, 40)}: ${line(typeof v === 'string' ? v : v.join(', '), 400)}`).join(' · ')}`);
  let step: string | undefined;
  for (const m of view.members) {
    if (m.step !== step) {
      step = m.step;
      out.push(`${line(m.step, 64)}:`);
    }
    const item = m.item === null ? '' : ` ${line(m.item, 200)}:`;
    const why = m.task.phase === 'blocked' && m.task.blockKind !== null ? ` (${m.task.blockKind}): ${line(m.task.blockReason ?? '', 500)}` : '';
    out.push(`  ${m.task.taskId}${item} ${m.status}${why} · ${who(m.task.assignee)}`);
  }
  if (view.related.length > 0 || view.relatedInstances.length > 0) {
    out.push('related, not members:');
    for (const r of view.related) out.push(`  ${r.task.taskId} ${line(r.task.title, 200)}: ${r.status}`);
    for (const o of view.relatedInstances) out.push(`  ${o.instanceId} ${line(o.name ?? '(no workflow)', 80)}, ${o.tasks} task${o.tasks === 1 ? '' : 's'}`);
  }
  return out;
}
```

In `src/kanban/service.ts`, replace:

```ts
  paramsLine,
  readWorkflow,
```

with:

```ts
  readWorkflow,
  usableMessage,
```

In `src/kanban/service.ts`, replace:

```ts
  /** `message`, then the usable workflows and their params, at most 4 KiB: the names first, then the params, saying how many were left out. */
  #usable(message: string): string {
    const usable = this.#workflowsDir === undefined ? [] : listWorkflows(this.#workflowsDir, this.#workflowFacts()).usable;
    if (usable.length === 0) return `${message}; there are no usable workflows`;
    const max = WORKFLOW_MESSAGE_BYTES;
    // Room kept at each step for what may still be said after it.
    const room = 64;
    const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') + room <= max;
    let text = `${message}; the usable ones are`;
    let names = 0;
    for (const w of usable) {
      const next = `${text}${names === 0 ? ' ' : ', '}${w.name}`;
      if (!fits(next)) break;
      text = next;
      names += 1;
    }
    if (names < usable.length) text += ` and ${usable.length - names} more`;
    let params = 0;
    for (const w of usable.slice(0, names)) {
      const next = `${text}${params === 0 ? '; their params: ' : '; '}${w.name} takes ${paramsLine(w)}`;
      if (!fits(next)) break;
      text = next;
      params += 1;
    }
    if (params < names) text += `; the params of ${names - params} more left out`;
    return text;
```

with:

```ts
  /** `message`, then the usable workflows and their params, at most 4 KiB. */
  #usable(message: string): string {
    const usable = this.#workflowsDir === undefined ? [] : listWorkflows(this.#workflowsDir, this.#workflowFacts()).usable;
    return usableMessage(message, usable, WORKFLOW_MESSAGE_BYTES);
```

In `src/kanban/workflow.ts`, replace:

```ts

/** A workflow's params, as `list` and `mt workflow check` say them: `topic (required), vendors (list, required), reviewer (default reviewer)`. */
```

with:

```ts

/**
 * `unknown_workflow`'s message (spec §21.6): `message`, then the usable
 * workflows and their params, at most `max` bytes, the names first, then the
 * params, saying how many were left out.
 */
export function usableMessage(message: string, usable: readonly Workflow[], max: number): string {
  if (usable.length === 0) return `${message}; there are no usable workflows`;
  // Room kept at each step for what may still be said after it.
  const room = 64;
  const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') + room <= max;
  let text = `${message}; the usable ones are`;
  let names = 0;
  for (const w of usable) {
    const next = `${text}${names === 0 ? ' ' : ', '}${w.name}`;
    if (!fits(next)) break;
    text = next;
    names += 1;
  }
  if (names < usable.length) text += ` and ${usable.length - names} more`;
  let params = 0;
  for (const w of usable.slice(0, names)) {
    const next = `${text}${params === 0 ? '; their params: ' : '; '}${w.name} takes ${paramsLine(w)}`;
    if (!fits(next)) break;
    text = next;
    params += 1;
  }
  if (params < names) text += `; the params of ${names - params} more left out`;
  return text;
}

/** A workflow's params, as `list` and `mt workflow check` say them: `topic (required), vendors (list, required), reviewer (default reviewer)`. */
```

- [ ] **Step 17.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2173 passed (2173)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 17.5: Commit.**

```bash
git add src/cli/gate.ts src/cli/mt.ts src/cli/operator.ts src/cli/plain.ts src/kanban/service.ts src/kanban/workflow.ts tests/mt-kanban-workflow.test.ts
git commit -m "Add mt kanban workflow at the terminal: preview, loading as openBoard does with no database and --json writing the DAG file, start, apply and apply --dry-run from a file or stdin, list, instances, show with --dag, and archive, refused no_board on an unmigrated database"
```

---

### Task 18: `task show` of a member

**Files:**

- Create: `tests/kanban-workflow-task-show.test.ts`
- Modify: `src/cli/operator.ts`, `src/cli/plain.ts`, `src/db/kanban-read.ts`, `src/kanban/chat-render.ts`

Spec §21.10. `TaskView.member`: `taskView` reads `memberOf`, which reads the members table only where it exists, so `mt kanban task show` keeps working on a database not yet migrated. Chat's `renderShow` and the terminal's `showText` give one line, `memberLine`, the instance, its step and item; `--json` gives `task.workflow`, or null.

- [ ] **Step 18.1: Write the tests.**

Create `tests/kanban-workflow-task-show.test.ts`:

```ts
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { createTask } from '../src/db/kanban.js';
import { taskView } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { renderShow } from '../src/kanban/chat-render.js';
import { KanbanService } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { VIA } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * `task show` of a member (spec §21.10): one line, its instance, step and item,
 * in chat and at the terminal, and `workflow` in `--json`; nothing for a task
 * that is no member, and `mt kanban task show` working on a database not yet
 * migrated to the workflows' tables.
 */

let f: MtFixture;
let db: Db;

beforeEach(() => {
  clearSecrets();
  f = mtFixture();
  for (const name of ['worker', 'reviewer']) {
    mkdirSync(join(f.home, 'roles', name), { recursive: true });
    writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  }
  mkdirSync(join(f.home, 'workflows'));
  writeFileSync(join(f.home, 'workflows', 'vendor-eval.yaml'), VENDOR_EVAL);
});
afterEach(() => {
  clearSecrets();
  db.close();
  f.cleanup();
});

async function mt(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['kanban', ...argv], { env: { ...f.env, HOME: f.root }, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('task show of a member', () => {
  it('says its instance, step and item, in chat, at the terminal and in --json', async () => {
    db = openDb(join(f.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    const service = new KanbanService({
      db,
      roles: new Map([['worker', role('worker')], ['reviewer', role('reviewer')]]),
      workspaces: new Set(['default']),
      workflowsDir: join(f.home, 'workflows'),
    });
    const r = service.startWorkflow({
      workflow: 'vendor-eval',
      params: { from: 'json', params: { topic: 'logs', vendors: ['acme'] } },
      createdBy: 'operator:me',
      createdVia: { kind: 'operator' },
    });
    if (!r.ok) throw new Error(r.message);
    const member = r.tasks[1]?.taskId ?? '';
    const id = r.instance.instanceId;
    const view = taskView(db, member);
    if (view === undefined) throw new Error('no view');
    expect(renderShow(view, []).split('\n')).toContain(`workflow: \`${id}\` vendor-eval, step evaluate, item acme`);
    expect((await mt(['task', 'show', member])).out.split('\n')).toContain(`workflow: ${id} vendor-eval, step evaluate, item acme`);
    expect(JSON.parse((await mt(['task', 'show', member, '--json'])).out)).toMatchObject({
      task: { workflow: { instance_id: id, name: 'vendor-eval', step: 'evaluate', item: 'acme' } },
    });
    const plain = createTask(db, { title: 'Not a member', createdBy: 'operator:me', createdVia: VIA }, Date.now());
    if (!plain.ok) throw new Error(plain.message);
    expect((await mt(['task', 'show', plain.task.taskId])).out).not.toContain('workflow:');
    expect(JSON.parse((await mt(['task', 'show', plain.task.taskId, '--json'])).out)).toMatchObject({ task: { workflow: null } });
  });

  it('works on a database not yet migrated to the workflows', async () => {
    const dir = mkdtempSync(join(f.root, 'schema-'));
    for (const name of readdirSync(SCHEMA_DIR)) if (/^00[1-8]_.*\.sql$/.test(name)) copyFileSync(join(SCHEMA_DIR, name), join(dir, name));
    db = openDb(join(f.home, 'team.db'));
    migrate(db, dir);
    rmSync(dir, { recursive: true, force: true });
    const t = createTask(db, { title: 'From before', createdBy: 'operator:me', createdVia: VIA }, Date.now());
    if (!t.ok) throw new Error(t.message);
    const r = await mt(['task', 'show', t.task.taskId]);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[0]).toBe(`From before (${t.task.taskId}): ready`);
  });
});
```

- [ ] **Step 18.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-task-show.test.ts`. Expected: `Tests  1 failed | 1 passed (2)`; the first failure: `AssertionError: expected [ …(4) ] to include 'workflow: `w_qbb07dhs09m3` vendor-eva…'`.

- [ ] **Step 18.3: Implement.**

In `src/cli/operator.ts`, replace:

```ts
          waiting: (r.view.waiting ?? []).map(waitingJson),
```

with:

```ts
          waiting: (r.view.waiting ?? []).map(waitingJson),
          // The workflow's instance it is a member of (spec §21.10), or null.
          workflow:
            r.view.member === undefined
              ? null
              : { instance_id: r.view.member.instanceId, name: r.view.member.name, step: r.view.member.step, item: r.view.member.item },
```

In `src/cli/plain.ts`, replace:

```ts
import { counted, listed, runState, waitingLine, workdirLine, type PreviewLine } from '../kanban/chat-render.js';
```

with:

```ts
import { counted, listed, memberLine, runState, waitingLine, workdirLine, type PreviewLine } from '../kanban/chat-render.js';
```

In `src/cli/plain.ts`, replace:

```ts
  ];
  for (const w of view.waiting ?? []) out.push(waitingLine(w, (t) => line(t, 80)));
```

with:

```ts
  ];
  if (view.member !== undefined) out.push(memberLine(view.member, (t) => line(t, 200)));
  for (const w of view.waiting ?? []) out.push(waitingLine(w, (t) => line(t, 80)));
```

In `src/db/kanban-read.ts`, replace:

```ts
  workdir?: { path: string | null; branch: string | null; first?: true };
```

with:

```ts
  workdir?: { path: string | null; branch: string | null; first?: true };
  /** The workflow's instance the task is a member of (spec §21.10), with its step and item; absent for a task that is none's. */
  member?: { instanceId: string; name: string | null; step: string; item: string | null };
```

In `src/db/kanban-read.ts`, replace:

```ts
  const undecided = runs.find((r) => r.outcome === null);
```

with:

```ts
  const undecided = runs.find((r) => r.outcome === null);
  // Read only when the members table is there: a database not yet migrated has none (spec §21.7).
  const member = memberOf(db, taskId);
```

In `src/db/kanban-read.ts`, replace:

```ts
    ...(task.worktree === null ? {} : { workdir: workdirOf(db, task.worktree) }),
```

with:

```ts
    ...(task.worktree === null ? {} : { workdir: workdirOf(db, task.worktree) }),
    ...(member === undefined ? {} : { member: { instanceId: member.instanceId, name: member.name, step: member.step, item: member.item } }),
```

In `src/kanban/chat-render.ts`, replace:

```ts
  ];
  for (const w of view.waiting ?? []) out.push(waitingLine(w, label, id));
```

with:

```ts
  ];
  if (view.member !== undefined) out.push(memberLine(view.member, label, id));
  for (const w of view.waiting ?? []) out.push(waitingLine(w, label, id));
```

In `src/kanban/chat-render.ts`, replace:

```ts
  return out.join('\n');
```

with:

```ts
  return out.join('\n');
}

/**
 * A member's line in `task show` (spec §21.10): its instance, its step and its
 * item, in chat and at the terminal in the same words.
 */
export function memberLine(
  m: { instanceId: string; name: string | null; step: string; item: string | null },
  escape: (text: string) => string = (t) => t,
  code: (id: string) => string = (t) => t,
): string {
  return `workflow: ${code(m.instanceId)} ${escape(m.name ?? '(no workflow)')}, step ${escape(m.step)}${m.item === null ? '' : `, item ${escape(m.item)}`}`;
```

- [ ] **Step 18.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2175 passed (2175)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 18.5: Commit.**

```bash
git add src/cli/operator.ts src/cli/plain.ts src/db/kanban-read.ts src/kanban/chat-render.ts tests/kanban-workflow-task-show.test.ts
git commit -m "Give task show of a workflow's member one line, its instance, step and item, in chat, at the terminal and in --json, read only where the members table is there"
```

---

### Task 19: End to end

**Files:**

- Create: `tests/kanban-workflow.e2e.ts`
- Modify: `tests/fakes/cli-agent.mjs`

Spec §21.16. The fake CLI agent (`tests/fakes/cli-agent.mjs`) gains `kanban-body`: it runs `mt kanban show`, and when its task's body is a worker command and its JSON, `start-workflow {…}` or `apply-dag {…}`, runs it and writes its answer to `asked.log`; then it reports complete. `tests/kanban-workflow.e2e.ts` runs the router, `KanbanChat`, the dispatcher, the real CLI driver, the shim, the real socket and the notifier together: the example started from a group, its steps run in order, its notices in the instance's thread; a deciding step's start of a second workflow, whose tasks follow the first's thread; a planner's graph of five tasks made by `apply-dag` in one transaction, its root claimed after; and a terminal's preview as a file, edited, checked and applied, which no chat follows.

- [ ] **Step 19.1: Write the fake's mode and the test.**

In `tests/fakes/cli-agent.mjs`, replace:

```js
 *               saying, on a rework, the reviewer's reason it revised for
```

with:

```js
 *               saying, on a rework, the reviewer's reason it revised for
 *   kanban-body run `mt kanban show`; when the task's body is a worker command and
 *               its JSON, `start-workflow {…}` or `apply-dag {…}`, run it, writing
 *               its answer to `asked.log` beside the log; then report complete
```

In `tests/fakes/cli-agent.mjs`, replace:

```js

  case 'kanban-late': {
```

with:

```js

  case 'kanban-body': {
    const shown = mt('show');
    let task = { title: '?', body: '' };
    try {
      task = JSON.parse(shown.answer).task;
    } catch {
      process.stderr.write(`mt kanban show failed: ${shown.error} ${shown.answer}\n`);
    }
    const m = /^(start-workflow|apply-dag) (\{[\s\S]*\})$/.exec(task.body ?? '');
    if (m !== null) {
      const asked = mt(m[1], JSON.parse(m[2]));
      if (LOG !== undefined) appendFileSync(join(dirname(LOG), 'asked.log'), `${asked.answer}\n`);
    }
    const done = mt('complete', { summary: `did: ${task.title}` });
    delta(`complete: ${done.answer}`);
    summary('completed', `reported on ${task.title}`);
    break;
  }

  case 'kanban-late': {
```

Create `tests/kanban-workflow.e2e.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import type { Channel } from '../src/channel/types.js';
import { Router } from '../src/core/router.js';
import { SessionRegistry } from '../src/core/registry.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { getInstance, getTask, membersOf, runsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
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
import type { InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * Workflows end to end (spec §21.16): a workflow started from a fake chat in a
 * group, its steps run by the fake CLI agent through the real socket in their
 * order, its notices in the instance's thread; a deciding step starting a second
 * workflow through `mt kanban start-workflow`; a planner applying a graph with
 * `mt kanban apply-dag`; and a terminal's preview, edit, dry run and apply.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };

const RESEARCH = `description: Shortlist, evaluate each, then recommend one
params:
  topic: { required: true }
  vendors: { list: true, required: true }
steps:
  shortlist: { title: "Shortlist vendors for {{topic}}", assignee: worker }
  evaluate: { title: "Evaluate {{item}} for {{topic}}", assignee: worker, for_each: vendors, parents: [shortlist] }
  recommend: { title: "Recommend a vendor for {{topic}}", assignee: worker, parents: [evaluate] }
`;

interface Stack {
  t: TestDb;
  dir: string;
  home: string;
  lark: FakeChannel;
  router: Router;
  service: KanbanService;
  dispatcher: Dispatcher;
  notifier: Notifier;
  registry: SessionRegistry;
  server: WorkerServer;
  asked(): unknown[];
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

async function build(): Promise<Stack> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-wf-e2e-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'repo');
  mkdirSync(join(home, 'workflows'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(home, 'workflows', 'research.yaml'), RESEARCH);
  const log = join(dir, 'invocations.log');
  const t = testDb();
  const authorizer = new Authorizer(defaultAuthConfig(OWNER.openId));
  const people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }) });
  const roles = new Map(['worker', 'planner', 'decider'].map((n) => [n, role(n)]));
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']), people, supervisedRoles: true, workflowsDir: join(home, 'workflows') });
  const agent = (): Driver => createCliDriver({ command: process.execPath, args: [AGENT], env: { FAKE_CLI_MODE: 'kanban-body', FAKE_CLI_LOG: log } });
  const drivers = new Map<string, Driver>([...roles.keys()].map((n) => [n, agent()]));
  const lark = new FakeChannel({ id: 'lark' });
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
  const chat = new KanbanChat({ service, hasTier: (p, tier) => authorizer.hasTier(p, tier), people, appId: 'cli_app', changed: () => d.pass() });
  const router = new Router({ db: t.db, registry, authorizer, channel: lark, channelId: 'lark', appId: 'cli_app', kanban: chat });
  const notifier = new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2, nameOf: (p) => people.nameOf(p) });
  const askedLog = join(dir, 'asked.log');
  stack = {
    t,
    dir,
    home,
    lark,
    router,
    service,
    dispatcher,
    notifier,
    registry,
    server,
    asked: () => (existsSync(askedLog) ? readFileSync(askedLog, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as unknown) : []),
  };
  return stack;
}

function inGroup(text: string): InboundMessage {
  return {
    messageId: `om_wf_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: '',
    sender: OWNER,
    senderIsBot: false,
    text,
    mentionedBot: true,
    mentionAll: false,
    mentions: [],
    attachments: [],
    createTime: Date.now(),
  };
}

/** Pass after pass until every task on the board is done, or give up. */
async function runAll(s: Stack, tasks: () => string[]): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (tasks().length > 0 && tasks().every((id) => getTask(s.t.db, id)?.phase === 'done')) return;
    s.dispatcher.pass();
    await s.dispatcher.idle();
  }
  throw new Error(`not every task is done: ${tasks().map((id) => `${id} ${getTask(s.t.db, id)?.phase}`).join(', ')}`);
}

const allTasks = (s: Stack): string[] =>
  s.t.db.prepare<[], { task_id: string }>('SELECT task_id FROM kanban_tasks ORDER BY rowid').all().map((r) => r.task_id);

/** When a task's first run started, and when its completion was recorded, by event id. */
function order(s: Stack, taskId: string): { claimed: number; completed: number } {
  const rows = s.t.db.prepare<[string], { id: number; kind: string }>('SELECT id, kind FROM kanban_events WHERE task_id = ? ORDER BY id').all(taskId);
  return { claimed: rows.find((r) => r.kind === 'claimed')?.id ?? -1, completed: rows.find((r) => r.kind === 'completed')?.id ?? -1 };
}

describe('workflows, end to end', () => {
  it('starts the example from a group, runs its steps in order through the real socket, and its notices land in its thread', async () => {
    const s = await build();
    const command = inGroup('/kanban workflow start research topic=logs vendors=acme,globex');
    await s.router.onMessage(command);
    const reply = s.lark.texts[0];
    expect(reply?.target).toMatchObject({ replyTo: command.messageId, replyInThread: true });
    const id = /as `(w_[0-9a-z]+)`/.exec(reply?.text ?? '')?.[1] ?? '';
    const members = membersOf(s.t.db, id);
    expect(members.map((m) => m.ref)).toEqual(['shortlist', 'evaluate:1', 'evaluate:2', 'recommend']);
    for (const m of members) expect(subscriptionsOf(s.t.db, m.taskId).map((x) => x.threadId)).toEqual([`omt_${command.messageId}`]);

    await runAll(s, () => members.map((m) => m.taskId));
    const [shortlist, e1, e2, recommend] = members.map((m) => order(s, m.taskId));
    expect(e1?.claimed).toBeGreaterThan(shortlist?.completed ?? Infinity);
    expect(e2?.claimed).toBeGreaterThan(shortlist?.completed ?? Infinity);
    expect(recommend?.claimed).toBeGreaterThan(Math.max(e1?.completed ?? Infinity, e2?.completed ?? Infinity));

    await s.notifier.deliver();
    const notices = s.lark.texts.slice(1);
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) expect(n.target).toMatchObject({ chatId: 'oc_team', threadId: `omt_${command.messageId}` });
    expect(notices.map((n) => n.text).join('\n')).toContain('Done: **Recommend a vendor for logs**');
  });

  it("lets a deciding step's agent start a second workflow, whose tasks follow the first's thread", async () => {
    const s = await build();
    writeFileSync(
      join(s.home, 'workflows', 'decide.yaml'),
      `steps:\n  decide:\n    title: Decide what to research\n    assignee: decider\n    body: 'start-workflow {"workflow": "research", "params": {"topic": "queues", "vendors": ["initech"]}, "idempotency_key": "d-1"}'\n`,
    );
    const command = inGroup('/kanban workflow start decide');
    await s.router.onMessage(command);
    const first = /as `(w_[0-9a-z]+)`/.exec(s.lark.texts[0]?.text ?? '')?.[1] ?? '';
    const decide = membersOf(s.t.db, first)[0]?.taskId ?? '';
    await runAll(s, () => allTasks(s));
    const [answer] = s.asked() as Array<{ ok: boolean; instance_id: string; tasks: Array<{ task_id: string }> }>;
    expect(answer).toMatchObject({ ok: true, existing: false, board: 'default' });
    expect(getInstance(s.t.db, answer?.instance_id ?? '')?.createdBy).toMatch(/^run:r_/);
    for (const t of answer?.tasks ?? []) {
      expect(getTask(s.t.db, t.task_id)?.createdFromTask).toBe(decide);
      expect(subscriptionsOf(s.t.db, t.task_id).map((x) => [x.threadId, x.rootMessageId])).toEqual([[`omt_${command.messageId}`, command.messageId]]);
    }
    const shown = s.service.instance(first);
    expect(shown.ok && shown.view.relatedInstances).toEqual([{ instanceId: answer?.instance_id, name: 'research', tasks: 3 }]);
  });

  it("lets a planner's agent apply a graph of five tasks, all made before any is claimed, following the planner's chat", async () => {
    const s = await build();
    const graph = {
      format: 1,
      tasks: [
        { ref: 'research', title: 'Research the options', assignee: 'worker' },
        { ref: 'a', title: 'Try A', assignee: 'worker', parents: ['research'] },
        { ref: 'b', title: 'Try B', assignee: 'worker', parents: ['research'] },
        { ref: 'compare', title: 'Compare A and B', assignee: 'worker', parents: ['a', 'b'] },
        { ref: 'write', title: 'Write it up', assignee: 'worker', parents: ['compare'] },
      ],
      idempotency_key: 'plan-1',
    };
    await s.router.onMessage(inGroup(`/kanban task new Plan the work\nassignee: planner\napply-dag ${JSON.stringify(graph)}`));
    const planner = allTasks(s)[0] ?? '';
    await runAll(s, () => allTasks(s));
    const [answer] = s.asked() as Array<{ ok: boolean; instance_id: string; tasks: Array<{ task_id: string; ref: string }> }>;
    expect(answer?.tasks.map((t) => t.ref)).toEqual(['research', 'a', 'b', 'compare', 'write']);
    const made = answer?.tasks.map((t) => getTask(s.t.db, t.task_id)) ?? [];
    // One transaction: every one made at the same moment, before any of them was claimed.
    expect(new Set(made.map((t) => t?.createdAt)).size).toBe(1);
    const rootRun = runsOf(s.t.db, answer?.tasks[0]?.task_id ?? '')[0];
    expect(rootRun?.startedAt).toBeGreaterThanOrEqual(made[0]?.createdAt ?? Infinity);
    for (const t of made) {
      expect(t?.createdFromTask).toBe(planner);
      expect(subscriptionsOf(s.t.db, t?.taskId ?? '').map((x) => x.conversationId)).toEqual(['oc_team']);
    }
  });

  it("previews at the terminal as a file, which is edited, checked with a dry run and applied, followed by no chat", async () => {
    const s = await build();
    writeFileSync(
      join(s.home, 'config.yaml'),
      [`workspace: ${join(s.dir, 'repo')}`, `db: ${join(s.dir, 'terminal.db')}`, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
    );
    mkdirSync(join(s.home, 'roles', 'worker'), { recursive: true });
    writeFileSync(join(s.home, 'roles', 'worker', 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
    const db = openDb(join(s.dir, 'terminal.db'));
    migrate(db, SCHEMA_DIR);
    try {
      const mt = async (argv: string[]) => {
        const out: string[] = [];
        const err: string[] = [];
        const code = await runMt(['kanban', 'workflow', ...argv], { env: { MT_HOME: s.home, PATH: process.env['PATH'], HOME: s.dir }, out: (l) => out.push(l), err: (l) => err.push(l) });
        return { code, out: out.join('\n'), err: err.join('\n') };
      };
      const preview = await mt(['preview', 'research', '--param', 'topic=logs', '--param', 'vendors=acme', '--json']);
      expect(preview.code).toBe(0);
      const dag = JSON.parse(preview.out) as { tasks: Array<{ title: string }> };
      dag.tasks[2]!.title = 'Recommend one vendor for logs, in a page';
      const file = join(s.dir, 'dag.json');
      writeFileSync(file, JSON.stringify(dag, null, 2));
      const dry = await mt(['apply', file, '--dry-run']);
      expect(dry.out.split('\n')[0]).toBe('would make 3 tasks, 2 links, 0 gates, on board default; nothing was made');
      const applied = JSON.parse((await mt(['apply', file, '--key', 'e2e', '--json'])).out) as { instance_id: string; tasks: Array<{ task_id: string }> };
      expect(applied.tasks).toHaveLength(3);
      const sent = s.lark.texts.length;
      for (const t of applied.tasks) expect(subscriptionsOf(db, t.task_id)).toEqual([]);
      expect(getTask(db, applied.tasks[2]?.task_id ?? '')?.title).toBe('Recommend one vendor for logs, in a page');
      expect(s.lark.texts).toHaveLength(sent);
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 19.2: Run it.** Run `npx vitest run --project e2e tests/kanban-workflow.e2e.ts`. Expected: `Tests  4 passed (4)`.

- [ ] **Step 19.3: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2175 passed (2175)`. Run `npx vitest run --project e2e`. Expected: `Tests  168 passed (168)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 19.4: Commit.**

```bash
git add tests/fakes/cli-agent.mjs tests/kanban-workflow.e2e.ts
git commit -m "Test workflows end to end: a start from a group run in order through the real socket with its notices in its thread, a deciding step's start-workflow, a planner's apply-dag, and a terminal's preview, edit, dry run and apply"
```

---

### Task 20: The README, the guide and the config example

**Files:**

- Modify: `README.md`, `config.example.yaml`, `docs/kanban-guide.md`

Spec §21.15, plan T's row in §12. The README's `mt` list and chat table gain the workflow commands, and the board's section a short account of workflows; its roles section says where the files live. The guide gains section 12, on workflows: the file, starting, managing, a deciding step and workspaces, and the terminal and agents; the recipes and rules of thumb become sections 13 and 14; recipe 3's planner makes its graph with `apply-dag`, with a dry run first, and recipe 4 applies a previewed DAG from a workflow file. `config.example.yaml` says workflows are files of their own. No test.

- [ ] **Step 20.1: Edit the documents.**

In `README.md`, replace:

````markdown
```

```yaml
````

with:

````markdown
```

Workflows live beside the roles, one file each, `$MT_HOME/workflows/<name>.yaml`, named as roles
are; the files are read at each preview and start, so an edit needs no restart. `mt workflow
check` checks them, and the board guide's section 12 says what they hold.

```yaml
````

In `README.md`, replace:

```markdown
mt role check [<name>]
```

with:

```markdown
mt role check [<name>]
mt workflow check [<name>]
```

In `README.md`, replace:

```markdown

# the worker's commands, which work only in a board run's shell, where the gateway sets MT_KANBAN_RUN, MT_KANBAN_TOKEN and MT_KANBAN_SOCKET:
mt kanban <show|complete|review|changes|block|comment|create|link> < input.json
```

with:

```markdown
mt kanban workflow list
mt kanban workflow instances [all] [--board <name>]
mt kanban workflow show <instance> [--board <name>] [--dag]
mt kanban workflow preview <name> [--board <name>] [--param <key>=<value>]... [--json]
mt kanban workflow start <name> [--board <name>] [--param <key>=<value>]... [--key <key>]
mt kanban workflow apply <dag.json|-> [--key <key>] [--dry-run]
mt kanban workflow archive <instance> [--board <name>]

# the worker's commands, which work only in a board run's shell, where the gateway sets MT_KANBAN_RUN, MT_KANBAN_TOKEN and MT_KANBAN_SOCKET:
mt kanban <show|complete|review|changes|block|comment|create|link|start-workflow|apply-dag> < input.json
```

In `README.md`, replace:

```markdown
[docs/kanban-guide.md](docs/kanban-guide.md). Its section 12 has recipes for whole graphs of
tasks: parallel branches, build, review and release, a planner role that writes the graph, a
script that builds one from a terminal, rerouting around a failed task, and two boards.
```

with:

````markdown
[docs/kanban-guide.md](docs/kanban-guide.md). Its section 12 is on workflows, and section 13 has
recipes for whole graphs of tasks: parallel branches, build, review and release, a planner role
that writes the graph, a DAG applied from a terminal, rerouting around a failed task, and two
boards.

**Workflows.** A graph of tasks the team runs again and again is written once, as a file,
`$MT_HOME/workflows/<name>.yaml`: a list of steps, each a task to make, with `parents` between
them, `for_each` to make one task an item of a list, and params filled into their text.

```yaml
description: Shortlist vendors, evaluate each in parallel, then recommend one
params:
  topic:    { required: true }
  vendors:  { list: true, required: true }
steps:
  shortlist: { title: "Shortlist vendors for {{topic}}", assignee: worker }
  evaluate:  { title: "Evaluate {{item}} for {{topic}}", assignee: worker, for_each: vendors, parents: [shortlist] }
  recommend: { title: "Recommend a vendor for {{topic}}", assignee: worker, parents: [evaluate] }
```

`/kanban workflow start vendor-eval topic="log storage" vendors=acme,globex` makes all four
tasks and their links at once, as one instance, `w_…`, or none of them; `/kanban workflow
preview` shows what a start would make. A workflow has no conditions: one that must branch has a
deciding step, whose agent reads its parents' handoffs and creates the branch it chose. Params
never reach a gate. `mt workflow check` checks the files, and the gateway says at startup which
are usable; a broken one does not stop it. At the terminal, `mt kanban workflow preview … --json`
writes the DAG a start would make as a file, which `mt kanban workflow apply` makes, with
`--dry-run` to check it first; an agent starts a workflow with `mt kanban start-workflow`, or
makes a graph of its own at once with `mt kanban apply-dag`, which takes no gates.
````

In `README.md`, replace:

```markdown
| `/kanban board archive <name>` | operate: refused while any of its tasks is open, in review or blocked; never `default` |
```

with:

```markdown
| `/kanban board archive <name>` | operate: refused while any of its tasks is open, in review or blocked; never `default` |
| `/kanban workflow list` | talk: the workflow files, each with its params, and each broken one with why |
| `/kanban workflow instances [all]` | talk: this chat's board's instances, running and blocked ones unless `all` |
| `/kanban workflow show <instance>` | talk: one instance, its steps' tasks in order, and its related tasks apart |
| `/kanban workflow preview <name> key=value ...` | talk: what a start would make, one line a task; makes nothing |
| `/kanban workflow start <name> key=value ...` | operate: makes every task of the workflow at once, on this chat's board; this chat hears each |
| `/kanban workflow archive <instance>` | operate: archives every task of the instance |
```

In `config.example.yaml`, replace:

```yaml
# design spells them, and are set in this file only.
```

with:

```yaml
# design spells them, and are set in this file only. Its workflows are not
# set here: each is a file of its own, $MT_HOME/workflows/<name>.yaml, read at
# each preview and start, and checked by mt workflow check.
```

In `docs/kanban-guide.md`, replace:

```markdown
for one agent and builds up to chains, fan-out and review. Section 12 has recipes for whole
graphs of tasks.
```

with:

```markdown
for one agent and builds up to chains, fan-out and review. Section 12 is on workflows, graphs
written once and started many times, and section 13 has recipes for whole graphs of tasks.
```

In `docs/kanban-guide.md`, replace:

```markdown
## 12. Recipes: graphs of tasks
```

with:

````markdown
## 12. Workflows

A team runs the same shape of work again and again: shortlist, evaluate each candidate,
recommend one; draft, review, publish. A **workflow** is that graph written once, in a file on
the gateway's host, and started as often as needed. **Starting** it makes one **instance**,
`w_…`: every task and every link of the graph, at once, in one go, or none of them.

### The file

One YAML file a workflow, at `~/.manus-team/workflows/<name>.yaml`, named as a role is:
lowercase letters, digits and `-`. This is `vendor-eval.yaml`:

```yaml
description: Shortlist vendors, evaluate each in parallel, then recommend one
params:
  topic:    { required: true, description: what is being bought }
  vendors:  { list: true, required: true }
  reviewer: { default: reviewer }
steps:
  shortlist:
    title: Shortlist vendors for {{topic}}
    assignee: worker
    outcome: a shortlist with one line per vendor
  evaluate:
    for_each: vendors
    parents: [shortlist]
    title: Evaluate {{item}} for {{topic}}
    assignee: worker
    gates:
      - command: test -s evaluation.md
        timeout_s: 30
  recommend:
    parents: [evaluate]
    title: Recommend a vendor for {{topic}}
    assignee: worker
    reviewer: { role: "{{reviewer}}" }
    verify: every score comes from a parent's summary
```

- **A step is a task to make.** It takes the fields `create` does: `title`, `body`,
  `assignee`, `reviewer`, `workspace`, `priority`, the contract (`outcome`, `verify`,
  `constraints`, `boundaries`, `stop_when`), `failure_limit`, `retry_on_crash` and
  `max_runtime_s`, and `gates`, as `/kanban gate add` takes them. An unknown key is an error
  that names its place, such as `steps.evaluate.timeout`.
- **`parents`** names the steps a step waits for, each written above it. A step whose parent is
  a `for_each` step waits for all of its tasks.
- **`for_each: <list param>`** makes one task an item, with `{{item}}` set to the item. Two
  `for_each` steps over one list are linked all to all: each review waits for every evaluation.
- **Params** are text, or lists with `list: true`; each is `required: true` or has a `default`.
  `{{name}}` fills them into the text fields, a list as its items joined by `, `. In
  `assignee`, `reviewer` and `workspace` the whole value may be one reference, `"{{reviewer}}"`,
  and it is checked as a name. **Quote a value that starts with `{{`**: YAML reads an unquoted
  `{{reviewer}}` as a mapping.
- **Params never reach a gate.** A gate is a shell command the gateway runs; a `{{` in one is an
  error. A gate that needs a value names it as an environment variable, `$NAME`, from the role's
  environment.
- **At most 100 tasks** an instance, and a file of at most 64 KiB.

`mt workflow check` reads the files, and says of each whether it is usable, and why not:

```
$ mt workflow check
vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)
```

The gateway checks them at startup too, and notes the broken ones; a broken workflow does not
stop it. The files are read at each preview and start, so an edit needs no restart.

### Starting it

```
/kanban workflow start vendor-eval topic="log storage" vendors=acme,globex
```

> Started vendor-eval as `w_…`, 4 tasks:
> - `k_…` Shortlist vendors for log storage, for role worker
> - `k_…` Evaluate acme for log storage, for role worker
> - `k_…` Evaluate globex for log storage, for role worker
> - `k_…` Recommend a vendor for log storage, for role worker
> This thread hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

- **Params** are `key=value`, split at the first `=`. Quote a value with spaces, `"…"`; a list
  is comma-separated, or its key repeated, and a quoted value is one item, so
  `vendors="Acme, Inc"` is one vendor. A person is an @-mention, `owner=@Alice Smith`, for a param
  that lands in `assignee` or `reviewer`.
- **An operator's command**, as `/kanban task new` is: a start starts agents. The tasks go on this
  chat's board, and this chat follows every one; in a group the reply opens a thread of its own,
  the instance's, where its cards and notices go.
- **One failure refuses the whole start**, naming the task, and nothing is made:

  > Not done: evaluate:2, step evaluate, item "globex": role "evaluator" is not configured
- **A start is keyed by its message**: a redelivery makes nothing twice.

`/kanban workflow preview vendor-eval topic="log storage" vendors=acme,globex` says what a start
would make, with each task's parents and gates, and makes nothing. Anyone allowed may preview.

### Seeing and managing

```
/kanban workflow list                 # the workflow files: name, description, params
/kanban workflow instances [all]      # this chat's board's instances: running and blocked unless all
/kanban workflow show w_…             # one instance: its steps' tasks, and its related tasks apart
/kanban workflow archive w_…          # archive every task of it
```

An instance's status is derived from its tasks: **blocked** when any is, with how many,
**done** when every one is done or archived, **archived** when every one is, **running**
otherwise. Nothing is automatic on a failure: a blocked task is unblocked, reassigned or routed
around with the task commands, as in recipe 5. Its tasks are ordinary tasks, and every change to
one is made with them. `/kanban task show` of one says which instance and step it is from.

### A step that decides

A workflow has no conditions: every step becomes tasks at the start. One that must branch has a
**deciding step**, whose agent reads its parents' handoffs, decides, and then makes the tasks of
the branch it chose, with `mt kanban create`, by starting another workflow with `mt kanban
start-workflow`, or with a graph of its own, `mt kanban apply-dag`. A gate on that step, such as
`test -s decision.md`, holds it until the decision is written down:

```yaml
  decide:
    parents: [evaluate]
    title: Decide whether to pilot a vendor or look again, for {{topic}}
    assignee: worker
    body: >
      Read the evaluations. Write decision.md saying which and why. To pilot, start the
      workflow pilot with mt kanban start-workflow; to look again, start vendor-eval
      with a new list of vendors.
    gates:
      - command: test -s decision.md
```

The tasks it makes are created from the deciding task, follow its chat and thread, and show as
a related instance in `/kanban workflow show` of the first.

### Workspaces

A workflow's tasks resolve their workspaces at their claims, as any task's do: a step's own
`workspace`, its role's, its parents', the board's. **A fan-out in one shared workspace runs one
task at a time**: the evaluations above queue behind each other in the shortlist's workspace.
They run side by side only in an isolated workspace (section 6), or with roles that work in
workspaces of their own. A step whose parents certainly work in different workspaces, and which
names none, is refused by the check: set its `workspace`.

### From a terminal, and from an agent

At the terminal, `mt kanban workflow start vendor-eval --param topic="log storage" --param
vendors=acme,globex --key ls-1` starts it, with `--board` and `--json` as the other commands
take them, and `mt kanban workflow preview … --json > dag.json` writes the **DAG** a start would
make: a JSON file of every task, its parents by ref, and its gates. Edit it if need be, check it
with `mt kanban workflow apply dag.json --dry-run`, which lists every task and gate command and
makes nothing, and make it with `mt kanban workflow apply dag.json --key ls-1` (recipe 4). `mt
kanban workflow show w_… --dag` prints the DAG an instance was made from, which `apply` takes
again.

An agent starts a workflow from its run with `mt kanban start-workflow < start.json`, as
`{"workflow": "vendor-eval", "params": {"topic": "log storage", "vendors": ["acme", "globex"]}}`,
and makes a graph of its own at once with `mt kanban apply-dag < dag.json` (recipe 3), which
takes no gates: gates are the operator's.

## 13. Recipes: graphs of tasks
````

In `docs/kanban-guide.md`, replace:

```markdown
Instead of writing each task yourself, give a goal to a role whose agent writes the graph. The
`planner` role's `role.md` says what to make. An excerpt, from
```

with:

```markdown
Instead of writing each task yourself, give a goal to a role whose agent writes the graph, and
makes all of it at once. The `planner` role's `role.md` says what to make. An excerpt, from
```

In `docs/kanban-guide.md`, replace:

```markdown
Create the tasks with `mt kanban create`, in dependency order: a task's "parents" name the tasks
it needs, so create those first. Give every task an "idempotency_key" made from its step, such as
"step-2-serializer", so that running the same command again does not make it twice.

When every task is created, report complete, with a summary that lists each task's id and title
in order.
```

with:

```markdown
Write the plan as one DAG and make it with `mt kanban apply-dag`: each task has a "ref", and
its "parents" name the refs of the tasks it needs, each written earlier in the list. Check it
first with "dry_run": true, then send it again without it. Give it an "idempotency_key", such as
"plan-1", so that sending it again does not make it twice.

When the graph is made, report complete, with a summary that lists each task's id and title in
order.
```

In `docs/kanban-guide.md`, replace:

````markdown
`mt kanban create` a task, each answered with the new id:

```json
{"title": "Write the CSV column mapping for every report type", "body": "List each report type and its columns in docs/csv-columns.md.", "assignee": "worker", "workspace": "api", "contract": {"outcome": "docs/csv-columns.md covers every report type", "verification": "each report type in src/reports/ appears in it"}, "idempotency_key": "step-1-columns"}
```

```json
{"ok":true,"task_id":"k_…","existing":false}
```

```json
{"title": "Add the CSV serializer", "body": "Implement src/csv.ts from the mapping in docs/csv-columns.md.", "assignee": "worker", "reviewer": "reviewer", "workspace": "api", "parents": ["k_…"], "idempotency_key": "step-2-serializer"}
```

and so on: the routes, with the serializer as parent and `reviewer` as reviewer, then the docs,
with the routes as parent. Sending a create again with the same key answers with the same id and
`"existing":true`, and makes nothing. A key is the planning task's own: another planning task can
use the same keys. The planner then reports complete, and the chat hears:

> Done: **Plan the reports CSV export** `k_…`
> > Created 4 tasks for worker, in order: k\_… column mapping; k\_… serializer (reviewer: reviewer); k\_… routes (reviewer: reviewer); k\_… docs.

The chat hears nothing as each task is created; the planner's summary is the list.

**Where the tasks go:**

- **On the planner's board.** A task an agent creates is on the board of the task it ran, whatever
  it asks for: a planning task created from a chat on board `web-app` fills `web-app`.
- **This chat follows them.** Each created task inherits the planning task's subscriptions, so the
  chat that created the plan hears when each one is done, needs review, blocks, gives up or is
  stranded, and so on down the line.
- **They are not the plan's children.** The planning task does not wait for them, and is done as
  soon as it reports. A created task with no `parents` can start at once, even while the planner
  is still at work: here, the column mapping starts while the planner creates the rest.
````

with:

````markdown
`mt kanban apply-dag` with the whole graph:

```json
{"format": 1, "idempotency_key": "plan-1", "tasks": [
  {"ref": "columns", "title": "Write the CSV column mapping for every report type", "body": "List each report type and its columns in docs/csv-columns.md.", "assignee": "worker", "workspace": "api", "contract": {"outcome": "docs/csv-columns.md covers every report type", "verification": "each report type in src/reports/ appears in it"}},
  {"ref": "serializer", "title": "Add the CSV serializer", "body": "Implement src/csv.ts from the mapping in docs/csv-columns.md.", "assignee": "worker", "reviewer": "reviewer", "workspace": "api", "parents": ["columns"]},
  {"ref": "routes", "title": "Add the CSV routes", "assignee": "worker", "reviewer": "reviewer", "workspace": "api", "parents": ["serializer"]},
  {"ref": "docs", "title": "Document CSV export", "assignee": "worker", "workspace": "api", "parents": ["routes"]}
]}
```

answered with every task, by its ref:

```json
{"ok":true,"instance_id":"w_…","existing":false,"board":"default","tasks":[{"task_id":"k_…","ref":"columns","step":"columns","item":null},…]}
```

The graph is made in one transaction, all of it or none, so no task starts before its parents
are linked, and a planner that stops half way leaves no half of a graph. With `"dry_run": true`
the same DAG is checked as an apply checks it and nothing is made: the answer has `"dry_run":
true` and no `instance_id`. Sending it again with the same key answers with the same instance
and `"existing":true`, and makes nothing; a key is the planning task's own. A refusal names the
task it is about:

```json
{"ok":false,"code":"unknown_role","message":"serializer: role \"reviwer\" is not configured"}
```

A planner's DAG takes no gates, and no `priority`, `failure_limit`, `retry_on_crash` or
`max_runtime_s` but at their defaults, as its `mt kanban create` takes none: they are the
operator's. Add gates afterwards with `/kanban gate add`. The planner then reports complete, and
the chat hears:

> Done: **Plan the reports CSV export** `k_…`
> > Made 4 tasks for worker, as w\_…, in order: k\_… column mapping; k\_… serializer (reviewer: reviewer); k\_… routes (reviewer: reviewer); k\_… docs.

**Where the tasks go:**

- **On the planner's board.** A task an agent makes is on the board of the task it ran, and a
  DAG naming another board is refused.
- **This chat follows them.** Each task inherits the planning task's subscriptions, so the chat
  that created the plan hears when each one is done, needs review, blocks, gives up or is
  stranded, and so on down the line.
- **They are not the plan's children.** The planning task does not wait for them, and is done as
  soon as it reports. `/kanban workflow show w_…` lists them, as "(no workflow)".
````

In `docs/kanban-guide.md`, replace:

```markdown
**Checking the graph.** `/kanban task list`:

> `k_…` **running**: Write the CSV column mapping for every report type · role worker
```

with:

```markdown
**Checking the graph.** `/kanban workflow show w_…`, or `/kanban task list`:

> `k_…` **ready**: Write the CSV column mapping for every report type · role worker
```

In `docs/kanban-guide.md`, replace:

```markdown
`/kanban task show k_…` on any of them gives its parents and children, so you can walk the graph:

> **Add the CSV serializer** `k_…`: todo
> assignee: role worker · reviewer: role reviewer · workspace: api
> parents: `k_…` (running)
> children: `k_…` (todo)
> > Implement src/csv.ts from the mapping in docs/csv-columns.md.

The parents and children lines give each task's status, as `/kanban task list` does. Check that
every task but the first has a parent, that no task you expected in parallel has a sibling as
parent, and that the reviewers are where checking is needed.
```

with:

```markdown
`/kanban task show k_…` on any of them gives its parents and children, and the instance it is
from, so you can walk the graph:

> **Add the CSV serializer** `k_…`: todo
> assignee: role worker · reviewer: role reviewer · workspace: api
> workflow: `w_…` (no workflow), step serializer
> parents: `k_…` (ready)
> children: `k_…` (todo)
> > Implement src/csv.ts from the mapping in docs/csv-columns.md.

Check that every task but the first has a parent, that no task you expected in parallel has a
sibling as parent, and that the reviewers are where checking is needed.
```

In `docs/kanban-guide.md`, replace:

````markdown
- **The planner must create tasks in order.** `mt kanban link` only works on a task that has not
  started, and only on a task the planner's own task created. A created task with no parents is
  claimed at once, so linking it afterwards is refused:

  ```json
  {"ok":false,"code":"run_open","message":"task k_… has an open run, r_…; a parent added now could not hold it back"}
  ```

  Naming the parents in each `create` is what holds a task back.
- **Too many tasks at the root.** Every task created with no parents starts as soon as there is
  room. Keep the plan to one or two roots.

### Recipe 4: a DAG scripted from the terminal

The graph of recipe 1, made with `mt kanban task new` on the gateway's host. `--json` prints one
line of JSON:

```
$ mt kanban task new "Write the caching options brief" --board web-app --assignee worker --json
{"ok":true,"task_id":"k_…","board":"web-app","existing":false,"nudged":true}
```

and a refusal, with exit status 1:

```
{"ok":false,"code":"unknown_board","message":"there is no board nope; no task is added to it"}
```

`nudged` says whether the running gateway was told to look for work at once; when it is false,
`mt` also says why on stderr, and the task waits for the gateway's next sweep, or its next start.

`--key <key>` makes a `task new` safe to run again. The first run with a key makes the task; a
later one with the same key makes nothing and returns the task it made, with `"existing":true` in
the JSON, and `"nudged":false`, since nothing changed for the gateway to act on; in plain text:

```
$ mt kanban task new "Write the caching options brief" --board web-app --key caching-dag:web-app:brief
task k_… already exists with key caching-dag:web-app:brief: Write the caching options brief, on board web-app; nothing new was created
```

The key names the task, whatever the rest of the command says: a second run with another title
still returns the first task, with "(archived)" after its title if it has been archived since. A
key holding a control character or a bidi control is refused, as a title is. A key is the terminal's own, so it never returns a task made from
chat or by an agent. A key already used on one board is refused on another, `other_board`, so
the script puts the board in its keys.

The script reads each id with `node -e`, and passes it on as `--parent`. After a failure halfway,
run it again: it makes only what is missing.

```sh
#!/bin/sh
# A brief, three prototypes in parallel, and a recommendation that waits for all three.
# Safe to run again: each task has a key, and a second run gets the same task back.
set -eu
BOARD=${BOARD:-web-app}

# The task_id in mt's --json line; on a refusal, its message on stderr, and exit 1.
task_id() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      if (s.trim() === "") process.exit(1); // mt printed its usage on stderr
      const r = JSON.parse(s);
      if (!r.ok) { console.error(`refused: ${r.message}`); process.exit(1); }
      console.log(r.task_id);
    });'
}

# new <name> <title> [flags...]: the id of the task this script calls <name>, made on the first run only.
new() {
  name=$1 title=$2
  shift 2
  mt kanban task new "$title" --board "$BOARD" --key "caching-dag:$BOARD:$name" --json "$@" | task_id
}

brief=$(new brief "Write the caching options brief" --assignee worker \
  --outcome "a brief naming three caching options for the reports API, each with what to measure" \
  --constraints "put the brief itself in your summary, not only in a file" \
  --body "Read docs/reports-api.md and propose three ways to cache report results.")

proto() {
  new "proto-$1" "Prototype caching option $1" --assignee worker --workspace "research-$1" \
    --parent "$brief" \
    --outcome "a measured p95 latency for option $1, with and without the cache" \
    --constraints "put the numbers, and how you got them, in your summary"
}
a=$(proto a)
b=$(proto b)
c=$(proto c)

report=$(new report "Write the caching recommendation" --assignee worker \
  --parent "$a" --parent "$b" --parent "$c" \
  --outcome "docs/caching.md, one table of the three options and a recommendation" \
  --verify "every number in the table comes from a parent's summary")

echo "brief:      $brief"
echo "prototypes: $a $b $c"
echo "report:     $report"
```

Make the board first, once (`mt kanban board create web-app`), then run it:

```
$ sh caching-dag.sh
brief:      k_…
prototypes: k_… k_… k_…
report:     k_…
$ mt kanban task list --board web-app
task  status  assignee     title
k_…   ready   role worker  Write the caching options brief
k_…   todo    role worker  Prototype caching option a
k_…   todo    role worker  Prototype caching option b
k_…   todo    role worker  Prototype caching option c
k_…   todo    role worker  Write the caching recommendation
```

A second `sh caching-dag.sh` prints the same ids and creates nothing. `BOARD=billing sh
caching-dag.sh` makes the same graph on `billing`, under keys of its own.

Notes:

- **Every command names its board.** `task new` and `task list` are on `default` without
  `--board`. Give `--board` to `show`, `link` and the rest too: a task on another board is then
  refused rather than changed.
- **`sed` works too.** The JSON is one line, written by `JSON.stringify`, and ids are lowercase
  letters and digits, so `sed -n 's/.*"task_id":"\(k_[0-9a-z]*\)".*/\1/p'` finds the id. It
  prints nothing for a refusal, where `node -e` also prints the reason.
- **A key is kept for good.** Archiving the task does not free its key: a run after that returns
  the archived task. To make the graph again, change the keys, say with a version in them.
- **No chat follows these tasks**, so nobody is told when they are done or block. Watch with
  `mt kanban task list --board web-app`, or create the first task from chat.
- **Gates** are `mt kanban gate add k_… -- npm test`, with `--` before the command, and take no
  `--board`.
````

with:

````markdown
- **A parent comes before its child.** A task's `parents` name refs written earlier in the list;
  a ref named later, or not in the DAG, is refused, naming it. A task already on the board is no
  parent here: link it afterwards with `mt kanban link`.
- **Too many tasks at the root.** Every task with no parents starts as soon as there is room.
  Keep the plan to one or two roots.
- **A plan the team makes again and again** is better as a workflow file (section 12): the
  planner then starts it with `mt kanban start-workflow`, and the file's gates come with it.

### Recipe 4: a DAG from the terminal

The graph of recipe 1, a brief, three prototypes in parallel and a recommendation that waits for
all three, kept as a workflow file on the gateway's host and made from a shell there. The file,
`~/.manus-team/workflows/caching.yaml`:

```yaml
description: A brief, three prototypes in parallel, and a recommendation
params:
  options: { list: true, default: [a, b, c] }
steps:
  brief:
    title: Write the caching options brief
    assignee: worker
    outcome: a brief naming three caching options for the reports API, each with what to measure
    constraints: put the brief itself in your summary, not only in a file
    body: Read docs/reports-api.md and propose three ways to cache report results.
  proto:
    for_each: options
    parents: [brief]
    title: Prototype caching option {{item}}
    assignee: worker
    workspace: research
    outcome: a measured p95 latency for option {{item}}, with and without the cache
  report:
    parents: [proto]
    title: Write the caching recommendation
    assignee: worker
    outcome: docs/caching.md, one table of the three options and a recommendation
    verify: every number in the table comes from a parent's summary
```

`research` is an isolated workspace (section 6), so the three prototypes each get a directory
of their own and run side by side; in a shared one they would queue. A name field takes a name,
or one whole reference such as `"{{item}}"`, never one put together from parts, so
`"research-{{item}}"` is refused by the check.

```
$ mt workflow check caching
caching: ok, 3 steps; params: options (list, default a, b, c)
```

**Preview it as a file.** `preview --json` writes the DAG a start would make, every key of every
task written out, and nothing else on stdout; a refusal goes to stderr, so it never leaves half a
file:

```
$ mt kanban workflow preview caching --board web-app --json > caching.json
```

The file is the plan: diff it, keep it beside the script, or edit it. Here the report gets a
reviewer, by hand:

```json
    {
      "ref": "report",
      "step": "report",
      "item": null,
      "title": "Write the caching recommendation",
      "body": null,
      "assignee": "worker",
      "reviewer": "reviewer",
```

**Check it, then make it.** `--dry-run` makes every check an apply makes, against the board as it
is now, and lists every task and every gate command, and makes nothing:

```
$ mt kanban workflow apply caching.json --dry-run
would make 5 tasks, 6 links, 0 gates, on board web-app; nothing was made
  brief  Write the caching options brief  role worker
  proto:1  Prototype caching option a  role worker, after brief
  proto:2  Prototype caching option b  role worker, after brief
  proto:3  Prototype caching option c  role worker, after brief
  report  Write the caching recommendation  role worker, after proto:1, proto:2, proto:3
$ mt kanban workflow apply caching.json --key caching:web-app --json
{"ok":true,"instance_id":"w_…","existing":false,"board":"web-app","tasks":[{"task_id":"k_…","ref":"brief","step":"brief","item":null},…],"nudged":true}
```

`--key` makes the apply safe to run again: a second run with the same key and the same DAG makes
nothing and answers with the instance, `"existing":true`; the same key with a DAG changed since
is refused, as is a key a `start` used. Without a key every apply is a new instance. A key is kept
for good, an archived instance's included: to make the graph again, change the key.

`mt kanban workflow start caching --board web-app --key caching:web-app` is the preview and the
apply in one step, with the file as it is, when there is nothing to edit.

Notes:

- **The apply checks again.** A role removed, a board archived or a workspace dropped between the
  preview and the apply is refused at the apply, naming the task. A workflow file edited since
  changes nothing: the apply makes the DAG.
- **Gates come with the file and the DAG at the terminal**, as the operator's: a gate command
  holding the mask `••••`, as one printed masked by `show --dag` would, is refused, and must be
  written out again.
- **No chat follows these tasks**, so nobody is told when they are done or block. Watch with
  `mt kanban workflow show w_…`, or start the workflow from chat if a group should hear.
- **A DAG written by hand** needs only `"format": 1` and its tasks, each with a `ref` and a
  `title`; every other key takes its default. It shows as "(no workflow)".
- **Scripting `mt kanban task new`** still works for a graph that is no workflow: each `--key`
  returns its task on a second run, and `--parent` links it.
````

In `docs/kanban-guide.md`, replace:

```markdown
- **Use idempotency keys when scripting.** An agent's `mt kanban create` takes an
  `idempotency_key`; give one to every task it makes. The terminal's `mt kanban task new` takes
  none, so a script keeps its own record of what it made (recipe 4).
```

with:

```markdown
- **Use idempotency keys when scripting.** An agent's `mt kanban create` and `mt kanban apply-dag`
  take an `idempotency_key`, and the terminal's `task new`, `workflow start` and `workflow apply`
  take `--key` (recipe 4).
```

In `docs/kanban-guide.md`, replace:

```markdown
## 13. Rules of thumb
```

with:

```markdown
## 14. Rules of thumb
```

- [ ] **Step 20.2: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2175 passed (2175)`. Run `npx vitest run --project e2e`. Expected: `Tests  168 passed (168)`. Run `npm run typecheck`. Expected: no errors. `git diff e73ee3e -- README.md docs/kanban-guide.md config.example.yaml | grep "^+" | grep -c "—"` prints `0`.

- [ ] **Step 20.3: Commit.**

```bash
git add README.md config.example.yaml docs/kanban-guide.md
git commit -m "Document workflows: the README's commands, tables and a short account, the guide's new section on workflow files, starting, managing, a deciding step and workspaces, its planner recipe making its graph with apply-dag and its terminal recipe applying a previewed DAG, and the config example's note"
```


## Done when

- `npx vitest run --project unit` gives `Tests  2175 passed (2175)`. `npx vitest run --project e2e` gives `Tests  168 passed (168)`, run twice. `npm run typecheck` and `npm run build` report no errors. All under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing, and `git diff e73ee3e -- src README.md docs/kanban-guide.md config.example.yaml | grep "^+" | grep -c "—"` prints `0`.
- A workflow file is checked at every level, by `mt workflow check`, at startup and at each preview and start (`tests/kanban-workflow-file.test.ts`, `tests/kanban-workflow-check.test.ts`).
- A start expands its params into a DAG, which is shaped, made canonical, measured, hashed and checked task by task, then made in one transaction, or refused whole, naming the task (`tests/kanban-workflow-expand.test.ts`, `tests/kanban-dag.test.ts`, `tests/kanban-workflow-service.test.ts`, `tests/kanban-workflow-writer.test.ts`).
- Chat previews and starts, the reply cut to fit and threaded with every member held, and lists, shows and archives instances (`tests/kanban-workflow-chat.test.ts`); a run starts a workflow and applies a DAG of its own, with no gates (`tests/kanban-workflow-worker.test.ts`); the terminal previews as a file, applies with a dry run first, and sees and archives (`tests/mt-kanban-workflow.test.ts`).
- End to end, through the real socket and the fake Lark: a start run in order with its notices in its thread, a deciding step's second workflow, a planner's `apply-dag`, and a terminal's preview, edit, dry run and apply (`tests/kanban-workflow.e2e.ts`).

## Before relying on it: the smoke checklist

For the user, once the plan is built and merged, on the real host, with the real Lark tenant. Run each command as the gateway's user. `<mt>` below is the `mt` the service's build has, `~/.nvm/versions/node/v22.15.0/bin/node <checkout>/dist/mt.js` until `PATH` has one; never a bare `mt` under another node. The items need the board on (`kanban.enabled: true`), a group the bot is in, a role `worker` (and `reviewer` for the example's last step), and you an operator.

0. **Make the host ready**, once. Back up the database while the service is stopped, as this build's first start migrates it to version 9: `<mt> service stop && sqlite3 ~/.manus-team/team.db ".backup /tmp/team-v8.db"`. Build with Node 22 (`cd <checkout> && PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH npm run build`), then `<mt> service start`. `<mt> service logs -n 30` says `schema at version 9` and, after the roles' line, `workflows: none`.
1. **A file, checked.** `mkdir -p ~/.manus-team/workflows` and write the example of spec §21.1 to `~/.manus-team/workflows/vendor-eval.yaml`. `<mt> workflow check` prints `vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)`, exit 0 (`echo $?`). Break a copy, `cp vendor-eval.yaml onboarding.yaml` and add a gate `command: "echo {{topic}}"` to a step: `<mt> workflow check` prints `onboarding: not usable: steps.….gates[0].command holds {{, …`, exit 1; `<mt> service check` prints it as a `warning:` line and still ends `ok: this build would start as …`. Restart the service: the log says `workflow onboarding is not usable: …` and `workflows: vendor-eval; not usable: onboarding`, and the gateway connects. Remove `onboarding.yaml`.
2. **A preview, in the group.** `/kanban workflow preview vendor-eval topic="log storage" vendors=acme,globex`: a reply of four lines, `shortlist`, `evaluate:1`, `evaluate:2` (each `after shortlist, 1 gate`), `recommend` (`after evaluate:1, evaluate:2`), and `Nothing was made: …`. `/kanban task list` shows nothing new. Type the quotes on a phone, where they arrive as `“…”`: the same reply.
3. **A start.** `/kanban workflow start vendor-eval topic="log storage" vendors=acme,globex`: a reply in a thread on the command, `Started vendor-eval as w_…, 4 tasks:`, a line a task, and `This thread hears …`. Lark shows the group's timeline with the command and its thread only. The shortlist runs first; each evaluation after it, one at a time in the shared workspace; the recommendation after both; every notice, `Done: …` and the like, lands in the thread. `/kanban task show` of an evaluation has a line `workflow: w_… vendor-eval, step evaluate, item acme`.
4. **Seeing it.** `/kanban workflow instances` lists it, `running, 1 of 4 done` and so on; `/kanban workflow show w_…` its steps' tasks; `/kanban workflow list` the file with its params. `<mt> kanban workflow show w_… --dag` prints the stored DAG, with no hash.
5. **A person, by @-mention.** A workflow with `assignee: "{{owner}}"` started with `owner=@<a person whose display name has a space>`: their task is theirs (`/kanban task show` names them), and their card comes in the instance's thread when they are in the group, by direct message otherwise. `owner=@Nobody` is refused, `Not done: @Nobody is not someone this message mentions …`.
6. **The terminal.** `<mt> kanban workflow preview vendor-eval --param topic=queues --param vendors=acme --json > /tmp/dag.json`; edit a title in it; `<mt> kanban workflow apply /tmp/dag.json --dry-run` lists every task and `gate: test -s evaluation.md (up to 30 s)`, and makes nothing; `<mt> kanban workflow apply /tmp/dag.json --key smoke-1` makes it, with the edited title, and the gateway runs it (it answered the nudge: no `mt: no gateway answered` line). No chat hears of it. Running the apply again says `already made, as w_…`.
7. **An agent's graph.** Give the `planner` role recipe 3's `role.md`, and send the recipe's task: the planner's run sends `mt kanban apply-dag` (first with `"dry_run": true`), the four tasks appear at once, as an instance shown "(no workflow)", and the chat that made the plan hears each of them. A `role.md` asking for a gate in the DAG gets `apply-dag takes none` back.
8. **Archive.** `/kanban workflow archive w_…` for the instance of item 3: every task of it archived, its open run stopped; `/kanban workflow instances` no longer lists it, and `instances all` does, as archived.

**Clean up.** `rm ~/.manus-team/workflows/*.yaml` if the files were only for the smoke; the instances stay on the board, archived or done, and `/tmp/team-v8.db` is the way back to the database before the migration.
