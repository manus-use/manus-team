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

**Any work, not only code.** A task can be research, writing a document, an operation in Lark, an
ops chore, or a change to code. A role's agent is a coding-agent CLI, used as a general worker with
a shell and tools. A workspace is a directory, which need not be a git repository. Gates (§7.7) are
optional checks of any kind: any command that exits 0 when the work is acceptable, such as a script
that checks a document exists or a link answers. The reported commit (§7.8) is recorded only when
the workspace is a git repository. Where this document's examples say "implementer", they mean
whoever does a task, and review (§5.3) applies to any work.

**Out, each with the seam that keeps it cheap later:**

| Deferred | Seam |
|---|---|
| Templates and workflow definitions | A template is a function that creates tasks and links. Nothing in the kernel knows about templates, so adding them touches no table |
| Automatic decomposition by an agent | A decomposer is just a task assigned to a role that calls `mt kanban create`. The CLI already allows it |
| A judge model ("is this really done?") | Completion contracts and gates (§4.3, §7.7) carry the acceptance criteria; a judge would read the same fields |
| Tenants; projects with operators and roles of their own | Boards (§16) are queues, not permissions: each task records its board. Who may act on a board, and which roles it may use, would be checked per board in the service, beside the tiers (§16.9) |
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
role grammar: `^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$` — lowercase, so `Reviewer` and `reviewer`
cannot both exist; no `/`, `.` or `..`, so a name can never leave the roles directory; no `:`, so a
role can never be mistaken for a person's principal (`lark:…`); and no `-` at the end, so a role's
name is also a valid bytesec agent package name (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`), which native
rendering (§2.7) names its package after. At most 40 characters. Entries starting with `.` (`.git`,
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
anything in the file that looks like a credential: secrets go in the role's `.env` (§2.5). Four
more, all optional:

- **`readOnlyTools`** — the agent's tool names that only read. Used by
  `retry_on_crash: if-no-side-effects` (§8.3). A tool not on the list is treated as having side
  effects; an empty or missing list means every tool call counts. Tool names belong to the vendor —
  a `tool-call` event carries only the agent's own title — which is why this is set per role's
  agent, not globally.
- **`maskExempt`** — environment variable names whose values are not secret, so the masker
  (§10.1) leaves them alone.
- **`native`** — `false` keeps the role's `role.md` and skills in the task prompt (§7.1) even though
  its agent has a renderer (§2.7). Unset, or `true`, a role whose agent has one runs natively.
- **`skills`** — user-level skills the role imports by name, such as `[lark-doc, lark-im]` (§2.2).

The gateway's legacy `agent:` block accepts `readOnlyTools` and `maskExempt` too, so a deployment
that has not moved to `roles/` gets the same behaviour. It does not accept `native` or `skills`: its
role has no `role.md` and no skills, so there is nothing to render or add to.

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
- a skill named in `agent.skills` that is not found, is not a name bytesec's skill-name rule
  accepts, or is also one of the role's own skills (§2.2);
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
tests before you report"). Delivered by the gateway at the head of every task prompt (§7.1), or, for
a role whose agent has a renderer, as that agent's own system prompt (§2.7). It is not a personality
or an identity, and nothing reads it as one: it is text the agent is given, which is also why it
works with any agent.

**Skills.** A skill is a directory, `skills/<name>/`, holding a `SKILL.md` whose front matter gives
a `name` — the same as the directory's — and a one-line `description`; anything else the skill
needs (`references/`, scripts) sits beside it. That is the format bytesec agent packages and Claude
Code both use, so a skill written once works with either, an existing bytesec skill can be copied in
unchanged, and a renderer can install skills natively (§2.7). For a role whose coding agent has no
renderer, or which opts out, the task prompt **lists** each skill's name, description and the
absolute path of its `SKILL.md`, and the agent opens a skill when it is relevant. That keeps skills
from spending the context window until they are needed, and works with any agent that can read a
file.

**Imported skills.** A role may also use skills from the user's own, by name: `agent.skills:
[lark-doc, lark-im]`. A native agent sees only its package's skills (§2.7), so this is how a role
keeps a user skill it needs. Each name is looked up where bytesec 0.7.4 finds a user's skills, in
the order that finds the one bytesec itself would use (it loads them in the reverse order, and a
later skill of a name replaces an earlier one): `$XDG_CONFIG_HOME/bytesec/skills` (else
`~/.config/bytesec/skills`), the same directory's `skill/`, then `~/.trae/skills`,
`~/.coco/skills`, `~/.agents/skills` and `~/.claude/skills`. `~/.bytesec/skills` is not searched:
bytesec reads it only under `--expose-user-skills`. The first real directory holding a regular
`SKILL.md` wins; a symlink is not followed. A name must follow bytesec's skill-name rule (lowercase
letters, digits and single `-`, not at either end, at most 64 characters); a name that is not found,
or is also one of the role's own skills, is a startup error naming the role. An imported skill is
checked as the role's own are and then treated exactly as they are: listed in the prompt at its
user path when the role is injected, copied into the package when it is rendered.

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
- **Workspace names follow the role grammar** (§2.1): `^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$`. A name becomes a
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
   is how a run's `MT_KANBAN_*` variables (§7.2) reach the agent. Plan R adds `args` beside it, in
   `StartOptions` and `SessionActorDeps`, the same way: extra arguments for the session's agent,
   which the structured-CLI driver puts after the configured `args` and before its own flags, and
   which the ACP driver refuses. The registry asks for them with `argsFor`, after `envFor`. They are
   how a native run's `--agent <role>` reaches its agent (§2.7).

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

  When the check passes it also says, one line a role, whether the role's runs are rendered
  natively (§2.7), and if not, why: `native: role implementer runs as a bytesec agent package`, or
  `native: role default does not: it has no role.md and no skills`.
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
- **The one exception: `mt kanban gate add|list|remove`** (§7.7). They write the board's database,
  beside a running gateway, through the board's own service (`KanbanService`), which stays the only
  user of `db/kanban.ts`; SQLite's WAL mode and busy retry let the two processes share the file. They
  take effect at once. They refuse to run when `MT_KANBAN_RUN` or `MT_KANBAN_TOKEN` is set, so an agent
  does not define gates by accident; that is not a security boundary, since an agent runs as the same
  user and could unset them, as it could edit `config.yaml` or a role's files.
- Not taken from comparable tools, deliberately: a role is not its own command (roles are run by the
  board, not by hand); a role has no memory of its own (each vendor agent keeps its own); a role has
  no bot token or gateway of its own (there is one gateway).

### 2.7 Native rendering (plan R)

A role whose coding agent has a **renderer** is delivered to that agent in the agent's own format:
`role.md` as its system prompt, its skills through the agent's own skill loading. The task prompt
then leaves both out (§7.1), so they are not sent twice. In v1 only bytesec has a renderer; Claude
Code's comes later behind the same interface. Every other agent keeps prompt injection, which stays
the fallback.

- **Which roles.** A role is rendered when all of these hold: its agent is **bytesec** — driver
  `structured-cli` and a command whose basename is `bytesec` (the structured-CLI driver speaks only
  bytesec's `run --format json`, and a wrapper with another name may not pass `--agent` or the
  environment on); it has a `role.md` or at least one skill; it does not set `agent.native: false`;
  and bytesec's renderer does not refuse it. The renderer refuses a role named `bytesec-agent`
  (bytesec runs its built-in agent under that name), a role whose `agent.args` already pass
  `--agent`, a role whose environment already sets `BYTESEC_LOCAL_APM_PATH` or
  `OPENCODE_LOCAL_APM_PATH`, in its `.env` or through `passEnv`, and a role with a skill whose name bytesec's own skill-name rule refuses
  (lowercase letters, digits and single `-`, not at either end, at most 64 characters). The role
  `default` made from the `agent:` block has no `role.md` and no skills, so it is never rendered.
  **Chat sessions are never rendered**: rendering is per kanban run, and chat never received
  `role.md` either.
- **What a role becomes.** A bytesec agent package, laid out as a real one is: `apm.json`
  (`{"name": "<role>", "description": "...", "source": "default", "path": ""}`), `agents/<role>.md`
  (front matter `name`, `description`, `mode: primary`, then the `role.md` bytes the claim read,
  unchanged), and `skills/<skill>/…`, every regular file of each of its own skills and of each skill
  it imports.
- **Where, and when.** Just after the claim, from the same `role.md` bytes the claim hashed, into
  `$MT_HOME/rendered/<role>/<hash>/`, which is itself the package. It is inside the gateway's home,
  so never in a workspace (§2.3: no workspace may contain the home, and inside it only
  `workspaces/<name>` may be one), and nothing is ever written into a repository. The hash is of the
  package's own files — paths and bytes — so it covers `role.md` and every skill file, imported ones
  included, so a changed user skill makes a new package: runs on
  different versions of a role's files get different directories, and a finished package is reused,
  never rewritten. It is written in a dot-directory and renamed into place, with `0700` directories
  (forced on ones that already existed) and `0600` files. Only regular files are copied, never a
  symlink, and never a `.env`; a `SKILL.md` that is not a regular file fails the render. A package
  over 16 MiB or 2,000 files fails it too, counted while the skills are walked, before each file is
  read.
- **How the run uses it.** The run's environment gains `BYTESEC_LOCAL_APM_PATH=<package dir>`, and
  its agent's arguments gain `--agent <role>`, both held by the dispatcher with the rest of the run's
  environment (§2.4 item 3). Each run points at its own role's single package: bytesec 0.7.4, pointed
  at a directory of packages, exits 1 and prints nothing. `BYTESEC_NO_GLOBAL_APM` is not set.
- **Old packages.** When a role is rendered, its other packages are removed, except those of runs
  still open; so a role keeps its newest package, and every running agent keeps its own. At boot,
  when nothing is open, the packages of roles no longer configured, and any half-written one, are
  removed.
- **Failure falls back.** A render that fails — the disk, permissions, a package too large — is
  noted in the log, and the run goes on with `role.md` and the skills in its prompt. The files were
  readable at the claim, so the run can still be told everything, and failing it would count a disk
  problem against the task's `failure_limit`. A sweep that fails is noted and changes nothing else.
- **What `mode: primary` does to bytesec's own instructions.** Read from bytesec 0.7.4's code: the
  agent file's body takes the place of bytesec's default identity paragraph in the system prompt;
  bytesec's provider prompt, its tool and workspace guidelines and its environment section are kept
  around it. `mode` only says the agent may be run directly. Behaviour on real coding tasks under a
  `role.md` persona is not yet measured, so `agent.native: false` is the operator's escape hatch.
- **A native agent sees only its package's skills.** bytesec gives a package's agent the skill
  permission `{"*": "deny", <the package's own skills>: "allow"}` and shows it only skills inside
  the package. So a native run cannot use the user's skills or the workspace's, though bytesec still
  loads them (the spike saw `bytedcli` loaded); `BYTESEC_NO_GLOBAL_APM` changes what is loaded, not
  what the agent may use, and is not set. `agent.skills` (§2.2) is how a role brings user skills in.
- **Limits, stated so they are not assumed.** `bytesec agent list` does not
  show a package given by `BYTESEC_LOCAL_APM_PATH`, so the gateway cannot verify a render by listing
  it. A bytesec that no longer finds the package fails the run's turn, which is classified like any
  other failure (§8.1); the fallback covers a render that fails, not an agent that rejects it.
- **The run's record.** A run records the hash of the `role.md` it was given (§3.3), as before. Its
  `agent_config` is taken at the claim; once the render is decided, the dispatcher adds
  `native: true` and the package's `packageHash`, or `native: false`, through `KanbanService`, with
  `db/kanban.ts` as the only writer, once, with a `run_rendered` event. It is there, not in a new
  column, because it is part of the agent the run ran, needs no migration, shows in the run's read
  type, and is what seeding compares: a rework (C4) or a resume (plan E) is seeded only from a run
  with the same native-ness and package hash. A run with neither key, claimed before plan R, counts
  as not native.

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
| `board` | migration `006`: the board the task is on (§16), `default` for every task before it; set at creation, never changed |

- **`idempotency_key` is unique** because creation is retried by everything that can create: Lark
  redelivers a message, and an agent re-runs a command whose output it did not see. A repeated
  create with the same key returns the existing task instead of a second card.
- **`consecutive_failures` and `block_recurrences` reset only on success**: completion resets both,
  and work handed to review resets `consecutive_failures`; with one deliberate exception for
  `gave_up` (§8.2). Resetting `block_recurrences` on unblock is the amnesia that lets
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
| `reported_commit`, `reported_dirty` | for an agent's `complete` or `review` report: `HEAD`, and whether the tree had uncommitted changes, at the moment of the report (§7.8); in a repository with no commit yet, or when git fails, no commit and `reported_dirty` true; both null for a person's report, and for a workspace that is not a git repository or where git is not installed |
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

- **`kanban_comments`** — `task_id`, `author`, `body`, `created_at`, and `steers` (migration `004`,
  default 1): whether the comment may steer an agent (§7.5). Every writer says which: the service's
  `comment` has no default for it. The conversation between the agents and
  people on a task. A retry reads the whole thread of comments that steer; people see every one.
- **`kanban_gates`** — `task_id`, `command`, `timeout_s` (default 300, at most 600), `created_by`,
  `created_at`. Shell commands that must exit 0 before the task may complete or go to review (§7.7):
  at most 20 on a task, taking at most 600 s together. Stored as written, never masked (§10.1); added
  and removed by an operator, each with an event.
- **`kanban_subscriptions`** — `task_id`, the channel binding key (channel, app, chat, thread),
  `cursor` (last `kanban_events.id` delivered), indexed by `account_id` (migration `004`) for the
  notifier's read of one bot's subscriptions. The same cursor discipline as a binding's
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
  accident. The tiers are decided by `open_id` and the board knows a person by `union_id`, so from
  plan D2 the gateway keeps a `people` table (migration `005`, written only by `db/people.ts`): the
  `open_id` and name Lark last gave with each `union_id`, noted for each `/kanban` sender, each
  person a `/kanban` command mentions, and each person who presses a board card's button. A person
  named by principal alone — typed out in chat, or in an agent's `mt kanban create` or `review` —
  is checked through the `open_id` last seen with it; a principal the gateway has never seen cannot
  be checked, and is refused.
- **Unassigned, or an assignee that does not resolve** (a role whose directory was removed or is
  now invalid, a role whose files cannot be read, a person the channel cannot reach), **or an agent task whose fixed
  workspace was removed from config**, or whose parents are in different workspaces and none was set
  (§2.3). Neither workspace case holds a human task (§2.3, §7.7). The task stays ready and a `skipped_unassignable`
  event is written once. It is never silently dropped and never sent to a fallback assignee, which
  would run work under an identity nobody chose. Once it has been ready and unclaimed for
  `kanban.stranded_after_s` (default 30 min, measured from when a pass first found it ready and
  unclaimable — its `skipped_unassignable` event — with nothing written on the task since: most events
  that make a task ready are on other tasks, or are no event at all, such as a cooldown ending), its
  subscribers are told it is stranded and why, once — `stranded_notified_at` records that the notice
  is due: the `stranded` event written with it is what the subscriptions deliver (§9.4). Only tasks that *cannot* be claimed are stranded; a ready task waiting its turn behind
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

For a task that went through review, the handoff its children are given is the implementer's — the
summary and metadata of its latest work run that ended `review_requested` — not the reviewer's
approval.

---

## 5. Lifecycle

### 5.1 Transitions

| From | Event | To |
|---|---|---|
| (new) | created | `open` |
| `open` (ready) | claimed | `open` (running) — a `work` run is opened |
| `review` (no open run) | claimed by the reviewer | `review` (reviewing) — a `review` run is opened |
| `open` (running) | `complete`, the task naming no reviewer | `done` |
| `open` (running) | `complete`, the task naming a reviewer | `review` — taken as a `review` with the same handoff; the work run ends `review_requested` (§5.3) |
| `open` (running) | `review` | `review` — the work run ends `review_requested` |
| `review` (reviewing) | reviewer `complete` | `done` |
| `review` (reviewing) | reviewer `changes` | `open` (ready) — the next claim is rework (§5.3) |
| `review` (reviewing), a role's undecided review run | an operator's `/kanban approve` | `done` — the review run ends `superseded` in the same transaction, and its turn is cancelled |
| `review` (reviewing), a role's undecided review run | an operator's `/kanban changes` | `open` (ready) — the same, and the next claim is rework |
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
button, and `/kanban approve`. On a task that names a reviewer, the first three, from the work,
ask for review instead (§5.3). A person cannot complete or approve a task **while an agent run is open
on it** — because gates would run against a checkout that agent is still changing, and the agent's
own later report would contradict the person's. If the run is undecided, the refusal says to
`/kanban stop` it first; if it has already reported and is finishing, the refusal says to wait for it
to finish.

The one exception is **an operator answering a role's review**: `/kanban approve` or
`/kanban changes` by an operator, on a task in `review` whose open run is a role reviewer's and
still undecided, takes the review from it. The answer's transaction ends that run `superseded`,
and chat then cancels its turn, as `assign` and `stop` do; anything the reviewer reports later is
refused `run_superseded`. A reviewer does not change the work under review, so its checkout is the
one the answer's gates test, and the operator's answer is the one recorded. Only an operator may do
this, only for a role reviewer's run — a person reviewer's run is decided by the answer, as before —
and never an assignee. A run that has already reported is waited for, as above.

### 5.2 Run outcomes

| Outcome | Meaning | Breaker |
|---|---|---|
| `completed` | reported `complete` | resets |
| `review_requested` | reported `review` | resets |
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

**A named reviewer is never skipped.** A task that names a reviewer — on its `reviewer:` line, or
from an earlier `review` that named one — is reviewed on the task. Its work run's prompt names the
reviewer and says to report `review` (§7.1). A `complete` from its work — an agent's, or its person
assignee's `/kanban done` or Done — is taken as a `review` request with the same handoff: the task
enters `review`, the run ends `review_requested`, the notices say "review requested", and the
answer says it was sent for review. Its gates run once, as for a review. So a rework's `complete`
goes back to review too: the reviewer who asked for changes sees them. Only the reviewer's
approval, or an operator's, completes such a task. A task that names no reviewer completes on
`complete`, and its implementer may still ask for review, naming a reviewer.

**Never both.** An implementer that requests same-task review when a downstream review task exists
leaves the downstream task waiting on a parent that is not done, so the review happens twice or not
at all. The worker protocol (§7.1) says so — for a task that names no reviewer, if one of its
children reviews it, report `complete` — and the worker context lists the task's children so the
worker can see which model applies. The board cannot tell a child that reviews from any other
child, so a task that names a reviewer **and** has a downstream review task follows its named
reviewer: its `complete` goes to that reviewer, and the downstream task is released once they
approve. The review then happens twice, never not at all; that is the cost of configuring both,
and the guide says to choose one.

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
null — the column names the run whose provider session the rework's session was seeded with, not the one before. It is set when
the claim seeds the run, and stays set even when the agent then refuses the seed and the rework replays or starts fresh, which its
session log says (a known limitation). A failed or crashed run is the
opposite case, and starts clean (§8.3).

The claim can compare only the agents: how the rework's role reaches its agent (§2.7) is decided by
the render just after it. So the seed is settled when the render is recorded, before the session is
created: it is kept only if the work run was given its role the same way — natively from the same
package (`packageHash`), or both in the prompt; a run from before plan R counts as not native — and is
dropped otherwise. A `role.md` edited between the two runs gives the rework a new package, and so a
fresh conversation: resuming under another system prompt would mix two sets of instructions.

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
`kanban.block_recurrence_limit` (default 2, at most 100, set in the file only, from plan D1) the
notification changes: it says the task keeps blocking for the same reason and suggests rewriting
it, instead of inviting another unblock.

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

The `kanban.*` settings this document names are set in the config file only, with no environment
overrides: a run's own environment is `MT_KANBAN_*` (§7.2), and a gateway setting under that prefix
would read as one of a run's variables. They are spelled as this document spells them, in snake_case,
while the rest of the file is camelCase.

### 6.2 A pass

1. Collect claimable tasks with **no open run of any kind**: **ready** (§4.1) for work, **review**
   for review. A task whose previous run has reported but not yet closed is skipped until it closes;
   claiming it would only fail on the one-open-run index (§3.3). Order by priority, higher first, then
   age, oldest first, within each board; across boards, take them in turn (§16.7).
2. Skip any whose `cooldown_until` is in the future, whose assignee (or reviewer) does not resolve
   (§4.2), or — for an agent run — whose workspace already has an open agent run (§6.3), or when
   `kanban.max_running` agent runs are open, or its board's own `max_running` of them (§16.6).
3. Claim, in one transaction: if the task's workspace is null, resolve it by the rules of §2.3 — which
   may leave it null for a person — then insert the run and write `claimed`. The case where an agent
   task's workspace cannot be resolved is caught by step 2 as unresolvable, before any claim, so an
   agent claim never inserts a run and then backs out. The partial unique index makes a second claim fail.
4. Start it: §7 for a role, §9.2 for a person.

### 6.3 One agent run per workspace

Two agents editing one checkout overwrite each other without either noticing. So **a workspace has
at most one open agent run at a time.** Tasks in different workspaces run in parallel, up to
`kanban.max_running` (default `maxLiveSessions`, which already caps live runtimes — a run is a
session, and the two limits must not disagree, so a `max_running` above `maxLiveSessions` is refused at
startup). Human runs are not limited.

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
`approvalId`. As plan D2 builds it, the forwarded card names the task ("Task `k_…`, *title*, asks:
…"), is answered at operator tier as any approval card is, and is redrawn where it went once
answered. A task nobody follows has nobody to ask: the send fails, and the agent is released as
cancelled. An unanswered approval counts toward the run's `max_runtime_s` like the rest of its turn.

The task prompt is composed, in this order, of:

1. **The role** — the role's `role.md`, if it has one.
2. **The skills** — for each of the role's skills, its name, description and the absolute path of its
   `SKILL.md`, and the instruction to read one when it applies.

   For a role whose coding agent has a renderer (§2.7), `role.md` and the skills are delivered in
   the agent's own format instead — `role.md` as its system prompt, the skills through its own skill
   loading — and are left out of the task prompt; everything from the protocol on is unchanged. A
   role that sets `agent.native: false`, or whose render fails, gets them here instead.
3. **The protocol** for the run's kind. It comes after `role.md` and says it takes precedence:
   a role's instructions may shape *how* work is done, not whether it is reported. That precedence is
   an instruction to the model, not something the gateway can enforce; the nudges (§7.5) and the
   `protocol_violation` outcome are what catch a `role.md` that talks an agent out of reporting.
   - *work*: you have one task; orient by reading the context below; do the work — the current
     directory is the task's workspace, for any files the work needs; report through `mt kanban`,
     and exactly one terminal report — `complete`, `review` or `block` — ends your run; when the
     task is done, the summary says what was done and where its results are, such as files,
     documents or links; block only on genuine ambiguity, and say why; if the task names no
     reviewer and a downstream review task exists, `complete` rather than `review`; if you find follow-up work, create a task for it rather than
     doing it; never put secrets in a summary, metadata or comment; stop once you have reported.
   - *review*: review the handoff, given in its own section of the context ("The handoff, from
     …"), and the work it describes, against the task and its contract; that work is in the
     workspace (the current directory) and in anything the handoff points to, such as documents,
     links or messages — or, when there is no such section, review the latest attempts and the
     workspace; do not change the work under review; report `complete` to approve or `changes` with
     a specific, actionable reason; `block` only for a problem the assignee cannot fix.
4. **The task** — title, body, contract, for a work run on a task that names a reviewer the reviewer
   and that its work is reported with `review`, not `complete` (§5.3), the task's gates (§7.7), one line each with its timeout, and
   the result of the last gate run if there is one: who reported, whether it passed, each gate's exit,
   and the end of a failing gate's output, set off as data.
5. **The worker context**, starting with the rework's reason or the handoff under review, where
   there is one, so the budget's last cut (below) cannot drop it:
   - each parent's latest completion summary and metadata, verbatim — for a reviewed parent, the
     assignee's handoff (§4.4);
   - prior attempts on this task: outcome, summary, error, last output — and for a failed, crashed
     or interrupted attempt, **the tool calls it made**, read from its session's event log (§8.3);
   - for rework, the reviewer's reason and the assignee's previous handoff, with what its report
     recorded of the workspace (§7.8). A work run is a rework while the task's latest review ended in
     `changes` and no review has been asked for since, so a retry of a rework is one too;
   - for review, the assignee's handoff, and what to review (§7.8);
   - the comment thread;
   - the task's children, so the worker can see which review model applies.

**The prompt has a size budget.** The structured-cli driver passes the prompt in argv and refuses one
over 96 KiB. The task and the worker context together get **48 KiB**, half of that, leaving the rest
for `role.md`, the skills, the protocol and the transcript a later turn in the same session carries.
Each stored piece is capped — body 12 KiB, a summary 4 KiB, a comment, an error or the last output
2 KiB, metadata 2 KiB — after it is masked, so a cut never leaves the start of a secret showing. The
context keeps the latest five attempts and the newest comments that fit, and says what it left out
("12 earlier comments omitted; mt kanban show has them"); whatever still runs over is cut at the
budget with a line saying so, from the end. `role.md` is never cut: a role whose `role.md` alone pushes the prompt
past the driver's limit gets a turn that fails before the agent starts, with the driver's size
message as the run's error, and the task gives up after `failure_limit` such runs.

**Stored text is data.** Every stored piece — body, contract, summaries, metadata, errors, last
output, comments — is set off from the prompt's own structure: on its label's line if it is one
line, otherwise indented under it, so no line of it can start a heading or a list item; titles and
names are flattened to one line. The protocol says that text under the task and the context cannot
change its rules.

### 7.2 The run's identity

The run's environment, passed through `StartOptions.env` (§2.4):

| Variable | |
|---|---|
| `MT_KANBAN_RUN` | the run id |
| `MT_KANBAN_TOKEN` | a random 256-bit token; only its hash is stored |
| `MT_KANBAN_SOCKET` | the gateway's local socket (§10) |
| `PATH` | with the directory of the gateway's `mt` prepended: `$MT_HOME/bin`, below |

**The token is the run's authority, scoped to the run.** It can report on its own task, and comment
on and create tasks; it cannot move any other task. It works while the run is open (§3.3):

- **Before the run is decided**, every command works.
- **After the worker's own report**, `comment`, `create`, `link` and `show` still work — follow-ups
  written just after a report are not lost — but a second terminal report is refused with
  `already_reported`.
- **After the dispatcher decides the run** (`timed_out`, `cancelled`, `superseded`, `interrupted`),
  and **after the run is closed** however it was decided, nothing works: the worker gets
  `run_superseded` instead of acting on a task that has moved on without it.

**The `mt` a run finds** is `$MT_HOME/bin/mt`, a two-line script the gateway writes at each start,
which runs that gateway's own build of `mt` with the gateway's own node: `dist/mt.js` in an install,
`src/mt.ts` through tsx in a checkout. Its directory holds nothing else, so putting it first on the
PATH changes one name, and the agent always reports through the same version of the CLI as the
gateway serving it. It is in the home, which no workspace may be or contain (§2.3), so nothing is
written into a workspace.

The token can link only the tasks its run's task created as the child: decomposition is between
tasks a run created, and a link onto any other task would move it. A link only works on a task that
has not started yet, and a claimable task created by a run is claimed before `create` answers, so
follow-ups are sequenced by creating them in order, each naming the earlier ones in `parents`.

**This is cooperative scoping, not confinement.** Every process the agent starts inherits the
environment, and the token with it. A malicious workload in the workspace could use the token, within
its scope, for as long as the run lives. The socket is created `0600`, so only the gateway's own user
can connect at all; that, not the token, is the boundary between users.

### 7.3 `mt kanban` — the worker CLI (new)

The `mt` binary arrived in plan B, with the `mt role` and `mt workspace` commands; the socket and
`mt kanban` arrive in plan C3 (§12).

```
mt kanban show                      # this task + worker context, as JSON
mt kanban complete   < handoff.json # {summary, metadata}
mt kanban review     < handoff.json # {summary, metadata, reviewer?}
mt kanban changes    < reason.json  # reviewer only: {reason}
mt kanban block      < block.json   # {kind, reason, parents} — parents for kind dependency (§5.4)
mt kanban comment    < comment.json # {body, task_id?}
mt kanban create     < task.json    # {title, body, contract?, assignee, reviewer?, workspace?, parents?, idempotency_key?}
mt kanban link       < link.json    # {parent_id, child_id}
```

- **JSON in on stdin, JSON out, always.** A summary is free text; passing it through shell arguments
  invites quoting failures that mangle or reject an agent's report. Every response is
  `{"ok": true, ...}` or `{"ok": false, "code": "...", "message": "..."}`, so the agent can act on an
  error rather than parse prose. `mt kanban` exits 0 when the command was done, 1 when it was refused,
  and 2 for a wrong command line.
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

However the run ended, once it is closed its session is archived and its `kanban` binding revoked, as
at boot (§8.4): one run is one session, so the session is never used again, and a stale approval card
for it resolves to "no longer bound".

### 7.5 Stop nudges

An agent that narrates its next step and stops without reporting is common, and usually the work is
done and only the report is missing. So the dispatcher submits a short nudge into **the same
session** — "you ended your turn without reporting; run `mt kanban complete`, `review` or `block`" —
up to `kanban.nudge_limit` (default 2, at most 10; 0 sends none) times. If they run out, the run ends `protocol_violation`,
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
  run from closing, and hold the workspace. The next run on the task reads it in the thread. A forwarded comment does not use up a nudge, and is sent when the run's turn ends, as a
  nudge would be: a person speaking is not a reminder. A comment by a run, the run's own included, is
  never forwarded.
- **Only a comment that steers reaches an agent.** Anyone at talk tier may comment from chat, and
  everyone sees the comments in `/kanban show`, but a talk-tier person's comment is stored with
  `steers` 0: it is neither forwarded nor put in any run's prompt, nor in `mt kanban show`. A run's
  comment, an operator's, and an unblock's steer; from plan D2, so do the named assignee's and
  reviewer's. Being allowed to talk to the bot is not being allowed to direct an unsupervised agent.

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
goes through — not in the socket handler, which is only one of the callers. Both are asynchronous: a
gate is a process the gateway waits for, never one that stops its event loop, which chat shares. A human task's gates run
in its fixed workspace like any other task's (§2.3). A human task is never made unresolvable by its
workspace, though: a person's run does not use the workspace, so a removed workspace only matters
when there is a gate to run — and then the completion is refused with that reason, instead of the
task being held from its assignee.

**How a report runs them.** A report the board would refuse anyway — a second report, a person's
while an agent works — runs none: the service asks the board first. Then, for an agent's report, the
reported commit is read (§7.8); then the gates, one after another in the order they were defined,
each as `/bin/sh -c` in its own process group with stdin closed, until one fails. A gate past its
`timeout_s` is sent SIGTERM with its group, and SIGKILL two seconds later; one that cannot start
fails. Then the transition, which checks everything again in its own transaction: the run may have
been decided while the gates ran — a runtime limit, a supersession — and is then refused as any
decided run's report is.

- **One report per workspace at a time.** While a report's gates run, a second report on the task,
  or a report on another task in the same workspace, is refused (`report_in_progress`), and no task
  whose workspace is, or resolves at its claim to, that workspace is claimed: two reports' gates
  would run in one checkout, or an agent would start in a checkout being tested.
- **The gates a report reads are the ones it runs.** A gate removed while a report's gates are
  running is still run by that report; a gate added meanwhile is not part of it, and runs from the
  next report on.
- **A report waits for them.** So a task's gates may take at most 600 s together, and `mt kanban`
  waits 15 minutes for its answer.
- **Limits.** A task has at most 20 gates, and a gate's command is at most 4 KiB in UTF-8; a gate
  over either is refused when it is added.
- **The refusal.** `gate_failed` carries the gate's command, its exit code or signal, whether it timed
  out, and the last 4 KiB of its stdout and stderr together, masked before they are cut (§10.1). What
  is read of a gate's output before masking is its last 64 KiB; when that window is cut, leading text
  that is the end of a known secret is dropped, and the window starts with `[earlier output cut]`, so
  a cut through a secret leaves none of it showing.
  `gates_cannot_run` says why gates could not run at all: no workspace, a workspace or role no longer
  configured, its directory gone, or the gateway stopping, which kills them and applies nothing. The
  worker socket tells a report still running its gates when it closes, and sends its answer before
  the connection goes. On shutdown the gateway closes the socket first, once the dispatcher has
  stopped deciding runs, and only then closes the sessions and waits for the dispatcher: the report
  is answered while its agent is still there, and no run is decided because of the stop — the next
  boot ends the runs still open (§8.4). A gate runner that fails unexpectedly fails its gate, recorded
  with the error masked, and refuses the report as `gate_failed`.
- **The record.** Each run of a task's gates is one `gates_ran` event, with every gate's result,
  passed or not.

Gates run as the gateway's user, with **the environment of the role of the task's latest agent run**,
by `attempt`, including the run making the report — its agent's base environment, `.env` and
`passEnv` values, on top of the short allowlist every agent gets from the gateway's environment
(`PATH`, `HOME` and the like) — or of the role `default` if no agent has run on the task. If that role can no longer be resolved —
its directory removed or now invalid — the completion is refused with that reason, as for a removed
workspace, rather than running gates under another role's credentials. So an implementer's
`review` runs gates as the implementer; a reviewer agent's `complete` runs them as the reviewer —
with the reviewer's credentials, so a reviewer given only a read-only token runs gates with that
token; and a person approving after an implementer's `review` runs them as the implementer. They never get the gateway's own environment, which holds its Lark
secret, and never `MT_KANBAN_TOKEN` or `MT_KANBAN_SOCKET`: a test suite has no business reporting on
the board.

**Gates are not a containment boundary.** A gate's process group is killed when it times out, is
stopped or its shell exits, but a process the gate detaches into a session of its own (`setsid`) has
left the group: it can outlive the timeout and go on changing the checkout. Gates are an operator's
commands, trusted as such.

**Known limitations**, for plan D2 or later:

- **A person's report and another task's agent.** A person's run does not hold the workspace, so a
  person's report — from plan D2's chat — can run gates in a workspace while another task's agent
  run is open in it, and test a checkout that agent is changing. Plan D2 refuses that report with
  `workspace_busy`: a person's `complete` or `review` on a task with gates and a fixed workspace,
  while any agent run of another task, decided or not, is open there. It is asked before the gates
  run, with the report's other checks; once a report's gates start, nothing is claimed into the
  workspace until they end. A person's report on a task with no gates runs nothing in the checkout,
  and is not refused. Plan D1 had no person's report: its chat refused the commands that would make
  one.
- **A run decided while its gates run.** A stop, a timeout, a reassignment or an archive that
  decides the run does not abort its report's gates: they run on, up to 600 s, holding the
  workspace, and the report is then refused as any decided run's is. A claim refused meanwhile
  because the workspace is held waits for the next sweep.

**Gates are not isolated from the network**, deliberately. They are commands an operator chose, in the
same trust position as a cron job, not output from an agent. Denying the network would break ordinary
gates — installing dependencies, integration tests — and has no portable implementation: macOS offers
no supported way to deny one process network access, so the same gate would behave differently on a
laptop and on a server.

Gates are deterministic where a contract is prose: a red test suite is evidence the task is not done,
and no reviewer has to notice. Defining a gate requires **operator** tier: a gate is a shell command
the gateway will execute. An operator defines, lists and removes gates with `mt kanban gate add`,
`list` and `remove` (§2.6), recorded as `operator:<login>`, and from plan D1 with `/kanban gate`, recorded as `lark:<union_id>`; both
call the service's `addGate`, `listGates` and `removeGate`. The worker CLI has no gate command.
Wherever a gate's command is shown — `mt kanban gate list`, `mt kanban show`, the task prompt — it is
masked, since a secret may have become known after the gate was defined; plan D1's chat masks it
too wherever it shows one — `/kanban gate list`, `/kanban show`, and the reply to `/kanban gate add`. A gate
whose command holds a known secret is refused (§10.1) — as written, with control characters stripped,
or with the shell's quotes and backslashes removed, since the shell runs `sk\$x` as `sk$x` — a
backslash-newline, which the shell removes as a line continuation, is taken out first, and that form
is checked with its control characters stripped too. `mt`
checks the secrets its own shell can know: every role's values, and the Lark app secret when
`LARK_APP_SECRET` is set there.

### 7.8 The reported commit

When an **agent** reports `complete` or `review` — the assignee, or a reviewer agent approving with
`complete` — the gateway records, on that run, `HEAD` (`git rev-parse HEAD`) as `reported_commit`
and whether the working tree had uncommitted changes (`git status --porcelain` non-empty) as
`reported_dirty`. Both are captured before the gates run and before the transaction that decides
the run, so they describe the state the report was made in. A person's report records neither: there
is no agent state to pin. A task need not be code, so its workspace need not be a git repository:
when it is not (`git rev-parse --git-dir` exits non-zero), or git is not installed, nothing is known
and both stay null, as for a person's report. In a repository with no commit yet, or when git fails
or times out, there is no commit and the tree counts as uncommitted: `reported_commit` is null and
`reported_dirty` true, which tells "no commit to review" apart from a report that recorded nothing.
The reads are asynchronous, take no lock (`git --no-optional-locks`), run no fsmonitor hook
(`-c core.fsmonitor=false`), and get only the agent allowlist of the gateway's environment. A
workspace's clean filters still run, as the gateway's user: no more than its agent could do.

Edge cases, as git reports them:

- a bare repository has no working tree, so `git status` fails and it reads as having uncommitted
  changes;
- a workspace directory that is not itself a repository but sits inside one reports the outer
  repository's `HEAD` and status;
- the reads' 10 s timeout signals git only, not processes git started, such as a clean filter.

The review card and the reviewer's context show them, and a human reviewer is told what to review:

- **clean tree** — "review commit `abc123`";
- **dirty tree** — "uncommitted changes on top of `abc123`": the commit alone does not contain the
  work, and since a person's review does not hold the workspace (§6.3), those changes may be mixed
  with another agent's later;
- **no commit yet, or the command failed** — "uncommitted; no commit to review";
- **not a git repository, or no git** — nothing: the reviewer reviews the handoff and the work it
  describes, with no state line.

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
| 1 | `terminal_provider` | error text: 401, 403, `authentication_error`, an invalid API key, credentials expired, revoked or missing (Bedrock's `ExpiredToken`, `InvalidSignatureException`; an SSO token expired; "OAuth token revoked"), a disabled organization, a model id that is not found, does not exist or is invalid | **block at once** as `capability`: every retry would hit the same wall |
| 2 | `rate_limited` | error text: 429, "rate limit", "rate exceeded", a usage limit reached, a quota exceeded or insufficient, 5xx, Bedrock's throttling and unavailable exceptions, a connection reset, refused or closed, an unreachable or unresolved host, a timeout to the provider, an agent's own retries spent | cooldown, transient counter |
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

The patterns match the provider's wording, not a word that also turns up in a test run or a tool's
output: the bare word "unauthorized" (a test named "handles unauthorized users"), a file or a command
named `model`, a count after `Error:` ("503 tests passed"), and a bare "quota" or "read timeout" are
not provider errors.

### 8.2 Counting

- **`failure_limit`** — the task's, else `kanban.failure_limit` (default **2**) — is the number of
  counted failures that blocks the task. With the default, a task gets its first attempt and **one**
  retry. `1` means no retries.
- `consecutive_failures` increments on every counted outcome, of either run kind, and resets on
  success: on completion, and when the work goes to review (a `review`, or a `complete` taken as
  one, §5.3), so that a failure in one review cycle is not added to the next one's. Going to review
  resets `consecutive_transient` too, as any outcome but `rate_limited` does, and leaves
  `block_recurrences` alone, which only completion resets. Below the limit,
  the task stays in its phase with no open run and is claimed again. At the limit, it goes to
  `blocked` with kind `gave_up`, and its subscribers are told what failed, how many times, and the
  last error.
- **Unblocking a `gave_up` task resets `consecutive_failures`** — the one exception to "only
  success resets". Without it, a person who has fixed the cause and unblocks would get exactly one
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
| `/kanban list [status\|all]` | talk | the chat's board (§16.4), by derived status |
| `/kanban show <id>` | talk | task, contract, gates, runs, latest output, comments |
| `/kanban assign <id> <assignee>` | operate | an undecided run ends `superseded`; a decided one is closed |
| `/kanban link <parent> <child>` | operate | |
| `/kanban workspace <id> <name>` | operate | sets a task's workspace; refused once one is fixed (§2.3) |
| `/kanban comment <id> <text>` | talk | stored, and shown to people; an operator's, the named assignee's or the named reviewer's also steers: forwarded to an undecided agent run, and read by later runs (§7.5) |
| `/kanban unblock <id> [comment]` | operate | |
| `/kanban approve <id> [comment]` · `/kanban changes <id> <reason>` | operate, or the named reviewer | answer a review; an operator's answer while a role reviewer's run is open ends that run `superseded` and cancels its turn (§5.1) |
| `/kanban done <id> [summary]` · `/kanban block <id> <reason>` | the assignee | report on a human task; on a task that names a reviewer, `done` asks for review (§5.3) |
| `/kanban review <id> [summary]`, with a line `reviewer: <role or @person>` unless the task names one | the assignee | ask for same-task review of a human task's work (§5.3) |
| `/kanban stop <id>` | operate | the run ends `cancelled`; the task blocks as `needs_input` |
| `/kanban gate add <id> [--timeout <s>] <command>` | operate | the rest of the message is the command, as written (§7.7); `--timeout=<s>` is read too, and a timeout that cannot be read, or a task id starting `--`, is refused with the usage line rather than taken into the command |
| `/kanban gate list <id>` | talk | the task's gates, masked |
| `/kanban gate remove <id> <gate>` | operate | |
| `/kanban archive <id>` | operate | |
| `/kanban boards [all]` · `/kanban board create\|use\|set\|archive …` | talk for `boards`, operate for the rest | §16.3 |
| `/kanban help` | talk | every command, with its tier |

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

**How plan D1 reads the table.** D1 is every command above that a role's task needs; D2 adds
people (§12).

- **`/kanban new`.** A CRLF or a lone CR in the message counts as a line break. The title is the rest
  of the first line, or the next line when the verb stands alone; a title that is itself a field line
  is refused. A field line is its label at the very start of a line, in any case, then a colon and a
  value: an indented line, or one that only mentions a label, stays body. A zero-width character
  (U+200B to U+200D, U+2060, U+FEFF) at the start of the message or of a line, or next to the colon,
  is passed over, and `stop when:` may have any spaces or tabs between its words. The field lines may come
  in any order, among the body's lines. Each field may be given once, except `parent:`, which takes
  one or more task ids, separated by spaces or commas, and may be repeated. `verify:` fills the
  contract's `verification`, `stop when:` its `stop_when`. A field with no value — a `parent:` line
  of only commas among them — or given twice, is refused. A task with no assignee may be created; it is unassignable until `/kanban assign`.
  The message's id is the task's idempotency key, `lark:<message_id>` (§3.1). A task from chat has
  the worker CLI's limits: a title of at most 512 bytes, a body of at most 64 KiB, each contract
  field at most 8 KiB, checked by the chat command before the service; `KanbanService.create`
  itself sets none.
- **`/kanban list`.** Without a status, the tasks someone may still act on — running, reviewing,
  review, ready, todo and blocked, grouped in that order; with one, only those; `all` lists every
  task. At most 30 lines, then how many more. From plan G, all of them on the chat's board (§16.4).
- **`/kanban show`** gives the task, its contract, its gates (masked), its last five runs, the end of
  the latest run's output (its last 800 characters, after a line saying the rest was cut), and its
  last five comments.
- **`/kanban assign`** to the task's current assignee says so and changes nothing. A person's name
  there may hold spaces (`@Alice Smith`), and is refused as a person, not as a wrong command line.
- **Who acted** is recorded as `lark:<union_id>`, the principal people are assigned as. A sender
  whose message carried no union_id may list, show and see the help, and is refused any command
  that records who acted.
- **`/kanban` is registered at talk tier**, and each command that changes the board checks
  operator tier itself, so a talk-tier sender is told which command needed more. `/kanban gate
  list` is talk tier, as `/kanban show`, which shows the same gates, is.
- **With `kanban.enabled` unset**, `/kanban` answers that the board is off on this gateway and how an
  operator turns it on, and opens no session. Chat without `/kanban` is unchanged either way.
- **What arrives later is said as "a later update"**, never by a plan's name, which nobody in chat
  knows.
- **Until plan D2**, the board gave work only to roles. Naming a person as assignee or reviewer —
  an @-mention, which Lark's text shows as `@Name`, or a `lark:` principal typed out — was refused,
  saying it arrives in a later update, and so was a role whose agent is supervised, whose approvals had nowhere
  to go yet. `/kanban done`, `block`, `review`, `approve` and `changes` were answered the same way,
  rather than as unknown commands. Plan D2 lifts all of it, as below.
- **After a change the dispatcher is told:** a pass after `new`, `assign`, `workspace`, `unblock`,
  `stop` and `archive`; and for `assign`, `stop`, `archive`, and from plan D2 an operator's
  `approve` or `changes` that ended a role reviewer's run, the cancel of the agent run's turn
  that the change decided (§5.1), which closes it. A `comment` needs neither: the dispatcher forwards
  it when the run's turn ends (§7.5).

**How plan D2 reads the table.** D2 adds people.

- **Naming a person.** The message carries the mentioned people's ids (`InboundMessage.mentions`,
  read from Lark's raw event, without `@all` or the bot). A field's `@Name` is matched against the
  mentions by the name Lark's text shows, or by the mention's key; a name no mention has, one two
  mentions share, or one whose mention came without a `union_id` is refused. A `lark:<union_id>`
  typed out is accepted once the gateway has seen that person (§4.2). A person without talk tier is
  refused by the name typed.
- **The people's commands.** `/kanban done <id> [summary]` and `/kanban approve <id> [comment]` may
  say nothing more; `/kanban block <id> <reason>` and `/kanban changes <id> <reason>` need a reason.
  `/kanban review <id> [summary]` names its reviewer on a line `reviewer: <role or @person>`,
  anywhere in it, as `/kanban new`'s fields are, after any spaces, tabs or zero-width characters, rather than as a last word, which could be the
  summary's; without one the task's reviewer is used, and a task with none is refused.
- **Who, and when.** `done`, `block` and `review` are the task's assignee's, a person, while the
  task is `open`; `approve` and `changes` are its reviewer's, a person, or any operator's — for a
  role's review too — while it is in `review`. The phase is checked because the board's `complete`
  takes either, and an assignee completing their own task in review would decide the reviewer's
  run. An operator's answer to a role's review while its run is open ends that run (§5.1). Who is named is read from the task as it stands when the command arrives, and checked again
  inside the board's transaction (§9.2), after any gates have run.
- **Steering.** A comment steers when its author is an operator, or the task's assignee or reviewer,
  a person (§7.5).
- **A gate's refusal** is shown with the gate, how it ended, and the end of its output, masked and
  escaped; nothing is applied.
- **A role whose agent is supervised** is accepted: its approvals go to the chat that follows the task (§7.1).

### 9.2 Cards

- **A human task** is sent to the assignee as a direct message when it becomes ready: title, body,
  contract, the parents' summaries, and buttons **Done** and **Block**. A button opens Lark's input
  form for the summary or reason; `/kanban done` is the equivalent typed form.
  - **If the task was created in a group**, the group also gets one line at the same moment —
    "📋 *title*, assigned to *name*" — and nothing else: the card and its buttons go only to the
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

**This needs two changes below the board** (plan D2):

- **Sending to a person.** `SendTarget` is `{chatId, threadId}`, and the adapter sends by `chat_id`
  only. It gains a person target, sent by `union_id` — Lark's API accepts `receive_id_type` per
  message — so a direct message does not require the person to have opened a chat with the bot first.
- **Routing card actions.** `Router.onCardAction` treats every click as an ACP approval, reading
  `approvalId`, `optionId` and `nonce`, and checks operator tier before it reads the payload. Card
  payloads gain a `kind` field — `approval` (and absent, for cards already posted) or `kanban` — and
  the router **dispatches on `kind` first**, then applies that kind's authorization: operator tier
  for an approval, as today; for a kanban card, the rules of §9.1, under which a named assignee with
  talk tier may press Done.

**As plan D2 builds it:**

- **The box.** A Lark card has no form a button opens; a card takes text through a form holding an
  input, submitted by a button. So a task card has one box, for the summary or the reason, above
  Done and Block, and a review card one, for what needs changing, above Approve and Request changes.
  Block and Request changes with an empty box are refused, saying to type a reason. A box holds at
  most 1,000 characters; the typed commands take more.
- **What a card shows.** A task card: the title, any changes a reviewer asked for, the body, the
  contract and up to five parents' summaries. A review card: the handoff, what to review (§7.8) only
  when the report recorded a commit, the body and the contract. Each ends with the typed commands
  that do the same.
- **Delivery, from the board.** Every 2 s the gateway reads the open people's runs with no card
  recorded, sends each its card by `union_id`, with one uuid per run, and records `card_sent` with the
  message. A card a restart cut off is sent then, and a recorded one never again. Only Lark refusing
  because it cannot reach the person (230013, "the bot has no availability to this user"), or a
  person who has lost talk tier since, records `card_failed`, which the task's subscribers hear, with
  the commands the person can type instead; the card is not tried again, and the run stays open.
  Every other refusal — a missing scope, a plain 400 — and every failure that never reached Lark is
  taken for the gateway's, tried again after a pause doubling from 2 s to five minutes, for as long as
  it lasts. A card sent whose record then fails is not sent again until a restart. A run that ends
  while a round is under way is sent no card.
- **The nonce** is bound to the task and the run — for an Unblock, the event that blocked the task —
  and not to the boot, as a person's run parks across restarts. Who may press: Done and Block, the
  run's assignee at talk tier; Approve and Request changes, the review run's reviewer at talk tier,
  or an operator; Unblock, an operator. The nonce is no secret — an unkeyed hash of ids the card
  shows — and catches a pointer mixed or mangled; who pressed, and the board's re-check, protect a
  press. A press for a run that is no longer the task's open one is refused inside the transaction,
  says the card is out of date, and redraws it so. A report typed instead leaves the card live, until
  it is next pressed. It is bound to what was checked: the task's open run as it was then, or none,
  and what the person reports as — the task's assignee, its reviewer, or an operator answering a
  review. The board checks both again in its transaction, after the gates: a run opened or ended
  since, a task now someone else's or no longer open, or a review now someone else's or no longer
  waiting refuses it, `run_superseded`, so a reassignment while its gates run never lets the former
  assignee or reviewer decide the task. A card's press is bound the same way, to its run. Only a
  person's run has a card: a press on one for an agent's run is refused.
- **A press is answered at once, and shown only on its card.** Lark waits about three seconds for a
  callback's answer, and the SDK answers only once the handler returns, so the card is redrawn as
  being worked on, the report is made in the background, at once, never waiting for that redraw,
  and the card is redrawn with the outcome once the first redraw has settled or been given up on, so
  the outcome is always drawn after it. A redraw that fails, even at once, never stops the report.
  A board card's press posts nothing in the chat; a press the card cannot show — someone else's, an
  Unblock's — is only logged; an approval's press is acknowledged in the chat after the callback is
  answered. A second press of a card while one is worked on is refused without a redraw. Every
  redraw is bounded, about 10 s, as the SDK's card update has no timeout of its own. When the gateway stops, the gates of a report from chat, pressed or typed, are killed and
  nothing is applied, as for the worker socket's.
- **A refused press leaves a pressable card.** The SDK drops a press it has seen — the card, the
  presser and the button's value — for twelve hours, whatever the box held. So a press refused for
  what it carried — an empty box, a gate, a busy workspace — redraws the card live, saying why, with
  buttons named for the next attempt, which the SDK's key holds whole, and whose value starts with
  it, outside the nonce; the card says "Not done." once, above why. A press by the wrong person
  changes nothing; a refused report whose run ended meanwhile redraws the card as out of date.
- **The one line** is the notice of a person's `claimed` event, which records the assignee's kind:
  "📋 *title*, assigned to *name*", or "review assigned to". It goes to every subscription of the
  task, as any notice does: a subscription does not record whether its chat is a group.
- **Unblock** sits under a message of notices, one for each task its notices left blocked, by the
  task's latest block there, at most five. The message is not redrawn when one is pressed, as it
  carries the round's other notices; a second press finds the block lifted and does nothing, which
  is noted in the log.
  The same operator's second press of one Unblock is dropped by the SDK, as above; `/kanban unblock`
  still works. An Unblock's event must be a block of its task: a `blocked` or `stopped` event, or a
  `run_ended` whose task blocked there, not one it was retried after.
- **Approval cards** are built in Lark's card schema 2.0, their buttons in the body with callback
  behaviors, as a board card's are; the router reads the button's value the same way for a card
  posted before.

### 9.3 Rendering

All task text — titles, bodies, summaries, comments, agent output — is untrusted: an agent wrote some
of it, and a task body can be pasted from anywhere. Markdown bodies use the answer escaper (tags
neutralized, markdown kept); labels use the full escaper; card fields that carry no formatting are
`plain_text`. In a reply, a body, summary, comment or output is set off as quoted lines under its
label, so none of its lines can start a heading; a line of three or more backticks or tildes has its
first escaped, so the text can neither open nor close a code fence. Links in it are kept: the answer
escaper neutralizes tags, and a link cannot mention anyone. Each piece is masked before anything else
is done to it — spaces collapsed into one line, trimmed, cut to its length — and only then escaped,
so no reshaping can hide a secret from the masker and a cut can neither leave part of a secret
showing nor split an escape. After masking, a CRLF or a lone CR becomes a newline, so quoting sees
every line. A cut falls on a character boundary: it never leaves half of a surrogate pair. An agent's
output is cut from its start, to show its end. Each whole
reply and notice is masked once more before it is sent. The group notice names the assignee in plain text, not as an @-mention: it is a
notice, and a bot that mentions people whenever work moves trains them to ignore it.

### 9.4 Subscriptions

The chat where a task is created is subscribed to it, and to the tasks created from it. A subscriber
hears: completed, review requested, blocked (with the kind and reason), retrying after a failure,
gave up, stranded. Delivery is at-least-once, each message with a uuid derived from the
`(subscription, event)` pairs it carries, so a redelivered message keeps its uuid.

**As plan D1 builds it:**

- **Who follows what.** A subscription is the binding key of the chat, or thread, a task was created
  in — channel, app, chat, thread. It is written in `createTask`'s own transaction, with no event of
  its own. A task a run creates gets every subscription of the run's task (§7.3), so "the tasks
  created from it" are its runs' follow-ups, and theirs in turn.
- **What is a notice.** From the task's events: `completed`; `review_requested`; `blocked` of any
  kind but `dependency`; `stopped`, which blocks the task as `needs_input`; `run_ended` that retries
  after `failed`, `crashed`, `timed_out` or `protocol_violation`; `run_ended` that blocks — "gave
  up" for `gave_up`, otherwise as a block with its kind and reason, which the event now carries as
  `blockReason`; and `stranded`. A run interrupted by a gateway restart is retried quietly: the task
  did nothing wrong. A throttled run's cooldown is not one either: it clears by itself, and blocks as
  `transient` at its limit, which is. Nor are a comment, a claim, a link, `changes_requested` or an
  archive. A block's notice tells how to unblock, unless the block has recurred
  `kanban.block_recurrence_limit` times (§5.4) — counted as the event recorded it (`blocked`,
  `stopped` and `run_ended` carry `blockRecurrences`), not as the task stands when the notice goes.
  A stop's notice names who stopped it: a person by the name Lark last gave, else as recorded.
  From plan D2, a person's claim is one too — the one line of §9.2 — and so is a card Lark refused.
- **Delivery is a projection from the cursors, a batch per conversation.** A round reads every
  subscription of this bot with an event past its cursor, groups them by conversation — a chat, or a
  thread — and sends each conversation at most one message: the round's notices for all its
  subscriptions, in event order, at most 20 and 3,800 characters, then how many follow. Once the send
  succeeded, each subscription's cursor moves to its last event the message covered, notices or
  not; before, none moves. The cursor moves forward only, and moving it writes no event — one would
  itself be a new event past the cursor. A message's uuid is a hash of the sorted set of the
  `(subscription, event)` pairs it carries. A subscription reads at most 100 events a round; when one
  has read that many, nothing past its last read event goes in that round's message, so another
  task's later notice cannot go before an earlier one not yet read. A round runs every 2 s, one at a
  time, and sends to at most ten conversations, the longest waiting — by its oldest pending event —
  first; the board is written by chat, the worker socket and
  the dispatcher, and a cheap poll replaces telling the notifier of each.
- **Across a restart** the cursors are in the database, so the first round after a start — run once
  the channel is connected — catches up on everything the chats missed, by the same code. A batch
  sent just before a stop, whose cursors had not moved, is sent again with the same uuid. Plan D1's
  Lark adapter did not pass a send's uuid to Lark, so such a batch could show twice. From plan D2 it
  does, for every message it sends as one — a text of up to 4,000 characters, which a batch always
  is, an approval card, a board card — through the SDK's own client, so a batch sent again within
  Lark's hour shows once; a longer text, which the SDK splits, and a streamed answer still go
  without it. A batch is never lost. Since Lark sends one message per uuid across receivers, every
  uuid is one message's: a boot finding's is keyed on its binding and the boot, a press's
  acknowledgement on the press, an approval card on its approval. A send that never reached Lark is
  retried with its uuid, and a notice whose card of buttons Lark refuses, for a reason not the
  chat's, goes as plain text.
- **A send that fails** moves no cursor, and the conversation is tried again after 2 s, doubling to at
  most five minutes, while the others go on. A refusal that may be of one bad batch is such a
  failure. So are a network failure, which the Lark adapter reports as code 0 and not retryable, and
  a send not answered in 30 s, which counts as failed; but they are the gateway's
  outage, not the chat's: they never count toward letting a chat go, and hold it at the five-minute
  pause for as long as the outage lasts, so after it the chat catches up from its cursors. **One that
  cannot succeed is let go of:** a send refused as unreachable — Lark's 230002, the bot is not in the
  chat; the chat-not-found and disbanded codes are not confirmed locally, and such a chat is caught
  by the next rule — or the third refusal in a row at five minutes, only a `ChannelError` with a
  nonzero code counting — the eleventh refused send, after 1,110 s of pauses (2 s doubling to 256 s,
  then two of five minutes), about 19 minutes — drops the notices it held, moving the cursors past
  them, logs one line naming the conversation, its tasks and the dropped events, and marks the conversation dead until the gateway
  restarts: its later notices are passed over unsent. A conversation on a channel this gateway has
  not got is let go of in the same way, at once. A subscription whose task is not on the board is
  let go of by itself: its cursor moves past its events, one line is logged, and its later events
  are passed over without another until a restart. A subscription that cannot be read otherwise, or
  a conversation that fails otherwise, is held back by itself; the rest of the round goes on. When a
  send succeeded and a cursor then fails to move, the others still move, the log says that
  subscription's notices were sent and its cursor not moved, and they are sent again after its
  pause — at least once, as ever. A subscription's pause is cleared once it is read again, or, for
  one whose cursor did not move, once its cursor moves.
- **Subscriptions are never deleted**, so a round's scan grows with the tasks ever created; it is one
  query, which finds this bot's subscriptions through the index on `account_id` (migration `004`)
  and each one's oldest pending event with a correlated `min(e.id)` through the events' `(task_id,
  id)` index, and a delivered subscription of an archived task has nothing past its cursor.

---

## 10. Security

- **Tiers.** Creating, assigning, linking, setting a workspace, unblocking, stopping, archiving,
  defining gates, and answering a review one is not the named reviewer of are operator actions. Listing, showing and commenting are talk actions. A named assignee or reviewer
  may report on, or answer, their own task.
- **Workspaces are named, never given as paths** (§2.3), so creating a task cannot aim an agent at an
  arbitrary directory.
- **Tool policies are enforced or refused, never silently ignored** (§2.2).
- **Rendered packages hold only the operator's files** (§2.7): `role.md` and the skills, never a
  `.env`, in `0700` directories under the gateway's home. They are not masked, as `role.md` and the
  skills are not masked in a prompt: a secret an operator typed into `role.md` reaches the agent
  either way, and the masker still masks it in what the agent writes back if it is a known value.
  The package's path is not a secret.
- **A role's `.env`** is the only file the gateway reads secrets from, and it is `0600`, never cloned,
  gitignored, masked, and given only to that role's agent (§2.5). Every agent runs as the same OS
  user, so one could still read another role's `.env` from disk; that boundary needs per-role users
  or containers.
- **Worker tokens** are run-scoped and hashed at rest (§7.2); the socket is `0600`, at
  `$MT_HOME/run/kanban.sock` in a `0700` directory — or, when that path is too long for a socket
  (104 bytes on macOS), in a `0700` directory of the gateway's user under the temporary directory,
  named by the user and the home; a stale socket is removed only if it is the gateway user's own
  socket and nothing answers on it; gates run without
  the token (§7.7).
- **Gates execute commands**, so they are operator-defined, run in the task's workspace as the
  gateway's user, and recorded with who defined them (`created_by`, and a `gate_added` event). An
  operator defines them with `mt kanban gate` and, from plan D1, `/kanban gate`, both through the
  service (§2.6, §7.7).
- **No secrets in the handoff.** Summaries, metadata and comments are durable and shown in chat. The
  worker protocol says so, and known secrets are masked (§10.1).
- **Agent-written task text cannot spoof a mention** (§9.3).
- **Card buttons are pointers.** A board card's button carries the task, the run and a nonce bound
  to both; who pressed is the callback's operator, and the board re-checks the run inside its
  transaction (§9.2). The `people` table holds ids and names Lark gave, never anything a message's
  text said (§4.2).

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

**A crash.** An uncaught exception or an unhandled rejection is printed through `redactKnownSecrets`
too, and the gateway exits 1, the code Node itself would use; Node's own report, which is not masked,
is never printed. The error's strings are masked value by value first — its own enumerable fields,
its message, stack, cause and errors, through arrays and plain objects, however deep — because
`inspect` escapes `\` and quotes, and a secret holding them would no longer match. `inspect` is then
shown every string whole and its text masked again; only then is it cut, at 64 Ki characters, with
any trailing start of a known secret dropped. An object of another kind, a `Map` or a class's
instance, is covered only by that second masking.

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
| Role and workspace names | the grammar enforced for roles at discovery and by `role create`, and for workspaces at startup and by `workspace add` (`../x`, `A`, `a:b`, `x-` refused); a workspace equal to or containing `$MT_HOME` or a relocated database refused; inside `$MT_HOME` only `workspaces/<name>` allowed; two names on one realpath, and one workspace nested in another, refused at startup and by `workspace add`; driver ids reserved; dot-entries ignored; other entries reported and ignored |
| Role and workspace CLI | `role create default` migrating a legacy `default` and printing the cutover and the `MT_AGENT_ENV_*` names; `role create` from `default` and from `--clone-from`, refusing an existing name, never copying `.env` or `MT_AGENT_ENV_*` values; `role check` reports what startup would; `role check` reporting environment-dependent results separately; `workspace add` keeps the config file's comments, refuses a name registered to another directory and a directory containing `$MT_HOME`, refuses without a config file, a name already in `workspaces:`, and `default` while `workspace:` is set; reads the database at an `MT_DB` location, and treats a missing one as empty; `--clone` uses `--`, refuses an existing target, and leaves nothing behind on failure; none of them touch the socket |
| Sessions | workspace name written to `sessions.workspace_id` at create and used on every actor rebuild; empty legacy value resolves to `default`; legacy driver id resolves to the role `default`; `sessions.agent_id` holds the role name |
| Derived status | pure function; table of phase × parents × runs |
| Transitions | every legal move, and every illegal one refused, against a real SQLite |
| Links | cycle refusal; link onto a task with an open run, or past its parents gate, refused; a dependency block's parents linked with it, from a work run (task stays open) and from a review run (task stays in review, its next review claim waiting on them) |
| Classifier | a table of real error strings → classes, including the 400 that was transient |
| Dispatcher | fake driver: claim race (two passes, one run); one open agent run per workspace, parallel across workspaces, `max_running`; workspace resolved at a claim while null — explicit, else the role's explicit one, else the parents' common one, else `default` — and reused by review, retry and later gates; `/kanban workspace` refused once the workspace is non-null; an agent claim on a task a person left null re-applies the rules; an unknown workspace refused at create; a removed workspace makes its tasks unresolvable; cooldown and doubling; stranded notice once, never for queued tasks; max runtime → `timed_out`, but a decided run past the limit keeps its outcome; a reporting run holds its workspace until it closes; dispatcher-cancel reason wins over the classifier |
| Prompt | `role.md`, skills list, protocol, task and context, in order; the run records `role_md_hash` and `agent_config`; a native run's prompt without `role.md` and the skills, and otherwise the same; imported skills listed like the role's own |
| Native rendering | `agent.skills` found in bytesec's order under a made-up home, a symlink not followed, an unknown, misnamed or duplicated-with-own name a startup error and a `role check` file problem, never the real home read; which roles are rendered, and each reason one is not; the package's layout and `role.md`'s bytes unchanged; content-addressed, reused, never rewritten; atomic, `0700`, regular files only, no `.env`; a too-large package and a symlinked `SKILL.md` refused; old packages swept but those of open runs, and unconfigured roles' at boot; `--agent` and `BYTESEC_LOCAL_APM_PATH` reaching the fake CLI agent's argv and environment on every turn; the ACP driver refusing per-session arguments; a failed render falling back to the prompt with a note; imported skills copied into the package and in its hash; the walk stopping at the file limit; a run's `native` and `packageHash` recorded once in `agent_config`; `mt role check`'s line; no test runs real bytesec |
| Retry | `failure_limit` 2 → one retry; `gave_up` and its unblock reset; `rate_limited` not counted; `if-no-side-effects` against `readOnlyTools`; the retry's context containing the previous run's tool calls |
| Review | reviewer `changes` → rework run seeded from the work run when their `agent_config` matches — driver, command and arguments, and the same native-ness and package hash — unseeded otherwise; the review's handoff and the rework's reason in their prompts; a failing review run counted and retried; `review` with no reviewer refused |
| Worker CLI | handler tests over JSON; token scope; `already_reported`; `run_superseded`; gates refusing completion; gates not seeing the token |
| Nudges | an agent that stops without reporting, then reports after one nudge; one that never does; distinct keys per submission; a comment replacing a nudge |
| Restart | `reconcileBoot` then `interrupted`; a decided-but-open run keeps its outcome; kanban findings not posted to Lark; the old session archived |
| Lark | tiers: a named assignee or reviewer acting with talk tier, a non-reviewer needing operator tier to approve, assigning to a person without talk tier refused; `/kanban review` from a human assignee, refused with gates while the workspace is null; `/kanban stop` on a decided-but-open run; `/kanban assign` mid-run; @-mention vs role assignees; person targets; the one-line group notice for a human task created in a group; card `kind` routing; a click on a superseded run's card refused |
| Chat (D1) | `/kanban new`'s field lines in any order, a field twice or empty refused; each command's usage; operate commands refused at talk tier with nothing written; a sender with no union_id read-only; a person — with spaces in the name too — a supervised role, an unknown role or workspace, an oversized task, or a field line for a title refused at creation; `/kanban done`, `approve` and the rest answered as arriving in a later update; a talk-tier comment stored and given to no agent, an operator's forwarded; an assignment that changes nothing said so; one task per message; the dispatcher told after a change, and the decided run's turn cancelled; `/kanban` answered while the chat's session is busy, and with the board off; gate commands shown masked |
| People (D2) | a mention's ids read from the raw event; a person without talk tier, one not mentioned, and a principal never seen refused; the named assignee's and reviewer's reports at talk tier, an operator answering any review, their comments steering; a card's run re-checked in the transaction, a stale card redrawn as out of date; card `kind` routing; `workspace_busy` for a person's report with gates beside another task's agent; a card sent once by union_id, again after a restart only if not recorded, with one uuid, and a refused one reported; Unblock under a block's notice, refused once lifted; a supervised agent's approval forwarded to the task's first subscription; the uuid on every one-message send; end to end, a person's task done from its card, and a person's review asking an agent for changes and approving its rework |
| Notices | each kind of notice, and the events that are none, an interrupted run's retry among them; one message per conversation a round, in event order, at most 20 with how many follow; a follow-up's notices to its creator's chat; a failed send retried after its pause, and sent once; a send refused for good, or failing at the longest pause, dropping its notices with one log line and passing over the conversation until a restart; a subscription that cannot be read, or a conversation that throws, holding up no other; a restart catching up from the cursors with the same batch uuid; only this bot's subscriptions; masked before reshaping, and escaped; an end-to-end `/kanban new` through the router whose completion the thread hears once |
| Masking | a known value masked through each escaper, in composed worker context and `last_output`, and in stored free text and JSON string values; **a secret split across two message chunks masked on the card**; a secret containing `_` masked before escaping, and one containing `"` masked inside JSON; values under 8 characters and `maskExempt` names left alone; a worker token masked only while its run is open; `turn_submitted` input stored unmasked but shown masked; a gate containing a secret refused; a render withholding a trailing prefix of a secret, mid-stream and on a turn that ended part-way through one; ids inside payloads left unmasked; the registry gaining and losing a worker token with its run |
| Reported commit | clean tree → commit; dirty tree → commit plus "uncommitted changes"; no commit yet → "uncommitted; no commit to review"; not a repo, or no git → nothing recorded, and no state line; recorded for a reviewer agent's `complete`, never for a person's report |
| Workspaces | a name registered on first sight; a known name repointed to another directory fails startup; no workspace `default` fails startup; a downstream review task inherits its parents' common workspace, a role with its own workspace does not; an unclaimed archived parent ignored; parents in different workspaces make an agent task unresolvable, while a human one is claimed with a null workspace, has gated completion refused, and can then be given one by `/kanban workspace`; a worker-created follow-up uses its creating task's workspace without a link and is claimable at once; an agent claims a workspace while a person's review on another task there is open; a person's run leaves the workspace null and a later agent review claim re-applies the rules |
| Boards (G) | migration `006` from version 5 with tasks in it, every task on `default`; boards created, set, archived only through the writer, `default` never archived, a board with unfinished tasks not either; a chat's board per conversation; a parent, a link, a dependency block and a worker's follow-up kept on a board; a board's workspace as rule 4; the service's name grammar and `max_running` bound; the boards in turn, and a board's `max_running` inside the gateway's; the board commands at their tiers, and `new`, `list` and `show` on the chat's board; end to end, a chat on a board running its task |
| End to end | the fake CLI agent calling `mt kanban complete` through the real socket |

---

## 12. Plans

Separate implementation plans. Each ends with everything built so far working and tested. Order: A, A2, B, F, C1,
C2, R, C3, C4, then D1 and D2, then G; E is independent once B is done. B is delivered as B1 (roles and workspaces in
configuration), B2 (the session layer) and B3 (the `mt` commands). C is delivered as C1 (the board),
C2 (agent runs), C3 (the worker CLI) and C4 (review, rework and gates), in that order; R comes
between C2 and C3, so the runs C3 makes reportable already get their role natively. **Before F**,
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
| **C4. Review, rework and gates** | same-task review and rework, with the rework's seed settled after the render; quality gates, run asynchronously in every report, and the worker socket draining on close; the reported commit (§5.3, §7.7, §7.8); refusing gates that contain a known secret; the operator's `mt kanban gate` commands; a crash handler whose output is masked | C3 |
| **D1. The board in chat** | every `/kanban` command a role's task needs (§9.1), through `KanbanService` only, with the tiers of §9.1, never refused for a busy chat session; people still refused, and the person-only commands answered as arriving in a later update; only an operator's chat comment steering an agent (`kanban_comments.steers`, migration `004`, §7.5); rendering escaped and masked, gate commands included (§9.3, §7.7); subscriptions and their notices, batched per conversation, delivered from the cursors and caught up after a restart, a conversation that cannot be reached let go of (§9.4); `kanban.block_recurrence_limit` (§5.4); `/kanban` answering that the board is off when `kanban.enabled` is unset | C4 |
| **D2. People** | people as assignees and reviewers: direct-message cards with Done, Block, Approve and Request changes; the person send target by union_id; card `kind` routing; the group one-line notice; `/kanban done`, `block` and `review` by a human assignee, `approve` and `changes` by a person reviewer; approval forwarding for supervised roles; an operator's `approve` and `changes` from chat; the named assignee's and reviewer's comments steering; refusing a person's report while another task's agent run is open in the workspace (`workspace_busy`, §7.7); the mentioned users' ids carried on an inbound message. As built (`docs/plans/2026-11-05-plan-d2-kanban-people.md`), also: the `people` table (migration `005`) that checks a person named by principal for talk tier (§4.2); cards delivered from the board, `card_sent` and `card_failed` (§9.2); and the uuid passed to Lark for every message sent as one (§9.4) | D1 |
| **E. Native resume** | the CLI driver captures the provider session id and passes `--session` (architecture §6.3), with transcript replay as the fallback. As built (`docs/plans/2026-11-05-plan-e-native-resume.md`), on bytesec 0.7.4 or later, which `mt role check` warns of: the id read from `--session-id-file` after each turn — for a resumed run, from its events' `session_id`, since the file echoes the id sent — and reported as a `session-observed` driver event, stored as the observed `provider_session_id` and logged as `provider_session_observed`; a resumed turn sends only the new message; a refused id — exit 1, nothing on stdout, and `persistence: session not found` or `unknown agent:` as stderr's last line — runs the same turn again with the transcript, automatically; a `cli:` id from before never seeds a rework; nudges and a seeded rework resume with no change to the board; `/status` shows the provider session and how the last turn reached it | B; independent of C and D |
| **R. Native rendering** | the spike, done on bytesec 0.7.4: `BYTESEC_LOCAL_APM_PATH=<one package dir>` with `bytesec run --agent <name>` loads that package's agent, whose body becomes the system prompt, and its skills; a directory of packages fails silently; a package's agent may use only the package's skills. Then (§2.7): the role grammar tightened so a name cannot end in `-`; `agent.native`; `agent.skills`, imported from where bytesec finds a user's skills, since a native agent sees only its package's; `StartOptions.args` and the registry's `argsFor`; a renderer interface with bytesec's renderer; content-addressed, atomic packages under `$MT_HOME/rendered`, swept; the dispatcher rendering just after the claim, recording on the run whether it is native and by which package, and falling back to prompt injection when a render fails; the prompt leaving `role.md` and the skills out of a native run; `mt role check` saying which roles run natively. Claude Code's renderer is later. Prompt injection (§7.1) stays the fallback | B2, C2 |
| **G. Boards** | isolated task queues on one database (§16): migration `006`, with `kanban_boards`, `default` in it, `kanban_chat_boards` and `kanban_tasks.board`, every existing task on `default`; boards created, set and archived, and each chat moved onto one, from chat (`/kanban boards`, `/kanban board create\|use\|set\|archive`); `/kanban new`, `list` and `show` on the chat's board; follow-ups, parents, links and dependency blocks kept on a board; a board's `max_running`, inside the gateway's, and its workspace as §2.3's rule 4; the dispatcher taking boards in turn; `mt kanban show` giving the board. Plan: `docs/plans/2026-11-09-plan-g-boards.md` | D2 |
| **F. Masking** | the registry and `redactKnownSecrets` (§10.1); masking inside the escapers (layer 1); trailing-prefix withholding in `renderCard`; masking session `events` and `approvals.payload` on write (layer 3). The kanban parts land in C1 (layer 3), C2 (layer 2) and C3 (worker tokens) | B (the resolved agent environments); best done before C, since it protects chat sessions too |

Until plan D2, nothing can deliver a card to a person, so **plans C and D1 refuse human assignees and
reviewers** at creation and in `mt kanban review`, and **refuse roles whose agent is supervised**,
whose approval cards would have nowhere to go until D2 forwards them. And **the board runs only when
`kanban.enabled` is set**, off by default. It stays opt-in after D1 and D2 — the user's decision — so
a gateway that never sets it runs chat exactly as before, and its `/kanban` says the board is off.
C's kernel implements and tests human runs and approval forwarding through its service API, and D2
turns them on: the gateway gives its service `people` and `supervisedRoles`, sends people their
cards, and forwards a supervised agent's approvals to the chat following its task.

Nor can a person create a task before D1: `/kanban new` arrives there, and every `mt kanban` command
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

---

## 16. Boards

Several projects share one gateway. A **board** is a queue of tasks for one of them: its own list
in chat, its own turn in each dispatcher pass, and optionally its own `max_running` and default
workspace. Boards are queues, not permissions: whoever may act on one task may act on any, by the
tiers of §9.1 and §10, as before. Built by plan G (§12).

### 16.1 One database, one dispatcher

Each task records its board, in a `board` column; there is no database per board. A run is a
session, and "what did task X's agent do" is a join (§3), whatever the board. One dispatcher (§6.1)
serves every board, so the one-run-per-workspace limit (§6.3) and `kanban.max_running` hold across
boards without two dispatchers having to agree: a workspace is a directory, and two boards' agents
in it would overwrite each other as two tasks' would.

### 16.2 Schema (migration `006_boards.sql`)

| Table, column | Notes |
|---|---|
| `kanban_boards` | `name` (the role grammar, §2.1; the key, never renamed), `max_running` (null, or at least 1), `workspace` (a workspace name, or null), `created_by`, `created_at`, `updated_by`, `updated_at`, `archived_at` |
| `kanban_tasks.board` | the board's name, `NOT NULL DEFAULT 'default'`; set at the insert and never changed |
| `kanban_chat_boards` | `(channel, account_id, conversation_id)` → `board`, `set_by`, `set_at`; a chat with no row is on `default` |

- **`default` always exists.** The migration inserts it, and every task already on the board is on
  it: `ALTER TABLE … ADD COLUMN` with a constant default records the default in the schema and
  rewrites no row, so the migration is as quick on a database holding years of tasks as on an empty
  one, and it runs in the one transaction `migrate` gives each file, with `user_version`. The live
  database, at version 5 and holding data, is migrated by the gateway's next start.
- **No foreign key on `kanban_tasks.board`.** SQLite refuses `REFERENCES` on a column added with a
  non-null default while foreign keys are on, as the gateway opens its database, and rebuilding
  `kanban_tasks` would rewrite every row of the live table. `db/kanban.ts` checks the board exists,
  and is not archived, in the transaction that creates the task. `kanban_chat_boards.board` is a new
  table's column, and has its foreign key.
- **No board events.** `kanban_events` rows belong to a task. A board's row says who created it and
  who last changed it; its history is not kept.
- **One writer.** `db/kanban.ts` writes both tables, as it writes every `kanban_` table.

### 16.3 Commands

| Command | Tier | |
|---|---|---|
| `/kanban boards [all]` | talk | each board with its tasks by phase, its own `max_running` and workspace where set, and which one this chat is on; `all` adds archived boards |
| `/kanban board create <name>` | operate | a new board, with no settings of its own; a name a board has, or had, is refused |
| `/kanban board use <name>` | operate | this chat, all its threads, is on the board from now on |
| `/kanban board set <name> max_running <number\|none>` · `… workspace <workspace\|none>` | operate | §16.5 |
| `/kanban board archive <name>` | operate | §16.7 |

**`use` needs operator tier** because it changes where the chat's tasks go, and a board's workspace
can change where their agents run: a talk-tier person moving an operator's chat would choose the
directory of the operator's next unsupervised agent. There is no rename: tasks carry the name, and
renaming would rewrite them; a display name, as Hermes gives its boards, can come later.

### 16.4 A chat's board, and what acts on it

- **A chat is a conversation**, for one bot: a group and every thread in it share one board, so a
  reply in a thread does not land on `default`. A chat starts on `default`.
- **`/kanban new`** creates the task on the chat's board, and its reply names the board unless it is
  `default`. A chat on an archived board is told to move first, and nothing is created.
- **`/kanban list`** shows the chat's board alone, under a line naming it unless it is `default`.
  `all` keeps its meaning, every status, on this board; `/kanban boards` is the view across boards.
- **`/kanban show <id>`**, and every command that names a task, work on any board by the task's id:
  task ids are unique across boards, and a chat that moved still follows the tasks it created, whose
  notices give their ids and an Unblock button. `show` names the task's board once any board but
  `default` is involved, the task's or the chat's.
- **Notices** are unchanged: a subscription follows the chat a task was created in (§9.4), and the
  tasks its runs create, so a board's notices go only to the chats that created its tasks. After the
  migration every existing subscription is a `default` task's in a chat on `default`, as before.

### 16.5 Isolation

- **A task's follow-ups stay on its board.** A task a run creates (§7.3) is on its run's task's
  board, whatever it asks; `mt kanban create` has no board field, and `mt kanban show` gives the
  board. A done task's follow-up (§4.4) is on the done task's board.
- **A parent and its child are on one board.** `parent:` at creation, `/kanban link`, a worker's
  `link`, and a dependency block's parents (§5.4) are refused `other_board` across boards, in the
  writer's transaction: a queue whose tasks wait on another queue's is not separate, and its
  priority, its limit and its archive would all depend on the other.
- **`mt kanban gate`** names a task by id, and needs no board.

### 16.6 A board's `max_running` and workspace

- **`max_running`** caps the open agent runs of the board's tasks, counted as §6.3 counts them, decided
  or not. It is at most the gateway's `kanban.max_running`, which the service refuses above, and
  which still caps every board together; `none` clears it. Set from chat, as boards are made there:
  a setting in `config.yaml` would name a board that may not exist yet, and two places would set
  one thing. Lowering the gateway's limit below a board's makes the gateway's the one that binds.
- **`workspace`** is §2.3's rule 4 for the board's tasks, in place of `default`: the last resort, after
  the task's own workspace, its role's explicit one and its parents' common one. It is resolved at a
  claim, as rule 4 is, so setting it moves no task already claimed. A board's workspace removed from
  config makes the agent tasks that would land there unresolvable (§4.2), not moved to `default`.

### 16.7 The dispatcher takes boards in turn

A pass (§6.2) orders its claimable tasks by board: the first of each board, then the second of
each, and so on, the boards by name, **starting with the board after the one that got the previous
agent claim**, wrapping round. Within a board the order is §6.2's, priority then age. Without the
rotation, a board whose first task is always claimable would be offered every free slot first; with
it, one board's burst cannot starve another, whatever its priorities, which say nothing about
another board's. The cursor is in memory: a restart starts again from the first board, which costs
one turn of fairness. Human runs are not limited, and do not move the cursor.

### 16.8 Archiving a board

Refused for `default`, and while any of the board's tasks is `open`, `review` or `blocked`: their
work would be left on a board nothing may be added to. Once archived, no task is created on it, from chat or
by a run whose task has just completed there; no chat moves onto it; and `/kanban boards` leaves
it out unless asked for `all`. Its tasks stay, by id. A chat still on it is
not moved: putting it back on `default` unasked would send its next task somewhere its operator did
not choose.

### 16.9 Later

- **Projects:** per-board operators, and a board's list of the roles it may use, checked in the
  service beside the tiers. The user chose queues without them.
- A display name, renaming, unarchiving; a board's settings history; naming the board in notices.
