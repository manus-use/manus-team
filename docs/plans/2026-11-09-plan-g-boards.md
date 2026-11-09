# Plan G: Boards. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several projects share one gateway, each on a **board** of its own: an isolated queue of tasks, with its own list in chat, its own turn in each dispatcher pass, and optionally its own `max_running`, inside the gateway's `kanban.max_running`, and its own default workspace. There is one database and one dispatcher, and each task records its board. A board `default` always exists; migration `006` puts every existing task on it, and every chat starts on it, so a gateway that never makes another board behaves as before. Boards are made from chat (`/kanban board create <name>`, the grammar of roles and workspaces), each chat remembers its board (`/kanban board use <name>`), and a chat's `/kanban new`, `list` and `show` act on it; `/kanban boards` lists them. A task's follow-ups stay on its board, `parent:` and `link` cannot cross boards, and notices go, as they always have, to the chats that created a board's tasks. Projects, with per-project operators and role allow-lists, are left for later, by the user's choice.

**Architecture:**
- **The schema** (`schema/006_boards.sql`): `kanban_boards` (with `default`), `kanban_chat_boards`, and `kanban_tasks.board`, added with a constant default, which rewrites no row.
- **The writer** (`src/db/kanban.ts`, still the board's only writer): `createBoard`, `setBoard`, `archiveBoard`, `useBoard`; `createTask` on a board, a run's follow-ups on its task's board, and a parent on another board refused, as is a link or a dependency block across boards (`other_board`); a claim's workspace falling back to the board's before `default`.
- **The reads** (`src/db/kanban-read.ts`): `getBoard`, `boardsOf`, `boardSummaries`, `chatBoardOf`, `openAgentRunCountOn`; `boardList` for one board; `TaskRow.board`.
- **The rule for a workspace** (`src/kanban/workspace.ts`): spec §2.3's rule 4 is the board's workspace, else `default`.
- **The service** (`src/kanban/service.ts`): the board API, with the name grammar, a board's `max_running` bounded by the gateway's, a board's workspace a configured one; `create` and `followUp` on a board; `list` of one board.
- **The dispatcher** (`src/kanban/dispatcher.ts`, `src/kanban/fair.ts`): boards in turn, starting after the board of the last agent claim, priority and age within a board; a board's own `max_running`.
- **Chat** (`src/kanban/chat-parse.ts`, `chat-render.ts`, `chat.ts`): `/kanban boards [all]`, `/kanban board create|use|set|archive`; `new`, `list` and `show` on the chat's board.
- **The worker API** (`src/kanban/worker.ts`): `mt kanban show` gives the task's board; nothing else changes for an agent.
- **Wiring** (`src/index.ts`): the service is given `kanban.max_running`.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §16, which this plan's commit adds, with the G row of §12, and the notes on boards in §1, §3.1, §6.2 and §9.1.

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on a branch `kanban-boards` from `main`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, never run real bytesec, and never write to `~/.manus-team`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npx vitest run --project unit` gives `Tests  1371 passed (1371)`. `npx vitest run --project e2e` gives `Tests  98 passed (98)`. `npm run typecheck` reports no errors.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given.
- **`db/kanban.ts` stays the board's only writer.** Every write to `kanban_boards`, `kanban_chat_boards` and `kanban_tasks.board` is in it, as `src/db/WRITERS.md` says after Task 2.
- **Any work.** A task on a board is any work, not only code; nothing here assumes a repository.
- **Words a person sees** never name a plan, and do not use the long dash.
- **No real agent.** No test runs bytesec. The end-to-end test runs the fake CLI agent, `tests/fakes/cli-agent.mjs`, unchanged.

## Decisions the spec left open

Each has a recommendation and its reason. *The user's decision* marks those the user made, before this plan was written or on its first draft, each as recommended; **[you decide]** marks one still open.

1. **One database, one dispatcher, a `board` column.** *The user's decision.* Unlike Hermes, whose boards each have a database, a directory and a dispatcher loop, each task records its board. *Why:* a run is a session, and what an agent did is a join (spec §3), and two dispatchers would have to share the per-workspace limit and `kanban.max_running`.
2. **Queues, not projects.** *The user's decision.* A board has no operators of its own and no list of the roles it may use: whoever may act on one task may act on any, by the tiers as they are. Both are named as later work in spec §16.9.
3. **Tiers.** `/kanban boards` is talk tier. `/kanban board create`, `use`, `set` and `archive` are operator tier. *The user's decision*, for `use`: operator, because moving a chat onto a board changes where its tasks go and, through the board's workspace, the directory its operator's next unsupervised agent runs in; talk tier would let anyone the bot answers do that to an operator's chat.
4. **No rename, no unarchive, and a name is never reused.** *The user's decision.* A task stores its board's name, as it stores a workspace's (spec §2.3, a name is a durable identity), so a rename would rewrite every task on the board; and a name is never reused, an archived board's included, so a new board of an old name cannot take over the old tasks. Hermes renames only a display name, which can come later.
5. **A board's `max_running` and workspace are set from chat**, by `/kanban board set <name> max_running <number|none>` and `… workspace <workspace|none>`, and stored on the board's row. *The user's decision*, over `config.yaml`, because boards are made from chat: a setting in the file would name a board that may not exist yet, and two places would set one thing. The service refuses a `max_running` above the gateway's `kanban.max_running`; if the file later lowers the gateway's, the lower one binds (`min` at each pass). A workspace must be configured, as everywhere a workspace is named (spec §2.3).
6. **A board's workspace is spec §2.3's rule 4, in place of `default`.** The last resort, after the task's own, its role's explicit one, and its parents' common one (or its creating task's). Resolved at a claim, as rule 4 is, so setting it moves no task already claimed, and a board's workspace removed from config makes the agent tasks that would land there unresolvable, not silently `default`. A person's task with no other rule gets it too.
7. **`/kanban show <id>` of a task on another board shows it, naming its board.** *The user's decision*, over refusing it. Task ids are unique across boards, and boards are not permissions; a chat that moved still follows the tasks it created, whose notices carry their ids, typed commands and an Unblock button, and those must keep working. So every command that names a task works on any board by id, and `show` names the board whenever the task's or the chat's board is not `default`.
8. **An agent's `mt kanban create` goes on its run's task's board**, whatever it asks: the worker API has no board field, and the writer derives the board from the creating run, so a follow-up never leaves its board. `mt kanban show` gives the task's `board`, read-only.
9. **`mt kanban gate` and the worker API need no board.** Gates belong to a task, named by its id, which is unique across boards; the token's scope is its run's task (spec §7.2).
10. **Fairness: the boards in turn.** A pass takes the boards in turn, by name, starting with the board after the one that got the last agent claim, wrapping round (`boardQueues`, `src/kanban/fair.ts`). A board's turn is its first task that can actually be claimed: the pass tries that board's queue in order until one agent claim succeeds or the queue runs out, then moves to the next board (`#tryClaim`, `src/kanban/dispatcher.ts`); a person's claim does not end the turn, and a board at its own limit gives up its turn for the pass. So a board whose head task is skipped, its workspace busy, is not sent behind every other board's work (review follow-ups). Within a board, priority then age, as spec §6.2 says; across boards priority does not count, as one board's priorities say nothing about another's. Without the rotation, a board whose first task is always claimable would be offered every slot first. The cursor is in memory; a restart costs one turn of fairness. People's runs are not limited and do not move it.
11. **One agent per workspace stays global.** A workspace is a directory, and two boards' agents in one checkout would overwrite each other exactly as two tasks' would (spec §6.3).
12. **Archiving.** `/kanban board archive <name>` is refused for `default`, and while any of the board's tasks is open, in review or blocked; once archived, no task is created on it, from chat or by a run whose task has just completed there, no chat moves onto it, and `/kanban boards` leaves it out unless asked for `all`. Its tasks stay, shown by id. A chat still on it is not moved, and its `/kanban new` is told to move first; its `/kanban boards` still lists it, marked (Decision 20). *The user's decision* on when a board may be archived, and on `default`; not moving its chats is recommended over archiving the board's tasks with it, which would end runs, and over moving its chats to `default` unasked, which would send their next task where nobody chose.
13. **Existing chats and subscriptions after the migration** are unchanged: every task is on `default`, every chat starts on `default`, and subscriptions follow the chat a task was created in, as before. A chat that moves still hears about the tasks it created.
14. **`/kanban list all` keeps its meaning:** every status, on the chat's board. **[you decide]** Recommended over "all boards", since `all` already means every status and a list of every board's tasks would mix queues; `/kanban boards` is the view across boards, with each board's tasks by phase.
15. **A chat is a conversation**, for one bot: a group and every thread in it share one board (`kanban_chat_boards` is keyed without the thread). A thread keyed separately would land a reply in a topic on `default` without anyone choosing it.
16. **The migration is safe on the live database.** `ALTER TABLE kanban_tasks ADD COLUMN board TEXT NOT NULL DEFAULT 'default'` records the default in the schema and rewrites no row; the whole file runs in `migrate`'s one transaction with `user_version`, so a failure leaves version 5 as it was. There is no `REFERENCES` on the column: SQLite refuses one on a column added with a non-null default while foreign keys are on, as `openDb` sets them, and rebuilding `kanban_tasks` would rewrite the live table. The writer checks the board in the creating transaction instead. `default`'s `created_at` is the migration's own moment, from `julianday('now')`.
17. **No board events.** `kanban_events` rows belong to a task. A board's row records who created it and who last changed it; there is no history of its settings.
18. **Replies name a board only when it is not `default`**, so a gateway with one board reads exactly as before, and its tests are unchanged: `/kanban new`'s reply, `/kanban list`'s first line, `/kanban show`'s board.
19. **Notices are unchanged.** They go to the chats that follow a task and do not name its board; the task id is enough for `/kanban show`. The `created` event records the board, as it records the workspace; it is no notice, so nothing a chat hears changes.
20. **`/kanban boards` always lists the chat's own board**, archived or not, so the chat is shown which board it is on; other archived boards only with `all`.
21. **An idempotency key is not a repeat across boards.** `createTask` answers a key it has seen with the task it made, before anything else. A chat's key whose task is on another board than the one asked for is refused `other_board`, rather than handing back a task from another queue: a message redelivered after its chat moved boards. A run's key is namespaced by its run's task (spec §3.1), whose board its follow-ups are on, so it cannot cross.

## Out of scope, and known limitations

- **Projects:** per-board operators and role allow-lists (spec §16.9), by the user's choice.
- **A workspace called `none`** cannot be a board's workspace: `none` clears it. `none` and `all` are not board names either.
- **No rename and no unarchive** (Decision 4); a board's display name is later.
- **No history of a board's settings** (Decision 17).
- **Fairness after a restart** starts from the first board by name (Decision 10).
- **Across boards, priority does not count** (Decision 10): an urgent task on one board waits its board's turn.
- **A chat's board is the conversation's**; a thread cannot have its own (Decision 15).
- **An archived board's chats stay on it** until an operator moves them (Decision 12).
- **Boards are made in chat only**: `mt` has no board commands.
- **Stranded behind a limit:** an agent task skipped because `kanban.max_running`, or its board's own `max_running`, is reached is not tried, so it is never recorded as unassignable, and a task nobody can be given is reported stranded only once a slot frees. A task waiting only on a limit is never reported stranded.

## File structure

| File | Responsibility |
|---|---|
| `schema/006_boards.sql` (create) | `kanban_boards` with `default`, `kanban_chat_boards`, `kanban_tasks.board` |
| `src/kanban/types.ts` (modify) | `TaskRow.board`, `DEFAULT_BOARD`, `BoardRow`, `ChatAt`; the refusals `unknown_board`, `board_archived`, `other_board` |
| `src/db/kanban-read.ts` (modify) | decoding `board`; `getBoard`, `boardsOf`, `boardSummaries`, `chatBoardOf`, `openAgentRunCountOn`; `boardList` of one board |
| `src/db/kanban.ts` (modify) | `createBoard`, `setBoard`, `archiveBoard`, `useBoard`; `createTask` on a board, its `created` event naming it; `other_board` in `createTask`, for a parent or a key used on another board, and in `linkIn`; the board's workspace in `claim` |
| `src/db/WRITERS.md` (modify) | the two new tables and `kanban_tasks.board` |
| `src/kanban/workspace.ts` (modify) | rule 4: the board's workspace, else `default` |
| `src/names.ts` (modify) | `nameProblem` for a board |
| `src/kanban/service.ts` (modify) | the board API; `create`'s and `followUp`'s board; `list` of one board; `maxRunning` |
| `src/kanban/fair.ts` (create) | `boardQueues`: one queue per board, in turn (and `fairOrder`, the order when every claim succeeds, used by tests) |
| `src/kanban/dispatcher.ts` (modify) | the pass tries each board's queue until one agent claim succeeds, the board cursor, a board's `max_running` |
| `src/kanban/chat-parse.ts` (modify) | `boards`, `board create|use|set|archive`, and their usage |
| `src/kanban/chat-render.ts` (modify) | `renderBoards`; the board in `renderList` and `renderShow`; the help |
| `src/kanban/chat.ts` (modify) | the board commands and their tiers; `new`, `list`, `show` on the chat's board |
| `src/kanban/worker.ts` (modify) | `board` in `mt kanban show` |
| `src/index.ts` (modify) | the service given `kanban.max_running` |
| `docs/kanban-guide.md`, `README.md` (modify) | boards, for the people who use them |
| `tests/kanban-boards-schema.test.ts`, `tests/kanban-boards.test.ts`, `tests/kanban-board-isolation.test.ts`, `tests/kanban-board-workspace.test.ts`, `tests/kanban-board-service.test.ts`, `tests/kanban-board-dispatch.test.ts`, `tests/kanban-board-chat-parse.test.ts`, `tests/kanban-board-chat.test.ts`, `tests/kanban-board-worker.test.ts` (create) | |
| `tests/kanban-schema.test.ts`, `tests/kanban-prompt.test.ts`, `tests/kanban-tasks.test.ts`, `tests/kanban-chat.e2e.ts` (modify) | the version and tables; a `TaskRow` fixture's board; the `created` event's board; one end-to-end test |

Running counts, unit then end to end: Task 1 1375 / 98, Task 2 1385 / 98, Task 3 1392 / 98, Task 4 1397 / 98, Task 5 1404 / 98, Task 6 1410 / 98, Task 7 1414 / 98, Task 8 1423 / 99, Task 9 1425 / 99, Task 10 1425 / 99, review follow-ups 1433 / 99.

---

### Task 1: Migration 006, and every task on a board

**Files:**
- Create: `schema/006_boards.sql`, `tests/kanban-boards-schema.test.ts`
- Modify: `src/kanban/types.ts`, `src/db/kanban-read.ts`, `tests/kanban-schema.test.ts`, `tests/kanban-prompt.test.ts`

The two tables, `default`, and the `board` column (Decision 16). The test that matters most runs the migration on a database left at version 5 with a task and a run in it, as the live one is, and finds the task on `default` and nothing else of it changed. A task read from the board now carries its board; the one test that builds a whole `TaskRow` by hand is given one.

- [ ] **Step 1.1: Write the failing tests.**

Create `tests/kanban-boards-schema.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { newTask } from './helpers/kanban.js';

/**
 * Migration 006 (spec §16): the boards, `default` among them, and every task on
 * one. It runs on the live database, which holds tasks, so it is tested from
 * version 5 with rows in it, as well as from nothing.
 */

const NOW = 1_760_000_000_000;
let dir: string;
let db: Db;

/** A database migrated as far as `version`, as a gateway from before this change left it. */
function migratedTo(version: number): Db {
  const only = mkdtempSync(join(dir, 'schema-'));
  for (const f of readdirSync(SCHEMA_DIR)) {
    if (/^\d+_.*\.sql$/.test(f) && Number(f.slice(0, f.indexOf('_'))) <= version) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
  }
  const d = openDb(join(dir, 'gateway.db'));
  migrate(d, only);
  return d;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-boards-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 006', () => {
  it('puts every task already on the board on default, and changes nothing else of it', () => {
    db = migratedTo(5);
    db.prepare(
      `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at)
       VALUES ('k_old', 'from before boards', jsonb('{}'), 'open', 'lark:on_alice', jsonb('{}'), ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO kanban_runs (run_id, task_id, attempt, kind, assignee_kind, assignee, agent_config, started_at)
       VALUES ('r_old', 'k_old', 1, 'work', 'role', 'implementer', jsonb('{}'), ?)`,
    ).run(NOW);

    expect(migrate(db, SCHEMA_DIR)).toBe(6);

    expect(getTask(db, 'k_old')).toMatchObject({ taskId: 'k_old', title: 'from before boards', phase: 'open', board: 'default' });
    expect(db.prepare('SELECT run_id, task_id FROM kanban_runs').all()).toEqual([{ run_id: 'r_old', task_id: 'k_old' }]);
    const boards = db.prepare<[], { name: string; created_by: string; created_at: number }>('SELECT * FROM kanban_boards').all();
    expect(boards.map((b) => [b.name, b.created_by])).toEqual([['default', 'gateway']]);
    // Stamped with the moment it ran, in milliseconds, as every other time is.
    expect(boards[0]?.created_at).toBeGreaterThan(NOW);
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 6 });
  });

  it('puts a task created afterwards on default unless it says otherwise', () => {
    db = migratedTo(6);
    expect(newTask(db).board).toBe('default');
  });

  it('refuses a chat on a board that does not exist', () => {
    db = migratedTo(6);
    const insert = db.prepare(
      `INSERT INTO kanban_chat_boards (channel, account_id, conversation_id, board, set_by, set_at)
       VALUES ('lark', 'cli_app', 'oc_chat', ?, 'lark:on_alice', ?)`,
    );
    expect(() => insert.run('nowhere', NOW)).toThrow(/FOREIGN KEY constraint failed/);
    insert.run('default', NOW);
  });

  it('refuses a board max_running below 1', () => {
    db = migratedTo(6);
    const insert = db.prepare(
      "INSERT INTO kanban_boards (name, max_running, created_by, created_at) VALUES (?, ?, 'lark:on_alice', ?)",
    );
    expect(() => insert.run('zero', 0, NOW)).toThrow(/CHECK constraint failed/);
    insert.run('one', 1, NOW);
  });
});
```

In `tests/kanban-schema.test.ts`, replace:

```ts
    // 004 adds a column to kanban_comments and an index, 005 the people table; every kanban table is 003's.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(5);
```

with:

```ts
    // 004 adds a column to kanban_comments and an index, 005 the people table, 006 the boards' two tables.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(6);
```

In `tests/kanban-schema.test.ts`, replace:

```ts
    expect(tables).toEqual([
      { name: 'kanban_comments', strict: 1 },
```

with:

```ts
    expect(tables).toEqual([
      { name: 'kanban_boards', strict: 1 },
      { name: 'kanban_chat_boards', strict: 1 },
      { name: 'kanban_comments', strict: 1 },
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-boards-schema.test.ts tests/kanban-schema.test.ts`. Expected: `Tests  5 failed | 9 passed (14)`: the version is still 5, there is no `kanban_chat_boards`, and a task has no `board`.

- [ ] **Step 1.3: Implement.**

Create `schema/006_boards.sql`:

```sql
-- manus-team migration 006: boards, the board's isolated task queues
-- See docs/specs/2026-11-02-kanban-design.md §16.
--
-- A board is a queue of tasks: its own list in chat, its own turn in each
-- dispatcher pass, and optionally its own max_running and default workspace.
-- One database and one dispatcher serve every board, so each task records the
-- board it is on. db/kanban.ts is the only writer of both tables below
-- (src/db/WRITERS.md).
CREATE TABLE kanban_boards (
  name         TEXT PRIMARY KEY,            -- the role grammar (spec §2.1); never renamed
  max_running  INTEGER CHECK (max_running IS NULL OR max_running >= 1),
  workspace    TEXT,                        -- a workspace name: its tasks' default (§2.3 rule 4)
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_by   TEXT,                        -- who last set max_running or the workspace, or archived it
  updated_at   INTEGER,
  archived_at  INTEGER
) STRICT, WITHOUT ROWID;

-- `default` always exists, and every task before this migration is on it.
INSERT INTO kanban_boards (name, created_by, created_at)
VALUES ('default', 'gateway', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));

-- A constant default: SQLite records it in the schema and rewrites no row, so the
-- migration is as quick on a board holding years of tasks as on an empty one. No
-- REFERENCES clause: SQLite refuses one on a column added with a non-null default
-- while foreign keys are on, as the gateway opens its database. db/kanban.ts checks
-- the board exists, in the transaction that creates the task.
ALTER TABLE kanban_tasks ADD COLUMN board TEXT NOT NULL DEFAULT 'default';

CREATE INDEX idx_kanban_tasks_board ON kanban_tasks(board, phase);

-- The board each chat is on (spec §16): a conversation, for one bot, with all its
-- threads. A chat with no row is on `default`.
CREATE TABLE kanban_chat_boards (
  channel          TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  board            TEXT NOT NULL REFERENCES kanban_boards(name),
  set_by           TEXT NOT NULL,
  set_at           INTEGER NOT NULL,
  PRIMARY KEY (channel, account_id, conversation_id)
) STRICT, WITHOUT ROWID;

UPDATE schema_version SET version = 6;
```

In `src/kanban/types.ts`, replace:

```ts
  closedAt: number | null;
  createdFromTask: string | null;
}
```

with:

```ts
  closedAt: number | null;
  createdFromTask: string | null;
  /** The board the task is on (spec §16): fixed at creation, and its follow-ups' too. */
  board: string;
}

/** The board every task was on before there were others, and every chat starts on (spec §16). */
export const DEFAULT_BOARD = 'default';

/**
 * A board (spec §16): a queue of tasks, with its own list in chat and its own
 * turn in each dispatcher pass. One database and one dispatcher serve them all.
 */
export interface BoardRow {
  /** The role grammar (spec §2.1); never renamed. */
  name: string;
  /** Open agent runs on this board at once, inside the gateway's `kanban.max_running`; null for no limit of its own. */
  maxRunning: number | null;
  /** The workspace of a task on this board that no other rule gives one (spec §2.3 rule 4); null for `default`. */
  workspace: string | null;
  createdBy: string;
  createdAt: number;
  updatedBy: string | null;
  updatedAt: number | null;
  /** Set once archived: no task is added to it, and no chat moves onto it. */
  archivedAt: number | null;
}

/** A chat, for the board it is on: a conversation, for one bot, with all its threads (spec §16). */
export interface ChatAt {
  channel: string;
  appId: string;
  conversationId: string;
}
```

In `src/kanban/types.ts`, replace:

```ts
  /** A report on the task is still running its gates. */
  | 'report_in_progress';
```

with:

```ts
  /** A report on the task is still running its gates. */
  | 'report_in_progress'
  /** No board of that name (spec §16). */
  | 'unknown_board'
  /** The board is archived: nothing is added to it, and no chat moves onto it. */
  | 'board_archived'
  /** A parent and its child would be on different boards (spec §16). */
  | 'other_board';
```

In `src/db/kanban-read.ts`, replace:

```ts
  closed_at: number | null;
  created_from_task: string | null;
}
```

with:

```ts
  closed_at: number | null;
  created_from_task: string | null;
  board: string;
}
```

In `src/db/kanban-read.ts`, replace:

```ts
    createdFromTask: r.created_from_task,
  };
}
```

with:

```ts
    createdFromTask: r.created_from_task,
    board: r.board,
  };
}
```

In `src/db/kanban-read.ts`, replace:

```ts
  json(created_via) AS created_via, created_at, closed_at, created_from_task`;
```

with:

```ts
  json(created_via) AS created_via, created_at, closed_at, created_from_task, board`;
```

In `tests/kanban-prompt.test.ts`, replace:

```ts
    createdFromTask: null,
    ...extra,
```

with:

```ts
    createdFromTask: null,
    board: 'default',
    ...extra,
```

- [ ] **Step 1.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1375 passed (1375)`. Run `npx vitest run --project e2e`. Expected: `Tests  98 passed (98)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.5: Commit.**

```bash
git add schema/006_boards.sql src/kanban/types.ts src/db/kanban-read.ts tests/kanban-boards-schema.test.ts tests/kanban-schema.test.ts tests/kanban-prompt.test.ts
git commit -m "Add boards to the schema: a kanban_boards table with default in it, the board each chat is on, and a board column on every task, which puts every existing task on default without rewriting a row"
```

---

### Task 2: Boards in the board's writer

**Files:**
- Create: `tests/kanban-boards.test.ts`
- Modify: `src/db/kanban.ts`, `src/db/kanban-read.ts`, `src/db/WRITERS.md`, `tests/kanban-tasks.test.ts`

`createBoard`, `setBoard`, `archiveBoard` and `useBoard`, each one transaction in `db/kanban.ts`, and the reads they and chat need. `createTask` takes a board, `default` unless given, and refuses one that does not exist or is archived; its `created` event names the board, as it names the workspace, and is still no notice. Task 3 keeps a task's family on it. Archiving is refused while a task on the board is unfinished (Decision 12); a name is never reused (Decision 4). `boardList` reads one board; `boardsOf` and `boardSummaries` leave archived boards out unless asked for them, or for one by name, as a chat's own board is (Decision 20).

- [ ] **Step 2.1: Write the failing tests.**

Create `tests/kanban-boards.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archive, archiveBoard, createBoard, setBoard, useBoard } from '../src/db/kanban.js';
import { boardSummaries, boardsOf, chatBoardOf, getBoard } from '../src/db/kanban-read.js';
import type { ChatAt } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';

/**
 * Boards in the board's writer (spec §16): created, set, archived, and the board
 * each chat is on. Whether a name is well formed, or a workspace configured, is
 * the service's; what the rows allow is here.
 */

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

const CHAT: ChatAt = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat' };

function made(name: string): void {
  const r = createBoard(h.db, name, ALICE, NOW);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
}

describe('createBoard', () => {
  it('creates a board with no limit or workspace of its own, by who asked', () => {
    expect(createBoard(h.db, 'web-app', ALICE, NOW)).toEqual({
      ok: true,
      board: {
        name: 'web-app',
        maxRunning: null,
        workspace: null,
        createdBy: ALICE,
        createdAt: NOW,
        updatedBy: null,
        updatedAt: null,
        archivedAt: null,
      },
    });
    expect(getBoard(h.db, 'web-app')?.name).toBe('web-app');
  });

  it('refuses a name a board already has, default and archived ones too', () => {
    made('web-app');
    expect(archiveBoard(h.db, 'web-app', ALICE, NOW).ok).toBe(true);
    for (const name of ['web-app', 'default']) {
      expect(createBoard(h.db, name, ALICE, NOW)).toMatchObject({ ok: false, code: 'invalid' });
    }
  });
});

describe('setBoard', () => {
  it('sets and clears its max_running and workspace, one at a time, recording who', () => {
    made('web-app');
    expect(setBoard(h.db, 'web-app', { maxRunning: 2 }, 'lark:on_bob', NOW + 1)).toMatchObject({
      ok: true,
      board: { maxRunning: 2, workspace: null, updatedBy: 'lark:on_bob', updatedAt: NOW + 1 },
    });
    expect(setBoard(h.db, 'web-app', { workspace: 'web' }, ALICE, NOW + 2)).toMatchObject({
      ok: true,
      board: { maxRunning: 2, workspace: 'web', updatedBy: ALICE },
    });
    expect(setBoard(h.db, 'web-app', { maxRunning: null }, ALICE, NOW + 3)).toMatchObject({
      ok: true,
      board: { maxRunning: null, workspace: 'web' },
    });
  });

  it('sets default too, and refuses a board that does not exist or is archived', () => {
    expect(setBoard(h.db, 'default', { maxRunning: 1 }, ALICE, NOW)).toMatchObject({ ok: true, board: { maxRunning: 1 } });
    expect(setBoard(h.db, 'nowhere', { maxRunning: 1 }, ALICE, NOW)).toMatchObject({ ok: false, code: 'unknown_board' });
    made('old');
    expect(archiveBoard(h.db, 'old', ALICE, NOW).ok).toBe(true);
    expect(setBoard(h.db, 'old', { maxRunning: 1 }, ALICE, NOW)).toMatchObject({ ok: false, code: 'board_archived' });
  });
});

describe('archiveBoard', () => {
  it('never archives default', () => {
    expect(archiveBoard(h.db, 'default', ALICE, NOW)).toMatchObject({ ok: false, code: 'invalid' });
    expect(getBoard(h.db, 'default')?.archivedAt).toBeNull();
  });

  it('refuses while a task on the board is not done or archived, and archives it once none is', () => {
    made('web-app');
    const task = newTask(h.db, { board: 'web-app' });
    const r = archiveBoard(h.db, 'web-app', ALICE, NOW);
    expect(r).toMatchObject({ ok: false, code: 'illegal_transition' });
    expect(r.ok ? '' : r.message).toContain('1 task');
    expect(archive(h.db, task.taskId, ALICE, NOW).ok).toBe(true);
    expect(archiveBoard(h.db, 'web-app', 'lark:on_bob', NOW + 5)).toMatchObject({
      ok: true,
      board: { archivedAt: NOW + 5, updatedBy: 'lark:on_bob' },
    });
    expect(archiveBoard(h.db, 'web-app', ALICE, NOW)).toMatchObject({ ok: false, code: 'board_archived' });
    expect(archiveBoard(h.db, 'nowhere', ALICE, NOW)).toMatchObject({ ok: false, code: 'unknown_board' });
  });
});

describe('the board a chat is on', () => {
  it('is none until a chat uses one, and is the conversation’s alone', () => {
    made('web-app');
    expect(chatBoardOf(h.db, CHAT)).toBeUndefined();
    expect(useBoard(h.db, CHAT, 'web-app', ALICE, NOW)).toMatchObject({ ok: true, board: { name: 'web-app' } });
    expect(chatBoardOf(h.db, CHAT)).toBe('web-app');
    expect(chatBoardOf(h.db, { ...CHAT, conversationId: 'oc_other' })).toBeUndefined();
    expect(chatBoardOf(h.db, { ...CHAT, appId: 'cli_other' })).toBeUndefined();
    expect(useBoard(h.db, CHAT, 'default', ALICE, NOW + 1).ok).toBe(true);
    expect(chatBoardOf(h.db, CHAT)).toBe('default');
  });

  it('refuses a board that does not exist or is archived, and leaves the chat where it was', () => {
    made('old');
    expect(archiveBoard(h.db, 'old', ALICE, NOW).ok).toBe(true);
    expect(useBoard(h.db, CHAT, 'nowhere', ALICE, NOW)).toMatchObject({ ok: false, code: 'unknown_board' });
    expect(useBoard(h.db, CHAT, 'old', ALICE, NOW)).toMatchObject({ ok: false, code: 'board_archived' });
    expect(chatBoardOf(h.db, CHAT)).toBeUndefined();
  });
});

describe('reading the boards', () => {
  it('lists archived boards only when asked, or when one is the board asked to include', () => {
    made('old');
    expect(archiveBoard(h.db, 'old', ALICE, NOW).ok).toBe(true);
    expect(boardSummaries(h.db).map((s) => s.board.name)).toEqual(['default']);
    expect(boardSummaries(h.db, { including: 'old' }).map((s) => s.board.name)).toEqual(['default', 'old']);
    expect(boardSummaries(h.db, { including: 'nowhere' }).map((s) => s.board.name)).toEqual(['default']);
  });

  it('lists default first, then by name, archived ones only when asked, each with its tasks by phase', () => {
    made('zeta');
    made('alpha');
    made('old');
    expect(archiveBoard(h.db, 'old', ALICE, NOW).ok).toBe(true);
    newTask(h.db);
    const gone = newTask(h.db);
    expect(archive(h.db, gone.taskId, ALICE, NOW).ok).toBe(true);
    newTask(h.db, { board: 'alpha' });

    expect(boardsOf(h.db).map((b) => b.name)).toEqual(['default', 'alpha', 'zeta']);
    expect(boardsOf(h.db, { archived: true }).map((b) => b.name)).toEqual(['default', 'alpha', 'old', 'zeta']);
    // A chat's own board is listed even archived, so the chat can see it is on one.
    expect(boardsOf(h.db, { including: 'old' }).map((b) => b.name)).toEqual(['default', 'alpha', 'old', 'zeta']);
    expect(boardsOf(h.db, { including: 'alpha' }).map((b) => b.name)).toEqual(['default', 'alpha', 'zeta']);
    const counts = Object.fromEntries(boardSummaries(h.db).map((s) => [s.board.name, s.counts]));
    expect(counts).toEqual({
      default: { open: 1, review: 0, blocked: 0, done: 0, archived: 1 },
      alpha: { open: 1, review: 0, blocked: 0, done: 0, archived: 0 },
      zeta: { open: 0, review: 0, blocked: 0, done: 0, archived: 0 },
    });
  });
});
```

In `tests/kanban-tasks.test.ts`, replace:

```ts
          workspace: 'web',
          parents: [],
          createdFromTask: null,
        },
      ],
```

with:

```ts
          workspace: 'web',
          parents: [],
          createdFromTask: null,
          board: 'default',
        },
      ],
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-boards.test.ts`. Expected: `Tests  10 failed (10)`, with `TypeError: (0 , createBoard) is not a function`.

- [ ] **Step 2.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  CommentRow,
```

with:

```ts
import type {
  ActivePhase,
  AgentSnapshot,
  Assignee,
  BoardRow,
  ChatAt,
  CommentRow,
```

In `src/db/kanban-read.ts`, replace:

```ts
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
```

with:

```ts
/**
 * Every task on a board -- on every board, with none given -- with its display
 * status, highest priority first, then oldest: `/kanban list` (spec §9.1, §16).
 * The status is derived here, from the parents and the runs, as `taskView`
 * derives it.
 */
export function boardList(db: Db, board?: string): BoardEntry[] {
  const where = board === undefined ? '' : 'WHERE board = ?';
  return db
    .prepare<string[], TaskRaw>(`SELECT ${TASK_COLS} FROM kanban_tasks ${where} ORDER BY priority DESC, created_at, rowid`)
    .all(...(board === undefined ? [] : [board]))
    .map(decodeTask)
```

In `src/db/kanban-read.ts`, replace:

```ts
  const payload = json(event.payload) as { summary?: unknown };
  return { summary: typeof payload.summary === 'string' ? payload.summary : '', metadata: null, runId: null };
}
```

with:

```ts
  const payload = json(event.payload) as { summary?: unknown };
  return { summary: typeof payload.summary === 'string' ? payload.summary : '', metadata: null, runId: null };
}

// ---------------------------------------------------------------------------
// Boards (spec §16)
// ---------------------------------------------------------------------------

interface BoardRaw {
  name: string;
  max_running: number | null;
  workspace: string | null;
  created_by: string;
  created_at: number;
  updated_by: string | null;
  updated_at: number | null;
  archived_at: number | null;
}

function decodeBoard(r: BoardRaw): BoardRow {
  return {
    name: r.name,
    maxRunning: r.max_running,
    workspace: r.workspace,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

const BOARD_COLS = 'name, max_running, workspace, created_by, created_at, updated_by, updated_at, archived_at';

export function getBoard(db: Db, name: string): BoardRow | undefined {
  const row = db.prepare<[string], BoardRaw>(`SELECT ${BOARD_COLS} FROM kanban_boards WHERE name = ?`).get(name);
  return row === undefined ? undefined : decodeBoard(row);
}

/** Which boards to read: archived ones too, or one board whatever it is, as a chat's own board is. */
export interface BoardsWanted {
  archived?: boolean;
  including?: string;
}

/** The boards, `default` first, then by name; archived ones only when asked for, or when `including` names one. */
export function boardsOf(db: Db, opts: BoardsWanted = {}): BoardRow[] {
  return db
    .prepare<[string], BoardRaw>(
      `SELECT ${BOARD_COLS} FROM kanban_boards
        ${opts.archived === true ? '' : 'WHERE archived_at IS NULL OR name = ?'}
        ORDER BY name <> 'default', name`,
    )
    .all(...((opts.archived === true ? [] : [opts.including ?? '']) as [string]))
    .map(decodeBoard);
}

/** A board, and how many of its tasks are in each phase: what `/kanban boards` shows. */
export interface BoardSummary {
  board: BoardRow;
  counts: Record<Phase, number>;
}

export function boardSummaries(db: Db, opts: BoardsWanted = {}): BoardSummary[] {
  const counted = db
    .prepare<[], { board: string; phase: Phase; n: number }>(
      'SELECT board, phase, count(*) AS n FROM kanban_tasks GROUP BY board, phase',
    )
    .all();
  return boardsOf(db, opts).map((board) => {
    const counts: Record<Phase, number> = { open: 0, review: 0, blocked: 0, done: 0, archived: 0 };
    for (const c of counted) if (c.board === board.name) counts[c.phase] = c.n;
    return { board, counts };
  });
}

/** The board a chat was moved onto, if it ever was: a chat with none is on `default` (spec §16). */
export function chatBoardOf(db: Db, at: ChatAt): string | undefined {
  return db
    .prepare<[string, string, string], { board: string }>(
      'SELECT board FROM kanban_chat_boards WHERE channel = ? AND account_id = ? AND conversation_id = ?',
    )
    .get(at.channel, at.appId, at.conversationId)?.board;
}
```

In `src/db/kanban.ts`, replace:

```ts
  getRun,
  getTask,
  getTaskByKey,
```

with:

```ts
  getBoard,
  getRun,
  getTask,
  getTaskByKey,
```

In `src/db/kanban.ts`, replace:

```ts
  ActivePhase,
  AgentSnapshot,
  Assignee,
  BlockKind,
  CommentRow,
```

with:

```ts
  ActivePhase,
  AgentSnapshot,
  Assignee,
  BlockKind,
  BoardRow,
  ChatAt,
  CommentRow,
```

In `src/db/kanban.ts`, replace:

```ts
import { ENDED_OUTCOMES, GATE_LIMITS, REPORTED_OUTCOMES } from '../kanban/types.js';
```

with:

```ts
import { DEFAULT_BOARD, ENDED_OUTCOMES, GATE_LIMITS, REPORTED_OUTCOMES } from '../kanban/types.js';
```

In `src/db/kanban.ts`, replace:

```ts
// ---------------------------------------------------------------------------
// Creating tasks, and comments
// ---------------------------------------------------------------------------
```

with:

```ts
// ---------------------------------------------------------------------------
// Boards (spec §16)
// ---------------------------------------------------------------------------

function mustGetBoard(d: Db, name: string): BoardRow {
  const board = getBoard(d, name);
  if (board === undefined) throw new Error(`board ${name} vanished inside its own transaction`);
  return board;
}

/** A board that exists and is not archived: what a task is added to, and a chat moved onto. */
function liveBoard(d: Db, name: string): Result<{ board: BoardRow }> {
  const board = getBoard(d, name);
  if (board === undefined) return refuse('unknown_board', `there is no board ${name}`);
  if (board.archivedAt !== null) return refuse('board_archived', `board ${name} is archived`);
  return { ok: true, board };
}

/**
 * A new board, with no max_running or workspace of its own. A name is never
 * reused, an archived board's included: tasks keep the name of the board they
 * were on, and a second board of that name would take them over.
 */
export function createBoard(db: Db, name: string, by: string, now: number): Result<{ board: BoardRow }> {
  return tx(db, (d) => {
    const existing = getBoard(d, name);
    if (existing !== undefined) {
      return refuse('invalid', `board ${name} exists already${existing.archivedAt === null ? '' : ', archived'}`);
    }
    d.prepare('INSERT INTO kanban_boards (name, created_by, created_at) VALUES (?, ?, ?)').run(name, by, now);
    return { ok: true, board: mustGetBoard(d, name) };
  });
}

/** A board's own settings (spec §16); a field left out is left as it is, and null clears it. */
export interface BoardChange {
  maxRunning?: number | null;
  workspace?: string | null;
}

/**
 * Set a board's max_running or workspace. The service has checked the values:
 * a max_running inside the gateway's, a configured workspace. A workspace set
 * here is used by the tasks claimed from now on whose workspace is still null.
 */
export function setBoard(db: Db, name: string, change: BoardChange, by: string, now: number): Result<{ board: BoardRow }> {
  return tx(db, (d) => {
    const live = liveBoard(d, name);
    if (!live.ok) return live;
    const next = {
      maxRunning: change.maxRunning === undefined ? live.board.maxRunning : change.maxRunning,
      workspace: change.workspace === undefined ? live.board.workspace : change.workspace,
    };
    d.prepare(
      'UPDATE kanban_boards SET max_running = ?, workspace = ?, updated_by = ?, updated_at = ? WHERE name = ?',
    ).run(next.maxRunning, next.workspace, by, now, name);
    return { ok: true, board: mustGetBoard(d, name) };
  });
}

/**
 * Archive a board: nothing is added to it from then on, and no chat moves onto
 * it. Refused while any of its tasks is still open, in review or blocked: its
 * work would have nowhere to go but a board nobody may add to. `default` is
 * never archived, as every chat starts on it.
 */
export function archiveBoard(db: Db, name: string, by: string, now: number): Result<{ board: BoardRow }> {
  return tx(db, (d) => {
    if (name === DEFAULT_BOARD) return refuse('invalid', `board ${DEFAULT_BOARD} is where every chat starts; it is never archived`);
    const live = liveBoard(d, name);
    if (!live.ok) return live;
    const unfinished =
      d
        .prepare<[string], { n: number }>(
          "SELECT count(*) AS n FROM kanban_tasks WHERE board = ? AND phase IN ('open', 'review', 'blocked')",
        )
        .get(name)?.n ?? 0;
    if (unfinished > 0) {
      return refuse(
        'illegal_transition',
        `board ${name} has ${unfinished} task${unfinished === 1 ? '' : 's'} not yet done or archived; finish or archive ${unfinished === 1 ? 'it' : 'them'} first`,
      );
    }
    d.prepare('UPDATE kanban_boards SET archived_at = ?, updated_by = ?, updated_at = ? WHERE name = ?').run(now, by, now, name);
    return { ok: true, board: mustGetBoard(d, name) };
  });
}

/** Move a chat onto a board (spec §16): its new tasks go there, and its list shows that board. */
export function useBoard(db: Db, at: ChatAt, name: string, by: string, now: number): Result<{ board: BoardRow }> {
  return tx(db, (d) => {
    const live = liveBoard(d, name);
    if (!live.ok) return live;
    d.prepare(
      `INSERT INTO kanban_chat_boards (channel, account_id, conversation_id, board, set_by, set_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, account_id, conversation_id)
       DO UPDATE SET board = excluded.board, set_by = excluded.set_by, set_at = excluded.set_at`,
    ).run(at.channel, at.appId, at.conversationId, name, by, now);
    return { ok: true, board: live.board };
  });
}

// ---------------------------------------------------------------------------
// Creating tasks, and comments
// ---------------------------------------------------------------------------
```

In `src/db/kanban.ts`, replace:

```ts
  maxRuntimeS?: number | null;
  createdBy: string;
  createdVia: CreatedVia;
}
```

with:

```ts
  maxRuntimeS?: number | null;
  createdBy: string;
  createdVia: CreatedVia;
  /** The board it goes on (spec §16); `default` unless given. */
  board?: string;
}
```

In `src/db/kanban.ts`, replace:

```ts
    const parents = [...new Set(t.parents ?? [])];
    for (const parent of parents) {
      if (getTask(d, parent) === undefined) return refuse('not_found', `no task ${parent} to be a parent`);
    }
```

with:

```ts
    const board = t.board ?? DEFAULT_BOARD;
    const live = liveBoard(d, board);
    if (!live.ok) return refuse(live.code, `${live.message}; no task is added to it`);
    const parents = [...new Set(t.parents ?? [])];
    for (const parent of parents) {
      if (getTask(d, parent) === undefined) return refuse('not_found', `no task ${parent} to be a parent`);
    }
```

In `src/db/kanban.ts`, replace:

```ts
          workspace, phase, priority, idempotency_key, failure_limit, retry_on_crash,
          max_runtime_s, created_by, created_via, created_at, created_from_task)
       VALUES (?, ?, ?, jsonb(?), ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, jsonb(?), ?, ?)`,
```

