# Kanban — a task board where humans and agents are coworkers

**Date:** 2026-11-02
**Status:** draft, for review
**Scope:** v1 of the task layer — ad-hoc tasks with dependencies, assigned to people or to roles,
dispatched onto gateway sessions, reported back through a worker CLI, and driven from Lark.

This document assumes [`../architecture.md`](../architecture.md). Where the two disagree, the
architecture document wins and this document is a bug. As in the channel spec, every rule that
looks arbitrary states the mechanism that forces it, so that it is not "simplified" away later.

---

## 0. The thesis

> **The board owns lifecycle truth. Workers execute, and never own it.**

A task is a durable card. Whoever is assigned to it — a person, or a role — does the work and then
*reports* through the board: complete, request review, block. Nothing a worker does moves a card
except an explicit report, and nothing else is allowed to stand in for one: an agent that stops
talking has not finished, and a commit is not a completion.

The gateway already has most of what sits below the board: durable sessions, a single writer per
session, an event log, vendor drivers, and a chat channel. The board turns "a task became ready"
into "a session got a prompt", and "the worker reported" into "the card moved". It needs five
changes underneath it, listed in §2.4.

---

## 1. Boundaries

**In:** tasks, dependency links, comments, quality gates, attempts (runs), subscriptions; an
in-process dispatcher; role directories and named workspaces, and the `mt role` / `mt workspace`
commands that create them; the `mt kanban` worker CLI;
`/kanban` chat commands and cards in Lark.

**Out, each with the seam that keeps it cheap later:**

| Deferred | Seam |
|---|---|
| Templates and workflow definitions | A template is a function that creates tasks and links. Nothing in the kernel knows about templates, so adding them touches no table |
| Automatic decomposition by an agent | A decomposer is just a task assigned to a role that calls `mt kanban create`. The CLI already allows it |
| A judge model ("is this really done?") | Completion contracts and gates (§4.3, §7.7) carry the acceptance criteria; a judge would read the same fields |
| Multiple boards, tenants | One board. A `board` column can be added with a default |
| A web board | Lark is the v1 interface. The board is a projection over `kanban_events`, so a web view is a second renderer |
| **Parallel agent runs in one workspace** | One open agent run per workspace (§6.3). Worktrees (architecture milestone 9) give each task its own checkout inside its workspace |
| Tool restrictions on agents that cannot enforce them | Declared per role, refused at startup until the role's agent can enforce them (§2.2) |
| Vendor-native skills (Claude Code skills, bytesec agent packages) | v1 skills are files listed in the prompt (§2.2), written in a format a native installer can consume later |
| MCP delivery of the worker tools | The CLI and an MCP server would share one handler (§7.3) |
| Live progress cards for a run | A run's events are in its session log already; `/kanban show` reads them |
| Notifications that start an agent turn ("wake") | Subscriptions deliver from a cursor; a second delivery kind reads the same cursor |

---

## 2. Roles and workspaces

Two things, configured separately, because they vary independently:

- a **role** is *who* does a kind of work, and *how* it is run: its coding agent (driver, command,
  model), its standing instructions, skills, tool policy, secrets, and where it works by default;
- a **workspace** is *where* — a named directory.

A role is **a directory**, self-contained, so it can be created from the command line, copied,
put under version control and shared. Moving a role from bytesec to Claude Code is an edit to that
role's `config.yaml`; its instructions and skills do not change with it.

```
$MT_HOME/roles/                 # default ~/.manus-team/roles
  implementer/
    config.yaml                  # the coding agent, workspace, tools, description
    role.md                      # standing instructions
    skills/
      testing/
        SKILL.md                 # front matter: name, description
        references/              # anything else the skill needs
      git-hygiene/
        SKILL.md
    .env                         # this role's secrets — 0600, never cloned (§2.5)
    .gitignore                   # contains .env
  reviewer/
    config.yaml
    role.md
    .env
    .gitignore
```

```yaml
# roles/implementer/config.yaml
description: Writes and changes code
workspace: default
agent:
  driver: structured-cli
  command: bytesec
  args: [run, -m, bytesec/modelhub-sg/gpt-5.6-sol]
  unsupervised: true
  passEnv: []
  readOnlyTools: [read, grep, glob, ls]     # illustrative: use the agent's real tool names
```

```yaml
# roles/reviewer/config.yaml — a different model is an independent opinion
agent:
  driver: structured-cli
  command: bytesec
  args: [run, -m, bytesec/modelhub-sg/gpt-5.5]
  unsupervised: true
```

Workspaces stay in the gateway's own `config.yaml`:

```yaml
workspaces:
  default: /srv/repos/bytesec-agents      # the existing `workspace:` setting
  docs:    /srv/repos/docs
```

### 2.1 A role's `config.yaml`

**Which entries are roles.** A role is a directory under `$MT_HOME/roles/` whose name matches the
role grammar: `^[a-z][a-z0-9-]{0,39}$` — lowercase, so `Reviewer` and `reviewer` cannot both
exist; no `/`, `.` or `..`, so a name can never leave the roles directory; no `:`, so a role can
never be mistaken for a person's principal (`lark:…`). Entries starting with `.` (`.git`,
`.DS_Store`) are ignored, so the directory can be under version control. Any other entry — a file,
or a directory with a non-conforming name — is reported once at startup and otherwise ignored.
**The driver ids (`acp`, `structured-cli`, and any the driver registry declares) are reserved** and
cannot be role names: old sessions store a driver id where a role name now goes (§2.4), and a role
called `acp` would make those rows ambiguous.

| Field | |
|---|---|
| `agent` | required; the coding agent, below |
| `workspace` | optional; a workspace name. Set, it always applies to the role's tasks; unset, a task takes its parents' workspace, else `default` (§2.3) |
| `tools` | optional; `allow` / `deny` lists of tool names (§2.2) |
| `description` | optional; unused by v1 — what an orchestrating agent would read to route work |

**The `agent` block** carries the fields the gateway's `agent:` block does today — `driver`,
`command`, `args`, `unsupervised`, `passEnv` — validated by the same rules, including the refusal of
anything in the file that looks like a credential: secrets go in the role's `.env` (§2.5). Two more,
both optional:

- **`readOnlyTools`** — the agent's tool names that only read. Used by
  `retry_on_crash: if-no-side-effects` (§8.3). A tool not on the list is treated as having side
  effects; an empty or missing list means every tool call counts. Tool names belong to the vendor —
  a `tool-call` event carries only the agent's own title — which is why this is set per role's
  agent, not globally.
- **`maskExempt`** — environment variable names whose values are not secret, so the masker
  (§10.1) leaves them alone.

The gateway's legacy `agent:` block accepts both keys too, so a deployment that has not moved to
`roles/` gets the same behaviour.

**The role `default`, and the existing `agent:` block.** Chat sessions use the role `default`, and
so does a task assigned to `default`. It is either a directory `roles/default/`, or — when there is
none — a role made from the gateway's existing `agent:` block: its agent is that block, with the
environment overrides that apply to it today (`MT_AGENT_COMMAND`, `MT_AGENT_ARGS`,
`MT_AGENT_DRIVER`, `MT_AGENT_UNSUPERVISED`, and the `MT_AGENT_ENV_*` variables passed to the
agent); it has no workspace of its own, no `role.md`, no skills and no `.env`. Existing deployments
keep working unchanged. Each of these is a startup error:

- **both** a `roles/default/` directory **and** an `agent:` block or `MT_AGENT_*` overrides — a
  silent override is how a deployment ends up running a command nobody can find in its config;
- **neither** — chat sessions need a `default` role;
- a role directory whose `config.yaml` is missing or invalid, or which names an unknown workspace;
- a role's `role.md` or a skill file that exists but cannot be read, or a skill without the required
  front matter;
- a role's `.env` that fails any check of §2.5.

A mistake found only when a task is claimed would strand that task; found at startup, it is a line
to fix.

`MT_AGENT_*` overrides apply to the role `default`, and only while it comes from the `agent:` block.
Other roles get exactly the environment their own `config.yaml` and `.env` give them.

**When changes take effect.** A role's `config.yaml` and `.env` are read at startup: changing its
agent or its secrets needs a restart, and `mt role check` (§2.6) validates the change first.
`role.md` and skills are optional. **Which of them a role has is decided at startup**; their
*contents* are read again at each claim, so editing a role's instructions takes effect from the next
run, and a file added after startup is picked up at the next start. A run records
the hash of the `role.md` it was given and a snapshot of the agent it ran (§3.3), so "what was this
agent told, and what was it" stays answerable after the files change. A file that existed at startup
and is missing or unreadable at a claim makes the role unresolvable (§4.2), not a run started
without its instructions.

### 2.2 `role.md`, skills and tools

- **Roles, not tasks.** What is worth varying is per role: the instructions, the agent, the model,
  where it works. A reviewer on a different model from the implementer is an independent opinion,
  not the same model marking its own work.

**`role.md`** — the role's standing work instructions ("you change code in this repository; run the
tests before you report"). Delivered by the gateway at the head of every task prompt (§7.1). It is
not a personality or an identity, and nothing reads it as one: it is text the agent is given, which
is also why it works with any agent.

**Skills.** A skill is a directory, `skills/<name>/`, holding a `SKILL.md` whose front matter gives
a `name` — the same as the directory's — and a one-line `description`; anything else the skill
needs (`references/`, scripts) sits beside it. That is the format bytesec agent packages and Claude
Code both use, so a skill written once works with either, an existing bytesec skill can be copied in
unchanged, and plan R can install skills natively. Until a role's coding agent has a renderer
(plan R), the task prompt **lists** each skill's name, description and the absolute path of its
`SKILL.md`, and the agent opens a skill when it is relevant. That keeps skills from spending the
context window until they are needed, and works with any agent that can read a file.

**Tools.** A role may declare `allow` and `deny` lists. Only the coding agent can *enforce* them —
the gateway sees tool calls after the fact, or, on a supervised agent, as approval requests it could
answer. Each driver therefore declares whether it can enforce a role's tool policy, and **a role
with a `tools` policy whose agent cannot enforce it is a startup error**, naming the role. Silently
accepting it would leave a role believed to be restricted that is not. In v1 no available driver
can: the structured-CLI driver runs `bytesec run -y`, which approves everything and has no per-tool
switch, and the ACP driver has no policy engine behind its approval requests yet (architecture §10).
The field is in the schema so that roles can be written now and start working when an agent can
enforce them.

### 2.3 Workspaces

- **Named directories.** Each path must be absolute, as the `workspace:` setting must be today: a
  relative path would resolve against whatever directory the service manager started the gateway
  in, and `~` is not expanded. Each is realpath-resolved **at startup** and must exist and be a
  directory — a change from today, where the one directory is resolved on first use; a typo now
  fails the start instead of the first task.
- **Workspace names follow the role grammar** (§2.1): `^[a-z][a-z0-9-]{0,39}$`. A name becomes a
  path (`mt workspace add --clone` writes to `$MT_HOME/workspaces/<name>`), so `../roles` must be
  impossible; it arrives from chat (`/kanban workspace`, `workspace:` lines); and it has no `:`, so a
  worktree id (`wt:…`, below) can never equal a configured name. Enforced at startup and by
  `mt workspace add`.
