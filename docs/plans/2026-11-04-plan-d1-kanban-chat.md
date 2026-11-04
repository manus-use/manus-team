# Plan D1 — The board in chat: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board can be used from Lark for tasks given to roles. An operator types `/kanban new` in any chat the bot is in, with field lines for the assignee, the workspace, the parents and the contract, and the dispatcher runs the task on the role's agent at once. Every `/kanban` command a role's task needs — `list`, `show`, `assign`, `link`, `workspace`, `comment`, `unblock`, `stop`, `archive`, `gate add|list|remove` and `help` — goes through `KanbanService` and nothing else, at the tiers of spec §9.1, and is never refused because the chat's own session is busy. The chat a task was created in follows it, and the tasks its runs create: it hears when one is done, needs review, blocks, is retried after a failure, gives up or is stranded, once, delivered from a cursor kept in the database, so the notices due while the gateway was down are sent when it is back. Everything shown is escaped and masked, gate commands included. A task is any work — research, a document, an operation in Lark, a chore, code — and nothing here assumes git: a workspace is a directory. People are still refused as assignees and reviewers, and the commands for their own tasks say they arrive in plan D2. With `kanban.enabled` unset, chat is unchanged, and `/kanban` says the board is off.

**Architecture:**
- **The setting** (`src/config.ts`): `kanban.block_recurrence_limit`, spec §5.4's, read as the other `kanban:` numbers are: default 2, at most 100, file only.
- **Subscriptions** (`db/kanban.ts` `createTask`, `advanceSubscription`; `db/kanban-read.ts` `subscriptionsOf`, `dueSubscriptions`, `eventsAfter`): `createTask` subscribes the chat a task is created in, or copies the subscriptions of the task whose run created it, in its own transaction. A cursor moves forward only and writes no event. `run_ended` carries the block's reason, so its notice can say why.
- **The board, listed** (`db/kanban-read.ts` `boardList`, `KanbanService.list`): every task with its derived status, for `/kanban list`.
- **Parsing** (`src/kanban/chat-parse.ts`): `parseKanban`, pure, turns what follows `/kanban` into a command, or the usage line to show.
- **Rendering** (`src/kanban/chat-render.ts`): the help, the list, `show`, the gate list and each notice, pure given the secret set. A piece is masked and cut before it is escaped; free text keeps its markdown through `forMarkdown`, quoted under its label; labels go through `forDisplay`.
- **The commands** (`src/kanban/chat.ts`): `KanbanChat.run` checks the sender's tier, records who acted as `lark:<union_id>`, refuses a person or a supervised role with what D2 brings, calls the service, and tells the dispatcher: a pass after a change, and the cancel of an agent run's turn that the change decided.
- **The router** (`src/core/commands.ts`, `src/core/router.ts`): `/kanban` is a command at talk tier, multiline, needing no session and never refused mid-turn; the router hands it to `RouterDeps.kanban`, or says the board is off, and masks the whole reply.
- **Notices** (`src/kanban/notices.ts`, `core/ids.ts` `noticeUuid`): the `Notifier` delivers each subscription's events past its cursor, in order, every 2 s and one round at a time; a send that fails is retried after a pause that doubles to five minutes; the uuid is derived from the subscription and the event.
- **Wiring** (`src/index.ts`): behind `kanban.enabled`, the router gets the commands and the gateway a notifier, started once the channel is connected and stopped before it disconnects.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §4.2, §5.4, §7.5, §7.7, §9.1, §9.3, §9.4, §10, §11 and the D1 and D2 rows of §12, as amended in the same commit as this plan.

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on branch `kanban-chat`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, and never write to `~/.manus-team`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Secrets.** Never print secret values. Tests use made-up values only.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` gives `Tests  1151 passed (1151)`. `npm run test:e2e` gives `Tests  70 passed (70)`. `npm run typecheck` reports no errors.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given.
- **The secret registry is process-wide.** Every test file that adds secrets calls `clearSecrets()` in `beforeEach` and `afterEach`, or, in `tests/router.test.ts`, in the `afterEach` of its own `describe`.
- **Tests use real SQLite** through `testDb()`, the real `KanbanService`, the real board and a `ManualClock`; the router's tests use its existing harness, and the notices a `FakeChannel`. No mocks, except the gateway's start-up test, which stubs the Lark connection as its neighbours do.
- **No real agent, no network, no real home.** No test runs bytesec or reaches Lark. The end-to-end test runs the fake CLI agent through the real CLI driver, with its home, socket and workspace under a fresh `mkdtemp` directory, realpath'd.
- **Unit tests start no process.** The board's chat and its notices start none; only `tests/kanban-chat.e2e.ts` does, in the e2e project.
- **The import guard.** `tests/kanban-service.test.ts` checks that only `src/kanban/service.ts` imports `src/db/kanban.js`. `KanbanChat` calls the service only; the `Notifier` reads through `db/kanban-read.js` and moves its cursors through the service.
- **Nothing assumes git or code.** A task is any work and a workspace any directory: no step here reads a repository, and the test tasks are documents, surveys and chores as often as code.

## Decisions the spec left open

Each is the reading most consistent with the rest of the spec. The user decided three before this plan: D is split into D1 and D2 (Decision 1), `kanban.enabled` stays off by default (Decision 2), and a task is any work (Decision 3). Those marked *To confirm* change what a person in chat sees or can do, and are proposed rather than decided. All of them are in the spec now (§4.2, §5.4, §7.7, §9.1, §9.3, §9.4, §12), amended in the same commit as this plan.

1. **D is D1, then D2.** *The user's decision.* D1 is every `/kanban` command a role's task needs, and a chat's subscriptions and their notices, so that tasks given to roles are usable from Lark. D2 is people: direct-message cards with Done, Block, Approve and Request changes; the person send target by union_id; card `kind` routing; the group one-line notice; `/kanban done`, `block` and `review` by a human assignee, `approve` and `changes` by a person reviewer; approval forwarding for supervised roles; and refusing a person's report beside another task's agent run (`workspace_busy`, spec §7.7).
2. **The board stays opt-in.** *The user's decision.* `kanban.enabled` is off by default after D1 and D2. With it unset, the gateway builds no service, dispatcher, socket or notifier, as before, and chat without `/kanban` is unchanged.
3. **A task is any work.** *The user's decision.* Nothing in D1 reads a repository or assumes code: a workspace is a directory, a gate any command, and the help and the README say so.
4. **`/kanban` with the board off answers that it is off.** The command is always registered; with no board, the router answers "The task board is off on this gateway. An operator turns it on with `kanban.enabled: true` in config.yaml, and a restart." and opens no session. *Why:* without it, `/kanban` would be "Unknown command", which reads as a typo, on the very gateway whose operator has to be told what to change. Leaving the command out of the table when the board is off was rejected: the table is static, and `/help` would then differ between gateways for a reason it cannot show.
5. **The person-only commands are answered, not left out.** `/kanban done`, `block`, `review`, `approve` and `changes` parse, and are answered "`/kanban done` is for a person's own task, and arrives in plan D2 with people as assignees and reviewers. For now tasks go to roles, whose agents report for themselves." *Why:* the spec's table lists them, so people will try them; "Unknown command" would send them looking for a typo, and reserving the verbs now means D2 changes their answer, not the parser. **`approve` and `changes` by an operator who is not the named reviewer** — spec §9.1's "operate, or the named reviewer" — are deferred with the rest to D2. *To confirm:* the user's D2 list names them "by a person reviewer"; an operator approving a role-reviewed task from chat is not named either way.
6. **A person named as assignee or reviewer is refused before the service sees it.** A name starting `@` — Lark's text gives an @-mention as `@Name` — or `lark:` is answered "Naming a person as an assignee or reviewer arrives in plan D2. For now a task is given to a role: name it as a bare word, such as `implementer`." *Why:* `InboundMessage` carries no mention ids yet (the SDK's `mentions` are not copied into it), so D1 cannot tell who was mentioned, only that someone was; the service's own `person_not_assignable` says "until the board is in Lark", which is no longer the reason. D2 adds the mentioned users' ids to the inbound message.
7. **A supervised role is still refused, saying why in D1's words.** The service's `supervised_role` refusal is answered as "role "x" has a supervised agent; its approval requests cannot be forwarded to a chat yet. That arrives in plan D2." The service is not changed: D2 turns `supervisedRoles` on.
8. **Who acted is `lark:<union_id>`.** The board's principal for a person (spec §3.1), and what D2 assigns people as. A sender whose message carried no union_id may `list`, `show`, `gate list` and see the help, and is refused anything that records who acted: "Lark did not say who you are (no union_id came with the message), and the board records who changes it. Ask the operator to check the app can read user ids." *Why:* `open_id` is app-scoped, and recording it would give one person two identities on the board. Lark sends union_id with every message event, so the refusal is for a misconfigured app, not a common case.
9. **Tiers.** `/kanban` is registered at talk tier, and each command that changes the board checks operator tier itself, naming the command it refused: "`/kanban assign` changes the board, and needs operator permission." Talk: `help`, `list`, `show`, `comment`, `gate list`. Operate: `new`, `assign`, `link`, `workspace`, `unblock`, `stop`, `archive`, `gate add`, `gate remove` (spec §9.1, §10). *To confirm:* **`gate list` at talk tier**, because `/kanban show`, which is talk, shows the same gates, masked; making it operator would only hide from `gate list` what `show` already gives.
10. **`/kanban new`'s grammar** (spec §9.1). The title is the rest of the first line, or the next line when the verb stands alone. A field line is its label at the very start of the line, in any case, then a colon and a value; an indented line, or one that only mentions a label, stays body. Field lines may come anywhere among the body's lines. Each field may be given once, except `parent:`, which takes task ids separated by spaces or commas and may be repeated. `verify:` fills `verification`, `stop when:` fills `stop_when`. A field given twice, or with no value, is refused with the label. A task with no assignee may be created, and the reply says how to assign it: the spec does not require one, and the stranded notice covers it if nobody does. The message id is the idempotency key, `lark:<message_id>`, the chat key the service already reserves (`CHAT_KEY`), so a redelivery past the router's own dedup still makes one task.
11. **`/kanban list`.** Without a status, the tasks someone may still act on — running, reviewing, review, ready, todo, blocked — grouped in that order; with a status, only those; `all` lists every task, done and archived ones included. At most 30 lines, then "… and N more". *Why:* done and archived tasks only grow, and a board that lists them by default is unreadable within a week.
12. **`/kanban show`** gives the title, id and status; assignee, reviewer and workspace; the block, if blocked; parents and children with their phases; the body; the contract; the gates, masked; the last five runs, one line each with the summary or error; the latest run's output (its last 2,000 characters, cut to 800); and the last five comments. Each piece has a cap, and the router cuts a whole reply at 4,000 characters, saying so.
13. **`/kanban gate add <task> [--timeout <s>] <command>`.** The rest of the message after the task id and the optional timeout is the command, as written, line breaks kept: a gate is a shell command, and re-joining words would change its quoting (C4's `mt kanban gate add` joins argv only because a shell split it). `gate list <task>` and `gate remove <task> <gate>` complete the set. The definer is `lark:<union_id>`. The service checks the command — size, NUL, known secrets — as for `mt`.
14. **Rendering** (spec §9.3). Every piece of task text is masked and cut to its length before it is escaped, so a cut leaves no start of a secret and splits no escape. A body, a summary, a comment and an agent's output keep their markdown through `forMarkdown` and are quoted, `> ` on each line, under their label, so none of their lines starts a heading or a list; titles, names, reasons, errors and gate commands go through `forDisplay`. Task ids the board minted are shown as code; anything else a sender typed is escaped. The router masks each whole reply once more, and the notifier each notice: masking is idempotent, and it covers the board's own words and ids.
15. **After a change, the dispatcher is told.** `KanbanChat` calls `changed()` — the dispatcher's `pass()` — after `new`, `assign`, `workspace`, `unblock`, `stop` and `archive`, so a task starts without waiting for the sweep; and `cancel(runId)` — the dispatcher's `cancel`, which C2 left for D — for an agent run that `assign`, `stop` or `archive` decided while it was open, so its turn is cancelled and the run closed. `comment` tells neither: the dispatcher already forwards a person's comment to an undecided run when its turn ends (spec §7.5). A hook that throws is swallowed: the sweep finds the work within a minute.
16. **Subscriptions are written by `createTask`, in its transaction, with no event.** The chat's binding key — channel, app, chat, thread — for a task created in chat; for a task a run created, a copy of every subscription of the run's task (spec §7.3), which is how "the tasks created from it" (§9.4) is read. Cursors start at 0. *Why no event:* the subscription is part of the creation, which already writes `created`. `INSERT OR IGNORE` on the table's unique key, so a copied subscription cannot collide.
17. **What a subscriber hears** (spec §9.4). `completed`, with the summary; `review_requested`, with the reviewer; `blocked` of any kind but `dependency`; `stopped`, which blocks as `needs_input`; `run_ended` that retries after `failed`, `crashed`, `timed_out`, `protocol_violation` or `interrupted`; `run_ended` that blocks — "gave up" for `gave_up`, otherwise as a block; and `stranded`. Not: a throttled run's cooldown (it clears by itself, and blocks as `transient` at its limit, which is heard), `changes_requested` (the rework starts by itself), comments, claims, links, gates, archives. A block's notice says how to unblock, or, once the task has blocked for the same kind `kanban.block_recurrence_limit` times after an unblock, to rewrite it instead (spec §5.4). *To confirm:* **`interrupted` as "retrying after a failure"**: after a restart every open run is interrupted and retried, and its chat hears so; the alternative is silence for a retry the task did nothing to cause.
18. **`run_ended` carries `blockReason`.** The breaker's reason ("failed 2 times; last crashed: …") was on the task only, and a notice delivered later — after a restart, say — would read whatever the task says by then. The payload is a JSON object, so the key is added with no migration, and the events written before it show the block's kind with no reason.
19. **Delivery is a projection from the cursor, polled** (spec §9.4). The `Notifier` runs a round every 2 s (`NOTICE_POLL_MS`), one at a time: every subscription of this bot with an event past its cursor, then each one's events in order — at most 100 a round. A notice is sent, then the cursor moves to it, through `KanbanService.advanceSubscription`; an event that is no notice only moves the cursor. *Why a poll:* the board is written from chat, the worker socket and the dispatcher, and from inside `endRun` and `noteStranded`; hooking each would be a second list to keep in step with every writer, and missing one would lose a notice silently. The read when nothing is due is one indexed query.
20. **Delivery survives a restart because the cursors are in the database.** The first round runs when the gateway has connected, from the stored cursors, so what the chats missed while it was down is sent by the code that sends in normal running. A notice sent just before a stop, whose cursor had not moved, is sent again with the same uuid, `noticeUuid(appId, subscription, event)`. The Lark adapter does not pass a send's uuid to Lark (its documented gap), so until it does that one notice can show twice; it is never lost. The gateway stops the notifier with the dispatcher, and waits for its round before it disconnects.
21. **A send that fails** leaves the cursor and holds that subscription back for 2 s, doubling to at most five minutes (`NOTICE_BACKOFF_MAX_MS`), while the others go on; each failure is noted with the task and subscription ids, never the text. A subscription whose channel is not configured is held back the same way.
22. **`kanban.block_recurrence_limit` is a setting now.** Spec §5.4 names it; C's config refused it "before it does anything". Default 2, at most 100, file only, like the other `kanban:` numbers.
23. **Words a person sees name "plan D2".** *To confirm.* The user asked that the refusals say the feature arrives in D2, and they do. A person in chat may not know what plan D2 is; "in a later update" is the alternative, one string each in `src/kanban/chat.ts` and `src/kanban/chat-render.ts`.

## Out of scope (plan D2 and later)

- **Plan D2:** everything in Decision 1; a person's `/kanban done`, `block`, `review`, `approve` and `changes`, through the service's asynchronous `complete` and `requestReview`, with a gate refusal's output shown through the escapers and `dispatcher.pass()` after it; the review card's "review commit …" from `describeReported`; the Unblock button on a blocked notice (spec §9.2); the mentioned users' ids on `InboundMessage`; approval cards for kanban runs forwarded to the task's first subscription (`KanbanSink`).
- **The Lark adapter's uuid.** Passing a send's uuid to Lark, so a notice redelivered after a restart is deduplicated by the platform, needs the SDK to expose it (the adapter's known gap).
- **Allowlists.** A subscription keeps receiving notices if its chat is later removed from `auth.chats`; the notifier does not consult the authorizer.

### Known limitations, not fixed here

- A notice sent just before the gateway stops, whose cursor had not moved, is sent again after the restart, and shows twice until the adapter passes the uuid on (Decision 20).
- A task created in a thread is followed by that thread only; nothing yet subscribes another chat to it.
- A notice is at most a 2 s poll behind the event, plus the backoff of a subscription whose sends have failed.
- A busy board's catch-up after a long outage sends up to 100 notices per subscription per round, in order; a chat that missed a day may get many at once.
- `/kanban list` reads every task's parents and runs, one query each: fine for a board of hundreds, slow for one of tens of thousands.

### What D2 needs

- `KanbanChat` answers the `later` verbs in one place: D2 replaces that branch with the reports, through `complete` and `requestReview`, awaited, and their tiers (spec §9.1: the named assignee or reviewer at talk tier).
- `isPerson` and `PEOPLE_LATER` are where an @-mention becomes a principal, once `InboundMessage` carries the mentioned ids; the service's `people` dependency turns persons on.
- The `Notifier` delivers through `Channel.sendText`; D2's cards and the group notice go through the same subscriptions, and its approval forwarding through the task's first one (`subscriptionsOf(...)[0]`).
- `renderNotice` is where a blocked notice gains its Unblock button.

## File structure

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | `kanban.block_recurrence_limit` |
| `src/kanban/types.ts` (modify) | `SubscriptionRow` |
| `src/db/kanban-read.ts` (modify) | `eventsAfter`, `subscriptionsOf`, `dueSubscriptions`, `boardList`, `BoardEntry` |
| `src/db/kanban.ts` (modify) | subscriptions in `createTask`; `advanceSubscription`; `run_ended`'s `blockReason` |
| `src/db/WRITERS.md` (modify) | `kanban_subscriptions`'s writer |
| `src/kanban/service.ts` (modify) | `list`, `advanceSubscription` |
| `src/kanban/chat-parse.ts` (create) | `parseKanban`, `USAGE`, `LIST_FILTERS`, `LATER_VERBS` |
| `src/kanban/chat-render.ts` (create) | `renderHelp`, `renderList`, `renderShow`, `renderGates`, `renderNotice` |
| `src/kanban/chat.ts` (create) | `KanbanChat`, `principalOf` |
| `src/core/commands.ts`, `src/core/router.ts` (modify) | the `/kanban` command; `KanbanCommands`, `RouterDeps.kanban`, `KANBAN_OFF` |
| `src/core/ids.ts` (modify) | `noticeUuid` |
| `src/kanban/notices.ts` (create) | `Notifier`, `NOTICE_POLL_MS`, `NOTICE_BACKOFF_MAX_MS` |
| `src/index.ts` (modify) | the commands and the notifier behind `kanban.enabled` |
| `README.md` (modify) | the board from Lark |
| `tests/kanban-subscriptions.test.ts`, `tests/kanban-chat-parse.test.ts`, `tests/kanban-chat-render.test.ts`, `tests/kanban-chat.test.ts`, `tests/kanban-notices.test.ts`, `tests/kanban-chat.e2e.ts` (create) | |
| `tests/config.test.ts`, `tests/router.test.ts`, `tests/commands.test.ts`, `tests/ids.test.ts`, `tests/gateway-startup.test.ts` (modify) | |

Running counts, unit then end to end: Task 1 1152 / 70, Task 2 1159, Task 3 1166, Task 4 1177, Task 5 1186, Task 6 1191, Task 7 1198, Task 8 1199, Task 9 1199 / 72, Task 10 1199 / 72.

---

### Task 1: The block recurrence setting

**Files:**
- Modify: `src/config.ts`, `tests/config.test.ts`

Spec §5.4 names `kanban.block_recurrence_limit`, the number of same-kind blocks after an unblock at which a blocked notice stops inviting another unblock. Plan C refused the key until something used it; the notices of Task 4 do (Decision 22). It is read like the other `kanban:` numbers: snake_case in the file, a positive whole number, a ceiling, no environment override.

- [ ] **Step 1.1: Write the failing tests.**

In `tests/config.test.ts`, replace:

```ts
      strandedAfterS: 1_800,
      nudgeLimit: 2,
    });