with:

```ts
          workspace, phase, priority, idempotency_key, failure_limit, retry_on_crash,
          max_runtime_s, created_by, created_via, created_at, created_from_task, board)
       VALUES (?, ?, ?, jsonb(?), ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, jsonb(?), ?, ?, ?)`,
```

In `src/db/kanban.ts`, replace:

```ts
      JSON.stringify(t.createdVia),
      now,
      createdFromTask,
    );
```

with:

```ts
      JSON.stringify(t.createdVia),
      now,
      createdFromTask,
      board,
    );
```

In `src/db/kanban.ts`, replace:

```ts
          parents,
          createdFromTask,
        },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), existing: false };
```

with:

```ts
          parents,
          createdFromTask,
          board,
        },
      },
      now,
    );
    return { ok: true, task: mustGet(d, taskId), existing: false };
```

In `src/db/kanban.ts`, replace:

```ts
  'packageHash',
  'seedDropped',
]);
```

with:

```ts
  'packageHash',
  'seedDropped',
  'board',
]);
```

In `src/db/WRITERS.md`, replace:

```markdown
| `people` | `db/people.ts` | One row per person per bot (migration 005): the open_id and name Lark last gave with a union_id, noted when a person sends a `/kanban` command, is mentioned in one, or presses a board card's button. How a person named by `lark:<union_id>` alone is checked for talk tier (spec §4.2). |
```

with:

```markdown
| `kanban_boards` | `db/kanban.ts` | Added by `createBoard` (migration 006 adds `default`); `max_running` and `workspace` set by `setBoard`, `archived_at` once by `archiveBoard`. Never deleted, never renamed: a task keeps the name of its board (spec §16). |
| `kanban_chat_boards` | `db/kanban.ts` | One row per conversation and bot, written by `useBoard`; a chat with none is on `default`. |
| `people` | `db/people.ts` | One row per person per bot (migration 005): the open_id and name Lark last gave with a union_id, noted when a person sends a `/kanban` command, is mentioned in one, or presses a board card's button. How a person named by `lark:<union_id>` alone is checked for talk tier (spec §4.2). |
```

In `src/db/WRITERS.md`, replace:

```markdown
| `kanban_tasks` | `db/kanban.ts` | `phase` is written only by its named transitions, each of which checks the current phase (spec §4.1). `workspace` is written once, while null. |
```

with:

```markdown
| `kanban_tasks` | `db/kanban.ts` | `phase` is written only by its named transitions, each of which checks the current phase (spec §4.1). `workspace` is written once, while null. `board` (migration 006) is set at the insert and never changed. |
```

- [ ] **Step 2.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1385 passed (1385)`. Run `npx vitest run --project e2e`. Expected: `Tests  98 passed (98)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.5: Commit.**

```bash
git add src/db/kanban.ts src/db/kanban-read.ts src/db/WRITERS.md tests/kanban-boards.test.ts
git commit -m "Create, set and archive boards, and move a chat onto one, in the board's writer; create a task on a board, refusing one that does not exist or is archived; never archive default, nor a board with unfinished tasks"
```

---

### Task 3: A board's tasks stay on it

**Files:**
- Create: `tests/kanban-board-isolation.test.ts`
- Modify: `src/db/kanban.ts`

A parent and its child are on one board, whether linked at creation, by `link`, or by a dependency block, all of which go through `createTask` or `linkIn`; and a task a run creates is on its run's task's board, whatever it asks (Decision 8). A chat's idempotency key that a task on another board was created with is not a repeat, and is refused rather than answered with that task (Decision 21). Each is refused `other_board` in the writer's transaction, so nothing is half written.

- [ ] **Step 3.1: Write the failing tests.**

Create `tests/kanban-board-isolation.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveBoard, block, createBoard, createTask, link } from '../src/db/kanban.js';
import { boardList, eventsOf, getRun, getTask, parentsOf } from '../src/db/kanban-read.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * A board's tasks stay on it (spec §16): a parent and its child are on one
 * board, whether linked at creation, by a link, or by a dependency block; and a
 * task a run creates goes on its run's task's board.
 */

