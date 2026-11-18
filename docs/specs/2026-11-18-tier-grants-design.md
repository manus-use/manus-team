# Tier grants: talk and operate tier from chat and the terminal

**Date:** 2026-11-18
**Status:** draft, for review
**Scope:** plan X. `/auth grant`, `/auth revoke` and `/auth list` in chat, and `mt auth grant`,
`revoke` and `list` at the terminal: a person given talk or operate tier by a row in the database,
counted beside `auth.owner`, `auth.talk` and `auth.operate`, at once and with no restart.

This document assumes [`../architecture.md`](../architecture.md), the Lark channel spec,
[`2026-08-21-lark-channel-design.md`](2026-08-21-lark-channel-design.md), cited as "channel §n",
and the kanban spec, [`2026-11-02-kanban-design.md`](2026-11-02-kanban-design.md), cited as
"kanban §n", and the cron spec, [`2026-11-16-cron-design.md`](2026-11-16-cron-design.md), cited
as "cron §n". It amends three of their rules, each said where it is changed: channel §3.4's single
write path into the allowlist (§4.2), kanban §4.2 and §22.2's talk check of a person named by
principal (§4.3), and cron §10's "no chat session gets a token or a changed `PATH`" with cron off
(§6.3). Elsewhere, where this document and they disagree, they win and this document is a
bug. As in them, every rule that looks arbitrary states the mechanism that forces it, so that it is
not "simplified" away later.

---

## 0. The thesis

> **A grant is an allowlist entry that Lark wrote the id for.**

Today a tier comes from configuration alone: the owner, `MT_OWNER_OPEN_ID` or `auth.owner`, in both
tiers; `MT_ALLOW_TALK` or `auth.talk`; `MT_ALLOW_OPERATE` or `auth.operate` (`loadConfig`,
`src/config.ts`). Each entry is an `open_id`, which is per app (channel §3.4). The user pasted an
open_id another Lark app had given them for a colleague; it matched nobody, silently, and the fix
was an edit and a restart. A grant made in chat cannot fail that way: the person is @-mentioned,
Lark sends this bot's ids for them with the message (`InboundMessage.mentions`), and the gateway
stores what Lark sent. Nobody types an id, and the next message is judged with the grant.

Nothing else about the tiers changes. There are still two, `talk` and `operate`; operate still
needs talk (`canOperate`); configuration is still the base, which no command removes; and every
check still goes through the one `Authorizer`.

---

## 1. Boundaries

**In:** the `tier_grants` table and its writer (§3); grants counted by the `Authorizer` at each
check, and by the terminal's talk check (§4); who may grant and revoke what (§5); `/auth` in chat
and `mt auth` at the terminal (§6); masking and the log (§7); the lists, the startup line and the
changes to `mt kanban people` (§8).

**Out, each with the seam that keeps it cheap later:**

| Deferred | Seam |
|---|---|
| A grant limited to some chats | A grant is gateway-wide, as a config entry is. `tier_grants` would gain a chat column, and the reader a chat argument |
| A grant that expires | `revoked_at` is already the end of a grant; an `expires_at` read beside it, or a sweep that revokes, is the change |
| Revoking the grants a revoked operator made, together | Each grant records `granted_by`; `mt auth list --json` gives it, so they can be found and revoked one by one |
| Granting a bot | `allowBots` stays configuration's. A bot's mention comes with no union_id, so `/auth grant` refuses it (§6.1) |
| A history command | The table keeps every grant and its revocation (§3.1); `sqlite3` reads it. A `mt auth history` is one read |
| An announcement for a terminal's grant | A terminal's grant is made in no chat, and posts nothing (§6.2). A `--chat` as `mt kanban task new` takes (kanban §22.1) would queue one |
| Editing `config.yaml` from chat | Never: configuration is the base no grant can lower (§2.3) |

---

## 2. Who has a tier

### 2.1 Three sources, one rule

A person's tier is computed from three sources, every time it is asked for:

1. **The owner**, `auth.owner`: in both lists always, as today.
2. **The configuration's lists**, `auth.talk` and `auth.operate` (or their `MT_ALLOW_*`
   overrides), with the owner put in both, as `loadConfig` builds `allowTalk` and `allowOperate`.
3. **The person's active grant**, if any: one row of `tier_grants` with no `revoked_at`, of tier
   `talk` or `operate` (§3.1). A person has at most one active grant.

Then, as one pure function, `tiersOf(lists, openId: string | null, grant)` in `src/policy/auth.ts`,
an open_id of null matching no list (a person `people` does not hold, §4.3):

- **talk** = the open_id is in `allowTalk`, **or** there is a grant (of either tier);
- **operate** = talk, **and** (the open_id is in `allowOperate`, **or** the grant is `operate`).

*Why a grant of operate gives talk too:* `canOperate` requires `canTalk`, so that an operate entry
that is not also a talk entry cannot `/clear` a session it cannot read (`auth.ts`). A grant of
operate that left talk to the configuration would be dead in exactly the case it is wanted for, a
person in no list. *Why one function:* the gateway's `Authorizer` and the terminal (§4.3) both call
it, so the two cannot come to disagree about who has a tier, which is how a boundary gets silently
reopened (channel §3.4).

*Why the configuration's operate is still checked against talk:* `auth.operate` is not required to
be inside `auth.talk` (`loadConfig` does not check it), so a person in `auth.operate` alone has no
tier today. A grant of talk to that person makes them an operator. §5.2 makes such a grant the
owner's, for that reason.

### 2.2 Keys and matching

- **A grant is keyed by `(app_id, union_id)`**, the bot and the person. union_id is the canonical
  human key (channel §3.4) and the board's (`lark:<union_id>`, kanban §3.1); an open_id is a per-bot
  handle. `app_id` is this bot's, `lark.appId`, as the `people` table's is.
- **A check matches a grant by union_id.** Every principal a check is asked about comes from Lark
  with its ids: a message's sender (`sender_id.union_id`), a card's presser (`operator.union_id`),
  a mention (`mentions[].id.union_id`), all in `src/channel/lark/inbound.ts`. The `Principal` the
  `Authorizer` is given carries `unionId`, so the grant is found by it, with no lookup.
- **A principal with no union_id has no grant.** Lark leaves union_id out when the app lacks the
  permission to read user ids; then the configuration's open_ids still decide, as today, and
  nothing is granted, since `/auth grant` refuses a mention without one (§6.1) and the terminal
  grants only a person `people` holds, who was noted with both ids (`PeopleDirectory.saw`). *Why no
  fallback through the open_id:* there would be no grant for it to find.