- **No workspace may be or contain `$MT_HOME`, or the gateway's database** (wherever `MT_DB` or
  `db:` puts it). A workspace configured as `$HOME`, or any directory at or above those, would put
  every role's `.env`, or the database, inside an agent's checkout. It is a startup error, and
  `mt workspace add` refuses it. Inside `$MT_HOME`, only `$MT_HOME/workspaces/<name>` may be a
  workspace — where `--clone` puts them. Anything else there (`roles/`, a single role's directory)
  would put `.env` files inside an agent's checkout, the thing this rule exists to prevent.
- **One directory, one name, no nesting.** Two configured names whose directories resolve to the same
  realpath, or where one lies inside the other, are a startup error, and `mt workspace add` refuses
  them. The one-run-per-workspace limit (§6.3) is counted per name; two names for one checkout would
  be two limits on one directory — two agents in it at once, exactly what the limit prevents — and a
  nested workspace is the same collision one level down.
- **A workspace `default` must exist** — chat sessions, the implicit role `default` and rule 4 below
  all need it — so its absence is a startup error, as it is today when `workspace:` is missing.
- **The existing `workspace:` setting, and `MT_WORKSPACE`, become workspace `default`.** Defining
  `default` in `workspaces:` while `workspace:` or `MT_WORKSPACE` is also set is a startup error,
  for the same reason as for the role `default` (§2.1).
- **A name is a durable identity, and its directory never moves.** At startup each configured
  workspace is registered in the existing `workspaces` table (schema `001`, unused until now), with
  the realpath recorded the first time the name is seen. If config later points a known name at a
  different directory, **startup fails**: relocating a workspace orphans the provider sessions that
  were opened in it — some agents look sessions up by directory — and silently moves every task fixed
  to it. To use a new directory, give it a new name. This is architecture Appendix A's rule that a
  `workspace_id` is never relocated, applied to names. Worktrees (milestone 9) will add rows to the
  same table; their ids are kind-prefixed (`wt:…`) so they cannot collide with a configured name.
- **A task's workspace is resolved at a claim, of any kind, while it is still null** — normally the
  first claim — as the first of:
  1. the task's own `workspace`, if one was given when it was created or set with
     `/kanban workspace` while it was null (§9.1);
  2. the assignee role's `workspace`, **if the role sets one explicitly** — a `docs-writer` with
     `workspace: docs` works in `docs` whatever its parents were;
  3. **its parents' workspace**, if the parents that have a fixed workspace all share one — so a
     downstream review task, whose reviewer role names no workspace, reviews where the work was done.
     Parents with no fixed workspace (an archived parent that was never claimed) are ignored. If the
     parents that count are in different workspaces, the task needs its workspace set (below):
     guessing would review one parent's repository and miss the other's;
  4. `default` — the implicit workspace of a role that names none, and of a person.

  A task a worker creates (§7.3) with no `parents` uses the creating run's task in place of parents
  for rule 3 — recorded as `created_from_task` — so a follow-up lands where the work is unless its
  role names a workspace of its own. **No link is created**: the follow-up is not gated on the
  creating task, and is claimable at once, queuing only behind the creating run's open workspace
  (§6.3).

  **When the parents disagree:** rules 1 and 2 did not apply, and rule 3 refuses to guess, so rule 4
  is not applied either — `default` would be the same guess with a different name.
  - An **agent** task is unresolvable (§4.2) until an operator runs `/kanban workspace <id> <name>`.
  - A **human** task is still claimed — a person's run does not use the workspace — and its
    `workspace` **stays null**. If it has gates, its completion or review is refused until the
    workspace is set (§7.7). A later agent claim on a task whose workspace is null applies the rules afresh.

  "Fixed" means the column is non-null: `/kanban workspace` is refused once a workspace is fixed,
  not merely once the task has been claimed, so a null workspace can always be set.

  Every later run on the task — review, rework, retry, a person's run, its gates — uses that
  workspace, whatever role or person it runs as. A reviewer reads the checkout the implementer wrote,
  not its own role's default directory; a gate added later runs where the work is.
  A task first claimed by a person and later reassigned to a role keeps whatever that claim fixed — `default` if nothing else applied — so set the workspace explicitly when creating a task
  that will move between people and roles.
- **Changing a role's `workspace` in config** affects only tasks not yet claimed; a task already
  claimed keeps the workspace it was fixed to.
- **Only configured workspaces can be named, and an unknown name is refused when the task is
  created.** A task names a workspace by name, never by path: a path typed into chat would let anyone
  who can create a task point an unsupervised agent at any directory the gateway's user can write. A
  workspace that is later *removed* from config makes the tasks fixed to it unresolvable (§4.2), not
  silently moved somewhere else.

### 2.4 Changes to the session layer

The board does not drive agents itself, but five things it needs from the layer below do not exist
yet:

1. **A driver per role.** `SessionRegistry` holds one `driver` for every session
   (`core/registry.ts`, `SessionRegistryDeps`) and stamps `agentId` from it, and the driver registry
   (`driver/registry.ts`) is a process-wide map keyed by driver *kind* that refuses a second
   registration — so two roles on `structured-cli` cannot both exist. It becomes one factory per kind,
   called once per role with that role's `agent` block and its environment (the role's `.env` and
   `passEnv`, §2.5), and the session registry holds a map from role name to driver. **A session's role
   is recorded in `sessions.agent_id`**, which the registry reads to rebuild the right driver for an
   existing session. Existing rows hold a driver id (`acp`, `structured-cli`), not a role name; **a
   legacy driver id resolves to the role `default`**, so every existing chat session keeps working
   without a migration — and the driver ids are reserved as role names (§2.1) so this stays
   unambiguous. A chat session stores `default` whether the role comes from `roles/default/` or from
   the `agent:` block.
2. **A workspace per session, recorded.** The workspace provider returns the one configured
   directory for every session (`core/workspace.ts`, `PlainDirWorkspaces`), and it is asked on every
   actor build — `actorFor` acquires the workspace each time it rebuilds an actor, after an idle
   eviction or when a cold session comes back. So the name must be durable, not just passed at
   creation. **The session's workspace name is written to `sessions.workspace_id` when the session is
   created**, and the provider becomes a lookup by that name. Today the column is written as `''`,
   with a comment saying it is filled in when the actor acquires a workspace — and nothing ever fills
   it. **An empty `workspace_id` resolves to `default`**, so every existing session keeps working.
   Chat sessions are created with `default`. The value is the workspace's name, which is its id in
   the `workspaces` table (§2.3).
3. **Per-session environment.** `StartOptions` carries `cwd`, `providerSessionId` and `replay`, and
   the CLI driver's environment is fixed when the driver is built. `StartOptions` gains `env`, merged
   over the agent's environment at spawn. The actor builds `StartOptions` itself, so this is **the one
   change to the actor**: `SessionActorDeps` gains `env`, which the actor passes to every start. This
   is how a run's `MT_KANBAN_*` variables (§7.2) reach the agent.

   **Who holds the environment.** The token exists only in memory — only its hash is stored — so the
   dispatcher holds each open run's environment, and the registry asks it for a session's environment
   whenever it builds that session's actor. Two rules keep that from failing silently:
   - **The actor of an open run is pinned**: never retired as idle by the registry's capacity
     eviction, so it cannot be rebuilt between a turn and its nudge.
   - **If it is rebuilt anyway** and the dispatcher has no environment for it — which means the
     process restarted — the run ends `interrupted` (§8.4) rather than prompting an agent that has
     no way to report.
4. **A channel per binding.** The registry holds one `channel`. It becomes a map keyed by the
   binding's `channel` id — `lark` to the Lark adapter, `kanban` to the sink channel (§7.1) — so a
   run's session posts through the sink and a chat session through Lark.
5. **Seeding a session from another's provider session.** Review rework (§5.3) starts a new session
   that resumes the implementer's provider-side conversation. The registry's create path accepts an
   initial `provider_session_id`; the driver resumes from it if it can (native resume, §12 plan E)
   and otherwise starts fresh, which the rework prompt is written to survive. This is a deliberate
   exception to "the provider session id is observed, never assumed" (architecture §6.3): the seed
   is an id *another* session observed, passed as a hint, and the new session records whatever the
   agent then reports as its own.

### 2.5 A role's `.env`

A role may need its own credentials: a reviewer with a read-only repository token and an implementer
with a write token, or each role billed to its own API key. So each role has a `.env`, and its
values are given to that role's agent — and to no other role's.

This is the one place the gateway reads secrets from a file. Elsewhere credentials live only in the
environment, because the agent runs as the gateway's user and can read anything on disk, and
because files persist and travel. A role directory is exactly the thing that is copied, cloned,
committed and shared, so its `.env` is guarded at every point where it could travel or leak:

- **Created empty, `0600`**, by `mt role create`, with a `.gitignore` containing `.env` beside it,
  so committing a roles directory does not commit its secrets.
- **Never cloned.** `mt role create --clone-from` copies `config.yaml`, `role.md` and `skills/`,
  and writes the new role an empty `.env`. A credential copied into a second role is one credential
  with two owners — and some cannot survive that: a single-use refresh token rotated by one copy is
  revoked for the other.
- **Permissions are checked, not fixed.** A `.env` readable by group or others is a startup error,
  and `mt role check` reports it. The gateway does not change its mode itself: a file that was
  world-readable may already have been read, and quietly tightening it hides that.
- **Masked.** Every value in every role's `.env` joins the known-secret set (§10.1).
- **Scoped.** A role's agent gets its own `.env`, plus whatever its `passEnv` names from the gateway's
  environment. A `.env` entry and a `passEnv` name for the same variable is a startup error, rather
  than one silently winning.

**The file.** Read at startup, like `config.yaml`; editing it needs a restart. A role without a `.env`
is valid — it has no secrets of its own. The format is deliberately small: `KEY=value` lines, blank
lines, and comments starting with `#`; a value may be wrapped in single or double quotes, which are
removed; no `export`, no variable expansion, no multi-line values. Anything else is an error naming
the line, not a guess. It must be a regular file — not a symlink, which could point anywhere — owned
by the gateway's user.

**Which names it may set.** The same names `passEnv` may not forward cannot be set here either:
`MT_*` and `LARK_*` belong to the gateway — an agent holding them could reconfigure or impersonate
it. `PATH` is refused too: the gateway prepends the `mt` binary's directory to it for every run
(§7.2), and a role replacing it would lose the worker CLI.

**What it does not do**, stated so it is not assumed: every role's agent runs as the same OS user, so
an agent can still *read* another role's `.env` from disk. Separate credentials stop roles from
*using* each other's credentials by accident — they do not stop a misbehaving agent from finding
them. Only a separate OS user or a container per role does that (architecture milestone 10).

The README's rule changes with this, from "credentials never go in the file" to "credentials go in
the environment, or in a role's `.env` — `0600`, never cloned, masked".

### 2.6 The `mt role` and `mt workspace` commands

```
mt role create <name> [--clone-from <role>] [--description "..."] [--own-workspace]
mt role list
mt role check [<name>]                      # the startup validation, without restarting
mt workspace add <name> <absolute-path>
mt workspace add <name> --clone <git-url>   # clones into $MT_HOME/workspaces/<name>
mt workspace list
```

