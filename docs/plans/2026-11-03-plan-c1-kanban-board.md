# Plan C1 — The board: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The kanban board exists, with no agent runs and no socket yet: tasks with dependency links, comments, assignees and a completion contract; one stored phase with one writer, and a derived display status; every transition of spec §5.1; runs as rows, opened by a claim and decided by a report or by an ending; and a service API that plans C2, C3 and D call.

**Architecture:**
- **Schema.** Migration `003_kanban.sql` creates every kanban table of spec §3, including gates and subscriptions, so that no later plan migrates again. The database itself refuses what the lifecycle forbids: two open runs on one task, two runs with one token, a stored `running`, a closed run with no outcome.
- **One writer.** `src/db/kanban.ts` is the only module that writes a `kanban_` table. `phase` changes only through its named transitions: `claim`, `complete`, `requestReview`, `requestChanges`, `block`, `unblock`, `stop`, `endRun`, `assign`, `assignReviewer`, `archive`. Each one reads the task inside its transaction and refuses an illegal move. A refused change rolls back whatever it had written. Every change writes one `kanban_events` row in the same transaction.
- **Reads.** `src/db/kanban-read.ts` decodes rows and builds the view `show` returns.
- **Derived status.** `src/kanban/status.ts` is one pure function from the phase, the parents and the undecided run (spec §4.1).
- **Workspace rules.** `src/kanban/workspace.ts` is one pure function for the four rules of spec §2.3. The claim gathers the facts inside its transaction and calls it.
- **Masking on write.** Free text and the string values of event payloads go through F's `redactKnownSecrets` and `redactValues` before they are stored (spec §10.1 layer 3). The board's ids and names are exempted for its own payloads only.
- **The service.** `src/kanban/service.ts` checks what rows cannot: configured roles and workspaces, the shape of input from chat or an agent's JSON, and who may be given work. Until plan D it refuses people and supervised roles. It resolves the role at a claim, including its `role.md`, and passes everything else to `db/kanban.ts`.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §2.3 (the bullet "A task's workspace is resolved at a claim…"), §3, §4, §5, §10.1 layer 3, and the C1 row of §12.

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on branch `kanban-board`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, and never write to `~/.manus-team`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Secrets.** Never print secret values. Tests use made-up values only.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` gives `Tests  591 passed (591)`. `npm run test:e2e` gives `Tests  49 passed (49)`. `npm run typecheck` prints nothing.
- **Finding edits.** Find each edit by its quoted text, not by line number.
- **The secret registry is process-wide.** Every test file that adds secrets calls `clearSecrets()` in `beforeEach` and `afterEach`.
- **Tests use real SQLite** through `testDb()`, with no mocks. Times are fixed numbers, or a `ManualClock` in the service tests.

## Decisions the spec left open

Each is the reading most consistent with the rest of the spec. Decisions 1 and 2 were confirmed by the user, and the spec now says them (§3.2, §4.1, §5.1, §5.4, §7.3).

1. **A dependency block names its prerequisites.** The spec used to say the worker "links the prerequisite as a parent first", but §3.2 refuses a link onto a task with an open run, and the worker's own run is open. So the block report carries `parents`. They are linked in the block's own transaction, after the run is decided, so the link cannot un-start anything. A dependency block that leaves nothing unfinished to wait on is refused: the task would be claimable again at once. Plan C3's `mt kanban block` JSON is `{kind, reason, parents}`.
2. **A reviewer's dependency block keeps the task in review.** The review run is decided `blocked`, the task stays in phase `review`, and the parents are linked. The implementer's work is done; only the review was waiting, so it is not redone.
   - **Claimable:** a review claim, like a work claim, needs every parent finished. Once they are, the reviewer is claimed again.
   - **Shown:** `todo`. The status means "held back by a parent that is not done", in `open` or in `review`: nobody can act until the parent is. `review` keeps meaning "waiting for a reviewer", so `/kanban list review` lists only reviews someone can start.
   - **Stored:** nothing new. The phase is still the only lifecycle column, and `block` writes it, here by not changing it.

   An implementer's dependency block stays as before: the task stays `open`, shown as `todo`.
3. **No link onto a task past its parents gate.** A public `link` is refused, with `illegal_transition`, onto a task in review, blocked from review, done or archived. A parent added then could never hold it back, and a review would wait on it forever. Only a dependency block links onto a task in review, through the internal `linkIn`, which the public `link` checks the phase before calling.
4. **An archived parent counts as finished**, both for readiness and for completion. §4.1 says "done/archived"; §5.1 says "parents are not all done". An archived parent will never be done, so reading §5.1 strictly would strand its children forever.
5. **`block_kind` and `block_reason` are set only by a block that enters `blocked`.** That is every kind except `dependency`, which never sits in `blocked` (§5.4). A dependency block leaves the last kind as it was, and is never counted as a recurrence. The schema's `block_kind` check leaves out `dependency`.
6. **`/kanban assign` on a task in review.** §5.1 says "running or reviewing … the next claim goes to the new assignee", and the next claim in `review` goes to the reviewer. So there are two operations:
   - `assign` sets the assignee and supersedes an open **work** run;
   - `assignReviewer` sets the reviewer and supersedes an open **review** run.

   Plan D maps `/kanban assign` onto `assignReviewer` while the task is in review, and onto `assign` otherwise. Assigning the current assignee again changes nothing.
7. **Where a reason is stored.** §3.3 has no reason column.
   - A reviewer's `changes` reason is stored as the review run's `summary`. The rework's prompt reads it from there. With no review run (a person's changes), the reason is only in the `changes_requested` event; C4 reads it from there.
   - A block's reason is stored on the task, in `block_reason`, and also as the blocking run's `summary`.
8. **`created_from_task` is set whenever a run creates a task**, as provenance. Rule 3 of §2.3 uses it only when the task has no parents.
9. **Seeding a rework needs something to resume.** §5.3 says `seeded_from_run` names "the run whose provider session was actually resumed". So it is set only when the work run's session observed a provider session id, as well as running the same driver, command and arguments. A rework is a work claim that directly follows a review run ending `changes_requested`.
10. **"Any other outcome resets `consecutive_transient`"** (§8.2) means every run outcome except `rate_limited`, including reports, `cancelled` and `superseded`.
11. **The order of the breaker's checks.**
    - For `rate_limited`, the transient limit is checked before `if-no-side-effects`: at the limit there is no retry to hold back.
    - `interrupted` is not counted, and is held for a person under `if-no-side-effects` when the run had side effects (§8.3, §8.4).
    - `terminal_provider` is not counted either.
12. **Unblocking a throttled run held for a person keeps `consecutive_transient`.** A `rate_limited` run under `if-no-side-effects` that changed things blocks as `needs_input`, with the count below the limit. §8.2 resets the count only when a `transient` block is unblocked, because there the next throttle would block the task again at once. Here it would not: the next throttle continues the count and its doubling cooldown, and any other outcome resets it. A person looking at the side effects has not fixed the throttling.
13. **A person's report** (complete, review, changes or block) is accepted with no open run. With an open person's run, it decides that run. While an agent run is open it is refused, as §5.1 says. Which person may act is plan D's to check.
14. **The settings.** `kanban.failure_limit`, `transient_limit` and `transient_cooldown_s` are not parsed from config in C1. They are a `KanbanLimits` parameter, defaulting to the spec's values (2, 10, 300 s). Plan C2 reads the `kanban:` section.
15. **Two of the dispatcher's skips are also refused inside the claim's transaction**, as a backstop against a racing pass: a cooldown still running, and a workspace with an open agent run. `max_running` stays the dispatcher's (C2).
16. **`skipped_unassignable` is written once** (§4.2). That means once until any other event is written on the task, so a pass every minute adds nothing to the log.
17. **`role.md` is read once, by the service's claim.** It is hashed into the run and returned, so that C2 composes the prompt from exactly the text whose hash the run records. A role.md or skill file that cannot be read makes the role unassignable (§2.1).
18. **People and supervised roles** are refused by the service by default, at creation, at assignment, as a review report's reviewer, and at a claim. Plan D passes `people` (with the talk-tier check of §4.2) and `supervisedRoles: true`. A person is named `lark:<union_id>`. Any other name containing `:` is refused as invalid.
19. **More free text is masked.** On top of the fields §10.1 lists, the completion contract's fields and a block's reason are masked on write too: they are free text and are shown to agents.
20. **The board's identifying keys are its own.** `kanban_events` payloads keep their ids and names (`taskId`, `runId`, `parentId`, `assignee`, `reviewer`, `workspace` and others) unmasked, through an extra-keys argument to `redactValues` that only `db/kanban.ts` passes. They are not added to the global `IDENTIFYING_KEYS`, which also exempts keys in session events and approvals, whose payloads an agent shapes.
21. **`/kanban stop` on a run that has already reported** writes nothing. The run is returned, and plan C2 cancels its turn and then calls `closeRun`.
22. **`endRun` refuses a person's run.** A person's run has no process to end, and never times out (§4.2).

## Out of scope (later plans)

- **Plan C2, agent runs:**
  - the dispatcher: passes, ordering by priority then age, `max_running`, the sweep, and noticing stranded tasks (`stranded_after_s`; setting `stranded_notified_at`, which a claim clears);
  - creating a run's session on the sink channel, then `attachSession`;
  - prompt composition, and layer 2 masking of the composed context and `last_output`;
  - the failure classifier, which supplies `endRun`'s outcome;
  - reading the tool calls a run made, which supplies `hadSideEffects`;
  - closing runs when their turn ends;
  - restart handling, the runtime limit and its `max_runtime_s`;
  - parsing the `kanban:` config section;
  - the `submissions` count;
  - a listing of ready tasks for the dispatcher to claim from, which C1 does not have;
  - each parent's latest summary, read for the prompt's handoff section.
- **Plan C3, the worker CLI:**
  - minting the run token and storing its `token_hash`, which the schema keeps unique;
  - registering the token with the masker, reference-counted;
  - the `0600` socket and the `mt kanban` commands, which map onto this service, with `block` taking `{kind, reason, parents}`;
  - passing a worker's `idempotency_key` through unchanged: the service already stores a run's key as `run-task:<its run's task_id>:<key>` and refuses a `lark:` key from anyone but chat, so two runs' keys cannot collide with each other or with chat's;
  - creating a task from a run, which inherits the run's task's subscriptions;
  - stop nudges, and forwarding comments to an undecided run;
  - capturing `reported_commit` and `reported_dirty` before a report;
  - size limits on the text a worker sends: title, body, contract, summary.
- **Plan C4, review, rework and gates:**
  - running gates inside `complete` and `requestReview`;
  - refusing a gate that contains a known secret;
  - the rework prompt;
  - a masked crash handler.
- **Plan D, Lark:**
  - the `/kanban` commands and cards;
  - which person may act on which task;
  - subscriptions, and notifications such as the block-recurrence warning at `block_recurrence_limit`;
  - turning on `people` and `supervisedRoles`;
  - size limits on the text a person sends: title, body, contract, summary.
- **The README.** It changes when the board can be used, in C3 or D. C1 has no surface a person can reach.

### What later plans need from the board

C1 does not have these; the plans that use them add them to `db/kanban-read.ts` or `db/kanban.ts`.

- **C2:**
  - a listing of every open run, for restart handling;
  - finding a run by its session id;
  - a count of open agent runs, for `max_running`;
  - a writer for `stranded_notified_at`;
  - a task in its cooldown still shows `ready`, so the dispatcher must check `cooldownUntil` itself, or rely on the claim refusing it as `not_claimable`;
  - the rework seed trusts `sessions.provider_session_id`, which may be a seeded hint rather than an id the session observed: C2 decides whether a second rework may resume from a hint nobody confirmed.
- **C3:**
  - finding a run by its token hash;
  - a writer for `submissions`.
- **D:** a list view, with each task's display status.

## File structure

| File | Responsibility |
|---|---|
| `schema/003_kanban.sql` (create) | every kanban table of spec §3 |
| `src/db/WRITERS.md` (modify) | `db/kanban.ts` owns every `kanban_` table |
| `src/core/ids.ts` (modify) | `newTaskId`, `newRunId` |
| `src/secrets.ts` (modify) | `redactValues` takes extra identifying keys for one caller |
| `src/kanban/types.ts` (create) | phases, block kinds, outcomes, rows, refusals |
| `src/kanban/status.ts` (create) | `displayStatus`, the derived status |
| `src/kanban/workspace.ts` (create) | `resolveTaskWorkspace`, the four rules |
| `src/db/kanban-read.ts` (create) | decoders, reads, `taskView` |
| `src/db/kanban.ts` (create) | the only writer: every transition |
| `src/kanban/service.ts` (create) | `KanbanService`, the API later plans call |
| `tests/helpers/kanban.ts` (create) | building tasks and claims for tests |
| `tests/kanban-*.test.ts` (create); `tests/ids.test.ts`, `tests/secrets.test.ts` (modify) | |

---
### Task 1: Ids for tasks and runs

**Files:**
- Modify: `src/core/ids.ts`, `tests/ids.test.ts`