let h: TestDb;

beforeEach(() => {
  h = testDb();
  for (const name of ['web-app', 'billing']) {
    const r = createBoard(h.db, name, ALICE, NOW);
    if (!r.ok) throw new Error(r.message);
  }
});

afterEach(() => h.close());

function taskCount(): number {
  return h.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_tasks').get()?.n ?? -1;
}

describe('creating a task on a board', () => {
  it('puts it on the board given, and refuses one that does not exist or is archived, writing nothing', () => {
    const made = newTask(h.db, { board: 'web-app' });
    expect(made.board).toBe('web-app');
    // Its created event records the board, as it records the workspace.
    expect(eventsOf(h.db, made.taskId)[0]?.payload).toMatchObject({ board: 'web-app' });
    const before = taskCount();
    expect(createTask(h.db, { title: 'x', board: 'nowhere', createdBy: ALICE, createdVia: VIA }, NOW)).toMatchObject({
      ok: false,
      code: 'unknown_board',
    });
    const old = createBoard(h.db, 'old', ALICE, NOW);
    expect(old.ok && archiveBoard(h.db, 'old', ALICE, NOW).ok).toBe(true);
    const r = createTask(h.db, { title: 'x', board: 'old', createdBy: ALICE, createdVia: VIA }, NOW);
    expect(r).toMatchObject({ ok: false, code: 'board_archived' });
    expect(r.ok ? '' : r.message).toBe('board old is archived; no task is added to it');
    expect(taskCount()).toBe(before);
  });

  it('refuses a parent on another board, writing nothing', () => {
    const parent = newTask(h.db, { board: 'web-app' });
    const before = taskCount();
    const r = createTask(
      h.db,
      { title: 'child', board: 'billing', parents: [parent.taskId], createdBy: ALICE, createdVia: VIA },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, code: 'other_board' });
    expect(r.ok ? '' : r.message).toBe(
      `task ${parent.taskId} is on board web-app, not billing: a task and its parents are on one board`,
    );
    expect(taskCount()).toBe(before);
    expect(newTask(h.db, { board: 'web-app', parents: [parent.taskId] }).board).toBe('web-app');
  });

  it('refuses a key a task on another board was created with, and returns that task on its own board', () => {
    const first = newTask(h.db, { board: 'web-app', idempotencyKey: 'lark:om_1' });
    const before = taskCount();
    const again = createTask(h.db, { title: 'x', board: 'billing', idempotencyKey: 'lark:om_1', createdBy: ALICE, createdVia: VIA }, NOW);
    expect(again).toMatchObject({ ok: false, code: 'other_board' });
    expect(again.ok ? '' : again.message).toBe(
      `task ${first.taskId} was created with this idempotency key on board web-app, not billing`,
    );
    expect(createTask(h.db, { title: 'x', board: 'web-app', idempotencyKey: 'lark:om_1', createdBy: ALICE, createdVia: VIA }, NOW)).toMatchObject({
      ok: true,
      existing: true,
      task: { taskId: first.taskId },
    });
    expect(taskCount()).toBe(before);
  });

  it("puts a task a run creates on its run's task's board, whatever it asks for", () => {
    const task = newTask(h.db, { board: 'web-app' });
    const run = claimed(h.db, task.taskId);
    const r = createTask(
      h.db,
      { title: 'follow-up', board: 'billing', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } },
      NOW,
    );
    expect(r).toMatchObject({ ok: true, task: { board: 'web-app', createdFromTask: task.taskId } });
  });
});