**Where the commands get the gateway's state.** They find the gateway's home, config file and
database exactly as the gateway does — `MT_CONFIG`, else `$MT_HOME/config.yaml`; `MT_DB`, else `db:`, else
`$MT_HOME/gateway.db` — and read registered workspaces from that database, opened read-only and
never checkpointed, so the running gateway is not disturbed. A database that does not exist yet (a
fresh install) has no registrations. A deployment with no config file (environment-only) cannot have
`workspaces:` added to it; `workspace add` refuses and says to create one.

- **`role create <name>`** checks the name against the grammar (§2.1), then writes the directory:
  `config.yaml` (copied from `default`, or from `--clone-from`), a starter `role.md`, an empty
  `skills/`, an empty `0600` `.env`, and the `.gitignore`. It refuses a name that exists — except
  `default` while that role still comes from the `agent:` block (below); `--clone-from` is refused
  with `default`, whose copy source is fixed.
- `--own-workspace` also creates `$MT_HOME/workspaces/<name>`, adds it to `workspaces:`, and sets the
  role's `workspace:` to it — for a role that does not work on a repository; without it a role's tasks
  follow their parents' workspace, which is what a reviewer needs. A `$MT_HOME/workspaces` that is a
  symlink, or not a directory, is refused before anything is written, so the new directory and the
  path recorded for it cannot land outside `$MT_HOME`.
- **Copying from the legacy `default`.** The agent is the `agent:` block with any `MT_AGENT_COMMAND`,
  `MT_AGENT_ARGS`, `MT_AGENT_DRIVER` and `MT_AGENT_UNSUPERVISED` overrides **set in the shell the
  command runs in**, and the command prints which were applied — the shell may not be the service's.
  `MT_AGENT_ENV_*` values are never copied: they are secrets. The command lists their names, so they
  can be put in the new role's `.env`, rather than leaving the new role to fail its first run on a
  missing credential with no hint why.
- **Moving an existing deployment to `roles/default/`** is `mt role create default`. It writes
  `roles/default/` from the legacy agent as above and prints the cutover: move the listed
  `MT_AGENT_ENV_*` values into `roles/default/.env`, remove the `agent:` block and every
  `MT_AGENT_*` variable from the service's configuration, run `mt role check`, restart. Until the
  `agent:` block and overrides are gone, startup refuses to run with both (§2.1) — deliberately, so
  the cutover cannot half-happen silently.
- **`role check`** runs the startup validation, in two parts:
  - the parts that depend only on files — names, `config.yaml`, the tool policy against what the
    agent can enforce, `role.md` and skills, the `.env` format, names, ownership and mode, workspace
    names against `config.yaml` and the resolved database;
  - the parts that depend on the environment — `passEnv` names being set, and whether `MT_AGENT_*`
    overrides conflict with `roles/default/` — checked against **this shell's** environment and
    reported separately, with a note that the service's environment may differ.
- **`workspace add`** adds the name to `workspaces:` in the gateway's `config.yaml`, editing the file
  in place so its comments survive. Before writing, it runs **every check startup runs on workspaces
  (§2.3)** — absolute, existing, a directory, not at or above `$MT_HOME` or the database, not sharing
  or nesting with another workspace — and refuses anything the next start would refuse, including:
  a name outside the grammar; a name already in `workspaces:` (registered or not — the gateway may
  not have restarted since it was added); a name registered in the database for a different
  directory; `default` while `workspace:` or `MT_WORKSPACE` is set — the latter read from this shell,
  with the same note as `role check` that the service's environment may differ.
- **`workspace add --clone <git-url>`** runs `git clone -- <url> <dir>` — the `--` so a URL starting
  with `-` cannot be read as an option — into `$MT_HOME/workspaces/<name>`. It refuses if that
  directory exists, and refuses a `$MT_HOME/workspaces` that is a symlink or not a directory, so the
  clone and the path recorded for it cannot land outside `$MT_HOME`. If the clone fails, the partial directory is removed and `config.yaml` is not
  touched. Any URL `git` accepts is allowed, including transports that run commands: the command runs
  as the operator, who could run `git` directly, so restricting URLs would add no protection.
- **These commands only write files.** They do not talk to the gateway's socket and take no
  authority from it, so they give an agent — which runs as the same user and could edit the same
  files by hand — nothing it did not already have. A change takes effect at the next start, or the
  next claim for `role.md` and skills.
- Not taken from comparable tools, deliberately: a role is not its own command (roles are run by the
  board, not by hand); a role has no memory of its own (each vendor agent keeps its own); a role has
  no bot token or gateway of its own (there is one gateway).

---

## 3. Schema (migration `003_kanban.sql`)

Same database (`gateway.db`), all tables prefixed `kanban_`. One database is deliberate: a run is
a session, and "what happened to task X, and what did its agent actually do" must be answerable
with a join, not by correlating two files.

### 3.1 `kanban_tasks`

| Column | Notes |
|---|---|
| `task_id` | `k_…`, opaque |
| `title`, `body` | `body` is free text |
| `contract` | JSON, all fields optional: `outcome`, `verification`, `constraints`, `boundaries`, `stop_when` (§4.3) |
| `assignee_kind`, `assignee` | `role` + role name, or `human` + principal (`lark:<union_id>`) |
| `reviewer_kind`, `reviewer` | optional; the reviewer for same-task review (§5.3), a role or a person |
| `workspace` | a workspace name; given at creation, or resolved at a claim while null (§2.3); "fixed" means non-null |
| `phase` | `open` · `review` · `blocked` · `done` · `archived` (§4.1) |
| `blocked_from` | the phase to return to on unblock; set with `blocked` |
| `block_kind`, `block_reason` | set with `blocked`; the kind survives unblock (§5.4) |
| `priority` | integer; ordering only |
| `idempotency_key` | unique, nullable |
| `failure_limit` | nullable; overrides `kanban.failure_limit` (§8.2) |
| `retry_on_crash` | `always` (default) · `if-no-side-effects` |
| `max_runtime_s` | nullable; overrides `kanban.default_max_runtime_s` |
| `consecutive_failures` | §8.2 |
| `consecutive_transient`, `cooldown_until` | §8.2 |
| `block_recurrences` | §5.4 |
| `stranded_notified_at` | §4.2; cleared when the task is next claimed |
| `created_by`, `created_via`, `created_at`, `closed_at` | `created_via` includes the chat it was created in (§9.2) |
| `created_from_task` | set when a worker creates the task: the creating run's task, used by §2.3 rule 3 when the task has no parents; not a link |

- **`idempotency_key` is unique** because creation is retried by everything that can create: Lark
  redelivers a message, and an agent re-runs a command whose output it did not see. A repeated
  create with the same key returns the existing task instead of a second card.
- **`consecutive_failures` and `block_recurrences` reset only on completion**, with one deliberate
  exception for `gave_up` (§8.2). Resetting `block_recurrences` on unblock is the amnesia that lets
  a task bounce between blocked and unblocked forever, each unblock forgetting the last block.
  Resetting failures on anything but success leaves the breaker unable to trip.

### 3.2 `kanban_links`

`(parent_id, child_id)`, primary key over both.

- **Cycles are refused** at insert, by walking parents from `parent_id`. A cycle is a pair of
  tasks that can never become ready, and nothing would ever say why.
- **A link onto a task with an open run, or past its parents gate, is refused.** The dependency
  gate is evaluated when a task becomes ready; adding a parent to a running task cannot un-start it,
  and a task in review, blocked from review, done or archived has passed the gate, so a parent added
  then could never hold it back — a review would wait on it forever.
- **Parents may also come from a dependency block** (§5.4): the block names them, and they are linked
  in the block's own transaction, after the reporting run is decided. That is the one way a parent is
  added to a task in review: the reviewer's own block, which holds the review until they are done.

### 3.3 `kanban_runs` — one attempt

| Column | Notes |
|---|---|
| `run_id`, `task_id`, `attempt` | `attempt` counts from 1 per task, across kinds |
| `kind` | `work` or `review` |
| `assignee_kind`, `assignee` | the role or person, snapshot at claim — reassigning the task does not rewrite history |
| `agent_config`, `workspace` | for an agent run: the role's effective `agent` block at claim — for a legacy `default`, after `MT_AGENT_*` overrides — with driver, command, args and the *names* of its environment variables, never their values; and the workspace. History shows what actually ran after the role's files change |
| `role_md_hash` | for an agent run: SHA-256 of the `role.md` it was given (§2.1) |
| `session_id` | the gateway session for an agent run; null for a human run |
| `seeded_from_run` | for rework (§5.3): the work run whose provider session this run resumes |
| `token_hash` | SHA-256 of the run's worker token (§7.2); the token itself is never stored |
| `outcome` | null until decided; §5.2 |
| `summary`, `metadata` | the handoff, as reported |
| `reported_commit`, `reported_dirty` | for an agent's `complete` or `review` report in a git workspace: `HEAD`, and whether the tree had uncommitted changes, at the moment of the report (§7.8); null otherwise |
| `error`, `last_output` | for failures: the classified error, and the tail of the agent's last output |
| `submissions` | prompts sent in this run: 1 for the task prompt, +1 per nudge or forwarded comment (§7.5) |
| `started_at`, `ended_at` | `ended_at` is set when the run is **closed** (below) |

A run has two moments, and they are kept apart deliberately:

- **Decided** — `outcome` is set. For a report, that is when `mt kanban complete` (or `review`,
  `block`, `changes`) succeeds, during the turn.
- **Closed** — `ended_at` is set. For an agent run, that is when its session's last turn has ended:
  the agent process is gone. For a human run, it is the same moment as decided.

A run is **open** until it is closed, and everything that is about *the process* counts open runs,
not undecided ones. After a successful report the agent usually keeps going — it summarises, maybe
commits — in the same checkout. If the report freed the run, the task's children would become
claimable and the next agent would start in that checkout while this one is still writing to it.
So:

- **A task has at most one open run**, enforced by a partial unique index on
  `task_id WHERE ended_at IS NULL`. Two dispatch passes racing to claim the same task then fail at
  the database instead of starting two agents.
- **The per-workspace limit (§6.3) counts open agent runs.**
- **The task's phase moves when the run is decided** — a reported `complete` makes the task `done`
  at once, and its children are ready — but a child in the same workspace cannot be claimed while
  the reporting run is still open there.

**A decided run's outcome is never overwritten.** Everything the dispatcher records itself —
`timed_out`, `cancelled`, `superseded`, `interrupted` — is recorded only on an **undecided** run. A
run that is decided but still open (the agent reported and is finishing) is only *closed*: its turn
is cancelled if necessary, and it keeps the outcome it reported. Otherwise a restart, a runtime
limit or an archive arriving in the seconds after a report would turn a completed task's run into a
failure, and count it.

**One agent run is exactly one gateway session**, and one gateway session belongs to at most one
run. Nudges are further turns in the run's session (§7.5); rework is a new run in a new session
(§5.3); a retry is a new run in a new session (§8.3).

### 3.4 `kanban_comments`, `kanban_gates`, `kanban_subscriptions`, `kanban_events`

- **`kanban_comments`** — `task_id`, `author`, `body`, `created_at`. The conversation between the
  agents and people on a task. A retry reads the whole thread.
