# Plan V: From a terminal: chats, people, times. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the operator's terminal, and a cron job's script, which is a terminal nobody reads, as good as chat at three things. A chat follows what a terminal makes: `mt kanban task new … --chat oc_… [--thread omt_…]` subscribes the chat and posts it a "Created" line; `mt kanban workflow start` and `apply` take the same flags, follow every member, and post the start's reply there, both queued as events the notifier sends. A person is named at the terminal as `lark:<union_id>`, checked for talk tier as chat checks one, against the same `people` table and the talk allowlist the settings give, with `mt kanban people` to find ids. And `mt kanban task list` says since when: `created_at` and `status_since` in `--json`, and an `age` column. A cron script gets the gateway's `mt` first on its `PATH` and the gateway's `MT_HOME`, `MT_CONFIG` and `MT_DB`, so it calls plain `mt`; and `mt cron --chat`, like the board's `--chat`, names no chat outside a non-empty `auth.chats`.

**Architecture:**
- **The shared pieces first** (Tasks 1 to 4): `src/core/lark-ids.ts`, the chat's and the thread's shapes, the `auth.chats` check and the app id's refusal, which `src/cli/cron.ts`, the operator's front and `KanbanService` import; `TeamSettings.talk` and `.chats`, read by the helpers `loadConfig` uses; `mt cron --chat` held to `auth.chats`; and `openBoard` giving its service chat's `PeopleDirectory`, saying which setting a shell lacks when it cannot.
- **People at the terminal** (Tasks 5, 6): `personRefused` gone, a person checked by the service at `task new`, `task assign`, a workflow's params and an applied DAG, the refusal in chat's words with the terminal's hint; no `@` there; a run's `start-workflow` keeps its refusal; the preview's facts alone take any person, saying so on stderr; and `mt kanban people`.
- **A chat that follows** (Tasks 7 to 9): `follow` beside `createdVia`, written by `subscribe()`, refused unless from the operator; `task_created_followed` and `workflow_started`, the "Created" line and the start's reply, rendered by the notifier from the task and the payload alone; and the flags, checked before the board is opened, then the key, then the thread's root.
- **Times** (Task 10): `phaseSince`, one query a board, `status_since` and `created_at` in milliseconds, and `age`.
- **A script's `mt`** (Task 11): `scriptEnv`, from `WorkerAccess` and a new `ScriptHome` dep.
- **The documents** (Task 12): the README, the guide and `docs/examples.md`, checked by `tests/docs-examples.test.ts`.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`), vitest, better-sqlite3 11, `yaml` 2. No new dependency, and no migration: the schema stays at its version.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §22 (from line 4046); `docs/specs/2026-11-16-workflows-design.md` §18 (from line 1298); `docs/specs/2026-11-16-cron-design.md` §5.1, §6.2, §13's and §14's plan V items, and §15's limits as amended for plan V; all as amended on 2026-11-17. Below, "§22.N" is the kanban spec's, "workflows §18.N" and "cron §N" the others'.

---

## Ground rules

- **Where to work.**
  - Use the worktree beside the main checkout, `/Users/x/Develop/manus/prime-gateway-wt2`, on the branch `terminal-followups`, which holds this plan, on top of `e703833`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, never reach the real Lark or the network, and never read or write `~/.manus-team`. Every test makes its own home in a temporary directory, its own database and its own roles; the notifier's and the card poster's tests run on the fake Lark channel and a `ManualClock`, and the scripts that call `mt` run this build's launcher against a temporary home.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npx vitest run --project unit` gives `Tests  2485 passed (2485)`. `npx vitest run --project e2e` gives `Tests  172 passed (172)`. `npm run typecheck` reports no errors. The tests of `tests/update-run.test.ts` and the other `mt update` tests, which time detached children, can fail on a loaded or sleeping machine; run the file again alone before looking for a cause.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text is whole lines, and appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given. Every step of this plan was applied in that order, from `e703833`, in a throwaway copy, and gave the counts and failures it states; the plan's own text was then applied in a second fresh copy, which reproduced the first copy's tree byte for byte at the end of every task.
- **One writer.** `db/` modules stay the only writers of a database: `db/kanban.ts` writes the subscriptions a `follow` makes and the two new events, `task_created_followed` and `workflow_started`; the front, the service and the notifier only call it or read. `src/db/WRITERS.md` says so (Tasks 7, 8). `peopleOf` and `phaseSince` are reads.
- **Words a person sees** (replies, refusals, `mt` output, notices, the README, the guide and the examples) never name a plan, and do not use the long dash.
- **No real agent.** No test runs bytesec.

## Decisions

Each has its reason. Where the code and the spec disagree, the code is the fact, and the decision says which reading keeps the spec's intent; those are listed again under "Where the code forced a reading" below.