describe('links across boards', () => {
  it('refuses a link between tasks on two boards, and makes one on a board', () => {
    const web = newTask(h.db, { board: 'web-app' });
    const billing = newTask(h.db, { board: 'billing' });
    const r = link(h.db, web.taskId, billing.taskId, ALICE, NOW);
    expect(r).toMatchObject({ ok: false, code: 'other_board' });
    expect(link(h.db, billing.taskId, web.taskId, ALICE, NOW)).toMatchObject({ ok: false, code: 'other_board' });
    expect(parentsOf(h.db, billing.taskId)).toEqual([]);
    const next = newTask(h.db, { board: 'web-app' });
    expect(link(h.db, web.taskId, next.taskId, ALICE, NOW)).toEqual({ ok: true, added: true });
  });

  it("refuses a dependency block naming a task on another board, and leaves the run undecided", () => {
    const task = newTask(h.db, { board: 'web-app' });
    const elsewhere = newTask(h.db, { board: 'billing' });
    const run = claimed(h.db, task.taskId);
    const r = block(
      h.db,
      task.taskId,
      { kind: 'run', runId: run.runId },
      { kind: 'dependency', reason: 'needs billing first', parents: [elsewhere.taskId] },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, code: 'other_board' });
    expect(getRun(h.db, run.runId)?.outcome).toBeNull();
    expect(getTask(h.db, task.taskId)?.phase).toBe('open');
  });
});

describe('a board’s list', () => {
  it('holds only its own tasks, and every task without a board given', () => {
    const a = newTask(h.db, { title: 'on default' });
    const b = newTask(h.db, { title: 'on web-app', board: 'web-app' });
    expect(boardList(h.db, 'web-app').map((e) => e.task.taskId)).toEqual([b.taskId]);
    expect(boardList(h.db, 'default').map((e) => e.task.taskId)).toEqual([a.taskId]);
    expect(boardList(h.db, 'billing')).toEqual([]);
    expect(boardList(h.db).map((e) => e.task.taskId)).toEqual([a.taskId, b.taskId]);
  });
});
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-board-isolation.test.ts`. Expected: `Tests  5 failed | 2 passed (7)`: a parent, a link, a dependency block and a key cross boards, and the run's follow-up lands where it asked.

- [ ] **Step 3.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
      const existing = getTaskByKey(d, t.idempotencyKey);
      if (existing !== undefined) return { ok: true, task: existing, existing: true };
```

with:

```ts
      const existing = getTaskByKey(d, t.idempotencyKey);
      // A chat's key on another board is not a repeat: answering with that board's task would cross boards (spec §16.5).
      // A run's key is namespaced by its task, so a repeat is always on that task's board.
      const asked = t.board ?? DEFAULT_BOARD;
      if (existing !== undefined && t.createdVia.kind === 'chat' && existing.board !== asked) {
        return refuse(
          'other_board',
          `task ${existing.taskId} was created with this idempotency key on board ${existing.board}, not ${asked}`,
        );
      }
      if (existing !== undefined) return { ok: true, task: existing, existing: true };
```

In `src/db/kanban.ts`, replace:

```ts
    const board = t.board ?? DEFAULT_BOARD;
    const live = liveBoard(d, board);
    if (!live.ok) return refuse(live.code, `${live.message}; no task is added to it`);
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
```

with:

```ts
    let createdFromTask: string | null = null;
    let board = t.board ?? DEFAULT_BOARD;
    if (t.createdVia.kind === 'run') {
      const run = getRun(d, t.createdVia.runId);
      if (run === undefined) return refuse('not_found', `no run ${t.createdVia.runId}`);
      createdFromTask = run.taskId;
      // A run's follow-ups stay on its task's board, whatever it asked for (spec §16).
      board = mustGet(d, run.taskId).board;
    }
    const live = liveBoard(d, board);
    if (!live.ok) return refuse(live.code, `${live.message}; no task is added to it`);
    const parents = [...new Set(t.parents ?? [])];
    for (const parent of parents) {
      const p = getTask(d, parent);
      if (p === undefined) return refuse('not_found', `no task ${parent} to be a parent`);
      if (p.board !== board) return refuse('other_board', onOtherBoard(parent, p.board, board));
    }
```

In `src/db/kanban.ts`, replace:

```ts
/** A board that exists and is not archived: what a task is added to, and a chat moved onto. */
```

with:

```ts
/** Why a parent cannot hold back a child on another board (spec §16). */
function onOtherBoard(parentId: string, parentBoard: string, childBoard: string): string {
  return `task ${parentId} is on board ${parentBoard}, not ${childBoard}: a task and its parents are on one board`;
}

/** A board that exists and is not archived: what a task is added to, and a chat moved onto. */
```

In `src/db/kanban.ts`, replace:

```ts
  blockingRun?: string,
): Result<{ added: boolean }> {
  if (getTask(d, parentId) === undefined) return refuse('not_found', `no task ${parentId}`);
  if (parentId === childId) return refuse('cycle', `task ${childId} cannot be its own parent`);
  if (linked(d, parentId, childId)) return { ok: true, added: false };
```

with:

```ts
  blockingRun?: string,
): Result<{ added: boolean }> {
  const parent = getTask(d, parentId);
  if (parent === undefined) return refuse('not_found', `no task ${parentId}`);
  if (parentId === childId) return refuse('cycle', `task ${childId} cannot be its own parent`);
  if (linked(d, parentId, childId)) return { ok: true, added: false };
  // Boards are separate queues: a task on one never waits for a task on another (spec §16).
  const child = mustGet(d, childId);
  if (parent.board !== child.board) return refuse('other_board', onOtherBoard(parentId, parent.board, child.board));
```

- [ ] **Step 3.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1392 passed (1392)`. Run `npx vitest run --project e2e`. Expected: `Tests  98 passed (98)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.5: Commit.**

```bash
git add src/db/kanban.ts tests/kanban-board-isolation.test.ts
git commit -m "Keep a board's tasks on it: refuse a parent, a link or a dependency block across boards, and put a task a run creates on its run's task's board"
```

---

### Task 4: A board's workspace

**Files:**
- Create: `tests/kanban-board-workspace.test.ts`
- Modify: `src/kanban/workspace.ts`, `src/db/kanban.ts`

Spec §2.3's rule 4 becomes the board's workspace, else `default` (Decision 6). The claim reads the board in its transaction; `resolveTaskWorkspace` stays pure, given it as one more fact.

- [ ] **Step 4.1: Write the failing tests.**

Create `tests/kanban-board-workspace.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claim, closeRun, complete, createBoard, createTask, setBoard } from '../src/db/kanban.js';
import { getTask } from '../src/db/kanban-read.js';
import { resolveTaskWorkspace } from '../src/kanban/workspace.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, WORKSPACES, claimantFor, claimed, newTask } from './helpers/kanban.js';

/**
 * A board's workspace (spec §16) is where its tasks work when nothing else says:
 * it takes the place of `default` in spec §2.3's rule 4, and of nothing before it.
 */

let h: TestDb;

beforeEach(() => {
  h = testDb();
  const made = createBoard(h.db, 'docs-site', ALICE, NOW);
  const set = setBoard(h.db, 'docs-site', { workspace: 'docs' }, ALICE, NOW);
  if (!made.ok || !set.ok) throw new Error('no board');
});

afterEach(() => h.close());

describe('resolveTaskWorkspace with a board workspace', () => {
  it('uses it last, in place of default, and never over a conflict', () => {
    const facts = { own: null, roleWorkspace: undefined, upstream: [], boardWorkspace: 'docs' };
    expect(resolveTaskWorkspace(facts)).toEqual({ workspace: 'docs' });
    expect(resolveTaskWorkspace({ ...facts, upstream: ['web'] })).toEqual({ workspace: 'web' });
    expect(resolveTaskWorkspace({ ...facts, roleWorkspace: 'api' })).toEqual({ workspace: 'api' });
    expect(resolveTaskWorkspace({ ...facts, own: 'web' })).toEqual({ workspace: 'web' });
    expect(resolveTaskWorkspace({ ...facts, upstream: ['web', 'api'] })).toEqual({ conflict: ['api', 'web'] });
    expect(resolveTaskWorkspace({ ...facts, boardWorkspace: null })).toEqual({ workspace: 'default' });
  });
});

describe('a claim on a board with a workspace', () => {
  it("fixes the board's workspace on a task nothing else places, for an agent and for a person", () => {
    const agent = newTask(h.db, { board: 'docs-site' });
    expect(claimed(h.db, agent.taskId).workspace).toBe('docs');
    const person = newTask(h.db, { board: 'docs-site', assignee: { kind: 'human', name: ALICE } });
    expect(claimed(h.db, person.taskId).workspace).toBe('docs');
    expect(getTask(h.db, person.taskId)?.workspace).toBe('docs');
  });

  it("leaves a task's own workspace, its role's, and its parents' before the board's", () => {
    const own = newTask(h.db, { board: 'docs-site', workspace: 'web' });
    expect(claimed(h.db, own.taskId).workspace).toBe('web');
    const role = newTask(h.db, { board: 'docs-site' });
    expect(claimed(h.db, role.taskId, { roleWorkspace: 'api' }).workspace).toBe('api');
    const parent = newTask(h.db, { board: 'docs-site', workspace: 'default' });
    const run = claimed(h.db, parent.taskId);
    expect(complete(h.db, parent.taskId, { kind: 'run', runId: run.runId }, { summary: 'ok' }, NOW).ok).toBe(true);
    expect(closeRun(h.db, run.runId, NOW).ok).toBe(true);
    const child = newTask(h.db, { board: 'docs-site', parents: [parent.taskId] });
    expect(claimed(h.db, child.taskId).workspace).toBe('default');
  });

  it("makes an agent task unassignable once the board's workspace is no longer configured", () => {
    const task = newTask(h.db, { board: 'docs-site' });
    const configured = new Set([...WORKSPACES].filter((w) => w !== 'docs'));
    const r = claim(h.db, { taskId: task.taskId, claimant: claimantFor(h.db, task.taskId), workspaces: configured }, NOW);
    expect(r).toMatchObject({ ok: false, code: 'unassignable' });
    expect(getTask(h.db, task.taskId)?.workspace).toBeNull();
  });

  it('places nothing on another board, default included', () => {
    const task = createTask(h.db, { title: 'x', assignee: { kind: 'role', name: 'implementer' }, createdBy: ALICE, createdVia: VIA }, NOW);
    expect(task.ok && claimed(h.db, task.task.taskId).workspace).toBe('default');
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-board-workspace.test.ts`. Expected: `Tests  3 failed | 2 passed (5)`: the board's workspace is not used yet, so tasks land in `default`.

- [ ] **Step 4.3: Implement.**

In `src/kanban/workspace.ts`, replace:

```ts
 * 3. its parents' -- or, with no parents, the task it was created from -- if
 *    those with a fixed workspace all share one;
 * 4. `default`.
```

with:

```ts
 * 3. its parents' -- or, with no parents, the task it was created from -- if
 *    those with a fixed workspace all share one;
 * 4. its board's workspace, if the board names one (spec §16); else `default`.
```

In `src/kanban/workspace.ts`, replace:

```ts
  upstream: readonly (string | null)[];
}
```

with:

```ts
  upstream: readonly (string | null)[];
  /** The workspace of the task's board, if it names one: rule 4 in place of `default`. */
  boardWorkspace?: string | null;
}
```

In `src/kanban/workspace.ts`, replace:

```ts
  if (fixed.length > 1) return { conflict: fixed };
  return { workspace: DEFAULT_WORKSPACE };
```

with:

```ts
  if (fixed.length > 1) return { conflict: fixed };
  return { workspace: f.boardWorkspace ?? DEFAULT_WORKSPACE };
```

In `src/db/kanban.ts`, replace:

```ts
        upstream: parents.length > 0 ? parents.map((p) => p.workspace) : from === undefined ? [] : [from.workspace],
      });
```

with:

```ts
        upstream: parents.length > 0 ? parents.map((p) => p.workspace) : from === undefined ? [] : [from.workspace],
        boardWorkspace: getBoard(d, task.board)?.workspace ?? null,
      });
```

- [ ] **Step 4.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1397 passed (1397)`. Run `npx vitest run --project e2e`. Expected: `Tests  98 passed (98)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.5: Commit.**

```bash
git add src/kanban/workspace.ts src/db/kanban.ts tests/kanban-board-workspace.test.ts
git commit -m "Use a board's workspace for its tasks that nothing else places, in place of default, as the last rule a claim applies"
```

---

### Task 5: Boards through the service

**Files:**
- Create: `tests/kanban-board-service.test.ts`
- Modify: `src/kanban/service.ts`, `src/names.ts`

What the rows cannot check: a board's name is in the grammar of roles and workspaces; its `max_running` is from 1 to the gateway's, which the service is now told (`maxRunning`); its workspace is configured. And the board of a chat, of a new task, and of a done task's follow-up.

- [ ] **Step 5.1: Write the failing tests.**

Create `tests/kanban-board-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { complete } from '../src/db/kanban.js';
import { KanbanService, type CreateRequest } from '../src/kanban/service.js';
import type { ChatAt } from '../src/kanban/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, WORKSPACES, claimed } from './helpers/kanban.js';

/**
 * Boards through the service (spec §16): the names it accepts, the limits a
 * board may set, the board each chat is on, and the board a task is created on.
 */

let h: TestDb;
let s: KanbanService;
const CHAT: ChatAt = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat' };

beforeEach(() => {
  h = testDb();
  s = new KanbanService({
    db: h.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(NOW),
    maxRunning: 4,
  });
});

afterEach(() => h.close());

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

function request(extra: Partial<CreateRequest> = {}): CreateRequest {
  return { title: 'a task', assignee: 'implementer', createdBy: ALICE, createdVia: VIA, ...extra };
}

describe('KanbanService: creating a board', () => {
  it('takes a name in the grammar of roles and workspaces, and refuses any other', () => {
    expect(ok(s.createBoard('web-app', ALICE)).board.name).toBe('web-app');
    for (const name of ['Web', 'a/b', '../x', 'x-', 'lark:x', '', '1st', 'a'.repeat(41)]) {
      expect(s.createBoard(name, ALICE)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(s.createBoard(3 as unknown as string, ALICE)).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('KanbanService: a board’s own settings', () => {
  it("takes a max_running from 1 to the gateway's, and none", () => {
    ok(s.createBoard('web-app', ALICE));
    expect(ok(s.setBoard('web-app', { maxRunning: 4 }, ALICE)).board.maxRunning).toBe(4);
    for (const n of [0, 5, 1.5, -1]) {
      const r = s.setBoard('web-app', { maxRunning: n }, ALICE);
      expect(r).toMatchObject({ ok: false, code: 'invalid' });
      expect(r.ok ? '' : r.message).toContain("the gateway's kanban.max_running, 4");
    }
    expect(ok(s.setBoard('web-app', { maxRunning: null }, ALICE)).board.maxRunning).toBeNull();
  });

  it('takes a configured workspace, and none', () => {
    ok(s.createBoard('web-app', ALICE));
    expect(ok(s.setBoard('web-app', { workspace: 'web' }, ALICE)).board.workspace).toBe('web');
    expect(s.setBoard('web-app', { workspace: 'elsewhere' }, ALICE)).toMatchObject({ ok: false, code: 'unknown_workspace' });
    expect(s.setBoard('web-app', { workspace: '/tmp' }, ALICE)).toMatchObject({ ok: false, code: 'unknown_workspace' });
    expect(ok(s.setBoard('web-app', { workspace: null }, ALICE)).board.workspace).toBeNull();
  });
});

describe('KanbanService: the board a chat is on', () => {
  it('is default until the chat uses another, and refuses one archived', () => {
    expect(s.chatBoard(CHAT).name).toBe('default');
    ok(s.createBoard('web-app', ALICE));
    ok(s.useBoard(CHAT, 'web-app', ALICE));
    expect(s.chatBoard(CHAT).name).toBe('web-app');
    ok(s.createBoard('old', ALICE));
    ok(s.archiveBoard('old', ALICE));
    expect(s.useBoard(CHAT, 'old', ALICE)).toMatchObject({ ok: false, code: 'board_archived' });
    expect(s.useBoard(CHAT, 'Web', ALICE)).toMatchObject({ ok: false, code: 'unknown_board' });
    expect(s.chatBoard(CHAT).name).toBe('web-app');
  });
});

describe('KanbanService: tasks on a board', () => {
  it('creates a task on the board asked for, and lists only that board', () => {
    ok(s.createBoard('web-app', ALICE));
    const web = ok(s.create(request({ board: 'web-app' }))).task;
    const plain = ok(s.create(request())).task;
    expect([web.board, plain.board]).toEqual(['web-app', 'default']);
    expect(s.list('web-app').map((e) => e.task.taskId)).toEqual([web.taskId]);
    expect(s.list().map((e) => e.task.taskId)).toEqual([web.taskId, plain.taskId]);
    expect(s.create(request({ board: 'nowhere' }))).toMatchObject({ ok: false, code: 'unknown_board' });
    expect(s.create(request({ board: 7 as unknown as string }))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it("puts a done task's follow-up on its board, and refuses another", () => {
    ok(s.createBoard('web-app', ALICE));
    const done = ok(s.create(request({ board: 'web-app' }))).task;
    const run = claimed(h.db, done.taskId);
    ok(complete(h.db, done.taskId, { kind: 'run', runId: run.runId }, { summary: 'ok' }, NOW));
    expect(ok(s.followUp(done.taskId, request({ title: 'more' }))).task.board).toBe('web-app');
    expect(s.followUp(done.taskId, request({ title: 'more', board: 'default' }))).toMatchObject({ ok: false, code: 'other_board' });
  });

  it('lists the boards with their tasks by phase', () => {
    ok(s.createBoard('web-app', ALICE));
    ok(s.create(request({ board: 'web-app' })));
    expect(s.boards().map((b) => [b.board.name, b.counts.open])).toEqual([
      ['default', 0],
      ['web-app', 1],
    ]);
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-board-service.test.ts`. Expected: `Tests  7 failed (7)`, with `TypeError: s.createBoard is not a function`.