- **`kanban_gates`** — `task_id`, `command`, `timeout_s` (default 300), `created_by`. Shell commands
  that must exit 0 before the task may complete (§7.7).
- **`kanban_subscriptions`** — `task_id`, the channel binding key (channel, app, chat, thread),
  `cursor` (last `kanban_events.id` delivered). The same cursor discipline as a binding's
  `cursor_seq`: delivery is a projection over the log, and catch-up after an outage is the same
  code as normal delivery.
- **`kanban_events`** — append-only: `id` (monotonic), `task_id`, `run_id`, `kind`, `actor`,
  `payload`, `created_at`. Every change to a task writes one, in the same transaction.

---

## 4. Tasks

### 4.1 Status: one stored phase, one writer, a derived display status

`phase` is the only lifecycle column. It is written **only** by `db/kanban.ts`, through named
transition functions (`claim`, `complete`, `requestReview`, `requestChanges`, `block`, `unblock`,
`giveUp`, `archive`, …), each of which checks the current phase and refuses an illegal move. No
other module issues an `UPDATE` to it.

What a person sees is computed, by one pure function, from the phase and two facts:

| Phase | And | Shown as |
|---|---|---|
| `open` | some parent is not `done`/`archived` | **todo** |
| `open` | all parents done, no undecided run | **ready** |
| `open` | an undecided run | **running** |
| `review` | some parent is not `done`/`archived` (a reviewer's dependency block, §5.4) | **todo** |
| `review` | all parents done, no undecided `review` run | **review** (waiting for a reviewer) |
| `review` | an undecided `review` run | **reviewing** |
| `blocked` / `done` / `archived` | | as is |

Display status follows **undecided** runs, because it answers "is someone working on this". A run
that has reported is not working on the task any more, even while its process finishes; a task
shown **ready** may therefore wait a moment before it can be claimed, until that run closes and
frees its workspace (§3.3).

**Why not store `todo`/`ready`/`running` too:** each is a fact about *other* rows — the parents,
the runs. Stored, it has to be rewritten whenever those change, from wherever they change, and a
status assigned from many code paths is how a task comes to say "running" with no run, or "todo"
with every parent done. Derived, it cannot disagree with the rows it describes. This is the rule
session status already follows (`core/status.ts`, channel spec §7), for the same reason.

### 4.2 Assignees

- **Role.** Dispatched onto a session running the role's agent, in the task's workspace (§6, §7).
- **Human.** A person, identified the way channels identify them (`lark:<union_id>`). When the task
  is ready, the dispatcher opens a run for them and sends them a task card (§9.2). A human run never
  times out: it **parks**, as an unanswered approval does (architecture §10), because a person
  taking a day is not a failure.
- **Assigning to a person who does not have talk tier is refused** at assignment, not left to fail
  at dispatch: being assigned is permission to report on that task (§9.1), and handing that to
  someone the gateway would otherwise ignore is a policy decision to make explicitly, not by
  accident.
- **Unassigned, or an assignee that does not resolve** (a role whose directory was removed or is
  now invalid, a role whose files cannot be read, a person the channel cannot reach), **or an agent task whose fixed
  workspace was removed from config**, or whose parents are in different workspaces and none was set
  (§2.3). Neither workspace case holds a human task (§2.3, §7.7). The task stays ready and a `skipped_unassignable`
  event is written once. It is never silently dropped and never sent to a fallback assignee, which
  would run work under an identity nobody chose. Once it has been ready and unclaimed for
  `kanban.stranded_after_s` (default 30 min, measured from the latest event that made it ready), its
  subscribers are told it is stranded and why, once — `stranded_notified_at` records that the notice
  went out. Only tasks that *cannot* be claimed are stranded; a ready task waiting its turn behind
  the per-workspace limit (§6.3) is queued, not stranded, and is never reported as such.

### 4.3 The completion contract

Five optional fields on the task: **outcome** (the end state that must be true), **verification**
(what proves it), **constraints** (what must not change or regress), **boundaries** (what is in
scope), **stop_when** (when to stop and ask instead).

They are rendered into the worker's prompt (§7.1) and shown to whoever reviews. The most common
failure of delegated work is a vague definition of done — the worker stops early, or never stops.
A contract costs nothing to carry and makes "done" checkable by the reviewer; gates (§7.7) make the
checkable parts mechanical.

### 4.4 Follow-ups, not reopening

A `done` task is never reopened. New work on it is a new task with the done task as a parent, and
any new evidence (a failing CI log, a bug report) goes in the new task's body.

**Why:** a completed task's summary is what its children were given as their handoff. Reopening it
rewrites the input to work that already ran. A child link keeps both the history and the reason
for the follow-up.

---

## 5. Lifecycle

### 5.1 Transitions

| From | Event | To |
|---|---|---|
| (new) | created | `open` |
| `open` (ready) | claimed | `open` (running) — a `work` run is opened |
| `review` (no open run) | claimed by the reviewer | `review` (reviewing) — a `review` run is opened |
| `open` (running) | `complete` | `done` |
| `open` (running) | `review` | `review` — the work run ends `review_requested` |
| `review` (reviewing) | reviewer `complete` | `done` |
| `review` (reviewing) | reviewer `changes` | `open` (ready) — the next claim is rework (§5.3) |
| `open` (running) | `block`, kind `dependency` | `open` (todo) — the parents it names are linked (§5.4) |
| `review` (reviewing) | `block`, kind `dependency` | `review` (todo) — the parents it names are linked; the reviewer is claimed again once they are done (§5.4) |
| `open` (running) / `review` (reviewing) | `block`, any other kind | `blocked`, `blocked_from` = the phase it left |
| `blocked` | `unblock` | `blocked_from` |
| running or reviewing | run fails, budget remains (§8.2) | same phase, no open run — claimed again |
| running or reviewing | run fails, budget exhausted | `blocked`, kind `gave_up` |
| running or reviewing | `terminal_provider` (§8.1) | `blocked`, kind `capability` |
| running or reviewing | `rate_limited` for the `transient_limit`-th time in a row (§8.2) | `blocked`, kind `transient` |
| running or reviewing | run fails, budget remains, `if-no-side-effects` and the run had side effects (§8.3) | `blocked`, kind `needs_input` |
| running or reviewing | `/kanban assign` | phase unchanged; an undecided run ends `superseded`, a decided one is closed; the next claim goes to the new assignee |
| running or reviewing | `/kanban stop` | `blocked`, kind `needs_input`, `blocked_from` = the phase; the run ends `cancelled` |
| a decided run still open | `/kanban stop` | phase unchanged; the run is closed (its turn cancelled) and keeps its outcome |
| any but `archived` | `archive` | `archived` — an undecided run ends `superseded`; a decided one is closed |

Completing a task whose parents are not all done is refused. Parents can only be unfinished if a
link was added after the task started, which §3.2 prevents, or if a reviewer's dependency block
added them, which holds the review until they are done; the check is the backstop.

**Every path to `done` goes through one `complete` operation**, and it runs the task's gates (§7.7):
an agent's `mt kanban complete`, a reviewer role's `complete`, a person's `/kanban done` or Done
button, and `/kanban approve`. A person cannot complete or approve a task **while an agent run is open
on it** — because gates would run against a checkout that agent is still changing, and the agent's
own later report would contradict the person's. If the run is undecided, the refusal says to
`/kanban stop` it first; if it has already reported and is finishing, the refusal says to wait for it
to finish.

### 5.2 Run outcomes

| Outcome | Meaning | Breaker |
|---|---|---|
| `completed` | reported `complete` | resets |
| `review_requested` | reported `review` | — |
| `changes_requested` | reviewer reported `changes` | — |
| `blocked` | reported `block` | — |
| `failed` | the turn failed for an ordinary reason (§8.1) | counted |
| `crashed` | the runtime exited without finishing | counted |
| `timed_out` | past `max_runtime_s`; the dispatcher cancelled it | counted |
| `protocol_violation` | ended without a report, and the nudges ran out (§7.5) | counted |
| `rate_limited` | throttling or a transient provider error | transient counter (§8.2) |
| `terminal_provider` | credentials rejected, or the model is unavailable | blocks at once |
| `interrupted` | the gateway restarted mid-run (§8.4) | — |
| `cancelled` | a person ran `/kanban stop` | — |
| `superseded` | the task was reassigned or archived during the run | — |

`gave_up` is not a run outcome: the run keeps the outcome that exhausted the budget, and `gave_up`
is the task's block kind (§5.4), so both "what happened last" and "why the task is stuck" are kept.

### 5.3 Review: two models, never both

1. **A downstream review task.** The graph has a separate review task whose parent is the
   implementation. The implementer reports `complete`, which is what releases the reviewer.
2. **Same-task review.** The implementer reports `review`, optionally naming a reviewer, which
   replaces the task's `reviewer` (otherwise the task's existing `reviewer` is used). A reviewer is a
   role name or a person's principal, `lark:<union_id>`, as `/kanban show` displays it. The task enters `review`; the reviewer — a role, dispatched as a `review`
   run in the task's workspace, or a person, sent a card — reports `complete` to approve or
   `changes` with a reason.

**Never both.** An implementer that requests same-task review when a downstream review task exists
leaves the downstream task waiting on a parent that is not done, so the review happens twice or not
at all. The worker protocol (§7.1) says so, and the worker context lists the task's children so the
worker can see which model applies.

A `review` with no reviewer named anywhere is refused: a task in review with nobody to review it is
a stranded task with a different label.

**Rework after `changes` is a new run that resumes the implementer.** It is claimed like any work
run, gets a new session, a new token and a new `run_id`, and records `seeded_from_run` = the last
work run when it seeds from it (below). Its session starts from that run's observed `provider_session_id` (§2.4, item 5), so on a
driver that resumes, the implementer continues its own conversation and revises what it wrote
knowing why. Its prompt carries the reviewer's reason and the implementer's previous handoff in
full, so on a driver that cannot resume, the rework still has everything it needs. Seeding is only
attempted when the rework runs the same agent as the work run it resumes — the same driver, command
and arguments in the runs' `agent_config`; environment names are not compared, since a changed
secret does not make a conversation unresumable; a task reassigned to a
role on another agent gets the full prompt and a fresh conversation, and its `seeded_from_run` is
null — the column names the run whose provider session was actually resumed, not the one before. A failed or crashed run is the
opposite case, and starts clean (§8.3).

### 5.4 Blocking

`block` takes a kind:

- **`dependency`** — waiting on another task. The block names the prerequisites in `parents`, and
  they are linked as the task's parents in the block's own transaction (§3.2) — not by a separate
  link first, which the open run would refuse. It never sits in `blocked`, because no person needs
  to act; the task keeps its phase and is gated by its parents:
  - from an implementer's work run, it stays `open` (todo), and its next work claim waits for them;
  - from a reviewer's review run, it stays `review` (todo), and the reviewer is claimed again once
    they are done. The implementer's work is done, and only the review was waiting, so it is not
    redone.

  A dependency block that leaves nothing unfinished to wait on is refused: the task would be
  claimable again at once.
- **`needs_input`** — a decision or information only a person can supply.
- **`capability`** — something the worker cannot do here: access, a tool, infrastructure.
- **`transient`** — expected to clear by itself.
- **`gave_up`** — set by the breaker, never by a worker (§8.2).