- **A person named by principal alone**, `lark:<union_id>` (the board's assignees and reviewers, the
  card poster's check, the terminal), is matched to a grant by that union_id directly, and to the
  configuration's lists by **the open_id `people` holds for them with this app id**, as today
  (kanban §4.2). A person `people` does not hold is in no list, and may still have a grant: the
  grant is checked by union_id whether or not `people` has a row, as it needs no open_id to be
  found.
- **When a person's open_id changes.** Within one app Lark gives one open_id per person, so it does
  not change for this bot; `notePerson` replaces it if Lark ever sends another. A grant, keyed by
  union_id, is unaffected; the configuration's lists, which hold open_ids, follow whatever the
  operator typed. The grant's own `open_id` column is a record of whom it was made for, as Lark
  gave them then, and is never matched on.
- **When the gateway's app id changes**, a different bot, every person has another open_id, the
  configuration's lists must be redone, and the grants of the old app id count for nothing: they
  are not deleted, and the startup line says how many there are (§8.4). *Why not carry them over:*
  a union_id is shared only by the apps of one developer, so whether the old bot's people are the
  new one's is not something the gateway can know; a grant that silently applied to another bot's
  people would fail open.

### 2.3 The configuration stays the base

- **No command removes a configuration entry.** `/auth revoke` and `mt auth revoke` end grants only,
  and say so when the person's tier is the configuration's (§5.2). The owner is in configuration
  alone, has no grant, and can never be revoked.
- *Why:* nobody can lock the owner out, which is the reason `config.example.yaml` gives for "not
  editable from chat". A grant can add to a tier and never take away from the configuration's, so
  the worst a mistaken or hostile grant can do is be revoked by the owner, who always can.
- **A restart changes nothing.** Grants are in the database, read at each check (§4.1), and
  survive restarts and `mt update`, as the board does.

---

## 3. Schema (migration `011_tier_grants.sql`)

### 3.1 `tier_grants`

```sql
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

- **Never deleted, never re-opened.** A revocation writes the four `revoked_*` columns and `ended`
  once, on an active row; a grant made again is a new row. So the table is the audit trail: who
  granted whom what, when, from where, and who ended it. *Why no separate events table:* each row
  is already one grant and its one end, and a second record of the same fact is a second thing to
  keep in step (WRITERS.md, "one transaction per fact").
- **`ended`** is `revoked` for a revocation, and `replaced` for a talk grant ended by an operate
  grant to the same person, in the same transaction that inserts it (§5.2): one active row a
  person, so the unique index holds the rule "at most one active grant". A row ended `replaced`
  takes its `revoked_at`, `revoked_by`, `revoked_via` and `revoked_chat` from the operate grant's
  `granted_*`, the same timestamp included, so the two rows say one change.
- **No name is stored.** A grant shows the name `people` last holds for its union_id (§7), so a
  renamed person shows their new name, and the table holds no free text to mask.
- **No foreign key to `people`.** `people` is keyed by `(app_id, union_id)` too, but a grant must
  outlive anything that might one day prune `people`, and the reads join where they need a name.

### 3.2 The writer, `db/grants.ts`

The only writer of `tier_grants` (WRITERS.md gains its row). Writes, each in one `txImmediate`:

- **`grantTier(db, { appId, unionId, openId, tier, by, via, chat }, decide, now)`** reads, inside
  the transaction, the target's active grant and the actor's, calls `decide` (§5.1) with them, and
  then inserts, or ends a talk grant `replaced` and inserts the operate one, or writes nothing for
  a no-op or a refusal. It returns `decide`'s answer and the rows written.
- **`revokeGrant(db, { appId, unionId, by, via, chat }, decide, now)`** reads the same two grants,
  calls `decide`, and ends the target's active grant `revoked`.

*Why `decide` runs inside the transaction:* the actor's own tier can come from a grant, which the
owner may be revoking at the same moment; the reads that decide a write are re-read under the lock
and compared, as WRITERS.md requires of any decision that must not be made on a stale read.

Reads, outside transactions: **`activeGrant(db, appId, unionId)`**, by the unique index;
**`activeGrants(db, appId)`**, for the lists, joined to `people` for names; **`grantCounts(db,
appId)`**, active grants by tier for this app and the count of active grants under other app ids,
for the startup line.

`db/people.ts` stays the only writer of `people`. Its WRITERS.md row gains that a person is also
noted when they send an `/auth` command or are mentioned in one (§6.1).

---

## 4. The Authorizer

### 4.1 Grants read at each check

`Authorizer` takes a second, optional dependency beside its `AuthConfig`:

```ts
export interface GrantReader {
  /** This bot's active grant for the person with this union_id: its tier, or undefined. */
  tierOf(unionId: string): Tier | undefined;
}
```

`src/index.ts` builds it over the gateway's database and `config.lark.appId`, with
`activeGrant`'s statement prepared once. `canTalk(principal)` and `canOperate(principal)` call
`tiersOf` (§2.1) with the configuration's lists, `principal.openId`, and `principal.unionId === null
? undefined : grants.tierOf(principal.unionId)`. Everything else in `Authorizer` (`admits`'s
order, `admitsTier`'s messages, the silent reasons) is unchanged.

- **A query per check, no cache.** A check is one indexed read of a small table on the gateway's
  own connection, against a Lark round trip per message; a message makes a few checks
  (`admits`, then a command's tier, or the turn's tier for cron). *Why no cache:* a grant made at the
  terminal is written by another process, which a cache would need told; the database is already
  where both processes meet, so the next check sees it, with **no nudge to the gateway** and
  nothing to invalidate.
- **A read that fails is no grant.** A thrown read (a corrupt page, a database closed at stop) is
  caught, logged at most once a minute, and counts as no grant: closed, as an empty list is. The
  configuration's tiers, the owner's included, still hold, so the owner is never locked out by it.
- **Without a reader** (the tests, and any caller that gives none), there are no grants, which is
  today's behaviour exactly.

### 4.2 The `reconfigure` question

`reconfigure(config)` stays as it is: it replaces the configuration part, and only the
configuration part, and nothing in the gateway calls it (only `tests/router.test.ts` does). Grants
never pass through it, and it never touches them. Its comment changes from "Allowlist edits do not
come from chat, so there is no command that reaches this" to say that the configuration is not
edited from chat; grants are a second source, read through `GrantReader` and written only by
`db/grants.ts`, whose rules (§5) are what keep a person who got in from keeping themselves in.

*Why not put grants into `AuthConfig` and call `reconfigure` on each change:* a terminal's grant is
made in another process, so the gateway would need a nudge or a poll to call it, and a chat grant
and a terminal grant would reach the lists by two paths. Reading the table at each check is one
path for both. Channel §3.4's rule, "every write path into the allowlist goes through one
function", is amended to: the configuration's lists are written by `loadConfig` alone, and the
grants by `db/grants.ts` alone, each a single path.

`mergeResolved`, unused, is left alone.

### 4.3 Where a grant takes effect

At once, everywhere a tier is checked, because each of these asks the `Authorizer` or `tiersOf`:

- **A chat message**: `admits` (`canTalk`) and a command's tier (`admitsTier`) in `Router`.
- **A card press**: an approval's `admitsTier(…, 'operate')` in `Router`; a board card's
  `hasTier(presser, 'talk' | 'operate')` in `KanbanChat`.
- **`/kanban` and `/cron`**: `KanbanChat`'s and `CronChat`'s `hasTier`.
- **Cron's per-turn tier**: `Router.#submit` passes `hasTier(sender, 'operate')` to
  `CronTokens.turnSubmitted` for each turn as it is submitted (cron spec §7.1).
- **A person named by principal, in the gateway**: `PeopleDirectory.canTalk` (assignees and
  reviewers, kanban §4.2) and the card poster's check at each send (`CardPoster`, `canTalk`).
  `PeopleDeps.canTalk(openId)` becomes `canTalk(person: { openId: string | null; unionId: string
  })`. The gateway's callback calls `tiersOf` (§2.1) directly, with the configuration's lists and
  the `GrantReader`'s `tierOf(person.unionId)`, the same two the `Authorizer` holds, rather than
  `Authorizer.canTalk` with a principal made up for it, so a grant is found by its union_id. `PeopleDirectory.canTalk(principal)` calls it whether or not `people` has a row for the
  union_id, with `openId` null when it has none: the grant is found by the union_id, and the
  configuration's lists, which hold open_ids, then match nothing. *Why change the signature:*
  today's callback passes `unionId: null`, which would hide every grant from the board, and today's
  method returns false for a person `people` does not hold before asking.
- **The terminal's talk check** (plan V, kanban §22.2): `openBoard` (`src/cli/gate.ts`) builds its
  `PeopleDirectory` with `canTalk(person)` = `tiersOf` over `TeamSettings`'s lists and
  `activeGrant(db, appId, person.unionId)`, on the database it opened. A database with no
  `tier_grants` table, not yet migrated to 011, has no grants for this reader: `mt kanban` and its
  talk column work as today, and only `mt auth` refuses such a database (§6.2). `TeamSettings` gains
  `operate` (the owner and `MT_ALLOW_OPERATE` or `auth.operate`, present with an owner, as `talk`
  is) and `owner`, read with `loadConfig`'s precedence, so `mt auth list` can say who operates.

Kanban §4.2 and §22.2 are amended: a person named by principal has talk tier when the open_id
`people` holds for them is in the talk list, **or** their union_id has an active grant.

---

## 5. Who may grant and revoke

### 5.1 The table, and one function

| | grant talk | grant operate | revoke a talk grant | revoke an operate grant | list |
|---|---|---|---|---|---|
| The owner, in chat | yes | yes | yes | yes | yes |
| An operator, in chat | yes, but §5.2's case | no | yes, but §5.2's case | no | yes |
| Talk tier, in chat | no | no | no | no | yes |
| The terminal (`mt auth`) | yes | yes | yes | yes | yes |
| An agent | no | no | no | no | no |

- **The owner** is the sender whose open_id is `ownerOpenId` (`Authorizer.isOwner`, new). The
  owner grants and revokes anything a grant can hold.
- **An operator**, at operate tier by configuration or by grant, grants and revokes talk only. *Why:*
  an operator who could grant operate could make more operators, and an operator the owner revoked
  could have had a friend re-grant them; with operate the owner's, every operator is one the owner
  or the configuration made.
- **The terminal** is the operator's, as `mt kanban` is (kanban §2.6): it runs as the gateway's user
  beside its files, where it could edit `config.yaml` and restart, so it may do what the owner may.
  It still cannot remove a configuration entry or the owner (§2.3), as nothing can.
- **An agent may do nothing.** `/auth` is typed by a person; an agent's shell refuses `mt auth`
  (§6.3).

The decision is one pure function, `decideGrant` and `decideRevoke` in `src/policy/grants.ts`, given
the actor (`owner`, `operator` or `terminal`), the target's sources (owner, in `allowTalk`, in
`allowOperate`, their active grant), the tier asked for, and answering `grant`, `replace`,
`revoke`, a no-op with its reason, or a refusal with its reason. Chat and the terminal both call it,
through the writer (§3.2), so they cannot judge a case differently.

