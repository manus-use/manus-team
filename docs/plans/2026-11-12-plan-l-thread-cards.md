# Plan L: Cards and notices in a task's thread. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a task created by `/kanban task new` in a group at chat scope a thread of its own, on the message that created it. Its "Created" reply is sent in that thread, with Lark's `reply_in_thread`, and its subscription moves there once Lark answers with the thread. Its person's cards go there when Lark's chat members API says they are in the group, starting with an @-mention of them; otherwise by direct message, as before. A direct message that cannot reach the person falls back to the thread, and a card the thread refuses falls back to a direct message, never to the top of the chat. Its notices, its follow-ups' notices and cards, and a supervised agent's approval cards go there too, all as replies to the thread's root. The group's timeline shows the command and its thread. The one line ("📋 *title*, assigned to *name*") moves from a person's claim to a card sent by direct message. A task created in a thread keeps its thread, now with its root; a task created in a direct message or at a terminal is unchanged; tasks created before this plan stay as they are.

**Architecture:**
- **The rows** (`schema/008_thread_roots.sql`, `src/db/kanban.ts`, `src/db/kanban-read.ts`, `src/kanban/types.ts`): `kanban_subscriptions.root_message_id`, written at creation from `CreatedVia.rootId` for a task created in a thread, copied to a follow-up, and once by `threadSubscription`, which moves a chat-scope subscription into the thread its reply opened. `card_sent` records `in: 'thread' | 'dm'`.
- **The channel** (`src/channel/types.ts`, `src/channel/lark/adapter.ts`, `src/channel/lark/inbound.ts`, `src/types.ts`): `SendTarget.replyInThread`, `root` and `stayInThread`; `SendResult.threadId`, read from Lark's answer; `Channel.chatMembers`, on `im.v1.chatMembers.get`; `InboundMessage.rootId`, from Lark's `root_id`, in a thread only.
- **The command and its reply** (`src/kanban/chat.ts`, `src/core/router.ts`): `KanbanCommands.run` answers `{ text, quoted?, thread? }`; the router sends `text` in a thread on the command, staying there, and `quoted` when Lark refuses it, then calls `KanbanCommands.threaded`, which moves the subscription. `KanbanChat` holds a fresh task, in memory, until then, or `CARD_SEND_MS`.
- **The cards** (`src/kanban/cards.ts`, `src/kanban/members.ts`, `src/kanban/chat-render.ts`): the card poster routes each card at each try by the rules of spec §19.2, through `Membership`, a cache of each group's members; the renderer puts in the mention.
- **The notices and approvals** (`src/kanban/notices.ts`, `src/kanban/sink.ts`): a thread's batch, and a forwarded approval card, reply to the thread's root.
- **The gateway** (`src/index.ts`): the card poster asks `KanbanChat.held`.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3, `@larksuiteoapi/node-sdk` 1.73.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §19 (from line 2843), its amendments to §9.2, §9.3 and §9.4, and plan L's row in §12.

---

## Ground rules

- **Where to work.**
  - Use the worktree beside the main checkout, `/Users/x/Develop/manus/prime-gateway-wt2`, on the branch `thread-cards`, which holds this plan, from `main` at `0001c69`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, never reach the real Lark, and never read or write `~/.manus-team`. Every test runs over the fake channel (`tests/helpers/channel.ts`) or a stand-in for the SDK's client, with a made-up database.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` (`vitest run --project unit`) gives `Tests  1734 passed (1734)`. `npm run test:e2e` gives `Tests  151 passed (151)`. `npm run typecheck` reports no errors. One unit test is known to fail now and then under load; run the suite again before looking into a single failure.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text is whole lines, and appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given. Every step of this plan was applied in that order, from `0001c69`, and gave the counts it states.
- **One writer per table.** `db/kanban.ts` stays the only writer of `kanban_subscriptions` and `kanban_events`, the root and `card_sent`'s `in` included; `db/people.ts` stays the only writer of `people`, which the card poster only reads. `src/db/WRITERS.md` says so (Tasks 1 and 2).
- **Words a person sees** (replies, notices, cards, the log, the README and the guide) never name a plan, and do not use the long dash.
- **No real agent.** No test runs bytesec. The end-to-end tests run fake drivers.

## Decisions

Each has its reason. Where the code and the spec disagree, the code is the fact, and the decision says which reading keeps the spec's intent; those are listed again under "Where the code forced a reading" below.

1. **A root is written only with a thread.** `subscribe()` writes `createdVia.rootId` only when `threadId` is not `''`, so a chat-scope subscription always has a null root until `threadSubscription` moves it, and "still at chat scope with no root" (§19.4) is one test. `KanbanChat` passes `rootId` only for a command typed in a group's thread, never in a direct message (§19.1), and the inbound side gives `rootId` only to a message with a `thread_id`: a quoted reply at chat scope carries a `root_id` too, which is no thread's.
2. **`threadSubscription` is `UPDATE OR IGNORE`.** The table's key is `(task_id, channel, account_id, conversation_id, thread_id)`; should the task somehow have a subscription in that thread already, the move changes nothing rather than throw. It returns `moved`, so a second call is visibly a no-op. It is called with `KanbanChat`'s `chatAt(key)`, the command's chat for this bot.
3. **`KanbanCommands.threaded` is synchronous.** It is one SQLite write and a timer's release. The router calls it in a `finally`, on every path once `run` answered with a `thread`, and notes it if it throws; the hold then lapses by its timer.
4. **The members lookup reads the whole group.** §19.3 says the pages are read "until the person is found or there are none left"; §19.7 gives the port no person to look for (`chatMembers(chatId)`) and says the cache is "of whole groups, so one lookup serves every person in the group". The second is the one the code can keep: `chatMembers` reads every page up to 20, and `complete` is false only when it stopped there. A person found on page 1 costs the same 20 pages at most once per group per five minutes.
5. **The cache is `Membership`, in its own module, owned by the card poster.** It keeps two `BoundedMap`s, one of five minutes for answers and one of one minute for failures, as a `BoundedMap` has one time to live. Keyed on the bot and the chat, at most 256 groups each. A timeout (`CARD_SEND_MS`, the card poster's `sendTimeoutMs`) is a failure. Not retried inside a lookup: a failure is remembered for a minute, and meanwhile the cards go by direct message.
6. **What the log says of a lookup.** Lark's 99991672 logs the exact line of §19.3 once per boot. Any other failure logs `kanban: the members of chat <chat> could not be read (<Lark's error, masked>); its cards go by direct message for a minute`, once each time a failure is remembered afresh, so at most once a minute per group. §19.3 asks for the code Lark answers to be found by the smoke checklist (item 7), and this line shows it if it is not 99991672.
7. **The wording of a reply in an existing thread.** A task created inside a group's thread whose root is known (every message Lark sends from a thread has one) is answered in the thread's words, "Their card comes in this thread …, This thread hears …": its card can go there, and §19.5's quoted wording is for "every reply not in a thread of the task's own". A command in a thread with no root, which Lark does not send but a test can, and any command in a direct message, is answered as today, as its card goes by direct message.
8. **A card refused in both places.** §19.2 says what follows a thread's refusal (a direct message, then §9.2 as today), but not what follows rule 3's fallback being refused in the thread. The reading that keeps "never back to the place it was refused in": the card is recorded `card_failed`, with both reasons, `<the direct message's refusal>; and in the task's thread: <the thread's>`, which its subscribers hear with the commands to type. A failure there that may pass is held back as any. The other way round, rule 4's direct message refused with 230013 after the thread refused the card, is recorded the same, `<the thread's refusal>; and by direct message: <the direct message's>`; any other refusal of it is held back, as §9.2 says.
9. **The card poster's thread is this bot's subscription on its channel.** §19.7 says to filter `subscriptionsOf(taskId)` by `deps.appId`; the card poster also requires the subscription's `channel` to be its channel's `id` (`lark`), as it can post nowhere else. A task has at most one subscription per bot, so nothing chooses among several.
10. **The mention.** By the open_id `people` holds for this bot's `app_id` and the person's union_id, read by the card poster with `personOf`; only an id shaped `ou_` and letters or digits (`/^ou_[0-9A-Za-z]+$/`, the adapter's own test for a person element) is put in; the mention precedes the card's first line, `<at id=ou_…></at> 📋 For you to do: …`. A direct message, a fallback included, and every redraw carry none.
11. **`card_sent`'s `in` is required.** `CardOutcome` is `{ messageId, in }`; the card poster sets it from `SendResult.threadId`. A `card_sent` with no `in`, from before this plan, is no notice (§19.5).
12. **The hold is a timer per task.** `setTimeout`, unreferenced, of `holdMs` (`CARD_SEND_MS` unless a test says otherwise). It is set synchronously after `service.create` returns and before the dispatcher is told, released by `threaded`, and released in a `catch` if the reply's render throws after the create. A held run is passed over without a word or a pause, so the next round, 2 s later, sends it.
13. **The router sends the threaded reply only for a group message at chat scope.** `KanbanChat` names a `thread` only then; should an answer name one elsewhere, the router sends `quoted ?? text` as today and calls `threaded(…, undefined)`.
14. **The fake channel's threads.** A send with a `threadId` lands in it; a reply with `replyInThread` lands in `omt_<message id>` unless `replyThreads` is off; a direct message lands in none. `answerNext('sendCard', …)` gives a deduplicated answer from the other place.

## Known limitations

- **No recovery of a thread a restart missed** (§19.6): a restart between Lark accepting the "Created" reply and the move leaves the task at chat scope.
- **Existing tasks are not moved** into threads, and their cards keep going by direct message.
- **A person who left the group** may get one card in a thread they no longer see, within the cache's five minutes.
- **A card is visible to the group**, the task's body, contract, parents' summaries and handoff included.
- **The reply window.** The hold keeps only the card back. A notice the task records in the moment between its creation and the move (a block at the first claim, §18.7) goes to the group at chat scope, as §19.4 accepts; so does a supervised agent's approval card asked in that moment, which §19 does not name. The end-to-end test of an approval asks once the thread is known.
- **The uuid across Lark's two APIs is unconfirmed** (smoke item 4): if a create and a reply with one uuid are two messages, a card sent in one place, not known to have landed, and routed to the other within the hour shows in both; if a refused send holds its uuid, the fallbacks need their own (§19.2). The plan keeps one uuid per run, as §19.2 says.
- **Lark's code for a missing permission** is taken as 99991672, unconfirmed (smoke item 7).
- **A thread from before this plan** has no root: its notices are sent as today, to the `thread_id` as a message id, and its cards go by direct message (smoke item 5).

## Where the code forced a reading

- **§19.3 and §19.7 on the lookup** (Decision 4): the whole group is read, up to 2,000 members, not only until the person is found.
- **A card refused by direct message and then in the thread** (Decision 8): not covered by §19.2; recorded `card_failed` with both reasons, as is rule 4's direct message refused with 230013.
- **The wording in an existing thread** (Decision 7): the thread's words when the root is known.
- **The card poster's subscription** (Decision 9): filtered by its channel as well as its app.
- **An approval card in the reply window** (Known limitations): goes to the group; §19 names only the notices there.
- Nothing else in §19 needed a reading: the SDK's normalized message carries `rootId`, its reply's answer carries `thread_id`, and `im.v1.chatMembers.get` takes `member_id_type: 'union_id'` and `page_size`, all as §19 assumes.

## File map

| File | Responsibility |
|---|---|
| `schema/008_thread_roots.sql` (create) | `kanban_subscriptions.root_message_id` |
| `src/kanban/types.ts`, `src/db/kanban-read.ts` (modify) | `CreatedVia.rootId`, `SubscriptionRow.rootMessageId` |
| `src/db/kanban.ts`, `src/db/WRITERS.md` (modify) | the root at the insert and copied; `threadSubscription`; `CardOutcome.in` |
| `src/kanban/service.ts` (modify) | `rootId` checked; `threadSubscription` |
| `src/channel/types.ts`, `src/channel/lark/adapter.ts` (modify) | `SendTarget.replyInThread`, `root`, `stayInThread`; `SendResult.threadId`; `ChatMembers`, `chatMembers` |
| `src/types.ts`, `src/channel/lark/inbound.ts` (modify) | `InboundMessage.rootId` |
| `src/core/router.ts` (modify) | `KanbanAnswer`, `KanbanCommands.threaded`; the threaded "Created" reply and its quoted fallback |
| `src/kanban/chat.ts` (modify) | `createdVia.rootId`; the two wordings; `held`, `threaded`, the hold |
| `src/kanban/chat-render.ts` (modify) | `CardFacts.mention`; the one line on a `card_sent` by direct message |
| `src/kanban/members.ts` (create) | `Membership`: who is in a group, cached |
| `src/kanban/cards.ts` (modify) | the routing rules, the mention's open_id, `held`, `card_sent`'s `in` |
| `src/kanban/notices.ts`, `src/kanban/sink.ts` (modify) | a reply to the thread's root; the sink's `chatMembers` |
| `src/index.ts` (modify) | `held` wired |
| `README.md`, `docs/kanban-guide.md` (modify) | where a card goes, the one line, the thread, the permission |
| `tests/helpers/channel.ts` (modify) | threads, members, `answerNext` |
| `tests/kanban-thread-roots.test.ts`, `tests/kanban-thread-chat.test.ts`, `tests/kanban-members.test.ts`, `tests/kanban-thread-cards.test.ts`, `tests/kanban-thread.e2e.ts` (create) | |
| `tests/gateway-startup.test.ts`, `tests/kanban-boards-schema.test.ts`, `tests/kanban-worktree-schema.test.ts`, `tests/kanban-schema.test.ts`, `tests/kanban-subscriptions.test.ts`, `tests/lark-adapter.test.ts`, `tests/lark-cards.test.ts`, `tests/kanban-sink.test.ts`, `tests/lark-inbound.test.ts`, `tests/kanban-chat.test.ts`, `tests/kanban-board-chat.test.ts`, `tests/router.test.ts`, `tests/kanban-chat-render.test.ts`, `tests/kanban-people-reports.test.ts`, `tests/kanban-notices.test.ts` (modify) | |

Running counts, unit then end to end: Task 1 1738 / 151, Task 2 1741 / 151, Task 3 1744 / 151, Task 4 1746 / 151, Task 5 1748 / 151, Task 6 1754 / 151, Task 7 1758 / 151, Task 8 1759 / 151, Task 9 1763 / 151, Task 10 1772 / 151, Task 11 1772 / 151, Task 12 1774 / 151, Task 13 1774 / 157, Task 14 1774 / 157.

How §19.9's tests map to the tasks: the routing rules, the mention's open_id, `in` from Lark's answer, a deduplicated answer, the codes a thread refuses with, a retried card routed afresh, the hold checked at each send, and a lookup past `CARD_SEND_MS` (Task 10); the mention and none on a redraw (Task 8); the cache's five minutes, a failure's one, and the one log line (Task 9); the move once, its cursor, a second call (Task 2); the root at creation in a thread, copied to a follow-up (Task 1) and written by the move (Task 2); the failed reply, a 230071 sent quoted, a reply with no `thread_id`, and a withdrawn command's quoted wording (Task 7); the hold set before any await, only on a fresh task from a group at chat scope, ended on every path, an error after the create included, and a move after it lapsed (Task 6); the one line (Task 11); a batch replying to a root, and an approval card replying to it (Task 12); and the end-to-end list (Task 13).

---

### Task 1: The root of a task's thread, in the schema

**Files:**

- Create: `tests/kanban-thread-roots.test.ts`, `schema/008_thread_roots.sql`
- Modify: `tests/gateway-startup.test.ts`, `tests/kanban-boards-schema.test.ts`, `tests/kanban-worktree-schema.test.ts`, `tests/kanban-schema.test.ts`, `tests/kanban-subscriptions.test.ts`, `src/kanban/types.ts`, `src/db/kanban-read.ts`, `src/db/kanban.ts`, `src/kanban/service.ts`, `src/db/WRITERS.md`

Migration `008` adds `kanban_subscriptions.root_message_id`, null for every subscription already on the board (spec §19.4). `CreatedVia`'s chat kind gains `rootId?`, which `subscribe()` writes as the root of a subscription in a thread, and never at chat scope, where the root comes from `threadSubscription` alone (Task 2); a follow-up copies its creating task's root with its thread. `SubscriptionRow` reads it as `rootMessageId`, and the service refuses a `rootId` that is not text. Four tests that name the schema's version move to 8; one that creates a task on a database migrated only so far moves to 8, as a subscription is now written with the column; the subscription test that lists a whole row gains `rootMessageId: null`. WRITERS.md's row for `kanban_subscriptions` names the first two writes of the root.

- [ ] **Step 1.1: Write the tests.**

Create `tests/kanban-thread-roots.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask } from '../src/db/kanban.js';
import { subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia } from '../src/kanban/types.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { ALICE, NOW, WORKSPACES, claimed, newTask } from './helpers/kanban.js';

/**
 * The root of a task's thread (spec §19.4, migration 008): written at creation
 * for a task created in a thread, copied to a follow-up, and none at chat scope
 * or for a subscription from before the migration.
 */

const THREAD: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' };

let h: TestDb;

beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

describe('migration 008', () => {
  it('gives every subscription already on the board no root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-roots-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^00[1-7]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(7);
        d.prepare(
          `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at)
           VALUES ('k_old', 'from before', jsonb('{}'), 'open', 'lark:on_alice', jsonb('{}'), ?)`,
        ).run(NOW);
        d.prepare(
          `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
           VALUES ('k_old', 'lark', 'cli_app', 'oc_team', 'omt_topic', ?)`,
        ).run(NOW);
        expect(migrate(d, SCHEMA_DIR)).toBe(8);
        expect(subscriptionsOf(d, 'k_old')).toMatchObject([{ threadId: 'omt_topic', rootMessageId: null }]);
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a subscription's root", () => {
  it('is written at creation for a task created in a thread, and never at chat scope', () => {
    const inThread = newTask(h.db, { createdVia: THREAD });
    expect(subscriptionsOf(h.db, inThread.taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_topic', 'om_root']]);
    // A root given at chat scope is not one: the chat's root comes only from the threaded reply.
    const atChat = newTask(h.db, { createdVia: { ...THREAD, threadId: '' } });
    expect(subscriptionsOf(h.db, atChat.taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['', null]]);
    const without = newTask(h.db, { createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' } });
    expect(subscriptionsOf(h.db, without.taskId)[0]?.rootMessageId).toBeNull();
  });

  it("is copied to a follow-up, with the creating task's thread", () => {
    const parent = newTask(h.db, { createdVia: THREAD });
    const run = claimed(h.db, parent.taskId);
    const child = createTask(h.db, { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW);
    if (!child.ok) throw new Error(child.message);
    expect(subscriptionsOf(h.db, child.task.taskId).map((s) => [s.conversationId, s.threadId, s.rootMessageId, s.cursor])).toEqual([
      ['oc_team', 'omt_topic', 'om_root', 0],
    ]);
  });

  it('is refused by the service unless it is text', () => {
    const service = new KanbanService({ db: h.db, roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])), workspaces: WORKSPACES });
    const via = { ...THREAD, rootId: 5 } as unknown as CreatedVia;
    expect(service.create({ title: 't', assignee: 'implementer', createdBy: ALICE, createdVia: via })).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.create({ title: 't', assignee: 'implementer', createdBy: ALICE, createdVia: THREAD }).ok).toBe(true);
  });
});
```

In `tests/gateway-startup.test.ts`, replace:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 7 (${config.dbPath})\n`))).toBe(true);
```

with:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 8 (${config.dbPath})\n`))).toBe(true);
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
    expect(migrate(db, SCHEMA_DIR)).toBe(7);
```

with:

```ts
    expect(migrate(db, SCHEMA_DIR)).toBe(8);
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 7 });
  });

  it('puts a task created afterwards on default unless it says otherwise', () => {
    // As far as the code it runs needs: 007 adds the column every task row is read with.
    db = migratedTo(7);
```

with:

```ts
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 8 });
  });

  it('puts a task created afterwards on default unless it says otherwise', () => {
    // As far as the code it runs needs: 007 adds the column every task row is read with, 008 the one its subscription is written with.
    db = migratedTo(8);
```

In `tests/kanban-worktree-schema.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(7);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(8);
```

In `tests/kanban-schema.test.ts`, replace:

```ts
    // 004 adds a column to kanban_comments and an index, 005 the people table, 006 the boards' two tables, 007 a column.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(7);
```

with:

```ts
    // 004 adds a column to kanban_comments and an index, 005 the people table, 006 the boards' two tables, 007 and 008 a column each.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(8);
```

In `tests/kanban-subscriptions.test.ts`, replace:

```ts
        threadId: 'omt_topic',
        cursor: 0,
        createdAt: NOW,
```

with:

```ts
        threadId: 'omt_topic',
        rootMessageId: null,
        cursor: 0,
        createdAt: NOW,
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-thread-roots.test.ts tests/gateway-startup.test.ts tests/kanban-boards-schema.test.ts tests/kanban-worktree-schema.test.ts tests/kanban-schema.test.ts tests/kanban-subscriptions.test.ts`. Expected: `Tests  9 failed | 37 passed (46)`: the schema is at version 7, and no subscription has a root.

- [ ] **Step 1.3: Implement.**

Create `schema/008_thread_roots.sql`:

```sql
-- manus-team migration 008: the root of a task's thread
-- See docs/specs/2026-11-02-kanban-design.md §19.
--
-- A task created by `/kanban task new` in a group at chat scope is answered in a
-- thread on its command message, and its subscription moves to that thread. Lark
-- replies in a thread to a message, by its id, so the subscription records the
-- thread's root: the command message, or for a task created in an existing
-- thread, the root Lark gave the command. null, no root is known: every
-- subscription from before this migration, every one at chat scope, and every
-- direct message. A board send in a thread with a root replies to it, and a
-- person's card goes in a thread only when it has one. db/kanban.ts is its only
-- writer (src/db/WRITERS.md): at the insert, copied to a follow-up, and once by
-- threadSubscription; never changed once written. No default and no rewrite.
ALTER TABLE kanban_subscriptions ADD COLUMN root_message_id TEXT;

UPDATE schema_version SET version = 8;
```

In `src/kanban/types.ts`, replace:

```ts
/**
 * Where a task came from (spec §3.1): the chat it was created in, the run that
 * created it, or an operator's `mt kanban task new` at a terminal, which no chat
 * follows.
 */
export type CreatedVia =
  | { kind: 'chat'; channel: string; appId: string; conversationId: string; threadId: string }
```

with:

```ts
/**
 * Where a task came from (spec §3.1): the chat it was created in, the run that
 * created it, or an operator's `mt kanban task new` at a terminal, which no chat
 * follows. A chat's `rootId`, for a command typed in a thread, is the thread's
 * root message, which a send in the thread replies to (spec §19.4); never set at
 * chat scope.
 */
export type CreatedVia =
  | { kind: 'chat'; channel: string; appId: string; conversationId: string; threadId: string; rootId?: string }
```

In `src/kanban/types.ts`, replace:

```ts
  conversationId: string;
  threadId: string;
  cursor: number;
  createdAt: number;
}
```