All but `dependency` go to `blocked` and notify subscribers (§9.4). `unblock` returns the task to
`blocked_from`, optionally with a comment the next run will see. A person's `/kanban block` on their
own task uses `needs_input`.

**Block loops.** Re-blocking for the same kind after an unblock increments `block_recurrences`. At
`kanban.block_recurrence_limit` (default 2) the notification changes: it says the task keeps
blocking for the same reason and suggests rewriting it, instead of inviting another unblock.

---

## 6. The dispatcher

### 6.1 One owner, in process

The dispatcher runs inside the gateway, as one component. There is exactly one: two dispatchers
would race to claim the same task, and the partial unique index (§3.3) would turn that race into
errors instead of two agents — better, but still noise. Single ownership is what removes it.

It runs a **pass** when something that can make a task claimable happens — a task created, linked
or unblocked, a run ended, a review requested — and on a sweep every `kanban.sweep_interval_s`
(default 60 s) for the things only time changes: cooldowns ending, runtimes exceeded, tasks
becoming stranded.

### 6.2 A pass

1. Collect claimable tasks with **no open run of any kind**: **ready** (§4.1) for work, **review**
   for review. A task whose previous run has reported but not yet closed is skipped until it closes;
   claiming it would only fail on the one-open-run index (§3.3). Order by priority, then age.
2. Skip any whose `cooldown_until` is in the future, whose assignee (or reviewer) does not resolve
   (§4.2), or — for an agent run — whose workspace already has an open agent run (§6.3), or when
   `kanban.max_running` agent runs are open.
3. Claim, in one transaction: if the task's workspace is null, resolve it by the rules of §2.3 — which
   may leave it null for a person — then insert the run and write `claimed`. The case where an agent
   task's workspace cannot be resolved is caught by step 2 as unresolvable, before any claim, so an
   agent claim never inserts a run and then backs out. The partial unique index makes a second claim fail.
4. Start it: §7 for a role, §9.2 for a person.

### 6.3 One agent run per workspace

Two agents editing one checkout overwrite each other without either noticing. So **a workspace has
at most one open agent run at a time.** Tasks in different workspaces run in parallel, up to
`kanban.max_running` (default `maxLiveSessions`, which already caps live runtimes — a run is a
session, and the two limits must not disagree). Human runs are not limited.

A board that fills every live slot leaves no room for chat sessions: open runs' actors are pinned
(§2.4), and the registry's capacity eviction goes over its cap rather than refusing a chat session
when nothing is idle. Nothing deadlocks, but the gateway runs above `maxLiveSessions` until a run
closes. Set `kanban.max_running` below `maxLiveSessions` to keep room for chat.

**Human runs do not hold a workspace.** A human run parks and has no time limit, so a review that held
the workspace would stop every agent in that repository for as long as the person took — days, for a
review nobody got to. The cost is that a person reviewing or completing task X can be looking at a
checkout another task's agent has since started changing. Two things contain it until worktrees
remove it:

- the person reviews **the commit the implementer reported** (§7.8), shown on the card, not whatever
  the checkout holds now;
- the gates run at approval do see the current checkout. That is the one remaining exposure, and it
  is a reason to keep gates fast and to approve promptly, not a reason to lock the workspace.

This is the main limitation of v1: two tasks in the same repository run one after the other. Worktrees
(architecture milestone 9) give each task its own checkout inside its workspace and lift it, which is
why they come directly after this work (§12).

A chat session in the same directory can still collide with a kanban run, as two chat sessions can
today. Worktrees fix both.

### 6.4 Supervision is the actor's, not the dispatcher's

The dispatcher does not poll processes, check PIDs, or expire claims. The session actor owns the
agent process and resolves the submit with the turn's terminal, so a run's end is an event, not
something to detect. The dispatcher acts on time only to cancel a run past `max_runtime_s`, end a
cooldown, and flag a stranded task.

When the dispatcher cancels an undecided run's turn, it **records why first** — `timed_out`,
`cancelled`, `superseded` — and that reason is the run's outcome. The classifier (§8.1) only runs for
a turn that ended without the dispatcher having asked it to. Cancelling a decided run's turn records
nothing: it only closes the run (§3.3).

---

## 7. Agent runs

### 7.1 One session per run, and its prompt

An agent run is a fresh gateway session, created by the registry with the role's agent and the task's
workspace, bound to a `kanban` binding key: `channel: 'kanban'`, conversation = task id, thread = run
id. The binding is how the run finds its session again for a nudge or a forwarded comment, and it is
why the session is never shared with another run.

The session uses the **sink channel**: card output is discarded (the session log keeps every event),
and approval cards, for a supervised agent, are forwarded to the task's first subscription. An
approval for kanban work is still answered by a person, on the channel where they follow the task;
the click resolves through the approval's session, which the router already looks up by
`approvalId`.

The task prompt is composed, in this order, of:

1. **The role** — the role's `role.md`, if it has one.
2. **The skills** — for each of the role's skills, its name, description and the absolute path of its
   `SKILL.md`, and the instruction to read one when it applies.

   For a role whose coding agent has a renderer (plan R), `role.md` and the skills are delivered in
   the agent's own format instead — `role.md` as its system prompt, the skills through its own skill
   loading — and are left out of the task prompt.
3. **The protocol** for the run's kind. It comes after `role.md` and says it takes precedence:
   a role's instructions may shape *how* work is done, not whether it is reported. That precedence is
   an instruction to the model, not something the gateway can enforce; the nudges (§7.5) and the
   `protocol_violation` outcome are what catch a `role.md` that talks an agent out of reporting.
   - *work*: you have one task; orient by reading the context below; work in the workspace; report
     through `mt kanban`, and exactly one terminal report — `complete`, `review` or `block` — ends
     your run; block only on genuine ambiguity, and say why; if a downstream review task exists,
     `complete` rather than `review`; if you find follow-up work, create a task for it rather than
     doing it; never put secrets in a summary, metadata or comment; stop once you have reported.
   - *review*: review the implementer's handoff and the workspace against the task and its
     contract; do not change the workspace; report `complete` to approve or `changes` with a
     specific, actionable reason; `block` only for a problem the implementer cannot fix.
4. **The task** — title, body, contract, and the result of the last gate run if there is one.
5. **The worker context:**
   - each parent's latest completion summary and metadata, verbatim;
   - prior attempts on this task: outcome, summary, error, last output — and for a failed, crashed
     or interrupted attempt, **the tool calls it made**, read from its session's event log (§8.3);
   - for rework, the reviewer's reason and the implementer's previous handoff;
   - for review, the implementer's handoff;
   - the comment thread;
   - the task's children, so the worker can see which review model applies.

### 7.2 The run's identity

The run's environment, passed through `StartOptions.env` (§2.4):

| Variable | |
|---|---|
| `MT_KANBAN_RUN` | the run id |
| `MT_KANBAN_TOKEN` | a random 256-bit token; only its hash is stored |
| `MT_KANBAN_SOCKET` | the gateway's local socket |
| `PATH` | with the directory of the `mt` binary prepended |

**The token is the run's authority, scoped to the run.** It can report on its own task, and comment
on and create tasks; it cannot move any other task. It works while the run is open (§3.3):

- **Before the run is decided**, every command works.
- **After the worker's own report**, `comment`, `create`, `link` and `show` still work — follow-ups
  written just after a report are not lost — but a second terminal report is refused with
  `already_reported`.
- **After the dispatcher decides the run** (`timed_out`, `cancelled`, `superseded`, `interrupted`),
  and **after the run is closed** however it was decided, nothing works: the worker gets
  `run_superseded` instead of acting on a task that has moved on without it.

**This is cooperative scoping, not confinement.** Every process the agent starts inherits the
environment, and the token with it. A malicious workload in the workspace could use the token, within
its scope, for as long as the run lives. The socket is created `0600`, so only the gateway's own user
can connect at all; that, not the token, is the boundary between users.

### 7.3 `mt kanban` — the worker CLI (new)

Neither the `mt` binary nor the socket exists yet. The binary arrives in plan B, with the `mt role`
and `mt workspace` commands; the socket and `mt kanban` arrive in plan C (§12).

```
mt kanban show                      # this task + worker context, as JSON
mt kanban complete   < handoff.json # {summary, metadata}
mt kanban review     < handoff.json # {summary, metadata, reviewer?}
mt kanban changes    < reason.json  # reviewer only: {reason}
mt kanban block      < block.json   # {kind, reason, parents} — parents for kind dependency (§5.4)
mt kanban comment    < comment.json # {body, task_id?}
mt kanban create     < task.json    # {title, body, contract?, assignee, workspace?, parents?, idempotency_key?}
mt kanban link       < link.json    # {parent_id, child_id}
```

- **JSON in on stdin, JSON out, always.** A summary is free text; passing it through shell arguments
  invites quoting failures that mangle or reject an agent's report. Every response is
  `{"ok": true, ...}` or `{"ok": false, "code": "...", "message": "..."}`, so the agent can act on an
  error rather than parse prose.
- **Why a CLI and not tools in the agent's schema:** the gateway drives vendor agents it cannot add
  tools to. `bytesec run` has no way to receive tools; every coding agent has a shell. The handler
  behind the CLI is one module, and an MCP server for agents that accept one is a second front end to
  it, not a second implementation.
- **`create` from a worker** is allowed (follow-ups, decomposition), and the new task inherits the
  run's task's subscriptions, so the person following the parent hears about the children. Its
  workspace follows §2.3: a follow-up for a role with its own workspace (`docs-writer`) works there,
  and one for a role with none works where the creating task did.

### 7.4 The run ends when the turn ends

When the actor resolves a submission with the turn's terminal, the dispatcher looks at the run:

- **A terminal report arrived** during the turn: the run was already decided. It is now closed, the
  session is released, and the workspace is free. If the turn itself failed or crashed after the
  report, the report stands: the board's truth is what the worker reported, not how its process
  exited afterwards.
- **No report, and the turn completed:** a stop nudge (§7.5).
- **No report, and the dispatcher cancelled the turn:** the outcome it recorded first (§6.4).
- **No report, and the turn failed or was ambiguous:** classified (§8.1).

### 7.5 Stop nudges

An agent that narrates its next step and stops without reporting is common, and usually the work is
done and only the report is missing. So the dispatcher submits a short nudge into **the same
session** — "you ended your turn without reporting; run `mt kanban complete`, `review` or `block`" —
up to `kanban.nudge_limit` (default 2) times. If they run out, the run ends `protocol_violation`,
with the agent's last output recorded so the next attempt and the person reading the card see what
it said.

- **Each submission has its own idempotency key**, `kanban:<run_id>:<n>`, where `n` is the run's
  `submissions` count before it. The actor deduplicates turns on `(session_id, idempotency_key)`; a
  nudge reusing the task prompt's key would be taken for a redelivery of the first turn and never
  sent. Because the key is scoped to the session, the dedup only protects a resubmission that reaches
  the *same* session — which the `kanban` binding guarantees, since the run finds its session through
  it rather than creating one.
- **A nudge does not need native resume.** It is another turn in a live session, and the CLI driver
  already carries a live session's conversation into each turn as a transcript. Native resume makes
  it cheaper, not possible.