**The sources fed to it.** The `Authorizer` exposes `sourcesOf(openId)`, which says whether an
open_id is the owner and whether it is in `allowTalk` and `allowOperate`, and `isOwner(principal)`;
`AuthChat` gives `decide` the actor's and the target's from these, and their grants from the
writer's reads. The terminal builds the same `sourcesOf` from `TeamSettings`' `owner`, `talk` and
`operate` (§4.3), with the same function behind both. *Its consequence:* the terminal judges by its
own read of the configuration, the file and the environment as this shell sees them, which may
differ from the running gateway's until the gateway restarts, as the terminal's talk check already
may (kanban §22.2). An edit to `config.yaml` that the gateway has not yet loaded is thus judged by
the terminal as if loaded.

**Where each list came from.** `loadConfig` records, beside `allowTalk`, `allowOperate` and
`ownerOpenId`, the name each came from, as it records `maxRunningFrom`: `auth.talk` or
`MT_ALLOW_TALK`, `auth.operate` or `MT_ALLOW_OPERATE`, `auth.owner` or `MT_OWNER_OPEN_ID`;
`teamSettingsFrom` records the same for the terminal. Every reply that names a list names the one
in effect: "from auth.talk in config.yaml" for the file, "from MT_ALLOW_TALK" for the environment.
Below, `<talk source>` stands for these words, and `<operate source>` and `<owner source>` for the
other two lists' alike. *Why:* with an override set, "config.yaml" points the
operator at a file whose list is not the one in use.

### 5.2 The cases a grant meets

In this order, the first that applies deciding:

- **Granting the owner, or revoking them**: a no-op for a grant, "is the owner, who has both tiers
  always", and a refusal for a revoke, "is the owner, set in <owner source>, and cannot be
  revoked". An owner with a grant left over from before they were the owner (the owner changed in
  configuration, §9) is the one revoke that goes ahead: the grant ends, and the reply says "the
  grant is revoked; they keep both tiers as the owner".