Both are random ids (see the module's comment): a task or run did not exist before, and its id must not be guessable or reproducible.

- [ ] **Step 1.1: Write the failing test.** In `tests/ids.test.ts`:
  - in the import from `../src/core/ids.js`, replace `newApprovalId,` / `newSessionId,` with:

```ts
  newApprovalId,
  newRunId,
  newSessionId,
  newTaskId,
```

  - directly after the end of the test "is prefixed by kind, so a mis-passed id is obvious in a log", that is after

```ts
    expect(newApprovalId()).toMatch(/^a_[0-9a-z]{12}$/);
  });
```

    add:

```ts
  it('names kanban tasks k_ and runs r_', () => {
    expect(newTaskId()).toMatch(/^k_[0-9a-z]{12}$/);
    expect(newRunId()).toMatch(/^r_[0-9a-z]{12}$/);
  });
```

- [ ] **Step 1.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/ids.test.ts`. Expected: the new test FAILS with `TypeError: (0 , newTaskId) is not a function`, and `Tests  1 failed | 13 passed (14)`.

- [ ] **Step 1.3: Implement.** In `src/core/ids.ts`, directly after `newApprovalId`:

```ts
export function newApprovalId(): string {
  return `a_${randomToken(12)}`;
}
```

add:

```ts
/** A kanban task (spec §3.1). Opaque: nothing reads meaning into it. */
export function newTaskId(): string {
  return `k_${randomToken(12)}`;
}

/** One attempt at a kanban task (spec §3.3). */
export function newRunId(): string {
  return `r_${randomToken(12)}`;
}
```

- [ ] **Step 1.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  592 passed (592)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 1.5: Commit.**

```bash
git add src/core/ids.ts tests/ids.test.ts
git commit -m "Mint ids for kanban tasks and runs"
```

---

### Task 2: Migration `003_kanban.sql`

**Files:**
- Create: `schema/003_kanban.sql`, `tests/kanban-schema.test.ts`
- Modify: `src/db/WRITERS.md`

Every kanban table of spec §3 is created here, including `kanban_gates` (written from C4) and `kanban_subscriptions` (from D), so that the board never migrates again for v1. The tables are STRICT. JSON columns are JSONB blobs, written with `jsonb(?)` and read with `json(col)`, as `events.payload` is.

The database refuses what the lifecycle forbids, as a backstop under `db/kanban.ts`'s own checks:
- **one open run per task**, by a partial unique index. Two claims racing then fail at the database instead of starting two agents (spec §3.3);
- **one run per session**, and **one run per token hash**, by two more partial unique indexes. The worker CLI finds a run by its token's hash (plan C3);
- **a stored `running`**: only the five phases are allowed;
- **`blocked` without `blocked_from`**, or `blocked_from` on a task that is not blocked;
- **a closed run with no outcome**;
- **a self-link**.

- [ ] **Step 2.1: Write the failing tests.** Create `tests/kanban-schema.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from './helpers/db.js';

/**
 * The shape of the board's tables (spec §3). These tests write raw rows on
 * purpose: they check what the database itself refuses, the backstop under
 * db/kanban.ts's own checks.
 */
const NOW = 1_760_000_000_000;
let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

function task(id: string, extra: Record<string, string | number | null> = {}): void {
  const row: Record<string, string | number | null> = {
    task_id: id,
    title: 't',
    phase: 'open',
    created_by: 'test',
    created_at: NOW,
    ...extra,
  };
  const cols = Object.keys(row);
  // The JSON columns are JSONB blobs, as db/kanban.ts writes them.
  h.db
    .prepare(
      `INSERT INTO kanban_tasks (contract, created_via, ${cols.join(', ')})
       VALUES (jsonb('{}'), jsonb('{}'), ${cols.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row));
}

function run(id: string, taskId: string, attempt: number, extra: Record<string, string | number | null> = {}): void {
  const row: Record<string, string | number | null> = {
    run_id: id,
    task_id: taskId,
    attempt,
    kind: 'work',
    assignee_kind: 'role',
    assignee: 'implementer',
    started_at: NOW,
    ...extra,
  };
  const cols = Object.keys(row);
  h.db
    .prepare(
      `INSERT INTO kanban_runs (agent_config, ${cols.join(', ')})
       VALUES (jsonb('{}'), ${cols.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row));
}

describe('migration 003', () => {
  it('creates every kanban table, all STRICT', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(3);
    const tables = h.db
      .prepare<[], { name: string; strict: number }>(
        "SELECT name, strict FROM pragma_table_list WHERE name LIKE 'kanban_%' ORDER BY name",
      )
      .all();
    expect(tables).toEqual([
      { name: 'kanban_comments', strict: 1 },
      { name: 'kanban_events', strict: 1 },
      { name: 'kanban_gates', strict: 1 },
      { name: 'kanban_links', strict: 1 },
      { name: 'kanban_runs', strict: 1 },
      { name: 'kanban_subscriptions', strict: 1 },
      { name: 'kanban_tasks', strict: 1 },
    ]);
  });

  it('allows one open run per task, and another once it is closed', () => {
    // Two dispatch passes racing to claim one task fail here instead of starting two agents.
    task('k_1');
    run('r_1', 'k_1', 1);
    expect(() => run('r_2', 'k_1', 2)).toThrow(/UNIQUE constraint failed/);
    h.db.prepare("UPDATE kanban_runs SET outcome = 'failed', ended_at = ? WHERE run_id = 'r_1'").run(NOW);
    run('r_2', 'k_1', 2);
  });

  it('refuses two runs with one token hash', () => {
    // The worker CLI finds a run by its token's hash (plan C3).
    task('k_1');
    task('k_2');
    run('r_1', 'k_1', 1, { token_hash: 'hash-of-token' });
    expect(() => run('r_2', 'k_2', 1, { token_hash: 'hash-of-token' })).toThrow(/UNIQUE constraint failed/);
    run('r_3', 'k_2', 1);
  });

  it('refuses rows that break the lifecycle', () => {
    expect(() => task('k_a', { phase: 'running' })).toThrow(/CHECK constraint failed/);
    expect(() => task('k_b', { phase: 'blocked' })).toThrow(/CHECK constraint failed/);
    expect(() => task('k_c', { blocked_from: 'open' })).toThrow(/CHECK constraint failed/);
    task('k_d');
    expect(() => run('r_1', 'k_d', 1, { ended_at: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => h.db.prepare("INSERT INTO kanban_links VALUES ('k_d', 'k_d', ?)").run(NOW)).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('keeps idempotency keys unique, and allows any number of tasks without one', () => {
    task('k_1', { idempotency_key: 'lark:om_1' });
    expect(() => task('k_2', { idempotency_key: 'lark:om_1' })).toThrow(/UNIQUE constraint failed/);
    task('k_3');
    task('k_4');
  });
});
```

- [ ] **Step 2.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-schema.test.ts`. Expected: all 5 FAIL. The first fails with `expected 2 to be 3`; the others with `no such table: kanban_tasks`.

- [ ] **Step 2.3: Implement.** Create `schema/003_kanban.sql`:

```sql
-- manus-team migration 003: the kanban board
-- See docs/specs/2026-11-02-kanban-design.md §3.
--
-- Every kanban table is created here, including the ones later plans write
-- (gates, subscriptions), so that the board never migrates again for v1.
-- db/kanban.ts is the only writer of every table below (src/db/WRITERS.md).

-- ---------------------------------------------------------------------------
-- Tasks. `phase` is the only lifecycle column (§4.1); todo / ready / running
-- are derived from the parents and the runs, never stored.
-- ---------------------------------------------------------------------------
CREATE TABLE kanban_tasks (
  task_id               TEXT PRIMARY KEY,          -- k_..., opaque
  title                 TEXT NOT NULL,
  body                  TEXT NOT NULL DEFAULT '',
  contract              BLOB NOT NULL,             -- JSON: outcome, verification, constraints,
                                                   -- boundaries, stop_when; all optional (§4.3)
  assignee_kind         TEXT CHECK (assignee_kind IN ('role', 'human')),
  assignee              TEXT,                      -- role name, or lark:<union_id>
  reviewer_kind         TEXT CHECK (reviewer_kind IN ('role', 'human')),
  reviewer              TEXT,
  workspace             TEXT,                      -- a name; "fixed" means non-null (§2.3)
  phase                 TEXT NOT NULL CHECK (phase IN ('open', 'review', 'blocked', 'done', 'archived')),
  blocked_from          TEXT CHECK (blocked_from IN ('open', 'review')),
  block_kind            TEXT CHECK (block_kind IN ('needs_input', 'capability', 'transient', 'gave_up')),
  block_reason          TEXT,                      -- the kind and reason survive unblock (§5.4)
  priority              INTEGER NOT NULL DEFAULT 0,
  idempotency_key       TEXT UNIQUE,
  failure_limit         INTEGER,
  retry_on_crash        TEXT NOT NULL DEFAULT 'always'
                          CHECK (retry_on_crash IN ('always', 'if-no-side-effects')),
  max_runtime_s         INTEGER,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  consecutive_transient INTEGER NOT NULL DEFAULT 0,
  cooldown_until        INTEGER,
  block_recurrences     INTEGER NOT NULL DEFAULT 0,
  stranded_notified_at  INTEGER,
  created_by            TEXT NOT NULL,
  created_via           BLOB NOT NULL,             -- JSON: the chat, or the creating run
  created_at            INTEGER NOT NULL,
  closed_at             INTEGER,
  created_from_task     TEXT REFERENCES kanban_tasks(task_id),  -- not a link (§2.3)

  CHECK ((assignee_kind IS NULL) = (assignee IS NULL)),
  CHECK ((reviewer_kind IS NULL) = (reviewer IS NULL)),
  -- blocked_from is set with blocked and only then; a blocked task always has a kind.
  CHECK ((phase = 'blocked') = (blocked_from IS NOT NULL)),
  CHECK (phase <> 'blocked' OR block_kind IS NOT NULL)
) STRICT;

CREATE INDEX idx_kanban_tasks_phase ON kanban_tasks(phase, priority DESC, created_at);

-- ---------------------------------------------------------------------------
-- Dependency links. Cycles and links onto a task with an open run are refused
-- by the writer (§3.2); a self-link is refused here too.
-- ---------------------------------------------------------------------------
CREATE TABLE kanban_links (
  parent_id   TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  child_id    TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (parent_id, child_id),
  CHECK (parent_id <> child_id)
) STRICT;

CREATE INDEX idx_kanban_links_child ON kanban_links(child_id);

-- ---------------------------------------------------------------------------
-- Runs: one attempt each (§3.3). Decided when `outcome` is set, closed when
-- `ended_at` is. A closed run is always decided.
-- ---------------------------------------------------------------------------
CREATE TABLE kanban_runs (
  run_id           TEXT PRIMARY KEY,               -- r_...
  task_id          TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  attempt          INTEGER NOT NULL,               -- from 1 per task, across kinds
  kind             TEXT NOT NULL CHECK (kind IN ('work', 'review')),
  assignee_kind    TEXT NOT NULL CHECK (assignee_kind IN ('role', 'human')),
  assignee         TEXT NOT NULL,                  -- a snapshot: reassigning does not rewrite it
  agent_config     BLOB,                           -- JSON; an agent run's agent, env NAMES only
  workspace        TEXT,
  role_md_hash     TEXT,
  session_id       TEXT REFERENCES sessions(id),
  seeded_from_run  TEXT REFERENCES kanban_runs(run_id),
  token_hash       TEXT,                           -- the token itself is never stored
  outcome          TEXT CHECK (outcome IN (
                     'completed', 'review_requested', 'changes_requested', 'blocked',
                     'failed', 'crashed', 'timed_out', 'protocol_violation', 'rate_limited',
                     'terminal_provider', 'interrupted', 'cancelled', 'superseded')),
  summary          TEXT,
  metadata         BLOB,                           -- JSON
  reported_commit  TEXT,
  reported_dirty   INTEGER,
  error            TEXT,
  last_output      TEXT,
  submissions      INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  UNIQUE (task_id, attempt),
  CHECK (ended_at IS NULL OR outcome IS NOT NULL),
  CHECK ((assignee_kind = 'role') = (agent_config IS NOT NULL))
) STRICT;

-- At most one open run per task: two claims racing fail here, not as two agents.
CREATE UNIQUE INDEX idx_kanban_runs_one_open ON kanban_runs(task_id) WHERE ended_at IS NULL;
-- One gateway session belongs to at most one run.
CREATE UNIQUE INDEX idx_kanban_runs_session ON kanban_runs(session_id) WHERE session_id IS NOT NULL;
-- The worker CLI finds a run by its token's hash (plan C3); no two runs share one.
CREATE UNIQUE INDEX idx_kanban_runs_token ON kanban_runs(token_hash) WHERE token_hash IS NOT NULL;
-- The per-workspace limit counts open agent runs (§6.3).
CREATE INDEX idx_kanban_runs_open_ws ON kanban_runs(workspace)
  WHERE ended_at IS NULL AND assignee_kind = 'role';

-- ---------------------------------------------------------------------------
-- Comments, gates, subscriptions (§3.4).
-- ---------------------------------------------------------------------------
CREATE TABLE kanban_comments (
  id          INTEGER PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_kanban_comments_task ON kanban_comments(task_id, id);

-- Written from plan C4. A command is never masked: a gate containing a known
-- secret is refused at creation instead (§10.1).
CREATE TABLE kanban_gates (
  id          INTEGER PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  command     TEXT NOT NULL,
  timeout_s   INTEGER NOT NULL DEFAULT 300,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_kanban_gates_task ON kanban_gates(task_id, id);

-- Written from plan D. The same cursor discipline as a binding's cursor_seq.
CREATE TABLE kanban_subscriptions (
  id               INTEGER PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  channel          TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  thread_id        TEXT NOT NULL DEFAULT '',
  cursor           INTEGER NOT NULL DEFAULT 0,      -- last kanban_events.id delivered
  created_at       INTEGER NOT NULL,
  UNIQUE (task_id, channel, account_id, conversation_id, thread_id)
) STRICT;

-- ---------------------------------------------------------------------------
-- The board's log. Append-only; every change to a task writes one row, in the
-- same transaction. AUTOINCREMENT so an id is never reused: subscription
-- cursors point into it.
-- ---------------------------------------------------------------------------
CREATE TABLE kanban_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  run_id      TEXT REFERENCES kanban_runs(run_id),
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  payload     BLOB NOT NULL,                     -- JSON, string values masked on write
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_kanban_events_task ON kanban_events(task_id, id);

UPDATE schema_version SET version = 3;
```

- [ ] **Step 2.4: Add the rows to `src/db/WRITERS.md`.** Add them to the ownership table, directly after the `workspaces` row:

```markdown
| `kanban_tasks` | `db/kanban.ts` | `phase` is written only by its named transitions, each of which checks the current phase (spec §4.1). `workspace` is written once, while null. |
| `kanban_links` | `db/kanban.ts` | Added in the transaction that checks for a cycle and for an open run on the child (spec §3.2). Never deleted. |
| `kanban_runs` | `db/kanban.ts` | Inserted by a claim. `outcome` is written once, on an undecided run; `ended_at` once, on a decided one (spec §3.3). |
| `kanban_comments` | `db/kanban.ts` | Rows are added, never updated. |
| `kanban_events` | `db/kanban.ts` | Append-only, written in the transaction of the change it records. String values in `payload` are masked on write (spec §10.1). |
| `kanban_gates`, `kanban_subscriptions` | `db/kanban.ts` | No writer until plans C4 (gates) and D (subscriptions); they add their functions to `db/kanban.ts`. |
```

- [ ] **Step 2.5: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  597 passed (597)`. Then run `npm run typecheck`. Expected: no output. Then run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  49 passed (49)`: the migration runs for every database the end-to-end tests open.

- [ ] **Step 2.6: Commit.**

```bash
git add schema/003_kanban.sql src/db/WRITERS.md tests/kanban-schema.test.ts
git commit -m "Add the kanban tables, with the database refusing what the lifecycle forbids"
```

---

### Task 3: The board's types, and the derived display status

**Files:**
- Create: `src/kanban/types.ts`, `src/kanban/status.ts`, `tests/kanban-status.test.ts`

`phase` is the only stored lifecycle state. What a person sees is computed from it, from whether every parent is finished, and from the kind of the task's **undecided** run (spec §4.1). It follows the undecided run, not the open one: a run that has reported is no longer working on the task, even while its process finishes. A task held back by a parent that is not done shows `todo`, in `open` or, after a reviewer's dependency block, in `review` (Decision 2).

`types.ts` holds every type and constant the rest of the plan uses. Later tasks only import from it.

- [ ] **Step 3.1: Write the failing tests.** Create `tests/kanban-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { displayStatus } from '../src/kanban/status.js';

describe('displayStatus', () => {
  it('shows an open task as todo until every parent is finished, then ready', () => {
    expect(displayStatus({ phase: 'open', parentsFinished: false, undecidedRun: undefined })).toBe('todo');
    expect(displayStatus({ phase: 'open', parentsFinished: true, undecidedRun: undefined })).toBe('ready');
  });

  it('shows an open task with an undecided run as running', () => {
    expect(displayStatus({ phase: 'open', parentsFinished: true, undecidedRun: 'work' })).toBe('running');
  });

  it('shows a task in review as waiting for a reviewer until a review run is undecided on it', () => {
    expect(displayStatus({ phase: 'review', parentsFinished: true, undecidedRun: undefined })).toBe('review');
    expect(displayStatus({ phase: 'review', parentsFinished: true, undecidedRun: 'review' })).toBe('reviewing');
  });

  it('shows a review waiting on a parent as todo, since nobody can act on it yet', () => {
    // A reviewer's dependency block adds parents to a task in review (spec §5.4).
    expect(displayStatus({ phase: 'review', parentsFinished: false, undecidedRun: undefined })).toBe('todo');
  });

  it('shows blocked, done and archived as they are, whatever else is true', () => {
    for (const phase of ['blocked', 'done', 'archived'] as const) {
      expect(displayStatus({ phase, parentsFinished: false, undecidedRun: 'work' })).toBe(phase);
      expect(displayStatus({ phase, parentsFinished: true, undecidedRun: undefined })).toBe(phase);
    }
  });
});
```

- [ ] **Step 3.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-status.test.ts`. Expected: FAIL, because `../src/kanban/status.js` cannot be found.

- [ ] **Step 3.3: Implement.** Create `src/kanban/types.ts`:

```ts
/**
 * The board's vocabulary (spec §3–§5): phases, block kinds, run outcomes, and
 * the rows db/kanban.ts reads and writes.
 *
 * Refusals are values, not exceptions, because nearly every one is something a
 * person in chat or an agent through `mt kanban` must be told, and act on: the
 * `code` is what an agent branches on, the `message` what a person reads.
 */

/** The only stored lifecycle state (spec §4.1). */
export const PHASES = ['open', 'review', 'blocked', 'done', 'archived'] as const;
export type Phase = (typeof PHASES)[number];

/** The phases a block can return to. */
export type ActivePhase = 'open' | 'review';

/**
 * Why a task is blocked (spec §5.4). `dependency` never sits in `blocked`: the
 * task returns to `open`, gated by its parents. `gave_up` is the breaker's.
 */
export const BLOCK_KINDS = ['dependency', 'needs_input', 'capability', 'transient', 'gave_up'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
/** A block kind a worker or a person may report. */
export type ReportedBlockKind = Exclude<BlockKind, 'gave_up'>;

export type RunKind = 'work' | 'review';

/** Outcomes a run's own report sets (spec §5.2). */
export const REPORTED_OUTCOMES = ['completed', 'review_requested', 'changes_requested', 'blocked'] as const;
/**
 * Outcomes recorded when a run ends without a report: the classifier's (§8.1),
 * and the dispatcher's own (§6.4). Only ever written on an undecided run.
 */
export const ENDED_OUTCOMES = [
  'failed',
  'crashed',
  'timed_out',
  'protocol_violation',
  'rate_limited',
  'terminal_provider',
  'interrupted',
] as const;
/** Recorded by a person's action, not by the run: `/kanban stop`, assign, archive. */
export const SUPERSEDING_OUTCOMES = ['cancelled', 'superseded'] as const;

export type ReportedOutcome = (typeof REPORTED_OUTCOMES)[number];
export type EndedOutcome = (typeof ENDED_OUTCOMES)[number];
export type RunOutcome = ReportedOutcome | EndedOutcome | (typeof SUPERSEDING_OUTCOMES)[number];

export type RetryOnCrash = 'always' | 'if-no-side-effects';

/** A role, by name, or a person, by principal (`lark:<union_id>`) (spec §4.2). */
export interface Assignee {
  kind: 'role' | 'human';
  name: string;
}

/** The completion contract (spec §4.3). Every field optional. */
export const CONTRACT_FIELDS = ['outcome', 'verification', 'constraints', 'boundaries', 'stop_when'] as const;
export type Contract = Partial<Record<(typeof CONTRACT_FIELDS)[number], string>>;

/** Where a task came from: the chat it was created in, or the run that created it (spec §3.1). */
export type CreatedVia =
  | { kind: 'chat'; channel: string; appId: string; conversationId: string; threadId: string }
  | { kind: 'run'; runId: string };

/**
 * Who is reporting. A run reports through its token (plan C3); a person through
 * chat (plan D). Who may act is checked by the caller; what the rows allow, here.
 */
export type Reporter = { kind: 'run'; runId: string } | { kind: 'person'; principal: string };

export interface TaskRow {
  taskId: string;
  title: string;
  body: string;
  contract: Contract;
  assignee: Assignee | null;
  reviewer: Assignee | null;
  /** Fixed once non-null (spec §2.3). */
  workspace: string | null;
  phase: Phase;
  blockedFrom: ActivePhase | null;
  blockKind: Exclude<BlockKind, 'dependency'> | null;
  blockReason: string | null;
  priority: number;
  idempotencyKey: string | null;
  failureLimit: number | null;
  retryOnCrash: RetryOnCrash;
  maxRuntimeS: number | null;
  consecutiveFailures: number;
  consecutiveTransient: number;
  cooldownUntil: number | null;
  blockRecurrences: number;
  strandedNotifiedAt: number | null;
  createdBy: string;
  createdVia: CreatedVia;
  createdAt: number;
  closedAt: number | null;
  createdFromTask: string | null;
}

/** An agent run's agent, as it was at the claim. Environment names only, never values. */
export interface AgentSnapshot {
  driver: string;
  command: string;
  args: readonly string[];
  unsupervised: boolean;
  envNames: readonly string[];
}

export interface RunRow {
  runId: string;
  taskId: string;
  attempt: number;
  kind: RunKind;
  /** A snapshot at the claim: reassigning the task does not rewrite it. */
  assignee: Assignee;
  /** Null for a person's run. */
  agentConfig: AgentSnapshot | null;
  workspace: string | null;
  roleMdHash: string | null;
  sessionId: string | null;
  seededFromRun: string | null;
  tokenHash: string | null;
  /** Null until decided. */
  outcome: RunOutcome | null;
  summary: string | null;
  metadata: unknown;
  reportedCommit: string | null;
  reportedDirty: boolean | null;
  error: string | null;
  lastOutput: string | null;
  submissions: number;
  startedAt: number;
  /** Null while open. */
  endedAt: number | null;
}

export interface CommentRow {
  id: number;
  taskId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface KanbanEvent {
  id: number;
  taskId: string;
  runId: string | null;
  kind: string;
  actor: string;
  payload: unknown;
  createdAt: number;
}

export type RefusalCode =
  /** No such task or run. */
  | 'not_found'
  /** The input itself is wrong: an empty title, an unknown contract field. */
  | 'invalid'
  /** The task's phase does not allow this. */
  | 'illegal_transition'
  /** The role is not configured, or its agent is supervised. */
  | 'unknown_role'
  | 'supervised_role'
  /** A person was named, and people cannot be assigned work (yet, or this one). */
  | 'person_not_assignable'
  | 'unknown_workspace'
  | 'workspace_fixed'
  /** A link would close a cycle, or lands on a task with an open run (spec §3.2). */
  | 'cycle'
  | 'run_open'
  /** A person acting while an agent run is open (spec §5.1). */
  | 'agent_run_open'
  /** A run reporting on a task that is not its own. */
  | 'wrong_task'
  /** The run has reported already (spec §7.2). */
  | 'already_reported'
  /** The run was decided by someone else, or is closed (spec §7.2). */
  | 'run_superseded'
  | 'no_reviewer'
  | 'parents_unfinished'
  /** A claim that cannot be made now: a parent not done, or a cooldown. */
  | 'not_claimable'
  | 'workspace_busy'
  /** Nobody the board may hand the task to (spec §4.2). */
  | 'unassignable'
  /** The claim's view of the task is out of date: it was reassigned meanwhile. */
  | 'stale'
  /** A run outcome or close that does not fit the run's state. */
  | 'already_decided'
  | 'undecided'
  | 'already_closed'
  | 'no_open_run';

export interface Refusal {
  ok: false;
  code: RefusalCode;
  message: string;
}

export type Result<T extends object> = ({ ok: true } & T) | Refusal;
```

Then create `src/kanban/status.ts`:

```ts
import type { Phase, RunKind } from './types.js';

/**
 * What a person sees, derived from the phase and two facts (spec §4.1).
 *
 * todo, ready and running are facts about other rows -- the parents, the runs.
 * Stored, each would have to be rewritten wherever those change, and a status
 * written from many places is how a task comes to say "running" with no run.
 * Derived, it cannot disagree with the rows it describes. Session status follows
 * the same rule (core/status.ts).
 */

export type DisplayStatus = 'todo' | 'ready' | 'running' | 'review' | 'reviewing' | 'blocked' | 'done' | 'archived';

export interface StatusFacts {
  phase: Phase;
  /**
   * Every parent is done or archived. True for a task with no parents. A task
   * held back by a parent shows todo, in `open` or in `review`.
   */
  parentsFinished: boolean;
  /**
   * The kind of the task's undecided run, if it has one. Undecided, not open: a
   * run that has reported is no longer working on the task, even while its
   * process finishes (spec §3.3).
   */
  undecidedRun: RunKind | undefined;
}

export function displayStatus(f: StatusFacts): DisplayStatus {
  switch (f.phase) {
    case 'open':
      if (f.undecidedRun !== undefined) return 'running';
      return f.parentsFinished ? 'ready' : 'todo';
    case 'review':
      // A reviewer's dependency block leaves the review waiting on new parents
      // (spec §5.4): todo, because nobody can act until they are done.
      if (f.undecidedRun === 'review') return 'reviewing';
      return f.parentsFinished ? 'review' : 'todo';
    case 'blocked':
    case 'done':
    case 'archived':
      return f.phase;
  }
}
```

- [ ] **Step 3.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  602 passed (602)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 3.5: Commit.**

```bash
git add src/kanban/types.ts src/kanban/status.ts tests/kanban-status.test.ts
git commit -m "Derive a task's display status from its phase, parents and runs"
```

---

### Task 4: The workspace rules

**Files:**
- Create: `src/kanban/workspace.ts`, `tests/kanban-workspace.test.ts`

Spec §2.3, the bullet "A task's workspace is resolved at a claim…". Rules 1 to 4, first match wins. When the parents disagree, the function returns the conflict rather than falling back to `default`: that would be the same guess with a different name. The claim (Task 7) decides what a conflict means. An agent task is unassignable; a person's is claimed with its workspace still null.

- [ ] **Step 4.1: Write the failing tests.** Create `tests/kanban-workspace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveTaskWorkspace } from '../src/kanban/workspace.js';

describe('resolveTaskWorkspace', () => {
  it("uses the task's own workspace first", () => {
    expect(resolveTaskWorkspace({ own: 'docs', roleWorkspace: 'ops', upstream: ['web'] })).toEqual({
      workspace: 'docs',
    });
  });

  it("uses a role's explicit workspace over its parents'", () => {
    // A docs-writer with workspace: docs works in docs whatever its parents were.
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: 'docs', upstream: ['web'] })).toEqual({
      workspace: 'docs',
    });
  });

  it("uses the parents' workspace when they share one", () => {
    // So a downstream review reviews where the work was done.
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: undefined, upstream: ['web', 'web'] })).toEqual({
      workspace: 'web',
    });
  });

  it('ignores parents whose workspace was never fixed', () => {
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: undefined, upstream: [null, 'web'] })).toEqual({
      workspace: 'web',
    });
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: undefined, upstream: [null] })).toEqual({
      workspace: 'default',
    });
  });

  it('refuses to guess when the parents disagree, naming their workspaces', () => {
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: undefined, upstream: ['web', 'api', 'web'] })).toEqual({
      conflict: ['api', 'web'],
    });
  });

  it('falls back to default with nothing else to go on', () => {
    expect(resolveTaskWorkspace({ own: null, roleWorkspace: undefined, upstream: [] })).toEqual({
      workspace: 'default',
    });
  });
});
```

- [ ] **Step 4.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-workspace.test.ts`. Expected: FAIL, because `../src/kanban/workspace.js` cannot be found.

- [ ] **Step 4.3: Implement.** Create `src/kanban/workspace.ts`:

```ts
import { DEFAULT_WORKSPACE } from '../core/registry.js';

/**
 * Which workspace a task works in, decided at a claim while it is still null
 * (spec §2.3). Pure: the claim gathers the facts inside its transaction.
 *
 * The rules, first match wins:
 * 1. the task's own workspace;
 * 2. the assignee role's, if the role sets one explicitly;
 * 3. its parents' -- or, with no parents, the task it was created from -- if
 *    those with a fixed workspace all share one;
 * 4. `default`.
 *
 * When the parents disagree, rule 4 is not applied either: `default` would be the
 * same guess with a different name. The caller decides what that means -- an
 * agent task is unassignable, a person's is claimed with its workspace null.
 */

export interface WorkspaceFacts {
  own: string | null;
  /** Undefined for a person, and for a role that names no workspace. */
  roleWorkspace: string | undefined;
  /**
   * The parents' workspaces, or the creating task's when there are no parents.
   * Null for one never fixed -- an archived parent nobody claimed -- which is ignored.
   */
  upstream: readonly (string | null)[];
}

export type WorkspaceResolution = { workspace: string } | { conflict: readonly string[] };

export function resolveTaskWorkspace(f: WorkspaceFacts): WorkspaceResolution {
  if (f.own !== null) return { workspace: f.own };
  if (f.roleWorkspace !== undefined) return { workspace: f.roleWorkspace };
  const fixed = [...new Set(f.upstream.filter((w): w is string => w !== null))].sort();
  const [only] = fixed;
  if (fixed.length === 1 && only !== undefined) return { workspace: only };
  if (fixed.length > 1) return { conflict: fixed };
  return { workspace: DEFAULT_WORKSPACE };
}
```

- [ ] **Step 4.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  608 passed (608)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 4.5: Commit.**

```bash
git add src/kanban/workspace.ts tests/kanban-workspace.test.ts
git commit -m "Decide a task's workspace by the four rules"
```

---

### Task 5: Extra identifying keys for one caller's payloads

**Files:**
- Modify: `src/secrets.ts`, `tests/secrets.test.ts`

`kanban_events` payloads are masked value by value with `redactValues` (Task 6 onwards). Spec §10.1 leaves identifying values alone: "ids, idempotency keys, workspace and assignee names". The board's keys (`taskId`, `assignee` and the rest) must therefore stay as they are in its payloads. They are **not** added to the global `IDENTIFYING_KEYS`: that set also exempts keys in session events and approval payloads, whose shape an agent controls, so an agent could hide a secret under a key named `assignee`. Instead `redactValues` takes an optional set of extra keys, which only `db/kanban.ts` passes (Decision 20).

- [ ] **Step 5.1: Write the failing test.** In `tests/secrets.test.ts`, inside `describe('redactValues', ...)`, directly after the end of the test "still walks an object or array under an identifying key":

```ts
      owner: { note: MASK },
      role: [MASK],
    });
  });
```

add:

```ts
  it('leaves the keys a caller names as identifying alone, for that call only', () => {
    addSecrets(['implementer-12345']);
    const payload = { assignee: 'implementer-12345', taskId: 'implementer-12345', summary: 'implementer-12345' };
    expect(redactValues(payload, new Set(['assignee', 'taskId']))).toEqual({
      assignee: 'implementer-12345',
      taskId: 'implementer-12345',
      summary: MASK,
    });
    expect(redactValues(payload)).toEqual({ assignee: MASK, taskId: MASK, summary: MASK });
  });
```

- [ ] **Step 5.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/secrets.test.ts`. Expected: the new test FAILS with `expected { assignee: '••••', …(2) } to deeply equal { assignee: 'implementer-12345', …(2) }`, and `Tests  1 failed | 15 passed (16)`.

- [ ] **Step 5.3: Implement.** In `src/secrets.ts`, replace the last line of `redactValues`'s doc comment, and everything after it to the end of `walk`:

```ts
 * Returns the input itself when there is nothing to mask.
 */
export function redactValues(value: unknown): unknown {
  if (ordered.length === 0) return value;
  return walk(value);
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return redactKnownSecrets(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = IDENTIFYING_KEYS.has(key) && typeof inner === 'string' ? inner : walk(inner);
    }
    return out;
  }
  return value;
}
```

with:

```ts
 * Returns the input itself when there is nothing to mask.
 *
 * `alsoIdentifying` names more keys to leave alone, for one writer's payloads:
 * the board's ids and assignee names (db/kanban.ts). They are not added to
 * IDENTIFYING_KEYS, which also exempts keys in session events and approvals,
 * whose payloads an agent shapes.
 */
export function redactValues(value: unknown, alsoIdentifying?: ReadonlySet<string>): unknown {
  if (ordered.length === 0) return value;
  return walk(value, alsoIdentifying);
}

function walk(value: unknown, also: ReadonlySet<string> | undefined): unknown {
  if (typeof value === 'string') return redactKnownSecrets(value);
  if (Array.isArray(value)) return value.map((inner) => walk(inner, also));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const identifying = IDENTIFYING_KEYS.has(key) || also?.has(key) === true;
      out[key] = identifying && typeof inner === 'string' ? inner : walk(inner, also);
    }
    return out;
  }
  return value;
}
```

- [ ] **Step 5.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  609 passed (609)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 5.5: Commit.**

```bash
git add src/secrets.ts tests/secrets.test.ts
git commit -m "Let one caller name more identifying keys for its payloads"
```

---

### Task 6: Reading the board, and creating tasks and comments

**Files:**
- Create: `src/db/kanban-read.ts`, `src/db/kanban.ts`, `tests/kanban-tasks.test.ts`

`kanban-read.ts` is complete in this task: every decoder and read the later tasks use, and `taskView`, which `show` returns. Its functions take a `Db`, so `db/kanban.ts` calls them with the connection of its open transaction.

`kanban.ts` starts with what every transition shares:
- **`refuse`**, a refusal as a value. Nearly every refusal is something a person in chat or an agent through `mt kanban` must be told.
- **`tx`**, `txImmediate` for a change that may be refused. A refusal returned inside it rolls back whatever the change had already written.
- **`record`**, which writes one `kanban_events` row, masked value by value, with `BOARD_KEYS` as the extra identifying keys (Task 5).

Later tasks append sections to this file, and replace its imports as they need more.

What is masked on write, and what is not:
- **Masked:** the title, the body, the contract's values, and comment bodies. Every event payload is masked through `redactValues`.
- **Not masked:** names, ids and idempotency keys, because they identify.

- [ ] **Step 6.1: Write the failing tests.** Create `tests/kanban-tasks.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addComment, createTask, type NewTask } from '../src/db/kanban.js';
import { childrenOf, commentsOf, eventsOf, getTask, parentsOf, taskView } from '../src/db/kanban-read.js';
import type { TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';

const NOW = 1_760_000_000_000;
const VIA = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: '' } as const;
let h: TestDb;

beforeEach(() => {
  clearSecrets();
  h = testDb();
});

afterEach(() => {
  h.close();
  clearSecrets();
});

