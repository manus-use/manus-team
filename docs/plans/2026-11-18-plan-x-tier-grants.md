# Plan X: Tier grants, and `/roles`. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person in, or let them operate, from chat or the terminal, with no id typed and no restart. In chat, `/auth grant @Name talk|operate` stores a grant for the person the @-mention names, with the ids Lark sent; `/auth revoke @Name` or `lark:<union_id>` ends one; `/auth list` says who has a tier, and from where. At the terminal, `mt auth grant|revoke|list`, with `--json`, does the same as the owner, for a person this bot has seen. A grant is a row in a new table, `tier_grants`, counted beside `auth.owner`, `auth.talk` and `auth.operate` at every check, by the gateway and by the terminal, the moment it is written. The owner grants anything, an operator talk only, an agent nothing: `mt auth` refuses every agent's shell, found by a new session marker, `MT_AGENT_SESSION`, which the gateway sets in every agent session, cron on or off. And `/roles` in chat lists the gateway's roles: what each is for, whether it can be given work, where it works, and its open runs against its `max_running`.

**Architecture:**
- **Refactors first, behaviour unchanged** (Tasks 1, 2): the `@` half of the board's mention resolution moves to `src/channel/mentions.ts`; `tiersOf`, one pure rule for a person's two tiers, which the `Authorizer` calls; and where the owner and each list came from, recorded by `loadConfig` as it records `maxRunningFrom`.
- **The store and the rules** (Tasks 3, 4): migration 011 and `src/db/grants.ts`, its only writer, which decides each grant and revoke on the grants it reads inside its own transaction; `decideGrant` and `decideRevoke` in `src/policy/grants.ts`, pure, with the words for every outcome.
- **Grants counted** (Tasks 5 to 7): the `Authorizer` reads a principal's grant at each check through a `GrantReader`, a failed read counting as none; `PeopleDirectory.canTalk` asks by union_id, so the board finds a grant; `TeamSettings` gains the owner, the operate list and their sources, and the terminal's talk check counts grants, a database not yet migrated read as having none.
- **The commands** (Tasks 8 to 10): `/auth` in chat, always on; `mt auth` at the terminal; and the session marker, which only `mt auth` refuses.
- **Lines and `/roles`** (Tasks 11, 12): the startup lines and `mt kanban people`'s `talk_from`; `/roles`, `roleMdFirstLine` reading a checked 8 KiB prefix of `role.md`, and a pure `renderRoles`.
- **The documents** (Task 13): the README, the guide, `config.example.yaml`, and the amendments the spec names for the channel, kanban and cron specs.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`), vitest, better-sqlite3 11, `yaml` 2. No new dependency. One migration, `011_tier_grants.sql`.

**Spec:** `docs/specs/2026-11-18-tier-grants-design.md`, as approved on 2026-11-18, with its amendments for review round 1 and for `/roles`. Below, "§N" is that spec's; "kanban §N", "cron §N" and "channel §N" are the other specs', as it cites them.

---

## Ground rules

- **Where to work.**
  - Use the worktree beside the main checkout, `/Users/x/Develop/manus/prime-gateway-wt2`, on the branch `tier-grants`, which holds this plan, on top of `0284031`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, never reach the real Lark or the network, and never read or write `~/.manus-team`. Every test makes its own home in a temporary directory, its own database and its own roles; the gateway's tests run on the fake Lark channel, and the one that runs `mt auth` as another process runs this build's `mt` against a temporary home.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npx vitest run --project unit` gives `Tests  2555 passed (2555)`. `npx vitest run --project e2e` gives `Tests  172 passed (172)`. `npm run typecheck` reports no errors. The tests of `tests/update-run.test.ts` and the other `mt update` tests, which time detached children, can fail on a loaded or sleeping machine; run the file again alone before looking for a cause.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text is whole lines, and appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given. Every step of this plan was applied in that order, from `0284031`, in a throwaway copy, and gave the counts and failures it states; the plan's own text was then applied in a second fresh copy, which reproduced the first copy's tree byte for byte at the end of every task.
- **One writer.** `db/` modules stay the only writers of a database: `db/grants.ts` writes `tier_grants`, and nothing else does (Task 3 holds it with a test that reads the sources); `db/people.ts` stays the only writer of `people`, which `/auth` notes people in through `PeopleDirectory.saw`. `src/db/WRITERS.md` says so (Tasks 3, 8). `activeGrant`, `activeGrants`, `tierReader`, `talkGrantsMadeBy` and `grantCounts` are reads.
- **Words a person sees** (replies, refusals, `mt` output, the log, the README, the guide and the config example) never name a plan, and do not use the long dash. `/roles` uses the short dash, `–`, for a field with nothing to show, as the spec does.
- **No real agent.** No test runs bytesec.

## Decisions

Each has its reason. Where the code and the spec disagree, the code is the fact, and the decision says which reading keeps the spec's intent; those are listed again under "Where the code forced a reading" below.

1. **`mentionedPerson(name, message)`** (Task 1) returns `{ ok: true, unionId, openId, name }`, the open_id and name of the first mention with that union_id, or `{ ok: false, reason, reply }`, its reply in `#mentioned`'s words, unchanged. `reason` (`not_mentioned`, `no_union_id`, `ambiguous`, and from Task 8 `bot`) lets `/auth` add the direct message's words to the one refusal they belong to. `#personOf`, a workflow param's resolution, keeps its own plain words: the spec moves `#mentioned`'s half only.
2. **`tiersOf(lists, openId, grant)` and `tiersFrom(listed, grant)`** (Task 2): `tiersOf` matches the open_id against the lists, then `tiersFrom` applies §2.1's rule to "in the talk list" and "in the operate list". `decideGrant`, `decideRevoke` and the lists judge a person by `Sources` booleans, so they call `tiersFrom` with the same rule.
3. **`GatewayConfig.auth.from: ListSources`** (Task 2), `{ owner, talk, operate }`, each the file key or the variable in effect; an override set but empty, `MT_ALLOW_TALK=`, is the variable's, as `envList` reads it. `sourceText` words it: `from auth.talk in config.yaml`, or `from MT_ALLOW_TALK`. `TeamSettings.from` is always set (Task 7).
4. **The writer takes the decision as a function** (Task 3): `grantTier(db, req, decide, now)` and `revokeGrant(db, req, decide, now)` read the target's active grant and the actor's (by the union_id in a `lark:` principal; an `operator:` login has none) inside `txImmediate`, call `decide(target, actor)`, and write what its `write` field says: `insert`, `replace` or `none` for a grant, `end` or `none` for a revoke. The writer knows no rule; the decision knows no SQL.
5. **`decideGrant(actor, target, tier)` and `decideRevoke(actor, target)`** (Task 4) take `Actor = 'owner' | 'operator' | 'talk' | 'terminal'`. `talk` is a sender at talk tier alone, refused by the decision itself, inside the transaction, as their tier can come from a grant the owner is revoking. `actorOf(sources, grant)` gives a chat sender's. An operator's own `grant @me talk` and its revoke fall out of the table, as §5.2 says.
6. **The words are one function each**, `grantReply` and `revokeReply` (Task 4), given the names already made safe for where they are said: `label` in chat, `line` at the terminal. In chat they are sentences; at the terminal one line, the clauses joined with `; `, no full stop, as `mt`'s other answers are.
7. **The `Authorizer`'s second argument is `AuthorizerDeps`**, `{ grants?, note?, clock? }` (Task 5): a failed read is said at most once a minute, which needs the log and a clock. `grantOf(unionId)` is the guarded read, public, so the gateway's people callback calls `tiersOf` with it and the configuration's lists, as §4.3 says, and a failing read is caught there too.
8. **`PeopleDeps.canTalk(person: { openId: string | null; unionId: string })`** (Task 6). Every test that built a `PeopleDirectory` with `(openId) => …` is changed to `({ openId }) => openId !== null && …`, which judges exactly as before for a person `people` holds.
9. **The terminal reads grants with the same prepared statement as the gateway**, `tierReader`, when `openBoard` finds a `tier_grants` table; with none, a function that finds no grant (Task 7). The check that looks for the table is the statement `openBoard` already prepares for the board's own table.
10. **`/auth`** (Task 8) is `AuthChat.run(arg, message)`, synchronous, as the database is. The verb is the first word; `list` takes nothing more, `grant`'s last word is the tier, `revoke` takes the rest. `help`, nothing, an unknown word, `list` with words after it, and a person who is neither an @-mention nor, for a revoke, `lark:<union_id>`, are answered with the usage. The router's `case 'auth'` masks the reply, notes a throw masked and answers "The tiers could not be read or changed: …", one line, as `/kanban`'s throw is; with no `auth` dependency, "The tiers cannot be listed or changed here."
11. **A grant's reply names its undoing by principal**: "Carol Wu now has talk tier, granted by Alice. `/auth revoke lark:on_c3a9f1` takes it back." (Task 4). A name in a code span would show `label`'s escapes as written, and the principal still works once the person has left the chat.
12. **`/auth list`** (Task 8) is built by `tierEntries(lists, grants, people)` in `src/policy/grants.ts`, pure, which `mt auth list` uses too: one entry a person, a configuration entry named by the person `people` holds with its open_id, sorted owner, operators, talk, then `auth.operate` without talk, each by name. Lines: `Owner: Alice (lark:on_a), from auth.owner in config.yaml`; `Dan (lark:on_d): operate, granted by Alice on 2026-11-18; talk also from auth.talk in config.yaml`; an unseen entry by its open_id with `; not seen by this bot yet`. At most 50, then "and N more: `mt auth list` at the terminal lists everyone".
13. **`mt auth`** (Task 9) loads `TeamSettings` with `withGatewayFile`'s environment, opens the database only once it exists and holds `tier_grants`, and refuses with the codes of §6.2. `--json`'s `tier` is the person's tier after the command: a talk grant to a person in `auth.operate` alone gives `"operate"`. `mt auth list` with no owner lists the grants alone, saying so on stderr, rather than being refused: §6.2 refuses only `grant` and `revoke` for it.
14. **`MT_AGENT_SESSION`** is `SESSION_MARKER` in `src/kanban/gates.ts`, beside `gateEnv`, which drops it (Task 10), so `src/index.ts` and `src/cli/update.ts` take it from there without importing `src/cli/`. `sessionEnv(sessionId, env)` in `src/index.ts`, pure, is what the registry's `envFor` returns: what the dispatcher, the scheduler or the cron tokens give, and the marker, always the session's own id. `inAgentSession(env)` in `src/cli/gate.ts` is `inAgentRun` or the marker; only `mt auth` asks it. `runShellRefusal` names the marker when no agent variable is set.
15. **`grantLines(counts)`** (Task 11) gives the startup lines, pure, from `grantCounts`, after the schema line. `SeenPerson.talkFrom` is `'config'`, `'grant'` or null, the configuration winning when both give it; the table's column stays `talk` or `no`.
16. **`roleMdFirstLine(path)`** (Task 12) lstat's the path, opens it with `O_NOFOLLOW`, checks the open file is regular, and reads 8192 bytes at most. A prefix is cut only when it filled and the file is longer; then a partial UTF-8 character at its end is dropped (`wholeUtf8`), and a first line that is the prefix's last piece gives undefined, as does a file with no line. `^#+\s*` is stripped from the trimmed line, and a line that is only `#`s counts as empty.
17. **`renderRoles(roles, { firstLine, running, boardOn })`** (Task 12) asks `firstLine` only for a role whose `roleMdPath` was set at the start, so a `role.md` added since shows `–`. `rolesReply(db, roles, kanban)`, beside it in `src/core/roles-chat.ts`, composes it with `roleMdFirstLine`, `openAgentRunCountAs` and `roleLimit`, so its count is tested on a real database; `src/index.ts` passes `() => rolesReply(db, team.roles, config.kanban)`.

## Known limitations

From §12 and §13.8, kept as they say: the terminal is trusted, and an agent is held off `mt auth` only by its shell's variables; with cron off a chat agent's shell can still run the other operator commands, a gate or a cron script among them, whose `mt auth` is an operator's; the terminal judges by its own read of the configuration; a grant needs a union_id; grants are per bot; a grant is gateway-wide and never expires; an admitted turn runs to its end after a revoke; a terminal's grant is announced nowhere and is not in the gateway's log; a revoked operator's grants stay; no history command; going back before 011 drops every grant with the backup; `/roles`' fields are the start's but `role.md`'s line; what a role is for is shown to talk tier in any chat; the running count is a moment's; "can be given work" speaks for the board and cron; no per-board view. Besides:

- **A mention with a union_id but no open_id is refused for a grant**, as `tier_grants.open_id` is required; Lark sends both for a person in practice.
- **The startup lines are checked by `createGateway` without a start** (`tests/gateway-startup.test.ts`), as the schema line is, not by a gateway that connects.
- **A board run's marker is checked by `sessionEnv`'s unit test**, as no test runs a board run through `createGateway`; a chat session's, cron off and on, and a fire's are checked through it (`tests/auth-gateway.e2e.ts`, `tests/cron-gateway.e2e.ts`).

## Where the code forced a reading

- **Migration 010 does not set `schema_version`**, which 001 to 009 each set; it stayed at 9. Migration 011 sets it to 11, as the spec's SQL says, and `tests/kanban-boards-schema.test.ts`, which read 9 there, now reads 11 (Task 3).
- **`config.example.yaml` has no `description` comment, and the README no `description` row**: a role's `description` is in its own `roles/<name>/config.yaml`, which neither documents key by key. The warning that `/roles` shows it to talk tier goes in `config.example.yaml` above the `agent:` block, which stands in for the role `default` and has no description, and in the README after its example of a role's `config.yaml` (Task 13).
- **Logging a failed grant read once a minute needs a log and a clock**, so the `Authorizer` takes `AuthorizerDeps` with the `GrantReader` in it, not the reader alone (Decision 7).
- **`grantOf` is the `Authorizer`'s**: §4.3 has the gateway's people callback call `tiersOf` with "the `GrantReader`'s `tierOf`"; it calls `tiersOf` with `authorizer.grantOf`, the same reader behind the same guard, so a failing read never throws out of the board's people check (Decision 7).
- **A grant's reply names `/auth revoke lark:<union_id>`**, not `/auth revoke @Carol`: the reply escapes names with `label`, and an escaped name inside a code span shows its backslashes (Decision 11).
- **A talk-tier sender is an actor** that the decision refuses (Decision 5): §5.1's table has the row, and the decision is the one place that reads the actor's tier inside the transaction.
- **The lists name a source as `sourceText` does everywhere**, "from auth.owner in config.yaml", where §8.1's example has "from config.yaml": §5.1 asks every reply that names a list to name the one in effect.
- **`MentionRefusal` gains `bot` in Task 8, checked after "not mentioned" and before the union_id**: a bot's mention comes with no union_id, and would otherwise be refused for that.
- **The missing database is `not_migrated`** at `mt auth`, "there is no database at …: the gateway creates it when it first starts", as `mt cron` says it: §6.2's codes have no `no_board`.
- **The card poster's refusal of a revoked assignee is the card poster's existing test** of a person without talk tier (`tests/kanban-cards.test.ts`), with `PeopleDirectory.canTalk` now finding and losing a grant (`tests/people-grants.test.ts`); nothing in `CardPoster` changes.
- **A cron fire writes no `kanban_runs` row**, so `/roles`' count leaves it out with no code of its own; the test writes a running fire of the role and sees the count unchanged.
- **`openBoard`'s people stay undefined without an owner**, grants or not: a terminal with no owner cannot tell what the configuration gives (§6.2), and `peopleMissing` already says why.
- **`/help` needs no edit of its own**: it renders `COMMANDS`, which Tasks 8 and 12 extend.

## File map

| File | Responsibility |
|---|---|
| `src/channel/mentions.ts` (create) | `mentionedPerson`, `MentionRefusal` (Tasks 1, 8) |
| `src/kanban/chat.ts` (modify) | `#mentioned` calls `mentionedPerson` (Task 1) |
| `src/policy/auth.ts` (modify) | `tiersOf`, `tiersFrom`, `sourcesOf`, `GrantReader`, `AuthorizerDeps`; `Authorizer.isOwner`, `.sourcesOf`, `.grantOf`; `reconfigure`'s comment (Tasks 2, 5) |
| `src/config.ts` (modify) | `ListSources`, `sourceText`, `auth.from`; `TeamSettings.owner`, `.operate`, `.from`; `operateOf` (Tasks 2, 7) |
| `schema/011_tier_grants.sql` (create) | `tier_grants` and its two indexes (Task 3) |
| `src/db/grants.ts` (create) | `grantTier`, `revokeGrant`, `activeGrant`, `tierReader`, `activeGrants`, `talkGrantsMadeBy`, `grantCounts` (Task 3) |
| `src/db/WRITERS.md` (modify) | `tier_grants`' row; `people`'s noted for `/auth` (Tasks 3, 8) |
| `src/policy/grants.ts` (create) | `actorOf`, `decideGrant`, `decideRevoke`, `grantReply`, `revokeReply`; `tierEntries` (Tasks 4, 8) |
| `src/index.ts` (modify) | the `GrantReader`; the people callback; `PeopleDirectory` and `AuthChat` always; `sessionEnv`; `grantLines`; `/roles` (Tasks 5, 6, 8, 10, 11, 12) |
| `src/kanban/people.ts` (modify) | `PeopleDeps.canTalk(person)` (Task 6) |
| `src/cli/gate.ts` (modify) | the terminal's grants in `openBoard`; `inAgentSession`; `runShellRefusal`'s marker; `SeenPerson.talkFrom` (Tasks 6, 7, 10, 11) |
| `src/types.ts`, `src/channel/lark/inbound.ts` (modify) | `InboundMention.isBot`, read from `mentioned_type` (Task 8) |
| `src/policy/auth-chat.ts` (create) | `AuthChat`: `/auth` (Task 8) |
| `src/core/commands.ts`, `src/core/router.ts` (modify) | `auth` and `roles`; their cases, `AUTH_OFF`, `ROLES_OFF` (Tasks 8, 12) |
| `src/cli/auth.ts` (create), `src/cli/mt.ts` (modify) | `mt auth`, its usage and its refusal in an agent's shell (Tasks 9, 10) |
| `src/kanban/gates.ts`, `src/cli/update.ts` (modify) | `SESSION_MARKER`, dropped from a gate's, a script's and `mt update`'s children's environments (Task 10) |
| `src/cli/operator.ts` (modify) | `mt kanban people --json`'s `talk_from` (Task 11) |
| `src/roles.ts` (modify) | `roleMdFirstLine`, `wholeUtf8`, `ROLE_MD_PREFIX_BYTES`, `ROLE_MD_UNREADABLE` (Task 12) |
| `src/core/roles-chat.ts` (create) | `renderRoles`, `rolesReply`, `ROLES_MAX` (Task 12) |
| `README.md`, `config.example.yaml`, `docs/kanban-guide.md`, `docs/specs/2026-08-21-lark-channel-design.md`, `docs/specs/2026-11-02-kanban-design.md`, `docs/specs/2026-11-16-cron-design.md` (modify) | the documents and the amendments (Task 13) |
| `tests/mentions.test.ts`, `tests/tiers.test.ts`, `tests/grants-writer.test.ts`, `tests/grants-policy.test.ts`, `tests/auth-grants.test.ts`, `tests/people-grants.test.ts`, `tests/team-settings-grants.test.ts`, `tests/auth-chat.test.ts`, `tests/mt-auth.test.ts`, `tests/auth-gateway.e2e.ts`, `tests/session-marker.test.ts`, `tests/roles-chat.test.ts` (create) | |
| `tests/cron-schema.test.ts`, `tests/gateway-startup.test.ts`, `tests/kanban-boards-schema.test.ts`, `tests/kanban-schema.test.ts`, `tests/kanban-thread-roots.test.ts`, `tests/kanban-workflow-schema.test.ts`, `tests/kanban-worktree-schema.test.ts`, `tests/people.test.ts`, `tests/kanban-board-chat.test.ts`, `tests/kanban-chat.test.ts`, `tests/kanban-chat.e2e.ts`, `tests/kanban-people.e2e.ts`, `tests/kanban-thread-chat.test.ts`, `tests/kanban-thread.e2e.ts`, `tests/kanban-workflow-chat.test.ts`, `tests/kanban-workflow.e2e.ts`, `tests/config.test.ts`, `tests/lark-inbound.test.ts`, `tests/router.test.ts`, `tests/commands.test.ts`, `tests/fakes/cli-agent.mjs`, `tests/cron-gateway.e2e.ts`, `tests/mt-service.test.ts`, `tests/mt-update-apply.test.ts`, `tests/mt-kanban-people.test.ts`, `tests/docs-examples.test.ts` (modify) | the schema's version, `PeopleDeps`' new shape, `TeamSettings`' new fields, the new commands, the marker, `talk_from`, the startup lines, the examples |

Running counts, unit then end to end: Task 1 2558 / 172, Task 2 2562 / 172, Task 3 2572 / 172, Task 4 2579 / 172, Task 5 2585 / 172, Task 6 2588 / 172, Task 7 2592 / 172, Task 8 2614 / 172, Task 9 2623 / 173, Task 10 2628 / 173, Task 11 2630 / 173, Task 12 2642 / 173, Task 13 2644 / 173.

How the spec's tests (§11, §13.7) map to the tasks: `tiersOf` (Task 2); `decideGrant` and `decideRevoke` (Task 4); the writer (Task 3); the `Authorizer` (Task 5); `/auth` (Task 8); the router (Task 8, and Task 12 for `/roles`); the board (Tasks 6, 7); the marker (Task 10); sources (Tasks 2, 7, 8, 9); `mt auth` (Task 9, its agent's shell Task 10); `mt kanban people` (Task 11); end to end (Task 9, the marker Task 10); the startup line (Task 11); docs (Task 13); `roleMdFirstLine`, `renderRoles`, the count and `/roles` in the router (Task 12).

---

### Task 1: `src/channel/mentions.ts`: the mention resolution, moved

**Files:**

- Create: `src/channel/mentions.ts`, `tests/mentions.test.ts`
- Modify: `src/kanban/chat.ts`

§6.1. The `@` half of `KanbanChat.#mentioned` moves to `mentionedPerson(name, message)`, which `/auth` will call too, so the two cannot drift. It gives the mention's open_id beside its union_id, which a grant records, and names why it refused, in the same words as before. `#mentioned` keeps the `lark:` branch and calls it. Nothing else changes: `/kanban`'s tests pass as they are.

- [ ] **Step 1.1: Write the tests.**

Create `tests/mentions.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mentionedPerson } from '../src/channel/mentions.js';
import type { InboundMention, InboundMessage } from '../src/types.js';

/**
 * `mentionedPerson` (the tier grants spec §6.1): the `@` half of the board's
 * mention resolution, moved out of `KanbanChat` so `/auth` resolves a mention
 * as `/kanban` does, with the same three refusals in the same words, and the
 * mention's open_id beside its union_id.
 */

function message(mentions: InboundMention[] | undefined): InboundMessage {
  return {
    messageId: 'om_1',
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: '',
    sender: { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' },
    senderIsBot: false,
    text: '/kanban task new x',
    mentionedBot: true,
    mentionAll: false,
    ...(mentions === undefined ? {} : { mentions }),
    attachments: [],
    createTime: 1,
  };
}

const CAROL: InboundMention = { key: '@_user_1', name: 'Carol Wu', openId: 'ou_carol', unionId: 'on_carol' };

describe('mentionedPerson', () => {
  it('finds the person by the name the text shows, or by the key, with both ids', () => {
    expect(mentionedPerson('@Carol Wu', message([CAROL]))).toEqual({ ok: true, unionId: 'on_carol', openId: 'ou_carol', name: 'Carol Wu' });
    expect(mentionedPerson('@_user_1', message([CAROL]))).toEqual({ ok: true, unionId: 'on_carol', openId: 'ou_carol', name: 'Carol Wu' });
    // The same person mentioned twice is one person.
    expect(mentionedPerson('@Carol Wu', message([CAROL, { ...CAROL, key: '@_user_2' }]))).toMatchObject({ ok: true, unionId: 'on_carol' });
  });

  it('refuses someone the message does not mention, a mention with no union_id, and two people of one name', () => {
    expect(mentionedPerson('@Dan', message([CAROL]))).toEqual({
      ok: false,
      reason: 'not_mentioned',
      reply: '@Dan is not someone this message mentions: type @ and pick them, so Lark says who they are.',
    });
    expect(mentionedPerson('@Dan', message(undefined))).toMatchObject({ ok: false, reason: 'not_mentioned' });
    expect(mentionedPerson('@Carol Wu', message([{ ...CAROL, unionId: null }]))).toEqual({
      ok: false,
      reason: 'no_union_id',
      reply: 'Lark did not say who @Carol Wu is (no union_id came with the mention). Ask the operator to check the app can read user ids.',
    });
    expect(mentionedPerson('@Carol Wu', message([CAROL, { ...CAROL, key: '@_user_2', unionId: 'on_other' }]))).toEqual({
      ok: false,
      reason: 'ambiguous',
      reply: 'More than one person mentioned is called @Carol Wu; say which with `lark:<union_id>`.',
    });
  });

  it('escapes the name it quotes, and the board calls it rather than keeping a copy', () => {
    expect(mentionedPerson('@a_b*', message([]))).toMatchObject({ reply: expect.stringContaining('@a\\_b\\*') });
    const chat = readFileSync(new URL('../src/kanban/chat.ts', import.meta.url), 'utf8');
    expect(chat).toContain("from '../channel/mentions.js'");
    expect(chat).not.toContain('is not someone this message mentions: type @ and pick them, so Lark says who they are.`');
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mentions.test.ts`. Expected: `Test Files  1 failed (1)` and `Tests  no tests`, as `Error: Cannot find module '../src/channel/mentions.js' imported from …/tests/mentions.test.ts`.

- [ ] **Step 1.3: Implement.**

In `src/kanban/chat.ts`, replace:

```ts
import { forDisplay } from '../channel/escape.js';
```

with:

```ts
import { forDisplay } from '../channel/escape.js';
import { mentionedPerson } from '../channel/mentions.js';
```

In `src/kanban/chat.ts`, replace:

```ts
  /** A person's principal: typed out, or the @-mention's, by the ids Lark sent with the message. */
  #mentioned(name: string, message: InboundMessage): Named {
    if (!name.startsWith('@')) return { ok: true, name: `lark:${name.slice('lark:'.length)}` };
    const shown = name.slice(1).trim();
    const found = (message.mentions ?? []).filter((m) => m.name === shown || m.key === name);
    const unionIds = [...new Set(found.map((m) => m.unionId).filter((u): u is string => u !== null))];
    if (found.length === 0) {
      return {
        ok: false,
        reply: `${label(name, 80)} is not someone this message mentions: type @ and pick them, so Lark says who they are.`,
      };
    }
    if (unionIds.length === 0) {
      return {
        ok: false,
        reply: `Lark did not say who ${label(name, 80)} is (no union_id came with the mention). Ask the operator to check the app can read user ids.`,
      };
    }
    if (unionIds.length > 1) {
      return { ok: false, reply: `More than one person mentioned is called ${label(name, 80)}; say which with \`lark:<union_id>\`.` };
    }
    return { ok: true, name: personPrincipal(unionIds[0] ?? '') };
```

with:

```ts
  /** A person's principal: typed out, or the @-mention's, by the ids Lark sent with the message (`mentionedPerson`). */
  #mentioned(name: string, message: InboundMessage): Named {
    if (!name.startsWith('@')) return { ok: true, name: `lark:${name.slice('lark:'.length)}` };
    const found = mentionedPerson(name, message);
    return found.ok ? { ok: true, name: personPrincipal(found.unionId) } : { ok: false, reply: found.reply };
```

Create `src/channel/mentions.ts`:

```ts
import { label } from '../kanban/chat-render.js';
import type { InboundMessage } from '../types.js';

/**
 * A person named in chat by @-mention (kanban spec §9.1, the tier grants spec
 * §6.1): found among the message's mentions by the name Lark's text shows, or
 * by the mention's key, so there is no name to resolve or confuse. `/kanban`
 * and `/auth` both resolve a mention here, so the two cannot come to read one
 * differently; a typed `lark:<union_id>` stays with each caller.
 */

/** Why a mention named no one person. */
export type MentionRefusal = 'not_mentioned' | 'no_union_id' | 'ambiguous';

/** The person an `@Name` stands for, as Lark gave them with the message; or a refusal, in words for chat. */
export type Mentioned =
  | { ok: true; unionId: string; openId: string | null; name: string | null }
  | { ok: false; reason: MentionRefusal; reply: string };

/**
 * The person `name`, an `@Name`, stands for: the one person among the
 * message's mentions shown by that name, with the union_id and open_id Lark
 * sent. Refused when the message mentions no one by it, when Lark gave no
 * union_id with the mention, and when more than one person is shown by it.
 */
export function mentionedPerson(name: string, message: InboundMessage): Mentioned {
  const shown = name.slice(1).trim();
  const found = (message.mentions ?? []).filter((m) => m.name === shown || m.key === name);
  const unionIds = [...new Set(found.map((m) => m.unionId).filter((u): u is string => u !== null))];
  if (found.length === 0) {
    return {
      ok: false,
      reason: 'not_mentioned',
      reply: `${label(name, 80)} is not someone this message mentions: type @ and pick them, so Lark says who they are.`,
    };
  }
  const unionId = unionIds[0];
  if (unionId === undefined) {
    return {
      ok: false,
      reason: 'no_union_id',
      reply: `Lark did not say who ${label(name, 80)} is (no union_id came with the mention). Ask the operator to check the app can read user ids.`,
    };
  }
  if (unionIds.length > 1) {
    return { ok: false, reason: 'ambiguous', reply: `More than one person mentioned is called ${label(name, 80)}; say which with \`lark:<union_id>\`.` };
  }
  const mention = found.find((m) => m.unionId === unionId);
  return { ok: true, unionId, openId: mention?.openId ?? null, name: mention?.name ?? null };
}
```

- [ ] **Step 1.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2558 passed (2558)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.5: Commit.**

```bash
git add src/channel/mentions.ts src/kanban/chat.ts tests/mentions.test.ts
git commit -m "Move the board's @-mention resolution to src/channel/mentions.ts, giving the mention's open_id beside its union_id and naming why a mention was refused, so chat's other commands resolve a mention as /kanban does"
```

---

### Task 2: `tiersOf`, and where each list came from

**Files:**

- Create: `tests/tiers.test.ts`
- Modify: `src/policy/auth.ts`, `src/config.ts`

§2.1, §5.1. One pure rule for a person's two tiers, `tiersOf(lists, openId, grant)`, which `Authorizer.canTalk` and `canOperate` call with no grant yet, so their behaviour is unchanged. `loadConfig` records where the owner and each list came from, as it records `maxRunningFrom`, in `auth.from`, and `sourceText` says it as a reply will.

- [ ] **Step 2.1: Write the tests.**

Create `tests/tiers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, sourceText, type Env } from '../src/config.js';
import { Authorizer, defaultAuthConfig, tiersOf } from '../src/policy/auth.js';
import type { Tier } from '../src/types.js';

/**
 * `tiersOf` (the tier grants spec §2.1): one rule for a person's two tiers,
 * from the configuration's lists by open_id and their active grant; and
 * where each list came from (§5.1), as `loadConfig` records it.
 */

const LISTS = { allowTalk: ['ou_owner', 'ou_talk', 'ou_both'], allowOperate: ['ou_owner', 'ou_both', 'ou_op_only'] };

describe('tiersOf', () => {
  it('gives talk by the talk list or any grant, and operate by talk with the operate list or an operate grant', () => {
    const rows: Array<[string | null, Tier | undefined, boolean, boolean]> = [
      ['ou_owner', undefined, true, true],
      ['ou_talk', undefined, true, false],
      ['ou_talk', 'talk', true, false],
      ['ou_talk', 'operate', true, true],
      ['ou_both', undefined, true, true],
      ['ou_both', 'talk', true, true],
      // In auth.operate alone: no tier, until a grant of talk makes them an operator.
      ['ou_op_only', undefined, false, false],
      ['ou_op_only', 'talk', true, true],
      ['ou_op_only', 'operate', true, true],
      ['ou_none', undefined, false, false],
      ['ou_none', 'talk', true, false],
      ['ou_none', 'operate', true, true],
      // A person people does not hold matches no list, and is judged by the grant alone.
      [null, undefined, false, false],
      [null, 'talk', true, false],
      [null, 'operate', true, true],
    ];
    for (const [openId, grant, talk, operate] of rows) {
      expect(tiersOf(LISTS, openId, grant), JSON.stringify({ openId, grant })).toEqual({ talk, operate });
    }
  });

  it("is the Authorizer's rule, which has no grants yet", () => {
    const a = new Authorizer({ ...defaultAuthConfig('ou_owner'), ...LISTS });
    for (const openId of ['ou_owner', 'ou_talk', 'ou_both', 'ou_op_only', 'ou_none']) {
      const p = { openId, unionId: `on_${openId}`, displayName: null };
      expect({ talk: a.canTalk(p), operate: a.canOperate(p) }, openId).toEqual(tiersOf(LISTS, openId, undefined));
    }
  });
});

describe("where the configuration's lists came from", () => {
  const BASE: Env = { MT_HOME: '/var/lib/mt', MT_WORKSPACE: '/srv/repo', MT_AGENT_COMMAND: 'bytesec', LARK_APP_ID: 'cli_app', LARK_APP_SECRET: 's' };
  const file = (): string => 'auth:\n  owner: ou_owner\n  talk: [ou_a]\n  operate: [ou_a]\n';

  it('names the file key, or the variable that overrides it, an empty one included', () => {
    expect(loadConfig(BASE, file).auth.from).toEqual({ owner: 'auth.owner', talk: 'auth.talk', operate: 'auth.operate' });
    expect(loadConfig({ ...BASE, MT_OWNER_OPEN_ID: 'ou_boss', MT_ALLOW_TALK: '', MT_ALLOW_OPERATE: 'ou_b' }, file).auth.from).toEqual({
      owner: 'MT_OWNER_OPEN_ID',
      talk: 'MT_ALLOW_TALK',
      operate: 'MT_ALLOW_OPERATE',
    });
    // A blank owner variable is unset, as ownerOf reads it.
    expect(loadConfig({ ...BASE, MT_OWNER_OPEN_ID: ' ' }, file).auth.from.owner).toBe('auth.owner');
  });

  it('says a file key with the file, and a variable alone', () => {
    expect(sourceText('auth.talk')).toBe('from auth.talk in config.yaml');
    expect(sourceText('MT_ALLOW_TALK')).toBe('from MT_ALLOW_TALK');
    expect(sourceText('auth.owner')).toBe('from auth.owner in config.yaml');
  });
});
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/tiers.test.ts`. Expected: `Tests  4 failed (4)`; among the failures, `TypeError: (0 , tiersOf) is not a function`.

- [ ] **Step 2.3: Implement.**

In `src/config.ts`, replace:

```ts
    allowMentionAll: boolean;
```

with:

```ts
    allowMentionAll: boolean;
    /** Where the owner and the two lists came from, as a reply names them (tier grants spec §5.1). */
    from: ListSources;
```

In `src/config.ts`, replace:

```ts
export type SessionLimitSource = 'MT_MAX_LIVE_SESSIONS' | 'maxLiveSessions';

```

with:

```ts
export type SessionLimitSource = 'MT_MAX_LIVE_SESSIONS' | 'maxLiveSessions';

/**
 * Where the owner and each tier list came from (tier grants spec §5.1): the
 * file's key, or the variable that overrides it, as `maxRunningFrom` records
 * the session limit's. A reply names the one in effect, so an operator with an
 * override set is not pointed at a file whose list is not the one in use.
 */
export interface ListSources {
  owner: 'auth.owner' | 'MT_OWNER_OPEN_ID';
  talk: 'auth.talk' | 'MT_ALLOW_TALK';
  operate: 'auth.operate' | 'MT_ALLOW_OPERATE';
}

/** A list's source as a reply says it: `from auth.talk in config.yaml`, or `from MT_ALLOW_TALK`. */
export function sourceText(source: ListSources[keyof ListSources]): string {
  return source.startsWith('auth.') ? `from ${source} in config.yaml` : `from ${source}`;
}

```

In `src/config.ts`, replace:

```ts
      allowMentionAll: envFlag(env, 'MT_ALLOW_MENTION_ALL') ?? file.auth.mentionAll ?? false,
```

with:

```ts
      allowMentionAll: envFlag(env, 'MT_ALLOW_MENTION_ALL') ?? file.auth.mentionAll ?? false,
      from: listSources(env),