- **Granting a tier the person already has**: a no-op, said so, with where it comes from: "already
  has talk tier, <talk source>", or "…, by a grant from Alice on 2026-11-18". Talk to
  an operator is a no-op too, since operate includes talk (§2.1); the reply says that to leave them
  talk alone, the owner revokes and grants talk again. *Why no downgrade by `grant talk`:* the same
  words would mean "make sure they have talk" from an operator and "take operate away" from the
  owner, and a command that means two things by who types it is a surprise for one of them.
- **Granting operate to a person with a talk grant**: the owner's or the terminal's, and it
  replaces the talk grant (§3.1), saying "now has operate tier, in place of talk".
- **An operator granting talk to a person in `auth.operate` but not in talk**: refused, "is in
  auth.operate, so talk tier would make them an operator, which is the owner's to grant". The owner
  and the terminal may.
- **An operator granting operate, or revoking an operate grant**: refused, "only the owner grants
  operate tier: an operator cannot make another operator", and "has operate tier by a grant, which
  only the owner revokes".
- **An operator revoking another operator's talk grant**: allowed. A person who is an operator by
  configuration (`auth.operate`) and has talk by a grant is the one exception: revoking that grant
  ends their operate tier too, so it is the owner's, refused for an operator with "is in
  auth.operate: their talk grant is what makes them an operator, so only the owner revokes it".
  *Why allowed otherwise:* talk is the operators' to manage; an operator by grant holds an operate
  grant, not a talk one, so this case does not reach them.
- **Revoking a person whose tier is the configuration's alone**: refused, "has talk tier <talk
  source>, which chat cannot change: the operator edits it and restarts the gateway". At the
  terminal the same words, "which mt auth cannot change".
- **Revoking a person with a grant and a configuration entry**: the grant ends; the reply says what
  is left, "keeps talk tier <talk source>".
- **Revoking a person with neither**: a no-op, "has no grant to revoke".
- **Granting or revoking yourself**: no rule of its own; the cases above settle it. An operator's
  `grant @me talk` is a no-op (they have it); an operator by grant cannot revoke their own operate
  grant (the owner's); an operator by configuration with talk by grant cannot revoke it (the
  exception above); the owner is the owner. So nobody can raise their own tier, and the only way
  down is the owner's or the terminal's.

**The interplay of operate and talk is settled by one grant a person** (§3.1): a revoke ends the
whole grant, and with it operate and talk together, as far as they came from it. *Why not revoke
talk alone from an operate grant:* operate without talk is no tier (§2.1), so it would be a revoke
of both, said as one; and a refusal would leave the owner no one-step way to remove an operator.

**A grant is gateway-wide.** Made in one chat, it holds in every chat the gateway acts in, as a
configuration entry does; `auth.chats` still limits which.

### 5.3 What a revoke does to open work

As today when a person loses talk tier, which until now took an edit and a restart:

- **Their next message** is refused by `admits`, silently (`sender_not_allowed`), and their card
  presses are refused, "You are not on the allowlist." (`KanbanChat`).
- **A turn already admitted** runs to its end, with its queued turns: a message is authorized once,
  at admission, and the actor's mailbox is not re-judged. A cron token's per-turn tier is the one
  recorded at its submission (cron spec §7.1).
- **Their tasks stay assigned** to them; the card poster refuses the next card, `card_failed`, "no
  longer has talk tier on this gateway" (`CardPoster`), which the task's subscribers hear, and an
  operator reassigns.
- **Approvals** need operate at the press, so a revoked operator's press is refused from then on.

---

## 6. Commands

### 6.1 `/auth` in chat

```
/auth list
/auth grant @Name talk
/auth grant @Name operate
/auth revoke @Name
/auth revoke lark:<union_id>
/auth help
```

- **Registered in `COMMANDS`** (`src/core/commands.ts`) as `auth`, tier `talk`, `needsSession:
  false`, `effect: 'immediate'`, `multiline: false`, `mutating: false`: talk because listing is,
  each subcommand that changes a grant checking its own tier (§5.1), as `/kanban` and `/cron` do;
  never refused for a busy session, as it never touches one. `/help` lists it. A sender without
  talk tier is refused by `admits` before any command, silently, as now.
- **Always on.** Not behind `kanban.enabled` or `cron.enabled`: the tiers are the gateway's, and a
  gateway with neither still has people to let in. So `src/index.ts` builds its `PeopleDirectory`
  whatever `kanban.enabled` says, and `Router` gets an `auth` dependency, `AuthChat`
  (`src/policy/auth-chat.ts`), as it gets `kanban` and `cron`.
- **Parsing.** After `grant`, the last word is the tier, `talk` or `operate` in any case, and
  everything between is the person; after `revoke`, everything is the person. A person is an
  @-mention or, for `revoke` only, `lark:<union_id>`. *Why the tier last:* a mention's name may
  have spaces (`@Alice Smith`), and with the tier last no name needs splitting.