with:

```ts
  conversationId: string;
  threadId: string;
  /**
   * The thread's root message, which a send in the thread replies to (spec §19.4,
   * migration 008); null at chat scope, in a direct message, and for a thread
   * whose root was never recorded. Only a subscription with one is a thread a
   * person's card can go to.
   */
  rootMessageId: string | null;
  cursor: number;
  createdAt: number;
}
```

In `src/db/kanban-read.ts`, replace:

```ts
  conversation_id: string;
  thread_id: string;
  cursor: number;
  created_at: number;
}

function decodeSubscription(r: SubscriptionRaw): SubscriptionRow {
```

with:

```ts
  conversation_id: string;
  thread_id: string;
  root_message_id: string | null;
  cursor: number;
  created_at: number;
}

function decodeSubscription(r: SubscriptionRaw): SubscriptionRow {
```

In `src/db/kanban-read.ts`, replace:

```ts
    threadId: r.thread_id,
    cursor: r.cursor,
    createdAt: r.created_at,
  };
}

const SUBSCRIPTION_COLS = 'id, task_id, channel, account_id, conversation_id, thread_id, cursor, created_at';
```

with:

```ts
    threadId: r.thread_id,
    rootMessageId: r.root_message_id,
    cursor: r.cursor,
    createdAt: r.created_at,
  };
}

const SUBSCRIPTION_COLS = 'id, task_id, channel, account_id, conversation_id, thread_id, root_message_id, cursor, created_at';
```

In `src/db/kanban.ts`, replace:

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
```

with:

```ts
/**
 * The chats that follow a new task (spec §9.4, §7.3): the chat it was created
 * in; or, for a task a run created, every chat following the creating run's
 * task, so whoever follows that task hears about its follow-ups too, in its
 * thread, with its root (spec §19.4). Each cursor starts at 0: every event of the
 * new task is newer than that. A root is written only with a thread: at chat
 * scope it comes from `threadSubscription` alone.
 */
function subscribe(d: Db, taskId: string, via: CreatedVia, createdFromTask: string | null, now: number): void {
  const insert = d.prepare(
    `INSERT OR IGNORE INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, root_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  if (via.kind === 'chat') {
    const root = via.threadId === '' || via.rootId === undefined || via.rootId === '' ? null : via.rootId;
    insert.run(taskId, via.channel, via.appId, via.conversationId, via.threadId, root, now);
    return;
  }
  if (createdFromTask === null) return;
  for (const s of subscriptionsOf(d, createdFromTask)) {
    insert.run(taskId, s.channel, s.appId, s.conversationId, s.threadId, s.rootMessageId, now);
  }
}
```

In `src/kanban/service.ts`, replace:

```ts
          isText(via.conversationId) &&
          isText(via.threadId));
  return fine ? undefined : board.refuse('invalid', 'created_via is a chat, with text fields, a run id, or the operator');
```

with:

```ts
          isText(via.conversationId) &&
          isText(via.threadId) &&
          (via.rootId === undefined || isText(via.rootId)));
  return fine ? undefined : board.refuse('invalid', 'created_via is a chat, with text fields, a run id, or the operator');
```

In `src/db/WRITERS.md`, replace:

```md
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. Never deleted. |
```

with:

```md
| `kanban_subscriptions` | `db/kanban.ts` | Added by `createTask`, in its transaction: the chat a task is created in, or the subscriptions of the task whose run created it (spec §9.4). `root_message_id` (migration 008) is written at the insert, for a task created in a thread, from `createdVia.rootId`, or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. Never deleted. |
```

- [ ] **Step 1.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1738 passed (1738)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.5: Commit.**

```bash
git add tests/kanban-thread-roots.test.ts schema/008_thread_roots.sql tests/gateway-startup.test.ts tests/kanban-boards-schema.test.ts tests/kanban-worktree-schema.test.ts tests/kanban-schema.test.ts tests/kanban-subscriptions.test.ts src/kanban/types.ts src/db/kanban-read.ts src/db/kanban.ts src/kanban/service.ts src/db/WRITERS.md
git commit -m "Record the root of a task's thread on its subscription: migration 008 adds root_message_id, written at creation for a task created in a thread and copied to its follow-ups, never at chat scope"
```

---

### Task 2: Moving a subscription into its thread

**Files:**

- Modify: `tests/kanban-thread-roots.test.ts`, `src/db/kanban.ts`, `src/kanban/service.ts`, `src/db/WRITERS.md`

`threadSubscription` in `db/kanban.ts` (spec §19.4): the third and last write of a root. It moves a task's subscription at a chat, for this bot, still at chat scope with no root, to the thread its "Created" reply opened, setting `thread_id` and `root_message_id` in one transaction, and writes no event, as a cursor's move writes none. The row is the same row, so its cursor moves with it. A second call, or one for a subscription already in a thread, changes nothing (`moved: false`). `UPDATE OR IGNORE` leaves a subscription of the task already in that thread as it is, rather than throw on the table's unique key. `KanbanService.threadSubscription` checks its arguments are text. WRITERS.md names the writer.

- [ ] **Step 2.1: Write the tests.**

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
import { createTask } from '../src/db/kanban.js';
import { subscriptionsOf } from '../src/db/kanban-read.js';
```

with:

```ts
import { advanceSubscription, createTask, threadSubscription } from '../src/db/kanban.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
import { ALICE, NOW, WORKSPACES, claimed, newTask } from './helpers/kanban.js';
```

with:

```ts
import { ALICE, NOW, VIA, WORKSPACES, claimed, newTask } from './helpers/kanban.js';
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
const THREAD: CreatedVia = 
```

with:

```ts
/** The chat `VIA` creates its tasks from, as `KanbanChat` names it. */
const CHAT = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat' };
const THREAD: CreatedVia = 
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
    expect(service.create({ title: 't', assignee: 'implementer', createdBy: ALICE, createdVia: THREAD }).ok).toBe(true);
  });
});
```

with:

```ts
    expect(service.create({ title: 't', assignee: 'implementer', createdBy: ALICE, createdVia: THREAD }).ok).toBe(true);
  });
});