```

In `src/config.ts`, replace:

```ts
/** The chats the gateway acts in, `MT_ALLOW_CHATS` else `auth.chats`; empty for any. */
```

with:

```ts
/** Which of the owner and the two lists the environment overrides: `ownerOf`'s, `talkOf`'s and `MT_ALLOW_OPERATE`'s precedence. */
function listSources(env: Env): ListSources {
  return {
    owner: envString(env, 'MT_OWNER_OPEN_ID') === undefined ? 'auth.owner' : 'MT_OWNER_OPEN_ID',
    talk: envList(env, 'MT_ALLOW_TALK') === undefined ? 'auth.talk' : 'MT_ALLOW_TALK',
    operate: envList(env, 'MT_ALLOW_OPERATE') === undefined ? 'auth.operate' : 'MT_ALLOW_OPERATE',
  };
}

/** The chats the gateway acts in, `MT_ALLOW_CHATS` else `auth.chats`; empty for any. */
```

In `src/policy/auth.ts`, replace:

```ts
const OK: Decision = { ok: true };
```

with:

```ts
/** The configuration's two lists, by open_id, with the owner in both (`loadConfig`). */
export interface TierLists {
  allowTalk: readonly string[];
  allowOperate: readonly string[];
}

/** A person's two tiers. */
export interface Tiers {
  talk: boolean;
  operate: boolean;
}

/**
 * A person's tiers (tier grants spec §2.1), from the configuration's lists and
 * their active grant, if any: talk when the open_id is in `allowTalk` or there
 * is a grant of either tier; operate when they have talk and the open_id is in
 * `allowOperate` or the grant is operate. An open_id of null, a person `people`
 * does not hold, matches no list.
 *
 * One function, which the gateway's `Authorizer` and the terminal both call, so
 * the two cannot come to disagree about who has a tier.
 */
export function tiersOf(lists: TierLists, openId: string | null, grant: Tier | undefined): Tiers {
  return tiersFrom(
    { talk: openId !== null && lists.allowTalk.includes(openId), operate: openId !== null && lists.allowOperate.includes(openId) },
    grant,
  );
}

/**
 * `tiersOf`'s rule, given whether the person is in each list. A grant of
 * operate gives talk too: operate needs talk, and an operate grant that left
 * talk to the configuration would be dead for a person in no list.
 */
export function tiersFrom(listed: { talk: boolean; operate: boolean }, grant: Tier | undefined): Tiers {
  const talk = listed.talk || grant !== undefined;
  return { talk, operate: talk && (listed.operate || grant === 'operate') };
}

const OK: Decision = { ok: true };
```

In `src/policy/auth.ts`, replace:

```ts
    return this.#config.allowTalk.includes(principal.openId);
```

with:

```ts
    return tiersOf(this.#config, principal.openId, undefined).talk;
```

In `src/policy/auth.ts`, replace:

```ts
    return this.canTalk(principal) && this.#config.allowOperate.includes(principal.openId);
```

with:

```ts
    return tiersOf(this.#config, principal.openId, undefined).operate;
```

- [ ] **Step 2.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2562 passed (2562)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.5: Commit.**

```bash
git add src/config.ts src/policy/auth.ts tests/tiers.test.ts
git commit -m "Give a person's tiers by one rule, tiersOf, which the Authorizer calls, and record where the owner and each tier list came from, as maxRunningFrom records the session limit's"
```

---

### Task 3: Migration 011 and `db/grants.ts`

**Files:**

- Create: `schema/011_tier_grants.sql`, `src/db/grants.ts`, `tests/grants-writer.test.ts`
- Modify: `src/db/WRITERS.md`, `tests/cron-schema.test.ts`, `tests/gateway-startup.test.ts`, `tests/kanban-boards-schema.test.ts`, `tests/kanban-schema.test.ts`, `tests/kanban-thread-roots.test.ts`, `tests/kanban-workflow-schema.test.ts`, `tests/kanban-worktree-schema.test.ts`

§3. `tier_grants` exactly as §3.1 gives it, and its only writer: `grantTier` and `revokeGrant`, each one `txImmediate` that reads the target's and the actor's active grants and writes what the decision it is given says (Decision 4); and the reads. The tests that name the schema's version move from 10 to 11. Nothing reads a grant yet.

- [ ] **Step 3.1: Write the tests.**

In `tests/cron-schema.test.ts`, replace:

```ts
  it('is version 10, with both tables STRICT and their indexes', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(10);
```

with:

```ts
  it('is migrated past version 10, with both tables STRICT and their indexes', () => {
    // 011 adds tier_grants.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(11);
```

In `tests/cron-schema.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(10);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(11);
```

In `tests/gateway-startup.test.ts`, replace:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 10 (${config.dbPath})\n`))).toBe(true);
```

with:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 11 (${config.dbPath})\n`))).toBe(true);
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
    expect(migrate(db, SCHEMA_DIR)).toBe(10);
```

with:

```ts
    expect(migrate(db, SCHEMA_DIR)).toBe(11);
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 9 });
```

with:

```ts
    // 010 left the row at 9; 011 sets it again.
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 11 });
```

In `tests/kanban-schema.test.ts`, replace:

```ts
    // 009 the workflows' two tables.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(10);
```

with:

```ts
    // 009 the workflows' two tables, 010 cron's, 011 tier_grants.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(11);
```

In `tests/kanban-thread-roots.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(10);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(11);
```

In `tests/kanban-workflow-schema.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(10);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(11);
```

In `tests/kanban-worktree-schema.test.ts`, replace:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(10);
```

with:

```ts
        expect(migrate(d, SCHEMA_DIR)).toBe(11);
```

Create `tests/grants-writer.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeGrant,
  activeGrants,
  grantCounts,
  grantTier,
  revokeGrant,
  talkGrantsMadeBy,
  tierReader,
  type GrantRequest,
  type GrantRow,
  type GrantWrite,
  type RevokeWrite,
} from '../src/db/grants.js';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { notePerson, personOf } from '../src/db/people.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * Migration 011 and its writer (the tier grants spec §3): every check, the one
 * active grant a person, a replace and a revoke each in one transaction, the
 * decision made on the reads inside it, and rows never deleted.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const APP = 'cli_app';
const OWNER = { by: 'operator:alice', via: 'terminal' as const, chat: null };

function row(extra: Record<string, unknown> = {}): void {
  const r = {
    app_id: APP,
    union_id: 'on_carol',
    open_id: 'ou_carol',
    tier: 'talk',
    granted_by: 'lark:on_alice',
    granted_via: 'chat',
    granted_chat: 'oc_team',
    granted_at: NOW,
    ...extra,
  };
  h.db.prepare(`INSERT INTO tier_grants (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r));
}

const always = <W extends GrantWrite | RevokeWrite>(write: W) => () => ({ write });

function grant(over: Partial<GrantRequest> = {}, write: GrantWrite = 'insert', at = NOW): GrantRow[] {
  return grantTier(h.db, { appId: APP, unionId: 'on_carol', openId: 'ou_carol', tier: 'talk', ...OWNER, ...over }, always(write), at).written;
}

const count = (): number => (h.db.prepare('SELECT count(*) AS n FROM tier_grants').get() as { n: number }).n;

describe('migration 011', () => {
  it('is version 11, STRICT, with its two indexes', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(11);
    expect(h.db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'tier_grants'").get()).toEqual({ strict: 1 });
    const indexes = h.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tier_grants' AND name LIKE 'idx_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(['idx_tier_grants_active', 'idx_tier_grants_person']);
  });

  it('checks the tier, the via, the chat with each via, and an end written whole', () => {
    row();
    const ended = { revoked_at: NOW, revoked_by: 'lark:on_alice', revoked_via: 'chat', revoked_chat: 'oc_team', ended: 'revoked' };
    row({ union_id: 'on_a', ...ended });
    row({ union_id: 'on_b', granted_via: 'terminal', granted_chat: null, ...ended, revoked_via: 'terminal', revoked_chat: null });
    for (const bad of [
      { tier: 'admin' },
      { granted_via: 'phone' },
      { granted_chat: null },
      { granted_via: 'terminal' },
      { revoked_at: NOW },
      { ...ended, revoked_by: null },
      { ...ended, revoked_via: null, revoked_chat: null },
      { ...ended, ended: null },
      { ...ended, ended: 'expired' },
      { ...ended, revoked_chat: null },
      { ...ended, revoked_via: 'terminal' },
      { ended: 'revoked' },
    ]) {
      expect(() => row({ union_id: 'on_bad', ...bad }), JSON.stringify(bad)).toThrow(/CHECK constraint failed/);
    }
    expect(() => row({ union_id: 'on_bad', granted_at: 'now' })).toThrow(/cannot store TEXT value in INTEGER column/);
  });

  it('holds one active grant a person a bot, whatever writes it', () => {
    row();
    expect(() => row({ tier: 'operate' })).toThrow(/UNIQUE constraint failed/);
    row({ app_id: 'cli_other' });
    row({ union_id: 'on_dan' });
    row({ revoked_at: NOW, revoked_by: 'x', revoked_via: 'terminal', ended: 'revoked' });
  });

  it('migrates a database at version 10, with people and a board in it, as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-grants-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) if (/^0(0[1-9]|10)_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(10);
        const task = newTask(d);
        notePerson(d, { appId: APP, unionId: 'on_carol', openId: 'ou_carol', name: 'Carol' }, NOW);
        const before = { task: getTask(d, task.taskId), person: personOf(d, APP, 'on_carol') };
        expect(migrate(d, SCHEMA_DIR)).toBe(11);
        expect({ task: getTask(d, task.taskId), person: personOf(d, APP, 'on_carol') }).toEqual(before);
        expect(d.prepare('SELECT count(*) AS n FROM tier_grants').get()).toEqual({ n: 0 });
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('grantTier and revokeGrant', () => {
  it('inserts a grant as asked, and nothing for a decision that writes none', () => {
    expect(grant({}, 'none')).toEqual([]);
    expect(count()).toBe(0);
    const [made] = grant({ by: 'lark:on_alice', via: 'chat', chat: 'oc_team' });
    expect(made).toEqual({
      grantId: expect.any(Number),
      appId: APP,
      unionId: 'on_carol',
      openId: 'ou_carol',
      tier: 'talk',
      grantedBy: 'lark:on_alice',
      grantedVia: 'chat',
      grantedChat: 'oc_team',
      grantedAt: NOW,
      revokedAt: null,
      revokedBy: null,
      revokedVia: null,
      revokedChat: null,
      ended: null,
    });
    expect(activeGrant(h.db, APP, 'on_carol')).toEqual(made);
    expect(activeGrant(h.db, 'cli_other', 'on_carol')).toBeUndefined();
  });

  it('replaces a talk grant with an operate one in one transaction, the end taking the new grant\'s actor and time', () => {
    grant({ by: 'lark:on_bob', via: 'chat', chat: 'oc_team' });
    const written = grant({ tier: 'operate' }, 'replace', NOW + 5);
    expect(written.map((g) => [g.tier, g.ended, g.revokedAt, g.revokedBy, g.revokedVia, g.revokedChat])).toEqual([
      ['talk', 'replaced', NOW + 5, 'operator:alice', 'terminal', null],
      ['operate', null, null, null, null, null],
    ]);
    expect(written[1]?.grantedAt).toBe(NOW + 5);
    expect(activeGrant(h.db, APP, 'on_carol')?.tier).toBe('operate');
    // A replace with no talk grant to end writes nothing at all.
    expect(() => grant({ unionId: 'on_dan' }, 'replace')).toThrow(/needs an active talk grant/);
    expect(count()).toBe(2);
  });

  it('ends a grant once, and a second revoke finds nothing to end; rows are never deleted', () => {
    grant();
    const decided: Array<GrantRow | undefined> = [];
    const revoke = (write: RevokeWrite) =>
      revokeGrant(h.db, { appId: APP, unionId: 'on_carol', by: 'lark:on_bob', via: 'chat', chat: 'oc_x' }, (target) => {
        decided.push(target);
        return { write: target === undefined ? 'none' : write };
      }, NOW + 9);
    const first = revoke('end');
    expect(first.written).toEqual([expect.objectContaining({ ended: 'revoked', revokedAt: NOW + 9, revokedBy: 'lark:on_bob', revokedVia: 'chat', revokedChat: 'oc_x' })]);
    expect(revoke('end').written).toEqual([]);
    expect(decided.map((t) => t?.tier)).toEqual(['talk', undefined]);
    expect(activeGrant(h.db, APP, 'on_carol')).toBeUndefined();
    // Made again, a new row.
    grant();
    expect(count()).toBe(2);
    expect(h.db.prepare('SELECT grant_id FROM tier_grants ORDER BY grant_id').all()).toHaveLength(2);
  });

  it("decides on the reads made inside its transaction: a revoke another connection committed is seen", () => {
    grant({ unionId: 'on_bob', openId: 'ou_bob', tier: 'operate' });
    // The caller read the actor's grant before; another process revokes it.
    expect(activeGrant(h.db, APP, 'on_bob')?.tier).toBe('operate');
    const other = openDb(join(h.dir, 'team.db'));
    try {
      revokeGrant(other, { appId: APP, unionId: 'on_bob', ...OWNER }, always('end'), NOW + 1);
    } finally {
      other.close();
    }
    const seen: Array<[GrantRow | undefined, GrantRow | undefined]> = [];
    const r = grantTier(
      h.db,
      { appId: APP, unionId: 'on_carol', openId: 'ou_carol', tier: 'talk', by: 'lark:on_bob', via: 'chat', chat: 'oc_team' },
      (target, actor) => {
        seen.push([target, actor]);
        return { write: actor === undefined ? ('none' as const) : ('insert' as const) };
      },
      NOW + 2,
    );
    expect(seen).toEqual([[undefined, undefined]]);
    expect(r.written).toEqual([]);
    // An operator's login has no grant to read.
    grantTier(h.db, { appId: APP, unionId: 'on_carol', openId: 'ou_carol', tier: 'talk', ...OWNER }, (_t, actor) => {
      expect(actor).toBeUndefined();
      return { write: 'none' as const };
    }, NOW);
  });
});

describe('the reads', () => {
  it("give a grant's tier by the prepared reader, the active grants with names, the talk grants a person made, and the counts", () => {
    notePerson(h.db, { appId: APP, unionId: 'on_carol', openId: 'ou_carol', name: 'Carol' }, NOW);
    grant({ by: 'lark:on_dan' });
    grant({ unionId: 'on_erin', openId: 'ou_erin', by: 'lark:on_dan' });
    grant({ unionId: 'on_dan', openId: 'ou_dan', tier: 'operate' });
    grant({ appId: 'cli_old', unionId: 'on_x', openId: 'ou_x' });
    grant({ appId: 'cli_old', unionId: 'on_y', openId: 'ou_y', tier: 'operate' });
    revokeGrant(h.db, { appId: APP, unionId: 'on_erin', ...OWNER }, always('end'), NOW);

    const tierOf = tierReader(h.db, APP);
    expect([tierOf('on_carol'), tierOf('on_dan'), tierOf('on_erin'), tierOf('on_x')]).toEqual(['talk', 'operate', undefined, undefined]);
    expect(activeGrants(h.db, APP).map((g) => [g.unionId, g.tier, g.name])).toEqual([
      ['on_carol', 'talk', 'Carol'],
      ['on_dan', 'operate', null],
    ]);
    expect(talkGrantsMadeBy(h.db, APP, 'lark:on_dan')).toBe(1);
    expect(talkGrantsMadeBy(h.db, APP, 'lark:on_carol')).toBe(0);
    expect(grantCounts(h.db, APP)).toEqual({ talk: 1, operate: 1, otherApps: 2 });
    expect(grantCounts(h.db, 'cli_none')).toEqual({ talk: 0, operate: 0, otherApps: 4 });
  });

  it('are the only writer of tier_grants', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const writers = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && /(INSERT INTO|UPDATE|DELETE FROM) tier_grants/.test(readFileSync(join(src, f), 'utf8')),
    );
    expect(writers).toEqual([join('db', 'grants.ts')]);
    expect(readFileSync(new URL('../src/db/WRITERS.md', import.meta.url), 'utf8')).toMatch(/\| `tier_grants` \| `db\/grants\.ts` \|/);
  });
});
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/cron-schema.test.ts tests/gateway-startup.test.ts tests/grants-writer.test.ts tests/kanban-boards-schema.test.ts tests/kanban-schema.test.ts tests/kanban-thread-roots.test.ts tests/kanban-workflow-schema.test.ts tests/kanban-worktree-schema.test.ts`. Expected: `Test Files  8 failed (8)` and `Tests  8 failed | 47 passed (55)`; `tests/grants-writer.test.ts` fails to load, `Error: Cannot find module '../src/db/grants.js' imported from …/tests/grants-writer.test.ts`, and among the failures, `AssertionError: expected 10 to be 11 // Object.is equality`.

- [ ] **Step 3.3: Implement.**

In `src/db/WRITERS.md`, replace:

```markdown
| `people` | `db/people.ts` | One row per person per bot (migration 005): the open_id and name Lark last gave with a union_id, noted when a person sends a `/kanban` command, is mentioned in one, or presses a board card's button. How a person named by `lark:<union_id>` alone is checked for talk tier (spec §4.2). |
```

with:

```markdown
| `people` | `db/people.ts` | One row per person per bot (migration 005): the open_id and name Lark last gave with a union_id, noted when a person sends a `/kanban` command, is mentioned in one, or presses a board card's button. How a person named by `lark:<union_id>` alone is checked for talk tier (spec §4.2). |
| `tier_grants` | `db/grants.ts` | Added by `grantTier` (migration 011), which reads the target's and the actor's active grants inside its transaction and writes what the decision it is given makes of them, so an actor whose own grant was revoked a moment before is judged without it (tier grants spec §3.2). `revoked_at`, `revoked_by`, `revoked_via`, `revoked_chat` and `ended` are written once, together, on an active row: by `revokeGrant`, `revoked`, or by `grantTier` for a talk grant an operate grant replaces, `replaced`, taking the operate grant's actor and time, in the transaction that inserts it. At most one active row a person, by the unique index. Never deleted, never re-opened: a grant made again is a new row. Nothing in it is free text, so nothing is masked. The gateway's `/auth` and the terminal's `mt auth` both write it, through these two. |
```

Create `schema/011_tier_grants.sql`:

```sql
-- manus-team migration 011: tier grants
-- See docs/specs/2026-11-18-tier-grants-design.md §3.
--
-- A grant gives a person talk or operate tier beside the configuration's
-- lists, made in chat by @-mention or at the terminal, keyed by the bot and
-- the person's union_id. A row is one grant and its one end, never deleted and
-- never re-opened, so the table is the audit trail. At most one active grant a
-- person. db/grants.ts is the only writer (src/db/WRITERS.md).
CREATE TABLE tier_grants (
  grant_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT NOT NULL,                      -- this bot's, as people's
  union_id      TEXT NOT NULL,                      -- the person: lark:<union_id>
  open_id       TEXT NOT NULL,                      -- as Lark gave it with the grant; a record, never matched
  tier          TEXT NOT NULL CHECK (tier IN ('talk', 'operate')),
  granted_by    TEXT NOT NULL,                      -- lark:<union_id> or operator:<login>
  granted_via   TEXT NOT NULL CHECK (granted_via IN ('chat', 'terminal')),
  granted_chat  TEXT,                               -- the chat it was made in; null at the terminal
  granted_at    INTEGER NOT NULL,                   -- unix ms
  revoked_at    INTEGER,
  revoked_by    TEXT,
  revoked_via   TEXT CHECK (revoked_via IN ('chat', 'terminal')),
  revoked_chat  TEXT,
  ended         TEXT CHECK (ended IN ('revoked', 'replaced')),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_via IS NULL)),
  CHECK ((revoked_at IS NULL) = (ended IS NULL)),
  CHECK ((granted_via = 'chat') = (granted_chat IS NOT NULL)),
  CHECK ((revoked_via IS 'chat') = (revoked_chat IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX idx_tier_grants_active ON tier_grants(app_id, union_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_tier_grants_person ON tier_grants(app_id, union_id, grant_id);

UPDATE schema_version SET version = 11;
```

Create `src/db/grants.ts`:

```ts
import type { Tier } from '../types.js';
import type { Db } from './open.js';
import { txImmediate } from './open.js';

/**
 * Tier grants (migration 011, the tier grants spec §3): a person given talk or
 * operate tier by a row, beside the configuration's lists, keyed by this bot's
 * app id and the person's union_id. The only writer of `tier_grants`
 * (src/db/WRITERS.md).
 *
 * A row is one grant and its one end: a revocation writes the `revoked_*`
 * columns and `ended` once, on an active row, and a grant made again is a new
 * row, so the table is the audit trail. At most one active grant a person, as
 * the unique index holds: an operate grant to a person with a talk grant ends
 * it `replaced`, in the transaction that inserts the operate one.
 *
 * Every write decides inside its transaction, on the target's and the actor's
 * active grants read there: the actor's own tier can come from a grant the
 * owner is revoking at the same moment, from chat or from another process.
 */

export type Via = 'chat' | 'terminal';

export interface GrantRow {
  grantId: number;
  appId: string;
  unionId: string;
  /** As Lark gave it with the grant: a record of whom it was made for, never matched on. */
  openId: string;
  tier: Tier;
  /** `lark:<union_id>` or `operator:<login>`. */
  grantedBy: string;
  grantedVia: Via;
  /** The chat it was made in; null at the terminal. */
  grantedChat: string | null;
  grantedAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  revokedVia: Via | null;
  revokedChat: string | null;
  ended: 'revoked' | 'replaced' | null;
}

/** An active grant, with the name `people` last holds for its person, for the lists. */
export interface NamedGrant extends GrantRow {
  name: string | null;
}

interface GrantRaw {
  grant_id: number;
  app_id: string;
  union_id: string;
  open_id: string;
  tier: Tier;
  granted_by: string;
  granted_via: Via;
  granted_chat: string | null;
  granted_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  revoked_via: Via | null;
  revoked_chat: string | null;
  ended: 'revoked' | 'replaced' | null;
}

const COLUMNS =
  'g.grant_id, g.app_id, g.union_id, g.open_id, g.tier, g.granted_by, g.granted_via, g.granted_chat, g.granted_at, ' +
  'g.revoked_at, g.revoked_by, g.revoked_via, g.revoked_chat, g.ended';

function rowOf(r: GrantRaw): GrantRow {
  return {
    grantId: r.grant_id,
    appId: r.app_id,
    unionId: r.union_id,
    openId: r.open_id,
    tier: r.tier,
    grantedBy: r.granted_by,
    grantedVia: r.granted_via,
    grantedChat: r.granted_chat,
    grantedAt: r.granted_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
    revokedVia: r.revoked_via,
    revokedChat: r.revoked_chat,
    ended: r.ended,
  };
}

/** Who asks for a grant or a revoke: their principal, how, and the chat when in one. */
export interface Actor {
  by: string;
  via: Via;
  chat: string | null;
}

export interface GrantRequest extends Actor {
  appId: string;
  unionId: string;
  openId: string;
  tier: Tier;
}

export interface RevokeRequest extends Actor {
  appId: string;
  unionId: string;
}

/** What a decision asks of `grantTier`: a new grant, an operate grant in place of a talk one, or nothing. */
export type GrantWrite = 'insert' | 'replace' | 'none';

/** What a decision asks of `revokeGrant`: the target's active grant ended, or nothing. */
export type RevokeWrite = 'end' | 'none';

/** The target's and the actor's active grants, as read inside the transaction. */
export type Decide<D> = (target: GrantRow | undefined, actor: GrantRow | undefined) => D;

/** The union_id in an actor's principal, when it is a person's: an operator's login has no grant. */
function actorUnionId(by: string): string | undefined {
  return by.startsWith('lark:') && by.length > 'lark:'.length ? by.slice('lark:'.length) : undefined;
}

function active(db: Db, appId: string, unionId: string | undefined): GrantRow | undefined {
  if (unionId === undefined) return undefined;
  const r = db
    .prepare<[string, string], GrantRaw>(`SELECT ${COLUMNS} FROM tier_grants g WHERE g.app_id = ? AND g.union_id = ? AND g.revoked_at IS NULL`)
    .get(appId, unionId);
  return r === undefined ? undefined : rowOf(r);
}

function byId(db: Db, grantId: number): GrantRow {
  const r = db.prepare<[number], GrantRaw>(`SELECT ${COLUMNS} FROM tier_grants g WHERE g.grant_id = ?`).get(grantId);
  if (r === undefined) throw new Error(`grant ${grantId} is not in tier_grants`);
  return rowOf(r);
}

/** End an active grant, once: the `revoked_*` columns and `ended` together. */
function end(db: Db, grantId: number, who: Actor, ended: 'revoked' | 'replaced', now: number): void {
  const r = db
    .prepare(
      `UPDATE tier_grants SET revoked_at = ?, revoked_by = ?, revoked_via = ?, revoked_chat = ?, ended = ?
        WHERE grant_id = ? AND revoked_at IS NULL`,
    )
    .run(now, who.by, who.via, who.chat, ended, grantId);
  if (r.changes !== 1) throw new Error(`grant ${grantId} is not active`);
}

/**
 * Grant `req.tier` to a person: inside one transaction, the target's and the
 * actor's active grants are read, `decide` is given them, and its answer is
 * written: a new grant, or the target's talk grant ended `replaced` and an
 * operate one inserted, with the same time and actor, or nothing for a no-op
 * or a refusal. Returns the decision and the rows written, in order.
 */
export function grantTier<D extends { write: GrantWrite }>(
  db: Db,
  req: GrantRequest,
  decide: Decide<D>,
  now: number,
): { decision: D; written: GrantRow[] } {
  return txImmediate(db, (d) => {
    const target = active(d, req.appId, req.unionId);
    const decision = decide(target, active(d, req.appId, actorUnionId(req.by)));
    if (decision.write === 'none') return { decision, written: [] };
    const written: GrantRow[] = [];
    let tier = req.tier;
    if (decision.write === 'replace') {
      if (target === undefined || target.tier !== 'talk') throw new Error(`a replace needs an active talk grant for ${req.unionId}`);
      end(d, target.grantId, req, 'replaced', now);
      written.push(byId(d, target.grantId));
      tier = 'operate';
    }
    const id = d
      .prepare(
        `INSERT INTO tier_grants (app_id, union_id, open_id, tier, granted_by, granted_via, granted_chat, granted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.appId, req.unionId, req.openId, tier, req.by, req.via, req.chat, now).lastInsertRowid;
    written.push(byId(d, Number(id)));
    return { decision, written };
  });
}

/**
 * Revoke a person's active grant: inside one transaction, the same two grants
 * are read and given to `decide`, and the target's grant is ended `revoked`
 * when it says so. Returns the decision and the row ended, if any.
 */
export function revokeGrant<D extends { write: RevokeWrite }>(
  db: Db,
  req: RevokeRequest,
  decide: Decide<D>,
  now: number,
): { decision: D; written: GrantRow[] } {
  return txImmediate(db, (d) => {
    const target = active(d, req.appId, req.unionId);
    const decision = decide(target, active(d, req.appId, actorUnionId(req.by)));
    if (decision.write === 'none') return { decision, written: [] };
    if (target === undefined) throw new Error(`there is no active grant for ${req.unionId} to end`);
    end(d, target.grantId, req, 'revoked', now);
    return { decision, written: [byId(d, target.grantId)] };
  });
}

/** This bot's active grant for the person with this union_id, by the unique index; undefined with none. */
export function activeGrant(db: Db, appId: string, unionId: string): GrantRow | undefined {
  return active(db, appId, unionId);
}

/**
 * The tier of this bot's active grant for a union_id, with its statement
 * prepared once: what the gateway's `Authorizer` reads at each check.
 */
export function tierReader(db: Db, appId: string): (unionId: string) => Tier | undefined {
  const statement = db.prepare<[string, string], { tier: Tier }>(
    'SELECT tier FROM tier_grants WHERE app_id = ? AND union_id = ? AND revoked_at IS NULL',
  );
  return (unionId) => statement.get(appId, unionId)?.tier;
}

/** This bot's active grants, each with the name `people` last holds for its person, oldest first. */
export function activeGrants(db: Db, appId: string): NamedGrant[] {
  return db
    .prepare<[string], GrantRaw & { name: string | null }>(
      `SELECT ${COLUMNS}, p.name AS name FROM tier_grants g
         LEFT JOIN people p ON p.app_id = g.app_id AND p.union_id = g.union_id
        WHERE g.app_id = ? AND g.revoked_at IS NULL ORDER BY g.grant_id`,
    )
    .all(appId)
    .map((r) => ({ ...rowOf(r), name: r.name }));
}

/** The talk grants a principal made that are still active: what a revoked operator leaves behind (tier grants spec §6.1). */
export function talkGrantsMadeBy(db: Db, appId: string, by: string): number {
  const row = db
    .prepare<[string, string], { n: number }>(
      "SELECT count(*) AS n FROM tier_grants WHERE app_id = ? AND granted_by = ? AND tier = 'talk' AND revoked_at IS NULL",
    )
    .get(appId, by);
  return row?.n ?? 0;
}

/**
 * Active grants by tier for this bot, and the active grants under any other
 * app id, which count for nothing here: the startup line's (tier grants spec §8.4).
 */
export function grantCounts(db: Db, appId: string): { talk: number; operate: number; otherApps: number } {
  const rows = db
    .prepare<[string], { mine: number; tier: Tier; n: number }>(
      `SELECT app_id = ? AS mine, tier, count(*) AS n FROM tier_grants WHERE revoked_at IS NULL GROUP BY mine, tier`,
    )
    .all(appId);
  const count = (mine: number, tier?: Tier): number =>
    rows.filter((r) => r.mine === mine && (tier === undefined || r.tier === tier)).reduce((n, r) => n + r.n, 0);
  return { talk: count(1, 'talk'), operate: count(1, 'operate'), otherApps: count(0) };
}
```

- [ ] **Step 3.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2572 passed (2572)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.5: Commit.**

```bash
git add schema/011_tier_grants.sql src/db/WRITERS.md src/db/grants.ts tests/cron-schema.test.ts tests/gateway-startup.test.ts tests/grants-writer.test.ts tests/kanban-boards-schema.test.ts tests/kanban-schema.test.ts tests/kanban-thread-roots.test.ts tests/kanban-workflow-schema.test.ts tests/kanban-worktree-schema.test.ts
git commit -m "Add migration 011, tier_grants, a row a grant and its one end with at most one active grant a person, and db/grants.ts, its only writer, which decides each grant and revoke on the grants read inside its transaction"
```

---

### Task 4: `decideGrant` and `decideRevoke`

**Files:**

- Create: `src/policy/grants.ts`, `tests/grants-policy.test.ts`

§5. Who may grant and revoke what, as two pure functions over the actor and the target's sources and grant, in §5.2's order, and the reply for every outcome, in chat's words and the terminal's (Decisions 5, 6, 11). The tests are tables: every actor against every kind of target. Nothing calls them yet.

- [ ] **Step 4.1: Write the tests.**

Create `tests/grants-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ListSources } from '../src/config.js';
import {
  actorOf,
  decideGrant,
  decideRevoke,
  grantReply,
  revokeReply,
  type Actor,
  type Held,
  type Sources,
  type Target,
  type Words,
} from '../src/policy/grants.js';
import type { Tier } from '../src/types.js';

/**
 * Who may grant and revoke what (the tier grants spec §5), as tables: every
 * actor against every kind of target, each outcome and its words, granting
 * and revoking yourself included.
 */

const NONE: Sources = { owner: false, talk: false, operate: false };
const GRANT = (tier: Tier): Held => ({ tier, by: 'lark:on_alice', at: Date.UTC(2026, 10, 18, 2) });

const TARGETS: Record<string, Target> = {
  owner: { sources: { owner: true, talk: true, operate: true }, grant: undefined },
  configTalk: { sources: { ...NONE, talk: true }, grant: undefined },
  configOperate: { sources: { ...NONE, talk: true, operate: true }, grant: undefined },
  operateOnly: { sources: { ...NONE, operate: true }, grant: undefined },
  talkGrant: { sources: NONE, grant: GRANT('talk') },
  operateGrant: { sources: NONE, grant: GRANT('operate') },
  none: { sources: NONE, grant: undefined },
};

const FROM: ListSources = { owner: 'auth.owner', talk: 'auth.talk', operate: 'auth.operate' };

function words(via: Words['via'] = 'chat', from: ListSources = FROM): Words {
  return { via, who: 'Carol', principal: 'lark:on_c', by: 'Bob', from, held: (g) => `${g.by === 'lark:on_alice' ? 'Alice' : g.by} on 2026-11-18` };
}

describe('actorOf', () => {
  it('is the owner, an operator by the configuration or by a grant, or talk', () => {
    expect(actorOf({ owner: true, talk: true, operate: true }, undefined)).toBe('owner');
    expect(actorOf({ ...NONE, talk: true, operate: true }, undefined)).toBe('operator');
    expect(actorOf(NONE, 'operate')).toBe('operator');
    expect(actorOf({ ...NONE, operate: true }, 'talk')).toBe('operator');
    expect(actorOf({ ...NONE, talk: true }, 'talk')).toBe('talk');
    expect(actorOf({ ...NONE, operate: true }, undefined)).toBe('talk');
  });
});

describe('decideGrant', () => {
  it('decides every actor and target, for talk and for operate', () => {
    const actors: Actor[] = ['owner', 'operator', 'terminal', 'talk'];
    const table: Record<string, Record<Tier, Record<Actor, string>>> = {
      owner: { talk: { owner: 'already owner', operator: 'already owner', terminal: 'already owner', talk: 'refused not_operator' }, operate: { owner: 'already owner', operator: 'already owner', terminal: 'already owner', talk: 'refused not_operator' } },
      configTalk: { talk: { owner: 'already config talk', operator: 'already config talk', terminal: 'already config talk', talk: 'refused not_operator' }, operate: { owner: 'granted operate', operator: 'refused operate_is_owners', terminal: 'granted operate', talk: 'refused not_operator' } },
      configOperate: { talk: { owner: 'already config operate', operator: 'already config operate', terminal: 'already config operate', talk: 'refused not_operator' }, operate: { owner: 'already config operate', operator: 'already config operate', terminal: 'already config operate', talk: 'refused not_operator' } },
      operateOnly: { talk: { owner: 'granted talk', operator: 'refused operate_listed', terminal: 'granted talk', talk: 'refused not_operator' }, operate: { owner: 'granted operate', operator: 'refused operate_is_owners', terminal: 'granted operate', talk: 'refused not_operator' } },
      talkGrant: { talk: { owner: 'already grant talk', operator: 'already grant talk', terminal: 'already grant talk', talk: 'refused not_operator' }, operate: { owner: 'replaced operate', operator: 'refused operate_is_owners', terminal: 'replaced operate', talk: 'refused not_operator' } },
      operateGrant: { talk: { owner: 'already grant operate', operator: 'already grant operate', terminal: 'already grant operate', talk: 'refused not_operator' }, operate: { owner: 'already grant operate', operator: 'already grant operate', terminal: 'already grant operate', talk: 'refused not_operator' } },
      none: { talk: { owner: 'granted talk', operator: 'granted talk', terminal: 'granted talk', talk: 'refused not_operator' }, operate: { owner: 'granted operate', operator: 'refused operate_is_owners', terminal: 'granted operate', talk: 'refused not_operator' } },
    };
    for (const [name, target] of Object.entries(TARGETS)) {
      for (const tier of ['talk', 'operate'] as const) {
        for (const actor of actors) {
          const d = decideGrant(actor, target, tier);
          const got =
            d.outcome === 'refused' ? `refused ${d.code}` : d.outcome === 'already' ? (d.from === 'owner' ? 'already owner' : `already ${d.from} ${d.tier}`) : `${d.outcome} ${d.tier}`;
          expect(got, `${actor} grants ${name} ${tier}`).toBe(table[name]?.[tier][actor]);
          expect(d.write, `${actor} grants ${name} ${tier}`).toBe(d.outcome === 'granted' ? 'insert' : d.outcome === 'replaced' ? 'replace' : 'none');
        }
      }
    }
  });

  it('lets nobody raise their own tier: an operator granting themselves talk has it already', () => {
    // An operator by configuration, and one by grant, granting themselves.
    expect(decideGrant('operator', TARGETS['configOperate'] as Target, 'talk')).toMatchObject({ outcome: 'already', tier: 'operate' });
    expect(decideGrant('operator', TARGETS['operateGrant'] as Target, 'operate')).toMatchObject({ outcome: 'already', tier: 'operate' });
  });
});