- [ ] **Step 5.3: Implement.**

In `src/names.ts`, replace:

```ts
/** Why `name` is not a valid role or workspace name, or undefined if it is. */
export function nameProblem(kind: 'role' | 'workspace', name: string): string | undefined {
```

with:

```ts
/** Why `name` is not a valid role, workspace or board name, or undefined if it is. */
export function nameProblem(kind: 'role' | 'workspace' | 'board', name: string): string | undefined {
```

In `src/kanban/service.ts`, replace:

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

with:

```ts
import {
  boardList,
  boardSummaries,
  cardReading,
  chatBoardOf,
  gatesOf,
  getBoard,
  getRun,
  getTask,
  runsOf,
  taskView,
  type BoardEntry,
  type BoardSummary,
  type CardReading,
  type TaskView,
} from '../db/kanban-read.js';
```

In `src/kanban/service.ts`, replace:

```ts
import { buildEnv } from '../driver/env.js';
```

with:

```ts
import { buildEnv } from '../driver/env.js';
import { nameProblem } from '../names.js';
```

In `src/kanban/service.ts`, replace:

```ts
  BLOCK_KINDS,
  CONTRACT_FIELDS,
  GATE_LIMITS,
  type AgentSnapshot,
  type Assignee,
  type CommentRow,
```

with:

```ts
  BLOCK_KINDS,
  CONTRACT_FIELDS,
  DEFAULT_BOARD,
  GATE_LIMITS,
  type AgentSnapshot,
  type Assignee,
  type BoardRow,
  type ChatAt,
  type CommentRow,
```

In `src/kanban/service.ts`, replace:

```ts
   * alone -- no commit is read, and a task with gates cannot complete.
   */
  checks?: ReportChecks;
}
```

with:

```ts
   * alone -- no commit is read, and a task with gates cannot complete.
   */
  checks?: ReportChecks;
  /**
   * The gateway's `kanban.max_running`: a board's own may not be above it (spec
   * §16). Absent -- tests of the board alone -- a board's is not bounded.
   */
  maxRunning?: number;
}
```

In `src/kanban/service.ts`, replace:

```ts
  maxRuntimeS?: number;
  createdBy: string;
  createdVia: CreatedVia;
}

/** A claim, with what was read for it. */
```

with:

```ts
  maxRuntimeS?: number;
  createdBy: string;
  createdVia: CreatedVia;
  /** The board it goes on (spec §16): chat's is the chat's board. A run's task's follow-ups go on its board, whatever this says. */
  board?: string;
}

/** A claim, with what was read for it. */
```

In `src/kanban/service.ts`, replace:

```ts
  readonly #checks: ReportChecks | undefined;
  /**
```

with:

```ts
  readonly #checks: ReportChecks | undefined;
  readonly #maxRunning: number;
  /**
```

In `src/kanban/service.ts`, replace:

```ts
    this.#checks = deps.checks;
  }
```

with:

```ts
    this.#checks = deps.checks;
    this.#maxRunning = deps.maxRunning ?? Number.MAX_SAFE_INTEGER;
  }

  /**
   * A new board (spec §16), named in the grammar of roles and workspaces: a name
   * typed in chat, kept in the database, and never renamed.
   */
  createBoard(name: string, by: string): Result<{ board: BoardRow }> {
    if (!isText(name)) return board.refuse('invalid', 'a board is a name, as text');
    const problem = nameProblem('board', name);
    if (problem !== undefined) return board.refuse('invalid', problem);
    return board.createBoard(this.#db, name, by, this.#clock.now());
  }

  /**
   * A board's own max_running, from 1 to the gateway's, or its workspace, a
   * configured one; null clears either (spec §16).
   */
  setBoard(name: string, change: board.BoardChange, by: string): Result<{ board: BoardRow }> {
    if (!isText(name) || typeof change !== 'object' || change === null) {
      return board.refuse('invalid', 'a board is a name, and a change an object');
    }
    const { maxRunning, workspace } = change;
    const within = (n: number) => Number.isSafeInteger(n) && n >= 1 && n <= this.#maxRunning;
    if (maxRunning !== undefined && maxRunning !== null && !within(maxRunning)) {
      return board.refuse(
        'invalid',
        `a board's max_running is a whole number from 1 to the gateway's kanban.max_running, ${this.#maxRunning}`,
      );
    }
    if (workspace !== undefined && workspace !== null && (!isText(workspace) || !this.#workspaces.has(workspace))) {
      return board.refuse('unknown_workspace', `workspace ${JSON.stringify(workspace)} is not configured`);
    }
    return board.setBoard(this.#db, name, change, by, this.#clock.now());
  }

  /** Archive a board whose tasks are all done or archived; never `default` (spec §16). */
  archiveBoard(name: string, by: string): Result<{ board: BoardRow }> {
    if (!isText(name)) return board.refuse('invalid', 'a board is a name, as text');
    return board.archiveBoard(this.#db, name, by, this.#clock.now());
  }

  /** Move a chat onto a board: its new tasks go there, and `/kanban list` shows it (spec §16). */
  useBoard(at: ChatAt, name: string, by: string): Result<{ board: BoardRow }> {
    if (!isText(name)) return board.refuse('invalid', 'a board is a name, as text');
    return board.useBoard(this.#db, at, name, by, this.#clock.now());
  }

  /** The board a chat is on: the one it last used, else `default`. */
  chatBoard(at: ChatAt): BoardRow {
    const found = getBoard(this.#db, chatBoardOf(this.#db, at) ?? DEFAULT_BOARD);
    if (found === undefined) throw new Error(`board ${DEFAULT_BOARD} is missing: the database is not migrated`);
    return found;
  }

  /** The boards, with their tasks by phase: `/kanban boards`. `including`: a chat's own board, archived or not. */
  boards(opts: { archived?: boolean; including?: string } = {}): BoardSummary[] {
    return boardSummaries(this.#db, opts);
  }
```

In `src/kanban/service.ts`, replace:

```ts
    if (req.workspace !== undefined && !isText(req.workspace)) return board.refuse('invalid', 'a workspace is a name');
```

with:

```ts
    if (req.workspace !== undefined && !isText(req.workspace)) return board.refuse('invalid', 'a workspace is a name');
    if (req.board !== undefined && !isText(req.board)) return board.refuse('invalid', 'a board is a name');
```

In `src/kanban/service.ts`, replace:

```ts
        createdBy: req.createdBy,
        createdVia: req.createdVia,
      },
      this.#clock.now(),
    );
  }
```

with:

```ts
        createdBy: req.createdBy,
        createdVia: req.createdVia,
        ...(req.board === undefined ? {} : { board: req.board }),
      },
      this.#clock.now(),
    );
  }
```

In `src/kanban/service.ts`, replace:

```ts
   * New work on a done task is a new task with it as a parent, never a reopening
   * (spec §4.4): the done task's summary is what its children were given as their
   * handoff, and reopening it would rewrite the input to work that already ran.
   */
```

with:

```ts
   * New work on a done task is a new task with it as a parent, never a reopening
   * (spec §4.4): the done task's summary is what its children were given as their
   * handoff, and reopening it would rewrite the input to work that already ran.
   * It goes on the done task's board, as a parent and its child are on one (spec §16).
   */
```

In `src/kanban/service.ts`, replace:

```ts
    return this.create({ ...req, parents: [taskId, ...(req.parents ?? [])] });
```

with:

```ts
    return this.create({ board: done.board, ...req, parents: [taskId, ...(req.parents ?? [])] });
```

In `src/kanban/service.ts`, replace:

```ts
  /** Every task with its display status (spec §4.1): `/kanban list`. */
  list(): BoardEntry[] {
    return boardList(this.#db);
  }
```

with:

```ts
  /** Every task on a board -- or on every board -- with its display status (spec §4.1): `/kanban list`. */
  list(onBoard?: string): BoardEntry[] {
    return boardList(this.#db, onBoard);
  }
```

- [ ] **Step 5.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1404 passed (1404)`. Run `npx vitest run --project e2e`. Expected: `Tests  98 passed (98)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add src/kanban/service.ts src/names.ts tests/kanban-board-service.test.ts
git commit -m "Offer boards through the service: names in the grammar of roles and workspaces, a board's max_running inside the gateway's and its workspace a configured one, the board each chat is on, and tasks and follow-ups created and listed on a board"
```

---

### Task 6: The dispatcher takes boards in turn

**Files:**
- Create: `src/kanban/fair.ts`, `tests/kanban-board-dispatch.test.ts`
- Modify: `src/kanban/dispatcher.ts`, `src/db/kanban-read.ts`

`fairOrder` (Decision 10), pure, and the pass using it, with the board of its last agent claim remembered; and a board's own `max_running`, counted as the gateway's is, decided runs that are finishing included. The first dispatcher test would run `b1` last without the rotation: with `maxRunning` 1, the board of the task just finished must yield to the next.

- [ ] **Step 6.1: Write the failing tests.**

Create `tests/kanban-board-dispatch.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { runsOf } from '../src/db/kanban-read.js';
import { fairOrder } from '../src/kanban/fair.js';
import { completes, dispatchHarness, holds, reportComplete, until, type DispatchHarness } from './helpers/dispatch.js';
import { ALICE } from './helpers/kanban.js';

/**
 * The dispatcher and boards (spec §16): one dispatcher for every board, taking
 * them in turn, and holding each to its own max_running inside the gateway's.
 */

const open: DispatchHarness[] = [];

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function boards(h: DispatchHarness, ...names: string[]): void {
  for (const name of names) {
    const r = h.service.createBoard(name, ALICE);
    if (!r.ok) throw new Error(r.message);
  }
}

/** The titles of the tasks a driver's runs were given, in the order they started. */
function started(h: DispatchHarness, roleName: string): Array<string | undefined> {
  return h.driver(roleName).runtimes.map((r) => /k_\w+: (\w+)/.exec(r.prompts[0]?.text ?? '')?.[1]);
}

describe('fairOrder', () => {
  const t = (board: string, title: string) => ({ board, title });
  const tasks = [t('a', 'a1'), t('a', 'a2'), t('a', 'a3'), t('c', 'c1'), t('b', 'b1'), t('b', 'b2')];

  it('takes the boards in turn, by name, keeping each board’s own order', () => {
    expect(fairOrder(tasks).map((x) => x.title)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
  });

  it('starts with the board after the one given, wrapping round', () => {
    expect(fairOrder(tasks, 'a').map((x) => x.title)).toEqual(['b1', 'c1', 'a1', 'b2', 'a2', 'a3']);
    expect(fairOrder(tasks, 'c').map((x) => x.title)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
    expect(fairOrder(tasks, 'bz').map((x) => x.title)).toEqual(['c1', 'a1', 'b1', 'a2', 'b2', 'a3']);
    expect(fairOrder([], 'a')).toEqual([]);
  });
});

describe('Dispatcher: boards in turn', () => {
  it("does not let one board's burst starve another", async () => {
    const h = harness({ settings: { maxRunning: 1 } });
    boards(h, 'alpha', 'beta');
    for (const title of ['a1', 'a2', 'a3']) {
      h.create({ title, workspace: 'web', board: 'alpha' });
      h.clock.advance(1);
    }
    h.create({ title: 'b1', workspace: 'web', board: 'beta' });
    const implementer = h.driver('implementer');
    for (let i = 0; i < 4; i += 1) completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();

    // Oldest first would have run b1 last.
    expect(started(h, 'implementer')).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  it("keeps priority within a board", async () => {
    const h = harness({ settings: { maxRunning: 1 } });
    boards(h, 'alpha');
    h.create({ title: 'old', workspace: 'web', board: 'alpha' });
    h.clock.advance(1);
    h.create({ title: 'urgent', workspace: 'web', board: 'alpha', priority: 5 });
    const implementer = h.driver('implementer');
    for (let i = 0; i < 2; i += 1) completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(started(h, 'implementer')).toEqual(['urgent', 'old']);
  });
});

describe("Dispatcher: a board's max_running", () => {
  it('opens no more agent runs on a board than its own limit, while other boards run', async () => {
    const h = harness({ settings: { maxRunning: 4 } });
    boards(h, 'alpha', 'beta');
    expect(h.service.setBoard('alpha', { maxRunning: 1 }, ALICE).ok).toBe(true);
    const first = h.create({ title: 'first', workspace: 'web', board: 'alpha' });
    h.clock.advance(1);
    const second = h.create({ title: 'second', workspace: 'api', board: 'alpha' });
    const other = h.create({ title: 'other', board: 'beta', assignee: 'docs-writer' });
    const held = holds(h.driver('implementer'));
    completes(h, h.driver('implementer'));
    const docs = holds(h.driver('docs-writer'));

    h.dispatcher.pass();
    await until(() => held.started && docs.started, 'a run on each board');
    h.dispatcher.pass();
    expect([first, second, other].map((t) => runsOf(h.t.db, t.taskId).length)).toEqual([1, 0, 1]);

    // Once alpha's run has closed, its next task is claimed.
    held.end('completed', () => reportComplete(h, h.driver('implementer')));
    docs.end('completed', () => reportComplete(h, h.driver('docs-writer')));
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, second.taskId).map((r) => r.outcome)).toEqual(['completed']);
  });

  it("is held to the gateway's max_running whatever its own says", async () => {
    const h = harness({ settings: { maxRunning: 1 } });
    boards(h, 'alpha');
    // The harness's service is not told the gateway's limit, so it lets this through.
    expect(h.service.setBoard('alpha', { maxRunning: 3 }, ALICE).ok).toBe(true);
    const one = h.create({ title: 'one', workspace: 'web', board: 'alpha' });
    const two = h.create({ title: 'two', workspace: 'api', board: 'alpha' });
    const held = holds(h.driver('implementer'));
    completes(h, h.driver('implementer'));

    h.dispatcher.pass();
    await until(() => held.started, 'the first run');
    h.dispatcher.pass();
    expect([one, two].map((t) => runsOf(h.t.db, t.taskId).length)).toEqual([1, 0]);
    held.end('completed', () => reportComplete(h, h.driver('implementer')));
    await h.dispatcher.idle();
  });
});
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-board-dispatch.test.ts`. Expected: the file fails to load, `Error: Cannot find module '../src/kanban/fair.js'`, and `Tests  no tests`.

- [ ] **Step 6.3: Implement.**

Create `src/kanban/fair.ts`:

```ts
/**
 * The order a dispatcher pass tries its claimable tasks in (spec §16): a turn
 * for each board in rotation, so a burst of tasks on one board cannot starve
 * another. Within a board, the order the tasks came in -- priority, then age --
 * is kept; across boards, priority does not count, since one board's priorities
 * say nothing about another's.
 *
 * `after` is the board of the pass's last agent claim before: this pass starts
 * with the board after it, by name, wrapping round, so the board that got the
 * last slot does not get the next one too. Pure: the dispatcher remembers
 * `after` itself.
 */
export function fairOrder<T extends { board: string }>(tasks: readonly T[], after?: string): T[] {
  const byBoard = new Map<string, T[]>();
  for (const task of tasks) {
    const queue = byBoard.get(task.board);
    if (queue === undefined) byBoard.set(task.board, [task]);
    else queue.push(task);
  }
  const names = [...byBoard.keys()].sort();
  const start = after === undefined ? 0 : names.findIndex((name) => name > after);
  const turns = start <= 0 ? names : [...names.slice(start), ...names.slice(0, start)];
  const out: T[] = [];
  for (let round = 0; out.length < tasks.length; round += 1) {
    for (const name of turns) {
      const task = byBoard.get(name)?.[round];
      if (task !== undefined) out.push(task);
    }
  }
  return out;
}
```

In `src/db/kanban-read.ts`, replace:

```ts
/**
 * Tasks a pass may try to claim (spec §6.2 step 1), highest priority first, then
```

with:

```ts
/** Open agent runs on one board's tasks: what a board's own max_running counts (spec §16). */
export function openAgentRunCountOn(db: Db, board: string): number {
  const row = db
    .prepare<[string], { n: number }>(
      `SELECT count(*) AS n FROM kanban_runs r JOIN kanban_tasks t ON t.task_id = r.task_id
        WHERE r.ended_at IS NULL AND r.assignee_kind = 'role' AND t.board = ?`,
    )
    .get(board);
  return row?.n ?? 0;
}

/**
 * Tasks a pass may try to claim (spec §6.2 step 1), highest priority first, then
```

In `src/kanban/dispatcher.ts`, replace:

```ts
import { claimableTasks, commentsOf, getRun, getTask, openAgentRunCount, openRuns, runBySession } from '../db/kanban-read.js';
```

with:

```ts
import {
  boardsOf,
  claimableTasks,
  commentsOf,
  getRun,
  getTask,
  openAgentRunCount,
  openAgentRunCountOn,
  openRuns,
  runBySession,
} from '../db/kanban-read.js';
```

In `src/kanban/dispatcher.ts`, replace:

```ts
import { classifyFailure } from './classify.js';
```

with:

```ts
import { classifyFailure } from './classify.js';
import { fairOrder } from './fair.js';
```

In `src/kanban/dispatcher.ts`, replace:

```ts
  /** What the last pass found nobody could be given, and why: the sweep's stranded candidates. */
  #unassignable = new Map<string, string>();
```

with:

```ts
  /** What the last pass found nobody could be given, and why: the sweep's stranded candidates. */
  #unassignable = new Map<string, string>();
  /** The board of the last agent claim: the next pass starts with the board after it (spec §16). */
  #lastBoard: string | undefined;
```

In `src/kanban/dispatcher.ts`, replace:

```ts
  /**
   * One pass (spec §6.2): claim what can be claimed, in order, and start each run.
   * Synchronous up to each run's first prompt, so a pass sees the runs the one
   * before it opened. Runs go on in the background; `idle()` waits for them.
   */
  pass(): void {
    if (this.#stopped) return;
    let tasks: ReturnType<typeof claimableTasks>;
    try {
      tasks = claimableTasks(this.#deps.db, this.#clock.now());
    } catch (err) {
```

with:

```ts
  /**
   * One pass (spec §6.2): claim what can be claimed, in order, and start each run.
   * Synchronous up to each run's first prompt, so a pass sees the runs the one
   * before it opened. Runs go on in the background; `idle()` waits for them.
   *
   * The boards take turns (spec §16): a task from each, then the next from each,
   * starting after the board of the last agent claim, priority and age deciding
   * only within a board. A board's own max_running holds inside the gateway's.
   */
  pass(): void {
    if (this.#stopped) return;
    let tasks: ReturnType<typeof claimableTasks>;
    let limits: Map<string, number | null>;
    try {
      tasks = fairOrder(claimableTasks(this.#deps.db, this.#clock.now()), this.#lastBoard);
      limits = new Map(boardsOf(this.#deps.db, { archived: true }).map((b) => [b.name, b.maxRunning]));
    } catch (err) {
```

In `src/kanban/dispatcher.ts`, replace:

```ts
        if (who?.kind === 'role' && openAgentRunCount(this.#deps.db) >= this.#deps.settings.maxRunning) continue;
```

with:

```ts
        if (who?.kind === 'role' && openAgentRunCount(this.#deps.db) >= this.#deps.settings.maxRunning) continue;
        const own = limits.get(task.board) ?? null;
        if (who?.kind === 'role' && own !== null && openAgentRunCountOn(this.#deps.db, task.board) >= own) continue;
```

In `src/kanban/dispatcher.ts`, replace:

```ts
        this.#track(this.#run(claimed, token));
      } catch (err) {
```

with:

```ts
        if (claimed.run.assignee.kind === 'role') this.#lastBoard = task.board;
        this.#track(this.#run(claimed, token));
      } catch (err) {
```

- [ ] **Step 6.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1410 passed (1410)`; the existing "claims by priority, then age" still passes, every task in it being on `default`. Run `npx vitest run --project e2e`. Expected: `Tests  98 passed (98)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.5: Commit.**

```bash
git add src/kanban/fair.ts src/kanban/dispatcher.ts src/db/kanban-read.ts tests/kanban-board-dispatch.test.ts
git commit -m "Let the dispatcher take boards in turn, starting after the board of its last agent claim and keeping priority within a board, so one board's burst cannot starve another, and hold each board to its own max_running inside the gateway's"
```

---

### Task 7: Parsing the board commands

**Files:**
- Create: `tests/kanban-board-chat-parse.test.ts`
- Modify: `src/kanban/chat-parse.ts`, `src/kanban/chat.ts`

`/kanban boards [all]` and `/kanban board create|use|set|archive`, pure, with their usage lines, and their tiers in `chat.ts` (Decision 3), which the typecheck needs for every verb. Until Task 8 the board verbs fall through to the help.

- [ ] **Step 7.1: Write the failing tests.**

Create `tests/kanban-board-chat-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseKanban, USAGE } from '../src/kanban/chat-parse.js';

/** `/kanban boards` and `/kanban board …` as typed (spec §16). */

describe('parseKanban: boards', () => {
  it('reads /kanban boards, with all for the archived ones too', () => {
    expect(parseKanban('boards')).toEqual({ ok: true, command: { verb: 'boards', archived: false } });
    expect(parseKanban('Boards ALL')).toEqual({ ok: true, command: { verb: 'boards', archived: true } });
    expect(parseKanban('boards web-app')).toEqual({ ok: false, usage: `Usage: \`${USAGE.boards}\`` });
  });

  it('reads create, use and archive, each with one name, kept as typed', () => {
    for (const sub of ['create', 'use', 'archive'] as const) {
      expect(parseKanban(`board ${sub} web-app`)).toEqual({ ok: true, command: { verb: `board ${sub}`, board: 'web-app' } });
      expect(parseKanban(`board ${sub.toUpperCase()} Web`)).toEqual({ ok: true, command: { verb: `board ${sub}`, board: 'Web' } });
      expect(parseKanban(`board ${sub}`)).toEqual({ ok: false, usage: `Usage: \`${USAGE[`board ${sub}`]}\`` });
      expect(parseKanban(`board ${sub} a b`)).toEqual({ ok: false, usage: `Usage: \`${USAGE[`board ${sub}`]}\`` });
    }
  });

  it('reads set: max_running a number or none, workspace a name or none', () => {
    const set = (change: object) => ({ ok: true, command: { verb: 'board set', board: 'web-app', change } });
    expect(parseKanban('board set web-app max_running 2')).toEqual(set({ maxRunning: 2 }));
    expect(parseKanban('board set web-app MAX_RUNNING None')).toEqual(set({ maxRunning: null }));
    expect(parseKanban('board set web-app workspace web')).toEqual(set({ workspace: 'web' }));
    expect(parseKanban('board set web-app workspace none')).toEqual(set({ workspace: null }));
    const refused = { ok: false, usage: `Usage: \`${USAGE['board set']}\`` };
    for (const bad of [
      'board set web-app max_running 0',
      'board set web-app max_running two',
      'board set web-app max_running 99999999999999999999',
      'board set web-app max_running',
      'board set web-app colour blue',
      'board set web-app',
      'board set web-app workspace web extra',
    ]) {
      expect(parseKanban(bad)).toEqual(refused);
    }
  });

  it('names every board command for one it does not know', () => {
    const r = parseKanban('board rename web-app site');
    expect(r.ok).toBe(false);
    for (const verb of ['board create', 'board use', 'board set', 'board archive'] as const) {
      expect(r.ok ? '' : r.usage).toContain(USAGE[verb]);
    }
  });
});
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-board-chat-parse.test.ts`. Expected: `Tests  4 failed (4)`: `boards` and `board` are unknown commands.

- [ ] **Step 7.3: Implement.**

In `src/kanban/chat-parse.ts`, replace:

```ts
  | { verb: 'gate remove'; taskId: string; gateId: number }
  | ReportCommand
  | ReviewCommand;