describe('threadSubscription', () => {
  it('moves a chat-scope subscription into its thread, once, with its root and its cursor, writing no event', () => {
    const task = newTask(h.db, { createdVia: VIA });
    const [before] = subscriptionsOf(h.db, task.taskId);
    const created = eventsOf(h.db, task.taskId).at(-1)?.id ?? 0;
    expect(advanceSubscription(h.db, before?.id ?? 0, created).ok).toBe(true);
    const events = eventsOf(h.db, task.taskId).length;
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: true });
    expect(subscriptionsOf(h.db, task.taskId)).toEqual([
      { ...before, threadId: 'omt_new', rootMessageId: 'om_cmd', cursor: created },
    ]);
    expect(eventsOf(h.db, task.taskId)).toHaveLength(events);
    // A second call, for that thread or another, changes nothing.
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_other', 'om_other')).toEqual({ ok: true, moved: false });
    expect(subscriptionsOf(h.db, task.taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_new', 'om_cmd']]);
  });

  it("moves only that task's subscription, at that chat, for this bot, while it is at chat scope", () => {
    const task = newTask(h.db, { createdVia: VIA });
    const neighbour = newTask(h.db, { createdVia: VIA });
    const inThread = newTask(h.db, { createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: 'omt_topic' } });
    expect(threadSubscription(h.db, task.taskId, { ...CHAT, appId: 'cli_other' }, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, task.taskId, { ...CHAT, conversationId: 'oc_other' }, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, inThread.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: false });
    expect(threadSubscription(h.db, task.taskId, CHAT, 'omt_new', 'om_cmd')).toEqual({ ok: true, moved: true });
    expect(subscriptionsOf(h.db, neighbour.taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['', null]]);
    expect(subscriptionsOf(h.db, inThread.taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_topic', null]]);
  });

  it('is refused through the service for an empty thread or root, or anything but text', () => {
    const service = new KanbanService({ db: h.db, roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])), workspaces: WORKSPACES });
    const task = newTask(h.db, { createdVia: VIA });
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

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-thread-roots.test.ts`. Expected: `Tests  3 failed | 4 passed (7)`: `threadSubscription is not a function`.

- [ ] **Step 2.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
    return { ok: true, advanced: changes === 1 };
  });
}
```

with:

```ts
    return { ok: true, advanced: changes === 1 };
  });
}

/**
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
  });
}
```

In `src/kanban/service.ts`, replace:

```ts
    return board.advanceSubscription(this.#db, subscriptionId, cursor);
  }
```

with:

```ts
    return board.advanceSubscription(this.#db, subscriptionId, cursor);
  }

  /**
   * A task's subscription at this chat moved into the thread its "Created" reply
   * opened, with the command message as its root (spec §19.4): `KanbanChat`'s,
   * once Lark answered the reply with its thread.
   */
  threadSubscription(taskId: string, at: ChatAt, threadId: string, rootId: string): Result<{ moved: boolean }> {
    const ids = idsRefused(taskId, threadId, rootId);
    if (ids !== undefined) return ids;
    if (!isRecord(at) || !isText(at.channel) || !isText(at.appId) || !isText(at.conversationId)) {
      return board.refuse('invalid', 'a chat is its channel, bot and conversation, as text');
    }
    return board.threadSubscription(this.#db, taskId, at, threadId, rootId);
  }
```

In `src/db/WRITERS.md`, replace:

```md
or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. Never deleted. |
```

with:

```md
or copied with the creating task's subscription (spec §19.4). `cursor` is moved forward only, by `advanceSubscription`, which writes no event: it is the notifier's own cursor, as a binding's `cursor_seq` is the card writer's. `thread_id` and `root_message_id` are written once more, together, by `threadSubscription`, which moves a subscription still at chat scope with no root into the thread its task's "Created" reply opened, writing no event either. No root is changed once written. Never deleted. |
```

- [ ] **Step 2.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1741 passed (1741)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.5: Commit.**

```bash
git add tests/kanban-thread-roots.test.ts src/db/kanban.ts src/kanban/service.ts src/db/WRITERS.md
git commit -m "Move a task's subscription at chat scope into the thread its reply opened, once, with its root and its cursor, writing no event"
```

---

### Task 3: Sends in a thread: the root, a reply that opens a thread, and staying there

**Files:**

- Modify: `tests/lark-cards.test.ts`, `tests/lark-adapter.test.ts`, `src/channel/types.ts`, `src/channel/lark/adapter.ts`, `tests/helpers/channel.ts`

`SendTarget` gains `replyInThread` (a reply to `replyTo` with Lark's `reply_in_thread`, at chat scope), `root` (the message a send in a thread replies to) and `stayInThread` (no withdrawn fallback to the chat); `SendResult` gains `threadId`, read from Lark's answer (spec §19.7). `messageRequest` replies to `root` when it is given, and to the thread's id as before when not; `#post` returns Lark's `thread_id`, absent when Lark gave none, and throws a refusal of a reply that stays in its thread instead of moving it to the chat. `#sendOptions`, which places a long text and a streamed card through the SDK, honours the same fields. The fake channel answers a send in a thread with its thread, and a reply that opens one with `omt_<message id>`, or with none once `replyThreads` is off.

- [ ] **Step 3.1: Write the tests.**

In `tests/lark-cards.test.ts`, replace:

```ts
  it('makes a text one post of one markdown element, as the SDK does', () => {
```

with:

```ts
  it("replies in a thread to its root when one is known, and opens a thread on a message when asked (spec §19.4)", () => {
    expect(messageRequest({ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' }, 'post', card, 'u-5')).toEqual({
      kind: 'reply',
      path: { message_id: 'om_root' },
      data: { msg_type: 'post', content: JSON.stringify(card), uuid: 'u-5', reply_in_thread: true },
    });
    expect(messageRequest({ chatId: 'oc_team', threadId: '', replyTo: 'om_q', replyInThread: true }, 'post', card, 'u-6')).toEqual({
      kind: 'reply',
      path: { message_id: 'om_q' },
      data: { msg_type: 'post', content: JSON.stringify(card), uuid: 'u-6', reply_in_thread: true },
    });
    // A direct message is never a reply, whatever the target carries.
    expect(messageRequest({ ...personTarget('on_alice'), root: 'om_root', replyTo: 'om_q', replyInThread: true }, 'interactive', card, 'u-7')).toMatchObject({
      kind: 'create',
      params: { receive_id_type: 'union_id' },
    });
  });

  it('makes a text one post of one markdown element, as the SDK does', () => {
```

In `tests/lark-adapter.test.ts`, replace:

```ts
function adapter(answers: Array<Error | undefined>): { a: LarkAdapter; calls: Call[]; waits: number[] } {
  const calls: Call[] = [];
  const waits: number[] = [];
  let seq = 0;
  const answer = async (kind: Call['kind'], payload: Call['payload']) => {
    calls.push({ kind, payload });
    const next = answers.shift();
    if (next !== undefined) throw next;
    return { code: 0, msg: 'ok', data: { message_id: `om_${++seq}` } };
  };
```

with:

```ts
/** What Lark answers a send with: a failure, or more of a success's data, such as its thread_id. */
type Answer = Error | { thread_id: string } | undefined;

function adapter(answers: Answer[]): { a: LarkAdapter; calls: Call[]; waits: number[] } {
  const calls: Call[] = [];
  const waits: number[] = [];
  let seq = 0;
  const answer = async (kind: Call['kind'], payload: Call['payload']) => {
    calls.push({ kind, payload });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { code: 0, msg: 'ok', data: { message_id: `om_${++seq}`, ...next } };
  };
```

In `tests/lark-adapter.test.ts`, replace:

```ts
describe('LarkAdapter.sendApprovalCard', () => {
```

with:

```ts
describe('LarkAdapter in a thread (spec §19.4, §19.7)', () => {
  const where = (calls: Call[]) => calls.map((c) => [c.kind, c.payload.path?.message_id ?? c.payload.data.receive_id]);

  it("reads the thread a send landed in from Lark's answer, and none when it has none", async () => {
    const threaded = adapter([{ thread_id: 'omt_new' }]);
    expect(await threaded.a.sendText({ chatId: 'oc_team', threadId: '', replyTo: 'om_cmd', replyInThread: true }, 'Created', 'u-1')).toEqual({
      messageId: 'om_1',
      deduped: false,
      threadId: 'omt_new',
    });
    expect(where(threaded.calls)).toEqual([['reply', 'om_cmd']]);
    const card = adapter([{ thread_id: 'omt_topic' }]);
    expect((await card.a.sendCard({ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' }, { markdown: 'x', buttons: [] }, 'u-2')).threadId).toBe(
      'omt_topic',
    );
    expect(where(card.calls)).toEqual([['reply', 'om_root']]);
    const dm = adapter([{ thread_id: '' }]);
    expect(await dm.a.sendCard({ chatId: 'on_alice', threadId: '', receiveIdType: 'union_id' }, { markdown: 'x', buttons: [] }, 'u-3')).toEqual({
      messageId: 'om_1',
      deduped: false,
    });
  });

  it('keeps a send that stays in its thread out of the chat: a withdrawn root, 230017 or an HTTP 404 reaches the caller', async () => {
    const target = { chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root', stayInThread: true };
    for (const err of [refused(230011), refused(230017), refused(230099, 404)]) {
      const gone = adapter([err]);
      await expect(gone.a.sendCard(target, { markdown: 'x', buttons: [] }, 'u-4')).rejects.toBeInstanceOf(ChannelError);
      expect(where(gone.calls)).toEqual([['reply', 'om_root']]);
    }
    const created = adapter([refused(230011)]);
    await expect(
      created.a.sendText({ chatId: 'oc_team', threadId: '', replyTo: 'om_cmd', replyInThread: true, stayInThread: true }, 'Created', 'u-5'),
    ).rejects.toMatchObject({ code: 230011, retryable: false });
    expect(where(created.calls)).toEqual([['reply', 'om_cmd']]);
    // Without it, a notice's reply to a gone root goes to the chat, as before.
    const notice = adapter([refused(230011)]);
    await notice.a.sendText({ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' }, 'Done', 'u-6');
    expect(where(notice.calls)).toEqual([
      ['reply', 'om_root'],
      ['create', 'oc_team'],
    ]);
  });
});

describe('LarkAdapter.sendApprovalCard', () => {
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/lark-adapter.test.ts tests/lark-cards.test.ts`. Expected: `Tests  3 failed | 22 passed (25)`: the request replies to the thread's id, the answer has no `threadId`, and a refused reply goes to the chat.

- [ ] **Step 3.3: Implement.**

In `src/channel/types.ts`, replace:

```ts
  /**
   * How `chatId` names who receives the message: absent, a chat; `union_id`, a
   * person, sent a direct message (spec §9.2). Lark takes the type per message,
   * so a person need not have opened a chat with the bot first.
   */
  receiveIdType?: 'union_id';
}
```

with:

```ts
  /**
   * With `replyTo`, at chat scope: the reply opens a thread on that message, with
   * Lark's `reply_in_thread`, rather than quoting it (spec §19.4: a task's
   * "Created" reply).
   */
  replyInThread?: boolean;
  /**
   * In a thread: the thread's root message, which the send replies to, with
   * `reply_in_thread` (spec §19.4). Absent, the send replies to `threadId` as a
   * message id, as before.
   */
  root?: string;
  /**
   * A reply whose message is gone is not moved to its chat, and the refusal
   * reaches the caller (spec §19.2, §19.4): a person's card in a thread, and the
   * threaded "Created" reply.
   */
  stayInThread?: boolean;
  /**
   * How `chatId` names who receives the message: absent, a chat; `union_id`, a
   * person, sent a direct message (spec §9.2). Lark takes the type per message,
   * so a person need not have opened a chat with the bot first.
   */
  receiveIdType?: 'union_id';
}
```

In `src/channel/types.ts`, replace:

```ts
export interface SendResult {
  messageId: string;
  /** True when the platform returned an existing message for a repeated uuid. */
  deduped: boolean;
}
```

with:

```ts
export interface SendResult {
  messageId: string;
  /** True when the platform returned an existing message for a repeated uuid. */
  deduped: boolean;
  /**
   * The thread the message is in, as the platform answered: absent for a message
   * in no thread, a direct message among them (spec §19.2, §19.7).
   */
  threadId?: string;
}
```

In `src/channel/lark/adapter.ts`, replace:

```ts
  /**
   * One message, sent through the SDK's client with its uuid. A reply whose
   * message is gone -- refused with one of `WITHDRAWN_CODES`, or with an HTTP
   * 404 -- goes to the chat instead, with the same uuid: the fallback the SDK's
   * own send makes, less 230020, which is retried as a rate limit instead.
   */
```

with:

```ts
  /**
   * One message, sent through the SDK's client with its uuid, answered with the
   * thread Lark says it is in, if any. A reply whose message is gone -- refused
   * with one of `WITHDRAWN_CODES`, or with an HTTP 404 -- goes to the chat
   * instead, with the same uuid: the fallback the SDK's own send makes, less
   * 230020, which is retried as a rate limit instead. Not for a target that stays
   * in its thread (spec §19.2): the refusal is thrown.
   */
```

In `src/channel/lark/adapter.ts`, replace:

```ts
      let r: { code?: number | undefined; msg?: string | undefined; data?: { message_id?: string | undefined } | undefined };
```

with:

```ts
      let r: {
        code?: number | undefined;
        msg?: string | undefined;
        data?: { message_id?: string | undefined; thread_id?: string | undefined } | undefined;
      };
```

In `src/channel/lark/adapter.ts`, replace:

```ts
      if (messageId === undefined || messageId === '') throw new ChannelError(0, 'Lark answered the send with no message id', false);
      return { messageId, deduped: false };
    };
    const req = messageRequest(target, msgType, content, uuid);
    try {
      return await send(req);
    } catch (err) {
      const gone = err instanceof ChannelError && !err.retryable && (WITHDRAWN_CODES.has(err.code) || notFound.has(err));
      if (req.kind !== 'reply' || !gone) throw err;
```

with:

```ts
      if (messageId === undefined || messageId === '') throw new ChannelError(0, 'Lark answered the send with no message id', false);
      // Lark's reply answers with "the topic the message belongs to"; a direct message has none.
      const threadId = r.data?.thread_id;
      return { messageId, deduped: false, ...(threadId === undefined || threadId === '' ? {} : { threadId }) };
    };
    const req = messageRequest(target, msgType, content, uuid);
    try {
      return await send(req);
    } catch (err) {
      const gone = err instanceof ChannelError && !err.retryable && (WITHDRAWN_CODES.has(err.code) || notFound.has(err));
      if (req.kind !== 'reply' || !gone || target.stayInThread === true) throw err;
```

In `src/channel/lark/adapter.ts`, replace:

```ts
    if (target.threadId === '') {
      // A quoted reply that stays in the main chat, not a new thread under it.
      return target.replyTo === undefined ? {} : { replyTo: target.replyTo };
    }
    return { replyTo: target.threadId, replyInThread: true };
```

with:

```ts
    if (target.threadId === '') {
      if (target.replyTo === undefined) return {};
      // A quoted reply that stays in the main chat, unless asked to open a thread on it.
      return target.replyInThread === true ? { replyTo: target.replyTo, replyInThread: true } : { replyTo: target.replyTo };
    }
    return { replyTo: threadAnchor(target), replyInThread: true };
```

In `src/channel/lark/adapter.ts`, replace:

```ts
/**
 * The request for one message to `target`, as `#sendOptions` places a message:
 * in its thread, as a quoted reply, or new in the chat -- or, for a person, as a
 * direct message by union_id. The uuid goes with it either way.
 */
export function messageRequest(target: SendTarget, msgType: string, content: object, uuid: string): MessageRequest {
  const body = { msg_type: msgType, content: JSON.stringify(content), uuid };
  if (target.receiveIdType !== 'union_id') {
    if (target.threadId !== '') return { kind: 'reply', path: { message_id: target.threadId }, data: { ...body, reply_in_thread: true } };
    if (target.replyTo !== undefined) return { kind: 'reply', path: { message_id: target.replyTo }, data: body };
  }
```

with:

```ts
/**
 * The message a send in a thread replies to: the thread's root when it is known
 * (spec §19.4), as Lark documents its reply API; else the thread's own id, as
 * every thread reply was sent before.
 */
function threadAnchor(target: SendTarget): string {
  return target.root === undefined || target.root === '' ? target.threadId : target.root;
}

/**
 * The request for one message to `target`, as `#sendOptions` places a message:
 * in its thread, as a quoted reply or one that opens a thread on its message, or
 * new in the chat -- or, for a person, as a direct message by union_id. The uuid
 * goes with it either way.
 */
export function messageRequest(target: SendTarget, msgType: string, content: object, uuid: string): MessageRequest {
  const body = { msg_type: msgType, content: JSON.stringify(content), uuid };
  if (target.receiveIdType !== 'union_id') {
    if (target.threadId !== '') return { kind: 'reply', path: { message_id: threadAnchor(target) }, data: { ...body, reply_in_thread: true } };
    if (target.replyTo !== undefined) {
      const data = target.replyInThread === true ? { ...body, reply_in_thread: true } : body;
      return { kind: 'reply', path: { message_id: target.replyTo }, data };
    }
  }
```

In `tests/helpers/channel.ts`, replace:

```ts
  readonly #clock: Clock;
  readonly #failures = new Map<Method, unknown[]>();
```

with:

```ts
  /**
   * Whether a reply that opens a thread is answered with that thread's id, as
   * Lark answers one (spec §19.4): `omt_` and the message replied to. Off, it is
   * answered with none, as a reply Lark did not thread.
   */
  replyThreads = true;

  readonly #clock: Clock;
  readonly #failures = new Map<Method, unknown[]>();
```

In `tests/helpers/channel.ts`, replace:

```ts
  get lastCard(): FakeCard | undefined {
    return this.cards.at(-1);
  }
```

with:

```ts
  get lastCard(): FakeCard | undefined {
    return this.cards.at(-1);
  }

  /** The thread a send to `target` lands in, as Lark answers: none for a direct message, or a message in no thread. */
  threadOf(target: SendTarget): string | undefined {
    if (target.receiveIdType === 'union_id') return undefined;
    if (target.threadId !== '') return target.threadId;
    if (target.replyTo !== undefined && target.replyInThread === true && this.replyThreads) return `omt_${target.replyTo}`;
    return undefined;
  }

  #result(messageId: string, target: SendTarget): SendResult {
    const threadId = this.threadOf(target);
    return { messageId, deduped: false, ...(threadId === undefined ? {} : { threadId }) };
  }
```

In `tests/helpers/channel.ts`, replace:

```ts
    this.texts.push({ target, text, uuid, ...(buttons === undefined ? {} : { buttons }) });
    return { messageId: `om_text_${++this.#seq}`, deduped: false };
```

with:

```ts
    this.texts.push({ target, text, uuid, ...(buttons === undefined ? {} : { buttons }) });
    return this.#result(`om_text_${++this.#seq}`, target);
```

In `tests/helpers/channel.ts`, replace:

```ts
    this.approvalCards.push({ target, spec, uuid });
    return { messageId: `om_approval_${++this.#seq}`, deduped: false };
```

with:

```ts
    this.approvalCards.push({ target, spec, uuid });
    return this.#result(`om_approval_${++this.#seq}`, target);
```

In `tests/helpers/channel.ts`, replace:

```ts
    this.boardCards.push({ target, view, uuid });
    return { messageId: `om_board_${++this.#seq}`, deduped: false };
```

with:

```ts
    this.boardCards.push({ target, view, uuid });
    return this.#result(`om_board_${++this.#seq}`, target);
```

- [ ] **Step 3.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1744 passed (1744)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.5: Commit.**

```bash
git add tests/lark-cards.test.ts tests/lark-adapter.test.ts src/channel/types.ts src/channel/lark/adapter.ts tests/helpers/channel.ts
git commit -m "Let a send in a thread reply to its root, a reply open a thread on its message, and a send that must stay in its thread throw rather than move to the chat, and read the thread Lark answers with"
```

---

### Task 4: The chat members port

**Files:**

- Modify: `tests/lark-adapter.test.ts`, `tests/kanban-sink.test.ts`, `src/channel/types.ts`, `src/channel/lark/adapter.ts`, `src/kanban/sink.ts`, `tests/helpers/channel.ts`

`Channel.chatMembers(chatId)` answers `{ unionIds, complete }` (spec §19.3, §19.7). The Lark adapter reads `im.v1.chatMembers.get` with `member_id_type=union_id` and `page_size=100`, page after page, at most `MEMBER_PAGES` (20), so 2,000 members, `complete` false when it stopped there. It reads the whole group rather than stop at one person, as the card poster caches whole groups (Decision 4). A refusal is thrown as a `ChannelError`, and a failure that never reached Lark as `sendError` makes it; nothing is retried here, as the card poster remembers a failure for a minute. `KanbanSink` throws, as a run's session is in no group. The fake channel gets `members` per chat, `incomplete` groups, and `memberLookups`; `failNext('chatMembers', …)` makes one fail.

- [ ] **Step 4.1: Write the tests.**

In `tests/lark-adapter.test.ts`, replace:

```ts
describe('LarkAdapter.sendApprovalCard', () => {
```

with:

```ts
/** A stand-in for Lark's chat members API, answering with each page in turn. */
function membersApi(pages: Array<Error | { code?: number; msg?: string; data?: object }>): { a: LarkAdapter; calls: unknown[] } {
  const calls: unknown[] = [];
  const lark = {
    rawClient: {
      im: {
        v1: {
          chatMembers: {
            get: async (payload: unknown) => {
              calls.push(payload);
              const next = pages.shift() ?? { code: 0, data: { items: [], has_more: false } };
              if (next instanceof Error) throw next;
              return { code: 0, msg: 'ok', ...next };
            },
          },
        },
      },
    },
  } as unknown as LarkChannel;
  return { a: new LarkAdapter({ appId: 'cli_app', appSecret: 'not-a-secret' }, undefined, { lark, sleep: async () => undefined }), calls };
}

describe('LarkAdapter.chatMembers (spec §19.3)', () => {
  it("reads a group's members by union_id, page by page, and at most 20 pages of 100", async () => {
    const two = membersApi([
      { data: { items: [{ member_id: 'on_alice' }, { member_id: 'on_bob' }], has_more: true, page_token: 'p2' } },
      { data: { items: [{ member_id: 'on_carol' }, { member_id: '' }], has_more: false } },
    ]);
    const read = await two.a.chatMembers('oc_team');
    expect([...read.unionIds]).toEqual(['on_alice', 'on_bob', 'on_carol']);
    expect(read.complete).toBe(true);
    expect(two.calls).toEqual([
      { path: { chat_id: 'oc_team' }, params: { member_id_type: 'union_id', page_size: 100 } },
      { path: { chat_id: 'oc_team' }, params: { member_id_type: 'union_id', page_size: 100, page_token: 'p2' } },
    ]);
    const large = membersApi(
      Array.from({ length: 25 }, (_, i) => ({ data: { items: [{ member_id: `on_${i}` }], has_more: true, page_token: `p${i + 1}` } })),
    );
    const big = await large.a.chatMembers('oc_big');
    expect(large.calls).toHaveLength(20);
    expect(big).toMatchObject({ complete: false });
    expect(big.unionIds.size).toBe(20);
  });

  it("throws Lark's refusal, a missing permission among them, and a failure that never reached Lark, without retrying", async () => {
    const scope = membersApi([{ code: 99991672, msg: 'Access denied' }]);
    await expect(scope.a.chatMembers('oc_team')).rejects.toMatchObject({ code: 99991672, retryable: false });
    const down = membersApi([new Error('socket hang up')]);
    await expect(down.a.chatMembers('oc_team')).rejects.toMatchObject({ code: 0, retryable: true });
    expect(down.calls).toHaveLength(1);
  });
});

describe('LarkAdapter.sendApprovalCard', () => {
```

In `tests/kanban-sink.test.ts`, replace:

```ts
    await sink.updateApprovalCard('m', { action: 'a', choice: 'b', answeredBy: 'c' });
  });
```

with:

```ts
    await sink.updateApprovalCard('m', { action: 'a', choice: 'b', answeredBy: 'c' });
    // A run's session is in no group.
    await expect(sink.chatMembers('k_1')).rejects.toThrow('has no members to read');
  });
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/lark-adapter.test.ts tests/kanban-sink.test.ts`. Expected: `Tests  3 failed | 15 passed (18)`: `chatMembers` is not a function on the adapter or the sink.

- [ ] **Step 4.3: Implement.**

In `src/channel/types.ts`, replace:

```ts
/**
 * A send that failed in a way the caller must branch on.
```

with:

```ts
/**
 * A group's members, by union_id (spec §19.3), as far as they were read:
 * `complete` false when the lookup stopped before the last of them.
 */
export interface ChatMembers {
  unionIds: ReadonlySet<string>;
  complete: boolean;
}

/**
 * A send that failed in a way the caller must branch on.
```

In `src/channel/types.ts`, replace:

```ts
  /** Remove the bot's own reaction. A reaction that is not there is not an error. */
  unreact(messageId: string, emoji: string): Promise<void>;
}
```

with:

```ts
  /** Remove the bot's own reaction. A reaction that is not there is not an error. */
  unreact(messageId: string, emoji: string): Promise<void>;

  /**
   * A group's members, by union_id (spec §19.3): whether a person's card can go
   * in a task's thread there. Throws when they cannot be read.
   */
  chatMembers(chatId: string): Promise<ChatMembers>;
}
```

In `src/channel/lark/adapter.ts`, replace:

```ts
  type CardView,
  type Channel,
```

with:

```ts
  type CardView,
  type Channel,
  type ChatMembers,
```

In `src/channel/lark/adapter.ts`, replace:

```ts
/** Lark's code for content it will not take: a post refused so goes as plain text, as the SDK's own send does. */
const INVALID_CONTENT = 230001;
```

with:

```ts
/** Lark's code for content it will not take: a post refused so goes as plain text, as the SDK's own send does. */
const INVALID_CONTENT = 230001;
/** Members in one page of Lark's chat members API, its largest. */
const MEMBER_PAGE_SIZE = 100;
/** Pages of members read at most (spec §19.3): 2,000 members. */
export const MEMBER_PAGES = 20;
```

In `src/channel/lark/adapter.ts`, replace:

```ts
  async unreact(messageId: string, emoji: string): Promise<void> {
```

with:

```ts
  /**
   * A group's members, by union_id (spec §19.3), from Lark's chat members API:
   * its pages read in turn, at most `MEMBER_PAGES` of `MEMBER_PAGE_SIZE`, so
   * 2,000 members, `complete` false when it stopped there. Lark lists no bots,
   * and asks for the bot to be in the group. Not retried: the card poster
   * remembers a failure, and sends a direct message meanwhile.
   */
  async chatMembers(chatId: string): Promise<ChatMembers> {
    const api = this.#lark.rawClient.im.v1.chatMembers;
    const unionIds = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MEMBER_PAGES; page += 1) {
      let r: {
        code?: number | undefined;
        msg?: string | undefined;
        data?:
          | { items?: Array<{ member_id?: string | undefined }> | undefined; page_token?: string | undefined; has_more?: boolean | undefined }
          | undefined;
      };
      try {
        r = await api.get({
          path: { chat_id: chatId },
          params: { member_id_type: 'union_id', page_size: MEMBER_PAGE_SIZE, ...(pageToken === undefined ? {} : { page_token: pageToken }) },
        });
      } catch (err) {
        throw sendError(err);
      }
      if (typeof r.code === 'number' && r.code !== 0) throw toChannelError(r);
      for (const m of r.data?.items ?? []) if (m.member_id !== undefined && m.member_id !== '') unionIds.add(m.member_id);
      const next = r.data?.page_token;
      if (r.data?.has_more !== true || next === undefined || next === '') return { unionIds, complete: true };
      pageToken = next;
    }
    return { unionIds, complete: false };
  }

  async unreact(messageId: string, emoji: string): Promise<void> {
```

In `src/kanban/sink.ts`, replace:

```ts
  CardView,
  Channel,
  SendResult,
```

with:

```ts
  CardView,
  Channel,
  ChatMembers,
  SendResult,
```

In `src/kanban/sink.ts`, replace:

```ts
  async unreact(_messageId: string, _emoji: string): Promise<void> {}
}
```

with:

```ts
  async unreact(_messageId: string, _emoji: string): Promise<void> {}

  /** A run's session is in no group, so it has no members: never asked, as it posts no board card. */
  async chatMembers(_chatId: string): Promise<ChatMembers> {
    throw new Error("a run's session is in no chat, and has no members to read");
  }
}
```

In `tests/helpers/channel.ts`, replace:

```ts
  CardView,
  Channel,
  SendResult,
```

with:

```ts
  CardView,
  Channel,
  ChatMembers,
  SendResult,
```

In `tests/helpers/channel.ts`, replace:

```ts
  | 'react'
  | 'unreact'
  | 'set'
  | 'finish';
```

with:

```ts
  | 'react'
  | 'unreact'
  | 'chatMembers'
  | 'set'
  | 'finish';
```

In `tests/helpers/channel.ts`, replace:

```ts
  readonly boardCards: BoardCardCall[] = [];
  readonly cardUpdates: CardUpdateCall[] = [];
```

with:

```ts
  readonly boardCards: BoardCardCall[] = [];
  readonly cardUpdates: CardUpdateCall[] = [];
  /** Each group's members, by union_id, as Lark's chat members API answers (spec §19.3); a group not here has none. */
  readonly members = new Map<string, readonly string[]>();
  /** Groups whose lookup stops before its last page, as one past 2,000 members does. */
  readonly incomplete = new Set<string>();
  /** The groups whose members were asked for, in order. */
  readonly memberLookups: string[] = [];
```

In `tests/helpers/channel.ts`, replace:

```ts
  async unreact(messageId: string, emoji: string): Promise<void> {
    this.calls.push('unreact');
    await this.gate('unreact');
    this.reactions.push({ op: 'remove', messageId, emoji });
  }
```

with:

```ts
  async unreact(messageId: string, emoji: string): Promise<void> {
    this.calls.push('unreact');
    await this.gate('unreact');
    this.reactions.push({ op: 'remove', messageId, emoji });
  }

  async chatMembers(chatId: string): Promise<ChatMembers> {
    this.calls.push('chatMembers');
    this.memberLookups.push(chatId);
    await this.gate('chatMembers');
    return { unionIds: new Set(this.members.get(chatId) ?? []), complete: !this.incomplete.has(chatId) };
  }
```

- [ ] **Step 4.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1746 passed (1746)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.5: Commit.**

```bash
git add tests/lark-adapter.test.ts tests/kanban-sink.test.ts src/channel/types.ts src/channel/lark/adapter.ts src/kanban/sink.ts tests/helpers/channel.ts
git commit -m "Read a group's members by union_id through Lark's chat members API, at most twenty pages of a hundred, as a port of the channel"
```

---

### Task 5: The root of a thread a command is typed in

**Files:**

- Modify: `tests/lark-inbound.test.ts`, `tests/kanban-chat.test.ts`, `src/types.ts`, `src/channel/lark/inbound.ts`, `src/kanban/chat.ts`

`InboundMessage` gains `rootId` (spec §19.4), from the SDK's normalized `rootId`, Lark's `root_id`, only for a message in a thread: a quoted reply at chat scope has a `root_id` too, which is no thread's. It is never a key: the binding stays on `thread_id`. `KanbanChat` passes it as `createdVia.rootId` for a command typed in a group's thread, and never for a direct message, which §19.1 leaves unchanged, so the task's subscription has its root from its creation (Task 1).

- [ ] **Step 5.1: Write the tests.**

In `tests/lark-inbound.test.ts`, replace:

```ts
import type { CardActionEvent } from '@larksuiteoapi/node-sdk';
```

with:

```ts
import type { CardActionEvent, NormalizedMessage } from '@larksuiteoapi/node-sdk';
```

In `tests/lark-inbound.test.ts`, replace:

```ts
import type { InboundCardAction, Router } from '../src/core/router.js';
```

with:

```ts
import type { InboundCardAction, Router } from '../src/core/router.js';
import type { InboundMessage } from '../src/types.js';
```

In `tests/lark-inbound.test.ts`, replace:

```ts
describe('LarkInbound, on a button press', () => {
```

with:

```ts
describe('LarkInbound, on a message', () => {
  it("gives a message in a thread the thread's root, as Lark's root_id, and one at chat scope none (spec §19.4)", async () => {
    let handlers: { message?: (msg: NormalizedMessage) => Promise<void> } = {};
    const routed: InboundMessage[] = [];
    const adapter = { raw: { on: (h: typeof handlers) => ((handlers = h), () => undefined) }, botOpenId: BOT } as unknown as LarkAdapter;
    const router = { onMessage: async (m: InboundMessage) => void routed.push(m) } as unknown as Router;
    new LarkInbound({ adapter, router, config: { appId: 'cli_app', downloadDir: '/nonexistent' } }).start();
    const msg = (over: Partial<NormalizedMessage>): NormalizedMessage =>
      ({
        messageId: 'om_2',
        chatId: 'oc_team',
        chatType: 'group',
        senderId: 'ou_owner',
        content: '/kanban task list',
        mentionedBot: true,
        mentionAll: false,
        resources: [],
        createTime: 0,
        raw: raw([]),
        ...over,
      }) as unknown as NormalizedMessage;
    await handlers.message?.(msg({ threadId: 'omt_topic', rootId: 'om_root' }));
    // A quoted reply at chat scope has a root_id too: it is no thread's.
    await handlers.message?.(msg({ rootId: 'om_quoted' }));
    expect(routed.map((m) => [m.threadId, m.rootId])).toEqual([
      ['omt_topic', 'om_root'],
      ['', undefined],
    ]);
  });
});

describe('LarkInbound, on a button press', () => {
```

In `tests/kanban-chat.test.ts`, replace:

```ts
  it('makes one task of one message, however often it arrives', async () => {
```

with:

```ts
  it("records the root of the thread a task is created in, from the message, as its subscription's", async () => {
    const taskId = created(await chat.run('task new In the topic', { ...message(OWNER), rootId: 'om_root' }, KEY));
    expect(getTask(t.db, taskId)?.createdVia).toMatchObject({ threadId: 'omt_topic', rootId: 'om_root' });
    expect(subscriptionsOf(t.db, taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_topic', 'om_root']]);
    // A direct message is unchanged (spec §19.1): no root, whatever the message carries.
    const direct = created(await chat.run('task new In a direct message', { ...message(OWNER), chatType: 'p2p', rootId: 'om_root' }, KEY));
    expect(subscriptionsOf(t.db, direct)[0]?.rootMessageId).toBeNull();
  });

  it('makes one task of one message, however often it arrives', async () => {
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/lark-inbound.test.ts tests/kanban-chat.test.ts`. Expected: `Tests  2 failed | 48 passed (50)`: no `rootId` on the message, and no root on the subscription.

- [ ] **Step 5.3: Implement.**

In `src/types.ts`, replace:

```ts
  /** '' for chat scope. Derived from thread_id only. */
  threadId: string;
  sender: Principal;
```

with:

```ts
  /** '' for chat scope. Derived from thread_id only. */
  threadId: string;
  /**
   * In a thread, the thread's root message, from Lark's `root_id`: only where a
   * reply in the thread is sent (spec §19.4), never a key, which is `threadId`'s.
   * Absent at chat scope.
   */
  rootId?: string;
  sender: Principal;
```

In `src/channel/lark/inbound.ts`, replace:

```ts
      threadId: msg.threadId ?? '',
      sender,
```

with:

```ts
      threadId: msg.threadId ?? '',
      // In a thread, its root: where a reply in it is sent (spec §19.4). A quoted
      // reply at chat scope has a root_id too, which is no thread's.
      ...(msg.threadId === undefined || msg.threadId === '' || msg.rootId === undefined || msg.rootId === '' ? {} : { rootId: msg.rootId }),
      sender,
```

In `src/kanban/chat.ts`, replace:

```ts
        conversationId: key.conversationId,
        threadId: key.threadId,
      },
    });
```

with:

```ts
        conversationId: key.conversationId,
        threadId: key.threadId,
        // In a group's thread, its root: where a card and a notice in it reply to (spec §19.4). A direct message has none (§19.1).
        ...(message.chatType !== 'group' || key.threadId === '' || message.rootId === undefined ? {} : { rootId: message.rootId }),
      },
    });
```

- [ ] **Step 5.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1748 passed (1748)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add tests/lark-inbound.test.ts tests/kanban-chat.test.ts src/types.ts src/channel/lark/inbound.ts src/kanban/chat.ts
git commit -m "Give a message in a thread the thread's root from Lark, and record it as the root of a task created there"
```

---

### Task 6: The "Created" reply's two wordings, and the hold

**Files:**

- Create: `tests/kanban-thread-chat.test.ts`
- Modify: `tests/kanban-chat.test.ts`, `tests/kanban-board-chat.test.ts`, `tests/router.test.ts`, `src/core/router.ts`, `src/kanban/chat.ts`

`KanbanCommands.run` answers `{ text, quoted?, thread? }` (spec §19.7). For a fresh task created in a group at chat scope, `KanbanChat` answers in the thread's words (§19.5), with today's words as `quoted` and the task as `thread`; for a task created in a group's thread whose root is known, in the thread's words, with no `thread`; anywhere else, and for an `existing` answer, as today. The task is held from the moment `service.create` returns, synchronously, before the dispatcher is told (`#changed`), until `threaded(taskId, key, messageId, threadId)` moves its subscription, or is told no thread came back, or `holdMs` (`CARD_SEND_MS`) lapses; a move after the lapse still applies. An error rendering the reply after the create releases the hold before it leaves `run`. `held(taskId)` is what the card poster asks (Task 10). The router, for now, reads the answer as before: it sends `quoted ?? text` as today's quoted reply and calls `threaded(…, undefined)`, which ends the hold; Task 7 sends the threaded reply. Every test that read `run`'s answer as text reads `.text`, and the board test whose command is at chat scope in a group expects "This thread hears".

- [ ] **Step 6.1: Write the tests.**

Create `tests/kanban-thread-chat.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import type { BindingKey, InboundMention, InboundMessage, Principal } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { WORKSPACES } from './helpers/kanban.js';

/**
 * `/kanban task new` in a group (spec §19.1, §19.4, §19.5): a fresh task at chat
 * scope is answered for a thread of its own, in both wordings, and held until the
 * router says where its reply went; every other task is answered as before, and
 * held by nothing.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const AT_ALICE: InboundMention = { key: '@_user_1', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' };
const TEAM: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };
const TOPIC: BindingKey = { ...TEAM, threadId: 'omt_topic' };
const HEARS = 'hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.';

let t: TestDb;
let people: PeopleDirectory;
let service: KanbanService;
/** Whether the newest task was held when the dispatcher was told of it, at each time it was. */
let heldAtPass: boolean[];
let seq = 0;

function newest(): string {
  return t.db.prepare<[], { task_id: string }>('SELECT task_id FROM kanban_tasks ORDER BY rowid DESC LIMIT 1').get()?.task_id ?? '';
}

function chat(holdMs?: number): KanbanChat {
  const c: KanbanChat = new KanbanChat({
    service,
    hasTier: () => true,
    people,
    appId: 'cli_app',
    changed: () => heldAtPass.push(c.held(newest())),
    ...(holdMs === undefined ? {} : { holdMs }),
  });
  return c;
}

beforeEach(() => {
  t = testDb();
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, 'ou_alice'] });
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }) });
  service = new KanbanService({ db: t.db, roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])), workspaces: WORKSPACES, people });
  heldAtPass = [];
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
    mentions: [AT_ALICE],
    attachments: [],
    createTime: 0,
    ...over,
  };
}

function idOf(text: string): string {
  const m = /^Created `(k_[0-9a-z]+)`/.exec(text);
  if (m?.[1] === undefined) throw new Error(`not created: ${text}`);
  return m[1];
}

const FOR_ALICE = 'task new Check the links\nassignee: @Alice Smith';

describe("/kanban task new in a group, for a thread of its own", () => {
  it('answers a fresh task at chat scope in the words of its thread, with the quoted words beside them, naming the task', async () => {
    const answer = await chat().run(FOR_ALICE, message(TEAM), TEAM);
    const taskId = idOf(answer.text);
    const head = `Created \`${taskId}\`: **Check the links**, for Alice Smith (lark:on\\_alice).`;
    expect(answer).toEqual({
      text: `${head} Their card comes in this thread when it is ready, or by direct message if they are not in this group. This thread ${HEARS}`,
      quoted: `${head} They are sent it as a card, in a direct message, once it is ready. This chat ${HEARS}`,
      thread: taskId,
    });
  });

  it("answers a task in a thread with a root in the thread's words, and one in a direct message, in a thread with no root, or already created, as before, with no thread", async () => {
    const c = chat();
    const inTopic = await c.run(FOR_ALICE, message(TOPIC, { rootId: 'om_root' }), TOPIC);
    expect(inTopic.text).toContain('Their card comes in this thread when it is ready');
    expect(inTopic).not.toHaveProperty('thread');
    const dm = await c.run(FOR_ALICE, message(TEAM, { chatType: 'p2p' }), TEAM);
    expect(dm).toEqual({ text: expect.stringContaining(`in a direct message, once it is ready. This chat ${HEARS}`) as string });
    const rootless = await c.run(FOR_ALICE, message(TOPIC), TOPIC);
    expect(rootless.text).toContain('They are sent it as a card, in a direct message');
    const again = message(TEAM);
    const first = await c.run(FOR_ALICE, again, TEAM);
    expect(await c.run(FOR_ALICE, again, TEAM)).toEqual({ text: `Already created, as \`${idOf(first.text)}\`.` });
  });
});

describe('the hold on a task whose thread is being made (spec §19.4)', () => {
  it('holds a fresh task from a group at chat scope from before the dispatcher is told of it, until its subscription moves', async () => {
    const c = chat();
    const msg = message(TEAM);
    const answer = await c.run(FOR_ALICE, msg, TEAM);
    const taskId = answer.thread ?? '';
    expect(heldAtPass).toEqual([true]);
    expect(c.held(taskId)).toBe(true);
    c.threaded(taskId, TEAM, msg.messageId, 'omt_new');
    expect(c.held(taskId)).toBe(false);
    expect(subscriptionsOf(t.db, taskId).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_new', msg.messageId]]);
  });

  it('ends the hold when no thread came back, leaving the task at chat scope; lapses by itself; and a move after it lapsed still applies', async () => {
    const c = chat(20);
    const failed = (await c.run(FOR_ALICE, message(TEAM), TEAM)).thread ?? '';
    c.threaded(failed, TEAM, 'om_x', undefined);
    expect(c.held(failed)).toBe(false);
    expect(subscriptionsOf(t.db, failed).map((s) => [s.threadId, s.rootMessageId])).toEqual([['', null]]);
    const msg = message(TEAM);
    const late = (await c.run(FOR_ALICE, msg, TEAM)).thread ?? '';
    expect(c.held(late)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(c.held(late)).toBe(false);
    c.threaded(late, TEAM, msg.messageId, 'omt_late');
    expect(subscriptionsOf(t.db, late).map((s) => [s.threadId, s.rootMessageId])).toEqual([['omt_late', msg.messageId]]);
  });

  it('holds no task that gets no thread: one in a direct message, in a thread, or already created', async () => {
    const c = chat();
    await c.run(FOR_ALICE, message(TEAM, { chatType: 'p2p' }), TEAM);
    await c.run(FOR_ALICE, message(TOPIC, { rootId: 'om_root' }), TOPIC);
    expect(heldAtPass).toEqual([false, false]);
    const again = message(TEAM);
    const taskId = (await c.run(FOR_ALICE, again, TEAM)).thread ?? '';
    c.threaded(taskId, TEAM, again.messageId, undefined);
    expect((await c.run(FOR_ALICE, again, TEAM)).thread).toBeUndefined();
    expect(c.held(taskId)).toBe(false);
  });

  it('ends the hold when the reply cannot be rendered after the create, which stands, at chat scope', async () => {
    const c = chat();
    people.nameOf = () => {
      throw new Error('the people table is locked');
    };
    await expect(c.run(FOR_ALICE, message(TEAM), TEAM)).rejects.toThrow('the people table is locked');
    const taskId = newest();
    expect(heldAtPass).toEqual([true]);
    expect(c.held(taskId)).toBe(false);
    expect(getTask(t.db, taskId)?.title).toBe('Check the links');
    expect(subscriptionsOf(t.db, taskId).map((s) => s.threadId)).toEqual(['']);
  });
});
```

In `tests/kanban-chat.test.ts`, replace:

```ts
function say(arg: string, sender: Principal = OWNER, mentions: InboundMention[] = []): Promise<string> {
  return chat.run(arg, message(sender, undefined, mentions), KEY);
}
```

with:

```ts
async function say(arg: string, sender: Principal = OWNER, mentions: InboundMention[] = []): Promise<string> {
  return (await chat.run(arg, message(sender, undefined, mentions), KEY)).text;
}
```

In `tests/kanban-chat.test.ts`, replace:

```ts
    const taskId = created(await chat.run('task new In the topic', { ...message(OWNER), rootId: 'om_root' }, KEY));
```

with:

```ts
    const taskId = created((await chat.run('task new In the topic', { ...message(OWNER), rootId: 'om_root' }, KEY)).text);
```

In `tests/kanban-chat.test.ts`, replace:

```ts
    const direct = created(await chat.run('task new In a direct message', { ...message(OWNER), chatType: 'p2p', rootId: 'om_root' }, KEY));
```

with:

```ts
    const direct = created((await chat.run('task new In a direct message', { ...message(OWNER), chatType: 'p2p', rootId: 'om_root' }, KEY)).text);
```

In `tests/kanban-chat.test.ts`, replace:

```ts
    const first = created(await chat.run('task new Once', message(OWNER, 'om_same'), KEY));
    expect(await chat.run('task new Once', message(OWNER, 'om_same'), KEY)).toBe(`Already created, as \`${first}\`.`);
```

with:

```ts
    const first = created((await chat.run('task new Once', message(OWNER, 'om_same'), KEY)).text);
    expect((await chat.run('task new Once', message(OWNER, 'om_same'), KEY)).text).toBe(`Already created, as \`${first}\`.`);
```

In `tests/kanban-board-chat.test.ts`, replace:

```ts
function say(arg: string, key: BindingKey = TEAM, sender: Principal = OWNER): Promise<string> {
  return chat.run(arg, message(sender, key), key);
}
```

with:

```ts
async function say(arg: string, key: BindingKey = TEAM, sender: Principal = OWNER): Promise<string> {
  return (await chat.run(arg, message(sender, key), key)).text;
}
```

In `tests/kanban-board-chat.test.ts`, replace:

```ts
    expect(reply).toContain(', in web, on board **web-app**. This chat hears');
```

with:

```ts
    // At chat scope in a group: in the words of the thread its reply opens (spec §19.5).
    expect(reply).toContain(', in web, on board **web-app**. This thread hears');
```

In `tests/router.test.ts`, replace:

```ts
      run: async (arg, message, key) => {
        calls.push({ arg, messageId: message.messageId, key });
        return answer(arg);
      },
      card: async () => answer('card'),
```

with:

```ts
      run: async (arg, message, key) => {
        calls.push({ arg, messageId: message.messageId, key });
        return { text: await answer(arg) };
      },
      threaded: () => undefined,
      card: async () => answer('card'),
```

In `tests/router.test.ts`, replace:

```ts
      kanban: {
        run: async () => 'unused',
        card: async (action) => {
```

with:

```ts
      kanban: {
        run: async () => ({ text: 'unused' }),
        threaded: () => undefined,
        card: async (action) => {
```

In `tests/router.test.ts`, replace:

```ts
      kanban: {
        run: async () => 'unused',
        card: async () => {
```

with:

```ts
      kanban: {
        run: async () => ({ text: 'unused' }),
        threaded: () => undefined,
        card: async () => {
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-thread-chat.test.ts`. Expected: `Tests  6 failed (6)`: `run` answers text, and there is no `held` or `threaded`.

- [ ] **Step 6.3: Implement.**

In `src/core/router.ts`, replace:

```ts
/**
 * The board's chat commands (spec §9.1): what follows `/kanban`, run for the
 * message that typed it, answered as the reply to send; and a press of a board
 * card's button (spec §9.2), answered the same way. `KanbanChat`.
 */
export interface KanbanCommands {
  run(arg: string, message: InboundMessage, key: BindingKey): Promise<string>;
  card(action: InboundCardAction): Promise<string>;
}
```

with:

```ts
/**
 * What `/kanban` answers (spec §19.7): the reply; for a task just created in a
 * group at chat scope, the task, whose reply opens a thread on the command, and
 * the reply's words for a quoted reply, which cannot say "this thread".
 */
export interface KanbanAnswer {
  text: string;
  quoted?: string;
  thread?: string;
}

/**
 * The board's chat commands (spec §9.1): what follows `/kanban`, run for the
 * message that typed it, answered as the reply to send; where that reply went,
 * for a task just created (spec §19.4); and a press of a board card's button
 * (spec §9.2), answered the same way. `KanbanChat`.
 */
export interface KanbanCommands {
  run(arg: string, message: InboundMessage, key: BindingKey): Promise<KanbanAnswer>;
  /**
   * Task `taskId`'s "Created" reply was sent in thread `threadId` on the command
   * message `messageId`, which becomes the thread's root; or, `threadId`
   * undefined, it was not: sent quoted, or failed. Called whenever `run`
   * answered with a `thread`, and it ends the task's hold.
   */
  threaded(taskId: string, key: BindingKey, messageId: string, threadId: string | undefined): void;
  card(action: InboundCardAction): Promise<string>;
}
```

In `src/core/router.ts`, replace:

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
            this.#note(`kanban command in ${message.messageId} failed: ${redactKnownSecrets(detail)}`);
            // One line, masked and cut, as a refusal is: an error can quote anything.
            text = `The board could not do that: ${label(detail, 600)}`;
          }
        }
        // Each piece was escaped, and masked, as it was put in; the whole reply is
        // masked once more, for what was not: ids, names, the board's own words.
        await this.#reply(target, message, 'kanban', redactKnownSecrets(text));
        return;
      }
```

with:

```ts
      case 'kanban': {
        let answer: KanbanAnswer;
        const kanban = this.#deps.kanban;
        if (kanban === undefined) {
          answer = { text: KANBAN_OFF };
        } else {
          try {
            answer = await kanban.run(arg, message, key);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            this.#note(`kanban command in ${message.messageId} failed: ${redactKnownSecrets(detail)}`);
            // One line, masked and cut, as a refusal is: an error can quote anything.
            answer = { text: `The board could not do that: ${label(detail, 600)}` };
          }
        }
        // Each piece was escaped, and masked, as it was put in; the whole reply is
        // masked once more, for what was not: ids, names, the board's own words.
        await this.#reply(target, message, 'kanban', redactKnownSecrets(answer.quoted ?? answer.text));
        if (answer.thread !== undefined) this.#threaded(answer.thread, key, message.messageId, undefined);
        return;
      }
```

In `src/core/router.ts`, replace:

```ts
  // -------------------------------------------------------------------------
  // Card actions
  // -------------------------------------------------------------------------
```

with:

```ts
  /** The board told where a task's "Created" reply went (spec §19.4); its failure is noted, and the hold lapses. */
  #threaded(taskId: string, key: BindingKey, messageId: string, threadId: string | undefined): void {
    try {
      this.#deps.kanban?.threaded(taskId, key, messageId, threadId);
    } catch (err) {
      this.#note(`kanban: where task ${taskId}'s reply went was not recorded: ${redactKnownSecrets(err instanceof Error ? err.message : String(err))}`);
    }
  }

  // -------------------------------------------------------------------------
  // Card actions
  // -------------------------------------------------------------------------
```

In `src/kanban/chat.ts`, replace:

```ts
import type { InboundCardAction } from '../core/router.js';
```

with:

```ts
import type { InboundCardAction, KanbanAnswer } from '../core/router.js';
```

In `src/kanban/chat.ts`, replace:

```ts
import { redactKnownSecrets } from '../secrets.js';
import { personPrincipal, type PeopleDirectory } from './people.js';
```

with:

```ts
import { redactKnownSecrets } from '../secrets.js';
import { CARD_SEND_MS } from './cards.js';
import { personPrincipal, type PeopleDirectory } from './people.js';
```

In `src/kanban/chat.ts`, replace:

```ts
  /** After a change that decided an agent run: the dispatcher cancels its turn and closes it. */
  cancel?: (runId: string) => void;
}
```

with:

```ts
  /** After a change that decided an agent run: the dispatcher cancels its turn and closes it. */
  cancel?: (runId: string) => void;
  /** How long a task is held while its "Created" reply is under way (spec §19.4); `CARD_SEND_MS` unless a test says otherwise. */
  holdMs?: number;
}
```

In `src/kanban/chat.ts`, replace:

```ts
  /** Aborted when the gateway stops: a report's gates are killed, and nothing is applied (spec §7.7). */
  readonly #stopping = new AbortController();
```

with:

```ts
  /** Aborted when the gateway stops: a report's gates are killed, and nothing is applied (spec §7.7). */
  readonly #stopping = new AbortController();
  /** Tasks whose "Created" reply is under way, each until its timer lapses (spec §19.4). Memory only. */
  readonly #holds = new Map<string, NodeJS.Timeout>();
```

In `src/kanban/chat.ts`, replace:

```ts
  /** Run `/kanban <arg>` from this message, bound at `key`; the reply to send. */
  async run(arg: string, message: InboundMessage, key: BindingKey): Promise<string> {
    const parsed = parseKanban(arg);
```

with:

```ts
  /** Run `/kanban <arg>` from this message, bound at `key`; the reply to send, and for a task given a thread, the task. */
  async run(arg: string, message: InboundMessage, key: BindingKey): Promise<KanbanAnswer> {
    const answer = await this.#run(arg, message, key);
    return typeof answer === 'string' ? { text: answer } : answer;
  }

  /**
   * Whether a task is held while its "Created" reply is under way (spec §19.4):
   * the card poster passes over its runs, so its card does not go by direct
   * message in the moment before its subscription moves to its thread.
   */
  held(taskId: string): boolean {
    return this.#holds.has(taskId);
  }

  /**
   * Where a fresh task's "Created" reply went (spec §19.4, §19.7): in thread
   * `threadId`, its subscription moves there, with the command message as its
   * root; with none -- the reply failed, or was sent quoted -- it stays at chat
   * scope. A move that comes after the hold lapsed still applies. The hold ends
   * either way, once the move is written.
   */
  threaded(taskId: string, key: BindingKey, messageId: string, threadId: string | undefined): void {
    try {
      if (threadId === undefined || threadId === '') return;
      const r = this.#deps.service.threadSubscription(taskId, chatAt(key), threadId, messageId);
      if (!r.ok) this.#note(`kanban: task ${taskId} stays at chat scope: its subscription was not moved to thread ${threadId} (${r.code})`);
    } finally {
      this.#release(taskId);
    }
  }

  /** A task held until `threaded`, or `holdMs` at most. */
  #hold(taskId: string): void {
    const timer = setTimeout(() => this.#holds.delete(taskId), this.#deps.holdMs ?? CARD_SEND_MS);
    timer.unref();
    this.#holds.set(taskId, timer);
  }

  #release(taskId: string): void {
    clearTimeout(this.#holds.get(taskId));
    this.#holds.delete(taskId);
  }

  async #run(arg: string, message: InboundMessage, key: BindingKey): Promise<string | KanbanAnswer> {
    const parsed = parseKanban(arg);
```

In `src/kanban/chat.ts`, replace:

```ts
  async #change(command: KanbanCommand, by: string, message: InboundMessage, key: BindingKey): Promise<string> {
```

with:

```ts
  async #change(command: KanbanCommand, by: string, message: InboundMessage, key: BindingKey): Promise<string | KanbanAnswer> {
```

In `src/kanban/chat.ts`, replace:

```ts
  /**
   * `/kanban task new` (spec §9.1): created from this chat, which is subscribed to it.
   * The message id is the idempotency key, so a redelivery that got past the
   * router's own dedup still makes one task.
   */
  #create(command: NewTaskCommand, by: string, message: InboundMessage, key: BindingKey): string {
```

with:

```ts
  /**
   * `/kanban task new` (spec §9.1): created from this chat, which is subscribed to it.
   * The message id is the idempotency key, so a redelivery that got past the
   * router's own dedup still makes one task. A fresh task from a group at chat
   * scope gets a thread of its own, on the command (spec §19.1): it is answered in
   * both wordings, naming it, and held until the router says where its reply went.
   */
  #create(command: NewTaskCommand, by: string, message: InboundMessage, key: BindingKey): string | KanbanAnswer {
```

In `src/kanban/chat.ts`, replace:

```ts
    if (!r.ok) return refused(r);
    const { task } = r;
    if (r.existing) return `Already created, as ${id(task.taskId)}.`;
    this.#changed();
    const whom =
      task.assignee === null
        ? 'nobody yet (`/kanban task assign ' + task.taskId + ' <role or @person>` gives it to someone)'
        : this.#whom(task.assignee);
    const card =
      task.assignee?.kind === 'human' ? ' They are sent it as a card, in a direct message, once it is ready.' : '';
    return (
      `Created ${id(task.taskId)}: **${label(task.title)}**, for ${whom}` +
      `${task.workspace === null ? '' : `, in ${label(task.workspace)}`}` +
      `${task.board === DEFAULT_BOARD ? '' : `, on board ${boardName(task.board)}`}.${card} ` +
      'This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.'
    );
  }
```

with:

```ts
    if (!r.ok) return refused(r);
    const { task } = r;
    if (r.existing) return `Already created, as ${id(task.taskId)}.`;
    // Held from here, with no await before it, so the dispatcher's pass below, and
    // the card poster, find it held (spec §19.4).
    const thread = message.chatType === 'group' && key.threadId === '';
    if (thread) this.#hold(task.taskId);
    try {
      this.#changed();
      if (thread) return { text: this.#created(task, 'thread'), quoted: this.#created(task, 'chat'), thread: task.taskId };
      // In a thread whose root is known, its card can come there too.
      return this.#created(task, message.chatType === 'group' && key.threadId !== '' && message.rootId !== undefined ? 'thread' : 'chat');
    } catch (err) {
      // The task stands, at chat scope, as one whose reply failed: no hold to wait out.
      if (thread) this.#release(task.taskId);
      throw err;
    }
  }

  /**
   * The "Created" reply (spec §19.5): in the words of a thread the task's card can
   * come to, or in words true anywhere: a direct message, a quoted reply, or a
   * thread with no root.
   */
  #created(task: TaskRow, where: 'thread' | 'chat'): string {
    const whom =
      task.assignee === null
        ? 'nobody yet (`/kanban task assign ' + task.taskId + ' <role or @person>` gives it to someone)'
        : this.#whom(task.assignee);
    const card =
      task.assignee?.kind !== 'human'
        ? ''
        : where === 'thread'
          ? ' Their card comes in this thread when it is ready, or by direct message if they are not in this group.'
          : ' They are sent it as a card, in a direct message, once it is ready.';
    return (
      `Created ${id(task.taskId)}: **${label(task.title)}**, for ${whom}` +
      `${task.workspace === null ? '' : `, in ${label(task.workspace)}`}` +
      `${task.board === DEFAULT_BOARD ? '' : `, on board ${boardName(task.board)}`}.${card} ` +
      `${where === 'thread' ? 'This thread' : 'This chat'} hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.`
    );
  }
```

- [ ] **Step 6.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1754 passed (1754)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.5: Commit.**

```bash
git add tests/kanban-thread-chat.test.ts tests/kanban-chat.test.ts tests/kanban-board-chat.test.ts tests/router.test.ts src/core/router.ts src/kanban/chat.ts
git commit -m "Answer a task created in a group at chat scope in the words of its thread and in quoted words, and hold it from its creation until the router says where its reply went"
```

---

### Task 7: The router's threaded "Created" reply

**Files:**

- Modify: `tests/router.test.ts`, `src/core/router.ts`

For a group message at chat scope whose answer names a `thread`, the router sends `text` as a reply on the command with `replyInThread` and `stayInThread`, with the reply's usual uuid (spec §19.4, §19.7). Lark's `thread_id` in the answer goes to `threaded`. A refusal (a `ChannelError` with a nonzero code, not retryable: 230071, 230072, a withdrawn command's 230011, 230017 or HTTP 404, any other) sends `quoted` at once as today's quoted reply, with the same uuid, which may itself take the adapter's withdrawn fallback; a failure that never reached Lark, retried by the adapter and given up, sends nothing more, as any reply is given up. An answer with no `thread_id` leaves the task at chat scope. Whatever happened, `threaded` is called, with the thread or with none, so the hold always ends; a `threaded` that throws is noted.

- [ ] **Step 7.1: Write the tests.**

In `tests/router.test.ts`, replace:

```ts
import { CARD_COALESCE_MS } from '../src/channel/card-writer.js';
```

with:

```ts
import { CARD_COALESCE_MS } from '../src/channel/card-writer.js';
import { ChannelError } from '../src/channel/types.js';
```

In `tests/router.test.ts`, replace:

```ts
  it('says the board is off when kanban.enabled is not set, and opens no session', async () => {
```

with:

```ts
  /** A board that creates task `k_1` for a thread of its own (spec §19.7), and records where the router says its reply went. */
  function creating(): KanbanCommands & { threads: Array<[string, BindingKey, string, string | undefined]> } {
    const threads: Array<[string, BindingKey, string, string | undefined]> = [];
    return {
      threads,
      run: async () => ({ text: 'Created `k_1`. This thread hears sk-thread-12345678', quoted: 'Created `k_1`. This chat hears', thread: 'k_1' }),
      threaded: (taskId, key, messageId, threadId) => void threads.push([taskId, key, messageId, threadId]),
      card: async () => 'unused',
    };
  }
  const inGroup = (): InboundMessage => msg({ chatType: 'group', mentionedBot: true, text: '/kanban task new Check the links' });
  const KEY: BindingKey = { channel: CHANNEL, appId: APP, conversationId: CHAT, threadId: '' };

  it("answers a fresh task from a group at chat scope in a thread on the command, staying there, and tells the board the thread", async () => {
    addSecrets(['sk-thread-12345678']);
    const kanban = creating();
    const h = harness({ kanban });
    const message = inGroup();
    await h.router.onMessage(message);
    expect(h.channel.texts).toEqual([
      {
        target: { chatId: CHAT, threadId: '', replyTo: message.messageId, replyInThread: true, stayInThread: true },
        text: `Created \`k_1\`. This thread hears ${MASK}`,
        uuid: replyUuid(APP, message.messageId, 'kanban'),
      },
    ]);
    expect(kanban.threads).toEqual([['k_1', KEY, message.messageId, `omt_${message.messageId}`]]);
  });

  it('sends the quoted words, with the same uuid, when Lark refuses the thread: 230071, a withdrawn command, 230017 or an HTTP 404', async () => {
    for (const code of [230071, 230011, 230017, 404]) {
      const kanban = creating();
      const h = harness({ kanban });
      const message = inGroup();
      h.channel.failNext('sendText', new ChannelError(code, `refused ${code}`, false));
      await h.router.onMessage(message);
      expect(h.channel.texts).toEqual([
        { target: { chatId: CHAT, threadId: '', replyTo: message.messageId }, text: 'Created `k_1`. This chat hears', uuid: replyUuid(APP, message.messageId, 'kanban') },
      ]);
      expect(kanban.threads).toEqual([['k_1', KEY, message.messageId, undefined]]);
    }
  });

  it('leaves the task at chat scope when the reply never reached Lark, or came back with no thread', async () => {
    const lost = creating();
    const h = harness({ kanban: lost });
    h.channel.failNext('sendText', new ChannelError(0, 'socket hang up', true));
    const first = inGroup();
    await h.router.onMessage(first);
    // Given up, as any reply is: nothing quoted after it.
    expect(h.channel.texts).toEqual([]);
    expect(lost.threads).toEqual([['k_1', KEY, first.messageId, undefined]]);
    expect(h.notes.some((n) => n.startsWith('reply (kanban) failed'))).toBe(true);
    const unthreaded = creating();
    const g = harness({ kanban: unthreaded });
    g.channel.replyThreads = false;
    const second = inGroup();
    await g.router.onMessage(second);
    expect(g.channel.texts.map((m) => m.target.replyInThread)).toEqual([true]);
    expect(unthreaded.threads).toEqual([['k_1', KEY, second.messageId, undefined]]);
    expect(g.notes).toContain(`kanban: the reply to ${second.messageId} came back with no thread; task k_1 stays at chat scope`);
  });

  it('answers a fresh task anyway when the board cannot record where its reply went, and notes it', async () => {
    const kanban = creating();
    kanban.threaded = () => {
      throw new Error('database_locked');
    };
    const h = harness({ kanban });
    await h.router.onMessage(inGroup());
    expect(h.channel.texts).toHaveLength(1);
    expect(h.notes).toContain("kanban: where task k_1's reply went was not recorded: database_locked");
  });

  it('says the board is off when kanban.enabled is not set, and opens no session', async () => {
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/router.test.ts`. Expected: `Tests  3 failed | 76 passed (79)`: the reply goes quoted. The fourth new test, a `threaded` that throws, passes already: Task 6 notes it.

- [ ] **Step 7.3: Implement.**

In `src/core/router.ts`, replace:

```ts
import type { Channel, SendTarget } from '../channel/types.js';
```

with:

```ts
import { ChannelError, type Channel, type SendTarget } from '../channel/types.js';
```

In `src/core/router.ts`, replace:

```ts
        // Each piece was escaped, and masked, as it was put in; the whole reply is
        // masked once more, for what was not: ids, names, the board's own words.
        await this.#reply(target, message, 'kanban', redactKnownSecrets(answer.quoted ?? answer.text));
        if (answer.thread !== undefined) this.#threaded(answer.thread, key, message.messageId, undefined);
        return;
      }
```

with:

```ts
        if (answer.thread !== undefined && message.chatType === 'group' && message.threadId === '') {
          await this.#createdInThread(answer, answer.thread, message, key, target);
          return;
        }
        // Each piece was escaped, and masked, as it was put in; the whole reply is
        // masked once more, for what was not: ids, names, the board's own words.
        await this.#reply(target, message, 'kanban', redactKnownSecrets(answer.quoted ?? answer.text));
        if (answer.thread !== undefined) this.#threaded(answer.thread, key, message.messageId, undefined);
        return;
      }
```

In `src/core/router.ts`, replace:

```ts
  /** The board told where a task's "Created" reply went (spec §19.4); its failure is noted, and the hold lapses. */
```

with:

```ts
  /**
   * A fresh task's "Created" reply, in a thread of its own on the command message
   * (spec §19.4, §19.7): sent with `reply_in_thread`, and staying in its thread,
   * so that a withdrawn command is not answered at the top of the chat in the
   * thread's words. Refused by Lark -- 230071, a withdrawn command, any refusal --
   * it is sent again at once as a quoted reply, in words true there, with the same
   * uuid; one that never reached Lark, retried by the adapter, is given up, as any
   * reply is. Whatever came of it, the board is told where it went, which ends
   * the task's hold.
   */
  async #createdInThread(
    answer: KanbanAnswer,
    taskId: string,
    message: InboundMessage,
    key: BindingKey,
    target: SendTarget,
  ): Promise<void> {
    let threadId: string | undefined;
    try {
      const sent = await this.#deps.channel.sendText(
        { chatId: message.chatId, threadId: '', replyTo: message.messageId, replyInThread: true, stayInThread: true },
        truncate(redactKnownSecrets(answer.text), 4000),
        replyUuid(this.#deps.appId, message.messageId, 'kanban'),
      );
      threadId = sent.threadId;
      if (threadId === undefined) this.#note(`kanban: the reply to ${message.messageId} came back with no thread; task ${taskId} stays at chat scope`);
    } catch (err) {
      const refused = err instanceof ChannelError && err.code !== 0 && !err.retryable;
      this.#note(`reply (kanban) failed: ${err instanceof Error ? err.message : String(err)}${refused ? '; sending it quoted' : ''}`);
      if (refused) await this.#reply(target, message, 'kanban', redactKnownSecrets(answer.quoted ?? answer.text));
    } finally {
      this.#threaded(taskId, key, message.messageId, threadId);
    }
  }

  /** The board told where a task's "Created" reply went (spec §19.4); its failure is noted, and the hold lapses. */
```

- [ ] **Step 7.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1758 passed (1758)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.5: Commit.**

```bash
git add tests/router.test.ts src/core/router.ts
git commit -m "Send a fresh task's reply in a thread on its command, staying there, send the quoted words when Lark refuses it, and tell the board where it went"
```

---

### Task 8: The mention

**Files:**

- Modify: `tests/kanban-chat-render.test.ts`, `tests/kanban-chat.test.ts`, `src/kanban/chat-render.ts`

`CardFacts.mention`, an open_id, starts a task or review card with `<at id=ou_…></at>` (spec §19.2), put in by the renderer after the line was escaped and masked, so an `<at` in task text is still escaped. Anything not shaped `ou_…` mentions nobody. A redraw is rendered with no `mention`, so it notifies nobody; the chat test that checks a live redraw says so.

- [ ] **Step 8.1: Write the tests.**

In `tests/kanban-chat-render.test.ts`, replace:

```ts
  it('redraws a card acted on with what happened, and no buttons', () => {
```

with:

```ts
  it('starts a card with a mention of its person by open_id, put in after the escaping, and none for anything that is not one', () => {
    const k = newTask(h.db, { title: `Check the links ${SPOOF}`, assignee: { kind: 'human', name: ALICE }, reviewer: { kind: 'human', name: ALICE } });
    const run = claimed(h.db, k.taskId);
    const facts = { task: task(k.taskId), run, parents: [] };
    const card = renderTaskCard({ ...facts, mention: 'ou_alice' }, 'cli_app');
    expect(card.markdown.startsWith(`<at id=ou_alice></at> 📋 For you to do: **Check the links hi \\<at id=all\\>\\</at\\> team**`)).toBe(true);
    expect(renderReviewCard({ ...facts, mention: 'ou_alice' }, 'cli_app').markdown.startsWith('<at id=ou_alice></at> 🔎 For you to review: ')).toBe(true);
    // Only an open_id: anything else, an `<at` of its own included, mentions nobody.
    for (const mention of ['on_alice', 'ou_x></at><at id=all', '']) {
      expect(renderTaskCard({ ...facts, mention }, 'cli_app').markdown.startsWith('📋 For you to do: ')).toBe(true);
    }
    // No open_id given, as for a direct message and every redraw: no mention.
    expect(renderTaskCard(facts, 'cli_app').markdown).not.toContain('<at id=ou_');
  });

  it('redraws a card acted on with what happened, and no buttons', () => {
```

In `tests/kanban-chat.test.ts`, replace:

```ts
    expect(first?.markdown).toContain('**Not done.** Type why it is blocked in the box, then press Block.');
```

with:

```ts
    expect(first?.markdown).toContain('**Not done.** Type why it is blocked in the box, then press Block.');
    // A redraw mentions nobody: the person was told when the card was sent (spec §19.2).
    expect(first?.markdown).not.toContain('<at id=');
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-chat-render.test.ts tests/kanban-chat.test.ts`. Expected: `Tests  1 failed | 67 passed (68)`: no mention.

- [ ] **Step 8.3: Implement.**

In `src/kanban/chat-render.ts`, replace:

```ts
  /** Why the last press did nothing, shown under the title, already escaped. */
  note?: string;
}
```

with:

```ts
  /** Why the last press did nothing, shown under the title, already escaped. */
  note?: string;
  /**
   * The person's open_id, for a card sent in a task's thread (spec §19.2): the
   * card starts with an @-mention of them. Absent for a direct message, and for
   * every redraw, which would notify them of their own press.
   */
  mention?: string;
}

/** An open_id, as Lark gives one: the only thing a card mentions anyone by. */
const OPEN_ID = /^ou_[0-9A-Za-z]+$/;

/**
 * A card's first line, after an @-mention of its person when it has one (spec
 * §19.2), as Lark's markdown writes one. Put in after the line was escaped and
 * masked, so an `<at` in task text is still escaped, and only this one, made
 * from an id the gateway holds, mentions anyone.
 */
function mentioning(f: CardFacts, line: string): string {
  return f.mention !== undefined && OPEN_ID.test(f.mention) ? `<at id=${f.mention}></at> ${line}` : line;
}
```

In `src/kanban/chat-render.ts`, replace:

```ts
  const out = [`📋 For you to do: **${label(task.title)}** ${id(task.taskId)}`];
```

with:

```ts
  const out = [mentioning(f, `📋 For you to do: **${label(task.title)}** ${id(task.taskId)}`)];
```

In `src/kanban/chat-render.ts`, replace:

```ts
  const out = [`🔎 For you to review: **${label(task.title)}** ${id(task.taskId)}`];
```

with:

```ts
  const out = [mentioning(f, `🔎 For you to review: **${label(task.title)}** ${id(task.taskId)}`)];
```

- [ ] **Step 8.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1759 passed (1759)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.5: Commit.**

```bash
git add tests/kanban-chat-render.test.ts tests/kanban-chat.test.ts src/kanban/chat-render.ts
git commit -m "Start a card sent in a thread with a mention of its person by open_id, put in after the escaping, and mention nobody on a redraw"
```

---

### Task 9: Who is in a group

**Files:**

- Create: `tests/kanban-members.test.ts`, `src/kanban/members.ts`

`Membership` (`src/kanban/members.ts`), the card poster's (spec §19.3): `isMember(chatId, unionId)` asks the channel's `chatMembers` once for a group, keyed on the bot and the group, and answers from it for `MEMBERS_MS` (five minutes), at most `MEMBERS_CHATS` (256) groups, in a `BoundedMap`. A lookup that fails, or outlasts `timeoutMs` (`CARD_SEND_MS`), is remembered `MEMBERS_FAILED_MS` (one minute) in a second `BoundedMap`, as the first has one time to live, and meanwhile the person is taken as no member, so the card goes by direct message. Lark's 99991672 logs `NO_MEMBERS_SCOPE` once per boot; any other failure logs a line naming the chat and Lark's error, masked, each time it is remembered afresh. A person not among the members read of a group past 2,000 is no member.

- [ ] **Step 9.1: Write the tests.**

Create `tests/kanban-members.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelError } from '../src/channel/types.js';
import { MEMBERS_FAILED_MS, MEMBERS_MS, Membership, NO_MEMBERS_SCOPE } from '../src/kanban/members.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock } from './helpers/db.js';

/**
 * Who is a member of a group (spec §19.3): Lark's chat members API, asked once
 * for a group and trusted five minutes, a failure remembered one minute, a
 * missing permission said once, and a lookup bounded in time.
 */

let clock: ManualClock;
let lark: FakeChannel;
let notes: string[];

beforeEach(() => {
  clock = new ManualClock();
  lark = new FakeChannel({ id: 'lark', clock });
  lark.members.set('oc_team', ['on_alice', 'on_bob']);
  lark.members.set('oc_other', ['on_carol']);
  notes = [];
});

function membership(timeoutMs = 30_000): Membership {
  return new Membership({ channel: lark, appId: 'cli_app', clock, timeoutMs, note: (line) => notes.push(line) });
}

describe('Membership', () => {
  it('asks Lark once for a group, and answers every person in it from that for five minutes', async () => {
    const m = membership();
    expect(await m.isMember('oc_team', 'on_alice')).toBe(true);
    expect(await m.isMember('oc_team', 'on_carol')).toBe(false);
    expect(await m.isMember('oc_other', 'on_carol')).toBe(true);
    expect(lark.memberLookups).toEqual(['oc_team', 'oc_other']);
    clock.advance(MEMBERS_MS - 1);
    lark.members.set('oc_team', ['on_alice', 'on_bob', 'on_carol']);
    expect(await m.isMember('oc_team', 'on_carol')).toBe(false);
    // Added to the group: their cards come there within five minutes.
    clock.advance(1);
    expect(await m.isMember('oc_team', 'on_carol')).toBe(true);
    expect(lark.memberLookups).toEqual(['oc_team', 'oc_other', 'oc_team']);
  });

  it('takes a person not among the members it could read of a large group as no member', async () => {
    lark.incomplete.add('oc_team');
    const m = membership();
    expect(await m.isMember('oc_team', 'on_alice')).toBe(true);
    expect(await m.isMember('oc_team', 'on_dan')).toBe(false);
  });

  it('remembers a failed lookup for one minute, and says once per boot that the app lacks the permission', async () => {
    const m = membership();
    lark.failNext('chatMembers', new ChannelError(99991672, 'Access denied', false));
    expect(await m.isMember('oc_team', 'on_alice')).toBe(false);
    clock.advance(MEMBERS_FAILED_MS - 1);
    expect(await m.isMember('oc_team', 'on_alice')).toBe(false);
    expect(lark.memberLookups).toEqual(['oc_team']);
    clock.advance(1);
    lark.failNext('chatMembers', new ChannelError(99991672, 'Access denied', false));
    expect(await m.isMember('oc_team', 'on_alice')).toBe(false);
    expect(lark.memberLookups).toEqual(['oc_team', 'oc_team']);
    expect(notes).toEqual([NO_MEMBERS_SCOPE]);
    // Any other failure is said with its reason, by ids only.
    lark.failNext('chatMembers', new ChannelError(500, 'internal error', true));
    expect(await m.isMember('oc_other', 'on_carol')).toBe(false);
    expect(notes.at(-1)).toBe('kanban: the members of chat oc_other could not be read (internal error (code 500)); its cards go by direct message for a minute');
    clock.advance(MEMBERS_FAILED_MS);
    expect(await m.isMember('oc_team', 'on_alice')).toBe(true);
  });

  it('takes a lookup that outlasts its time for a failed one', async () => {
    const m = membership(20);
    lark.hold();
    expect(await m.isMember('oc_team', 'on_alice')).toBe(false);
    expect(notes).toEqual(['kanban: the members of chat oc_team could not be read (the lookup took longer than 20 ms); its cards go by direct message for a minute']);
    lark.release();
    expect(await m.isMember('oc_team', 'on_alice')).toBe(false);
    expect(lark.memberLookups).toEqual(['oc_team']);
  });
});
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-members.test.ts`. Expected: `Tests  no tests`, with `Cannot find module '../src/kanban/members.js'`.

- [ ] **Step 9.3: Implement.**

Create `src/kanban/members.ts`:

```ts
import { ChannelError, type Channel, type ChatMembers } from '../channel/types.js';
import { BoundedMap } from '../core/bounded-map.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';

/**
 * Who is a member of a group (spec §19.3), for the card poster: whether a
 * person's card can go in a task's thread there.
 *
 * **From Lark's chat members API**, the channel's `chatMembers`: a whole group
 * read at once, so one lookup serves every card in it, kept `MEMBERS_MS` per bot
 * and group, at most `MEMBERS_CHATS` groups. A person added to a group gets their
 * cards there within five minutes; one who left may get one there within five.
 *
 * **A lookup that failed**, Lark refusing, or past `timeoutMs`, is remembered
 * `MEMBERS_FAILED_MS`, and meanwhile the group's members are taken as unknown, so
 * every card goes by direct message, as before there were threads. A missing
 * permission is said once per boot; any other failure each time it is
 * remembered afresh, by ids only. Memory only: a restart asks again.
 */

/** How long a group's members are trusted. */
export const MEMBERS_MS = 5 * 60_000;
/** How long a failed lookup is remembered, so a missing permission is not asked of Lark at every card round. */
export const MEMBERS_FAILED_MS = 60_000;
/** Groups remembered at most. */
export const MEMBERS_CHATS = 256;
/** Lark's code for an app without the permission an API needs: taken as this, to be confirmed by the smoke checklist. */
export const NO_PERMISSION = 99991672;
/** Said once per boot, at the first lookup Lark refuses for a missing permission. */
export const NO_MEMBERS_SCOPE =
  "kanban: cards go by direct message: the app lacks im:chat.members:read, which Lark's chat members API needs";

export interface MembershipDeps {
  /** The channel the cards go by: its `chatMembers`. */
  channel: Channel;
  /** This bot: a group's members are its own to ask about. */
  appId: string;
  /** The longest a whole lookup, every page, is waited for: the card poster's `CARD_SEND_MS`. */
  timeoutMs: number;
  clock?: Clock;
  /** Metadata only: ids, and Lark's error, masked. */
  note?: (line: string) => void;
}

export class Membership {
  readonly #deps: MembershipDeps;
  readonly #members: BoundedMap<string, ChatMembers>;
  readonly #failed: BoundedMap<string, true>;
  #scopeSaid = false;

  constructor(deps: MembershipDeps) {
    this.#deps = deps;
    const clock = deps.clock ?? systemClock;
    this.#members = new BoundedMap({ ttlMs: MEMBERS_MS, maxEntries: MEMBERS_CHATS }, clock);
    this.#failed = new BoundedMap({ ttlMs: MEMBERS_FAILED_MS, maxEntries: MEMBERS_CHATS }, clock);
  }

  /**
   * Whether the person is a member of the group, as far as Lark said: false when
   * they are not among the members read, and when the members could not be read.
   * Never rejects.
   */
  async isMember(chatId: string, unionId: string): Promise<boolean> {
    const key = `${this.#deps.appId}\u0000${chatId}`;
    if (this.#failed.has(key)) return false;
    let members = this.#members.get(key);
    if (members === undefined) {
      try {
        members = await this.#bounded(this.#deps.channel.chatMembers(chatId));
      } catch (err) {
        this.#failed.set(key, true);
        this.#said(chatId, err);
        return false;
      }
      this.#members.set(key, members);
    }
    return members.unionIds.has(unionId);
  }

  #said(chatId: string, err: unknown): void {
    let line: string;
    if (err instanceof ChannelError && err.code === NO_PERMISSION) {
      if (this.#scopeSaid) return;
      this.#scopeSaid = true;
      line = NO_MEMBERS_SCOPE;
    } else {
      const why = redactKnownSecrets(err instanceof Error ? err.message : String(err));
      line = `kanban: the members of chat ${chatId} could not be read (${why}); its cards go by direct message for a minute`;
    }
    try {
      this.#deps.note?.(line);
    } catch {
      // Nowhere left to say it.
    }
  }

  /** A lookup, waited for at most `timeoutMs`: one that outlasts it is a failed lookup. */
  async #bounded<T>(lookup: Promise<T>): Promise<T> {
    const ms = this.#deps.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      const took = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
      timer = setTimeout(() => reject(new Error(`the lookup took longer than ${took}`)), ms);
    });
    try {
      return await Promise.race([lookup, late]);
    } finally {
      clearTimeout(timer);
      lookup.catch(() => undefined);
    }
  }
}
```

- [ ] **Step 9.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1763 passed (1763)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.5: Commit.**

```bash
git add tests/kanban-members.test.ts src/kanban/members.ts
git commit -m "Know who is in a group from Lark, for five minutes, a failed lookup remembered for one, bounded in time, and say once when the app lacks the permission"
```

---

### Task 10: Where a card goes

**Files:**

- Create: `tests/kanban-thread-cards.test.ts`
- Modify: `tests/helpers/channel.ts`, `tests/kanban-people-reports.test.ts`, `src/db/kanban.ts`, `src/kanban/cards.ts`

The card poster routes each run's card at each try (spec §19.2): it asks `held(taskId)` first, and passes over a held task's run silently; it finds the task's thread from `subscriptionsOf(taskId)`, this bot's subscription on its channel, when it is in a thread with a root; and it sends to the thread when `Membership` says the person is in the group (rule 1), with the mention by the open_id the `people` table holds for this bot's app, else by direct message, unmentioned (rule 2). A direct message refused with a code of `PERSON_UNREACHABLE_CODES` goes to the thread when there is one (rule 3); refused there too, it is recorded `card_failed` with both reasons, never sent back by direct message. A card refused in the thread with any nonzero, non-retryable code goes by direct message (rule 4); refused there too, never back to the thread: 230013 records `card_failed` with both reasons, `<the thread's>; and by direct message: <the direct message's>`, anything else is held back. A failure that never reached Lark, one Lark marks retryable, and a timeout are held back, and the next try routes afresh (rule 5). One uuid per run, wherever it goes. `card_sent` records `in`, `thread` exactly when Lark's answer carries a thread, so `CardOutcome` gains `in`. The fake channel gains `answerNext`, for an answer Lark deduplicated.

- [ ] **Step 10.1: Write the tests.**

Create `tests/kanban-thread-cards.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelError, type SendTarget } from '../src/channel/types.js';
import { boardCardUuid } from '../src/core/ids.js';
import { eventsOf } from '../src/db/kanban-read.js';
import { notePerson } from '../src/db/people.js';
import { CardPoster } from '../src/kanban/cards.js';
import { MEMBERS_MS } from '../src/kanban/members.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, RunRow, TaskRow } from '../src/kanban/types.js';
import { clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * Where a person's card goes (spec §19.2): in its task's thread for a member of
 * the group, mentioning them; by direct message otherwise; a direct message that
 * cannot reach them to the thread; a card refused in the thread by direct
 * message, never at the top of the chat; routed afresh at each try; recorded
 * where Lark says it went; and a held task's card kept back.
 */

const ALICE = 'lark:on_alice';
const BOB = 'lark:on_bob';
const TOPIC: CreatedVia = { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' };
const THREAD: SendTarget = { chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root', stayInThread: true };
const dm = (unionId: string): SendTarget => ({ chatId: unionId, threadId: '', receiveIdType: 'union_id' });

let t: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;
let notes: string[];
let held: Set<string>;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  clock = new ManualClock();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock,
    people: { canTalk: (p) => p === ALICE || p === BOB },
  });
  lark = new FakeChannel({ id: 'lark', clock });
  lark.members.set('oc_team', ['on_alice', 'on_owner']);
  // Alice was mentioned in a command, so her open_id for this bot is known; Bob's is not.
  notePerson(t.db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice', name: 'Alice' }, clock.now());
  notes = [];
  held = new Set();
});
afterEach(() => t.close());

function poster(opts: { sendTimeoutMs?: number } = {}): CardPoster {
  return new CardPoster({
    db: t.db,
    service,
    channel: lark,
    appId: 'cli_app',
    clock,
    note: (line) => notes.push(line),
    held: (taskId) => held.has(taskId),
    ...opts,
  });
}

function ready(assignee = ALICE, createdVia: CreatedVia = TOPIC, title = 'Check the links'): { task: TaskRow; run: RunRow } {
  const r = service.create({ title, assignee, createdBy: ALICE, createdVia });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  const c = service.claim(r.task.taskId);
  if (!c.ok) throw new Error(`${c.code}: ${c.message}`);
  return { task: r.task, run: c.run };
}

function sentPayload(taskId: string): unknown {
  return eventsOf(t.db, taskId).find((e) => e.kind === 'card_sent')?.payload;
}

describe("a person's card, for a task with a thread", () => {
  it("goes in the thread for a member, replying to its root, mentioning them by this bot's open_id, and is recorded there", async () => {
    const { task, run } = ready();
    expect(await poster().deliver()).toBe(1);
    expect(lark.boardCards.map((c) => c.target)).toEqual([THREAD]);
    expect(lark.boardCards[0]?.uuid).toBe(boardCardUuid('cli_app', run.runId));
    expect(lark.boardCards[0]?.view.markdown.startsWith(`<at id=ou_alice></at> 📋 For you to do: **Check the links** \`${task.taskId}\``)).toBe(true);
    expect(sentPayload(task.taskId)).toEqual({ kind: 'work', to: ALICE, messageId: 'om_board_1', in: 'thread' });
    expect(lark.memberLookups).toEqual(['oc_team']);
  });

  it('goes by direct message, unmentioned, to a person not a member, and to anyone when the lookup failed or could not finish', async () => {
    const outside = ready(BOB);
    const p = poster();
    await p.deliver();
    expect(lark.boardCards.map((c) => c.target)).toEqual([dm('on_bob')]);
    expect(lark.boardCards[0]?.view.markdown.startsWith('📋 For you to do: ')).toBe(true);
    expect(sentPayload(outside.task.taskId)).toMatchObject({ in: 'dm' });
    // A new poster, a new boot: the lookup fails.
    lark.failNext('chatMembers', new ChannelError(99991672, 'Access denied', false));
    const failed = ready(ALICE, TOPIC, 'Lookup failed');
    await poster().deliver();
    expect(lark.boardCards.at(-1)?.target).toEqual(dm('on_alice'));
    expect(sentPayload(failed.task.taskId)).toMatchObject({ in: 'dm' });
    // A group past what is read, with Alice not among those read.
    lark.members.set('oc_team', ['on_owner']);
    lark.incomplete.add('oc_team');
    ready(ALICE, TOPIC, 'Large group');
    await poster().deliver();
    expect(lark.boardCards.at(-1)?.target).toEqual(dm('on_alice'));
  });

  it("names a member in plain text, with no mention, when no open_id of theirs is noted", async () => {
    lark.members.set('oc_team', ['on_bob']);
    ready(BOB);
    await poster().deliver();
    expect(lark.boardCards.map((c) => c.target)).toEqual([THREAD]);
    expect(lark.boardCards[0]?.view.markdown).not.toContain('<at id=');
  });

  it('goes to the thread when a direct message cannot reach the person, and is recorded as failed only when there is no thread', async () => {
    const reached = ready(BOB);
    lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    await poster().deliver();
    expect(lark.boardCards.map((c) => c.target)).toEqual([THREAD]);
    expect(sentPayload(reached.task.taskId)).toMatchObject({ in: 'thread' });
    // No thread: card_failed, as before.
    const nowhere = ready(BOB, VIA, 'At chat scope');
    lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    await poster().deliver();
    expect(eventsOf(t.db, nowhere.task.taskId).at(-1)).toMatchObject({ kind: 'card_failed', payload: { error: 'Bot has NO availability to this user (code 230013)' } });
    // Refused in the thread too: never back to the direct message, and failed.
    const neither = ready(BOB, TOPIC, 'Refused twice');
    lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    lark.failNext('sendCard', new ChannelError(232009, 'chat dissolved', false));
    const sends = lark.calls.filter((c) => c === 'sendCard').length;
    await poster().deliver();
    expect(lark.calls.filter((c) => c === 'sendCard').length - sends).toBe(2);
    expect(eventsOf(t.db, neither.task.taskId).at(-1)).toMatchObject({
      kind: 'card_failed',
      payload: { error: "Bot has NO availability to this user (code 230013); and in the task's thread: chat dissolved (code 232009)" },
    });
  });

  it('goes by direct message after any refusal in the thread that will not pass, and never to the top of the chat', async () => {
    for (const code of [230002, 230011, 230017, 230019, 232009, 230018, 230035, 230099, 100290, 404, 400]) {
      const { task } = ready(ALICE, TOPIC, `refused ${code}`);
      lark.failNext('sendCard', new ChannelError(code, `refused ${code}`, false));
      const from = lark.calls.filter((c) => c === 'sendCard').length;
      await poster().deliver();
      const tried = lark.calls.filter((c) => c === 'sendCard').length - from;
      expect(tried).toBe(2);
      expect(lark.boardCards.at(-1)?.target).toEqual(dm('on_alice'));
      // The direct message is not the thread's card: no mention.
      expect(lark.boardCards.at(-1)?.view.markdown).not.toContain('<at id=');
      expect(sentPayload(task.taskId)).toMatchObject({ in: 'dm' });
    }
    expect(lark.boardCards.every((c) => c.target.threadId !== '' || c.target.receiveIdType === 'union_id')).toBe(true);
    // The direct message refused after it: 230013 records the card as failed, never back to the thread; anything else holds it back.
    const unreachable = ready(ALICE, TOPIC, 'Unreachable');
    lark.failNext('sendCard', new ChannelError(232009, 'chat dissolved', false));
    lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    await poster().deliver();
    expect(eventsOf(t.db, unreachable.task.taskId).at(-1)).toMatchObject({
      kind: 'card_failed',
      payload: { error: 'chat dissolved (code 232009); and by direct message: Bot has NO availability to this user (code 230013)' },
    });
    const later = ready(ALICE, TOPIC, 'Later');
    lark.failNext('sendCard', new ChannelError(232009, 'chat dissolved', false));
    lark.failNext('sendCard', new ChannelError(400, 'Bad Request', false));
    await poster().deliver();
    expect(eventsOf(t.db, later.task.taskId).some((e) => e.kind.startsWith('card_'))).toBe(false);
    expect(notes.some((n) => n.startsWith(`kanban: the card of run ${later.run.runId} was not sent (Bad Request (code 400))`))).toBe(true);
  });

  it('is held back after a failure that may pass, and routed afresh at its next try', async () => {
    const { task, run } = ready();
    lark.failNext('sendCard', new ChannelError(500, 'internal error', true));
    const p = poster();
    expect(await p.deliver()).toBe(0);
    expect(notes.some((n) => n.startsWith(`kanban: the card of run ${run.runId} was not sent (internal error (code 500))`))).toBe(true);
    // Alice leaves the group; once the members are read again, her card goes to her.
    lark.members.set('oc_team', ['on_owner']);
    clock.advance(MEMBERS_MS);
    expect(await p.deliver()).toBe(1);
    expect(lark.calls.filter((c) => c === 'sendCard')).toHaveLength(2);
    expect(lark.boardCards.map((c) => c.target)).toEqual([dm('on_alice')]);
    expect(lark.boardCards[0]?.uuid).toBe(boardCardUuid('cli_app', run.runId));
    expect(sentPayload(task.taskId)).toMatchObject({ in: 'dm' });
  });

  it("is recorded where Lark's answer says it is, an answer deduplicated against the other place included", async () => {
    const toBob = ready(BOB);
    // Sent to the thread before a restart, unrecorded; now routed to Bob, Lark answers with the thread's message.
    lark.answerNext('sendCard', { messageId: 'om_earlier', deduped: true, threadId: 'omt_topic' });
    await poster().deliver();
    expect(lark.boardCards.map((c) => c.target)).toEqual([dm('on_bob')]);
    expect(sentPayload(toBob.task.taskId)).toEqual({ kind: 'work', to: BOB, messageId: 'om_earlier', in: 'thread' });
    const toAlice = ready(ALICE, TOPIC, 'The other way');
    lark.answerNext('sendCard', { messageId: 'om_dm_earlier', deduped: true });
    await poster().deliver();
    expect(lark.boardCards.at(-1)?.target).toEqual(THREAD);
    expect(sentPayload(toAlice.task.taskId)).toMatchObject({ messageId: 'om_dm_earlier', in: 'dm' });
  });

  it("passes over a held task's runs at each send, saying nothing, and sends the card once the hold has ended", async () => {
    const first = ready(ALICE, TOPIC, 'First');
    const second = ready(ALICE, TOPIC, 'Second');
    lark.hold();
    const round = poster().deliver();
    await new Promise((resolve) => setImmediate(resolve));
    // Held while the round is under way, after the round read its runs: checked at its send.
    held.add(second.task.taskId);
    lark.release();
    expect(await round).toBe(1);
    expect(lark.boardCards.map((c) => c.view.markdown.includes('First'))).toEqual([true]);
    expect(notes).toEqual([]);
    held.delete(second.task.taskId);
    expect(await poster().deliver()).toBe(1);
    expect(sentPayload(second.task.taskId)).toMatchObject({ in: 'thread' });
    expect(sentPayload(first.task.taskId)).toMatchObject({ in: 'thread' });
  });

  it('goes by direct message when the lookup outlasts its time', async () => {
    lark.chatMembers = () => new Promise(() => undefined);
    const { task } = ready();
    expect(await poster({ sendTimeoutMs: 20 }).deliver()).toBe(1);
    expect(lark.boardCards.map((c) => c.target)).toEqual([dm('on_alice')]);
    expect(sentPayload(task.taskId)).toMatchObject({ in: 'dm' });
  });
});
```

In `tests/helpers/channel.ts`, replace:

```ts
  readonly #clock: Clock;
  readonly #failures = new Map<Method, unknown[]>();
```

with:

```ts
  readonly #clock: Clock;
  readonly #failures = new Map<Method, unknown[]>();
  readonly #answers = new Map<Method, SendResult[]>();
```

In `tests/helpers/channel.ts`, replace:

```ts
  /** Awaited by every call site, after it has been recorded and before it succeeds. */
```

with:

```ts
  /**
   * Make the next call to `method` that succeeds answer with `result`, as Lark
   * answers a send it deduplicated against an earlier one: queued, as failures are.
   */
  answerNext(method: Method, result: SendResult): void {
    const queue = this.#answers.get(method) ?? [];
    queue.push(result);
    this.#answers.set(method, queue);
  }

  /** Awaited by every call site, after it has been recorded and before it succeeds. */
```

In `tests/helpers/channel.ts`, replace:

```ts
    this.boardCards.push({ target, view, uuid });
    return this.#result(`om_board_${++this.#seq}`, target);
```

with:

```ts
    this.boardCards.push({ target, view, uuid });
    const result = this.#result(`om_board_${++this.#seq}`, target);
    return this.#answers.get('sendCard')?.shift() ?? result;
```

In `tests/kanban-people-reports.test.ts`, replace:

```ts
    expect(service.recordCard(run.runId, { messageId: 'om_card' })).toEqual({ ok: true, recorded: true });
```

with:

```ts
    expect(service.recordCard(run.runId, { messageId: 'om_card', in: 'dm' })).toEqual({ ok: true, recorded: true });
```

In `tests/kanban-people-reports.test.ts`, replace:

```ts
      ['card_sent', { kind: 'work', to: ALICE, messageId: 'om_card' }],
```

with:

```ts
      ['card_sent', { kind: 'work', to: ALICE, messageId: 'om_card', in: 'dm' }],
```

In `tests/kanban-people-reports.test.ts`, replace:

```ts
    expect(service.recordCard(agent.run.runId, { messageId: 'om_x' })).toMatchObject({ ok: false, code: 'invalid' });
```

with:

```ts
    expect(service.recordCard(agent.run.runId, { messageId: 'om_x', in: 'dm' })).toMatchObject({ ok: false, code: 'invalid' });
```

- [ ] **Step 10.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-thread-cards.test.ts tests/kanban-people-reports.test.ts`. Expected: `Tests  10 failed | 10 passed (20)`: every card goes by direct message, and none records `in`.

- [ ] **Step 10.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
/** What became of a person's card (spec §9.2): sent, as this message, or refused for good by the channel. */
export type CardOutcome = { messageId: string } | { error: string };
```

with:

```ts
/**
 * What became of a person's card (spec §9.2): sent, as this message, in the
 * task's thread or by direct message as Lark's answer said (spec §19.2), or
 * refused for good by the channel.
 */
export type CardOutcome = { messageId: string; in: 'thread' | 'dm' } | { error: string };
```

In `src/db/kanban.ts`, replace:

```ts
        ? { taskId: run.taskId, runId, kind: 'card_sent', actor: 'gateway', payload: { ...base, messageId: card.messageId } }
```

with:

```ts
        ? { taskId: run.taskId, runId, kind: 'card_sent', actor: 'gateway', payload: { ...base, messageId: card.messageId, in: card.in } }
```

In `src/kanban/cards.ts`, replace:

```ts
import { ChannelError, personTarget, type Channel } from '../channel/types.js';
import { boardCardUuid } from '../core/ids.js';
import { cardsDue } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { renderReviewCard, renderTaskCard, type CardFacts, type NameOf } from './chat-render.js';
import { unionIdOf } from './people.js';
import type { KanbanService } from './service.js';
import type { RunRow } from './types.js';
```

with:

```ts
import { ChannelError, personTarget, type Channel, type SendResult, type SendTarget } from '../channel/types.js';
import { boardCardUuid } from '../core/ids.js';
import { cardsDue, subscriptionsOf, type CardReading } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { personOf } from '../db/people.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { renderReviewCard, renderTaskCard, type CardFacts, type NameOf } from './chat-render.js';
import { Membership } from './members.js';
import { unionIdOf } from './people.js';
import type { KanbanService } from './service.js';
import type { RunRow } from './types.js';
```

In `src/kanban/cards.ts`, replace:

```ts
 * **A card sent and not recorded** is not sent again, in a loop that would
 * outlast the uuid's hour: the run is passed over until a restart, said once.
 */
```

with:

```ts
 * **A card sent and not recorded** is not sent again, in a loop that would
 * outlast the uuid's hour: the run is passed over until a restart, said once.
 *
 * **Where it goes** (spec §19.2), decided afresh at each try: in the task's
 * thread, mentioning the person, when the task has a thread with a root and
 * Lark's chat members API says they are in the group (`Membership`); by direct
 * message otherwise. A direct message that cannot reach them goes to the thread;
 * a card refused in the thread, whatever the code, goes by direct message, and
 * never to the top of the chat. One uuid per run, wherever it goes. `card_sent`
 * records where Lark's answer says it went. A task held while its "Created"
 * reply is under way (spec §19.4) is passed over, at each send.
 */
```

In `src/kanban/cards.ts`, replace:

```ts
  /** How long a send is waited for; `CARD_SEND_MS` unless a test says otherwise. */
  sendTimeoutMs?: number;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

with:

```ts
  /** How long a send, or a members lookup, is waited for; `CARD_SEND_MS` unless a test says otherwise. */
  sendTimeoutMs?: number;
  /** Whether a task is held while its "Created" reply is under way (spec §19.4): `KanbanChat`'s. */
  held?: (taskId: string) => boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lark refused it, and will again: not a failure that never reached Lark, nor one it marks retryable, nor a timeout. */
function refusal(err: unknown): err is ChannelError {
  return err instanceof ChannelError && err.code !== 0 && !err.retryable;
}

/** Where a card was tried, and what came of it. */
type Sent = { ok: true; sent: SendResult } | { ok: false; err: unknown };
```

In `src/kanban/cards.ts`, replace:

```ts
  /** Runs whose card was sent and could not be recorded: passed over until a restart. */
  readonly #unrecorded = new Set<string>();
```

with:

```ts
  /** Runs whose card was sent and could not be recorded: passed over until a restart. */
  readonly #unrecorded = new Set<string>();
  /** Who is in each group, for a card in a task's thread (spec §19.3). */
  readonly #members: Membership;
```

In `src/kanban/cards.ts`, replace:

```ts
    this.#note = (line) => {
      try {
        note(line);
      } catch {
        // Nowhere left to say it.
      }
    };
  }

  /** Send every `CARD_POLL_MS`, starting now: the first round sends what a restart left unsent. */
```

with:

```ts
    this.#note = (line) => {
      try {
        note(line);
      } catch {
        // Nowhere left to say it.
      }
    };
    this.#members = new Membership({
      channel: deps.channel,
      appId: deps.appId,
      timeoutMs: deps.sendTimeoutMs ?? CARD_SEND_MS,
      clock: this.#clock,
      note: this.#note,
    });
  }

  /** Send every `CARD_POLL_MS`, starting now: the first round sends what a restart left unsent. */
```

In `src/kanban/cards.ts`, replace:

```ts
  /** Send one run its card, and record it; true once it was sent. */
  async #post(run: RunRow): Promise<boolean> {
    const unionId = unionIdOf(run.assignee.name);
```

with:

```ts
  /** Send one run its card, where spec §19.2 says, and record it; true once it was sent. */
  async #post(run: RunRow): Promise<boolean> {
    // Its "Created" reply under way: passed over, as an unrecorded run is, until a later round.
    if (this.#deps.held?.(run.taskId) === true) return false;
    const unionId = unionIdOf(run.assignee.name);
```

In `src/kanban/cards.ts`, replace:

```ts
    const view = this.#render(run);
    if (view === undefined) return false;
    let messageId: string;
    try {
      const sent = await this.#bounded(
        this.#deps.channel.sendCard(
          personTarget(unionId),
          // Masked once more as a whole, as every reply and notice is (spec §9.3).
          { ...view, markdown: redactKnownSecrets(view.markdown) },
          boardCardUuid(this.#deps.appId, run.runId),
        ),
      );
      messageId = sent.messageId;
    } catch (err) {
      if (err instanceof ChannelError && PERSON_UNREACHABLE_CODES.has(err.code)) {
        this.#refused(run, message(err));
      } else {
        this.#holdBack(run, message(err));
      }
      return false;
    }
    this.#backoff.delete(run.runId);
    let why: string | undefined;
    try {
      const recorded = this.#deps.service.recordCard(run.runId, { messageId });
```

with:

```ts
    const reading = this.#reading(run);
    if (reading === undefined) return false;
    const thread = this.#thread(run.taskId);
    // Rules 1 and 2: the thread for a member, a direct message for anyone else, or when the lookup failed.
    const first = thread !== undefined && (await this.#members.isMember(thread.chatId, unionId)) ? 'thread' : 'dm';
    const tried = await this.#send(run, reading, first === 'thread' ? thread : undefined, unionId);
    if (tried.ok) return this.#sent(run, tried.sent);
    if (!refusal(tried.err)) {
      // Rule 5: held back, and routed afresh at its next try.
      this.#holdBack(run, message(tried.err));
      return false;
    }
    if (first === 'thread') {
      // Rule 4: refused in the thread, whatever the code, it goes by direct message.
      this.#note(`kanban: the card of run ${run.runId} was refused in its task's thread (${message(tried.err)}); sending it by direct message`);
      const again = await this.#send(run, reading, undefined, unionId);
      if (again.ok) return this.#sent(run, again.sent);
      // Never back to the thread it was refused in: 230013 is recorded, with both reasons; anything else held back.
      if (again.err instanceof ChannelError && PERSON_UNREACHABLE_CODES.has(again.err.code)) {
        this.#refused(run, `${message(tried.err)}; and by direct message: ${message(again.err)}`);
        return false;
      }
      this.#holdBack(run, message(again.err));
      return false;
    }
    if (thread !== undefined && tried.err instanceof ChannelError && PERSON_UNREACHABLE_CODES.has(tried.err.code)) {
      // Rule 3: a person a direct message cannot reach gets it in the thread, member or not.
      this.#note(`kanban: the card of run ${run.runId} cannot reach its person by direct message (${message(tried.err)}); sending it in its task's thread`);
      const again = await this.#send(run, reading, thread, unionId);
      if (again.ok) return this.#sent(run, again.sent);
      if (!refusal(again.err)) {
        this.#holdBack(run, message(again.err));
        return false;
      }
      this.#refused(run, `${message(tried.err)}; and in the task's thread: ${message(again.err)}`);
      return false;
    }
    return this.#notSent(run, tried.err);
  }

  /**
   * The task's thread a card can go to (spec §19.4): this bot's subscription of
   * it, on this channel, when it is in a thread whose root is known. A task has
   * at most one per bot.
   */
  #thread(taskId: string): SendTarget | undefined {
    const sub = subscriptionsOf(this.#deps.db, taskId).find((s) => s.appId === this.#deps.appId && s.channel === this.#deps.channel.id);
    if (sub === undefined || sub.threadId === '' || sub.rootMessageId === null) return undefined;
    // A card is never moved to the top of the chat (spec §19.2): a refusal comes back here.
    return { chatId: sub.conversationId, threadId: sub.threadId, root: sub.rootMessageId, stayInThread: true };
  }

  /**
   * The card sent to the thread, mentioning its person by the open_id this bot
   * last noted for them, or else by direct message; with the run's one uuid
   * either way.
   */
  async #send(run: RunRow, reading: CardReading, thread: SendTarget | undefined, unionId: string): Promise<Sent> {
    const mention = thread === undefined ? undefined : personOf(this.#deps.db, this.#deps.appId, unionId)?.openId;
    const view = this.#render(run, reading, mention);
    try {
      const sent = await this.#bounded(
        this.#deps.channel.sendCard(
          thread ?? personTarget(unionId),
          // Masked once more as a whole, the mention in it, as every reply and notice is (spec §9.3).
          { ...view, markdown: redactKnownSecrets(view.markdown) },
          boardCardUuid(this.#deps.appId, run.runId),
        ),
      );
      return { ok: true, sent };
    } catch (err) {
      return { ok: false, err };
    }
  }

  /** A direct message not sent, as before threads: one Lark says cannot reach the person is recorded, anything else held back. */
  #notSent(run: RunRow, err: unknown): boolean {
    if (err instanceof ChannelError && PERSON_UNREACHABLE_CODES.has(err.code)) this.#refused(run, message(err));
    else this.#holdBack(run, message(err));
    return false;
  }

  /** A card sent: recorded, where Lark's answer says it is -- a direct message never has a thread. */
  #sent(run: RunRow, sent: SendResult): boolean {
    const { messageId } = sent;
    this.#backoff.delete(run.runId);
    let why: string | undefined;
    try {
      const recorded = this.#deps.service.recordCard(run.runId, { messageId, in: sent.threadId === undefined ? 'dm' : 'thread' });
```

In `src/kanban/cards.ts`, replace:

```ts
  /**
   * The run's card, from the board as it is now; undefined when its task is gone,
   * or its run ended since the round read it: a card for it would be out of date
   * on arrival.
   */
  #render(run: RunRow): ReturnType<typeof renderTaskCard> | undefined {
    const reading = this.#deps.service.cardReading(run.runId);
    if (reading === undefined || reading.run.endedAt !== null) return undefined;
    const facts: CardFacts = { ...reading, ...(this.#deps.nameOf === undefined ? {} : { nameOf: this.#deps.nameOf }) };
    return run.kind === 'review' ? renderReviewCard(facts, this.#deps.appId) : renderTaskCard(facts, this.#deps.appId);
  }
```

with:

```ts
  /**
   * What the run's card shows, from the board as it is now; undefined when its
   * task is gone, or its run ended since the round read it: a card for it would
   * be out of date on arrival.
   */
  #reading(run: RunRow): CardReading | undefined {
    const reading = this.#deps.service.cardReading(run.runId);
    return reading === undefined || reading.run.endedAt !== null ? undefined : reading;
  }

  /** The run's card, mentioning its person when it goes in a thread (spec §19.2). */
  #render(run: RunRow, reading: CardReading, mention: string | undefined): ReturnType<typeof renderTaskCard> {
    const facts: CardFacts = {
      ...reading,
      ...(this.#deps.nameOf === undefined ? {} : { nameOf: this.#deps.nameOf }),
      ...(mention === undefined ? {} : { mention }),
    };
    return run.kind === 'review' ? renderReviewCard(facts, this.#deps.appId) : renderTaskCard(facts, this.#deps.appId);
  }
```

- [ ] **Step 10.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1772 passed (1772)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.5: Commit.**

```bash
git add tests/kanban-thread-cards.test.ts tests/helpers/channel.ts tests/kanban-people-reports.test.ts src/db/kanban.ts src/kanban/cards.ts
git commit -m "Send a person's card in its task's thread when they are in the group and by direct message otherwise, fall back from each to the other as the rules say, route it afresh at each try, pass over a held task, and record where Lark says it went"
```

---

### Task 11: The one line, at the card's send

**Files:**

- Modify: `tests/kanban-chat-render.test.ts`, `tests/kanban-notices.test.ts`, `src/kanban/chat-render.ts`

The one line ("📋 *title*, assigned to *name*") becomes the notice of a `card_sent` whose `in` is `dm` (spec §19.5), from its payload's `to` and `kind`; a person's `claimed` is no notice any more, and neither is a `card_sent` in the thread, or one from before this plan with no `in`. The two tests of the one line change to say so. The people end-to-end tests are unchanged: their cards go by direct message, and they deliver notices after cards.

- [ ] **Step 11.1: Write the tests.**

In `tests/kanban-chat-render.test.ts`, replace:

```ts
  it("tells who a person's claim gave the task to, by name, in plain text, and nothing of a role's", () => {
    const k = newTask(h.db, { title: `Check the links ${SPOOF}`, assignee: { kind: 'human', name: ALICE } });
    claimed(h.db, k.taskId);
    const nameOf = (p: string) => (p === ALICE ? 'Alice <at id=all></at>' : undefined);
    expect(renderNotice(last(k.taskId), task(k.taskId), { ...LIMIT, nameOf })).toBe(
      `📋 **Check the links hi \\<at id=all\\>\\</at\\> team** \`${k.taskId}\`, assigned to Alice \\<at id=all\\>\\</at\\>`,
    );
    // Without a name known, the principal.
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toMatch(/, assigned to lark:on\\_alice$/);
    const review = { ...last(k.taskId), payload: { kind: 'review', assignee: ALICE, assigneeKind: 'human' } };
    expect(renderNotice(review, task(k.taskId), { ...LIMIT, nameOf })).toMatch(/, review assigned to Alice /);
    const role = newTask(h.db);
    claimed(h.db, role.taskId);
    expect(renderNotice(last(role.taskId), task(role.taskId), { ...LIMIT, nameOf })).toBeUndefined();
```

with:

```ts
  it("tells who a person's card by direct message went to, by name, in plain text, and nothing of a claim or of a card in the thread", () => {
    const k = newTask(h.db, { title: `Check the links ${SPOOF}`, assignee: { kind: 'human', name: ALICE } });
    claimed(h.db, k.taskId);
    // A claim is no notice now: only the card's send knows where it went (spec §19.5).
    expect(renderNotice(last(k.taskId), task(k.taskId), LIMIT)).toBeUndefined();
    const sent = (payload: unknown): KanbanEvent => ({ ...last(k.taskId), kind: 'card_sent', payload });
    const nameOf = (p: string) => (p === ALICE ? 'Alice <at id=all></at>' : undefined);
    expect(renderNotice(sent({ kind: 'work', to: ALICE, messageId: 'om_1', in: 'dm' }), task(k.taskId), { ...LIMIT, nameOf })).toBe(
      `📋 **Check the links hi \\<at id=all\\>\\</at\\> team** \`${k.taskId}\`, assigned to Alice \\<at id=all\\>\\</at\\>`,
    );
    // Without a name known, the principal.
    expect(renderNotice(sent({ kind: 'work', to: ALICE, messageId: 'om_1', in: 'dm' }), task(k.taskId), LIMIT)).toMatch(/, assigned to lark:on\\_alice$/);
    expect(renderNotice(sent({ kind: 'review', to: ALICE, messageId: 'om_1', in: 'dm' }), task(k.taskId), { ...LIMIT, nameOf })).toMatch(
      /, review assigned to Alice /,
    );
    // The card itself in the thread says the same; one sent before threads, with no `in`, was told at its claim.
    expect(renderNotice(sent({ kind: 'work', to: ALICE, messageId: 'om_1', in: 'thread' }), task(k.taskId), LIMIT)).toBeUndefined();
    expect(renderNotice(sent({ kind: 'work', to: ALICE, messageId: 'om_1' }), task(k.taskId), LIMIT)).toBeUndefined();
    const role = newTask(h.db);
    claimed(h.db, role.taskId);
    expect(renderNotice(last(role.taskId), task(role.taskId), { ...LIMIT, nameOf })).toBeUndefined();
```

In `tests/kanban-notices.test.ts`, replace:

```ts
  it("tells who a person's claim gave a task to, by the name Lark gave", async () => {
```

with:

```ts
  it("tells who a person's card by direct message went to, by the name Lark gave, and nothing of the claim before it", async () => {
```

In `tests/kanban-notices.test.ts`, replace:

```ts
    expect(people.claim(r.task.taskId).ok).toBe(true);
    await notifier({ nameOf: (p) => (p === ALICE ? 'Alice' : undefined) }).deliver();
    expect(lark.texts.map((m) => m.text)).toEqual([`📋 **Check the links** \`${r.task.taskId}\`, assigned to Alice`]);
```

with:

```ts
    const claimed = people.claim(r.task.taskId);
    if (!claimed.ok) throw new Error(claimed.message);
    const n = notifier({ nameOf: (p) => (p === ALICE ? 'Alice' : undefined) });
    expect(await n.deliver()).toBe(0);
    expect(people.recordCard(claimed.run.runId, { messageId: 'om_card', in: 'dm' }).ok).toBe(true);
    await n.deliver();
    expect(lark.texts.map((m) => m.text)).toEqual([`📋 **Check the links** \`${r.task.taskId}\`, assigned to Alice`]);
```

- [ ] **Step 11.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-chat-render.test.ts tests/kanban-notices.test.ts`. Expected: `Tests  2 failed | 49 passed (51)`: the claim is still told.

- [ ] **Step 11.3: Implement.**

In `src/kanban/chat-render.ts`, replace:

```ts
 * clears by itself, and blocks as transient at its limit, which is one. For
 * people: the one line that says who a person's claim gave the task to (spec
 * §9.2), named in plain text, never mentioned, and a card that could not be sent.
 */
```

with:

```ts
 * clears by itself, and blocks as transient at its limit, which is one. For
 * people: the one line that says who a person's card went to, when it went by
 * direct message (spec §19.5), named in plain text, never mentioned -- a card in
 * the task's thread says it itself, and a claim is no notice, as only the send
 * knows where the card went -- and a card that could not be sent.
 */
```

In `src/kanban/chat-render.ts`, replace:

```ts
    case 'claimed': {
      // A role's claim is no notice: its outcome is. A person's is the group's one line.
      if (p['assigneeKind'] !== 'human') return undefined;
      const person = whom({ kind: 'human', name: text(p, 'assignee') }, opts.nameOf);
      return `📋 ${name}, ${p['kind'] === 'review' ? 'review ' : ''}assigned to ${person}`;
    }
```

with:

```ts
    case 'card_sent': {
      // The group's one line, for a card it does not see. One with no `in`, from before threads, was told at its claim.
      if (p['in'] !== 'dm') return undefined;
      const person = whom({ kind: 'human', name: text(p, 'to') }, opts.nameOf);
      return `📋 ${name}, ${p['kind'] === 'review' ? 'review ' : ''}assigned to ${person}`;
    }
```

- [ ] **Step 11.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1772 passed (1772)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 11.5: Commit.**

```bash
git add tests/kanban-chat-render.test.ts tests/kanban-notices.test.ts src/kanban/chat-render.ts
git commit -m "Tell the one line for a card sent by direct message, rather than for a person's claim, and nothing for a card in the thread"
```

---

### Task 12: Notices and approval cards reply to the root

**Files:**

- Modify: `tests/kanban-notices.test.ts`, `tests/kanban-sink.test.ts`, `src/kanban/notices.ts`, `src/kanban/sink.ts`

The notifier sends a conversation's batch as a reply to a root in the thread when any of its due subscriptions has one (spec §19.7): a thread has one root, and a batch can mix a subscription from before this plan with one after. With none, it sends as today. `KanbanSink.sendApprovalCard` replies to its subscription's root, in the thread, when it has one. Neither stays in its thread: a notice refused for a gone root goes to the chat by the adapter's fallback, as a thread reply's does today (§19.6).

- [ ] **Step 12.1: Write the tests.**

In `tests/kanban-notices.test.ts`, replace:

```ts
  it('sends at most a batch of notices a message, says more follow, and sends them in the next round', async () => {
```

with:

```ts
  it("replies a thread's batch to its root when any of its subscriptions has one, and one with none as before (spec §19.7)", async () => {
    // A task from before threads had roots, and one after, in the same thread.
    const old = create('From before');
    const rooted = create('From after', { ...VIA, rootId: 'om_root' });
    await done(old, 'one');
    await done(rooted, 'two');
    expect(await notifier().deliver()).toBe(2);
    expect(lark.texts.map((m) => m.target)).toEqual([{ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' }]);
    // A thread with no root among its subscriptions replies to the thread, as before.
    await done(create('Alone'), 'three');
    await notifier().deliver();
    expect(lark.texts[1]?.target).toEqual({ chatId: 'oc_team', threadId: 'omt_topic' });
    expect(lark.texts[1]?.target).not.toHaveProperty('root');
  });

  it('sends at most a batch of notices a message, says more follow, and sends them in the next round', async () => {
```

In `tests/kanban-sink.test.ts`, replace:

```ts
import { newTask } from './helpers/kanban.js';
```

with:

```ts
import { VIA, newTask } from './helpers/kanban.js';
```

In `tests/kanban-sink.test.ts`, replace:

```ts
  it('remembers at most FORWARDED_MAX forwarded cards for their redraw, forgetting the oldest', async () => {
```

with:

```ts
  it("replies to the root of the task's thread, in the thread, when its subscription has one (spec §19.7)", async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    const rooted = newTask(h.db, { title: 'Rotate the logs', createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' } });
    const rootless = newTask(h.db, { title: 'Rotate the logs', createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic' } });
    const atChat = newTask(h.db, { title: 'Rotate the logs', createdVia: VIA });
    const lark = new FakeChannel({ id: 'lark', clock });
    const sink = new KanbanSink(() => clock.now(), { db: h.db, channels: new Map([['lark', lark]]), appId: 'cli_app' });
    const spec = { approvalId: 'a_1', action: 'delete old.log', options: [{ optionId: 'allow', name: 'Allow' }], nonce: 'n' };
    for (const task of [rooted, rootless, atChat]) await sink.sendApprovalCard({ chatId: task.taskId, threadId: 'r_1' }, spec, `u_${task.taskId}`);
    expect(lark.approvalCards.map((c) => c.target)).toEqual([
      { chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' },
      { chatId: 'oc_team', threadId: 'omt_topic' },
      { chatId: 'oc_chat', threadId: '' },
    ]);
    expect(lark.approvalCards[1]?.target).not.toHaveProperty('root');
  });

  it('remembers at most FORWARDED_MAX forwarded cards for their redraw, forgetting the oldest', async () => {
```

- [ ] **Step 12.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-notices.test.ts tests/kanban-sink.test.ts`. Expected: `Tests  2 failed | 31 passed (33)`: no `root` on the targets.

- [ ] **Step 12.3: Implement.**

In `src/kanban/notices.ts`, replace:

```ts
      const c = byKey.get(key) ?? {
        key,
        channel: sub.channel,
        target: { chatId: sub.conversationId, threadId: sub.threadId },
        subs: [],
      };
      c.subs.push(sub);
```

with:

```ts
      const c = byKey.get(key) ?? {
        key,
        channel: sub.channel,
        target: { chatId: sub.conversationId, threadId: sub.threadId },
        subs: [],
      };
      // A thread has one root, so any of its subscriptions that knows it serves (spec §19.7):
      // a task from before threads had roots can share a thread with one from after.
      if (c.target.root === undefined && sub.threadId !== '' && sub.rootMessageId !== null) {
        c.target = { ...c.target, root: sub.rootMessageId };
      }
      c.subs.push(sub);
```

In `src/kanban/sink.ts`, replace:

```ts
    const sent = await channel.sendApprovalCard(
      { chatId: sub.conversationId, threadId: sub.threadId },
```

with:

```ts
    // In a thread with a root, a reply to it, as the notifier's (spec §19.7).
    const root = sub.threadId === '' || sub.rootMessageId === null ? {} : { root: sub.rootMessageId };
    const sent = await channel.sendApprovalCard(
      { chatId: sub.conversationId, threadId: sub.threadId, ...root },
```

In `src/kanban/sink.ts`, replace:

```ts
 * An approval card, for a supervised agent, is forwarded to the task's first
 * subscription (spec §7.1): the chat, or thread, the task was created in, where
 * someone follows it.
```

with:

```ts
 * An approval card, for a supervised agent, is forwarded to the task's first
 * subscription (spec §7.1): the chat, or thread, the task was created in, where
 * someone follows it; in a thread whose root is known, as a reply to it (spec
 * §19.7).
```

- [ ] **Step 12.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1774 passed (1774)`. Run `npx vitest run --project e2e`. Expected: `Tests  151 passed (151)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 12.5: Commit.**

```bash
git add tests/kanban-notices.test.ts tests/kanban-sink.test.ts src/kanban/notices.ts src/kanban/sink.ts
git commit -m "Reply a thread's notices, and a forwarded approval card, to the thread's root when it is known"
```

---

### Task 13: The gateway, and a task's thread end to end

**Files:**

- Create: `tests/kanban-thread.e2e.ts`
- Modify: `src/index.ts`

`src/index.ts` gives the card poster `KanbanChat`'s `held`, and its comment says where a card goes. The adapter is the card poster's channel already, so its `chatMembers` is used as is. The end-to-end tests run the router, the board, the dispatcher with fake drivers, the notifier, the card poster and the sink over the fake Lark channel: a member gets a thread card, a non-member a direct message, a 230013 direct message falls back to the thread, the task's notices land in its thread, a follow-up's notices and its person's card land in its parent's thread, a supervised role's approval card lands in the task's thread, and a task created in a direct message is unchanged. They pass as soon as they are written: they put Tasks 1 to 12 together, and nothing in them goes through `src/index.ts`, whose wiring the type check and the existing startup tests, which build the gateway with the board on, cover.

- [ ] **Step 13.1: Write the tests.**

Create `tests/kanban-thread.e2e.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelError, type CardView, type Channel, type SendTarget } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { Router } from '../src/core/router.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { getRun, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { notePerson } from '../src/db/people.js';
import type { Driver } from '../src/driver/types.js';
import { CardPoster } from '../src/kanban/cards.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { Notifier } from '../src/kanban/notices.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { InboundMention, InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role, until } from './helpers/dispatch.js';

/**
 * A task's thread, end to end (spec §19): a task created in a group at chat
 * scope is answered in a thread on its command, through the router and the fake
 * Lark channel; its person's card goes there when they are a member, by direct
 * message when not, and to the thread when a direct message cannot reach them;
 * its notices, its follow-ups' notices and cards, and a supervised agent's
 * approval card all land there; and a task created in a direct message is as it
 * was.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const ALICE: Principal = { openId: 'ou_alice', unionId: 'on_alice', displayName: 'Alice Smith' };
const BOB: Principal = { openId: 'ou_bob', unionId: 'on_bob', displayName: 'Bob' };
const AT_ALICE: InboundMention = { key: '@_user_1', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' };
const AT_BOB: InboundMention = { key: '@_user_2', name: 'Bob', openId: 'ou_bob', unionId: 'on_bob' };

interface Stack {
  t: TestDb;
  lark: FakeChannel;
  router: Router;
  dispatcher: Dispatcher;
  service: KanbanService;
  chat: KanbanChat;
  notifier: Notifier;
  cards: CardPoster;
  registry: SessionRegistry;
  helper: FakeDriver;
  watched: FakeDriver;
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
  stack.t.close();
  rmSync(stack.dir, { recursive: true, force: true });
  stack = undefined;
});

function build(): Stack {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-thread-e2e-')));
  const workspace = join(dir, 'work');
  mkdirSync(workspace);
  const t = testDb();
  const authorizer = new Authorizer({ ...defaultAuthConfig(OWNER.openId), allowTalk: [OWNER.openId, ALICE.openId, BOB.openId] });
  const people = new PeopleDirectory({
    db: t.db,
    appId: 'cli_app',
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
  });
  // Both have used the board before, so it knows them, and their open_ids for this bot.
  for (const p of [ALICE, BOB]) notePerson(t.db, { appId: 'cli_app', unionId: p.unionId ?? '', openId: p.openId, name: p.displayName }, Date.now());
  const watchedRole = role('watched');
  const roles = new Map([
    ['helper', role('helper')],
    ['watched', { ...watchedRole, agent: { ...watchedRole.agent, unsupervised: false } }],
  ]);
  const helper = new FakeDriver('helper');
  const watched = new FakeDriver('watched');
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']), people, supervisedRoles: true });
  const lark = new FakeChannel({ id: 'lark' });
  // Alice and the owner are in the team's group; Bob is not.
  lark.members.set('oc_team', ['on_owner', 'on_alice']);
  const drivers = new Map<string, Driver>([
    ['default', new FakeDriver()],
    ['helper', helper],
    ['watched', watched],
  ]);
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
  dispatcher = new Dispatcher({
    db: t.db,
    service,
    sessions: registry,
    roles,
    appId: 'cli_app',
    settings: { maxRunning: 2, defaultMaxRuntimeS: 600, strandedAfterS: 1800, sweepIntervalS: 60, nudgeLimit: 0 },
  });
  const d = dispatcher;
  const chat = new KanbanChat({
    service,
    hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
    people,
    appId: 'cli_app',
    redraw: (messageId, view) => lark.updateCard(messageId, view),
    changed: () => d.pass(),
    cancel: (runId) => {
      d.cancel(runId);
    },
  });
  const router = new Router({ db: t.db, registry, authorizer, channel: lark, channelId: 'lark', appId: 'cli_app', kanban: chat });
  const nameOf = (principal: string) => people.nameOf(principal);
  stack = {
    t,
    lark,
    router,
    dispatcher,
    service,
    chat,
    notifier: new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2, nameOf }),
    cards: new CardPoster({ db: t.db, service, channel: lark, appId: 'cli_app', nameOf, held: (taskId) => chat.held(taskId) }),
    registry,
    helper,
    watched,
    dir,
  };
  return stack;
}

/** A message in the team's group, at chat scope, mentioning the bot and whoever else. */
function inGroup(text: string, mentions: InboundMention[] = []): InboundMessage {
  return {
    messageId: `om_e2e_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: '',
    sender: OWNER,
    senderIsBot: false,
    text,
    mentionedBot: true,
    mentionAll: false,
    mentions,
    attachments: [],
    createTime: Date.now(),
  };
}

/** The task a "Created" reply names. */
function createdIn(lark: FakeChannel): string {
  const reply = lark.texts.find((m) => m.text.startsWith('Created'))?.text ?? '';
  const id = /^Created `(k_[0-9a-z]+)`/.exec(reply)?.[1];
  if (id === undefined) throw new Error(`no task created: ${reply}`);
  return id;
}

/** The thread on a command message, as the fake channel answers a reply that opens one. */
function threadOn(message: InboundMessage): SendTarget {
  return { chatId: 'oc_team', threadId: `omt_${message.messageId}`, root: message.messageId };
}

/** Press a card's button as `who`, as Lark's callback gives it, through the router; then wait for the press's work. */
async function press(s: Stack, view: CardView, messageId: string, label: string, who: Principal, input?: string): Promise<void> {
  const button = view.buttons.find((b) => b.label === label);
  if (button === undefined) throw new Error(`no ${label} on the card`);
  await s.router.onCardAction({ chatId: 'oc_team', messageId, operator: who, value: { ...button.value }, ...(input === undefined ? {} : { input }) });
  await s.chat.idle(10_000);
}

/** Nothing the board said went to the top of the group: every send there is in a thread, or opens one. */
function nothingAtTheTop(lark: FakeChannel): boolean {
  const targets = [...lark.texts.map((m) => m.target), ...lark.boardCards.map((c) => c.target), ...lark.approvalCards.map((c) => c.target)];
  return targets.every((x) => x.chatId !== 'oc_team' || x.threadId !== '' || x.replyInThread === true);
}

describe("a task's thread, end to end", () => {
  it("answers a task created at chat scope in a thread on its command, and puts a member's card, its press and its notices there", async () => {
    const s = build();
    const command = inGroup('/kanban task new Book the venue\nassignee: @Alice Smith', [AT_ALICE]);
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    expect(s.lark.texts[0]?.target).toEqual({ chatId: 'oc_team', threadId: '', replyTo: command.messageId, replyInThread: true, stayInThread: true });
    expect(s.lark.texts[0]?.text).toContain('Their card comes in this thread when it is ready, or by direct message if they are not in this group. This thread hears');
    expect(subscriptionsOf(s.t.db, taskId).map((x) => [x.threadId, x.rootMessageId])).toEqual([[`omt_${command.messageId}`, command.messageId]]);
    expect(s.chat.held(taskId)).toBe(false);
    await s.dispatcher.idle();

    expect(await s.cards.deliver()).toBe(1);
    const [card] = s.lark.boardCards;
    expect(card?.target).toEqual({ ...threadOn(command), stayInThread: true });
    expect(card?.view.markdown.startsWith(`<at id=ou_alice></at> 📋 For you to do: **Book the venue** \`${taskId}\``)).toBe(true);
    // The card says who has it, in the thread: no one line.
    expect(await s.notifier.deliver()).toBe(0);

    await press(s, card?.view ?? { markdown: '', buttons: [] }, 'om_board_2', 'Done', ALICE, 'rooms 3A and 3B');
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');
    expect(await s.notifier.deliver()).toBe(1);
    expect(s.lark.texts.at(-1)).toMatchObject({ target: threadOn(command), text: `Done: **Book the venue** \`${taskId}\`\n> rooms 3A and 3B` });
    expect(nothingAtTheTop(s.lark)).toBe(true);
  });

  it("sends a non-member's card by direct message, and the thread hears who has it", async () => {
    const s = build();
    const command = inGroup('/kanban task new Order the badges\nassignee: @Bob', [AT_BOB]);
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    expect(await s.cards.deliver()).toBe(1);
    expect(s.lark.boardCards.map((c) => c.target)).toEqual([{ chatId: 'on_bob', threadId: '', receiveIdType: 'union_id' }]);
    expect(s.lark.boardCards[0]?.view.markdown).not.toContain('<at id=');
    expect(await s.notifier.deliver()).toBe(1);
    expect(s.lark.texts.at(-1)).toMatchObject({ target: threadOn(command), text: `📋 **Order the badges** \`${taskId}\`, assigned to Bob` });
  });

  it('sends a card whose direct message cannot reach its person to the thread', async () => {
    const s = build();
    const command = inGroup('/kanban task new Order the badges\nassignee: @Bob', [AT_BOB]);
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    s.lark.failNext('sendCard', new ChannelError(230013, 'Bot has NO availability to this user', false));
    expect(await s.cards.deliver()).toBe(1);
    expect(s.lark.calls.filter((c) => c === 'sendCard')).toHaveLength(2);
    expect(s.lark.boardCards.map((c) => c.target)).toEqual([{ ...threadOn(command), stayInThread: true }]);
    expect(s.lark.boardCards[0]?.view.markdown.startsWith('<at id=ou_bob></at> ')).toBe(true);
    expect(await s.notifier.deliver()).toBe(0);
    expect(getTask(s.t.db, taskId)?.phase).toBe('open');
  });

  it("puts a follow-up's notices, and its person's card, in its parent's thread", async () => {
    const s = build();
    let followUp = '';
    s.helper.scripts.push(async (ctl) => {
      const runId = ctl.env?.['MT_KANBAN_RUN'] ?? '';
      // As the worker API creates one for `mt kanban create`: by the run, for a person.
      const child = s.service.create({ title: 'Call the caterer', assignee: 'lark:on_alice', createdBy: `run:${runId}`, createdVia: { kind: 'run', runId } });
      if (!child.ok) throw new Error(child.message);
      followUp = child.task.taskId;
      const done = await s.service.complete(getRun(s.t.db, runId)?.taskId ?? '', { kind: 'run', runId }, { summary: 'venue booked' });
      if (!done.ok) throw new Error(done.message);
      ctl.end('completed');
    });
    const command = inGroup('/kanban task new Plan the offsite\nassignee: helper');
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    await until(() => followUp !== '' && getTask(s.t.db, taskId)?.phase === 'done', 'the follow-up');
    await s.dispatcher.idle();
    s.dispatcher.pass();
    await s.dispatcher.idle();
    expect(subscriptionsOf(s.t.db, followUp).map((x) => [x.threadId, x.rootMessageId])).toEqual([[`omt_${command.messageId}`, command.messageId]]);
    expect(await s.cards.deliver()).toBe(1);
    const [card] = s.lark.boardCards;
    expect(card?.target).toEqual({ ...threadOn(command), stayInThread: true });
    // Alice's Done on the follow-up's card: its notice comes in the parent's thread too.
    await press(s, card?.view ?? { markdown: '', buttons: [] }, 'om_board_2', 'Done', ALICE, 'booked');
    expect(getTask(s.t.db, followUp)?.phase).toBe('done');
    await s.notifier.deliver();
    const told = s.lark.texts.filter((m) => !m.text.startsWith('Created'));
    expect(told.map((m) => m.target)).toEqual([threadOn(command)]);
    expect(told[0]?.text.split('\n\n')).toEqual([
      `Done: **Plan the offsite** \`${taskId}\`\n> venue booked`,
      `Done: **Call the caterer** \`${followUp}\`\n> booked`,
    ]);
    expect(nothingAtTheTop(s.lark)).toBe(true);
  });

  it("forwards a supervised role's approval card to the task's thread, replying to its root", async () => {
    const s = build();
    let answer: unknown;
    s.watched.scripts.push(async (ctl) => {
      const runId = ctl.env?.['MT_KANBAN_RUN'] ?? '';
      const taskId = getRun(s.t.db, runId)?.taskId ?? '';
      // Asked once the thread is known: one asked in the moment before is the group's (see Known limitations).
      await until(() => subscriptionsOf(s.t.db, taskId)[0]?.rootMessageId !== null, 'the thread');
      answer = await ctl.ask('delete old.log', [{ optionId: 'allow', name: 'Allow' }]);
      ctl.end('completed');
    });
    const command = inGroup('/kanban task new Rotate the logs\nassignee: watched');
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    await until(() => s.lark.approvalCards.length > 0, 'the approval card');
    const [card] = s.lark.approvalCards;
    expect(card?.target).toEqual(threadOn(command));
    expect(card?.spec.action).toBe(`Task ${taskId}, Rotate the logs, asks: delete old.log`);
    expect(
      await s.router.onCardAction({
        chatId: 'oc_team',
        messageId: 'om_approval_2',
        operator: OWNER,
        value: { kind: 'approval', approvalId: card?.spec.approvalId ?? '', optionId: 'allow', nonce: card?.spec.nonce ?? '' },
      }),
    ).toBe('Sent: Allow.');
    await until(() => answer !== undefined, "the agent's answer");
    expect(answer).toEqual({ kind: 'selected', optionId: 'allow' });
  });

  it('leaves a task created in a direct message as it was: no thread, its card by direct message, its one line in that chat', async () => {
    const s = build();
    const command: InboundMessage = { ...inGroup('/kanban task new Check the links\nassignee: @Alice Smith', [AT_ALICE]), chatId: 'oc_dm', chatType: 'p2p' };
    await s.router.onMessage(command);
    const taskId = createdIn(s.lark);
    expect(s.lark.texts[0]?.target).toEqual({ chatId: 'oc_dm', threadId: '' });
    expect(s.lark.texts[0]?.text).toContain('They are sent it as a card, in a direct message, once it is ready. This chat hears');
    expect(subscriptionsOf(s.t.db, taskId).map((x) => [x.conversationId, x.threadId, x.rootMessageId])).toEqual([['oc_dm', '', null]]);
    await s.dispatcher.idle();
    expect(await s.cards.deliver()).toBe(1);
    expect(s.lark.boardCards.map((c) => c.target)).toEqual([{ chatId: 'on_alice', threadId: '', receiveIdType: 'union_id' }]);
    expect(s.lark.memberLookups).toEqual([]);
    expect(await s.notifier.deliver()).toBe(1);
    expect(s.lark.texts.at(-1)).toMatchObject({ target: { chatId: 'oc_dm', threadId: '' }, text: `📋 **Check the links** \`${taskId}\`, assigned to Alice Smith` });
  });
});
```

- [ ] **Step 13.2: Run them.** Run `npx vitest run --project e2e tests/kanban-thread.e2e.ts`. Expected: `Tests  6 passed (6)`.

- [ ] **Step 13.3: Implement.**

In `src/index.ts`, replace:

```ts
    // A person's run is sent its card, as a direct message (spec §9.2).
    cards = new CardPoster({
      db,
      service,
      channel: adapter,
      appId: config.lark.appId,
      nameOf: (principal) => people.nameOf(principal),
      canTalk: (principal) => people.canTalk(principal),
      note,
    });
```

with:

```ts
    // A person's run is sent its card: in its task's thread when they are in the group, else as a
    // direct message (spec §9.2, §19.2), never while the task's "Created" reply is under way (§19.4).
    const chat = kanbanChat;
    cards = new CardPoster({
      db,
      service,
      channel: adapter,
      appId: config.lark.appId,
      nameOf: (principal) => people.nameOf(principal),
      canTalk: (principal) => people.canTalk(principal),
      held: (taskId) => chat.held(taskId),
      note,
    });
```

- [ ] **Step 13.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1774 passed (1774)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 13.5: Commit.**

```bash
git add tests/kanban-thread.e2e.ts src/index.ts
git commit -m "Give the card poster the hold, and test a task's thread end to end over the fake channel"
```

---

### Task 14: The README and the guide

**Files:**

- Modify: `README.md`, `docs/kanban-guide.md`

The README asks for `im:chat.members:read`, says where a person's card goes, when the one line is told and what a task's thread holds, and adds three limitations; the guide says a task gets a thread in a group, shows the threaded "Created" reply, says where the card goes and who sees it, when the one line is told, and that follow-ups and approval cards go in the thread. No plan is named, and no long dash is added.

- [ ] **Step 14.1: Write it.**

In `README.md`, replace:

```md
   (`im/v1/messages/:message_id/resources`), and creating and updating cards
   (`cardkit/v1/cards`).
```

with:

```md
   (`im/v1/messages/:message_id/resources`), and creating and updating cards
   (`cardkit/v1/cards`). With the board on, also `im:chat.members:read`, to read a group's
   members, so that a person's card can go in a task's thread in their group: without it,
   every card goes by direct message, and the log says so once.
```

In `README.md`, replace:

```md
When a person's task is ready, they are sent it as a card in a direct message — the title, the
body, the contract and the parents' summaries — with a box and **Done** and **Block**: type a
```

with:

```md
When a person's task is ready, they are sent it as a card, in the task's thread or by direct
message (see "A task's thread" below): the title, the body, the contract and the parents'
summaries, with a box and **Done** and **Block**: type a
```

In `README.md`, replace:

```md
it waits for them, across restarts. The chat the task came from hears one line — "📋 *title*,
assigned to *name*", the name in plain text, never a mention — and its notices as usual; a
notice of a block carries an **Unblock** button for an operator. Only a card that cannot reach
its person — Lark answering that they are outside the app's availability (230013), or the person
having lost talk tier — is reported to the chat instead, with the commands to use. Any other
```

with:

```md
it waits for them, across restarts. The chat the task came from hears its notices as usual, and
for a card sent by direct message, one line, "📋 *title*, assigned to *name*", the name in
plain text, never a mention; a notice of a block carries an **Unblock** button for an operator.
Only a card that cannot reach its person (Lark answering that they are outside the app's
availability, 230013, for a task with no thread to send it to instead, or the person having lost
talk tier) is reported to the chat instead, with the commands to use. Any other
```

In `README.md`, replace:

```md
person's report is refused while another task's agent is working in the same workspace, if the
task has gates to run there.
```

with:

```md
person's report is refused while another task's agent is working in the same workspace, if the
task has gates to run there.

**A task's thread.** A task created by `/kanban task new` in a group, at chat scope, is answered
in a thread on the command message, and everything about it goes there: its person's cards, its
notices, and its follow-ups' notices and cards. The group's timeline shows the command and its
thread. A person's card goes in the thread, starting with an @-mention of them, when Lark's chat
members API says they are in the group, asked at most once a group every five minutes;
otherwise it goes by direct message, and the thread hears the one line. A direct message Lark
refuses because the person is outside the app's availability goes to the thread instead; a card
the thread refuses goes by direct message, never to the top of the chat. A card in the thread is
seen by the whole group, the task's body and contract included. A task created inside a thread
uses that thread; one created in a direct message, or at a terminal, has none, and its cards go
by direct message. Tasks created before this build stay as they were. If Lark refuses to reply
in a thread, in a group that does not allow it or to a command message since withdrawn, the
reply is sent quoted instead, and the task stays at chat scope.
```

In `README.md`, replace:

```md
A role whose agent is supervised may be given tasks too: its approval cards go to the chat that
follows the task, naming it, and are answered there at operator tier, as in a chat session.
```

with:

```md
A role whose agent is supervised may be given tasks too: its approval cards go to the chat, or
the thread, that follows the task, naming it, and are answered there at operator tier, as in a
chat session.
```

In `README.md`, replace:

```md
- A task created with `mt kanban task new` is followed by no chat: nobody hears its notices, and a
  supervised role's approval requests on it reach nobody, as for any task no chat follows.
```

with:

```md
- A task created with `mt kanban task new` is followed by no chat: nobody hears its notices, and a
  supervised role's approval requests on it reach nobody, as for any task no chat follows.
- A task's thread is not recovered after a restart in the moment between Lark accepting its
  "Created" reply and the task moving to it: the task stays at chat scope, its notices in the
  group and its cards by direct message.
- A block, or an approval card, raised before the task's thread is known goes to the group.
- A person who has left a group may get one more card in a task's thread there, within five
  minutes of leaving.
```

In `docs/kanban-guide.md`, replace:

```md
an @-mention of the bot, or the gateway does not read it. In a direct message with the bot, just
type the command. The examples below leave the bot's mention out.
```

with:

```md
an @-mention of the bot, or the gateway does not read it. In a direct message with the bot, just
type the command. The examples below leave the bot's mention out.

**In a group, a task gets a thread.** A `/kanban task new` typed in a group, not inside a thread,
is answered in a thread on your message, and everything about the task goes in that thread: its
notices, its person's cards, and its follow-ups' notices and cards. The group's timeline shows
only your command and its thread. A task created inside a thread uses that thread; one created
in a direct message has none. The replies below are as a direct message shows them; in a group
they say "This thread hears" where they say "This chat hears".
```

In `docs/kanban-guide.md`, replace:

```md
- **A person** gets a review card in a direct message: the handoff, what to review (the reported
  commit, when one was recorded), the body and the contract, a box, and **Approve** and
  **Request changes**. The chat the task came from hears one line:
```

with:

```md
- **A person** gets a review card, in the task's thread when they are in its group, else in a
  direct message: the handoff, what to review (the reported commit, when one was recorded), the
  body and the contract, a box, and **Approve** and **Request changes**. When it goes by direct
  message, the thread, or the chat the task came from, hears one line:
```

In `docs/kanban-guide.md`, replace:

```md
The chat replies:

> Created `k_…`: **Book the venue for the January offsite**, for Alice Chen (lark:on_…). They are sent it as a card, in a direct message, once it is ready. This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

When the task is ready, Alice gets a card in a direct message from the bot:
```

with:

```md
Typed in a group, it is answered in a thread on your message:

> Created `k_…`: **Book the venue for the January offsite**, for Alice Chen (lark:on_…). Their card comes in this thread when it is ready, or by direct message if they are not in this group. This thread hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

In a direct message with the bot, the reply says instead "They are sent it as a card, in a direct
message, once it is ready. This chat hears …".

When the task is ready, Alice gets a card from the bot: in the task's thread, starting with an
@-mention of her, when she is in the group; otherwise in a direct message. The card holds:
```

In `docs/kanban-guide.md`, replace:

```md
The chat the task came from hears one line, naming her in plain text, never as a mention:
```

with:

```md
When the card goes by direct message, the thread, or the chat the task came from, hears one line,
naming her in plain text, never as a mention. A card in the thread says the same itself.
```

In `docs/kanban-guide.md`, replace:

```md
of date and does nothing. Only the person named can press Done and Block.
```

with:

```md
of date and does nothing. Only the person named can press Done and Block.

A card in the thread is seen by everyone in the group, the task's body and contract included,
and anyone may press it, though only Alice's press does anything. If Lark will not take her
direct message because she is outside the app's availability, the card goes to the thread
instead, mentioning her, so the group can bring her in. If the thread refuses the card, it goes
to her by direct message, never to the top of the group.
```

In `docs/kanban-guide.md`, replace:

```md
The chat, or the thread, a task was created in follows it and every follow-up its runs create.
It hears when a task:
```

with:

```md
The chat, or the thread, a task was created in follows it and every follow-up its runs create;
for a task created in a group at chat scope, the thread its "Created" reply opened. It hears
when a task:
```

In `docs/kanban-guide.md`, replace:

```md
It also hears the one line saying a person was given a task or a review, and when a card could
not reach its person.
```

with:

```md
It also hears the one line saying a person was given a task or a review, when their card went by
direct message, and when a card could not reach its person.
```

In `docs/kanban-guide.md`, replace:

```md
  it, so the chat that created the parent hears when each follow-up is done, blocks or gives up,
  and so on down the line.
```

with:

```md
  it, so the chat that created the parent hears when each follow-up is done, blocks or gives up,
  and so on down the line. A follow-up of a task with a thread is in that thread, and so is its
  person's card, when they are in the group.
```

In `docs/kanban-guide.md`, replace:

```md
A role whose agent is supervised, such as `watched`, asks before it acts. Its approval cards go
to the chat that follows the task, naming it
```

with:

```md
A role whose agent is supervised, such as `watched`, asks before it acts. Its approval cards go
to the chat, or the thread, that follows the task, naming it
```

- [ ] **Step 14.2: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1774 passed (1774)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors. Run `git diff -- README.md docs/kanban-guide.md | grep "^+" | grep -c "—"`. Expected: `0`.

- [ ] **Step 14.3: Commit.**

```bash
git add README.md docs/kanban-guide.md
git commit -m "Say in the README and the guide that a task created in a group gets a thread, where a person's card goes, when the one line is told, and the permission it needs"
```

---
## Done when

- `npx vitest run --project unit` gives `Tests  1774 passed (1774)`. `npx vitest run --project e2e` gives `Tests  157 passed (157)`, run twice. `npm run typecheck` reports no errors. All under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- Migration 008 leaves every existing subscription with no root; a task created in a thread records its root, a follow-up copies it, and `threadSubscription` moves a chat-scope subscription once, with its cursor and no event (`tests/kanban-thread-roots.test.ts`).
- A send in a thread replies to its root, a reply can open a thread, a send that stays in its thread throws rather than move to the chat, and Lark's `thread_id` is read; a group's members are read by union_id, at most 20 pages (`tests/lark-adapter.test.ts`, `tests/lark-cards.test.ts`).
- A fresh task from a group at chat scope is answered in a thread on its command, in the thread's words, the quoted words after any refusal, and held from its creation until the router says where its reply went, on every path (`tests/kanban-thread-chat.test.ts`, `tests/router.test.ts`).
- A person's card goes by the rules of §19.2, with its mention, routed afresh at each try, and records `in` from Lark's answer; the members lookup is cached and bounded, and the missing permission said once (`tests/kanban-thread-cards.test.ts`, `tests/kanban-members.test.ts`, `tests/kanban-chat-render.test.ts`).
- The one line is told for a card sent by direct message, and never for a claim; a thread's notices and approval cards reply to its root (`tests/kanban-notices.test.ts`, `tests/kanban-sink.test.ts`).
- End to end, over the fake channel: a member's thread card, a non-member's direct message, a 230013 falling back to the thread, the task's notices, a follow-up's notices and card, and a supervised role's approval card all in the task's thread, and a task created in a direct message unchanged (`tests/kanban-thread.e2e.ts`).

## Before relying on it: the smoke checklist (spec §19.10)

For the user, once the plan is built and merged, on the real tenant, before `kanban.enabled` is relied on with this build. It uses a scratch group with the bot in it, the user, and one colleague who is in the group (call them Alice) and, for items 3 and 4(b), one who is a member but outside the app's availability (Bob). A task for a person needs no agent. Run `mt` as the gateway's user.

0. **Deploy.** Deploy this build as usual (`npm run build && mt service restart`, or restart `npm run dev`), at first without `im:chat.members:read`, for the first half of item 7. The log says `schema at version 8`. Then, in the Lark developer console, add `im:chat.members:read` to the app's permissions, publish the version, restart, and go on with item 1.
1. **The thread.** In the group, at chat scope, `@bot /kanban task new Smoke: book a room` with `assignee: @Alice`. The bot answers in a thread on that message, "Their card comes in this thread …"; the group's timeline shows only the command and its thread. `mt kanban task show <id>` gives the task; `sqlite3 ~/.manus-team/team.db "SELECT thread_id, root_message_id FROM kanban_subscriptions WHERE task_id='<id>'"` gives the thread's `omt_…` and the command's `om_…`.
2. **The mention.** Alice gets the card in the thread, starting with a mention of her, and is notified, with the group muted too. She presses **Done** with a summary; the card is redrawn, and she is not notified again. "Done: …" comes in the thread.
3. **A member outside the availability.** A task for `@Bob`, who is in the group: by membership his card comes in the thread, mentioning him, and no direct message is tried. He presses **Done**, and the task completes: only his own press can do that, as anyone else's is refused, so the callback carried his `union_id`. (The fallback of a 230013 direct message to the thread is item 4(b)'s, and the end-to-end tests'.)
4. **The uuid across the two APIs.** From the checkout, with the app's id and secret in the environment, run a one-off script (not committed) on the SDK's client, `new Client({ appId, appSecret })`, with one fresh uuid `U`:
   (a) `im.v1.message.create({ params: { receive_id_type: 'union_id' }, data: { receive_id: <Alice's union_id>, msg_type: 'text', content: '{"text":"smoke a"}', uuid: U } })`, then `im.v1.message.reply({ path: { message_id: <item 1's command> }, data: { msg_type: 'text', content: '{"text":"smoke a"}', uuid: U, reply_in_thread: true } })`: is there one message or two, and what does the second answer, its `thread_id` included?
   (b) The same with a second uuid `V`, the create sent to Bob, refused with 230013: does the reply with `V` then appear in the thread?
   (c) The reply of (a) sent again with `U`: what does it answer, its `thread_id` included?
   Write the answers into the spec's §19.10. If (a) gives two messages, a card can show in both places in the case §19.2 names, and nothing else changes; if (b) gives none, each fallback needs a uuid of its own, as §19.2 and §19.4 say, before this build is relied on.
5. **The root.** A notice for the task of item 1 lands in its thread (a reply to the root). For a task created in a thread before this build (no root), a notice still lands in the thread, not at the top of the group.
6. **A withdrawn root.** Withdraw the command message of a task in a thread, then stop the task (`mt kanban task stop <id>`): note what Lark answers (the log), whether the stop's notice lands at the top of the group, and whether the thread lives on. A card due then for that task goes by direct message.
7. **The permission.** Before the permission is added (item 0), the first card in a thread logs `kanban: cards go by direct message: the app lacks im:chat.members:read, which Lark's chat members API needs` once, or, if Lark answers another code, `kanban: the members of chat … could not be read (…)` with it; the card goes by direct message. Once it is added, and the gateway restarted, a member's card goes in the thread, as item 2 shows.
8. **A topic group.** In a topic group, a `/kanban task new` that opens a new topic is answered in that topic, and its card goes there; one typed inside a topic uses that topic.
9. **Clean up.** `mt kanban task archive <id>` for each smoke task.