function create(t: Partial<NewTask> = {}): TaskRow {
  const r = createTask(h.db, { title: 'Write the parser', createdBy: 'lark:on_alice', createdVia: VIA, ...t }, NOW);
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

function taskCount(): number {
  return h.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_tasks').get()?.n ?? -1;
}

describe('createTask', () => {
  it('creates an open task, and records its creation', () => {
    const task = create({
      body: 'Parse the config file.',
      contract: { outcome: 'config parses', stop_when: 'the format is unclear' },
      assignee: { kind: 'role', name: 'implementer' },
      workspace: 'web',
      priority: 2,
    });
    expect(task).toMatchObject({
      title: 'Write the parser',
      body: 'Parse the config file.',
      contract: { outcome: 'config parses', stop_when: 'the format is unclear' },
      assignee: { kind: 'role', name: 'implementer' },
      reviewer: null,
      workspace: 'web',
      phase: 'open',
      priority: 2,
      retryOnCrash: 'always',
      consecutiveFailures: 0,
      createdBy: 'lark:on_alice',
      createdVia: VIA,
      createdAt: NOW,
      closedAt: null,
      createdFromTask: null,
    });
    expect(task.taskId).toMatch(/^k_/);
    expect(eventsOf(h.db, task.taskId).map((e) => [e.kind, e.actor, e.payload])).toEqual([
      [
        'created',
        'lark:on_alice',
        {
          title: 'Write the parser',
          assignee: 'implementer',
          reviewer: null,
          workspace: 'web',
          parents: [],
          createdFromTask: null,
        },
      ],
    ]);
  });

  it('links a new task to its parents in the same transaction', () => {
    const a = create({ title: 'a' });
    const b = create({ title: 'b' });
    const c = create({ title: 'c', parents: [a.taskId, b.taskId, a.taskId] });
    expect(parentsOf(h.db, c.taskId).map((t) => t.title)).toEqual(['a', 'b']);
    expect(childrenOf(h.db, a.taskId).map((t) => t.title)).toEqual(['c']);
  });

  it('refuses an unknown parent, and writes nothing', () => {
    const a = create({ title: 'a' });
    const r = createTask(
      h.db,
      { title: 'b', parents: [a.taskId, 'k_missing'], createdBy: 'lark:on_alice', createdVia: VIA },
      NOW,
    );
    expect(r).toEqual({ ok: false, code: 'not_found', message: 'no task k_missing to be a parent' });
    expect(taskCount()).toBe(1);
  });

  it('refuses a creating run that does not exist', () => {
    const r = createTask(
      h.db,
      { title: 'b', createdBy: 'run:r_missing', createdVia: { kind: 'run', runId: 'r_missing' } },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
    expect(taskCount()).toBe(0);
  });

  it('returns the existing task for a repeated idempotency key, and changes nothing', () => {
    // Lark redelivers; an agent re-runs a command whose output it did not see.
    const first = create({ idempotencyKey: 'lark:om_1' });
    const again = createTask(
      h.db,
      { title: 'something else', idempotencyKey: 'lark:om_1', createdBy: 'lark:on_bob', createdVia: VIA },
      NOW + 1,
    );
    expect(again).toEqual({ ok: true, task: first, existing: true });
    expect(taskCount()).toBe(1);
    expect(eventsOf(h.db, first.taskId)).toHaveLength(1);
  });

  it('masks free text and event payloads on write, but not names', () => {
    addSecrets(['sk-test-123456']);
    const task = create({
      title: 'rotate sk-test-123456',
      body: 'the old key is sk-test-123456',
      contract: { verification: 'curl -H sk-test-123456' },
      assignee: { kind: 'role', name: 'sk-test-123456' },
      workspace: 'sk-test-123456',
    });
    const stored = getTask(h.db, task.taskId);
    expect(stored).toMatchObject({
      title: `rotate ${MASK}`,
      body: `the old key is ${MASK}`,
      contract: { verification: `curl -H ${MASK}` },
      assignee: { kind: 'role', name: 'sk-test-123456' },
      workspace: 'sk-test-123456',
    });
    expect(eventsOf(h.db, task.taskId)[0]?.payload).toMatchObject({
      title: `rotate ${MASK}`,
      assignee: 'sk-test-123456',
      workspace: 'sk-test-123456',
    });
  });
});

describe('addComment', () => {
  it('adds comments in order, masked, each with an event', () => {
    addSecrets(['sk-test-123456']);
    const task = create();
    addComment(h.db, task.taskId, 'lark:on_alice', 'first', NOW);
    const r = addComment(h.db, task.taskId, 'run:r_1', 'used sk-test-123456', NOW + 1);
    expect(r).toMatchObject({ ok: true, comment: { author: 'run:r_1', body: `used ${MASK}` } });
    expect(commentsOf(h.db, task.taskId).map((c) => [c.author, c.body])).toEqual([
      ['lark:on_alice', 'first'],
      ['run:r_1', `used ${MASK}`],
    ]);
    expect(eventsOf(h.db, task.taskId).map((e) => [e.kind, e.payload])).toEqual([
      ['created', expect.anything()],
      ['commented', { body: 'first' }],
      ['commented', { body: `used ${MASK}` }],
    ]);
  });

  it('refuses a comment on an unknown task', () => {
    expect(addComment(h.db, 'k_missing', 'lark:on_alice', 'hi', NOW)).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('taskView', () => {
  it('shows a task with no parents as ready, and its child as todo', () => {
    const parent = create({ title: 'parent' });
    const child = create({ title: 'child', parents: [parent.taskId] });
    expect(taskView(h.db, parent.taskId)).toMatchObject({ status: 'ready', parents: [], runs: [], comments: [] });
    expect(taskView(h.db, child.taskId)).toMatchObject({ status: 'todo', parents: [{ title: 'parent' }] });
    expect(taskView(h.db, parent.taskId)?.children.map((t) => t.title)).toEqual(['child']);
    expect(taskView(h.db, 'k_missing')).toBeUndefined();
  });
});
```

- [ ] **Step 6.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-tasks.test.ts`. Expected: FAIL, because `../src/db/kanban.js` cannot be found.

- [ ] **Step 6.3: Implement.** Create `src/db/kanban-read.ts`:

```ts
import type { Db } from './open.js';
import { displayStatus, type DisplayStatus } from '../kanban/status.js';
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  CommentRow,
  Contract,
  CreatedVia,
  KanbanEvent,
  Phase,
  RetryOnCrash,
  RunKind,
  RunOutcome,
  RunRow,
  TaskRow,
} from '../kanban/types.js';

/**
 * Reading the board. Reads only: every write is db/kanban.ts's (WRITERS.md).
 *
 * Each function takes a `Db`, so db/kanban.ts calls them with the connection of
 * its open transaction, and a read that a decision rests on is made under the
 * write lock.
 */

type Json = string | Buffer | Uint8Array;

function json(v: Json): unknown {
  return JSON.parse(typeof v === 'string' ? v : Buffer.from(v).toString('utf8')) as unknown;
}

function assignee(kind: string | null, name: string | null): Assignee | null {
  return kind === null || name === null ? null : { kind: kind as Assignee['kind'], name };
}

interface TaskRaw {
  task_id: string;
  title: string;
  body: string;
  contract: Json;
  assignee_kind: string | null;
  assignee: string | null;
  reviewer_kind: string | null;
  reviewer: string | null;
  workspace: string | null;
  phase: string;
  blocked_from: string | null;
  block_kind: string | null;
  block_reason: string | null;
  priority: number;
  idempotency_key: string | null;
  failure_limit: number | null;
  retry_on_crash: string;
  max_runtime_s: number | null;
  consecutive_failures: number;
  consecutive_transient: number;
  cooldown_until: number | null;
  block_recurrences: number;
  stranded_notified_at: number | null;
  created_by: string;
  created_via: Json;
  created_at: number;
  closed_at: number | null;
  created_from_task: string | null;
}

function decodeTask(r: TaskRaw): TaskRow {
  return {
    taskId: r.task_id,
    title: r.title,
    body: r.body,
    contract: json(r.contract) as Contract,
    assignee: assignee(r.assignee_kind, r.assignee),
    reviewer: assignee(r.reviewer_kind, r.reviewer),
    workspace: r.workspace,
    phase: r.phase as Phase,
    blockedFrom: r.blocked_from as ActivePhase | null,
    blockKind: r.block_kind as TaskRow['blockKind'],
    blockReason: r.block_reason,
    priority: r.priority,
    idempotencyKey: r.idempotency_key,
    failureLimit: r.failure_limit,
    retryOnCrash: r.retry_on_crash as RetryOnCrash,
    maxRuntimeS: r.max_runtime_s,
    consecutiveFailures: r.consecutive_failures,
    consecutiveTransient: r.consecutive_transient,
    cooldownUntil: r.cooldown_until,
    blockRecurrences: r.block_recurrences,
    strandedNotifiedAt: r.stranded_notified_at,
    createdBy: r.created_by,
    createdVia: json(r.created_via) as CreatedVia,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    createdFromTask: r.created_from_task,
  };
}

const TASK_COLS = `task_id, title, body, json(contract) AS contract, assignee_kind, assignee,
  reviewer_kind, reviewer, workspace, phase, blocked_from, block_kind, block_reason, priority,
  idempotency_key, failure_limit, retry_on_crash, max_runtime_s, consecutive_failures,
  consecutive_transient, cooldown_until, block_recurrences, stranded_notified_at, created_by,
  json(created_via) AS created_via, created_at, closed_at, created_from_task`;

interface RunRaw {
  run_id: string;
  task_id: string;
  attempt: number;
  kind: string;
  assignee_kind: string;
  assignee: string;
  agent_config: Json | null;
  workspace: string | null;
  role_md_hash: string | null;
  session_id: string | null;
  seeded_from_run: string | null;
  token_hash: string | null;
  outcome: string | null;
  summary: string | null;
  metadata: Json | null;
  reported_commit: string | null;
  reported_dirty: number | null;
  error: string | null;
  last_output: string | null;
  submissions: number;
  started_at: number;
  ended_at: number | null;
}

function decodeRun(r: RunRaw): RunRow {
  return {
    runId: r.run_id,
    taskId: r.task_id,
    attempt: r.attempt,
    kind: r.kind as RunKind,
    assignee: { kind: r.assignee_kind as Assignee['kind'], name: r.assignee },
    agentConfig: r.agent_config === null ? null : (json(r.agent_config) as AgentSnapshot),
    workspace: r.workspace,
    roleMdHash: r.role_md_hash,
    sessionId: r.session_id,
    seededFromRun: r.seeded_from_run,
    tokenHash: r.token_hash,
    outcome: r.outcome as RunOutcome | null,
    summary: r.summary,
    metadata: r.metadata === null ? null : json(r.metadata),
    reportedCommit: r.reported_commit,
    reportedDirty: r.reported_dirty === null ? null : r.reported_dirty === 1,
    error: r.error,
    lastOutput: r.last_output,
    submissions: r.submissions,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

const RUN_COLS = `run_id, task_id, attempt, kind, assignee_kind, assignee,
  json(agent_config) AS agent_config, workspace, role_md_hash, session_id, seeded_from_run,
  token_hash, outcome, summary, json(metadata) AS metadata, reported_commit, reported_dirty,
  error, last_output, submissions, started_at, ended_at`;

interface CommentRaw {
  id: number;
  task_id: string;
  author: string;
  body: string;
  created_at: number;
}

function decodeComment(r: CommentRaw): CommentRow {
  return { id: r.id, taskId: r.task_id, author: r.author, body: r.body, createdAt: r.created_at };
}

interface EventRaw {
  id: number;
  task_id: string;
  run_id: string | null;
  kind: string;
  actor: string;
  payload: Json;
  created_at: number;
}

function decodeEvent(r: EventRaw): KanbanEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    runId: r.run_id,
    kind: r.kind,
    actor: r.actor,
    payload: json(r.payload),
    createdAt: r.created_at,
  };
}

export function getTask(db: Db, taskId: string): TaskRow | undefined {
  const row = db.prepare<[string], TaskRaw>(`SELECT ${TASK_COLS} FROM kanban_tasks WHERE task_id = ?`).get(taskId);
  return row === undefined ? undefined : decodeTask(row);
}

export function getTaskByKey(db: Db, idempotencyKey: string): TaskRow | undefined {
  const row = db
    .prepare<[string], TaskRaw>(`SELECT ${TASK_COLS} FROM kanban_tasks WHERE idempotency_key = ?`)
    .get(idempotencyKey);
  return row === undefined ? undefined : decodeTask(row);
}

export function parentsOf(db: Db, taskId: string): TaskRow[] {
  return db
    .prepare<[string], TaskRaw>(
      `SELECT ${TASK_COLS} FROM kanban_tasks
        WHERE task_id IN (SELECT parent_id FROM kanban_links WHERE child_id = ?)
        ORDER BY created_at, rowid`,
    )
    .all(taskId)
    .map(decodeTask);
}

export function childrenOf(db: Db, taskId: string): TaskRow[] {
  return db
    .prepare<[string], TaskRaw>(
      `SELECT ${TASK_COLS} FROM kanban_tasks
        WHERE task_id IN (SELECT child_id FROM kanban_links WHERE parent_id = ?)
        ORDER BY created_at, rowid`,
    )
    .all(taskId)
    .map(decodeTask);
}

/** Done or archived: a parent that no longer holds its children back (spec §4.1). */
export function isFinished(phase: Phase): boolean {
  return phase === 'done' || phase === 'archived';
}

export function getRun(db: Db, runId: string): RunRow | undefined {
  const row = db.prepare<[string], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE run_id = ?`).get(runId);
  return row === undefined ? undefined : decodeRun(row);
}

/** Every run on the task, oldest attempt first. */
export function runsOf(db: Db, taskId: string): RunRow[] {
  return db
    .prepare<[string], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE task_id = ? ORDER BY attempt`)
    .all(taskId)
    .map(decodeRun);
}

/** The task's open run, if any: at most one, by the partial unique index. */
export function openRunOf(db: Db, taskId: string): RunRow | undefined {
  const row = db
    .prepare<[string], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE task_id = ? AND ended_at IS NULL`)
    .get(taskId);
  return row === undefined ? undefined : decodeRun(row);
}

/** The open agent run in a workspace, if any: the one-per-workspace limit (spec §6.3). */
export function openAgentRunIn(db: Db, workspace: string): RunRow | undefined {
  const row = db
    .prepare<[string], RunRaw>(
      `SELECT ${RUN_COLS} FROM kanban_runs
        WHERE workspace = ? AND ended_at IS NULL AND assignee_kind = 'role'`,
    )
    .get(workspace);
  return row === undefined ? undefined : decodeRun(row);
}

export function commentsOf(db: Db, taskId: string): CommentRow[] {
  return db
    .prepare<[string], CommentRaw>(
      'SELECT id, task_id, author, body, created_at FROM kanban_comments WHERE task_id = ? ORDER BY id',
    )
    .all(taskId)
    .map(decodeComment);
}

export function eventsOf(db: Db, taskId: string): KanbanEvent[] {
  return db
    .prepare<[string], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? ORDER BY id`,
    )
    .all(taskId)
    .map(decodeEvent);
}

/** The task as `/kanban show` and `mt kanban show` present it. */
export interface TaskView {
  task: TaskRow;
  status: DisplayStatus;
  parents: TaskRow[];
  children: TaskRow[];
  runs: RunRow[];
  comments: CommentRow[];
}

export function taskView(db: Db, taskId: string): TaskView | undefined {
  const task = getTask(db, taskId);
  if (task === undefined) return undefined;
  const parents = parentsOf(db, taskId);
  const runs = runsOf(db, taskId);
  const undecided = runs.find((r) => r.outcome === null);
  return {
    task,
    status: displayStatus({
      phase: task.phase,
      parentsFinished: parents.every((p) => isFinished(p.phase)),
      undecidedRun: undecided?.kind,
    }),
    parents,
    children: childrenOf(db, taskId),
    runs,
    comments: commentsOf(db, taskId),
  };
}
```

Then create `src/db/kanban.ts`:

```ts
import type { Db } from './open.js';
import { txImmediate } from './open.js';
import { newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import type {
  Assignee,
  CommentRow,
  Contract,
  CreatedVia,
  Refusal,
  RefusalCode,
  Result,
  RetryOnCrash,
  TaskRow,
} from '../kanban/types.js';
import { getRun, getTask, getTaskByKey } from './kanban-read.js';

/**
 * The board's only writer (spec §4.1, WRITERS.md).
 *
 * `phase` is written only here, through named transitions, each of which reads
 * the task inside its transaction, checks the current phase and refuses an
 * illegal move. Every change writes one `kanban_events` row in the same
 * transaction.
 *
 * What this module checks is what the rows make true or false: phases, parents,
 * open runs, cycles. Whether a name is configured, or who may act, is the
 * service's (kanban/service.ts), which knows the team.
 *
 * Free text -- titles, bodies, the contract, summaries, metadata, reasons,
 * comments, errors, output -- and every event payload's string values are masked
 * before they are stored (spec §10.1 layer 3). Best effort: a secret split
 * across two writes matches neither; the escapers are the authoritative layer.
 * Ids, names and idempotency keys are not masked: they identify.
 */

export function refuse(code: RefusalCode, message: string): Refusal {
  return { ok: false, code, message };
}

/** Thrown inside a transaction to roll it back, and returned as the refusal it carries. */
class Rollback extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

/**
 * txImmediate, for a change that may be refused: a refusal rolls back whatever
 * the change had written, so a refused change never leaves half of itself.
 */
function tx<T extends object>(db: Db, fn: (d: Db) => Result<T>): Result<T> {
  try {
    return txImmediate(db, (d) => {
      const r = fn(d);
      if (!r.ok) throw new Rollback(r);
      return r;
    });
  } catch (err) {
    if (err instanceof Rollback) return err.refusal;
    throw err;
  }
}

/**
 * Keys in the board's payloads that identify rather than say something: its ids,
 * and the names of who and where. Passed to redactValues for these payloads only:
 * session events and approvals carry agent-controlled keys, which must not be
 * exempted the same way.
 */
const BOARD_KEYS: ReadonlySet<string> = new Set([
  'taskId',
  'runId',
  'parentId',
  'childId',
  'createdFromTask',
  'seededFromRun',
  'assignee',
  'reviewer',
  'workspace',
]);

/** One row of the board's log, masked value by value. */
function record(
  d: Db,
  e: { taskId: string; runId?: string | null; kind: string; actor: string; payload: Record<string, unknown> },
  now: number,
): void {
  d.prepare(
    `INSERT INTO kanban_events (task_id, run_id, kind, actor, payload, created_at)
     VALUES (?, ?, ?, ?, jsonb(?), ?)`,
  ).run(e.taskId, e.runId ?? null, e.kind, e.actor, JSON.stringify(redactValues(e.payload, BOARD_KEYS)), now);
}

const mask = redactKnownSecrets;

function mustGet(d: Db, taskId: string): TaskRow {
  const task = getTask(d, taskId);
  if (task === undefined) throw new Error(`task ${taskId} vanished inside its own transaction`);
  return task;
}

// ---------------------------------------------------------------------------
// Creating tasks, and comments
// ---------------------------------------------------------------------------

export interface NewTask {
  title: string;
  body?: string;
  contract?: Contract;
  assignee?: Assignee | null;
  reviewer?: Assignee | null;
  workspace?: string | null;
  parents?: readonly string[];
  priority?: number;
  idempotencyKey?: string | null;
  failureLimit?: number | null;
  retryOnCrash?: RetryOnCrash;
  maxRuntimeS?: number | null;
  createdBy: string;
  createdVia: CreatedVia;
}

/**
 * Create a task, linked to its parents, in one transaction.
 *
 * A repeated idempotency key returns the existing task and changes nothing:
 * creation is retried by everything that can create -- Lark redelivers a
 * message, an agent re-runs a command whose output it did not see (spec §3.1).
 *
 * A task created by a run records that run's task as `created_from_task`, the
 * stand-in for parents when its workspace is resolved (spec §2.3). It is not a
 * link: the new task is not gated on its creator.
 */
export function createTask(db: Db, t: NewTask, now: number): Result<{ task: TaskRow; existing: boolean }> {
  return tx(db, (d) => {
    if (t.idempotencyKey !== undefined && t.idempotencyKey !== null) {
      const existing = getTaskByKey(d, t.idempotencyKey);
      if (existing !== undefined) return { ok: true, task: existing, existing: true };
    }
    const parents = [...new Set(t.parents ?? [])];
    for (const parent of parents) {
      if (getTask(d, parent) === undefined) return refuse('not_found', `no task ${parent} to be a parent`);
    }
    let createdFromTask: string | null = null;
    if (t.createdVia.kind === 'run') {
      const run = getRun(d, t.createdVia.runId);
      if (run === undefined) return refuse('not_found', `no run ${t.createdVia.runId}`);
      createdFromTask = run.taskId;
    }

    const taskId = newTaskId();
    d.prepare(
      `INSERT INTO kanban_tasks
         (task_id, title, body, contract, assignee_kind, assignee, reviewer_kind, reviewer,
          workspace, phase, priority, idempotency_key, failure_limit, retry_on_crash,
          max_runtime_s, created_by, created_via, created_at, created_from_task)
       VALUES (?, ?, ?, jsonb(?), ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, jsonb(?), ?, ?)`,
    ).run(
      taskId,
      mask(t.title),
      mask(t.body ?? ''),
      JSON.stringify(redactValues(t.contract ?? {})),
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
    );
    const link = d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)');
    for (const parent of parents) link.run(parent, taskId, now);
    record(
      d,
      {
        taskId,
        kind: 'created',
        actor: t.createdBy,
        payload: {
          title: t.title,
          assignee: t.assignee?.name ?? null,
          reviewer: t.reviewer?.name ?? null,
          workspace: t.workspace ?? null,
          parents,
          createdFromTask,
        },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), existing: false };
  });
}

/** A comment, on a task in any phase. Forwarding one to a run is plan C3's. */
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

- [ ] **Step 6.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  618 passed (618)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 6.5: Commit.**

```bash
git add src/db/kanban-read.ts src/db/kanban.ts tests/kanban-tasks.test.ts
git commit -m "Create kanban tasks and comments, masked on write"
```

---

### Task 7: Claiming a task

**Files:**
- Create: `tests/helpers/kanban.ts`, `tests/kanban-claim.test.ts`
- Modify: `src/db/kanban.ts`

A claim opens a run (spec §5.1, §6.2 step 3):
- a **work** run on a task that is `open` and ready;
- a **review** run on a task in `review` with no open run.

It runs in one transaction, so what it was decided on is still true when the run is inserted. It refuses:
- a task with an open run. The partial unique index backs this up;
- a claimant the task is no longer for (`stale`): the service resolved the role outside the transaction;
- any claim, work or review, with a parent not finished. A review gets new parents from a reviewer's dependency block (Decision 2);
- a claim during a cooldown;
- for an agent, a workspace that cannot be resolved, is no longer configured, or already has an open agent run (spec §6.3). A person's run holds no workspace.

A null workspace is resolved by Task 4's rules and fixed on the task, and `stranded_notified_at` is cleared (spec §3.1), in the same `UPDATE`. A rework claim records `seeded_from_run` (spec §5.3; Decision 9). Its test needs reports, so it is in Task 9. So are the tests of the parents' rule, which need finished parents.

`attachSession` records the gateway session plan C2 creates for an agent run, after the claim.

The helpers write real rows through `db/kanban.ts`. `claimed()` claims for whoever the task is for now, with a fixed agent snapshot. The service builds the real claimant in Task 13.

- [ ] **Step 7.1: Write the failing tests.** Create `tests/helpers/kanban.ts`:

```ts
import type { Db } from '../../src/db/open.js';
import { claim, createTask, type Claimant, type NewTask } from '../../src/db/kanban.js';
import { getTask } from '../../src/db/kanban-read.js';
import type { AgentSnapshot, CreatedVia, RunRow, TaskRow } from '../../src/kanban/types.js';

/** Building blocks for tests of the board: real rows, written through db/kanban.ts. */

export const NOW = 1_760_000_000_000;

export const VIA: CreatedVia = {
  kind: 'chat',
  channel: 'lark',
  appId: 'cli_app',
  conversationId: 'oc_chat',
  threadId: '',
};

export const AGENT: AgentSnapshot = {
  driver: 'structured-cli',
  command: 'bytesec',
  args: ['run', '-m', 'model-a'],
  unsupervised: true,
  envNames: ['API_KEY'],
};

export const WORKSPACES: ReadonlySet<string> = new Set(['default', 'web', 'api', 'docs']);

export const ALICE = 'lark:on_alice';

export function newTask(db: Db, t: Partial<NewTask> = {}, now = NOW): TaskRow {
  const r = createTask(
    db,
    { title: 'a task', assignee: { kind: 'role', name: 'implementer' }, createdBy: ALICE, createdVia: VIA, ...t },
    now,
  );
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task;
}

/** The claimant for the task's next claim: its assignee in open, its reviewer in review. */
export function claimantFor(db: Db, taskId: string, extra: Partial<Claimant> = {}): Claimant {
  const task = getTask(db, taskId);
  const who = task?.phase === 'review' ? task.reviewer : task?.assignee;
  if (who === null || who === undefined) throw new Error(`task ${taskId} has nobody to claim it`);
  return {
    assignee: who,
    agentConfig: who.kind === 'role' ? AGENT : null,
    roleWorkspace: undefined,
    roleMdHash: who.kind === 'role' ? 'hash-of-role-md' : null,
    ...extra,
  };
}

export function claimed(db: Db, taskId: string, extra: Partial<Claimant> = {}, now = NOW): RunRow {
  const r = claim(db, { taskId, claimant: claimantFor(db, taskId, extra), workspaces: WORKSPACES }, now);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.run;
}
```

Then create `tests/kanban-claim.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSession, claim, createTask } from '../src/db/kanban.js';
import { eventsOf, getRun, getTask, parentsOf, runsOf, taskView } from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import { testDb, type TestDb } from './helpers/db.js';
import { AGENT, ALICE, NOW, WORKSPACES, claimantFor, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

const BOB = { kind: 'human', name: 'lark:on_bob' } as const;

function tryClaim(taskId: string, extra: Parameters<typeof claimantFor>[2] = {}, now = NOW) {
  return claim(h.db, { taskId, claimant: claimantFor(h.db, taskId, extra), workspaces: WORKSPACES }, now);
}

describe('claim', () => {
  it('opens a work run on a ready task, and records the claim', () => {
    const task = newTask(h.db);
    const r = claim(
      h.db,
      {
        taskId: task.taskId,
        claimant: claimantFor(h.db, task.taskId),
        tokenHash: 'hash-of-token',
        workspaces: WORKSPACES,
      },
      NOW + 5,
    );
    expect(r).toMatchObject({
      ok: true,
      run: {
        taskId: task.taskId,
        attempt: 1,
        kind: 'work',
        assignee: { kind: 'role', name: 'implementer' },
        agentConfig: AGENT,
        workspace: 'default',
        roleMdHash: 'hash-of-role-md',
        tokenHash: 'hash-of-token',
        sessionId: null,
        seededFromRun: null,
        outcome: null,
        submissions: 0,
        startedAt: NOW + 5,
        endedAt: null,
      },
      task: { workspace: 'default', phase: 'open' },
    });
    if (!r.ok) return;
    expect(r.run.runId).toMatch(/^r_/);
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'claimed',
      runId: r.run.runId,
      payload: { kind: 'work', attempt: 1, assignee: 'implementer', workspace: 'default', seededFromRun: null },
    });
    expect(taskView(h.db, task.taskId)?.status).toBe('running');
  });

  it('refuses a second claim while a run is open', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(tryClaim(task.taskId)).toEqual({
      ok: false,
      code: 'run_open',
      message: `task ${task.taskId} already has an open run, ${run.runId}`,
    });
    expect(runsOf(h.db, task.taskId)).toHaveLength(1);
  });

  it('refuses a task waiting on a parent that is not done', () => {
    const parent = newTask(h.db);
    const child = newTask(h.db, { parents: [parent.taskId] });
    expect(tryClaim(child.taskId)).toMatchObject({ ok: false, code: 'not_claimable' });
  });

  it('refuses a claim for someone the task is no longer assigned to', () => {
    const task = newTask(h.db);
    const r = tryClaim(task.taskId, { assignee: { kind: 'role', name: 'reviewer' } });
    expect(r).toEqual({
      ok: false,
      code: 'stale',
      message: `task ${task.taskId} is now for implementer, not reviewer`,
    });
  });

  it('refuses a task with no assignee as unassignable', () => {
    const task = newTask(h.db, { assignee: null });
    const r = claim(
      h.db,
      {
        taskId: task.taskId,
        claimant: {
          assignee: { kind: 'role', name: 'implementer' },
          agentConfig: AGENT,
          roleWorkspace: undefined,
          roleMdHash: null,
        },
        workspaces: WORKSPACES,
      },
      NOW,
    );
    expect(r).toEqual({ ok: false, code: 'unassignable', message: `task ${task.taskId} has no assignee` });
  });

  it("fixes the workspace from the task's own, else the role's own", () => {
    const own = newTask(h.db, { workspace: 'web' });
    expect(claimed(h.db, own.taskId, { roleWorkspace: 'docs' }).workspace).toBe('web');
    const role = newTask(h.db);
    expect(claimed(h.db, role.taskId, { roleWorkspace: 'docs' }).workspace).toBe('docs');
    expect(getTask(h.db, role.taskId)?.workspace).toBe('docs');
  });

  it('refuses an agent run in a workspace no longer configured, but not a person', () => {
    const agentTask = newTask(h.db, { workspace: 'removed' });
    expect(tryClaim(agentTask.taskId)).toEqual({
      ok: false,
      code: 'unassignable',
      message: `task ${agentTask.taskId}'s workspace removed is not configured`,
    });
    const personTask = newTask(h.db, { workspace: 'removed', assignee: BOB });
    expect(claimed(h.db, personTask.taskId).workspace).toBe('removed');
  });

  it('allows one open agent run per workspace; a person holds none', () => {
    const person = newTask(h.db, { workspace: 'web', assignee: BOB });
    claimed(h.db, person.taskId);
    const first = newTask(h.db, { workspace: 'web' });
    const run = claimed(h.db, first.taskId);
    const second = newTask(h.db, { workspace: 'web' });
    expect(tryClaim(second.taskId)).toEqual({
      ok: false,
      code: 'workspace_busy',
      message: `workspace web has an open agent run, ${run.runId}`,
    });
    const elsewhere = newTask(h.db, { workspace: 'api' });
    expect(claimed(h.db, elsewhere.taskId).workspace).toBe('api');
  });

  it('puts a task a run creates where its creator works, without a link', () => {
    const creator = newTask(h.db, { workspace: 'web', assignee: BOB });
    const run = claimed(h.db, creator.taskId);
    const r = createTask(
      h.db,
      {
        title: 'follow-up',
        assignee: { kind: 'role', name: 'implementer' },
        createdBy: `run:${run.runId}`,
        createdVia: { kind: 'run', runId: run.runId },
      },
      NOW,
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.task.createdFromTask).toBe(creator.taskId);
    expect(parentsOf(h.db, r.task.taskId)).toEqual([]);
    expect(claimed(h.db, r.task.taskId).workspace).toBe('web');
  });

  it('attaches a session to an open agent run, once', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    createSession(h.db, { id: 's_run', agentId: 'implementer', workspaceId: 'default', ownerPrincipal: ALICE }, NOW);
    expect(attachSession(h.db, run.runId, 's_run', NOW)).toMatchObject({ ok: true, run: { sessionId: 's_run' } });
    expect(getRun(h.db, run.runId)?.sessionId).toBe('s_run');
    expect(attachSession(h.db, run.runId, 's_run', NOW)).toEqual({
      ok: false,
      code: 'invalid',
      message: `run ${run.runId} already has session s_run`,
    });
    const person = newTask(h.db, { assignee: BOB });
    expect(attachSession(h.db, claimed(h.db, person.taskId).runId, 's_run', NOW)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
```

- [ ] **Step 7.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-claim.test.ts`. Expected: all 10 FAIL with `(0 , claim) is not a function`, since the helpers call it too.

- [ ] **Step 7.3: Implement.** Replace the imports at the top of `src/db/kanban.ts`, that is everything above the header comment that begins `/**` / ` * The board's only writer`, with:

```ts
import type { Db } from './open.js';
import { txImmediate } from './open.js';
import { newRunId, newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { resolveTaskWorkspace } from '../kanban/workspace.js';
import type {
  AgentSnapshot,
  Assignee,
  CommentRow,
  Contract,
  CreatedVia,
  Refusal,
  RefusalCode,
  Result,
  RetryOnCrash,
  RunKind,
  RunRow,
  TaskRow,
} from '../kanban/types.js';
import {
  getRun,
  getTask,
  getTaskByKey,
  isFinished,
  openAgentRunIn,
  openRunOf,
  parentsOf,
  runsOf,
} from './kanban-read.js';
```

Then append to the end of `src/db/kanban.ts`:

```ts
// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** Who a claim is for, as the service resolved it from the team. */
export interface Claimant {
  /** The task's assignee for a work run, its reviewer for a review run. */
  assignee: Assignee;
  /** The role's effective agent; null for a person. */
  agentConfig: AgentSnapshot | null;
  /** The role's workspace, if it names one explicitly (spec §2.3 rule 2). */
  roleWorkspace: string | undefined;
  /** SHA-256 of the role.md the run is given (spec §2.1); null without one. */
  roleMdHash: string | null;
}

export interface ClaimInput {
  taskId: string;
  claimant: Claimant;
  /** SHA-256 of the run's worker token (plan C3); the token is never stored. */
  tokenHash?: string | null;
  /** The configured workspace names: an agent run in any other is unassignable. */
  workspaces: ReadonlySet<string>;
}

/**
 * Open a run on a task (spec §5.1, §6.2 step 3): a work run on a ready task, a
 * review run on a task in review with no open run.
 *
 * In one transaction, so that what the claim was decided on is still true when
 * the run is inserted: the phase, the parents, no open run (also enforced by the
 * partial unique index, so two racing claims fail at the database), the
 * assignee, the cooldown, and the workspace.
 *
 * A null workspace is resolved here (spec §2.3) and fixed on the task. Where it
 * cannot be -- the parents disagree -- an agent claim is refused as unassignable
 * before anything is written, and a person's run is opened with the workspace
 * still null. An agent run is also refused in a workspace no longer configured,
 * and in one that already has an open agent run (spec §6.3). A person's run
 * holds no workspace.
 */
export function claim(db: Db, input: ClaimInput, now: number): Result<{ run: RunRow; task: TaskRow }> {
  return tx(db, (d) => {
    const task = getTask(d, input.taskId);
    if (task === undefined) return refuse('not_found', `no task ${input.taskId}`);
    if (task.phase !== 'open' && task.phase !== 'review') {
      return refuse('illegal_transition', `task ${task.taskId} is ${task.phase}, so it cannot be claimed`);
    }
    const kind: RunKind = task.phase === 'open' ? 'work' : 'review';
    const open = openRunOf(d, task.taskId);
    if (open !== undefined) return refuse('run_open', `task ${task.taskId} already has an open run, ${open.runId}`);

    const who = kind === 'work' ? task.assignee : task.reviewer;
    if (who === null) {
      return refuse('unassignable', `task ${task.taskId} has no ${kind === 'work' ? 'assignee' : 'reviewer'}`);
    }
    if (who.kind !== input.claimant.assignee.kind || who.name !== input.claimant.assignee.name) {
      return refuse('stale', `task ${task.taskId} is now for ${who.name}, not ${input.claimant.assignee.name}`);
    }
    const agent = who.kind === 'role';
    if (agent !== (input.claimant.agentConfig !== null)) {
      throw new Error('a claim carries an agent exactly when it is for a role');
    }
    const parents = parentsOf(d, task.taskId);
    // A review waits on its parents too: a reviewer's dependency block adds them (spec §5.4).
    if (!parents.every((p) => isFinished(p.phase))) {
      return refuse('not_claimable', `task ${task.taskId} is waiting on a parent that is not done`);
    }
    if (task.cooldownUntil !== null && task.cooldownUntil > now) {
      return refuse('not_claimable', `task ${task.taskId} is cooling down after being throttled`);
    }

    let workspace = task.workspace;
    if (workspace === null) {
      const from = task.createdFromTask === null ? undefined : getTask(d, task.createdFromTask);
      const resolved = resolveTaskWorkspace({
        own: null,
        roleWorkspace: agent ? input.claimant.roleWorkspace : undefined,
        upstream: parents.length > 0 ? parents.map((p) => p.workspace) : from === undefined ? [] : [from.workspace],
      });
      if ('conflict' in resolved) {
        if (agent) {
          return refuse(
            'unassignable',
            `task ${task.taskId}'s parents are in different workspaces (${resolved.conflict.join(', ')}); ` +
              'set its workspace',
          );
        }
      } else {
        workspace = resolved.workspace;
      }
    }
    if (agent) {
      if (workspace === null || !input.workspaces.has(workspace)) {
        return refuse('unassignable', `task ${task.taskId}'s workspace ${String(workspace)} is not configured`);
      }
      const busy = openAgentRunIn(d, workspace);
      if (busy !== undefined) {
        return refuse('workspace_busy', `workspace ${workspace} has an open agent run, ${busy.runId}`);
      }
    }

    const runs = runsOf(d, task.taskId);
    const runId = newRunId();
    const attempt = (runs.at(-1)?.attempt ?? 0) + 1;
    const seededFromRun = kind === 'work' ? reworkSeed(d, runs, input.claimant.agentConfig) : null;
    d.prepare(
      `INSERT INTO kanban_runs
         (run_id, task_id, attempt, kind, assignee_kind, assignee, agent_config, workspace,
          role_md_hash, seeded_from_run, token_hash, started_at)
       VALUES (?, ?, ?, ?, ?, ?, jsonb(?), ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      task.taskId,
      attempt,
      kind,
      who.kind,
      who.name,
      input.claimant.agentConfig === null ? null : JSON.stringify(input.claimant.agentConfig),
      workspace,
      input.claimant.roleMdHash,
      seededFromRun,
      input.tokenHash ?? null,
      now,
    );
    // A claimed task is no longer stranded (spec §3.1).
    d.prepare('UPDATE kanban_tasks SET workspace = ?, stranded_notified_at = NULL WHERE task_id = ?').run(
      workspace,
      task.taskId,
    );
    record(
      d,
      {
        taskId: task.taskId,
        runId,
        kind: 'claimed',
        actor: 'gateway',
        payload: { kind, attempt, assignee: who.name, workspace, seededFromRun },
      },
      now,
    );
    return { ok: true, run: mustGetRun(d, runId), task: mustGet(d, task.taskId) };
  });
}

/**
 * The run a rework resumes (spec §5.3): only right after a reviewer's
 * `changes`, only from the last work run, only if it ran the same agent --
 * driver, command and arguments; environment names are not compared -- and only
 * if its session observed a provider session id to resume. Anything else starts
 * fresh, and the column stays null: it names the run actually resumed.
 */
function reworkSeed(d: Db, runs: readonly RunRow[], agent: AgentSnapshot | null): string | null {
  const last = runs.at(-1);
  if (agent === null || last?.kind !== 'review' || last.outcome !== 'changes_requested') return null;
  const work = runs.findLast((r) => r.kind === 'work');
  if (work === undefined || work.agentConfig === null || work.sessionId === null) return null;
  const before = work.agentConfig;
  const same =
    before.driver === agent.driver &&
    before.command === agent.command &&
    JSON.stringify(before.args) === JSON.stringify(agent.args);
  if (!same) return null;
  const seen = d
    .prepare<[string], { provider_session_id: string | null }>('SELECT provider_session_id FROM sessions WHERE id = ?')
    .get(work.sessionId);
  return seen?.provider_session_id ? work.runId : null;
}

function mustGetRun(d: Db, runId: string): RunRow {
  const run = getRun(d, runId);
  if (run === undefined) throw new Error(`run ${runId} vanished inside its own transaction`);
  return run;
}

/**
 * Record the gateway session an agent run runs in (spec §3.3: one run, one
 * session). Plan C2 calls it once the session is created, after the claim.
 */
export function attachSession(db: Db, runId: string, sessionId: string, now: number): Result<{ run: RunRow }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.endedAt !== null) return refuse('already_closed', `run ${runId} is closed`);
    if (run.agentConfig === null) return refuse('invalid', `run ${runId} is a person's, and has no session`);
    if (run.sessionId !== null) return refuse('invalid', `run ${runId} already has session ${run.sessionId}`);
    d.prepare('UPDATE kanban_runs SET session_id = ? WHERE run_id = ?').run(sessionId, runId);
    record(d, { taskId: run.taskId, runId, kind: 'session_attached', actor: 'gateway', payload: { sessionId } }, now);
    return { ok: true, run: mustGetRun(d, runId) };
  });
}
```

- [ ] **Step 7.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  628 passed (628)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 7.5: Commit.**

```bash
git add src/db/kanban.ts tests/helpers/kanban.ts tests/kanban-claim.test.ts
git commit -m "Claim a task: open its run and fix its workspace in one transaction"
```

---

### Task 8: Links

**Files:**
- Modify: `src/db/kanban.ts`
- Create: `tests/kanban-links.test.ts`

Spec §3.2. The public `link` refuses:
- **a child past its parents gate**, that is in review, blocked from review, done or archived (Decision 3), with `illegal_transition`. The gate is evaluated when a task becomes ready, so a parent added later could never hold it back. A review would then wait on it forever. Task 9 tests the review case, once a task can reach review;
- **a child with an open run**, for the same reason;
- **a cycle**, found by walking up from the parent with a recursive query. A cycle is two tasks that can never become ready, with nothing to say why.

Linking a pair that is already linked changes nothing. The link itself is the internal `linkIn`, which a dependency block also calls (Task 10), on a task in `open` or `review`, with the run that has just reported the block (Decisions 1 and 2).

- [ ] **Step 8.1: Write the failing tests.** Create `tests/kanban-links.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { link } from '../src/db/kanban.js';
import { eventsOf, parentsOf, taskView } from '../src/db/kanban-read.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