- **A person's comment beats a nudge.** A `/kanban comment` on a task with an **undecided** agent run
  is submitted into the run's session in place of the next nudge, with the same key scheme, because a
  person speaking is better information than a reminder. On a decided run the comment is only
  stored: prompting an agent that has reported would start a turn with nothing to report, keep the
  run from closing, and hold the workspace. The next run on the task reads it in the thread.

### 7.6 Reports after the run is closed

A report arriving after the run is closed — a background process the agent left running, a late
retry of a command — is refused with `run_superseded` (§7.2). The run's outcome is whatever was
decided before it closed.

### 7.7 Quality gates

The `complete` operation (§5.1) runs the task's gates in the task's workspace before accepting,
whoever calls it. An implementer's `review` runs them too, so a reviewer never starts on a change
whose own checks are red. If any gate exits non-zero or times out, the report is **refused**: the
response carries the failing command, its exit code and the tail of its output, the run stays
undecided, and the agent can fix it and try again. A person whose completion is refused sees the same
output in chat. Each gate run is recorded as an event either way.

Gates live in the kanban service's `complete` and `review` operations — the one place every caller
goes through — not in the socket handler, which is only one of the callers. A human task's gates run
in its fixed workspace like any other task's (§2.3). A human task is never made unresolvable by its
workspace, though: a person's run does not use the workspace, so a removed workspace only matters
when there is a gate to run — and then the completion is refused with that reason, instead of the
task being held from its assignee.

Gates run as the gateway's user, with **the environment of the role of the task's latest agent run**,
by `attempt`, including the run making the report — its agent's base environment, `.env` and
`passEnv` values — or of the role `default` if no agent has run on the task. If that role can no longer be resolved —
its directory removed or now invalid — the completion is refused with that reason, as for a removed
workspace, rather than running gates under another role's credentials. So an implementer's
`review` runs gates as the implementer; a reviewer agent's `complete` runs them as the reviewer —
with the reviewer's credentials, so a reviewer given only a read-only token runs gates with that
token; and a person approving after an implementer's `review` runs them as the implementer. They never get the gateway's own environment, which holds its Lark
secret, and never `MT_KANBAN_TOKEN`: a test suite has no business reporting on the board.

**Gates are not isolated from the network**, deliberately. They are commands an operator chose, in the
same trust position as a cron job, not output from an agent. Denying the network would break ordinary
gates — installing dependencies, integration tests — and has no portable implementation: macOS offers
no supported way to deny one process network access, so the same gate would behave differently on a
laptop and on a server.

Gates are deterministic where a contract is prose: a red test suite is evidence the task is not done,
and no reviewer has to notice. Defining a gate requires **operator** tier: a gate is a shell command
the gateway will execute.

### 7.8 The reported commit

When an **agent** reports `complete` or `review` — an implementer, or a reviewer agent approving with
`complete` — the gateway records, on that run, `HEAD` (`git rev-parse HEAD`) as `reported_commit`
and whether the working tree had uncommitted changes (`git status --porcelain` non-empty) as
`reported_dirty`. Both are captured before the transaction that decides the run, so they describe
the state the report was made in. A person's report records neither: there is no agent state to pin.

The review card and the reviewer's context show them, and a human reviewer is told what to review:

- **clean tree** — "review commit `abc123`";
- **dirty tree** — "uncommitted changes on top of `abc123`": the commit alone does not contain the
  work, and since a person's review does not hold the workspace (§6.3), those changes may be mixed
  with another agent's later;
- **not a git repository, or the command failed** — "uncommitted; no commit to review".

The agent's own summary can say what it changed, but not reliably *which state* it left: it may not
have committed, or may commit again after reporting. These fields are facts the gateway observes.

---

## 8. Failure and retry

### 8.1 Classification

For a turn that ended without a report, failed or ambiguous, and was not cancelled by the dispatcher
(§6.4), the failure is classified from two signals: the turn's terminal, which `submit` resolves
with, and the text of the `agent_error` events of that turn, read from the run's session log. They
are checked **in this order, first match wins**:

| # | Class | Recognized by | Response |
|---|---|---|---|
| 1 | `terminal_provider` | error text: 401, 403, "unauthorized", "authentication", model not found | **block at once** as `capability`: every retry would hit the same wall |
| 2 | `rate_limited` | error text: 429, "rate limit", "quota", 5xx, connection reset or timeout to the provider | cooldown, transient counter |
| 3 | `crashed` | terminal `ambiguous` — the runtime exited without finishing | counted |
| 4 | `failed` | everything else — **including 400** | counted |

**Text before terminal**, because the CLI driver reports any process that exits without a finish
line as `ambiguous`, with the stderr tail in the error — so a 429 or a 401 that kills the agent
early arrives as an ambiguous terminal *with* a provider error in it. Classed by terminal alone, a
quota wall would count as a crash and a revoked credential would be retried.

**400 is an ordinary failure, not a terminal one.** On 2026-11-02 a provider returned 400 to every
request for about three minutes, then recovered with nothing changed. A 400 that blocked at once
would have turned a three-minute blip into a task waiting on a person.

The classifier is one pure function over `(terminal, error text)` with a table of tests built from
real error strings, so a new provider's wording is a test case and a line.

### 8.2 Counting

- **`failure_limit`** — the task's, else `kanban.failure_limit` (default **2**) — is the number of
  counted failures that blocks the task. With the default, a task gets its first attempt and **one**
  retry. `1` means no retries.
- `consecutive_failures` increments on every counted outcome, of either run kind. Below the limit,
  the task stays in its phase with no open run and is claimed again. At the limit, it goes to
  `blocked` with kind `gave_up`, and its subscribers are told what failed, how many times, and the
  last error.
- **Unblocking a `gave_up` task resets `consecutive_failures`** — the one exception to "only
  completion resets". Without it, a person who has fixed the cause and unblocks would get exactly one
  attempt before the breaker trips again, which is not what unblocking means. `block_recurrences` is
  not reset, so a task given up twice for the same reason still escalates (§5.4). For the same
  reason, **unblocking a `transient` block resets `consecutive_transient`**: otherwise the next
  throttle after the unblock would block the task again at once.
- `rate_limited` does not count as a failure, so a long quota window cannot exhaust the retries of a
  task that did nothing wrong. It has its own bound: `consecutive_transient` increments, the task is
  held until `cooldown_until` = now + `kanban.transient_cooldown_s` (default 300 s) × 2^(n−1), capped at
  one hour; after `kanban.transient_limit` (default 10) consecutive occurrences the task blocks as
  `transient`. Any other outcome resets `consecutive_transient`. Unbounded "it's only throttling"
  retries are how a dead endpoint burns a night.

### 8.3 Retries start fresh, and know what already happened

A retry after a failure, crash or interruption is a **new run in a new session**. Resuming a context
that just failed tends to repeat the failure; a fresh context with an account of what happened does
not.

The account is what makes this safe. The new run's context (§7.1) lists the previous attempt's
outcome and error, its last output, **and the tool calls it made** — read from that attempt's own
session event log ("edited `src/a.ts`; ran `npm test`, which failed"). A retry therefore knows what
it is retrying *after*, rather than starting from a task body that no longer describes the state of
the workspace.

`retry_on_crash` sets how far to trust that:

- **`always`** (default) — retry within the limit regardless.
- **`if-no-side-effects`** — retry automatically only if the previous run made no tool call outside
  its role's `readOnlyTools` (§2.1). Otherwise block as `needs_input` and let a person look first.
  It applies to **every** automatic retry: after `failed`, `crashed`, `timed_out`,
  `protocol_violation`, `interrupted` — and after `rate_limited` when the throttled run had already
  made tool calls before the provider refused it. A throttled run that made none has nothing to
  repeat and is simply requeued. For tasks where repeating an action is expensive: a deploy, a
  message sent, a payment.

**How this squares with G6** ("no turn is ever silently executed twice"): a retry is not a replay of
the failed turn. It is a new run, recorded as its own row, announced to subscribers, with a prompt
that says what the previous attempt did. G6 still governs the session layer exactly as before — an
ambiguous turn in a chat session holds the session and is never resent.

### 8.4 Gateway restart

Until the broker exists (architecture §4), restarting the gateway kills every running agent. Boot
runs in this order:

1. **`reconcileBoot`**, as today. It quarantines any session with a turn in `delivering`, which
   includes a kanban run's session if the restart caught a prompt mid-delivery.
2. **Findings are delivered by channel.** Today every finding is posted to Lark with the binding's
   conversation id as the chat id; for a `kanban` binding that is a task id. Findings for `kanban`
   bindings are not posted to Lark; the dispatcher handles those sessions in the next step.
3. **The dispatcher closes every open agent run.** An **undecided** one ends `interrupted`: not
   counted, because the task did nothing wrong, and claimable again subject to `retry_on_crash` — an
   interrupted run may have changed the workspace exactly as a crashed one may. The retry's context
   reports the interruption and the tool calls made before it. A **decided** one keeps its outcome
   and is only closed: the agent had reported, and the restart cost it at most the tidying it was
   doing afterwards.
4. **Every run closed at boot — interrupted or already decided — has its session archived and its
   `kanban` binding revoked**, never resumed: its run is over, and a new run gets a new session
   (§3.3). Revoking the binding is what makes a stale
   approval card for that session, still sitting in a subscriber's chat, resolve to "no longer
   bound" instead of recording an answer against an archived session.

Human runs are unaffected by a restart; they hold no process.

### 8.5 Runtime limit

An undecided run past `max_runtime_s` (default `kanban.default_max_runtime_s`, 4 h) has its turn
cancelled and ends `timed_out`, counted. A decided run past the limit is closed and keeps its
outcome. This is wall-clock regardless of activity: it exists for the run that is alive and busy and
getting nowhere, which no liveness check catches.

---

## 9. People: Lark

### 9.1 Commands

| Command | Tier | |
|---|---|---|
| `/kanban new <title>` + body lines | operate | creates a task; lines starting `assignee:`, `reviewer:`, `workspace:`, `parent:`, `outcome:`, `verify:`, `constraints:`, `boundaries:`, `stop when:` fill fields; the rest is the body |
| `/kanban list [status]` | talk | the board, by derived status |
| `/kanban show <id>` | talk | task, contract, runs, latest output, comments |
| `/kanban assign <id> <assignee>` | operate | an undecided run ends `superseded`; a decided one is closed |
| `/kanban link <parent> <child>` | operate | |
| `/kanban workspace <id> <name>` | operate | sets a task's workspace; refused once one is fixed (§2.3) |
| `/kanban comment <id> <text>` | talk | forwarded to an undecided agent run (§7.5); otherwise stored |
| `/kanban unblock <id> [comment]` | operate | |
| `/kanban approve <id>` · `/kanban changes <id> <reason>` | operate, or the named reviewer | answer a review |
| `/kanban done <id> <summary>` · `/kanban block <id> <reason>` | the assignee | report on a human task |
| `/kanban review <id> <summary> [reviewer]` | the assignee | ask for same-task review of a human task's work (§5.3) |
| `/kanban stop <id>` | operate | the run ends `cancelled`; the task blocks as `needs_input` |
| `/kanban gate add <id> <command>` | operate | |
| `/kanban archive <id>` | operate | |

- **Unknown names are refused at creation:** an unknown workspace (§2.3), and an unknown role. A
  typo in chat should fail while the person is still looking, not strand the task later.