```

with:

```ts
  | { verb: 'gate remove'; taskId: string; gateId: number }
  | ReportCommand
  | ReviewCommand
  | { verb: 'boards'; archived: boolean }
  | BoardCommand;

/** `/kanban board …` (spec §16): a board's name as typed, which the service checks. */
export type BoardCommand =
  | { verb: 'board create' | 'board use' | 'board archive'; board: string }
  | { verb: 'board set'; board: string; change: { maxRunning?: number | null; workspace?: string | null } };
```

In `src/kanban/chat-parse.ts`, replace:

```ts
  approve: '/kanban approve <task> [comment]',
  changes: '/kanban changes <task> <reason>',
} as const;
```

with:

```ts
  approve: '/kanban approve <task> [comment]',
  changes: '/kanban changes <task> <reason>',
  boards: '/kanban boards [all]',
  'board create': '/kanban board create <name>',
  'board use': '/kanban board use <name>',
  'board set': '/kanban board set <name> max_running <number|none>, or workspace <workspace|none>',
  'board archive': '/kanban board archive <name>',
} as const;
```

In `src/kanban/chat-parse.ts`, replace:

```ts
    case 'review':
      return parseReview(rest);
    default:
```

with:

```ts
    case 'review':
      return parseReview(rest);
    case 'boards': {
      const w = words(rest, 0) ?? words(rest, 1);
      const all = w?.[0]?.toLowerCase();
      if (w === undefined || (all !== undefined && all !== 'all')) return usage('boards');
      return { ok: true, command: { verb: 'boards', archived: all === 'all' } };
    }
    case 'board':
      return parseBoard(rest);
    default:
```

In `src/kanban/chat-parse.ts`, replace:

```ts
function parseGate(text: string): ParsedKanban {
```

with:

```ts
/**
 * `/kanban board create|use|archive <name>`, and `/kanban board set <name>` with
 * `max_running <number|none>` or `workspace <workspace|none>` (spec §16).
 */
function parseBoard(text: string): ParsedKanban {
  const [rawSub, rest] = shift(text);
  const sub = rawSub.toLowerCase();
  if (sub === 'create' || sub === 'use' || sub === 'archive') {
    const verb = `board ${sub}` as const;
    const w = words(rest, 1);
    return w?.[0] === undefined ? usage(verb) : { ok: true, command: { verb, board: w[0] } };
  }
  if (sub === 'set') {
    const [board, setting, value] = words(rest, 3) ?? [];
    if (board === undefined || setting === undefined || value === undefined) return usage('board set');
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
  }
  const verbs = (['board create', 'board use', 'board set', 'board archive'] as const).map((v) => `\`${USAGE[v]}\``);
  return { ok: false, usage: `Usage: ${verbs.join(', ')}` };
}

function parseGate(text: string): ParsedKanban {
```

In `src/kanban/chat.ts`, replace:

```ts
  approve: 'talk',
  changes: 'talk',
};
```

with:

```ts
  approve: 'talk',
  changes: 'talk',
  boards: 'talk',
  // Moving a chat onto a board changes where its tasks go, and so which workspace
  // an agent may run in: an operator's, as creating a task is (spec §16).
  'board create': 'operate',
  'board use': 'operate',
  'board set': 'operate',
  'board archive': 'operate',
};
```

- [ ] **Step 7.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1414 passed (1414)`. Run `npx vitest run --project e2e`. Expected: `Tests  98 passed (98)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.5: Commit.**

```bash
git add src/kanban/chat-parse.ts src/kanban/chat.ts tests/kanban-board-chat-parse.test.ts
git commit -m "Parse /kanban boards and /kanban board create, use, set and archive, with their usage lines, at talk tier for the list and operator tier for the rest"
```

---

### Task 8: Boards in chat

**Files:**
- Create: `tests/kanban-board-chat.test.ts`
- Modify: `src/kanban/chat.ts`, `src/kanban/chat-render.ts`, `tests/kanban-chat.e2e.ts`

The commands, through the service only; `/kanban new` on the chat's board, refused on an archived one; `/kanban list` of the chat's board; `/kanban show` naming a task's board (Decision 7, Decision 18); `/kanban boards`; the help. The end-to-end test takes a chat onto a board through the router, runs its task through the real dispatcher, socket and fake CLI agent, and hears it done.

- [ ] **Step 8.1: Write the failing tests.**

Create `tests/kanban-board-chat.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardsOf, getTask } from '../src/db/kanban-read.js';
import { renderHelp } from '../src/kanban/chat-render.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import type { BindingKey, InboundMessage, Principal } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * Boards in chat (spec §16): `/kanban boards` and `/kanban board …`, each chat
 * on its own board, and `/kanban new`, `list` and `show` acting on it.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };
const TEAM: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };
const TOPIC: BindingKey = { ...TEAM, threadId: 'omt_topic' };
const OTHER: BindingKey = { ...TEAM, conversationId: 'oc_other' };

let t: TestDb;
let service: KanbanService;
let chat: KanbanChat;
let passes: number;
let seq = 0;

beforeEach(() => {
  t = testDb();
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, GUEST.openId] });
  const people = new PeopleDirectory({
    db: t.db,
    appId: 'cli_app',
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
  });
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
    people,
    maxRunning: 4,
  });
  passes = 0;
  chat = new KanbanChat({
    service,
    hasTier: (p, tier) => authorizer.hasTier(p, tier),
    people,
    appId: 'cli_app',
    changed: () => (passes += 1),
  });
});

afterEach(() => t.close());

function message(sender: Principal, key: BindingKey): InboundMessage {
  return {
    messageId: `om_${++seq}`,
    appId: key.appId,
    chatId: key.conversationId,
    chatType: 'group',
    threadId: key.threadId,
    sender,
    senderIsBot: false,
    text: '',
    mentionedBot: true,
    mentionAll: false,
    mentions: [],
    attachments: [],
    createTime: 0,
  };
}

function say(arg: string, key: BindingKey = TEAM, sender: Principal = OWNER): Promise<string> {
  return chat.run(arg, message(sender, key), key);
}

function created(reply: string): string {
  const m = /^Created `(k_[0-9a-z]+)`/.exec(reply);
  if (m?.[1] === undefined) throw new Error(`not created: ${reply}`);
  return m[1];
}

describe('/kanban boards and /kanban board create', () => {
  it('lists default, and the boards an operator creates, marking this chat’s', async () => {
    expect(await say('boards')).toBe(
      '**default** (this chat): no tasks\n' +
        '`/kanban board use <name>` moves this chat to another board; `/kanban board create <name>` makes one.',
    );
    expect(await say('board create web-app')).toBe('Created board **web-app**. `/kanban board use web-app` puts a chat on it.');
    expect((await say('boards', TEAM, GUEST)).split('\n').slice(0, 2)).toEqual(['**default** (this chat): no tasks', '**web-app**: no tasks']);
  });

  it('refuses a talk-tier sender, and a name out of the grammar, creating nothing', async () => {
    expect(await say('board create web-app', TEAM, GUEST)).toBe('`/kanban board create` changes the board, and needs operator permission.');
    expect(await say('board create Web_App')).toMatch(/^Not done: board name "Web\\_App" must be lowercase letters/);
    expect(boardsOf(t.db).map((b) => b.name)).toEqual(['default']);
  });
});

describe('/kanban board use', () => {
  it('moves this chat, all its threads, onto a board, and no other chat', async () => {
    await say('board create web-app');
    expect(await say('board use web-app', TOPIC)).toBe(
      'This chat is on board **web-app** now: its `/kanban new` adds tasks to it, and `/kanban list` shows them.',
    );
    expect(service.chatBoard({ channel: 'lark', appId: 'cli_app', conversationId: 'oc_team' }).name).toBe('web-app');
    expect(service.chatBoard({ channel: 'lark', appId: 'cli_app', conversationId: 'oc_other' }).name).toBe('default');
    expect(await say('board use web-app', TEAM, GUEST)).toBe('`/kanban board use` changes the board, and needs operator permission.');
    expect(await say('board use nowhere')).toBe('Not done: there is no board nowhere');
  });

  it("creates this chat's tasks on its board, and lists that board alone", async () => {
    await say('board create web-app');
    const plain = created(await say('new On default\nassignee: implementer', OTHER));
    await say('board use web-app');
    const reply = await say('new On the web app\nassignee: implementer\nworkspace: web');
    const taskId = created(reply);
    expect(reply).toContain(', in web, on board **web-app**. This chat hears');
    expect(getTask(t.db, taskId)?.board).toBe('web-app');
    expect(passes).toBe(2);

    expect((await say('list')).split('\n')).toEqual(['Board **web-app**:', `\`${taskId}\` **ready**: On the web app · role implementer`]);
    expect(await say('list', OTHER)).toBe(`\`${plain}\` **ready**: On default · role implementer`);
    expect(await say('list done')).toBe('No done tasks on board web-app.');
  });

  it("shows a task on any board by its id, naming its board", async () => {
    await say('board create web-app');
    const plain = created(await say('new On default\nassignee: implementer'));
    expect((await say(`show ${plain}`)).split('\n')[1]).toBe('assignee: role implementer · reviewer: nobody · workspace: not yet fixed');
    await say('board use web-app');
    expect((await say(`show ${plain}`)).split('\n')[1]).toBe(
      'assignee: role implementer · reviewer: nobody · workspace: not yet fixed · board: default',
    );
  });

  it("refuses a parent on another board", async () => {
    await say('board create web-app');
    const plain = created(await say('new On default\nassignee: implementer'));
    await say('board use web-app');
    expect(await say(`new Child\nassignee: implementer\nparent: ${plain}`)).toBe(
      `Not done: task ${plain.replace('_', '\\_')} is on board default, not web-app: a task and its parents are on one board`,
    );
  });
});