1. **The shared shapes and words live in `src/core/lark-ids.ts`** (Task 1, 3): `CHAT_ID`, `THREAD_ID`, `NEEDS_BOT` ("--chat needs the bot: …", cron's words) and `chatRefused(chat, chats)`, the `auth.chats` refusal in §22.1's words. A test reads the sources to hold §22.5's rule that no module of `src/kanban/` imports `src/cli/`.
2. **`TeamSettings.chats` is optional in the type, and always set by `teamSettingsFrom`**: settings a test builds by hand stay valid, and an absent list is read as empty, any chat, as the gateway reads it.
3. **A malformed `--chat` or `--thread`, and `--thread` without `--chat`, are wrong command lines, exit 2**, as `mt cron add --chat`'s malformed chat is; the app id and `auth.chats` are refusals, `invalid`, exit 1, made through a new `OpenOptions.check` that `openBoard` runs after the agent's-shell refusal and before it opens the database (Task 9). So all four refuse before the board is opened, a repeat by key included.
4. **The key is looked up before the root by the front**, with `KanbanService.keyMade(key, via, 'task' | 'instance')`, as the key's lookup is inside `createTask` and the start's step 0; a key already used gets no `follow` at all, so a repeat whose thread has lost its root is still answered, and adds nothing.
5. **A repeat's `follows`**, in `--json` and in the plain line, is `KanbanService.followOf(taskId, appId)`: the task's first Lark subscription for this bot, or the first member's for an instance, the thread `null` at chat scope; `null` with none.
6. **The front adds the hint, and names the missing setting** (`personHint`, Task 4): for `person_not_assignable` it appends "; mt kanban people lists …" to chat's words; for a service with no talk check, it replaces `assignable`'s "cannot be given work yet: … until the board is in Lark" in place, so a DAG refusal keeps its `tasks[i] (ref …):` prefix, and gives no hint, as the person is not the problem. The app id is named first when both are missing.
7. **`@` is refused at the terminal wherever a person may go**: `task new`'s `--assignee` and `--reviewer`, `task assign`, a param that lands in a person field, and a DAG's `assignee` and `reviewer` (`checkDagTasks`'s terminal rule becomes this one). §22.2's words, `invalid`; a DAG's refusal is prefixed with its task's place, as every DAG refusal is.
8. **`mt kanban people` refuses `no_bot`** without an app id, and with no owner lists everyone as `no`, saying so once on stderr; a person with no name is `(no name)`, sorted last. Its table is `plain.ts`'s `peopleText`.
9. **The "Created" line is rendered from the task as it is now**, as every notice is: "Created `k_…` **title**, for role worker, by operator:alice from a terminal.", `for nobody yet` with no assignee, a person by the name Lark last gave.
10. **`workflow_started`'s payload counts every member for `people`**, and lists the first 30; `fitted` gains a `total`, so a reply of 30 listed members of 100 says "… and 70 more" even when all 30 fit.
11. **The terminal's answers**: `created k_…: <title>, for role worker, on board default; chat oc_… follows it[, in thread omt_…]`; a start's or an apply's last line `chat oc_… follows its tasks[, in thread omt_…], and is sent the start's reply`, a repeat's `chat oc_… follows its tasks`, a dry run's `chat oc_… would follow its tasks[, in thread omt_…], and be sent the start's reply`.
12. **`status_since` is the `created_at` of the newest phase-changing event by id**, found with SQLite's bare column beside `max(id)`, and the payload's `kind` and `next` read with `json_extract`, as `db/kanban.ts` already reads `next`.
13. **`listText` takes the times** as `{ since, now }`, `now` the terminal's `Date.now()`, so its own test needs no clock.
14. **`scriptEnv(role, env, worker, home)`** is exported, pure, and used by the scheduler's `#script`: the docs test runs the examples' scripts with the environment a fire gives them, not a copy of its rules. `#workerEnv` and it share `mtFirst`. `src/index.ts` passes `MT_CONFIG` and `MT_DB` resolved to absolute paths, as a script runs in its workspace, not in the gateway's directory.

## Known limitations

From §22.7, workflows §18.7 and cron §5.1, §15, kept as they say: no thread opened from a terminal, and none followed whose root the board does not know; no check that the bot is in the chat; no `/kanban follow` for a task already made; the terminal judges talk tier by its own reading of the configuration, so an edited `auth.talk` counts at the terminal at once and at the gateway after a restart; `status_since` is a phase's, so how long a task has been ready or running is not said; no reply for a repeat by key, and no second chat for a task or an instance once made; the preview leaves people unchecked; no `--chat` for an agent's start or DAG. Besides:

- **A hand-run gateway's shell-only settings are not seen by its scripts' `mt`**: `LARK_APP_ID`, `MT_OWNER_OPEN_ID` and `MT_ALLOW_TALK` fail safe, but an `MT_ALLOW_CHATS` set only in that shell leaves the script's `auth.chats` empty, any chat. The examples say to put such settings in the config file or the `.env`.
- **A script runs in its job's workspace**, which the role's agents write to; the examples say to keep a job's script outside it.
- **Chat's `/kanban task list` is unchanged**: no age there.

## Where the code forced a reading

- **The key's lookup is inside the writer** (`createTask`, the start's step 0), so §22.1's order, "then the key is looked up; then … the thread's root", needs a read before it: `KanbanService.keyMade` (Decision 4). The service checks a `follow`'s shape before the key, so a malformed one from any caller is refused first.
- **`act` gave its function only the service.** It now passes the `BoardAccess` too, for the app id (Task 9), the missing setting (Task 5) and the people seen (Task 6).
- **`renderStarted` took a start's rows.** The payload is flat, so it takes a `StartedReply`; chat builds one from its rows with `startedReply`, and the notifier from the payload; `renderNotice` takes `where` for the words, which the notifier gives from the conversation's thread and root (workflows §18.5).
- **The notifier already sends a batch's first notice whole**: `BATCH_CHARS` is checked only once a batch holds one, so no change was needed for workflows §18.2's "never cut"; a test holds it.
- **`assignable`'s message for a service with no people is shared with chat and the worker.** The terminal changes it only in its own answer (Decision 6), so chat's and an agent's words stay as they are.
- **`checkDagTasks` refused every person when `createdVia` was the operator.** Workflows §18.3 removes that rule; §22.2 refuses `@` wherever a person may go, so the same place now refuses a DAG's `@Name` at the terminal (Decision 7).
- **`expand` and `paramValues` told the terminal from a run only by `GivenParams.from`.** They take the start's `createdVia` kind as workflows §18.3 says; the service passes `req.createdVia.kind`, and the preview `'operator'`.
- **`--json` had no shape for "followed".** `follows` is `{"chat", "thread"}`, `thread` null at chat scope, or `null`.
- **The terminal's start answer.** Workflows §18.2 words it "and is sent this reply"; at a terminal "this" would name the terminal's own answer, so it says "and is sent the start's reply" (Decision 11).
- **The gateway's files, as a script finds them.** `GatewayConfig.dbPath` and `configPath` may be relative to the gateway's directory, and a script runs in its workspace, so they are passed resolved (Decision 14).
- **The examples said a terminal gives no person work** in workflows 1 to 5 and in the triage workflow's terminal start, besides example 6. Those sentences became false, so Task 12 says instead how a terminal names a person, and that `--chat` makes a chat follow; their commands are unchanged. `tests/docs-examples.test.ts`'s home gains an owner and Dana Wu, `lark:on_5d1e7a`, at talk tier, whom example 6 names as the reviewer.

## File map

| File | Responsibility |
|---|---|
| `src/core/lark-ids.ts` (create) | `CHAT_ID`, `THREAD_ID`, `NEEDS_BOT`, `chatRefused` (Tasks 1, 3) |
| `src/cli/cron.ts` (modify) | `CHAT_ID` imported; `--chat` held to `auth.chats` (Tasks 1, 3) |
| `src/config.ts` (modify) | `TeamSettings.talk`, `.chats`; `ownerOf`, `talkOf`, `chatsOf` (Task 2) |
| `src/cli/gate.ts` (modify) | `openBoard`'s `PeopleDirectory`, `peopleMissing`, `personHint`, `seen()`, `appId`, `OpenOptions.check` (Tasks 4, 6, 9) |
| `src/kanban/task-checks.ts`, `src/kanban/dag.ts`, `src/kanban/workflow.ts` (modify) | `NO_MENTIONS`; the terminal's rule in `checkDagTasks`; `via` for `@` (Task 5) |
| `src/cli/operator.ts` (modify) | people, `@`, the hint, the preview's facts; `people`; `--chat`, `--thread`, `follows`; the list's times (Tasks 5, 6, 9, 10) |
| `src/cli/mt.ts` (modify) | `people` group; `USAGE` (Tasks 6, 9) |
| `src/cli/plain.ts` (modify) | `peopleText`; `ageText`, the `age` column (Tasks 6, 10) |
| `src/db/people.ts` (modify) | `peopleOf` (Task 6) |
| `src/kanban/types.ts`, `src/kanban/service.ts` (modify) | `Follow`, `CreateRequest.follow`, `StartRequest.follow`, `ApplyRequest.follow`, `followRefused`, `threadRoot`, `keyMade`, `followOf`, `phaseSince` (Tasks 5, 7 to 10) |
| `src/db/kanban.ts`, `src/db/WRITERS.md` (modify) | `subscribe()`'s follow, `task_created_followed`, `applyDag`'s follow and `workflow_started` (Tasks 7, 8) |
| `src/db/kanban-read.ts` (modify) | `phaseSince` (Task 10) |
| `src/kanban/chat-render.ts`, `src/kanban/notices.ts`, `src/kanban/chat.ts` (modify) | the two notices, `StartedReply`, `startedReply`, `fitted`'s total, `where` (Tasks 7, 8) |
| `src/cron/scheduler.ts`, `src/index.ts` (modify) | `ScriptHome`, `scriptEnv`, `mtFirst` (Task 11) |
| `README.md`, `docs/kanban-guide.md`, `docs/examples.md` (modify) | the documents (Task 12) |
| `tests/lark-ids.test.ts`, `tests/team-settings-auth.test.ts`, `tests/mt-cron-chats.test.ts`, `tests/mt-board-people.test.ts`, `tests/mt-terminal-people.test.ts`, `tests/mt-kanban-people.test.ts`, `tests/kanban-follow.test.ts`, `tests/kanban-workflow-started.test.ts`, `tests/mt-terminal-chat.test.ts`, `tests/kanban-phase-since.test.ts`, `tests/cron-script-env.test.ts` (create) | |
| `tests/config.test.ts`, `tests/kanban-dag.test.ts`, `tests/kanban-workflow-expand.test.ts`, `tests/kanban-workflow-service.test.ts`, `tests/mt-kanban-operator-tasks.test.ts`, `tests/mt-kanban-workflow.test.ts`, `tests/kanban-workflow-chat.test.ts`, `tests/mt-plain.test.ts`, `tests/helpers/cron.ts`, `tests/docs-examples.test.ts` (modify) | the shared settings' shape, a person at the terminal, the start's reply's shape, the list's columns, the scheduler's new dep, the examples |

Running counts, unit then end to end: Task 1 2487 / 172, Task 2 2489 / 172, Task 3 2492 / 172, Task 4 2497 / 172, Task 5 2506 / 172, Task 6 2511 / 172, Task 7 2521 / 172, Task 8 2531 / 172, Task 9 2540 / 172, Task 10 2546 / 172, Task 11 2552 / 172, Task 12 2553 / 172.

How the specs' tests map to the tasks: §22.6 `--chat` (Tasks 7, 9; the notifier's "Created" line and its resend, and a person's card in the thread, Task 7); §22.6 people (Tasks 4, 5, 6; `TeamSettings`, Task 2); §22.6 times (Task 10); workflows §18.6 `--chat` (Tasks 8, 9), the reply (Task 8), people (Task 5); cron §14's script environment (Task 11, and the examples' scripts in Task 12) and `--chat` with `auth.chats` (Task 3).

---

### Task 1: `src/core/lark-ids.ts`: a chat's and a thread's shape

**Files:**

- Create: `src/core/lark-ids.ts`, `tests/lark-ids.test.ts`
- Modify: `src/cli/cron.ts`

§22.1, §22.5, cron §6.2. `CHAT_ID` moves out of `src/cli/cron.ts` into a module of `src/core/`, with `THREAD_ID` beside it, so the operator's front and `KanbanService` can check a `follow` without anything in `src/kanban/` importing from `src/cli/`. Nothing else changes: `mt cron`'s tests pass as they are.

- [ ] **Step 1.1: Write the tests.**

Create `tests/lark-ids.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHAT_ID, THREAD_ID } from '../src/core/lark-ids.js';

/**
 * A chat's and a thread's id, as a terminal names them (kanban spec §22.1, the
 * cron spec §6.2): checked for shape, in one place the cron CLI, the
 * operator's board commands and the board's service share.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

describe('CHAT_ID and THREAD_ID', () => {
  it('take oc_ and omt_ with 1 to 64 letters and digits, and nothing else', () => {
    for (const ok of ['oc_a', 'oc_TEAM9', `oc_${'x'.repeat(64)}`]) expect(CHAT_ID.test(ok), ok).toBe(true);
    for (const no of ['oc_', 'oc_a-b', 'oc_a_b', ` oc_a`, 'oc_a\n', `oc_${'x'.repeat(65)}`, 'omt_a', 'chat']) expect(CHAT_ID.test(no), no).toBe(false);
    for (const ok of ['omt_a', 'omt_Topic7', `omt_${'x'.repeat(64)}`]) expect(THREAD_ID.test(ok), ok).toBe(true);
    for (const no of ['omt_', 'omt_a b', 'oc_a', `omt_${'x'.repeat(65)}`, 'thread']) expect(THREAD_ID.test(no), no).toBe(false);
  });

  it('are imported by the cron CLI, and no module of src/kanban imports src/cli', () => {
    expect(readFileSync(join(SRC, 'cli', 'cron.ts'), 'utf8')).toMatch(/import \{ CHAT_ID[^}]*\} from '\.\.\/core\/lark-ids\.js';/);
    expect(readFileSync(join(SRC, 'cli', 'cron.ts'), 'utf8')).not.toMatch(/const CHAT_ID =/);
    for (const name of readdirSync(join(SRC, 'kanban')).filter((n) => n.endsWith('.ts'))) {
      expect(readFileSync(join(SRC, 'kanban', name), 'utf8'), name).not.toMatch(/from '\.\.\/cli\//);
    }
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/lark-ids.test.ts`. Expected: `Test Files  1 failed (1)` and `Tests  no tests`, as `Error: Cannot find module '../src/core/lark-ids.js' imported from …/tests/lark-ids.test.ts`.

- [ ] **Step 1.3: Implement.**

In `src/cli/cron.ts`, replace:

```ts
import { existsSync } from 'node:fs';
```

with:

```ts
import { existsSync } from 'node:fs';
import { CHAT_ID } from '../core/lark-ids.js';
```

In `src/cli/cron.ts`, replace:

```ts
].join('\n');

/** A chat id as Lark gives one: checked for shape, not for whether the bot is in it (§6.2). */
const CHAT_ID = /^oc_[A-Za-z0-9]{1,64}$/;
```

with:

```ts
].join('\n');
```

Create `src/core/lark-ids.ts`:

```ts
/**
 * Lark's ids as a terminal names them (kanban spec §22.1, the cron spec §6.2):
 * a chat, `oc_…`, and a thread, `omt_…`, checked for shape only, as a terminal
 * has no Lark client to ask whether the bot is in the chat. `mt cron`, the
 * operator's `mt kanban` and the board's service all check them here, so
 * nothing in `src/kanban/` imports from `src/cli/`.
 */

/** A chat id as Lark gives one. */
export const CHAT_ID = /^oc_[A-Za-z0-9]{1,64}$/;

/** A thread id as Lark gives one. */
export const THREAD_ID = /^omt_[A-Za-z0-9]{1,64}$/;
```

- [ ] **Step 1.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2487 passed (2487)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.5: Commit.**

```bash
git add src/cli/cron.ts src/core/lark-ids.ts tests/lark-ids.test.ts
git commit -m "Move a chat id's shape to src/core/lark-ids.ts, with a thread id's beside it, so the cron CLI, the operator's board commands and the board's service check them in one place"
```

---

### Task 2: `TeamSettings.talk` and `TeamSettings.chats`

**Files:**

- Create: `tests/team-settings-auth.test.ts`
- Modify: `src/config.ts`, `tests/config.test.ts`

§22.1, §22.2, §22.5. `teamSettingsFrom` reads the talk allowlist and the chats as `loadConfig` reads `auth.allowTalk` and `auth.allowChats`, by three helpers both call: `ownerOf`, `talkOf`, which puts the owner first, and `chatsOf`. `talk` is set only with an owner, as a gateway with none does not start. The test compares the two for each mix of the environment and the file; `tests/config.test.ts`'s comparison of the shared fields gains the two.

- [ ] **Step 2.1: Write the tests.**

In `tests/config.test.ts`, replace:

```ts
      appId: c.lark.appId,
```

with:

```ts
      appId: c.lark.appId,
      talk: c.auth.allowTalk,
      chats: c.auth.allowChats,
```

Create `tests/team-settings-auth.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig, loadTeamSettings, type FileReader } from '../src/config.js';

/**
 * The talk allowlist and the chats as a terminal reads them (kanban spec
 * §22.1, §22.2): `TeamSettings.talk` and `TeamSettings.chats`, read by the
 * same helpers as `loadConfig`'s `auth.allowTalk` and `auth.allowChats`, so the
 * two cannot drift. `talk` is there only with an owner, the owner always in it.
 */

const HOME = '/var/lib/mt';
const PATH = join(HOME, 'config.yaml');
const BASE = { MT_HOME: HOME, LARK_APP_SECRET: 'app-secret' };

function file(auth: Record<string, unknown> | undefined): FileReader {
  const text = stringify({ workspace: '/srv/repo', lark: { appId: 'cli_app' }, agent: { command: 'bytesec' }, ...(auth === undefined ? {} : { auth }) });
  return (path) => (path === PATH ? text : undefined);
}

describe('TeamSettings.talk and TeamSettings.chats', () => {
  it("equal loadConfig's allowTalk and allowChats for each mix of the environment and the file", () => {
    const files = [
      { owner: 'ou_owner' },
      { owner: 'ou_owner', talk: ['ou_a', 'ou_b'], chats: ['oc_team'] },
      { owner: 'ou_owner', talk: ['ou_owner', 'ou_a'], chats: [] },
    ];
    const envs: Array<Record<string, string>> = [
      {},
      { MT_OWNER_OPEN_ID: 'ou_boss' },
      { MT_ALLOW_TALK: 'ou_c, ou_d,ou_c' },
      { MT_ALLOW_TALK: '' },
      { MT_ALLOW_CHATS: 'oc_x,oc_y' },
      { MT_ALLOW_CHATS: '' },
      { MT_OWNER_OPEN_ID: 'ou_boss', MT_ALLOW_TALK: 'ou_a', MT_ALLOW_CHATS: 'oc_z' },
    ];
    for (const auth of files) {
      for (const over of envs) {
        const env = { ...BASE, ...over };
        const gateway = loadConfig(env, file(auth));
        const team = loadTeamSettings(env, file(auth));
        const at = JSON.stringify({ auth, over });
        expect(team.talk, at).toEqual(gateway.auth.allowTalk);
        expect(team.chats, at).toEqual(gateway.auth.allowChats);
      }
    }
  });

  it('has no talk without an owner, and chats empty when neither sets any', () => {
    const team = loadTeamSettings(BASE, file(undefined));
    expect(team.talk).toBeUndefined();
    expect(team.chats).toEqual([]);
    expect(loadTeamSettings({ ...BASE, MT_ALLOW_TALK: 'ou_a', MT_ALLOW_CHATS: 'oc_a' }, file(undefined))).toMatchObject({ chats: ['oc_a'] });
    expect(loadTeamSettings({ ...BASE, MT_ALLOW_TALK: 'ou_a' }, file(undefined)).talk).toBeUndefined();
    expect(loadTeamSettings({ ...BASE, MT_OWNER_OPEN_ID: 'ou_boss', MT_ALLOW_TALK: 'ou_a' }, file(undefined)).talk).toEqual(['ou_boss', 'ou_a']);
  });
});
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/config.test.ts tests/team-settings-auth.test.ts`. Expected: `Tests  3 failed | 76 passed (79)`; among the failures, `AssertionError: expected undefined to deeply equal []`.

- [ ] **Step 2.3: Implement.**

In `src/config.ts`, replace:

```ts
  /**
   * `kanban.enabled` as the config sets it, absent when it does not (the board is
```

with:

```ts
  /**
   * The talk allowlist as the gateway builds `auth.allowTalk`: the owner,
   * `MT_OWNER_OPEN_ID` or `auth.owner`, and `MT_ALLOW_TALK` or `auth.talk`.
   * Present only with an owner, as a gateway with none does not start: what
   * the terminal checks a person's talk tier against (kanban spec §22.2).
   */
  talk?: readonly string[];
  /**
   * The chats the gateway acts in, `MT_ALLOW_CHATS` or `auth.chats`, as it
   * builds `auth.allowChats`; empty for any chat. A terminal's `--chat` names
   * none outside it (kanban spec §22.1, the cron spec §6.2).
   */
  chats?: readonly string[];
  /**
   * `kanban.enabled` as the config sets it, absent when it does not (the board is
```

In `src/config.ts`, replace:

```ts
  const ownerOpenId =
    envString(env, 'MT_OWNER_OPEN_ID') ??
    file.auth.owner ??
    fail('an owner is required: set auth.owner in the config file, or MT_OWNER_OPEN_ID');
  const team = teamSettingsFrom(env, located);

  const allowTalk = envList(env, 'MT_ALLOW_TALK') ?? file.auth.talk;
```

with:

```ts
  const ownerOpenId = ownerOf(env, file) ?? fail('an owner is required: set auth.owner in the config file, or MT_OWNER_OPEN_ID');
  const team = teamSettingsFrom(env, located);

```

In `src/config.ts`, replace:

```ts
      allowTalk: unique([ownerOpenId, ...allowTalk]),
      allowOperate: unique([ownerOpenId, ...allowOperate]),
      allowChats: envList(env, 'MT_ALLOW_CHATS') ?? file.auth.chats,
```

with:

```ts
      allowTalk: talkOf(env, file, ownerOpenId),
      allowOperate: unique([ownerOpenId, ...allowOperate]),
      allowChats: chatsOf(env, file),
```

In `src/config.ts`, replace:

```ts

function teamSettingsFrom(env: Env, { home, path, text, file }: Located, opts: LoadOptions = {}): TeamSettings {
```

with:

```ts

/** The owner, `MT_OWNER_OPEN_ID` else `auth.owner`: `loadConfig`'s, and the terminal's talk check's. */
function ownerOf(env: Env, file: FileConfig): string | undefined {
  return envString(env, 'MT_OWNER_OPEN_ID') ?? file.auth.owner;
}

/** The talk allowlist, `MT_ALLOW_TALK` else `auth.talk`, with the owner always first in it. */
function talkOf(env: Env, file: FileConfig, owner: string): string[] {
  return unique([owner, ...(envList(env, 'MT_ALLOW_TALK') ?? file.auth.talk)]);
}

/** The chats the gateway acts in, `MT_ALLOW_CHATS` else `auth.chats`; empty for any. */
function chatsOf(env: Env, file: FileConfig): readonly string[] {
  return envList(env, 'MT_ALLOW_CHATS') ?? file.auth.chats;
}

function teamSettingsFrom(env: Env, { home, path, text, file }: Located, opts: LoadOptions = {}): TeamSettings {
```

In `src/config.ts`, replace:

```ts
  const appId = envString(env, 'LARK_APP_ID') ?? file.lark.appId;
```

with:

```ts
  const appId = envString(env, 'LARK_APP_ID') ?? file.lark.appId;
  const owner = ownerOf(env, file);
```

In `src/config.ts`, replace:

```ts
    ...(appId === undefined ? {} : { appId }),
```

with:

```ts
    ...(appId === undefined ? {} : { appId }),
    ...(owner === undefined ? {} : { talk: talkOf(env, file, owner) }),
    chats: chatsOf(env, file),
```

- [ ] **Step 2.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2489 passed (2489)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.5: Commit.**

```bash
git add src/config.ts tests/config.test.ts tests/team-settings-auth.test.ts
git commit -m "Read the talk allowlist and auth.chats into TeamSettings by the helpers loadConfig uses, the talk list only with an owner, so a terminal can check a person's tier and a chat as the gateway would"
```

---

### Task 3: `mt cron --chat` held to `auth.chats`

**Files:**

- Create: `tests/mt-cron-chats.test.ts`
- Modify: `src/cli/cron.ts`, `src/core/lark-ids.ts`

Cron §6.2, §22.1. `delivery()`, which `add` and `edit` call before the service, refuses a chat outside a non-empty `auth.chats`, `invalid`, in §22.1's words, after the app id's refusal, which moves to `NEEDS_BOT` unchanged. So a repeated `--key` naming a chat that has left the list is refused, not answered; an empty list takes any chat; a job already delivering to such a chat is left as it is, and its other fields edit as before.

- [ ] **Step 3.1: Write the tests.**

Create `tests/mt-cron-chats.test.ts`:

```ts
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getJob, listJobs } from '../src/db/cron.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `mt cron add --chat` and `mt cron edit --chat` against `auth.chats` (the
 * cron spec, §6.2, kanban spec §22.1): a chat outside a non-empty list is
 * refused, in the board's words; an empty list takes any chat; a job made
 * before the check is left as it is.
 */

let fx: MtFixture;
let db: Db;

afterEach(() => {
  clearSecrets();
  db?.close();
  fx?.cleanup();
});

function setup(auth: string[]): void {
  clearSecrets();
  fx = mtFixture((ws) =>
    [`workspace: ${ws}`, 'lark:', '  appId: cli_app', ...auth, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', 'cron:', '  tz: Asia/Shanghai', ''].join('\n'),
  );
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
}

const OUTSIDE = 'oc_other is not in auth.chats, so this gateway does not act in it: add it there, or name a chat that is';

describe('mt cron --chat and auth.chats', () => {
  it('refuses on add and on edit a chat not in a non-empty auth.chats, before the add, a repeated key included', async () => {
    setup(['auth:', '  chats: [oc_team]']);
    expect(await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_other'])).toEqual({ code: 1, out: '', err: `mt: ${OUTSIDE}` });
    expect(JSON.parse((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_other', '--json'])).out)).toEqual({ ok: false, code: 'invalid', message: OUTSIDE });
    expect(listJobs(db)).toEqual([]);
    const made = JSON.parse((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_team', '--key', 'k1', '--json'])).out);
    expect(made).toMatchObject({ ok: true, existing: false, job: { delivery: { chat: 'oc_team' } } });
    const id = made.job.job_id as string;
    expect(await fx.run(['cron', 'edit', id, '--chat', 'oc_other'])).toEqual({ code: 1, out: '', err: `mt: ${OUTSIDE}` });
    expect(getJob(db, id)?.delivery?.chat).toBe('oc_team');
    // The same key, and a chat the list no longer holds: refused, not answered with the key's job.
    expect(await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_other', '--key', 'k1'])).toMatchObject({ code: 1, err: `mt: ${OUTSIDE}` });
  });

  it('takes any chat when auth.chats is empty, and MT_ALLOW_CHATS over the file', async () => {
    setup([]);
    expect((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_anywhere'])).code).toBe(0);
    expect(await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_other'], { env: { MT_ALLOW_CHATS: 'oc_team' } })).toMatchObject({ code: 1, err: `mt: ${OUTSIDE}` });
    expect((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_team'], { env: { MT_ALLOW_CHATS: 'oc_team' } })).code).toBe(0);
  });

  it('leaves a job delivering to a chat outside the list as it is, and edits its other fields', async () => {
    setup([]);
    const id = JSON.parse((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_other', '--json'])).out).job.job_id as string;
    const r = await fx.run(['cron', 'edit', id, '--prompt', 'Check again.'], { env: { MT_ALLOW_CHATS: 'oc_team' } });
    expect(r.code, r.err).toBe(0);
    expect(getJob(db, id)).toMatchObject({ prompt: 'Check again.', delivery: { chat: 'oc_other' } });
  });
});
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-cron-chats.test.ts`. Expected: `Tests  2 failed | 1 passed (3)`; among the failures, `AssertionError: expected { code: +0, …(2) } to deeply equal { code: 1, out: '', …(1) }`.

- [ ] **Step 3.3: Implement.**

In `src/cli/cron.ts`, replace:

```ts
import { CHAT_ID } from '../core/lark-ids.js';
```

with:

```ts
import { CHAT_ID, NEEDS_BOT, chatRefused } from '../core/lark-ids.js';
```

In `src/cli/cron.ts`, replace:

```ts
  appId: string | undefined;
```

with:

```ts
  appId: string | undefined;
  /** `auth.chats` as this shell's settings give it: a `--chat` outside it, when it is not empty, is refused. */
  chats: readonly string[];
```

In `src/cli/cron.ts`, replace:

```ts
  return { service, db, home: settings.home, appId: settings.appId, enabled: settings.cron?.enabled, zoneSource };
```

with:

```ts
  return { service, db, home: settings.home, appId: settings.appId, chats: settings.chats ?? [], enabled: settings.cron?.enabled, zoneSource };
```

In `src/cli/cron.ts`, replace:

```ts
    const delivery = (chat: string): CronDelivery | number =>
      o.appId === undefined ? no('invalid', '--chat needs the bot: set lark.appId in the config file, or LARK_APP_ID') : { channel: 'lark', account: o.appId, chat, thread: '', root: null };
```

with:

```ts
    // Before the add or the edit, so a repeated key naming a chat that has left auth.chats is refused too (§6.2).
    const delivery = (chat: string): CronDelivery | number => {
      if (o.appId === undefined) return no('invalid', NEEDS_BOT);
      const outside = chatRefused(chat, o.chats);
      return outside === undefined ? { channel: 'lark', account: o.appId, chat, thread: '', root: null } : no('invalid', outside);
    };
```

In `src/core/lark-ids.ts`, replace:

```ts
export const THREAD_ID = /^omt_[A-Za-z0-9]{1,64}$/;
```

with:

```ts
export const THREAD_ID = /^omt_[A-Za-z0-9]{1,64}$/;

/** What a terminal's `--chat` says when this shell's settings give the bot no app id. */
export const NEEDS_BOT = '--chat needs the bot: set lark.appId in the config file, or LARK_APP_ID';

/**
 * Why a terminal may not name `chat`: it is outside `chats`, `auth.chats` as
 * the settings give it, which is not empty, so the gateway admits no message
 * from it and nobody there could answer. Undefined when it may: an empty list
 * means any chat, as it does for the gateway.
 */
export function chatRefused(chat: string, chats: readonly string[]): string | undefined {
  if (chats.length === 0 || chats.includes(chat)) return undefined;
  return `${chat} is not in auth.chats, so this gateway does not act in it: add it there, or name a chat that is`;
}
```

- [ ] **Step 3.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2492 passed (2492)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.5: Commit.**

```bash
git add src/cli/cron.ts src/core/lark-ids.ts tests/mt-cron-chats.test.ts
git commit -m "Refuse mt cron add --chat and mt cron edit --chat for a chat outside a non-empty auth.chats, before the add, so a terminal names no chat the gateway ignores"
```

---

### Task 4: `openBoard`'s people, and what a shell lacks

**Files:**

- Create: `tests/mt-board-people.test.ts`
- Modify: `src/cli/gate.ts`

§22.2. `openBoard` gives its service a `PeopleDirectory` over the database it opened, for `settings.appId`, whose `canTalk(openId)` reads `settings.talk`, when the settings give both; `BoardAccess.peopleMissing` says `appId` or `owner` otherwise, the app id first. `personHint` is how the terminal will say a person's refusal (Task 5 wires it): chat's words and the hint, or, from a service with no people, the missing setting in place of "until the board is in Lark". The front still refuses every person before the service sees one, so this task changes no command's answer: its tests call `openBoard` and `personHint` directly, and an owner only in the gateway's `.env` counts, through `withGatewayFile`.

- [ ] **Step 4.1: Write the tests.**

Create `tests/mt-board-people.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBoard, personHint, type BoardAccess } from '../src/cli/gate.js';
import { withGatewayFile, type MtIo } from '../src/cli/mt.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The terminal's board knows people (kanban spec §22.2): `openBoard` gives its
 * service chat's `PeopleDirectory` over the database it opened, with this
 * bot's app id and the talk allowlist the settings give, so a person named by
 * principal is checked by chat's own code; and says what this shell lacked when
 * it cannot, which `personHint` words for the terminal.
 */

let fx: MtFixture;
let db: Db;
const boards: BoardAccess[] = [];

afterEach(() => {
  clearSecrets();
  while (boards.length > 0) boards.pop()?.close();
  db?.close();
  fx?.cleanup();
});

/** A home whose config has the lines given, its database migrated, and three people this bot has seen. */
function setup(lines: string[]): void {
  clearSecrets();
  fx = mtFixture((ws) => [`workspace: ${ws}`, ...lines, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  for (const [unionId, openId, name] of [['on_alice', 'ou_alice', 'Alice Chen'], ['on_bob', 'ou_bob', 'Bob Li'], ['on_owner', 'ou_owner', 'Owner']] as const) {
    notePerson(db, { appId: 'cli_app', unionId, openId, name }, 1);
  }
}

function open(env: Record<string, string | undefined> = {}): BoardAccess {
  const err: string[] = [];
  const io: MtIo = { env: { ...fx.env, ...env }, out: () => undefined, err: (l) => err.push(l) };
  const board = openBoard(withGatewayFile(io), 'mt kanban task new');
  if (typeof board === 'number') throw new Error(`refused: ${err.join('\n')}`);
  boards.push(board);
  return board;
}

function assign(board: BoardAccess, assignee: string) {
  return board.service.create({ title: 'Book the venue', assignee, createdBy: 'operator:me', createdVia: { kind: 'operator' } });
}

const UNKNOWN_TALK =
  'cannot be given work: being assigned lets a person report on the task, which needs talk tier, and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it';

describe("openBoard's people", () => {
  it('checks a person as chat does: seen by this bot, and at talk tier by the open_id last seen', () => {
    setup(['lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', '  talk: [ou_alice]']);
    const board = open();
    expect(board.peopleMissing).toBeUndefined();
    expect(assign(board, 'lark:on_alice')).toMatchObject({ ok: true, task: { assignee: { kind: 'human', name: 'lark:on_alice' } } });
    expect(assign(board, 'lark:on_owner')).toMatchObject({ ok: true });
    expect(assign(board, 'lark:on_bob')).toEqual({ ok: false, code: 'person_not_assignable', message: `"lark:on_bob" ${UNKNOWN_TALK}` });
    expect(assign(board, 'lark:on_carol')).toEqual({ ok: false, code: 'person_not_assignable', message: `"lark:on_carol" ${UNKNOWN_TALK}` });
    // Another bot's people are not this one's.
    notePerson(db, { appId: 'cli_other', unionId: 'on_dana', openId: 'ou_alice', name: 'Dana' }, 2);
    expect(assign(board, 'lark:on_dana')).toMatchObject({ ok: false, code: 'person_not_assignable' });
  });

  it("counts an owner, a talk list and an app id the gateway's .env holds, and MT_ALLOW_TALK over the file", () => {
    setup([]);
    writeFileSync(join(fx.home, '.env'), 'LARK_APP_ID=cli_app\nMT_OWNER_OPEN_ID=ou_owner\nMT_ALLOW_TALK=ou_bob\n', { mode: 0o600 });
    const board = open();
    expect(board.peopleMissing).toBeUndefined();
    expect(assign(board, 'lark:on_bob')).toMatchObject({ ok: true });
    expect(assign(board, 'lark:on_alice')).toMatchObject({ ok: false, code: 'person_not_assignable' });
    expect(assign(open({ MT_ALLOW_TALK: 'ou_alice' }), 'lark:on_alice')).toMatchObject({ ok: true });
  });

  it('says which setting this shell lacks, the app id first, and still takes a role', () => {
    setup(['auth:', '  owner: ou_owner']);
    const noApp = open();
    expect(noApp.peopleMissing).toBe('appId');
    expect(assign(noApp, 'worker')).toMatchObject({ ok: false, code: 'unknown_role' });
    expect(assign(noApp, 'default')).toMatchObject({ ok: true });
    expect(assign(noApp, 'lark:on_alice')).toMatchObject({ ok: false, code: 'person_not_assignable', message: expect.stringMatching(/until the board is in Lark$/) });
    expect(open({ LARK_APP_ID: 'cli_app' }).peopleMissing).toBeUndefined();
    fx.cleanup();
    db.close();
    setup(['lark:', '  appId: cli_app']);
    expect(open().peopleMissing).toBe('owner');
    expect(open({ MT_OWNER_OPEN_ID: 'ou_owner' }).peopleMissing).toBeUndefined();
  });
});

describe('personHint', () => {
  it("adds to chat's words where to find a person's id, and leaves other refusals alone", () => {
    const talk = `"lark:on_bob" ${UNKNOWN_TALK}`;
    expect(personHint({ code: 'person_not_assignable', message: talk }, undefined)).toBe(
      `${talk}; mt kanban people lists the people this gateway knows, with their union_ids and whether they have talk tier`,
    );
    expect(personHint({ code: 'person_not_assignable', message: `ask: ${talk}` }, undefined)).toMatch(/^ask: "lark:on_bob" cannot be given work: .*; mt kanban people lists/);
    expect(personHint({ code: 'unknown_role', message: 'role "x" is not configured' }, undefined)).toBe('role "x" is not configured');
  });

  it('names what this shell lacks in place of "until the board is in Lark", never the hint', () => {
    const none = '"lark:on_bob" cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark';
    expect(personHint({ code: 'person_not_assignable', message: none }, 'appId')).toBe(
      '"lark:on_bob" cannot be checked for talk tier here: this shell finds no lark.appId or LARK_APP_ID, which the people this bot has seen are kept by',
    );
    expect(personHint({ code: 'person_not_assignable', message: `a: ${none}` }, 'owner')).toBe(
      'a: "lark:on_bob" cannot be checked for talk tier here: this shell finds no auth.owner or MT_OWNER_OPEN_ID, without which there is no talk allowlist to check against',
    );
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-board-people.test.ts`. Expected: `Tests  5 failed (5)`; among the failures, `AssertionError: expected undefined to be 'appId' // Object.is equality` and `TypeError: (0 , personHint) is not a function`.

- [ ] **Step 4.3: Implement.**

In `src/cli/gate.ts`, replace:

```ts
import { openDb } from '../db/open.js';
```

with:

```ts
import { openDb } from '../db/open.js';
import { PeopleDirectory } from '../kanban/people.js';
```

In `src/cli/gate.ts`, replace:

```ts
export interface BoardAccess {
  service: KanbanService;
  /** The gateway's home, where its socket is (spec §7.2). */
  home: string;
  /** `kanban.enabled` as the config sets it, undefined when it does not: the board runs only when it is true. */
  kanbanEnabled: boolean | undefined;
  close(): void;
```

with:

```ts
/**
 * What this shell's settings lack for the terminal to check a person's talk
 * tier (kanban spec §22.2): the bot's app id, by which `people` keeps who it has
 * seen, or an owner, without which there is no talk allowlist.
 */
export type PeopleMissing = 'appId' | 'owner';

export interface BoardAccess {
  service: KanbanService;
  /** The gateway's home, where its socket is (spec §7.2). */
  home: string;
  /** `kanban.enabled` as the config sets it, undefined when it does not: the board runs only when it is true. */
  kanbanEnabled: boolean | undefined;
  /** Why the service has no people, so a person cannot be checked here; undefined when it has them. */
  peopleMissing: PeopleMissing | undefined;
  close(): void;
}

/** What `assignable` says of a person when the service has no talk check: right for a board not in Lark, wrong beside a gateway that is. */
const NO_PEOPLE = 'cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark';

/** What the terminal says in its place, naming the setting this shell lacks. */
const MISSING: Readonly<Record<PeopleMissing, string>> = {
  appId: 'cannot be checked for talk tier here: this shell finds no lark.appId or LARK_APP_ID, which the people this bot has seen are kept by',
  owner: 'cannot be checked for talk tier here: this shell finds no auth.owner or MT_OWNER_OPEN_ID, without which there is no talk allowlist to check against',
};

/** How a terminal finds a person's id, added to chat's words for a person it refused (kanban spec §22.2). */
export const PEOPLE_HINT = 'mt kanban people lists the people this gateway knows, with their union_ids and whether they have talk tier';

/**
 * A refusal's message as the terminal says it: for a person the service could
 * not check, the setting this shell lacks; for one it refused, chat's words and
 * how to find a person's id. Any other refusal as it is.
 */
export function personHint(r: { code: string; message: string }, missing: PeopleMissing | undefined): string {
  if (r.code !== 'person_not_assignable') return r.message;
  if (missing !== undefined && r.message.includes(NO_PEOPLE)) return r.message.replace(NO_PEOPLE, MISSING[missing]);
  return `${r.message}; ${PEOPLE_HINT}`;
```

In `src/cli/gate.ts`, replace:

```ts
  }
  // As the gateway builds its own: a supervised role's approvals go to the chat that follows its task (spec §7.1).
```

with:

```ts
  }
  // Chat's own check of a person, against the same table (kanban spec §22.2): the people this bot has
  // seen, and the talk allowlist this shell's settings give, as the gateway's authorizer holds it.
  const { appId, talk } = settings;
  const peopleMissing: PeopleMissing | undefined = appId === undefined ? 'appId' : talk === undefined ? 'owner' : undefined;
  const people =
    appId === undefined || talk === undefined ? undefined : new PeopleDirectory({ db, appId, canTalk: (openId) => talk.includes(openId) });
  // As the gateway builds its own: a supervised role's approvals go to the chat that follows its task (spec §7.1).
```

In `src/cli/gate.ts`, replace:

```ts
  });
  return { service, home: settings.home, kanbanEnabled: settings.kanbanEnabled, close: () => db.close() };
```

with:

```ts
    ...(people === undefined ? {} : { people }),
  });
  return { service, home: settings.home, kanbanEnabled: settings.kanbanEnabled, peopleMissing, close: () => db.close() };
```

- [ ] **Step 4.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2497 passed (2497)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.5: Commit.**

```bash
git add src/cli/gate.ts tests/mt-board-people.test.ts
git commit -m "Give the terminal's board chat's people directory over the database it opened, with this bot's app id and the talk list the settings give, and say which setting a shell lacks when it cannot check a person"
```

---

### Task 5: A person at the terminal

**Files:**

- Create: `tests/mt-terminal-people.test.ts`
- Modify: `src/cli/operator.ts`, `src/kanban/dag.ts`, `src/kanban/service.ts`, `src/kanban/task-checks.ts`, `src/kanban/workflow.ts`, `tests/kanban-dag.test.ts`, `tests/kanban-workflow-expand.test.ts`, `tests/kanban-workflow-service.test.ts`, `tests/mt-kanban-operator-tasks.test.ts`, `tests/mt-kanban-workflow.test.ts`

§22.2, workflows §18.3. The front's `personRefused` goes: `task new` and `task assign` pass a person to the service, which checks it with `assignable` against Task 4's people, and `act` says a refusal through `personHint`. `checkDagTasks` drops its rule that refused every person from the operator, and refuses an `@` name there instead. `paramValues` and `expand` take the start's `createdVia` kind: the operator's `@` gets `NO_MENTIONS`, `invalid`; a run's keeps its `person_not_assignable`. The preview's facts alone take any person (`canTalk: () => true`), and it says on stderr, for each person in its DAG, that the start checks them. The tests that held the old refusals change with it.

- [ ] **Step 5.1: Write the tests.**

In `tests/kanban-dag.test.ts`, replace:

```ts
  it('refuses any person at the terminal', () => {
    expect(problem(tiny({ assignee: 'lark:on_bob' }), { createdVia: { kind: 'operator' }, createdBy: 'operator:me' })).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: 'a: "lark:on_bob" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
```

with:

```ts
  it('checks a person at the terminal as anywhere, and refuses an @-mention there', () => {
    const terminal = { createdVia: { kind: 'operator' }, createdBy: 'operator:me' } as const;
    expect(problem(tiny({ assignee: 'lark:on_bob' }), terminal)).toBeUndefined();
    expect(problem(tiny({ reviewer: 'lark:on_carol' }), terminal)).toMatchObject({ ok: false, code: 'person_not_assignable', message: expect.stringMatching(/^a: "lark:on_carol" cannot be given work: /) });
    expect(problem(tiny({ assignee: '@Bob' }), terminal)).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a: there are no @-mentions at the terminal: a person is lark:<union_id>, which mt kanban people lists',
```

In `tests/kanban-workflow-expand.test.ts`, replace:

```ts
  it('refuses an @Name in a person field with no mentions to resolve it by, at the terminal or from a run, and keeps one in text', () => {
    const w = workflow('params:\n  owner: { required: true }\n  note: { default: x }\nsteps:\n  a: { title: "Ask {{note}}", assignee: "{{owner}}" }\n');
    for (const given of [terminal(['owner', '@Alice Smith']), json({ owner: '@Alice Smith' })]) {
      expect(refusal(expand(w, given, 'default'))).toEqual({
        code: 'person_not_assignable',
        message: '"@Alice Smith" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
```

with:

```ts
  it('refuses an @Name in a person field with no mentions to resolve it by, as the start came, and keeps one in text', () => {
    const w = workflow('params:\n  owner: { required: true }\n  note: { default: x }\nsteps:\n  a: { title: "Ask {{note}}", assignee: "{{owner}}" }\n');
    // A run's start keeps its refusal: an agent has no mt kanban people.
    for (const given of [terminal(['owner', '@Alice Smith']), json({ owner: '@Alice Smith' })]) {
      expect(refusal(expand(w, given, 'default', undefined, 'run'))).toEqual({
        code: 'person_not_assignable',
        message: '"@Alice Smith" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
      });
      // The terminal's: there are no mentions there, and a person is lark:<union_id>.
      expect(refusal(expand(w, given, 'default', undefined, 'operator'))).toEqual({
        code: 'invalid',
        message: 'there are no @-mentions at the terminal: a person is lark:<union_id>, which mt kanban people lists',
```

In `tests/kanban-workflow-service.test.ts`, replace:

```ts
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
```

with:

```ts
  it('checks a person at the terminal as from chat: taken with talk tier, refused without', () => {
    const owned = 'params:\n  owner: { required: true }\nsteps:\n  a: { title: A, assignee: "{{owner}}" }\n';
    writeFileSync(join(dir, 'owned.yaml'), owned);
    const params = { from: 'json', params: { owner: BOB } } as const;
    expect(made(start({ workflow: 'owned', params, createdVia: OPERATOR, createdBy: 'operator:me' })).tasks[0]?.task.assignee).toEqual({ kind: 'human', name: BOB });
    expect(made(start({ workflow: 'owned', params })).tasks[0]?.task.assignee).toEqual({ kind: 'human', name: BOB });
    talks.clear();
    for (const via of [{}, { createdVia: OPERATOR, createdBy: 'operator:me' }]) {
      expect(start({ workflow: 'owned', params, ...via })).toMatchObject({ ok: false, code: 'person_not_assignable', message: expect.stringMatching(/^a: "lark:on_bob" cannot be given work: being assigned/) });
    }
```

In `tests/mt-kanban-operator-tasks.test.ts`, replace:

```ts
  it("refuses what chat refuses: a person, an unknown role, an archived board, a task over chat's limits", async () => {
    expect(await mt(['task', 'new', 'x', '--assignee', 'lark:on_bob'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: "lark:on_bob" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
    });
    expect(await mt(['task', 'new', 'x', '--reviewer', '@Bob'])).toMatchObject({ code: 1 });
```

with:

```ts
  it("refuses what chat refuses: a person it cannot check, an unknown role, an archived board, a task over chat's limits", async () => {
    expect(await mt(['task', 'new', 'x', '--assignee', 'lark:on_bob'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: "lark:on_bob" cannot be checked for talk tier here: this shell finds no lark.appId or LARK_APP_ID, which the people this bot has seen are kept by',
    });
    expect(await mt(['task', 'new', 'x', '--reviewer', '@Bob'])).toMatchObject({ code: 1, err: 'mt: there are no @-mentions at the terminal: a person is lark:<union_id>, which mt kanban people lists' });
```

In `tests/mt-kanban-workflow.test.ts`, replace:

```ts
  it('writes a refusal on stderr and nothing on stdout, and refuses a person as at the terminal', async () => {
    expect(await mt(['preview', 'vendor-eval', '--param', 'topic=x', '--json'])).toEqual({ code: 1, out: '', err: 'mt: workflow vendor-eval needs param vendors' });
    writeFileSync(join(f.home, 'workflows', 'ask.yaml'), 'params:\n  owner: { required: true }\nsteps:\n  ask: { title: Ask, assignee: "{{owner}}" }\n');
    expect((await mt(['preview', 'ask', '--param', 'owner=lark:on_bob'])).err).toBe(
      'mt: ask: "lark:on_bob" is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier',
```

with:

```ts
  it('writes a refusal on stderr and nothing on stdout, and leaves a person to the start, saying so', async () => {
    expect(await mt(['preview', 'vendor-eval', '--param', 'topic=x', '--json'])).toEqual({ code: 1, out: '', err: 'mt: workflow vendor-eval needs param vendors' });
    writeFileSync(join(f.home, 'workflows', 'ask.yaml'), 'params:\n  owner: { required: true }\nsteps:\n  ask: { title: Ask, assignee: "{{owner}}" }\n');
    expect((await mt(['preview', 'ask', '--param', 'owner=lark:on_bob'])).err).toBe(
      'mt: lark:on_bob is checked at the start, against the people this gateway knows; mt kanban workflow apply --dry-run checks it now',
```

Create `tests/mt-terminal-people.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * A person from the terminal (kanban spec §22.2, workflows spec §18.3):
 * `lark:<union_id>` taken by `task new`, `task assign`, a workflow's params and
 * an applied DAG, checked as chat checks one, refused in chat's words with how
 * to find ids; no @-mentions; and the preview leaving people to the start.
 */

let fx: MtFixture;
let db: Db;
let server: WorkerServer | undefined;

afterEach(async () => {
  clearSecrets();
  await server?.close();
  server = undefined;
  db?.close();
  fx?.cleanup();
});

/** A home with the config lines given, the board on and a gateway taking nudges, Alice and Bob seen by this bot, Alice at talk tier. */
async function setup(lines: string[] = ['lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', '  talk: [ou_alice]']): Promise<void> {
  clearSecrets();
  fx = mtFixture((ws) =>
    [`workspace: ${ws}`, ...lines, 'kanban:', '  enabled: true', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
  );
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  notePerson(db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice', name: 'Alice Chen' }, 1);
  notePerson(db, { appId: 'cli_app', unionId: 'on_bob', openId: 'ou_bob', name: 'Bob Li' }, 1);
  mkdirSync(join(fx.home, 'workflows'));
  writeFileSync(
    join(fx.home, 'workflows', 'ask.yaml'),
    'params:\n  owner: { required: true }\n  note: { default: x }\nsteps:\n  ask: { title: "Ask {{note}}", assignee: "{{owner}}" }\n',
  );
  server = await listenWorker(workerSocketPath(fx.home), () => ({ ok: true }));
}

const kanban = (argv: string[], env: Record<string, string | undefined> = {}) => fx.run(['kanban', ...argv], { env });

const TALK =
  'cannot be given work: being assigned lets a person report on the task, which needs talk tier, and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it';
const HINT = 'mt kanban people lists the people this gateway knows, with their union_ids and whether they have talk tier';
const NO_MENTIONS = 'there are no @-mentions at the terminal: a person is lark:<union_id>, which mt kanban people lists';

describe('a person at task new and task assign', () => {
  it('takes a person known with talk tier, and refuses one unknown or without it in chat\'s words, with the hint', async () => {
    await setup();
    const made = await kanban(['task', 'new', 'Book the venue', '--assignee', 'lark:on_alice', '--reviewer', 'lark:on_alice', '--json']);
    expect(made.code, made.err).toBe(0);
    const id = JSON.parse(made.out).task_id as string;
    expect(getTask(db, id)).toMatchObject({ assignee: { kind: 'human', name: 'lark:on_alice' }, reviewer: { kind: 'human', name: 'lark:on_alice' } });
    expect((await kanban(['task', 'new', 'Book the venue', '--assignee', 'lark:on_alice'])).out).toMatch(/^created k_[0-9a-z]+: Book the venue, for lark:on_alice, on board default$/);
    for (const who of ['lark:on_bob', 'lark:on_carol']) {
      expect(await kanban(['task', 'new', 'x', '--assignee', who])).toEqual({ code: 1, out: '', err: `mt: "${who}" ${TALK}; ${HINT}` });
    }
    expect(JSON.parse((await kanban(['task', 'new', 'x', '--reviewer', 'lark:on_bob', '--json'])).out)).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: `"lark:on_bob" ${TALK}; ${HINT}`,
    });
  });

  it('counts an owner only the .env holds', async () => {
    await setup(['lark:', '  appId: cli_app']);
    expect((await kanban(['task', 'new', 'x', '--assignee', 'lark:on_alice'])).err).toMatch(/this shell finds no auth\.owner or MT_OWNER_OPEN_ID/);
    writeFileSync(join(fx.home, '.env'), 'MT_OWNER_OPEN_ID=ou_owner\nMT_ALLOW_TALK=ou_alice\n', { mode: 0o600 });
    expect((await kanban(['task', 'new', 'x', '--assignee', 'lark:on_alice'])).code).toBe(0);
  });

  it('names the setting this shell lacks, never "until the board is in Lark"', async () => {
    await setup(['auth:', '  owner: ou_owner', '  talk: [ou_alice]']);
    expect(await kanban(['task', 'new', 'x', '--assignee', 'lark:on_alice'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: "lark:on_alice" cannot be checked for talk tier here: this shell finds no lark.appId or LARK_APP_ID, which the people this bot has seen are kept by',
    });
    const owner = await kanban(['task', 'new', 'x', '--assignee', 'lark:on_alice'], { MT_OWNER_OPEN_ID: undefined, LARK_APP_ID: 'cli_app' });
    expect(owner.code).toBe(0);
    fx.cleanup();
    db.close();
    await server?.close();
    await setup(['lark:', '  appId: cli_app']);
    const r = await kanban(['task', 'new', 'x', '--assignee', 'lark:on_alice', '--json']);
    expect(JSON.parse(r.out)).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: '"lark:on_alice" cannot be checked for talk tier here: this shell finds no auth.owner or MT_OWNER_OPEN_ID, without which there is no talk allowlist to check against',
    });
    expect(r.out).not.toMatch(/until the board is in Lark/);
  });

  it('refuses an @-mention with its hint, as there are none at the terminal', async () => {
    await setup();
    for (const flag of ['--assignee', '--reviewer']) {
      expect(await kanban(['task', 'new', 'x', flag, '@Alice'])).toEqual({ code: 1, out: '', err: `mt: ${NO_MENTIONS}` });
    }
    const task = JSON.parse((await kanban(['task', 'new', 'x', '--assignee', 'default', '--json'])).out).task_id as string;
    expect(JSON.parse((await kanban(['task', 'assign', task, '@Alice Chen', '--json'])).out)).toEqual({ ok: false, code: 'invalid', message: NO_MENTIONS });
  });

  it('assigns a task to a person with talk tier, and refuses one without in the same words', async () => {
    await setup();
    const task = JSON.parse((await kanban(['task', 'new', 'x', '--assignee', 'default', '--json'])).out).task_id as string;
    expect(await kanban(['task', 'assign', task, 'lark:on_alice'])).toMatchObject({ code: 0, out: `${task} is now for lark:on_alice` });
    expect(getTask(db, task)?.assignee).toEqual({ kind: 'human', name: 'lark:on_alice' });
    expect(await kanban(['task', 'assign', task, 'lark:on_bob'])).toEqual({ code: 1, out: '', err: `mt: "lark:on_bob" ${TALK}; ${HINT}` });
    const usage = await kanban(['task', 'assign', task]);
    expect(usage.code).toBe(2);
    expect(usage.err.split('\n')[0]).toBe('mt: kanban task assign takes a task id, and a role or a person, lark:<union_id>');
  });
});

describe('a person in a workflow at the terminal', () => {
  it('takes one in a param with talk tier, and refuses one without, naming the ref, with the hint', async () => {
    await setup();
    const r = await kanban(['workflow', 'start', 'ask', '--param', 'owner=lark:on_alice', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(getTask(db, JSON.parse(r.out).tasks[0].task_id)?.assignee).toEqual({ kind: 'human', name: 'lark:on_alice' });
    expect(await kanban(['workflow', 'start', 'ask', '--param', 'owner=lark:on_bob'])).toEqual({ code: 1, out: '', err: `mt: ask: "lark:on_bob" ${TALK}; ${HINT}` });
  });

  it("refuses @ in a person field at the terminal, with the hint, and keeps it in a text field", async () => {
    await setup();
    expect(await kanban(['workflow', 'start', 'ask', '--param', 'owner=@Alice Chen'])).toEqual({ code: 1, out: '', err: `mt: ${NO_MENTIONS}` });
    const kept = await kanban(['workflow', 'start', 'ask', '--param', 'owner=default', '--param', 'note=@Bob', '--json']);
    expect(getTask(db, JSON.parse(kept.out).tasks[0].task_id)?.title).toBe('Ask @Bob');
  });

  it('checks a DAG\'s person at apply and apply --dry-run, and refuses an @ there', async () => {
    await setup();
    const dag = (assignee: string) => {
      const path = join(fx.root, `dag-${assignee.replace(/\W/g, '')}.json`);
      writeFileSync(path, JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'Ask', assignee }] }));
      return path;
    };
    expect(await kanban(['workflow', 'apply', dag('lark:on_bob'), '--dry-run'])).toEqual({ code: 1, out: '', err: `mt: a: "lark:on_bob" ${TALK}; ${HINT}` });
    expect((await kanban(['workflow', 'apply', dag('lark:on_alice'), '--dry-run'])).code).toBe(0);
    expect((await kanban(['workflow', 'apply', dag('lark:on_alice')])).code).toBe(0);
    expect(await kanban(['workflow', 'apply', dag('@Alice')])).toEqual({ code: 1, out: '', err: `mt: a: ${NO_MENTIONS}` });
  });

  it('previews a person unchecked, saying on stderr that the start checks it', async () => {
    await setup(['auth:', '  owner: ou_owner']);
    const r = await kanban(['workflow', 'preview', 'ask', '--param', 'owner=lark:on_bob']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ask would make 1 task, on board default:\n {2}ask {2}Ask x {2}lark:on_bob/);
    expect(r.err).toBe('mt: lark:on_bob is checked at the start, against the people this gateway knows; mt kanban workflow apply --dry-run checks it now');
    const json = await kanban(['workflow', 'preview', 'ask', '--param', 'owner=lark:on_bob', '--json']);
    expect(JSON.parse(json.out).tasks[0].assignee).toBe('lark:on_bob');
    expect(json.err).toBe(r.err);
    expect(await kanban(['workflow', 'preview', 'ask', '--param', 'owner=@Bob'])).toEqual({ code: 1, out: '', err: `mt: ${NO_MENTIONS}` });
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-dag.test.ts tests/kanban-workflow-expand.test.ts tests/kanban-workflow-service.test.ts tests/mt-kanban-operator-tasks.test.ts tests/mt-kanban-workflow.test.ts tests/mt-terminal-people.test.ts`. Expected: `Tests  14 failed | 106 passed (120)`; among the failures, `AssertionError: expected { code: 'person_not_assignable', …(1) } to deeply equal { code: 'invalid', …(1) }`.

- [ ] **Step 5.3: Implement.**

In `src/cli/operator.ts`, replace:

```ts
import { boardSetting, isPerson, LIST_FILTERS, tooBig, type NewTaskCommand } from '../kanban/chat-parse.js';
import { DAG_LIMITS, checkDagShape, checkDagTasks, dagFile } from '../kanban/dag.js';
import { WORKFLOW_MESSAGE_BYTES, type KanbanService, type WorkflowMade } from '../kanban/service.js';
import { expand, listWorkflows, paramsLine, readWorkflow, usableMessage } from '../kanban/workflow.js';
import { maskAll, NUDGE, workerSocketPath } from '../kanban/socket.js';
import { DEFAULT_BOARD, type BoardRow, type Contract, type Refusal, type Waiting } from '../kanban/types.js';
import { WORKER_LIMITS } from '../kanban/limits.js';
import { visible } from '../names.js';
import { parse, UsageError } from './args.js';
import { loadOperator, operatorName, withBoard } from './gate.js';
```

with:

```ts
import { boardSetting, LIST_FILTERS, tooBig, type NewTaskCommand } from '../kanban/chat-parse.js';
import { DAG_LIMITS, checkDagShape, checkDagTasks, dagFile } from '../kanban/dag.js';
import { NO_MENTIONS } from '../kanban/task-checks.js';
import { WORKFLOW_MESSAGE_BYTES, type KanbanService, type WorkflowMade } from '../kanban/service.js';
import { expand, listWorkflows, paramsLine, readWorkflow, usableMessage } from '../kanban/workflow.js';
import { maskAll, NUDGE, workerSocketPath } from '../kanban/socket.js';
import { DEFAULT_BOARD, type BoardRow, type Contract, type Refusal, type Waiting } from '../kanban/types.js';
import { WORKER_LIMITS } from '../kanban/limits.js';
import { visible } from '../names.js';
import { parse, UsageError } from './args.js';
import { loadOperator, operatorName, personHint, withBoard, type PeopleMissing } from './gate.js';
```

In `src/cli/operator.ts`, replace:

```ts
  const code = withBoard(
    io,
    what,
    (board) => {
      home = board.home;
      enabled = board.kanbanEnabled;
      outcome = fn(board.service, operatorName(io));
      return 0;
    },
    { refuse: no, unsetNote: 'those values are not masked here', ...(opts.workflows === true ? { workflows: true } : {}) },
  );
  if (outcome === undefined) return code;
  if (!outcome.ok) return no(outcome.code, outcome.message);
```

with:

```ts
  let missing: PeopleMissing | undefined;
  const code = withBoard(
    io,
    what,
    (board) => {
      home = board.home;
      enabled = board.kanbanEnabled;
      missing = board.peopleMissing;
      outcome = fn(board.service, operatorName(io));
      return 0;
    },
    { refuse: no, unsetNote: 'those values are not masked here', ...(opts.workflows === true ? { workflows: true } : {}) },
  );
  if (outcome === undefined) return code;
  // A person refused in chat's words, with how a terminal finds ids; or what this shell lacks to check one (kanban spec §22.2).
  if (!outcome.ok) return no(outcome.code, personHint(outcome, missing));
```

In `src/cli/operator.ts`, replace:

```ts
 * A person is given work from chat, by @-mention, where the gateway can check
 * they have talk tier (spec §4.2): a terminal has no allowlist to check against.
 */
function personRefused(name: string): Outcome | undefined {
  if (!isPerson(name)) return undefined;
  return refused({
    code: 'person_not_assignable',
    message: `${JSON.stringify(name)} is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier`,
  });
```

with:

```ts
 * A name starting with `@` where a person may go (kanban spec §22.2): a mention
 * is resolved from the message Lark delivers, which a terminal has not got. A
 * person is `lark:<union_id>`, checked by the service as chat checks one.
 */
function mentionRefused(name: string): Outcome | undefined {
  return name.startsWith('@') ? refused({ code: 'invalid', message: NO_MENTIONS }) : undefined;
```

In `src/cli/operator.ts`, replace:

```ts
      const person = name === undefined ? undefined : personRefused(name);
      if (person !== undefined) return person;
```

with:

```ts
      const mention = name === undefined ? undefined : mentionRefused(name);
      if (mention !== undefined) return mention;
```

In `src/cli/operator.ts`, replace:

```ts
/** `mt kanban task assign <task> <role>`: an undecided run ends `superseded`, and the gateway's pass cancels its turn. */
function assign(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [taskId, role, extra] = positionals;
  const name = role?.trim();
  if (taskId === undefined || name === undefined || name === '' || extra !== undefined) {
    throw new UsageError('kanban task assign takes a task id and a role');
  }
  const board = boardFlag(values.board);
  return act(io, values.json === true, 'mt kanban task assign', (service, by) => {
    const person = personRefused(name);
    if (person !== undefined) return person;
```

with:

```ts
/**
 * `mt kanban task assign <task> <role|lark:<union_id>>`: an undecided run ends `superseded`, and the gateway's
 * pass cancels its turn. A person is checked as `task new` checks one (kanban spec §22.2).
 */
function assign(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [taskId, role, extra] = positionals;
  const name = role?.trim();
  if (taskId === undefined || name === undefined || name === '' || extra !== undefined) {
    throw new UsageError('kanban task assign takes a task id, and a role or a person, lark:<union_id>');
  }
  const board = boardFlag(values.board);
  return act(io, values.json === true, 'mt kanban task assign', (service, by) => {
    const mention = mentionRefused(name);
    if (mention !== undefined) return mention;
```

In `src/cli/operator.ts`, replace:

```ts
 * a start makes but the board's, the people's and the key's, a person refused as
 * at the terminal. `--json` writes the DAG file alone on stdout; a refusal goes
 * to stderr, so it never leaves half a file.
```

with:

```ts
 * a start makes but the board's, the people's and the key's. A person in the
 * grammar passes, as `people` is in the database, and is said on stderr to be
 * checked at the start (§18.3). `--json` writes the DAG file alone on stdout; a
 * refusal goes to stderr, so it never leaves half a file.
```

In `src/cli/operator.ts`, replace:

```ts
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
```

with:

```ts
  // As openBoard's service judges a task, supervised roles accepted; the preview's facts alone take every person,
  // whom a start and an apply check against the database (workflows spec §18.3).
  const facts = { roles: team.roles, workspaces: new Set(team.workspaces.keys()), supervisedRoles: true };
  const anyone = { ...facts, canTalk: () => true };
  const dir = join(settings.home, 'workflows');
  const read = readWorkflow(dir, name, facts);
  if (!read.ok) {
    return no(read.code, read.code === 'unknown_workflow' ? usableMessage(read.message, listWorkflows(dir, facts).usable, WORKFLOW_MESSAGE_BYTES) : read.message);
  }
  const expanded = expand(read.workflow, { from: 'terminal', pairs }, boardName, undefined, 'operator');
  if (!expanded.ok) return no(expanded.code, expanded.message);
  const shaped = checkDagShape(expanded.dag, 'expansion');
  if (!shaped.ok) return no(shaped.code, shaped.message);
  const refused = checkDagTasks(shaped.dag, { facts: anyone, createdBy: operatorName(io), createdVia: { kind: 'operator' } });
  if (refused !== undefined) return no(refused.code, refused.message);
  const people = new Set(shaped.dag.tasks.flatMap((t) => [t.assignee, t.reviewer]).filter((v): v is string => v !== null && v.includes(':')));
  for (const person of people) {
    io.err(`mt: ${line(person, 200)} is checked at the start, against the people this gateway knows; mt kanban workflow apply --dry-run checks it now`);
  }
```

In `src/kanban/dag.ts`, replace:

```ts
import { checkTask, isRecord, type TaskFacts } from './task-checks.js';
```

with:

```ts
import { checkTask, isRecord, NO_MENTIONS, type TaskFacts } from './task-checks.js';
```

In `src/kanban/dag.ts`, replace:

```ts
 * naming the task. A person is checked by `facts.canTalk`; at the terminal,
 * which has no talk check, any person is refused.
```

with:

```ts
 * naming the task. A person is checked by `facts.canTalk`, at the terminal as
 * elsewhere; an @-mention there is refused, as no message carries it.
```

In `src/kanban/dag.ts`, replace:

```ts
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
```

with:

```ts
    // A person is checked as chat checks one, by `facts.canTalk`, wherever the DAG comes from (kanban spec §22.2);
    // at the terminal, an @-mention has no message to be resolved from.
    if (terminal && [t.assignee, t.reviewer].some((v) => v?.startsWith('@') === true)) return no('invalid', NO_MENTIONS);
```

In `src/kanban/service.ts`, replace:

```ts
    const expanded = expand(read.workflow, req.params, onBoard, req.personOf);
```

with:

```ts
    // The start's kind, for an `@` with no mention to resolve it by: the terminal's refusal, or a run's (workflows spec §18.3).
    const expanded = expand(read.workflow, req.params, onBoard, req.personOf, req.createdVia?.kind);
```

In `src/kanban/task-checks.ts`, replace:

```ts
const PERSON = /^lark:[A-Za-z0-9_-]+$/;
```

with:

```ts
const PERSON = /^lark:[A-Za-z0-9_-]+$/;

/**
 * What the terminal says of a name starting with `@` where a person may go
 * (kanban spec §22.2): a mention is resolved from the message Lark delivers,
 * which a terminal has not got.
 */
export const NO_MENTIONS = 'there are no @-mentions at the terminal: a person is lark:<union_id>, which mt kanban people lists';
```

In `src/kanban/workflow.ts`, replace:

```ts
import { assignable, isRecord, type TaskFacts } from './task-checks.js';
import { GATE_LIMITS, type Contract, type Phase, type Refusal, type Result, type RetryOnCrash } from './types.js';
```

with:

```ts
import { assignable, isRecord, NO_MENTIONS, type TaskFacts } from './task-checks.js';
import { GATE_LIMITS, type Contract, type CreatedVia, type Phase, type Refusal, type Result, type RetryOnCrash } from './types.js';
```

In `src/kanban/workflow.ts`, replace:

```ts
 */
export function paramValues(w: Workflow, given: GivenParams, personOf?: PersonOf): Result<{ values: Map<string, ParamValue> }> {
```

with:

```ts
 * With no `personOf`, an `@` in a person field is refused as the start's
 * `via` is told: at the terminal, that it has no mentions (kanban spec §22.2);
 * from a run, that a person is given work from chat.
 */
export function paramValues(w: Workflow, given: GivenParams, personOf?: PersonOf, via?: CreatedVia['kind']): Result<{ values: Map<string, ParamValue> }> {
```

In `src/kanban/workflow.ts`, replace:

```ts
      const at = texts.find((t) => t.startsWith('@'));
```

with:

```ts
      const at = texts.find((t) => t.startsWith('@'));
      if (at !== undefined && via === 'operator') return refuse('invalid', NO_MENTIONS);
```

In `src/kanban/workflow.ts`, replace:

```ts
export function expand(w: Workflow, given: GivenParams, board: string, personOf?: PersonOf): Result<{ dag: Dag }> {
  const params = paramValues(w, given, personOf);
```

with:

```ts
export function expand(w: Workflow, given: GivenParams, board: string, personOf?: PersonOf, via?: CreatedVia['kind']): Result<{ dag: Dag }> {
  const params = paramValues(w, given, personOf, via);
```

- [ ] **Step 5.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2506 passed (2506)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add src/cli/operator.ts src/kanban/dag.ts src/kanban/service.ts src/kanban/task-checks.ts src/kanban/workflow.ts tests/kanban-dag.test.ts tests/kanban-workflow-expand.test.ts tests/kanban-workflow-service.test.ts tests/mt-kanban-operator-tasks.test.ts tests/mt-kanban-workflow.test.ts tests/mt-terminal-people.test.ts
git commit -m "Take a person by lark:<union_id> at the terminal's task new, task assign, workflow params and applied DAGs, checked as chat checks one and refused in chat's words with how to find ids; refuse @-mentions there, keep a run's refusal, and leave people to the start in a preview"
```

---

### Task 6: `mt kanban people`

**Files:**

- Create: `tests/mt-kanban-people.test.ts`
- Modify: `src/cli/gate.ts`, `src/cli/mt.ts`, `src/cli/operator.ts`, `src/cli/plain.ts`, `src/db/people.ts`

§22.2, §22.5. A read, `peopleOf(db, appId)`, by name and then union_id, those with no name last; `BoardAccess.seen()` gives each with talk tier by this shell's allowlist; `act`'s function is given the `BoardAccess`; the command is a group of its own in `OPERATOR_GROUPS`, so an agent's shell refuses it before it reads anything, and `USAGE` names it.

- [ ] **Step 6.1: Write the tests.**

Create `tests/mt-kanban-people.test.ts`:

```ts
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson, peopleOf } from '../src/db/people.js';
import { addSecrets, clearSecrets, MASK } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `mt kanban people` (kanban spec §22.2): the people this bot has seen, one a
 * line, sorted by name and then union_id, with the name masked and stripped,
 * the principal, and talk tier by the open_id last seen; `--json`; refused in an
 * agent's shell, and with no app id, no bot to list for.
 */

let fx: MtFixture;
let db: Db;

afterEach(() => {
  clearSecrets();
  db?.close();
  fx?.cleanup();
});

function setup(lines: string[] = ['lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', '  talk: [ou_bob]']): void {
  clearSecrets();
  fx = mtFixture((ws) => [`workspace: ${ws}`, ...lines, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  const seen: Array<[string, string, string | null]> = [
    ['on_zed', 'ou_zed', 'Bob Li'],
    ['on_bob', 'ou_bob', 'Bob Li'],
    ['on_ann', 'ou_ann', 'Ann\u202E Wu'],
    ['on_quiet', 'ou_quiet', null],
    ['on_owner', 'ou_owner', 'Owner sk-live-1234567890'],
  ];
  for (const [unionId, openId, name] of seen) notePerson(db, { appId: 'cli_app', unionId, openId, name }, 1);
  notePerson(db, { appId: 'cli_other', unionId: 'on_else', openId: 'ou_bob', name: 'Elsewhere' }, 1);
}

describe('peopleOf', () => {
  it("gives this bot's people, by name and then union_id, those with no name last", () => {
    setup();
    expect(peopleOf(db, 'cli_app').map((p) => p.unionId)).toEqual(['on_ann', 'on_bob', 'on_zed', 'on_owner', 'on_quiet']);
    expect(peopleOf(db, 'cli_other').map((p) => p.unionId)).toEqual(['on_else']);
    expect(peopleOf(db, 'cli_none')).toEqual([]);
  });
});

describe('mt kanban people', () => {
  it('lists them, masked and stripped, with the principal and talk or no', async () => {
    setup();
    addSecrets(['sk-live-1234567890']);
    const r = await fx.run(['kanban', 'people']);
    expect(r).toEqual({
      code: 0,
      out: [
        'name        person         talk',
        'Ann Wu      lark:on_ann    no',
        'Bob Li      lark:on_bob    talk',
        'Bob Li      lark:on_zed    no',
        `Owner ${MASK}  lark:on_owner  talk`,
        '(no name)   lark:on_quiet  no',
      ].join('\n'),
      err: '',
    });
  });

  it('gives --json', async () => {
    setup();
    const r = await fx.run(['kanban', 'people', '--json']);
    expect(JSON.parse(r.out)).toEqual({
      ok: true,
      people: [
        { principal: 'lark:on_ann', union_id: 'on_ann', name: 'Ann\u202E Wu', talk: false },
        { principal: 'lark:on_bob', union_id: 'on_bob', name: 'Bob Li', talk: true },
        { principal: 'lark:on_zed', union_id: 'on_zed', name: 'Bob Li', talk: false },
        { principal: 'lark:on_owner', union_id: 'on_owner', name: 'Owner sk-live-1234567890', talk: true },
        { principal: 'lark:on_quiet', union_id: 'on_quiet', name: null, talk: false },
      ],
    });
    expect(r.out).toContain('Ann\\u202e Wu');
  });

  it('says there is no bot to list for without an app id, and nobody has talk tier without an owner', async () => {
    setup(['auth:', '  owner: ou_owner']);
    expect(await fx.run(['kanban', 'people'])).toEqual({ code: 1, out: '', err: 'mt: there is no bot to list people for: this shell finds no lark.appId or LARK_APP_ID' });
    expect(JSON.parse((await fx.run(['kanban', 'people', '--json'])).out)).toMatchObject({ ok: false, code: 'no_bot' });
    const noOwner = await fx.run(['kanban', 'people'], { env: { LARK_APP_ID: 'cli_app', MT_OWNER_OPEN_ID: undefined } });
    expect(noOwner.code).toBe(0);
    fx.cleanup();
    db.close();
    setup(['lark:', '  appId: cli_app']);
    const r = await fx.run(['kanban', 'people']);
    expect(r.out.split('\n').slice(1).every((l) => l.endsWith(' no'))).toBe(true);
    expect(r.err).toBe('mt: this shell finds no auth.owner or MT_OWNER_OPEN_ID, so nobody is shown with talk tier');
  });

  it('says so when nobody is known, takes no arguments, and is refused in an agent\'s shell', async () => {
    setup();
    db.prepare('DELETE FROM people').run();
    expect(await fx.run(['kanban', 'people'])).toEqual({ code: 0, out: 'no people yet: the gateway learns a person once they have used /kanban, or been @-mentioned in it', err: '' });
    expect((await fx.run(['kanban', 'people', 'all'])).code).toBe(2);
    expect(await fx.run(['kanban', 'people'], { env: { MT_CRON_TOKEN: 't' } })).toEqual({
      code: 1,
      out: '',
      err: "mt: mt kanban people is an operator's command, not an agent's; this shell has MT_CRON_TOKEN set. Run it from your own shell",
    });
    expect(JSON.parse((await fx.run(['kanban', 'people', '--json'], { env: { MT_KANBAN_RUN: 'r_1' } })).out)).toMatchObject({ ok: false, code: 'operator_command' });
  });
});
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-kanban-people.test.ts`. Expected: `Tests  5 failed (5)`; among the failures, `TypeError: (0 , peopleOf) is not a function`.

- [ ] **Step 6.3: Implement.**

In `src/cli/gate.ts`, replace:

```ts
import { openDb } from '../db/open.js';
```

with:

```ts
import { openDb } from '../db/open.js';
import { peopleOf } from '../db/people.js';
```

In `src/cli/gate.ts`, replace:

```ts
  peopleMissing: PeopleMissing | undefined;
  close(): void;
```

with:

```ts
  peopleMissing: PeopleMissing | undefined;
  /**
   * The people this bot has seen, each with talk tier by this shell's allowlist,
   * none with an owner missing: `mt kanban people`'s (kanban spec §22.2).
   * Undefined with no app id, as there is no bot to list them for.
   */
  seen(): SeenPerson[] | undefined;
  close(): void;
}

/** A person as `mt kanban people` lists them. */
export interface SeenPerson {
  unionId: string;
  name: string | null;
  talk: boolean;
```

In `src/cli/gate.ts`, replace:

```ts
  return { service, home: settings.home, kanbanEnabled: settings.kanbanEnabled, peopleMissing, close: () => db.close() };
```

with:

```ts
  const seen = (): SeenPerson[] | undefined =>
    appId === undefined
      ? undefined
      : peopleOf(db, appId).map((p) => ({ unionId: p.unionId, name: p.name, talk: talk?.includes(p.openId) === true }));
  return { service, home: settings.home, kanbanEnabled: settings.kanbanEnabled, peopleMissing, seen, close: () => db.close() };
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban workflow archive <instance> [--board <name>] [--json]',
```

with:

```ts
  '  mt kanban workflow archive <instance> [--board <name>] [--json]',
  '  mt kanban people [--json]',
```

In `src/cli/mt.ts`, replace:

```ts
const OPERATOR_GROUPS: readonly string[] = ['task', 'board', 'gate', 'workflow'];

/** The subcommands whose name a run's refusal gives: `mt kanban board set`, not just `mt kanban board`. */
const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  task: TASK_COMMANDS,
  board: ['list', 'create', 'set', 'archive', 'use'],
  gate: ['add', 'list', 'remove'],
  workflow: ['list', 'instances', 'show', 'preview', 'start', 'apply', 'archive'],
```

with:

```ts
const OPERATOR_GROUPS: readonly string[] = ['task', 'board', 'gate', 'workflow', 'people'];

/** The subcommands whose name a run's refusal gives: `mt kanban board set`, not just `mt kanban board`. */
const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  task: TASK_COMMANDS,
  board: ['list', 'create', 'set', 'archive', 'use'],
  gate: ['add', 'list', 'remove'],
  workflow: ['list', 'instances', 'show', 'preview', 'start', 'apply', 'archive'],
  people: [],
```

In `src/cli/operator.ts`, replace:

```ts
import { loadOperator, operatorName, personHint, withBoard, type PeopleMissing } from './gate.js';
import { ask } from './kanban.js';
import type { MtIo } from './mt.js';
import { BIDI, decodeUtf8, INVISIBLE } from '../text.js';
import { boardsText, dryRunText, instanceText, instancesText, line, listText, madeText, previewText, showText, who, workflowsText } from './plain.js';
```

with:

```ts
import { loadOperator, operatorName, personHint, withBoard, type BoardAccess, type PeopleMissing } from './gate.js';
import { ask } from './kanban.js';
import type { MtIo } from './mt.js';
import { BIDI, decodeUtf8, INVISIBLE } from '../text.js';
import { boardsText, dryRunText, instanceText, instancesText, line, listText, madeText, peopleText, previewText, showText, who, workflowsText } from './plain.js';
```

In `src/cli/operator.ts`, replace:

```ts
  fn: (service: KanbanService, by: string) => Outcome,
```

with:

```ts
  fn: (service: KanbanService, by: string, board: BoardAccess) => Outcome,
```

In `src/cli/operator.ts`, replace:

```ts
      outcome = fn(board.service, operatorName(io));
```

with:

```ts
      outcome = fn(board.service, operatorName(io), board);
```

In `src/cli/operator.ts`, replace:

```ts
/** `mt kanban task …`, `board …` and `workflow …`, outside a board run: the operator's. */
export async function operatorCommand(command: string, rest: readonly string[], io: MtIo): Promise<number> {
```

with:

```ts
/**
 * `mt kanban people [--json]` (kanban spec §22.2): who this bot has seen, as a
 * terminal names them, `lark:<union_id>`, and whether they have talk tier by
 * the open_id last seen. A union_id is in no message a person sees, so this is
 * how an operator finds one.
 */
function people(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, JSON_FLAG);
  if (positionals.length > 0) throw new UsageError('kanban people takes no arguments');
  return act(io, values.json === true, 'mt kanban people', (_service, _by, board) => {
    const seen = board.seen();
    if (seen === undefined) return refused({ code: 'no_bot', message: 'there is no bot to list people for: this shell finds no lark.appId or LARK_APP_ID' });
    if (board.peopleMissing === 'owner' && values.json !== true) {
      io.err('mt: this shell finds no auth.owner or MT_OWNER_OPEN_ID, so nobody is shown with talk tier');
    }
    return {
      ok: true,
      lines: peopleText(seen),
      json: { people: seen.map((p) => ({ principal: `lark:${p.unionId}`, union_id: p.unionId, name: p.name, talk: p.talk })) },
    };
  });
}

/** `mt kanban task …`, `board …`, `workflow …` and `people`, outside a board run: the operator's. */
export async function operatorCommand(command: string, rest: readonly string[], io: MtIo): Promise<number> {
  if (command === 'people') return people(rest, io);
```

In `src/cli/plain.ts`, replace:

```ts
  return table([['task', 'status', 'assignee', 'title'], ...rows]);
```

with:

```ts
  return table([['task', 'status', 'assignee', 'title'], ...rows]);
}

/** `mt kanban people` (kanban spec §22.2): each person this bot has seen, by name, with their principal and talk tier. */
export function peopleText(seen: readonly { unionId: string; name: string | null; talk: boolean }[]): string[] {
  if (seen.length === 0) return ['no people yet: the gateway learns a person once they have used /kanban, or been @-mentioned in it'];
  const rows = seen.map((p) => [p.name === null ? '(no name)' : line(p.name, 80), `lark:${line(p.unionId, 80)}`, p.talk ? 'talk' : 'no']);
  return table([['name', 'person', 'talk'], ...rows]);
```

In `src/db/people.ts`, replace:

```ts
    : { appId: row.app_id, unionId: row.union_id, openId: row.open_id, name: row.name, seenAt: row.seen_at };
}
```

with:

```ts
    : { appId: row.app_id, unionId: row.union_id, openId: row.open_id, name: row.name, seenAt: row.seen_at };
}

/**
 * Every person this bot has seen (kanban spec §22.2), for `mt kanban people`:
 * by the name Lark last gave, then by union_id, those with no name last.
 */
export function peopleOf(db: Db, appId: string): PersonRow[] {
  return db
    .prepare<[string], PersonRaw>(
      `SELECT app_id, union_id, open_id, name, seen_at FROM people WHERE app_id = ?
        ORDER BY name IS NULL, name, union_id`,
    )
    .all(appId)
    .map((row) => ({ appId: row.app_id, unionId: row.union_id, openId: row.open_id, name: row.name, seenAt: row.seen_at }));
}
```

- [ ] **Step 6.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2511 passed (2511)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.5: Commit.**

```bash
git add src/cli/gate.ts src/cli/mt.ts src/cli/operator.ts src/cli/plain.ts src/db/people.ts tests/mt-kanban-people.test.ts
git commit -m "Add mt kanban people, the people this bot has seen, by name, with their principal and whether they have talk tier, refused in an agent's shell"
```

---

### Task 7: `follow`, and the "Created" line

**Files:**

- Create: `tests/kanban-follow.test.ts`
- Modify: `src/db/WRITERS.md`, `src/db/kanban.ts`, `src/kanban/chat-render.ts`, `src/kanban/service.ts`, `src/kanban/types.ts`

§22.1, §22.5. `Follow { appId, chatId, threadId, rootId }` beside `createdVia`, which stays `{kind: operator}`. `KanbanService.create` refuses a `follow` unless from the operator, and in any shape but Lark's, before the key; `subscribe()` writes it in the task's transaction, for `lark` and this bot, the root only with a thread; `createTask` writes `task_created_followed` after `created`, its actor and its `by` the creator, which `renderNotice` renders as the task's "Created" line. A repeat by key returns before anything is written. `KanbanService.threadRoot` is the notifier's own lookup, for Task 9. No front passes a `follow` yet.

- [ ] **Step 7.1: Write the tests.**

Create `tests/kanban-follow.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SendTarget } from '../src/channel/types.js';
import { noticeBatchUuid } from '../src/core/ids.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { notePerson } from '../src/db/people.js';
import { CardPoster } from '../src/kanban/cards.js';
import { renderNotice } from '../src/kanban/chat-render.js';
import { Notifier } from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, Follow, KanbanEvent, TaskRow } from '../src/kanban/types.js';
import { clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * A chat that follows a terminal's task (kanban spec §22.1): `follow`, which
 * `subscribe()` writes in the task's transaction for this bot, at chat scope or
 * in a thread with its root; refused from chat and from a run; a repeat by key
 * adding nothing; and its "Created" line, `task_created_followed`, which the
 * notifier sends before the task's other notices.
 */

const OPERATOR: CreatedVia = { kind: 'operator' };
const BY = 'operator:alice';
const CHAT: Follow = { appId: 'cli_app', chatId: 'oc_team', threadId: '', rootId: null };
const THREAD: Follow = { appId: 'cli_app', chatId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' };
const ALICE = 'lark:on_alice';

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  clock = new ManualClock();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock,
    people: { canTalk: (p) => p === ALICE },
  });
  lark = new FakeChannel({ id: 'lark', clock });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function create(follow: Follow | undefined, extra: Partial<Parameters<KanbanService['create']>[0]> = {}) {
  return service.create({ title: 'Book the venue', assignee: 'implementer', createdBy: BY, createdVia: OPERATOR, ...(follow === undefined ? {} : { follow }), ...extra });
}