describe('link', () => {
  it('makes a parent hold its child back, and records it on the child', () => {
    const parent = newTask(h.db);
    const child = newTask(h.db);
    expect(link(h.db, parent.taskId, child.taskId, ALICE, NOW)).toEqual({ ok: true, added: true });
    expect(parentsOf(h.db, child.taskId).map((t) => t.taskId)).toEqual([parent.taskId]);
    expect(taskView(h.db, child.taskId)?.status).toBe('todo');
    expect(eventsOf(h.db, child.taskId).at(-1)).toMatchObject({
      kind: 'linked',
      actor: ALICE,
      payload: { parentId: parent.taskId },
    });
  });

  it('changes nothing when the pair is already linked', () => {
    const parent = newTask(h.db);
    const child = newTask(h.db, { parents: [parent.taskId] });
    expect(link(h.db, parent.taskId, child.taskId, ALICE, NOW)).toEqual({ ok: true, added: false });
    expect(eventsOf(h.db, child.taskId).map((e) => e.kind)).toEqual(['created']);
  });

  it('refuses a cycle, however long, and a task as its own parent', () => {
    const a = newTask(h.db);
    const b = newTask(h.db, { parents: [a.taskId] });
    const c = newTask(h.db, { parents: [b.taskId] });
    expect(link(h.db, c.taskId, a.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'cycle',
      message: `task ${a.taskId} is already upstream of ${c.taskId}; the link would make a cycle`,
    });
    expect(link(h.db, a.taskId, a.taskId, ALICE, NOW)).toMatchObject({ ok: false, code: 'cycle' });
    expect(parentsOf(h.db, a.taskId)).toEqual([]);
  });

  it('refuses a link onto a task with an open run', () => {
    const parent = newTask(h.db);
    const child = newTask(h.db);
    const run = claimed(h.db, child.taskId);
    expect(link(h.db, parent.taskId, child.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'run_open',
      message: `task ${child.taskId} has an open run, ${run.runId}; a parent added now could not hold it back`,
    });
  });

  it('refuses an unknown task on either side', () => {
    const task = newTask(h.db);
    expect(link(h.db, 'k_missing', task.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'not_found',
      message: 'no task k_missing',
    });
    expect(link(h.db, task.taskId, 'k_missing', ALICE, NOW)).toMatchObject({ ok: false, code: 'not_found' });
  });
});
```

- [ ] **Step 8.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-links.test.ts`. Expected: all 5 FAIL with `(0 , link) is not a function`.

- [ ] **Step 8.3: Implement.** Append to the end of `src/db/kanban.ts`:

```ts
// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Make `parentId` a parent of `childId` (spec §3.2). Linking an existing pair
 * again changes nothing.
 *
 * Refused:
 * - a child past its parents gate -- in review, blocked from review, done or
 *   archived: the gate is evaluated when a task becomes ready, so a parent added
 *   now could never hold it back, and a review would wait on it forever;
 * - a child with an open run, for the same reason;
 * - a cycle, found by walking up from the parent: two tasks that can never become
 *   ready, and nothing would ever say why.
 */
export function link(db: Db, parentId: string, childId: string, by: string, now: number): Result<{ added: boolean }> {
  return tx(db, (d) => {
    if (getTask(d, parentId) === undefined) return refuse('not_found', `no task ${parentId}`);
    const child = getTask(d, childId);
    if (child === undefined) return refuse('not_found', `no task ${childId}`);
    if (child.phase !== 'open' && !(child.phase === 'blocked' && child.blockedFrom === 'open')) {
      return refuse(
        'illegal_transition',
        `task ${childId} is ${child.phase}; a parent added now could not hold it back`,
      );
    }
    return linkIn(d, parentId, childId, by, now);
  });
}

/**
 * The link itself, once the child's phase allows it. A dependency block calls it
 * directly (spec §5.4), on a task in `open` or `review`, with `blockingRun` the
 * run that has just reported the block: that run is decided, so the parents it
 * names hold back the next claim, not the run.
 */
function linkIn(
  d: Db,
  parentId: string,
  childId: string,
  by: string,
  now: number,
  blockingRun?: string,
): Result<{ added: boolean }> {
  if (getTask(d, parentId) === undefined) return refuse('not_found', `no task ${parentId}`);
  if (parentId === childId) return refuse('cycle', `task ${childId} cannot be its own parent`);
  const exists = d
    .prepare<[string, string], { n: number }>('SELECT 1 AS n FROM kanban_links WHERE parent_id = ? AND child_id = ?')
    .get(parentId, childId);
  if (exists !== undefined) return { ok: true, added: false };
  const cycle = d
    .prepare<[string, string], { n: number }>(
      `WITH RECURSIVE up(id) AS (
         SELECT ?
         UNION
         SELECT l.parent_id FROM kanban_links l JOIN up ON l.child_id = up.id
       )
       SELECT 1 AS n FROM up WHERE id = ? LIMIT 1`,
    )
    .get(parentId, childId);
  if (cycle !== undefined) {
    return refuse('cycle', `task ${childId} is already upstream of ${parentId}; the link would make a cycle`);
  }
  const open = openRunOf(d, childId);
  if (open !== undefined && open.runId !== blockingRun) {
    return refuse(
      'run_open',
      `task ${childId} has an open run, ${open.runId}; a parent added now could not hold it back`,
    );
  }
  d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)').run(parentId, childId, now);
  record(d, { taskId: childId, kind: 'linked', actor: by, payload: { parentId } }, now);
  return { ok: true, added: true };
}
```

- [ ] **Step 8.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  633 passed (633)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 8.5: Commit.**

```bash
git add src/db/kanban.ts tests/kanban-links.test.ts
git commit -m "Link tasks, refusing cycles and links a task can no longer wait on"
```

---

### Task 9: Reports: complete, review, changes; closing a run

**Files:**
- Modify: `src/db/kanban.ts`
- Create: `tests/kanban-reports.test.ts`

A run has two moments, kept apart deliberately (spec §3.3):
- **Decided** is when `outcome` is set. For a report, that is during the turn. The task's phase moves at once: a `complete` makes the task `done`, and its children ready.
- **Closed** is when `ended_at` is set. The agent's last turn has ended, and the workspace is free. A person's run closes when it is decided.

Who may report (spec §5.1, §7.2):
- **A run** reports only on its own task, while it is open and undecided. A second report is `already_reported`. Once someone else has decided it, or it is closed, a report is `run_superseded`.
- **A person's report** decides the open person's run, if there is one. It is refused while an agent run is open. The message says to stop the run if it is still undecided, or to wait if it has reported and is finishing.

What each report changes:
- **`complete`**, from a work run or a review run, resets the breaker's counters, and is the only report that does. It refuses a task with an unfinished parent: the backstop for Task 8, and what holds a review that a reviewer's dependency block left waiting.
- **`requestReview`** needs a reviewer, named in the report or already on the task.
- **`requestChanges`** stores its reason as the review run's summary (Decision 7).
- **Any outcome but `rate_limited`** resets `consecutive_transient` (Decision 10).

`closeRun` refuses an undecided run. What ended it must be recorded first, by a report or, from Task 11, by `endRun`.

The tests also cover two moves Task 8 and Task 7 implemented: a public link onto a task in review is refused, and an agent claim re-applies the workspace rules when a person's claim left the workspace null (spec §2.3).

- [ ] **Step 9.1: Write the failing tests.** Create `tests/kanban-reports.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSession, claim, closeRun, complete, link, requestChanges, requestReview } from '../src/db/kanban.js';
import { eventsOf, getRun, getTask, runsOf, taskView } from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import type { Reporter, RunRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { AGENT, ALICE, NOW, WORKSPACES, claimantFor, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  clearSecrets();
  h = testDb();
});

afterEach(() => {
  h.close();
  clearSecrets();
});

const BOB = { kind: 'human', name: 'lark:on_bob' } as const;
const REVIEWER = { kind: 'role', name: 'reviewer' } as const;
const asRun = (run: RunRow): Reporter => ({ kind: 'run', runId: run.runId });
const asPerson = (principal: string): Reporter => ({ kind: 'person', principal });

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** A finished task in a workspace, as a person leaves one: done, with no agent involved. */
function doneIn(workspace: string | null): string {
  const task = newTask(h.db, { assignee: BOB, workspace });
  if (workspace !== null) claimed(h.db, task.taskId);
  ok(complete(h.db, task.taskId, asPerson('lark:on_bob'), { summary: 'done' }, NOW));
  return task.taskId;
}

describe('complete', () => {
  it("completes a running task from its run's report, and frees its children", () => {
    const task = newTask(h.db);
    const child = newTask(h.db, { parents: [task.taskId] });
    const run = claimed(h.db, task.taskId);
    const r = complete(
      h.db,
      task.taskId,
      asRun(run),
      { summary: 'parser written', metadata: { files: 2 }, reportedCommit: 'abc123', reportedDirty: false },
      NOW + 10,
    );
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'done', closedAt: NOW + 10, consecutiveFailures: 0 },
      run: {
        outcome: 'completed',
        summary: 'parser written',
        metadata: { files: 2 },
        reportedCommit: 'abc123',
        reportedDirty: false,
        endedAt: null,
      },
    });
    expect(taskView(h.db, child.taskId)?.status).toBe('ready');
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'completed',
      runId: run.runId,
      actor: `run:${run.runId}`,
      payload: { summary: 'parser written' },
    });
  });

  it('masks the summary, the metadata and the event on write', () => {
    addSecrets(['sk-test-123456']);
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = ok(
      complete(
        h.db,
        task.taskId,
        asRun(run),
        { summary: 'rotated sk-test-123456', metadata: { key: 'sk-test-123456', files: 2 } },
        NOW,
      ),
    );
    expect(r.run).toMatchObject({ summary: `rotated ${MASK}`, metadata: { key: MASK, files: 2 } });
    expect(eventsOf(h.db, task.taskId).at(-1)?.payload).toEqual({ summary: `rotated ${MASK}` });
  });

  it('keeps the reporting run open, holding its workspace, until it is closed', () => {
    // The agent usually keeps going after it reports, in the same checkout.
    const task = newTask(h.db);
    const child = newTask(h.db, { parents: [task.taskId] });
    const run = claimed(h.db, task.taskId);
    ok(complete(h.db, task.taskId, asRun(run), { summary: 'done' }, NOW));
    const blocked = claim(
      h.db,
      { taskId: child.taskId, claimant: claimantFor(h.db, child.taskId), workspaces: WORKSPACES },
      NOW,
    );
    expect(blocked).toMatchObject({ ok: false, code: 'workspace_busy' });
    expect(closeRun(h.db, run.runId, NOW + 1)).toMatchObject({ ok: true, run: { endedAt: NOW + 1 } });
    expect(claimed(h.db, child.taskId).workspace).toBe('default');
  });

  it('refuses a second report from a run, a report after it is closed, and one on another task', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    ok(complete(h.db, task.taskId, asRun(run), { summary: 'done' }, NOW));
    expect(complete(h.db, task.taskId, asRun(run), { summary: 'again' }, NOW)).toEqual({
      ok: false,
      code: 'already_reported',
      message: `run ${run.runId} has already reported (completed)`,
    });
    ok(closeRun(h.db, run.runId, NOW));
    expect(complete(h.db, task.taskId, asRun(run), { summary: 'late' }, NOW)).toEqual({
      ok: false,
      code: 'run_superseded',
      message: `run ${run.runId} is over`,
    });
    const other = newTask(h.db);
    expect(complete(h.db, other.taskId, asRun(run), { summary: 'x' }, NOW)).toMatchObject({
      ok: false,
      code: 'wrong_task',
    });
  });

  it('refuses to complete a task whose parent is not done', () => {
    const parent = newTask(h.db);
    const child = newTask(h.db, { parents: [parent.taskId] });
    expect(complete(h.db, child.taskId, asPerson(ALICE), { summary: 'x' }, NOW)).toEqual({
      ok: false,
      code: 'parents_unfinished',
      message: `task ${child.taskId} has a parent that is not done`,
    });
  });

  it('lets a person complete their task, deciding and closing their own run', () => {
    const task = newTask(h.db, { assignee: BOB });
    const run = claimed(h.db, task.taskId);
    const r = ok(complete(h.db, task.taskId, asPerson('lark:on_bob'), { summary: 'did it' }, NOW + 3));
    expect(r.run).toMatchObject({ runId: run.runId, outcome: 'completed', summary: 'did it', endedAt: NOW + 3 });
    expect(r.task.phase).toBe('done');
  });

  it('refuses a person while an agent run is open: stop it first, or wait for it to finish', () => {
    const task = newTask(h.db, { reviewer: BOB });
    const run = claimed(h.db, task.taskId);
    expect(complete(h.db, task.taskId, asPerson(ALICE), { summary: 'x' }, NOW)).toEqual({
      ok: false,
      code: 'agent_run_open',
      message: `task ${task.taskId} has an agent run working on it (${run.runId}); stop it first`,
    });
    ok(requestReview(h.db, task.taskId, asRun(run), { summary: 'please look' }, NOW));
    expect(complete(h.db, task.taskId, asPerson('lark:on_bob'), { summary: 'approved' }, NOW)).toEqual({
      ok: false,
      code: 'agent_run_open',
      message: `task ${task.taskId}'s agent run ${run.runId} has reported and is finishing; wait for it to finish`,
    });
  });
});