- **Naming an assignee or reviewer:** an @-mention names a person — Lark delivers the mentioned
  user's ids with the message, so there is no name to resolve or confuse; a bare word names a role.
- **Creating a task needs operator tier** because it starts an agent, unsupervised, in a workspace —
  the same authority as running a prompt, exercised while nobody is watching.
- **A named reviewer or assignee may act on their own task with talk tier.** Being named is the
  authorization; requiring operator tier too would mean a person can be assigned work they are not
  allowed to finish.
- **`/kanban` is never refused because a chat session is busy.** It does not touch the chat session;
  it is control-plane, like `/status`.
- **`/kanban stop` blocks the task** rather than leaving it ready, because ready would dispatch it
  again immediately — the opposite of what the person asked.

### 9.2 Cards

- **A human task** is sent to the assignee as a direct message when it becomes ready: title, body,
  contract, the parents' summaries, and buttons **Done** and **Block**. A button opens Lark's input
  form for the summary or reason; `/kanban done` is the equivalent typed form.
  - **If the task was created in a group**, the group also gets one line at the same moment —
    "📋 *title* — assigned to *name*" — and nothing else: the card and its buttons go only to the
    assignee. The team sees who has what without the group filling up with cards meant for one
    person, and the assignee gets a card a busy group cannot bury. Later events on the task reach
    the group through its subscription (§9.4) as usual.
- **A review for a person** has **Approve** and **Request changes** (with a reason), sent to the
  reviewer the same way, with the same one-line notice in the originating group.
- **A blocked task** notifies subscribers with **Unblock**.

Buttons follow the approval card rules (channel spec §5): identity from the callback's operator,
never from the payload; a nonce bound to the task and run; the action re-checked against the current
run inside the transaction, so a click on a card for a superseded run does nothing and says so. A
card is redrawn with the outcome once acted on, so its buttons stop working.

**This needs two changes below the board** (plan D):

- **Sending to a person.** `SendTarget` is `{chatId, threadId}`, and the adapter sends by `chat_id`
  only. It gains a person target, sent by `union_id` — Lark's API accepts `receive_id_type` per
  message — so a direct message does not require the person to have opened a chat with the bot first.
- **Routing card actions.** `Router.onCardAction` treats every click as an ACP approval, reading
  `approvalId`, `optionId` and `nonce`, and checks operator tier before it reads the payload. Card
  payloads gain a `kind` field — `approval` (and absent, for cards already posted) or `kanban` — and
  the router **dispatches on `kind` first**, then applies that kind's authorization: operator tier
  for an approval, as today; for a kanban card, the rules of §9.1, under which a named assignee with
  talk tier may press Done.

### 9.3 Rendering

All task text — titles, bodies, summaries, comments, agent output — is untrusted: an agent wrote some
of it, and a task body can be pasted from anywhere. Markdown bodies use the answer escaper (tags
neutralized, markdown kept); labels use the full escaper; card fields that carry no formatting are
`plain_text`. The group notice names the assignee in plain text, not as an @-mention: it is a
notice, and a bot that mentions people whenever work moves trains them to ignore it.

### 9.4 Subscriptions

The chat where a task is created is subscribed to it, and to the tasks created from it. A subscriber
hears: completed, review requested, blocked (with the kind and reason), retrying after a failure,
gave up, stranded. Delivery is at-least-once with a uuid per `(subscription, event)`, so a
redelivered event is one message.

---

## 10. Security

- **Tiers.** Creating, assigning, linking, setting a workspace, unblocking, stopping, archiving,
  defining gates, and answering a review one is not the named reviewer of are operator actions. Listing, showing and commenting are talk actions. A named assignee or reviewer
  may report on, or answer, their own task.
- **Workspaces are named, never given as paths** (§2.3), so creating a task cannot aim an agent at an
  arbitrary directory.
- **Tool policies are enforced or refused, never silently ignored** (§2.2).
- **A role's `.env`** is the only file the gateway reads secrets from, and it is `0600`, never cloned,
  gitignored, masked, and given only to that role's agent (§2.5). Every agent runs as the same OS
  user, so one could still read another role's `.env` from disk; that boundary needs per-role users
  or containers.
- **Worker tokens** are run-scoped and hashed at rest (§7.2); the socket is `0600`; gates run without
  the token (§7.7).
- **Gates execute commands**, so they are operator-defined, run in the task's workspace as the
  gateway's user, and recorded with who defined them.
- **No secrets in the handoff.** Summaries, metadata and comments are durable and shown in chat. The
  worker protocol says so, and known secrets are masked (§10.1).
- **Agent-written task text cannot spoof a mention** (§9.3).

### 10.1 Masking the secrets the gateway knows

Anything an agent writes — a summary, a comment, its output — is shown in chat and, on the board,
passed to other agents. So the gateway masks **every secret value it holds itself**, replacing each
exact occurrence with `••••`:

- the Lark app secret;
- every environment value the gateway passes to an agent: every value in every role's `.env`
  (§2.5), the `MT_AGENT_ENV_*` values of the role `default` made from the `agent:` block, and the
  resolved values of each role's `passEnv` names — except names a role lists in `maskExempt`, for
  values that are long but not secret (`ANTHROPIC_BASE_URL`, `AWS_REGION`);
- every live worker token (§7.2), added when a run is claimed and removed when it closes.

Values shorter than 8 characters are not masked: an environment value of `1` or `true` is not a
secret, and masking it would mangle ordinary text. The masker is one module with one function,
`redactKnownSecrets`; the existing `mask()` in `channel/escape.ts`, which shows a secret's prefix in
a deliberate render, is a different operation and keeps its name.

**Where, and why there.** Masking is applied to **assembled** text, at the points it leaves the
gateway, and always **before escaping** — the escapers rewrite characters such as `_`, so a secret
containing one no longer matches once escaped:

1. **Inside the escapers.** `forDisplay`, `forMarkdown` and `forPlainText` call the masker before
   they escape. (`forMarkdown`, the escaper that keeps an answer's markdown, exists on the unmerged
   `lark-interaction-fixes` branch; that branch is merged before plan F, §12.) Every piece of text that reaches chat goes through one of them — card bodies, tool
   titles, errors, command replies, notifications, approval cards — and call sites already escape
   each piece before joining it into a reply, so masking inside the escaper is the one place that is
   always before escaping. This is the authoritative layer for chat.
2. **When text is composed for an agent.** The worker context (§7.1) — parents' handoffs, prior
   attempts' output and tool calls, comments — and a run's `last_output` are masked as they are
   assembled. They are built from many stored pieces, and only the assembled text is guaranteed to
   contain a secret whole.
3. **On write, best effort.** Kanban free-text fields — title, body, summary, metadata, comment
   bodies, error, `last_output` — and the string values of payloads in **both** event logs — the
   session `events` table, through `appendEvent`, and `kanban_events` — and of `approvals.payload`
   are masked before they are stored. JSON payloads are masked value by value, never as serialized
   text, because JSON escaping changes a secret containing `"` or `\` so that it no longer matches.
   Identifying values inside payloads — `approvalId`, `toolCallId`, option ids, `messageId` — are left
   alone, as identifying columns are (below).

**How a changing set reaches pure functions.** The escapers, and the renderer that calls them, are
pure functions, and that purity is a stated design property (architecture §12). The secret set is a
**process-wide registry**: filled at startup with the configured secrets, then given a worker token
when a run is claimed and relieved of it when the run closes. The escapers read it. So the
projection is **pure given the secret set** — the claim in architecture §12 is amended to say so —
and tests set the registry explicitly. A card already posted is never re-rendered because the set
changed: removing a token only means later text may show a token that no longer works.

**Streaming.** A card re-renders while an answer streams in, so a secret whose first chunk has
arrived and whose second has not would briefly show as a prefix. **Every** render therefore drops
trailing text that is a prefix of a known secret, four characters or longer. On a render mid-stream
it reappears — masked — once the rest arrives; on a final render it is a turn that ended part-way
through a secret, and dropping the fragment is the right outcome. This happens in `renderCard`, on the
raw joined message before it is escaped: it is a property of an incomplete answer, which the
escapers cannot see.

**Why write-time masking cannot be the authoritative layer:** the actor stores an agent's answer as
one event per streamed chunk, and the renderer joins them. A secret split across two chunks matches
neither stored event, yet appears whole on the card. Layers 1 and 2 mask the joined text; layer 3
only reduces how much reaches the database, which is local to the gateway's user.

**Not masked, deliberately:**

- **Identifying and executable fields** — ids, idempotency keys, workspace and assignee names, and
  gate commands. Masking a gate command would store a command that silently runs broken. A gate
  whose command contains a known secret is **refused at creation**, with a message to pass the value
  through the agent's environment instead.
- **`turn_submitted` input.** A person's prompt is what replay re-sends to the agent (architecture
  §6.3), and masking it would re-send `••••` in place of a value the person gave on purpose. It is
  still masked wherever it is *shown*, by layer 1.

**What it does not catch**, stated so it is not assumed: a secret the agent found by itself, such as a
key in a file it read; a known secret encoded or reformatted; anything under the threshold. Pattern
detection of key-shaped strings is the next step and is not in v1. This is the first, exact-match
part of the redaction pass architecture §13 describes; it protects chat sessions as well as the
board.

---

## 11. Testing

| Layer | How |
|---|---|
| Rename | the home defaults to `~/.manus-team`; `passEnv` and role `.env` refuse `MT_*` and `LARK_*` |
| Config | role directories and workspaces resolve; with no `roles/default/`, the `agent:` block and its `MT_AGENT_*` overrides become the role `default`, and apply to nothing else; both a `roles/default/` and an `agent:` block fails; neither fails; `workspace:` becomes workspace `default`; relative or missing workspace paths fail; a role with a missing or invalid `config.yaml` or an unknown workspace fails; a `tools` policy the role's agent cannot enforce fails; an unreadable `role.md` or skill fails startup and later makes the role unresolvable |
| Role `.env` | created empty and `0600` with a `.gitignore`; never copied by `--clone-from`; group- or world-readable, symlinked, or foreign-owned fails startup and `role check`, and is not chmod-ed; the format's accepted and refused lines; `MT_*`, `LARK_*` and `PATH` refused; a missing `.env` valid; values reach only that role's agent; the same variable in `.env` and `passEnv` fails; values masked |
| Role and workspace names | the grammar enforced for roles at discovery and by `role create`, and for workspaces at startup and by `workspace add` (`../x`, `A`, `a:b` refused); a workspace equal to or containing `$MT_HOME` or a relocated database refused; inside `$MT_HOME` only `workspaces/<name>` allowed; two names on one realpath, and one workspace nested in another, refused at startup and by `workspace add`; driver ids reserved; dot-entries ignored; other entries reported and ignored |
| Role and workspace CLI | `role create default` migrating a legacy `default` and printing the cutover and the `MT_AGENT_ENV_*` names; `role create` from `default` and from `--clone-from`, refusing an existing name, never copying `.env` or `MT_AGENT_ENV_*` values; `role check` reports what startup would; `role check` reporting environment-dependent results separately; `workspace add` keeps the config file's comments, refuses a name registered to another directory and a directory containing `$MT_HOME`, refuses without a config file, a name already in `workspaces:`, and `default` while `workspace:` is set; reads the database at an `MT_DB` location, and treats a missing one as empty; `--clone` uses `--`, refuses an existing target, and leaves nothing behind on failure; none of them touch the socket |
| Sessions | workspace name written to `sessions.workspace_id` at create and used on every actor rebuild; empty legacy value resolves to `default`; legacy driver id resolves to the role `default`; `sessions.agent_id` holds the role name |
| Derived status | pure function; table of phase × parents × runs |
| Transitions | every legal move, and every illegal one refused, against a real SQLite |
| Links | cycle refusal; link onto a task with an open run, or past its parents gate, refused; a dependency block's parents linked with it, from a work run (task stays open) and from a review run (task stays in review, its next review claim waiting on them) |
| Classifier | a table of real error strings → classes, including the 400 that was transient |
| Dispatcher | fake driver: claim race (two passes, one run); one open agent run per workspace, parallel across workspaces, `max_running`; workspace resolved at a claim while null — explicit, else the role's explicit one, else the parents' common one, else `default` — and reused by review, retry and later gates; `/kanban workspace` refused once the workspace is non-null; an agent claim on a task a person left null re-applies the rules; an unknown workspace refused at create; a removed workspace makes its tasks unresolvable; cooldown and doubling; stranded notice once, never for queued tasks; max runtime → `timed_out`, but a decided run past the limit keeps its outcome; a reporting run holds its workspace until it closes; dispatcher-cancel reason wins over the classifier |
| Prompt | `role.md`, skills list, protocol, task and context, in order; the run records `role_md_hash` and `agent_config` |
| Retry | `failure_limit` 2 → one retry; `gave_up` and its unblock reset; `rate_limited` not counted; `if-no-side-effects` against `readOnlyTools`; the retry's context containing the previous run's tool calls |
| Review | reviewer `changes` → rework run seeded from the work run when their `agent_config` matches, unseeded otherwise; a failing review run counted and retried; `review` with no reviewer refused |
| Worker CLI | handler tests over JSON; token scope; `already_reported`; `run_superseded`; gates refusing completion; gates not seeing the token |
| Nudges | an agent that stops without reporting, then reports after one nudge; one that never does; distinct keys per submission; a comment replacing a nudge |
| Restart | `reconcileBoot` then `interrupted`; a decided-but-open run keeps its outcome; kanban findings not posted to Lark; the old session archived |
| Lark | tiers: a named assignee or reviewer acting with talk tier, a non-reviewer needing operator tier to approve, assigning to a person without talk tier refused; `/kanban review` from a human assignee, refused with gates while the workspace is null; `/kanban stop` on a decided-but-open run; `/kanban assign` mid-run; @-mention vs role assignees; person targets; the one-line group notice for a human task created in a group; card `kind` routing; a click on a superseded run's card refused |
| Masking | a known value masked through each escaper, in composed worker context and `last_output`, and in stored free text and JSON string values; **a secret split across two message chunks masked on the card**; a secret containing `_` masked before escaping, and one containing `"` masked inside JSON; values under 8 characters and `maskExempt` names left alone; a worker token masked only while its run is open; `turn_submitted` input stored unmasked but shown masked; a gate containing a secret refused; a render withholding a trailing prefix of a secret, mid-stream and on a turn that ended part-way through one; ids inside payloads left unmasked; the registry gaining and losing a worker token with its run |
| Reported commit | clean tree → commit; dirty tree → commit plus "uncommitted changes"; not a repo → "uncommitted"; recorded for a reviewer agent's `complete`, never for a person's report |
| Workspaces | a name registered on first sight; a known name repointed to another directory fails startup; no workspace `default` fails startup; a downstream review task inherits its parents' common workspace, a role with its own workspace does not; an unclaimed archived parent ignored; parents in different workspaces make an agent task unresolvable, while a human one is claimed with a null workspace, has gated completion refused, and can then be given one by `/kanban workspace`; a worker-created follow-up uses its creating task's workspace without a link and is claimable at once; an agent claims a workspace while a person's review on another task there is open; a person's run leaves the workspace null and a later agent review claim re-applies the rules |
| End to end | the fake CLI agent calling `mt kanban complete` through the real socket |