function made(follow: Follow | undefined, extra: Partial<Parameters<KanbanService['create']>[0]> = {}): TaskRow {
  const r = create(follow, extra);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task;
}

function notifier(): Notifier {
  return new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2, clock, note: () => undefined });
}

describe('follow', () => {
  it("is the new task's one subscription, for this bot, at chat scope, with the task's creator and createdVia unchanged", () => {
    const task = made(CHAT);
    expect(task).toMatchObject({ createdBy: BY, createdVia: OPERATOR });
    expect(subscriptionsOf(t.db, task.taskId)).toEqual([
      expect.objectContaining({ channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '', rootMessageId: null, cursor: 0 }),
    ]);
    expect(subscriptionsOf(t.db, made(undefined).taskId)).toEqual([]);
  });

  it('is written in a thread with its root, and nothing at all when the task is refused', () => {
    const task = made(THREAD);
    expect(subscriptionsOf(t.db, task.taskId)).toEqual([expect.objectContaining({ conversationId: 'oc_team', threadId: 'omt_topic', rootMessageId: 'om_root' })]);
    const before = t.db.prepare('SELECT count(*) AS n FROM kanban_subscriptions').get();
    expect(create(CHAT, { parents: ['k_nope'] })).toMatchObject({ ok: false, code: 'not_found' });
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_subscriptions').get()).toEqual(before);
  });

  it('is refused from chat and from a run, and in any shape but Lark\'s', () => {
    const run = service.claim(made(undefined).taskId);
    if (!run.ok) throw new Error(run.message);
    for (const via of [VIA, { kind: 'run', runId: run.run.runId } as const]) {
      expect(service.create({ title: 'x', createdBy: BY, createdVia: via, follow: CHAT })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^only the terminal names a chat/) });
    }
    const bad: unknown[] = [
      { ...CHAT, chatId: 'team' },
      { ...CHAT, appId: '' },
      { ...CHAT, threadId: 'topic', rootId: 'om_root' },
      { ...THREAD, rootId: null },
      { ...CHAT, rootId: 'om_root' },
      'oc_team',
    ];
    for (const follow of bad) expect(create(follow as Follow), JSON.stringify(follow)).toMatchObject({ ok: false, code: 'invalid' });
    expect(t.db.prepare('SELECT count(*) AS n FROM kanban_subscriptions').get()).toEqual({ n: 0 });
  });

  it("writes one task_created_followed after created, by the creator, and none without a follow", () => {
    const task = made(CHAT);
    const events = eventsOf(t.db, task.taskId);
    expect(events.map((e) => e.kind)).toEqual(['created', 'task_created_followed']);
    expect(events[1]).toMatchObject({ actor: BY, payload: { by: BY } });
    expect(eventsOf(t.db, made(undefined).taskId).map((e) => e.kind)).toEqual(['created']);
  });

  it('answers a key repeated with another chat with the first task, adding no subscription and no event', () => {
    const first = create(CHAT, { idempotencyKey: 'weekly' });
    const again = create({ ...CHAT, chatId: 'oc_other' }, { idempotencyKey: 'weekly' });
    expect(again).toMatchObject({ ok: true, existing: true, task: { taskId: first.ok ? first.task.taskId : '' } });
    const id = first.ok ? first.task.taskId : '';
    expect(subscriptionsOf(t.db, id).map((s) => s.conversationId)).toEqual(['oc_team']);
    expect(eventsOf(t.db, id).map((e) => e.kind)).toEqual(['created', 'task_created_followed']);
  });

  it("finds a thread's root as the notifier does, from a subscription in it", () => {
    const at = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };
    expect(service.threadRoot(at)).toBeUndefined();
    service.create({ title: 'From chat', createdBy: ALICE, createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' } });
    expect(service.threadRoot(at)).toBe('om_root');
    expect(service.threadRoot({ ...at, appId: 'cli_other' })).toBeUndefined();
    expect(service.threadRoot({ ...at, threadId: '' })).toBeUndefined();
  });
});