describe('/kanban board set', () => {
  it("sets a board's max_running and workspace, and looks for work", async () => {
    await say('board create web-app');
    expect(await say('board set web-app max_running 2')).toBe('Board **web-app** runs at most 2 agents at once now.');
    expect(await say('board set web-app max_running none')).toBe(
      "Board **web-app** has no max\\_running of its own now: the gateway's kanban.max\\_running holds.",
    );
    expect(await say('board set web-app workspace web')).toBe(
      "Board **web-app**'s tasks work in web now, unless their own workspace, their role's or their parents' says otherwise.",
    );
    expect(passes).toBe(3);
    expect(await say('board set web-app max_running 5')).toBe(
      "Not done: a board's max\\_running is a whole number from 1 to the gateway's kanban.max\\_running, 4",
    );
    expect(await say('board set web-app workspace nowhere')).toBe('Not done: workspace "nowhere" is not configured');
    expect(await say('board set web-app max_running 1', TEAM, GUEST)).toBe(
      '`/kanban board set` changes the board, and needs operator permission.',
    );
    expect((await say('boards')).split('\n')[1]).toBe('**web-app**: no tasks · workspace web');
  });
});

describe('/kanban board archive', () => {
  it('archives a board once its tasks are finished, and then adds nothing to it', async () => {
    await say('board create web-app');
    await say('board use web-app');
    const taskId = created(await say('new Last one\nassignee: implementer'));
    expect(await say('board archive web-app')).toBe(
      'Not done: board web-app has 1 task not yet done or archived; finish or archive it first',
    );
    await say(`archive ${taskId}`);
    expect(await say('board archive web-app')).toBe(
      'Archived board **web-app**. Its tasks stay, and `/kanban show` still shows them; nothing more is added to it.',
    );
    expect(await say('new Another\nassignee: implementer')).toBe(
      'This chat is on board **web-app**, which is archived: `/kanban board use <board>` moves it to another first.',
    );
    expect(await say('board use web-app', OTHER)).toBe('Not done: board web-app is archived');
    // A chat on an archived board still sees it, marked; another chat does not.
    expect((await say('boards')).split('\n')[1]).toBe('**web-app** (archived, this chat): no tasks');
    expect(await say('boards', OTHER)).not.toContain('**web-app**');
    expect((await say('boards all', OTHER)).split('\n')[1]).toBe('**web-app** (archived): no tasks');
    expect(await say('board archive default')).toBe('Not done: board default is where every chat starts; it is never archived');
  });
});

describe('/kanban help', () => {
  it('lists the board commands, with who may run them', () => {
    const help = renderHelp();
    expect(help).toContain('`/kanban boards [all]` (anyone allowed)');
    for (const verb of ['create <name>', 'use <name>', 'archive <name>']) {
      expect(help).toContain(`\`/kanban board ${verb}\` (operator)`);
    }
    expect(help).toContain('`/kanban board set <name> max_running <number|none>, or workspace <workspace|none>` (operator)');
    expect(help).toContain('A board is a queue of tasks of its own.');
  });
});
```

In `tests/kanban-chat.e2e.ts`, replace:

```ts
  it("an agent that crashes is retried, then given up on, and the thread hears both", async () => {
```

with:

```ts
  it("a chat on a board of its own runs its task there, hears of it, and lists that board", async () => {
    const s = await build('kanban');
    await s.router.onMessage(said('/kanban board create web-app'));
    await s.router.onMessage(said('/kanban board use web-app'));
    expect(s.lark.texts.at(-1)?.text).toContain('This chat is on board **web-app** now');
    await s.router.onMessage(said('/kanban new Write the parser\nassignee: implementer\nIt reads CSV.'));
    const taskId = createdIn(s.lark);

    await s.dispatcher.idle();
    expect(getTask(s.t.db, taskId)).toMatchObject({ board: 'web-app', phase: 'done', workspace: 'default' });
    expect(await s.notifier().deliver()).toBe(1);
    expect(s.lark.texts.at(-1)?.text).toBe(`Done: **Write the parser** \`${taskId}\`\n> did: Write the parser`);

    await s.router.onMessage(said('/kanban list all'));
    expect(s.lark.texts.at(-1)?.text).toBe(`Board **web-app**:\n\`${taskId}\` **done**: Write the parser · role implementer`);
  });

  it("an agent that crashes is retried, then given up on, and the thread hears both", async () => {
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-board-chat.test.ts`. Expected: `Tests  9 failed (9)`: the board verbs answer with the help. Run `npx vitest run --project e2e tests/kanban-chat.e2e.ts`. Expected: `Tests  1 failed | 2 passed (3)`.

- [ ] **Step 8.3: Implement.**

In `src/kanban/chat-render.ts`, replace:

```ts
import type { BoardEntry, ReviewRequest, TaskView } from '../db/kanban-read.js';
```

with:

```ts
import type { BoardEntry, BoardSummary, ReviewRequest, TaskView } from '../db/kanban-read.js';
```

In `src/kanban/chat-render.ts`, replace:

```ts
import type { Assignee, FailedGate, GateRow, KanbanEvent, RunRow, TaskRow } from './types.js';
```

with:

```ts
import { DEFAULT_BOARD, type Assignee, type FailedGate, type GateRow, type KanbanEvent, type RunRow, type TaskRow } from './types.js';
```

In `src/kanban/chat-render.ts`, replace:

```ts
    [USAGE.approve, reviewer],
    [USAGE.changes, reviewer],
  ];
```

with:

```ts
    [USAGE.approve, reviewer],
    [USAGE.changes, reviewer],
    [USAGE.boards, talk],
    [USAGE['board create'], operate],
    [USAGE['board use'], operate],
    [USAGE['board set'], operate],
    [USAGE['board archive'], operate],
  ];
```

In `src/kanban/chat-render.ts`, replace:

```ts
    'The chat a task is created in hears when it is done, needs review, blocks, is retried after a failure, gives up, or is stranded, and who a person was given it.',
  ].join('\n');
```

with:

```ts
    'The chat a task is created in hears when it is done, needs review, blocks, is retried after a failure, gives up, or is stranded, and who a person was given it.',
    "A board is a queue of tasks of its own. Each chat is on one, `default` until `/kanban board use` moves it, and its `/kanban new` and `list` act on that board; a task's follow-ups and parents are on its board.",
  ].join('\n');
```

In `src/kanban/chat-render.ts`, replace:

```ts
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
```

with:

```ts
/**
 * `/kanban list` (spec §9.1): a board by derived status, the active tasks unless a
 * filter is given. A board other than `default` is named (spec §16).
 */
export function renderList(
  entries: readonly BoardEntry[],
  filter: DisplayStatus | 'all' | undefined,
  board: string = DEFAULT_BOARD,
): string {
  const on = board === DEFAULT_BOARD ? '' : ` on board ${label(board)}`;
  const shown = entries.filter((e) =>
    filter === undefined ? ACTIVE.includes(e.status) : filter === 'all' || e.status === filter,
  );
  if (shown.length === 0) {
    return filter === undefined
      ? `No open tasks${on}. \`/kanban list all\` shows done and archived ones too.`
      : `No ${filter === 'all' ? '' : `${filter} `}tasks${on}.`;
  }
```

In `src/kanban/chat-render.ts`, replace:

```ts
  const more = ordered.length - LIST_MAX;
  if (more > 0) lines.push(`… and ${more} more. \`/kanban list <${LIST_FILTERS.join('|')}>\` narrows it.`);
  return lines.join('\n');
}
```

with:

```ts
  const more = ordered.length - LIST_MAX;
  if (more > 0) lines.push(`… and ${more} more. \`/kanban list <${LIST_FILTERS.join('|')}>\` narrows it.`);
  if (on !== '') lines.unshift(`Board **${label(board)}**:`);
  return lines.join('\n');
}

/** How many of a board's tasks are where, leaving out what is none. */
function counted(s: BoardSummary): string {
  const parts = (
    [
      [s.counts.open, 'open'],
      [s.counts.review, 'in review'],
      [s.counts.blocked, 'blocked'],
      [s.counts.done, 'done'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`);
  return parts.length === 0 ? 'no tasks' : parts.join(', ');
}

/**
 * `/kanban boards` (spec §16): each board, its tasks by phase, its own
 * max_running and workspace where it sets them, and which one this chat is on.
 */
export function renderBoards(summaries: readonly BoardSummary[], current: string): string {
  const lines = summaries.map((s) => {
    const b = s.board;
    const settings = [
      ...(b.maxRunning === null ? [] : [`max\\_running ${b.maxRunning}`]),
      ...(b.workspace === null ? [] : [`workspace ${label(b.workspace)}`]),
    ];
    const marks = [...(b.archivedAt === null ? [] : ['archived']), ...(b.name === current ? ['this chat'] : [])];
    return (
      `**${label(b.name)}**${marks.length === 0 ? '' : ` (${marks.join(', ')})`}: ${counted(s)}` +
      settings.map((x) => ` · ${x}`).join('')
    );
  });
  return [
    ...lines,
    `\`/kanban board use <name>\` moves this chat to another board; \`/kanban board create <name>\` makes one.`,
  ].join('\n');
}
```

In `src/kanban/chat-render.ts`, replace:

```ts
/** `/kanban show` (spec §9.1): the task, its contract, gates, runs, latest output and comments. */
export function renderShow(view: TaskView, gates: readonly GateRow[]): string {
  const { task } = view;
  const out: string[] = [
    `**${label(task.title)}** ${id(task.taskId)}: ${view.status}`,
    `assignee: ${who(task.assignee)} · reviewer: ${who(task.reviewer)} · workspace: ${task.workspace === null ? 'not yet fixed' : label(task.workspace)}`,
  ];
```

with:

```ts
/**
 * `/kanban show` (spec §9.1): the task, its contract, gates, runs, latest output
 * and comments. Its board is named once anything is on a board but `default`:
 * the task's, or the chat's it is shown in (spec §16).
 */
export function renderShow(view: TaskView, gates: readonly GateRow[], chatBoard: string = DEFAULT_BOARD): string {
  const { task } = view;
  const board = task.board === DEFAULT_BOARD && chatBoard === DEFAULT_BOARD ? '' : ` · board: ${label(task.board)}`;
  const out: string[] = [
    `**${label(task.title)}** ${id(task.taskId)}: ${view.status}`,
    `assignee: ${who(task.assignee)} · reviewer: ${who(task.reviewer)} · workspace: ${task.workspace === null ? 'not yet fixed' : label(task.workspace)}${board}`,
  ];
```

In `src/kanban/chat.ts`, replace:

```ts
import {
  label,
  renderCardOutcome,
```

with:

```ts
import {
  label,
  renderBoards,
  renderCardOutcome,
```

In `src/kanban/chat.ts`, replace:

```ts
import type { Assignee, PersonReportsAs, Refusal, Reporter, RunRow, TaskRow } from './types.js';
```

with:

```ts
import {
  DEFAULT_BOARD,
  type Assignee,
  type BoardRow,
  type ChatAt,
  type PersonReportsAs,
  type Refusal,
  type Reporter,
  type RunRow,
  type TaskRow,
} from './types.js';
```

In `src/kanban/chat.ts`, replace:

```ts
import { isPerson, parseKanban, type KanbanCommand, type NewTaskCommand, type ReportCommand, type ReviewCommand } from './chat-parse.js';
```

with:

```ts
import {
  isPerson,
  parseKanban,
  type BoardCommand,
  type KanbanCommand,
  type NewTaskCommand,
  type ReportCommand,
  type ReviewCommand,
} from './chat-parse.js';
```

In `src/kanban/chat.ts`, replace:

```ts
/** The board's principal for a chat sender: `lark:<union_id>`, or undefined when Lark gave none. */
```

with:

```ts
/** The chat a command came from, for the board it is on: its conversation, whatever the thread (spec §16). */
function chatAt(key: BindingKey): ChatAt {
  return { channel: key.channel, appId: key.appId, conversationId: key.conversationId };
}

/** A board, by name, as a reply names it. */
function boardName(board: BoardRow | string): string {
  return `**${label(typeof board === 'string' ? board : board.name)}**`;
}

/** The board's principal for a chat sender: `lark:<union_id>`, or undefined when Lark gave none. */
```

In `src/kanban/chat.ts`, replace:

```ts
      case 'list':
        return renderList(this.#deps.service.list(), command.filter);
      case 'show': {
        const r = this.#deps.service.show(command.taskId);
        if (!r.ok) return refused(r);
        const gates = this.#deps.service.listGates(command.taskId);
        return renderShow(r.view, gates.ok ? gates.gates : []);
      }
```

with:

```ts
      case 'list': {
        // The chat's board alone (spec §16).
        const board = this.#deps.service.chatBoard(chatAt(key)).name;
        return renderList(this.#deps.service.list(board), command.filter, board);
      }
      case 'show': {
        // A task on any board, by id, with its board named (spec §16).
        const r = this.#deps.service.show(command.taskId);
        if (!r.ok) return refused(r);
        const gates = this.#deps.service.listGates(command.taskId);
        return renderShow(r.view, gates.ok ? gates.gates : [], this.#deps.service.chatBoard(chatAt(key)).name);
      }
      case 'boards': {
        // This chat's own board is always listed, archived or not, so it is marked.
        const current = this.#deps.service.chatBoard(chatAt(key)).name;
        return renderBoards(this.#deps.service.boards({ archived: command.archived, including: current }), current);
      }
```

In `src/kanban/chat.ts`, replace:

```ts
      case 'review':
        return this.#review(command, by, message);
      default:
        return renderHelp();
    }
  }
```

with:

```ts
      case 'review':
        return this.#review(command, by, message);
      case 'board create':
      case 'board use':
      case 'board set':
      case 'board archive':
        return this.#board(command, by, key);
      default:
        return renderHelp();
    }
  }

  /** `/kanban board …` (spec §16): boards made, set and archived, and the chat moved onto one. */
  #board(command: BoardCommand, by: string, key: BindingKey): string {
    const service = this.#deps.service;
    switch (command.verb) {
      case 'board create': {
        const r = service.createBoard(command.board, by);
        if (!r.ok) return refused(r);
        return `Created board ${boardName(r.board)}. \`/kanban board use ${r.board.name}\` puts a chat on it.`;
      }
      case 'board use': {
        const r = service.useBoard(chatAt(key), command.board, by);
        if (!r.ok) return refused(r);
        return `This chat is on board ${boardName(r.board)} now: its \`/kanban new\` adds tasks to it, and \`/kanban list\` shows them.`;
      }
      case 'board set': {
        const r = service.setBoard(command.board, command.change, by);
        if (!r.ok) return refused(r);
        // A higher limit, or a workspace, can make a task claimable.
        this.#changed();
        const b = r.board;
        if (command.change.maxRunning !== undefined) {
          return b.maxRunning === null
            ? `Board ${boardName(b)} has no max\\_running of its own now: the gateway's kanban.max\\_running holds.`
            : `Board ${boardName(b)} runs at most ${b.maxRunning} agent${b.maxRunning === 1 ? '' : 's'} at once now.`;
        }
        return `Board ${boardName(b)}'s tasks work in ${label(b.workspace ?? 'default')} now, unless their own workspace, their role's or their parents' says otherwise.`;
      }
      case 'board archive': {
        const r = service.archiveBoard(command.board, by);
        if (!r.ok) return refused(r);
        return `Archived board ${boardName(r.board)}. Its tasks stay, and \`/kanban show\` still shows them; nothing more is added to it.`;
      }
    }
  }
```

In `src/kanban/chat.ts`, replace:

```ts
    const tooBig = oversized(command);
    if (tooBig !== undefined) return tooBig;
    const r = this.#deps.service.create({
```

with:

```ts
    const tooBig = oversized(command);
    if (tooBig !== undefined) return tooBig;
    // On the chat's board (spec §16).
    const board = this.#deps.service.chatBoard(chatAt(key));
    if (board.archivedAt !== null) {
      return `This chat is on board ${boardName(board)}, which is archived: \`/kanban board use <board>\` moves it to another first.`;
    }
    const r = this.#deps.service.create({
      board: board.name,
```

In `src/kanban/chat.ts`, replace:

```ts
      `Created ${id(task.taskId)}: **${label(task.title)}**, for ${whom}` +
      `${task.workspace === null ? '' : `, in ${label(task.workspace)}`}.${card} ` +
```

with:

```ts
      `Created ${id(task.taskId)}: **${label(task.title)}**, for ${whom}` +
      `${task.workspace === null ? '' : `, in ${label(task.workspace)}`}` +
      `${task.board === DEFAULT_BOARD ? '' : `, on board ${boardName(task.board)}`}.${card} ` +
```

- [ ] **Step 8.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1423 passed (1423)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.5: Commit.**

```bash
git add src/kanban/chat.ts src/kanban/chat-render.ts tests/kanban-board-chat.test.ts tests/kanban-chat.e2e.ts
git commit -m "Drive boards from chat: /kanban boards lists them, /kanban board creates, sets, archives and moves a chat onto one, and a chat's /kanban new, list and show act on its board, naming it unless it is default"
```

---

### Task 9: The worker API and the gateway

**Files:**
- Create: `tests/kanban-board-worker.test.ts`
- Modify: `src/kanban/worker.ts`, `src/index.ts`

An agent names no board (Decision 8): `mt kanban show` says which its task is on, and its `create` and `link` meet the writer's rules of Task 3, which the test proves through the worker API. The gateway gives the service its `kanban.max_running`, which `/kanban board set` is held inside.

- [ ] **Step 9.1: Write the failing tests.**

Create `tests/kanban-board-worker.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import { WorkerApi, type WorkerResponse } from '../src/kanban/worker.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * A board run's agent and boards (spec §16): it names no board. Its show says
 * which board its task is on, and what it creates goes there; a parent or a link
 * on another board is refused, as for anyone.
 */

let t: TestDb;
let service: KanbanService;
let api: WorkerApi;

beforeEach(() => {
  t = testDb();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
  api = new WorkerApi({ db: t.db, service });
  for (const name of ['web-app', 'billing']) {
    if (!service.createBoard(name, ALICE).ok) throw new Error(`no board ${name}`);
  }
});

afterEach(() => t.close());

function task(board: string): string {
  const r = service.create({ title: 'a task', assignee: 'implementer', workspace: 'web', board, createdBy: ALICE, createdVia: VIA });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task.taskId;
}

/** Claim the task's run with a token, and a way to ask as that run. */
function asRun(taskId: string): (command: string, input?: unknown) => Promise<WorkerResponse> {
  const token = mintToken();
  const r = service.claim(taskId, { tokenHash: hashToken(token) });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return (command, input = {}) => api.handle({ run: r.run.runId, token, command, input });
}

describe('worker API: boards', () => {
  it("shows the run's task's board", async () => {
    const ask = asRun(task('web-app'));
    expect(await ask('show')).toMatchObject({ ok: true, task: { board: 'web-app' } });
  });

  it("creates a follow-up on its task's board, and refuses a parent or a link on another", async () => {
    const ask = asRun(task('web-app'));
    const made = await ask('create', { title: 'follow-up', body: '', assignee: 'implementer' });
    expect(made).toMatchObject({ ok: true });
    const child = made.ok ? String(made['task_id']) : '';
    expect(getTask(t.db, child)?.board).toBe('web-app');

    const elsewhere = task('billing');
    expect(await ask('create', { title: 'x', body: '', assignee: 'implementer', parents: [elsewhere] })).toMatchObject({
      ok: false,
      code: 'other_board',
    });
    expect(await ask('link', { parent_id: elsewhere, child_id: child })).toMatchObject({ ok: false, code: 'other_board' });
  });
});
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-board-worker.test.ts`. Expected: `Tests  1 failed | 1 passed (2)`: `show` has no `board`. The second passes already, on Task 3's writer.

- [ ] **Step 9.3: Implement.**

In `src/kanban/worker.ts`, replace:

```ts
        workspace: task.workspace,
        phase: task.phase,
        status: view.status,
      },
```

with:

```ts
        workspace: task.workspace,
        phase: task.phase,
        status: view.status,
        // Read-only: what a run creates goes on this board, whatever it asks (spec §16).
        board: task.board,
      },
```

In `src/index.ts`, replace:

```ts
      // A report runs its task's gates in the workspace, and reads the commit there
      // (spec §7.7, §7.8). They get only what an agent gets of this environment.
      checks: { workspaceDirs: team.workspaces, env: process.env },
    });
```

with:

```ts
      // A report runs its task's gates in the workspace, and reads the commit there
      // (spec §7.7, §7.8). They get only what an agent gets of this environment.
      checks: { workspaceDirs: team.workspaces, env: process.env },
      // A board's own max_running is held inside the gateway's (spec §16).
      maxRunning: config.kanban.maxRunning,
    });