- **The mention is resolved as `/kanban` resolves one**: the `@` half of `KanbanChat.#mentioned`
  moves to a shared function, `mentionedPerson(name, message)` in `src/channel/mentions.ts`, which
  takes `@` names only, with its three refusals and their words: not someone this message mentions
  ("type @ and pick them, so Lark says who they are"), no union_id with the mention ("ask the
  operator to check the app can read user ids"), and more than one person mentioned by that name.
  It also returns the mention's open_id, which the grant records. The `lark:` branch stays with
  each caller: `KanbanChat` keeps its own for a typed principal, and `AuthChat` takes one for
  `revoke` only, so no path reaches a grant with a typed id. *Why move it:* `/auth` works with the
  board off, and two copies of the same resolution would drift.
- **A bot is not a person.** `admits`' `bot_sender` check comes first, as now, so a bot cannot type
  `/auth` at all. A mention of a bot is refused by `mentionedPerson`, "is a bot, and a bot's tier is
  configuration's", by the mention's `mentioned_type`, which the adapter's `mentionsOf` reads into
  `InboundMention.isBot`; a mention without the field is judged as today, and a bot's comes with no
  union_id anyway. `/kanban`'s callers get the refusal too, which is right for them: a bot cannot be
  given work.
- **In a direct message**, a person can be @-mentioned only where Lark lets them be, so a grant
  whose name is not among the message's mentions is refused there with the mention's words and
  "in a direct message, grant in a group they are in, or with mt auth grant".
- **`lark:<union_id>` for a revoke only.** A person to revoke may have left the chat, and can no
  longer be mentioned; `/auth list` shows the principal to type. A grant takes a mention only, so
  that a chat grant is always made with the ids Lark sent: that is the point of this design (§0).
- **Noted.** The sender and each mention are noted in `people` (`PeopleDirectory.saw`) before the
  command runs, as `/kanban` notes them, so the person granted can be named by principal at once,
  on the board and at the terminal, and has a name in the lists.
- **The granter is `lark:<union_id>`.** A sender Lark gave no union_id is refused for `grant` and
  `revoke`, in the mention's words for that case: the grant must record who made it, and the same
  missing permission would refuse the mention anyway.
- **The announcement is the reply.** Each grant or revoke is answered with one line in the chat,
  or thread, where it was typed, the reply every command gets, so everyone there sees it:
  - "Carol now has talk tier, granted by Alice. `/auth revoke @Carol` takes it back."
  - "Carol now has operate tier, in place of talk, granted by Alice."
  - "Carol no longer has talk tier: revoked by Bob." or "…: revoked by Bob; they keep talk tier
    <talk source>."
  - For a person whose operate grant is revoked, who may have granted talk while an operator, the
    count of the talk grants they made that are still active is added: "They made 2 talk grants
    still in force; /auth list shows them." *Why say it:* those grants stay (§9), and the owner
    revoking an operator is the moment they are wanted.

  No-ops and refusals are one line too (§5.2). The person is named by the name Lark's mention
  showed, the granter by the name Lark gave for the sender, falling back to their principal. *Why
  no @-mention in the reply:* replies are escaped, so a mention tag would be the gateway's first
  notifying markup, and the person was just @-mentioned by the command.
- **The reply is masked** with the rest (§7), as `/kanban`'s is.

### 6.2 `mt auth` at the terminal

```
mt auth grant lark:<union_id> talk|operate [--json]
mt auth revoke lark:<union_id> [--json]
mt auth list [--json]
```

- **A group of its own**, as `mt service` and `mt cron` are, loading its settings through
  `withGatewayFile`, so a value only in the gateway's `.env` is seen, and opening the database the
  settings name. It needs the app id (`lark.appId` or `LARK_APP_ID`), refused without one, "there
  is no bot to grant for: this shell finds no lark.appId or LARK_APP_ID", and `tier_grants`,
  refused without it, "the database at … has no tier grants yet: start the gateway once, so it is
  migrated". Only `mt auth` refuses an unmigrated database; the other commands read it as having
  no grants (§4.3).
- **The person is `lark:<union_id>`, and must be in `people`** for this app id. Refused otherwise:
  "lark:on_… is not someone this bot has seen: mt kanban people lists those it has, or grant them in
  chat with /auth grant @Name talk, which needs no id". An `ou_…` is refused with "ou_… is an
  open_id, which is per app: a person is lark:<union_id>, which mt auth list and mt kanban people
  give"; a name starting with `@` with kanban §22.2's words. *Why seen only:* a union_id typed or
  pasted is the failure this design exists to end (§0); one Lark has given this bot is known to be
  this bot's person. The grant's `open_id` is the one `people` holds.
- **As the terminal** (§5.1), recorded `operator:<login>`, `granted_via` `terminal`, no chat. The
  same decisions as chat, through the same writer, in the same words, on stderr for a refusal.
- **Exit codes** as the other operator commands: 0 done, a no-op included, its line on stdout; 1
  refused; 2 the command line was wrong.
- **`--json`** on `grant` and `revoke`, as on the other operator commands, so a script reads the
  outcome rather than words: `{"ok": true, "outcome": "granted" | "replaced" | "revoked" |
  "already" | "no_grant", "tier": "talk" | "operate" | null, "principal": "lark:<union_id>"}`, the
  tier being the one the person has afterwards; a refusal `{"ok": false, "code", "message"}`, its
  code one of `no_bot`, `no_owner`, `not_migrated`, `unknown_person`, `open_id`, `invalid`,
  `is_owner`, `from_config` and `operator_command` (in an agent's shell, §6.3).
- **No announcement.** A terminal's grant is made in no chat (§1). The running gateway sees it at
  its next check (§4.1), with no nudge.
- **The owner and the lists** come from `TeamSettings` (§4.3). With no owner set, `grant` and
  `revoke` are refused, "this shell finds no auth.owner or MT_OWNER_OPEN_ID, so it cannot tell
  what the configuration gives", as a gateway with none does not start.

### 6.3 Agents

`mt auth` is refused in every agent's shell, whether or not cron is on, before its arguments are
read; `--json` among its words gives the refusal as JSON, as `mt kanban`'s operator groups do. An
agent has no other way in: `/auth` is a chat command, and an agent's messages are not inbound
messages.

- **The session marker.** Today a chat session's agent has no marked shell with cron off (cron
  §15), so `inAgentRun` alone would let it run `mt auth`. The gateway therefore puts
  `MT_AGENT_SESSION=<session id>` into every agent session's environment, a chat session's, a board
  run's and a fire's alike, cron on or off: the registry's `envFor` in `src/index.ts` adds it to
  what the dispatcher, the scheduler or the cron tokens give, and gives it alone when none of them
  gives anything.
- **`mt auth` is refused when `inAgentRun(env)` or `MT_AGENT_SESSION` is set**, with
  `runShellRefusal`'s words, naming `MT_AGENT_SESSION` when it is the only one set.
- **Not in `AGENT_VARIABLES`.** Every other operator command keeps today's behaviour: with cron
  off, a chat agent's shell can still run `mt kanban task`, `mt service` and the rest, and the
  role and workflow checks still read the gateway's `.env` there. *Why:* the user chose to guard
  only `mt auth`; adding the marker to `AGENT_VARIABLES` would change every command's behaviour in
  every chat session, which cron §15 lists as a cost of turning cron on, for every gateway.
- **Dropped where the others are.** `gateEnv` (`src/kanban/gates.ts`) and `mt update`'s child
  environment (`src/cli/update.ts`) drop `MT_AGENT_SESSION` as they drop `MT_KANBAN_*` and
  `MT_CRON_*`, so a cron script and a gate, the operator's commands, stay operator shells, and
  their `mt auth` works.
- **Cron §10 amended.** Its rule that with cron off "no chat session gets a token or a changed
  `PATH`" becomes: no chat session gets a token or a `PATH` change; the session marker is always
  set.

This guards against mistakes and injection, not against a determined agent (§12).

---

## 7. Masking and the log

- **Names are shown masked**: through `label` in chat (masked, one line, cut to 80, escaped) and
  `line` at the terminal, as `mt kanban people` shows them. A name is Lark's, and could be anything
  a user set.
- **Nothing in `tier_grants` is free text**: ids, a tier, a login, times. So nothing is masked on
  write. The login is the operator's own, as `created_by` is (kanban §10.1).
- **The whole reply is masked once more**, `redactKnownSecrets`, as the router does for `/kanban`
  and `/cron`.
- **The log** gets one line a change, ids only, never a name: `auth: talk granted to lark:on_c by
  lark:on_a in chat oc_x`, `auth: operate granted to … (replacing talk)`, `auth: talk grant of
  lark:on_c revoked by lark:on_b in chat oc_x`. A terminal's change is not in the gateway's log,
  which it never reaches; the table has it.

---

## 8. Lists and lines

### 8.1 `/auth list`

At talk tier: everyone with a tier, the owner first, then operators, then talk, each sorted by
name, one line each, at most 50 lines and then "and N more: mt auth list at the terminal lists
everyone":

```
Owner: Alice (lark:on_a), from config.yaml
Bob (lark:on_b): operate, from config.yaml
Dan (lark:on_d): operate, granted by Alice on 2026-11-18; talk also from config.yaml
Carol (lark:on_c): talk, granted by Bob on 2026-11-18
ou_e…: talk, from config.yaml; not seen by this bot yet
```

A configuration entry is named by the person `people` holds with that open_id, or by the open_id
when there is none. A person in `auth.operate` with no talk is listed last, "in auth.operate
without talk tier, so no tier", the case §5.2 guards. The date is the gateway's zone's
(`cron.tz`, else the process's), as cron's are. *Talk tier may list, and sees every chat's grants:*
grants are gateway-wide (§5.2), so the list is the gateway's, and a chat's members see grants made
in other chats, with the granter's name and the date, though not the chat. This is accepted: who
can drive the agent, and so read what is said to it, is something a person at talk tier is
entitled to know, and the list names no chat and quotes nothing said in one.

### 8.2 `mt auth list`

The same people, as `mt kanban people` lays out a line: the name, the principal (or the open_id
for an unseen configuration entry), the tier, and the sources, "owner", "auth.talk", "auth.operate",
"grant by lark:on_a in chat oc_x, 2026-11-18 10:02" or "grant by operator:x at the terminal, …". No
limit on lines. `--json`:

```json
{"ok": true, "people": [
  {"principal": "lark:on_c", "union_id": "on_c", "open_id": "ou_c", "name": "Carol",
   "tier": "talk", "owner": false, "config": {"talk": false, "operate": false},
   "grant": {"tier": "talk", "by": "lark:on_b", "via": "chat", "chat_id": "oc_x", "at": 1795000000000}}
]}
```

`principal`, `union_id` and `name` null for a configuration entry `people` does not hold; `tier`
`"talk"`, `"operate"` or null; `grant` null with none; `at` in milliseconds, as `task list --json`
gives times (kanban §22.3). Active grants only: the history is the table's (§1).

### 8.3 `mt kanban people`

Its talk column counts grants: `talk` when `tiersOf` says so, by the configuration's lists or a
grant (§4.3). `--json` gains, beside `talk`, `"talk_from"`: `"config"`, `"grant"` or null, the
configuration winning when both give it. *Why it changes:* the column answers "can I give this
person work?", and a person with a grant can be given it.

### 8.4 The startup line

After the schema line, when there are any grants for this app:

- `auth: 3 person(s) granted talk and 1 operate, beside the configuration's; mt auth list shows who`

and, when there are active grants under another app id, whatever this app's are:

- `auth: 2 grant(s) are for another app id than lark.appId, and count for nothing here`, as §2.2 says

and nothing when there are none. The two counts are of active grants by tier, so a person is
counted once.

### 8.5 `mt service check`, `mt update`, the backup

- **`mt service check`** needs no change: it checks the configuration the gateway would start with,
  and grants cannot stop a start. Its database line already says the version, 11 once migrated.
- **`mt update`** takes the backup for migration 011, as for any new one (kanban §20.8).
- **Going back to a build before 011** cannot keep the database: an older build refuses a database
  above its highest migration (`migrate`, `src/db/open.ts`, kanban §20.6), so going back means
  restoring the backup taken before 011. That drops every grant, and everything else written
  since; it fails closed, as the configuration's tiers, the owner's included, still hold. Grants
  made since must be made again after going forward.

---

## 9. The cases

- **A grant in a group, and the person's next message**: admitted, with no restart; their messages
  before the grant were refused and are not replayed.
- **A grant at the terminal while the gateway runs**: the gateway's next check reads it (§4.1).
- **Two grants of the same person at once**, in chat and at the terminal: the writer's transaction
  and the unique index make one; the other reads it and is a no-op, said so.
- **The owner revoking an operator while that operator grants talk**: whichever transaction is
  second re-reads the operator's grant (§3.2): a grant after the revoke is refused.
- **An operator by grant, revoked**: the talk grants they made stay; the revoke's reply counts them
  (§6.1), and `mt auth list --json` gives each one's `by`.
- **A mention of a bot, or of `@all`**: `@all` is not a mention (`InboundMessage.mentions` leaves it
  out); a bot comes with no union_id and is refused (§6.1).
- **Two people mentioned with the same name**: refused, "say which with lark:<union_id>", which a
  revoke takes; a grant cannot, so the operator mentions one person a command.
- **A person mentioned who has never written to the bot**: granted; Lark gave their ids with the
  mention. They are noted in `people` then.
- **A configuration entry also granted**: both count; revoking the grant leaves the entry (§5.2),
  and removing the entry from `config.yaml` and restarting leaves the grant.
- **The owner changed in configuration**: the new owner is the owner; grants made by the old one
  stay, recorded with their principal.
- **A revoked person's open turns, tasks and cards**: §5.3.
- **The gateway's app id changed**: the old grants count for nothing, and the startup line says
  how many (§8.4).
- **`/auth` in a chat outside `auth.chats`**: refused by `admits`, as every message there is.
- **`/auth` in a direct message**: works; but a person can be @-mentioned only where Lark lets them
  be, so a grant is usually made in a group they are in, and a revoke can take `lark:<union_id>`.

---

## 10. Wiring

- **`schema/011_tier_grants.sql`** (§3.1) and **`src/db/grants.ts`**, the writer and its reads
  (§3.2); **`src/db/WRITERS.md`** gains the `tier_grants` row and amends `people`'s (§3.2).
- **`src/policy/auth.ts`**: `tiersOf` (§2.1); `GrantReader`; the `Authorizer`'s optional reader
  and `isOwner`; `reconfigure`'s comment (§4.2).
- **`src/policy/grants.ts`**, pure: `decideGrant` and `decideRevoke` (§5), and the reply words
  for each outcome, which chat and the terminal both give.
- **`src/policy/auth-chat.ts`**, `AuthChat`: `/auth`'s parse, its notes in `people`, its calls to the
  writer and its replies (§6.1); `/auth list` (§8.1).
- **`src/channel/mentions.ts`**: `mentionedPerson`, moved from `KanbanChat.#mentioned`, which calls
  it (§6.1).
- **`src/core/commands.ts`** gains `auth`; **`src/core/router.ts`** its `case 'auth'`, through an
  `auth` dependency, with the reply masked; **`src/core/router.ts`'s** deps comment on tiers.
- **`src/kanban/people.ts`**: `PeopleDeps.canTalk` takes `{ openId: string | null, unionId }`,
  and `canTalk(principal)` asks it with or without a `people` row (§4.3).
- **`src/index.ts`**: the `GrantReader` over the database; the `PeopleDirectory` built whatever
  `kanban.enabled` says; `AuthChat`; the startup lines (§8.4); `MT_AGENT_SESSION` in the
  registry's `envFor` (§6.3).
- **`src/config.ts`**: `TeamSettings.owner` and `TeamSettings.operate` (§4.3); where each list came
  from, in `loadConfig` and `teamSettingsFrom` (§5.1).
- **`src/policy/auth.ts`** also: `sourcesOf(openId)` (§5.1).
- **`src/channel/lark/inbound.ts`**: `mentionsOf` reading `mentioned_type` into
  `InboundMention.isBot` (§6.1).
- **`src/kanban/gates.ts`** and **`src/cli/update.ts`**: `MT_AGENT_SESSION` dropped from a gate's,
  a script's and `mt update`'s children's environments (§6.3).
- **`src/cli/auth.ts`**: `mt auth`, `--json` on all three (§6.2, §8.2); **`src/cli/mt.ts`**: the
  group, its usage lines, and its refusal by `inAgentRun` or `MT_AGENT_SESSION` (§6.3); **`src/cli/gate.ts`**: `openBoard`'s
  `canTalk(person)` and `seen()`'s `talk`, through `tiersOf` and `activeGrant`, and `talk_from`
  (§8.3).
- **Docs, as built:** `config.example.yaml`'s comment on `auth.owner`, which says the lists are
  "not editable from chat", becomes: the lists are not editable from chat, and `/auth grant` adds
  people beside them, never removing an entry or the owner; the README's `auth.talk` and
  `auth.operate` rows, and its "Empty means closed" rule, name grants; the kanban guide's "Who may
  do what" (`docs/kanban-guide.md`) and its §22.2 lines say a tier comes from the configuration or
  a grant, and `mt kanban people`'s talk column counts grants; a section "Letting people in" in the
  guide gives `/auth` and `mt auth`; channel §3.4, kanban §4.2 and §22.2, and cron §10 get an
  amendment note pointing here, cron §10's sentence reworded as §6.3 says.

---

## 11. Testing

- **Unit, `tiersOf`**, as a table: each combination of in `allowTalk`, in `allowOperate`, and a
  grant of none, talk or operate, with the owner; `auth.operate` alone giving no tier, and with a
  talk grant giving operate.
- **Unit, `decideGrant` and `decideRevoke`**, as a table over the actor (owner, operator by
  configuration, operator by grant, terminal) and the target (owner, configuration's talk,
  configuration's operate, `auth.operate` without talk, talk grant, operate grant, none), each
  outcome and its words, so every case of §5.2 is a row, granting and revoking yourself included.
- **Unit, the writer**, on a real SQLite: migration 011 from version 10 with people and a board in
  it; every check constraint; the unique active index refusing a second active row written past
  the writer; a replace ending the talk row `replaced` and inserting operate in one transaction; a
  revoke writing its columns once and a second revoke finding nothing; `decide` run with the reads
  made inside the transaction (a revoke committed between a caller's read and its write is seen);
  rows never deleted; `grantCounts` with another app id's grants.
- **Unit, the `Authorizer`**: with a fake reader, `canTalk` and `canOperate` by grant; a principal
  with no union_id never asking the reader; a throwing reader counting as no grant and logged once
  a minute; no reader as today; `isOwner`.
- **Unit, `/auth`**: the parse (a mention name with spaces, the tier in any case and last, a
  missing tier, `lark:` for revoke only, `help` and an unknown word answered with the usage);
  `mentionedPerson`'s three refusals, through `/kanban` too, unchanged, and its fourth for a bot's
  mention; a typed `lark:` refused for `grant`; the direct message's refusal; the revoked
  operator's count of grants still in force; the owner's leftover grant revoked; each tier refusal; the
  sender and mentions noted in `people`; the reply's words for each outcome, masked, a name holding
  a known secret shown masked; the 50-line cut of `/auth list`.
- **Router**: `/auth` registered at talk, listed in `/help`, answered while a session is busy, and
  refused silently for a sender without talk; a grant then the person's message admitted with the
  same `Authorizer`; a revoke then refused; a card press by a revoked operator refused; cron's
  `turnSubmitted` given operate for an operator by grant.
- **The board**: a person granted talk assignable by `/kanban task new` and at the terminal; the
  card poster refusing a revoked assignee's card, `card_failed`; `PeopleDirectory.canTalk` finding a
  grant by union_id.
- **The marker**: `MT_AGENT_SESSION` in a chat session's environment with cron off and on, a board
  run's and a fire's; absent from a gate's, a cron script's and `mt update`'s children's; `mt auth`
  refused with it alone set, and `mt kanban task list` and `mt service status` not refused with it
  alone set.
- **Sources**: a reply naming `MT_ALLOW_TALK` with the override set and `auth.talk` without; the
  terminal's `sourcesOf` from `TeamSettings` agreeing with the `Authorizer`'s for the same settings.
- **`mt auth`**: grant, revoke and list against a temp home and database, `--json` on each, every
  refusal code; an unseen union_id, an
  `ou_` and an `@` refused in their words; no app id, no owner, an unmigrated database; refused in an
  agent's shell, `--json` included; `list --json`'s shape; `mt kanban people`'s `talk` and
  `talk_from`.
- **End to end**, with the fake Lark of the gateway tests: the owner grants talk in a group, the
  person's message runs a turn; an operator's `/auth grant @X operate` refused; `mt auth revoke`
  from another process while the gateway runs, and the person's next message refused, with no
  restart; the startup line with grants and with another app id's.
- **Docs**: the guide's and the README's `/auth` and `mt auth` examples checked by
  `tests/docs-examples.test.ts`, as the other commands' are.

---

## 12. Limits

- **The terminal is trusted, and an agent is held off only by its shell.** `mt auth` refuses every
  agent's shell, by `MT_AGENT_SESSION` or the agent variables (§6.3). That guards `mt auth` against
  mistakes and prompt injection, not against an agent set on it: an agent runs as the gateway's OS
  user, and could unset the variable, edit `config.yaml`, or write `tier_grants` itself, as kanban
  §10 says of the board's operator commands.
- **Other operator commands stay reachable from a chat agent's shell with cron off**, by the user's
  choice (§6.3): `mt kanban task`, `mt service` and the rest, as today. So with cron off a chat
  agent's shell can still add a gate (`mt kanban gate add`), or change a cron script, whose command
  runs `mt auth` in an operator's shell, as gates and scripts are (§6.3). That follows from the
  user's choice, and is no stronger than unsetting the variable.
- **The terminal judges by its own read of the configuration**, which may differ from the running
  gateway's until a restart (§5.1).
- **A grant needs a union_id**: an app that cannot read user ids can grant nobody, and its people
  are let in by configuration alone (§2.2).
- **Grants are per bot**: a new app id starts with none in effect (§2.2).
- **A grant is gateway-wide and never expires** (§1).
- **An admitted turn runs to its end** after a revoke, with its queued turns (§5.3).
- **A terminal's grant is announced nowhere**, and is not in the gateway's log (§6.2, §7).
- **A revoked operator's grants stay** until each is revoked (§9).
- **No history command**: the revoked grants are in the table, read with `sqlite3` (§1).
- **Going back before migration 011 drops every grant**, with the backup restored, failing closed
  (§8.5).

---

*Decided on 2026-11-18.* The user chose: the commands, `/auth grant @Name talk|operate`, `/auth
revoke @Name` and `/auth list` in chat, and `mt auth grant|revoke lark:<union_id>` and `mt auth
list [--json]` at the terminal; that the owner grants and revokes anything, an operator talk only,
the terminal both, and an agent nothing; grants stored in the database with the principal, the
open_id as last seen, the tier, who, when and how, counted beside the configuration's lists; that
the configuration stays the base, its entries and the owner never revoked from chat or `mt auth`;
the grant's effect at once, with no restart, on chat messages, card presses, `/kanban`'s checks,
cron's per-turn tier, the card poster's check and the terminal's (`TeamSettings.talk`); one line in
the chat a grant or revoke was made in, which the main agent read as posting nothing for a
terminal's change, made in no chat; a revoked person's work treated as on losing talk today; a
table of grants with `revoked_at`, never deleted; an operator allowed to revoke another operator's
talk grant unless the target is an operator by configuration; a configuration tier refused for
revoke with that said; a grant of a tier already held a no-op, said so; and the config example's
comment changed in the plan, not now. The main agent decided, where the code forced it: grants
keyed by `(app_id, union_id)` and matched by the union_id Lark sends with every principal, with
the open_id from `people` used only to place a person named by principal in the configuration's
lists, and the grant's own open_id never matched, since Lark gives a check the union_id directly
and an open_id is per app; a principal with no union_id having no grant; the old app id's grants
counting for nothing, and said at startup; a query per check with no cache, a failed read counting
as no grant, so a terminal's grant needs no nudge; `reconfigure` left to the configuration, with
its comment and channel §3.4's single write path amended; one pure `tiersOf` for the gateway and
the terminal, and one `decideGrant` and `decideRevoke` for chat and the terminal, run inside the
writer's transaction; one active grant a person, an operate grant replacing a talk one, and a
revoke ending the whole grant, operate and talk together; a talk grant to someone in
`auth.operate` alone, and its revoke, the owner's, as either makes or unmakes an operator; `grant
talk` never a downgrade; `/auth` always on, at talk tier, with each change checking its own;
`lark:<union_id>` taken by `/auth revoke` but not `/auth grant`; the mention resolution moved to
`src/channel/mentions.ts`; the reply as the announcement, by name, not by @-mention; the terminal
granting only a person `people` holds, and refusing an open_id; no names stored, shown masked; no
events table; `PeopleDeps.canTalk` given the union_id; `TeamSettings.owner` and `operate`; `mt
kanban people`'s `talk_from`; the startup lines; `/auth list`'s 50-line cut; and `mt service check`
unchanged.
*Amended on 2026-11-18, after review round 1.* The user decided that only `mt auth` is refused in an
agent's shell, whether or not cron is on: the gateway sets `MT_AGENT_SESSION=<session id>` in every
agent session's environment through the registry's `envFor`, not added to `AGENT_VARIABLES`;
`mt auth` refuses when `inAgentRun` holds or the marker is set; `gateEnv` and `mt update`'s
environment drop it; cron §10's rule becomes "no token or `PATH` change; the session marker is
always set"; and the limits say this guards `mt auth` against mistakes and injection, not against
an agent that unsets the variable or edits `config.yaml` as the same OS user, with the other
operator commands reachable from a chat agent's shell when cron is off (§6.3, §12). The user also
chose: `/auth list` kept at talk tier, accepting that a chat's members see other chats' grants
(§8.1); a revoked operator's reply counting their talk grants still in force (§6.1); the audit
view deferred (§1); and the direct message rule kept, its refusal pointing at a group or `mt auth
grant` (§6.1). The review found, and this revision takes: that going back before 011 means
restoring the backup, which drops every grant (§8.5); that only `mt auth` refuses an unmigrated
database, the terminal's reader finding no grants (§4.3); that `PeopleDirectory.canTalk` checks a
grant with or without a `people` row, its callback taking `openId: string | null` (§4.3); that
replies name the list in effect, `loadConfig` recording each list's source (§5.1); `sourcesOf`
and `isOwner` feeding `decide` in the gateway and at the terminal, the terminal judging by its own
read of the configuration (§5.1); `--json` on `mt auth grant` and `revoke` (§6.2); a bot's mention
refused by `mentioned_type` (§6.1); `mentionedPerson` taking `@` names only (§6.1); the
`revoked_chat` check (§3.1); and an owner's leftover grant revoked, the owner keeping both tiers
(§5.2).