describe('a review run', () => {
  it("completes the task on the reviewer's complete", () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    expect(complete(h.db, task.taskId, asRun(review), { summary: 'approved' }, NOW + 1)).toMatchObject({
      ok: true,
      task: { phase: 'done', closedAt: NOW + 1 },
      run: { runId: review.runId, kind: 'review', outcome: 'completed', summary: 'approved' },
    });
  });

  it('refuses a public link onto a task in review: a parent added now could not hold it back', () => {
    const parent = newTask(h.db);
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    expect(link(h.db, parent.taskId, task.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${task.taskId} is review; a parent added now could not hold it back`,
    });
  });
});

describe('requestReview', () => {
  it("moves the task to review, with a reviewer the report names replacing the task's", () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    const r = requestReview(
      h.db,
      task.taskId,
      asRun(work),
      { summary: 'ready', reviewer: { kind: 'role', name: 'second-opinion' } },
      NOW,
    );
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'review', reviewer: { kind: 'role', name: 'second-opinion' } },
      run: { outcome: 'review_requested', summary: 'ready' },
    });
    expect(taskView(h.db, task.taskId)?.status).toBe('review');
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'review_requested',
      payload: { summary: 'ready', reviewer: 'second-opinion' },
    });
    ok(closeRun(h.db, work.runId, NOW));
    expect(claimed(h.db, task.taskId)).toMatchObject({
      kind: 'review',
      attempt: 2,
      assignee: { kind: 'role', name: 'second-opinion' },
      workspace: 'default',
    });
    expect(taskView(h.db, task.taskId)?.status).toBe('reviewing');
  });

  it('refuses a review with nobody to review it, and leaves the run undecided', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(requestReview(h.db, task.taskId, asRun(run), { summary: 'x' }, NOW)).toEqual({
      ok: false,
      code: 'no_reviewer',
      message: `nobody is named to review task ${task.taskId}`,
    });
    expect(getRun(h.db, run.runId)?.outcome).toBeNull();
  });
});

describe('requestChanges', () => {
  function reviewed(agent = AGENT, providerSessionId: string | null = 'prov_impl') {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    createSession(
      h.db,
      {
        id: 's_work',
        agentId: 'implementer',
        workspaceId: 'default',
        ownerPrincipal: ALICE,
        ...(providerSessionId === null ? {} : { providerSessionId }),
      },
      NOW,
    );
    ok(attachSession(h.db, work.runId, 's_work', NOW));
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    const r = requestChanges(h.db, task.taskId, asRun(review), 'handle empty input', NOW);
    ok(closeRun(h.db, review.runId, NOW));
    return { task, work, review, r, rework: claimed(h.db, task.taskId, { agentConfig: agent }) };
  }

  it('returns the task to open, and the next claim is a rework resuming the work run', () => {
    const { task, work, review, r, rework } = reviewed();
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'open' },
      run: { runId: review.runId, outcome: 'changes_requested', summary: 'handle empty input' },
    });
    expect(rework).toMatchObject({ kind: 'work', attempt: 3, seededFromRun: work.runId });
    expect(eventsOf(h.db, task.taskId).find((e) => e.kind === 'changes_requested')?.payload).toEqual({
      reason: 'handle empty input',
    });
  });

  it('does not seed a rework on another agent, or from a session that saw no provider session', () => {
    expect(reviewed({ ...AGENT, args: ['run', '-m', 'model-b'] }).rework.seededFromRun).toBeNull();
    h.close();
    h = testDb();
    // A changed environment does not make a conversation unresumable.
    expect(reviewed({ ...AGENT, envNames: ['OTHER_KEY'] }).rework.seededFromRun).not.toBeNull();
    h.close();
    h = testDb();
    expect(reviewed(AGENT, null).rework.seededFromRun).toBeNull();
  });

  it('refuses changes from a work run', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const run = claimed(h.db, task.taskId);
    expect(requestChanges(h.db, task.taskId, asRun(run), 'x', NOW)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${task.taskId} is open, so it cannot have changes requested`,
    });
  });
});

describe('closeRun', () => {
  it('closes a decided run once, and refuses an undecided one', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(closeRun(h.db, run.runId, NOW)).toEqual({
      ok: false,
      code: 'undecided',
      message: `run ${run.runId} has no outcome yet; record one first`,
    });
    ok(complete(h.db, task.taskId, asRun(run), { summary: 'done' }, NOW));
    ok(closeRun(h.db, run.runId, NOW + 1));
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({ kind: 'run_closed', payload: { outcome: 'completed' } });
    expect(closeRun(h.db, run.runId, NOW + 2)).toMatchObject({ ok: false, code: 'already_closed' });
  });
});

describe('a workspace from the parents', () => {
  it("is the parents' common one, ignoring a parent whose workspace was never fixed", () => {
    const child = newTask(h.db, { parents: [doneIn('api'), doneIn('api'), doneIn(null)] });
    expect(claimed(h.db, child.taskId).workspace).toBe('api');
    expect(getTask(h.db, child.taskId)?.workspace).toBe('api');
  });

  it("leaves an agent task unassignable when they disagree, and claims a person's with no workspace", () => {
    const web = doneIn('web');
    const api = doneIn('api');
    const agentTask = newTask(h.db, { parents: [web, api] });
    expect(
      claim(
        h.db,
        { taskId: agentTask.taskId, claimant: claimantFor(h.db, agentTask.taskId), workspaces: WORKSPACES },
        NOW,
      ),
    ).toEqual({
      ok: false,
      code: 'unassignable',
      message: `task ${agentTask.taskId}'s parents are in different workspaces (api, web); set its workspace`,
    });
    expect(runsOf(h.db, agentTask.taskId)).toEqual([]);
    // A person's run does not use the workspace, so the task is still claimed.
    const personTask = newTask(h.db, { parents: [web, api], assignee: BOB });
    expect(claimed(h.db, personTask.taskId)).toMatchObject({ workspace: null, agentConfig: null });
    expect(getTask(h.db, personTask.taskId)?.workspace).toBeNull();
  });

  it('is resolved afresh by an agent claim after a person left it null', () => {
    const web = doneIn('web');
    const api = doneIn('api');
    const task = newTask(h.db, { parents: [web, api], assignee: BOB, reviewer: REVIEWER });
    claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asPerson('lark:on_bob'), { summary: 'have a look' }, NOW));
    expect(getTask(h.db, task.taskId)?.workspace).toBeNull();
    // The rules apply again: the parents still disagree, so only the role's own workspace settles it.
    expect(
      claim(h.db, { taskId: task.taskId, claimant: claimantFor(h.db, task.taskId), workspaces: WORKSPACES }, NOW),
    ).toMatchObject({ ok: false, code: 'unassignable' });
    expect(claimed(h.db, task.taskId, { roleWorkspace: 'docs' })).toMatchObject({ kind: 'review', workspace: 'docs' });
    expect(getTask(h.db, task.taskId)?.workspace).toBe('docs');
  });
});
```

- [ ] **Step 9.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-reports.test.ts`. Expected: all 18 FAIL, for example with `(0 , complete) is not a function`.

- [ ] **Step 9.3: Implement.** Replace the imports at the top of `src/db/kanban.ts`, that is everything above the header comment that begins `/**` / ` * The board's only writer`, with:

```ts
import type { Db } from './open.js';
import { txImmediate } from './open.js';
import { newRunId, newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { resolveTaskWorkspace } from '../kanban/workspace.js';
import { REPORTED_OUTCOMES } from '../kanban/types.js';
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  CommentRow,
  Contract,
  CreatedVia,
  Phase,
  Refusal,
  RefusalCode,
  Reporter,
  Result,
  RetryOnCrash,
  RunKind,
  RunOutcome,
  RunRow,
  TaskRow,
} from '../kanban/types.js';
import {
  getRun,
  getTask,
  getTaskByKey,
  isFinished,
  openAgentRunIn,
  openRunOf,
  parentsOf,
  runsOf,
} from './kanban-read.js';
```

Then append to the end of `src/db/kanban.ts`:

```ts
// ---------------------------------------------------------------------------
// Reports: complete, review, changes
// ---------------------------------------------------------------------------

/** A worker's or a person's handoff (spec §7.3). */
export interface Handoff {
  summary: string;
  metadata?: unknown;
  /** For an agent's report in a git workspace (spec §7.8), captured before this transaction. */
  reportedCommit?: string | null;
  reportedDirty?: boolean | null;
}

export function actorOf(by: Reporter): string {
  return by.kind === 'run' ? `run:${by.runId}` : by.principal;
}

/**
 * The run a report decides, if any.
 *
 * A run reports only through its own run, while that is open and undecided: once
 * it has reported, a second report is `already_reported`; once anything else has
 * decided it, or it is closed, `run_superseded` (spec §7.2).
 *
 * A person's report decides the open human run, if there is one. While an agent
 * run is open it is refused (spec §5.1): gates would run against a checkout the
 * agent is still changing, and the agent's own later report would contradict
 * the person's.
 */
function reportingRun(d: Db, task: TaskRow, by: Reporter): Result<{ run: RunRow | undefined }> {
  if (by.kind === 'run') {
    const run = getRun(d, by.runId);
    if (run === undefined) return refuse('not_found', `no run ${by.runId}`);
    if (run.taskId !== task.taskId) {
      return refuse('wrong_task', `run ${run.runId} is on task ${run.taskId}, not ${task.taskId}`);
    }
    if (run.endedAt !== null) return refuse('run_superseded', `run ${run.runId} is over`);
    if (run.outcome !== null) {
      return (REPORTED_OUTCOMES as readonly string[]).includes(run.outcome)
        ? refuse('already_reported', `run ${run.runId} has already reported (${run.outcome})`)
        : refuse('run_superseded', `run ${run.runId} has ended (${run.outcome})`);
    }
    return { ok: true, run };
  }
  const open = openRunOf(d, task.taskId);
  if (open === undefined) return { ok: true, run: undefined };
  if (open.assignee.kind === 'role') {
    return refuse(
      'agent_run_open',
      open.outcome === null
        ? `task ${task.taskId} has an agent run working on it (${open.runId}); stop it first`
        : `task ${task.taskId}'s agent run ${open.runId} has reported and is finishing; wait for it to finish`,
    );
  }
  return { ok: true, run: open };
}

/** The phase a run of this kind works in. */
function phaseOfKind(kind: RunKind): ActivePhase {
  return kind === 'work' ? 'open' : 'review';
}

/**
 * Set an undecided run's outcome. A person's run is closed at the same moment:
 * there is no process to finish (spec §3.3). Any outcome but `rate_limited`
 * resets the task's throttling counter (spec §8.2).
 */
function decide(
  d: Db,
  run: RunRow,
  outcome: RunOutcome,
  fields: {
    summary?: string | null;
    metadata?: unknown;
    reportedCommit?: string | null;
    reportedDirty?: boolean | null;
    error?: string | null;
    lastOutput?: string | null;
  },
  now: number,
): void {
  const agent = run.agentConfig !== null;
  const changed = d
    .prepare(
      `UPDATE kanban_runs
          SET outcome = ?, summary = ?, metadata = jsonb(?), reported_commit = ?, reported_dirty = ?,
              error = ?, last_output = ?, ended_at = ?
        WHERE run_id = ? AND outcome IS NULL`,
    )
    .run(
      outcome,
      fields.summary === undefined || fields.summary === null ? null : mask(fields.summary),
      fields.metadata === undefined ? null : JSON.stringify(redactValues(fields.metadata)),
      agent ? (fields.reportedCommit ?? null) : null,
      agent && fields.reportedDirty !== undefined && fields.reportedDirty !== null
        ? Number(fields.reportedDirty)
        : null,
      fields.error === undefined || fields.error === null ? null : mask(fields.error),
      fields.lastOutput === undefined || fields.lastOutput === null ? null : mask(fields.lastOutput),
      agent ? null : now,
      run.runId,
    ).changes;
  if (changed !== 1) throw new Error(`run ${run.runId} was decided twice`);
  if (outcome !== 'rate_limited') {
    d.prepare('UPDATE kanban_tasks SET consecutive_transient = 0 WHERE task_id = ?').run(run.taskId);
  }
}

/**
 * Report on the task as the run or person given, after the checks every report
 * shares: the reporter may report, the task is in a phase this report applies
 * to, and a run's kind fits that phase.
 */
function reporting(
  d: Db,
  taskId: string,
  by: Reporter,
  phases: readonly ActivePhase[],
  what: string,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  const task = getTask(d, taskId);
  if (task === undefined) return refuse('not_found', `no task ${taskId}`);
  const r = reportingRun(d, task, by);
  if (!r.ok) return r;
  if (!(phases as readonly Phase[]).includes(task.phase)) {
    return refuse('illegal_transition', `task ${taskId} is ${task.phase}, so it cannot ${what}`);
  }
  if (r.run !== undefined && phaseOfKind(r.run.kind) !== task.phase) {
    return refuse('illegal_transition', `a ${r.run.kind} run cannot ${what}`);
  }
  return { ok: true, task, run: r.run };
}

/**
 * The one way to `done` (spec §5.1): an agent's or reviewer's `complete`, a
 * person's done or approval. Gates run before it, from plan C4.
 *
 * Completion resets the breaker's counters, and is the only report that does
 * (spec §3.1). A task whose parents are not all finished is refused: only a link
 * added after it started could cause that, which link() prevents; this is the
 * backstop.
 */
export function complete(
  db: Db,
  taskId: string,
  by: Reporter,
  handoff: Handoff,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open', 'review'], 'be completed');
    if (!r.ok) return r;
    if (!parentsOf(d, taskId).every((p) => isFinished(p.phase))) {
      return refuse('parents_unfinished', `task ${taskId} has a parent that is not done`);
    }
    if (r.run !== undefined) decide(d, r.run, 'completed', handoff, now);
    d.prepare(
      `UPDATE kanban_tasks
          SET phase = 'done', closed_at = ?, consecutive_failures = 0, consecutive_transient = 0,
              block_recurrences = 0, cooldown_until = NULL
        WHERE task_id = ?`,
    ).run(now, taskId);
    record(
      d,
      {
        taskId,
        runId: r.run?.runId ?? null,
        kind: 'completed',
        actor: actorOf(by),
        payload: { summary: handoff.summary },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
  });
}

/**
 * Same-task review (spec §5.3). A reviewer named in the report replaces the
 * task's; with none named anywhere it is refused, since a task in review with
 * nobody to review it is stranded under another label. Gates run before it,
 * from plan C4.
 */
export function requestReview(
  db: Db,
  taskId: string,
  by: Reporter,
  handoff: Handoff & { reviewer?: Assignee },
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open'], 'ask for review');
    if (!r.ok) return r;
    const reviewer = handoff.reviewer ?? r.task.reviewer;
    if (reviewer === null) return refuse('no_reviewer', `nobody is named to review task ${taskId}`);
    if (r.run !== undefined) decide(d, r.run, 'review_requested', handoff, now);
    d.prepare("UPDATE kanban_tasks SET phase = 'review', reviewer_kind = ?, reviewer = ? WHERE task_id = ?").run(
      reviewer.kind,
      reviewer.name,
      taskId,
    );
    record(
      d,
      {
        taskId,
        runId: r.run?.runId ?? null,
        kind: 'review_requested',
        actor: actorOf(by),
        payload: { summary: handoff.summary, reviewer: reviewer.name },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
  });
}

/**
 * A reviewer's `changes` (spec §5.3): the task returns to open, and its next
 * claim is the rework. The reason is the review run's summary, which the
 * rework's prompt carries.
 */
export function requestChanges(
  db: Db,
  taskId: string,
  by: Reporter,
  reason: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['review'], 'have changes requested');
    if (!r.ok) return r;
    if (r.run !== undefined) decide(d, r.run, 'changes_requested', { summary: reason }, now);
    d.prepare("UPDATE kanban_tasks SET phase = 'open' WHERE task_id = ?").run(taskId);
    record(
      d,
      { taskId, runId: r.run?.runId ?? null, kind: 'changes_requested', actor: actorOf(by), payload: { reason } },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
  });
}

/**
 * Close a decided run: its session's last turn has ended, the agent process is
 * gone, and the workspace is free (spec §3.3). An undecided run is refused: what
 * ended it must be recorded first, by a report or by endRun().
 */
export function closeRun(db: Db, runId: string, now: number): Result<{ run: RunRow }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.endedAt !== null) return refuse('already_closed', `run ${runId} is already closed`);
    if (run.outcome === null) return refuse('undecided', `run ${runId} has no outcome yet; record one first`);
    d.prepare('UPDATE kanban_runs SET ended_at = ? WHERE run_id = ?').run(now, runId);
    record(
      d,
      { taskId: run.taskId, runId, kind: 'run_closed', actor: 'gateway', payload: { outcome: run.outcome } },
      now,
    );
    return { ok: true, run: mustGetRun(d, runId) };
  });
}
```

- [ ] **Step 9.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  651 passed (651)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 9.5: Commit.**

```bash
git add src/db/kanban.ts tests/kanban-reports.test.ts
git commit -m "Report complete, review and changes, and close a decided run"
```

---

### Task 10: Blocking, unblocking, stopping

**Files:**
- Modify: `src/db/kanban.ts`
- Create: `tests/kanban-block.test.ts`

Spec §5.1 and §5.4.
- **A block of any kind but `dependency`** moves the task to `blocked`, with `blocked_from` set to the phase it left.
- **A block of the same kind as the last one** increments `block_recurrences`. The kind survives unblock, and only completion resets the count.
- **A `dependency` block** links the parents it names in the same transaction (Decision 1), through `linkIn`, and leaves the phase as it was:
  - from a work run the task stays `open`, shown `todo`;
  - from a review run it stays `review`, shown `todo`, and the reviewer is claimed again once the parents are done (Decision 2). The implementer's work is done; only the review was waiting.

  Since the phase does not move, there is nothing to write before the parents check: `linkIn` accepts the task in either phase, and a refused block rolls back the links.
- **`unblock`** returns the task to `blocked_from`. For a `gave_up` block it resets the failure count, and for a `transient` block the throttling count (spec §8.2).
- **`stop`** cancels an undecided run and blocks the task as `needs_input`, rather than leaving it ready to be dispatched again at once. On a run that has already reported it writes nothing (Decision 21).

- [ ] **Step 10.1: Write the failing tests.** Create `tests/kanban-block.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { block, claim, closeRun, complete, requestReview, stop, unblock } from '../src/db/kanban.js';
import { commentsOf, eventsOf, getRun, getTask, parentsOf, taskView } from '../src/db/kanban-read.js';
import type { Reporter, RunRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, WORKSPACES, claimantFor, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  clearSecrets();
  h = testDb();
});

afterEach(() => {
  h.close();
  clearSecrets();
});

const BOB = { kind: 'human', name: 'lark:on_bob' } as const;
const asRun = (run: RunRow): Reporter => ({ kind: 'run', runId: run.runId });

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** Claim, block with this kind, and close the run, as an agent would leave it. */
function blockedBy(taskId: string, kind: 'needs_input' | 'capability'): void {
  const run = claimed(h.db, taskId);
  ok(block(h.db, taskId, asRun(run), { kind, reason: `${kind} please` }, NOW));
  ok(closeRun(h.db, run.runId, NOW));
}

describe('block', () => {
  it('blocks a running task, remembering the phase it left, and records why', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = block(h.db, task.taskId, asRun(run), { kind: 'needs_input', reason: 'which database?' }, NOW);
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'blocked', blockedFrom: 'open', blockKind: 'needs_input', blockReason: 'which database?' },
      run: { outcome: 'blocked', summary: 'which database?', endedAt: null },
    });
    expect(taskView(h.db, task.taskId)?.status).toBe('blocked');
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'blocked',
      payload: { kind: 'needs_input', reason: 'which database?', blockRecurrences: 0 },
    });
  });

  it('masks the reason on write', () => {
    addSecrets(['sk-test-123456']);
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = ok(
      block(h.db, task.taskId, asRun(run), { kind: 'capability', reason: 'sk-test-123456 is revoked' }, NOW),
    );
    expect(r.task.blockReason).toBe(`${MASK} is revoked`);
    expect(r.run?.summary).toBe(`${MASK} is revoked`);
    expect(eventsOf(h.db, task.taskId).at(-1)?.payload).toMatchObject({ reason: `${MASK} is revoked` });
  });

  it('counts a block of the same kind after an unblock, and keeps the count across unblocks', () => {
    const task = newTask(h.db);
    blockedBy(task.taskId, 'needs_input');
    ok(unblock(h.db, task.taskId, ALICE, undefined, NOW));
    blockedBy(task.taskId, 'needs_input');
    expect(getTask(h.db, task.taskId)?.blockRecurrences).toBe(1);
    ok(unblock(h.db, task.taskId, ALICE, undefined, NOW));
    blockedBy(task.taskId, 'capability');
    expect(getTask(h.db, task.taskId)).toMatchObject({ blockRecurrences: 1, blockKind: 'capability' });
  });

  it('returns a task to open on a dependency block, waiting on the parents it names', () => {
    const prerequisite = newTask(h.db, { title: 'prerequisite' });
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = block(
      h.db,
      task.taskId,
      asRun(run),
      { kind: 'dependency', reason: 'needs the schema first', parents: [prerequisite.taskId] },
      NOW,
    );
    expect(r).toMatchObject({ ok: true, task: { phase: 'open', blockKind: null }, run: { outcome: 'blocked' } });
    expect(parentsOf(h.db, task.taskId).map((t) => t.title)).toEqual(['prerequisite']);
    expect(taskView(h.db, task.taskId)?.status).toBe('todo');
  });

  it("keeps a reviewer's dependency block in review, and claims the reviewer again once the parents are done", () => {
    // The implementer's work is done; only the review was waiting.
    const prerequisite = newTask(h.db, { title: 'prerequisite', assignee: BOB });
    const task = newTask(h.db, { reviewer: { kind: 'role', name: 'reviewer' } });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    const r = block(
      h.db,
      task.taskId,
      asRun(review),
      { kind: 'dependency', reason: 'needs the API docs first', parents: [prerequisite.taskId] },
      NOW,
    );
    expect(r).toMatchObject({ ok: true, task: { phase: 'review', blockKind: null }, run: { outcome: 'blocked' } });
    expect(parentsOf(h.db, task.taskId).map((t) => t.title)).toEqual(['prerequisite']);
    expect(taskView(h.db, task.taskId)?.status).toBe('todo');
    ok(closeRun(h.db, review.runId, NOW));
    expect(
      claim(h.db, { taskId: task.taskId, claimant: claimantFor(h.db, task.taskId), workspaces: WORKSPACES }, NOW),
    ).toEqual({
      ok: false,
      code: 'not_claimable',
      message: `task ${task.taskId} is waiting on a parent that is not done`,
    });
    ok(
      complete(
        h.db,
        prerequisite.taskId,
        { kind: 'person', principal: 'lark:on_bob' },
        { summary: 'docs written' },
        NOW,
      ),
    );
    expect(taskView(h.db, task.taskId)?.status).toBe('review');
    expect(claimed(h.db, task.taskId)).toMatchObject({ kind: 'review', attempt: 3, assignee: { name: 'reviewer' } });
  });

  it('refuses a dependency block with nothing unfinished to wait on, and writes nothing', () => {
    const finished = newTask(h.db, { assignee: BOB });
    ok(complete(h.db, finished.taskId, { kind: 'person', principal: 'lark:on_bob' }, { summary: 'done' }, NOW));
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    for (const parents of [[], [finished.taskId]]) {
      expect(block(h.db, task.taskId, asRun(run), { kind: 'dependency', reason: 'x', parents }, NOW)).toEqual({
        ok: false,
        code: 'invalid',
        message: `a dependency block must name a task ${task.taskId} waits on that is not done`,
      });
    }
    expect(parentsOf(h.db, task.taskId)).toEqual([]);
    expect(getRun(h.db, run.runId)?.outcome).toBeNull();
  });
});