```

- [ ] **Step 9.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1425 passed (1425)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.5: Commit.**

```bash
git add src/kanban/worker.ts src/index.ts tests/kanban-board-worker.test.ts
git commit -m "Say which board a run's task is on in mt kanban show, and give the board's service the gateway's kanban.max_running, which a board's own is held inside"
```

---

### Task 10: The guide and the README

**Files:**
- Modify: `docs/kanban-guide.md`, `README.md`

A section on boards in the guide, for the people who drive the board from Lark, with the messages to paste; the board commands, a paragraph and two limitations in the README. The spec's §16 is already in, from this plan's own commit.

- [ ] **Step 10.1: Write.**

In `docs/kanban-guide.md`, replace:

```markdown
| Anyone at talk tier | `/kanban help`, `list`, `show`, `comment`, `gate list` |
| Operators | `/kanban new`, `assign`, `link`, `workspace`, `unblock`, `stop`, `archive`, `gate add`, `gate remove`, and every talk-tier command |
```

with:

```markdown
| Anyone at talk tier | `/kanban help`, `list`, `show`, `comment`, `gate list`, `boards` |
| Operators | `/kanban new`, `assign`, `link`, `workspace`, `unblock`, `stop`, `archive`, `gate add`, `gate remove`, `board create`, `board use`, `board set`, `board archive`, and every talk-tier command |
```

In `docs/kanban-guide.md`, replace:

```markdown
## 10. Rules of thumb
```

with:

````markdown
## 10. Boards

Several projects can share one gateway. Give each its own **board**: a queue of tasks of its
own. A board has its own list in chat, takes its turn with the dispatcher, so that a burst of
tasks on one board cannot hold up another, and may have its own limit on how many agents it runs
at once, and its own default workspace. One gateway, with one database, serves every board.

Every gateway has a board called `default`. Every task created before boards existed is on it,
and every chat starts on it. A gateway that never makes another board works as it always did.

### Making a board, and moving a chat onto it

```
/kanban board create web-app
```

> Created board **web-app**. `/kanban board use web-app` puts a chat on it.

A board's name follows the rule for role and workspace names: lowercase letters, digits and
`-`, starting with a letter, not ending with `-`, at most 40 characters. A name is never renamed
or reused, an archived board's included.

```
/kanban board use web-app
```

> This chat is on board **web-app** now: its `/kanban new` adds tasks to it, and `/kanban list`
> shows them.

A chat is the whole conversation: a group and every thread in it are on one board, and no other
chat moves with it. Keep each project's group on its project's board; a direct message with the
bot can move between boards as you need.

### What a board changes

- `/kanban new` creates the task on this chat's board. The reply names the board, unless it is
  `default`.
- `/kanban list` shows this chat's board alone, under a line naming it. `all` still means every
  status, on this board.
- `/kanban show k_…` shows a task on any board, by its id, and names its board once any board
  but `default` is involved.
- Every other command that names a task (`assign`, `comment`, `approve` and the rest) works on
  a task on any board, by its id. The commands a notice gives, and its Unblock button, keep
  working after the chat has moved.
- A task's follow-ups stay on its board: those its agent creates with `mt kanban create`, and
  those a done task is given.
- `parent:` and `/kanban link` cannot cross boards:

  > Not done: task k\_… is on board default, not web-app: a task and its parents are on one board

- Notices go where they always did: to the chat a task was created in. A chat that moves to
  another board still hears about the tasks it created before.

### Listing the boards

```
/kanban boards
```

> **default**: 2 open, 14 done
> **web-app** (this chat): 3 open, 1 in review · max\_running 1 · workspace web
> `/kanban board use <name>` moves this chat to another board; `/kanban board create <name>` makes one.

`/kanban boards all` lists archived boards too.

### A board's own limit and workspace

```
/kanban board set web-app max_running 1
```

> Board **web-app** runs at most 1 agent at once now.

The gateway's own `kanban.max_running` still holds over every board together, so a board's own
is at most that; `none` clears it. One agent at a time per workspace is still the gateway's rule,
across boards: two boards' tasks in one workspace take turns.

```
/kanban board set web-app workspace web
```

> Board **web-app**'s tasks work in web now, unless their own workspace, their role's or their
> parents' says otherwise.

A board's workspace is the last resort, in place of `default`, for a task with no `workspace:`
line, whose role names no workspace, and whose parents have none. It applies to tasks claimed
from then on; a task already working somewhere stays there. `none` clears it.

### Archiving a board

```
/kanban board archive web-app
```

It is refused while any of the board's tasks is open, in review or blocked: finish or archive
them first. Once it is archived, nothing more is added to it, and no chat can move onto it; its
tasks stay, and `/kanban show` still shows them. A chat still on it is told to move before its
next `/kanban new`, and its `/kanban boards` still lists it, marked archived. `default` is never
archived.

### Who may do what

Anyone at talk tier may list the boards. Creating, using, setting and archiving a board are
operator commands: moving a chat onto a board changes where its tasks go, and so which workspace
an agent may run in.

## 11. Rules of thumb
````

In `docs/kanban-guide.md`, replace:

```markdown
- Want parallel work? Give each task its own workspace, or they queue.
```

with:

```markdown
- Want parallel work? Give each task its own workspace, or they queue.
- Several projects? Give each a board, keep its group on it with `/kanban board use`, and give
  the board the project's workspace.
```

In `README.md`, replace:

```markdown
| `/kanban help` | talk |
```

with:

```markdown
| `/kanban boards [all]` | talk: each board, its tasks, its own limit and workspace, and which one this chat is on |
| `/kanban board create <name>` | operate: a new board, named as roles and workspaces are |
| `/kanban board use <name>` | operate: this chat, all its threads, is on that board from now on |
| `/kanban board set <name> max_running <number\|none>`, or `workspace <workspace\|none>` | operate: the board's own limit, inside `kanban.max_running`, or its tasks' default workspace |
| `/kanban board archive <name>` | operate: refused while any of its tasks is open, in review or blocked; never `default` |
| `/kanban help` | talk |
```

In `README.md`, replace:

```markdown
**People.** Name a person with an @-mention
```

with:

```markdown
**Boards.** Several projects can share the gateway, each on a board of its own: a queue of
tasks with its own list, its turn in each dispatcher pass, and optionally its own
`max_running`, inside the gateway's, and default workspace. One database and one dispatcher
serve every board. A board called `default` always exists, holds every task from before boards,
and is where every chat starts; `/kanban board use` moves a chat, and `/kanban new` and
`/kanban list` act on the chat's board. `/kanban show` and the commands that name a task work
on any board, by id. A task's follow-ups, its parents and its links stay on its board, and its
notices go to the chat it was created in, as before. One agent at a time per workspace still
holds across boards. See section 10 of [docs/kanban-guide.md](docs/kanban-guide.md).

**People.** Name a person with an @-mention
```

In `README.md`, replace:

```markdown
- A person's name, in a notice or a card, is the one Lark last gave with their ids, and can be
```

with:

```markdown
- A board's name is never renamed, and an archived board is never brought back: make a new one.
- A board's own settings keep only who changed them last, and when; there is no history of them.
- A person's name, in a notice or a card, is the one Lark last gave with their ids, and can be
```

- [ ] **Step 10.2: Check.** Run `git grep -n -i "p[g]w" -- . ':!package-lock.json'`. Expected: no output. Run `git diff -U0 docs/kanban-guide.md README.md | grep '^+' | grep -c "$(printf '\342\200\224')"`, which counts the long dashes added. Expected: `0`. Run `npx vitest run --project unit`. Expected: `Tests  1425 passed (1425)`. Run `npx vitest run --project e2e`. Expected: `Tests  99 passed (99)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.3: Commit.**

```bash
git add docs/kanban-guide.md README.md
git commit -m "Describe boards in the usage guide and the README: making one, moving a chat onto it, what it changes, its own limit and workspace, archiving it, and who may do each"
```

---

## Done when

- `npx vitest run --project unit` gives `Tests  1433 passed (1433)` (1425 at Task 10, and 8 from the review follow-ups). `npx vitest run --project e2e` gives `Tests  99 passed (99)`. `npm run typecheck` reports no errors. All under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- Migration 006 takes a version 5 database with tasks to version 6, every task on `default`, nothing else of them changed (`tests/kanban-boards-schema.test.ts`).
- Boards are created, set and archived, and chats moved onto them, only through `db/kanban.ts` (`tests/kanban-boards.test.ts`, `src/db/WRITERS.md`).
- A parent, a link, a dependency block and a worker's follow-up never cross boards (`tests/kanban-board-isolation.test.ts`, `tests/kanban-board-worker.test.ts`).
- A board's workspace places the tasks nothing else does (`tests/kanban-board-workspace.test.ts`).
- The dispatcher takes boards in turn and holds each to its own `max_running` inside the gateway's (`tests/kanban-board-dispatch.test.ts`).
- In chat, `/kanban boards` and `/kanban board …` work at their tiers, and a chat's `new`, `list` and `show` act on its board, end to end through the router (`tests/kanban-board-chat.test.ts`, `tests/kanban-chat.e2e.ts`).

## Review follow-ups

After Task 10 (`e449bdf`, 1425 / 99), a review of the plan's work found the items below. Each behaviour fix was written test first. Counts after them: 1433 / 99.

| Item | Outcome | Commit |
|---|---|---|
| A skipped head task loses its board's turn: `fairOrder` fixed rounds before any skip, so a board whose head task waited on a busy workspace had its next task behind every other board's first | Fixed. `fair.ts` gives each board's queue (`boardQueues`), and a pass tries a board's queue in order until one agent claim succeeds or it runs out, then moves on. A person's claim does not end the turn; a board at its own limit gives its turn up for the pass; priority within a board and the rotation cursor are kept. The reproduction (gamma holding `web`, alpha's busy head task, beta's four) is a regression test; `fairOrder` and its tests stay. Spec §16.7 reworded | `8e1280e` |
| The guide's tier table rendered two rows as a code block: the plan's `markdown` fence lines were pasted in | Fixed: both lines deleted. The rest of the guide's fences are balanced, and each holds a message or a command | this commit |
| A task skipped because its board, or the gateway, is at its limit is never recorded as unassignable | Documented as a known limitation here, in the README and in spec §4.2: such a task is not tried, so one nobody can be given is reported stranded only once a slot frees. A test checks a task waiting only on a limit, the gateway's or its board's, is never reported stranded | `8e1280e` |
| A workspace named `none` can never be a board's workspace, and boards could be named `none` or `all` | `none` and `all` are reserved in the name check (`RESERVED_BOARD_NAMES`). The guide, the README and spec §16.3 say `none` means "clear" | `c8f28f1` |
| A zero-width character in a board name was refused, but the refusal looked like it named a valid board | A refusal that quotes a name writes each non-printing character as `\uXXXX` (`visible` in `src/names.ts`): the name grammar's refusal, an unknown board, and an unconfigured workspace | `c8f28f1` |
| `setBoard(name, {})` stamped the board without changing anything | Refused `invalid` in the service; the board is left unstamped | `c8f28f1` |
| The writer's board check for a reused idempotency key ran only for chat-created tasks | The writer works out the new task's board first (its run's task's, or the one asked for), then refuses `other_board` any existing task on another board, however it was created. Spec §16.5 | `c8f28f1` |
| `createBoard` in the writer did no name check | A cheap one added: the name pattern and the reserved names | `c8f28f1` |
| Guide, "What a board changes": the list's board line, and a follow-up's `parent:` from chat | Said: the line naming the board appears only off `default`; a follow-up with `parent:` must come from a chat on the parent's board, or it is refused | this commit |
| Guide: a person's claim on a board whose workspace was removed from config fixes that workspace on the task | A note added under "A board's own limit and workspace", and in spec §16.6 | this commit |
| Notices after a chat moves | A unit test: a task created on `default`, the chat moved to `web-app`, the task done, and the Done notice still reaches the chat | `c8f28f1` |

## Before using boards: a smoke test against the live gateway

For the user, once the plan is built and deployed, with `kanban.enabled: true`. Use a role on a cheap model; `<role>` below is its name. Run the `sqlite3` lines with the gateway stopped, as its own user.

0. **Before the deploy**, with the gateway stopped: `sqlite3 ~/.manus-team/gateway.db "PRAGMA user_version; SELECT count(*) FROM kanban_tasks"` (or `$MT_DB` if set) prints `5` and the number of tasks. Keep a copy with `sqlite3 ~/.manus-team/gateway.db ".backup $HOME/.manus-team/gateway-v5.db"` (`$HOME`, not `~`: inside the quotes the shell does not expand `~`, and sqlite3 does not either), not by copying the file: in WAL mode the latest changes may still be in the separate `-wal` file. Start the new build, stop it once it is up, and run `sqlite3 ~/.manus-team/gateway.db "PRAGMA user_version; SELECT board, count(*) FROM kanban_tasks GROUP BY board"`: `6`, then `default` and the same number. Start it again.
1. In a group that used the board before: `/kanban boards` shows `**default** (this chat)` with its tasks; `/kanban list` shows what it showed before, with no board line.
2. In a direct message with the bot: `/kanban board create smoke`, then `/kanban board use smoke`. `/kanban list` says `No open tasks on board smoke.`
3. There: `/kanban new Smoke: reply with the word hello` and a line `assignee: <role>`. The reply contains `on board **smoke**.`; the task runs, and this chat hears it done.
4. In the group: `/kanban list all` does not show it; `/kanban show k_…` with its id shows it, with `board: smoke`.
5. In the direct message: `/kanban new Child`, with `assignee: <role>` and `parent:` naming one of the group's tasks. It is refused: the parent is on board default.
6. `/kanban board set smoke max_running 1`, then `/kanban boards`: `**smoke** (this chat): 1 done · max_running 1`.
7. Clean up: `/kanban board archive smoke`, which succeeds, as its one task is done; `/kanban new x` is then refused, saying the board is archived; `/kanban board use default` puts the chat back.