describe('decideRevoke', () => {
  it('decides every actor and target', () => {
    const table: Record<string, Record<Actor, string>> = {
      owner: { owner: 'refused is_owner', operator: 'refused is_owner', terminal: 'refused is_owner', talk: 'refused not_operator' },
      configTalk: { owner: 'refused from_config', operator: 'refused from_config', terminal: 'refused from_config', talk: 'refused not_operator' },
      configOperate: { owner: 'refused from_config', operator: 'refused from_config', terminal: 'refused from_config', talk: 'refused not_operator' },
      operateOnly: { owner: 'no_grant', operator: 'no_grant', terminal: 'no_grant', talk: 'refused not_operator' },
      talkGrant: { owner: 'revoked talk', operator: 'revoked talk', terminal: 'revoked talk', talk: 'refused not_operator' },
      operateGrant: { owner: 'revoked operate', operator: 'refused operate_grant_is_owners', terminal: 'revoked operate', talk: 'refused not_operator' },
      none: { owner: 'no_grant', operator: 'no_grant', terminal: 'no_grant', talk: 'refused not_operator' },
    };
    for (const [name, target] of Object.entries(TARGETS)) {
      for (const actor of ['owner', 'operator', 'terminal', 'talk'] as const) {
        const d = decideRevoke(actor, target);
        const got = d.outcome === 'refused' ? `refused ${d.code}` : d.outcome === 'revoked' ? `revoked ${d.grant}` : d.outcome;
        expect(got, `${actor} revokes ${name}`).toBe(table[name]?.[actor]);
        expect(d.write).toBe(d.outcome === 'revoked' ? 'end' : 'none');
      }
    }
  });

  it("keeps what the configuration gives, ends an owner's leftover grant, and leaves an operator by configuration's talk grant to the owner", () => {
    expect(decideRevoke('operator', { sources: { ...NONE, talk: true }, grant: GRANT('talk') })).toEqual({ write: 'end', outcome: 'revoked', grant: 'talk', left: 'talk', owner: false });
    expect(decideRevoke('owner', { sources: { ...NONE, talk: true, operate: true }, grant: GRANT('operate') })).toMatchObject({ left: 'operate' });
    expect(decideRevoke('operator', { sources: { owner: true, talk: true, operate: true }, grant: GRANT('talk') })).toEqual({ write: 'end', outcome: 'revoked', grant: 'talk', left: 'operate', owner: true });
    // In auth.operate, talk by grant: revoking it unmakes an operator, the owner's to do, the operator's own included.
    const operateListed: Target = { sources: { ...NONE, operate: true }, grant: GRANT('talk') };
    expect(decideRevoke('operator', operateListed)).toMatchObject({ outcome: 'refused', code: 'operate_listed' });
    expect(decideRevoke('owner', operateListed)).toEqual({ write: 'end', outcome: 'revoked', grant: 'talk', left: null, owner: false });
    expect(decideRevoke('terminal', operateListed)).toMatchObject({ outcome: 'revoked' });
  });
});