describe('unblock', () => {
  it('returns a task to the phase it left, keeping the kind, with a comment for the next run', () => {
    const task = newTask(h.db, { reviewer: { kind: 'role', name: 'reviewer' } });
    const work = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    blockedBy(task.taskId, 'capability');
    expect(getTask(h.db, task.taskId)?.blockedFrom).toBe('review');
    const r = unblock(h.db, task.taskId, ALICE, 'access granted', NOW);
    expect(r).toMatchObject({ ok: true, task: { phase: 'review', blockedFrom: null, blockKind: 'capability' } });
    expect(commentsOf(h.db, task.taskId).map((c) => [c.author, c.body])).toEqual([[ALICE, 'access granted']]);
    expect(claimed(h.db, task.taskId).kind).toBe('review');
  });

  it('refuses a task that is not blocked', () => {
    const task = newTask(h.db);
    expect(unblock(h.db, task.taskId, ALICE, undefined, NOW)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${task.taskId} is open, not blocked`,
    });
  });
});

describe('stop', () => {
  it('cancels an undecided run, and blocks the task for input', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const r = stop(h.db, task.taskId, ALICE, NOW);
    expect(r).toMatchObject({
      ok: true,
      task: { phase: 'blocked', blockedFrom: 'open', blockKind: 'needs_input', blockReason: `stopped by ${ALICE}` },
      run: { outcome: 'cancelled', endedAt: null },
    });
    // The agent's later report finds its run decided by someone else.
    expect(complete(h.db, task.taskId, asRun(run), { summary: 'x' }, NOW)).toMatchObject({
      ok: false,
      code: 'run_superseded',
    });
  });

  it('leaves a run that has reported with its outcome, writing nothing', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    ok(complete(h.db, task.taskId, asRun(run), { summary: 'done' }, NOW));
    const before = eventsOf(h.db, task.taskId).length;
    expect(stop(h.db, task.taskId, ALICE, NOW)).toMatchObject({
      ok: true,
      task: { phase: 'done' },
      run: { outcome: 'completed', endedAt: null },
    });
    expect(eventsOf(h.db, task.taskId)).toHaveLength(before);
  });

  it("closes a person's stopped run at once, and refuses a task with no open run", () => {
    const task = newTask(h.db, { assignee: BOB });
    claimed(h.db, task.taskId);
    expect(stop(h.db, task.taskId, ALICE, NOW + 1)).toMatchObject({
      ok: true,
      run: { outcome: 'cancelled', endedAt: NOW + 1 },
    });
    expect(stop(h.db, task.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'no_open_run',
      message: `task ${task.taskId} has no open run to stop`,
    });
  });
});
```

- [ ] **Step 10.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-block.test.ts`. Expected: all 11 FAIL, for example with `(0 , block) is not a function`.

- [ ] **Step 10.3: Implement.** Replace the imports at the top of `src/db/kanban.ts`, that is everything above the header comment that begins `/**` / ` * The board's only writer`, with:

```ts
import type { Db } from './open.js';
import { txImmediate } from './open.js';
import { newRunId, newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { resolveTaskWorkspace } from '../kanban/workspace.js';
import { REPORTED_OUTCOMES } from '../kanban/types.js';
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  BlockKind,
  CommentRow,
  Contract,
  CreatedVia,
  Phase,
  Refusal,
  RefusalCode,
  ReportedBlockKind,
  Reporter,
  Result,
  RetryOnCrash,
  RunKind,
  RunOutcome,
  RunRow,
  TaskRow,
} from '../kanban/types.js';
import {
  getRun,
  getTask,
  getTaskByKey,
  isFinished,
  openAgentRunIn,
  openRunOf,
  parentsOf,
  runsOf,
} from './kanban-read.js';
```

Then append to the end of `src/db/kanban.ts`:

```ts
// ---------------------------------------------------------------------------
// Blocking, unblocking, stopping
// ---------------------------------------------------------------------------

export interface BlockReport {
  kind: ReportedBlockKind;
  reason: string;
  /** For `dependency`: the tasks it waits on, linked as parents in the same transaction. */
  parents?: readonly string[];
}

/**
 * Move a task to `blocked` (spec §5.4), remembering the phase it left. A block of
 * the same kind as the last one -- which survives unblock -- is a recurrence,
 * and recurrences are reset only by completion: resetting them on unblock is the
 * amnesia that lets a task bounce between blocked and unblocked forever.
 */
function enterBlocked(d: Db, task: TaskRow, kind: Exclude<BlockKind, 'dependency'>, reason: string): number {
  if (task.phase !== 'open' && task.phase !== 'review') throw new Error(`cannot block a ${task.phase} task`);
  const recurrences = task.blockRecurrences + (task.blockKind === kind ? 1 : 0);
  d.prepare(
    `UPDATE kanban_tasks
        SET phase = 'blocked', blocked_from = ?, block_kind = ?, block_reason = ?, block_recurrences = ?
      WHERE task_id = ?`,
  ).run(task.phase, kind, mask(reason), recurrences, task.taskId);
  return recurrences;
}

/**
 * A worker's or person's `block` (spec §5.1, §5.4).
 *
 * `dependency` never sits in `blocked`, since no person needs to act. The task
 * keeps its phase, and the parents the report names are linked here, so its next
 * claim waits for them:
 * - from a work run it stays `open`, shown as todo;
 * - from a review run it stays `review`, shown as todo, and the reviewer is
 *   claimed again once the parents are done. The implementer's work is done; only
 *   the review was waiting, so it is not redone.
 *
 * A dependency block that leaves nothing unfinished to wait on is refused: the
 * task would be claimable again at once.
 */
export function block(
  db: Db,
  taskId: string,
  by: Reporter,
  report: BlockReport,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const r = reporting(d, taskId, by, ['open', 'review'], 'be blocked');
    if (!r.ok) return r;
    if (r.run !== undefined) decide(d, r.run, 'blocked', { summary: report.reason }, now);
    const actor = actorOf(by);
    if (report.kind === 'dependency') {
      const parents = report.parents ?? [];
      for (const parent of parents) {
        const linked = linkIn(d, parent, taskId, actor, now, r.run?.runId);
        if (!linked.ok) return linked;
      }
      if (parentsOf(d, taskId).every((p) => isFinished(p.phase))) {
        return refuse('invalid', `a dependency block must name a task ${taskId} waits on that is not done`);
      }
      record(
        d,
        {
          taskId,
          runId: r.run?.runId ?? null,
          kind: 'blocked',
          actor,
          payload: { kind: report.kind, reason: report.reason, parents },
        },
        now,
      );
    } else {
      const recurrences = enterBlocked(d, r.task, report.kind, report.reason);
      record(
        d,
        {
          taskId,
          runId: r.run?.runId ?? null,
          kind: 'blocked',
          actor,
          payload: { kind: report.kind, reason: report.reason, blockRecurrences: recurrences },
        },
        now,
      );
    }
    return { ok: true, task: mustGet(d, taskId), run: r.run === undefined ? undefined : mustGetRun(d, r.run.runId) };
  });
}

/**
 * Return a blocked task to the phase it left (spec §5.4), optionally with a
 * comment the next run will read. The kind and reason are kept.
 *
 * Unblocking a `gave_up` task resets its failure count, and a `transient` one its
 * throttling count (spec §8.2): otherwise a person who fixed the cause would get
 * one attempt, or none, before the breaker tripped again.
 */
export function unblock(
  db: Db,
  taskId: string,
  by: string,
  comment: string | undefined,
  now: number,
): Result<{ task: TaskRow }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.phase !== 'blocked') return refuse('illegal_transition', `task ${taskId} is ${task.phase}, not blocked`);
    d.prepare(
      `UPDATE kanban_tasks
          SET phase = blocked_from, blocked_from = NULL,
              consecutive_failures = CASE block_kind WHEN 'gave_up' THEN 0 ELSE consecutive_failures END,
              consecutive_transient = CASE block_kind WHEN 'transient' THEN 0 ELSE consecutive_transient END,
              cooldown_until = CASE block_kind WHEN 'transient' THEN NULL ELSE cooldown_until END
        WHERE task_id = ?`,
    ).run(taskId);
    record(d, { taskId, kind: 'unblocked', actor: by, payload: { kind: task.blockKind } }, now);
    if (comment !== undefined && comment !== '') insertComment(d, taskId, by, comment, now);
    return { ok: true, task: mustGet(d, taskId) };
  });
}

/**
 * `/kanban stop` (spec §5.1). An undecided run is cancelled and the task blocks
 * as `needs_input`, rather than staying ready and being dispatched again at once.
 * A run that has already reported keeps its outcome; nothing is written.
 *
 * The run returned still has `endedAt` null when it is an agent's: the caller
 * cancels its turn, and closes it when the turn ends.
 */
export function stop(db: Db, taskId: string, by: string, now: number): Result<{ task: TaskRow; run: RunRow }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    const open = openRunOf(d, taskId);
    if (open === undefined) return refuse('no_open_run', `task ${taskId} has no open run to stop`);
    if (open.outcome !== null) return { ok: true, task, run: open };
    decide(d, open, 'cancelled', {}, now);
    const recurrences = enterBlocked(d, task, 'needs_input', `stopped by ${by}`);
    record(
      d,
      { taskId, runId: open.runId, kind: 'stopped', actor: by, payload: { blockRecurrences: recurrences } },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run: mustGetRun(d, open.runId) };
  });
}
```

- [ ] **Step 10.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  662 passed (662)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 10.5: Commit.**

```bash
git add src/db/kanban.ts tests/kanban-block.test.ts
git commit -m "Block, unblock and stop a task, keeping a reviewer's dependency block in review"
```

---

### Task 11: Runs that end without a report

**Files:**
- Modify: `src/db/kanban.ts`
- Create: `tests/kanban-runs.test.ts`

`endRun` is the run-outcome transition plan C2 calls. It takes the classifier's outcome (§8.1), or the dispatcher's own, `timed_out` or `interrupted`, which the dispatcher records before it cancels the turn (§6.4). It applies §5.1's failure rows and §8.2's counting, to work and review runs alike: a failing review run is counted and the task stays in review.

It acts only on an undecided run. A decided run's outcome is never overwritten (§3.3), so a runtime limit or a restart arriving just after a report cannot turn a completed task's run into a failure. The run stays open; `closeRun` closes it when its turn has ended. `hadSideEffects` is C2's to work out from the session log and the role's `readOnlyTools`. A throttled run held for a person keeps its throttling count across the unblock (Decision 12).

- [ ] **Step 11.1: Write the failing tests.** Create `tests/kanban-runs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  claim,
  closeRun,
  complete,
  endRun,
  requestReview,
  unblock,
  type RunEnding,
} from '../src/db/kanban.js';
import { eventsOf, getRun, getTask } from '../src/db/kanban-read.js';
import type { NewTask } from '../src/db/kanban.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, WORKSPACES, claimantFor, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  clearSecrets();
  h = testDb();
});

afterEach(() => {
  h.close();
  clearSecrets();
});

const SEC = 1000;

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** Claim the task, end the run this way, and close it, as plan C2 will once its turn is over. */
function attempt(taskId: string, ending: RunEnding, limits = DEFAULT_LIMITS, now = NOW) {
  const run = claimed(h.db, taskId, {}, now);
  const r = ok(endRun(h.db, run.runId, ending, limits, now));
  ok(closeRun(h.db, run.runId, now));
  return r;
}

function task(t: Partial<NewTask> = {}): string {
  return newTask(h.db, t).taskId;
}

describe('endRun', () => {
  it('counts a failure, records it, and leaves the task to be claimed again', () => {
    addSecrets(['sk-test-123456']);
    const id = task();
    const run = claimed(h.db, id);
    const r = endRun(
      h.db,
      run.runId,
      { outcome: 'failed', error: 'exit 1 with sk-test-123456', lastOutput: 'tests failed' },
      DEFAULT_LIMITS,
      NOW,
    );
    expect(r).toMatchObject({
      ok: true,
      next: 'retry',
      task: { phase: 'open', consecutiveFailures: 1 },
      run: { outcome: 'failed', error: `exit 1 with ${MASK}`, lastOutput: 'tests failed', endedAt: null },
    });
    expect(eventsOf(h.db, id).at(-1)).toMatchObject({
      kind: 'run_ended',
      payload: { outcome: 'failed', error: `exit 1 with ${MASK}`, next: 'retry', blockKind: null },
    });
    ok(closeRun(h.db, run.runId, NOW));
    expect(claimed(h.db, id).attempt).toBe(2);
  });

  it('gives up at the failure limit, keeping the outcome that used it up', () => {
    const id = task();
    attempt(id, { outcome: 'failed' });
    const r = attempt(id, { outcome: 'crashed', error: 'exited without finishing' });
    expect(r).toMatchObject({
      next: 'blocked',
      run: { outcome: 'crashed' },
      task: {
        phase: 'blocked',
        blockKind: 'gave_up',
        blockReason: 'failed 2 times; last crashed: exited without finishing',
        consecutiveFailures: 2,
      },
    });
  });

  it("uses the task's own failure limit: 1 means no retries", () => {
    expect(attempt(task({ failureLimit: 1 }), { outcome: 'timed_out' })).toMatchObject({
      next: 'blocked',
      task: { blockKind: 'gave_up' },
    });
  });

  it('counts a failing review run, and leaves the task in review for the reviewer', () => {
    const id = task({ reviewer: { kind: 'role', name: 'reviewer' } });
    const work = claimed(h.db, id);
    ok(requestReview(h.db, id, { kind: 'run', runId: work.runId }, { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    expect(attempt(id, { outcome: 'crashed' })).toMatchObject({
      next: 'retry',
      run: { kind: 'review', outcome: 'crashed' },
      task: { phase: 'review', consecutiveFailures: 1 },
    });
    expect(claimed(h.db, id)).toMatchObject({ kind: 'review', attempt: 3 });
  });

  it('resets the failure count on completion, and on unblocking a task that gave up', () => {
    const a = task();
    attempt(a, { outcome: 'protocol_violation' });
    const run = claimed(h.db, a);
    expect(
      ok(complete(h.db, a, { kind: 'run', runId: run.runId }, { summary: 'done' }, NOW)).task.consecutiveFailures,
    ).toBe(0);
    ok(closeRun(h.db, run.runId, NOW));

    const b = task({ failureLimit: 1 });
    attempt(b, { outcome: 'failed' });
    expect(ok(unblock(h.db, b, ALICE, undefined, NOW)).task).toMatchObject({
      phase: 'open',
      consecutiveFailures: 0,
      blockRecurrences: 0,
    });
  });

  it('does not count throttling, and holds the task in a doubling cooldown', () => {
    const id = task();
    expect(attempt(id, { outcome: 'rate_limited' })).toMatchObject({
      next: 'cooldown',
      task: { phase: 'open', consecutiveFailures: 0, consecutiveTransient: 1, cooldownUntil: NOW + 300 * SEC },
    });
    const early = claim(h.db, { taskId: id, claimant: claimantFor(h.db, id), workspaces: WORKSPACES }, NOW + 299 * SEC);
    expect(early).toEqual({
      ok: false,
      code: 'not_claimable',
      message: `task ${id} is cooling down after being throttled`,
    });
    expect(attempt(id, { outcome: 'rate_limited' }, DEFAULT_LIMITS, NOW + 300 * SEC).task.cooldownUntil).toBe(
      NOW + 900 * SEC,
    );
  });

  it('caps the cooldown at an hour, blocks as transient at the limit, and unblocking resets it', () => {
    const limits = { ...DEFAULT_LIMITS, transientLimit: 3, transientCooldownS: 2000 };
    const id = task();
    expect(attempt(id, { outcome: 'rate_limited' }, limits, NOW).task.cooldownUntil).toBe(NOW + 2000 * SEC);
    expect(attempt(id, { outcome: 'rate_limited' }, limits, NOW + 2000 * SEC).task.cooldownUntil).toBe(
      NOW + 5600 * SEC,
    );
    expect(attempt(id, { outcome: 'rate_limited' }, limits, NOW + 5600 * SEC)).toMatchObject({
      next: 'blocked',
      task: { blockKind: 'transient', blockReason: 'throttled 3 times in a row' },
    });
    expect(ok(unblock(h.db, id, ALICE, undefined, NOW)).task).toMatchObject({
      consecutiveTransient: 0,
      cooldownUntil: null,
    });
  });

  it('resets the throttling count on any other outcome', () => {
    const id = task();
    attempt(id, { outcome: 'rate_limited' });
    expect(attempt(id, { outcome: 'failed' }, DEFAULT_LIMITS, NOW + 300 * SEC).task.consecutiveTransient).toBe(0);
  });

  it('blocks at once on a terminal provider error, without counting it', () => {
    expect(attempt(task(), { outcome: 'terminal_provider', error: '401 unauthorized' })).toMatchObject({
      next: 'blocked',
      task: { blockKind: 'capability', blockReason: '401 unauthorized', consecutiveFailures: 0 },
    });
  });

  it('does not count an interruption', () => {
    expect(attempt(task(), { outcome: 'interrupted' })).toMatchObject({
      next: 'retry',
      task: { phase: 'open', consecutiveFailures: 0 },
    });
  });

  it('with if-no-side-effects, asks a person before retrying a run that changed things', () => {
    const careful = { retryOnCrash: 'if-no-side-effects' } as const;
    expect(attempt(task(careful), { outcome: 'failed', hadSideEffects: true })).toMatchObject({
      next: 'blocked',
      task: {
        blockKind: 'needs_input',
        blockReason: 'the run ended failed after changing things; look before it is retried',
      },
    });
    expect(attempt(task(careful), { outcome: 'failed', hadSideEffects: false }).next).toBe('retry');
    expect(attempt(task(careful), { outcome: 'interrupted', hadSideEffects: true }).task.blockKind).toBe('needs_input');
    const throttled = attempt(task(careful), { outcome: 'rate_limited', hadSideEffects: true }).task;
    expect(throttled).toMatchObject({ blockKind: 'needs_input', consecutiveTransient: 1 });
    // Unblocking it is not unblocking a transient block: the throttling count stands (spec §8.2).
    expect(ok(unblock(h.db, throttled.taskId, ALICE, undefined, NOW)).task.consecutiveTransient).toBe(1);
    expect(attempt(task(), { outcome: 'failed', hadSideEffects: true }).next).toBe('retry');
  });

  it("never overwrites a decided run's outcome, and refuses a closed run", () => {
    const id = task();
    const run = claimed(h.db, id);
    ok(complete(h.db, id, { kind: 'run', runId: run.runId }, { summary: 'done' }, NOW));
    expect(endRun(h.db, run.runId, { outcome: 'timed_out' }, DEFAULT_LIMITS, NOW)).toEqual({
      ok: false,
      code: 'already_decided',
      message: `run ${run.runId} already has its outcome (completed), which stands`,
    });
    expect(getRun(h.db, run.runId)?.outcome).toBe('completed');
    expect(getTask(h.db, id)?.consecutiveFailures).toBe(0);
    ok(closeRun(h.db, run.runId, NOW));
    expect(endRun(h.db, run.runId, { outcome: 'interrupted' }, DEFAULT_LIMITS, NOW)).toMatchObject({
      ok: false,
      code: 'already_closed',
    });
  });

  it("refuses a person's run", () => {
    const id = task({ assignee: { kind: 'human', name: 'lark:on_bob' } });
    const run = claimed(h.db, id);
    expect(endRun(h.db, run.runId, { outcome: 'timed_out' }, DEFAULT_LIMITS, NOW)).toEqual({
      ok: false,
      code: 'invalid',
      message: `run ${run.runId} is a person's: it has no process to end`,
    });
  });
});
```

- [ ] **Step 11.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-runs.test.ts`. Expected: all 13 FAIL with `(0 , endRun) is not a function`.

- [ ] **Step 11.3: Implement.** Replace the imports at the top of `src/db/kanban.ts`, that is everything above the header comment that begins `/**` / ` * The board's only writer`, with:

```ts
import type { Db } from './open.js';
import { txImmediate } from './open.js';
import { newRunId, newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import { resolveTaskWorkspace } from '../kanban/workspace.js';
import { REPORTED_OUTCOMES } from '../kanban/types.js';
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  BlockKind,
  CommentRow,
  Contract,
  CreatedVia,
  EndedOutcome,
  Phase,
  Refusal,
  RefusalCode,
  ReportedBlockKind,
  Reporter,
  Result,
  RetryOnCrash,
  RunKind,
  RunOutcome,
  RunRow,
  TaskRow,
} from '../kanban/types.js';
import {
  getRun,
  getTask,
  getTaskByKey,
  isFinished,
  openAgentRunIn,
  openRunOf,
  parentsOf,
  runsOf,
} from './kanban-read.js';
```

Then append to the end of `src/db/kanban.ts`:

```ts
// ---------------------------------------------------------------------------
// Runs that end without a report
// ---------------------------------------------------------------------------

/** The `kanban:` settings the breaker uses (spec §8.2). */
export interface KanbanLimits {
  /** Counted failures that block a task as gave_up, unless the task sets its own. */
  failureLimit: number;
  /** Consecutive throttled runs that block a task as transient. */
  transientLimit: number;
  /** The first cooldown after a throttled run; it doubles each time, up to an hour. */
  transientCooldownS: number;
}

export const DEFAULT_LIMITS: KanbanLimits = { failureLimit: 2, transientLimit: 10, transientCooldownS: 300 };

const MAX_COOLDOWN_S = 60 * 60;

export interface RunEnding {
  outcome: EndedOutcome;
  error?: string | null;
  lastOutput?: string | null;
  /**
   * The run made a tool call outside its role's readOnlyTools (spec §8.3). Plan
   * C2 reads the tool calls from the run's session log.
   */
  hadSideEffects?: boolean;
}

/** What happens to the task next: claimed again, claimed again after a cooldown, or blocked. */
export type NextStep = 'retry' | 'cooldown' | 'blocked';

/**
 * Record why an agent run ended without a report, and what it means for the task
 * (spec §5.1, §5.2, §8.2, §8.3). Plan C2 calls it with the classifier's outcome,
 * or with its own -- `timed_out`, `interrupted` -- having recorded it before it
 * cancels the turn.
 *
 * Only an undecided run: a decided run's outcome is never overwritten, so a
 * restart or a runtime limit arriving just after a report cannot turn a
 * completed task's run into a failure. The run stays open; closeRun() closes it
 * when its turn has ended.
 *
 * - `failed`, `crashed`, `timed_out`, `protocol_violation` are counted. At the
 *   task's failure limit it blocks as `gave_up`; below it, it is claimed again.
 * - `rate_limited` is not counted, so a long quota window cannot use up a task's
 *   retries. It holds the task in a cooldown that doubles each time, up to an
 *   hour, and blocks it as `transient` at the limit.
 * - `terminal_provider` blocks at once as `capability`: every retry would hit the
 *   same wall.
 * - `interrupted` is not counted: the task did nothing wrong.
 *
 * With `retry_on_crash: if-no-side-effects`, a run that changed things blocks as
 * `needs_input` instead of being retried, so a person looks first.
 */
export function endRun(
  db: Db,
  runId: string,
  ending: RunEnding,
  limits: KanbanLimits,
  now: number,
): Result<{ task: TaskRow; run: RunRow; next: NextStep }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.endedAt !== null) return refuse('already_closed', `run ${runId} is closed`);
    if (run.outcome !== null) {
      return refuse('already_decided', `run ${runId} already has its outcome (${run.outcome}), which stands`);
    }
    if (run.agentConfig === null) return refuse('invalid', `run ${runId} is a person's: it has no process to end`);
    const before = mustGet(d, run.taskId);
    decide(d, run, ending.outcome, { error: ending.error ?? null, lastOutput: ending.lastOutput ?? null }, now);

    const cautious = before.retryOnCrash === 'if-no-side-effects' && ending.hadSideEffects === true;
    const careful = `the run ended ${ending.outcome} after changing things; look before it is retried`;
    let next: NextStep = 'retry';
    let blockAs: { kind: Exclude<BlockKind, 'dependency'>; reason: string } | undefined;
    switch (ending.outcome) {
      case 'terminal_provider':
        blockAs = { kind: 'capability', reason: ending.error ?? 'the provider refused the credentials or the model' };
        break;
      case 'rate_limited': {
        const n = before.consecutiveTransient + 1;
        d.prepare('UPDATE kanban_tasks SET consecutive_transient = ? WHERE task_id = ?').run(n, run.taskId);
        if (n >= limits.transientLimit) {
          blockAs = { kind: 'transient', reason: `throttled ${n} times in a row` };
        } else if (cautious) {
          blockAs = { kind: 'needs_input', reason: careful };
        } else {
          const seconds = Math.min(limits.transientCooldownS * 2 ** (n - 1), MAX_COOLDOWN_S);
          d.prepare('UPDATE kanban_tasks SET cooldown_until = ? WHERE task_id = ?').run(
            now + seconds * 1000,
            run.taskId,
          );
          next = 'cooldown';
        }
        break;
      }
      case 'interrupted':
        if (cautious) blockAs = { kind: 'needs_input', reason: careful };
        break;
      case 'failed':
      case 'crashed':
      case 'timed_out':
      case 'protocol_violation': {
        const failures = before.consecutiveFailures + 1;
        d.prepare('UPDATE kanban_tasks SET consecutive_failures = ? WHERE task_id = ?').run(failures, run.taskId);
        if (failures >= (before.failureLimit ?? limits.failureLimit)) {
          blockAs = {
            kind: 'gave_up',
            reason: `failed ${failures} times; last ${ending.outcome}${ending.error ? `: ${ending.error}` : ''}`,
          };
        } else if (cautious) {
          blockAs = { kind: 'needs_input', reason: careful };
        }
        break;
      }
    }
    if (blockAs !== undefined) {
      enterBlocked(d, mustGet(d, run.taskId), blockAs.kind, blockAs.reason);
      next = 'blocked';
    }
    record(
      d,
      {
        taskId: run.taskId,
        runId,
        kind: 'run_ended',
        actor: 'gateway',
        payload: { outcome: ending.outcome, error: ending.error ?? null, next, blockKind: blockAs?.kind ?? null },
      },
      now,
    );
    return { ok: true, task: mustGet(d, run.taskId), run: mustGetRun(d, runId), next };
  });
}
```

- [ ] **Step 11.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  675 passed (675)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 11.5: Commit.**

```bash
git add src/db/kanban.ts tests/kanban-runs.test.ts
git commit -m "Record why a run ended without a report, and what the breaker does"
```

---

### Task 12: Reassigning, setting a workspace, archiving

**Files:**
- Modify: `src/db/kanban.ts`
- Create: `tests/kanban-assign.test.ts`

These leave the phase alone, except `archive`.
- **`assign` and `assignReviewer`** (Decision 6) supersede the open run whose claimant they replace. An undecided run ends `superseded`. A decided one keeps its outcome and is returned, so C2 can close it.
- **`setWorkspace`** sets a null workspace in any phase, and is refused once the workspace is fixed (spec §2.3).
- **`archive`** works from any phase but `archived`, superseding an undecided run and returning a decided one still open. An archived parent no longer holds its children back (Decision 4).
- **`noteUnassignable`** records a task nobody can be given once (spec §4.2, Decision 16).

- [ ] **Step 12.1: Write the failing tests.** Create `tests/kanban-assign.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addComment,
  archive,
  assign,
  assignReviewer,
  closeRun,
  complete,
  noteUnassignable,
  requestReview,
  setWorkspace,
} from '../src/db/kanban.js';
import { eventsOf, getRun, taskView } from '../src/db/kanban-read.js';
import type { Reporter, RunRow } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