```

with:

```ts
      strandedAfterS: 1_800,
      nudgeLimit: 2,
      blockRecurrenceLimit: 2,
    });
```

In `tests/config.test.ts`, replace:

```ts
          nudge_limit: 1,
        },
      }),
    );
```

with:

```ts
          nudge_limit: 1,
          block_recurrence_limit: 3,
        },
      }),
    );
```

In `tests/config.test.ts`, replace:

```ts
      strandedAfterS: 120,
      nudgeLimit: 1,
    });
```

with:

```ts
      strandedAfterS: 120,
      nudgeLimit: 1,
      blockRecurrenceLimit: 3,
    });
```

In `tests/config.test.ts`, replace:

```ts
      'unknown setting kanban.failureLimit (known: enabled, max_running, failure_limit',
    );
    // Plan D's setting is not accepted before it does anything.
    expect(() => load({}, yamlFile({ kanban: { block_recurrence_limit: 2 } }))).toThrow(
      'unknown setting kanban.block_recurrence_limit',
    );
  });
```

with:

```ts
      'unknown setting kanban.failureLimit (known: enabled, max_running, failure_limit',
    );
  });
```

In `tests/config.test.ts`, replace:

```ts
describe('loadConfig: kanban.nudge_limit', () => {
```

with:

```ts
describe('loadConfig: kanban.block_recurrence_limit', () => {
  it('is a positive whole number, at most 100, and is file only', () => {
    expect(load({}, yamlFile({ kanban: { block_recurrence_limit: 1 } })).kanban.blockRecurrenceLimit).toBe(1);
    expect(() => load({}, yamlFile({ kanban: { block_recurrence_limit: 0 } }))).toThrow(
      'kanban.block_recurrence_limit must be a positive integer',
    );
    expect(() => load({}, yamlFile({ kanban: { block_recurrence_limit: 101 } }))).toThrow(
      'kanban.block_recurrence_limit must be at most 100, got 101',
    );
    expect(load({ MT_KANBAN_BLOCK_RECURRENCE_LIMIT: '5' }).kanban.blockRecurrenceLimit).toBe(2);
  });
});

describe('loadConfig: kanban.nudge_limit', () => {
```


- [ ] **Step 1.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/config.test.ts`. Expected: three FAIL — the defaults lack `blockRecurrenceLimit`, and the other two are refused with `unknown setting kanban.block_recurrence_limit (known: enabled, max_running, …, nudge_limit)`. `Tests  3 failed | 70 passed (73)`.

- [ ] **Step 1.3: Implement.**

In `src/config.ts`, replace:

```ts
  /** Reminders sent to a run whose turn ended without a report, before it is a protocol violation (spec §7.5). */
  nudgeLimit: number;
}
```

with:

```ts
  /** Reminders sent to a run whose turn ended without a report, before it is a protocol violation (spec §7.5). */
  nudgeLimit: number;
  /**
   * Blocks of the same kind in a row, unblocked in between, at which a blocked
   * notice stops inviting another unblock and suggests rewriting the task (spec §5.4).
   */
  blockRecurrenceLimit: number;
}
```

In `src/config.ts`, replace:

```ts
  nudgeLimit: 2,
};
```

with:

```ts
  nudgeLimit: 2,
  blockRecurrenceLimit: 2,
};
```

In `src/config.ts`, replace:

```ts
  nudge_limit: 'nudgeLimit',
} as const;
```

with:

```ts
  nudge_limit: 'nudgeLimit',
  block_recurrence_limit: 'blockRecurrenceLimit',
} as const;
```

In `src/config.ts`, replace:

```ts
  nudge_limit: 10,
};
```

with:

```ts
  nudge_limit: 10,
  block_recurrence_limit: 100,
};
```

In `src/config.ts`, replace:

```ts
      nudgeLimit: file.kanban.nudgeLimit ?? KANBAN_DEFAULTS.nudgeLimit,
    },
```

with:

```ts
      nudgeLimit: file.kanban.nudgeLimit ?? KANBAN_DEFAULTS.nudgeLimit,
      blockRecurrenceLimit: file.kanban.blockRecurrenceLimit ?? KANBAN_DEFAULTS.blockRecurrenceLimit,
    },
```


- [ ] **Step 1.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/config.test.ts`. Expected: `Tests  73 passed (73)`.

- [ ] **Step 1.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1152 passed (1152)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.6: Commit.**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "Read kanban.block_recurrence_limit, the count of blocks of one kind after which a blocked notice suggests rewriting the task"
```

---

### Task 2: Subscriptions, and the board as a list

**Files:**
- Create: `tests/kanban-subscriptions.test.ts`
- Modify: `src/kanban/types.ts`, `src/db/kanban-read.ts`, `src/db/kanban.ts`, `src/kanban/service.ts`, `src/db/WRITERS.md`

`kanban_subscriptions` exists since migration 003 with no writer. `createTask` now subscribes, in its own transaction: the chat a task is created in, or every chat following the task whose run created it (spec §7.3, §9.4; Decision 16). `advanceSubscription` moves a cursor forward only and writes no event — an event would itself be past the cursor. The reads a notifier needs come with it: `subscriptionsOf`, `dueSubscriptions` and `eventsAfter`. `run_ended` gains `blockReason`, so a notice delivered later says why the task blocked (Decision 18). And `boardList`, through `KanbanService.list`, gives `/kanban list` every task with its derived status.

- [ ] **Step 2.1: Write the failing tests.**

Create `tests/kanban-subscriptions.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceSubscription, createTask, endRun, DEFAULT_LIMITS } from '../src/db/kanban.js';
import {
  boardList,
  dueSubscriptions,
  eventsAfter,
  eventsOf,
  subscriptionsOf,
} from '../src/db/kanban-read.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * Subscriptions (spec §9.4): the chat a task is created in follows it, and the
 * chats following a task follow the tasks its runs create. A cursor moves only
 * forward, and writes no event of its own.
 */

let h: TestDb;

beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const THREAD: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };
const OTHER_BOT: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_other', conversationId: 'oc_chat', threadId: '' };

describe('subscriptions', () => {
  it('subscribes the chat a task is created in, at cursor 0, writing no event of its own', () => {
    const task = newTask(h.db, { createdVia: THREAD });
    expect(subscriptionsOf(h.db, task.taskId)).toEqual([
      {
        id: expect.any(Number) as number,
        taskId: task.taskId,
        channel: 'lark',
        appId: 'cli_app',
        conversationId: 'oc_team',
        threadId: 'omt_topic',
        cursor: 0,
        createdAt: NOW,
      },
    ]);
    expect(eventsOf(h.db, task.taskId).map((e) => e.kind)).toEqual(['created']);
  });

  it('subscribes nothing twice when a create is repeated with its key', () => {
    const first = newTask(h.db, { idempotencyKey: 'lark:om_1' });
    const again = createTask(
      h.db,
      { title: 'a task', idempotencyKey: 'lark:om_1', createdBy: ALICE, createdVia: VIA },
      NOW,
    );
    expect(again).toMatchObject({ ok: true, existing: true, task: { taskId: first.taskId } });
    expect(subscriptionsOf(h.db, first.taskId)).toHaveLength(1);
  });

  it("gives a task a run creates every subscription of the run's task", () => {
    const parent = newTask(h.db, { createdVia: THREAD });
    // A second chat following the same task: a subscription is per chat and thread.
    h.db
      .prepare(
        `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
         VALUES (?, 'lark', 'cli_app', 'oc_other', '', ?)`,
      )
      .run(parent.taskId, NOW);
    const run = claimed(h.db, parent.taskId);
    const child = createTask(
      h.db,
      { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } },
      NOW,
    );
    if (!child.ok) throw new Error(child.message);
    expect(subscriptionsOf(h.db, child.task.taskId).map((s) => [s.conversationId, s.threadId, s.cursor])).toEqual([
      ['oc_team', 'omt_topic', 0],
      ['oc_other', '', 0],
    ]);
  });

  it('moves a cursor forward only, and refuses a subscription that does not exist', () => {
    const task = newTask(h.db);
    const [sub] = subscriptionsOf(h.db, task.taskId);
    if (sub === undefined) throw new Error('not subscribed');
    expect(advanceSubscription(h.db, sub.id, 5)).toEqual({ ok: true, advanced: true });
    expect(advanceSubscription(h.db, sub.id, 3)).toEqual({ ok: true, advanced: false });
    expect(subscriptionsOf(h.db, task.taskId)[0]?.cursor).toBe(5);
    expect(eventsOf(h.db, task.taskId).map((e) => e.kind)).toEqual(['created']);
    expect(advanceSubscription(h.db, 999, 1)).toEqual({ ok: false, code: 'not_found', message: 'no subscription 999' });
  });

  it("lists this bot's subscriptions with events past their cursor, and the events after a cursor in order", () => {
    const a = newTask(h.db);
    const b = newTask(h.db);
    newTask(h.db, { createdVia: OTHER_BOT });
    const [subA] = subscriptionsOf(h.db, a.taskId);
    const [subB] = subscriptionsOf(h.db, b.taskId);
    if (subA === undefined || subB === undefined) throw new Error('not subscribed');
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.taskId)).toEqual([a.taskId, b.taskId]);
    const created = eventsOf(h.db, b.taskId)[0]?.id ?? 0;
    expect(advanceSubscription(h.db, subB.id, created).ok).toBe(true);
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.taskId)).toEqual([a.taskId]);
    claimed(h.db, b.taskId);
    expect(dueSubscriptions(h.db, 'cli_app').map((s) => s.taskId)).toEqual([a.taskId, b.taskId]);
    expect(eventsAfter(h.db, b.taskId, created, 10).map((e) => e.kind)).toEqual(['claimed']);
    expect(eventsAfter(h.db, b.taskId, 0, 1).map((e) => e.kind)).toEqual(['created']);
  });

  it('records why a run that ended unreported blocked its task, for the notice', () => {
    const task = newTask(h.db, { failureLimit: 1 });
    const run = claimed(h.db, task.taskId);
    expect(endRun(h.db, run.runId, { outcome: 'failed', error: 'exit 1' }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    expect(eventsOf(h.db, task.taskId).at(-1)).toMatchObject({
      kind: 'run_ended',
      payload: { next: 'blocked', blockKind: 'gave_up', blockReason: 'failed 1 times; last failed: exit 1' },
    });
  });
});

describe('the board, as /kanban list reads it', () => {
  it('gives every task its derived status, highest priority first, then oldest', () => {
    const parent = newTask(h.db, { title: 'parent' });
    newTask(h.db, { title: 'child', parents: [parent.taskId] });
    const urgent = newTask(h.db, { title: 'urgent', priority: 5 });
    claimed(h.db, urgent.taskId);
    expect(boardList(h.db).map((e) => [e.task.title, e.status])).toEqual([
      ['urgent', 'running'],
      ['parent', 'ready'],
      ['child', 'todo'],
    ]);
  });
});
```


- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-subscriptions.test.ts`. Expected: all seven FAIL — six with `TypeError: (0 , subscriptionsOf) is not a function` (or `boardList`), and the `run_ended` one because its payload has no `blockReason`. `Tests  7 failed (7)`.

- [ ] **Step 2.3: Implement.**

In `src/kanban/types.ts`, replace:

```ts
  payload: unknown;
  createdAt: number;
}

export type RefusalCode =
```

with:

```ts
  payload: unknown;
  createdAt: number;
}

/**
 * A chat following a task (spec §9.4): the binding key its notices go to, and
 * the last `kanban_events` id delivered there, or passed over as no notice.
 */
export interface SubscriptionRow {
  id: number;
  taskId: string;
  channel: string;
  /** The bot's app id: the schema's `account_id`. */
  appId: string;
  conversationId: string;
  threadId: string;
  cursor: number;
  createdAt: number;
}

export type RefusalCode =
```

In `src/db/kanban-read.ts`, replace:

```ts
  RunRow,
  TaskRow,
} from '../kanban/types.js';

/**
 * Reading the board.
```

with:

```ts
  RunRow,
  SubscriptionRow,
  TaskRow,
} from '../kanban/types.js';

/**
 * Reading the board.
```

In `src/db/kanban-read.ts`, replace:

```ts
/** A report's run of the task's gates, as its `gates_ran` event recorded it (spec §7.7). */
export interface LastGateRun {
```

with:

```ts
/** The task's events after the given id, oldest first, at most `limit`: what a subscription has yet to hear. */
export function eventsAfter(db: Db, taskId: string, after: number, limit: number): KanbanEvent[] {
  return db
    .prepare<[string, number, number], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(taskId, after, limit)
    .map(decodeEvent);
}

interface SubscriptionRaw {
  id: number;
  task_id: string;
  channel: string;
  account_id: string;
  conversation_id: string;
  thread_id: string;
  cursor: number;
  created_at: number;
}

function decodeSubscription(r: SubscriptionRaw): SubscriptionRow {
  return {
    id: r.id,
    taskId: r.task_id,
    channel: r.channel,
    appId: r.account_id,
    conversationId: r.conversation_id,
    threadId: r.thread_id,
    cursor: r.cursor,
    createdAt: r.created_at,
  };
}

const SUBSCRIPTION_COLS = 'id, task_id, channel, account_id, conversation_id, thread_id, cursor, created_at';

/** The chats following a task, in the order they were subscribed (spec §9.4). */
export function subscriptionsOf(db: Db, taskId: string): SubscriptionRow[] {
  return db
    .prepare<[string], SubscriptionRaw>(
      `SELECT ${SUBSCRIPTION_COLS} FROM kanban_subscriptions WHERE task_id = ? ORDER BY id`,
    )
    .all(taskId)
    .map(decodeSubscription);
}

/**
 * This bot's subscriptions with an event past their cursor, oldest first: what a
 * round of delivery has to do (spec §9.4). Read from the cursors, so a round after
 * a restart catches up exactly as a round in normal running does.
 */
export function dueSubscriptions(db: Db, appId: string): SubscriptionRow[] {
  return db
    .prepare<[string], SubscriptionRaw>(
      `SELECT ${SUBSCRIPTION_COLS} FROM kanban_subscriptions s
        WHERE s.account_id = ?
          AND EXISTS (SELECT 1 FROM kanban_events e WHERE e.task_id = s.task_id AND e.id > s.cursor)
        ORDER BY s.id`,
    )
    .all(appId)
    .map(decodeSubscription);
}

/** A report's run of the task's gates, as its `gates_ran` event recorded it (spec §7.7). */
export interface LastGateRun {
```

In `src/db/kanban-read.ts`, replace:

```ts
// ---------------------------------------------------------------------------
// What the dispatcher reads (plan C2)
// ---------------------------------------------------------------------------
```

with:

```ts
/** A task on the board, with what a person sees of it (spec §4.1). */
export interface BoardEntry {
  task: TaskRow;
  status: DisplayStatus;
}

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
    .map((task) => ({
      task,
      status: displayStatus({
        phase: task.phase,
        parentsFinished: parentsOf(db, task.taskId).every((p) => isFinished(p.phase)),
        undecidedRun: runsOf(db, task.taskId).find((r) => r.outcome === null)?.kind,
      }),
    }));
}

// ---------------------------------------------------------------------------
// What the dispatcher reads (plan C2)
// ---------------------------------------------------------------------------
```

In `src/db/kanban.ts`, replace:

```ts
  parentsOf,
  runsOf,
} from './kanban-read.js';
```

with:

```ts
  parentsOf,
  runsOf,
  subscriptionsOf,
} from './kanban-read.js';
```

In `src/db/kanban.ts`, replace:

```ts
    const link = d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)');
    for (const parent of parents) link.run(parent, taskId, now);
    record(
```

with:

```ts
    const link = d.prepare('INSERT INTO kanban_links (parent_id, child_id, created_at) VALUES (?, ?, ?)');
    for (const parent of parents) link.run(parent, taskId, now);
    subscribe(d, taskId, t.createdVia, createdFromTask, now);
    record(
```

In `src/db/kanban.ts`, replace:

```ts
/** A comment, on a task in any phase. The dispatcher forwards a person's to an undecided run (spec §7.5). */
```

with:

```ts
/**
 * The chats that follow a new task (spec §9.4, §7.3): the chat it was created
 * in; or, for a task a run created, every chat following the creating run's
 * task, so whoever follows that task hears about its follow-ups too. Each cursor
 * starts at 0: every event of the new task is newer than that.
 */
function subscribe(d: Db, taskId: string, via: CreatedVia, createdFromTask: string | null, now: number): void {
  const insert = d.prepare(
    `INSERT OR IGNORE INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  if (via.kind === 'chat') {
    insert.run(taskId, via.channel, via.appId, via.conversationId, via.threadId, now);
    return;
  }
  if (createdFromTask === null) return;
  for (const s of subscriptionsOf(d, createdFromTask)) {
    insert.run(taskId, s.channel, s.appId, s.conversationId, s.threadId, now);
  }
}

/**
 * Move a subscription's cursor to an event it has been told of, or passed over as
 * no notice (spec §9.4). Forward only, so a slower round cannot move it back and
 * have a notice sent twice. It writes no event: the cursor is the projection's
 * own, as a binding's `cursor_seq` is, and an event here would itself be a new
 * event past the cursor.
 */
export function advanceSubscription(db: Db, subscriptionId: number, cursor: number): Result<{ advanced: boolean }> {
  return tx(db, (d) => {
    const found = d.prepare<[number], { id: number }>('SELECT id FROM kanban_subscriptions WHERE id = ?').get(subscriptionId);
    if (found === undefined) return refuse('not_found', `no subscription ${subscriptionId}`);
    const { changes } = d
      .prepare('UPDATE kanban_subscriptions SET cursor = ? WHERE id = ? AND cursor < ?')
      .run(cursor, subscriptionId, cursor);
    return { ok: true, advanced: changes === 1 };
  });
}

/** A comment, on a task in any phase. The dispatcher forwards a person's to an undecided run (spec §7.5). */
```

In `src/db/kanban.ts`, replace:

```ts
        payload: { outcome: ending.outcome, error: ending.error ?? null, next, blockKind: blockAs?.kind ?? null },
```

with:

```ts
        payload: {
          outcome: ending.outcome,
          error: ending.error ?? null,
          next,
          blockKind: blockAs?.kind ?? null,
          // For the blocked notice (spec §9.4): what the task's block_reason says now.
          blockReason: blockAs?.reason ?? null,
        },
```

In `src/kanban/service.ts`, replace:

```ts
import { gatesOf, getRun, getTask, runsOf, taskView, type TaskView } from '../db/kanban-read.js';
```

with:

```ts
import { boardList, gatesOf, getRun, getTask, runsOf, taskView, type BoardEntry, type TaskView } from '../db/kanban-read.js';
```

In `src/kanban/service.ts`, replace:

```ts
    const view = taskView(this.#db, taskId);
    return view === undefined ? board.refuse('not_found', `no task ${taskId}`) : { ok: true, view };
  }
```

with:

```ts
    const view = taskView(this.#db, taskId);
    return view === undefined ? board.refuse('not_found', `no task ${taskId}`) : { ok: true, view };
  }

  /** Every task with its display status (spec §4.1): `/kanban list`. */
  list(): BoardEntry[] {
    return boardList(this.#db);
  }

  /**
   * A subscription has been told of every event up to `cursor`, or passed over
   * those that are no notice (spec §9.4). The notifier calls it after each send.
   */
  advanceSubscription(subscriptionId: number, cursor: number): Result<{ advanced: boolean }> {
    if (!Number.isSafeInteger(subscriptionId) || !Number.isSafeInteger(cursor) || cursor < 0) {
      return board.refuse('invalid', 'a subscription and its cursor are whole numbers');
    }
    return board.advanceSubscription(this.#db, subscriptionId, cursor);
  }
```

In `src/db/WRITERS.md`, replace:

```md
| `kanban_subscriptions` | `db/kanban.ts` | No writer until plan D, which adds its functions to `db/kanban.ts`. |
```

with:

```md
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. Never deleted. |
```


- [ ] **Step 2.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-subscriptions.test.ts`. Expected: `Tests  7 passed (7)`.

- [ ] **Step 2.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1159 passed (1159)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.6: Commit.**

```bash
git add src/kanban/types.ts src/db/kanban-read.ts src/db/kanban.ts src/kanban/service.ts src/db/WRITERS.md tests/kanban-subscriptions.test.ts
git commit -m "Subscribe the chat a task is created in, and the chats following its creating run's task, and list the board with each task's status"
```

---

### Task 3: Parsing `/kanban`

**Files:**
- Create: `src/kanban/chat-parse.ts`, `tests/kanban-chat-parse.test.ts`

What follows `/kanban`, as the router passes it — the whole argument, line breaks kept — parsed into a command, or the usage line to show (spec §9.1; Decisions 5, 10, 11, 13). Pure: tiers, identity and the board are Task 5's. The person-only verbs parse as `later`, so they are answered rather than unknown.

- [ ] **Step 3.1: Write the failing tests.**

Create `tests/kanban-chat-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseKanban } from '../src/kanban/chat-parse.js';

/** `/kanban` as typed in chat (spec §9.1): what follows the command, parsed. */

describe('/kanban new', () => {
  it('takes the title from the first line, fields from labelled lines in any order, and the rest as the body', () => {
    const r = parseKanban(
      [
        'new  Write the release notes ',
        'assignee: docs-writer',
        'The notes cover 0.4.',
        'Workspace: docs',
        'parent: k_a, k_b',
        'parent: k_c',
        'outcome: notes merged',
        'verify: a reviewer reads them',
        'constraints: no marketing words',
        'boundaries: docs/ only',
        'stop when: the changelog is missing',
        '  outcome: an indented line stays body',
        'reviewer: reviewer',
      ].join('\n'),
    );
    expect(r).toEqual({
      ok: true,
      command: {
        verb: 'new',
        title: 'Write the release notes',
        body: 'The notes cover 0.4.\n  outcome: an indented line stays body',
        assignee: 'docs-writer',
        reviewer: 'reviewer',
        workspace: 'docs',
        parents: ['k_a', 'k_b', 'k_c'],
        contract: {
          outcome: 'notes merged',
          verification: 'a reviewer reads them',
          constraints: 'no marketing words',
          boundaries: 'docs/ only',
          stop_when: 'the changelog is missing',
        },
      },
    });
  });

  it('takes a title alone, and a title on the line after the verb', () => {
    expect(parseKanban('new Tidy the wiki')).toEqual({
      ok: true,
      command: { verb: 'new', title: 'Tidy the wiki', body: '', parents: [], contract: {} },
    });
    expect(parseKanban('NEW\nTidy the wiki\n\n\nWhat it is about.')).toMatchObject({
      ok: true,
      command: { title: 'Tidy the wiki', body: 'What it is about.' },
    });
  });

  it('refuses no title, a field given twice, and a field with no value', () => {
    expect(parseKanban('new')).toMatchObject({ ok: false, usage: expect.stringContaining('Put the title on the first line') });
    expect(parseKanban('new t\nassignee: a\nassignee: b')).toEqual({ ok: false, usage: '`assignee:` is given twice.' });
    expect(parseKanban('new t\nverify:')).toEqual({ ok: false, usage: '`verify:` needs a value.' });
  });
});

describe('the other /kanban commands', () => {
  it('parses each, with its task ids and text', () => {
    expect(parseKanban('')).toEqual({ ok: true, command: { verb: 'help' } });
    expect(parseKanban('help')).toEqual({ ok: true, command: { verb: 'help' } });
    expect(parseKanban('list')).toEqual({ ok: true, command: { verb: 'list', filter: undefined } });
    expect(parseKanban('list Blocked')).toEqual({ ok: true, command: { verb: 'list', filter: 'blocked' } });
    expect(parseKanban('list all')).toEqual({ ok: true, command: { verb: 'list', filter: 'all' } });
    expect(parseKanban('show k_1')).toEqual({ ok: true, command: { verb: 'show', taskId: 'k_1' } });
    expect(parseKanban('stop k_1')).toEqual({ ok: true, command: { verb: 'stop', taskId: 'k_1' } });
    expect(parseKanban('archive k_1')).toEqual({ ok: true, command: { verb: 'archive', taskId: 'k_1' } });
    expect(parseKanban('assign k_1 reviewer')).toEqual({
      ok: true,
      command: { verb: 'assign', taskId: 'k_1', assignee: 'reviewer' },
    });
    expect(parseKanban('link k_1 k_2')).toEqual({ ok: true, command: { verb: 'link', parentId: 'k_1', childId: 'k_2' } });
    expect(parseKanban('workspace k_1 docs')).toEqual({
      ok: true,
      command: { verb: 'workspace', taskId: 'k_1', workspace: 'docs' },
    });
    expect(parseKanban('comment k_1 use the 2024 numbers\nnot 2023')).toEqual({
      ok: true,
      command: { verb: 'comment', taskId: 'k_1', text: 'use the 2024 numbers\nnot 2023' },
    });
    expect(parseKanban('unblock k_1')).toEqual({ ok: true, command: { verb: 'unblock', taskId: 'k_1', comment: undefined } });
    expect(parseKanban('unblock k_1 the key is in the vault now')).toEqual({
      ok: true,
      command: { verb: 'unblock', taskId: 'k_1', comment: 'the key is in the vault now' },
    });
  });

  it('keeps a gate command as written, after an optional timeout', () => {
    expect(parseKanban("gate add k_1 test -f notes.md && grep -q '0.4' notes.md")).toEqual({
      ok: true,
      command: { verb: 'gate add', taskId: 'k_1', command: "test -f notes.md && grep -q '0.4' notes.md", timeoutS: undefined },
    });
    expect(parseKanban('gate add k_1 --timeout 60 curl -fsS https://example.invalid/health')).toEqual({
      ok: true,
      command: { verb: 'gate add', taskId: 'k_1', command: 'curl -fsS https://example.invalid/health', timeoutS: 60 },
    });
    expect(parseKanban('gate list k_1')).toEqual({ ok: true, command: { verb: 'gate list', taskId: 'k_1' } });
    expect(parseKanban('gate remove k_1 3')).toEqual({ ok: true, command: { verb: 'gate remove', taskId: 'k_1', gateId: 3 } });
  });

  it("names the people's commands, which arrive in plan D2", () => {
    for (const name of ['done', 'block', 'review', 'approve', 'changes']) {
      expect(parseKanban(`${name} k_1 looks good`)).toEqual({ ok: true, command: { verb: 'later', name } });
    }
  });

  it('answers a wrong command line with its usage, and an unknown one escaped', () => {
    for (const text of [
      'show',
      'show k_1 k_2',
      'assign k_1',
      'link k_1',
      'workspace k_1',
      'comment k_1',
      'unblock',
      'list soon',
      'list ready now',
      'gate',
      'gate add k_1',
      'gate add k_1 --timeout 0 true',
      'gate add k_1 --timeout x true',
      'gate remove k_1 one',
      'gate remove k_1 0',
    ]) {
      expect([text, parseKanban(text)]).toEqual([text, { ok: false, usage: expect.stringMatching(/^Usage: `\/kanban /) }]);
    }
    expect(parseKanban('frob_nicate k_1')).toEqual({
      ok: false,
      usage: 'Unknown `/kanban` command `frob\\_nicate`. `/kanban help` lists them.',
    });
  });
});
```


- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-chat-parse.test.ts`. Expected: the file FAILS to load, with `Error: Cannot find module '../src/kanban/chat-parse.js'`. `Tests  no tests`.

- [ ] **Step 3.3: Implement.**

Create `src/kanban/chat-parse.ts`:

```ts
import { forDisplay } from '../channel/escape.js';
import type { DisplayStatus } from './status.js';
import type { Contract } from './types.js';

/**
 * `/kanban` as typed in chat (spec §9.1), parsed into what to do. Pure: no
 * board, no tiers, no identity -- those are `KanbanChat`'s. A parse that fails
 * carries the usage line to show, already escaped.
 */

/** The display statuses `/kanban list` can filter by, and `all`. */
export const LIST_FILTERS: readonly (DisplayStatus | 'all')[] = [
  'todo',
  'ready',
  'running',
  'review',
  'reviewing',
  'blocked',
  'done',
  'archived',
  'all',
];

/** The commands for people's own tasks, which arrive with people in plan D2. */
export const LATER_VERBS = ['done', 'block', 'review', 'approve', 'changes'] as const;
export type LaterVerb = (typeof LATER_VERBS)[number];

export interface NewTaskCommand {
  verb: 'new';
  title: string;
  body: string;
  assignee?: string;
  reviewer?: string;
  workspace?: string;
  parents: string[];
  contract: Contract;
}

export type KanbanCommand =
  | { verb: 'help' }
  | NewTaskCommand
  | { verb: 'list'; filter: DisplayStatus | 'all' | undefined }
  | { verb: 'show'; taskId: string }
  | { verb: 'assign'; taskId: string; assignee: string }
  | { verb: 'link'; parentId: string; childId: string }
  | { verb: 'workspace'; taskId: string; workspace: string }
  | { verb: 'comment'; taskId: string; text: string }
  | { verb: 'unblock'; taskId: string; comment: string | undefined }
  | { verb: 'stop'; taskId: string }
  | { verb: 'archive'; taskId: string }
  | { verb: 'gate add'; taskId: string; command: string; timeoutS: number | undefined }
  | { verb: 'gate list'; taskId: string }
  | { verb: 'gate remove'; taskId: string; gateId: number }
  | { verb: 'later'; name: LaterVerb };

export type ParsedKanban = { ok: true; command: KanbanCommand } | { ok: false; usage: string };

/** Each verb's usage line, as `/kanban help` shows it. */
export const USAGE = {
  new: '/kanban new <title>, then lines assignee:, reviewer:, workspace:, parent:, outcome:, verify:, constraints:, boundaries:, stop when:, and the body',
  list: `/kanban list [${LIST_FILTERS.join('|')}]`,
  show: '/kanban show <task>',
  assign: '/kanban assign <task> <role>',
  link: '/kanban link <parent> <child>',
  workspace: '/kanban workspace <task> <workspace>',
  comment: '/kanban comment <task> <text>',
  unblock: '/kanban unblock <task> [comment]',
  stop: '/kanban stop <task>',
  archive: '/kanban archive <task>',
  'gate add': '/kanban gate add <task> [--timeout <seconds>] <command>',
  'gate list': '/kanban gate list <task>',
  'gate remove': '/kanban gate remove <task> <gate>',
} as const;

/**
 * The lines of `/kanban new` that fill a field (spec §9.1), by their label. A
 * label is matched at the start of a line, in any case, followed by a colon: a
 * body line that only mentions one, indented or mid-sentence, stays body.
 */
const FIELDS = {
  assignee: 'assignee',
  reviewer: 'reviewer',
  workspace: 'workspace',
  parent: 'parent',
  outcome: 'outcome',
  verify: 'verification',
  constraints: 'constraints',
  boundaries: 'boundaries',
  'stop when': 'stop_when',
} as const;
type FieldLabel = keyof typeof FIELDS;

const FIELD_LINE = /^(assignee|reviewer|workspace|parent|outcome|verify|constraints|boundaries|stop when)[ \t]*:[ \t]*(.*)$/i;

function usage(verb: keyof typeof USAGE): ParsedKanban {
  return { ok: false, usage: `Usage: \`${USAGE[verb]}\`` };
}

/** The next word, and what follows it with the spaces after the word, and one line break, removed. */
function shift(text: string): [string, string] {
  const m = /^\s*(\S+)[ \t]*(?:\r?\n)?([\s\S]*)$/.exec(text);
  return m === null ? ['', ''] : [m[1] ?? '', m[2] ?? ''];
}

/** Exactly `n` words, or undefined. */
function words(text: string, n: number): string[] | undefined {
  const all = text.trim() === '' ? [] : text.trim().split(/\s+/);
  return all.length === n ? all : undefined;
}

/**
 * Parse what follows `/kanban`. The router gives the whole argument, newlines
 * kept: `/kanban new` and `/kanban comment` take several lines.
 */
export function parseKanban(arg: string): ParsedKanban {
  const [rawVerb, rest] = shift(arg);
  const verb = rawVerb.toLowerCase();
  switch (verb) {
    case '':
    case 'help':
      return { ok: true, command: { verb: 'help' } };
    case 'new':
      return parseNew(rest);
    case 'list': {
      const w = words(rest, 0) ?? words(rest, 1);
      const filter = w?.[0]?.toLowerCase();
      if (w === undefined) return usage('list');
      if (filter === undefined) return { ok: true, command: { verb: 'list', filter: undefined } };
      const known = LIST_FILTERS.find((f) => f === filter);
      return known === undefined ? usage('list') : { ok: true, command: { verb: 'list', filter: known } };
    }
    case 'show':
    case 'stop':
    case 'archive': {
      const w = words(rest, 1);
      return w?.[0] === undefined ? usage(verb) : { ok: true, command: { verb, taskId: w[0] } };
    }
    case 'assign': {
      const w = words(rest, 2);
      if (w?.[0] === undefined || w[1] === undefined) return usage('assign');
      return { ok: true, command: { verb: 'assign', taskId: w[0], assignee: w[1] } };
    }
    case 'link': {
      const w = words(rest, 2);
      if (w?.[0] === undefined || w[1] === undefined) return usage('link');
      return { ok: true, command: { verb: 'link', parentId: w[0], childId: w[1] } };
    }
    case 'workspace': {
      const w = words(rest, 2);
      if (w?.[0] === undefined || w[1] === undefined) return usage('workspace');
      return { ok: true, command: { verb: 'workspace', taskId: w[0], workspace: w[1] } };
    }
    case 'comment': {
      const [taskId, text] = shift(rest);
      if (taskId === '' || text.trim() === '') return usage('comment');
      return { ok: true, command: { verb: 'comment', taskId, text: text.trim() } };
    }
    case 'unblock': {
      const [taskId, text] = shift(rest);
      if (taskId === '') return usage('unblock');
      const comment = text.trim();
      return { ok: true, command: { verb: 'unblock', taskId, comment: comment === '' ? undefined : comment } };
    }
    case 'gate':
      return parseGate(rest);
    default: {
      const later = LATER_VERBS.find((v) => v === verb);
      if (later !== undefined) return { ok: true, command: { verb: 'later', name: later } };
      return { ok: false, usage: `Unknown \`/kanban\` command \`${forDisplay(rawVerb)}\`. \`/kanban help\` lists them.` };
    }
  }
}

function parseGate(text: string): ParsedKanban {
  const [rawSub, rest] = shift(text);
  const sub = rawSub.toLowerCase();
  if (sub === 'list') {
    const w = words(rest, 1);
    return w?.[0] === undefined ? usage('gate list') : { ok: true, command: { verb: 'gate list', taskId: w[0] } };
  }
  if (sub === 'remove') {
    const w = words(rest, 2);
    const gateId = Number(w?.[1]);
    if (w?.[0] === undefined || !/^[1-9][0-9]*$/.test(w[1] ?? '') || !Number.isSafeInteger(gateId)) {
      return usage('gate remove');
    }
    return { ok: true, command: { verb: 'gate remove', taskId: w[0], gateId } };
  }
  if (sub !== 'add') return usage('gate add');
  const [taskId, after] = shift(rest);
  let command = after;
  let timeoutS: number | undefined;
  const timed = /^[ \t]*--timeout[ \t]+(\S+)([\s\S]*)$/.exec(command);
  if (timed !== null) {
    if (!/^[1-9][0-9]*$/.test(timed[1] ?? '')) return usage('gate add');
    timeoutS = Number(timed[1]);
    command = (timed[2] ?? '').replace(/^[ \t]+/, '');
  }
  command = command.trim();
  if (taskId === '' || command === '') return usage('gate add');
  return { ok: true, command: { verb: 'gate add', taskId, command, timeoutS } };
}

/**
 * `/kanban new <title>`, then the field lines and the body, in any order
 * (spec §9.1). A field may be given once, `parent:` as often as needed, each
 * line one or more task ids.
 */
function parseNew(text: string): ParsedKanban {
  const [first = '', ...lines] = text.split(/\r?\n/);
  const title = first.trim();
  if (title === '') return { ok: false, usage: `Put the title on the first line. Usage: \`${USAGE.new}\`` };
  const seen = new Set<FieldLabel>();
  const out: NewTaskCommand = { verb: 'new', title, body: '', parents: [], contract: {} };
  const body: string[] = [];
  for (const line of lines) {
    const m = FIELD_LINE.exec(line);
    if (m === null) {
      body.push(line);
      continue;
    }
    const label = (m[1] ?? '').toLowerCase() as FieldLabel;
    const value = (m[2] ?? '').trim();
    if (value === '') return { ok: false, usage: `\`${label}:\` needs a value.` };
    if (label === 'parent') {
      out.parents.push(...value.split(/[\s,]+/).filter((id) => id !== ''));
      continue;
    }
    if (seen.has(label)) return { ok: false, usage: `\`${label}:\` is given twice.` };
    seen.add(label);
    const field = FIELDS[label];
    if (field === 'assignee' || field === 'reviewer' || field === 'workspace') out[field] = value;
    else out.contract[field] = value;
  }
  out.body = body.join('\n').replace(/^\s*\n/, '').trimEnd();
  return { ok: true, command: out };
}
```


- [ ] **Step 3.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-chat-parse.test.ts`. Expected: `Tests  7 passed (7)`.

- [ ] **Step 3.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1166 passed (1166)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.6: Commit.**

```bash
git add src/kanban/chat-parse.ts tests/kanban-chat-parse.test.ts
git commit -m "Parse what follows /kanban in chat: a new task's field lines and body, each command's arguments, and the usage of a wrong one"
```

---

### Task 4: What the board says in chat, and its notices

**Files:**
- Create: `src/kanban/chat-render.ts`, `tests/kanban-chat-render.test.ts`

The text of `/kanban help`, `list`, `show` and `gate list`, and of each notice a subscription hears (spec §9.3, §9.4; Decisions 11, 12, 14, 17). Pure, given the secret set. Every piece of task text is masked and cut before it is escaped; free text keeps its markdown, quoted under its label; labels and gate commands are escaped whole, and a gate command defined before a secret became known is still shown masked (spec §7.7).

- [ ] **Step 4.1: Write the failing tests.**

Create `tests/kanban-chat-render.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addComment, addGate, block, complete, createTask, endRun, DEFAULT_LIMITS } from '../src/db/kanban.js';
import { boardList, eventsOf, getTask, taskView } from '../src/db/kanban-read.js';
import { renderGates, renderHelp, renderList, renderNotice, renderShow } from '../src/kanban/chat-render.js';
import type { KanbanEvent, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * What /kanban says, and what a subscription hears (spec §9.3, §9.4): task text
 * is untrusted, so it is escaped -- a tag can never become a mention -- and
 * masked before it is cut.
 */

let h: TestDb;

beforeEach(() => {
  clearSecrets();
  h = testDb();
});
afterEach(() => {
  clearSecrets();
  h.close();
});

const SPOOF = 'hi <at id=all></at> team';

function last(taskId: string): KanbanEvent {
  const e = eventsOf(h.db, taskId).at(-1);
  if (e === undefined) throw new Error('no event');
  return e;
}

function task(taskId: string): TaskRow {
  const t = getTask(h.db, taskId);
  if (t === undefined) throw new Error('no task');
  return t;
}

const LIMIT = { blockRecurrenceLimit: 2 };

describe('/kanban help', () => {
  it('lists every command with the tier it needs, and says people arrive in plan D2', () => {
    const help = renderHelp();
    for (const verb of ['new', 'list', 'show', 'assign', 'link', 'workspace', 'comment', 'unblock', 'stop', 'archive']) {
      expect(help).toContain(`/kanban ${verb}`);
    }
    expect(help).toContain('`/kanban gate add <task> [--timeout <seconds>] <command>` (operator)');
    expect(help).toContain('`/kanban list');
    expect(help).toContain('(anyone allowed)');
    expect(help).toContain('plan D2');
  });
});

describe('/kanban list', () => {
  it('shows the open tasks by status, escaped, and a filter or all', () => {
    const ready = newTask(h.db, { title: `ready ${SPOOF}` });
    const running = newTask(h.db, { title: 'running_one' });
    claimed(h.db, running.taskId);
    const done = newTask(h.db, { title: 'finished', workspace: 'web' });
    const run = claimed(h.db, done.taskId);
    expect(complete(h.db, done.taskId, { kind: 'run', runId: run.runId }, { summary: 'ok' }, NOW).ok).toBe(true);

    const board = boardList(h.db);
    const open = renderList(board, undefined);
    expect(open.split('\n')).toEqual([
      `\`${running.taskId}\` **running** — running\\_one · role implementer`,
      `\`${ready.taskId}\` **ready** — ready hi \\<at id=all\\>\\</at\\> team · role implementer`,
    ]);
    expect(renderList(board, 'done')).toContain(done.taskId);
    expect(renderList(board, 'done')).not.toContain(ready.taskId);
    expect(renderList(board, 'all').split('\n')).toHaveLength(3);
    expect(renderList(board, 'archived')).toBe('No archived tasks.');
    expect(renderList([], undefined)).toBe('No open tasks. `/kanban list all` shows done and archived ones too.');
  });

  it('shows at most 30, and says how many more there are', () => {
    for (let i = 0; i < 32; i += 1) newTask(h.db, { title: `task ${i}` });
    const lines = renderList(boardList(h.db), undefined).split('\n');
    expect(lines).toHaveLength(31);
    expect(lines[30]).toMatch(/^… and 2 more\. /);
  });
});

describe('/kanban show', () => {
  it('shows the task, its contract, gates, runs, latest output and comments, escaped and masked', () => {
    const k = newTask(h.db, {
      title: 'Write *the* notes',
      body: `Line one ${SPOOF}\n# not a heading`,
      contract: { outcome: 'notes_merged', stop_when: 'no changelog' },
      workspace: 'docs',
    });
    expect(addGate(h.db, k.taskId, { command: 'test -f notes.md --key sk-late-12345678', timeoutS: 30 }, ALICE, NOW).ok).toBe(
      true,
    );
    const run = claimed(h.db, k.taskId);
    expect(
      endRun(h.db, run.runId, { outcome: 'failed', error: 'exit 1', lastOutput: 'wrote <b>notes</b>' }, DEFAULT_LIMITS, NOW).ok,
    ).toBe(true);
    expect(addComment(h.db, k.taskId, ALICE, 'use the 2024 numbers', NOW).ok).toBe(true);
    // Known only now: a gate defined before the secret was is still shown masked.
    addSecrets(['sk-late-12345678']);

    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, [
      { id: 1, taskId: k.taskId, command: 'test -f notes.md --key sk-late-12345678', timeoutS: 30, createdBy: ALICE, createdAt: NOW },
    ]);
    expect(text.split('\n')).toEqual([
      `**Write \\*the\\* notes** \`${k.taskId}\` — ready`,
      'assignee: role implementer · reviewer: nobody · workspace: docs',
      '> Line one hi \\<at id=all\\>\\</at\\> team',
      '> # not a heading',
      '**Contract**',
      'outcome: notes\\_merged',
      'stop\\_when: no changelog',
      '**Gates**',
      `1. test -f notes.md --key ${MASK} (30 s)`,
      '**Runs**',
      '#1 work · role implementer · failed — exit 1',
      'Latest output:',
      '> wrote \\<b\\>notes\\</b\\>',
      '**Comments** (1 of 1)',
      'lark:on\\_alice:',
      '> use the 2024 numbers',
    ]);
  });

  it('masks a secret before it cuts a long piece, so no start of it shows', () => {
    addSecrets(['sk-split-1234567890']);
    const k = newTask(h.db, { body: `${'x'.repeat(1490)}sk-split-1234567890 and more` });
    const view = taskView(h.db, k.taskId);
    if (view === undefined) throw new Error('no view');
    const text = renderShow(view, []);
    expect(text).not.toContain('sk-split');
    expect(text).toContain('(truncated)');
  });
});

describe('/kanban gate list', () => {
  it('shows each gate masked, in order, with its timeout and who defined it', () => {
    addSecrets(['sk-gate-12345678']);
    expect(
      renderGates('k_1', [
        { id: 4, taskId: 'k_1', command: 'curl -H "k: sk-gate-12345678" https://ci', timeoutS: 60, createdBy: ALICE, createdAt: NOW },
        { id: 7, taskId: 'k_1', command: 'test -s report_final.md', timeoutS: 300, createdBy: 'operator:alice', createdAt: NOW },
      ]).split('\n'),
    ).toEqual([
      'Gates of `k_1`, run in this order before it may complete or go to review:',
      `4. curl -H "k: ${MASK}" https://ci (60 s, by lark:on\\_alice)`,
      '7. test -s report\\_final.md (300 s, by operator:alice)',
    ]);
    expect(renderGates('k_1', [])).toBe('Task `k_1` has no gates.');
  });
});

describe('notices', () => {
  it('tells of a completion, with its summary kept as markdown and its tags neutralized', () => {
    const k = newTask(h.db, { title: 'Release notes' });
    const run = claimed(h.db, k.taskId);
    expect(complete(h.db, k.taskId, { kind: 'run', runId: run.runId }, { summary: `**merged** ${SPOOF}` }, NOW).ok).toBe(true);
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toBe(
      `Done — **Release notes** \`${k.taskId}\`:\n> **merged** hi \\<at id=all\\>\\</at\\> team`,
    );
  });

  it('tells of a block with its kind and reason, and asks for a rewrite once it keeps recurring', () => {
    const k = newTask(h.db, { title: 'Fetch the report' });
    const run = claimed(h.db, k.taskId);
    const by = { kind: 'run' as const, runId: run.runId };
    expect(block(h.db, k.taskId, by, { kind: 'capability', reason: 'no access to the_drive' }, NOW).ok).toBe(true);
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toBe(
      `Blocked (capability) — **Fetch the report** \`${k.taskId}\`: no access to the\\_drive\n` +
        `\`/kanban unblock ${k.taskId} [comment]\` once it can go on.`,
    );
    const again = { ...last(k.taskId), payload: { kind: 'capability', reason: 'still no access', blockRecurrences: 2 } };
    expect(renderNotice(again, task(k.taskId), LIMIT)).toContain('It keeps blocking for the same reason (2 times after an unblock)');
  });

  it('says nothing of a dependency block, a throttled cooldown, or an event that is no notice', () => {
    const k = newTask(h.db);
    const t = task(k.taskId);
    const event = (kind: string, payload: unknown): KanbanEvent => ({ ...last(k.taskId), kind, payload });
    expect(renderNotice(event('blocked', { kind: 'dependency', reason: 'waits', parents: [] }), t, LIMIT)).toBeUndefined();
    expect(renderNotice(event('run_ended', { outcome: 'rate_limited', next: 'cooldown' }), t, LIMIT)).toBeUndefined();
    for (const kind of ['created', 'claimed', 'commented', 'linked', 'gates_ran', 'archived', 'changes_requested']) {
      expect(renderNotice(event(kind, {}), t, LIMIT)).toBeUndefined();
    }
  });

  it('tells of a retry after a failure, of giving up, of a stop, of a review requested and of a stranded task', () => {
    const k = newTask(h.db, { title: 'Survey' });
    const t = task(k.taskId);
    const event = (kind: string, payload: unknown, actor = 'gateway'): KanbanEvent => ({ ...last(k.taskId), kind, actor, payload });
    const name = `**Survey** \`${k.taskId}\``;
    expect(renderNotice(event('run_ended', { outcome: 'crashed', error: 'exit_1', next: 'retry' }), t, LIMIT)).toBe(
      `Retrying — ${name}: the last attempt ended crashed: exit\\_1.`,
    );
    expect(
      renderNotice(
        event('run_ended', { outcome: 'failed', next: 'blocked', blockKind: 'gave_up', blockReason: 'failed 2 times; last failed' }),
        t,
        LIMIT,
      ),
    ).toBe(`Gave up — ${name}: failed 2 times; last failed\n\`/kanban unblock ${k.taskId} [comment]\` gives it a fresh set of attempts.`);
    expect(
      renderNotice(event('run_ended', { outcome: 'terminal_provider', next: 'blocked', blockKind: 'capability', blockReason: '401' }), t, LIMIT),
    ).toMatch(/^Blocked \(capability\) — .*: 401\n/);
    expect(renderNotice(event('stopped', { blockRecurrences: 0 }, ALICE), t, LIMIT)).toMatch(
      /^Blocked \(needs\\_input\) — .*: stopped by lark:on\\_alice\n/,
    );
    expect(renderNotice(event('review_requested', { summary: 'v1', reviewer: 'reviewer', reviewerKind: 'role' }), t, LIMIT)).toBe(
      `Review requested — ${name}, from role reviewer.`,
    );
    expect(renderNotice(event('stranded', { reason: 'role "gone" is not configured' }), t, LIMIT)).toBe(
      `Stranded — ${name}: nobody can be given it: role "gone" is not configured`,
    );
  });

  it('masks a secret in what it tells', () => {
    addSecrets(['sk-said-12345678']);
    const created = createTask(h.db, { title: 'a task', createdBy: ALICE, createdVia: VIA }, NOW);
    if (!created.ok) throw new Error(created.message);
    const event: KanbanEvent = { ...last(created.task.taskId), kind: 'stranded', payload: { reason: 'key sk-said-12345678 refused' } };
    expect(renderNotice(event, created.task, LIMIT)).toContain(`key ${MASK} refused`);
  });
});
```


- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-chat-render.test.ts`. Expected: the file FAILS to load, with `Error: Cannot find module '../src/kanban/chat-render.js'`. `Tests  no tests`.

- [ ] **Step 4.3: Implement.**

Create `src/kanban/chat-render.ts`:

```ts
import { forDisplay, forMarkdown, truncate } from '../channel/escape.js';
import type { BoardEntry, TaskView } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import { LIST_FILTERS, USAGE } from './chat-parse.js';
import type { DisplayStatus } from './status.js';
import type { Assignee, GateRow, KanbanEvent, RunRow, TaskRow } from './types.js';

/**
 * What `/kanban` says in chat (spec §9.3), and the notices a subscription hears
 * (spec §9.4). Pure, given the secret set.
 *
 * All task text is untrusted -- an agent wrote some of it, and a body can be
 * pasted from anywhere. A body, a summary, a comment and an agent's output keep
 * their markdown through `forMarkdown`, which neutralizes Feishu's tags; titles,
 * names, reasons and errors go through `forDisplay`, which escapes everything.
 * A piece is masked and cut before it is escaped, so a cut cannot leave the
 * start of a secret showing, nor split an escape. Gate commands are shown
 * masked too: a secret may have become known after the gate was defined (spec
 * §7.7). The router masks each whole reply once more.
 */

/** Masked, control characters stripped, and cut to `max` characters: ready for an escaper. */
function clip(text: string, max: number): string {
  return truncate(redactKnownSecrets(stripControl(text)), max);
}

/** A label: one line, every markdown character escaped. */
function label(text: string, max = 200): string {
  return forDisplay(clip(text.replace(/\s+/g, ' ').trim(), max));
}

/** Free text that keeps its markdown, indented under its label so it cannot start a heading. */
function block(text: string, max: number): string {
  return forMarkdown(clip(text.trim(), max))
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function who(a: Assignee | null): string {
  if (a === null) return 'nobody';
  return a.kind === 'role' ? `role ${label(a.name)}` : label(a.name);
}

function id(taskId: string): string {
  return `\`${taskId}\``;
}

const LIST_MAX = 30;

/** The statuses `/kanban list` shows with no filter: everything someone may still act on. */
const ACTIVE: readonly DisplayStatus[] = ['running', 'reviewing', 'review', 'ready', 'todo', 'blocked'];

/** `/kanban help`: every command, with the tier it needs (spec §9.1). */
export function renderHelp(): string {
  const operate = 'operator';
  const talk = 'anyone allowed';
  const lines: Array<[string, string]> = [
    [USAGE.new, operate],
    [USAGE.list, talk],
    [USAGE.show, talk],
    [USAGE.assign, operate],
    [USAGE.link, operate],
    [USAGE.workspace, operate],
    [USAGE.comment, talk],
    [USAGE.unblock, operate],
    [USAGE.stop, operate],
    [USAGE.archive, operate],
    [USAGE['gate add'], operate],
    [USAGE['gate list'], talk],
    [USAGE['gate remove'], operate],
  ];
  return [
    '**The task board.** A task is any work -- research, a document, an operation in Lark, a chore, a change to code -- given to a role, whose agent runs it in a workspace.',
    ...lines.map(([usage, tier]) => `\`${usage}\` (${tier})`),
    'Assignees and reviewers are roles for now: naming a person, with an @-mention, arrives in plan D2, with `/kanban done`, `block`, `review`, `approve` and `changes`.',
    'The chat a task is created in hears when it is done, needs review, blocks, is retried after a failure, gives up, or is stranded.',
  ].join('\n');
}

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
  const ordered =
    filter === undefined ? ACTIVE.flatMap((status) => shown.filter((e) => e.status === status)) : [...shown];
  const lines = ordered
    .slice(0, LIST_MAX)
    .map((e) => `${id(e.task.taskId)} **${e.status}** — ${label(e.task.title, 120)} · ${who(e.task.assignee)}`);
  const more = ordered.length - LIST_MAX;
  if (more > 0) lines.push(`… and ${more} more. \`/kanban list <${LIST_FILTERS.join('|')}>\` narrows it.`);
  return lines.join('\n');
}

function runLine(run: RunRow): string {
  const outcome = run.outcome === null ? (run.endedAt === null ? 'working' : 'undecided') : run.outcome;
  const head = `#${run.attempt} ${run.kind} · ${who(run.assignee)} · ${forDisplay(outcome)}`;
  const said = run.summary ?? run.error;
  return said === null || said === '' ? head : `${head} — ${label(said, 300)}`;
}

/** `/kanban show` (spec §9.1): the task, its contract, gates, runs, latest output and comments. */
export function renderShow(view: TaskView, gates: readonly GateRow[]): string {
  const { task } = view;
  const out: string[] = [
    `**${label(task.title)}** ${id(task.taskId)} — ${view.status}`,
    `assignee: ${who(task.assignee)} · reviewer: ${who(task.reviewer)} · workspace: ${task.workspace === null ? 'not yet fixed' : label(task.workspace)}`,
  ];
  if (task.phase === 'blocked' && task.blockKind !== null) {
    out.push(`blocked (${forDisplay(task.blockKind)}): ${label(task.blockReason ?? '', 500)}`);
  }
  if (view.parents.length > 0) {
    out.push(`parents: ${view.parents.map((p) => `${id(p.taskId)} (${p.phase})`).join(', ')}`);
  }
  if (view.children.length > 0) {
    out.push(`children: ${view.children.map((c) => `${id(c.taskId)} (${c.phase})`).join(', ')}`);
  }
  if (task.body.trim() !== '') out.push(block(task.body, 1500));
  const contract = Object.entries(task.contract).filter(([, v]) => v !== undefined && v.trim() !== '');
  if (contract.length > 0) {
    out.push('**Contract**');
    for (const [field, value] of contract) out.push(`${forDisplay(field)}: ${label(value ?? '', 400)}`);
  }
  if (gates.length > 0) {
    out.push('**Gates**');
    for (const g of gates) out.push(`${g.id}. ${label(g.command, 300)} (${g.timeoutS} s)`);
  }
  if (view.runs.length > 0) {
    out.push('**Runs**');
    for (const run of view.runs.slice(-5)) out.push(runLine(run));
    const last = view.runs.at(-1);
    const output = last?.lastOutput ?? null;
    if (output !== null && output.trim() !== '') out.push('Latest output:', block(output.slice(-2000), 800));
  }
  if (view.comments.length > 0) {
    const shown = view.comments.slice(-5);
    out.push(`**Comments** (${shown.length} of ${view.comments.length})`);
    for (const c of shown) out.push(`${label(c.author, 80)}:`, block(c.body, 400));
  }
  return out.join('\n');
}

/** `/kanban gate list` (spec §7.7): each gate's command masked, with its timeout and who defined it. */
export function renderGates(taskId: string, gates: readonly GateRow[]): string {
  if (gates.length === 0) return `Task ${id(taskId)} has no gates.`;
  return [
    `Gates of ${id(taskId)}, run in this order before it may complete or go to review:`,
    ...gates.map((g) => `${g.id}. ${label(g.command, 600)} (${g.timeoutS} s, by ${label(g.createdBy, 80)})`),
  ].join('\n');
}

/** The outcomes a retry follows that are failures to tell a subscriber of (spec §9.4). */
const RETRIED: ReadonlySet<string> = new Set(['failed', 'crashed', 'timed_out', 'protocol_violation', 'interrupted']);

function text(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

function blockedLine(task: TaskRow, kind: string, reason: string, recurrences: number, limit: number): string {
  const head = `Blocked (${forDisplay(kind)}) — **${label(task.title)}** ${id(task.taskId)}: ${label(reason, 800)}`;
  if (recurrences >= limit) {
    return (
      `${head}\nIt keeps blocking for the same reason (${recurrences} times after an unblock); ` +
      'rewrite the task, or archive it and create a clearer one, rather than unblocking it again.'
    );
  }
  return `${head}\n\`/kanban unblock ${task.taskId} [comment]\` once it can go on.`;
}

/**
 * The notice a subscription hears of one event (spec §9.4), or undefined when
 * the event is none: completed, review requested, blocked with its kind and
 * reason, retrying after a failure, gave up, stranded. A dependency block is not
 * one, since nobody needs to act; a throttled run's cooldown is not either, as it
 * clears by itself, and blocks as transient at its limit, which is one.
 */
export function renderNotice(event: KanbanEvent, task: TaskRow, opts: { blockRecurrenceLimit: number }): string | undefined {
  const p = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
  const name = `**${label(task.title)}** ${id(task.taskId)}`;
  const recurrences = typeof p['blockRecurrences'] === 'number' ? p['blockRecurrences'] : task.blockRecurrences;
  switch (event.kind) {
    case 'completed': {
      const summary = text(p, 'summary');
      return summary.trim() === '' ? `Done — ${name}.` : `Done — ${name}:\n${block(summary, 1200)}`;
    }
    case 'review_requested': {
      const reviewer = text(p, 'reviewer');
      const kind = p['reviewerKind'] === 'human' ? 'human' : 'role';
      return `Review requested — ${name}, from ${who(reviewer === '' ? null : { kind, name: reviewer })}.`;
    }
    case 'blocked': {
      const kind = text(p, 'kind');
      if (kind === '' || kind === 'dependency') return undefined;
      return blockedLine(task, kind, text(p, 'reason'), recurrences, opts.blockRecurrenceLimit);
    }
    case 'stopped':
      return blockedLine(task, 'needs_input', `stopped by ${event.actor}`, recurrences, opts.blockRecurrenceLimit);
    case 'run_ended': {
      const outcome = text(p, 'outcome');
      const error = text(p, 'error');
      if (p['next'] === 'retry' && RETRIED.has(outcome)) {
        const why = error === '' ? '' : `: ${label(error, 500)}`;
        return `Retrying — ${name}: the last attempt ended ${forDisplay(outcome)}${why}.`;
      }
      if (p['next'] !== 'blocked') return undefined;
      const kind = text(p, 'blockKind');
      const reason = text(p, 'blockReason');
      if (kind === 'gave_up') {
        return `Gave up — ${name}: ${label(reason, 800)}\n\`/kanban unblock ${task.taskId} [comment]\` gives it a fresh set of attempts.`;
      }
      return blockedLine(task, kind, reason, task.blockRecurrences, opts.blockRecurrenceLimit);
    }
    case 'stranded':
      return `Stranded — ${name}: nobody can be given it: ${label(text(p, 'reason'), 500)}`;
    default:
      return undefined;
  }
}
```


- [ ] **Step 4.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-chat-render.test.ts`. Expected: `Tests  11 passed (11)`.

- [ ] **Step 4.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1177 passed (1177)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.6: Commit.**

```bash
git add src/kanban/chat-render.ts tests/kanban-chat-render.test.ts
git commit -m "Render the board's chat replies and its subscription notices, escaped, with every piece masked before it is cut"
```

---

### Task 5: The commands, through the service

**Files:**
- Create: `src/kanban/chat.ts`, `tests/kanban-chat.test.ts`

`KanbanChat.run` does a parsed command (spec §9.1, §10; Decisions 5–10, 15): it checks the sender's tier with the router's authorizer, records who acted as `lark:<union_id>`, refuses a person or a supervised role with what D2 brings, calls `KanbanService` and nothing else, and tells the dispatcher — a pass after a change, and the cancel of the agent run's turn a change decided. It touches no chat session.

- [ ] **Step 5.1: Write the failing tests.**

Create `tests/kanban-chat.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commentsOf, eventsOf, gatesOf, getRun, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { KanbanService } from '../src/kanban/service.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { BindingKey, InboundMessage, Principal } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES, role } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * /kanban in chat (spec §9.1): tiers, the identity the board records, the
 * refusals of what arrives in plan D2, and every change done through the
 * service, with the dispatcher told.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };
const NAMELESS: Principal = { openId: 'ou_owner', unionId: null, displayName: 'Owner' };
const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };

let t: TestDb;
let service: KanbanService;
let chat: KanbanChat;
let passes: number;
let cancelled: string[];
let seq = 0;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  service = new KanbanService({
    db: t.db,
    roles: new Map(
      [...DEFAULT_ROLES, role('watched', { agent: { ...DEFAULT_ROLES[0]!.agent, unsupervised: false } })].map((r) => [
        r.name,
        r,
      ]),
    ),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, GUEST.openId] });
  passes = 0;
  cancelled = [];
  chat = new KanbanChat({
    service,
    hasTier: (p, tier) => authorizer.hasTier(p, tier),
    changed: () => (passes += 1),
    cancel: (runId) => cancelled.push(runId),
  });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function message(sender: Principal = OWNER, messageId = `om_${++seq}`): InboundMessage {
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
    attachments: [],
    createTime: 0,
  };
}

function say(arg: string, sender: Principal = OWNER): Promise<string> {
  return chat.run(arg, message(sender), KEY);
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
  });

  it('makes one task of one message, however often it arrives', async () => {
    const first = created(await chat.run('new Once', message(OWNER, 'om_same'), KEY));
    expect(await chat.run('new Once', message(OWNER, 'om_same'), KEY)).toBe(`Already created, as \`${first}\`.`);
    expect(taskCount()).toBe(1);
  });

  it('refuses an unknown role or workspace, a person, and a supervised role, creating nothing', async () => {
    expect(await say('new t\nassignee: nobody-here')).toBe('Not done: role "nobody-here" is not configured');
    expect(await say('new t\nassignee: implementer\nworkspace: nowhere')).toBe(
      'Not done: workspace "nowhere" is not configured',
    );
    for (const line of ['assignee: @Alice', 'reviewer: @Bob', 'assignee: lark:on_alice']) {
      expect(await say(`new t\n${line}`)).toContain('Naming a person as an assignee or reviewer arrives in plan D2.');
    }
    expect(await say('new t\nassignee: watched')).toBe(
      'role "watched" has a supervised agent; its approval requests cannot be forwarded to a chat yet. That arrives in plan D2.',
    );
    expect(taskCount()).toBe(0);
  });
});

describe('tiers and identity', () => {
  it('lets a talk-tier sender read and comment, and refuses every change of the board', async () => {
    const taskId = created(await say('new A task\nassignee: implementer'));
    expect(await say('list', GUEST)).toContain(taskId);
    expect(await say(`show ${taskId}`, GUEST)).toContain('**A task**');
    expect(await say(`gate list ${taskId}`, GUEST)).toBe(`Task \`${taskId}\` has no gates.`);
    expect(await say(`comment ${taskId} the 2024 figures, please`, GUEST)).toContain('Comment added');
    expect(commentsOf(t.db, taskId).map((c) => [c.author, c.body])).toEqual([['lark:on_guest', 'the 2024 figures, please']]);
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
    expect(await say(`assign ${child} @Carol`)).toContain('arrives in plan D2');
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

describe('what chat cannot do yet', () => {
  it("answers the people's commands with when they arrive, and a wrong command line with its usage", async () => {
    expect(await say('done k_1 finished')).toBe(
      "`/kanban done` is for a person's own task, and arrives in plan D2 with people as assignees and reviewers. " +
        'For now tasks go to roles, whose agents report for themselves.',
    );
    expect(await say('approve k_1')).toContain('arrives in plan D2');
    expect(await say('show')).toBe('Usage: `/kanban show <task>`');
    expect(await say('show k_missing')).toBe('Not done: no task k\\_missing');
    expect(await say('')).toContain('**The task board.**');
  });
});
```


- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-chat.test.ts`. Expected: the file FAILS to load, with `Error: Cannot find module '../src/kanban/chat.js'`. `Tests  no tests`.

- [ ] **Step 5.3: Implement.**

Create `src/kanban/chat.ts`:

```ts
import { forDisplay } from '../channel/escape.js';
import type { BindingKey, InboundMessage, Principal, Tier } from '../types.js';
import { parseKanban, type KanbanCommand, type LaterVerb, type NewTaskCommand } from './chat-parse.js';
import { renderGates, renderHelp, renderList, renderShow } from './chat-render.js';
import type { KanbanService } from './service.js';
import type { Refusal, RunRow } from './types.js';

/**
 * `/kanban` in chat (spec §9.1): a parsed command, checked against the sender's
 * tier, done through `KanbanService` and nothing else, and answered as text the
 * router sends. It never touches the chat's session, so a busy session never
 * refuses it: it is control-plane, like `/status`.
 *
 * A person is recorded as `lark:<union_id>` (spec §3.1), the identity the board
 * knows people by; a sender whose union_id is unknown can read the board but not
 * change it. Until plan D2 the board gives work only to roles, so naming a
 * person is refused here, and the commands for people's own tasks are answered
 * with when they arrive.
 */

export interface KanbanChatDeps {
  service: KanbanService;
  /** The sender's tier, as the router's authorizer decides it. */
  hasTier(principal: Principal, tier: Tier): boolean;
  /** After a change that can make a task claimable: the dispatcher's pass. */
  changed?: () => void;
  /** After a change that decided an agent run: the dispatcher cancels its turn and closes it. */
  cancel?: (runId: string) => void;
}

/** Who may run each command (spec §9.1, §10). */
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
  later: 'talk',
};

/** The board's principal for a chat sender: `lark:<union_id>`, or undefined when Lark gave none. */
export function principalOf(sender: Principal): string | undefined {
  return sender.unionId === null || sender.unionId === '' ? undefined : `lark:${sender.unionId}`;
}

/**
 * A name that is a person, not a role: an @-mention, which Lark's text gives as
 * `@Name`, or a principal typed out. Roles are bare words (spec §9.1).
 */
function isPerson(name: string): boolean {
  return name.startsWith('@') || name.toLowerCase().startsWith('lark:');
}

const PEOPLE_LATER =
  'Naming a person as an assignee or reviewer arrives in plan D2. For now a task is given to a role: name it as a bare word, such as `implementer`.';

function later(name: LaterVerb): string {
  return (
    `\`/kanban ${name}\` is for a person's own task, and arrives in plan D2 with people as assignees and reviewers. ` +
    'For now tasks go to roles, whose agents report for themselves.'
  );
}

/** A refusal, in words for chat: the board's message, escaped, with what D2 brings where that is the reason. */
function refused(r: Refusal): string {
  if (r.code === 'supervised_role') {
    return (
      `${forDisplay(r.message.replace(/;.*$/, ''))}; its approval requests cannot be forwarded to a chat yet. ` +
      'That arrives in plan D2.'
    );
  }
  if (r.code === 'person_not_assignable') return PEOPLE_LATER;
  return `Not done: ${forDisplay(r.message)}`;
}

/** The board's own ids are code; anything else the sender typed is escaped like any text. */
function id(taskId: string): string {
  return /^[kr]_[0-9a-z]+$/.test(taskId) ? `\`${taskId}\`` : forDisplay(taskId);
}

export class KanbanChat {
  readonly #deps: KanbanChatDeps;

  constructor(deps: KanbanChatDeps) {
    this.#deps = deps;
  }

  /** Run `/kanban <arg>` from this message, bound at `key`; the reply to send. */
  async run(arg: string, message: InboundMessage, key: BindingKey): Promise<string> {
    const parsed = parseKanban(arg);
    if (!parsed.ok) return parsed.usage;
    const command = parsed.command;
    const tier = TIERS[command.verb];
    if (tier === 'operate' && !this.#deps.hasTier(message.sender, 'operate')) {
      return `\`/kanban ${command.verb}\` changes the board, and needs operator permission.`;
    }
    switch (command.verb) {
      case 'help':
        return renderHelp();
      case 'later':
        return later(command.name);
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
    if (by === undefined) {
      return 'Lark did not say who you are (no union_id came with the message), and the board records who changes it. Ask the operator to check the app can read user ids.';
    }
    return this.#change(command, by, message, key);
  }

  #change(command: KanbanCommand, by: string, message: InboundMessage, key: BindingKey): string {
    const service = this.#deps.service;
    switch (command.verb) {
      case 'new':
        return this.#create(command, by, message, key);
      case 'assign': {
        if (isPerson(command.assignee)) return PEOPLE_LATER;
        const r = service.assign(command.taskId, command.assignee, by);
        if (!r.ok) return refused(r);
        this.#decided(r.run);
        this.#changed();
        return `${id(command.taskId)} is now for role ${forDisplay(command.assignee)}${r.run === undefined ? '' : `; its run ${id(r.run.runId)} was ${forDisplay(r.run.outcome ?? 'ended')}`}.`;
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
        return `${id(command.taskId)} works in ${forDisplay(command.workspace)}.`;
      }
      case 'comment': {
        const r = service.comment(command.taskId, command.text, by);
        if (!r.ok) return refused(r);
        return `Comment added to ${id(command.taskId)}. An agent working on it gets it when its current turn ends; otherwise the next run reads it.`;
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
        return `Gate ${r.gate.id} added to ${id(command.taskId)} (${r.gate.timeoutS} s): ${forDisplay(r.gate.command)}`;
      }
      case 'gate remove': {
        const r = service.removeGate(command.taskId, command.gateId, by);
        if (!r.ok) return refused(r);
        return `Gate ${r.gate.id} removed from ${id(command.taskId)}: ${forDisplay(r.gate.command)}`;
      }
      default:
        return renderHelp();
    }
  }

  /**
   * `/kanban new` (spec §9.1): created from this chat, which is subscribed to it.
   * The message id is the idempotency key, so a redelivery that got past the
   * router's own dedup still makes one task.
   */
  #create(command: NewTaskCommand, by: string, message: InboundMessage, key: BindingKey): string {
    for (const name of [command.assignee, command.reviewer]) {
      if (name !== undefined && isPerson(name)) return PEOPLE_LATER;
    }
    const r = this.#deps.service.create({
      title: command.title,
      ...(command.body === '' ? {} : { body: command.body }),
      contract: command.contract,
      ...(command.assignee === undefined ? {} : { assignee: command.assignee }),
      ...(command.reviewer === undefined ? {} : { reviewer: command.reviewer }),
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
        ? `nobody yet: \`/kanban assign ${task.taskId} <role>\` gives it to a role`
        : `role ${forDisplay(task.assignee.name)}`;
    return (
      `Created ${id(task.taskId)} — **${forDisplay(task.title)}**, for ${whom}` +
      `${task.workspace === null ? '' : `, in ${forDisplay(task.workspace)}`}. ` +
      'This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.'
    );
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


- [ ] **Step 5.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-chat.test.ts`. Expected: `Tests  9 passed (9)`. Run `npx vitest run --project unit tests/kanban-service.test.ts -t "one writer"`. Expected: `Tests  1 passed | …`: `src/kanban/chat.ts` does not import `db/kanban.js`.

- [ ] **Step 5.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1186 passed (1186)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.6: Commit.**

```bash
git add src/kanban/chat.ts tests/kanban-chat.test.ts
git commit -m "Do the /kanban commands through the board's service, at the tier each needs, recording who acted, and refuse people until plan D2"
```

---

### Task 6: `/kanban` in the router

**Files:**
- Modify: `src/core/commands.ts`, `src/core/router.ts`, `tests/router.test.ts`, `tests/commands.test.ts`

`/kanban` joins the command table at talk tier, multiline, needing no session, and not mutating, so a busy session never refuses it (spec §9.1). The router hands it to `RouterDeps.kanban` — `KanbanCommands`, an interface in the router, so the core imports nothing from the board — or answers that the board is off (Decision 4). A board that throws is answered with the reason, escaped and masked, and noted. Every reply is masked whole before it is sent (Decision 14).

- [ ] **Step 6.1: Write the failing tests.**

In `tests/router.test.ts`, replace:

```ts
import { ACK_EMOJI, Router } from '../src/core/router.js';
```

with:

```ts
import { ACK_EMOJI, KANBAN_OFF, Router, type KanbanCommands } from '../src/core/router.js';
```

In `tests/router.test.ts`, replace:

```ts
import type { InboundMessage, PermissionOption, Principal } from '../src/types.js';
```

with:

```ts
import type { BindingKey, InboundMessage, PermissionOption, Principal } from '../src/types.js';
```

In `tests/router.test.ts`, replace:

```ts
function harness(
  opts: { auth?: Partial<AuthConfig>; authorizer?: Authorizer } = {},
): Harness {
```

with:

```ts
function harness(
  opts: { auth?: Partial<AuthConfig>; authorizer?: Authorizer; kanban?: KanbanCommands } = {},
): Harness {
```

In `tests/router.test.ts`, replace:

```ts
    channelId: CHANNEL,
    appId: APP,
    clock,
    note: (line) => notes.push(line),
  });
  return { db: t.db, router, registry, channel, driver, clock, notes, authorizer };
```

with:

```ts
    channelId: CHANNEL,
    appId: APP,
    ...(opts.kanban === undefined ? {} : { kanban: opts.kanban }),
    clock,
    note: (line) => notes.push(line),
  });
  return { db: t.db, router, registry, channel, driver, clock, notes, authorizer };
```

In `tests/router.test.ts`, replace:

```ts
describe('Router: prompts', () => {
```

with:

```ts
describe('Router: /kanban', () => {
  afterEach(() => clearSecrets());

  /** A board that records what it was asked, and answers with `answer`. */
  function board(answer: (arg: string) => Promise<string>): KanbanCommands & {
    calls: Array<{ arg: string; messageId: string; key: BindingKey }>;
  } {
    const calls: Array<{ arg: string; messageId: string; key: BindingKey }> = [];
    return {
      calls,
      run: async (arg, message, key) => {
        calls.push({ arg, messageId: message.messageId, key });
        return answer(arg);
      },
    };
  }

  it('says the board is off when kanban.enabled is not set, and opens no session', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/kanban list' }));
    expect(lastReply(h)).toBe(KANBAN_OFF);
    expect(sessionCount(h)).toBe(0);
  });

  it('hands the board the whole argument, lines kept, with the message and where it was said; the reply masked', async () => {
    addSecrets(['sk-board-12345678']);
    const kanban = board(async () => 'Created `k_1`, key sk-board-12345678');
    const h = harness({ kanban });
    const message = msg({ text: '/kanban new Draft the notes\nassignee: docs-writer', threadId: 'omt_1' });
    await h.router.onMessage(message);
    expect(kanban.calls).toEqual([
      {
        arg: 'new Draft the notes\nassignee: docs-writer',
        messageId: message.messageId,
        key: { channel: CHANNEL, appId: APP, conversationId: CHAT, threadId: 'omt_1' },
      },
    ]);
    expect(h.channel.texts.at(-1)).toMatchObject({
      text: `Created \`k_1\`, key ${MASK}`,
      uuid: replyUuid(APP, message.messageId, 'kanban'),
    });
    expect(sessionCount(h)).toBe(0);
  });

  it('answers while the chat session is busy: it never touches that session', async () => {
    const h = harness({ kanban: board(async () => 'the board') });
    await working(h);
    await h.router.onMessage(msg({ text: '/kanban list' }));
    expect(lastReply(h)).toBe('the board');
  });

  it('answers a board that throws with the reason, escaped and masked, and notes it', async () => {
    addSecrets(['sk-thrown-12345678']);
    const h = harness({
      kanban: board(async () => {
        throw new Error('database_locked by sk-thrown-12345678');
      }),
    });
    await h.router.onMessage(msg({ text: '/kanban list' }));
    expect(lastReply(h)).toBe(`The board could not do that: database\\_locked by ${MASK}`);
    expect(h.notes.some((n) => n.includes('kanban command in'))).toBe(true);
  });
});

describe('Router: prompts', () => {
```

In `tests/commands.test.ts`, replace:

```ts
  it('has no /approve', () => {
```

with:

```ts
  it('runs /kanban at talk tier, lines kept, without a session and never refused mid-turn', () => {
    // Its commands that change the board check operator tier themselves (spec §9.1).
    const parsed = parseCommand('/kanban new A task\nassignee: implementer');
    if (parsed === undefined || !('spec' in parsed)) throw new Error('/kanban did not parse');
    expect(parsed.spec).toMatchObject({ name: 'kanban', tier: 'talk', needsSession: false, mutating: false, multiline: true });
    expect(parsed.arg).toBe('new A task\nassignee: implementer');
  });

  it('has no /approve', () => {
```


- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/router.test.ts tests/commands.test.ts`. Expected: five FAIL — the command table's with `/kanban did not parse`, and the router's four because `/kanban` is answered "Unknown command `/kanban`. Try `/help`." `Tests  5 failed | 76 passed (81)`.

- [ ] **Step 6.3: Implement.**

In `src/core/commands.ts`, replace:

```ts
  {
    name: 'help',
    tier: 'talk',
```

with:

```ts
  {
    name: 'kanban',
    // Talk, because reading the board is; each of its commands that changes the
    // board checks operator tier itself (spec §9.1).
    tier: 'talk',
    needsSession: false,
    effect: 'immediate',
    // `/kanban new` takes field lines and a body; `/kanban comment` a paragraph.
    multiline: true,
    // Control-plane, like /status: it never touches this chat's session, so a
    // busy one does not refuse it (spec §9.1).
    mutating: false,
    summary: 'The task board: `/kanban help` lists its commands.',
    usage: '/kanban <command>',
  },
  {
    name: 'help',
    tier: 'talk',
```

In `src/core/router.ts`, replace:

```ts
import { forDisplay, truncate } from '../channel/escape.js';
```

with:

```ts
import { forDisplay, truncate } from '../channel/escape.js';
import { redactKnownSecrets } from '../secrets.js';
```

In `src/core/router.ts`, replace:

```ts
export interface RouterDeps {
  db: Db;
  registry: SessionRegistry;
  authorizer: Authorizer;
  channel: Channel;
  channelId: string;
  appId: string;
  clock?: Clock;
  note?: (line: string) => void;
}
```

with:

```ts
/**
 * The board's chat commands (spec §9.1): what follows `/kanban`, run for the
 * message that typed it, answered as the reply to send. Plan D1's `KanbanChat`.
 */
export interface KanbanCommands {
  run(arg: string, message: InboundMessage, key: BindingKey): Promise<string>;
}

export interface RouterDeps {
  db: Db;
  registry: SessionRegistry;
  authorizer: Authorizer;
  channel: Channel;
  channelId: string;
  appId: string;
  /** The board's commands; absent when `kanban.enabled` is off, and `/kanban` says so. */
  kanban?: KanbanCommands;
  clock?: Clock;
  note?: (line: string) => void;
}

/** What `/kanban` says on a gateway whose board is off. */
export const KANBAN_OFF =
  'The task board is off on this gateway. An operator turns it on with `kanban.enabled: true` in config.yaml, and a restart.';
```

In `src/core/router.ts`, replace:

```ts
      case 'cd': {
        // Declared in the registry but not wired in this build
```

with:

```ts
      case 'kanban': {
        let text: string;
        const kanban = this.#deps.kanban;
        if (kanban === undefined) {
          text = KANBAN_OFF;
        } else {
          try {
            text = await kanban.run(arg, message, key);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            this.#note(`kanban command in ${message.messageId} failed: ${detail}`);
            text = `The board could not do that: ${forDisplay(detail)}`;
          }
        }
        // Each piece was escaped, and masked, as it was put in; the whole reply is
        // masked once more, for what was not: ids, names, the board's own words.
        await this.#reply(target, message, 'kanban', redactKnownSecrets(text));
        return;
      }

      case 'cd': {
        // Declared in the registry but not wired in this build
```


- [ ] **Step 6.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/router.test.ts tests/commands.test.ts`. Expected: `Tests  81 passed (81)`.

- [ ] **Step 6.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1191 passed (1191)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.6: Commit.**

```bash
git add src/core/commands.ts src/core/router.ts tests/router.test.ts tests/commands.test.ts
git commit -m "Route /kanban to the board's chat commands, never refused for a busy session, and say the board is off when it is"
```

---

### Task 7: Delivering notices

**Files:**
- Create: `src/kanban/notices.ts`, `tests/kanban-notices.test.ts`
- Modify: `src/core/ids.ts`, `tests/ids.test.ts`

The `Notifier` (spec §9.4; Decisions 19–21): a round every 2 s, one at a time, over this bot's subscriptions with an event past their cursor; each one's events in order, a notice sent and then the cursor moved, an event that is none only moving it. A send that fails keeps the cursor and holds that subscription back for a pause that doubles to five minutes. The uuid is `noticeUuid(appId, subscription, event)`, derived, so a notice sent again after a restart carries the first one's. A new `Notifier` over the same database is a restart: it knows only the cursors.

- [ ] **Step 7.1: Write the failing tests.**

In `tests/ids.test.ts`, replace:

```ts
  newTurnId,
  replyUuid,
```

with:

```ts
  newTurnId,
  noticeUuid,
  replyUuid,
```

In `tests/ids.test.ts`, replace:

```ts
describe('approvalNonce', () => {
```

with:

```ts
describe('noticeUuid', () => {
  it('is the same for one subscription and event, after a restart too, and differs for any other', () => {
    const a = noticeUuid('cli_app', 3, 41);
    expect(noticeUuid('cli_app', 3, 41)).toBe(a);
    expect(a).toHaveLength(50);
    expect(new Set([a, noticeUuid('cli_app', 4, 41), noticeUuid('cli_app', 3, 42), noticeUuid('cli_other', 3, 41)]).size).toBe(4);
    // Never a control reply's or a session send's for the same numbers.
    expect(a).not.toBe(replyUuid('cli_app', '3', '41'));
    expect(a).not.toBe(sendUuid('cli_app', '3', 41));
  });
});

describe('approvalNonce', () => {
```

Create `tests/kanban-notices.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noticeUuid } from '../src/core/ids.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { NOTICE_POLL_MS, Notifier } from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, WORKSPACES } from './helpers/kanban.js';

/**
 * Subscriptions' notices (spec §9.4): delivered in order from each
 * subscription's cursor, at least once, one uuid per subscription and event, and
 * caught up after a restart by the same code.
 */

const VIA: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' };

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
  });
  lark = new FakeChannel({ id: 'lark', clock });
  notes = [];
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function notifier(appId = 'cli_app'): Notifier {
  return new Notifier({
    db: t.db,
    service,
    channels: new Map([['lark', lark]]),
    appId,
    blockRecurrenceLimit: 2,
    clock,
    note: (line) => notes.push(line),
  });
}

function create(title: string, via: CreatedVia = VIA): TaskRow {
  const r = service.create({ title, assignee: 'implementer', createdBy: ALICE, createdVia: via });
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

async function done(task: TaskRow, summary: string): Promise<void> {
  const r = await service.complete(task.taskId, { kind: 'person', principal: ALICE }, { summary });
  if (!r.ok) throw new Error(r.message);
}

describe('the notifier', () => {
  it('sends each notice once, in order, to the chat and thread, passing over the events that are none', async () => {
    const a = create('Draft the notes');
    const b = create('Check the links');
    expect(service.comment(a.taskId, 'first draft by Friday', ALICE).ok).toBe(true);
    expect(service.block(b.taskId, { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which wiki?' }).ok).toBe(true);
    await done(a, 'merged');
    const n = notifier();

    expect(await n.deliver()).toBe(2);
    expect(lark.texts.map((m) => [m.target, m.text.split('\n')[0]])).toEqual([
      [{ chatId: 'oc_team', threadId: 'omt_topic' }, `Done — **Draft the notes** \`${a.taskId}\`:`],
      [{ chatId: 'oc_team', threadId: 'omt_topic' }, `Blocked (needs\\_input) — **Check the links** \`${b.taskId}\`: which wiki?`],
    ]);
    const [subA] = subscriptionsOf(t.db, a.taskId);
    const completed = eventsOf(t.db, a.taskId).find((e) => e.kind === 'completed');
    expect(lark.texts[0]?.uuid).toBe(noticeUuid('cli_app', subA?.id ?? 0, completed?.id ?? 0));
    // Every event, a notice or not, is behind the cursor now.
    expect(subA?.cursor).toBe(eventsOf(t.db, a.taskId).at(-1)?.id);
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(2);
  });

  it("tells the chat following a task about the tasks that task's runs create", async () => {
    const parent = create('Plan the launch');
    const claimed = service.claim(parent.taskId);
    if (!claimed.ok) throw new Error(claimed.message);
    const child = service.create({
      title: 'Book the room',
      assignee: 'implementer',
      createdBy: `run:${claimed.run.runId}`,
      createdVia: { kind: 'run', runId: claimed.run.runId },
    });
    if (!child.ok) throw new Error(child.message);
    await notifier().deliver();
    expect(lark.texts).toHaveLength(0);
    expect(service.stop(parent.taskId, ALICE).ok).toBe(true);
    expect(service.closeRun(claimed.run.runId).ok).toBe(true);
    await done(child.task, 'booked');
    await notifier().deliver();
    expect(lark.texts.map((m) => m.text.split('\n')[0])).toEqual([
      `Blocked (needs\\_input) — **Plan the launch** \`${parent.taskId}\`: stopped by lark:on\\_alice`,
      `Done — **Book the room** \`${child.task.taskId}\`:`,
    ]);
  });

  it('keeps the cursor where it is when a send fails, and tries again after a pause, sending it once', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    lark.failNext('sendText', new Error('chat not found'));
    expect(await n.deliver()).toBe(0);
    expect(notes.at(-1)).toBe(
      `kanban: a notice for task ${a.taskId} to subscription ${subscriptionsOf(t.db, a.taskId)[0]?.id ?? 0} was not sent (chat not found); trying again in 2 s`,
    );
    expect(subscriptionsOf(t.db, a.taskId)[0]?.cursor).toBeLessThan(eventsOf(t.db, a.taskId).at(-1)?.id ?? 0);
    // Held back until the pause is over.
    expect(await n.deliver()).toBe(0);
    clock.advance(NOTICE_POLL_MS);
    expect(await n.deliver()).toBe(1);
    expect(lark.texts).toHaveLength(1);
    expect(await n.deliver()).toBe(0);
  });

  it('catches up after a restart from the cursors, sending again only what was not marked sent, with the same uuid', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    expect(await notifier().deliver()).toBe(1);
    // A new process: nothing is sent twice that was marked sent.
    expect(await notifier().deliver()).toBe(0);
    // One that stopped after the send and before its cursor moved.
    t.db.prepare('UPDATE kanban_subscriptions SET cursor = 0').run();
    expect(await notifier().deliver()).toBe(1);
    expect(lark.texts).toHaveLength(2);
    expect(lark.texts[1]?.uuid).toBe(lark.texts[0]?.uuid);
  });

  it("runs one round at a time, delivers only this bot's subscriptions, and masks what it sends", async () => {
    addSecrets(['sk-notice-12345678']);
    const mine = create('Rotate the key');
    const theirs = create('Elsewhere', { kind: 'chat', channel: 'lark', appId: 'cli_other', conversationId: 'oc_team', threadId: '' });
    await done(mine, 'rotated, old one was sk-notice-12345678');
    await done(theirs, 'done');
    const n = notifier();
    const [first, second] = await Promise.all([n.deliver(), n.deliver()]);
    expect([first, second]).toEqual([1, 1]);
    expect(lark.texts).toHaveLength(1);
    expect(lark.texts[0]?.text).toContain(`old one was ${MASK}`);
    expect(lark.texts[0]?.text).not.toContain('sk-notice');
  });

  it('sends nothing once stopped, and idle waits for the round under way', async () => {
    const a = create('Draft the notes');
    await done(a, 'merged');
    const n = notifier();
    lark.hold();
    const round = n.deliver();
    n.stop();
    lark.release();
    await n.idle();
    expect(await round).toBe(1);
    expect(await n.deliver()).toBe(0);
    await done(create('Another'), 'done');
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });
});
```


- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/ids.test.ts tests/kanban-notices.test.ts`. Expected: `tests/kanban-notices.test.ts` FAILS to load, with `Error: Cannot find module '../src/kanban/notices.js'`, and the `noticeUuid` test FAILS with `TypeError: (0 , noticeUuid) is not a function`. `Test Files  2 failed (2)`, `Tests  1 failed | 14 passed (15)`.

- [ ] **Step 7.3: Implement.**

In `src/core/ids.ts`, replace:

```ts
/**
 * The opaque value carried in a card button's `action.value`.
```

with:

```ts
/**
 * The `uuid` for a subscription's notice of one board event (spec §9.4).
 *
 * Derived from the subscription and the event, so the notice a restart sends
 * again -- sent, and the gateway stopped before the cursor moved past it --
 * carries the uuid the first one did, and a channel that deduplicates by it
 * shows one message.
 */
export function noticeUuid(appId: string, subscriptionId: number, eventId: number): string {
  const canonical = [appId, 'kanban-notice', subscriptionId, eventId].join(SEP);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 50);
}

/**
 * The opaque value carried in a card button's `action.value`.
```

Create `src/kanban/notices.ts`:

```ts
import type { Channel } from '../channel/types.js';
import { noticeUuid } from '../core/ids.js';
import { dueSubscriptions, eventsAfter, getTask } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { renderNotice } from './chat-render.js';
import type { KanbanService } from './service.js';
import type { SubscriptionRow } from './types.js';

/**
 * Subscriptions' notices (spec §9.4): what a chat following a task hears.
 *
 * **Delivery is a projection over `kanban_events`, from a cursor.** Each round
 * reads the subscriptions with an event past their cursor and, for each, the
 * events in order: one that is a notice is sent, and the cursor moves past it
 * once the send succeeded; one that is not is passed over. After a restart the
 * first round starts from the cursors in the database, so catching up after an
 * outage is the same code as delivering in normal running.
 *
 * **At least once.** A send that fails leaves the cursor where it is, and the
 * subscription is tried again after a pause that doubles, up to five minutes. A
 * notice sent just before the gateway stopped, whose cursor had not moved yet, is
 * sent again by the next round, with the same uuid -- one per subscription and
 * event -- so a channel that deduplicates by uuid shows it once. (The Lark
 * adapter does not pass the uuid on yet; see its note.)
 *
 * The board's writes come from chat, the worker socket and the dispatcher, so
 * rather than be told of each, the notifier looks every `NOTICE_POLL_MS`: a cheap
 * read when nothing is due.
 */

/** How often a round looks for notices to send. */
export const NOTICE_POLL_MS = 2_000;
/** The longest a subscription whose sends fail waits before it is tried again. */
export const NOTICE_BACKOFF_MAX_MS = 5 * 60_000;
/** Events read for one subscription in one round; the rest wait for the next. */
const ROUND_EVENTS = 100;

export interface NotifierDeps {
  db: Db;
  service: KanbanService;
  /** Where a subscription's channel id sends: `lark` to the Lark adapter. */
  channels: ReadonlyMap<string, Channel>;
  /** This bot: only its subscriptions are delivered here. */
  appId: string;
  /** `kanban.block_recurrence_limit` (spec §5.4). */
  blockRecurrenceLimit: number;
  clock?: Clock;
  /** Metadata only: ids and counts, never task text. */
  note?: (line: string) => void;
}

export class Notifier {
  readonly #deps: NotifierDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  /** A subscription whose last send failed: when it may be tried again, and the pause after that. */
  readonly #backoff = new Map<number, { until: number; waitMs: number }>();
  #round: Promise<number> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: NotifierDeps) {
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

  /** Deliver every `NOTICE_POLL_MS`, starting now: the first round is the catch-up after a restart. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.deliver(), NOTICE_POLL_MS);
    this.#timer.unref();
    void this.deliver();
  }

  /** No more rounds; one under way stops after its current send. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Once the round under way, if any, is over: for shutdown, before the database closes. */
  async idle(): Promise<void> {
    await this.#round;
  }

  /**
   * One round, or the one already under way: never two at once, which could send
   * a notice twice. Resolves to the notices sent. Never rejects: a failure is
   * noted, and the next round tries again.
   */
  deliver(): Promise<number> {
    if (this.#round !== undefined) return this.#round;
    const round = this.#deliverOnce()
      .catch((err: unknown) => {
        this.#note(`kanban: delivering notices failed: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      })
      .finally(() => {
        this.#round = undefined;
      });
    this.#round = round;
    return round;
  }

  async #deliverOnce(): Promise<number> {
    if (this.#stopped) return 0;
    let sent = 0;
    for (const sub of dueSubscriptions(this.#deps.db, this.#deps.appId)) {
      if (this.#stopped) break;
      const held = this.#backoff.get(sub.id);
      if (held !== undefined && this.#clock.now() < held.until) continue;
      sent += await this.#deliverTo(sub);
    }
    return sent;
  }

  /** A subscription's events past its cursor, in order, until one fails to send. */
  async #deliverTo(sub: SubscriptionRow): Promise<number> {
    const channel = this.#deps.channels.get(sub.channel);
    const task = getTask(this.#deps.db, sub.taskId);
    if (channel === undefined || task === undefined) {
      this.#fail(sub, `no channel ${sub.channel}`);
      return 0;
    }
    let sent = 0;
    for (const event of eventsAfter(this.#deps.db, sub.taskId, sub.cursor, ROUND_EVENTS)) {
      if (this.#stopped) break;
      const text = renderNotice(event, task, { blockRecurrenceLimit: this.#deps.blockRecurrenceLimit });
      if (text !== undefined) {
        try {
          await channel.sendText(
            { chatId: sub.conversationId, threadId: sub.threadId },
            redactKnownSecrets(text),
            noticeUuid(this.#deps.appId, sub.id, event.id),
          );
        } catch (err) {
          this.#fail(sub, err instanceof Error ? err.message : String(err));
          return sent;
        }
        sent += 1;
      }
      const moved = this.#deps.service.advanceSubscription(sub.id, event.id);
      if (!moved.ok) {
        this.#fail(sub, moved.message);
        return sent;
      }
    }
    this.#backoff.delete(sub.id);
    return sent;
  }

  /** Hold a subscription back for a while, doubling each time, and say so. */
  #fail(sub: SubscriptionRow, why: string): void {
    const waitMs = Math.min((this.#backoff.get(sub.id)?.waitMs ?? NOTICE_POLL_MS / 2) * 2, NOTICE_BACKOFF_MAX_MS);
    this.#backoff.set(sub.id, { until: this.#clock.now() + waitMs, waitMs });
    this.#note(
      `kanban: a notice for task ${sub.taskId} to subscription ${sub.id} was not sent (${why}); trying again in ${Math.round(waitMs / 1000)} s`,
    );
  }
}
```


- [ ] **Step 7.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/ids.test.ts tests/kanban-notices.test.ts`. Expected: `Tests  21 passed (21)`.

- [ ] **Step 7.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1198 passed (1198)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.6: Commit.**

```bash
git add src/core/ids.ts src/kanban/notices.ts tests/ids.test.ts tests/kanban-notices.test.ts
git commit -m "Deliver each subscription's notices in order from its cursor, at least once, with one uuid per subscription and event, so a restart catches up"
```

---

### Task 8: Wiring it into the gateway

**Files:**
- Modify: `src/index.ts`, `tests/gateway-startup.test.ts`

Behind `kanban.enabled` and nowhere else (Decision 2): the router gets `KanbanChat`, over the same service as the worker socket, with the authorizer's tiers and the dispatcher's `pass` and `cancel`; the gateway gets a `Notifier` sending through the Lark adapter. The notifier starts once the channel is connected — its first round is the catch-up — stops with the dispatcher, and is waited for before the channel disconnects.

- [ ] **Step 8.1: Write the failing test.**

In `tests/gateway-startup.test.ts`, replace:

```ts
  it('builds no dispatcher unless kanban.enabled is set: chat runs as it did', async () => {
    const gateway = await createGateway(config, team);
    try {
      expect(gateway.dispatcher).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });
```

with:

```ts
  it('builds no dispatcher unless kanban.enabled is set: chat runs as it did', async () => {
    const gateway = await createGateway(config, team);
    try {
      expect(gateway.dispatcher).toBeUndefined();
      expect(gateway.notifier).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });

  it('starts delivering notices once connected, and stops before it disconnects, when kanban.enabled is set', async () => {
    vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
    const order: string[] = [];
    vi.spyOn(LarkAdapter.prototype, 'disconnect').mockImplementation(async () => {
      order.push('disconnect');
    });
    vi.spyOn(LarkInbound.prototype, 'start').mockImplementation(() => undefined);
    const gateway = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    const notifier = gateway.notifier;
    if (notifier === undefined) throw new Error('no notifier');
    vi.spyOn(notifier, 'start').mockImplementation(() => {
      order.push('notices start');
    });
    vi.spyOn(notifier, 'idle').mockImplementation(async () => {
      order.push('notices idle');
    });
    await gateway.start();
    await gateway.stop();
    expect(order).toEqual(['notices start', 'notices idle', 'disconnect']);
  });
```


- [ ] **Step 8.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/gateway-startup.test.ts`. Expected: the new test FAILS with `Error: no notifier`. `Tests  1 failed | 11 passed (12)`.

- [ ] **Step 8.3: Implement.**

In `src/index.ts`, replace:

```ts
import { Dispatcher } from './kanban/dispatcher.js';
import { KanbanService } from './kanban/service.js';
```

with:

```ts
import { KanbanChat } from './kanban/chat.js';
import { Dispatcher } from './kanban/dispatcher.js';
import { Notifier } from './kanban/notices.js';
import { KanbanService } from './kanban/service.js';
```

In `src/index.ts`, replace:

```ts
  /** The board's dispatcher, when `kanban.enabled` is set. */
  readonly dispatcher: Dispatcher | undefined;
}
```

with:

```ts
  /** The board's dispatcher, when `kanban.enabled` is set. */
  readonly dispatcher: Dispatcher | undefined;
  /** What delivers the board's notices to the chats that follow its tasks, when `kanban.enabled` is set. */
  readonly notifier: Notifier | undefined;
}
```

In `src/index.ts`, replace:

```ts
  // Off until the board can be used: nothing can create a task before plan D (spec §12).
  let worker: { api: WorkerApi; socket: string } | undefined;
```

with:

```ts
  // Opt in: off unless kanban.enabled is set (spec §12). Chat runs as it always did
  // without it, and `/kanban` says the board is off.
  let worker: { api: WorkerApi; socket: string } | undefined;
  let kanbanChat: KanbanChat | undefined;
  let notifier: Notifier | undefined;
```

In `src/index.ts`, replace:

```ts
    // A worker's create, link or report can make a task claimable.
    worker = { api: new WorkerApi({ db, service, changed: () => dispatcher?.pass() }), socket };
```

with:

```ts
    // A worker's create, link or report can make a task claimable.
    worker = { api: new WorkerApi({ db, service, changed: () => dispatcher?.pass() }), socket };
    // /kanban in chat (spec §9.1): through the same service, with the router's tiers.
    kanbanChat = new KanbanChat({
      service,
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
      changed: () => dispatcher?.pass(),
      cancel: (runId) => {
        dispatcher?.cancel(runId);
      },
    });
    // What the chats following a task hear (spec §9.4), sent through Lark.
    notifier = new Notifier({
      db,
      service,
      channels: new Map<string, Channel>([[adapter.id, adapter]]),
      appId: config.lark.appId,
      blockRecurrenceLimit: config.kanban.blockRecurrenceLimit,
      note,
    });
```

In `src/index.ts`, replace:

```ts
    channelId: adapter.id,
    appId: config.lark.appId,
    note,
  });

  const inbound = new LarkInbound({
```

with:

```ts
    channelId: adapter.id,
    appId: config.lark.appId,
    ...(kanbanChat === undefined ? {} : { kanban: kanbanChat }),
    note,
  });

  const inbound = new LarkInbound({
```

In `src/index.ts`, replace:

```ts
  return {
    db,
    dispatcher,
```

with:

```ts
  return {
    db,
    dispatcher,
    notifier,
```

In `src/index.ts`, replace:

```ts
      note(`connected as ${adapter.botOpenId ?? 'unknown bot identity'}`);
```

with:

```ts
      note(`connected as ${adapter.botOpenId ?? 'unknown bot identity'}`);
      // Once connected: its first round catches up on what the chats missed while the gateway was down.
      notifier?.start();
```

In `src/index.ts`, replace:

```ts
      // No more claims; the runs still open are ended by the next boot.
      dispatcher?.stop();
```

with:

```ts
      // No more claims; the runs still open are ended by the next boot.
      dispatcher?.stop();
      // No more notices; what was not sent is sent by the next boot, from the cursors.
      notifier?.stop();
```

In `src/index.ts`, replace:

```ts
      await workerServer?.close();
      await adapter.disconnect().catch((err: unknown) => {
```

with:

```ts
      await workerServer?.close();
      // A notice being sent finishes while the channel is still connected.
      await notifier?.idle();
      await adapter.disconnect().catch((err: unknown) => {
```


- [ ] **Step 8.4: Run it to verify it passes.** Run `npx vitest run --project unit tests/gateway-startup.test.ts`. Expected: `Tests  12 passed (12)`.

- [ ] **Step 8.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1199 passed (1199)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  70 passed (70)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.6: Commit.**

```bash
git add src/index.ts tests/gateway-startup.test.ts
git commit -m "Give the router the board's chat commands and start the notices once connected, both only when kanban.enabled is set"
```

---

### Task 9: End to end: `/kanban new` from a thread, and the thread hears it is done

**Files:**
- Create: `tests/kanban-chat.e2e.ts`

D1's proof (spec §11, "Chat (D1)" and "Notices"). A person types `/kanban new` in a group's topic thread; the real router hands it to `KanbanChat`, which creates the task and tells the real dispatcher; the dispatcher runs it as a session whose agent is a real process — the fake CLI agent in its `kanban` mode, through the real CLI driver — which reports `mt kanban complete` through the shim and the real socket; and a `Notifier` sends the thread one notice of the completion, through a `FakeChannel` standing for Lark. A second round, and a new notifier standing for a restart, send nothing more. A second test runs the agent in its `crash` mode: the thread hears the retry, then the giving up.

- [ ] **Step 9.1: Write the test.**

Create `tests/kanban-chat.e2e.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { Router } from '../src/core/router.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { Notifier } from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * The board from Lark, end to end (spec §9, §11): a person types `/kanban new`
 * in a group thread; the router hands it to the board's chat commands; the real
 * dispatcher runs the task as a session whose agent is a real process -- the
 * fake CLI agent, through the real CLI driver -- which reports through `mt
 * kanban` and the real socket; and the thread hears of it, once, from its
 * subscription.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };

interface Stack {
  t: TestDb;
  lark: FakeChannel;
  router: Router;
  dispatcher: Dispatcher;
  notifier: () => Notifier;
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-chat-e2e-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(workspace);
  const t = testDb();
  const roles = new Map([['implementer', role('implementer')]]);
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']) });
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
      ['kanban', new KanbanSink()],
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
  const authorizer = new Authorizer(defaultAuthConfig(OWNER.openId));
  const router = new Router({
    db: t.db,
    registry,
    authorizer,
    channel: lark,
    channelId: 'lark',
    appId: 'cli_app',
    kanban: new KanbanChat({
      service,
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
      changed: () => d.pass(),
      cancel: (runId) => {
        d.cancel(runId);
      },
    }),
  });
  stack = {
    t,
    lark,
    router,
    dispatcher,
    // A new one is a new process: it knows only what the database does.
    notifier: () =>
      new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2 }),
    server,
    registry,
    dir,
  };
  return stack;
}

/** A message in the team's group, in a topic thread, mentioning the bot. */
function said(text: string): InboundMessage {
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
    attachments: [],
    createTime: Date.now(),
  };
}

/** The task id the router's reply to /kanban new names. */
function createdIn(lark: FakeChannel): string {
  const reply = lark.texts.at(-1)?.text ?? '';
  const id = /^Created `(k_[0-9a-z]+)`/.exec(reply)?.[1];
  if (id === undefined) throw new Error(`no task created: ${reply}`);
  return id;
}

describe('the board from Lark, end to end', () => {
  it('/kanban new runs the task on a role, and the thread it was created in hears it is done, once', async () => {
    const s = await build('kanban');
    await s.router.onMessage(said('/kanban new Write the parser\nassignee: implementer\nworkspace: default\nIt reads CSV.'));
    const taskId = createdIn(s.lark);
    expect(s.lark.texts.at(-1)?.target).toEqual({ chatId: 'oc_team', threadId: 'omt_topic' });

    // The reply looked for work: the run started without waiting for a sweep.
    await s.dispatcher.idle();
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');
    expect(runsOf(s.t.db, taskId)[0]).toMatchObject({ outcome: 'completed', summary: 'did: Write the parser' });

    const replies = s.lark.texts.length;
    expect(await s.notifier().deliver()).toBe(1);
    expect(s.lark.texts.slice(replies)).toEqual([
      {
        target: { chatId: 'oc_team', threadId: 'omt_topic' },
        text: `Done — **Write the parser** \`${taskId}\`:\n> did: Write the parser`,
        uuid: expect.any(String) as string,
      },
    ]);
    // Delivered is delivered: again, and after a restart, nothing more is sent.
    expect(await s.notifier().deliver()).toBe(0);
    expect(s.lark.texts).toHaveLength(replies + 1);

    // And /kanban show tells the same story.
    await s.router.onMessage(said(`/kanban show ${taskId}`));
    expect(s.lark.texts.at(-1)?.text).toContain('#1 work · role implementer · completed — did: Write the parser');
  });

  it("an agent that crashes is retried, then given up on, and the thread hears both", async () => {
    const s = await build('crash');
    await s.router.onMessage(said('/kanban new Flaky job\nassignee: implementer\nworkspace: default'));
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    expect(getTask(s.t.db, taskId)).toMatchObject({ phase: 'blocked', blockKind: 'gave_up' });

    const replies = s.lark.texts.length;
    expect(await s.notifier().deliver()).toBe(2);
    const [retry, gaveUp] = s.lark.texts.slice(replies).map((m) => m.text);
    expect(retry).toMatch(new RegExp(`^Retrying — \\*\\*Flaky job\\*\\* \`${taskId}\`: the last attempt ended crashed`));
    expect(gaveUp).toMatch(new RegExp(`^Gave up — \\*\\*Flaky job\\*\\* \`${taskId}\`: failed 2 times; last crashed`));
  });
});
```


- [ ] **Step 9.2: Run it to verify it passes.** Every piece it uses exists after Task 8, so this test is the integration check rather than a driver of new code. Run `npx vitest run --project e2e tests/kanban-chat.e2e.ts`. Expected: `Tests  2 passed (2)`. To see it fail first, stop new tasks being subscribed: in `src/db/kanban.ts`, comment out the line `subscribe(d, taskId, t.createdVia, createdFromTask, now);`. Expected: both tests FAIL, with `AssertionError: expected +0 to be 1 // Object.is equality` and `expected +0 to be 2`: the tasks ran, and nobody heard. `Tests  2 failed (2)`. Put the line back.

- [ ] **Step 9.3: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1199 passed (1199)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.4: Commit.**

```bash
git add tests/kanban-chat.e2e.ts
git commit -m "End to end: /kanban new from a thread runs a fake agent through the real socket, and the thread hears it is done once"
```

---

### Task 10: The README

**Files:**
- Modify: `README.md`

The board from Lark: what a task is, `/kanban new`'s lines, every command with its tier, who is recorded, the notices and how they survive a restart, and what waits for D2; `kanban.enabled` as opt-in, and the new setting.

- [ ] **Step 10.1: Edit.**

In `README.md`, replace:

```md
| `kanban.enabled` | — | Run the board's dispatcher. Default **off**: nothing can create a task or report on one yet. The
```

with:

```md
| `kanban.enabled` | — | Run the board: its dispatcher, the worker socket, `/kanban` in chat and its notices. Default **off**, and opt-in: without it chat runs as it always did, and `/kanban` says the board is off. The
```

In `README.md`, replace:

```md
| `kanban.nudge_limit` | — | Reminders sent into a run whose turn ended without a report, before the run ends as a protocol violation. Default 2; 0 sends none. At most 10. |
```

with:

```md
| `kanban.nudge_limit` | — | Reminders sent into a run whose turn ended without a report, before the run ends as a protocol violation. Default 2; 0 sends none. At most 10. |
| `kanban.block_recurrence_limit` | — | Blocks of the same kind in a row, unblocked in between, at which a blocked notice stops inviting another unblock and suggests rewriting the task. Default 2, at most 100. |
```

In `README.md`, replace:

```md
| `/help` | talk | List commands |
| `/cd <path>` | operate |
```

with:

```md
| `/help` | talk | List commands |
| `/kanban <command>` | talk; operate to change the board | The task board, below. Never refused because this chat's session is busy |
| `/cd <path>` | operate |
```

In `README.md`, replace:

```md
second way to mutate it with no capability the button doesn't already have.
```

with:

````md
second way to mutate it with no capability the button doesn't already have.

### The board from Lark

With `kanban.enabled`, `/kanban` drives the board from any chat the bot is in. A task is any
work — research, a document, an operation in Lark, a chore, a change to code — given to a
role, whose agent runs it in a workspace, which is just a directory.

```
/kanban new Draft the Q3 summary
assignee: docs-writer
workspace: docs
outcome: a page in the team wiki
verify: the page links every source
Use last quarter's page as the model.
```

The first line is the title. Lines starting `assignee:`, `reviewer:`, `workspace:`, `parent:`
(one or more task ids; repeat it for more), `outcome:`, `verify:`, `constraints:`,
`boundaries:` and `stop when:` fill those fields, in any order and in any case; every other
line is the body. An unknown role or workspace is refused at once, and so is a role whose agent
is supervised. The dispatcher looks for work as soon as the task is created.

| Command | Tier |
|---|---|
| `/kanban new <title>` + lines | operate |
| `/kanban list [todo\|ready\|running\|review\|reviewing\|blocked\|done\|archived\|all]` | talk; without a status, the tasks someone may still act on |
| `/kanban show <task>` | talk: the task, its contract, gates, runs, latest output and comments |
| `/kanban assign <task> <role>` | operate: an undecided run ends `superseded` |
| `/kanban link <parent> <child>` | operate |
| `/kanban workspace <task> <name>` | operate: refused once the workspace is fixed |
| `/kanban comment <task> <text>` | talk: an agent working on the task gets it when its turn ends |
| `/kanban unblock <task> [comment]` | operate |
| `/kanban stop <task>` | operate: the run ends `cancelled`, and the task blocks |
| `/kanban archive <task>` | operate |
| `/kanban gate add <task> [--timeout <s>] <command>` | operate: the rest of the message is the command, as written |
| `/kanban gate list <task>` | talk |
| `/kanban gate remove <task> <gate>` | operate |
| `/kanban help` | talk |

Whoever acts is recorded as `lark:<union_id>`; a sender whose message carried no union_id can
read the board but not change it. Everything shown is escaped, so a task's text cannot mention
anyone, and masked, gate commands included.

**Notices.** The chat, or thread, a task was created in follows it, and the tasks its runs
create. It hears when a task is done, needs review, blocks (with the kind and the reason),
is retried after a failure, gives up, or is stranded with nobody able to take it. A task that
keeps blocking for the same reason, `kanban.block_recurrence_limit` times after an unblock,
is flagged for rewriting instead. Notices are delivered from a cursor kept in the database, so
those due while the gateway was down are sent when it is back; a notice sent just before a
stop may be sent twice.

**Not yet:** people as assignees or reviewers. Naming one, with an @-mention, is refused, and
`/kanban done`, `block`, `review`, `approve` and `changes` say they arrive in plan D2, with
cards to a person's direct messages.
````


- [ ] **Step 10.2: Check.** Run `git grep -n -i "p[g]w" -- . ':!package-lock.json'`. Expected: no output. Run `npm test 2>&1 | tail -4`. Expected: `Tests  1199 passed (1199)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  72 passed (72)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.3: Commit.**

```bash
git add README.md
git commit -m "Document the board from Lark: the /kanban commands and their tiers, notices and how they survive a restart, and what waits for people"
```

---

## Done when

- `npm test` gives `Tests  1199 passed (1199)`. `npm run test:e2e` gives `Tests  72 passed (72)`. `npm run typecheck` reports no errors. All of these run under Node 22, in the worktree.
- Only `src/db/kanban.ts` writes a `kanban_` table, and only `src/kanban/service.ts` imports it (the guard in `tests/kanban-service.test.ts`). `src/kanban/chat.ts`, `src/kanban/chat-render.ts`, `src/kanban/chat-parse.ts` and `src/kanban/notices.ts` write nothing.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- `/kanban new` typed in a thread creates a task through the service, recorded as `lark:<union_id>` and subscribed to by that thread; the dispatcher runs it at once on a fake agent process that reports through the real socket; and the thread hears, once, that it is done — and nothing more after a restart (`tests/kanban-chat.e2e.ts`).
- Every `/kanban` command of spec §9.1 a role's task needs works at its tier; a talk-tier sender changes nothing; a person, a supervised role, an unknown role or workspace is refused at creation; the person-only commands answer that they arrive in D2 (`tests/kanban-chat.test.ts`).
- `/kanban` is answered while the chat's session is busy, and says the board is off when `kanban.enabled` is unset, opening no session (`tests/router.test.ts`).
- Every reply and notice is escaped and masked, gate commands included, and a cut never shows the start of a secret (`tests/kanban-chat-render.test.ts`).
- A subscription hears completed, review requested, blocked with its kind and reason, retrying after a failure, gave up and stranded, in order, once; a failed send is retried after its pause; a restart catches up from the cursors (`tests/kanban-notices.test.ts`).
- With `kanban.enabled` unset, the gateway builds no service, dispatcher, socket, chat commands or notifier.