describe('the "Created" line', () => {
  const task = { taskId: 'k_000000000001', title: 'Book_the venue', assignee: { kind: 'role', name: 'worker' } } as unknown as TaskRow;
  const event = { id: 2, taskId: task.taskId, runId: null, kind: 'task_created_followed', actor: BY, payload: { by: BY }, createdAt: 1 } as KanbanEvent;

  it('names the task, who it is for and who made it, from a terminal', () => {
    const opts = { blockRecurrenceLimit: 2, nameOf: (p: string) => (p === ALICE ? 'Alice Chen' : undefined) };
    expect(renderNotice(event, task, opts)).toBe('Created `k_000000000001` **Book\\_the venue**, for role worker, by operator:alice from a terminal.');
    expect(renderNotice(event, { ...task, assignee: { kind: 'human', name: ALICE } }, opts)).toBe('Created `k_000000000001` **Book\\_the venue**, for Alice Chen, by operator:alice from a terminal.');
    expect(renderNotice(event, { ...task, assignee: null }, opts)).toBe('Created `k_000000000001` **Book\\_the venue**, for nobody yet, by operator:alice from a terminal.');
  });

  it("is sent first, then the task's notices, in the chat's conversation and in the thread's", async () => {
    const chat = made(CHAT);
    const thread = made(THREAD, { title: 'Order the food' });
    const n = notifier();
    expect(await n.deliver()).toBe(2);
    expect(lark.texts.map((x) => [x.target, x.text])).toEqual([
      [{ chatId: 'oc_team', threadId: '' }, `Created \`${chat.taskId}\` **Book the venue**, for role implementer, by operator:alice from a terminal.`],
      [{ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' }, `Created \`${thread.taskId}\` **Order the food**, for role implementer, by operator:alice from a terminal.`],
    ]);
    const r = await service.complete(chat.taskId, { kind: 'person', principal: ALICE }, { summary: 'booked' });
    expect(r.ok).toBe(true);
    expect(await n.deliver()).toBe(1);
    expect(lark.texts.at(-1)?.text).toBe(`Done: **Book the venue** \`${chat.taskId}\`\n> booked`);
  });

  it('is sent again after a restart with the same uuid', async () => {
    const task = made(CHAT);
    lark.failNext('sendText', new Error('socket hang up'));
    expect(await notifier().deliver()).toBe(0);
    expect(lark.texts).toEqual([]);
    expect(await notifier().deliver()).toBe(1);
    const sub = subscriptionsOf(t.db, task.taskId)[0]?.id ?? 0;
    const created = eventsOf(t.db, task.taskId).find((e) => e.kind === 'task_created_followed')?.id ?? 0;
    expect(lark.texts[0]?.uuid).toBe(noticeBatchUuid('cli_app', [[sub, created]]));
  });
});

describe("a person's card for a task the terminal followed", () => {
  it('goes in the thread to a member, and by direct message from a chat-scope follow', async () => {
    notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice', name: 'Alice' }, clock.now());
    lark.members.set('oc_team', ['on_alice']);
    const poster = () => new CardPoster({ db: t.db, service, channel: lark, appId: 'cli_app', clock, note: () => undefined, held: () => false });
    for (const follow of [THREAD, CHAT]) {
      const task = made(follow, { assignee: ALICE });
      expect(service.claim(task.taskId).ok).toBe(true);
      await poster().deliver();
    }
    const dm: SendTarget = { chatId: 'on_alice', threadId: '', receiveIdType: 'union_id' };
    expect(lark.boardCards.map((c) => c.target)).toEqual([{ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root', stayInThread: true }, dm]);
  });
});
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-follow.test.ts`. Expected: `Tests  10 failed (10)`; among the failures, `AssertionError: expected [] to deeply equal [ ObjectContaining{…} ]`.

- [ ] **Step 7.3: Implement.**

In `src/db/WRITERS.md`, replace:

```markdown
| `kanban_events` | `db/kanban.ts` | Append-only, written in the transaction of the change it records. String values in `payload` are masked on write (spec §10.1). |
| `kanban_gates` | `db/kanban.ts` | Added by `addGate` and deleted by `removeGate`, never updated: the command is stored as written, never masked (spec §10.1). The gateway and the `mt kanban gate` commands both write it, each through `KanbanService`. |
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4). `root_message_id` (migration 008) is written at the insert, for a task created in a thread, from `createdVia.rootId`, or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. `thread_id` and `root_message_id` are written once more, together, by `threadSubscriptions`, which moves each subscription of its tasks still at chat scope with no root into the thread their "Created" reply opened, in one transaction: one task's for `/kanban task new`, every member's for a workflow's start (workflows spec §9), writing no event either. No root is changed once written. Never deleted. |
```

with:

```markdown
| `kanban_events` | `db/kanban.ts` | Append-only, written in the transaction of the change it records. String values in `payload` are masked on write (spec §10.1). `createTask` writes `task_created_followed` after `created` for a task a terminal named a chat to follow, the "Created" line the notifier posts there (kanban spec §22.1). |
| `kanban_gates` | `db/kanban.ts` | Added by `addGate` and deleted by `removeGate`, never updated: the command is stored as written, never masked (spec §10.1). The gateway and the `mt kanban gate` commands both write it, each through `KanbanService`. |
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4), or the chat a terminal named, `follow`, for this bot, at chat scope or in a thread with the root `threadRootOf` gave (kanban spec §22.1). `root_message_id` (migration 008) is written at the insert, for a task created in a thread, from `createdVia.rootId`, or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. `thread_id` and `root_message_id` are written once more, together, by `threadSubscriptions`, which moves each subscription of its tasks still at chat scope with no root into the thread their "Created" reply opened, in one transaction: one task's for `/kanban task new`, every member's for a workflow's start (workflows spec §9), writing no event either. No root is changed once written. Never deleted. |
```

In `src/db/kanban.ts`, replace:

```ts
import { DEFAULT_BOARD, ENDED_OUTCOMES, GATE_LIMITS, REPORTED_OUTCOMES } from '../kanban/types.js';
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  BlockKind,
  BoardRow,
  ChatAt,
  CommentRow,
  Contract,
  CreatedVia,
  EndedOutcome,
  GateRow,
  Phase,
  Refusal,
  RefusalCode,
  ReportedBlockKind,
  Rendering,
  Reporter,
  Result,
  RetryOnCrash,
  RunKind,
  RunOutcome,
```

with:

```ts
import { DEFAULT_BOARD, ENDED_OUTCOMES, GATE_LIMITS, REPORTED_OUTCOMES } from '../kanban/types.js';
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  BlockKind,
  BoardRow,
  ChatAt,
  CommentRow,
  Contract,
  CreatedVia,
  EndedOutcome,
  Follow,
  GateRow,
  Phase,
  Refusal,
  RefusalCode,
  ReportedBlockKind,
  Rendering,
  Reporter,
  Result,
  RetryOnCrash,
  RunKind,
  RunOutcome,
```

In `src/db/kanban.ts`, replace:

```ts
}

/**
 * Create a task, linked to its parents, in one transaction.
```

with:

```ts
  /** The chat a terminal named to follow it (kanban spec §22.1), checked by the service. */
  follow?: Follow;
}

/**
 * Create a task, linked to its parents, in one transaction.
 *
 * A task with a `follow` gets one more event, after `created`:
 * `task_created_followed`, the "Created" line the notifier posts to that chat,
 * as a terminal has no Lark client to post it (kanban spec §22.1). A
 * workflow's members never get one: their instance's `workflow_started` names
 * them all.
```

In `src/db/kanban.ts`, replace:

```ts
    const taskId = insertTask(d, { ...t, board, createdFromTask, parents }, now);
```

with:

```ts
    const taskId = insertTask(d, { ...t, board, createdFromTask, parents }, now);
    if (t.follow !== undefined) record(d, { taskId, kind: 'task_created_followed', actor: t.createdBy, payload: { by: t.createdBy } }, now);
```

In `src/db/kanban.ts`, replace:

```ts
  subscribe(d, taskId, t.createdVia, createdFromTask, now);
```

with:

```ts
  subscribe(d, taskId, t.createdVia, createdFromTask, now, t.follow);
```

In `src/db/kanban.ts`, replace:

```ts
 * thread, with its root (spec §19.4). Each cursor starts at 0: every event of the
 * new task is newer than that. A root is written only with a thread: at chat
 * scope it comes from `threadSubscription` alone.
 */
function subscribe(d: Db, taskId: string, via: CreatedVia, createdFromTask: string | null, now: number): void {
  const insert = d.prepare(
    `INSERT OR IGNORE INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, root_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
```

with:

```ts
 * thread, with its root (spec §19.4); or, for a terminal's, the chat it named,
 * `follow`, in Lark, for this bot (kanban spec §22.1). Each cursor starts at 0:
 * every event of the new task is newer than that. A root is written only with a
 * thread: at chat scope it comes from `threadSubscription` alone.
 */
function subscribe(d: Db, taskId: string, via: CreatedVia, createdFromTask: string | null, now: number, follow?: Follow): void {
  const insert = d.prepare(
    `INSERT OR IGNORE INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, root_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  if (follow !== undefined) {
    insert.run(taskId, 'lark', follow.appId, follow.chatId, follow.threadId, follow.threadId === '' ? null : follow.rootId, now);
  }
```

In `src/kanban/chat-render.ts`, replace:

```ts
 * knows where the card went -- and a card that could not be sent.
```

with:

```ts
 * knows where the card went -- and a card that could not be sent. A task a
 * terminal made for a chat to follow is announced there by its "Created" line.
```

In `src/kanban/chat-render.ts`, replace:

```ts
      return `Stranded: ${name}. Nobody can be given it: ${label(text(p, 'reason'), 500)}`;
```

with:

```ts
      return `Stranded: ${name}. Nobody can be given it: ${label(text(p, 'reason'), 500)}`;
    case 'task_created_followed': {
      // The "Created" line of a task a terminal made (kanban spec §22.1), from the task as it is now, as every notice.
      const whose = task.assignee === null ? 'nobody yet' : whom(task.assignee, opts.nameOf);
      return `Created ${id(task.taskId)} **${label(task.title)}**, for ${whose}, by ${label(text(p, 'by'), 80)} from a terminal.`;
    }
```

In `src/kanban/service.ts`, replace:

```ts
  type BoardEntry,
  type BoardSummary,
  type CardReading,
  type InstanceRow,
  type MemberRow,
  type TaskView,
} from '../db/kanban-read.js';
```

with:

```ts
  threadRootOf,
  type BoardEntry,
  type BoardSummary,
  type CardReading,
  type InstanceRow,
  type MemberRow,
  type TaskView,
  type ThreadAt,
} from '../db/kanban-read.js';
import { CHAT_ID, THREAD_ID } from '../core/lark-ids.js';
```

In `src/kanban/service.ts`, replace:

```ts
/**
 * A report refused while another on the task runs its gates: what to look at
```

with:

```ts
/**
 * Why a `follow` is refused (kanban spec §22.1, workflows spec §18.1), or
 * undefined: only the terminal names a chat, as a chat follows what is made in
 * it and a run's work follows its task's chats; and it names one in Lark's
 * shapes, for a bot, with a thread's root, and none at chat scope.
 */
function followRefused(follow: unknown, via: CreatedVia): Refusal | undefined {
  if (follow === undefined) return undefined;
  if (via?.kind !== 'operator') {
    return board.refuse('invalid', "only the terminal names a chat to follow what it makes: a chat follows what is made in it, and a run's work its task's chats");
  }
  if (!isRecord(follow) || !isText(follow.appId) || follow.appId === '' || !isText(follow.chatId) || !CHAT_ID.test(follow.chatId)) {
    return board.refuse('invalid', "a chat to follow is the bot's app id and a chat id, oc_…");
  }
  const { threadId, rootId } = follow;
  if (!isText(threadId) || (threadId !== '' && !THREAD_ID.test(threadId))) return board.refuse('invalid', 'a thread to follow in is a thread id, omt_…, or none');
  if (threadId === '' ? rootId !== null : !isText(rootId) || rootId === '') {
    return board.refuse('invalid', 'a thread is followed with its root message, and a chat with none');
  }
  return undefined;
}

/**
 * A report refused while another on the task runs its gates: what to look at
```

In `src/kanban/service.ts`, replace:

```ts
    if (!checked.ok) return checked;
```

with:

```ts
    if (!checked.ok) return checked;
    const follow = followRefused(req.follow, req.createdVia);
    if (follow !== undefined) return follow;
```

In `src/kanban/service.ts`, replace:

```ts
        ...(req.board === undefined ? {} : { board: req.board }),
      },
      this.#clock.now(),
    );
```

with:

```ts
        ...(req.board === undefined ? {} : { board: req.board }),
        ...(req.follow === undefined ? {} : { follow: req.follow }),
      },
      this.#clock.now(),
    );
  }

  /**
   * The root of a thread, as the notifier finds it (spec §19.7): the message a
   * subscription in it recorded, or undefined for none, or at chat scope. The
   * terminal's `--thread` follows only a thread whose root is known (kanban spec §22.1).
   */
  threadRoot(at: ThreadAt): string | undefined {
    return threadRootOf(this.#db, at);
```

In `src/kanban/types.ts`, replace:

```ts
  | { kind: 'operator' };
```

with:

```ts
  | { kind: 'operator' };

/**
 * A chat the terminal names to follow what it makes (kanban spec §22.1,
 * workflows spec §18.1): this bot's app id, the chat, and the thread, `''` at
 * chat scope, with its root, the message every send in it replies to, null at
 * chat scope. Beside `createdVia`, which stays the operator's: a terminal's
 * task is not recorded as a chat's.
 */
export interface Follow {
  appId: string;
  chatId: string;
  threadId: string;
  rootId: string | null;
}
```

In `src/kanban/types.ts`, replace:

```ts
  /** The board it goes on (spec §16): chat's is the chat's board. A run's task's follow-ups go on its board, whatever this says. */
  board?: string;
}
```

with:

```ts
  /** The board it goes on (spec §16): chat's is the chat's board. A run's task's follow-ups go on its board, whatever this says. */
  board?: string;
  /** The chat that follows it, named at the terminal (kanban spec §22.1); the operator's alone. */
  follow?: Follow;
}
```

- [ ] **Step 7.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2521 passed (2521)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.5: Commit.**

```bash
git add src/db/WRITERS.md src/db/kanban.ts src/kanban/chat-render.ts src/kanban/service.ts src/kanban/types.ts tests/kanban-follow.test.ts
git commit -m "Let the terminal name a chat to follow a new task: a follow beside createdVia, written by subscribe in the task's transaction, refused from chat and from a run, and a task_created_followed event the notifier posts as the task's Created line"
```

---

### Task 8: `workflow_started`, the start's reply

**Files:**

- Create: `tests/kanban-workflow-started.test.ts`
- Modify: `src/db/WRITERS.md`, `src/db/kanban.ts`, `src/kanban/chat-render.ts`, `src/kanban/chat.ts`, `src/kanban/notices.ts`, `src/kanban/service.ts`, `tests/kanban-workflow-chat.test.ts`

Workflows §18.1, §18.2, §18.5. `StartRequest.follow` and `ApplyRequest.follow`, refused as Task 7's; `NewInstance.follow`, which `applyDag` gives every member's insert, and, after the member rows, one `workflow_started` on the first member with the payload §18.2 lists. `renderStarted` takes a `StartedReply`, built from chat's rows by `startedReply` or from the payload, and names who started it from a terminal; `fitted` takes a total; `renderNotice` renders the event with `where`, which the notifier gives from the conversation, so the words are the thread's in a thread with a root. Members get no `task_created_followed`, as they are inserted by `insertTask`, not `createTask`.

- [ ] **Step 8.1: Write the tests.**

In `tests/kanban-workflow-chat.test.ts`, replace:

```ts
import { WORKFLOW_REPLY_MAX, renderInstance, renderStarted } from '../src/kanban/chat-render.js';
```

with:

```ts
import { WORKFLOW_REPLY_MAX, renderInstance, renderStarted, startedReply } from '../src/kanban/chat-render.js';
```

In `tests/kanban-workflow-chat.test.ts`, replace:

```ts
    const text = renderStarted({ instance: { instanceId: 'w_aaaaaaaaaaaa', name: 'big', board: 'default' }, tasks }, 'thread', (a) => `role ${a.name}`);
```

with:

```ts
    const text = renderStarted(startedReply({ instance: { instanceId: 'w_aaaaaaaaaaaa', name: 'big', board: 'default' }, tasks }), 'thread', (a) => `role ${a.name}`);
```

Create `tests/kanban-workflow-started.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noticeBatchUuid } from '../src/core/ids.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { renderStarted, startedReply, WORKFLOW_REPLY_MAX } from '../src/kanban/chat-render.js';
import { Notifier } from '../src/kanban/notices.js';
import { KanbanService, type WorkflowMade } from '../src/kanban/service.js';
import type { CreatedVia, Follow, Result, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA } from './helpers/kanban.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A workflow started or applied at a terminal with a chat to follow it
 * (workflows spec §18.1, §18.2): every member followed in the one transaction,
 * and the start's reply queued as `workflow_started` on the first member, which
 * the notifier renders from its payload alone, whole, before any member's
 * notice; never for chat's start or a run's.
 */

const SECRET = 'sk-live-1234567890';
const OPERATOR: CreatedVia = { kind: 'operator' };
const BY = 'operator:alice';
const CHAT: Follow = { appId: 'cli_app', chatId: 'oc_team', threadId: '', rootId: null };
const THREAD: Follow = { appId: 'cli_app', chatId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' };
const PARAMS = { from: 'json', params: { topic: 'log storage', vendors: ['acme', 'globex'] } } as const;
const HEARS = 'hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.';

let h: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  clock = new ManualClock();
  const dir = join(h.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
  service = new KanbanService({
    db: h.db,
    roles: new Map(['worker', 'reviewer', 'implementer'].map((n) => [n, role(n)])),
    workspaces: new Set(['default']),
    people: { canTalk: (p) => p === ALICE },
    supervisedRoles: true,
    workflowsDir: dir,
    clock,
  });
  lark = new FakeChannel({ id: 'lark', clock });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

function made(r: Result<object>): WorkflowMade {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r as unknown as WorkflowMade;
}

function start(follow: Follow | undefined, over: Partial<Parameters<KanbanService['startWorkflow']>[0]> = {}) {
  return service.startWorkflow({ workflow: 'vendor-eval', params: PARAMS, createdBy: BY, createdVia: OPERATOR, ...(follow === undefined ? {} : { follow }), ...over });
}

/** A DAG of `n` tasks, each titled to `bytes` bytes, the first for a person. */
function dag(n: number, bytes = 20) {
  return {
    format: 1,
    tasks: Array.from({ length: n }, (_, i) => ({
      ref: `t${i}`,
      title: `${'T'.repeat(Math.max(0, bytes - String(i).length - 1))} ${i}`.slice(-bytes),
      assignee: i === 0 ? ALICE : 'worker',
    })),
  };
}

function notifier(): Notifier {
  return new Notifier({ db: h.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2, clock, note: () => undefined });
}

const kinds = (task: TaskRow) => eventsOf(h.db, task.taskId).map((e) => e.kind);

describe('a terminal start that names a chat', () => {
  it("follows every member from the chat, and writes one workflow_started on the first, after the member rows", () => {
    const r = made(start(CHAT));
    for (const t of r.tasks) {
      expect(subscriptionsOf(h.db, t.taskId)).toEqual([expect.objectContaining({ channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '', rootMessageId: null })]);
    }
    const [first, ...rest] = r.tasks;
    expect(kinds(first?.task as TaskRow)).toEqual(['created', 'workflow_started']);
    for (const t of rest) expect(kinds(t.task)).not.toContain('workflow_started');
    const event = eventsOf(h.db, first?.taskId ?? '').at(-1);
    const lastCreated = Math.max(...r.tasks.map((t) => eventsOf(h.db, t.taskId)[0]?.id ?? 0));
    expect(event?.id).toBeGreaterThan(lastCreated);
    expect(event).toMatchObject({ actor: BY });
    expect(event?.payload).toEqual({
      workflow: r.instance.instanceId,
      workflowName: 'vendor-eval',
      board: 'default',
      by: BY,
      count: 4,
      people: false,
      tasks: r.tasks.map((t) => ({ taskId: t.taskId, title: t.task.title, assignee: 'worker', assigneeKind: 'role' })),
    });
  });

  it('follows in a thread with its root, and holds no task_created_followed on any member', () => {
    const r = made(service.applyDag({ dag: dag(3), createdBy: BY, createdVia: OPERATOR, follow: THREAD }));
    for (const t of r.tasks) {
      expect(subscriptionsOf(h.db, t.taskId)).toEqual([expect.objectContaining({ threadId: 'omt_topic', rootMessageId: 'om_root' })]);
      expect(kinds(t.task)).not.toContain('task_created_followed');
    }
    expect(eventsOf(h.db, r.tasks[0]?.taskId ?? '').at(-1)?.payload).toMatchObject({ workflowName: null, count: 3, people: true });
  });

  it('keeps the first 30 tasks of 100 in the payload, masked', () => {
    addSecrets([SECRET]);
    const big = dag(100);
    big.tasks[1] = { ...big.tasks[1], title: `with ${SECRET}` } as (typeof big.tasks)[number];
    const r = made(service.applyDag({ dag: big, createdBy: BY, createdVia: OPERATOR, follow: CHAT }));
    const payload = eventsOf(h.db, r.tasks[0]?.taskId ?? '').at(-1)?.payload as { count: number; tasks: Array<{ taskId: string; title: string }> };
    expect(payload.count).toBe(100);
    expect(payload.tasks.map((t) => t.taskId)).toEqual(r.tasks.slice(0, 30).map((t) => t.taskId));
    expect(payload.tasks[1]?.title).toBe(`with ${MASK}`);
  });

  it("writes none without a chat, and refuses a follow from chat's start and from a run's", () => {
    const plain = made(start(undefined));
    expect(kinds(plain.tasks[0]?.task as TaskRow)).toEqual(['created']);
    expect(start(CHAT, { createdBy: ALICE, createdVia: VIA })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^only the terminal names a chat/) });
    const planner = service.create({ title: 'Plan', assignee: 'implementer', createdBy: ALICE, createdVia: VIA });
    if (!planner.ok) throw new Error(planner.message);
    const run = service.claim(planner.task.taskId);
    if (!run.ok) throw new Error(run.message);
    const via: CreatedVia = { kind: 'run', runId: run.run.runId };
    expect(start(CHAT, { createdBy: `run:${run.run.runId}`, createdVia: via })).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.applyDag({ dag: dag(1), createdBy: `run:${run.run.runId}`, createdVia: via, follow: CHAT })).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.applyDag({ dag: dag(1), createdBy: BY, createdVia: OPERATOR, follow: { ...CHAT, chatId: 'team' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.applyDag({ dag: { ...dag(1), chat: 'oc_team' }, createdBy: BY, createdVia: OPERATOR })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/takes no key "chat"/) });
  });

  it('adds no subscription and no second event for a repeat by key, and writes nothing for a dry run', () => {
    const first = made(start(CHAT, { idempotencyKey: 'weekly' }));
    const again = made(start({ ...CHAT, chatId: 'oc_other' }, { idempotencyKey: 'weekly' }));
    expect(again).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
    for (const t of first.tasks) expect(subscriptionsOf(h.db, t.taskId).map((s) => s.conversationId)).toEqual(['oc_team']);
    expect(eventsOf(h.db, first.tasks[0]?.taskId ?? '').filter((e) => e.kind === 'workflow_started')).toHaveLength(1);
    const count = () => h.db.prepare('SELECT count(*) AS n FROM kanban_subscriptions').get();
    const before = count();
    expect(service.applyDag({ dag: dag(2), createdBy: BY, createdVia: OPERATOR, follow: CHAT, dryRun: true })).toMatchObject({ ok: true, dryRun: true, existing: false });
    expect(count()).toEqual(before);
  });
});