const OTHER = { kind: 'role', name: 'other-role' } as const;
const REVIEWER = { kind: 'role', name: 'reviewer' } as const;
const asRun = (run: RunRow): Reporter => ({ kind: 'run', runId: run.runId });

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

describe('assign', () => {
  it('supersedes an undecided work run; the next claim goes to the new assignee', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(assign(h.db, task.taskId, OTHER, ALICE, NOW)).toMatchObject({
      ok: true,
      task: { phase: 'open', assignee: OTHER },
      run: { runId: run.runId, outcome: 'superseded', endedAt: null },
    });
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'assignee_set',
      runId: run.runId,
      payload: { assignee: 'other-role' },
    });
    expect(complete(h.db, task.taskId, asRun(run), { summary: 'x' }, NOW)).toMatchObject({ code: 'run_superseded' });
    ok(closeRun(h.db, run.runId, NOW));
    expect(claimed(h.db, task.taskId)).toMatchObject({ attempt: 2, assignee: OTHER });
  });

  it('leaves a work run that has reported with its outcome, and returns it to be closed', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const run = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(run), { summary: 'v1' }, NOW));
    expect(assign(h.db, task.taskId, OTHER, ALICE, NOW)).toMatchObject({
      ok: true,
      task: { phase: 'review', assignee: OTHER },
      run: { runId: run.runId, outcome: 'review_requested', endedAt: null },
    });
  });

  it('changes nothing when the assignee is the same', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const before = eventsOf(h.db, task.taskId).length;
    expect(assign(h.db, task.taskId, { kind: 'role', name: 'implementer' }, ALICE, NOW)).toMatchObject({
      ok: true,
      run: undefined,
    });
    expect(eventsOf(h.db, task.taskId)).toHaveLength(before);
    expect(getRun(h.db, run.runId)?.outcome).toBeNull();
  });

  it('replaces the reviewer, superseding an undecided review run, but not a work run', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const work = claimed(h.db, task.taskId);
    expect(assignReviewer(h.db, task.taskId, OTHER, ALICE, NOW)).toMatchObject({ ok: true, run: undefined });
    ok(requestReview(h.db, task.taskId, asRun(work), { summary: 'v1' }, NOW));
    ok(closeRun(h.db, work.runId, NOW));
    const review = claimed(h.db, task.taskId);
    expect(assignReviewer(h.db, task.taskId, REVIEWER, ALICE, NOW)).toMatchObject({
      ok: true,
      task: { phase: 'review', reviewer: REVIEWER },
      run: { runId: review.runId, outcome: 'superseded' },
    });
    ok(closeRun(h.db, review.runId, NOW));
    expect(claimed(h.db, task.taskId).assignee).toEqual(REVIEWER);
  });

  it('refuses to reassign a done or archived task', () => {
    const done = newTask(h.db);
    ok(complete(h.db, done.taskId, { kind: 'person', principal: ALICE }, { summary: 'x' }, NOW));
    expect(assign(h.db, done.taskId, OTHER, ALICE, NOW)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${done.taskId} is done; it cannot be reassigned`,
    });
    const archived = newTask(h.db);
    ok(archive(h.db, archived.taskId, ALICE, NOW));
    expect(assignReviewer(h.db, archived.taskId, OTHER, ALICE, NOW)).toMatchObject({ code: 'illegal_transition' });
  });
});

describe('setWorkspace', () => {
  it('sets a null workspace, and refuses once one is fixed', () => {
    const task = newTask(h.db);
    expect(setWorkspace(h.db, task.taskId, 'web', ALICE, NOW)).toMatchObject({ ok: true, task: { workspace: 'web' } });
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({ kind: 'workspace_set', payload: { workspace: 'web' } });
    expect(setWorkspace(h.db, task.taskId, 'api', ALICE, NOW)).toEqual({
      ok: false,
      code: 'workspace_fixed',
      message: `task ${task.taskId} works in web; a fixed workspace does not change`,
    });
    const claimedTask = newTask(h.db);
    claimed(h.db, claimedTask.taskId);
    expect(setWorkspace(h.db, claimedTask.taskId, 'api', ALICE, NOW)).toMatchObject({ code: 'workspace_fixed' });
  });
});

describe('archive', () => {
  it('archives a task, superseding an undecided run, and frees its children', () => {
    const task = newTask(h.db);
    const child = newTask(h.db, { parents: [task.taskId] });
    const run = claimed(h.db, task.taskId);
    expect(archive(h.db, task.taskId, ALICE, NOW + 1)).toMatchObject({
      ok: true,
      task: { phase: 'archived', closedAt: NOW + 1 },
      run: { runId: run.runId, outcome: 'superseded' },
    });
    expect(taskView(h.db, child.taskId)?.status).toBe('ready');
    expect(archive(h.db, task.taskId, ALICE, NOW)).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${task.taskId} is already archived`,
    });
  });

  it('archives a task whose run has reported, keeping its outcome, and returns the run to be closed', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
    const run = claimed(h.db, task.taskId);
    ok(requestReview(h.db, task.taskId, asRun(run), { summary: 'v1' }, NOW));
    expect(archive(h.db, task.taskId, ALICE, NOW)).toMatchObject({
      ok: true,
      task: { phase: 'archived' },
      run: { runId: run.runId, outcome: 'review_requested', endedAt: null },
    });
  });

  it('keeps the time a done task was done', () => {
    const task = newTask(h.db);
    ok(complete(h.db, task.taskId, { kind: 'person', principal: ALICE }, { summary: 'x' }, NOW));
    expect(ok(archive(h.db, task.taskId, ALICE, NOW + 50)).task).toMatchObject({ phase: 'archived', closedAt: NOW });
  });
});

describe('noteUnassignable', () => {
  it('writes once, until something else happens to the task', () => {
    const task = newTask(h.db);
    expect(noteUnassignable(h.db, task.taskId, 'role gone is not configured', NOW)).toEqual({
      ok: true,
      written: true,
    });
    expect(noteUnassignable(h.db, task.taskId, 'role gone is not configured', NOW)).toEqual({
      ok: true,
      written: false,
    });
    ok(addComment(h.db, task.taskId, ALICE, 'any news?', NOW));
    expect(noteUnassignable(h.db, task.taskId, 'role gone is not configured', NOW)).toEqual({
      ok: true,
      written: true,
    });
    expect(eventsOf(h.db, task.taskId).filter((e) => e.kind === 'skipped_unassignable')).toHaveLength(2);
  });
});
```

- [ ] **Step 12.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-assign.test.ts`. Expected: all 10 FAIL, for example with `(0 , assign) is not a function`.

- [ ] **Step 12.3: Implement.** Append to the end of `src/db/kanban.ts`. It needs no new imports.

```ts
// ---------------------------------------------------------------------------
// Assigning, workspaces, archiving
// ---------------------------------------------------------------------------

/**
 * The open run a change takes the task away from: an undecided one ends
 * `superseded`; a decided one keeps its outcome (spec §3.3). Either way the run
 * is returned so the caller can cancel an agent's turn and close it.
 */
function supersede(d: Db, open: RunRow | undefined, now: number): RunRow | undefined {
  if (open === undefined) return undefined;
  if (open.outcome === null) decide(d, open, 'superseded', {}, now);
  return mustGetRun(d, open.runId);
}

function reassign(
  db: Db,
  taskId: string,
  role: 'assignee' | 'reviewer',
  who: Assignee,
  by: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.phase === 'done' || task.phase === 'archived') {
      return refuse('illegal_transition', `task ${taskId} is ${task.phase}; it cannot be reassigned`);
    }
    const current = task[role];
    if (current !== null && current.kind === who.kind && current.name === who.name) {
      return { ok: true, task, run: undefined };
    }
    const open = openRunOf(d, taskId);
    const run = open?.kind === (role === 'assignee' ? 'work' : 'review') ? supersede(d, open, now) : undefined;
    d.prepare(`UPDATE kanban_tasks SET ${role}_kind = ?, ${role} = ? WHERE task_id = ?`).run(
      who.kind,
      who.name,
      taskId,
    );
    record(
      d,
      { taskId, runId: run?.runId ?? null, kind: `${role}_set`, actor: by, payload: { [role]: who.name } },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), run };
  });
}

/**
 * `/kanban assign` (spec §5.1): the phase is unchanged, and the next work claim
 * goes to the new assignee. An open work run is superseded.
 */
export function assign(
  db: Db,
  taskId: string,
  assignee: Assignee,
  by: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return reassign(db, taskId, 'assignee', assignee, by, now);
}

/** The same, for the reviewer: the next review claim goes to them. An open review run is superseded. */
export function assignReviewer(
  db: Db,
  taskId: string,
  reviewer: Assignee,
  by: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return reassign(db, taskId, 'reviewer', reviewer, by, now);
}

/**
 * `/kanban workspace` (spec §2.3): set a task's workspace while it is null, in any
 * phase. Refused once fixed, not merely once claimed, so a null workspace -- a
 * person's task whose parents disagreed -- can always be set.
 */
export function setWorkspace(
  db: Db,
  taskId: string,
  workspace: string,
  by: string,
  now: number,
): Result<{ task: TaskRow }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.workspace !== null) {
      return refuse('workspace_fixed', `task ${taskId} works in ${task.workspace}; a fixed workspace does not change`);
    }
    d.prepare('UPDATE kanban_tasks SET workspace = ? WHERE task_id = ?').run(workspace, taskId);
    record(d, { taskId, kind: 'workspace_set', actor: by, payload: { workspace } }, now);
    return { ok: true, task: mustGet(d, taskId) };
  });
}

/**
 * Archive a task from any phase but archived (spec §5.1). An undecided run ends
 * `superseded`. A done task keeps the time it was done. An archived parent no
 * longer holds its children back.
 */
export function archive(
  db: Db,
  taskId: string,
  by: string,
  now: number,
): Result<{ task: TaskRow; run: RunRow | undefined }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.phase === 'archived') return refuse('illegal_transition', `task ${taskId} is already archived`);
    const run = supersede(d, openRunOf(d, taskId), now);
    d.prepare(
      `UPDATE kanban_tasks SET phase = 'archived', blocked_from = NULL, closed_at = coalesce(closed_at, ?)
        WHERE task_id = ?`,
    ).run(now, taskId);
    record(d, { taskId, runId: run?.runId ?? null, kind: 'archived', actor: by, payload: { from: task.phase } }, now);
    return { ok: true, task: mustGet(d, taskId), run };
  });
}

/**
 * A ready task nobody can be given (spec §4.2) is never dropped and never sent to
 * a fallback: it is recorded, once -- until something else happens to the task,
 * so a dispatcher pass every minute does not fill its log.
 */
export function noteUnassignable(db: Db, taskId: string, reason: string, now: number): Result<{ written: boolean }> {
  return tx(db, (d) => {
    if (getTask(d, taskId) === undefined) return refuse('not_found', `no task ${taskId}`);
    const last = d
      .prepare<[string], { kind: string }>('SELECT kind FROM kanban_events WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId);
    if (last?.kind === 'skipped_unassignable') return { ok: true, written: false };
    record(d, { taskId, kind: 'skipped_unassignable', actor: 'gateway', payload: { reason } }, now);
    return { ok: true, written: true };
  });
}
```

- [ ] **Step 12.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  685 passed (685)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 12.5: Commit.**

```bash
git add src/db/kanban.ts tests/kanban-assign.test.ts
git commit -m "Reassign, set a workspace, archive, and note an unassignable task once"
```

---

### Task 13: The service: who may be given work, and claims

**Files:**
- Create: `src/kanban/service.ts`, `tests/kanban-service.test.ts`

`KanbanService` is what plans C2, C3 and D call. It is built from the team's roles and the configured workspace names, and checks what the rows cannot:
- **Names.** A named role or workspace must be configured. An unknown one is refused at creation (spec §9.1).
- **Who may be given work** (spec §4.2, §12). A role whose agent is supervised is refused, and so is a person, until plan D passes `people` and `supervisedRoles` (Decision 18).
- **Input shape.** Input arrives from chat or from an agent's JSON, so its shape is checked here: the title, the contract's five text fields, the limits.

A claim resolves the role as it is now:
- a role removed since the task was created makes the task unassignable;
- `role.md` is read again, so an edit takes effect from the next run (spec §2.1), hashed into the run, and returned for C2's prompt (Decision 17);
- a skill file that cannot be read makes the role unassignable too.

Anything that does not resolve is noted once, as `skipped_unassignable`, and never sent to a fallback. The run records the role's agent as driver, command, arguments and the *names* of its environment variables, never their values (spec §3.3).

This task also gives the service the run lifecycle C2 needs: `attachSession`, `endRun` with the service's limits, and `closeRun`.

- [ ] **Step 13.1: Write the failing tests.** Create `tests/kanban-service.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf } from '../src/db/kanban-read.js';
import { KanbanService, type CreateRequest, type KanbanServiceDeps } from '../src/kanban/service.js';
import type { AgentConfig } from '../src/config.js';
import type { Role } from '../src/roles.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

let h: TestDb;
let dir: string;
let clock: ManualClock;

beforeEach(() => {
  h = testDb();
  dir = mkdtempSync(join(tmpdir(), 'mt-kanban-'));
  clock = new ManualClock();
});

afterEach(() => {
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

function role(name: string, extra: Partial<Role> = {}, agent: Partial<AgentConfig> = {}): Role {
  return {
    name,
    source: 'directory',
    dir: undefined,
    description: undefined,
    workspace: undefined,
    agent: {
      driver: 'structured-cli',
      command: 'bytesec',
      args: ['run', '-m', 'model-a'],
      env: { API_KEY: 'sk-role-12345678' },
      unsupervised: true,
      passEnv: [],
      readOnlyTools: [],
      maskExempt: [],
      ...agent,
    },
    roleMdPath: undefined,
    skills: [],
    secretValues: ['sk-role-12345678'],
    ...extra,
  };
}

const ROLES: ReadonlyMap<string, Role> = new Map([
  ['implementer', role('implementer')],
  ['reviewer', role('reviewer')],
  ['docs-writer', role('docs-writer', { workspace: 'docs' })],
  ['supervised', role('supervised', {}, { driver: 'acp', unsupervised: false })],
]);

function service(extra: Partial<KanbanServiceDeps> = {}): KanbanService {
  return new KanbanService({ db: h.db, roles: ROLES, workspaces: WORKSPACES, clock, ...extra });
}

function request(extra: Partial<CreateRequest> = {}): CreateRequest {
  return { title: 'Write the parser', assignee: 'implementer', createdBy: ALICE, createdVia: VIA, ...extra };
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

describe('KanbanService: who may be given work', () => {
  it('creates a task for a configured role, in a configured workspace', () => {
    const r = service().create(request({ workspace: 'web', reviewer: 'reviewer', contract: { outcome: 'it parses' } }));
    expect(r).toMatchObject({
      ok: true,
      existing: false,
      task: {
        assignee: { kind: 'role', name: 'implementer' },
        reviewer: { kind: 'role', name: 'reviewer' },
        workspace: 'web',
        contract: { outcome: 'it parses' },
        createdAt: clock.now(),
      },
    });
  });

  it('refuses an unknown role or workspace while the person is still looking', () => {
    const s = service();
    expect(s.create(request({ assignee: 'implementr' }))).toEqual({
      ok: false,
      code: 'unknown_role',
      message: 'role implementr is not configured',
    });
    expect(s.create(request({ reviewer: 'nobody' }))).toMatchObject({ ok: false, code: 'unknown_role' });
    expect(s.create(request({ workspace: 'wbe' }))).toEqual({
      ok: false,
      code: 'unknown_workspace',
      message: 'workspace wbe is not configured',
    });
  });

  it('refuses a role whose agent is supervised, until approvals can reach someone', () => {
    expect(service().create(request({ assignee: 'supervised' }))).toEqual({
      ok: false,
      code: 'supervised_role',
      message:
        "role supervised's agent is supervised; its approval requests would reach nobody until the board is in Lark",
    });
    expect(service({ supervisedRoles: true }).create(request({ assignee: 'supervised' })).ok).toBe(true);
  });

  it('refuses people as assignees and reviewers until they can be reached, then only with talk tier', () => {
    expect(service().create(request({ assignee: 'lark:on_bob' }))).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message:
        'lark:on_bob cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark',
    });
    expect(service().create(request({ reviewer: 'lark:on_bob' }))).toMatchObject({ code: 'person_not_assignable' });
    const withPeople = service({ people: { canTalk: (p) => p === 'lark:on_bob' } });
    expect(withPeople.create(request({ assignee: 'lark:on_bob' }))).toMatchObject({
      ok: true,
      task: { assignee: { kind: 'human', name: 'lark:on_bob' } },
    });
    expect(withPeople.create(request({ assignee: 'lark:on_eve' }))).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: 'lark:on_eve does not have talk tier, so cannot be given work',
    });
    expect(withPeople.create(request({ assignee: 'slack:U1' }))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses malformed input: no title, an unknown contract field, a limit below 1', () => {
    const s = service();
    expect(s.create(request({ title: '  ' }))).toEqual({ ok: false, code: 'invalid', message: 'a task needs a title' });
    expect(s.create(request({ contract: { done_when: 'x' } as never }))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'unknown contract field done_when',
    });
    expect(s.create(request({ contract: { outcome: 3 } as never }))).toMatchObject({ code: 'invalid' });
    expect(s.create(request({ failureLimit: 0 }))).toMatchObject({ code: 'invalid' });
    expect(s.create(request({ retryOnCrash: 'never' as never }))).toMatchObject({ code: 'invalid' });
  });
});

describe('KanbanService: claims and the runs they open', () => {
  it("records the role's agent without its environment values, and the role.md it is given", () => {
    const md = join(dir, 'role.md');
    writeFileSync(md, 'You change code in this repository.\n');
    const s = service({ roles: new Map([['implementer', role('implementer', { roleMdPath: md })]]) });
    const task = ok(s.create(request())).task;
    const r = ok(s.claim(task.taskId, { tokenHash: 'hash-of-token' }));
    expect(r.run).toMatchObject({
      agentConfig: {
        driver: 'structured-cli',
        command: 'bytesec',
        args: ['run', '-m', 'model-a'],
        unsupervised: true,
        envNames: ['API_KEY'],
      },
      roleMdHash: createHash('sha256').update('You change code in this repository.\n').digest('hex'),
      tokenHash: 'hash-of-token',
      startedAt: clock.now(),
    });
    expect(r.roleMd).toBe('You change code in this repository.\n');
    expect(JSON.stringify(r.run)).not.toContain('sk-role-12345678');
  });

  it("works in the role's own workspace", () => {
    const s = service();
    const task = ok(s.create(request({ assignee: 'docs-writer' }))).task;
    expect(ok(s.claim(task.taskId)).run.workspace).toBe('docs');
  });

  it('leaves a task unassignable, noted once, when its role is gone or its files cannot be read', () => {
    const task = ok(service().create(request())).task;
    const without = service({ roles: new Map() });
    expect(without.claim(task.taskId)).toEqual({
      ok: false,
      code: 'unassignable',
      message: 'role implementer is not configured',
    });
    expect(without.claim(task.taskId)).toMatchObject({ code: 'unassignable' });
    expect(eventsOf(h.db, task.taskId).filter((e) => e.kind === 'skipped_unassignable')).toHaveLength(1);

    const md = join(dir, 'role.md');
    writeFileSync(md, 'instructions');
    unlinkSync(md);
    const unreadable = service({ roles: new Map([['implementer', role('implementer', { roleMdPath: md })]]) });
    expect(unreadable.claim(task.taskId)).toMatchObject({
      ok: false,
      code: 'unassignable',
      message: expect.stringMatching(/^role implementer's files cannot be read: ENOENT/),
    });
  });

  it("claims a person's task once people can be reached, with no agent", () => {
    const s = service({ people: { canTalk: () => true } });
    const task = ok(s.create(request({ assignee: 'lark:on_bob' }))).task;
    expect(ok(s.claim(task.taskId))).toMatchObject({ run: { agentConfig: null, roleMdHash: null }, roleMd: undefined });
  });

  it('ends and closes runs with its limits', () => {
    const s = service({ limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
    const task = ok(s.create(request())).task;
    const run = ok(s.claim(task.taskId)).run;
    expect(s.endRun(run.runId, { outcome: 'failed', error: 'exit 1' })).toMatchObject({
      ok: true,
      next: 'blocked',
      task: { blockKind: 'gave_up' },
    });
    expect(s.closeRun(run.runId)).toMatchObject({ ok: true, run: { endedAt: clock.now() } });
  });
});
```

- [ ] **Step 13.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-service.test.ts`. Expected: FAIL, because `../src/kanban/service.js` cannot be found.

- [ ] **Step 13.3: Implement.** Create `src/kanban/service.ts`:

```ts
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import type { Db } from '../db/open.js';
import * as board from '../db/kanban.js';
import { getTask } from '../db/kanban-read.js';
import type { Role } from '../roles.js';
import { systemClock, type Clock } from '../time.js';
import {
  CONTRACT_FIELDS,
  type AgentSnapshot,
  type Assignee,
  type Contract,
  type CreatedVia,
  type Result,
  type RetryOnCrash,
  type RunRow,
  type TaskRow,
} from './types.js';

/**
 * The board's service API (spec §4–§5): what plans C2, C3 and D call.
 *
 * It checks what the rows cannot: that a named role or workspace is configured,
 * that the board may hand work to it, and that input -- from chat, or from an
 * agent's JSON -- has the right shape. db/kanban.ts checks the rest, and is the
 * only writer.
 *
 * Until plan D nothing can deliver a card to a person, so people cannot be
 * assigned or named as reviewers, and a role whose agent is supervised is
 * refused: its approval cards would have nowhere to go (spec §12). Plan D passes
 * `people` and `supervisedRoles` to turn them on. Who may act -- tiers, the
 * named assignee -- is the caller's: the worker CLI's token (plan C3), chat (D).
 */

/** How the board reaches people. Plan D's; absent, people cannot be given work. */
export interface People {
  /** Being assigned is permission to report, so it needs talk tier (spec §4.2). */
  canTalk(principal: string): boolean;
}

export interface KanbanServiceDeps {
  db: Db;
  roles: ReadonlyMap<string, Role>;
  /** The configured workspace names. */
  workspaces: ReadonlySet<string>;
  clock?: Clock;
  limits?: board.KanbanLimits;
  people?: People;
  /** Accept roles whose agent asks for approval. Plan D's, once approvals reach a subscriber. */
  supervisedRoles?: boolean;
}

/** A task to create, as a person or a worker asks for it. Names are not yet checked. */
export interface CreateRequest {
  title: string;
  body?: string;
  contract?: Contract;
  /** A role name, or a person's principal `lark:<union_id>`. */
  assignee?: string;
  reviewer?: string;
  workspace?: string;
  parents?: readonly string[];
  priority?: number;
  idempotencyKey?: string;
  failureLimit?: number;
  retryOnCrash?: RetryOnCrash;
  maxRuntimeS?: number;
  createdBy: string;
  createdVia: CreatedVia;
}

/** A claim, with what was read for it. */
export interface Claimed {
  run: RunRow;
  task: TaskRow;
  /** The role.md whose hash the run records, for plan C2's prompt; undefined without one. */
  roleMd: string | undefined;
}

/** A person's principal, as channels identify them. */
const PERSON = /^lark:[A-Za-z0-9_-]+$/;

/** What a run records of its agent (spec §3.3): never an environment value. */
export function agentSnapshot(role: Role): AgentSnapshot {
  return {
    driver: role.agent.driver,
    command: role.agent.command,
    args: [...role.agent.args],
    unsupervised: role.agent.unsupervised,
    envNames: Object.keys(role.agent.env).sort(),
  };
}

function isWhole(n: number | undefined, min: number): boolean {
  return n === undefined || (Number.isInteger(n) && n >= min);
}

export class KanbanService {
  readonly #db: Db;
  readonly #roles: ReadonlyMap<string, Role>;
  readonly #workspaces: ReadonlySet<string>;
  readonly #clock: Clock;
  readonly #limits: board.KanbanLimits;
  readonly #people: People | undefined;
  readonly #supervisedRoles: boolean;

  constructor(deps: KanbanServiceDeps) {
    this.#db = deps.db;
    this.#roles = deps.roles;
    this.#workspaces = deps.workspaces;
    this.#clock = deps.clock ?? systemClock;
    this.#limits = deps.limits ?? board.DEFAULT_LIMITS;
    this.#people = deps.people;
    this.#supervisedRoles = deps.supervisedRoles ?? false;
  }