describe('the words', () => {
  const grantSays = (actor: Actor, target: string, tier: Tier, w = words()): string => {
    const t = TARGETS[target] as Target;
    return grantReply(decideGrant(actor, t, tier), t, w);
  };
  const revokeSays = (actor: Actor, target: Target, w = words(), made = 0): string => revokeReply(decideRevoke(actor, target), target, w, made);

  it('say each grant outcome, in chat and at the terminal', () => {
    expect(grantSays('owner', 'none', 'talk')).toBe('Carol now has talk tier, granted by Bob. `/auth revoke lark:on_c` takes it back.');
    expect(grantSays('terminal', 'none', 'operate', words('terminal'))).toBe('Carol now has operate tier, granted by Bob; mt auth revoke lark:on_c takes it back');
    expect(grantSays('owner', 'talkGrant', 'operate')).toBe('Carol now has operate tier, in place of talk, granted by Bob. `/auth revoke lark:on_c` takes it back.');
    expect(grantSays('operator', 'owner', 'talk')).toBe('Carol is the owner, who has both tiers always.');
    expect(grantSays('operator', 'configTalk', 'talk')).toBe('Carol already has talk tier, from auth.talk in config.yaml.');
    expect(grantSays('operator', 'configTalk', 'talk', words('chat', { ...FROM, talk: 'MT_ALLOW_TALK' }))).toBe('Carol already has talk tier, from MT_ALLOW_TALK.');
    expect(grantSays('operator', 'talkGrant', 'talk')).toBe('Carol already has talk tier, by a grant from Alice on 2026-11-18.');
    expect(grantSays('owner', 'operateGrant', 'talk')).toBe(
      'Carol already has operate tier, by a grant from Alice on 2026-11-18, which includes talk. To leave them talk alone, the owner revokes and grants talk again.',
    );
    expect(grantSays('owner', 'configOperate', 'talk')).toBe('Carol already has operate tier, from auth.operate in config.yaml, which includes talk.');
    expect(grantSays('owner', 'operateGrant', 'operate')).toBe('Carol already has operate tier, by a grant from Alice on 2026-11-18.');
    expect(grantSays('talk', 'none', 'talk')).toBe('`/auth grant` needs operator permission: an operator grants talk tier, and the owner operate.');
    expect(grantSays('operator', 'none', 'operate')).toBe('Only the owner grants operate tier: an operator cannot make another operator.');
    expect(grantSays('operator', 'operateOnly', 'talk', words('chat', { ...FROM, operate: 'MT_ALLOW_OPERATE' }))).toBe(
      "Carol is in MT_ALLOW_OPERATE, so talk tier would make them an operator, which is the owner's to grant.",
    );
  });

  it('say each revoke outcome, with what is left and the grants a revoked operator made', () => {
    expect(revokeSays('operator', TARGETS['talkGrant'] as Target)).toBe('Carol no longer has talk tier: revoked by Bob.');
    expect(revokeSays('operator', { sources: { ...NONE, talk: true }, grant: GRANT('talk') })).toBe(
      'Carol no longer has talk tier: revoked by Bob; they keep talk tier from auth.talk in config.yaml.',
    );
    expect(revokeSays('owner', TARGETS['operateGrant'] as Target, words(), 2)).toBe(
      'Carol no longer has operate tier: revoked by Bob. They made 2 talk grants still in force; `/auth list` shows them.',
    );
    expect(revokeSays('terminal', TARGETS['operateGrant'] as Target, words('terminal'), 1)).toBe(
      'Carol no longer has operate tier: revoked by Bob; they made 1 talk grant still in force; mt auth list shows them',
    );
    expect(revokeSays('owner', TARGETS['operateGrant'] as Target, words(), 0)).toBe('Carol no longer has operate tier: revoked by Bob.');
    expect(revokeSays('owner', { sources: { owner: true, talk: true, operate: true }, grant: GRANT('talk') })).toBe(
      "Carol's talk grant is revoked; they keep both tiers as the owner.",
    );
    expect(revokeSays('owner', TARGETS['none'] as Target)).toBe('Carol has no grant to revoke.');
    expect(revokeSays('talk', TARGETS['talkGrant'] as Target)).toBe('`/auth revoke` needs operator permission.');
    expect(revokeSays('owner', TARGETS['owner'] as Target, words('chat', { ...FROM, owner: 'MT_OWNER_OPEN_ID' }))).toBe(
      'Carol is the owner, from MT_OWNER_OPEN_ID, and cannot be revoked.',
    );
    expect(revokeSays('owner', TARGETS['configTalk'] as Target)).toBe(
      'Carol has talk tier from auth.talk in config.yaml, which chat cannot change: the operator edits it and restarts the gateway.',
    );
    expect(revokeSays('terminal', TARGETS['configOperate'] as Target, words('terminal'))).toBe(
      'Carol has operate tier from auth.operate in config.yaml, which mt auth cannot change: the operator edits it and restarts the gateway',
    );
    expect(revokeSays('operator', TARGETS['operateGrant'] as Target)).toBe('Carol has operate tier by a grant, which only the owner revokes.');
    expect(revokeSays('operator', { sources: { ...NONE, operate: true }, grant: GRANT('talk') })).toBe(
      'Carol is in auth.operate: their talk grant is what makes them an operator, so only the owner revokes it.',
    );
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/grants-policy.test.ts`. Expected: `Test Files  1 failed (1)` and `Tests  no tests`, as `Error: Cannot find module '../src/policy/grants.js' imported from …/tests/grants-policy.test.ts`.

- [ ] **Step 4.3: Implement.**

Create `src/policy/grants.ts`:

```ts
import { sourceText, type ListSources } from '../config.js';
import type { Tier } from '../types.js';
import { tiersFrom } from './auth.js';

/**
 * Who may grant and revoke what (the tier grants spec §5): one pure decision
 * for a grant and one for a revoke, and the words for each outcome, which chat
 * and the terminal both give. `db/grants.ts` runs a decision inside its
 * transaction, on the grants read there, so chat and the terminal cannot judge
 * a case differently, nor on a stale read.
 *
 * The owner grants and revokes anything a grant can hold; an operator, by the
 * configuration or by a grant, talk only, so every operator is one the owner
 * or the configuration made; the terminal as the owner; talk tier nothing.
 * Nothing removes a configuration entry or the owner: a grant only adds.
 */

/** Who asks: the owner, an operator, a person at talk tier alone, or the operator's terminal. */
export type Actor = 'owner' | 'operator' | 'talk' | 'terminal';

/** Whether an open_id is the owner, and whether it is in each of the configuration's lists. */
export interface Sources {
  owner: boolean;
  talk: boolean;
  operate: boolean;
}

/** A person's active grant, as a decision and its words need it. */
export interface Held {
  tier: Tier;
  /** Who made it: `lark:<union_id>` or `operator:<login>`. */
  by: string;
  at: number;
}

/** The person a grant or revoke is for: their configuration's sources, and their active grant, if any. */
export interface Target {
  sources: Sources;
  grant: Held | undefined;
}

/** A sender in chat as an actor: the owner, else an operator by the configuration or a grant, else talk. */
export function actorOf(sources: Sources, grant: Tier | undefined): Actor {
  if (sources.owner) return 'owner';
  return tiersFrom(sources, grant).operate ? 'operator' : 'talk';
}

/** Why a grant was refused. */
export type GrantRefusal = 'not_operator' | 'operate_is_owners' | 'operate_listed';

/** Why a revoke was refused. */
export type RevokeRefusal = 'not_operator' | 'is_owner' | 'from_config' | 'operate_grant_is_owners' | 'operate_listed';

/** Where a tier a person already has comes from: the owner, the configuration, or their grant. */
export type HeldFrom = 'owner' | 'config' | 'grant';

export type GrantDecision =
  | { write: 'insert'; outcome: 'granted'; tier: Tier }
  | { write: 'replace'; outcome: 'replaced'; tier: 'operate' }
  | { write: 'none'; outcome: 'already'; tier: Tier; from: HeldFrom; asked: Tier }
  | { write: 'none'; outcome: 'refused'; code: GrantRefusal };

export type RevokeDecision =
  | { write: 'end'; outcome: 'revoked'; grant: Tier; left: Tier | null; owner: boolean }
  | { write: 'none'; outcome: 'no_grant' }
  | { write: 'none'; outcome: 'refused'; code: RevokeRefusal };

/** The tier a person has, or null for none. */
function tierOf(t: { talk: boolean; operate: boolean }): Tier | null {
  return t.operate ? 'operate' : t.talk ? 'talk' : null;
}

/** Where an operate tier comes from: the configuration when both its lists give it, else the grant. */
function operateFrom(target: Target): HeldFrom {
  return target.grant?.tier === 'operate' && !(target.sources.talk && target.sources.operate) ? 'grant' : 'config';
}

/**
 * Grant `tier` (§5.2), the first case that applies deciding: talk tier alone
 * may grant nothing; the owner already has both; a tier already held is a
 * no-op, talk to an operator included, as operate includes talk; operate is
 * the owner's and the terminal's, in place of a talk grant when there is one;
 * an operator's talk to a person in `auth.operate` alone, which would make
 * them an operator, is refused.
 */
export function decideGrant(actor: Actor, target: Target, tier: Tier): GrantDecision {
  if (actor === 'talk') return { write: 'none', outcome: 'refused', code: 'not_operator' };
  if (target.sources.owner) return { write: 'none', outcome: 'already', tier: 'operate', from: 'owner', asked: tier };
  const now = tiersFrom(target.sources, target.grant?.tier);
  if (now.operate) return { write: 'none', outcome: 'already', tier: 'operate', from: operateFrom(target), asked: tier };
  if (tier === 'talk' && now.talk) {
    return { write: 'none', outcome: 'already', tier: 'talk', from: target.sources.talk ? 'config' : 'grant', asked: tier };
  }
  if (tier === 'operate') {
    if (actor === 'operator') return { write: 'none', outcome: 'refused', code: 'operate_is_owners' };
    return target.grant?.tier === 'talk' ? { write: 'replace', outcome: 'replaced', tier: 'operate' } : { write: 'insert', outcome: 'granted', tier: 'operate' };
  }
  if (actor === 'operator' && target.sources.operate) return { write: 'none', outcome: 'refused', code: 'operate_listed' };
  return { write: 'insert', outcome: 'granted', tier: 'talk' };
}

/**
 * Revoke a person's grant (§5.2), which ends the whole grant: talk tier alone
 * may revoke nothing; the owner cannot be revoked, but a grant left over from
 * before they were the owner ends; with no grant, a configuration's tier is
 * refused and none is a no-op; an operate grant is the owner's to revoke, and
 * so is the talk grant that makes a person in `auth.operate` an operator.
 */
export function decideRevoke(actor: Actor, target: Target): RevokeDecision {
  if (actor === 'talk') return { write: 'none', outcome: 'refused', code: 'not_operator' };
  const grant = target.grant;
  if (grant === undefined) {
    if (target.sources.owner) return { write: 'none', outcome: 'refused', code: 'is_owner' };
    if (tiersFrom(target.sources, undefined).talk) return { write: 'none', outcome: 'refused', code: 'from_config' };
    return { write: 'none', outcome: 'no_grant' };
  }
  if (target.sources.owner) return { write: 'end', outcome: 'revoked', grant: grant.tier, left: 'operate', owner: true };
  if (actor === 'operator' && grant.tier === 'operate') return { write: 'none', outcome: 'refused', code: 'operate_grant_is_owners' };
  if (actor === 'operator' && target.sources.operate && !target.sources.talk) return { write: 'none', outcome: 'refused', code: 'operate_listed' };
  return { write: 'end', outcome: 'revoked', grant: grant.tier, left: tierOf(tiersFrom(target.sources, undefined)), owner: false };
}

/** What a reply needs beside the decision: where it is said, and the names, already made safe to show there. */
export interface Words {
  via: 'chat' | 'terminal';
  /** The person: their name, or their principal. */
  who: string;
  /** Their principal, `lark:<union_id>`, for the command that undoes a grant. */
  principal: string;
  /** Who acted. */
  by: string;
  /** Where the configuration's lists came from. */
  from: ListSources;
  /** A grant's maker and day, as `Alice on 2026-11-18`. */
  held: (grant: Held) => string;
}

/** Clauses as a reply: sentences in chat, one line joined with `; ` at the terminal. */
function say(via: Words['via'], clauses: readonly string[]): string {
  if (via === 'chat') return clauses.map((c) => `${c}.`).join(' ');
  return clauses.map((c, i) => (i === 0 ? c : `${c.charAt(0).toLowerCase()}${c.slice(1)}`)).join('; ');
}

/** A command, as a reply names it: in a code span in chat. */
function command(via: Words['via'], text: string): string {
  return via === 'chat' ? `\`/auth ${text}\`` : `mt auth ${text}`;
}

/** Where the tier a person has comes from, as a no-op says it. */
function heldText(d: { tier: Tier; from: HeldFrom }, target: Target, w: Words): string {
  if (d.from === 'grant' && target.grant !== undefined) return `by a grant from ${w.held(target.grant)}`;
  return sourceText(d.tier === 'operate' ? w.from.operate : w.from.talk);
}

/** A grant's outcome, in the words §5.2 and §6.1 give it. */
export function grantReply(d: GrantDecision, target: Target, w: Words): string {
  switch (d.outcome) {
    case 'granted':
      return say(w.via, [`${w.who} now has ${d.tier} tier, granted by ${w.by}`, `${command(w.via, `revoke ${w.principal}`)} takes it back`]);
    case 'replaced':
      return say(w.via, [`${w.who} now has operate tier, in place of talk, granted by ${w.by}`, `${command(w.via, `revoke ${w.principal}`)} takes it back`]);
    case 'already': {
      if (d.from === 'owner') return say(w.via, [`${w.who} is the owner, who has both tiers always`]);
      const has = `${w.who} already has ${d.tier} tier, ${heldText(d, target, w)}`;
      if (d.asked === 'talk' && d.tier === 'operate') {
        return say(w.via, [
          `${has}, which includes talk`,
          ...(d.from === 'grant' ? ['To leave them talk alone, the owner revokes and grants talk again'] : []),
        ]);
      }
      return say(w.via, [has]);
    }
    case 'refused':
      switch (d.code) {
        case 'not_operator':
          return say(w.via, [`${command(w.via, 'grant')} needs operator permission: an operator grants talk tier, and the owner operate`]);
        case 'operate_is_owners':
          return say(w.via, ['Only the owner grants operate tier: an operator cannot make another operator']);
        case 'operate_listed':
          return say(w.via, [`${w.who} is in ${w.from.operate}, so talk tier would make them an operator, which is the owner's to grant`]);
      }
  }
}

/** A revoke's outcome, in the words §5.2 and §6.1 give it; `made`, for a revoked operate grant, the talk grants its holder made that are still in force. */
export function revokeReply(d: RevokeDecision, target: Target, w: Words, made = 0): string {
  switch (d.outcome) {
    case 'revoked': {
      if (d.owner) return say(w.via, [`${w.who}'s ${d.grant} grant is revoked; they keep both tiers as the owner`]);
      const left = d.left === null ? '' : `; they keep ${d.left} tier ${sourceText(d.left === 'operate' ? w.from.operate : w.from.talk)}`;
      const still =
        d.grant === 'operate' && made > 0
          ? [`They made ${made} talk grant${made === 1 ? '' : 's'} still in force; ${command(w.via, 'list')} shows them`]
          : [];
      return say(w.via, [`${w.who} no longer has ${d.grant} tier: revoked by ${w.by}${left}`, ...still]);
    }
    case 'no_grant':
      return say(w.via, [`${w.who} has no grant to revoke`]);
    case 'refused':
      switch (d.code) {
        case 'not_operator':
          return say(w.via, [`${command(w.via, 'revoke')} needs operator permission`]);
        case 'is_owner':
          return say(w.via, [`${w.who} is the owner, ${sourceText(w.from.owner)}, and cannot be revoked`]);
        case 'from_config': {
          const operate = target.sources.operate && target.sources.talk;
          const tier = operate ? `operate tier ${sourceText(w.from.operate)}` : `talk tier ${sourceText(w.from.talk)}`;
          const who = w.via === 'chat' ? 'chat' : 'mt auth';
          return say(w.via, [`${w.who} has ${tier}, which ${who} cannot change: the operator edits it and restarts the gateway`]);
        }
        case 'operate_grant_is_owners':
          return say(w.via, [`${w.who} has operate tier by a grant, which only the owner revokes`]);
        case 'operate_listed':
          return say(w.via, [`${w.who} is in ${w.from.operate}: their talk grant is what makes them an operator, so only the owner revokes it`]);
      }
  }
}
```

- [ ] **Step 4.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2579 passed (2579)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.5: Commit.**

```bash
git add src/policy/grants.ts tests/grants-policy.test.ts
git commit -m "Decide who may grant and revoke which tier in one pure function each, decideGrant and decideRevoke, with the words for every outcome that chat and the terminal both give"
```

---

### Task 5: The `Authorizer` reading grants

**Files:**

- Create: `tests/auth-grants.test.ts`
- Modify: `src/policy/auth.ts`, `src/index.ts`

§4.1, §4.2, §5.1. The `Authorizer` takes `AuthorizerDeps` beside its config (Decision 7), and `canTalk` and `canOperate` count the principal's grant, read by union_id at each check, with no cache: a principal with no union_id never asks; a read that throws counts as none, said once a minute. `isOwner` and `sourcesOf` feed a decision. `reconfigure`'s comment says grants never pass through it. The gateway builds the reader over its database with `tierReader`.

- [ ] **Step 5.1: Write the tests.**

Create `tests/auth-grants.test.ts`:

```ts
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grantTier, revokeGrant, tierReader } from '../src/db/grants.js';
import { openDb } from '../src/db/open.js';
import { Authorizer, defaultAuthConfig, sourcesOf, type GrantReader } from '../src/policy/auth.js';
import type { InboundMessage, Principal, Tier } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

/**
 * The Authorizer with grants (the tier grants spec §4.1, §5.1): a grant read at
 * each check, by the principal's union_id, beside the configuration's lists;
 * none without a union_id or a reader; a failed read none, said once a minute;
 * and the owner and the sources a grant's decision is fed.
 */

const OWNER = 'ou_owner';
const CONFIG = { ...defaultAuthConfig(OWNER), allowTalk: [OWNER, 'ou_talk'], allowOperate: [OWNER, 'ou_op_only'] };

function person(openId: string, unionId: string | null = `on_${openId.slice(3)}`): Principal {
  return { openId, unionId, displayName: null };
}

function reader(grants: Record<string, Tier>, asked: string[] = []): GrantReader {
  return {
    tierOf: (unionId) => {
      asked.push(unionId);
      return grants[unionId];
    },
  };
}

function message(sender: Principal): InboundMessage {
  return {
    messageId: 'om_1',
    appId: 'cli_app',
    chatId: 'oc_chat',
    chatType: 'p2p',
    threadId: '',
    sender,
    senderIsBot: false,
    text: 'hello',
    mentionedBot: false,
    mentionAll: false,
    attachments: [],
    createTime: 1,
  };
}

let h: TestDb | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

describe('Authorizer with grants', () => {
  it('gives talk and operate by a grant, found by union_id, and operate by a talk grant to a person in auth.operate', () => {
    const a = new Authorizer(CONFIG, { grants: reader({ on_carol: 'talk', on_dan: 'operate', on_op_only: 'talk' }) });
    expect([a.canTalk(person('ou_carol')), a.canOperate(person('ou_carol'))]).toEqual([true, false]);
    expect([a.canTalk(person('ou_dan')), a.canOperate(person('ou_dan'))]).toEqual([true, true]);
    expect([a.canTalk(person('ou_op_only')), a.canOperate(person('ou_op_only'))]).toEqual([true, true]);
    expect([a.canTalk(person('ou_erin')), a.canOperate(person('ou_erin'))]).toEqual([false, false]);
    expect(a.hasTier(person('ou_dan'), 'operate')).toBe(true);
    expect(a.admits(message(person('ou_carol')))).toEqual({ ok: true });
    expect(a.admitsTier(person('ou_carol'), 'operate')).toMatchObject({ ok: false, reason: 'insufficient_tier' });
  });

  it('never asks the reader about a principal with no union_id, and counts no grant for one', () => {
    const asked: string[] = [];
    const a = new Authorizer(CONFIG, { grants: reader({ on_carol: 'operate' }, asked) });
    expect(a.canTalk(person('ou_carol', null))).toBe(false);
    expect(a.canOperate(person('ou_carol', ''))).toBe(false);
    expect(a.canTalk(person('ou_talk', null))).toBe(true);
    expect(asked).toEqual([]);
  });

  it('counts a read that throws as no grant, the configuration still holding, and says so once a minute', () => {
    const clock = new ManualClock(1_000);
    const notes: string[] = [];
    const a = new Authorizer(CONFIG, {
      grants: {
        tierOf: () => {
          throw new Error('database disk image is malformed');
        },
      },
      note: (line) => notes.push(line),
      clock,
    });
    expect(a.canTalk(person('ou_carol'))).toBe(false);
    expect(a.canOperate(person(OWNER))).toBe(true);
    clock.advance(59_999);
    expect(a.canTalk(person('ou_talk'))).toBe(true);
    expect(notes).toEqual(['auth: reading the tier grants failed, so none count until a read succeeds: database disk image is malformed']);
    clock.advance(1);
    a.canTalk(person('ou_carol'));
    expect(notes).toHaveLength(2);
  });

  it('is as before with no reader', () => {
    const a = new Authorizer(CONFIG);
    expect([a.canTalk(person('ou_carol')), a.canTalk(person('ou_talk')), a.canOperate(person('ou_op_only')), a.canOperate(person(OWNER))]).toEqual([false, true, false, true]);
    expect(a.grantOf('on_carol')).toBeUndefined();
  });

  it('says who the owner is, and where an open_id is in the configuration', () => {
    const a = new Authorizer(CONFIG);
    expect(a.isOwner(person(OWNER))).toBe(true);
    expect(a.isOwner(person('ou_talk'))).toBe(false);
    expect(a.sourcesOf(OWNER)).toEqual({ owner: true, talk: true, operate: true });
    expect(a.sourcesOf('ou_talk')).toEqual({ owner: false, talk: true, operate: false });
    expect(a.sourcesOf('ou_op_only')).toEqual({ owner: false, talk: false, operate: true });
    expect(a.sourcesOf(null)).toEqual({ owner: false, talk: false, operate: false });
    expect(sourcesOf({ ownerOpenId: OWNER, allowTalk: [], allowOperate: [] }, OWNER)).toEqual({ owner: true, talk: false, operate: false });
  });

  it('reads the database at each check, so a grant and a revoke from another connection count at once', () => {
    h = testDb();
    const a = new Authorizer(CONFIG, { grants: { tierOf: tierReader(h.db, 'cli_app') } });
    expect(a.canTalk(person('ou_carol'))).toBe(false);
    const other = openDb(join(h.dir, 'team.db'));
    try {
      const actor = { by: 'operator:alice', via: 'terminal' as const, chat: null };
      grantTier(other, { appId: 'cli_app', unionId: 'on_carol', openId: 'ou_carol', tier: 'talk', ...actor }, () => ({ write: 'insert' as const }), 1);
      expect(a.canTalk(person('ou_carol'))).toBe(true);
      // Another bot's grant counts for nothing here.
      grantTier(other, { appId: 'cli_old', unionId: 'on_dan', openId: 'ou_dan', tier: 'operate', ...actor }, () => ({ write: 'insert' as const }), 1);
      expect(a.canTalk(person('ou_dan'))).toBe(false);
      revokeGrant(other, { appId: 'cli_app', unionId: 'on_carol', ...actor }, () => ({ write: 'end' as const }), 2);
      expect(a.canTalk(person('ou_carol'))).toBe(false);
    } finally {
      other.close();
    }
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/auth-grants.test.ts`. Expected: `Tests  5 failed | 1 passed (6)`; among the failures, `TypeError: a.isOwner is not a function` and `AssertionError: expected [ false, false ] to deeply equal [ true, false ]`.

- [ ] **Step 5.3: Implement.**

In `src/index.ts`, replace:

```ts
import { jobCounts } from './db/cron.js';
```

with:

```ts
import { jobCounts } from './db/cron.js';
import { tierReader } from './db/grants.js';
```

In `src/index.ts`, replace:

```ts
    allowMentionAll: config.auth.allowMentionAll,
```

with:

```ts
    allowMentionAll: config.auth.allowMentionAll,
  }, {
    // A grant made in chat or at the terminal counts at the next check, read from the database (tier grants spec §4.1).
    grants: { tierOf: tierReader(db, config.lark.appId) },
    note,
```

In `src/policy/auth.ts`, replace:

```ts
import type { InboundMessage, Principal, RejectReason, Tier } from '../types.js';

/**
 * Authorization. Two tiers, one write path, closed by default.
```

with:

```ts
import { systemClock, type Clock } from '../time.js';
import type { InboundMessage, Principal, RejectReason, Tier } from '../types.js';
import type { Sources } from './grants.js';

/**
 * Authorization. Two tiers, two sources each with one write path, closed by default.
```

In `src/policy/auth.ts`, replace:

```ts
/**
 * `tiersOf`'s rule, given whether the person is in each list. A grant of
```

with:

```ts
/** Whether an open_id is the owner, and whether it is in each of the configuration's lists (tier grants spec §5.1). */
export function sourcesOf(lists: TierLists & { ownerOpenId: string }, openId: string | null): Sources {
  if (openId === null) return { owner: false, talk: false, operate: false };
  return { owner: openId === lists.ownerOpenId, talk: lists.allowTalk.includes(openId), operate: lists.allowOperate.includes(openId) };
}

/**
 * The second source of a tier beside the configuration (tier grants spec
 * §4.1): this bot's active grants, read at each check.
 */
export interface GrantReader {
  /** This bot's active grant for the person with this union_id: its tier, or undefined. */
  tierOf(unionId: string): Tier | undefined;
}

export interface AuthorizerDeps {
  /** Grants, read at each check; without, there are none, as before grants. */
  grants?: GrantReader;
  /** Where a failed read of the grants is said, at most once a minute. */
  note?: (line: string) => void;
  clock?: Clock;
}

/** How often a failing grant read is said: once is enough to be seen, and every check would flood the log. */
const READ_FAILURE_NOTE_MS = 60_000;

/**
 * `tiersOf`'s rule, given whether the person is in each list. A grant of
```

In `src/policy/auth.ts`, replace:

```ts

  constructor(config: AuthConfig) {
    this.#config = config;
  }

  /**
   * Replace the configuration.
   *
   * The only mutation path. Allowlist edits do not come from chat, so there is no
   * command that reaches this -- a chat-editable allowlist means whoever gets in
   * once can keep themselves in.
```

with:

```ts
  readonly #deps: AuthorizerDeps;
  readonly #clock: Clock;
  #failedAt: number | undefined;

  constructor(config: AuthConfig, deps: AuthorizerDeps = {}) {
    this.#config = config;
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Replace the configuration, and only the configuration.
   *
   * The configuration is not edited from chat, so there is no command that
   * reaches this. Grants are a second source, read through the `GrantReader`
   * at each check and written only by `db/grants.ts`, never passed through
   * here; their rules (tier grants spec §5) are what keep a person who got in
   * from keeping themselves in.
```

In `src/policy/auth.ts`, replace:

```ts
  canTalk(principal: Principal): boolean {
    return tiersOf(this.#config, principal.openId, undefined).talk;
```

with:

```ts
  /** Whether this principal is the owner, by the configuration's owner open_id. */
  isOwner(principal: Principal): boolean {
    return principal.openId === this.#config.ownerOpenId;
  }

  /** Whether an open_id is the owner, and in each of the configuration's lists: what a grant's decision is fed. */
  sourcesOf(openId: string | null): Sources {
    return sourcesOf(this.#config, openId);
  }

  /**
   * The tier of this bot's active grant for a union_id, read now: none with no
   * reader or no union_id, and none when the read fails, which is said at most
   * once a minute. Closed, as an empty list is; the configuration's tiers, the
   * owner's included, still hold.
   */
  grantOf(unionId: string | null): Tier | undefined {
    const grants = this.#deps.grants;
    if (grants === undefined || unionId === null || unionId === '') return undefined;
    try {
      return grants.tierOf(unionId);
    } catch (err) {
      const now = this.#clock.now();
      if (this.#failedAt === undefined || now - this.#failedAt >= READ_FAILURE_NOTE_MS) {
        this.#failedAt = now;
        this.#deps.note?.(`auth: reading the tier grants failed, so none count until a read succeeds: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }
  }

  canTalk(principal: Principal): boolean {
    return tiersOf(this.#config, principal.openId, this.grantOf(principal.unionId)).talk;
```

In `src/policy/auth.ts`, replace:

```ts
    return tiersOf(this.#config, principal.openId, undefined).operate;
```

with:

```ts
    return tiersOf(this.#config, principal.openId, this.grantOf(principal.unionId)).operate;
```

- [ ] **Step 5.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2585 passed (2585)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add src/index.ts src/policy/auth.ts tests/auth-grants.test.ts
git commit -m "Have the Authorizer read this bot's active grant at each check, by the principal's union_id, counting a failed read as no grant and saying so once a minute, and tell who the owner is and where an open_id is in the configuration"
```

---

### Task 6: `PeopleDirectory.canTalk` by union_id

**Files:**

- Create: `tests/people-grants.test.ts`
- Modify: `src/kanban/people.ts`, `src/index.ts`, `src/cli/gate.ts`, `tests/people.test.ts`, `tests/kanban-board-chat.test.ts`, `tests/kanban-chat.test.ts`, `tests/kanban-chat.e2e.ts`, `tests/kanban-people.e2e.ts`, `tests/kanban-thread-chat.test.ts`, `tests/kanban-thread.e2e.ts`, `tests/kanban-workflow-chat.test.ts`, `tests/kanban-workflow.e2e.ts`

§4.3. `PeopleDeps.canTalk` takes `{ openId: string | null, unionId }`, and `PeopleDirectory.canTalk(principal)` asks it whether or not `people` has a row, so the board's assignees, its reviewers and the card poster's check find a grant. The gateway's callback is `tiersOf` over the configuration's lists and `authorizer.grantOf`; the terminal's keeps its talk list alone until Task 7. Every test that built a directory changes its callback's shape (Decision 8).

- [ ] **Step 6.1: Write the tests.**

In `tests/kanban-board-chat.test.ts`, replace:

```ts
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

with:

```ts
    canTalk: ({ openId }) => openId !== null && authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

In `tests/kanban-chat.e2e.ts`, replace:

```ts
        canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

with:

```ts
        canTalk: ({ openId }) => openId !== null && authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

In `tests/kanban-chat.test.ts`, replace:

```ts
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

with:

```ts
    canTalk: ({ openId }) => openId !== null && authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

In `tests/kanban-people.e2e.ts`, replace:

```ts
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

with:

```ts
    canTalk: ({ openId }) => openId !== null && authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

In `tests/kanban-thread-chat.test.ts`, replace:

```ts
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }) });
```

with:

```ts
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: ({ openId }) => openId !== null && authorizer.canTalk({ openId, unionId: null, displayName: null }) });
```

In `tests/kanban-thread.e2e.ts`, replace:

```ts
    canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

with:

```ts
    canTalk: ({ openId }) => openId !== null && authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

In `tests/kanban-workflow-chat.test.ts`, replace:

```ts
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }) });
```

with:

```ts
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: ({ openId }) => openId !== null && authorizer.canTalk({ openId, unionId: null, displayName: null }) });
```

In `tests/kanban-workflow.e2e.ts`, replace:

```ts
  const people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }) });
```

with:

```ts
  const people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: ({ openId }) => openId !== null && authorizer.canTalk({ openId, unionId: null, displayName: null }) });
```

In `tests/people.test.ts`, replace:

```ts
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => TALK.has(openId), clock });
```

with:

```ts
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: ({ openId }) => openId !== null && TALK.has(openId), clock });
```

In `tests/people.test.ts`, replace:

```ts
    expect(unionIdOf('implementer')).toBeUndefined();
  });
```

with:

```ts
    expect(unionIdOf('implementer')).toBeUndefined();
  });

  it("asks about a person by union_id, with the open_id people holds or none, so a grant is found without a row (tier grants spec §4.3)", () => {
    const asked: Array<{ openId: string | null; unionId: string }> = [];
    const granted = new PeopleDirectory({
      db: t.db,
      appId: 'cli_app',
      canTalk: (person) => {
        asked.push(person);
        return person.unionId === 'on_granted';
      },
    });
    people.saw({ openId: 'ou_alice', unionId: 'on_alice', name: 'Alice' });
    expect(granted.canTalk('lark:on_granted')).toBe(true);
    expect(granted.canTalk('lark:on_alice')).toBe(false);
    expect(granted.canTalk('implementer')).toBe(false);
    expect(asked).toEqual([
      { openId: null, unionId: 'on_granted' },
      { openId: 'ou_alice', unionId: 'on_alice' },
    ]);
  });
```

Create `tests/people-grants.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grantTier, revokeGrant, tierReader } from '../src/db/grants.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { Authorizer, defaultAuthConfig, tiersOf } from '../src/policy/auth.js';
import type { Role } from '../src/roles.js';
import type { Tier } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * A person named by principal, with grants (the tier grants spec §4.3): the
 * board's people built as the gateway builds them, over the configuration's
 * lists and the Authorizer's grant read, so a granted person is given work
 * whether or not `people` holds them, and a revoked one is refused.
 */

let h: TestDb;
let service: KanbanService;
const CONFIG = { ...defaultAuthConfig('ou_owner'), allowTalk: ['ou_owner', 'ou_listed'] };
const ACTOR = { by: 'operator:alice', via: 'terminal' as const, chat: null };

const ROLE: Role = {
  name: 'implementer',
  source: 'directory',
  dir: undefined,
  description: undefined,
  workspace: undefined,
  agent: { driver: 'structured-cli', command: 'bytesec', args: [], env: {}, unsupervised: true, passEnv: [], readOnlyTools: [], maskExempt: [] },
  roleMdPath: undefined,
  skills: [],
  secretValues: [],
};

beforeEach(() => {
  h = testDb();
  const authorizer = new Authorizer(CONFIG, { grants: { tierOf: tierReader(h.db, 'cli_app') } });
  const people = new PeopleDirectory({
    db: h.db,
    appId: 'cli_app',
    canTalk: (person) => tiersOf(CONFIG, person.openId, authorizer.grantOf(person.unionId)).talk,
  });
  people.saw({ openId: 'ou_listed', unionId: 'on_listed', name: 'Listed' });
  people.saw({ openId: 'ou_seen', unionId: 'on_seen', name: 'Seen' });
  service = new KanbanService({ db: h.db, roles: new Map([['implementer', ROLE]]), workspaces: WORKSPACES, people });
});
afterEach(() => h.close());

function grant(unionId: string, tier: Tier): void {
  grantTier(h.db, { appId: 'cli_app', unionId, openId: `ou_${unionId.slice(3)}`, tier, ...ACTOR }, () => ({ write: 'insert' as const }), 1);
}

const assign = (principal: string) => service.create({ title: 'Write it up', assignee: principal, createdBy: ALICE, createdVia: VIA });

describe('the board, with grants', () => {
  it('gives work to a person in the talk list, and to one granted talk, seen or not', () => {
    expect(assign('lark:on_listed')).toMatchObject({ ok: true });
    expect(assign('lark:on_seen')).toMatchObject({ ok: false, code: 'person_not_assignable' });
    grant('on_seen', 'talk');
    grant('on_unseen', 'operate');
    expect(assign('lark:on_seen')).toMatchObject({ ok: true, task: { assignee: { kind: 'human', name: 'lark:on_seen' } } });
    expect(assign('lark:on_unseen')).toMatchObject({ ok: true });
  });

  it('refuses a person once their grant is revoked', () => {
    grant('on_seen', 'talk');
    expect(assign('lark:on_seen')).toMatchObject({ ok: true });
    revokeGrant(h.db, { appId: 'cli_app', unionId: 'on_seen', ...ACTOR }, () => ({ write: 'end' as const }), 2);
    expect(assign('lark:on_seen')).toMatchObject({ ok: false, code: 'person_not_assignable' });
  });
});
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-board-chat.test.ts tests/kanban-chat.test.ts tests/kanban-thread-chat.test.ts tests/kanban-workflow-chat.test.ts tests/people-grants.test.ts tests/people.test.ts`. Expected: `Test Files  5 failed | 1 passed (6)` and `Tests  36 failed | 41 passed (77)`; among the failures, `Error: not created: @Alice Smith cannot be given work: being assigned lets a person report on the task, which needs talk tier, and the gateway does not know them to have it.`, as the old directory passes an open_id where the new callbacks take a person. Run `npx vitest run --project e2e tests/kanban-chat.e2e.ts tests/kanban-people.e2e.ts tests/kanban-thread.e2e.ts tests/kanban-workflow.e2e.ts`. Expected: `Tests  7 failed | 9 passed (16)`, for the same reason.

- [ ] **Step 6.3: Implement.**

In `src/cli/gate.ts`, replace:

```ts
    appId === undefined || talk === undefined ? undefined : new PeopleDirectory({ db, appId, canTalk: (openId) => talk.includes(openId) });
```

with:

```ts
    appId === undefined || talk === undefined ? undefined : new PeopleDirectory({ db, appId, canTalk: ({ openId }) => openId !== null && talk.includes(openId) });
```

In `src/index.ts`, replace:

```ts
import { Authorizer } from './policy/auth.js';
```

with:

```ts
import { Authorizer, tiersOf } from './policy/auth.js';
```

In `src/index.ts`, replace:

```ts
      canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }),
```

with:

```ts
      // The configuration's lists and the grant, as the authorizer holds them, for a person named by principal (tier grants spec §4.3).
      canTalk: (person) => tiersOf(config.auth, person.openId, authorizer.grantOf(person.unionId)).talk,
```

In `src/kanban/people.ts`, replace:

```ts
 * The board knows a person as `lark:<union_id>`; the tiers are decided by
 * open_id. Lark gives both for a sender, for whoever presses a card's button,
 * and for each person a message mentions, so each is noted as it is seen, and
 * a person named by principal alone -- typed out, or by an agent's `mt kanban
 * create` -- is checked through the open_id last seen with their union_id. A
 * person the gateway has never seen cannot be checked, and so is not given work.
```

with:

```ts
 * The board knows a person as `lark:<union_id>`; the configuration's tiers are
 * decided by open_id. Lark gives both for a sender, for whoever presses a
 * card's button, and for each person a message mentions, so each is noted as
 * it is seen, and a person named by principal alone -- typed out, or by an
 * agent's `mt kanban create` -- is checked through the open_id last seen with
 * their union_id, and by a grant to their union_id (tier grants spec §4.3). A
 * person the gateway has never seen is in no list, and is given work only by
 * a grant.
```

In `src/kanban/people.ts`, replace:

```ts
  /** Whether an open_id has talk tier: the router's authorizer. */
  canTalk(openId: string): boolean;
```

with:

```ts
  /**
   * Whether a person has talk tier (tier grants spec §4.3): by the open_id
   * `people` holds for them with this app id, null when it holds none, in the
   * configuration's lists, or by their union_id's active grant.
   */
  canTalk(person: { openId: string | null; unionId: string }): boolean;
```

In `src/kanban/people.ts`, replace:

```ts
  /** Whether this person may be given work: seen, and at talk tier by the open_id last seen for them. */
```

with:

```ts
  /**
   * Whether this person may be given work: at talk tier by the open_id last
   * seen for them, or by a grant to their union_id, which needs no row here.
   */
```

In `src/kanban/people.ts`, replace:

```ts
    return person !== undefined && this.#deps.canTalk(person.openId);
```

with:

```ts
    return this.#deps.canTalk({ openId: person?.openId ?? null, unionId });
```

- [ ] **Step 6.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2588 passed (2588)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.5: Commit.**

```bash
git add src/cli/gate.ts src/index.ts src/kanban/people.ts tests/kanban-board-chat.test.ts tests/kanban-chat.e2e.ts tests/kanban-chat.test.ts tests/kanban-people.e2e.ts tests/kanban-thread-chat.test.ts tests/kanban-thread.e2e.ts tests/kanban-workflow-chat.test.ts tests/kanban-workflow.e2e.ts tests/people-grants.test.ts tests/people.test.ts
git commit -m "Check a person named by principal for talk tier by their union_id as well as the open_id people holds, asking whether or not people has a row, so the board finds a grant; the gateway's check reads the configuration's lists and the grant as the Authorizer does"
```

---

### Task 7: `TeamSettings.owner` and `.operate`, and the terminal's grants

**Files:**

- Create: `tests/team-settings-grants.test.ts`
- Modify: `src/config.ts`, `src/cli/gate.ts`, `tests/config.test.ts`

§4.3, §5.1. `teamSettingsFrom` reads the owner, the operate list and where each list came from as `loadConfig` does, through the same helpers, so the terminal's `sourcesOf` agrees with the `Authorizer`'s. `openBoard`'s talk check is `tiersOf` over this shell's lists and the database's grants, read by `tierReader`; a database with no `tier_grants` table has none for it (Decision 9).

- [ ] **Step 7.1: Write the tests.**

In `tests/config.test.ts`, replace:

```ts
      chats: c.auth.allowChats,
```

with:

```ts
      chats: c.auth.allowChats,
      owner: c.auth.ownerOpenId,
      operate: c.auth.allowOperate,
      from: c.auth.from,
```

Create `tests/team-settings-grants.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig, loadTeamSettings, type FileReader } from '../src/config.js';
import { grantTier, revokeGrant } from '../src/db/grants.js';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { Authorizer, defaultAuthConfig, sourcesOf } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { Tier } from '../src/types.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The terminal's reading of the tiers (the tier grants spec §4.3, §5.1):
 * `TeamSettings.owner`, `.operate` and `.from`, read as `loadConfig` reads
 * them, the terminal's `sourcesOf` agreeing with the Authorizer's, and the
 * board's talk check at the terminal counting grants, in a database migrated
 * to them and, as having none, in one that is not.
 */

const HOME = '/var/lib/mt';
const PATH = join(HOME, 'config.yaml');
const BASE = { MT_HOME: HOME, LARK_APP_SECRET: 'app-secret' };

function file(auth: Record<string, unknown>): FileReader {
  const text = stringify({ workspace: '/srv/repo', lark: { appId: 'cli_app' }, agent: { command: 'bytesec' }, auth });
  return (path) => (path === PATH ? text : undefined);
}

describe('TeamSettings.owner, .operate and .from', () => {
  it("equal loadConfig's for each mix of the environment and the file, and agree on sourcesOf", () => {
    const files = [{ owner: 'ou_owner' }, { owner: 'ou_owner', talk: ['ou_a'], operate: ['ou_a', 'ou_b'] }];
    const envs: Array<Record<string, string>> = [
      {},
      { MT_OWNER_OPEN_ID: 'ou_boss' },
      { MT_ALLOW_OPERATE: 'ou_c, ou_d' },
      { MT_ALLOW_OPERATE: '' },
      { MT_OWNER_OPEN_ID: 'ou_boss', MT_ALLOW_TALK: 'ou_a', MT_ALLOW_OPERATE: 'ou_a' },
    ];
    for (const auth of files) {
      for (const over of envs) {
        const env = { ...BASE, ...over };
        const gateway = loadConfig(env, file(auth));
        const team = loadTeamSettings(env, file(auth));
        const at = JSON.stringify({ auth, over });
        expect(team.owner, at).toBe(gateway.auth.ownerOpenId);
        expect(team.operate, at).toEqual(gateway.auth.allowOperate);
        expect(team.from, at).toEqual(gateway.auth.from);
        const authorizer = new Authorizer({ ...defaultAuthConfig(gateway.auth.ownerOpenId), allowTalk: gateway.auth.allowTalk, allowOperate: gateway.auth.allowOperate });
        const terminal = { ownerOpenId: team.owner ?? '', allowTalk: team.talk ?? [], allowOperate: team.operate ?? [] };
        for (const openId of ['ou_owner', 'ou_boss', 'ou_a', 'ou_b', 'ou_c', 'ou_none']) {
          expect(sourcesOf(terminal, openId), `${at} ${openId}`).toEqual(authorizer.sourcesOf(openId));
        }
      }
    }
  });

  it('has no owner or operate list without an owner, and always says where the lists came from', () => {
    const team = loadTeamSettings({ ...BASE, MT_ALLOW_OPERATE: 'ou_a' }, () => stringify({ workspace: '/srv/repo', agent: { command: 'bytesec' } }));
    expect(team.owner).toBeUndefined();
    expect(team.operate).toBeUndefined();
    expect(team.from).toEqual({ owner: 'auth.owner', talk: 'auth.talk', operate: 'MT_ALLOW_OPERATE' });
  });
});

describe("the terminal's talk check, with grants", () => {
  let fx: MtFixture;
  let db: Db;

  afterEach(() => {
    clearSecrets();
    db?.close();
    fx?.cleanup();
  });

  /** A home with the board off, Bob seen without talk tier, and its database migrated to `upTo` (every migration when undefined). */
  function setup(upTo?: number): void {
    clearSecrets();
    fx = mtFixture((ws) =>
      [`workspace: ${ws}`, 'lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
    );
    let schema = SCHEMA_DIR;
    if (upTo !== undefined) {
      schema = mkdtempSync(join(fx.root, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) if (Number(f.slice(0, 3)) <= upTo) copyFileSync(join(SCHEMA_DIR, f), join(schema, f));
    }
    db = openDb(join(fx.home, 'team.db'));
    migrate(db, schema);
    notePerson(db, { appId: 'cli_app', unionId: 'on_bob', openId: 'ou_bob', name: 'Bob Li' }, 1);
  }

  function grant(unionId: string, tier: Tier): void {
    grantTier(db, { appId: 'cli_app', unionId, openId: `ou_${unionId.slice(3)}`, tier, by: 'operator:alice', via: 'terminal', chat: null }, () => ({ write: 'insert' as const }), 1);
  }

  const assign = async (who: string) => fx.run(['kanban', 'task', 'new', 'Book the venue', '--assignee', who, '--json']);

  it('gives work to a person granted talk, seen or not, and refuses them once revoked', async () => {
    setup();
    expect(JSON.parse((await assign('lark:on_bob')).out)).toMatchObject({ ok: false, code: 'person_not_assignable' });
    grant('on_bob', 'talk');
    grant('on_unseen', 'operate');
    const made = JSON.parse((await assign('lark:on_bob')).out) as { ok: boolean; task_id: string };
    expect(made.ok).toBe(true);
    expect(getTask(db, made.task_id)?.assignee).toEqual({ kind: 'human', name: 'lark:on_bob' });
    expect(JSON.parse((await assign('lark:on_unseen')).out)).toMatchObject({ ok: true });
    // Another bot's grant counts for nothing here.
    grantTier(db, { appId: 'cli_old', unionId: 'on_old', openId: 'ou_old', tier: 'talk', by: 'operator:alice', via: 'terminal', chat: null }, () => ({ write: 'insert' as const }), 1);
    expect(JSON.parse((await assign('lark:on_old')).out)).toMatchObject({ ok: false, code: 'person_not_assignable' });
    revokeGrant(db, { appId: 'cli_app', unionId: 'on_bob', by: 'operator:alice', via: 'terminal', chat: null }, () => ({ write: 'end' as const }), 2);
    expect(JSON.parse((await assign('lark:on_bob')).out)).toMatchObject({ ok: false, code: 'person_not_assignable' });
  });

  it('reads a database not yet migrated to 011 as having no grants', async () => {
    setup(10);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tier_grants'").get()).toBeUndefined();
    expect(JSON.parse((await assign('lark:on_bob')).out)).toMatchObject({ ok: false, code: 'person_not_assignable' });
    expect(JSON.parse((await assign('default')).out)).toMatchObject({ ok: true });
    expect((await fx.run(['kanban', 'people'])).code).toBe(0);
  });
});
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/config.test.ts tests/team-settings-grants.test.ts`. Expected: `Tests  4 failed | 77 passed (81)`; among the failures, `AssertionError: {"auth":{"owner":"ou_owner"},"over":{}}: expected undefined to be 'ou_owner' // Object.is equality`.

- [ ] **Step 7.3: Implement.**

In `src/cli/gate.ts`, replace:

```ts
import { loadTeamSettings, type Env, type TeamSettings } from '../config.js';
```

with:

```ts
import { loadTeamSettings, type Env, type TeamSettings } from '../config.js';
import { tierReader } from '../db/grants.js';
```

In `src/cli/gate.ts`, replace:

```ts
import type { GateRow } from '../kanban/types.js';
import { addSecrets, redactKnownSecrets } from '../secrets.js';
import { loadTeam, teamSecrets, type Team } from '../team.js';
```

with:

```ts
import { tiersOf } from '../policy/auth.js';
import type { GateRow } from '../kanban/types.js';
import { addSecrets, redactKnownSecrets } from '../secrets.js';
import { loadTeam, teamSecrets, type Team } from '../team.js';
import type { Tier } from '../types.js';
```

In `src/cli/gate.ts`, replace:

```ts
  let migrated: unknown;
```

with:

```ts
  let migrated: unknown;
  let granted: boolean;
```

In `src/cli/gate.ts`, replace:

```ts
    migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
```

with:

```ts
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    migrated = has.get(table);
    // A database not yet migrated to 011 has no grants: the board reads it as having none (tier grants spec §4.3).
    granted = has.get('tier_grants') !== undefined;
```

In `src/cli/gate.ts`, replace:

```ts
  // Chat's own check of a person, against the same table (kanban spec §22.2): the people this bot has
  // seen, and the talk allowlist this shell's settings give, as the gateway's authorizer holds it.
  const { appId, talk } = settings;
  const peopleMissing: PeopleMissing | undefined = appId === undefined ? 'appId' : talk === undefined ? 'owner' : undefined;
  const people =
    appId === undefined || talk === undefined ? undefined : new PeopleDirectory({ db, appId, canTalk: ({ openId }) => openId !== null && talk.includes(openId) });
```

with:

```ts
  // Chat's own check of a person, against the same tables (kanban spec §22.2, tier grants spec §4.3): the people
  // this bot has seen, the lists this shell's settings give, as the gateway's authorizer holds them, and the grants.
  const { appId, talk } = settings;
  const lists = { allowTalk: talk ?? [], allowOperate: settings.operate ?? [] };
  const peopleMissing: PeopleMissing | undefined = appId === undefined ? 'appId' : talk === undefined ? 'owner' : undefined;
  const grantOf = appId !== undefined && granted ? tierReader(db, appId) : (): Tier | undefined => undefined;
  const people =
    appId === undefined || talk === undefined
      ? undefined
      : new PeopleDirectory({ db, appId, canTalk: (person) => tiersOf(lists, person.openId, grantOf(person.unionId)).talk });
```

In `src/config.ts`, replace:

```ts
  talk?: readonly string[];
```

with:

```ts
  talk?: readonly string[];
  /**
   * The owner, `MT_OWNER_OPEN_ID` or `auth.owner`, when either is set: whom
   * `mt auth` judges as the owner, who cannot be revoked (tier grants spec §4.3).
   */
  owner?: string;
  /**
   * The operate list as the gateway builds `auth.allowOperate`: the owner and
   * `MT_ALLOW_OPERATE` or `auth.operate`. Present only with an owner, as
   * `talk` is: so `mt auth list` can say who operates.
   */
  operate?: readonly string[];
  /** Where the owner and the two lists came from, as `loadConfig` records them, for the words that name a list. */
  from?: ListSources;
```

In `src/config.ts`, replace:

```ts
  const allowOperate = envList(env, 'MT_ALLOW_OPERATE') ?? file.auth.operate;
  const { maxLiveSessions, liveName, maxRunning, maxRunningFrom } = runningLimits(env, file);
```

with:

```ts
  const { maxLiveSessions, liveName, maxRunning, maxRunningFrom } = runningLimits(env, file);
```

In `src/config.ts`, replace:

```ts
      allowOperate: unique([ownerOpenId, ...allowOperate]),
```

with:

```ts
      allowOperate: operateOf(env, file, ownerOpenId),
```

In `src/config.ts`, replace:

```ts
/** Which of the owner and the two lists the environment overrides: `ownerOf`'s, `talkOf`'s and `MT_ALLOW_OPERATE`'s precedence. */
```

with:

```ts
/** The operate list, `MT_ALLOW_OPERATE` else `auth.operate`, with the owner always first in it. */
function operateOf(env: Env, file: FileConfig, owner: string): string[] {
  return unique([owner, ...(envList(env, 'MT_ALLOW_OPERATE') ?? file.auth.operate)]);
}

/** Which of the owner and the two lists the environment overrides: `ownerOf`'s, `talkOf`'s and `MT_ALLOW_OPERATE`'s precedence. */
```

In `src/config.ts`, replace:

```ts
    ...(owner === undefined ? {} : { talk: talkOf(env, file, owner) }),
```

with:

```ts
    ...(owner === undefined ? {} : { owner, talk: talkOf(env, file, owner), operate: operateOf(env, file, owner) }),
    from: listSources(env),
```

- [ ] **Step 7.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2592 passed (2592)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.5: Commit.**

```bash
git add src/cli/gate.ts src/config.ts tests/config.test.ts tests/team-settings-grants.test.ts
git commit -m "Read the owner, the operate list and where each list came from into TeamSettings as loadConfig reads them, and count grants in the terminal's talk check, a database not yet migrated to them read as having none"
```

---

### Task 8: `/auth` in chat

**Files:**

- Create: `src/policy/auth-chat.ts`, `tests/auth-chat.test.ts`
- Modify: `src/types.ts`, `src/channel/lark/inbound.ts`, `src/channel/mentions.ts`, `src/policy/grants.ts`, `src/core/commands.ts`, `src/core/router.ts`, `src/index.ts`, `src/db/WRITERS.md`, `tests/mentions.test.ts`, `tests/lark-inbound.test.ts`, `tests/kanban-chat.test.ts`, `tests/router.test.ts`

§6.1, §7, §8.1. `/auth list`, `grant @Name talk|operate` and `revoke @Name|lark:<union_id>`, at talk tier, always on: `src/index.ts` builds its `PeopleDirectory` whatever `kanban.enabled` says, and gives the router an `auth` dependency, `AuthChat` (Decision 10). The sender and every mention are noted first. Each change goes through the writer with `decideGrant` or `decideRevoke`, and is answered with one line, masked, and logged by ids. A bot's mention is refused, by Lark's `mentioned_type`, `/kanban`'s included. `tierEntries` builds the list (Decision 12). The router's tests run a grant, a person's next message, a revoke and an approval's press with the same `Authorizer`.

- [ ] **Step 8.1: Write the tests.**

In `tests/kanban-chat.test.ts`, replace:

```ts
      /^Lark did not say who @Alice Smith is/,
    );
```

with:

```ts
      /^Lark did not say who @Alice Smith is/,
    );
    // A bot is not a person, and cannot be given work.
    expect(await say('task new t\nassignee: @Helper', OWNER, [{ key: '@_user_9', name: 'Helper', openId: 'ou_helper', unionId: null, isBot: true }])).toBe(
      "@Helper is a bot, and a bot's tier is configuration's.",
    );
```

In `tests/lark-inbound.test.ts`, replace:

```ts
  it('is empty for an event without mentions, or with anything else in their place', () => {
```

with:

```ts
  it("says whether a mention is of a bot when Lark sends its mentioned_type, and nothing when it does not", () => {
    expect(
      mentionsOf(
        raw([
          { key: '@_user_1', name: 'Helper', id: { open_id: 'ou_helper' }, mentioned_type: 'bot' },
          { key: '@_user_2', name: 'Alice', id: { open_id: 'ou_alice', union_id: 'on_alice' }, mentioned_type: 'user' },
          { key: '@_user_3', name: 'Bob', id: { open_id: 'ou_bob', union_id: 'on_bob' }, mentioned_type: '' },
        ]),
        BOT,
      ),
    ).toEqual([
      { key: '@_user_1', name: 'Helper', openId: 'ou_helper', unionId: null, isBot: true },
      { key: '@_user_2', name: 'Alice', openId: 'ou_alice', unionId: 'on_alice', isBot: false },
      { key: '@_user_3', name: 'Bob', openId: 'ou_bob', unionId: 'on_bob' },
    ]);
  });

  it('is empty for an event without mentions, or with anything else in their place', () => {
```

In `tests/mentions.test.ts`, replace:

```ts
  it('escapes the name it quotes, and the board calls it rather than keeping a copy', () => {
```

with:

```ts
  it("refuses a bot's mention, by Lark's mentioned_type, and judges one without the field as before", () => {
    expect(mentionedPerson('@Helper', message([{ key: '@_user_1', name: 'Helper', openId: 'ou_helper', unionId: null, isBot: true }]))).toEqual({
      ok: false,
      reason: 'bot',
      reply: "@Helper is a bot, and a bot's tier is configuration's.",
    });
    expect(mentionedPerson('@Carol Wu', message([{ ...CAROL, isBot: false }]))).toMatchObject({ ok: true, unionId: 'on_carol' });
  });

  it('escapes the name it quotes, and the board calls it rather than keeping a copy', () => {
```

In `tests/router.test.ts`, replace:

```ts
import { ACK_EMOJI, KANBAN_OFF, Router, continuityLine, type InboundCardAction, type KanbanCommands } from '../src/core/router.js';
```

with:

```ts
import { ACK_EMOJI, AUTH_OFF, KANBAN_OFF, Router, continuityLine, type InboundCardAction, type KanbanCommands, type RouterDeps } from '../src/core/router.js';
```

In `tests/router.test.ts`, replace:

```ts
import { Authorizer, defaultAuthConfig, type AuthConfig, type Decision } from '../src/policy/auth.js';
```

with:

```ts
import { Authorizer, defaultAuthConfig, tiersOf, type AuthConfig, type Decision } from '../src/policy/auth.js';
import { AuthChat } from '../src/policy/auth-chat.js';
import { tierReader } from '../src/db/grants.js';
import { PeopleDirectory } from '../src/kanban/people.js';
```

In `tests/router.test.ts`, replace:

```ts
  opts: { auth?: Partial<AuthConfig>; authorizer?: Authorizer; kanban?: KanbanCommands } = {},
```

with:

```ts
  opts: {
    auth?: Partial<AuthConfig>;
    authorizer?: Authorizer;
    kanban?: KanbanCommands;
    authChat?: RouterDeps['auth'] | ((db: Db, authorizer: Authorizer) => RouterDeps['auth']);
    cronTurns?: RouterDeps['cronTurns'];
    withGrants?: boolean;
  } = {},
```

In `tests/router.test.ts`, replace:

```ts
    opts.authorizer ?? new Authorizer({ ...defaultAuthConfig(OWNER.openId), ...opts.auth });
```

with:

```ts
    opts.authorizer ??
    new Authorizer({ ...defaultAuthConfig(OWNER.openId), ...opts.auth }, opts.withGrants === true ? { grants: { tierOf: tierReader(t.db, APP) } } : {});
  const authChat = typeof opts.authChat === 'function' ? opts.authChat(t.db, authorizer) : opts.authChat;
```

In `tests/router.test.ts`, replace:

```ts
    ...(opts.kanban === undefined ? {} : { kanban: opts.kanban }),
```

with:

```ts
    ...(opts.kanban === undefined ? {} : { kanban: opts.kanban }),
    ...(authChat === undefined ? {} : { auth: authChat }),
    ...(opts.cronTurns === undefined ? {} : { cronTurns: opts.cronTurns }),
```

In `tests/router.test.ts`, replace:

```ts
describe('Router: prompts', () => {
```

with:

```ts
describe('Router: /auth', () => {
  afterEach(() => clearSecrets());

  /** The gateway's /auth over the harness's database and authorizer, the owner's lists as configured. */
  const gatewayAuth =
    (lists: { allowTalk: string[]; allowOperate: string[] }) =>
    (db: Db, authorizer: Authorizer): AuthChat =>
      new AuthChat({
        db,
        appId: APP,
        authorizer,
        auth: { ownerOpenId: OWNER.openId, ...lists, from: { owner: 'auth.owner', talk: 'auth.talk', operate: 'auth.operate' } },
        people: new PeopleDirectory({ db, appId: APP, canTalk: (p) => tiersOf(lists, p.openId, authorizer.grantOf(p.unionId)).talk }),
        zone: 'UTC',
      });
  const LISTS = { allowTalk: [OWNER.openId], allowOperate: [OWNER.openId] };
  const AT_GUEST = { key: '@_user_1', name: 'Guest', openId: GUEST.openId, unionId: GUEST.unionId };
  const inGroup = (text: string, over: Partial<InboundMessage> = {}): InboundMessage =>
    msg({ chatType: 'group', mentionedBot: true, text, mentions: [AT_GUEST], ...over });

  it('is registered at talk tier, listed in /help, answered while the session is busy, and refused silently without talk', async () => {
    const calls: string[] = [];
    const h = harness({ authChat: { run: (arg) => (calls.push(arg), 'the tiers') } });
    await h.router.onMessage(msg({ text: '/help' }));
    expect(lastReply(h)).toContain('`/auth <command>`: Who may talk to the agent and operate it');
    await working(h);
    await h.router.onMessage(msg({ text: '/auth list' }));
    expect(lastReply(h)).toBe('the tiers');
    const before = h.channel.texts.length;
    await h.router.onMessage(msg({ text: '/auth list', sender: GUEST }));
    expect(h.channel.texts).toHaveLength(before);
    expect(calls).toEqual(['list']);
  });

  it('says so with nothing to answer it, and answers one that throws, masked, noting it', async () => {
    const plain = harness();
    await plain.router.onMessage(msg({ text: '/auth list' }));
    expect(lastReply(plain)).toBe(AUTH_OFF);
    addSecrets(['sk-auth-12345678']);
    const h = harness({
      authChat: {
        run: () => {
          throw new Error('disk_full near sk-auth-12345678');
        },
      },
    });
    await h.router.onMessage(msg({ text: '/auth list' }));
    expect(lastReply(h)).toBe(`The tiers could not be read or changed: disk\\_full near ${MASK}`);
    expect(h.notes.find((n) => n.includes('auth command in'))).toContain(MASK);
  });

  it("masks the reply once more, and keys it on the message", async () => {
    addSecrets(['sk-reply-12345678']);
    const h = harness({ authChat: { run: () => 'granted sk-reply-12345678' } });
    const message = msg({ text: '/auth grant @x talk' });
    await h.router.onMessage(message);
    expect(h.channel.texts.at(-1)).toMatchObject({ text: `granted ${MASK}`, uuid: replyUuid(APP, message.messageId, 'auth') });
  });

  it("admits a person's next message once granted in a group, with no restart, and refuses it once revoked", async () => {
    const h = harness({ auth: LISTS, withGrants: true, authChat: gatewayAuth(LISTS) });
    const guestSays = async (text: string): Promise<number> => {
      const before = h.channel.texts.length + h.channel.cardOpens.length;
      await h.router.onMessage(inGroup(text, { sender: GUEST, mentions: [] }));
      await flush();
      return h.channel.texts.length + h.channel.cardOpens.length - before;
    };
    expect(await guestSays('before the grant')).toBe(0);
    await h.router.onMessage(inGroup('/auth grant @Guest talk'));
    expect(lastReply(h)).toBe('Guest now has talk tier, granted by Owner. `/auth revoke lark:on_guest` takes it back.');
    h.driver.scripts = [async (ctl: TurnControl) => ctl.end('completed')];
    await h.router.onMessage(inGroup('after the grant', { sender: GUEST, mentions: [] }));
    await flush();
    const prompts = (): string[] => h.driver.runtimes.flatMap((r) => r.prompts.map((p) => p.text));
    expect(prompts()).toEqual(['after the grant']);
    await h.router.onMessage(inGroup('/auth revoke @Guest'));
    expect(lastReply(h)).toBe('Guest no longer has talk tier: revoked by Owner.');
    expect(await guestSays('after the revoke')).toBe(0);
    expect(prompts()).toEqual(['after the grant']);
  });

  it("refuses an approval's press by an operator whose operate grant was revoked", async () => {
    const h = harness({ auth: LISTS, withGrants: true, authChat: gatewayAuth(LISTS) });
    await h.router.onMessage(inGroup('/auth grant @Guest operate'));
    await h.router.onMessage(inGroup('/auth revoke @Guest'));
    const { approvalId, nonce } = await ask(h);
    expect(await h.router.onCardAction({ ...click(approvalId, 'allow', nonce), operator: GUEST })).toContain('operator permission');
    expect(await h.router.onCardAction(click(approvalId, 'deny', nonce))).toBe('Sent: Deny.');
  });

  it("tells cron each turn's tier, operate for an operator by grant", async () => {
    const turns: boolean[] = [];
    const h = harness({
      auth: LISTS,
      withGrants: true,
      authChat: gatewayAuth(LISTS),
      cronTurns: { turnSubmitted: (_s, _k, operate) => void turns.push(operate) },
    });
    await h.router.onMessage(inGroup('/auth grant @Guest talk'));
    h.driver.scripts = [async (ctl: TurnControl) => ctl.end('completed'), async (ctl: TurnControl) => ctl.end('completed')];
    await h.router.onMessage(inGroup('as talk', { sender: GUEST, mentions: [] }));
    await flush();
    await h.router.onMessage(inGroup('/auth grant @Guest operate'));
    await h.router.onMessage(inGroup('as an operator', { sender: GUEST, mentions: [] }));
    await flush();
    expect(turns).toEqual([false, true]);
  });
});

describe('Router: prompts', () => {
```

Create `tests/auth-chat.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ListSources } from '../src/config.js';
import { activeGrant, grantTier } from '../src/db/grants.js';
import { personOf } from '../src/db/people.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { AUTH_LIST_MAX, AuthChat } from '../src/policy/auth-chat.js';
import { Authorizer, defaultAuthConfig, tiersOf } from '../src/policy/auth.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { InboundMention, InboundMessage, Principal } from '../src/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

/**
 * `/auth` in chat (the tier grants spec §6.1, §8.1): its parse, the mention
 * it resolves as `/kanban` does, who may do what, every reply's words, the
 * people it notes, the log's ids, masking, and `/auth list` with its cut.
 */

const NOW = Date.UTC(2026, 10, 18, 2, 0);
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Alice' };
const BOB: Principal = { openId: 'ou_bob', unionId: 'on_bob', displayName: 'Bob' };
const TESS: Principal = { openId: 'ou_tess', unionId: 'on_tess', displayName: 'Tess' };
const DAN: Principal = { openId: 'ou_dan', unionId: 'on_dan', displayName: 'Dan' };

const mention = (n: number, name: string, id: string): InboundMention => ({ key: `@_user_${n}`, name, openId: `ou_${id}`, unionId: `on_${id}` });
const AT_CAROL = mention(1, 'Carol Wu', 'carol');
const AT_DAN = mention(2, 'Dan', 'dan');
const AT_OLGA = mention(3, 'Olga', 'olga');
const AT_TESS = mention(4, 'Tess', 'tess');
const AT_ERIN = mention(5, 'Erin', 'erin');
const AT_OWNER = mention(6, 'Alice', 'owner');

const LISTS = {
  allowTalk: ['ou_owner', 'ou_tess', 'ou_bob', 'ou_ghost'],
  allowOperate: ['ou_owner', 'ou_bob', 'ou_olga'],
};
const FROM: ListSources = { owner: 'auth.owner', talk: 'auth.talk', operate: 'auth.operate' };

let t: TestDb;
let authorizer: Authorizer;
let people: PeopleDirectory;
let notes: string[];
let seq = 0;

function chat(from: ListSources = FROM): AuthChat {
  return new AuthChat({
    db: t.db,
    appId: 'cli_app',
    authorizer,
    auth: { ownerOpenId: 'ou_owner', ...LISTS, from },
    people,
    zone: 'Asia/Shanghai',
    clock: new ManualClock(NOW),
    note: (line) => notes.push(line),
  });
}

beforeEach(() => {
  clearSecrets();
  t = testDb();
  notes = [];
  authorizer = new Authorizer({ ...defaultAuthConfig('ou_owner'), ...LISTS }, { grants: { tierOf: (u) => activeGrant(t.db, 'cli_app', u)?.tier } });
  people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (p) => tiersOf(LISTS, p.openId, authorizer.grantOf(p.unionId)).talk });
});
afterEach(() => {
  clearSecrets();
  t.close();
});

function message(sender: Principal, mentions: InboundMention[], chatType: 'group' | 'p2p'): InboundMessage {
  return {
    messageId: `om_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType,
    threadId: '',
    sender,
    senderIsBot: false,
    text: '/auth',
    mentionedBot: true,
    mentionAll: false,
    mentions,
    attachments: [],
    createTime: NOW,
  };
}

function say(arg: string, sender: Principal = OWNER, mentions: InboundMention[] = [], chatType: 'group' | 'p2p' = 'group', from?: ListSources): string {
  return chat(from).run(arg, message(sender, mentions, chatType));
}

const HELP = [
  '`/auth list`: everyone with a tier, and where it comes from.',
  "`/auth grant @Name talk` or `/auth grant @Name operate`: give a tier beside the configuration's lists. An operator grants talk; only the owner grants operate.",
  '`/auth revoke @Name` or `/auth revoke lark:<union_id>`: end a grant. The configuration and the owner are never changed from chat.',
].join('\n');

describe('/auth grant', () => {
  it('grants by @-mention, a name with spaces and the tier last in any case; notes the sender and the mention; logs ids only', () => {
    expect(say('grant @Carol Wu TALK', OWNER, [AT_CAROL])).toBe('Carol Wu now has talk tier, granted by Alice. `/auth revoke lark:on_carol` takes it back.');
    expect(activeGrant(t.db, 'cli_app', 'on_carol')).toMatchObject({ tier: 'talk', openId: 'ou_carol', grantedBy: 'lark:on_owner', grantedVia: 'chat', grantedChat: 'oc_team', grantedAt: NOW });
    expect(personOf(t.db, 'cli_app', 'on_carol')?.name).toBe('Carol Wu');
    expect(personOf(t.db, 'cli_app', 'on_owner')?.name).toBe('Alice');
    expect(notes).toEqual(['auth: talk granted to lark:on_carol by lark:on_owner in chat oc_team']);
    // At once, with no restart.
    expect(authorizer.canTalk({ openId: 'ou_carol', unionId: 'on_carol', displayName: null })).toBe(true);
    expect(people.canTalk('lark:on_carol')).toBe(true);
  });

  it('puts operate in place of a talk grant, and says a tier already held, from where', () => {
    say('grant @Carol Wu talk', OWNER, [AT_CAROL]);
    expect(say('grant @Carol Wu talk', BOB, [AT_CAROL])).toBe('Carol Wu already has talk tier, by a grant from Alice on 2026-11-18.');
    expect(say('grant @Carol Wu operate', OWNER, [AT_CAROL])).toBe(
      'Carol Wu now has operate tier, in place of talk, granted by Alice. `/auth revoke lark:on_carol` takes it back.',
    );
    expect(notes.at(-1)).toBe('auth: operate granted to lark:on_carol by lark:on_owner in chat oc_team (replacing talk)');
    expect(say('grant @Tess talk', BOB, [AT_TESS])).toBe('Tess already has talk tier, from auth.talk in config.yaml.');
    expect(say('grant @Tess talk', BOB, [AT_TESS], 'group', { ...FROM, talk: 'MT_ALLOW_TALK' })).toBe('Tess already has talk tier, from MT_ALLOW_TALK.');
    expect(say('grant @Alice talk', BOB, [AT_OWNER])).toBe('Alice is the owner, who has both tiers always.');
  });

  it("holds each tier's rule: talk tier grants nothing, an operator talk only, and not to a person in auth.operate alone", () => {
    expect(say('grant @Carol Wu talk', TESS, [AT_CAROL])).toBe('`/auth grant` needs operator permission: an operator grants talk tier, and the owner operate.');
    expect(say('grant @Carol Wu operate', BOB, [AT_CAROL])).toBe('Only the owner grants operate tier: an operator cannot make another operator.');
    expect(say('grant @Olga talk', BOB, [AT_OLGA])).toBe("Olga is in auth.operate, so talk tier would make them an operator, which is the owner's to grant.");
    expect(activeGrant(t.db, 'cli_app', 'on_carol')).toBeUndefined();
    expect(say('grant @Olga talk', OWNER, [AT_OLGA])).toMatch(/^Olga now has talk tier/);
    expect(authorizer.canOperate({ openId: 'ou_olga', unionId: 'on_olga', displayName: null })).toBe(true);
    // An operator by grant grants talk.
    say('grant @Dan operate', OWNER, [AT_DAN]);
    expect(say('grant @Carol Wu talk', DAN, [AT_CAROL])).toBe('Carol Wu now has talk tier, granted by Dan. `/auth revoke lark:on_carol` takes it back.');
  });

  it('takes a mention only: a typed principal, a bare word and a missing or unknown tier are refused', () => {
    expect(say('grant lark:on_carol talk')).toBe(
      'A grant takes an @-mention, so it is made with the ids Lark sends: type @ and pick them. `lark:<union_id>` is for `/auth revoke`.',
    );
    expect(say('grant Carol talk')).toBe(HELP);
    for (const arg of ['grant @Carol Wu', 'grant @Carol Wu admin', 'grant', 'grant talk']) {
      expect(say(arg, OWNER, [AT_CAROL]), arg).toBe('`/auth grant` takes the person, then the tier: `/auth grant @Name talk` or `/auth grant @Name operate`.');
    }
    expect(activeGrant(t.db, 'cli_app', 'on_carol')).toBeUndefined();
  });

  it("refuses a mention as /kanban does, a bot's included, and in a direct message points at a group or the terminal", () => {
    expect(say('grant @Dan talk', OWNER, [AT_CAROL])).toBe('@Dan is not someone this message mentions: type @ and pick them, so Lark says who they are.');
    expect(say('grant @Dan talk', OWNER, [AT_CAROL], 'p2p')).toBe(
      '@Dan is not someone this message mentions: type @ and pick them, so Lark says who they are. In a direct message, grant in a group they are in, or with `mt auth grant` at the terminal.',
    );
    expect(say('grant @Carol Wu talk', OWNER, [{ ...AT_CAROL, unionId: null }])).toBe(
      'Lark did not say who @Carol Wu is (no union_id came with the mention). Ask the operator to check the app can read user ids.',
    );
    expect(say('grant @Carol Wu talk', OWNER, [AT_CAROL, { ...AT_CAROL, key: '@_user_9', unionId: 'on_other' }])).toMatch(/^More than one person mentioned is called @Carol Wu/);
    expect(say('grant @Helper talk', OWNER, [{ key: '@_user_7', name: 'Helper', openId: 'ou_helper', unionId: null, isBot: true }])).toBe(
      "@Helper is a bot, and a bot's tier is configuration's.",
    );
    // Mentioned in a direct message, as Lark lets one be: granted.
    expect(say('grant @Carol Wu talk', OWNER, [AT_CAROL], 'p2p')).toMatch(/^Carol Wu now has talk tier/);
  });

  it('refuses a sender Lark gave no union_id, as the grant records who made it', () => {
    expect(say('grant @Carol Wu talk', { ...OWNER, unionId: null }, [AT_CAROL])).toBe(
      'Lark did not say who you are (no union_id came with the message), and a grant records who made or ended it. Ask the operator to check the app can read user ids.',
    );
    expect(activeGrant(t.db, 'cli_app', 'on_carol')).toBeUndefined();
  });

  it('masks a name holding a known secret', () => {
    addSecrets(['sk-live-1234567890']);
    const reply = say('grant @Carol sk-live-1234567890 talk', OWNER, [{ ...AT_CAROL, name: 'Carol sk-live-1234567890' }]);
    expect(reply).toBe(`Carol ${MASK} now has talk tier, granted by Alice. \`/auth revoke lark:on_carol\` takes it back.`);
  });
});

describe('/auth revoke', () => {
  it('ends a grant by mention or by principal, says what is left, and logs it', () => {
    say('grant @Carol Wu talk', OWNER, [AT_CAROL]);
    expect(say('revoke @Carol Wu', BOB, [AT_CAROL])).toBe('Carol Wu no longer has talk tier: revoked by Bob.');
    expect(notes.at(-1)).toBe('auth: talk grant of lark:on_carol revoked by lark:on_bob in chat oc_team');
    expect(say('revoke lark:on_carol', BOB)).toBe('Carol Wu has no grant to revoke.');
    expect(say('revoke lark:on_never', BOB)).toBe('lark:on\\_never has no grant to revoke.');
    say('grant @Tess operate', OWNER, [AT_TESS]);
    expect(say('revoke @Tess', OWNER, [AT_TESS])).toBe('Tess no longer has operate tier: revoked by Alice; they keep talk tier from auth.talk in config.yaml.');
    expect(authorizer.canTalk({ openId: 'ou_carol', unionId: 'on_carol', displayName: null })).toBe(false);
  });

  it('counts the talk grants a revoked operator made that are still in force', () => {
    say('grant @Dan operate', OWNER, [AT_DAN]);
    say('grant @Carol Wu talk', DAN, [AT_CAROL]);
    say('grant @Erin talk', DAN, [AT_ERIN]);
    expect(say('revoke @Dan', OWNER, [AT_DAN])).toBe('Dan no longer has operate tier: revoked by Alice. They made 2 talk grants still in force; `/auth list` shows them.');
    expect(activeGrant(t.db, 'cli_app', 'on_carol')?.tier).toBe('talk');
  });

  it("refuses the owner, a configuration's tier, and an operator's revoke of what is the owner's; ends an owner's leftover grant", () => {
    expect(say('revoke @Alice', BOB, [AT_OWNER])).toBe('Alice is the owner, from auth.owner in config.yaml, and cannot be revoked.');
    expect(say('revoke @Tess', OWNER, [AT_TESS])).toBe(
      'Tess has talk tier from auth.talk in config.yaml, which chat cannot change: the operator edits it and restarts the gateway.',
    );
    say('grant @Dan operate', OWNER, [AT_DAN]);
    expect(say('revoke @Dan', BOB, [AT_DAN])).toBe('Dan has operate tier by a grant, which only the owner revokes.');
    say('grant @Olga talk', OWNER, [AT_OLGA]);
    expect(say('revoke @Olga', BOB, [AT_OLGA])).toBe('Olga is in auth.operate: their talk grant is what makes them an operator, so only the owner revokes it.');
    expect(say('revoke @Carol Wu', TESS, [AT_CAROL])).toBe('`/auth revoke` needs operator permission.');
    // A grant from before they were the owner.
    grantTier(t.db, { appId: 'cli_app', unionId: 'on_owner', openId: 'ou_owner', tier: 'talk', by: 'operator:x', via: 'terminal', chat: null }, () => ({ write: 'insert' as const }), 1);
    expect(say('revoke lark:on_owner', OWNER)).toBe("Alice's talk grant is revoked; they keep both tiers as the owner.");
  });

  it('takes a person and nothing else', () => {
    expect(say('revoke')).toBe('`/auth revoke` takes the person: `/auth revoke @Name`, or `/auth revoke lark:<union_id>` for someone who can no longer be mentioned.');
    expect(say('revoke Carol')).toBe(HELP);
    expect(say('revoke lark:on carol')).toBe('lark:on carol is not a person: a person is `lark:<union_id>`, which `/auth list` shows.');
  });
});

describe('/auth list and help', () => {
  it('lists the owner first, then operators, then talk, each by name, and auth.operate without talk last', () => {
    for (const p of [BOB, TESS]) people.saw({ openId: p.openId, unionId: p.unionId, name: p.displayName });
    say('grant @Carol Wu talk', OWNER, [AT_CAROL]);
    say('grant @Dan operate', OWNER, [AT_DAN, AT_OLGA]);
    expect(say('list', TESS).split('\n')).toEqual([
      'Owner: Alice (lark:on\\_owner), from auth.owner in config.yaml',
      'Bob (lark:on\\_bob): operate, from auth.operate in config.yaml',
      'Dan (lark:on\\_dan): operate, granted by Alice on 2026-11-18',
      'Carol Wu (lark:on\\_carol): talk, granted by Alice on 2026-11-18',
      'ou\\_ghost: talk, from auth.talk in config.yaml; not seen by this bot yet',
      'Tess (lark:on\\_tess): talk, from auth.talk in config.yaml',
      'Olga (lark:on\\_olga): in auth.operate without talk tier, so no tier',
    ]);
  });

  it('says a mix of sources, and cuts the list at 50 lines', () => {
    say('grant @Tess operate', OWNER, [AT_TESS]);
    expect(say('list').split('\n')).toContain('Tess (lark:on\\_tess): operate, granted by Alice on 2026-11-18; talk also from auth.talk in config.yaml');
    for (let i = 0; i < 60; i += 1) {
      grantTier(t.db, { appId: 'cli_app', unionId: `on_p${i}`, openId: `ou_p${i}`, tier: 'talk', by: 'lark:on_owner', via: 'chat', chat: 'oc_team' }, () => ({ write: 'insert' as const }), NOW);
    }
    const lines = say('list').split('\n');
    expect(lines).toHaveLength(AUTH_LIST_MAX + 1);
    expect(lines.at(-1)).toBe('and 15 more: `mt auth list` at the terminal lists everyone');
  });

  it('answers help, nothing and an unknown word with the usage', () => {
    for (const arg of ['help', '', 'frobnicate', 'list everyone']) expect(say(arg), arg).toBe(HELP);
  });
});
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/auth-chat.test.ts tests/kanban-chat.test.ts tests/lark-inbound.test.ts tests/mentions.test.ts tests/router.test.ts`. Expected: `Test Files  5 failed (5)` and `Tests  3 failed | 53 passed (56)`; `tests/auth-chat.test.ts` and `tests/router.test.ts` fail to load, `Error: Cannot find module '../src/policy/auth-chat.js'`, and the other three fail on the bot's mention.

- [ ] **Step 8.3: Implement.**

In `src/channel/lark/inbound.ts`, replace:

```ts
 * left out. Anything not shaped like a mention is skipped.
```

with:

```ts
 * left out. Anything not shaped like a mention is skipped. A mention's
 * `mentioned_type`, when Lark sends one, says whether it is of a bot.
```

In `src/channel/lark/inbound.ts`, replace:

```ts
    out.push({ key, name: text(m['name']), openId, unionId: text(ids['union_id']) });
```

with:

```ts
    const type = text(m['mentioned_type']);
    out.push({ key, name: text(m['name']), openId, unionId: text(ids['union_id']), ...(type === null ? {} : { isBot: type === 'bot' }) });
```

In `src/channel/mentions.ts`, replace:

```ts
export type MentionRefusal = 'not_mentioned' | 'no_union_id' | 'ambiguous';
```

with:

```ts
export type MentionRefusal = 'not_mentioned' | 'bot' | 'no_union_id' | 'ambiguous';
```

In `src/channel/mentions.ts`, replace:

```ts
 * sent. Refused when the message mentions no one by it, when Lark gave no
 * union_id with the mention, and when more than one person is shown by it.
```

with:

```ts
 * sent. Refused when the message mentions no one by it, when the mention is
 * of a bot, when Lark gave no union_id with the mention, and when more than
 * one person is shown by it.
```

In `src/channel/mentions.ts`, replace:

```ts
  const unionId = unionIds[0];
```

with:

```ts
  if (found.some((m) => m.isBot === true)) {
    return { ok: false, reason: 'bot', reply: `${label(name, 80)} is a bot, and a bot's tier is configuration's.` };
  }
  const unionId = unionIds[0];
```

In `src/core/commands.ts`, replace:

```ts
    usage: '/cron <command>',
  },
```

with:

```ts
    usage: '/cron <command>',
  },
  {
    name: 'auth',
    // Talk, because listing who has a tier is; a grant and a revoke check their own
    // tier, the owner's or an operator's (tier grants spec §5.1).
    tier: 'talk',
    needsSession: false,
    effect: 'immediate',
    multiline: false,
    // It never touches this chat's session, so a busy one does not refuse it.
    mutating: false,
    summary: 'Who may talk to the agent and operate it: `/auth help` lists its commands.',
    usage: '/auth <command>',
  },
```

In `src/core/router.ts`, replace:

```ts
  cron?: { run(arg: string, message: InboundMessage, key: BindingKey): Promise<string> };
```

with:

```ts
  cron?: { run(arg: string, message: InboundMessage, key: BindingKey): Promise<string> };
  /**
   * `/auth` (tier grants spec §6.1): always on, as the tiers are the gateway's.
   * Its grants and revokes check their own tier, through the same authorizer.
   * `AuthChat`; absent only where a caller gives none, and `/auth` says so.
   */
  auth?: { run(arg: string, message: InboundMessage): string };
```

In `src/core/router.ts`, replace:

```ts
/** What `/cron` says on a gateway whose cron is off. */
```

with:

```ts
/** What `/auth` says where nothing was given to answer it. */
export const AUTH_OFF = 'The tiers cannot be listed or changed here.';

/** What `/cron` says on a gateway whose cron is off. */
```

In `src/core/router.ts`, replace:

```ts
      case 'cd': {
```

with:

```ts
      case 'auth': {
        const auth = this.#deps.auth;
        let text: string;
        if (auth === undefined) text = AUTH_OFF;
        else {
          try {
            text = auth.run(arg, message);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            this.#note(`auth command in ${message.messageId} failed: ${redactKnownSecrets(detail)}`);
            text = `The tiers could not be read or changed: ${label(detail, 600)}`;
          }
        }
        // Names were masked as they were put in; the whole reply once more, as /kanban's is.
        await this.#reply(target, message, 'auth', redactKnownSecrets(text));
        return;
      }

      case 'cd': {
```

In `src/db/WRITERS.md`, replace:

```markdown
| `people` | `db/people.ts` | One row per person per bot (migration 005): the open_id and name Lark last gave with a union_id, noted when a person sends a `/kanban` command, is mentioned in one, or presses a board card's button. How a person named by `lark:<union_id>` alone is checked for talk tier (spec §4.2). |
```

with:

```markdown
| `people` | `db/people.ts` | One row per person per bot (migration 005): the open_id and name Lark last gave with a union_id, noted when a person sends a `/kanban` command, is mentioned in one, or presses a board card's button, and when a person sends an `/auth` command or is mentioned in one (tier grants spec §6.1). How a person named by `lark:<union_id>` alone is checked for talk tier (spec §4.2). |
```

In `src/index.ts`, replace:

```ts
import { Authorizer, tiersOf } from './policy/auth.js';
```

with:

```ts
import { Authorizer, tiersOf } from './policy/auth.js';
import { AuthChat } from './policy/auth-chat.js';
```

In `src/index.ts`, replace:

```ts
  if (config.kanban.enabled) {
    const { failureLimit, transientLimit, transientCooldownS } = config.kanban;
    // Who the gateway has seen in Lark: how a person named by principal is checked for talk tier (spec §4.2).
    const people = new PeopleDirectory({
      db,
      appId: config.lark.appId,
      // The configuration's lists and the grant, as the authorizer holds them, for a person named by principal (tier grants spec §4.3).
      canTalk: (person) => tiersOf(config.auth, person.openId, authorizer.grantOf(person.unionId)).talk,
    });
```

with:

```ts
  // Who the gateway has seen in Lark: how a person named by principal is checked for talk tier (spec §4.2),
  // and named in /auth's lists, the board on or off (tier grants spec §6.1).
  const people = new PeopleDirectory({
    db,
    appId: config.lark.appId,
    // The configuration's lists and the grant, as the authorizer holds them, for a person named by principal (tier grants spec §4.3).
    canTalk: (person) => tiersOf(config.auth, person.openId, authorizer.grantOf(person.unionId)).talk,
  });
  // /auth, always on: the tiers are the gateway's, whatever kanban.enabled and cron.enabled say (tier grants spec §6.1).
  const authChat = new AuthChat({ db, appId: config.lark.appId, authorizer, auth: config.auth, people, zone, note });
  if (config.kanban.enabled) {
    const { failureLimit, transientLimit, transientCooldownS } = config.kanban;
```

In `src/index.ts`, replace:

```ts
    ...(cronChat === undefined ? {} : { cron: cronChat }),
```

with:

```ts
    ...(cronChat === undefined ? {} : { cron: cronChat }),
    auth: authChat,
```

In `src/policy/grants.ts`, replace:

```ts
import type { Tier } from '../types.js';
import { tiersFrom } from './auth.js';
```

with:

```ts
import type { GrantRow, NamedGrant } from '../db/grants.js';
import type { PersonRow } from '../db/people.js';
import type { Tier } from '../types.js';
import { sourcesOf, tiersFrom } from './auth.js';
```

In `src/policy/grants.ts`, replace:

```ts
          return say(w.via, [`${w.who} is in ${w.from.operate}: their talk grant is what makes them an operator, so only the owner revokes it`]);
      }
  }
}
```

with:

```ts
          return say(w.via, [`${w.who} is in ${w.from.operate}: their talk grant is what makes them an operator, so only the owner revokes it`]);
      }
  }
}

/** Someone with a tier, or in `auth.operate` without one, as the lists show them (tier grants spec §8). */
export interface TierEntry {
  /** Null for a configuration entry `people` does not hold. */
  unionId: string | null;
  /** The open_id `people` holds, or the configuration's entry's; null for a grant to a person `people` does not hold. */
  openId: string | null;
  name: string | null;
  sources: Sources;
  grant: GrantRow | undefined;
  tier: Tier | null;
}

/** The configuration's owner and lists, by open_id, as the gateway or this shell reads them. */
export interface ConfigLists {
  owner: string;
  talk: readonly string[];
  operate: readonly string[];
}

/** The order the lists give: the owner first, then operators, then talk, then those with no tier, each by name. */
function rank(e: TierEntry): number {
  if (e.sources.owner) return 0;
  return e.tier === 'operate' ? 1 : e.tier === 'talk' ? 2 : 3;
}

/**
 * Everyone with a tier, from the configuration's lists and this bot's active
 * grants: a configuration entry named by the person `people` holds with its
 * open_id, a grant by its union_id, one entry a person. A person in
 * `auth.operate` without talk, the case a grant to them guards, is listed
 * with no tier. Sorted as the lists give them.
 */
export function tierEntries(lists: ConfigLists, grants: readonly NamedGrant[], people: readonly PersonRow[]): TierEntry[] {
  const byOpenId = new Map(people.map((p) => [p.openId, p]));
  const byUnionId = new Map(people.map((p) => [p.unionId, p]));
  const config = { ownerOpenId: lists.owner, allowTalk: lists.talk, allowOperate: lists.operate };
  const entries = new Map<string, Omit<TierEntry, 'sources' | 'tier'>>();
  for (const g of grants) {
    const p = byUnionId.get(g.unionId);
    entries.set(`u:${g.unionId}`, { unionId: g.unionId, openId: p?.openId ?? null, name: p?.name ?? g.name, grant: g });
  }
  for (const openId of new Set([lists.owner, ...lists.talk, ...lists.operate])) {
    const p = byOpenId.get(openId);
    const key = p === undefined ? `o:${openId}` : `u:${p.unionId}`;
    if (!entries.has(key)) entries.set(key, { unionId: p?.unionId ?? null, openId, name: p?.name ?? null, grant: undefined });
  }
  const out = [...entries.values()].map((e) => {
    const sources = sourcesOf(config, e.openId);
    return { ...e, sources, tier: tierOf(tiersFrom(sources, e.grant?.tier)) };
  });
  const sortName = (e: TierEntry): string => e.name ?? (e.unionId === null ? (e.openId ?? '') : `lark:${e.unionId}`);
  return out.sort((a, b) => rank(a) - rank(b) || sortName(a).localeCompare(sortName(b)) || (a.unionId ?? a.openId ?? '').localeCompare(b.unionId ?? b.openId ?? ''));
}
```

In `src/types.ts`, replace:

```ts
  openId: string | null;
  unionId: string | null;
```

with:

```ts
  openId: string | null;
  unionId: string | null;
  /**
   * Whether Lark says the mention is of a bot, by its `mentioned_type`; absent
   * when Lark did not say. A bot is not a person: its tier is configuration's.
   */
  isBot?: boolean;
```

Create `src/policy/auth-chat.ts`:

```ts
import { mentionedPerson } from '../channel/mentions.js';
import { sourceText, type GatewayConfig } from '../config.js';
import { formatWall } from '../cron/schedule.js';
import { activeGrants, grantTier, revokeGrant, talkGrantsMadeBy, type GrantRow } from '../db/grants.js';
import type { Db } from '../db/open.js';
import { peopleOf, personOf } from '../db/people.js';
import { label } from '../kanban/chat-render.js';
import { personPrincipal, unionIdOf, type PeopleDirectory } from '../kanban/people.js';
import { systemClock, type Clock } from '../time.js';
import type { InboundMention, InboundMessage, Principal } from '../types.js';
import type { Authorizer } from './auth.js';
import {
  actorOf,
  decideGrant,
  decideRevoke,
  grantReply,
  revokeReply,
  tierEntries,
  type Actor,
  type Held,
  type Target,
  type TierEntry,
  type Words,
} from './grants.js';

/**
 * `/auth` in chat (the tier grants spec §6.1, §8.1): `list` at talk tier, and
 * `grant @Name talk|operate` and `revoke @Name` or `revoke lark:<union_id>`,
 * each judged by `decideGrant` or `decideRevoke` inside the writer's
 * transaction. A grant takes an @-mention only, so it is always made with the
 * ids Lark sent: nobody types an id. Always on, the board and cron off or not.
 *
 * The reply is the announcement: one line in the chat or thread it was typed
 * in, naming the person by the name Lark's mention showed, never by a mention
 * of its own. Names are shown through `label`, masked, and the router masks
 * the whole reply once more.
 */

export interface AuthChatDeps {
  db: Db;
  /** This bot: grants are per app id. */
  appId: string;
  /** The owner and the sources a decision is fed: the router's authorizer. */
  authorizer: Authorizer;
  /** The configuration's owner and lists, and where each came from, for the list and the words. */
  auth: Pick<GatewayConfig['auth'], 'ownerOpenId' | 'allowTalk' | 'allowOperate' | 'from'>;
  /** Who the gateway has seen: each sender and mention is noted here first. */
  people: PeopleDirectory;
  /** The zone a grant's day is said in: `cron.tz`, else the process's. */
  zone: string;
  clock?: Clock;
  /** The log: one line a change, ids only (§7). */
  note?: (line: string) => void;
}

/** At most this many lines of `/auth list`, then how many more. */
export const AUTH_LIST_MAX = 50;

const HELP = [
  '`/auth list`: everyone with a tier, and where it comes from.',
  "`/auth grant @Name talk` or `/auth grant @Name operate`: give a tier beside the configuration's lists. An operator grants talk; only the owner grants operate.",
  '`/auth revoke @Name` or `/auth revoke lark:<union_id>`: end a grant. The configuration and the owner are never changed from chat.',
].join('\n');

const NO_UNION_ID =
  'Lark did not say who you are (no union_id came with the message), and a grant records who made or ended it. Ask the operator to check the app can read user ids.';

/** What Lark gave for a sender or a mention, as the people directory notes it. */
function seen(p: Principal | InboundMention): { openId: string | null; unionId: string | null; name: string | null } {
  return 'key' in p ? { openId: p.openId, unionId: p.unionId, name: p.name } : { openId: p.openId, unionId: p.unionId, name: p.displayName };
}

/** A grant's maker and moment, as a decision's words need them. */
function held(g: GrantRow | undefined): Held | undefined {
  return g === undefined ? undefined : { tier: g.tier, by: g.grantedBy, at: g.grantedAt };
}

/** The person a command names: their union_id, the open_id to judge them by, and the name to call them. */
interface Named {
  unionId: string;
  openId: string | null;
  who: string;
}

/** Why a command names no one: the reply, and whether the message mentions no one by the name typed. */
interface Unnamed {
  refused: string;
  notMentioned: boolean;
}

export class AuthChat {
  readonly #deps: AuthChatDeps;
  readonly #clock: Clock;

  constructor(deps: AuthChatDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /** `/auth <arg>` from this message: the reply. */
  run(arg: string, message: InboundMessage): string {
    const head = /^\s*(\S*)\s*/.exec(arg)?.[0] ?? '';
    const verb = head.trim().toLowerCase();
    const rest = arg.slice(head.length).trim();
    // Noted first, as /kanban notes them: the person granted can be named by principal at once, and has a name in the lists.
    this.#deps.people.saw(seen(message.sender));
    for (const m of message.mentions ?? []) this.#deps.people.saw(seen(m));
    switch (verb) {
      case 'list':
        return rest === '' ? this.#list() : HELP;
      case 'grant':
        return this.#grant(rest, message);
      case 'revoke':
        return this.#revoke(rest, message);
      default:
        return HELP;
    }
  }

  #grant(rest: string, message: InboundMessage): string {
    const parts = /^(.*\S)\s+(\S+)$/.exec(rest);
    const tier = parts?.[2]?.toLowerCase();
    if (parts === null || (tier !== 'talk' && tier !== 'operate')) {
      return '`/auth grant` takes the person, then the tier: `/auth grant @Name talk` or `/auth grant @Name operate`.';
    }
    const name = (parts[1] ?? '').trim();
    if (name.startsWith('lark:')) {
      return 'A grant takes an @-mention, so it is made with the ids Lark sends: type @ and pick them. `lark:<union_id>` is for `/auth revoke`.';
    }
    if (!name.startsWith('@')) return HELP;
    const by = this.#by(message);
    if (by === undefined) return NO_UNION_ID;
    const found = this.#mentioned(name, message);
    if ('refused' in found) {
      // In a direct message, a person can be @-mentioned only where Lark lets them be.
      return message.chatType === 'p2p' && found.notMentioned
        ? `${found.refused} In a direct message, grant in a group they are in, or with \`mt auth grant\` at the terminal.`
        : found.refused;
    }
    if (found.openId === null) {
      return `Lark did not say who ${label(name, 80)} is (no open_id came with the mention). Ask the operator to check the app can read user ids.`;
    }
    const sources = this.#deps.authorizer.sourcesOf(found.openId);
    let target: Target = { sources, grant: undefined };
    const r = grantTier(
      this.#deps.db,
      { appId: this.#deps.appId, unionId: found.unionId, openId: found.openId, tier, by, via: 'chat', chat: message.chatId },
      (grant, actorGrant) => {
        target = { sources, grant: held(grant) };
        return decideGrant(this.#actor(message.sender, actorGrant), target, tier);
      },
      this.#clock.now(),
    );
    const d = r.decision;
    const principal = personPrincipal(found.unionId);
    if (d.outcome === 'granted') this.#note(`auth: ${d.tier} granted to ${principal} by ${by} in chat ${message.chatId}`);
    if (d.outcome === 'replaced') this.#note(`auth: operate granted to ${principal} by ${by} in chat ${message.chatId} (replacing talk)`);
    return grantReply(d, target, this.#words(found.who, principal, message.sender));
  }

  #revoke(rest: string, message: InboundMessage): string {
    if (rest === '') return '`/auth revoke` takes the person: `/auth revoke @Name`, or `/auth revoke lark:<union_id>` for someone who can no longer be mentioned.';
    const by = this.#by(message);
    if (by === undefined) return NO_UNION_ID;
    let found: Named | Unnamed;
    if (rest.startsWith('lark:')) {
      const unionId = unionIdOf(rest);
      if (unionId === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(unionId)) return `${label(rest, 80)} is not a person: a person is \`lark:<union_id>\`, which \`/auth list\` shows.`;
      const p = personOf(this.#deps.db, this.#deps.appId, unionId);
      found = { unionId, openId: p?.openId ?? null, who: p?.name === null || p?.name === undefined ? label(rest, 80) : label(p.name, 80) };
    } else if (rest.startsWith('@')) {
      found = this.#mentioned(rest, message);
    } else {
      return HELP;
    }
    if ('refused' in found) return found.refused;
    const named = found;
    const sources = this.#deps.authorizer.sourcesOf(named.openId);
    let target: Target = { sources, grant: undefined };
    const r = revokeGrant(
      this.#deps.db,
      { appId: this.#deps.appId, unionId: named.unionId, by, via: 'chat', chat: message.chatId },
      (grant, actorGrant) => {
        target = { sources, grant: held(grant) };
        return decideRevoke(this.#actor(message.sender, actorGrant), target);
      },
      this.#clock.now(),
    );
    const d = r.decision;
    const principal = personPrincipal(named.unionId);
    let made = 0;
    if (d.outcome === 'revoked') {
      this.#note(`auth: ${d.grant} grant of ${principal} revoked by ${by} in chat ${message.chatId}`);
      if (d.grant === 'operate') made = talkGrantsMadeBy(this.#deps.db, this.#deps.appId, principal);
    }
    return revokeReply(d, target, this.#words(named.who, principal, message.sender), made);
  }

  /** `/auth list` (§8.1): everyone with a tier, the owner first, at most `AUTH_LIST_MAX` lines. */
  #list(): string {
    const { auth, db, appId } = this.#deps;
    const entries = tierEntries({ owner: auth.ownerOpenId, talk: auth.allowTalk, operate: auth.allowOperate }, activeGrants(db, appId), peopleOf(db, appId));
    const lines = entries.map((e) => this.#line(e));
    if (lines.length <= AUTH_LIST_MAX) return lines.join('\n');
    return [...lines.slice(0, AUTH_LIST_MAX), `and ${lines.length - AUTH_LIST_MAX} more: \`mt auth list\` at the terminal lists everyone`].join('\n');
  }

  #line(e: TierEntry): string {
    const from = this.#deps.auth.from;
    const who =
      e.unionId === null
        ? label(e.openId ?? '', 80)
        : e.name === null
          ? label(personPrincipal(e.unionId), 80)
          : `${label(e.name, 80)} (${label(personPrincipal(e.unionId), 80)})`;
    const unseen = e.unionId === null ? '; not seen by this bot yet' : '';
    const g = e.grant;
    const granted = g === undefined ? '' : `granted by ${this.#nameOf(g.grantedBy)} on ${this.#day(g.grantedAt)}`;
    if (e.sources.owner) return `Owner: ${who}, ${sourceText(from.owner)}${g === undefined ? '' : `; also a ${g.tier} grant, ${granted}`}${unseen}`;
    if (e.tier === null) return `${who}: in ${from.operate} without talk tier, so no tier${unseen}`;
    let why: string;
    if (e.tier === 'operate') {
      if (e.sources.operate && e.sources.talk) why = `${sourceText(from.operate)}${g === undefined ? '' : `; also a ${g.tier} grant, ${granted}`}`;
      else if (g?.tier === 'operate') why = `${granted}${e.sources.talk ? `; talk also ${sourceText(from.talk)}` : ''}`;
      else why = `${sourceText(from.operate)}, with talk ${granted}`;
    } else {
      why = e.sources.talk ? `${sourceText(from.talk)}${g === undefined ? '' : `; also ${granted}`}` : granted;
    }
    return `${who}: ${e.tier}, ${why}${unseen}`;
  }

  /** The sender's principal, which a grant records; undefined when Lark gave no union_id. */
  #by(message: InboundMessage): string | undefined {
    const u = message.sender.unionId;
    return u === null || u === '' ? undefined : personPrincipal(u);
  }

  /** The sender as an actor, by the grant read inside the transaction. */
  #actor(sender: Principal, grant: GrantRow | undefined): Actor {
    if (this.#deps.authorizer.isOwner(sender)) return 'owner';
    return actorOf(this.#deps.authorizer.sourcesOf(sender.openId), grant?.tier);
  }

  /** The person an `@Name` stands for, by the name Lark's mention showed; or why not. */
  #mentioned(name: string, message: InboundMessage): Named | Unnamed {
    const found = mentionedPerson(name, message);
    if (!found.ok) return { refused: found.reply, notMentioned: found.reason === 'not_mentioned' };
    return { unionId: found.unionId, openId: found.openId, who: label(found.name ?? name.slice(1).trim(), 80) };
  }

  #words(who: string, principal: string, sender: Principal): Words {
    const u = sender.unionId;
    const by = sender.displayName === null || sender.displayName === '' ? label(u === null ? sender.openId : personPrincipal(u), 80) : label(sender.displayName, 80);
    return { via: 'chat', who, principal, by, from: this.#deps.auth.from, held: (g) => `${this.#nameOf(g.by)} on ${this.#day(g.at)}` };
  }

  /** A grant's maker, by the name Lark last gave for them, else their principal. */
  #nameOf(principal: string): string {
    const name = this.#deps.people.nameOf(principal);
    return label(name ?? principal, 80);
  }

  #day(at: number): string {
    return formatWall(this.#deps.zone, at).slice(0, 10);
  }

  #note(line: string): void {
    try {
      this.#deps.note?.(line);
    } catch {
      // The log is told, never relied on.
    }
  }
}
```

- [ ] **Step 8.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2614 passed (2614)`. Run `npx vitest run --project e2e`. Expected: `Tests  172 passed (172)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.5: Commit.**

```bash
git add src/channel/lark/inbound.ts src/channel/mentions.ts src/core/commands.ts src/core/router.ts src/db/WRITERS.md src/index.ts src/policy/auth-chat.ts src/policy/grants.ts src/types.ts tests/auth-chat.test.ts tests/kanban-chat.test.ts tests/lark-inbound.test.ts tests/mentions.test.ts tests/router.test.ts
git commit -m "Add /auth in chat, always on at talk tier: grant talk or operate to a person by @-mention, with the ids Lark sent, revoke by mention or lark:<union_id>, and list everyone with a tier, each change judged inside the writer's transaction and answered with one line in the chat; refuse a bot's mention"
```

---

### Task 9: `mt auth` at the terminal

**Files:**

- Create: `src/cli/auth.ts`, `tests/mt-auth.test.ts`, `tests/auth-gateway.e2e.ts`
- Modify: `src/cli/mt.ts`

§6.2, §8.2, §9. `mt auth grant|revoke|list`, as the terminal (Decision 13): a group of its own, loaded through `withGatewayFile`, refused in an agent's shell by `inAgentRun` before its arguments are read, its refusals in §6.2's words and codes, `--json` on all three. The end-to-end test runs a gateway on the fake Lark: the owner grants talk by @-mention in a group and the person's next message runs a turn, an operator's grant of operate is refused, and `mt auth revoke`, as another process, refuses the person's next message with no restart.

- [ ] **Step 9.1: Write the tests.**

Create `tests/auth-gateway.e2e.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import type { Channel } from '../src/channel/types.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/index.js';
import { mtCommand } from '../src/kanban/shim.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam } from '../src/team.js';
import { FakeChannel } from './helpers/channel.js';

/**
 * Tier grants through createGateway (the tier grants spec §11, end to end),
 * with the fake chat standing in for Lark and the fake CLI agent for the
 * role's, the board and cron off: the owner grants talk in a group and the
 * person's next message runs a turn; an operator's grant of operate is
 * refused; and `mt auth revoke`, run as another process while the gateway
 * runs, refuses the person's next message, with no restart.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

let root: string;
let home: string;
let log: string;
let env: Record<string, string>;
let config: GatewayConfig;
let lark: FakeChannel;
let handlers: { message: (msg: unknown) => Promise<void> } | undefined;
let gateway: Gateway | undefined;
let seq = 0;

const CHANNEL_METHODS = ['sendText', 'openCard', 'sendApprovalCard', 'updateApprovalCard', 'sendCard', 'updateCard', 'react', 'unreact', 'chatMembers'] as const;

interface Person {
  openId: string;
  unionId: string;
  name: string;
}
const OWNER: Person = { openId: 'ou_owner', unionId: 'on_owner', name: 'Alice' };
const BOB: Person = { openId: 'ou_bob', unionId: 'on_bob', name: 'Bob' };
const CAROL: Person = { openId: 'ou_carol', unionId: 'on_carol', name: 'Carol Wu' };
const DAN: Person = { openId: 'ou_dan', unionId: 'on_dan', name: 'Dan' };

beforeEach(() => {
  clearSecrets();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-auth-gw-')));
  home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'repo'));
  log = join(root, 'agent.log');
  env = {
    MT_HOME: home,
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: join(root, 'repo'),
    MT_OWNER_OPEN_ID: OWNER.openId,
    MT_ALLOW_TALK: BOB.openId,
    MT_ALLOW_OPERATE: BOB.openId,
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: process.execPath,
    MT_AGENT_ARGS: AGENT,
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
    MT_AGENT_ENV_FAKE_CLI_LOG: log,
  };
  config = loadConfig(env, () => undefined);
  lark = new FakeChannel({ id: 'lark' });
  vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(LarkAdapter.prototype, 'disconnect').mockResolvedValue(undefined);
  vi.spyOn(LarkAdapter.prototype, 'botOpenId', 'get').mockReturnValue('ou_bot');
  vi.spyOn(LarkAdapter.prototype, 'raw', 'get').mockReturnValue({
    on: (h: typeof handlers) => {
      handlers = h;
      return () => {
        handlers = undefined;
      };
    },
  } as never);
  for (const method of CHANNEL_METHODS) {
    const fake = (lark as unknown as Record<string, (...args: unknown[]) => unknown>)[method] as (...args: unknown[]) => unknown;
    vi.spyOn(LarkAdapter.prototype as unknown as Channel, method).mockImplementation(((...args: unknown[]) => fake.apply(lark, args)) as never);
  }
});

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  vi.restoreAllMocks();
  clearSecrets();
  rmSync(root, { recursive: true, force: true });
});

/** A message in the group, addressed to the bot, mentioning `mentions`, as the SDK hands it to the inbound side. */
async function inGroup(sender: Person, text: string, mentions: Person[] = []): Promise<string> {
  if (handlers === undefined) throw new Error('the inbound side is not listening');
  const messageId = `om_auth_${++seq}`;
  await handlers.message({
    messageId,
    chatId: 'oc_team',
    chatType: 'group',
    threadId: undefined,
    senderId: sender.openId,
    senderName: sender.name,
    content: text,
    mentionedBot: true,
    mentionAll: false,
    resources: [],
    createTime: Date.now(),
    raw: {
      sender: { sender_type: 'user', sender_id: { union_id: sender.unionId } },
      message: {
        mentions: [
          { key: '@_user_1', name: 'Bot', id: { open_id: 'ou_bot' } },
          ...mentions.map((m, i) => ({ key: `@_user_${i + 2}`, name: m.name, id: { open_id: m.openId, union_id: m.unionId } })),
        ],
      },
    },
  });
  return messageId;
}

/** Wait for `ok`, polling, for up to about 30 s: a loaded machine starts the fake agent slowly. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1200; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** The prompts the fake agent was given, in order. */
function prompts(): string[] {
  try {
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => (JSON.parse(l) as { prompt: string }).prompt);
  } catch {
    return [];
  }
}

const replies = (): string[] => lark.texts.map((m) => m.text);

/** `mt <args>` as another process: this build's, with the gateway's settings. */
function mt(args: string[]): Promise<{ status: number | null; out: string; err: string }> {
  const [command, ...rest] = mtCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command ?? process.execPath, [...rest, ...args], { env: { ...env, PATH: process.env['PATH'] ?? '', HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
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

function outcome(messageId: string): string | undefined {
  return (gateway?.db.prepare('SELECT outcome FROM seen_messages WHERE message_id = ?').get(messageId) as { outcome: string } | undefined)?.outcome;
}

describe('tier grants through createGateway', () => {
  it("lets a person granted talk in a group run a turn at once, refuses an operator's grant of operate, and takes a terminal's revoke at the next message", async () => {
    gateway = await createGateway(config, loadTeam(config, {}));
    await gateway.start();

    const before = await inGroup(CAROL, 'before the grant');
    expect(outcome(before)).toBe('rejected');

    await inGroup(OWNER, '/auth grant @Carol Wu talk', [CAROL]);
    expect(replies().at(-1)).toBe('Carol Wu now has talk tier, granted by Alice. `/auth revoke lark:on_carol` takes it back.');
    await inGroup(CAROL, 'hello after the grant');
    await until('the turn to run', () => prompts().some((p) => p.includes('hello after the grant')));

    await inGroup(BOB, '/auth grant @Dan operate', [DAN]);
    expect(replies().at(-1)).toBe('Only the owner grants operate tier: an operator cannot make another operator.');

    const revoked = await mt(['auth', 'revoke', 'lark:on_carol', '--json']);
    expect(revoked.status, revoked.err).toBe(0);
    expect(JSON.parse(revoked.out)).toEqual({ ok: true, outcome: 'revoked', tier: null, principal: 'lark:on_carol' });
    const after = await inGroup(CAROL, 'hello after the revoke');
    expect(outcome(after)).toBe('rejected');
    expect(prompts().some((p) => p.includes('after the revoke'))).toBe(false);
  });
});
```

Create `tests/mt-auth.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activeGrant, grantTier } from '../src/db/grants.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { operatorName } from '../src/cli/gate.js';
import { formatWall } from '../src/cron/schedule.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `mt auth` (the tier grants spec §6.2, §8.2): grant, revoke and list at the
 * terminal, as the owner, against a temporary home and database; `--json` on
 * each; every refusal and its code; and refused in an agent's shell.
 */

let fx: MtFixture;
let db: Db;
const ME = operatorName({ env: process.env, out: () => undefined, err: () => undefined });
const ZONE = 'Asia/Shanghai';

afterEach(() => {
  clearSecrets();
  db?.close();
  fx?.cleanup();
});

const AUTH = ['auth:', '  owner: ou_owner', '  talk: [ou_tess, ou_bob]', '  operate: [ou_bob, ou_olga]'];

/** A home with the bot's app id and the lists given, and people this bot has seen; its database migrated to `upTo`, or every migration. */
function setup(lines: string[] = ['lark:', '  appId: cli_app', ...AUTH], upTo?: number): void {
  clearSecrets();
  fx = mtFixture((ws) => [`workspace: ${ws}`, ...lines, 'cron:', `  tz: ${ZONE}`, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
  let schema = SCHEMA_DIR;
  if (upTo !== undefined) {
    schema = mkdtempSync(join(fx.root, 'schema-'));
    for (const f of readdirSync(SCHEMA_DIR)) if (Number(f.slice(0, 3)) <= upTo) copyFileSync(join(SCHEMA_DIR, f), join(schema, f));
  }
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, schema);
  for (const [id, name] of [['owner', 'Alice'], ['tess', 'Tess'], ['bob', 'Bob'], ['carol', 'Carol Wu'], ['olga', 'Olga'], ['dan', null]] as const) {
    notePerson(db, { appId: 'cli_app', unionId: `on_${id}`, openId: `ou_${id}`, name }, 1);
  }
}

const auth = (argv: string[], env: Record<string, string | undefined> = {}) => fx.run(['auth', ...argv], { env });
const json = async (argv: string[], env: Record<string, string | undefined> = {}): Promise<unknown> => JSON.parse((await auth([...argv, '--json'], env)).out);

describe('mt auth grant', () => {
  it('grants a person this bot has seen, as the operator, at the terminal, and says a tier already held', async () => {
    setup();
    expect(await auth(['grant', 'lark:on_carol', 'talk'])).toEqual({
      code: 0,
      out: `Carol Wu (lark:on_carol) now has talk tier, granted by ${ME}; mt auth revoke lark:on_carol takes it back`,
      err: '',
    });
    const g = activeGrant(db, 'cli_app', 'on_carol');
    expect(g).toMatchObject({ tier: 'talk', openId: 'ou_carol', grantedBy: ME, grantedVia: 'terminal', grantedChat: null });
    expect(await auth(['grant', 'lark:on_carol', 'TALK'])).toEqual({
      code: 0,
      out: `Carol Wu (lark:on_carol) already has talk tier, by a grant from ${ME} on ${formatWall(ZONE, g?.grantedAt ?? 0).slice(0, 10)}`,
      err: '',
    });
    expect(await json(['grant', 'lark:on_carol', 'operate'])).toEqual({ ok: true, outcome: 'replaced', tier: 'operate', principal: 'lark:on_carol' });
    expect(await json(['grant', 'lark:on_carol', 'talk'])).toEqual({ ok: true, outcome: 'already', tier: 'operate', principal: 'lark:on_carol' });
    expect(await json(['grant', 'lark:on_dan', 'operate'])).toEqual({ ok: true, outcome: 'granted', tier: 'operate', principal: 'lark:on_dan' });
    expect((await auth(['grant', 'lark:on_dan', 'talk'])).out).toMatch(/^lark:on_dan already has operate tier, by a grant from .+, which includes talk; to leave them talk alone/);
    // As the owner: talk to a person in auth.operate alone, which makes them an operator.
    expect(await json(['grant', 'lark:on_olga', 'talk'])).toEqual({ ok: true, outcome: 'granted', tier: 'operate', principal: 'lark:on_olga' });
    expect(await json(['grant', 'lark:on_owner', 'talk'])).toEqual({ ok: true, outcome: 'already', tier: 'operate', principal: 'lark:on_owner' });
  });

  it("refuses a person this bot has not seen, an open_id, an @-mention and anything else, in their words", async () => {
    setup();
    expect(await auth(['grant', 'lark:on_stranger', 'talk'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: lark:on_stranger is not someone this bot has seen: mt kanban people lists those it has, or grant them in chat with /auth grant @Name talk, which needs no id',
    });
    expect(await json(['grant', 'lark:on_stranger', 'talk'])).toMatchObject({ ok: false, code: 'unknown_person' });
    expect(await json(['grant', 'ou_carol', 'talk'])).toEqual({
      ok: false,
      code: 'open_id',
      message: 'ou_carol is an open_id, which is per app: a person is lark:<union_id>, which mt auth list and mt kanban people give',
    });
    expect(await json(['grant', '@Carol', 'talk'])).toEqual({
      ok: false,
      code: 'invalid',
      message: 'there are no @-mentions at the terminal: a person is lark:<union_id>, which mt kanban people lists',
    });
    expect(await json(['revoke', 'carol'])).toMatchObject({ ok: false, code: 'invalid', message: 'carol is not a person: a person is lark:<union_id>, which mt auth list and mt kanban people give' });
    expect(activeGrant(db, 'cli_app', 'on_carol')).toBeUndefined();
  });

  it('is refused with no app id, with no owner, and on a database not yet migrated to grants, or none', async () => {
    setup(AUTH);
    expect(await json(['list'])).toEqual({ ok: false, code: 'no_bot', message: 'there is no bot to grant for: this shell finds no lark.appId or LARK_APP_ID' });
    db.close();
    fx.cleanup();
    setup(['lark:', '  appId: cli_app']);
    const noOwner = 'this shell finds no auth.owner or MT_OWNER_OPEN_ID, so it cannot tell what the configuration gives';
    expect(await json(['grant', 'lark:on_carol', 'talk'])).toEqual({ ok: false, code: 'no_owner', message: noOwner });
    expect(await auth(['revoke', 'lark:on_carol'])).toEqual({ code: 1, out: '', err: `mt: ${noOwner}` });
    // The owner only the .env holds counts.
    expect((await auth(['grant', 'lark:on_carol', 'talk'], { MT_OWNER_OPEN_ID: 'ou_owner' })).code).toBe(0);
    db.close();
    fx.cleanup();
    setup(undefined, 10);
    const path = join(fx.home, 'team.db');
    expect(await json(['list'])).toEqual({ ok: false, code: 'not_migrated', message: `the database at ${path} has no tier grants yet: start the gateway once, so it is migrated` });
    db.close();
    rmSync(path);
    expect(await auth(['list'])).toEqual({ code: 1, out: '', err: `mt: there is no database at ${path}: the gateway creates it when it first starts` });
  });

  it('takes a person and a tier, and nothing else', async () => {
    setup();
    for (const argv of [[], ['grant'], ['grant', 'lark:on_carol'], ['grant', 'lark:on_carol', 'admin'], ['grant', 'lark:on_carol', 'talk', 'x'], ['revoke'], ['list', 'all'], ['frob'], ['grant', 'lark:on_carol', 'talk', '--force']]) {
      const r = await auth(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err, argv.join(' ')).toMatch(/^mt: /);
    }
  });
});

describe('mt auth revoke', () => {
  it('ends a grant, says what is left, counts the talk grants a revoked operator made, and is a no-op with none', async () => {
    setup();
    await auth(['grant', 'lark:on_tess', 'operate']);
    expect(await auth(['revoke', 'lark:on_tess'])).toEqual({
      code: 0,
      out: `Tess (lark:on_tess) no longer has operate tier: revoked by ${ME}; they keep talk tier from auth.talk in config.yaml`,
      err: '',
    });
    await auth(['grant', 'lark:on_dan', 'operate']);
    for (const id of ['carol', 'owner']) {
      grantTier(db, { appId: 'cli_app', unionId: `on_${id}`, openId: `ou_${id}`, tier: 'talk', by: 'lark:on_dan', via: 'chat', chat: 'oc_team' }, () => ({ write: 'insert' as const }), 1);
    }
    expect((await auth(['revoke', 'lark:on_dan'])).out).toBe(`lark:on_dan no longer has operate tier: revoked by ${ME}; they made 2 talk grants still in force; mt auth list shows them`);
    expect(await json(['revoke', 'lark:on_carol'])).toEqual({ ok: true, outcome: 'revoked', tier: null, principal: 'lark:on_carol' });
    expect(await json(['revoke', 'lark:on_carol'])).toEqual({ ok: true, outcome: 'no_grant', tier: null, principal: 'lark:on_carol' });
    // The owner's grant from before: ended, both tiers kept.
    expect(await json(['revoke', 'lark:on_owner'])).toEqual({ ok: true, outcome: 'revoked', tier: 'operate', principal: 'lark:on_owner' });
  });

  it('refuses the owner and a tier the configuration gives, naming the list in effect', async () => {
    setup();
    expect(await json(['revoke', 'lark:on_owner'])).toEqual({ ok: false, code: 'is_owner', message: 'Alice (lark:on_owner) is the owner, from auth.owner in config.yaml, and cannot be revoked' });
    expect(await auth(['revoke', 'lark:on_tess'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: Tess (lark:on_tess) has talk tier from auth.talk in config.yaml, which mt auth cannot change: the operator edits it and restarts the gateway',
    });
    expect(await json(['revoke', 'lark:on_tess'], { MT_ALLOW_TALK: 'ou_tess' })).toMatchObject({ code: 'from_config', message: expect.stringContaining('has talk tier from MT_ALLOW_TALK, which') });
    expect(await json(['revoke', 'lark:on_bob'])).toMatchObject({ code: 'from_config', message: expect.stringContaining('has operate tier from auth.operate in config.yaml') });
  });
});

describe('mt auth list', () => {
  it('lists everyone with a tier, the owner first, with where each comes from, and gives --json', async () => {
    setup();
    await auth(['grant', 'lark:on_carol', 'talk']);
    grantTier(db, { appId: 'cli_app', unionId: 'on_dan', openId: 'ou_dan', tier: 'operate', by: 'lark:on_owner', via: 'chat', chat: 'oc_team' }, () => ({ write: 'insert' as const }), Date.UTC(2026, 10, 18, 2, 2));
    const carolAt = activeGrant(db, 'cli_app', 'on_carol')?.grantedAt ?? 0;
    const r = await auth(['list']);
    expect(r.code).toBe(0);
    expect(r.out.split('\n').map((l) => l.replace(/ +/g, ' '))).toEqual([
      'name person tier from',
      'Alice lark:on_owner operate owner; auth.talk; auth.operate',
      'Bob lark:on_bob operate auth.talk; auth.operate',
      '(no name) lark:on_dan operate operate grant by lark:on_owner in chat oc_team, 2026-11-18 10:02',
      `Carol Wu lark:on_carol talk talk grant by ${ME} at the terminal, ${formatWall(ZONE, carolAt)}`,
      'Tess lark:on_tess talk auth.talk',
      'Olga lark:on_olga none auth.operate',
    ]);
    const listed = (await json(['list'])) as { ok: boolean; people: unknown[] };
    expect(listed.ok).toBe(true);
    expect(listed.people).toContainEqual({
      principal: 'lark:on_dan',
      union_id: 'on_dan',
      open_id: 'ou_dan',
      name: null,
      tier: 'operate',
      owner: false,
      config: { talk: false, operate: false },
      grant: { tier: 'operate', by: 'lark:on_owner', via: 'chat', chat_id: 'oc_team', at: Date.UTC(2026, 10, 18, 2, 2) },
    });
    expect(listed.people).toContainEqual({
      principal: 'lark:on_bob',
      union_id: 'on_bob',
      open_id: 'ou_bob',
      name: 'Bob',
      tier: 'operate',
      owner: false,
      config: { talk: true, operate: true },
      grant: null,
    });
  });

  it('shows a configuration entry this bot has not seen by its open_id, and only the grants with no owner', async () => {
    setup(['lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', '  talk: [ou_ghost]']);
    expect((await auth(['list'])).out.split('\n').map((l) => l.replace(/ +/g, ' '))).toContain('(not seen) ou_ghost talk auth.talk');
    expect(await json(['list'])).toMatchObject({ people: expect.arrayContaining([{ principal: null, union_id: null, open_id: 'ou_ghost', name: null, tier: 'talk', owner: false, config: { talk: true, operate: false }, grant: null }]) });
    db.close();
    fx.cleanup();
    setup(['lark:', '  appId: cli_app']);
    grantTier(db, { appId: 'cli_app', unionId: 'on_carol', openId: 'ou_carol', tier: 'talk', by: ME, via: 'terminal', chat: null }, () => ({ write: 'insert' as const }), 1);
    const r = await auth(['list']);
    expect(r.err).toBe('mt: this shell finds no auth.owner or MT_OWNER_OPEN_ID, so only the grants are shown');
    expect(r.out.split('\n')).toHaveLength(2);
  });
});

describe("mt auth in an agent's shell", () => {
  it('is refused before its arguments are read, as JSON with --json', async () => {
    setup();
    expect(await auth(['grant', 'lark:on_carol', 'talk'], { MT_CRON_TOKEN: 't' })).toEqual({
      code: 1,
      out: '',
      err: "mt: mt auth grant is an operator's command, not an agent's; this shell has MT_CRON_TOKEN set. Run it from your own shell",
    });
    expect(await json(['bogus'], { MT_KANBAN_RUN: 'r_1' })).toEqual({
      ok: false,
      code: 'operator_command',
      message: "mt auth is an operator's command, not an agent's; this shell has MT_KANBAN_RUN set. Run it from your own shell",
    });
    expect(activeGrant(db, 'cli_app', 'on_carol')).toBeUndefined();
  });
});
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-auth.test.ts`. Expected: `Tests  8 failed | 1 passed (9)`; among the failures, `AssertionError: expected { code: 2, out: '', …(1) } to deeply equal { code: +0, …(2) }`, as `mt auth` is an unknown command. Run `npx vitest run --project e2e tests/auth-gateway.e2e.ts`. Expected: `Tests  1 failed (1)`.

- [ ] **Step 9.3: Implement.**

In `src/cli/mt.ts`, replace:

```ts
import { updateCommand, type UpdateDeps } from './update.js';
```

with:

```ts
import { updateCommand, type UpdateDeps } from './update.js';
import { AUTH_USAGE, authCommand } from './auth.js';
```

In `src/cli/mt.ts`, replace:

```ts
 * else. They refuse to run in an agent's shell.
```

with:

```ts
 * else. They refuse to run in an agent's shell.
 *
 * `mt auth` is the operator's too (tier grants spec §6.2): it writes the
 * gateway's grants through their own writer, which the gateway reads at its
 * next check, and refuses to run in an agent's shell before its arguments are
 * read.
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt update [--check | --yes]',
```

with:

```ts
  '  mt update [--check | --yes]',
  AUTH_USAGE,
```

In `src/cli/mt.ts`, replace:

```ts
/**
 * `io` for a command that loads the gateway's settings: its environment this
```

with:

```ts
/** `mt auth` in an agent's shell: refused, naming the variable that marks it, as JSON when `--json` is among its words. */
function refuseAuth(command: string | undefined, rest: readonly string[], io: MtIo): number {
  const named = command === 'grant' || command === 'revoke' || command === 'list';
  const message = runShellRefusal(named ? `mt auth ${command}` : 'mt auth', io.env);
  if (command === '--json' || rest.includes('--json')) io.out(jsonLine({ ok: false, code: 'operator_command', message }));
  else refuse(io, message);
  return 1;
}

/**
 * `io` for a command that loads the gateway's settings: its environment this
```

In `src/cli/mt.ts`, replace:

```ts
    if (group === 'service') {
```

with:

```ts
    if (group === 'auth') {
      // Refused in an agent's shell before its arguments are read, in JSON when asked (tier grants spec §6.3).
      if (inAgentRun(io.env)) return refuseAuth(command, rest, io);
      return authCommand(argv.slice(1), withGatewayFile(io));
    }
    if (group === 'service') {
```

Create `src/cli/auth.ts`:

```ts
import { existsSync } from 'node:fs';
import { loadTeamSettings, type ListSources, type TeamSettings } from '../config.js';
import { processZone, formatWall } from '../cron/schedule.js';
import { readGatewayZone } from '../cron/zone-file.js';
import { activeGrants, grantTier, revokeGrant, talkGrantsMadeBy, type GrantRow } from '../db/grants.js';
import { openDb, type Db } from '../db/open.js';
import { peopleOf, personOf, type PersonRow } from '../db/people.js';
import { NO_MENTIONS } from '../kanban/task-checks.js';
import { sourcesOf, tiersFrom } from '../policy/auth.js';
import { decideGrant, decideRevoke, grantReply, revokeReply, tierEntries, type Held, type Target, type TierEntry, type Words } from '../policy/grants.js';
import { addSecrets, redactKnownSecrets } from '../secrets.js';
import type { Tier } from '../types.js';
import { parse, table, UsageError } from './args.js';
import { operatorName } from './gate.js';
import type { MtIo } from './mt.js';
import { jsonLine } from './operator.js';
import { line } from './plain.js';

/**
 * `mt auth grant|revoke|list` (the tier grants spec §6.2, §8.2): the
 * terminal's grants, as the owner's, recorded `operator:<login>` with no chat,
 * through the same writer and the same decisions as chat's `/auth`, in the
 * same words. The person is `lark:<union_id>`, one this bot has seen: a
 * union_id typed or pasted from elsewhere is the failure grants exist to end.
 *
 * The terminal judges by its own read of the configuration, the file and the
 * environment as this shell sees them, which may differ from the running
 * gateway's until it restarts. A grant made here is seen by the gateway at its
 * next check, with no nudge, and announced nowhere.
 *
 * Exit codes: 0 done, a no-op included; 1 refused; 2 the command line was
 * wrong. `--json` on all three, as on the other operator commands.
 */

export const AUTH_USAGE = [
  '  mt auth grant lark:<union_id> talk|operate [--json]',
  '  mt auth revoke lark:<union_id> [--json]',
  '  mt auth list [--json]',
].join('\n');

/** What a command did, or why not. */
type Outcome = { ok: true; lines: string[]; json: Record<string, unknown> } | { ok: false; code: string; message: string };

/** The database and what this shell's settings give, opened for one command. */
interface Opened {
  db: Db;
  appId: string;
  settings: TeamSettings;
  from: ListSources;
  zone: string;
}

const NO_OWNER = 'this shell finds no auth.owner or MT_OWNER_OPEN_ID, so it cannot tell what the configuration gives';

/** The person a command names, checked: a principal this bot has seen. */
function personNamed(text: string, db: Db, appId: string): PersonRow | Outcome {
  const shown = line(text, 80);
  if (text.startsWith('ou_')) {
    return { ok: false, code: 'open_id', message: `${shown} is an open_id, which is per app: a person is lark:<union_id>, which mt auth list and mt kanban people give` };
  }
  if (text.startsWith('@')) return { ok: false, code: 'invalid', message: NO_MENTIONS };
  const unionId = text.startsWith('lark:') ? text.slice('lark:'.length) : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(unionId)) {
    return { ok: false, code: 'invalid', message: `${shown} is not a person: a person is lark:<union_id>, which mt auth list and mt kanban people give` };
  }
  const person = personOf(db, appId, unionId);
  if (person === undefined) {
    return {
      ok: false,
      code: 'unknown_person',
      message: `${shown} is not someone this bot has seen: mt kanban people lists those it has, or grant them in chat with /auth grant @Name talk, which needs no id`,
    };
  }
  return person;
}

/** This shell's settings and the database they name, migrated to grants; or why not. */
function open(io: MtIo): Opened | Outcome {
  const settings = loadTeamSettings(io.env);
  const secret = io.env['LARK_APP_SECRET'];
  if (secret !== undefined && secret !== '') addSecrets([secret]);
  const appId = settings.appId;
  if (appId === undefined) return { ok: false, code: 'no_bot', message: 'there is no bot to grant for: this shell finds no lark.appId or LARK_APP_ID' };
  if (!existsSync(settings.dbPath)) {
    return { ok: false, code: 'not_migrated', message: `there is no database at ${settings.dbPath}: the gateway creates it when it first starts` };
  }
  const db = openDb(settings.dbPath);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tier_grants'").get() === undefined) {
    db.close();
    return { ok: false, code: 'not_migrated', message: `the database at ${settings.dbPath} has no tier grants yet: start the gateway once, so it is migrated` };
  }
  const configured = settings.cron?.tz;
  const zone = configured ?? readGatewayZone(settings.home) ?? processZone();
  const from = settings.from ?? { owner: 'auth.owner', talk: 'auth.talk', operate: 'auth.operate' };
  return { db, appId, settings, from, zone };
}

function held(g: GrantRow | undefined): Held | undefined {
  return g === undefined ? undefined : { tier: g.tier, by: g.grantedBy, at: g.grantedAt };
}

/** A person, as the terminal names them: their name and principal, or the principal alone. */
function whoOf(p: PersonRow): string {
  return p.name === null ? `lark:${line(p.unionId, 80)}` : `${line(p.name, 80)} (lark:${line(p.unionId, 80)})`;
}

/** The words a decision is said in at the terminal. */
function words(o: Opened, p: PersonRow, io: MtIo): Words {
  const nameOf = (principal: string): string => {
    const named = principal.startsWith('lark:') ? personOf(o.db, o.appId, principal.slice('lark:'.length))?.name : undefined;
    return line(named ?? principal, 80);
  };
  return {
    via: 'terminal',
    who: whoOf(p),
    principal: `lark:${p.unionId}`,
    by: operatorName(io),
    from: o.from,
    held: (g) => `${nameOf(g.by)} on ${formatWall(o.zone, g.at).slice(0, 10)}`,
  };
}

function targetOf(o: Opened, p: PersonRow, grant: GrantRow | undefined): Target {
  const s = o.settings;
  return { sources: sourcesOf({ ownerOpenId: s.owner ?? '', allowTalk: s.talk ?? [], allowOperate: s.operate ?? [] }, p.openId), grant: held(grant) };
}

/** The tier a person has with this target's sources and grant: what `--json` gives as `tier`. */
function tierNow(t: Target, grant: Tier | undefined): Tier | null {
  const now = tiersFrom(t.sources, grant);
  return now.operate ? 'operate' : now.talk ? 'talk' : null;
}

function grant(o: Opened, person: string, tier: Tier, io: MtIo): Outcome {
  if (o.settings.owner === undefined) return { ok: false, code: 'no_owner', message: NO_OWNER };
  const p = personNamed(person, o.db, o.appId);
  if (!('unionId' in p)) return p;
  let target = targetOf(o, p, undefined);
  const r = grantTier(
    o.db,
    { appId: o.appId, unionId: p.unionId, openId: p.openId, tier, by: operatorName(io), via: 'terminal', chat: null },
    (g) => {
      target = targetOf(o, p, g);
      return decideGrant('terminal', target, tier);
    },
    Date.now(),
  );
  const d = r.decision;
  const message = grantReply(d, target, words(o, p, io));
  if (d.outcome === 'refused') return { ok: false, code: d.code, message };
  return {
    ok: true,
    lines: [message],
    // The tier the person has afterwards: a talk grant to a person in auth.operate makes an operator.
    json: { outcome: d.outcome, tier: d.outcome === 'already' ? d.tier : tierNow(target, d.tier), principal: `lark:${p.unionId}` },
  };
}

function revoke(o: Opened, person: string, io: MtIo): Outcome {
  if (o.settings.owner === undefined) return { ok: false, code: 'no_owner', message: NO_OWNER };
  const p = personNamed(person, o.db, o.appId);
  if (!('unionId' in p)) return p;
  let target = targetOf(o, p, undefined);
  const r = revokeGrant(
    o.db,
    { appId: o.appId, unionId: p.unionId, by: operatorName(io), via: 'terminal', chat: null },
    (g) => {
      target = targetOf(o, p, g);
      return decideRevoke('terminal', target);
    },
    Date.now(),
  );
  const d = r.decision;
  const principal = `lark:${p.unionId}`;
  const made = d.outcome === 'revoked' && d.grant === 'operate' ? talkGrantsMadeBy(o.db, o.appId, principal) : 0;
  const message = revokeReply(d, target, words(o, p, io), made);
  if (d.outcome === 'refused') return { ok: false, code: d.code, message };
  const tier = d.outcome === 'revoked' ? d.left : tierNow(target, target.grant?.tier);
  return { ok: true, lines: [message], json: { outcome: d.outcome, tier, principal } };
}

/** Where a person's tier comes from, as `mt auth list` says it. */
function sourcesText(e: TierEntry, o: Opened): string {
  const out: string[] = [];
  if (e.sources.owner) out.push('owner');
  if (e.sources.talk) out.push(o.from.talk);
  if (e.sources.operate) out.push(o.from.operate);
  const g = e.grant;
  if (g !== undefined) {
    const where = g.grantedVia === 'chat' ? `in chat ${line(g.grantedChat ?? '', 80)}` : 'at the terminal';
    out.push(`${g.tier} grant by ${line(g.grantedBy, 80)} ${where}, ${formatWall(o.zone, g.grantedAt)}`);
  }
  return out.join('; ');
}

function list(o: Opened, io: MtIo, json: boolean): Outcome {
  const s = o.settings;
  if (s.owner === undefined && !json) io.err('mt: this shell finds no auth.owner or MT_OWNER_OPEN_ID, so only the grants are shown');
  const entries = tierEntries({ owner: s.owner ?? '', talk: s.owner === undefined ? [] : (s.talk ?? []), operate: s.owner === undefined ? [] : (s.operate ?? []) }, activeGrants(o.db, o.appId), peopleOf(o.db, o.appId)).filter(
    (e) => e.unionId !== null || e.openId !== '',
  );
  const rows = entries.map((e) => [
    e.name === null ? (e.unionId === null ? '(not seen)' : '(no name)') : line(e.name, 80),
    e.unionId === null ? line(e.openId ?? '', 80) : `lark:${line(e.unionId, 80)}`,
    e.tier ?? 'none',
    sourcesText(e, o),
  ]);
  return {
    ok: true,
    lines: rows.length === 0 ? ['nobody has a tier'] : table([['name', 'person', 'tier', 'from'], ...rows]),
    json: {
      people: entries.map((e) => ({
        principal: e.unionId === null ? null : `lark:${e.unionId}`,
        union_id: e.unionId,
        open_id: e.openId,
        name: e.name,
        tier: e.tier,
        owner: e.sources.owner,
        config: { talk: e.sources.talk, operate: e.sources.operate },
        grant:
          e.grant === undefined
            ? null
            : { tier: e.grant.tier, by: e.grant.grantedBy, via: e.grant.grantedVia, chat_id: e.grant.grantedChat, at: e.grant.grantedAt },
      })),
    },
  };
}

/** `mt auth <sub> …`, in an operator's shell, with the gateway's .env read. */
export function authCommand(argv: readonly string[], io: MtIo): number {
  const [sub, ...rest] = argv;
  const { values, positionals } = parse(rest, { json: { type: 'boolean' } });
  const json = values.json === true;
  let run: (o: Opened) => Outcome;
  if (sub === 'grant') {
    const [person, tier, extra] = positionals;
    const t = tier?.toLowerCase();
    if (person === undefined || (t !== 'talk' && t !== 'operate') || extra !== undefined) {
      throw new UsageError('auth grant takes a person, lark:<union_id>, and a tier, talk or operate');
    }
    run = (o) => grant(o, person, t, io);
  } else if (sub === 'revoke') {
    const [person, extra] = positionals;
    if (person === undefined || extra !== undefined) throw new UsageError('auth revoke takes a person, lark:<union_id>');
    run = (o) => revoke(o, person, io);
  } else if (sub === 'list') {
    if (positionals.length > 0) throw new UsageError('auth list takes no arguments');
    run = (o) => list(o, io, json);
  } else {
    throw new UsageError('auth takes grant, revoke or list');
  }
  const opened = open(io);
  let outcome: Outcome;
  if ('db' in opened) {
    try {
      outcome = run(opened);
    } catch (err) {
      outcome = { ok: false, code: 'failed', message: `the database failed: ${redactKnownSecrets(err instanceof Error ? err.message : String(err))}` };
    } finally {
      opened.db.close();
    }
  } else {
    outcome = opened;
  }
  if (!outcome.ok) {
    if (json) io.out(jsonLine({ ok: false, code: outcome.code, message: outcome.message }));
    else io.err(`mt: ${redactKnownSecrets(outcome.message)}`);
    return 1;
  }
  if (json) io.out(jsonLine({ ok: true, ...outcome.json }));
  else for (const l of outcome.lines) io.out(redactKnownSecrets(l));
  return 0;
}
```

- [ ] **Step 9.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2623 passed (2623)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.5: Commit.**

```bash
git add src/cli/auth.ts src/cli/mt.ts tests/auth-gateway.e2e.ts tests/mt-auth.test.ts
git commit -m "Add mt auth grant, revoke and list at the terminal, as the owner, for a person this bot has seen, through the same writer and decisions as chat, with --json on each, refused in an agent's shell; the running gateway sees a terminal's grant at its next check"
```

---

### Task 10: The session marker, `MT_AGENT_SESSION`

**Files:**

- Create: `tests/session-marker.test.ts`
- Modify: `src/kanban/gates.ts`, `src/cli/gate.ts`, `src/cli/mt.ts`, `src/cli/update.ts`, `src/index.ts`, `tests/fakes/cli-agent.mjs`, `tests/auth-gateway.e2e.ts`, `tests/cron-gateway.e2e.ts`, `tests/mt-service.test.ts`, `tests/mt-update-apply.test.ts`

§6.3. The registry's `envFor` gives every agent session `MT_AGENT_SESSION=<session id>`, beside what the dispatcher, the scheduler or the cron tokens give, or alone (Decision 14). `mt auth` refuses a shell with it, naming it when it is the only one set; every other command is as it was, as it is not one of `AGENT_VARIABLES`. `gateEnv`, and so a cron script, and `mt update`'s children drop it. The fake CLI agent records the marker it was given, so a chat session's, cron off and on, and a fire's are checked through `createGateway`.

- [ ] **Step 10.1: Write the tests.**

In `tests/auth-gateway.e2e.ts`, replace:

```ts
import { loadConfig, type GatewayConfig } from '../src/config.js';
```

with:

```ts
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { resolveBinding } from '../src/db/bindings.js';
```

In `tests/auth-gateway.e2e.ts`, replace:

```ts
 * person's next message runs a turn; an operator's grant of operate is
 * refused; and `mt auth revoke`, run as another process while the gateway
 * runs, refuses the person's next message, with no restart.
```

with:

```ts
 * person's next message runs a turn, whose agent has the session marker in
 * its environment; an operator's grant of operate is refused; and `mt auth
 * revoke`, run as another process while the gateway runs, refuses the
 * person's next message, with no restart.
```

In `tests/auth-gateway.e2e.ts`, replace:

```ts
/** The prompts the fake agent was given, in order. */
function prompts(): string[] {
```

with:

```ts
/** The turns the fake agent was given, in order: each prompt, and the session marker in its environment. */
function turns(): Array<{ prompt: string; marker: string | null }> {
```

In `tests/auth-gateway.e2e.ts`, replace:

```ts
      .map((l) => (JSON.parse(l) as { prompt: string }).prompt);
```

with:

```ts
      .map((l) => JSON.parse(l) as { prompt: string; marker: string | null });
```

In `tests/auth-gateway.e2e.ts`, replace:

```ts
const replies = (): string[] => lark.texts.map((m) => m.text);
```

with:

```ts
const prompts = (): string[] => turns().map((t) => t.prompt);

const replies = (): string[] => lark.texts.map((m) => m.text);
```

In `tests/auth-gateway.e2e.ts`, replace:

```ts
    await until('the turn to run', () => prompts().some((p) => p.includes('hello after the grant')));
```

with:

```ts
    await until('the turn to run', () => prompts().some((p) => p.includes('hello after the grant')));
    // A chat session's agent, with cron off, is marked as an agent's shell all the same (tier grants spec §6.3).
    const session = resolveBinding(gateway.db, { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' })?.sessionId;
    expect(session).toMatch(/^s_/);
    expect(turns().find((t) => t.prompt.includes('hello after the grant'))?.marker).toBe(session);
```

In `tests/cron-gateway.e2e.ts`, replace:

```ts
import { cronUuid } from '../src/core/ids.js';
```

with:

```ts
import { cronUuid } from '../src/core/ids.js';
import { resolveBinding } from '../src/db/bindings.js';
```

In `tests/cron-gateway.e2e.ts`, replace:

```ts
function turnsSeen(): Array<{ fire: string | null; path: string | null }> {
```

with:

```ts
function turnsSeen(): Array<{ fire: string | null; path: string | null; marker: string | null }> {
```

In `tests/cron-gateway.e2e.ts`, replace:

```ts
      .map((l) => JSON.parse(l) as { fire: string | null; path: string | null });
```

with:

```ts
      .map((l) => JSON.parse(l) as { fire: string | null; path: string | null; marker: string | null });
```

In `tests/cron-gateway.e2e.ts`, replace:

```ts
    // The chat turn's agent: the shim's directory, then the role's own PATH, not the gateway's.
    expect(turnsSeen()).toEqual([{ fire: null, path: shimFirst }]);
```

with:

```ts
    // The chat turn's agent: the shim's directory, then the role's own PATH, not the gateway's; and its session's marker.
    const chat = resolveBinding(db, { channel: 'lark', appId: 'cli_app', conversationId: 'oc_owner_dm', threadId: '' })?.sessionId;
    expect(turnsSeen()).toEqual([{ fire: null, path: shimFirst, marker: chat }]);
```

In `tests/cron-gateway.e2e.ts`, replace:

```ts
      { fire: null, path: shimFirst },
      { fire: String(fire?.fireId), path: shimFirst },
    ]);
```

with:

```ts
      { fire: null, path: shimFirst, marker: chat },
      { fire: String(fire?.fireId), path: shimFirst, marker: fire?.sessionId ?? 'none' },
    ]);
    expect(fire?.sessionId).toMatch(/^s_/);
```

In `tests/fakes/cli-agent.mjs`, replace:

```js
 *               turn's PATH, and its MT_CRON_FIRE if a fire's, is appended to
 *               `cron-env.log` beside the log
```

with:

```js
 *               turn's PATH, its MT_CRON_FIRE if a fire's, and its
 *               MT_AGENT_SESSION, is appended to `cron-env.log` beside the log
```

In `tests/fakes/cli-agent.mjs`, replace:

```js
 * as `apm` (null when unset), and a board run's id, `MT_KANBAN_RUN`, as `run`.
```

with:

```js
 * as `apm` (null when unset), a board run's id, `MT_KANBAN_RUN`, as `run`, and
 * the session marker every agent session is given, `MT_AGENT_SESSION`, as
 * `marker`.
```

In `tests/fakes/cli-agent.mjs`, replace:

```js
  appendFileSync(LOG, `${JSON.stringify({ argv, prompt, apm, run, session: asked ?? null })}\n`);
```

with:

```js
  const marker = process.env['MT_AGENT_SESSION'] ?? null;
  appendFileSync(LOG, `${JSON.stringify({ argv, prompt, apm, run, session: asked ?? null, marker })}\n`);
```

In `tests/fakes/cli-agent.mjs`, replace:

```js
      appendFileSync(join(dirname(LOG), 'cron-env.log'), `${JSON.stringify({ fire: process.env['MT_CRON_FIRE'] ?? null, path: process.env['PATH'] ?? null })}\n`);
```

with:

```js
      appendFileSync(
        join(dirname(LOG), 'cron-env.log'),
        `${JSON.stringify({ fire: process.env['MT_CRON_FIRE'] ?? null, path: process.env['PATH'] ?? null, marker: process.env['MT_AGENT_SESSION'] ?? null })}\n`,
      );
```

In `tests/mt-service.test.ts`, replace:

```ts
  it('says what the database lock names, with cron.enabled', async () => {
```

with:

```ts
  it('runs in a shell with only the session marker set, which guards mt auth alone', async () => {
    fx = fixture();
    notLoaded(fx);
    const r = await fx.run(['service', 'status'], { env: { MT_AGENT_SESSION: 's_1' } });
    expect(r.out).toMatch(/^installed: no/m);
    expect(r.err).not.toContain("operator's command");
  });

  it('says what the database lock names, with cron.enabled', async () => {
```

In `tests/mt-update-apply.test.ts`, replace:

```ts
  it("gives git, npm and the check none of an agent's variables, MT_CRON_* as MT_KANBAN_*", async () => {
    fx = await updateFake();
    await fx.update(['--yes'], { env: { MT_KANBAN_SOCKET: '/nowhere.sock', MT_CRON_STRAY: 'x' } });
    expect(fx.runs.length).toBeGreaterThan(0);
    for (const run of fx.runs) {
      expect(Object.keys(run.opts.env).filter((k) => k.startsWith('MT_KANBAN_') || k.startsWith('MT_CRON_'))).toEqual([]);
```

with:

```ts
  it("gives git, npm and the check none of an agent's variables, MT_CRON_* and the session marker as MT_KANBAN_*", async () => {
    fx = await updateFake();
    await fx.update(['--yes'], { env: { MT_KANBAN_SOCKET: '/nowhere.sock', MT_CRON_STRAY: 'x', MT_AGENT_SESSION: 's_1' } });
    expect(fx.runs.length).toBeGreaterThan(0);
    for (const run of fx.runs) {
      expect(Object.keys(run.opts.env).filter((k) => k.startsWith('MT_KANBAN_') || k.startsWith('MT_CRON_') || k === 'MT_AGENT_SESSION')).toEqual([]);
```

Create `tests/session-marker.test.ts`:

```ts
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptEnv } from '../src/cron/scheduler.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { SESSION_MARKER, gateEnv } from '../src/kanban/gates.js';
import { sessionEnv } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The session marker (the tier grants spec §6.3): `MT_AGENT_SESSION=<session
 * id>` in every agent session's environment, beside what a run, a fire or a
 * chat session's cron token gives, or alone; dropped from a gate's, a cron
 * script's and `mt update`'s children's; and refusing `mt auth` alone of the
 * operator's commands.
 */

describe('sessionEnv', () => {
  it("adds the marker to a run's, a fire's and a chat session's environment, and gives it alone with none", () => {
    expect(SESSION_MARKER).toBe('MT_AGENT_SESSION');
    expect(sessionEnv('s_chat', undefined)).toEqual({ MT_AGENT_SESSION: 's_chat' });
    expect(sessionEnv('s_chat', { MT_CRON_TOKEN: 't', PATH: '/srv/mt/bin:/usr/bin' })).toEqual({ MT_CRON_TOKEN: 't', PATH: '/srv/mt/bin:/usr/bin', MT_AGENT_SESSION: 's_chat' });
    expect(sessionEnv('s_run', { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 'k' })).toMatchObject({ MT_KANBAN_RUN: 'r_1', MT_AGENT_SESSION: 's_run' });
    expect(sessionEnv('s_fire', { MT_CRON_FIRE: '7' })).toMatchObject({ MT_CRON_FIRE: '7', MT_AGENT_SESSION: 's_fire' });
    // The session's own id, whatever was given.
    expect(sessionEnv('s_real', { MT_AGENT_SESSION: 's_other' })).toEqual({ MT_AGENT_SESSION: 's_real' });
  });

  it("is dropped from a gate's environment and a cron script's, the operator's shells", () => {
    const worker = role('worker', { agent: { ...role('worker').agent, env: { MT_AGENT_SESSION: 's_role', API_KEY: 'k' } } });
    const parent = { PATH: '/usr/bin', HOME: '/home/mt', MT_AGENT_SESSION: 's_parent' };
    expect(gateEnv(worker, parent)).toEqual({ PATH: '/usr/bin', HOME: '/home/mt', API_KEY: 'k' });
    expect(scriptEnv(worker, parent, undefined, undefined)).not.toHaveProperty('MT_AGENT_SESSION');
  });
});

describe('mt in a shell with the marker alone', () => {
  let fx: MtFixture;
  let db: Db;

  afterEach(() => {
    clearSecrets();
    db?.close();
    fx?.cleanup();
  });

  function setup(): void {
    clearSecrets();
    fx = mtFixture((ws) =>
      [`workspace: ${ws}`, 'lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
    );
    db = openDb(join(fx.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
  }

  it('refuses mt auth, naming the marker, as JSON with --json, and the first agent variable when there is one', async () => {
    setup();
    const refusal = "mt auth list is an operator's command, not an agent's; this shell has MT_AGENT_SESSION set. Run it from your own shell";
    expect(await fx.run(['auth', 'list'], { env: { MT_AGENT_SESSION: 's_1' } })).toEqual({ code: 1, out: '', err: `mt: ${refusal}` });
    expect(JSON.parse((await fx.run(['auth', 'list', '--json'], { env: { MT_AGENT_SESSION: 's_1' } })).out)).toEqual({ ok: false, code: 'operator_command', message: refusal });
    expect((await fx.run(['auth', 'grant', 'lark:on_x', 'talk'], { env: { MT_AGENT_SESSION: 's_1', MT_CRON_TOKEN: 't' } })).err).toContain('this shell has MT_CRON_TOKEN set');
    expect((await fx.run(['auth', 'list'])).code).toBe(0);
  });

  it("does not refuse the board's or the cron operator's commands, which only the agent variables refuse", async () => {
    setup();
    const board = await fx.run(['kanban', 'task', 'list', '--json'], { env: { MT_AGENT_SESSION: 's_1' } });
    expect(board.code, board.err).toBe(0);
    expect(JSON.parse(board.out)).toMatchObject({ ok: true });
    const cron = await fx.run(['cron', 'list'], { env: { MT_AGENT_SESSION: 's_1' } });
    expect(cron.err).not.toContain("operator's command");
  });
});
```

- [ ] **Step 10.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-service.test.ts tests/mt-update-apply.test.ts tests/session-marker.test.ts`. Expected: `Tests  4 failed | 75 passed (79)`; among the failures, `AssertionError: expected [ 'MT_AGENT_SESSION' ] to deeply equal []`. Run `npx vitest run --project e2e tests/auth-gateway.e2e.ts tests/cron-gateway.e2e.ts`. Expected: `Tests  2 failed (2)`: no turn's marker is set yet.

- [ ] **Step 10.3: Implement.**

In `src/cli/gate.ts`, replace:

```ts
import { PeopleDirectory } from '../kanban/people.js';
```

with:

```ts
import { PeopleDirectory } from '../kanban/people.js';
import { SESSION_MARKER } from '../kanban/gates.js';
```

In `src/cli/gate.ts`, replace:

```ts
/** What an operator's command, `what`, says in an agent's shell, naming the first of its variables `env` has set. */
export function runShellRefusal(what: string, env: Env): string {
  const found = AGENT_VARIABLES.find((name) => env[name] !== undefined) ?? AGENT_VARIABLES[0];
```

with:

```ts
/** Any agent's shell, a chat session's with cron off included: the agent variables, or the session marker. */
export function inAgentSession(env: Env): boolean {
  return inAgentRun(env) || env[SESSION_MARKER] !== undefined;
}

/**
 * What an operator's command, `what`, says in an agent's shell, naming the
 * first of its variables `env` has set, and the session marker when it is the
 * only one.
 */
export function runShellRefusal(what: string, env: Env): string {
  const found =
    AGENT_VARIABLES.find((name) => env[name] !== undefined) ?? (env[SESSION_MARKER] !== undefined ? SESSION_MARKER : AGENT_VARIABLES[0]);
```

In `src/cli/mt.ts`, replace:

```ts
import { gateAdd, gateList, gateRemove, hasBoardRun, inAgentRun, runShellRefusal } from './gate.js';
```

with:

```ts
import { gateAdd, gateList, gateRemove, hasBoardRun, inAgentRun, inAgentSession, runShellRefusal } from './gate.js';
```

In `src/cli/mt.ts`, replace:

```ts
 * next check, and refuses to run in an agent's shell before its arguments are
 * read.
```

with:

```ts
 * next check, and refuses to run in any agent's shell before its arguments are
 * read: by the agent variables, or by `MT_AGENT_SESSION`, which the gateway
 * sets in every agent session, cron on or off.
```

In `src/cli/mt.ts`, replace:

```ts
      // Refused in an agent's shell before its arguments are read, in JSON when asked (tier grants spec §6.3).
      if (inAgentRun(io.env)) return refuseAuth(command, rest, io);
```

with:

```ts
      // Refused in every agent's shell, a chat session's with cron off included, before its arguments are
      // read, in JSON when asked (tier grants spec §6.3).
      if (inAgentSession(io.env)) return refuseAuth(command, rest, io);
```

In `src/cli/update.ts`, replace:

```ts
import { isSecretName, loadGatewayEnv } from '../gateway-env.js';
```

with:

```ts
import { isSecretName, loadGatewayEnv } from '../gateway-env.js';
import { SESSION_MARKER } from '../kanban/gates.js';
```

In `src/cli/update.ts`, replace:

```ts
    // This shell's, never an agent's (no MT_KANBAN_* and no MT_CRON_*), and nothing git or npm starts may prompt.
    const env: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(io.env)) {
      if (!name.startsWith('MT_KANBAN_') && !name.startsWith('MT_CRON_')) env[name] = value;
```

with:

```ts
    // This shell's, never an agent's (no MT_KANBAN_*, no MT_CRON_* and no MT_AGENT_SESSION), and nothing git or npm starts may prompt.
    const env: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(io.env)) {
      if (!name.startsWith('MT_KANBAN_') && !name.startsWith('MT_CRON_') && name !== SESSION_MARKER) env[name] = value;
```

In `src/index.ts`, replace:

```ts
import { KanbanService } from './kanban/service.js';
```

with:

```ts
import { KanbanService } from './kanban/service.js';
import { SESSION_MARKER } from './kanban/gates.js';
```

In `src/index.ts`, replace:

```ts
/**
 * The boot findings to post on one channel, each with only its bindings there
```

with:

```ts
/**
 * An agent session's environment as the registry is given it (tier grants spec
 * §6.3): what the dispatcher, the scheduler or the cron tokens give, with the
 * session marker, `MT_AGENT_SESSION=<session id>`, beside it, or alone when
 * none gives anything. So every agent's shell, a chat session's with cron off
 * included, is one `mt auth` refuses.
 */
export function sessionEnv(sessionId: string, env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return { ...env, [SESSION_MARKER]: sessionId };
}

/**
 * The boot findings to post on one channel, each with only its bindings there
```

In `src/index.ts`, replace:

```ts
    // A run's, else a fire's, else a chat session's cron token (the cron spec, §7).
    envFor: (sessionId, key) => dispatcher?.envFor(sessionId) ?? scheduler?.envFor(sessionId) ?? tokens?.envFor(sessionId, key),
```

with:

```ts
    // A run's, else a fire's, else a chat session's cron token (the cron spec, §7); and the session marker, always (tier grants spec §6.3).
    envFor: (sessionId, key) => sessionEnv(sessionId, dispatcher?.envFor(sessionId) ?? scheduler?.envFor(sessionId) ?? tokens?.envFor(sessionId, key)),
```

In `src/kanban/gates.ts`, replace:

```ts
 * `MT_CRON_*`, whatever put it there.
 */
export function gateEnv(role: Role, parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env = buildEnv(parent, role.agent.env);
  for (const key of Object.keys(env)) if (key.startsWith('MT_KANBAN_') || key.startsWith('MT_CRON_')) delete env[key];
  return env;
}

```

with:

```ts
 * `MT_CRON_*`, nor the session marker `MT_AGENT_SESSION` (tier grants spec
 * §6.3), whatever put it there: a gate and a cron script are the operator's.
 */
export function gateEnv(role: Role, parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env = buildEnv(parent, role.agent.env);
  for (const key of Object.keys(env)) if (key.startsWith('MT_KANBAN_') || key.startsWith('MT_CRON_') || key === SESSION_MARKER) delete env[key];
  return env;
}

/**
 * What the gateway puts in every agent session's environment, a chat
 * session's, a board run's and a fire's, cron on or off (tier grants spec
 * §6.3): the session's id. Not one of the agent variables `mt` refuses its
 * operator's commands by, so it changes no command but `mt auth`.
 */
export const SESSION_MARKER = 'MT_AGENT_SESSION';

```

- [ ] **Step 10.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2628 passed (2628)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.5: Commit.**

```bash
git add src/cli/gate.ts src/cli/mt.ts src/cli/update.ts src/index.ts src/kanban/gates.ts tests/auth-gateway.e2e.ts tests/cron-gateway.e2e.ts tests/fakes/cli-agent.mjs tests/mt-service.test.ts tests/mt-update-apply.test.ts tests/session-marker.test.ts
git commit -m "Put MT_AGENT_SESSION, the session's id, in every agent session's environment, cron on or off, and refuse mt auth in a shell that has it, leaving every other command as it was; drop it from a gate's, a cron script's and mt update's children's environments"
```

---

### Task 11: The startup line, and `mt kanban people`'s talk column

**Files:**

- Modify: `src/index.ts`, `src/cli/gate.ts`, `src/cli/operator.ts`, `tests/gateway-startup.test.ts`, `tests/mt-kanban-people.test.ts`

§8.3, §8.4. After the schema line, how many people this bot's grants let in, by tier, and how many active grants are another app id's; nothing with none (Decision 15). `mt kanban people` counts a grant in its talk column, and `--json` gains `talk_from`.

- [ ] **Step 11.1: Write the tests.**

In `tests/gateway-startup.test.ts`, replace:

```ts
import { createGateway, findingUuid, findingsOn, registerConfiguredSecrets } from '../src/index.js';
```

with:

```ts
import { createGateway, findingUuid, findingsOn, grantLines, registerConfiguredSecrets } from '../src/index.js';
import { grantTier } from '../src/db/grants.js';
```

In `tests/gateway-startup.test.ts`, replace:

```ts
  it('says, with the board on, which workspaces give each task a directory of its own', async () => {
```

with:

```ts
  it("says how many people this bot's grants let in, and how many grants are another app id's, after the schema line", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const quiet = await createGateway(config, team);
    await quiet.stop();
    expect(lines.filter((l) => l.includes(' auth: '))).toEqual([]);
    const db = openDb(config.dbPath);
    try {
      const actor = { by: 'operator:alice', via: 'terminal' as const, chat: null };
      const grant = (appId: string, unionId: string, tier: 'talk' | 'operate'): void =>
        void grantTier(db, { appId, unionId, openId: `ou_${unionId}`, tier, ...actor }, () => ({ write: 'insert' as const }), 1);
      grant(config.lark.appId, 'on_a', 'talk');
      grant(config.lark.appId, 'on_b', 'talk');
      grant(config.lark.appId, 'on_c', 'operate');
      grant('cli_old', 'on_a', 'talk');
    } finally {
      db.close();
    }
    lines.length = 0;
    const gateway = await createGateway(config, team);
    try {
      const at = lines.findIndex((l) => l.includes(' schema at version '));
      expect(lines.slice(at + 1, at + 3).map((l) => l.replace(/^\S+ /, ''))).toEqual([
        "auth: 2 person(s) granted talk and 1 operate, beside the configuration's; mt auth list shows who\n",
        'auth: 1 grant(s) are for another app id than lark.appId, and count for nothing here\n',
      ]);
    } finally {
      await gateway.stop();
    }
    expect(grantLines({ talk: 0, operate: 0, otherApps: 3 })).toEqual(['auth: 3 grant(s) are for another app id than lark.appId, and count for nothing here']);
    expect(grantLines({ talk: 0, operate: 2, otherApps: 0 })).toEqual(["auth: 0 person(s) granted talk and 2 operate, beside the configuration's; mt auth list shows who"]);
  });

  it('says, with the board on, which workspaces give each task a directory of its own', async () => {
```

In `tests/mt-kanban-people.test.ts`, replace:

```ts
import { migrate, openDb, type Db } from '../src/db/open.js';
```

with:

```ts
import { migrate, openDb, type Db } from '../src/db/open.js';
import { grantTier } from '../src/db/grants.js';
```

In `tests/mt-kanban-people.test.ts`, replace:

```ts
        { principal: 'lark:on_ann', union_id: 'on_ann', name: 'Ann\u202E Wu', talk: false },
        { principal: 'lark:on_bob', union_id: 'on_bob', name: 'Bob Li', talk: true },
        { principal: 'lark:on_zed', union_id: 'on_zed', name: 'Bob Li', talk: false },
        { principal: 'lark:on_owner', union_id: 'on_owner', name: 'Owner sk-live-1234567890', talk: true },
        { principal: 'lark:on_quiet', union_id: 'on_quiet', name: null, talk: false },
```

with:

```ts
        { principal: 'lark:on_ann', union_id: 'on_ann', name: 'Ann\u202E Wu', talk: false, talk_from: null },
        { principal: 'lark:on_bob', union_id: 'on_bob', name: 'Bob Li', talk: true, talk_from: 'config' },
        { principal: 'lark:on_zed', union_id: 'on_zed', name: 'Bob Li', talk: false, talk_from: null },
        { principal: 'lark:on_owner', union_id: 'on_owner', name: 'Owner sk-live-1234567890', talk: true, talk_from: 'config' },
        { principal: 'lark:on_quiet', union_id: 'on_quiet', name: null, talk: false, talk_from: null },
```

In `tests/mt-kanban-people.test.ts`, replace:

```ts
  it('says there is no bot to list for without an app id, and nobody has talk tier without an owner', async () => {
```

with:

```ts
  it('counts a grant in the talk column, saying in --json where talk tier comes from, the configuration first', async () => {
    setup();
    const actor = { by: 'operator:alice', via: 'terminal' as const, chat: null };
    grantTier(db, { appId: 'cli_app', unionId: 'on_zed', openId: 'ou_zed', tier: 'talk', ...actor }, () => ({ write: 'insert' as const }), 1);
    grantTier(db, { appId: 'cli_app', unionId: 'on_bob', openId: 'ou_bob', tier: 'operate', ...actor }, () => ({ write: 'insert' as const }), 1);
    grantTier(db, { appId: 'cli_other', unionId: 'on_ann', openId: 'ou_ann', tier: 'talk', ...actor }, () => ({ write: 'insert' as const }), 1);
    expect((await fx.run(['kanban', 'people'])).out).toMatch(/^Bob Li +lark:on_zed +talk$/m);
    const people = (JSON.parse((await fx.run(['kanban', 'people', '--json'])).out) as { people: Array<{ union_id: string; talk: boolean; talk_from: string | null }> }).people;
    expect(people.map((p) => [p.union_id, p.talk, p.talk_from])).toEqual([
      ['on_ann', false, null],
      ['on_bob', true, 'config'],
      ['on_zed', true, 'grant'],
      ['on_owner', true, 'config'],
      ['on_quiet', false, null],
    ]);
  });

  it('says there is no bot to list for without an app id, and nobody has talk tier without an owner', async () => {
```

- [ ] **Step 11.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/gateway-startup.test.ts tests/mt-kanban-people.test.ts`. Expected: `Tests  3 failed | 20 passed (23)`; among the failures, `AssertionError: expected [ Array(1) ] to deeply equal [ …(2) ]`.

- [ ] **Step 11.3: Implement.**

In `src/cli/gate.ts`, replace:

```ts
   * The people this bot has seen, each with talk tier by this shell's allowlist,
   * none with an owner missing: `mt kanban people`'s (kanban spec §22.2).
```

with:

```ts
   * The people this bot has seen, each with talk tier by this shell's allowlist
   * or a grant, none with an owner missing: `mt kanban people`'s (kanban spec
   * §22.2, tier grants spec §8.3).
```

In `src/cli/gate.ts`, replace:

```ts
  talk: boolean;
```

with:

```ts
  /** Whether they can be given work: talk tier by this shell's lists, or by a grant (tier grants spec §8.3). */
  talk: boolean;
  /** Where their talk tier comes from, the configuration winning when both give it; null with none. */
  talkFrom: 'config' | 'grant' | null;
```

In `src/cli/gate.ts`, replace:

```ts
      : peopleOf(db, appId).map((p) => ({ unionId: p.unionId, name: p.name, talk: talk?.includes(p.openId) === true }));
```

with:

```ts
      : peopleOf(db, appId).map((p) => {
          // With no owner there is no talk list, and nobody is shown with talk tier.
          const has = talk !== undefined && tiersOf(lists, p.openId, grantOf(p.unionId)).talk;
          return { unionId: p.unionId, name: p.name, talk: has, talkFrom: !has ? null : talk.includes(p.openId) ? 'config' : 'grant' };
        });
```

In `src/cli/operator.ts`, replace:

```ts
 * terminal names them, `lark:<union_id>`, and whether they have talk tier by
 * the open_id last seen. A union_id is in no message a person sees, so this is
 * how an operator finds one.
```

with:

```ts
 * terminal names them, `lark:<union_id>`, and whether they have talk tier, by
 * the open_id last seen or by a grant, and from which (tier grants spec §8.3).
 * A union_id is in no message a person sees, so this is how an operator finds one.
```

In `src/cli/operator.ts`, replace:

```ts
      json: { people: seen.map((p) => ({ principal: `lark:${p.unionId}`, union_id: p.unionId, name: p.name, talk: p.talk })) },
```

with:

```ts
      json: { people: seen.map((p) => ({ principal: `lark:${p.unionId}`, union_id: p.unionId, name: p.name, talk: p.talk, talk_from: p.talkFrom })) },
```

In `src/index.ts`, replace:

```ts
import { tierReader } from './db/grants.js';
```

with:

```ts
import { grantCounts, tierReader } from './db/grants.js';
```

In `src/index.ts`, replace:

```ts
/**
 * An agent session's environment as the registry is given it (tier grants spec
```

with:

```ts
/**
 * The grants' startup lines (tier grants spec §8.4), after the schema's: how
 * many people this bot's active grants let in, by tier, and how many active
 * grants are another app id's, which count for nothing here; none of either
 * says nothing.
 */
export function grantLines(counts: { talk: number; operate: number; otherApps: number }): string[] {
  const out: string[] = [];
  if (counts.talk + counts.operate > 0) {
    out.push(`auth: ${counts.talk} person(s) granted talk and ${counts.operate} operate, beside the configuration's; mt auth list shows who`);
  }
  if (counts.otherApps > 0) out.push(`auth: ${counts.otherApps} grant(s) are for another app id than lark.appId, and count for nothing here`);
  return out;
}

/**
 * An agent session's environment as the registry is given it (tier grants spec
```

In `src/index.ts`, replace:

```ts
  note(`schema at version ${version} (${config.dbPath})`);
```

with:

```ts
  note(`schema at version ${version} (${config.dbPath})`);
  for (const line of grantLines(grantCounts(db, config.lark.appId))) note(line);
```

- [ ] **Step 11.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2630 passed (2630)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 11.5: Commit.**

```bash
git add src/cli/gate.ts src/cli/operator.ts src/index.ts tests/gateway-startup.test.ts tests/mt-kanban-people.test.ts
git commit -m "Say at startup how many people this bot's grants let in, and how many grants are another app id's, and count grants in mt kanban people's talk column, its --json saying whether talk tier comes from the configuration or a grant"
```

---

### Task 12: `/roles`

**Files:**

- Create: `src/core/roles-chat.ts`, `tests/roles-chat.test.ts`
- Modify: `src/roles.ts`, `src/core/commands.ts`, `src/core/router.ts`, `src/index.ts`, `tests/router.test.ts`, `tests/commands.test.ts`

§13. `/roles` at talk tier, as `/sessions` is registered: one line a role, by name, what it is for, whether it can be given work, its workspace and its open runs against its limit, cut at 30 (Decisions 16, 17). `roleMdFirstLine` reads a checked 8 KiB prefix of `role.md` and never shows a cut line. The router answers anything after `/roles` with its usage, keyed `roles-usage`, masks the reply, and answers a throw plainly, noting it masked.

- [ ] **Step 12.1: Write the tests.**

In `tests/commands.test.ts`, replace:

```ts
  it('has no /approve', () => {
```

with:

```ts
  it('runs /auth and /roles at talk tier, one line, without a session and never refused mid-turn', () => {
    for (const name of ['auth', 'roles']) {
      const parsed = parseCommand(`/${name} list\nmore`);
      if (parsed === undefined || !('spec' in parsed)) throw new Error(`/${name} did not parse`);
      expect(parsed.spec).toMatchObject({ name, tier: 'talk', needsSession: false, mutating: false, multiline: false, effect: 'immediate' });
      expect(parsed.arg).toBe('list');
    }
    expect(renderHelp()).toContain('`/auth <command>`');
    expect(renderHelp()).toContain('`/roles`');
  });

  it('has no /approve', () => {
```

In `tests/router.test.ts`, replace:

```ts
import { ACK_EMOJI, AUTH_OFF, KANBAN_OFF, Router, continuityLine, type InboundCardAction, type KanbanCommands, type RouterDeps } from '../src/core/router.js';
```

with:

```ts
import { ACK_EMOJI, AUTH_OFF, KANBAN_OFF, ROLES_OFF, Router, continuityLine, type InboundCardAction, type KanbanCommands, type RouterDeps } from '../src/core/router.js';
```

In `tests/router.test.ts`, replace:

```ts
    withGrants?: boolean;
```

with:

```ts
    withGrants?: boolean;
    roles?: () => string;
```

In `tests/router.test.ts`, replace:

```ts
    ...(opts.cronTurns === undefined ? {} : { cronTurns: opts.cronTurns }),
```

with:

```ts
    ...(opts.cronTurns === undefined ? {} : { cronTurns: opts.cronTurns }),
    ...(opts.roles === undefined ? {} : { roles: opts.roles }),
```

In `tests/router.test.ts`, replace:

```ts
describe('Router: prompts', () => {
```

with:

```ts
describe('Router: /roles', () => {
  afterEach(() => clearSecrets());

  it('is registered at talk tier, listed in /help, answered while the session is busy, and refused silently without talk', async () => {
    let asked = 0;
    const h = harness({ roles: () => (asked += 1, '**worker**: writes') });
    await h.router.onMessage(msg({ text: '/help' }));
    expect(lastReply(h)).toContain('`/roles`: The roles, what each is for, whether it can be given work, and its open runs. (anyone allowed)');
    await working(h);
    const message = msg({ text: '/roles' });
    await h.router.onMessage(message);
    expect(h.channel.texts.at(-1)).toMatchObject({ text: '**worker**: writes', uuid: replyUuid(APP, message.messageId, 'roles') });
    const before = h.channel.texts.length;
    await h.router.onMessage(msg({ text: '/roles', sender: GUEST }));
    expect(h.channel.texts).toHaveLength(before);
    expect(asked).toBe(1);
  });

  it('answers anything after it with the usage, keyed roles-usage, and lists nothing', async () => {
    let asked = 0;
    const h = harness({ roles: () => (asked += 1, 'the roles') });
    const message = msg({ text: '/roles worker' });
    await h.router.onMessage(message);
    expect(h.channel.texts.at(-1)).toMatchObject({ text: 'Usage: `/roles`, with nothing after it.', uuid: replyUuid(APP, message.messageId, 'roles-usage') });
    expect(asked).toBe(0);
  });

  it('says so with nothing to list them, masks the reply, and answers one that throws plainly, noting it masked', async () => {
    const plain = harness();
    await plain.router.onMessage(msg({ text: '/roles' }));
    expect(lastReply(plain)).toBe(ROLES_OFF);
    expect(ROLES_OFF).toBe('The roles cannot be listed here.');
    addSecrets(['sk-roles-12345678']);
    const masked = harness({ roles: () => 'holds sk-roles-12345678' });
    await masked.router.onMessage(msg({ text: '/roles' }));
    expect(lastReply(masked)).toBe(`holds ${MASK}`);
    const h = harness({
      roles: () => {
        throw new Error('EACCES near sk-roles-12345678');
      },
    });
    await h.router.onMessage(msg({ text: '/roles' }));
    expect(lastReply(h)).toBe('Could not list the roles.');
    const noted = h.notes.find((n) => n.includes('roles command in')) ?? '';
    expect(noted).toContain(MASK);
    expect(noted).not.toContain('sk-roles');
  });
});

describe('Router: prompts', () => {
```

Create `tests/roles-chat.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLES_MAX, renderRoles, rolesReply, type RolesView } from '../src/core/roles-chat.js';
import { KanbanService } from '../src/kanban/service.js';
import { ROLE_MD_PREFIX_BYTES, ROLE_MD_UNREADABLE, roleMdFirstLine, wholeUtf8, type Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets, redactKnownSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * `/roles` (the tier grants spec §13): `role.md`'s first line read from a
 * checked 8 KiB prefix, never a cut line; one line a role, by name, with what
 * it is for, whether it can be given work, its workspace and its open runs
 * against its limit; the 30-line cut; masking; and the count the dispatcher's
 * limit uses.
 */

let dir: string;
beforeEach(() => {
  clearSecrets();
  dir = mkdtempSync(join(tmpdir(), 'mt-roles-chat-'));
});
afterEach(() => {
  clearSecrets();
  rmSync(dir, { recursive: true, force: true });
});

function roleMd(text: string | Uint8Array, name = 'role.md'): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe('roleMdFirstLine', () => {
  it('gives the first line that is not empty, a heading as its words', () => {
    expect(roleMdFirstLine(roleMd('\n  \n## Writes the weekly notes\nthen more\n'))).toBe('Writes the weekly notes');
    expect(roleMdFirstLine(roleMd('#\n\r\nChecks a task before done'))).toBe('Checks a task before done');
    expect(roleMdFirstLine(roleMd(''))).toBeUndefined();
    expect(roleMdFirstLine(roleMd('\n\n'))).toBeUndefined();
  });

  it('is unreadable for a symbolic link, a directory or nothing there, as the start refuses them', () => {
    const real = roleMd('Real instructions', 'real.md');
    symlinkSync(real, join(dir, 'linked.md'));
    expect(roleMdFirstLine(join(dir, 'linked.md'))).toBe(ROLE_MD_UNREADABLE);
    mkdirSync(join(dir, 'folder.md'));
    expect(roleMdFirstLine(join(dir, 'folder.md'))).toBe(ROLE_MD_UNREADABLE);
    expect(roleMdFirstLine(join(dir, 'gone.md'))).toBe(ROLE_MD_UNREADABLE);
    expect(ROLE_MD_UNREADABLE).toBe('(role.md unreadable)');
  });

  it('never gives a line still going at 8 KiB, so a secret across the limit is never shown in part', () => {
    expect(ROLE_MD_PREFIX_BYTES).toBe(8192);
    expect(roleMdFirstLine(roleMd('x'.repeat(9000)))).toBeUndefined();
    // Ending exactly at the end of a file of 8 KiB is whole.
    expect(roleMdFirstLine(roleMd('y'.repeat(8192)))).toBe('y'.repeat(8192));
    const secret = 'sk-live-abcdefghijklmnop';
    addSecrets([secret]);
    const path = roleMd(`${'z'.repeat(8180)} ${secret} and on\n`);
    const reply = redactKnownSecrets(renderRoles([role('writer', { roleMdPath: path })], { firstLine: (r) => roleMdFirstLine(r.roleMdPath), running: () => ({ count: 0, limit: undefined }), boardOn: true }));
    expect(reply).toBe('**writer**: – · can be given work: yes · workspace any (default) · running 0');
    expect(reply).not.toContain('sk-');
  });

  it('drops a partial UTF-8 character at the prefix end whole, and reads only the prefix of a large file', () => {
    expect([...wholeUtf8(Buffer.from('ab日', 'utf8').subarray(0, 4))]).toEqual([0x61, 0x62]);
    expect([...wholeUtf8(Buffer.from('ab日', 'utf8'))]).toEqual([...Buffer.from('ab日', 'utf8')]);
    expect([...wholeUtf8(Buffer.from('a😀', 'utf8').subarray(0, 3))]).toEqual([0x61]);
    expect([...wholeUtf8(Buffer.from([]))]).toEqual([]);
    expect(roleMdFirstLine(roleMd(Buffer.concat([Buffer.from('\n'.repeat(8191)), Buffer.from('日本\n', 'utf8')])))).toBeUndefined();
    // 3 GiB, sparse: a whole read would not fit in a buffer at all.
    const big = roleMd('# The big one\n', 'big.md');
    truncateSync(big, 3 * 1024 ** 3);
    expect(roleMdFirstLine(big)).toBe('The big one');
  });
});

describe('renderRoles', () => {
  const view = (over: Partial<RolesView> = {}): RolesView => ({ firstLine: () => undefined, running: () => ({ count: 0, limit: undefined }), boardOn: true, ...over });

  it("says what a role is for by its description, else its role.md's first line, else –", () => {
    const roles = [
      role('worker', { description: 'general research and writing', roleMdPath: '/r/worker/role.md' }),
      role('reviewer', { roleMdPath: '/r/reviewer/role.md' }),
      // A role.md added after the start: roleMdPath was fixed when the role loaded.
      role('late'),
    ];
    const lines = renderRoles(roles, view({ firstLine: (r) => `${r.name}'s first line` })).split('\n');
    expect(lines).toEqual([
      "**late**: – · can be given work: yes · workspace any (default) · running 0",
      "**reviewer**: reviewer's first line · can be given work: yes · workspace any (default) · running 0",
      '**worker**: general research and writing · can be given work: yes · workspace any (default) · running 0',
    ]);
  });

  it('says supervised roles go to the board only, and nowhere with it off; a workspace set or any; the runs against the limit', () => {
    const roles = [
      role('worker', { workspace: 'worker', maxRunning: 2 }),
      role('watched', { agent: { ...role('x').agent, unsupervised: false } }),
      role('free'),
    ];
    const running = (name: string) => (name === 'worker' ? { count: 1, limit: 2 } : name === 'free' ? { count: 3, limit: undefined } : { count: 0, limit: 1 });
    expect(renderRoles(roles, view({ running })).split('\n')).toEqual([
      '**free**: – · can be given work: yes · workspace any (default) · running 3',
      '**watched**: – · can be given work: board only (supervised) · workspace any (default) · running 0 of 1',
      '**worker**: – · can be given work: yes · workspace worker · running 1 of 2',
    ]);
    expect(renderRoles(roles, view({ running, boardOn: false })).split('\n')).toEqual([
      '**free**: – · can be given work: yes · workspace any (default) · running –',
      '**watched**: – · can be given work: no (supervised; the board is off) · workspace any (default) · running –',
      '**worker**: – · can be given work: yes · workspace worker · running –',
    ]);
  });

  it('sorts by localeCompare, cuts at 30 lines with exactly its last line, masks a description, and never shows the agent', () => {
    addSecrets(['sk-desc-12345678']);
    const roles: Role[] = Array.from({ length: 33 }, (_, i) => role(`r${String(i).padStart(2, '0')}`));
    roles.push(role('Alpha', { description: 'holds sk-desc-12345678', agent: { ...role('x').agent, command: '/opt/secret-host/bin/agent', args: ['--model', 'm-1'] } }));
    const lines = renderRoles(roles, view()).split('\n');
    expect(lines).toHaveLength(ROLES_MAX + 1);
    expect(lines[0]).toBe(`**Alpha**: holds ${MASK} · can be given work: yes · workspace any (default) · running 0`);
    expect(lines[1]?.startsWith('**r00**')).toBe(true);
    expect(lines.at(-1)).toBe('… and 4 more; mt role list shows all');
    expect(lines.join('\n')).not.toMatch(/secret-host|m-1|bytesec/);
  });
});

describe('rolesReply', () => {
  let t: TestDb;
  afterEach(() => t?.close());

  it("counts a role's work and review runs, a decided one until it closes, and not a person's run or a cron fire", async () => {
    t = testDb();
    const roles = new Map([
      ['worker', role('worker', { maxRunning: 2 })],
      ['reviewer', role('reviewer')],
    ]);
    const service = new KanbanService({ db: t.db, roles, workspaces: WORKSPACES, people: { canTalk: () => true } });
    const create = (title: string, extra: { assignee?: string; reviewer?: string; workspace?: string } = {}) => {
      const r = service.create({ title, assignee: extra.assignee ?? 'worker', createdBy: ALICE, createdVia: VIA, ...(extra.reviewer === undefined ? {} : { reviewer: extra.reviewer }), workspace: extra.workspace ?? 'web' });
      if (!r.ok) throw new Error(r.message);
      return r.task.taskId;
    };
    const claim = (taskId: string) => {
      const r = service.claim(taskId);
      if (!r.ok) throw new Error(r.message);
      return r.run.runId;
    };
    const reply = (): string[] => rolesReply(t.db, roles, { enabled: true, maxRunningPerRole: 1 }).split('\n');
    claim(create('one'));
    const reviewed = create('two', { reviewer: 'reviewer', workspace: 'api' });
    const work = claim(reviewed);
    claim(create('a person', { assignee: 'lark:on_alice', workspace: 'docs' }));
    t.db
      .prepare(
        `INSERT INTO cron_jobs (job_id, name, schedule, tz, role, workspace, prompt, state, next_run_at, created_by, created_via, created_at, updated_at)
         VALUES ('c_1', 'n', 'every 1h', 'UTC', 'worker', 'default', 'p', 'active', ?, 'operator:x', '{"kind":"operator"}', ?, ?)`,
      )
      .run(NOW, NOW, NOW);
    t.db.prepare("INSERT INTO cron_fires (job_id, scheduled_at, trigger, started_at) VALUES ('c_1', ?, 'schedule', ?)").run(NOW, NOW);
    expect(reply()).toEqual([
      '**reviewer**: – · can be given work: yes · workspace any (default) · running 0 of 1',
      '**worker**: – · can be given work: yes · workspace any (default) · running 2 of 2',
    ]);
    // Decided, still open: counted until it closes; then the review run counts against the reviewer.
    expect((await service.requestReview(reviewed, { kind: 'run', runId: work }, { summary: 'look' })).ok).toBe(true);
    expect(reply()[1]).toMatch(/running 2 of 2$/);
    expect(service.closeRun(work).ok).toBe(true);
    expect(reply()[1]).toMatch(/running 1 of 2$/);
    claim(reviewed);
    expect(reply()[0]).toMatch(/running 1 of 1$/);
    expect(rolesReply(t.db, roles, { enabled: false }).split('\n').every((l) => l.endsWith('running –'))).toBe(true);
  });
});
```

- [ ] **Step 12.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/commands.test.ts tests/roles-chat.test.ts tests/router.test.ts`. Expected: `Test Files  3 failed (3)` and `Tests  5 failed | 98 passed (103)`; `tests/roles-chat.test.ts` fails to load, `Error: Cannot find module '../src/core/roles-chat.js' imported from …/tests/roles-chat.test.ts`.

- [ ] **Step 12.3: Implement.**

In `src/core/commands.ts`, replace:

```ts
    summary: 'Cancel the current turn. Cancellation is a terminal, not a deletion.',
  },
```

with:

```ts
    summary: 'Cancel the current turn. Cancellation is a terminal, not a deletion.',
  },
  {
    name: 'roles',
    // Talk, as /sessions is: a person giving work to a role needs to know its name and what it is for.
    tier: 'talk',
    needsSession: false,
    effect: 'immediate',
    multiline: false,
    mutating: false,
    summary: 'The roles, what each is for, whether it can be given work, and its open runs.',
  },
```

In `src/core/router.ts`, replace:

```ts
  auth?: { run(arg: string, message: InboundMessage): string };
```

with:

```ts
  auth?: { run(arg: string, message: InboundMessage): string };
  /**
   * `/roles` (tier grants spec §13): the reply's text, synchronous, which the
   * router masks. Absent where a caller gives none, and `/roles` says so.
   */
  roles?: () => string;
```

In `src/core/router.ts`, replace:

```ts
/** What `/auth` says where nothing was given to answer it. */
```

with:

```ts
/** What `/roles` says where nothing was given to answer it. */
export const ROLES_OFF = 'The roles cannot be listed here.';

/** What `/auth` says where nothing was given to answer it. */
```

In `src/core/router.ts`, replace:

```ts
      case 'auth': {
```

with:

```ts
      case 'roles': {
        if (arg !== '') {
          // A word after it reads as a filter, and a full list would look like one that matched everything.
          await this.#reply(target, message, 'roles-usage', 'Usage: `/roles`, with nothing after it.');
          return;
        }
        const roles = this.#deps.roles;
        let text: string;
        if (roles === undefined) text = ROLES_OFF;
        else {
          try {
            text = roles();
          } catch (err) {
            this.#note(`roles command in ${message.messageId} failed: ${redactKnownSecrets(err instanceof Error ? err.message : String(err))}`);
            text = 'Could not list the roles.';
          }
        }
        await this.#reply(target, message, 'roles', redactKnownSecrets(text));
        return;
      }

      case 'auth': {
```

In `src/index.ts`, replace:

```ts
import { Router } from './core/router.js';
```

with:

```ts
import { Router } from './core/router.js';
import { rolesReply } from './core/roles-chat.js';
```

In `src/index.ts`, replace:

```ts
    auth: authChat,
```

with:

```ts
    auth: authChat,
    // The gateway's roles, read at each /roles, the board on or off (tier grants spec §13).
    roles: () => rolesReply(db, team.roles, config.kanban),
```

In `src/roles.ts`, replace:

```ts
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
```

with:

```ts
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
```

In `src/roles.ts`, replace:

```ts
/**
 * The user-level skill directories bytesec 0.7.4 loads for an agent that is not
```

with:

```ts
/** How much of `role.md` `/roles` reads, at most: its first line is what it shows. */
export const ROLE_MD_PREFIX_BYTES = 8 * 1024;

/** What `/roles` shows for a `role.md` it cannot read: anything not a regular file, or a read that fails. */
export const ROLE_MD_UNREADABLE = '(role.md unreadable)';

/** The longest start of `bytes` that ends on a whole UTF-8 character: a partial one at the end is dropped whole. */
export function wholeUtf8(bytes: Uint8Array): Uint8Array {
  // Back from the end over at most three continuation bytes, to the lead byte of the last character.
  let lead = bytes.length - 1;
  while (lead >= 0 && lead > bytes.length - 4 && ((bytes[lead] ?? 0) & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return bytes;
  const b = bytes[lead] ?? 0;
  const size = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  return lead + size > bytes.length ? bytes.subarray(0, lead) : bytes;
}

/**
 * The first line of a role's `role.md` that is not empty, as `/roles` shows
 * what a role is for (tier grants spec §13.2), read when asked: `^#+\s*`
 * stripped, so a heading shows as its words. The file is checked first, as
 * `readRoleMd` checks it at the start: a regular file, not a symbolic link;
 * anything else, or a read that fails, is `ROLE_MD_UNREADABLE`. At most an
 * 8 KiB prefix is read, and a line still going at its end is never shown, as
 * a secret cut in two would reach the reply as its first half, unmasked:
 * undefined then, as for a file with no line at all.
 */
export function roleMdFirstLine(path: string): string | undefined {
  let fd: number | undefined;
  let bytes: Uint8Array;
  let size: number;
  try {
    if (!lstatSync(path).isFile()) return ROLE_MD_UNREADABLE;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return ROLE_MD_UNREADABLE;
    size = stat.size;
    const buffer = Buffer.alloc(ROLE_MD_PREFIX_BYTES);
    const read = readSync(fd, buffer, 0, ROLE_MD_PREFIX_BYTES, 0);
    bytes = buffer.subarray(0, read);
  } catch {
    return ROLE_MD_UNREADABLE;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const cut = bytes.length >= ROLE_MD_PREFIX_BYTES && size > bytes.length;
  const lines = new TextDecoder().decode(cut ? wholeUtf8(bytes) : bytes).split(/\r?\n/);
  for (const [i, text] of lines.entries()) {
    const shown = text.trim().replace(/^#+\s*/, '');
    if (shown === '') continue;
    // The last piece of a cut prefix may go on past it.
    if (cut && i === lines.length - 1) return undefined;
    return shown;
  }
  return undefined;
}

/**
 * The user-level skill directories bytesec 0.7.4 loads for an agent that is not
```

Create `src/core/roles-chat.ts`:

```ts
import { openAgentRunCountAs } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { label } from '../kanban/chat-render.js';
import { roleLimit, roleMdFirstLine, type Role } from '../roles.js';

/**
 * `/roles` in chat (the tier grants spec §13): one line a role, sorted by
 * name, with what it is for, whether it can be given work, where it works and
 * its open agent runs against its `max_running`, in the layout of the
 * gateway's other chat lists. Nothing of how a role runs: its command, driver,
 * model, args, environment, secrets and skills are the terminal's. Each field
 * goes through `label`, masked, and the router masks the whole reply again.
 */

/** At most this many roles, then how many more: `/kanban task list`'s number. */
export const ROLES_MAX = 30;

/** A role's open agent runs, and the limit they are held to, if any. */
export interface Running {
  count: number;
  limit: number | undefined;
}

export interface RolesView {
  /** The first line of `role.md`, as read now, for a role that had one at the start; undefined for none. */
  firstLine: (role: Role & { roleMdPath: string }) => string | undefined;
  /** A role's open agent runs and its limit, by name. */
  running: (name: string) => Running;
  /** Whether the board runs: with it off no dispatcher runs, so no limit applies. */
  boardOn: boolean;
}

/** One role's line: `**name**: what · can be given work: … · workspace … · running …`. */
function roleLine(role: Role, view: RolesView): string {
  // A role.md added since the start is not seen: roleMdPath was fixed when the role loaded.
  const line = role.description ?? (role.roleMdPath === undefined ? undefined : view.firstLine({ ...role, roleMdPath: role.roleMdPath }));
  const what = line === undefined || line === '' ? '–' : label(line, 80);
  const work = role.agent.unsupervised ? 'yes' : view.boardOn ? 'board only (supervised)' : 'no (supervised; the board is off)';
  const workspace = role.workspace === undefined ? 'any (default)' : label(role.workspace, 80);
  let running = '–';
  if (view.boardOn) {
    const r = view.running(role.name);
    running = r.limit === undefined ? String(r.count) : `${r.count} of ${r.limit}`;
  }
  return `**${label(role.name, 80)}**: ${what} · can be given work: ${work} · workspace ${workspace} · running ${running}`;
}

/** The reply to `/roles`: the roles given, by name, at most `ROLES_MAX` lines and then how many more. */
export function renderRoles(roles: Iterable<Role>, view: RolesView): string {
  const sorted = [...roles].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.slice(0, ROLES_MAX).map((r) => roleLine(r, view));
  const more = sorted.length - ROLES_MAX;
  if (more > 0) lines.push(`… and ${more} more; mt role list shows all`);
  return lines.join('\n');
}

/**
 * `/roles` over the gateway's roles and database: `role.md` read now, the
 * open runs as the dispatcher's limit counts them, and the limit `roleLimit`
 * gives, the role's own or `kanban.max_running_per_role`.
 */
export function rolesReply(db: Db, roles: ReadonlyMap<string, Role>, kanban: { enabled: boolean; maxRunningPerRole?: number }): string {
  return renderRoles(roles.values(), {
    firstLine: (role) => roleMdFirstLine(role.roleMdPath),
    running: (name) => {
      const role = roles.get(name);
      return { count: openAgentRunCountAs(db, name), limit: role === undefined ? undefined : roleLimit(role, kanban.maxRunningPerRole)?.limit };
    },
    boardOn: kanban.enabled,
  });
}
```

- [ ] **Step 12.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2642 passed (2642)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 12.5: Commit.**

```bash
git add src/core/commands.ts src/core/roles-chat.ts src/core/router.ts src/index.ts src/roles.ts tests/commands.test.ts tests/roles-chat.test.ts tests/router.test.ts
git commit -m "Add /roles in chat at talk tier: one line a role, by name, with what it is for from its description or role.md's first line, read from a checked 8 KiB prefix and never cut, whether it can be given work, its workspace, and its open runs against its max_running"
```

---

### Task 13: The README, the guide, `config.example.yaml` and the other specs

**Files:**

- Modify: `README.md`, `config.example.yaml`, `docs/kanban-guide.md`, `docs/specs/2026-08-21-lark-channel-design.md`, `docs/specs/2026-11-02-kanban-design.md`, `docs/specs/2026-11-16-cron-design.md`, `tests/docs-examples.test.ts`

§10's docs, §13.6. `config.example.yaml`'s owner comment says the lists are not editable from chat and that a grant adds people beside them; a comment above `agent:` says what `/roles` shows. The README's `auth.talk` and `auth.operate` rows and its "Empty means closed" rule name grants; its command table gains `/auth` and `/roles`; its `mt` usage gains `mt auth`; a paragraph "Letting people in" gives the examples; and a sentence after a role's `config.yaml` warns what `/roles` shows. The guide says a tier comes from the config or a grant, gains a section "Letting people in", and says `mt kanban people` counts grants. The channel spec §3.4, the kanban spec §4.2 and §22.2 and the cron spec §10 get an amendment pointing at the tier grants spec, cron §10's rule reworded as §6.3 says. `tests/docs-examples.test.ts` runs the `/auth` and `mt auth` examples. `/help` needs nothing: it renders the registry.

- [ ] **Step 13.1: Write the tests.**

In `tests/docs-examples.test.ts`, replace:

```ts
import { clearSecrets } from '../src/secrets.js';
```

with:

```ts
import { clearSecrets } from '../src/secrets.js';
import { AuthChat } from '../src/policy/auth-chat.js';
import { Authorizer, defaultAuthConfig, tiersOf } from '../src/policy/auth.js';
import { tierReader } from '../src/db/grants.js';
import { PeopleDirectory } from '../src/kanban/people.js';
```

In `tests/docs-examples.test.ts`, replace:

```ts
 * finds the gateway's launcher first, and an agent's JSON through the handler it is sent to. Nothing here
```

with:

```ts
 * finds the gateway's launcher first, an agent's JSON through the handler it is sent to, and a
 * `/auth` line through chat's `/auth` and an `mt auth` line through `mt`. Nothing here
```

In `tests/docs-examples.test.ts`, replace:

```ts
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
  });
});
```

with:

```ts
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
  });
});

describe('/auth and mt auth', () => {
  /** The gateway's `/auth` over a home: the owner Alice, Dana at talk tier, as the home's config gives them. */
  function authChat(h: Home): AuthChat {
    const lists = { allowTalk: ['ou_owner', DANA.openId], allowOperate: ['ou_owner'] };
    const authorizer = new Authorizer({ ...defaultAuthConfig('ou_owner'), ...lists }, { grants: { tierOf: tierReader(h.db, 'cli_app') } });
    return new AuthChat({
      db: h.db,
      appId: 'cli_app',
      authorizer,
      auth: { ownerOpenId: 'ou_owner', ...lists, from: { owner: 'auth.owner', talk: 'auth.talk', operate: 'auth.operate' } },
      people: new PeopleDirectory({ db: h.db, appId: 'cli_app', canTalk: (p) => tiersOf(lists, p.openId, authorizer.grantOf(p.unionId)).talk }),
      zone: 'Asia/Shanghai',
      clock: new ManualClock(NOW),
    });
  }

  let sent = 0;

  /** A line of an `auth chat` block, from the owner in a group, its @-mentions as Lark would send them. */
  function inGroup(text: string): InboundMessage {
    return {
      messageId: `om_docs_auth_${++sent}`,
      appId: 'cli_app',
      chatId: 'oc_team',
      chatType: 'group',
      threadId: '',
      sender: { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Alice' },
      senderIsBot: false,
      text,
      mentionedBot: true,
      mentionAll: false,
      mentions: mentionsIn(text).map((name, i) => {
        const unionId = principalOf(`@${name}`).slice('lark:'.length);
        return { key: `@_user_${i + 1}`, name, openId: `ou_${unionId.slice(3)}`, unionId };
      }),
      attachments: [],
      createTime: NOW,
    };
  }

  it("each /auth line in the guide and the README is done by chat's /auth, and the guide's reply is the one it gives", () => {
    let seen = 0;
    for (const doc of ['docs/kanban-guide.md', 'README.md'] as const) {
      const h = docHome.get(doc) as Home;
      const chat = authChat(h);
      for (const b of (blocks.get(doc) ?? []).filter((x) => x.marker === 'auth chat')) {
        const replies = b.body
          .split('\n')
          .filter((l) => l.startsWith('/auth '))
          .map((l) => chat.run(l.slice('/auth '.length), inGroup(l)));
        expect(replies.length, where(b)).toBeGreaterThanOrEqual(3);
        for (const r of replies) expect(r, where(b)).toMatch(/^(Carol Wu now has|Carol Wu no longer has|Owner: )/);
        if (doc === 'docs/kanban-guide.md') {
          const quoted = (replies[0] ?? '').replace(/lark:on_[a-z0-9_]+/, 'lark:on_…');
          expect(readFileSync(join(REPO, doc), 'utf8')).toContain(`> ${quoted}`);
        }
        seen += 1;
      }
    }
    expect(seen).toBe(2);
  });

  it('each mt auth line in the guide and the README is done by mt, for a person the bot has seen', async () => {
    let seen = 0;
    for (const doc of ['docs/kanban-guide.md', 'README.md'] as const) {
      const h = docHome.get(doc) as Home;
      for (const b of (blocks.get(doc) ?? []).filter((x) => x.marker === 'auth terminal')) {
        const commands = commandsOf(b.body).filter((c) => c.command.startsWith('mt auth '));
        expect(commands.length, where(b)).toBeGreaterThanOrEqual(3);
        for (const c of commands) {
          const r = await h.mt(shellWords(c.command).slice(1));
          expect(r.code, `${where(b)}: ${c.command}: ${r.err}`).toBe(0);
        }
        seen += 1;
      }
    }
    expect(seen).toBe(2);
  });
});
```

- [ ] **Step 13.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/docs-examples.test.ts`. Expected: `Tests  2 failed | 25 passed (27)`; among the failures, `AssertionError: expected +0 to be 2 // Object.is equality`: no example is marked yet.

- [ ] **Step 13.3: Implement.**

In `README.md`, replace:

```markdown
| `auth.talk` | `MT_ALLOW_TALK` | `open_id`s that may prompt the agent. |
| `auth.operate` | `MT_ALLOW_OPERATE` | `open_id`s that may answer approvals and run mutating commands. |
```

with:

```markdown
| `auth.talk` | `MT_ALLOW_TALK` | `open_id`s that may prompt the agent. A grant, `/auth grant @Name talk` in chat or `mt auth grant` at the terminal, adds a person beside them, kept in the database and counted at once; no command removes an entry. |
| `auth.operate` | `MT_ALLOW_OPERATE` | `open_id`s that may answer approvals and run mutating commands. Only the owner, or the terminal, grants operate tier beside them. |
```

In `README.md`, replace:

```markdown
  no-restrictions.
```

with:

```markdown
  no-restrictions. A grant adds a person beside a list and never removes one, and a grant
  that cannot be read counts as none.
```

In `README.md`, replace:

```markdown
A role's `max_running: N`, a positive whole number, lets at most N of its agent runs be open at
```

with:

```markdown
`/roles` shows a role's `description` in chat, to anyone at talk tier, in every chat the gateway
acts in, and the first line of its `role.md` when it has none: keep in neither anything a
talk-tier person should not read.

A role's `max_running: N`, a positive whole number, lets at most N of its agent runs be open at
```

In `README.md`, replace:

```markdown
mt update [--check | --yes]
```

with:

```markdown
mt update [--check | --yes]
mt auth grant lark:<union_id> talk|operate [--json]
mt auth revoke lark:<union_id> [--json]
mt auth list [--json]
```

In `README.md`, replace:

```markdown
| `/help` | talk | List commands |
```

with:

```markdown
| `/help` | talk | List commands |
| `/roles` | talk | The roles, what each is for, whether it can be given work, and its open runs |
| `/auth <command>` | talk; an operator grants talk, the owner operate | Who may talk to the agent and operate it, below. Never refused because this chat's session is busy |
```

In `README.md`, replace:

```markdown
### The board from Lark
```

with:

````markdown
**Letting people in.** A tier comes from `auth.talk` and `auth.operate`, or from a grant. In a
group the person is in, @-mention them, so Lark gives their ids and nobody types one:

<!-- example: auth chat -->
```text
/auth grant @Carol Wu talk
/auth list
/auth revoke @Carol Wu
```

The reply in the chat is the announcement. An operator grants and revokes talk; only the owner
grants operate, or revokes an operate grant. A grant counts at the next message, with no
restart, and never removes a config entry or the owner. At the terminal, as the owner, for a
person the bot has seen (`mt kanban people` lists them):

<!-- example: auth terminal -->
```
mt auth grant lark:on_5d1e7a operate
mt auth list
mt auth revoke lark:on_5d1e7a
```

`mt auth` is refused in every agent's shell, and posts in no chat.

### The board from Lark
````

In `config.example.yaml`, replace:

```yaml
  # excludes the owner locks out the only person who can fix it, and it is not
  # editable from chat.
```

with:

```yaml
  # excludes the owner locks out the only person who can fix it. The lists are
  # not editable from chat: /auth grant, and mt auth grant at the terminal, add
  # people beside them, kept in the database, and never remove an entry or the
  # owner. A grant counts at once, with no restart.
```

In `config.example.yaml`, replace:

```yaml
agent:
```

with:

```yaml
# The role default, when there is no roles/default/. It has no description, so
# /roles shows "–" for what it is for. A role directory's config.yaml
# description, else the first line of its role.md, is what /roles shows in
# chat, to anyone at talk tier, in every chat the gateway acts in: keep in
# neither anything a talk-tier person should not read.
agent:
```

In `docs/kanban-guide.md`, replace:

```markdown
config. Anyone at talk tier may use the board's read commands; anything that changes the board
needs operator tier, except a person's reports on their own task.
```

with:

```markdown
config, or from a grant (see "Letting people in", below). Anyone at talk tier may use the
board's read commands; anything that changes the board needs operator tier, except a person's
reports on their own task.
```

In `docs/kanban-guide.md`, replace:

```markdown
## 1. One task for a role
```

with:

````markdown
### Letting people in

A tier comes from the gateway's config, `auth.talk` and `auth.operate`, or from a grant made in
chat or at the terminal. A grant counts at once, with no restart, everywhere a tier is checked:
messages, card buttons, `/kanban` and the people tasks are given to. It never removes a config
entry or the owner. In a group the person is in, @-mention them, so Lark gives their ids:

<!-- example: auth chat -->
```text
/auth grant @Carol Wu talk
/auth grant @Carol Wu operate
/auth revoke @Carol Wu
/auth list
```

> Carol Wu now has talk tier, granted by Alice. `/auth revoke lark:on_…` takes it back.

The reply is the announcement: everyone in the chat sees it. An operator grants and revokes
talk; only the owner grants operate, or revokes an operate grant, so every operator is one the
owner or the config made. A grant takes an @-mention only; `/auth revoke lark:<union_id>` takes
the id `/auth list` shows, for someone who is no longer in the chat. Granting a tier a person
has already is answered with where it comes from, and changes nothing. A revoked person is
refused from their next message on; a turn already running finishes; their tasks stay assigned,
and their next card is refused, so an operator reassigns them.

At the terminal, as the owner, for a person the bot has seen (`mt kanban people` lists them):

<!-- example: auth terminal -->
```
mt auth grant lark:on_5d1e7a operate
mt auth list
mt auth revoke lark:on_5d1e7a
```

`mt auth` judges by the config as your shell reads it, posts in no chat, and is refused in every
agent's shell. `mt auth list --json` gives each person's tier, config entries and grant, with who
made it and when.

## 1. One task for a role
````

In `docs/kanban-guide.md`, replace:

```markdown
  (`auth.talk`). Otherwise the chat says, for example:
```

with:

```markdown
  (`auth.talk`, or a grant, which needs no earlier message from them). Otherwise the chat says,
  for example:
```

In `docs/kanban-guide.md`, replace:

```markdown
  shell's settings give. `mt kanban people` lists the people the gateway knows, by name, with
  their `lark:` ids and `talk` or `no`. There are no @-mentions here: `@Alice` is refused.
```

with:

```markdown
  shell's settings give, or by a grant. `mt kanban people` lists the people the gateway knows, by
  name, with their `lark:` ids and `talk` or `no`, a grant counted; `--json` says whether talk
  tier comes from the config or a grant. There are no @-mentions here: `@Alice` is refused.
```

In `docs/specs/2026-08-21-lark-channel-design.md`, replace:

```markdown
  second entry point silently reopening a boundary the first one closed.
```

with:

```markdown
  second entry point silently reopening a boundary the first one closed.
  *Amended on 2026-11-18 by the tier grants spec,
  [`2026-11-18-tier-grants-design.md`](2026-11-18-tier-grants-design.md) §4.2:* a tier has two
  sources, each with a single write path: the configuration's lists, written by `loadConfig`
  alone, and the grants, written by `db/grants.ts` alone.
```

In `docs/specs/2026-11-02-kanban-design.md`, replace:

```markdown
  be checked, and is refused.
```

with:

```markdown
  be checked, and is refused. *Amended on 2026-11-18 by the tier grants spec,
  [`2026-11-18-tier-grants-design.md`](2026-11-18-tier-grants-design.md) §4.3:* a person named by
  principal has talk tier when the `open_id` `people` holds for them is in the talk list, **or**
  their union_id has an active grant, which needs no row in `people`.
```

In `docs/specs/2026-11-02-kanban-design.md`, replace:

```markdown
  settings, so the terminal's check is chat's own code, against the same table.
```

with:

```markdown
  settings, so the terminal's check is chat's own code, against the same table. *Amended on
  2026-11-18 by the tier grants spec,
  [`2026-11-18-tier-grants-design.md`](2026-11-18-tier-grants-design.md) §4.3:* `canTalk` takes
  the person's open_id, null when `people` holds none, and union_id, and counts their active
  grant, read from the database the terminal opened; one not yet migrated to grants has none.
```

In `docs/specs/2026-11-16-cron-design.md`, replace:

```markdown
  gets a token or a changed `PATH`, `/cron` says cron is off, and the tables wait. A gateway that
  never sets it runs chat exactly as before.
```

with:

```markdown
  gets a token or a `PATH` change, `/cron` says cron is off, and the tables wait; the session
  marker, `MT_AGENT_SESSION`, is always set, cron on or off (*amended on 2026-11-18 by the tier
  grants spec, [`2026-11-18-tier-grants-design.md`](2026-11-18-tier-grants-design.md) §6.3*, so
  that `mt auth` refuses every agent's shell). A gateway that never sets it runs chat exactly as
  before.
```

- [ ] **Step 13.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2644 passed (2644)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors. `git diff 0284031 -- README.md config.example.yaml docs/kanban-guide.md | grep "^+" | grep -c "—"` prints `0`.

- [ ] **Step 13.5: Commit.**

```bash
git add README.md config.example.yaml docs/kanban-guide.md docs/specs/2026-08-21-lark-channel-design.md docs/specs/2026-11-02-kanban-design.md docs/specs/2026-11-16-cron-design.md tests/docs-examples.test.ts
git commit -m "Document /auth, mt auth and /roles in the README, the guide and config.example.yaml, saying a tier comes from the config or a grant and that /roles shows a role's description to talk tier; amend the channel, kanban and cron specs where grants change their rules; check the examples in tests/docs-examples.test.ts"
```

---


## Done when

- `npx vitest run --project unit` gives `Tests  2644 passed (2644)`. `npx vitest run --project e2e` gives `Tests  173 passed (173)`, run twice. `npm run typecheck` and `npm run build` report no errors. All under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing, and `git diff 0284031 -- 'src/*.ts' 'src/**/*.ts' README.md config.example.yaml docs/kanban-guide.md | grep "^+" | grep -c "—"` prints `0`.
- A grant made in chat by @-mention, or at the terminal for a person seen, is counted at the next check by the gateway and by the terminal, with no restart; a revoke likewise; a failed read counts as none (`tests/auth-grants.test.ts`, `tests/people-grants.test.ts`, `tests/team-settings-grants.test.ts`, `tests/auth-gateway.e2e.ts`).
- Who may grant and revoke what is one decision, made inside the writer's transaction, and said in the same words in chat and at the terminal (`tests/grants-policy.test.ts`, `tests/grants-writer.test.ts`, `tests/auth-chat.test.ts`, `tests/mt-auth.test.ts`).
- `mt auth` is refused in every agent's shell, the marker alone included, and nothing else changes for it (`tests/session-marker.test.ts`, `tests/mt-service.test.ts`).
- `/roles` lists every role in one line each, never a cut line of `role.md`, masked (`tests/roles-chat.test.ts`, `tests/router.test.ts`).

## Before relying on it: the smoke checklist

For the user, once the plan is built and merged, on the Mac with the real Lark tenant. Run each command as the gateway's user. `<node>` is `~/.nvm/versions/node/v22.15.0/bin/node`, and `<mt>` is `<node> <checkout>/dist/mt.js`: never a bare `node`, `npm` or `mt`. Every build runs under the same Node 22.15: `PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH npm run build`. The items need a group the bot is in, you as the owner, a colleague in that group who is in neither `auth.talk` nor `auth.operate` and whose open_id you do not know, and, for item 4, `kanban.enabled: true`.

0. **Back up first.** This plan adds migration 011, which the gateway runs at its first start, and every grant is a new row. Find the file the gateway uses: `MT_DB` in the service's environment, else `db:` in the config file (`MT_CONFIG` in the service's environment, else `~/.manus-team/config.yaml`), else `~/.manus-team/team.db`; the `.env` refuses `MT_DB`, so it is never there. Stop the service, `<mt> service stop`, and back it up with SQLite's own backup, `sqlite3 <db> ".backup /tmp/team-before-grants.db"` (`/usr/bin/sqlite3` on macOS); with no `sqlite3`, copy it while the gateway is stopped, `cp <db> /tmp/team-before-grants.db`, and its `-wal` file beside it if there is one. Going back to a build before this one means restoring this backup (§8.5). Build (`cd <checkout> && PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH npm run build`), then `<mt> service start`. `<mt> service logs -n 50` shows `schema at version 11 (<db>)`, and no `auth:` line yet.
1. **`/roles`.** In the group, `@bot /roles` answers one line a role, each `**name**: … · can be given work: … · workspace … · running …`, sorted by name, the role `default` with `–` for what it is for. `@bot /roles worker` answers "Usage: `/roles`, with nothing after it."
2. **The list.** `@bot /auth list` answers `Owner: <your name> (lark:on_…), from auth.owner in config.yaml` first, then the configuration's people.
3. **A colleague let in by @-mention.** Ask the colleague to send `@bot hello`: nothing answers. Send `@bot /auth grant @<colleague> talk`, picking them from Lark's mention list: the group sees "<colleague> now has talk tier, granted by <you>. `/auth revoke lark:on_…` takes it back." Ask them to send `@bot hello` again: the agent answers, with no restart. `@bot /auth grant @<colleague> talk` again answers "… already has talk tier, by a grant from <you> on <today>".
4. **Then a task for them.** `@bot /kanban task new Smoke: a granted person's task` with a second line `assignee: @<colleague>` is created, and their card comes in the task's thread, or by direct message. `<mt> kanban people --json` gives them `"talk": true, "talk_from": "grant"`, and `<mt> auth list` shows their grant, `talk grant by lark:on_… in chat oc_…, <today> <time>`.
5. **The startup line.** `<mt> service restart`, then `<mt> service logs -n 50` shows `auth: 1 person(s) granted talk and 0 operate, beside the configuration's; mt auth list shows who`.
6. **Refused in an agent's shell.** In a direct message with the bot, ask the agent: "Run `mt auth list` in your shell and paste exactly what it prints." It prints `mt: mt auth list is an operator's command, not an agent's; this shell has MT_AGENT_SESSION set. Run it from your own shell` (with cron on, `MT_CRON_TOKEN` in its place). Ask it to run `mt kanban task list`: with cron off it runs, as before.
7. **Revoke from the terminal.** `<mt> auth revoke lark:<their union_id>` prints "<colleague> (lark:on_…) no longer has talk tier: revoked by operator:<login>"; their next `@bot hello` gets no answer, with no restart. `@bot /auth revoke @<colleague>` then answers "… has no grant to revoke."
8. **Clean up.** `<mt> kanban task archive k_…` for the smoke task. `/tmp/team-before-grants.db` is the way back to the database before the smoke test.
