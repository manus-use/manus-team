# Configuring manus-team

This guide sets up the gateway one goal at a time, from the minimum that starts to every feature
turned on, and ends with the complete reference of every setting. Each step shows the part of
the config file it adds; a setting you leave out keeps its default.

- [How configuration works](#how-configuration-works)
- [1. The minimum to start](#1-the-minimum-to-start)
- [2. Who may use it](#2-who-may-use-it)
- [3. Choosing the agent](#3-choosing-the-agent)
- [4. Workspaces and roles](#4-workspaces-and-roles)
- [5. Turning features on, one by one](#5-turning-features-on-one-by-one)
- [6. Checking it](#6-checking-it)
- [7. Full reference](#7-full-reference)

## How configuration works

Settings live in one YAML file, `$MT_HOME/config.yaml`. `MT_HOME` defaults to `~/.manus-team`,
and `MT_CONFIG` names a file elsewhere. A file `MT_CONFIG` names that does not exist is an
error; no file at the default location is an ordinary deploy configured by the environment
alone. Start from [`config.example.yaml`](../config.example.yaml), which has every section.

Credentials never go in the file. They go in the gateway's own `.env`, at `$MT_HOME/.env`, or in
the environment, or, for a role's agent, in that role's `.env`. The agent runs as the same user
as the gateway and is not sandboxed, so it can read anything on disk; a key in the file that
looks like a credential (`secret`, `token`, `password`, `apiKey` and the like) is refused at
startup, and so is an `env:` key, which would put values in the file.

Four rules hold everywhere:

- **Everything is checked at startup.** A mistake prints one line, `configuration error: …`,
  and the gateway exits 78.
- **The environment wins.** Every setting that has an environment variable can be set by it,
  and the variable wins over the file, so an emergency change needs no edit. A list set by the
  environment replaces the file's list, never merges with it.
- **Empty means closed.** An empty `auth.talk` lets in the owner alone, not everyone.
- **An unknown key is an error.** A misspelled key is refused with the list of keys that
  section knows, rather than silently taking its default.

The file mixes two spellings: the top level and the `lark`, `auth` and `agent` sections are
camelCase (`maxLiveSessions`, `directMessages`), while `kanban` and `cron` are snake_case
(`max_running`, `idle_timeout_s`), as their designs spell them. The `kanban` and `cron` keys are
set in the file only: `MT_KANBAN_*` and `MT_CRON_*` are names a run's agent is given, and a
setting under them would read as one.

## 1. The minimum to start

Four things are required: the Lark app id, its secret, the owner, and a workspace with an agent.

```yaml
# ~/.manus-team/config.yaml
lark:
  appId: cli_xxxxxxxxxxxxxxxx

auth:
  owner: ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

workspace: /srv/work

agent:
  command: claude-agent-acp
```

**The app id** is the Lark app's, from its console. Set the app up first, with its permissions
and events: [Feishu/Lark app setup](../README.md#feishulark-app-setup). For Lark rather than
Feishu, also set `lark.domain: https://open.larksuite.com`.

**The app secret** goes in `$MT_HOME/.env`, never in the file. Write it from a shell that already
holds it:

```bash
(umask 077; printf 'LARK_APP_SECRET=%s\n' "${LARK_APP_SECRET:?is not set}" > ~/.manus-team/.env) && chmod 600 ~/.manus-team/.env
```

The line writes the value without printing it, writes nothing if `LARK_APP_SECRET` is not set,
and the `umask` keeps the file owner-only from the moment it exists. The `>` replaces an existing
`.env` whole: if you have one, add the line with an editor instead.

The gateway refuses to start unless the `.env` is a regular file (not a symlink), owned by the
user the gateway runs as, and readable and writable by that user alone (`0600` or `0400`). A
role's `.env` is checked the same way. Both take `NAME=value` lines, `#` comments on lines of
their own, and one pair of optional quotes; no `export`, no expansion, and no control character
but the tab. An unquoted value keeps everything after the `=`, a trailing ` # note` included.

The gateway's `.env` may set only the variables the gateway reads (the
[environment table](#environment-only) and every variable in the reference's Environment column)
and `MT_AGENT_ENV_<NAME>`; any other name is refused, as an unknown key is. It may not set
`MT_HOME`, `MT_CONFIG` or `MT_DB`, which say where the gateway's files are and so belong to the
environment the gateway starts with. The environment wins over it, name by name. No agent is
given the file. Only its secrets, `LARK_APP_SECRET` and `MT_AGENT_ENV_*`, are masked in what
the gateway shows; ids, paths and limits are shown as written.

**The owner** is your Lark `open_id`, `ou_…`. An open_id is per app: the same person has a
different one in each app, so it must be the one this app sees. The gateway tells you yours.
Start it with any placeholder owner, such as `ou_placeholder`, and send the bot a direct
message. You are not let in, and the log says who you are:

```text
2026-11-25T09:14:03.120Z rejected om_xxxx from ou_5d1e7a… in oc_9f2c… (sender_not_allowed) with no bound session
```

Put the `ou_…` id in `auth.owner` and restart. The `oc_…` id after `in` is the chat's id, which
`auth.chats` takes. The line is written for a message refused in a chat where you have no
session yet. Read the log with `mt service logs`, or on the terminal of a gateway run by hand.

**A workspace** is the absolute path of an existing directory the agent works in. `workspace:`
is the shortcut for a single one; [section 4](#4-workspaces-and-roles) names several.

**An agent** runs chat sessions: here `claude-agent-acp`, the Claude Code ACP agent, on `PATH`.
[Section 3](#3-choosing-the-agent) covers the choice. The `agent:` block is the role `default`;
a `roles/default/` directory can take its place.

**Run it.** Check, install the service, and watch it connect:

```bash
mt service check     # would this build start? Before install, as a gateway run from this shell
mt service install
mt service logs -f   # until "connected as ou_…"
```

Or by hand from a checkout, `npm run dev`. The service gets `PATH` and `MT_HOME` and nothing
else from your shell, which is why the secret belongs in the `.env`:
[Running as a service](../README.md#running-as-a-service).

## 2. Who may use it

```yaml
auth:
  owner: ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  talk:
    - ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb   # may chat with the agent and read the board
    - ou_ccccccccccccccccccccccccccccccc
  operate:
    - ou_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb   # may also answer approvals and change the board
  chats: []               # empty: any chat the bot is in
  directMessages: true
  mentionAll: false
```

**Tiers.** `auth.talk` lists who may prompt the agent and read; `auth.operate` lists who may also
answer approval cards and run the commands that change things, such as `/new` and the board's.
The owner is always in both. Operate needs talk: an `auth.operate` entry that is not also in
`auth.talk`, and holds no talk grant, gets neither tier, so list each operator in both. Entries
are open_ids, found as the owner's is.

**Empty means closed.** An empty or missing `auth.talk` lets in the owner alone. The same holds for
the environment: `MT_ALLOW_TALK=`, set but empty, means the owner alone, and is not a fallback to
the file.

**Grants** let people in without an edit or a restart. In a group the person is in, @-mention
them:

```text
/auth grant @Carol Wu talk
/auth grant @Carol Wu operate
/auth revoke @Carol Wu
/auth list
```

An operator grants and revokes talk; only the owner grants operate. At the terminal, as the
owner, for a person the bot has seen (`mt kanban people` lists them):

```text
mt auth grant lark:on_5d1e7a operate
mt auth list
mt auth revoke lark:on_5d1e7a
```

A grant counts at once and is kept in the database. It adds a person beside the lists and never
removes a list entry or the owner; a grant that cannot be read counts as none. Grants belong to
one app id: after a change of `lark.appId`, the old app's grants count for nothing, and the
startup log says how many. More in the board guide:
[Letting people in](kanban-guide.md#letting-people-in).

**Chats.** `auth.chats` lists the `chat_id`s (`oc_…`) the bot acts in. Empty, which is the
default, means any chat it has been added to. A direct message is a chat too: with a non-empty
list, a direct message whose own chat is not listed is refused. `mt cron add --chat` and
`mt kanban task new --chat` refuse a chat outside a non-empty list.

**Direct messages and @all.** `auth.directMessages`, on by default, answers a direct message
without a mention; off, direct messages are refused. `auth.mentionAll`, off by default, treats
`@all` in a group as addressing the bot; it is off because `@all` is an announcement, not an
instruction.

## 3. Choosing the agent

Two drivers run an agent. Both have been run in real use: Claude Code (`claude-agent-acp`) over
`acp`, and bytesec over `structured-cli`.

**`acp`, the default**, runs one process per session that speaks the Agent Client Protocol. It is
the only driver that asks before acting, so it is the one with approval cards, and the only one
where `auth.operate` gates the agent's tools:

```yaml
agent:
  driver: acp
  command: claude-agent-acp
  args: []
  passEnv: []
```

A subscription-authenticated Claude Code keeps its credentials under `$HOME`, which the agent is
given already, so it needs no `passEnv`.

**`structured-cli`** runs one process per turn, with the prompt on its command line, and reads
JSON back: it is written for bytesec's `run --format json`. It has no way to ask, so the agent
edits files and runs commands with no approval card, and the file must say you accept that:

```yaml
agent:
  driver: structured-cli
  command: bytesec
  args: [run, -m, bytesec/modelhub-sg/gpt-5.6-sol]
  unsupervised: true
```

`unsupervised: true` is required by `structured-cli` and refused with `acp`: a file must not
claim a posture the gateway is not in. Each turn resumes the agent's own session by its id, on
bytesec 0.7.4 or later. Below that, resume is unmeasured and `mt role check` warns; when the
agent refuses the id, the turn sends the conversation again as text, which costs input tokens
and loses the tool state behind it.

**`command` and `args`.** `command` is the binary alone, on `PATH` or absolute. `args` is a list,
or one string split on whitespace with quotes honoured. Neither goes through a shell: the agent
is spawned with no shell, so `$HOME` and `$(…)` pass through literally. A command with a space
in it, such as `command: bytesec run`, is refused and the error shows the `args` it meant; an
absolute path with a space is allowed.

**The agent's environment.** The agent gets a short allowlist of the gateway's environment
(`PATH`, `HOME`, `USER`, the locale, `TMPDIR`, the proxy variables and a few more), and on top of
it, three sources you choose:

```yaml
agent:
  command: claude-agent-acp
  passEnv: [ANTHROPIC_API_KEY]      # names only; the value stays in the environment
  maskExempt: [ANTHROPIC_BASE_URL]  # long, but not secret: not masked
```

- `passEnv` names variables forwarded from the gateway's environment. Names only, never
  `NAME=value`. A name that is not set is an error, since forwarding nothing shows up much later
  as an agent that cannot authenticate. A name starting `MT_` or `LARK_` is refused: those are
  the gateway's.
- `MT_AGENT_ENV_<NAME>`, in the gateway's `.env` or environment, reaches the agent as `<NAME>`:
  `MT_AGENT_ENV_ANTHROPIC_API_KEY` becomes `ANTHROPIC_API_KEY`, and wins over `passEnv`. It
  applies to the `agent:` block only, and any `MT_AGENT_*` variable counts as defining that
  block. Prefer it to `passEnv` under the service, whose environment holds only `PATH` and
  `MT_HOME`.
- A role directory's `.env`, for a role's agent ([section 4](#4-workspaces-and-roles)).

The gateway masks every value it gives an agent, as `••••`, in what it shows in chat and in what
it stores, except names listed in `maskExempt`. Values shorter than 8 characters are not masked.
A secret the agent finds for itself, in a file say, is not known to the gateway and is not
masked.

`readOnlyTools` lists the agent's tools that only read. A task with `retry_on_crash:
if-no-side-effects` is retried after a crash only if every tool its run called is in the list.

## 4. Workspaces and roles

### Workspaces

```yaml
workspaces:
  default: /srv/repos/main
  docs: /srv/repos/docs
  notes:
    path: /home/me/.manus-team/workspaces/notes
    isolated: true
  web:
    path: /srv/repos/web
    isolated: true
    base: main
```

`workspaces` names several directories; `default` is required, and chat sessions run in it.
`workspace: /path` is the same as `workspaces.default`, and setting both is an error. Each path
must be absolute and an existing directory; it may not be or contain `$MT_HOME`, its `roles/` or
the database; inside `$MT_HOME`, only `workspaces/<name>` may be one; and no two may share or nest
in one directory. A name keeps the directory it was first used with: point it elsewhere and the
gateway will not start, so give a new directory a new name. Names are lowercase letters, digits
and `-`, start with a letter, do not end with `-`, and are at most 40 characters.

A plain workspace runs one agent at a time. An **isolated** one, written as a mapping with
`isolated: true`, gives each board task a directory of its own, so its tasks run side by side.
In a plain folder that is an empty folder under `$MT_HOME/worktrees/<workspace>/`; in a git
repository it is a worktree there on the branch `mt/<task_id>`, started from `base` (a branch,
tag or commit; unset, whatever the repository has checked out) or from the task's parents.
`base` needs `isolated: true`. The gateway never merges, pushes or deletes branches for you.
`mt workspace add <name> <path> [--isolated]` adds one, keeping the file's comments. More:
[Roles and workspaces](../README.md#roles-and-workspaces).

### Roles

A role is a directory under `$MT_HOME/roles/`. `mt role create <name>` writes one:

```text
roles/analyst/
  config.yaml              # the agent, and optionally a description, workspace and max_running
  role.md                  # optional standing instructions
  skills/<name>/SKILL.md   # optional skills
  .env                     # optional, owner-only: this role's own secrets
```

```yaml
# roles/analyst/config.yaml
description: Researches a question and writes up what it finds
workspace: notes
max_running: 2
agent:
  driver: structured-cli
  command: bytesec
  args: [run, -m, bytesec/modelhub-sg/gpt-5.6-sol]
  unsupervised: true
  skills: [lark-doc]
```

- `agent` is required, with the same keys as the gateway's `agent:` block, plus `native` (false
  sends `role.md` and the skills in the task prompt instead of a bytesec agent package) and
  `skills` (skills imported by name from the user's own skill directories).
- `agent.maxSteps` is the most agent steps (model calls, with their tool uses) one turn may take
  before the agent stops it; a whole number from 1 to 1000. Unset, the agent's own limit applies:
  bytesec's is 50, and a turn past it fails with "exceeded max steps". Only a bytesec role rendered
  as an agent package takes it today, written as the package agent's `steps`. Claude Code calls
  these turns (`maxTurns`) and is not wired yet. A role whose agent cannot apply it is refused at
  startup, with one line: an agent no renderer takes, as
  `agent.maxSteps: this role's agent (claude-agent-acp over acp) has no step limit the gateway can set`,
  a role not rendered (`native: false`, or no `role.md` and no skills), and the role `default`,
  whose chat sessions are not rendered. The `agent:` block does not take it. `mt role check` shows
  each role's value, or whose default applies.
- `description` is shown by `/role list` to anyone at talk tier; with none, the first line of
  `role.md` is. Keep in neither anything a talk-tier person should not read.
- `workspace` names a configured workspace the role always works in.
- `max_running` caps the role's open agent runs. A role without one takes
  `kanban.max_running_per_role`; with neither it has no cap of its own. Either is refused above
  `kanban.max_running`.
- `tools`, a tool policy, is refused: no driver in this build can enforce one, and accepting it
  would leave a role believed restricted that is not.
- The role's `.env` holds its secrets as `NAME=value` lines, given to its agent and masked. It may
  not set a name starting `MT_` or `LARK_`, nor `PATH`. A name may be in the `.env` or in
  `agent.passEnv`, not both.

The role `default` runs chat sessions. It is `roles/default/` if that exists, else the gateway's
`agent:` block; both, or neither, stops the gateway. `mt role create default` moves an `agent:`
block into `roles/default/`; then remove the block and every `MT_AGENT_*` variable. A change to a
role takes effect at the next start. `mt role check` runs the startup checks on every role, or on
one with `mt role check <name>`.

### The common mistakes

These three come up most. Each stops the gateway with one line.

**A gateway name in a role's `.env`.**

```text
LARK_APP_ID=cli_xxxxxxxxxxxxxxxx
```

```text
configuration error: /home/me/.manus-team/roles/analyst/.env: LARK_APP_ID may not be set in a role's .env: it belongs to the gateway
```

Remove the line. `LARK_*` and `MT_*` are the gateway's identity and settings, and live in
`$MT_HOME/.env` or `config.yaml`; `PATH` is set by the gateway for every run.

**A value in `passEnv`.** `passEnv` takes names, not `NAME=value`:

```yaml
agent:
  passEnv: [LARK_APP_ID=cli_xxxxxxxxxxxxxxxx]
```

```text
configuration error: /home/me/.manus-team/roles/analyst/config.yaml: agent.passEnv must not forward LARK_APP_ID=cli_xxxxxxxxxxxxxxxx: it belongs to the gateway
```

Remove the entry. To give a role's agent a value, put `NAME=value` in its `.env`; to forward a
variable the gateway's environment already holds, list its name alone, as `passEnv: [GITHUB_TOKEN]`.
A `LARK_` or `MT_` name cannot be forwarded either way.

**An empty entry.** A dash with nothing after it is an empty entry:

```yaml
agent:
  passEnv:
    -
```

```text
configuration error: /home/me/.manus-team/roles/analyst/config.yaml: agent.passEnv[0] must be a non-empty string
```

Write `passEnv: []`, or a name after the dash. Every list in the file is checked this way.

## 5. Turning features on, one by one

Each feature is off until its key is set, except wakes, which follow the board. A change to the
file takes effect at the next start: `mt service restart`.

### The board

```yaml
kanban:
  enabled: true
  max_running: 6              # open agent runs at once; default maxLiveSessions
  max_running_per_role: 2     # for a role with no max_running of its own
```

With the board on, the gateway runs its dispatcher, `/kanban` works in chat, tasks' notices and
people's cards are sent, and a supervised role's approvals go to the chat that follows its task.
It listens on `$MT_HOME/run/kanban.sock` for the agents' reports, writes `$MT_HOME/bin/mt` and
puts that directory first on every run's `PATH` (keep nothing else in it), and holds
`$MT_HOME/run/gateway.pid` while it runs. Give the app `im:chat.members:read` too, or every card
goes by direct message. Off, `/kanban` says the board is off. The startup log says
`kanban: dispatching up to 6 agent run(s) at once`.

`kanban.max_running` may not be above `maxLiveSessions`, since a run is a live session; set it
lower to keep room for chat. The other limits, failures, throttling, runtimes, the sweep, and
reminders, are in the [reference](#kanban). How to use the board:
[the board guide](kanban-guide.md).

### Wakes

```yaml
kanban:
  enabled: true
  wake:
    enabled: true     # the default
    per_hour: 6
    max_depth: 5
    hold_minutes: 10
```

A task with wake on starts a turn of the agent in the conversation that follows it when it is
done, has changes requested, blocks, gives up or is stranded. Wakes are on by default but do
nothing while `kanban.enabled` is off, and each task opts in, so `kanban.wake.enabled: false` is
for an operator who wants none at all: then nothing is woken and a wake asked for is refused.
`per_hour` caps woken turns a conversation an hour, `max_depth` keeps a task that many woken
turns deep to notices only, and `hold_minutes` is how long a block's Unblock button waits for
the agent's try. The startup log says
`kanban: wakes on; at most 6 woken turns a conversation an hour, tasks up to 4 woken turns deep`.
More: [Wakes](kanban-guide.md#wakes).

### Progress cards

```yaml
kanban:
  enabled: true
  progress:
    enabled: true
    min_seconds: 30
```

An agent run that has gone on for `min_seconds` gets a live card in its task's thread, or its
direct message: the task, the role, the try, each tool and its state, the tail of what the agent
is saying, and a Stop button, drawn final when the run ends. A person's task gets none, and so
does a task followed at a group's chat scope. Off by default, and nothing while the board is
off. The startup log says `kanban: progress cards on, for agent runs past 30 s`.

**What it exposes.** Everyone in the thread sees the card, talk tier or not: every tool's title,
which can hold a command line or a path, and what the agent says mid-run, before its report.
Only the secrets the gateway knows are masked (its credentials, run tokens and roles' `.env`
values); a secret the agent reads from a file and prints is shown as printed. More:
[Progress cards](kanban-guide.md#progress-cards).

### Cron

```yaml
cron:
  enabled: true
  max_running: 2
  idle_timeout_s: 600
  tz: Asia/Shanghai
```

At a job's time the gateway opens a fresh session of the job's role, gives it the prompt and
posts the answer in the chat that made the job. A job's role must be unsupervised, since nobody
watches a fire. `max_running` caps fires at once, apart from the board's runs; `idle_timeout_s`
stops a fire whose turn is quiet that long; `tz` is the zone a new job gets when it names none,
checked as an IANA zone, and the process's own zone when unset. Every job keeps the zone it was
given.

With cron off, `/cron` says so, and no chat session's agent gets a token or a changed `PATH`.
With it on, a chat agent's shell holds `MT_CRON_TOKEN`, so an agent can add a job of its own,
and the operator's `mt kanban`, `mt service`, `mt update` and `mt cron` are refused there. The
startup log says, for instance,
`cron: 0 active job(s), 0 paused; up to 2 fire(s) at once, each stopped after 600 s with no activity; new jobs in Asia/Shanghai (from cron.tz), and every job keeps its own zone`.
More: [Cron jobs](../README.md#cron-jobs) and [the guide's section 15](kanban-guide.md#15-cron-jobs).

## 6. Checking it

- `mt service check` asks whether this build would start as the service: with the unit's `PATH`,
  `MT_HOME` and the `.env` only, or, with no service installed, as a gateway started by hand from
  this shell. It loads the config, the roles and the gateway's modules, and ends with
  `ok: this build would start as …`.
- `mt role check [<name>]` runs the role checks, and reports what comes from this shell's
  environment apart from the files: each `passEnv` name this shell does not set, whether the
  gateway's `.env` exists and the names it sets (never their values), whether each role runs as
  a native bytesec package, and a bytesec older than 0.7.4.
- `mt workflow check [<name>]` checks the files in `$MT_HOME/workflows/`.
- `mt service install` runs the same check as `mt service check` and refuses to install a unit
  that would fail. `mt update` reads the configuration with the running build before it changes
  anything, and refuses when that build rejects it ("the running build rejects the configuration,
  so the database cannot be found"): a config edited ahead of an update, for a key only the new
  build knows, is the usual cause, so update first and edit after. It then has the new build run
  `mt service check`, and goes back to the old build if that fails.

**The startup lines.** A gateway that starts writes, in order, lines such as:

```text
gateway .env: /home/me/.manus-team/.env sets LARK_APP_SECRET
2026-11-25T09:14:01.002Z settings from /home/me/.manus-team/config.yaml, environment overrides applied
2026-11-25T09:14:01.010Z roles: analyst, default; workspaces: default, notes
2026-11-25T09:14:01.031Z schema at version 14 (/home/me/.manus-team/team.db)
2026-11-25T09:14:01.044Z kanban: dispatching up to 6 agent run(s) at once
2026-11-25T09:14:02.517Z connected as ou_…
```

The second line names the file read, or says `no config file; settings from the environment
alone`: if it names a file you did not mean, that is why your settings seem ignored. A
`structured-cli` role adds `role analyst (structured-cli): the agent acts without approval cards
(agent.unsupervised is set)`, and each feature turned on adds its line, as section 5 shows.

**A mistake** prints one line and exits 78 (`EX_CONFIG`), so a supervisor can tell it from a
crash; under systemd the unit stays failed rather than restarting every 30 seconds:

```text
configuration error: /home/me/.manus-team/config.yaml: unknown setting kanban.max_runing (known: enabled, max_running, max_running_per_role, failure_limit, transient_limit, transient_cooldown_s, default_max_runtime_s, sweep_interval_s, stranded_after_s, nudge_limit, block_recurrence_limit, wake, progress)
```

An error never prints a value read from the environment; it names the variable instead.
**The environment wins:** a setting that seems not to apply may be overridden by a variable in the
service's environment or the gateway's `.env`. `mt role check` lists the `.env`'s names.

## 7. Full reference

Every key the config file accepts, with its default, its limits and the environment variable
that overrides it. "File only" means no variable sets it. A whole number below is an integer
of at least 1 unless the limits say otherwise.

### Top level

| Key | Default | Limits | Environment | Meaning |
|---|---|---|---|---|
| `workspace` | none | an absolute path | `MT_WORKSPACE` | The workspace `default`. Required unless `workspaces.default` is set; both is an error. |
| `workspaces.<name>` | none | an absolute path | file only | A named workspace's directory. `default` is required, here or as `workspace`. |
| `workspaces.<name>.path` | none | an absolute path | file only | The directory, when the workspace is written as a mapping. Required in a mapping. |
| `workspaces.<name>.isolated` | `false` | `true` or `false` | file only | Each board task gets a directory of its own. |
| `workspaces.<name>.base` | what the directory has checked out | a branch, tag or commit; no leading `-`, no space | file only | Where a task with no parents starts, in a git workspace. Needs `isolated: true`. |
| `maxLiveSessions` | `8` | a whole number | `MT_MAX_LIVE_SESSIONS` | Agent processes at once; sessions beyond it stay cold until one frees up. |
| `db` | `$MT_HOME/team.db` | a path | `MT_DB` | The SQLite database. Its directory holds the WAL, so it must be writable. |
| `downloads` | `$MT_HOME/downloads` | a path | `MT_DOWNLOAD_DIR` | Where inbound attachments land, outside every workspace. |

### lark

| Key | Default | Limits | Environment | Meaning |
|---|---|---|---|---|
| `lark.appId` | none | | `LARK_APP_ID` | The app id. Required. |
| `lark.domain` | Feishu | a URL | `LARK_DOMAIN` | `https://open.larksuite.com` for Lark. |

The app secret has no key: it is `LARK_APP_SECRET`, required, in `$MT_HOME/.env` or the
environment.

### auth

| Key | Default | Limits | Environment | Meaning |
|---|---|---|---|---|
| `auth.owner` | none | an open_id | `MT_OWNER_OPEN_ID` | You. Required. Always in both tiers, and cannot be revoked. |
| `auth.talk` | `[]`, the owner alone | open_ids | `MT_ALLOW_TALK`, comma-separated | May prompt the agent and read. Grants add people beside it. |
| `auth.operate` | `[]`, the owner alone | open_ids | `MT_ALLOW_OPERATE`, comma-separated | May also answer approvals and change things. Needs talk tier too. |
| `auth.chats` | `[]`, any chat | chat_ids | `MT_ALLOW_CHATS`, comma-separated | The chats the bot acts in, direct messages included. |
| `auth.directMessages` | `true` | `true` or `false` | `MT_ALLOW_DM` | Answer a direct message without a mention; off refuses them. |
| `auth.mentionAll` | `false` | `true` or `false` | `MT_ALLOW_MENTION_ALL` | Treat `@all` as addressing the bot. |

A variable for a flag takes `true` or `false`, `1` or `0`, `yes` or `no`, `on` or `off`. A list
variable that is set but empty is an empty list, not the file's.

### agent

The role `default`, when there is no `roles/default/`. The block is optional when that directory
exists; any `MT_AGENT_*` variable counts as setting it.

| Key | Default | Limits | Environment | Meaning |
|---|---|---|---|---|
| `agent.driver` | `acp` | `acp` or `structured-cli` | `MT_AGENT_DRIVER` | How the agent is run. |
| `agent.command` | none | a binary on `PATH`, or an absolute path; no space unless absolute | `MT_AGENT_COMMAND` | The agent. Required in the block. |
| `agent.args` | `[]` | a list, or one string split on whitespace with quotes honoured | `MT_AGENT_ARGS` | Arguments, passed with no shell. |
| `agent.unsupervised` | `false` | `true` or `false` | `MT_AGENT_UNSUPERVISED` | Required true by `structured-cli`, refused with `acp`. |
| `agent.passEnv` | `[]` | variable names; none starting `MT_` or `LARK_`; each must be set | file only | Variables forwarded from the gateway's environment. |
| `agent.readOnlyTools` | `[]` | tool names | file only | Tools that only read, for `retry_on_crash: if-no-side-effects`. |
| `agent.maskExempt` | `[]` | variable names | file only | Variables whose values are not masked. |

### kanban

File only, and snake_case.

| Key | Default | Limits | Environment | Meaning |
|---|---|---|---|---|
| `kanban.enabled` | `false` | `true` or `false` | file only | Run the board. |
| `kanban.max_running` | `maxLiveSessions` | 1 to 256, and at most `maxLiveSessions` | file only | Open agent runs at once, over every board and role. |
| `kanban.max_running_per_role` | none, no cap | 1 to 256, and at most `kanban.max_running` | file only | Open runs as any one role whose `config.yaml` sets no `max_running`. |
| `kanban.failure_limit` | `2` | 1 to 100 | file only | Counted failures before a task gives up and blocks: a first try and one retry. |
| `kanban.transient_limit` | `10` | 1 to 1000 | file only | Throttled runs in a row before a task blocks. |
| `kanban.transient_cooldown_s` | `300` | 1 to 3600 | file only | The first wait after a throttled run, doubling each time, up to an hour. |
| `kanban.default_max_runtime_s` | `14400` (4 hours) | 1 to 604800 (7 days) | file only | A run's wall-clock limit, unless its task sets one. |
| `kanban.sweep_interval_s` | `60` | 1 to 3600 | file only | How often runtimes, cooldowns and stranded tasks are checked. |
| `kanban.stranded_after_s` | `1800` (30 minutes) | 1 to 2592000 (30 days) | file only | How long a task nobody can take waits before it is reported stranded. |
| `kanban.nudge_limit` | `2` | 0 to 10 | file only | Reminders to a run whose turn ended with no report, before it ends as a protocol violation; 0 sends none. |
| `kanban.block_recurrence_limit` | `2` | 1 to 100 | file only | Blocks of one kind in a row at which a blocked notice suggests rewriting the task. |

### kanban.wake

| Key | Default | Limits | Environment | Meaning |
|---|---|---|---|---|
| `kanban.wake.enabled` | `true` | `true` or `false` | file only | Wake the agent for the outcomes of a task with wake on. Nothing while the board is off. |
| `kanban.wake.per_hour` | `6` | 1 to 60 | file only | Woken turns a conversation in any hour. |
| `kanban.wake.max_depth` | `5` | 1 to 20 | file only | A task this many woken turns deep stays notice-only. |
| `kanban.wake.hold_minutes` | `10` | 1 to 60 | file only | How long a block's Unblock button waits for the agent's try. |

### kanban.progress

| Key | Default | Limits | Environment | Meaning |
|---|---|---|---|---|
| `kanban.progress.enabled` | `false` | `true` or `false` | file only | A live card for each long agent run a thread or direct message follows. See [what it exposes](#progress-cards). |
| `kanban.progress.min_seconds` | `30` | 0 to 3600 | file only | A run gets its card once it has run this long. |

### cron

File only, and snake_case.

| Key | Default | Limits | Environment | Meaning |
|---|---|---|---|---|
| `cron.enabled` | `false` | `true` or `false` | file only | Run the scheduler. |
| `cron.max_running` | `2` | 1 to 16 | file only | Fires at once, apart from the board's runs. Not checked against `maxLiveSessions`. |
| `cron.idle_timeout_s` | `600` | 60 to 86400 | file only | A fire's turn quiet this long is cancelled. |
| `cron.tz` | the process's zone | an IANA zone, such as `Asia/Shanghai` | file only | The zone a new job gets when it names none. |

### Environment only

| Variable | Default | Meaning |
|---|---|---|
| `LARK_APP_SECRET` | none | The app secret. Required. In `$MT_HOME/.env` (0600) or the environment; never in the file. |
| `MT_AGENT_ENV_<NAME>` | none | Given to the `agent:` block's agent as `<NAME>`; wins over `passEnv`; masked. |
| `MT_HOME` | `~/.manus-team` | The gateway's home: the config file, `.env`, database, roles and workflows. Not in the `.env`. |
| `MT_CONFIG` | `$MT_HOME/config.yaml` | The config file. Named but missing is an error. Not in the `.env`. |
| `MT_SCHEMA_DIR` | this build's `schema/` | Where the migrations are read. A packaging setting, rarely set. |

`MT_DB` overrides `db` and may not be set in the `.env` either.

### A role's config.yaml

`$MT_HOME/roles/<name>/config.yaml`. Its keys are not settable by environment.

| Key | Default | Limits | Meaning |
|---|---|---|---|
| `description` | the first line of `role.md` | | What `/role list` shows for the role. |
| `workspace` | none: the task's | a configured workspace name | The workspace the role always works in. |
| `max_running` | `kanban.max_running_per_role` | a whole number, at most `kanban.max_running` | Open agent runs as this role at once. |
| `tools` | none | refused in this build | A tool policy; no driver can enforce one yet. |
| `agent.driver` | `acp` | `acp` or `structured-cli` | As the gateway's `agent.driver`. |
| `agent.command` | none | as the gateway's | Required. |
| `agent.args` | `[]` | as the gateway's | |
| `agent.unsupervised` | `false` | as the gateway's | |
| `agent.passEnv` | `[]` | as the gateway's; not also in the role's `.env` | |
| `agent.readOnlyTools` | `[]` | tool names | |
| `agent.maskExempt` | `[]` | variable names, from any source | |
| `agent.native` | `true` | `true` or `false` | False sends `role.md` and the skills in the task prompt instead of a bytesec agent package. |
| `agent.skills` | `[]` | skill names found in the user's skill directories | Skills imported by name, beside the role's own `skills/`. |
| `agent.maxSteps` | none: the agent's own (bytesec's is 50) | a whole number from 1 to 1000; a rendered bytesec role only | The most agent steps (model calls, with their tool uses) one turn may take. Written as the bytesec package agent's `steps`; Claude Code's `maxTurns` is not wired yet. Refused at startup for a role whose agent cannot apply it: no renderer, `native: false`, nothing to render, or the role `default`. |