describe('the reply, as the notifier sends it', () => {
  it("is posted once, in the chat's words, naming who started it from a terminal, before a member's first notice", async () => {
    const r = made(start(CHAT));
    const [shortlist] = r.tasks;
    expect(service.block(r.tasks[1]?.taskId ?? '', { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which acme?' }).ok).toBe(true);
    const n = notifier();
    expect(await n.deliver()).toBe(2);
    expect(lark.texts).toHaveLength(1);
    const [reply, blocked] = lark.texts[0]?.text.split('\n\n') ?? [];
    expect(reply).toBe(
      [
        `operator:alice started vendor-eval from a terminal as \`${r.instance.instanceId}\`, 4 tasks:`,
        `- \`${shortlist?.taskId}\` Shortlist vendors for log storage, for role worker`,
        `- \`${r.tasks[1]?.taskId}\` Evaluate acme for log storage, for role worker`,
        `- \`${r.tasks[2]?.taskId}\` Evaluate globex for log storage, for role worker`,
        `- \`${r.tasks[3]?.taskId}\` Recommend a vendor for log storage, for role worker`,
        `This chat ${HEARS}`,
      ].join('\n'),
    );
    expect(blocked).toMatch(/is blocked \(needs\\_input\): which acme\?/);
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });

  it("is in the thread's words in a thread, saying where a person's card comes", async () => {
    made(service.applyDag({ dag: dag(2), createdBy: BY, createdVia: OPERATOR, follow: THREAD }));
    await notifier().deliver();
    expect(lark.texts[0]?.target).toEqual({ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' });
    expect(lark.texts[0]?.text.split('\n')[0]).toMatch(/^operator:alice started \\\(no workflow\\\) from a terminal as `w_[0-9a-z]+`, 2 tasks:$/);
    expect(lark.texts[0]?.text.split('\n').at(-1)).toBe(
      `This thread ${HEARS} A person's card comes in this thread when their task is ready, or by direct message if they are not in this group.`,
    );
  });

  it('is never cut, and under 3,800 characters for 100 tasks of 512-byte titles', async () => {
    const r = made(service.applyDag({ dag: dag(100, 512), createdBy: BY, createdVia: OPERATOR, follow: CHAT }));
    expect(await notifier().deliver()).toBe(1);
    const text = lark.texts[0]?.text ?? '';
    expect(text.length).toBeLessThan(WORKFLOW_REPLY_MAX);
    const lines = text.split('\n');
    const listed = lines.filter((l) => l.startsWith('- '));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThanOrEqual(30);
    expect(lines.at(-2)).toBe(`… and ${100 - listed.length} more: \`/kanban workflow show ${r.instance.instanceId}\` lists them all.`);
    expect(lines.at(-1)).toMatch(/^This chat hears/);
  });

  it('is sent again after a restart with the same uuid, and read without the workflow tables', async () => {
    const r = made(start(CHAT));
    lark.failNext('sendText', new Error('socket hang up'));
    await notifier().deliver();
    const prepare = vi.spyOn(h.db, 'prepare');
    expect(await notifier().deliver()).toBe(1);
    expect(prepare.mock.calls.map((c) => String(c[0])).filter((sql) => /kanban_workflow/.test(sql))).toEqual([]);
    prepare.mockRestore();
    const first = r.tasks[0]?.taskId ?? '';
    const sub = subscriptionsOf(h.db, first)[0]?.id ?? 0;
    const event = eventsOf(h.db, first).find((e) => e.kind === 'workflow_started')?.id ?? 0;
    expect(lark.texts[0]?.uuid).toBe(noticeBatchUuid('cli_app', [[sub, event]]));
  });
});

describe('renderStarted', () => {
  it("is chat's own reply, built from the rows, with no one named as the starter", () => {
    const r = made(start(undefined));
    const text = renderStarted(startedReply(r), 'chat', (a) => `role ${a.name}`);
    expect(text.split('\n')[0]).toBe(`Started vendor-eval as \`${r.instance.instanceId}\`, 4 tasks:`);
  });
});
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-workflow-chat.test.ts tests/kanban-workflow-started.test.ts`. Expected: `Tests  11 failed | 13 passed (24)`; among the failures, `TypeError: (0 , startedReply) is not a function`.

- [ ] **Step 8.3: Implement.**

In `src/db/WRITERS.md`, replace:

```markdown
| `kanban_events` | `db/kanban.ts` | Append-only, written in the transaction of the change it records. String values in `payload` are masked on write (spec §10.1). `createTask` writes `task_created_followed` after `created` for a task a terminal named a chat to follow, the "Created" line the notifier posts there (kanban spec §22.1). |
| `kanban_gates` | `db/kanban.ts` | Added by `addGate` and deleted by `removeGate`, never updated: the command is stored as written, never masked (spec §10.1). The gateway and the `mt kanban gate` commands both write it, each through `KanbanService`. |
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4), or the chat a terminal named, `follow`, for this bot, at chat scope or in a thread with the root `threadRootOf` gave (kanban spec §22.1). `root_message_id` (migration 008) is written at the insert, for a task created in a thread, from `createdVia.rootId`, or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. `thread_id` and `root_message_id` are written once more, together, by `threadSubscriptions`, which moves each subscription of its tasks still at chat scope with no root into the thread their "Created" reply opened, in one transaction: one task's for `/kanban task new`, every member's for a workflow's start (workflows spec §9), writing no event either. No root is changed once written. Never deleted. |
```

with:

```markdown
| `kanban_events` | `db/kanban.ts` | Append-only, written in the transaction of the change it records. String values in `payload` are masked on write (spec §10.1). `createTask` writes `task_created_followed` after `created` for a task a terminal named a chat to follow, the "Created" line the notifier posts there (kanban spec §22.1); and `applyDag` writes `workflow_started` on an instance's first member, after its member rows, for an instance a terminal named a chat to follow, holding the start's reply for the notifier (workflows spec §18.2). |
| `kanban_gates` | `db/kanban.ts` | Added by `addGate` and deleted by `removeGate`, never updated: the command is stored as written, never masked (spec §10.1). The gateway and the `mt kanban gate` commands both write it, each through `KanbanService`. |
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4), or the chat a terminal named, `follow`, for this bot, at chat scope or in a thread with the root `threadRootOf` gave (kanban spec §22.1), which `applyDag` gives every member of an instance (workflows spec §18.1). `root_message_id` (migration 008) is written at the insert, for a task created in a thread, from `createdVia.rootId`, or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. `thread_id` and `root_message_id` are written once more, together, by `threadSubscriptions`, which moves each subscription of its tasks still at chat scope with no root into the thread their "Created" reply opened, in one transaction: one task's for `/kanban task new`, every member's for a workflow's start (workflows spec §9), writing no event either. No root is changed once written. Never deleted. |
```

In `src/db/kanban.ts`, replace:

```ts
  idempotencyKey: string | null;
}
```

with:

```ts
  idempotencyKey: string | null;
  /** The chat a terminal named to follow every member (workflows spec §18.1), beside the DAG, not in it. */
  follow?: Follow;
}

/** The members a `workflow_started` payload lists: the start's reply lists at most 30 (workflows spec §9, §18.2). */
const STARTED_TASKS = 30;
```

In `src/db/kanban.ts`, replace:

```ts
 * repeated ref, rolls everything back: all of it is made, or none.
```

with:

```ts
 * repeated ref, rolls everything back: all of it is made, or none. With a
 * `follow`, every member's insert subscribes it, and one `workflow_started` on
 * the first member, after the member rows, holds the start's reply for the
 * notifier to post (workflows spec §18.2): the facts, not the text, which the
 * notifier makes, masked and worded as every notice is.
```

In `src/db/kanban.ts`, replace:

```ts
        { ...m.task, board, createdFromTask, parents, idempotencyKey: null, createdBy: instance.createdBy, createdVia: instance.createdVia },
```

with:

```ts
        {
          ...m.task,
          board,
          createdFromTask,
          parents,
          idempotencyKey: null,
          createdBy: instance.createdBy,
          createdVia: instance.createdVia,
          ...(instance.follow === undefined ? {} : { follow: instance.follow }),
        },
```

In `src/db/kanban.ts`, replace:

```ts
      member.run(taskId, instanceId, m.ref, m.step, m.item === null ? null : mask(m.item), position);
      ids.push(taskId);
    }
```

with:

```ts
      member.run(taskId, instanceId, m.ref, m.step, m.item === null ? null : mask(m.item), position);
      ids.push(taskId);
    }
    const first = ids[0];
    if (instance.follow !== undefined && first !== undefined) {
      const human = (a: Assignee | null | undefined): boolean => a?.kind === 'human';
      record(
        d,
        {
          taskId: first,
          kind: 'workflow_started',
          actor: instance.createdBy,
          payload: {
            workflow: instanceId,
            workflowName: instance.name,
            board,
            by: instance.createdBy,
            count: members.length,
            people: members.some((m) => human(m.task.assignee) || human(m.task.reviewer)),
            tasks: members.slice(0, STARTED_TASKS).map((m, i) => ({
              taskId: ids[i],
              title: m.task.title,
              assignee: m.task.assignee?.name ?? null,
              assigneeKind: m.task.assignee?.kind ?? null,
            })),
          },
        },
        now,
      );
    }
```

In `src/kanban/chat-render.ts`, replace:

```ts
 * terminal made for a chat to follow is announced there by its "Created" line.
```

with:

```ts
 * terminal made for a chat to follow is announced there by its "Created" line,
 * and a workflow a terminal started by its start's reply.
```

In `src/kanban/chat-render.ts`, replace:

```ts
    runAssignee?: (runId: string) => Assignee | undefined;
```

with:

```ts
    runAssignee?: (runId: string) => Assignee | undefined;
    /** Whether the notice goes to a thread with a root or to the chat, for a start's reply's words; the chat's unless given. */
    where?: 'thread' | 'chat';
```

In `src/kanban/chat-render.ts`, replace:

```ts
      return `Created ${id(task.taskId)} **${label(task.title)}**, for ${whose}, by ${label(text(p, 'by'), 80)} from a terminal.`;
    }
    default:
```

with:

```ts
      return `Created ${id(task.taskId)} **${label(task.title)}**, for ${whose}, by ${label(text(p, 'by'), 80)} from a terminal.`;
    }
    case 'workflow_started':
      // A terminal start's reply (workflows spec §18.2), on its first member, whole: it may run to 3,800 characters.
      return renderStarted(startedOf(p), opts.where ?? 'chat', (a) => whom(a, opts.nameOf));
    default:
```

In `src/kanban/chat-render.ts`, replace:

```ts
export function fitted(head: readonly string[], lines: readonly string[], tail: readonly string[], more: (n: number) => string): string {
  let kept = Math.min(lines.length, WORKFLOW_REPLY_TASKS);
  const render = (n: number): string =>
    [...head, ...lines.slice(0, n), ...(n < lines.length ? [more(lines.length - n)] : []), ...tail].join('\n');
```

with:

```ts
export function fitted(
  head: readonly string[],
  lines: readonly string[],
  tail: readonly string[],
  more: (n: number) => string,
  total = lines.length,
): string {
  let kept = Math.min(lines.length, WORKFLOW_REPLY_TASKS);
  // `total` counts what `lines` left out already: a start's payload holds its first 30 members of more.
  const render = (n: number): string => [...head, ...lines.slice(0, n), ...(n < total ? [more(total - n)] : []), ...tail].join('\n');
```

In `src/kanban/chat-render.ts`, replace:

```ts
/**
 * A start's reply (workflows spec §9): the instance, one line a task in position order
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
```

with:

```ts
/** A member as a start's reply lists it: flat, as a task row keeps it, and as `workflow_started`'s payload holds it. */
export interface StartedTask {
  taskId: string;
  title: string;
  assignee: string | null;
  assigneeKind: 'role' | 'human' | null;
}

/** What a start's reply says (workflows spec §9, §18.2): from chat's rows, or from a terminal start's `workflow_started`. */
export interface StartedReply {
  instance: { instanceId: string; name: string | null; board: string };
  /** The members in position order: all of them from chat's rows, the first 30 from a payload. */
  tasks: readonly StartedTask[];
  /** How many members the instance has. */
  count: number;
  /** Whether any member names a person, as assignee or reviewer. */
  people: boolean;
  /** Who started it at a terminal, as nobody in the chat typed it; absent for a chat's own start. */
  by?: string;
}

/** A start's reply from what the start made, as chat's start builds it. */
export function startedReply(made: { instance: { instanceId: string; name: string | null; board: string }; tasks: readonly { task: TaskRow }[] }): StartedReply {
  return {
    instance: made.instance,
    tasks: made.tasks.map(({ task }) => ({ taskId: task.taskId, title: task.title, assignee: task.assignee?.name ?? null, assigneeKind: task.assignee?.kind ?? null })),
    count: made.tasks.length,
    people: made.tasks.some(({ task }) => task.assignee?.kind === 'human' || task.reviewer?.kind === 'human'),
  };
}

/** A `workflow_started` payload as a reply, read from the payload alone: the notifier reads no workflow table (workflows spec §18.2). */
function startedOf(p: Record<string, unknown>): StartedReply {
  const tasks = (Array.isArray(p['tasks']) ? p['tasks'] : []).flatMap((raw): StartedTask[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const t = raw as Record<string, unknown>;
    const kind = t['assigneeKind'] === 'human' || t['assigneeKind'] === 'role' ? t['assigneeKind'] : null;
    return [{ taskId: text(t, 'taskId'), title: text(t, 'title'), assignee: typeof t['assignee'] === 'string' ? t['assignee'] : null, assigneeKind: kind }];
  });
  return {
    instance: { instanceId: text(p, 'workflow'), name: typeof p['workflowName'] === 'string' ? p['workflowName'] : null, board: text(p, 'board') || DEFAULT_BOARD },
    tasks,
    count: typeof p['count'] === 'number' ? p['count'] : tasks.length,
    people: p['people'] === true,
    by: text(p, 'by'),
  };
}

/**
 * A start's reply (workflows spec §9): the instance, one line a task in position order
 * with its id, its title and its assignee, and who hears, in the words of the
 * thread or of the chat. A terminal's names who started it (§18.2).
 */
export function renderStarted(reply: StartedReply, where: 'thread' | 'chat', whom: (a: Assignee) => string): string {
  const { instance, tasks, count: n } = reply;
  const board = instance.board === DEFAULT_BOARD ? '' : `, on board **${label(instance.board)}**`;
  const lines = tasks.map((t) => {
    const assignee = t.assignee === null ? 'nobody yet' : whom({ kind: t.assigneeKind === 'human' ? 'human' : 'role', name: t.assignee });
    return `- ${id(t.taskId)} ${label(t.title, WORKFLOW_TITLE_MAX)}, for ${assignee}`;
  });
  const started = `${label(workflowName(instance.name))} ${reply.by === undefined ? 'as' : 'from a terminal as'} ${id(instance.instanceId)}`;
  const head = reply.by === undefined ? `Started ${started}` : `${label(reply.by, 80)} started ${started}`;
  const cards =
    !reply.people
      ? ''
      : where === 'thread'
        ? " A person's card comes in this thread when their task is ready, or by direct message if they are not in this group."
        : ' A person is sent their card by direct message once their task is ready.';
  return fitted(
    [`${head}, ${n} task${n === 1 ? '' : 's'}${board}:`],
    lines,
    [
      `${where === 'thread' ? 'This thread' : 'This chat'} hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.${cards}`,
    ],
    (more) => `… and ${more} more: \`/kanban workflow show ${instance.instanceId}\` lists them all.`,
    n,
```

In `src/kanban/chat.ts`, replace:

```ts
  renderHelp,
  renderInstance,
  renderInstances,
  renderList,
  renderPreview,
  renderStarted,
  renderWorkflows,
  renderReviewCard,
  renderShow,
  renderTaskCard,
  type CardFacts,
} from './chat-render.js';
```

with:

```ts
  renderHelp,
  renderInstance,
  renderInstances,
  renderList,
  renderPreview,
  renderStarted,
  startedReply,
  renderWorkflows,
  renderReviewCard,
  renderShow,
  renderTaskCard,
  type CardFacts,
} from './chat-render.js';
```

In `src/kanban/chat.ts`, replace:

```ts
    return renderStarted(made, where, (a) => this.#whom(a));
```

with:

```ts
    return renderStarted(startedReply(made), where, (a) => this.#whom(a));
```

In `src/kanban/notices.ts`, replace:

```ts
        pending.push(this.#read(sub));
```

with:

```ts
        pending.push(this.#read(sub, c.target.threadId !== '' && c.target.root !== undefined ? 'thread' : 'chat'));
```

In `src/kanban/notices.ts`, replace:

```ts
  /** A subscription's events past its cursor, and the notices among them. */
  #read(sub: SubscriptionRow): Pending {
    const task = getTask(this.#deps.db, sub.taskId);
    if (task === undefined) throw new TaskGone(`task ${sub.taskId} is not on the board`);
    const events = eventsAfter(this.#deps.db, sub.taskId, sub.cursor, ROUND_EVENTS);
    const notices: Pending['notices'] = [];
    for (const event of events) {
      const text = renderNotice(event, task, {
        blockRecurrenceLimit: this.#deps.blockRecurrenceLimit,
        runAssignee: (runId) => getRun(this.#deps.db, runId)?.assignee,
```

with:

```ts
  /** A subscription's events past its cursor, and the notices among them, worded for a thread with a root or for the chat. */
  #read(sub: SubscriptionRow, where: 'thread' | 'chat'): Pending {
    const task = getTask(this.#deps.db, sub.taskId);
    if (task === undefined) throw new TaskGone(`task ${sub.taskId} is not on the board`);
    const events = eventsAfter(this.#deps.db, sub.taskId, sub.cursor, ROUND_EVENTS);
    const notices: Pending['notices'] = [];
    for (const event of events) {
      const text = renderNotice(event, task, {
        blockRecurrenceLimit: this.#deps.blockRecurrenceLimit,
        runAssignee: (runId) => getRun(this.#deps.db, runId)?.assignee,
        where,
```

In `src/kanban/service.ts`, replace:

```ts
  type BoardRow,
  type ChatAt,
  type CommentRow,
  type CreateRequest,
  type CreatedVia,
  type GateRow,
  type Phase,
  type Refusal,
  type Rendering,
  type ReportedBlockKind,
```

with:

```ts
  type BoardRow,
  type ChatAt,
  type CommentRow,
  type CreateRequest,
  type CreatedVia,
  type Follow,
  type GateRow,
  type Phase,
  type Refusal,
  type Rendering,
  type ReportedBlockKind,
```

In `src/kanban/service.ts`, replace:

```ts
  /** Chat's board, or the terminal's `--board`, else `default`; a run's is its task's, whatever this says. */
  board?: string;
}
```

with:

```ts
  /** Chat's board, or the terminal's `--board`, else `default`; a run's is its task's, whatever this says. */
  board?: string;
  /** The chat that follows every member, named at the terminal (workflows spec §18.1); the operator's alone. */
  follow?: Follow;
}
```

In `src/kanban/service.ts`, replace:

```ts
  createdVia: CreatedVia;
}
```

with:

```ts
  createdVia: CreatedVia;
  /** As a start's: not a key of the DAG, so its hash is the same wherever it is heard (workflows spec §18.1). */
  follow?: Follow;
}
```

In `src/kanban/service.ts`, replace:

```ts
    if (!isText(req.workflow)) return board.refuse('invalid', "a workflow is a workflow's name, as text");
    const on = this.#boardFor(req.createdVia, req.board);
```

with:

```ts
    if (!isText(req.workflow)) return board.refuse('invalid', "a workflow is a workflow's name, as text");
    const follow = followRefused(req.follow, req.createdVia);
    if (follow !== undefined) return follow;
    const on = this.#boardFor(req.createdVia, req.board);
```

In `src/kanban/service.ts`, replace:

```ts
    return this.#write(shaped, { name: shaped.workflow.name, source: 'start', board: on.board, key: key.key, createdBy: req.createdBy, createdVia: req.createdVia });
```

with:

```ts
    return this.#write(shaped, {
      name: shaped.workflow.name,
      source: 'start',
      board: on.board,
      key: key.key,
      createdBy: req.createdBy,
      createdVia: req.createdVia,
      ...(req.follow === undefined ? {} : { follow: req.follow }),
    });
```

In `src/kanban/service.ts`, replace:

```ts
    if (!shaped.ok) return shaped;
    const on = this.#boardFor(req.createdVia, shaped.dag.board);
```

with:

```ts
    if (!shaped.ok) return shaped;
    const follow = followRefused(req.follow, req.createdVia);
    if (follow !== undefined) return follow;
    const on = this.#boardFor(req.createdVia, shaped.dag.board);
```

In `src/kanban/service.ts`, replace:

```ts
    return this.#write(shaped, { name: shaped.dag.workflow, source: 'apply', board: on.board, key: key.key, createdBy: req.createdBy, createdVia: req.createdVia });
```

with:

```ts
    return this.#write(shaped, {
      name: shaped.dag.workflow,
      source: 'apply',
      board: on.board,
      key: key.key,
      createdBy: req.createdBy,
      createdVia: req.createdVia,
      ...(req.follow === undefined ? {} : { follow: req.follow }),
    });
```

In `src/kanban/service.ts`, replace:

```ts
    i: { name: string | null; source: 'start' | 'apply'; board: string; key: string | null; createdBy: string; createdVia: CreatedVia },
```

with:

```ts
    i: { name: string | null; source: 'start' | 'apply'; board: string; key: string | null; createdBy: string; createdVia: CreatedVia; follow?: Follow },
```

In `src/kanban/service.ts`, replace:

```ts
        idempotencyKey: i.key,
```

with:

```ts
        idempotencyKey: i.key,
        ...(i.follow === undefined ? {} : { follow: i.follow }),
```

- [ ] **Step 8.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2531 passed (2531)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.5: Commit.**

```bash
git add src/db/WRITERS.md src/db/kanban.ts src/kanban/chat-render.ts src/kanban/chat.ts src/kanban/notices.ts src/kanban/service.ts tests/kanban-workflow-chat.test.ts tests/kanban-workflow-started.test.ts
git commit -m "Follow every member of a workflow a terminal starts or applies from the chat it names, and queue the start's reply as workflow_started on the first member, rendered by the notifier from its payload with chat's own renderer, whole, before any member's notice"
```

---

### Task 9: `--chat` and `--thread` at the terminal

**Files:**

- Create: `tests/mt-terminal-chat.test.ts`
- Modify: `src/cli/gate.ts`, `src/cli/mt.ts`, `src/cli/operator.ts`, `src/kanban/service.ts`, `tests/mt-kanban-operator-tasks.test.ts`, `tests/mt-kanban-workflow.test.ts`

§22.1, workflows §18.1. `task new`, `workflow start` and `workflow apply` take `--chat oc_… [--thread omt_…]`; `preview` refuses them. The order is §22.1's: the shapes as the command line is read, the app id and `auth.chats` through `openBoard`'s new `check`, before the database is opened; then the key, by `keyMade`; then, for what is not made yet, the thread's root by `threadRoot`, a thread with none refused. A repeat passes no `follow`, and its answer's `follows` is the stored subscription (`followOf`). `apply --dry-run` makes the same checks, writes nothing, and says who would follow. `USAGE` and the two tests that read the old answers change.

- [ ] **Step 9.1: Write the tests.**

In `tests/mt-kanban-operator-tasks.test.ts`, replace:

```ts
    expect(JSON.parse(json.out)).toEqual({ ok: true, task_id: taskId, board: 'default', existing: true, nudged: false });
```

with:

```ts
    expect(JSON.parse(json.out)).toEqual({ ok: true, task_id: taskId, board: 'default', existing: true, nudged: false, follows: null });
```

In `tests/mt-kanban-workflow.test.ts`, replace:

```ts
    expect(usage).toContain('  mt kanban workflow apply <dag.json|-> [--key <key>] [--dry-run] [--json]');
```

with:

```ts
    expect(usage).toContain('  mt kanban workflow apply <dag.json|-> [--key <key>] [--dry-run] [--chat <chat_id> [--thread <thread_id>]] [--json]');
```

Create `tests/mt-terminal-chat.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `--chat oc_… [--thread omt_…]` on `mt kanban task new`, `workflow start` and
 * `workflow apply` (kanban spec §22.1, workflows spec §18.1): the shapes, the
 * app id and auth.chats checked before the board is opened, a repeat by key
 * included; then the key; then, for what is not made yet, the thread's root.
 * The answer says who follows, a repeat its stored subscription.
 */

let fx: MtFixture;
let db: Db;
let server: WorkerServer | undefined;

afterEach(async () => {
  clearSecrets();
  await server?.close();
  server = undefined;
  db?.close();
  fx?.cleanup();
});

/** A home with an app id, the board on and a gateway taking nudges; a thread omt_topic in oc_team whose root a chat's task recorded. */
async function setup(lines: string[] = ['lark:', '  appId: cli_app', 'kanban:', '  enabled: true']): Promise<void> {
  clearSecrets();
  fx = mtFixture((ws) => [`workspace: ${ws}`, ...lines, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  newTask(db, { createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' } });
  mkdirSync(join(fx.home, 'workflows'));
  writeFileSync(
    join(fx.home, 'workflows', 'brief.yaml'),
    'params:\n  topic: { required: true }\nsteps:\n  a: { title: "Brief on {{topic}}", assignee: default }\n  b: { parents: [a], title: "Check the brief on {{topic}}", assignee: default }\n',
  );
  server = await listenWorker(workerSocketPath(fx.home), () => ({ ok: true }));
}

const kanban = (argv: string[], env: Record<string, string | undefined> = {}) => fx.run(['kanban', ...argv], { env });
const subs = (taskId: string) => subscriptionsOf(db, taskId).map((s) => [s.channel, s.appId, s.conversationId, s.threadId, s.rootMessageId]);
const OUTSIDE = 'oc_team is not in auth.chats, so this gateway does not act in it: add it there, or name a chat that is';

describe('mt kanban task new --chat', () => {
  it('follows the new task from the chat, and says so', async () => {
    await setup();
    const r = await kanban(['task', 'new', 'Book the venue', '--assignee', 'default', '--chat', 'oc_team']);
    expect(r.code, r.err).toBe(0);
    const id = /^created (k_[0-9a-z]+): /.exec(r.out)?.[1] ?? '';
    expect(r.out).toBe(`created ${id}: Book the venue, for role default, on board default; chat oc_team follows it`);
    expect(subs(id)).toEqual([['lark', 'cli_app', 'oc_team', '', null]]);
    expect(eventsOf(db, id).map((e) => e.kind)).toEqual(['created', 'task_created_followed']);
    const json = JSON.parse((await kanban(['task', 'new', 'Order food', '--chat', 'oc_team', '--json'])).out);
    expect(json).toMatchObject({ ok: true, existing: false, follows: { chat: 'oc_team', thread: null } });
    expect(JSON.parse((await kanban(['task', 'new', 'Alone', '--json'])).out)).toMatchObject({ ok: true, follows: null });
  });

  it("follows in a thread with the root the board knows, and refuses a thread it has none for", async () => {
    await setup();
    const r = await kanban(['task', 'new', 'Book the venue', '--chat', 'oc_team', '--thread', 'omt_topic', '--json']);
    const id = JSON.parse(r.out).task_id as string;
    expect(JSON.parse(r.out)).toMatchObject({ follows: { chat: 'oc_team', thread: 'omt_topic' } });
    expect(subs(id)).toEqual([['lark', 'cli_app', 'oc_team', 'omt_topic', 'om_root']]);
    expect((await kanban(['task', 'new', 'Again', '--chat', 'oc_team', '--thread', 'omt_topic'])).out).toMatch(/; chat oc_team follows it, in thread omt_topic$/);
    const before = db.prepare('SELECT count(*) AS n FROM kanban_tasks').get();
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--thread', 'omt_other'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: no root is known for thread omt_other in oc_team: the board learns a thread\'s root when a task is made in it from chat; give --chat alone to follow from the chat',
    });
    expect(db.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual(before);
  });

  it('refuses a malformed chat or thread, and --thread without --chat, as a wrong command line', async () => {
    await setup();
    const usage = async (argv: string[]) => {
      const r = await kanban(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      return r.err.split('\n')[0];
    };
    expect(await usage(['task', 'new', 'x', '--chat', 'team'])).toBe('mt: --chat takes a chat id as Lark gives one, oc_…, not "team"');
    expect(await usage(['task', 'new', 'x', '--chat', 'oc_team', '--thread', 'topic'])).toBe('mt: --thread takes a thread id as Lark gives one, omt_…, not "topic"');
    expect(await usage(['task', 'new', 'x', '--thread', 'omt_topic'])).toBe('mt: --thread needs --chat: it names a thread of that chat');
  });

  it('refuses before the board is opened with no app id, or a chat outside a non-empty auth.chats; any chat with an empty one', async () => {
    await setup(['kanban:', '  enabled: true']);
    const nowhere = { MT_DB: join(fx.root, 'none.db') };
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team'], nowhere)).toEqual({ code: 1, out: '', err: 'mt: --chat needs the bot: set lark.appId in the config file, or LARK_APP_ID' });
    const app = { ...nowhere, LARK_APP_ID: 'cli_app', MT_ALLOW_CHATS: 'oc_other' };
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team'], app)).toEqual({ code: 1, out: '', err: `mt: ${OUTSIDE}` });
    expect(JSON.parse((await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--json'], app)).out)).toEqual({ ok: false, code: 'invalid', message: OUTSIDE });
    expect((await kanban(['task', 'new', 'x', '--chat', 'oc_team'], { ...app, MT_DB: undefined, MT_ALLOW_CHATS: 'oc_team,oc_other' })).code).toBe(0);
    expect((await kanban(['task', 'new', 'x', '--chat', 'oc_anywhere'], { LARK_APP_ID: 'cli_app' })).code).toBe(0);
  });

  it('answers a repeat by key with the first task and its stored chat, adding nothing, and refuses one whose chat has left auth.chats', async () => {
    await setup();
    const first = JSON.parse((await kanban(['task', 'new', 'Weekly', '--chat', 'oc_team', '--thread', 'omt_topic', '--key', 'w47', '--json'])).out);
    // The thread's root is lost: a repeat is answered all the same, as the root is looked up only for a task not yet made.
    db.prepare('UPDATE kanban_subscriptions SET root_message_id = NULL').run();
    const again = await kanban(['task', 'new', 'Weekly', '--chat', 'oc_other', '--thread', 'omt_topic', '--key', 'w47', '--json']);
    expect(JSON.parse(again.out)).toEqual({ ok: true, task_id: first.task_id, board: 'default', existing: true, nudged: false, follows: { chat: 'oc_team', thread: 'omt_topic' } });
    expect((await kanban(['task', 'new', 'Weekly', '--key', 'w47'])).out).toMatch(/; nothing new was created; chat oc_team follows it, in thread omt_topic$/);
    expect(subscriptionsOf(db, first.task_id)).toHaveLength(1);
    expect(eventsOf(db, first.task_id).filter((e) => e.kind === 'task_created_followed')).toHaveLength(1);
    expect((await kanban(['task', 'new', 'Weekly', '--chat', 'oc_team', '--key', 'w47'], { MT_ALLOW_CHATS: 'oc_other' })).err).toBe(`mt: ${OUTSIDE}`);
    const plain = JSON.parse((await kanban(['task', 'new', 'Plain', '--key', 'p1', '--json'])).out);
    expect(JSON.parse((await kanban(['task', 'new', 'Plain', '--key', 'p1', '--json'])).out)).toMatchObject({ task_id: plain.task_id, existing: true, follows: null });
  });

  it('writes the subscription and its event with the board off, and is refused in an agent\'s shell', async () => {
    await setup(['lark:', '  appId: cli_app']);
    const r = await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--json']);
    expect(r.err).toMatch(/^mt: the board is off on this gateway/);
    expect(subs(JSON.parse(r.out).task_id)).toHaveLength(1);
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team'], { MT_KANBAN_RUN: 'r_1' })).toMatchObject({ code: 1, err: expect.stringMatching(/is an operator's command, not an agent's/) });
  });
});

describe('mt kanban workflow start and apply --chat', () => {
  it('follows every member and says the chat is sent the reply; a repeat its stored chat', async () => {
    await setup();
    const r = await kanban(['workflow', 'start', 'brief', '--param', 'topic=logs', '--chat', 'oc_team', '--key', 'b1']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n').at(-1)).toBe("chat oc_team follows its tasks, and is sent the start's reply");
    const json = JSON.parse((await kanban(['workflow', 'start', 'brief', '--param', 'topic=logs', '--chat', 'oc_other', '--key', 'b1', '--json'])).out);
    expect(json).toMatchObject({ ok: true, existing: true, follows: { chat: 'oc_team', thread: null } });
    for (const t of json.tasks as Array<{ task_id: string }>) expect(subs(t.task_id)).toEqual([['lark', 'cli_app', 'oc_team', '', null]]);
    expect((await kanban(['workflow', 'start', 'brief', '--param', 'topic=logs', '--key', 'b1'])).out.split('\n').at(-1)).toBe('chat oc_team follows its tasks');
    const none = JSON.parse((await kanban(['workflow', 'start', 'brief', '--param', 'topic=db', '--json'])).out);
    expect(none.follows).toBeNull();
  });

  it('applies with a thread, refuses a thread with no root, and checks before the board is opened', async () => {
    await setup();
    const file = join(fx.root, 'dag.json');
    writeFileSync(file, JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'default' }] }));
    const r = JSON.parse((await kanban(['workflow', 'apply', file, '--chat', 'oc_team', '--thread', 'omt_topic', '--json'])).out);
    expect(r).toMatchObject({ ok: true, existing: false, follows: { chat: 'oc_team', thread: 'omt_topic' } });
    expect(subs(r.tasks[0].task_id)).toEqual([['lark', 'cli_app', 'oc_team', 'omt_topic', 'om_root']]);
    expect((await kanban(['workflow', 'apply', file, '--chat', 'oc_team', '--thread', 'omt_lost'])).err).toMatch(/^mt: no root is known for thread omt_lost in oc_team/);
    expect(await kanban(['workflow', 'start', 'brief', '--param', 'topic=x', '--chat', 'oc_team'], { MT_ALLOW_CHATS: 'oc_other', MT_DB: join(fx.root, 'none.db') })).toEqual({ code: 1, out: '', err: `mt: ${OUTSIDE}` });
    expect((await kanban(['workflow', 'apply', file, '--chat', 'nope'])).code).toBe(2);
  });

  it('dry-runs with the flags, writing nothing and saying who would follow; refuses them on a preview', async () => {
    await setup();
    const file = join(fx.root, 'dag.json');
    writeFileSync(file, JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'default' }] }));
    const count = () => db.prepare('SELECT count(*) AS n FROM kanban_subscriptions').get();
    const before = count();
    const dry = await kanban(['workflow', 'apply', file, '--dry-run', '--chat', 'oc_team']);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out.split('\n').at(-1)).toBe("chat oc_team would follow its tasks, and be sent the start's reply");
    expect(JSON.parse((await kanban(['workflow', 'apply', file, '--dry-run', '--chat', 'oc_team', '--json'])).out)).toMatchObject({ dry_run: true, follows: { chat: 'oc_team', thread: null } });
    expect((await kanban(['workflow', 'apply', file, '--dry-run', '--chat', 'oc_team', '--thread', 'omt_lost'])).err).toMatch(/^mt: no root is known/);
    expect(count()).toEqual(before);
    for (const flags of [['--chat', 'oc_team'], ['--thread', 'omt_topic']]) {
      const r = await kanban(['workflow', 'preview', 'brief', '--param', 'topic=x', ...flags]);
      expect(r.code).toBe(2);
      expect(r.err.split('\n')[0]).toBe("mt: --chat is start's and apply's: a preview makes nothing to follow");
    }
  });
});
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-kanban-operator-tasks.test.ts tests/mt-kanban-workflow.test.ts tests/mt-terminal-chat.test.ts`. Expected: `Tests  11 failed | 38 passed (49)`; among the failures, `mt: Unknown option '--chat'`.

- [ ] **Step 9.3: Implement.**

In `src/cli/gate.ts`, replace:

```ts
  kanbanEnabled: boolean | undefined;
```

with:

```ts
  kanbanEnabled: boolean | undefined;
  /** The bot's app id, as this shell's settings give it: the account of a chat `--chat` names (kanban spec §22.1). */
  appId: string | undefined;
```

In `src/cli/gate.ts`, replace:

```ts
  workflows?: boolean;
```

with:

```ts
  workflows?: boolean;
  /**
   * What the command checks of the settings before the database is opened, a
   * refusal or undefined: `--chat`'s app id and `auth.chats` (kanban spec §22.1),
   * so they refuse even a repeat by key.
   */
  check?: (settings: TeamSettings) => { code: string; message: string } | undefined;
```

In `src/cli/gate.ts`, replace:

```ts
  const { settings, team } = loaded;
```

with:

```ts
  const { settings, team } = loaded;
  const early = opts.check?.(settings);
  if (early !== undefined) return no(early.code, early.message);
```

In `src/cli/gate.ts`, replace:

```ts
  return { service, home: settings.home, kanbanEnabled: settings.kanbanEnabled, peopleMissing, seen, close: () => db.close() };
```

with:

```ts
  return { service, home: settings.home, kanbanEnabled: settings.kanbanEnabled, appId, peopleMissing, seen, close: () => db.close() };
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban task new <title> [--board <name>] [--assignee <role>] [--reviewer <role>] [--workspace <name>]',
  '      [--parent <task>]... [--outcome "..."] [--verify "..."] [--constraints "..."] [--boundaries "..."]',
  '      [--stop-when "..."] [--body "..." | --body-file <path|->] [--key <key>] [--json]',
  `  mt kanban task list [${LIST_FILTERS.join('|')}] [--board <name>] [--json]`,
  '  mt kanban task show <task_id> [--board <name>] [--json]',
  '  mt kanban task assign <task_id> <role> [--board <name>] [--json]',
```

with:

```ts
  '  mt kanban task new <title> [--board <name>] [--assignee <role|lark:<union_id>>] [--reviewer <role|lark:<union_id>>]',
  '      [--workspace <name>] [--parent <task>]... [--outcome "..."] [--verify "..."] [--constraints "..."] [--boundaries "..."]',
  '      [--stop-when "..."] [--body "..." | --body-file <path|->] [--key <key>] [--chat <chat_id> [--thread <thread_id>]] [--json]',
  `  mt kanban task list [${LIST_FILTERS.join('|')}] [--board <name>] [--json]`,
  '  mt kanban task show <task_id> [--board <name>] [--json]',
  '  mt kanban task assign <task_id> <role|lark:<union_id>> [--board <name>] [--json]',
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban workflow start <name> [--board <name>] [--param <key>=<value>]... [--key <key>] [--json]',
  '  mt kanban workflow apply <dag.json|-> [--key <key>] [--dry-run] [--json]',
```

with:

```ts
  '  mt kanban workflow start <name> [--board <name>] [--param <key>=<value>]... [--key <key>]',
  '      [--chat <chat_id> [--thread <thread_id>]] [--json]',
  '  mt kanban workflow apply <dag.json|-> [--key <key>] [--dry-run] [--chat <chat_id> [--thread <thread_id>]] [--json]',
```

In `src/cli/operator.ts`, replace:

```ts
import { DAG_LIMITS, checkDagShape, checkDagTasks, dagFile } from '../kanban/dag.js';
import { NO_MENTIONS } from '../kanban/task-checks.js';
import { WORKFLOW_MESSAGE_BYTES, type KanbanService, type WorkflowMade } from '../kanban/service.js';
import { expand, listWorkflows, paramsLine, readWorkflow, usableMessage } from '../kanban/workflow.js';
import { maskAll, NUDGE, workerSocketPath } from '../kanban/socket.js';
import { DEFAULT_BOARD, type BoardRow, type Contract, type Refusal, type Waiting } from '../kanban/types.js';
import { WORKER_LIMITS } from '../kanban/limits.js';
import { visible } from '../names.js';
import { parse, UsageError } from './args.js';
import { loadOperator, operatorName, personHint, withBoard, type BoardAccess, type PeopleMissing } from './gate.js';
```

with:

```ts
import { CHAT_ID, NEEDS_BOT, THREAD_ID, chatRefused } from '../core/lark-ids.js';
import { DAG_LIMITS, checkDagShape, checkDagTasks, dagFile } from '../kanban/dag.js';
import { NO_MENTIONS } from '../kanban/task-checks.js';
import { WORKFLOW_MESSAGE_BYTES, type KanbanService, type WorkflowMade } from '../kanban/service.js';
import { expand, listWorkflows, paramsLine, readWorkflow, usableMessage } from '../kanban/workflow.js';
import { maskAll, NUDGE, workerSocketPath } from '../kanban/socket.js';
import { DEFAULT_BOARD, type BoardRow, type Contract, type CreatedVia, type Follow, type Refusal, type Waiting } from '../kanban/types.js';
import { WORKER_LIMITS } from '../kanban/limits.js';
import { visible } from '../names.js';
import { parse, UsageError } from './args.js';
import { loadOperator, operatorName, personHint, withBoard, type BoardAccess, type OpenOptions, type PeopleMissing } from './gate.js';
```

In `src/cli/operator.ts`, replace:

```ts
  opts: { workflows?: boolean } = {},
```

with:

```ts
  opts: { workflows?: boolean; check?: OpenOptions['check'] } = {},
```

In `src/cli/operator.ts`, replace:

```ts
    { refuse: no, unsetNote: 'those values are not masked here', ...(opts.workflows === true ? { workflows: true } : {}) },
```

with:

```ts
    {
      refuse: no,
      unsetNote: 'those values are not masked here',
      ...(opts.workflows === true ? { workflows: true } : {}),
      ...(opts.check === undefined ? {} : { check: opts.check }),
    },
```

In `src/cli/operator.ts`, replace:

```ts

/** One task id, and nothing else. */
```

with:

```ts

/** `--chat` and `--thread`: a chat a terminal names to follow what it makes (kanban spec §22.1, workflows spec §18.1). */
const FOLLOW_FLAGS = { chat: { type: 'string' }, thread: { type: 'string' } } as const;

/** The chat and the thread the flags name, `''` at chat scope. */
interface ChatFlags {
  chat: string;
  thread: string;
}

/** A chat that follows something, as an answer says it: the thread null at chat scope. */
type Follows = { chat: string; thread: string | null } | null;

/** The operator, as the service namespaces a key for them. */
const OPERATOR: CreatedVia = { kind: 'operator' };

/** `--chat` and `--thread`, checked for shape as `mt cron add --chat` checks a chat; undefined without `--chat`. */
function chatFlags(values: { chat?: string | undefined; thread?: string | undefined }): ChatFlags | undefined {
  const { chat, thread } = values;
  if (chat === undefined) {
    if (thread !== undefined) throw new UsageError('--thread needs --chat: it names a thread of that chat');
    return undefined;
  }
  if (!CHAT_ID.test(chat)) throw new UsageError(`--chat takes a chat id as Lark gives one, oc_…, not ${JSON.stringify(chat)}`);
  if (thread !== undefined && !THREAD_ID.test(thread)) throw new UsageError(`--thread takes a thread id as Lark gives one, omt_…, not ${JSON.stringify(thread)}`);
  return { chat, thread: thread ?? '' };
}

/**
 * What a `--chat` needs of the settings, checked before the board is opened, so
 * a repeat by key is refused too: the bot's app id, and a chat in a non-empty
 * `auth.chats` (kanban spec §22.1).
 */
function chatCheck(flags: ChatFlags | undefined): OpenOptions['check'] {
  if (flags === undefined) return undefined;
  return (settings) => {
    if (settings.appId === undefined) return { code: 'invalid', message: NEEDS_BOT };
    const outside = chatRefused(flags.chat, settings.chats ?? []);
    return outside === undefined ? undefined : { code: 'invalid', message: outside };
  };
}

/**
 * The follow for something not made yet: at chat scope, or in a thread with the
 * root the board knows for it, as the notifier finds one (spec §19.7). A thread
 * with none is refused: a terminal has no message to reply to, and opens none.
 */
function followFor(service: KanbanService, board: BoardAccess, flags: ChatFlags): Follow | Outcome {
  const appId = board.appId ?? '';
  if (flags.thread === '') return { appId, chatId: flags.chat, threadId: '', rootId: null };
  const root = service.threadRoot({ channel: 'lark', appId, conversationId: flags.chat, threadId: flags.thread });
  if (root === undefined) {
    return refused({
      code: 'invalid',
      message: `no root is known for thread ${flags.thread} in ${flags.chat}: the board learns a thread's root when a task is made in it from chat; give --chat alone to follow from the chat`,
    });
  }
  return { appId, chatId: flags.chat, threadId: flags.thread, rootId: root };
}

/**
 * The follow a command passes, or a refusal: none without `--chat`, and none
 * for a key that has made its task or instance already, which is answered
 * before its thread's root is looked up (kanban spec §22.1).
 */
function followOrRefusal(service: KanbanService, board: BoardAccess, flags: ChatFlags | undefined, key: string | undefined, what: 'task' | 'instance'): Follow | Outcome | undefined {
  if (flags === undefined || (key !== undefined && service.keyMade(key, OPERATOR, what))) return undefined;
  return followFor(service, board, flags);
}

/** What a new task's or instance's answer says follows it: the chat named, as passed. */
function followsOf(follow: Follow | undefined): Follows {
  return follow === undefined ? null : { chat: follow.chatId, thread: follow.threadId === '' ? null : follow.threadId };
}

/** A task's stored subscription of this bot: what a repeat's answer names, never the `--chat` given now. */
function storedFollows(service: KanbanService, board: BoardAccess, taskId: string | undefined): Follows {
  return board.appId === undefined || taskId === undefined ? null : service.followOf(taskId, board.appId);
}

/** `chat oc_… follows <what>`, with its thread, for an answer's line. */
function followsText(f: NonNullable<Follows>, what: string): string {
  return `chat ${f.chat} follows ${what}${f.thread === null ? '' : `, in thread ${f.thread}`}`;
}

/** One task id, and nothing else. */
```

In `src/cli/operator.ts`, replace:

```ts
  });
  const json = values.json === true;
```

with:

```ts
    ...FOLLOW_FLAGS,
  });
  const json = values.json === true;
  const flags = chatFlags(values);
```

In `src/cli/operator.ts`, replace:

```ts
  return act(io, json, 'mt kanban task new', (service, by) => {
    for (const name of [command.assignee, command.reviewer]) {
      const mention = name === undefined ? undefined : mentionRefused(name);
      if (mention !== undefined) return mention;
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
      ...(key === undefined ? {} : { idempotencyKey: key }),
      createdBy: by,
      createdVia: { kind: 'operator' },
    });
    if (!r.ok) return refused(r);
    const { task } = r;
    // The key's task, made by an earlier run of the command: nothing changed, so no nudge.
    if (r.existing) {
      return {
        ok: true,
        lines: [
          `task ${task.taskId} already exists with key ${line(key ?? '', 80)}: ${line(task.title)}` +
            `${task.phase === 'archived' ? ' (archived)' : ''}, on board ${line(task.board, 80)}; nothing new was created`,
        ],
        // Nothing changed, so the gateway was not asked to look.
        json: { task_id: task.taskId, board: task.board, existing: true, nudged: false },
      };
    }
    const whom = task.assignee === null ? `nobody yet (mt kanban task assign ${task.taskId} <role> gives it to someone)` : who(task.assignee);
    const where = task.workspace === null ? '' : `, in ${line(task.workspace, 80)}`;
    return {
      ok: true,
      lines: [`created ${task.taskId}: ${line(task.title)}, for ${whom}${where}, on board ${line(task.board, 80)}`],
      json: { task_id: task.taskId, board: task.board, existing: false },
      nudge: true,
      ...(key === undefined ? {} : { keyed: true }),
    };
  });
```

with:

```ts
  return act(
    io,
    json,
    'mt kanban task new',
    (service, by, b) => {
      for (const name of [command.assignee, command.reviewer]) {
        const mention = name === undefined ? undefined : mentionRefused(name);
        if (mention !== undefined) return mention;
      }
      const follow = followOrRefusal(service, b, flags, key, 'task');
      if (follow !== undefined && 'ok' in follow) return follow;
      const r = service.create({
        board,
        title: command.title,
        ...(command.body === '' ? {} : { body: command.body }),
        contract: command.contract,
        ...(command.assignee === undefined ? {} : { assignee: command.assignee }),
        ...(command.reviewer === undefined ? {} : { reviewer: command.reviewer }),
        ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
        ...(command.parents.length === 0 ? {} : { parents: command.parents }),
        ...(key === undefined ? {} : { idempotencyKey: key }),
        createdBy: by,
        createdVia: { kind: 'operator' },
        ...(follow === undefined ? {} : { follow }),
      });
      if (!r.ok) return refused(r);
      const { task } = r;
      // The key's task, made by an earlier run of the command: nothing changed, so no nudge.
      if (r.existing) {
        const follows = storedFollows(service, b, task.taskId);
        return {
          ok: true,
          lines: [
            `task ${task.taskId} already exists with key ${line(key ?? '', 80)}: ${line(task.title)}` +
              `${task.phase === 'archived' ? ' (archived)' : ''}, on board ${line(task.board, 80)}; nothing new was created` +
              `${follows === null ? '' : `; ${followsText(follows, 'it')}`}`,
          ],
          // Nothing changed, so the gateway was not asked to look.
          json: { task_id: task.taskId, board: task.board, existing: true, nudged: false, follows },
        };
      }
      const whom = task.assignee === null ? `nobody yet (mt kanban task assign ${task.taskId} <role> gives it to someone)` : who(task.assignee);
      const where = task.workspace === null ? '' : `, in ${line(task.workspace, 80)}`;
      const follows = followsOf(follow);
      return {
        ok: true,
        lines: [`created ${task.taskId}: ${line(task.title)}, for ${whom}${where}, on board ${line(task.board, 80)}${follows === null ? '' : `; ${followsText(follows, 'it')}`}`],
        json: { task_id: task.taskId, board: task.board, existing: false, follows },
        nudge: true,
        ...(key === undefined ? {} : { keyed: true }),
      };
    },
    { check: chatCheck(flags) },
  );
```

In `src/cli/operator.ts`, replace:

```ts
  const { values, positionals } = parse(rest, { ...BOARD_FLAGS, param: { type: 'string', multiple: true } });
  const [name, extra] = positionals;
  if (name === undefined || extra !== undefined) throw new UsageError('kanban workflow preview takes a workflow name');
```

with:

```ts
  const { values, positionals } = parse(rest, { ...BOARD_FLAGS, ...FOLLOW_FLAGS, param: { type: 'string', multiple: true } });
  const [name, extra] = positionals;
  if (name === undefined || extra !== undefined) throw new UsageError('kanban workflow preview takes a workflow name');
  if (values.chat !== undefined || values.thread !== undefined) throw new UsageError("--chat is start's and apply's: a preview makes nothing to follow");
```

In `src/cli/operator.ts`, replace:

```ts
/** `mt kanban workflow start <name> [--board] [--param k=v]… [--key] [--json]` (workflows spec §6). */
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
```

with:

```ts
/**
 * A start's or an apply's answer, with who follows its tasks (workflows spec §18.2): the chat named, sent the
 * start's reply; for a repeat, the first member's stored subscription, sent nothing.
 */
function madeAnswer(service: KanbanService, board: BoardAccess, r: WorkflowMade, follow: Follow | undefined, key: string | undefined): Done {
  const follows = r.existing ? storedFollows(service, board, r.tasks[0]?.taskId) : followsOf(follow);
  const said = follows === null ? [] : [r.existing ? followsText(follows, 'its tasks') : `${followsText(follows, 'its tasks')}, and is sent the start's reply`];
  return {
    ok: true,
    lines: [...madeText(r), ...said],
    json: { ...madeJson(r), follows },
    nudge: !r.existing,
    ...(key === undefined ? {} : { keyed: true }),
    makes: 'instance',
  };
}

/** `mt kanban workflow start <name> [--board] [--param k=v]… [--key] [--chat [--thread]] [--json]` (workflows spec §6, §18.1). */
function start(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, { ...BOARD_FLAGS, ...FOLLOW_FLAGS, param: { type: 'string', multiple: true }, key: { type: 'string' } });
  const [name, extra] = positionals;
  if (name === undefined || extra !== undefined) throw new UsageError('kanban workflow start takes a workflow name');
  const pairs = paramPairs(values.param);
  const boardName = boardFlag(values.board) ?? DEFAULT_BOARD;
  const key = keyFlag(values.key);
  const flags = chatFlags(values);
  return act(
    io,
    values.json === true,
    'mt kanban workflow start',
    (service, by, b) => {
      const follow = followOrRefusal(service, b, flags, key, 'instance');
      if (follow !== undefined && 'ok' in follow) return follow;
      const r = service.startWorkflow({
        workflow: name,
        params: { from: 'terminal', pairs },
        ...(key === undefined ? {} : { idempotencyKey: key }),
        createdBy: by,
        createdVia: { kind: 'operator' },
        board: boardName,
        ...(follow === undefined ? {} : { follow }),
      });
      if (!r.ok) return refused(r);
      return madeAnswer(service, b, r, follow, key);
    },
    { workflows: true, check: chatCheck(flags) },
```

In `src/cli/operator.ts`, replace:

```ts
/** `mt kanban workflow apply <dag.json|-> [--key] [--dry-run] [--json]` (workflows spec §6): the DAG's board, else `default`. */
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
      // Nothing written, so no nudge (workflows spec §6).
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
```

with:

```ts
/** `mt kanban workflow apply <dag.json|-> [--key] [--dry-run] [--chat [--thread]] [--json]` (workflows spec §6, §18.1): the DAG's board, else `default`. */
async function applyFile(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, { ...JSON_FLAG, ...FOLLOW_FLAGS, key: { type: 'string' }, 'dry-run': { type: 'boolean' } });
  const [file, extra] = positionals;
  if (file === undefined || extra !== undefined) throw new UsageError('kanban workflow apply takes a DAG file, or - for stdin');
  const json = values.json === true;
  const key = keyFlag(values.key);
  const dryRun = values['dry-run'] === true;
  const flags = chatFlags(values);
  const dag = await dagOf(file, io, json);
  if (typeof dag === 'number') return dag;
  return act(
    io,
    json,
    'mt kanban workflow apply',
    (service, by, b) => {
      const follow = followOrRefusal(service, b, flags, key, 'instance');
      if (follow !== undefined && 'ok' in follow) return follow;
      const r = service.applyDag({
        dag,
        ...(key === undefined ? {} : { idempotencyKey: key }),
        ...(dryRun ? { dryRun: true } : {}),
        createdBy: by,
        createdVia: { kind: 'operator' },
        ...(follow === undefined ? {} : { follow }),
      });
      if (!r.ok) return refused(r);
      if (!('dryRun' in r)) return madeAnswer(service, b, r, follow, key);
      // Nothing written, so no nudge (workflows spec §6); who would follow, or for its key's instance who does.
      const member = r.instanceId === null ? undefined : service.instance(r.instanceId);
      const follows = r.existing ? storedFollows(service, b, member?.ok === true ? member.view.members[0]?.taskId : undefined) : followsOf(follow);
      const said =
        follows === null
          ? []
          : [r.existing ? followsText(follows, 'its tasks') : `chat ${follows.chat} would follow its tasks${follows.thread === null ? '' : `, in thread ${follows.thread}`}, and be sent the start's reply`];
      return {
        ok: true,
        lines: [...dryRunText(r), ...said],
        json: {
          dry_run: true,
          existing: r.existing,
          ...(r.instanceId === null ? {} : { instance_id: r.instanceId }),
          board: r.board,
          tasks: r.tasks.map((t) => ({ ref: t.ref, step: t.step, item: t.item, gates: t.gates })),
          follows,
        },
      };
    },
    { workflows: true, check: chatCheck(flags) },
```

In `src/kanban/service.ts`, replace:

```ts
import {
  boardList,
  boardSummaries,
  cardReading,
  chatBoardOf,
  gatesOf,
  getBoard,
  getInstance,
  getRun,
  getTask,
  instanceByKey,
  instancesOn,
  memberOf,
  memberPhases,
  membersWithTasks,
  relatedTasks,
  runsOf,
  statusOf,
  taskView,
  threadRootOf,
  type BoardEntry,
  type BoardSummary,
  type CardReading,
  type InstanceRow,
  type MemberRow,
  type TaskView,
  type ThreadAt,
} from '../db/kanban-read.js';
```

with:

```ts
import {
  boardList,
  boardSummaries,
  cardReading,
  chatBoardOf,
  gatesOf,
  getBoard,
  getInstance,
  getRun,
  getTask,
  getTaskByKey,
  instanceByKey,
  instancesOn,
  memberOf,
  memberPhases,
  membersWithTasks,
  relatedTasks,
  runsOf,
  statusOf,
  subscriptionsOf,
  taskView,
  threadRootOf,
  type BoardEntry,
  type BoardSummary,
  type CardReading,
  type InstanceRow,
  type MemberRow,
  type TaskView,
  type ThreadAt,
} from '../db/kanban-read.js';
```

In `src/kanban/service.ts`, replace:

```ts
    return threadRootOf(this.#db, at);
```

with:

```ts
    return threadRootOf(this.#db, at);
  }

  /**
   * Whether a key has made its task, or its instance, already: the terminal
   * looks a thread's root up only for what is not made yet, so a repeat is
   * answered even once its thread's root is lost (kanban spec §22.1). Namespaced
   * as `create` and a start namespace it; false for a key they would refuse.
   */
  keyMade(key: string, via: CreatedVia, what: 'task' | 'instance'): boolean {
    const k = this.#idempotencyKey(key, via);
    if (!k.ok || k.key === null) return false;
    return what === 'task' ? getTaskByKey(this.#db, k.key) !== undefined : instanceByKey(this.#db, k.key) !== undefined;
  }

  /**
   * The chat that follows a task for this bot, as stored: its first Lark
   * subscription, the thread null at chat scope; null with none. A repeat's
   * answer names it, never the `--chat` given now (kanban spec §22.1).
   */
  followOf(taskId: string, appId: string): { chat: string; thread: string | null } | null {
    const s = subscriptionsOf(this.#db, taskId).find((x) => x.channel === 'lark' && x.appId === appId);
    return s === undefined ? null : { chat: s.conversationId, thread: s.threadId === '' ? null : s.threadId };
```

- [ ] **Step 9.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2540 passed (2540)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.5: Commit.**

```bash
git add src/cli/gate.ts src/cli/mt.ts src/cli/operator.ts src/kanban/service.ts tests/mt-kanban-operator-tasks.test.ts tests/mt-kanban-workflow.test.ts tests/mt-terminal-chat.test.ts
git commit -m "Add --chat and --thread to mt kanban task new, workflow start and workflow apply: the shapes, the app id and auth.chats checked before the board is opened, then the key, then a thread's root; the answers say who follows, a repeat its stored subscription; a preview refuses them"
```

---

### Task 10: Times in the task list

**Files:**

- Create: `tests/kanban-phase-since.test.ts`
- Modify: `src/cli/operator.ts`, `src/cli/plain.ts`, `src/db/kanban-read.ts`, `src/kanban/service.ts`, `tests/mt-kanban-operator-tasks.test.ts`, `tests/mt-plain.test.ts`

§22.3. `phaseSince(db, board)` in `src/db/kanban-read.ts`: one query, the time of each task's newest event among the nine kinds that set a phase, a dependency block left out; `KanbanService.phaseSince`. `task list --json` gives `created_at` and `status_since` in milliseconds, a task with no such event its creation; the plain list gains `age`, `ageText`, between the status and the assignee. The two tests that read the old list change.

- [ ] **Step 10.1: Write the tests.**

Create `tests/kanban-phase-since.test.ts`:

```ts
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ageText } from '../src/cli/plain.js';
import {
  addComment,
  archive,
  block,
  closeRun,
  complete,
  createBoard,
  endRun,
  link,
  requestChanges,
  requestReview,
  stop,
  unblock,
  DEFAULT_LIMITS,
} from '../src/db/kanban.js';
import { phaseSince } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import type { Reporter } from '../src/kanban/types.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, claimed, newTask, NOW } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * Times in the task list (kanban spec §22.3): `status_since`, the time of a
 * task's latest phase-changing event, read for a whole board in one query; and
 * the plain list's `age` column, in minutes, hours or days.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let t: TestDb;
beforeEach(() => {
  clearSecrets();
  t = testDb();
});
afterEach(() => t.close());

const since = (taskId: string): number | undefined => phaseSince(t.db, 'default').get(taskId);
const by = (runId: string): Reporter => ({ kind: 'run', runId });
const OPERATOR: Reporter = { kind: 'person', principal: ALICE, as: 'operator' };
const ok = (r: { ok: boolean; message?: string }): void => {
  if (!r.ok) throw new Error(r.message);
};

describe('phaseSince', () => {
  it('is moved by each of the nine kinds that set a phase, at its time', () => {
    let at = NOW;
    const step = (): number => (at += HOUR);
    const task = newTask(t.db, { failureLimit: 1, reviewer: { kind: 'role', name: 'reviewer' } }, at);
    expect(since(task.taskId)).toBe(NOW);
    // blocked, then unblocked
    let run = claimed(t.db, task.taskId, {}, step());
    ok(block(t.db, task.taskId, by(run.runId), { kind: 'needs_input', reason: 'which venue?' }, step()));
    expect(since(task.taskId)).toBe(at);
    ok(closeRun(t.db, run.runId, at));
    ok(unblock(t.db, task.taskId, ALICE, undefined, step()));
    expect(since(task.taskId)).toBe(at);
    // stopped
    run = claimed(t.db, task.taskId, {}, step());
    ok(stop(t.db, task.taskId, ALICE, step()));
    expect(since(task.taskId)).toBe(at);
    ok(closeRun(t.db, run.runId, at));
    ok(unblock(t.db, task.taskId, ALICE, undefined, step()));
    // a run whose end blocked the task
    run = claimed(t.db, task.taskId, {}, step());
    ok(endRun(t.db, run.runId, { outcome: 'failed', error: 'exit 1' }, { ...DEFAULT_LIMITS, failureLimit: 1 }, step()));
    expect(since(task.taskId)).toBe(at);
    ok(closeRun(t.db, run.runId, at));
    ok(unblock(t.db, task.taskId, ALICE, undefined, step()));
    // review requested, then changes requested
    run = claimed(t.db, task.taskId, {}, step());
    ok(requestReview(t.db, task.taskId, by(run.runId), { summary: 'booked' }, step()));
    expect(since(task.taskId)).toBe(at);
    ok(closeRun(t.db, run.runId, at));
    ok(requestChanges(t.db, task.taskId, OPERATOR, 'a cheaper one', step()));
    expect(since(task.taskId)).toBe(at);
    // completed by the reviewer's approval, then archived
    run = claimed(t.db, task.taskId, {}, step());
    ok(requestReview(t.db, task.taskId, by(run.runId), { summary: 'cheaper' }, step()));
    ok(closeRun(t.db, run.runId, at));
    ok(complete(t.db, task.taskId, OPERATOR, { summary: 'approved' }, step()));
    expect(since(task.taskId)).toBe(at);
    ok(archive(t.db, task.taskId, ALICE, step()));
    expect(since(task.taskId)).toBe(at);
  });

  it('is the second block for a task blocked, unblocked and blocked again', () => {
    const task = newTask(t.db, {}, NOW);
    for (const at of [NOW + HOUR, NOW + 3 * HOUR]) {
      const run = claimed(t.db, task.taskId, {}, at - MIN);
      ok(block(t.db, task.taskId, by(run.runId), { kind: 'needs_input', reason: 'why' }, at));
      ok(closeRun(t.db, run.runId, at));
      if (at === NOW + HOUR) ok(unblock(t.db, task.taskId, ALICE, undefined, NOW + 2 * HOUR));
    }
    expect(since(task.taskId)).toBe(NOW + 3 * HOUR);
  });

  it('is not moved by a dependency block, a claim, a comment or a link', () => {
    const task = newTask(t.db, {}, NOW);
    const parent = newTask(t.db, { title: 'parent' }, NOW);
    const other = newTask(t.db, { title: 'other' }, NOW);
    const run = claimed(t.db, task.taskId, {}, NOW + HOUR);
    ok(addComment(t.db, task.taskId, ALICE, 'note', NOW + 2 * HOUR, true));
    ok(link(t.db, other.taskId, parent.taskId, ALICE, NOW + 3 * HOUR));
    ok(block(t.db, task.taskId, by(run.runId), { kind: 'dependency', reason: 'needs the parent', parents: [parent.taskId] }, NOW + 4 * HOUR));
    expect([since(task.taskId), since(parent.taskId)]).toEqual([NOW, NOW]);
  });

  it("reads a board's tasks in one query, whatever its size, and none of another board's", () => {
    ok(createBoard(t.db, 'web-app', ALICE, NOW));
    const ids = Array.from({ length: 50 }, (_, i) => newTask(t.db, { title: `task ${i}` }, NOW + i).taskId);
    const elsewhere = newTask(t.db, { board: 'web-app' }, NOW);
    const prepare = vi.spyOn(t.db, 'prepare');
    const all = phaseSince(t.db, 'default');
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockRestore();
    expect(all.size).toBe(50);
    expect(all.get(ids[49] ?? '')).toBe(NOW + 49);
    expect(all.has(elsewhere.taskId)).toBe(false);
  });
});

describe('ageText', () => {
  it('says whole minutes under an hour, whole hours under a day, and whole days after', () => {
    expect([0, MIN - 1, MIN, 45 * MIN, HOUR - 1].map(ageText)).toEqual(['0m', '0m', '1m', '45m', '59m']);
    expect([HOUR, 5 * HOUR + 59 * MIN, DAY - 1].map(ageText)).toEqual(['1h', '5h', '23h']);
    expect([DAY, 3 * DAY + 23 * HOUR, 400 * DAY].map(ageText)).toEqual(['1d', '3d', '400d']);
    expect(ageText(-5 * MIN)).toBe('0m');
  });
});

describe('mt kanban task list', () => {
  let fx: MtFixture;
  let db: Db;
  afterEach(() => {
    db?.close();
    fx?.cleanup();
  });

  it('gives created_at and status_since in milliseconds, and an age column between the status and the assignee', async () => {
    fx = mtFixture();
    db = openDb(join(fx.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    const now = Date.now();
    const old = newTask(db, { title: 'Old', assignee: { kind: 'role', name: 'default' } }, now - 3 * DAY - HOUR);
    const run = claimed(db, old.taskId, {}, now - 3 * DAY);
    ok(block(db, old.taskId, by(run.runId), { kind: 'needs_input', reason: 'which?' }, now - 5 * HOUR - MIN));
    const fresh = newTask(db, { title: 'Fresh', assignee: null }, now - 45 * MIN - 30_000);
    const json = JSON.parse((await fx.run(['kanban', 'task', 'list', '--json'])).out);
    expect(json.tasks).toEqual([
      { task_id: fresh.taskId, status: 'ready', title: 'Fresh', assignee: null, assignee_kind: null, created_at: now - 45 * MIN - 30_000, status_since: now - 45 * MIN - 30_000 },
      { task_id: old.taskId, status: 'blocked', title: 'Old', assignee: 'default', assignee_kind: 'role', created_at: now - 3 * DAY - HOUR, status_since: now - 5 * HOUR - MIN },
    ]);
    const lines = (await fx.run(['kanban', 'task', 'list'])).out.split('\n');
    expect(lines[0]).toMatch(/^task\s+status\s+age\s+assignee\s+title$/);
    expect(lines[1]).toMatch(new RegExp(`^${fresh.taskId}\\s+ready\\s+45m\\s+nobody\\s+Fresh$`));
    expect(lines[2]).toMatch(new RegExp(`^${old.taskId}\\s+blocked\\s+5h\\s+role default\\s+Old$`));
  });
});
```

In `tests/mt-kanban-operator-tasks.test.ts`, replace:

```ts
      tasks: [{ task_id: taskId, status: 'ready', title: 'On web', assignee: null, assignee_kind: null }],
```

with:

```ts
      tasks: [{ task_id: taskId, status: 'ready', title: 'On web', assignee: null, assignee_kind: null, created_at: getTask(gateway, taskId)?.createdAt, status_since: getTask(gateway, taskId)?.createdAt }],
```

In `tests/mt-plain.test.ts`, replace:

```ts
    expect(listText(service.list('default'), undefined, 'default')).toEqual([
      'no open tasks on board default; mt kanban task list all shows done and archived ones too',
    ]);
    expect(listText(service.list('default'), 'done', 'default')).toEqual(['no done tasks on board default']);
    const ids = Array.from({ length: 31 }, (_, i) => create(`task ${i}`));
    const lines = listText(service.list('default'), undefined, 'default');
    expect(lines).toHaveLength(32);
    expect(lines[0]).toMatch(/^task\s+status\s+assignee\s+title$/);
    expect(lines[1]).toMatch(new RegExp(`^${ids[0]}\\s+ready\\s+role implementer\\s+task 0$`));
```

with:

```ts
    const ages = () => ({ since: service.phaseSince('default'), now: 1_760_000_000_000 + 90 * 60_000 });
    expect(listText(service.list('default'), undefined, 'default', ages())).toEqual([
      'no open tasks on board default; mt kanban task list all shows done and archived ones too',
    ]);
    expect(listText(service.list('default'), 'done', 'default', ages())).toEqual(['no done tasks on board default']);
    const ids = Array.from({ length: 31 }, (_, i) => create(`task ${i}`));
    const lines = listText(service.list('default'), undefined, 'default', ages());
    expect(lines).toHaveLength(32);
    expect(lines[0]).toMatch(/^task\s+status\s+age\s+assignee\s+title$/);
    expect(lines[1]).toMatch(new RegExp(`^${ids[0]}\\s+ready\\s+1h\\s+role implementer\\s+task 0$`));
```

- [ ] **Step 10.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-phase-since.test.ts tests/mt-kanban-operator-tasks.test.ts tests/mt-plain.test.ts`. Expected: `Tests  8 failed | 45 passed (53)`; among the failures, `TypeError: (0 , phaseSince) is not a function`.

- [ ] **Step 10.3: Implement.**

In `src/cli/operator.ts`, replace:

```ts
    const tasks = listed(entries, filter).map((e) => ({
      task_id: e.task.taskId,
      status: e.status,
      title: e.task.title,
      assignee: e.task.assignee?.name ?? null,
      assignee_kind: e.task.assignee?.kind ?? null,
    }));
    return { ok: true, lines: listText(entries, filter, board), json: { board, tasks } };
```

with:

```ts
    // When each changed phase, in milliseconds as every --json time is; the plain list's age is the readable form.
    const since = service.phaseSince(board);
    const tasks = listed(entries, filter).map((e) => ({
      task_id: e.task.taskId,
      status: e.status,
      title: e.task.title,
      assignee: e.task.assignee?.name ?? null,
      assignee_kind: e.task.assignee?.kind ?? null,
      created_at: e.task.createdAt,
      status_since: since.get(e.task.taskId) ?? e.task.createdAt,
    }));
    return { ok: true, lines: listText(entries, filter, board, { since, now: Date.now() }), json: { board, tasks } };
```

In `src/cli/plain.ts`, replace:

```ts
/** `mt kanban task list` (spec §9.1): one board's tasks, as chat lists them, every one rather than the first 30. */
export function listText(
  entries: readonly BoardEntry[],
  filter: DisplayStatus | 'all' | undefined,
  board: string,
```

with:

```ts
/**
 * How long a task has been in its status, as the task list's `age` says it (kanban
 * spec §22.3): whole minutes under an hour, whole hours under a day, whole days after.
 */
export function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * `mt kanban task list` (spec §9.1): one board's tasks, as chat lists them, every one rather than the first 30,
 * each with its age in its status, from `since`, else its creation, to `now` by this terminal's clock (kanban spec §22.3).
 */
export function listText(
  entries: readonly BoardEntry[],
  filter: DisplayStatus | 'all' | undefined,
  board: string,
  ages: { since: ReadonlyMap<string, number>; now: number },
```

In `src/cli/plain.ts`, replace:

```ts
  const rows = shown.map((e) => [e.task.taskId, e.status, who(e.task.assignee), line(e.task.title, 120)]);
  return table([['task', 'status', 'assignee', 'title'], ...rows]);
```

with:

```ts
  const rows = shown.map((e) => [
    e.task.taskId,
    e.status,
    ageText(ages.now - (ages.since.get(e.task.taskId) ?? e.task.createdAt)),
    who(e.task.assignee),
    line(e.task.title, 120),
  ]);
  return table([['task', 'status', 'age', 'assignee', 'title'], ...rows]);
```

In `src/db/kanban-read.ts`, replace:

```ts
}

// ---------------------------------------------------------------------------
// What the dispatcher reads (plan C2)
```

with:

```ts
}

/**
 * When each task of a board last changed phase (kanban spec §22.3): the time of
 * its newest event among those that set one, as db/kanban.ts writes them --
 * `created`, `review_requested`, `changes_requested`, `completed`, `blocked`
 * unless a dependency block, which keeps the phase, `stopped`, `run_ended` whose
 * `next` blocked the task, `unblocked` and `archived`. One query for the board,
 * by the events' `(task_id, id)` index; a task with none is not in the map.
 */
export function phaseSince(db: Db, board: string): Map<string, number> {
  const rows = db
    .prepare<[string], { task_id: string; at: number; newest: number }>(
      `SELECT e.task_id AS task_id, e.created_at AS at, max(e.id) AS newest
         FROM kanban_events e JOIN kanban_tasks t ON t.task_id = e.task_id
        WHERE t.board = ?
          AND (e.kind IN ('created', 'review_requested', 'changes_requested', 'completed', 'stopped', 'unblocked', 'archived')
               OR (e.kind = 'blocked' AND coalesce(json_extract(e.payload, '$.kind'), '') <> 'dependency')
               OR (e.kind = 'run_ended' AND json_extract(e.payload, '$.next') = 'blocked'))
        GROUP BY e.task_id`,
    )
    .all(board);
  return new Map(rows.map((r) => [r.task_id, r.at]));
}

// ---------------------------------------------------------------------------
// What the dispatcher reads (plan C2)
```

In `src/kanban/service.ts`, replace:

```ts
  boardSummaries,
  cardReading,
  chatBoardOf,
  gatesOf,
  getBoard,
  getInstance,
  getRun,
  getTask,
  getTaskByKey,
  instanceByKey,
  instancesOn,
  memberOf,
  memberPhases,
  membersWithTasks,
  relatedTasks,
  runsOf,
  statusOf,
  subscriptionsOf,
  taskView,
  threadRootOf,
  type BoardEntry,
  type BoardSummary,
  type CardReading,
  type InstanceRow,
  type MemberRow,
  type TaskView,
  type ThreadAt,
} from '../db/kanban-read.js';
```

with:

```ts
  boardSummaries,
  cardReading,
  chatBoardOf,
  gatesOf,
  getBoard,
  getInstance,
  getRun,
  getTask,
  getTaskByKey,
  instanceByKey,
  instancesOn,
  memberOf,
  memberPhases,
  membersWithTasks,
  phaseSince,
  relatedTasks,
  runsOf,
  statusOf,
  subscriptionsOf,
  taskView,
  threadRootOf,
  type BoardEntry,
  type BoardSummary,
  type CardReading,
  type InstanceRow,
  type MemberRow,
  type TaskView,
  type ThreadAt,
} from '../db/kanban-read.js';
```

In `src/kanban/service.ts`, replace:

```ts
  }

  /**
   * A subscription has been told of every event up to `cursor`, or passed over
```

with:

```ts
  }

  /** When each of a board's tasks last changed phase, in one read (kanban spec §22.3): `mt kanban task list`'s times. */
  phaseSince(onBoard: string): ReadonlyMap<string, number> {
    return phaseSince(this.#db, onBoard);
  }

  /**
   * A subscription has been told of every event up to `cursor`, or passed over
```

- [ ] **Step 10.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2546 passed (2546)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.5: Commit.**

```bash
git add src/cli/operator.ts src/cli/plain.ts src/db/kanban-read.ts src/kanban/service.ts tests/kanban-phase-since.test.ts tests/mt-kanban-operator-tasks.test.ts tests/mt-plain.test.ts
git commit -m "Give mt kanban task list --json each task's created_at and status_since in milliseconds, the phase times read for a board in one query, and the plain list an age column between the status and the assignee"
```

---

### Task 11: A cron script's `PATH` and home

**Files:**

- Create: `tests/cron-script-env.test.ts`
- Modify: `src/cron/scheduler.ts`, `src/index.ts`, `tests/helpers/cron.ts`

Cron §5.1, §13. `scriptEnv(role, env, worker, home)`: `gateEnv`, then `PATH` with `WorkerAccess.mtDir` first, before the role's `PATH` or the gateway's, as `#workerEnv` builds a fire's agent's (both through `mtFirst`), then `MT_HOME`, `MT_CONFIG` (only for a file read) and `MT_DB` from a new `ScriptHome` dep, set after the role's environment. `#script` uses it; `src/index.ts` fills `scriptHome` from `GatewayConfig`. A gate's environment is unchanged. The harness's `deps` takes `scriptHome`.

- [ ] **Step 11.1: Write the tests.**

Create `tests/cron-script-env.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_VARIABLES } from '../src/cli/gate.js';
import { scriptEnv, type ScriptHome } from '../src/cron/scheduler.js';
import { migrate, openDb } from '../src/db/open.js';
import { gateEnv, spawnGate, type GateExit, type GateRunOptions } from '../src/kanban/gates.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { clearSecrets } from '../src/secrets.js';
import { answers, cronHarness, type CronHarness } from './helpers/cron.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * A fire's script's PATH and home (the cron spec, §5.1): `$MT_HOME/bin` first,
 * before the role's PATH or the gateway's, and the gateway's home, config file
 * and database, so plain `mt` in a script reaches this gateway; none of them an
 * agent's variable, and a gate's environment as it was.
 */

const WORKER = { socket: '/run/mt/kanban.sock', mtDir: '/srv/mt/bin', path: '/usr/local/bin:/usr/bin' };
const HOME: ScriptHome = { home: '/srv/mt', configPath: '/etc/mt/config.yaml', dbPath: '/data/team.db' };
/** The gateway's own environment, which, inside the gateway, has an agent's variables too. */
const GATEWAY = { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/mt', MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 't', MT_KANBAN_SOCKET: '/s', MT_CRON_TOKEN: 'c', MT_CRON_FIRE: '7', MT_CONFIG: '/tmp/other.yaml' };

describe('scriptEnv', () => {
  it("puts the gateway's mt first, before the gateway's PATH, and sets its home, config file and database", () => {
    const env = scriptEnv(role('worker'), GATEWAY, WORKER, HOME);
    expect(env).toEqual({ PATH: '/srv/mt/bin:/usr/local/bin:/usr/bin', HOME: '/home/mt', MT_HOME: '/srv/mt', MT_CONFIG: '/etc/mt/config.yaml', MT_DB: '/data/team.db' });
  });

  it("puts it before the role's own PATH, and sets the three after the role's environment", () => {
    const worker = role('worker', { agent: { ...role('worker').agent, env: { PATH: '/opt/tools/bin', MT_HOME: '/elsewhere', GH_HOST: 'git.example' } } });
    const env = scriptEnv(worker, GATEWAY, WORKER, HOME);
    expect(env).toMatchObject({ PATH: '/srv/mt/bin:/opt/tools/bin', MT_HOME: '/srv/mt', GH_HOST: 'git.example' });
  });

  it('gives no MT_CONFIG to an environment-only gateway, no agent variable and no socket', () => {
    const env = scriptEnv(role('worker'), GATEWAY, WORKER, { ...HOME, configPath: undefined });
    expect(env['MT_CONFIG']).toBeUndefined();
    for (const name of [...AGENT_VARIABLES, 'MT_KANBAN_SOCKET']) expect(env[name], name).toBeUndefined();
  });

  it("leaves a gate's environment as it was, and a script's without the deps", () => {
    expect(gateEnv(role('worker'), GATEWAY)).toEqual({ PATH: '/usr/local/bin:/usr/bin', HOME: '/home/mt' });
    expect(scriptEnv(role('worker'), GATEWAY, undefined, undefined)).toEqual(gateEnv(role('worker'), GATEWAY));
  });
});

describe("a fire's script", () => {
  const open: CronHarness[] = [];
  afterEach(() => {
    clearSecrets();
    while (open.length > 0) open.pop()?.close();
  });

  it('runs with the environment scriptEnv gives, from the scheduler\'s deps', async () => {
    const calls: GateRunOptions[] = [];
    const runner = async (_command: string, opts: GateRunOptions): Promise<GateExit> => {
      calls.push(opts);
      return { exitCode: 0, signal: null, timedOut: false, output: 'ok' };
    };
    const h = cronHarness({ deps: { runner, env: GATEWAY, worker: WORKER, scriptHome: HOME } });
    open.push(h);
    h.add({ script: 'mt kanban task list --json' });
    answers(h.driver, 'Nothing stuck.');
    h.clock.advance(60 * 60_000);
    await h.tick();
    await h.scheduler.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toEqual(scriptEnv(role('worker'), GATEWAY, WORKER, HOME));
    expect(calls[0]?.env['PATH']?.startsWith('/srv/mt/bin:')).toBe(true);
  });
});

describe("plain mt in a script, through the gateway's launcher", () => {
  let fx: MtFixture;
  beforeEach(() => clearSecrets());
  afterEach(() => fx?.cleanup());

  it("reads the gateway's own database, one a gateway run by hand names by MT_DB outside its home included", async () => {
    fx = mtFixture();
    writeMtShim(fx.home);
    const dbPath = join(mkdtempSync(join(fx.root, 'data-')), 'board.db');
    const db = openDb(dbPath);
    migrate(db, SCHEMA_DIR);
    const task = newTask(db, { title: 'In the gateway database', assignee: null });
    db.close();
    const env = scriptEnv(role('worker'), { PATH: process.env['PATH'], HOME: fx.root }, { socket: '/none', mtDir: join(fx.home, 'bin'), path: process.env['PATH'] }, { home: fx.home, configPath: fx.configPath, dbPath });
    const exit = await spawnGate('mt kanban task list --json', { cwd: fx.workspace, env, timeoutMs: 60_000 });
    expect(exit.exitCode, exit.output).toBe(0);
    const answer = JSON.parse(exit.output.split('\n').find((l) => l.startsWith('{')) ?? 'null') as { ok: boolean; tasks: Array<{ task_id: string }> };
    expect(answer.ok).toBe(true);
    expect(answer.tasks.map((t) => t.task_id)).toEqual([task.taskId]);
  }, 60_000);
});
```

In `tests/helpers/cron.ts`, replace:

```ts
  deps?: Pick<CronSchedulerDeps, 'runner' | 'renderRoot' | 'packages' | 'worker' | 'env' | 'sweepRendersAtBoot' | 'tokens'>;
```

with:

```ts
  deps?: Pick<CronSchedulerDeps, 'runner' | 'renderRoot' | 'packages' | 'worker' | 'env' | 'sweepRendersAtBoot' | 'tokens' | 'scriptHome'>;
```

- [ ] **Step 11.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/cron-script-env.test.ts`. Expected: `Tests  6 failed (6)`; among the failures, `TypeError: (0 , scriptEnv) is not a function`.

- [ ] **Step 11.3: Implement.**

In `src/cron/scheduler.ts`, replace:

```ts
  /** The socket and the shim a fire's agent finds the gateway's mt through (§7.2). */
  worker?: WorkerAccess;
  /** Mints a fire's token, `MT_CRON_TOKEN`, held while it runs (§7.2); absent, a fire gets none. */
  tokens?: CronTokens;
```

with:

```ts
  /** The socket and the shim a fire's agent finds the gateway's mt through (§7.2); a script, the shim alone (§5.1). */
  worker?: WorkerAccess;
  /** The gateway's home, config file and database, which a fire's script is given (§5.1); absent, none are. */
  scriptHome?: ScriptHome;
  /** Mints a fire's token, `MT_CRON_TOKEN`, held while it runs (§7.2); absent, a fire gets none. */
  tokens?: CronTokens;
}

/**
 * Where the gateway's files are, as it resolved them (§5.1): its home, the config
 * file it read, if any, and the database it opened. Its own dep, not
 * `WorkerAccess`'s, which is the socket's and the launcher's.
 */
export interface ScriptHome {
  home: string;
  configPath: string | undefined;
  dbPath: string;
}

/** A PATH that finds the gateway's `mt` launcher first, then the role's own PATH, else the gateway's (§7.2). */
function mtFirst(role: Role, worker: WorkerAccess): string {
  const rest = role.agent.env['PATH'] ?? worker.path;
  return rest === undefined || rest === '' ? worker.mtDir : `${worker.mtDir}${delimiter}${rest}`;
}

/**
 * A fire's script's environment (§5.1): its role's, as a gate's (`gateEnv`),
 * then `PATH` with the gateway's `mt` launcher first, and `MT_HOME`, `MT_CONFIG`
 * and `MT_DB` the gateway's, set after the role's, so plain `mt` in a script
 * opens exactly this gateway's files. None is an agent's variable, so the
 * script is a terminal: the operator's commands work in it.
 */
export function scriptEnv(
  role: Role,
  env: Readonly<Record<string, string | undefined>>,
  worker: WorkerAccess | undefined,
  home: ScriptHome | undefined,
): Record<string, string> {
  const out = gateEnv(role, env);
  if (worker !== undefined) out['PATH'] = mtFirst(role, worker);
  if (home !== undefined) {
    out['MT_HOME'] = home.home;
    if (home.configPath === undefined) delete out['MT_CONFIG'];
    else out['MT_CONFIG'] = home.configPath;
    out['MT_DB'] = home.dbPath;
  }
  return out;
```

In `src/cron/scheduler.ts`, replace:

```ts
  /** The job's script, as a gate runs (§5.1): in the workspace, with the role's environment, killed at its limit. */
  async #script(entry: Entry, job: JobRow, role: Role): Promise<GateExit> {
    const cwd = this.#deps.workspaceDirs.get(job.workspace);
    const runner = this.#deps.runner ?? spawnGate;
    if (cwd === undefined) return { exitCode: null, signal: null, timedOut: false, output: `workspace ${job.workspace} has no directory` };
    return runner(job.script ?? '', {
      cwd,
      env: gateEnv(role, this.#deps.env ?? process.env),
```

with:

```ts
  /** The job's script, as a gate runs (§5.1): in the workspace, with the role's environment and the gateway's mt and home, killed at its limit. */
  async #script(entry: Entry, job: JobRow, role: Role): Promise<GateExit> {
    const cwd = this.#deps.workspaceDirs.get(job.workspace);
    const runner = this.#deps.runner ?? spawnGate;
    if (cwd === undefined) return { exitCode: null, signal: null, timedOut: false, output: `workspace ${job.workspace} has no directory` };
    return runner(job.script ?? '', {
      cwd,
      env: scriptEnv(role, this.#deps.env ?? process.env, this.#deps.worker, this.#deps.scriptHome),
```

In `src/cron/scheduler.ts`, replace:

```ts
    const rest = role.agent.env['PATH'] ?? worker.path;
    return { MT_KANBAN_SOCKET: worker.socket, PATH: rest === undefined || rest === '' ? worker.mtDir : `${worker.mtDir}${delimiter}${rest}` };
```

with:

```ts
    return { MT_KANBAN_SOCKET: worker.socket, PATH: mtFirst(role, worker) };
```

In `src/index.ts`, replace:

```ts
import { dirname, join } from 'node:path';
```

with:

```ts
import { dirname, join, resolve } from 'node:path';
```

In `src/index.ts`, replace:

```ts
      sweepRendersAtBoot: !config.kanban.enabled,
      worker: access,
      tokens,
```

with:

```ts
      sweepRendersAtBoot: !config.kanban.enabled,
      worker: access,
      // A script's plain mt opens exactly the gateway's files, resolved, as the script runs in a workspace (§5.1).
      scriptHome: {
        home: config.home,
        configPath: config.configPath === undefined ? undefined : resolve(config.configPath),
        dbPath: resolve(config.dbPath),
      },
      tokens,
```

- [ ] **Step 11.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2552 passed (2552)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 11.5: Commit.**

```bash
git add src/cron/scheduler.ts src/index.ts tests/cron-script-env.test.ts tests/helpers/cron.ts
git commit -m "Give a cron script the gateway's mt first on its PATH and the gateway's MT_HOME, MT_CONFIG and MT_DB, from a ScriptHome dep of the scheduler's, so its plain mt reaches this gateway; gates are unchanged"
```

---

### Task 12: The README, the guide and `docs/examples.md`

**Files:**

- Modify: `README.md`, `docs/examples.md`, `docs/kanban-guide.md`, `tests/docs-examples.test.ts`

§22.5, workflows §18.5, cron §13. The README's command list and its paragraph on the operator's `kanban` commands, and its cron section; the guide's section 11 (people, `--chat`, the `age` column) and section 12's terminal paragraph; `docs/examples.md`'s people, the terminal sentences of workflows 1 to 6, part 2's facts on a script's `mt` and its two limits, example 3 by `age` with no file kept, and example 6 with `--chat oc_xxx` and Dana Wu as the reviewer. `tests/docs-examples.test.ts` runs the examples' scripts with `scriptEnv`, plain `mt` found by the launcher first on a `PATH` that has no other, the board review's `age` column, the weekly start's chat and its one reply; it makes the guide's `task new --chat`, and a terminal start naming Dana, and refuses one naming a person the gateway does not know, with the hint.

- [ ] **Step 12.1: Write the tests.**

In `tests/docs-examples.test.ts`, replace:

```ts
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { loadTeamSettings } from '../src/config.js';
import { CronChat, parseAdd } from '../src/cron/chat.js';
import { parseSchedule } from '../src/cron/schedule.js';
import { CronService } from '../src/cron/service.js';
import { CronTokens } from '../src/cron/tokens.js';
import { CronApi } from '../src/cron/worker.js';
import { bindSession } from '../src/db/bindings.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn, setTurnState } from '../src/db/turns.js';
import { parseKanban } from '../src/kanban/chat-parse.js';
import { gateEnv, spawnGate } from '../src/kanban/gates.js';
```

with:

```ts
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { loadTeamSettings } from '../src/config.js';
import { CronChat, parseAdd } from '../src/cron/chat.js';
import { scriptEnv } from '../src/cron/scheduler.js';
import { parseSchedule } from '../src/cron/schedule.js';
import { CronService } from '../src/cron/service.js';
import { CronTokens } from '../src/cron/tokens.js';
import { CronApi } from '../src/cron/worker.js';
import { bindSession } from '../src/db/bindings.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn, setTurnState } from '../src/db/turns.js';
import { parseKanban } from '../src/kanban/chat-parse.js';
import { spawnGate } from '../src/kanban/gates.js';
```

In `tests/docs-examples.test.ts`, replace:

```ts
 * an `mt` command through `mt` itself, a cron script calling `mt` as a fire
 * runs it, by /bin/sh through the gateway's launcher, and an agent's JSON through the handler it is sent to. Nothing here
```

with:

```ts
 * an `mt` command through `mt` itself, a cron script calling plain `mt` as a
 * fire runs it, by /bin/sh with the environment the scheduler gives it, which
 * finds the gateway's launcher first, and an agent's JSON through the handler it is sent to. Nothing here
```

In `tests/docs-examples.test.ts`, replace:

```ts
/** The launcher a cron script calls `mt` by (docs/examples.md, part 2). */
const LAUNCHER = '~/.manus-team/bin/mt';
```

with:

```ts
/** A cron script that calls plain `mt`, which the gateway's launcher answers (docs/examples.md, part 2). */
const CALLS_MT = /(^|[;&|(] *)mt /;

/** Dana Wu, whom the examples name as `lark:on_5d1e7a`, known to every home with talk tier. */
const DANA = { unionId: 'on_5d1e7a', openId: 'ou_dana' };
```

In `tests/docs-examples.test.ts`, replace:

```ts
 * A gateway home at `<root>/.manus-team`, so a cron script's `~/.manus-team/bin/mt`
 * finds it with HOME at `<root>`: the roles worker, reviewer and triage, the
 * default role from the agent block, and the workspaces the examples name, two
 * of them isolated; its database migrated, and the boards the docs name.
```

with:

```ts
 * A gateway home at `<root>/.manus-team`: the roles worker, reviewer and triage,
 * the default role from the agent block, and the workspaces the examples name,
 * two of them isolated; an owner, and Dana at talk tier, whom the bot has seen;
 * its database migrated, and the boards the docs name.
```

In `tests/docs-examples.test.ts`, replace:

```ts
      'lark:',
      '  appId: cli_app',
      'agent:',
      '  driver: structured-cli',
```

with:

```ts
      'lark:',
      '  appId: cli_app',
      'auth:',
      '  owner: ou_owner',
      `  talk: [${DANA.openId}]`,
      'agent:',
      '  driver: structured-cli',
```

In `tests/docs-examples.test.ts`, replace:

```ts
  migrate(db, SCHEMA_DIR);
```

with:

```ts
  migrate(db, SCHEMA_DIR);
  notePerson(db, { appId: 'cli_app', unionId: DANA.unionId, openId: DANA.openId, name: 'Dana Wu' }, NOW);
```

In `tests/docs-examples.test.ts`, replace:

```ts
    "each script calling mt runs as a fire runs it: by /bin/sh in the workspace, through the gateway's launcher, with no agent's variables, and allowed",
```

with:

```ts
    "each script calling plain mt runs as a fire runs it: by /bin/sh in the workspace, the gateway's launcher first on its PATH, with no agent's variables, and allowed",
```

In `tests/docs-examples.test.ts`, replace:

```ts
      const withMt = scripts.filter((s) => s.script.includes(`${LAUNCHER} `));
      // The board review and the weekly workflow, each in chat and at the terminal.
      expect(withMt).toHaveLength(4);
      // A fire's script gets the role's environment from the gateway's, which, inside the gateway, has these too.
      const gateway = {
        PATH: process.env['PATH'],
```

with:

```ts
      const withMt = scripts.filter((s) => CALLS_MT.test(s.script));
      // The board review and the weekly workflow, each in chat and at the terminal; no script names the launcher's path.
      expect(withMt).toHaveLength(4);
      expect(scripts.filter((s) => s.script.includes('bin/mt'))).toEqual([]);
      // A fire's script gets the role's environment from the gateway's, which, inside the gateway, has these too,
      // and a PATH on which mt is not found but for the launcher put first.
      const gateway = {
        PATH: '/usr/bin:/bin',
```

In `tests/docs-examples.test.ts`, replace:

```ts
      const env = gateEnv(worker, gateway);
      expect(Object.keys(env).filter((k) => k.startsWith('MT_'))).toEqual([]);
      // Never the real home: under /bin/sh, ~ is HOME, here the temporary root.
      expect(env['HOME']).toBe(h.root);
      const run = async (s: { block: Block; script: string }, cwd: string): Promise<string> => {
        const exit = await spawnGate(s.script, { cwd, env, timeoutMs: 60_000 });
        expect(exit.exitCode, `${where(s.block)}: ${exit.output}`).toBe(0);
        return exit.output;
      };
      const answerOf = (output: string): { ok: boolean; instance_id?: string; existing?: boolean } =>
        JSON.parse(output.split('\n').find((l) => l.startsWith('{')) ?? 'null');

      // The board review, twice in one workspace: the second sees the first's list as last week's.
      const open = await h.mt(['kanban', 'task', 'new', 'Fix the flaky export', '--board', 'web-app', '--assignee', 'worker', '--json']);
      const openId = (JSON.parse(open.out) as { task_id: string }).task_id;
      for (const s of withMt.filter((x) => x.script.includes('task list'))) {
        const cwd = mkdtempSync(join(h.root, 'ws-review-'));
        const first = await run(s, cwd);
        expect(first, where(s.block)).toMatch(/Last week:\nnone yet\nThis week:\n\{"ok":true,"board":"web-app","tasks":\[/);
        const thisWeek = first.slice(first.indexOf('This week:\n') + 'This week:\n'.length).trim();
        const second = await run(s, cwd);
        const lastWeek = second.slice(second.indexOf('Last week:\n') + 'Last week:\n'.length, second.indexOf('This week:')).trim();
        expect(lastWeek, where(s.block)).toBe(thisWeek);
        expect(thisWeek, where(s.block)).toContain(openId);
        expect(readFileSync(join(cwd, '.board-review', 'last.json'), 'utf8').trim()).toBe(thisWeek);
      }

      // The weekly start: every run in the same week answers with the first's instance.
      const instances = new Set<string>();
      let runs = 0;
      for (const s of withMt.filter((x) => x.script.includes('workflow start'))) {
        for (let i = 0; i < 2; i += 1) {
          const answer = answerOf(await run(s, join(h.root, 'ws', 'worker')));
          expect(answer.ok, where(s.block)).toBe(true);
          if (runs > 0) expect(answer.existing, where(s.block)).toBe(true);
          instances.add(answer.instance_id ?? '');
          runs += 1;
        }
      }
      expect(runs).toBe(4);
      expect(instances.size).toBe(1);
    },
    120_000,
  );

  it('refuses at the terminal the starts docs/examples.md says need chat, as a person cannot be given work there', async () => {
    const h = docHome.get('docs/examples.md') as Home;
    const r = await h.mt(['kanban', 'workflow', 'start', 'content-pipeline', '--param', 'topic=x', '--param', 'approver=lark:on_x', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: 'person_not_assignable' });
```

with:

```ts
      const access = { socket: join(h.home, 'run', 'kanban.sock'), mtDir: join(h.home, 'bin'), path: gateway.PATH };
      const env = scriptEnv(worker, gateway, access, { home: h.home, configPath: join(h.home, 'config.yaml'), dbPath: join(h.home, 'team.db') });
      expect(Object.keys(env).filter((k) => k.startsWith('MT_')).sort()).toEqual(['MT_CONFIG', 'MT_DB', 'MT_HOME']);
      expect(env['PATH']).toBe(`${join(h.home, 'bin')}:/usr/bin:/bin`);
      // Never the real home: under /bin/sh, ~ is HOME, here the temporary root.
      expect(env['HOME']).toBe(h.root);
      const run = async (s: { block: Block; script: string }, cwd: string): Promise<string> => {
        const exit = await spawnGate(s.script, { cwd, env, timeoutMs: 60_000 });
        expect(exit.exitCode, `${where(s.block)}: ${exit.output}`).toBe(0);
        return exit.output;
      };
      const answerOf = (output: string): { ok: boolean; instance_id?: string; existing?: boolean; follows?: unknown } =>
        JSON.parse(output.split('\n').find((l) => l.startsWith('{')) ?? 'null');

      // The board review: the board's list, each task's age in its status between its status and its assignee, and no file kept.
      const open = await h.mt(['kanban', 'task', 'new', 'Fix the flaky export', '--board', 'web-app', '--assignee', 'worker', '--json']);
      const openId = (JSON.parse(open.out) as { task_id: string }).task_id;
      for (const s of withMt.filter((x) => x.script.includes('task list'))) {
        const cwd = mkdtempSync(join(h.root, 'ws-review-'));
        const lines = (await run(s, cwd)).split('\n');
        expect(lines[0], where(s.block)).toMatch(/^task\s+status\s+age\s+assignee\s+title$/);
        expect(lines[1], where(s.block)).toMatch(new RegExp(`^${openId}\\s+ready\\s+0m\\s+role worker\\s+Fix the flaky export$`));
        expect(readdirSync(cwd), where(s.block)).toEqual([]);
      }

      // The weekly start: every run in the same week answers with the first's instance, which the chat follows, Dana reviewing.
      const instances = new Set<string>();
      let runs = 0;
      for (const s of withMt.filter((x) => x.script.includes('workflow start'))) {
        for (let i = 0; i < 2; i += 1) {
          const answer = answerOf(await run(s, join(h.root, 'ws', 'worker')));
          expect(answer.ok, where(s.block)).toBe(true);
          if (runs > 0) expect(answer.existing, where(s.block)).toBe(true);
          expect(answer.follows, where(s.block)).toEqual({ chat: 'oc_xxx', thread: null });
          instances.add(answer.instance_id ?? '');
          runs += 1;
        }
      }
      expect(runs).toBe(4);
      expect(instances.size).toBe(1);
      const members = h.db
        .prepare<[string], { task_id: string; position: number }>('SELECT task_id, position FROM kanban_workflow_tasks WHERE instance_id = ? ORDER BY position')
        .all([...instances][0] ?? '');
      for (const m of members) expect(subscriptionsOf(h.db, m.task_id).map((x) => x.conversationId)).toEqual(['oc_xxx']);
      // One reply, on the first member, however many runs.
      expect(members.flatMap((m) => eventsOf(h.db, m.task_id)).filter((e) => e.kind === 'workflow_started')).toHaveLength(1);
      expect(h.db.prepare("SELECT count(*) AS n FROM kanban_tasks WHERE reviewer = 'lark:on_5d1e7a'").get()).toEqual({ n: 1 });
    },
    120_000,
  );

  it('makes each terminal task new with --chat in the docs, its chat following it and queued its "Created" line', async () => {
    let n = 0;
    for (const doc of DOCS) {
      const h = docHome.get(doc) as Home;
      for (const b of blocks.get(doc) ?? []) {
        for (const c of commandsOf(b.body).filter((x) => /^mt kanban task new .*--chat /.test(x.command))) {
          const r = await h.mt([...shellWords(c.command).slice(1), '--json']);
          expect(r.code, `${where(b)}: ${r.out}${r.err}`).toBe(0);
          const answer = JSON.parse(r.out) as { task_id: string; follows: unknown };
          expect(answer.follows, where(b)).toEqual({ chat: 'oc_xxx', thread: null });
          expect(eventsOf(h.db, answer.task_id).map((e) => e.kind), where(b)).toEqual(['created', 'task_created_followed']);
          n += 1;
        }
      }
    }
    // One in the guide's section 11.
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('takes at the terminal a person the docs name by lark:<union_id>, and refuses one the gateway does not know, with the hint', async () => {
    const h = docHome.get('docs/examples.md') as Home;
    const taken = await h.mt(['kanban', 'workflow', 'start', 'content-pipeline', '--param', 'topic=x', '--param', 'approver=lark:on_5d1e7a', '--chat', 'oc_xxx', '--json']);
    expect(JSON.parse(taken.out), taken.err).toMatchObject({ ok: true, existing: false, follows: { chat: 'oc_xxx', thread: null } });
    const r = await h.mt(['kanban', 'workflow', 'start', 'content-pipeline', '--param', 'topic=x', '--param', 'approver=lark:on_x', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: 'person_not_assignable', message: expect.stringMatching(/; mt kanban people lists the people this gateway knows/) });
    expect((await h.mt(['kanban', 'people'])).out).toMatch(/^name\s+person\s+talk\nDana Wu\s+lark:on_5d1e7a\s+talk$/);
```

- [ ] **Step 12.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/docs-examples.test.ts`. Expected: `Tests  2 failed | 23 passed (25)`; among the failures, `AssertionError: expected [] to have a length of 4 but got +0`.

- [ ] **Step 12.3: Implement.**

In `README.md`, replace:

```markdown
mt kanban task new <title> [--board <name>] [--assignee <role>] [--reviewer <role>] [--workspace <name>]
    [--parent <task_id>]... [--outcome "..."] [--verify "..."] [--constraints "..."]
    [--boundaries "..."] [--stop-when "..."] [--body "..." | --body-file <path|->] [--key <key>]
mt kanban task list [todo|ready|running|review|reviewing|blocked|done|archived|all] [--board <name>]
mt kanban task show <task_id> [--board <name>]
mt kanban task assign <task_id> <role> [--board <name>]
```

with:

```markdown
mt kanban task new <title> [--board <name>] [--assignee <role|lark:<union_id>>] [--reviewer <role|lark:<union_id>>]
    [--workspace <name>] [--parent <task_id>]... [--outcome "..."] [--verify "..."] [--constraints "..."]
    [--boundaries "..."] [--stop-when "..."] [--body "..." | --body-file <path|->] [--key <key>]
    [--chat <chat_id> [--thread <thread_id>]]
mt kanban task list [todo|ready|running|review|reviewing|blocked|done|archived|all] [--board <name>]
mt kanban task show <task_id> [--board <name>]
mt kanban task assign <task_id> <role|lark:<union_id>> [--board <name>]
```

In `README.md`, replace:

```markdown
mt kanban workflow start <name> [--board <name>] [--param <key>=<value>]... [--key <key>]
mt kanban workflow apply <dag.json|-> [--key <key>] [--dry-run]
mt kanban workflow archive <instance> [--board <name>]
```

with:

```markdown
mt kanban workflow start <name> [--board <name>] [--param <key>=<value>]... [--key <key>] [--chat <chat_id> [--thread <thread_id>]]
mt kanban workflow apply <dag.json|-> [--key <key>] [--dry-run] [--chat <chat_id> [--thread <thread_id>]]
mt kanban workflow archive <instance> [--board <name>]
mt kanban people
```

In `README.md`, replace:

```markdown
  `assign`, `--assignee` and `--reviewer` take a role: a person is given work from chat, by
  @-mention, where the gateway can check their tier. A task created here is followed by no
  chat, so nobody is told when it is done or blocks: `mt kanban task show` and `task list` tell you. Each
```

with:

```markdown
  `assign`, `--assignee` and `--reviewer` take a role, or a person as `lark:<union_id>`, checked
  as chat checks one: known to this gateway, and at talk tier by the allowlist this shell's
  settings give (the owner, and `auth.talk` or `MT_ALLOW_TALK`). `mt kanban people` lists the
  people the gateway knows, with their union_ids and whether they have talk tier; there are no
  @-mentions at a terminal. A task created here is followed by no chat unless `--chat oc_…`
  names one, checked as `mt cron add --chat` checks it, with `--thread omt_…` for a thread whose
  root the board knows: that chat follows the task as it follows its own, and is posted a
  "Created" line, then the task's notices. A chat outside a non-empty `auth.chats` is refused.
  `workflow start` and `apply` take `--chat` and `--thread` too: every task of the instance is
  followed, and the start's reply is posted there. `task list --json` gives each task's
  `created_at` and `status_since`, in milliseconds, and the plain list an `age` column, the
  time in its status: `45m`, `5h`, `3d`. Each
```

In `README.md`, replace:

```markdown
environment, killed after 120 s, and puts its output in the prompt with the job's previous
result. An answer of exactly `[nothing to report]` is not posted. A fire whose session is
```

with:

```markdown
environment, `$MT_HOME/bin` first on its `PATH` and the gateway's `MT_HOME`, `MT_CONFIG` and
`MT_DB`, so plain `mt` in it is this gateway's, killed after 120 s, and puts its output in the
prompt with the job's previous result. `mt cron add --chat` and `edit --chat` refuse a chat
outside a non-empty `auth.chats`. An answer of exactly `[nothing to report]` is not posted. A fire whose session is
```

In `docs/examples.md`, replace:

```markdown
have used `/kanban`, or been @-mentioned in it, before they can be given work, and needs talk
tier.
```

with:

```markdown
have used `/kanban`, or been @-mentioned in it, before they can be given work, and needs talk
tier. At a terminal, which has no mentions, a person is `lark:<union_id>`: `mt kanban people`
lists the people the gateway knows, with their ids and whether they have talk tier.
```

In `docs/examples.md`, replace:

```markdown
From a terminal on the gateway's host, where a person cannot be given work, so the reviewer is
the `reviewer` role:
```

with:

```markdown
From a terminal on the gateway's host, here with the `reviewer` role as the reviewer; a person
would be `--param reviewer=lark:<union_id>`:
```

In `docs/examples.md`, replace:

```markdown
Not from a terminal: the approver is a person, and a terminal gives no person work, so `mt
kanban workflow start` refuses it. Check the file there:
```

with:

```markdown
From a terminal, the approver is `--param approver=lark:<union_id>`, an id `mt kanban people`
lists, and `--chat oc_xxx` names the group that hears. Check the file there:
```

In `docs/examples.md`, replace:

```markdown
Not from a terminal, as the owners are people. Check the file there:
```

with:

```markdown
From a terminal, the owners are `lark:` ids, `--param owners=lark:on_…,lark:on_…`. Check the
file there:
```

In `docs/examples.md`, replace:

```markdown
Not from a terminal, as the admin and the manager are people. Check the file there:
```

with:

```markdown
From a terminal, the admin and the manager are `lark:` ids, as `mt kanban people` lists them.
Check the file there:
```

In `docs/examples.md`, replace:

```markdown
Not from a terminal, as the releaser is a person. Check the file there:
```

with:

```markdown
From a terminal, the releaser is a `lark:` id, as `mt kanban people` lists it. Check the file
there:
```

In `docs/examples.md`, replace:

```markdown
or from a terminal, as it names no person. Started there, no chat follows the triage task, nor
the workflow it starts, so nobody is told how either goes: watch them with `mt kanban workflow
show w_…`, or start it from chat if a group should hear.
```

with:

```markdown
or from a terminal. Started there, no chat follows the triage task, nor the workflow it starts,
unless `--chat oc_xxx` names one: then that chat follows the triage task, and so the workflow
its run starts, as a run's work follows its task's chats. Without it, watch them with `mt kanban
workflow show w_…`.
```

In `docs/examples.md`, replace:

```markdown
  commands work in it. Its `PATH` is the gateway's own, which need not hold `mt`, and `MT_HOME`
  is not passed, so call the launcher the gateway writes at each start by its path,
  `~/.manus-team/bin/mt`, which finds the home `~/.manus-team` by itself. For a gateway with a
  home of its own, write it out: `MT_HOME=/srv/mt /srv/mt/bin/mt …`.
```

with:

```markdown
  commands work in it. The gateway puts its own `mt` first on the script's `PATH`, and gives it
  its `MT_HOME`, `MT_CONFIG` and `MT_DB`, so plain `mt` in a script is this gateway's `mt`, on
  its own config and database, whatever else the host has installed.

A script runs in the job's workspace, which the role's agents write to: keep the script itself
outside it, under `$MT_HOME` for example, so it never runs what an agent left there. A gateway
run by hand passes its scripts nothing of its own shell but those three: a setting only in that
shell, such as `MT_ALLOW_CHATS`, belongs in the config file or the `.env`, where both read it.
```

In `docs/examples.md`, replace:

````markdown
/cron add "every friday 16:00" worker Below are last week's and this week's open tasks on the board web-app, each as JSON. List each task blocked this week, with its id, title and assignee. Then list each task open in both lists, as stale. One line each. If nothing is blocked or stale, answer [nothing to report].
name: Board review
script: mkdir -p .board-review && ~/.manus-team/bin/mt kanban task list --board web-app --json > .board-review/now.json && echo 'Last week:' && (cat .board-review/last.json 2>/dev/null || echo 'none yet') && echo 'This week:' && cat .board-review/now.json && mv .board-review/now.json .board-review/last.json
```

<!-- example: cron board-review terminal -->
```
mt cron add "every friday 16:00" worker \
    "Below are last week's and this week's open tasks on the board web-app, each as JSON. List each task blocked this week, with its id, title and assignee. Then list each task open in both lists, as stale. One line each. If nothing is blocked or stale, answer [nothing to report]." \
    --name "Board review" --chat oc_xxx \
    --script "mkdir -p .board-review && ~/.manus-team/bin/mt kanban task list --board web-app --json > .board-review/now.json && echo 'Last week:' && (cat .board-review/last.json 2>/dev/null || echo 'none yet') && echo 'This week:' && cat .board-review/now.json && mv .board-review/now.json .board-review/last.json"
```

What happens: each Friday at 16:00 the script lists the board's open tasks, each with its id,
status, title and assignee, and keeps the list in the job's workspace, as
`.board-review/last.json`. It prints the list it kept a week ago, `none yet` the first time,
beside this week's, so the agent can tell which tasks were open both times. The list says no
task's age, which is why "stale" here means "open last week as well". A `/cron run` in the
middle of the week keeps its own list too, and the next Friday compares with that one.

**The pattern:** the script reads the board, because a fire's agent cannot: in its shell the
operator's `mt kanban` commands are refused. And the script keeps the state from one week to
the next, in a file: the job's previous result holds only what the agent last said, here the
tasks it flagged, not the whole board.
````

with:

````markdown
/cron add "every friday 16:00" worker Below are the open tasks on the board web-app, each with its status and its age in that status. List each task that is blocked, and each whose age is 7d or more, with its id, title, assignee and age. One line each. If there are none, answer [nothing to report].
name: Board review
script: mt kanban task list --board web-app
```

<!-- example: cron board-review terminal -->
```
mt cron add "every friday 16:00" worker \
    "Below are the open tasks on the board web-app, each with its status and its age in that status. List each task that is blocked, and each whose age is 7d or more, with its id, title, assignee and age. One line each. If there are none, answer [nothing to report]." \
    --name "Board review" --chat oc_xxx \
    --script "mt kanban task list --board web-app"
```

What happens: each Friday at 16:00 the script lists the board's open tasks, a line each, with
its id, its status, its `age`, how long it has been in that status (`45m`, `5h`, `3d`), its
assignee and its title. The agent flags what is blocked, and what has sat for a week or more.
Nothing is kept between fires: the age is the board's, from the time each task last changed
status, so a `/cron run` in the middle of the week sees the same ages a Friday would.

**The pattern:** the script reads the board, because a fire's agent cannot: in its shell the
operator's `mt kanban` commands are refused. The board's own times say what is stale, so the
script keeps no state of its own.
````

In `docs/examples.md`, replace:

````markdown
/cron add "every monday 09:00" worker The script below has just started this week's report workflow, and printed its answer as JSON. Post the instance_id, and one line: how many tasks it made, or, if existing is true, that this week's report was already started. End with: /kanban workflow show, then the id, follows it.
name: Weekly report
script: ~/.manus-team/bin/mt kanban workflow start weekly-report --board reports --param week=$(date +%G-W%V) --param reviewer=reviewer --key weekly-$(date +%G-%V) --json
```

<!-- example: cron weekly-workflow terminal -->
```
mt cron add "every monday 09:00" worker \
    "The script below has just started this week's report workflow, and printed its answer as JSON. Post the instance_id, and one line: how many tasks it made, or, if existing is true, that this week's report was already started. End with: /kanban workflow show, then the id, follows it." \
    --name "Weekly report" --chat oc_xxx \
    --script '~/.manus-team/bin/mt kanban workflow start weekly-report --board reports --param week=$(date +%G-W%V) --param reviewer=reviewer --key weekly-$(date +%G-%V) --json'
```

The board `reports` is made once, with `/kanban board create reports` or `mt kanban board create
reports`.

What happens: each Monday at 09:00 the script starts weekly-report as the operator, with the
week filled in, such as `2026-W47`. `--key weekly-2026-47` makes the start safe to repeat: a
second start that week, from `/cron run` or a retry, makes nothing and answers with the same
instance and `"existing": true`. `date` runs on the gateway's host, in its zone, not in the
job's `tz`, so near midnight on a Sunday the two can disagree about the week. The agent posts
the id. That post is how the chat hears of it:
a workflow started from a terminal is followed by no chat, so its tasks' notices go nowhere, and
`/kanban workflow show w_…` is how the chat follows it.

**The pattern:** the script does the operator's part, the agent the telling. Two rules make it
this way round. A fire's agent cannot start a workflow: `mt kanban start-workflow` works only in
a board run, and the operator's `mt kanban workflow start` is refused in an agent's shell. And a
terminal gives no person work, so the reviewer is the `reviewer` role here, where chat would
name a person.
````

with:

````markdown
/cron add "every monday 09:00" worker The script below has just started this week's report workflow, and printed its answer as JSON; the gateway posts the start's reply in this chat. If existing is true, say in one line that this week's report was already started. Otherwise answer [nothing to report].
name: Weekly report
script: mt kanban workflow start weekly-report --board reports --param week=$(date +%G-W%V) --param reviewer=lark:on_5d1e7a --key weekly-$(date +%G-%V) --chat oc_xxx --json
```

<!-- example: cron weekly-workflow terminal -->
```
mt cron add "every monday 09:00" worker \
    "The script below has just started this week's report workflow, and printed its answer as JSON; the gateway posts the start's reply in this chat. If existing is true, say in one line that this week's report was already started. Otherwise answer [nothing to report]." \
    --name "Weekly report" --chat oc_xxx \
    --script 'mt kanban workflow start weekly-report --board reports --param week=$(date +%G-W%V) --param reviewer=lark:on_5d1e7a --key weekly-$(date +%G-%V) --chat oc_xxx --json'
```

The board `reports` is made once, with `/kanban board create reports` or `mt kanban board create
reports`.

What happens: each Monday at 09:00 the script starts weekly-report as the operator, with the
week filled in, such as `2026-W47`, and Dana Wu, `lark:on_5d1e7a`, as the reviewer: the start
checks her as chat would, known to the gateway and at talk tier. `--chat oc_xxx`, this chat's id,
makes the chat follow every task of the instance, and the gateway posts the start's reply here,
naming the instance and its tasks, then each task's notices. `--key weekly-2026-47` makes the
start safe to repeat: a second start that week, from `/cron run` or a retry, makes nothing,
posts nothing, and answers with the same instance and `"existing": true`, which the agent says.
`date` runs on the gateway's host, in its zone, not in the job's `tz`, so near midnight on a
Sunday the two can disagree about the week.

**The pattern:** the script does the operator's part, the gateway the telling. A fire's agent
cannot start a workflow: `mt kanban start-workflow` works only in a board run, and the
operator's `mt kanban workflow start` is refused in an agent's shell. So the script starts it,
`--chat` says who hears, and the agent speaks only when there is something the reply does not
say.
````

In `docs/kanban-guide.md`, replace:

```markdown
mt kanban task stop k_…
```

with:

```markdown
mt kanban task stop k_…
mt kanban people
mt kanban task new "Book the venue for the offsite" --assignee lark:on_5d1e7a --chat oc_xxx
```

In `docs/kanban-guide.md`, replace:

```markdown
- Only roles: give a person work from chat, by @-mention.
- No chat follows a task created here, so nobody is told when it is done or blocks. Look with
  `mt kanban task show`, or create it from chat if a group should hear.
```

with:

```markdown
- A person is `lark:<union_id>`: `--assignee`, `--reviewer` and `task assign` take one, checked
  as chat checks one: known to this gateway, and at talk tier by the owner and `auth.talk` this
  shell's settings give. `mt kanban people` lists the people the gateway knows, by name, with
  their `lark:` ids and `talk` or `no`. There are no @-mentions here: `@Alice` is refused.
- `--chat oc_…` makes that chat follow the task, as a chat follows a task made in it: the gateway
  posts it a line, "Created `k_…` **Book the venue for the offsite**, for Dana Wu, by
  operator:alice from a terminal.", then the task's notices. `--thread omt_…` puts them in a thread
  of that chat whose root the board already knows, from a task made in it from chat; a thread it
  does not know is refused. A chat outside a non-empty `auth.chats` is refused, as the gateway
  would not answer there. Without `--chat`, no chat follows the task, so nobody is told when it
  is done or blocks: look with `mt kanban task show`. The board is still `--board`, whatever the
  chat. With `--key`, a second run answers the first task and names the chat that follows it.
- `task list` has an `age` column, how long each task has been in its status, `45m`, `5h` or
  `3d`; `--json` gives each task's `created_at` and `status_since`, in milliseconds.
```

In `docs/kanban-guide.md`, replace:

```markdown
kanban workflow show w_… --dag` prints the DAG an instance was made from, which `apply` takes
again.

```

with:

```markdown
kanban workflow show w_… --dag` prints the DAG an instance was made from, which `apply` takes
again.

`start` and `apply` take `--chat oc_… [--thread omt_…]` as `task new` does: every task of the
instance is followed from that chat, and the gateway posts there the start's reply, naming the
instance and its tasks. A param that lands in a person field, and a DAG's `assignee` or
`reviewer`, take `lark:<union_id>`, checked at the start and by `apply --dry-run`; the preview
opens no database, so it leaves people unchecked and says so.

```

- [ ] **Step 12.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2553 passed (2553)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors. `git diff e703833 -- README.md docs/kanban-guide.md docs/examples.md | grep "^+" | grep -c "—"` prints `0`.

- [ ] **Step 12.5: Commit.**

```bash
git add README.md docs/examples.md docs/kanban-guide.md tests/docs-examples.test.ts
git commit -m "Document the terminal's chats, people and times in the README and the guide, and in docs/examples.md call plain mt, review the board by age, and pass --chat and a person to the weekly workflow; check them in tests/docs-examples.test.ts"
```

---


## Done when

- `npx vitest run --project unit` gives `Tests  2553 passed (2553)`. `npx vitest run --project e2e` gives `Tests  172 passed (172)`, run twice. `npm run typecheck` and `npm run build` report no errors. All under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing, and `git diff e703833 -- 'src/*.ts' 'src/**/*.ts' README.md docs/kanban-guide.md docs/examples.md | grep "^+" | grep -c "—"` prints `0`.
- A chat named at the terminal follows the task, or every member, in the one transaction, and hears a "Created" line or the start's reply first, resent after a restart with the same uuid; a repeat adds nothing; `follow` is refused from chat and from a run (`tests/kanban-follow.test.ts`, `tests/kanban-workflow-started.test.ts`, `tests/mt-terminal-chat.test.ts`).
- A person is taken at the terminal as chat takes one, refused in chat's words with the hint, or with the setting this shell lacks; no `@`; `mt kanban people` lists them (`tests/mt-board-people.test.ts`, `tests/mt-terminal-people.test.ts`, `tests/mt-kanban-people.test.ts`).
- `task list` gives `created_at`, `status_since` and `age` from one query (`tests/kanban-phase-since.test.ts`).
- A cron script's plain `mt` is the gateway's, on its files; `mt cron --chat` names no chat outside `auth.chats` (`tests/cron-script-env.test.ts`, `tests/mt-cron-chats.test.ts`, `tests/docs-examples.test.ts`).

## Before relying on it: the smoke checklist

For the user, once the plan is built and merged, on the Mac with the real Lark tenant. Run each command as the gateway's user. `<node>` is `~/.nvm/versions/node/v22.15.0/bin/node`, and `<mt>` is `<node> <checkout>/dist/mt.js`: never a bare `node`, `npm` or `mt`. Every build runs under the same Node: `PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH npm run build`. The items need `kanban.enabled: true`, a group the bot is in, its chat id `oc_…` (`<mt> cron list` shows a job's, or the Lark admin console), you at talk tier, and a second person the bot has seen who is not.

0. **Back up first.** This plan writes no migration, but its first `--chat` writes new rows. Find the file the gateway uses: `MT_DB` in the service's environment or `~/.manus-team/.env`, else `db:` in `~/.manus-team/config.yaml`, else `~/.manus-team/team.db`. Stop the service, `<mt> service stop`, and back it up with SQLite's own backup, `sqlite3 <db> ".backup /tmp/team-before-terminal.db"` (`/usr/bin/sqlite3` on macOS); with no `sqlite3`, copy it while the gateway is stopped, `cp <db> /tmp/team-before-terminal.db`, and its `-wal` file beside it if there is one. To read it, open it immutable, `sqlite3 "file:<db>?immutable=1" "…"`, or read the backup. Build (`cd <checkout> && PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH npm run build`), then `<mt> service start`.
1. **People.** `<mt> kanban people` lists the people the bot has seen, by name, with `lark:on_…` and `talk` for you, `no` for the second person. `<mt> kanban people --json` gives the same as JSON.
2. **A task the group follows.** `<mt> kanban task new "Smoke: book the room" --assignee default --chat oc_…` answers `created k_…: Smoke: book the room, for role default, on board default; chat oc_… follows it`. Within a few seconds the group gets "Created `k_…` **Smoke: book the room**, for role default, by operator:yourlogin from a terminal.", then the task's notices as it runs. `/kanban task show k_…` in the group shows it.
3. **A person.** `<mt> kanban task new "Smoke: a person's task" --assignee lark:<your union_id> --chat oc_…` is made, and your card comes, in the group's thread if it has one for the task, else by direct message. The same with the second person's id is refused: `… cannot be given work: being assigned lets a person report on the task, which needs talk tier, …; mt kanban people lists the people this gateway knows, …`. `--assignee @You` is refused: `there are no @-mentions at the terminal: …`.
4. **A thread.** In the group, `/kanban task new Smoke: a thread to follow` opens a thread on its reply. Read its ids: `sqlite3 "file:<db>?immutable=1" "SELECT conversation_id, thread_id, root_message_id FROM kanban_subscriptions ORDER BY id DESC LIMIT 1"`. `<mt> kanban task new "Smoke: in the thread" --chat <conversation_id> --thread <thread_id>` posts its "Created" line in that thread. `--thread omt_nothing` is refused: `no root is known for thread omt_nothing in oc_…: …`.
5. **A workflow.** With a workflow that names roles only, `<mt> kanban workflow start <name> --param … --chat oc_… --key smoke-1` ends `chat oc_… follows its tasks, and is sent the start's reply`, and the group gets `operator:yourlogin started <name> from a terminal as w_…, N tasks:` with a line a task. Run it again: `already made, as w_…`, `chat oc_… follows its tasks`, and nothing is posted. `<mt> kanban workflow apply <dag.json> --dry-run --chat oc_…` ends `chat oc_… would follow its tasks, and be sent the start's reply`, and makes nothing.
6. **Times.** `<mt> kanban task list` has an `age` column between the status and the assignee, `0m` for the smoke tasks; `<mt> kanban task list --json` gives each task `created_at` and `status_since` in milliseconds.
7. **A script's plain mt.** With `cron.enabled: true`, `<mt> cron add "every 5m" worker "Say in one line how many tasks the list below shows." --script 'mt kanban task list' --chat oc_… --name "Smoke list"`. Within five minutes and thirty seconds its answer, counting the tasks, arrives in the group. If `auth.chats` is set, `<mt> cron add "every 5m" worker "x" --chat oc_<one not in it>` is refused: `oc_… is not in auth.chats, so this gateway does not act in it: …`, as is `<mt> kanban task new x --chat oc_<the same>`.
8. **Clean up.** `<mt> cron remove c_…` for the smoke job; `<mt> kanban task archive k_…` for each smoke task, and `<mt> kanban workflow archive w_…` for the smoke instance. `/tmp/team-before-terminal.db` is the way back to the database before the smoke test.