---

## 12. Plans

Separate implementation plans. Each ends with everything built so far working and tested. Order: A, A2, B, F, C,
D, then R; E is independent once B is done. B is delivered as B1 (roles and workspaces in
configuration), B2 (the session layer) and B3 (the `mt` commands). C is delivered as C1 (the board),
C2 (agent runs), C3 (the worker CLI) and C4 (review, rework and gates), in that order. **Before F**,
the `lark-interaction-fixes` branch is merged: F changes the escapers, and `forMarkdown` is on that
branch.

| Plan | Contents | Depends on |
|---|---|---|
| **A. Rename** | the repository to `manus-team` (§13) | — |
| **A2. Finish the rename** | the environment variables renamed to `MT_*` in configuration, tests and docs; the home default `~/.manus-team`; `passEnv` refusing `MT_*` and `LARK_*`; `src/identity.ts`'s comment (§13) | A |
| **B. Roles and workspaces** | role directories (`config.yaml`, `role.md`, `skills/`, `.env` with its safeguards) and `workspaces:`, with the legacy `agent:` / `workspace:` as `default`; the `mt` binary and its `mt role` and `mt workspace` commands; a driver per role; `sessions.agent_id` as the role name; a workspace per session; `StartOptions.env`; a channel per binding; seeding a session's provider session id; tool-policy enforcement check; the README's credentials rule (§2) | A2 |
| **C1. The board** | migration `003`, with every kanban table (§3); the one stored phase with one writer, and the derived display status (§4.1); transitions (§5.1); assignees (§4.2); the completion contract (§4.3); follow-ups (§4.4); blocking and unblocking (§5.4); resolving a task's workspace at a claim (§2.3); run rows and their outcomes, without agents; with F's masker, masking kanban free text and `kanban_events` on write (layer 3); the service API the later plans call. No agent runs and no socket | B, F |
| **C2. Agent runs** | the dispatcher — passes, the per-workspace limit, `max_running`; a run as a session on the sink channel; prompt composition, with F's masker on the composed worker context and `last_output` (layer 2); how a run ends; the failure classifier; retries; restart handling and the runtime limit (§6, §7.1, §7.4, §8) | C1, F |
| **C3. The worker CLI** | the run's token, added to F's masker when the run is claimed and removed when it closes, reference-counted so that removing it never unmasks a configured secret with the same value; the `0600` socket; the `mt kanban` commands; stop nudges; reports after the run is closed (§7.2, §7.3, §7.5, §7.6) | C2 |
| **C4. Review, rework and gates** | same-task review and rework, quality gates, the reported commit (§5.3, §7.7, §7.8); refusing gates that contain a known secret; a crash handler whose output is masked | C3 |
| **D. Lark** | `/kanban` commands; person targets; card `kind` routing; task, review and blocked cards; the group notice; subscriptions | C4 |
| **E. Native resume** | the CLI driver captures the provider session id and passes `--session` (architecture §6.3), with transcript replay as the fallback | B; independent of C and D |
| **R. Native rendering** | starts with a spike: where `bytesec run --agent` looks up a package (the workspace's `apm/packages/`, or a global install), so rendering never writes into a workspace repository. Then a renderer per coding agent: for bytesec, a role becomes an agent package — `role.md` as `agents/<role>.md` (`mode: primary`), its `skills/` copied — in a directory the gateway manages, run with `--agent`; Claude Code's later. Prompt injection (§7.1) stays the fallback for an agent with no renderer | B2 |
| **F. Masking** | the registry and `redactKnownSecrets` (§10.1); masking inside the escapers (layer 1); trailing-prefix withholding in `renderCard`; masking session `events` and `approvals.payload` on write (layer 3). The kanban parts land in C1 (layer 3), C2 (layer 2) and C3 (worker tokens) | B (the resolved agent environments); best done before C, since it protects chat sessions too |

Until plan D, nothing can deliver a card to a person, so **plan C refuses human assignees and
reviewers** at creation and in `mt kanban review`, and **refuses roles whose agent is supervised**,
whose approval cards would have nowhere to go until subscriptions exist. C's kernel implements and
tests human runs and approval forwarding through its service API, and D turns them on.

Nor can a person create a task before D: `/kanban new` arrives there, and every `mt kanban` command
needs a run's token. C does **not** add a token-less way in. Agents run as the gateway's own user, so
a command that trusts "whoever can reach the socket" would trust every agent, and let any of them act
as an operator. C is therefore proven by its service API and its end-to-end tests — a fake agent
running a real task through the real socket — and the board becomes usable by people in D.

Plan E makes nudges cheaper and lets rework resume the implementer's conversation; without it both
still work (§5.3, §7.5). Worktrees are architecture milestone 9 and a separate project; they lift the
per-workspace limit (§6.3) and should follow these plans directly.

---

## 13. The rename

The repository is **manus-team**: the team is the concept — people and roles assigned work on one
board — and Kanban is the board inside it. It is done first, before any kanban code, so that the
spec, the migration and the CLI start under the final name and nothing is renamed twice.

- **Plan A** renamed the product: the repository, `package.json`, the README and docs, schema header
  comments, and the names the gateway identifies itself by to Lark and to agents, which come from
  one constant.
- **Plan A2** renames everything a deployment depends on: the environment variables become `MT_*`,
  the home `~/.prime-gateway` becomes `~/.manus-team`, and the CLI — not yet built — is `mt`.

**No transition.** The old names are not read. There was one deployment, its environment set none
of the old variables, and its home was moved to `~/.manus-team` (with the gateway stopped and the
database checked) before this change. Keeping two names alive would be complexity with no user.

`LARK_*` variables keep their names: they belong to the Lark integration, not to the product. The
CLI is `mt`; on some systems `mt` is also a tape-drive utility, and agents always get the gateway's,
because its directory is first on their `PATH` (§7.2).

---

## 14. Corrections to `architecture.md`

Made in the same change as this document:

- **§1 Non-goals** said the gateway does not schedule work. Agents' *internal* fan-out is still not
  scheduled; work assigned on the board is (§17).
- **§6.3** said `bytesec run --session` does not continue a conversation. On 0.7.4 it does — a second
  run with `--session <id>` recalled a fact given only to the first.
- **Throughout**, the environment variables are `MT_*`, the home is `$MT_HOME` and the design
  identifiers use `mt/`, after the rename (§13).
- **§13** marks the first part of its redaction pass — exact-value masking — as designed (§10.1),
  and names a role's `.env` as the one file the gateway reads secrets from (§2.5).
- **§14, §15, §17, Appendix A** gain the kanban failure modes, milestone, summary and terms.

---

## 15. Resolved questions

Recorded so the reasons are not lost:

1. **Should a person's review hold the workspace?** No. A human run has no time limit, and a held
   workspace would stop every agent in it for as long as the person took. The person reviews the
   reported commit instead (§6.3, §7.8).
2. **Should gates be denied network access?** No. Gates are operator-chosen commands; denying the
   network breaks ordinary gates and has no portable implementation (§7.7).
3. **Redaction.** Exact-value masking of the secrets the gateway holds, in v1, on log writes and sends
   (§10.1). Pattern-based detection is later.

No questions are open.
