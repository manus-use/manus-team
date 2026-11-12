# Writer contract

Every table in this schema has exactly one module allowed to write it. This file
is the registry. If you are adding a write and it is not listed here, you are
adding a second writer to something, and you need to either route through the
existing owner or amend this file first.

## Why a registry rather than a convention

"There is only one writer" is a claim that decays silently. It survives the first
implementation, then a repair script, a boot reconciler, or a test helper writes
the same row from another path, and the two writers disagree about a field
neither of them owns. Nothing crashes. A row is just wrong afterwards.

`txImmediate` protects against *interleaving*. It does not protect against two
modules holding different beliefs about what a column means. That is what this
file is for.

## Ownership

| Table | Sole writer | Notes |
| --- | --- | --- |
| `events` | `db/events.ts` | `appendEvents` only. `seq` is assigned inside the transaction from `sessions.last_seq`; nothing else may set it. Rows are never updated or deleted. |
| `sessions` | `db/sessions.ts` | Except `last_seq`, which `appendEvents` advances in the same transaction that writes the events — the two facts must not be able to disagree. |
| `turns` | `db/turns.ts` | |
| `approvals` | `db/approvals.ts` | |
| `channel_bindings` | `db/bindings.ts` | |
| `seen_messages` | `db/dedup.ts` | |
| `workspaces` | `db/workspaces.ts` | Rows are added, never updated: `root_path` is fixed the first time a name is seen (spec §2.3). A task's own directory (`wt:<task_id>`, spec §18) is added by `registerWorktree` once it is made, with `repo_root`, and `branch` for a worktree. `lock_holder` stays null. |
| `kanban_tasks` | `db/kanban.ts` | `phase` is written only by its named transitions, each of which checks the current phase (spec §4.1). `workspace` is written once, while null. `board` (migration 006) is set at the insert and never changed. `worktree` (migration 007) is written once, by a claim, while null (spec §18). |
| `kanban_links` | `db/kanban.ts` | Added in the transaction that checks for a cycle and for an open run on the child (spec §3.2). Never deleted. |
| `kanban_runs` | `db/kanban.ts` | Inserted by a claim. `outcome` is written once, on an undecided run; `ended_at` once, on a decided one (spec §3.3). `agent_config` gains `native` and `packageHash` once, by `recordRendering` (plan R). |
| `kanban_comments` | `db/kanban.ts` | Rows are added, never updated. `steers` (migration 004) is set at the insert: 0 for a talk-tier person's comment from chat, which is shown to people and given to no agent. |
| `kanban_events` | `db/kanban.ts` | Append-only, written in the transaction of the change it records. String values in `payload` are masked on write (spec §10.1). |
| `kanban_gates` | `db/kanban.ts` | Added by `addGate` and deleted by `removeGate`, never updated: the command is stored as written, never masked (spec §10.1). The gateway and the `mt kanban gate` commands both write it, each through `KanbanService`. |
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4). `root_message_id` (migration 008) is written at the insert, for a task created in a thread, from `createdVia.rootId`, or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. `thread_id` and `root_message_id` are written once more, together, by `threadSubscription`, which moves a subscription still at chat scope with no root into the thread its task's "Created" reply opened, writing no event either. No root is changed once written. Never deleted. |
| `kanban_boards` | `db/kanban.ts` | Added by `createBoard` (migration 006 adds `default`); `max_running` and `workspace` set by `setBoard`, `archived_at` once by `archiveBoard`. Never deleted, never renamed: a task keeps the name of its board (spec §16). |
| `kanban_chat_boards` | `db/kanban.ts` | One row per conversation and bot, written by `useBoard`; a chat with none is on `default`. |
| `people` | `db/people.ts` | One row per person per bot (migration 005): the open_id and name Lark last gave with a union_id, noted when a person sends a `/kanban` command, is mentioned in one, or presses a board card's button. How a person named by `lark:<union_id>` alone is checked for talk tier (spec §4.2). |
| `schema_version`, `user_version` | `db/open.ts` (`migrate`) | Migration files own the `schema_version` row contents; the runner owns `user_version`. |

## Rules that hold across all of them

**Append-only means append-only.** `events` has no UPDATE and no DELETE path.
Anything that looks like a correction is a new event that supersedes an old one.
A projection that needs to hide superseded content filters at read time. The log
is evidence, and evidence you can edit is not evidence.

**One transaction per fact.** If two rows must be true together, they are written
in one `txImmediate` call. The pair that matters most is `events` + the
`sessions.last_seq` bump: a committed event with a stale `last_seq` hands the
next append a duplicate `seq`.

**No `await` inside `txImmediate`.** The callback is synchronous by contract. An
`await` under the write lock lets unrelated work interleave while the lock is
held, and better-sqlite3 will happily let you start a second statement on the
same connection from that interleaved work.

**Never write from a projection.** Channel adapters read the log and advance
their own `cursor_seq`. That cursor is the only thing a projection owns. A
projection that writes session state has made the display authoritative over the
log, which inverts the whole design.

**Reads outside transactions are allowed to be stale.** They are snapshots. Any
decision that must not be made on a stale read — resolving an approval, claiming
a message, opening a turn — re-reads inside `txImmediate` and compares. The
generation CAS in `resolveApproval` is the reference example: the read that
picked the row is untrusted, and the write re-checks.