  /**
   * Create a task. Unknown names are refused here, at creation (spec §9.1): a typo
   * should fail while the person is still looking, not strand the task later.
   */
  create(req: CreateRequest): Result<{ task: TaskRow; existing: boolean }> {
    if (req.title.trim() === '') return board.refuse('invalid', 'a task needs a title');
    const contract = this.#contract(req.contract);
    if (!contract.ok) return contract;
    if (req.workspace !== undefined && !this.#workspaces.has(req.workspace)) {
      return board.refuse('unknown_workspace', `workspace ${req.workspace} is not configured`);
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
    return board.createTask(
      this.#db,
      {
        title: req.title,
        ...(req.body === undefined ? {} : { body: req.body }),
        contract: contract.contract,
        assignee: assignee?.assignee ?? null,
        reviewer: reviewer?.assignee ?? null,
        workspace: req.workspace ?? null,
        ...(req.parents === undefined ? {} : { parents: req.parents }),
        ...(req.priority === undefined ? {} : { priority: req.priority }),
        idempotencyKey: req.idempotencyKey ?? null,
        failureLimit: req.failureLimit ?? null,
        ...(req.retryOnCrash === undefined ? {} : { retryOnCrash: req.retryOnCrash }),
        maxRuntimeS: req.maxRuntimeS ?? null,
        createdBy: req.createdBy,
        createdVia: req.createdVia,
      },
      this.#clock.now(),
    );
  }

  assign(taskId: string, assignee: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const who = this.#assignable(assignee);
    if (!who.ok) return who;
    return board.assign(this.#db, taskId, who.assignee, by, this.#clock.now());
  }

  assignReviewer(taskId: string, reviewer: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const who = this.#assignable(reviewer);
    if (!who.ok) return who;
    return board.assignReviewer(this.#db, taskId, who.assignee, by, this.#clock.now());
  }

  /**
   * Claim the task's next run (spec §6.2 step 3), for whoever it is for now: its
   * assignee in `open`, its reviewer in `review`. Plan C2's dispatcher calls it.
   *
   * The role is resolved at the claim: its directory may have been removed since
   * the task was created, and its role.md is read again now, so an edit takes
   * effect from the next run (spec §2.1). Anything that does not resolve leaves
   * the task unassignable -- written once, never sent to a fallback (spec §4.2).
   */
  claim(taskId: string, opts: { tokenHash?: string } = {}): Result<Claimed> {
    const now = this.#clock.now();
    const task = getTask(this.#db, taskId);
    if (task === undefined) return board.refuse('not_found', `no task ${taskId}`);
    if (task.phase !== 'open' && task.phase !== 'review') {
      return board.refuse('illegal_transition', `task ${taskId} is ${task.phase}, so it cannot be claimed`);
    }
    const resolved = this.#claimant(task);
    const r = resolved.ok
      ? board.claim(
          this.#db,
          { taskId, claimant: resolved.claimant, tokenHash: opts.tokenHash ?? null, workspaces: this.#workspaces },
          now,
        )
      : resolved;
    if (!r.ok) {
      if (r.code === 'unassignable') board.noteUnassignable(this.#db, taskId, r.message, now);
      return r;
    }
    return { ok: true, run: r.run, task: r.task, roleMd: resolved.ok ? resolved.roleMd : undefined };
  }

  /** Record the run's gateway session, once plan C2 has created it. */
  attachSession(runId: string, sessionId: string): Result<{ run: RunRow }> {
    return board.attachSession(this.#db, runId, sessionId, this.#clock.now());
  }

  /**
   * An agent run ended without a report (spec §5.2, §8): the classifier's
   * outcome, or the dispatcher's own, recorded before it cancels the turn.
   */
  endRun(runId: string, ending: board.RunEnding): Result<{ task: TaskRow; run: RunRow; next: board.NextStep }> {
    return board.endRun(this.#db, runId, ending, this.#limits, this.#clock.now());
  }

  /** The run's last turn has ended: it is closed, and its workspace free. */
  closeRun(runId: string): Result<{ run: RunRow }> {
    return board.closeRun(this.#db, runId, this.#clock.now());
  }

  /** Who the next claim is for, resolved against the team as it is now. */
  #claimant(task: TaskRow): Result<{ claimant: board.Claimant; roleMd: string | undefined }> {
    const who = task.phase === 'review' ? task.reviewer : task.assignee;
    if (who === null) {
      return board.refuse(
        'unassignable',
        `task ${task.taskId} has no ${task.phase === 'review' ? 'reviewer' : 'assignee'}`,
      );
    }
    if (who.kind === 'human') {
      if (this.#people === undefined) {
        return board.refuse('unassignable', `task ${task.taskId} is for ${who.name}, and people cannot take work yet`);
      }
      return {
        ok: true,
        claimant: { assignee: who, agentConfig: null, roleWorkspace: undefined, roleMdHash: null },
        roleMd: undefined,
      };
    }
    const role = this.#roles.get(who.name);
    if (role === undefined) return board.refuse('unassignable', `role ${who.name} is not configured`);
    if (!role.agent.unsupervised && !this.#supervisedRoles) {
      return board.refuse(
        'unassignable',
        `role ${who.name}'s agent is supervised, and its approvals could reach nobody`,
      );
    }
    let roleMd: string | undefined;
    try {
      roleMd = role.roleMdPath === undefined ? undefined : readFileSync(role.roleMdPath, 'utf8');
      for (const skill of role.skills) accessSync(skill.path, constants.R_OK);
    } catch (err) {
      // A file that existed at startup and is gone now: not a run without its instructions.
      return board.refuse('unassignable', `role ${who.name}'s files cannot be read: ${(err as Error).message}`);
    }
    return {
      ok: true,
      claimant: {
        assignee: who,
        agentConfig: agentSnapshot(role),
        roleWorkspace: role.workspace,
        roleMdHash: roleMd === undefined ? null : createHash('sha256').update(roleMd, 'utf8').digest('hex'),
      },
      roleMd,
    };
  }

  /**
   * A name the board may hand work to: a configured role whose agent runs
   * unsupervised, or a person with talk tier once people can be reached.
   */
  #assignable(name: string): Result<{ assignee: Assignee }> {
    if (name.includes(':')) {
      if (!PERSON.test(name)) {
        return board.refuse('invalid', `${JSON.stringify(name)} is neither a role name nor a person (lark:<union_id>)`);
      }
      if (this.#people === undefined) {
        return board.refuse(
          'person_not_assignable',
          `${name} cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark`,
        );
      }
      if (!this.#people.canTalk(name)) {
        // Being assigned is permission to report on the task.
        return board.refuse('person_not_assignable', `${name} does not have talk tier, so cannot be given work`);
      }
      return { ok: true, assignee: { kind: 'human', name } };
    }
    const role = this.#roles.get(name);
    if (role === undefined) return board.refuse('unknown_role', `role ${name} is not configured`);
    if (!role.agent.unsupervised && !this.#supervisedRoles) {
      return board.refuse(
        'supervised_role',
        `role ${name}'s agent is supervised; its approval requests would reach nobody until the board is in Lark`,
      );
    }
    return { ok: true, assignee: { kind: 'role', name } };
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
      if (field === undefined) return board.refuse('invalid', `unknown contract field ${key}`);
      if (typeof value !== 'string') return board.refuse('invalid', `contract field ${key} must be text`);
      contract[field] = value;
    }
    return { ok: true, contract };
  }
}
```

- [ ] **Step 13.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  695 passed (695)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 13.5: Commit.**

```bash
git add src/kanban/service.ts tests/kanban-service.test.ts
git commit -m "Add the kanban service: who may be given work, and claims"
```

---

### Task 14: The rest of the service API

**Files:**
- Modify: `src/kanban/service.ts`, `tests/kanban-service.test.ts`

These are the remaining operations C3 and D call: link, set a workspace, comment, the three reports, block, unblock, stop, archive, show, and follow-ups. Each checks its input, then calls `db/kanban.ts`. Two of them do more than pass through:
- **`requestReview`** checks a reviewer named in the report like any assignee. Until plan D that refuses a person, as spec §12 says `mt kanban review` must.
- **`followUp`** is how new work on a done task is created (spec §4.4). A done task is never reopened, because its summary is what its children were given as their handoff.

`block` takes its kind as text and `parents` for a dependency block, the shape of C3's `{kind, reason, parents}`.

- [ ] **Step 14.1: Write the failing tests.** In `tests/kanban-service.test.ts`:
  - directly after `import { eventsOf } from '../src/db/kanban-read.js';`, add:

```ts
import { createSession } from '../src/db/sessions.js';
```

  - append to the end of the file:

```ts
describe('KanbanService: the rest of the board', () => {
  it('runs a task from claim to done, and shows it', () => {
    const s = service();
    const task = ok(s.create(request())).task;
    const run = ok(s.claim(task.taskId)).run;
    createSession(
      h.db,
      { id: 's_run', agentId: 'implementer', workspaceId: 'default', ownerPrincipal: ALICE },
      clock.now(),
    );
    ok(s.attachSession(run.runId, 's_run'));
    ok(s.comment(task.taskId, 'remember the empty file', ALICE));
    clock.advance(60_000);
    ok(s.complete(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'parser written' }));
    ok(s.closeRun(run.runId));
    expect(ok(s.show(task.taskId)).view).toMatchObject({
      status: 'done',
      task: { phase: 'done', closedAt: clock.now() },
      runs: [
        { runId: run.runId, sessionId: 's_run', outcome: 'completed', summary: 'parser written', endedAt: clock.now() },
      ],
      comments: [{ author: ALICE, body: 'remember the empty file' }],
    });
    expect(s.show('k_missing')).toEqual({ ok: false, code: 'not_found', message: 'no task k_missing' });
  });

  it('checks a reviewer named in a review report like any assignee', () => {
    const s = service();
    const task = ok(s.create(request())).task;
    const by = { kind: 'run', runId: ok(s.claim(task.taskId)).run.runId } as const;
    expect(s.requestReview(task.taskId, by, { summary: 'v1', reviewer: 'lark:on_bob' })).toMatchObject({
      ok: false,
      code: 'person_not_assignable',
    });
    expect(s.requestReview(task.taskId, by, { summary: 'v1', reviewer: 'ghost' })).toMatchObject({
      ok: false,
      code: 'unknown_role',
    });
    expect(s.requestReview(task.taskId, by, { summary: 'v1', reviewer: 'reviewer' })).toMatchObject({
      ok: true,
      task: { phase: 'review', reviewer: { kind: 'role', name: 'reviewer' } },
    });
  });

  it('reassigns only to a name the board may give work to, and sets only a configured workspace', () => {
    const s = service();
    const task = ok(s.create(request())).task;
    expect(s.assign(task.taskId, 'supervised', ALICE)).toMatchObject({ ok: false, code: 'supervised_role' });
    expect(s.assignReviewer(task.taskId, 'lark:on_bob', ALICE)).toMatchObject({
      ok: false,
      code: 'person_not_assignable',
    });
    expect(s.assign(task.taskId, 'docs-writer', ALICE)).toMatchObject({
      ok: true,
      task: { assignee: { kind: 'role', name: 'docs-writer' } },
    });
    expect(s.setWorkspace(task.taskId, 'nowhere', ALICE)).toEqual({
      ok: false,
      code: 'unknown_workspace',
      message: 'workspace nowhere is not configured',
    });
    expect(s.setWorkspace(task.taskId, 'web', ALICE)).toMatchObject({ ok: true, task: { workspace: 'web' } });
  });

  it('refuses an empty comment, reason or change request, and a block kind nobody may report', () => {
    const s = service();
    const task = ok(s.create(request({ reviewer: 'reviewer' }))).task;
    const by = { kind: 'run', runId: ok(s.claim(task.taskId)).run.runId } as const;
    expect(s.comment(task.taskId, '  ', ALICE)).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a comment needs text',
    });
    expect(s.block(task.taskId, by, { kind: 'gave_up', reason: 'x' })).toEqual({
      ok: false,
      code: 'invalid',
      message: "gave_up is set by the board's breaker, never reported",
    });
    expect(s.block(task.taskId, by, { kind: 'bored', reason: 'x' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'unknown block kind bored (one of dependency, needs_input, capability, transient)',
    });
    expect(s.block(task.taskId, by, { kind: 'needs_input', reason: '' })).toMatchObject({ code: 'invalid' });
    expect(s.requestChanges(task.taskId, by, ' ')).toMatchObject({ code: 'invalid' });
  });

  it('blocks, unblocks, stops and archives', () => {
    const s = service();
    const task = ok(s.create(request())).task;
    const first = ok(s.claim(task.taskId)).run;
    expect(
      s.block(task.taskId, { kind: 'run', runId: first.runId }, { kind: 'needs_input', reason: 'which db?' }),
    ).toMatchObject({
      ok: true,
      task: { phase: 'blocked' },
    });
    ok(s.closeRun(first.runId));
    expect(s.unblock(task.taskId, ALICE, 'postgres')).toMatchObject({ ok: true, task: { phase: 'open' } });
    const second = ok(s.claim(task.taskId)).run;
    expect(s.stop(task.taskId, ALICE)).toMatchObject({ ok: true, run: { runId: second.runId, outcome: 'cancelled' } });
    ok(s.closeRun(second.runId));
    expect(s.archive(task.taskId, ALICE)).toMatchObject({ ok: true, task: { phase: 'archived' } });
  });

  it('creates a follow-up for a done task instead of reopening it', () => {
    const s = service();
    const task = ok(s.create(request())).task;
    expect(s.followUp(task.taskId, request({ title: 'handle CRLF' }))).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${task.taskId} is open; only a done task gets follow-ups`,
    });
    ok(s.complete(task.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' }));
    const follow = ok(s.followUp(task.taskId, request({ title: 'handle CRLF', body: 'CI log: ...' }))).task;
    expect(ok(s.show(follow.taskId)).view).toMatchObject({
      status: 'ready',
      parents: [{ taskId: task.taskId, phase: 'done' }],
      task: { body: 'CI log: ...' },
    });
    expect(ok(s.show(task.taskId)).view.task.phase).toBe('done');
  });

  it('links tasks, refusing a cycle', () => {
    const s = service();
    const a = ok(s.create(request({ title: 'a' }))).task;
    const b = ok(s.create(request({ title: 'b', parents: [a.taskId] }))).task;
    expect(s.link(b.taskId, a.taskId, ALICE)).toMatchObject({ ok: false, code: 'cycle' });
    const c = ok(s.create(request({ title: 'c' }))).task;
    expect(s.link(c.taskId, b.taskId, ALICE)).toEqual({ ok: true, added: true });
    expect(ok(s.show(b.taskId)).view.parents.map((t) => t.title)).toEqual(['a', 'c']);
  });
});
```

- [ ] **Step 14.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-service.test.ts`. Expected: the 7 new tests FAIL, for example with `s.comment is not a function`, and `Tests  7 failed | 10 passed (17)`.

- [ ] **Step 14.3: Implement.** In `src/kanban/service.ts`:
  - replace the imports at the top, that is everything above the comment that begins `/**` / ` * The board's service API`, with:

```ts
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import type { Db } from '../db/open.js';
import * as board from '../db/kanban.js';
import { getTask, taskView, type TaskView } from '../db/kanban-read.js';
import type { Role } from '../roles.js';
import { systemClock, type Clock } from '../time.js';
import {
  BLOCK_KINDS,
  CONTRACT_FIELDS,
  type AgentSnapshot,
  type Assignee,
  type CommentRow,
  type Contract,
  type CreatedVia,
  type ReportedBlockKind,
  type Reporter,
  type Result,
  type RetryOnCrash,
  type RunRow,
  type TaskRow,
} from './types.js';
```

  - directly before `/** A person's principal, as channels identify them. */`, add:

```ts
/** The kinds a worker or a person may report; gave_up is the breaker's. */
const REPORTABLE: readonly ReportedBlockKind[] = BLOCK_KINDS.filter((k): k is ReportedBlockKind => k !== 'gave_up');
```

  - in the class, directly before `/** Who the next claim is for, resolved against the team as it is now. */`, add:

```ts
  /**
   * New work on a done task is a new task with it as a parent, never a reopening
   * (spec §4.4): the done task's summary is what its children were given as their
   * handoff, and reopening it would rewrite the input to work that already ran.
   */
  followUp(taskId: string, req: CreateRequest): Result<{ task: TaskRow; existing: boolean }> {
    const done = getTask(this.#db, taskId);
    if (done === undefined) return board.refuse('not_found', `no task ${taskId}`);
    if (done.phase !== 'done') {
      return board.refuse('illegal_transition', `task ${taskId} is ${done.phase}; only a done task gets follow-ups`);
    }
    return this.create({ ...req, parents: [taskId, ...(req.parents ?? [])] });
  }

  link(parentId: string, childId: string, by: string): Result<{ added: boolean }> {
    return board.link(this.#db, parentId, childId, by, this.#clock.now());
  }

  /** Workspaces are named, never paths, and only configured ones (spec §2.3). */
  setWorkspace(taskId: string, workspace: string, by: string): Result<{ task: TaskRow }> {
    if (!this.#workspaces.has(workspace)) {
      return board.refuse('unknown_workspace', `workspace ${workspace} is not configured`);
    }
    return board.setWorkspace(this.#db, taskId, workspace, by, this.#clock.now());
  }

  comment(taskId: string, body: string, by: string): Result<{ comment: CommentRow }> {
    if (body.trim() === '') return board.refuse('invalid', 'a comment needs text');
    return board.addComment(this.#db, taskId, by, body, this.#clock.now());
  }

  /** Every path to done (spec §5.1). Gates run here first, from plan C4. */
  complete(taskId: string, by: Reporter, handoff: board.Handoff): Result<{ task: TaskRow; run: RunRow | undefined }> {
    return board.complete(this.#db, taskId, by, handoff, this.#clock.now());
  }

  /** A reviewer the report names is checked like any assignee (spec §5.3, §12). */
  requestReview(
    taskId: string,
    by: Reporter,
    handoff: board.Handoff & { reviewer?: string },
  ): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const { reviewer, ...rest } = handoff;
    if (reviewer === undefined) return board.requestReview(this.#db, taskId, by, rest, this.#clock.now());
    const who = this.#assignable(reviewer);
    if (!who.ok) return who;
    return board.requestReview(this.#db, taskId, by, { ...rest, reviewer: who.assignee }, this.#clock.now());
  }

  requestChanges(taskId: string, by: Reporter, reason: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    if (reason.trim() === '') return board.refuse('invalid', 'changes need a reason the implementer can act on');
    return board.requestChanges(this.#db, taskId, by, reason, this.#clock.now());
  }

  /** `kind` arrives as text from an agent's JSON or from chat, so it is checked here. */
  block(
    taskId: string,
    by: Reporter,
    report: { kind: string; reason: string; parents?: readonly string[] },
  ): Result<{ task: TaskRow; run: RunRow | undefined }> {
    const kind = REPORTABLE.find((k) => k === report.kind);
    if (kind === undefined) {
      return board.refuse(
        'invalid',
        report.kind === 'gave_up'
          ? "gave_up is set by the board's breaker, never reported"
          : `unknown block kind ${report.kind} (one of ${REPORTABLE.join(', ')})`,
      );
    }
    if (report.reason.trim() === '') return board.refuse('invalid', 'a block needs a reason');
    return board.block(
      this.#db,
      taskId,
      by,
      { kind, reason: report.reason, ...(report.parents === undefined ? {} : { parents: report.parents }) },
      this.#clock.now(),
    );
  }

  unblock(taskId: string, by: string, comment?: string): Result<{ task: TaskRow }> {
    return board.unblock(this.#db, taskId, by, comment, this.#clock.now());
  }

  stop(taskId: string, by: string): Result<{ task: TaskRow; run: RunRow }> {
    return board.stop(this.#db, taskId, by, this.#clock.now());
  }

  archive(taskId: string, by: string): Result<{ task: TaskRow; run: RunRow | undefined }> {
    return board.archive(this.#db, taskId, by, this.#clock.now());
  }

  show(taskId: string): Result<{ view: TaskView }> {
    const view = taskView(this.#db, taskId);
    return view === undefined ? board.refuse('not_found', `no task ${taskId}`) : { ok: true, view };
  }
```

- [ ] **Step 14.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  702 passed (702)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 14.5: Commit.**

```bash
git add src/kanban/service.ts tests/kanban-service.test.ts
git commit -m "Finish the kanban service API"
```

- [ ] **Step 14.6: Run everything.** Run:
  - `npm test 2>&1 | tail -4`: expect `Tests  702 passed (702)`;
  - `npm run test:e2e 2>&1 | tail -4`: expect `Tests  49 passed (49)`;
  - `npm run typecheck`: expect no output;
  - `git grep -n -E "UPDATE kanban_|INSERT INTO kanban_" -- src`: expect matches in `src/db/kanban.ts` only, since it is the one writer;
  - `git grep -n -i "p[g]w" -- . ':!package-lock.json'`: expect no output.

- [ ] **Step 14.7: Report, without merging.** Merging into the main checkout restarts the live gateway. That is the controller's step, after asking the user. The migration then runs once against the live database, adding empty tables.

---

## Done when

- `npm test` gives `Tests  729 passed (729)` (702 after Task 14; 27 more from the review follow-ups). `npm run test:e2e` gives `Tests  49 passed (49)`. `npm run typecheck` prints nothing. All of these run under Node 22, in the worktree.
- Only `src/db/kanban.ts` writes a `kanban_` table (Step 14.6), and `src/db/WRITERS.md` says so.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- Every transition of spec §5.1 that does not need an agent, a dispatcher or a socket has a function in `db/kanban.ts` and a test, and `KanbanService` exposes it.

## Review follow-ups

Made after Tasks 1–14, from the reviews of the service, the schema, masking, events and reports. Migration 003 had never been applied anywhere real, so it was edited in place; there is no migration 004. Task 2's SQL above is the original; `schema/003_kanban.sql` is current.

**Malformed input (service).** Every `KanbanService` entry point checks the types of what it was sent and refuses a wrong one as `invalid`, never throwing and never writing: a title that is not text or is missing; an assignee or reviewer that is not text, is null, or is empty (also in `requestReview`); a body, comment, block reason or changes reason that is not text; `parents` that is not a list of strings; an idempotency key that is not text; a contract value that is not text; a priority, failure limit or runtime that is not a safe integer (`Number.isSafeInteger`); task ids that are not text; a handoff with no text summary, or a `reportedCommit` or `reportedDirty` of the wrong type. One table-driven test feeds each bad shape to each entry point and checks that nothing was written.

**Idempotency keys (service).** `create`, and so `followUp`, stores a run's key as `run-task:<its run's task_id>:<key>`. A `lark:` key is refused unless the creator is chat, and a key starting `run-task:` is refused from anyone, since it is the board's own. Tests: an agent's `lark:om_1` is refused; two runs on different tasks using one key get different tasks; a run repeating its key gets its own task back; a chat's key used by a run does not return the chat's task.

**Schema (003).** `reported_dirty` is `CHECK (reported_dirty IN (0, 1))`. `kanban_runs` has `CHECK (assignee_kind = 'role' OR session_id IS NULL)`: a person's run has no session. `tests/kanban-schema.test.ts` now also covers the session-uniqueness index, the role⇔`agent_config` CHECK, and the assignee and reviewer kind/name pair CHECKs.

**Masking.** The contract is masked value by value with `redactKnownSecrets`, not through `redactValues`, which leaves a value under a globally identifying key (such as `workspace`) alone. Tested with a secret under `workspace` in a contract.

**Events.** `created`, `assignee_set`, `reviewer_set` and `review_requested` record the kind (`assigneeKind`, `reviewerKind`: `role` or `human`) beside the name; both keys are in `BOARD_KEYS`.

**Reports (`db/kanban.ts`).**
- `requestReview` refuses `parents_unfinished` while a parent is unfinished, as `complete` does. Tested with a person reporting, with no open run, on an open task whose parent is unfinished.
- `link` checks for an existing pair first, so re-linking one changes nothing in any phase. Tested on a done child and a child in review.

**`endRun`.** A missing `hadSideEffects` is taken as true, so an `if-no-side-effects` task stops for a person (`needs_input`, "may have changed things") rather than being retried blind. It stays optional in the type, documented as unknown-means-true.

**Service minors.**
- `noteUnassignable` writes only for a task that could otherwise be claimed: in open or review, parents finished, no cooldown, no open run. The check is in `db/kanban.ts`, inside its transaction; the claim is still refused `unassignable`. Tested with a todo task and a running task whose role was removed.
- An empty or blank name is `invalid`, not `unknown_role`.
- Names, workspaces, block kinds and contract fields the caller sent are echoed in refusals with `JSON.stringify`, and so in `skipped_unassignable` reasons.
- role.md and each SKILL.md must be regular files (`statSync().isFile()`) as well as readable; a directory leaves the task unassignable.
- role.md's bytes are hashed, and decoded separately for the returned text. Tested with bytes that are not UTF-8.
- A blank or whitespace summary from a run is refused in `complete` and `requestReview` as `invalid`. A person's may be empty.
- `Claimed` returns the `Role` the claim resolved, so plan C2's prompt uses the skills that were checked.
- A test scans `src/**/*.ts` and checks that only `src/kanban/service.ts` imports `db/kanban.js`.

**Missing tests, added.** The cooldown refusal, and the claim succeeding at exactly `cooldown_until`; a review claim refused while a parent is unfinished; a diamond (a→b, a→c, b→d, c→d), where linking a onto d is allowed and d onto a is a cycle; a new link onto a done child refused.

**Out of scope, noted above.** Text size limits are C3's and D's. C2 needs a ready-task listing, and each parent's latest summary for the prompt. C3 no longer namespaces keys: the service does.

**Final review.**
- A run's metadata is masked by `maskDeep` in `db/kanban.ts`, which masks every string whatever its key, and every key: `redactValues` left a value under a globally identifying key such as `sessionId` alone, and never masked keys. Tested with a secret under `sessionId`, `idempotencyKey` and `messageId`, and as a key. No event payload carries metadata, so `record()` is unchanged.
- `reportedCommit` must match `/^[0-9a-f]{7,64}$/`, or the service refuses the report as `invalid`; `db/kanban.ts` also masks it on write. Tested: a secret is refused, a 40-digit id is stored, and a secret written straight through `db/kanban.ts` is masked.
- An idempotency key holding a known secret is refused as `invalid`: keys identify, so they are stored unmasked.
- `endRun` refuses, as `invalid`, an outcome not in `ENDED_OUTCOMES`, at runtime. Tested with `completed`.
- `block` refuses `parents` on any kind but `dependency`.
- `create` refuses a `createdBy` that is not text, and a `createdVia` that is not a chat with text `channel`, `appId`, `conversationId` and `threadId`, or a run with a text `runId`. These cases are in the table-driven malformed-input test, with the commit and block cases.
- `types.ts` says a dependency block keeps the task's phase, open or review; it said the task returned to open.
- `actorOf`, `PHASES` and `SUPERSEDING_OUTCOMES` are no longer exported: nothing outside their files, tests included, used them.
- What C2, C3 and D need from the board is listed under "Out of scope".
