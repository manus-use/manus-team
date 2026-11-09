# manus-team

A vendor-neutral gateway for driving coding agents (Claude Code, Gemini CLI, Codex, and any
other ACP-compatible agent) from any channel — Feishu/Lark, Telegram, web, Slack, REST.

**Status:** first channel implemented. A Feishu/Lark message drives Claude Code in a
configured repository and the answer streams back into an interactive card. The broker
sidecar is not built yet, so **restarting the gateway kills every live agent**; sessions
themselves survive and cold-resume on the next message.

Design: [`docs/architecture.md`](docs/architecture.md) (whole system),
[`docs/specs/2026-08-21-lark-channel-design.md`](docs/specs/2026-08-21-lark-channel-design.md)
(this slice).

## What it is

manus-team does not implement an agent loop. It launches real vendor agent runtimes and
speaks a structured protocol to them, while owning the things the vendors don't:

- **Durable sessions** that survive gateway restart, agent crash, and weeks of idleness
- **Multi-channel access** — one session drivable from several channels simultaneously
- **Central approvals** — the agent asks once, any bound channel can answer
- **Isolated workspaces** — git worktree per session, checkpointed at turn boundaries
- **Audit** — an append-only event log is the system of record

```
Channels ──> Gateway ──> Driver ──> Broker ──> Agent runtime
                │                      │
          event log (SQLite)     detached, reattachable
```

## The core idea

> A gateway session is a durable event log with an optional, reattachable agent runtime
> bound to it.

ACP agents run as local subprocesses over stdio, so whoever holds the pipe owns the
session's life. If the gateway holds it, restarting the gateway kills every session. The
**broker sidecar** breaks that coupling: it runs detached under tmux/systemd/container,
owns the agent's stdio, spools every event to disk, and serves `attach(from_offset)` when
the gateway comes back.

## Running it

Requires Node 22.12+ and an ACP-capable agent on `PATH`.

```bash
npm install
npm run build
npm start
```

### Feishu/Lark app setup

Create a custom app, then:

1. **Permissions:** the scopes the console lists for receiving and sending messages as the
   bot (`im/v1/messages`), downloading message resources for inbound attachments
   (`im/v1/messages/:message_id/resources`), and creating and updating cards
   (`cardkit/v1/cards`).
2. **Events:** subscribe to `im.message.receive_v1` and `card.action.trigger`, delivered over
   **long connection** — no public URL, no request signing to get wrong.
3. Add the bot to a chat, or message it directly.

### Sending to Lark

Every message the gateway sends as one message — a reply or a notice of up to 4,000
characters, an approval card, a board card — goes through the SDK's own client with a uuid, and
Lark shows one message for any number of sends with the same uuid within an hour. This reaches every chat, with the board
on or off, and differs from the SDK's own send in three ways everyone sees:

- Replies and notices no longer go through the SDK's markdown tidying (headings demoted, blank
  lines compressed); they are sent as written.
- Texts over 4,000 characters, and streamed answers, still go out the SDK's way, without the
  uuid: a retry of one can still post a second copy.
- The fallback from a post to plain text is narrower than the SDK's: only a post Lark refuses
  as invalid content (230001) goes as text. A reply to a message that is gone — Lark's 230011
  or 230017, or an HTTP 404 — goes to its chat, as the SDK's does; 230020 is retried as the
  chat's rate limit instead.

**Before deploying this build at all (kanban off).** Run these steps of the smoke test at the
end of docs/plans/2026-11-05-plan-d2-kanban-people.md against the live tenant first, with
`kanban.enabled` off, and deploy only once they pass:

- the chat-session half of step 1: an approval card in a chat session, pressed and redrawn;
- step 8: one message per uuid, at chat scope and in a thread;
- step 11: a reply to a withdrawn message arrives in its chat;
- a `/help` reply in a direct message, in a group, and in a thread.

### Configuration

Settings live in a YAML file; credentials live in the environment. Start from
[`config.example.yaml`](config.example.yaml):

```bash
cp config.example.yaml ~/.manus-team/config.yaml
export LARK_APP_SECRET=...
```

`MT_CONFIG` names the file if you keep it elsewhere; otherwise it is
`$MT_HOME/config.yaml`, default `~/.manus-team/config.yaml`. A file that is named but
missing is an error, while the default location being absent is an ordinary
environment-only deploy.

**Credentials go in the environment, or in a role's `.env`.** The agent runs as the same
user and is not sandboxed in this build, so anything on disk it can read. The environment
is not airtight either — a same-uid process can read `/proc/<pid>/environ` on Linux — but
it does not persist, is not backed up, cannot be copied into a worktree, and cannot be
committed by accident. A key that looks like a credential (`secret`, `token`, `password`,
`apiKey`, …) is refused at boot rather than quietly accepted, and so is `agent.env`, which
would put values in the file rather than names. A role's `.env` is the one file secrets are
read from: it must be a regular file owned by the gateway's user, readable and writable only
by its owner (for example `0600` or `0400`). It may not set `MT_*`, `LARK_*` or `PATH`.

The gateway masks every secret it holds itself — the Lark app secret, and every value it gives
an agent from a role's `.env`, `passEnv` or `MT_AGENT_ENV_*`, except names the role lists in
`agent.maskExempt` — as `••••` in everything it shows in chat, and in what it stores in its event
log and approvals. A secret split by a character that shows nothing (a zero-width or bidi
character, a direction mark) is masked too. Values shorter than 8 characters are not masked. A secret the agent finds by
itself, for instance in a file it reads, is not known to the gateway and is not masked.

| File setting | Env override | Meaning |
|---|---|---|
| — | `LARK_APP_SECRET` **(required)** | The app secret. Environment only; never written to disk or the event log. |
| `lark.appId` | `LARK_APP_ID` | App id. Required from one source or the other. |
| `lark.domain` | `LARK_DOMAIN` | Set for Lark (`https://open.larksuite.com`); omitted means Feishu. |
| `auth.owner` | `MT_OWNER_OPEN_ID` | Your `open_id`. Required. Always in both allowlists — an allowlist that excludes the owner locks out the only person who can fix it. |
| `auth.talk` | `MT_ALLOW_TALK` | `open_id`s that may prompt the agent. |
| `auth.operate` | `MT_ALLOW_OPERATE` | `open_id`s that may answer approvals and run mutating commands. |
| `auth.chats` | `MT_ALLOW_CHATS` | `chat_id`s the bot will work in. Empty means any chat it was added to. |
| `auth.directMessages` | `MT_ALLOW_DM` | Answer direct messages without a mention. Default on. |
| `auth.mentionAll` | `MT_ALLOW_MENTION_ALL` | Treat `@all` as addressing the bot. Default **off**: `@all` is a room-wide notification, not an instruction. |
| `workspace` | `MT_WORKSPACE` | Absolute path the agent works in. Required unless `workspaces` is set. |
| `workspaces` | — | Named workspaces: `name: absolute-path`. Must include `default` (or use `workspace`). |
| `agent.driver` | `MT_AGENT_DRIVER` | `acp` (default) or `structured-cli`. See [Protocol strategy](#protocol-strategy) — the CLI driver cannot ask before acting. |
| `agent.command` | `MT_AGENT_COMMAND` | The agent binary, e.g. `claude-agent-acp`. Required unless `roles/default/` exists. |
| `agent.args` | `MT_AGENT_ARGS` | A list, or one string split on whitespace with quotes honoured. Not a shell: `$HOME` is not expanded, because the agent is spawned with `shell: false`. |
| `agent.unsupervised` | `MT_AGENT_UNSUPERVISED` | Required by, and only by, `structured-cli`: a written acknowledgement that the agent acts with no approval card and no gate from `auth.operate`. Setting it alongside the `acp` driver is an error — a config must not claim a posture the gateway is not in. |
| `agent.readOnlyTools` | — | The agent's tool names that only read. Checked at startup but not used in this build; automatic retry of a failed run will use it. |
| `agent.maskExempt` | — | Variable names whose values are long but not secret, such as a base URL, so not masked. |
| `agent.passEnv` | — | Variable **names** forwarded to the agent from the gateway's own environment. A name that is not set is an error, because forwarding nothing surfaces later as the agent failing to authenticate. Leave it empty for a subscription-authenticated agent: its credentials are under `$HOME`, which is forwarded already. |
| — | `MT_AGENT_ENV_*` | Forwarded with the prefix stripped: `MT_AGENT_ENV_ANTHROPIC_API_KEY` becomes `ANTHROPIC_API_KEY`. Wins over `passEnv`. Opt-in by prefix, because an agent holding the Feishu secret could post as the bot and answer its own approvals. |
| `maxLiveSessions` | `MT_MAX_LIVE_SESSIONS` | Concurrent agent processes. Default 8. |
| `kanban.enabled` | — | Run the board: its dispatcher, the worker socket, `/kanban` in chat and its notices, people's cards, and forwarding supervised roles' approvals to the chat that follows a task. Default **off**, and opt-in: without it chat runs as it always did, and `/kanban` says the board is off. The `kanban:` keys are snake_case, as the kanban design spells them; the rest of the file is camelCase. They are set in the file only, and each number has a ceiling (below); a value above it is a startup error. |
| `kanban.max_running` | — | Open agent runs at once. Default `maxLiveSessions`, and refused above it: a run is a live session. Set it lower to keep room for chat. At most 256. |
| `kanban.max_running_per_role` | — | Open agent runs as any one role at once, for every role whose `config.yaml` sets no `max_running` of its own. Unset, a role has no limit of its own. Refused above `kanban.max_running`. At most 256. |
| `kanban.failure_limit` | — | Counted failures before a task gives up and blocks. Default 2: a first attempt and one retry. At most 100. |
| `kanban.transient_limit`, `kanban.transient_cooldown_s` | — | A throttled run is retried after a cooldown, 300 s by default, doubling each time up to an hour; after 10 in a row the task blocks. At most 1000 in a row, and a first cooldown of at most 3600 s. |
| `kanban.default_max_runtime_s` | — | A run's wall-clock limit unless its task sets one. Default 4 hours, at most 7 days. |
| `kanban.sweep_interval_s`, `kanban.stranded_after_s` | — | How often the dispatcher checks runtimes, cooldowns and stranded tasks (default 60 s), and how long a task nobody can take waits before it is reported stranded (default 30 min). At most 3600 s and 30 days. |
| `kanban.nudge_limit` | — | Reminders sent into a run whose turn ended without a report, before the run ends as a protocol violation. Default 2; 0 sends none. At most 10. |
| `kanban.block_recurrence_limit` | — | Blocks of the same kind in a row, unblocked in between, at which a blocked notice stops inviting another unblock and suggests rewriting the task. Default 2, at most 100. |
| `db`, `downloads` | `MT_DB`, `MT_DOWNLOAD_DIR` | `$MT_HOME/team.db` and `$MT_HOME/downloads` unless set. |
| — | `MT_HOME` | State directory, and where the config file is looked for. Default `~/.manus-team`. |

Three rules make a mistake fail loudly instead of silently:

- **The environment wins.** Every file setting has an override, so a container needs no
  file and an emergency lockdown needs no edit. Lists are *replaced*, not merged — merging
  would leave no way to revoke. `MT_ALLOW_TALK=` set-but-empty means the owner alone.
- **Empty means closed.** An unset allowlist is everyone-except-the-owner, not
  no-restrictions.
- **An unknown key is an error.** A typo'd setting silently taking its default is how a
  value someone deliberately changed turns out never to have applied — and for the auth
  keys that failure is silent *and* permissive.

Everything is validated at boot; a configuration mistake prints one line and exits 78.

### Roles and workspaces

The board's tasks can be any work, not only code: research, writing a document, an operation
in Lark, an ops chore. A role's agent is a coding-agent CLI, used as a general worker with a
shell and tools. A workspace is a directory, which need not be a git repository. Gates are
optional checks of any kind: any command that exits 0 when the work is acceptable, for example
a script that checks a document exists or a link answers. The reported commit is recorded only
when the workspace is a git repository.

A **role** is who does a kind of work, and how it is run. Each is a directory under
`$MT_HOME/roles/`:

```
roles/implementer/
  config.yaml     # the coding agent, an optional workspace, description and max_running
  role.md         # optional standing instructions
  skills/<name>/SKILL.md   # optional; front matter gives name and description
  .env            # optional; this role's own secrets, owner-only (e.g. 0600)
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
```

A role's `max_running: N`, a positive whole number, lets at most N of its agent runs be open at
once, however many workspaces are free. A run counts against the role it runs as: a work run
against the task's assignee, a review run against its reviewer; a person's run never counts.
A role that sets none takes `kanban.max_running_per_role`, and with neither it has no limit of
its own. Either is refused at startup above `kanban.max_running`, which, like a board's own
`max_running`, still holds over every role together. A task whose role is at its limit waits,
and the board goes on to its next task; it is not reported stranded, and `/kanban task show`
says what it is waiting on. `mt role list` and `mt role check` show each role's limit and where
it comes from, and `mt role create` writes none. As with the rest of `config.yaml`, a change
takes effect at the next start.

A role may also use skills from the user's own, by name: `agent.skills: [lark-doc, lark-im]` in
its `config.yaml`. Each name is looked up where bytesec keeps a user's skills, in this order:
`$XDG_CONFIG_HOME/bytesec/skills` (else `~/.config/bytesec/skills`), the same directory's
`skill/`, then `~/.trae/skills`, `~/.coco/skills`, `~/.agents/skills` and `~/.claude/skills`. The
first real directory holding a `SKILL.md` wins; a symlink is not followed. A name that is not
found, is not a skill name bytesec loads, or is also one of the role's own skills, stops the
gateway at startup. An imported skill is
given to the agent exactly as the role's own are.

The role `default` runs chat sessions. It is `roles/default/` if that exists, and otherwise
the gateway's own `agent:` block (in the table above); having both, or neither, stops the
gateway at startup. Role and workspace names are lowercase letters, digits and `-`, start
with a letter, do not end with `-`, and are at most 40 characters; `acp` and `structured-cli` are reserved as
role names. A directory under `roles/` with a reserved name stops the gateway at startup;
one with any other invalid name is skipped, with a note in the startup log, and one whose
name starts with `.` is skipped silently. In this build every chat session runs the role
`default` in the workspace `default`; other roles are loaded and checked at startup, and
run once tasks arrive.

**Native rendering.** A role whose agent is bytesec (driver `structured-cli`, command
`bytesec`) and which has a `role.md` or skills runs each board task as a bytesec agent
package. Just after a task is claimed, the gateway writes the package under
`$MT_HOME/rendered/<role>/`, never in a workspace, and runs the agent with `--agent <role>`
and `BYTESEC_LOCAL_APM_PATH` pointing at it. `role.md` becomes the agent's own system
prompt, in place of bytesec's default identity, and the skills load as bytesec skills; the
task prompt then leaves both out. A native agent can use only the skills in its own package:
bytesec hides your user-level skills and the workspace's from it. Name the user skills a role
needs in its `agent.skills` and they are copied into the package with its own. Set
`agent.native: false` in a role's `config.yaml` to have its `role.md` and skills sent in the
task prompt instead, as every other agent gets them; if writing the package fails, a run gets
them that way too, and the log says so. Some roles are not rendered and get them in the prompt
too: one named `bytesec-agent`, which bytesec keeps for its own agent; one whose `agent.args`
already hold `--agent`; one whose environment sets `BYTESEC_LOCAL_APM_PATH` itself; and one
with a skill whose name bytesec will not load. `mt role check` says which, and why. Chat
sessions are not affected.

**Workspaces** are named directories in the config file:

```yaml
workspaces:
  default: /srv/repos/bytesec-agents
  docs: /srv/repos/docs
```

The single `workspace:` setting is the same as `workspaces.default`. A workspace must be an
absolute path to an existing directory; may not be or contain `$MT_HOME` or the database;
inside `$MT_HOME` only `workspaces/<name>` may be one; and no two workspaces may share or
nest in one directory. Everything here is checked at startup.

A workspace's name keeps the directory it was first used with: the gateway records it, and
if the config later points that name somewhere else it will not start. Sessions opened in a
directory belong to it, and moving them would orphan them. To use another directory, give
it a new name.

Once `roles/default/` exists, remove the `agent:` block **and** every `MT_AGENT_*` variable,
including `MT_AGENT_ENV_*`: any of them still counts as a second definition of the role
`default`, and the gateway will not start with two.

### The mt command

`mt` creates and checks roles and workspaces, drives the board from a terminal, and is how a
board run's agent reports. In a checkout, run it as `npm run -s mt -- …`.

```
mt role create <name> [--clone-from <role>] [--description "..."] [--own-workspace]
mt role list
mt role check [<name>]
mt workspace add <name> <absolute-path>
mt workspace add <name> --clone <git-url>
mt workspace list
mt kanban board list [all]
mt kanban board create <name>
mt kanban board set <name> max_running <number|none>
mt kanban board set <name> workspace <workspace|none>
mt kanban board archive <name>
mt kanban task new <title> [--board <name>] [--assignee <role>] [--reviewer <role>] [--workspace <name>]
    [--parent <task_id>]... [--outcome "..."] [--verify "..."] [--constraints "..."]
    [--boundaries "..."] [--stop-when "..."] [--body "..." | --body-file <path|->]
mt kanban task list [todo|ready|running|review|reviewing|blocked|done|archived|all] [--board <name>]
mt kanban task show <task_id> [--board <name>]
mt kanban task assign <task_id> <role> [--board <name>]
mt kanban task link <parent_id> <child_id> [--board <name>]
mt kanban task unblock <task_id> [comment...] [--board <name>]
mt kanban task stop <task_id> [--board <name>]
mt kanban task archive <task_id> [--board <name>]
mt kanban task comment <task_id> <text...> [--board <name>]
mt kanban gate add <task_id> [--timeout <s>] -- <command...>
mt kanban gate list <task_id>
mt kanban gate remove <task_id> <gate_id>

# the worker's commands, which work only in a board run's shell, where the gateway sets MT_KANBAN_RUN, MT_KANBAN_TOKEN and MT_KANBAN_SOCKET:
mt kanban <show|complete|review|changes|block|comment|create|link> < input.json
```

The role, workspace and operator's board commands find the home, config file and database the
way the gateway does (`MT_HOME`, `MT_CONFIG`, `MT_DB`; the database is `$MT_HOME/team.db` unless
set), from the shell they run in, and need no Lark settings. The role and workspace commands
only write files and never contact the gateway; changes take effect at the next start. The
operator's `mt kanban` commands are the one exception: they write the board's database, beside
a running gateway, through the board's own service, and take effect at once.

- `role create` writes `config.yaml` (from the role `default`, or `--clone-from`), a starter
  `role.md`, `skills/`, an empty `0600` `.env` and a `.gitignore`. A `.env` is never copied.
  `mt role create default` moves an `agent:` block into `roles/default/` and prints the steps
  that finish the move.
  `--own-workspace` also creates `$MT_HOME/workspaces/<name>`, adds it to `workspaces:` and sets
  the role's `workspace:` to it, for a role that does not work on a repository; without it, a
  role's tasks follow their parents' workspace, which is what a reviewer needs.
- `role check` runs the startup checks, and reports what comes from this shell's environment
  separately: the service's environment may differ. It says, a line a role, whether the
  role's runs are rendered as a native agent package, and why not.
- `workspace add` edits `workspaces:` in the config file, keeping its comments, and refuses
  anything the next start would refuse. `--clone` clones into `$MT_HOME/workspaces/<name>`.
- The operator's `kanban` commands are chat's `/kanban` commands at a terminal, in the same
  groups, with the same meaning, for whoever runs the gateway: `board list`, `create`, `set` and
  `archive`; `task new`, `list`, `show`, `assign`, `link`, `unblock`, `stop`, `archive` and
  `comment`; and `gate add`, `list` and `remove`. A task command needs `task`: `mt kanban new`,
  without it, is an unknown command, and `mt kanban show`, `comment` and `link` are always the
  worker's, which an agent runs in a board run. There is no
  `board use`, since a terminal is no chat: `task new` and `task list` take `--board <name>`, `default`
  unless given. The commands that name a task work on a task on any board, by id; given
  `--board <name>`, they refuse (`other_board`) a task on another board, and `link` refuses
  unless both tasks are on it. A `--board` naming no board is refused. They record who acted as
  `operator:<login>`, the login of the account the command runs as: run under `sudo -u`, that
  is the service account, not you. `task new` takes `/kanban task new`'s lines as flags; its title is the
  words that are not flags, on one line, with no control character or bidi control, and its
  body `--body`, or `--body-file` with a regular file, or `-` for stdin.
  `assign`, `--assignee` and `--reviewer` take a role: a person is given work from chat, by
  @-mention, where the gateway can check their tier. A task created here is followed by no
  chat, so nobody is told when it is done or blocks: `mt kanban task show` and `task list` tell you. Each
  prints plain text, or with `--json` one line of JSON, `{"ok": true, ...}` or
  `{"ok": false, "code": "...", "message": "..."}`; each exits 0 when done, 1 when refused, and
  2 for a wrong command line, said on stderr. After `task new`, `assign`, `unblock`, `stop`,
  `archive` and `board set`, as after their chat forms, the gateway is asked over its socket to
  look for work at once, which also cancels the turn of an agent run the change ended; if no
  gateway answers, they say why, and that the change stands: the gateway acts on it at its next
  sweep, or when it next starts, and running the command again would make it twice. If the
  config does not set `kanban.enabled`, or sets it to false, they say which, and that the board
  is off: the change is recorded, and nothing runs it until the board is turned on. They refuse
  to run in a board run's shell, where `MT_KANBAN_RUN` or `MT_KANBAN_TOKEN` is set, before
  reading their arguments or stdin.
- The worker's `kanban` commands, `show`, `complete`, `review`, `changes`, `block`, `comment`,
  `create` and `link`, with no group, are for the run's agent, not for a person: they work only
  with the run's `MT_KANBAN_RUN`, `MT_KANBAN_TOKEN` and `MT_KANBAN_SOCKET`, which the gateway
  gives each run, and take no arguments. They are the worker's in any shell, and elsewhere say
  they work only inside a run; in a run's shell, the operator's `task`, `board` and `gate`
  commands are refused.
  It reads its input as JSON on stdin and prints one line of JSON, `{"ok": true, ...}` or
  `{"ok": false, "code": "...", "message": "..."}`. It exits 0 when the command was done, 1 when
  it was refused, and 2 for a wrong command line. `link` takes only the tasks the run's own
  task created, and refuses one that has started, so sequence follow-ups by creating them in
  order, each naming the earlier ones in `"parents"`. On a task that names a reviewer,
  `complete` is taken as `review`, with the same handoff, and its answer says
  `"sent for review to ..."`. With `kanban.enabled`, the gateway writes
  `$MT_HOME/bin/mt`, which runs this build's `mt` with the gateway's node, puts that directory
  first on every run's `PATH`, and listens on `$MT_HOME/run/kanban.sock` (`0600`, in a `0700`
  directory; under the temporary directory when the home's path is too long for a socket).
  Because `$MT_HOME/bin` comes first on every run's `PATH`, keep nothing else in it: any
  file there would shadow a command of the same name for every agent. A command other than
  `show` refuses at once when stdin is a terminal; redirect a file or pipe the JSON in.
  With `kanban.enabled`, the gateway also holds `$MT_HOME/run/gateway.pid` while it runs, and
  refuses to start on a home whose lock names another live process.
- A task may have **gates**: shell commands that must exit 0, in the task's workspace, before
  `complete` or `review` is accepted. A failing gate refuses the report with its command, exit
  code and the end of its output, masked, and the agent can fix it and report again. Gates run
  as the gateway's user with the environment of the role of the task's latest agent run, or
  the role `default` if no agent has run, never with a run's token or socket, for up to 600 s
  each and 600 s together, so `mt kanban` waits up to 15 minutes for an answer. A task has at
  most 20 gates, and a gate's command at most 4 KiB. A gate whose command holds a known secret is refused: put
  the value in the role's `.env` or `agent.passEnv`, and name it in the command. Defining gates
  is an operator's action: `mt kanban gate add` (the command's words after `--` are joined with
  spaces; quote it to keep its own quoting; words before `--` join it too, so write the whole
  command after `--`), `list` and `remove`, which record you as
  `operator:<your login>`. They check the secrets this shell knows: every role's values, and
  the Lark app secret if `LARK_APP_SECRET` is set here. They refuse to run in a board run's
  shell, where `MT_KANBAN_RUN` or `MT_KANBAN_TOKEN` is set, so an agent does not define gates by
  accident; that is not a security boundary, since an agent runs as your user and could unset
  them, as it could edit `config.yaml` or a role's files. Gate commands are shown masked. One
  report's gates run in a workspace at a time: another report there is refused until it is
  answered. A report runs the gates it read when it started: one added or removed meanwhile
  counts from the next report. Gates are not a containment boundary: a process a gate detaches
  with `setsid` leaves its process group, can outlive the timeout and can go on changing the
  checkout. When an agent reports
  `complete` or `review`, the gateway also records its workspace's `HEAD`, and whether the tree
  had uncommitted changes, when the workspace is a git repository; for one that is not, or
  when git is not installed, nothing is recorded, and a reviewer is told no state. A repository
  with no commit yet reads as uncommitted with no commit, and a bare repository as having
  uncommitted changes; a workspace
  that is not itself a repository but sits inside one reports the outer repository's `HEAD`;
  and the read's timeout signals git only, not what git started.

### Chat commands

| Command | Tier | Effect |
|---|---|---|
| `/new` | operate | Fresh session in this thread, retiring the current one |
| `/sessions`, `/ls` | talk | Sessions bound in this chat |
| `/attach <session-id>` | operate | Bind this thread to an existing session |
| `/status` | talk | What this session is doing |
| `/stop`, `/cancel` | operate | Cancel the current turn |
| `/help` | talk | List commands |
| `/kanban <command>` | talk; operate to change the board | The task board, below. Never refused because this chat's session is busy |
| `/cd <path>` | operate | Declared, and honestly unavailable in this build — every session shares the one configured workspace |

Approvals are answered by clicking a card button, never by typing: the agent's blocked
`session/request_permission` call *is* the pending request, and a chat verb would be a
second way to mutate it with no capability the button doesn't already have.

### The board from Lark

With `kanban.enabled`, `/kanban` drives the board from any chat the bot is in. A task is any
work — research, a document, an operation in Lark, a chore, a change to code — given to a
role, whose agent runs it in a workspace, which is just a directory, or to a person.

For a walk-through with messages to paste, from one task to chains, fan-out and review, see
[docs/kanban-guide.md](docs/kanban-guide.md).

```
/kanban task new Draft the Q3 summary
assignee: docs-writer
workspace: docs
outcome: a page in the team wiki
verify: the page links every source
Use last quarter's page as the model.
```

The first line is the title. Lines starting `assignee:`, `reviewer:`, `workspace:`, `parent:`
(one or more task ids; repeat it for more), `outcome:`, `verify:`, `constraints:`,
`boundaries:` and `stop when:` fill those fields, in any order and in any case; every other
line is the body. A bare word names a role, and an @-mention a person. An unknown role or
workspace is refused at once. The dispatcher looks for work as soon as the task is created.

**Review.** A task that names a `reviewer:` is reviewed before it is done. Its agent's prompt
names the reviewer, and a `complete` from its agent, or a `/kanban task done` or **Done** from its
person assignee, is sent to the reviewer as a review request, with the same summary; its gates
run once. A rework after changes goes back to the reviewer the same way. Only the reviewer's
approval, or an operator's, completes it. A task with no reviewer is done when its assignee
says so, and its agent may still ask for review, naming one. A separate review task, a child of
the work, is the other way to review: use one or the other, since a task with both is reviewed
twice. An operator may answer any review; if a reviewer role's agent is working on it, the
answer ends that run (`superseded`) and stops its turn, and the reviewer's later report is
refused.

Every command is in a group, then a verb: a task's under `/kanban task`, a board's under
`/kanban board`, a gate's under `/kanban gate`, and `/kanban help` on its own. A task command
typed without `task`, such as `/kanban new`, is an unknown command.

| Command | Tier |
|---|---|
| `/kanban task new <title>` + lines | operate |
| `/kanban task list [todo\|ready\|running\|review\|reviewing\|blocked\|done\|archived\|all]` | talk; without a status, the tasks someone may still act on |
| `/kanban task show <task>` | talk: the task, its contract, gates, runs, latest output and comments |
| `/kanban task assign <task> <role or @person>` | operate: an undecided run ends `superseded` |
| `/kanban task link <parent> <child>` | operate: refused for a child past `open`, or with a run open |
| `/kanban task workspace <task> <name>` | operate: refused once the workspace is fixed |
| `/kanban task comment <task> <text>` | talk: everyone sees it in `/kanban task show`; an operator's, or the task's assignee's or reviewer's, also reaches its agent, when its turn ends or in its next run |
| `/kanban task unblock <task> [comment]` | operate |
| `/kanban task stop <task>` | operate: the run ends `cancelled`, and the task blocks |
| `/kanban task archive <task>` | operate |
| `/kanban gate add <task> [--timeout <s>] <command>` | operate: the rest of the message is the command, as written |
| `/kanban gate list <task>` | talk |
| `/kanban gate remove <task> <gate>` | operate |
| `/kanban task done <task> [summary]` | the task's assignee, a person; on a task that names a reviewer, it asks for review instead |
| `/kanban task block <task> <reason>` | the task's assignee: it blocks as needing input |
| `/kanban task review <task> [summary]`, and a line `reviewer: <role or @person>` unless the task names one | the task's assignee |
| `/kanban task approve <task> [comment]` | the task's reviewer, a person, or an operator; an operator's answer ends a reviewer role's open run |
| `/kanban task changes <task> <reason>` | the task's reviewer, a person, or an operator; an operator's answer ends a reviewer role's open run |
| `/kanban board list [all]` | talk: each board, its tasks, its own limit and workspace, and which one this chat is on |
| `/kanban board create <name>` | operate: a new board, named as roles and workspaces are, but never `none` or `all` |
| `/kanban board use <name>` | operate: this chat, all its threads, is on that board from now on |
| `/kanban board set <name> max_running <number\|none>`, or `workspace <workspace\|none>` | operate: the board's own limit, inside `kanban.max_running`, or its tasks' default workspace; `none` clears either |
| `/kanban board archive <name>` | operate: refused while any of its tasks is open, in review or blocked; never `default` |
| `/kanban help` | talk |

Whoever acts is recorded as `lark:<union_id>`; a sender whose message carried no union_id can
read the board but not change it. Everything shown is escaped, so a task's text cannot mention
anyone, and masked, gate commands included.

**Notices.** The chat, or thread, a task was created in follows it, and the tasks its runs
create. It hears when a task is done, needs review, blocks (with the kind and the reason),
is retried after a failure, gives up, or is stranded with nobody able to take it. A run cut
short by a gateway restart is retried quietly. A task that keeps blocking for the same reason,
`kanban.block_recurrence_limit` times after an unblock, is flagged for rewriting instead. Each
chat or thread gets at most one message every couple of seconds, listing what happened in
order, 20 notices at most. Notices are delivered from a cursor kept in the database, so those
due while the gateway was down are sent when it is back; a message sent just before a stop
is sent again with the same uuid, which Lark shows once if it comes within the hour. A chat
the bot can no longer post to — removed from it, or refused by
Lark for about 19 minutes — is let go of until the next restart: its notices are dropped, and
the gateway's log says which. A network outage, or Lark not answering, never lets a chat go:
its notices wait, and are sent once the gateway reaches Lark again.

**Boards.** Several projects can share the gateway, each on a board of its own: a queue of
tasks with its own list, its turn in each dispatcher pass, and optionally its own
`max_running`, inside the gateway's, and default workspace. One database and one dispatcher
serve every board. A board called `default` always exists, holds every task from before boards,
and is where every chat starts; `/kanban board use` moves a chat, and `/kanban task new` and
`/kanban task list` act on the chat's board. `/kanban task show` and the commands that name a task work
on any board, by id. A task's follow-ups, its parents and its links stay on its board, and its
notices go to the chat it was created in, as before. One agent at a time per workspace still
holds across boards. See section 10 of [docs/kanban-guide.md](docs/kanban-guide.md). From a
terminal, `mt kanban board …` and `mt kanban task new|list --board <name>` do the same (see "The mt
command" above).

**People.** Name a person with an @-mention — type @ and pick them, so Lark sends who they
are — as `assignee:` or `reviewer:`, or in `/kanban task assign`. Being named lets a person report on
the task, so they must have talk tier (`auth.talk`); a person without talk tier is
refused. The board knows a person as `lark:<union_id>`, which is how `/kanban task show` lists them
and how an agent's `mt kanban create` or `review` names one; the gateway learns each person's
ids as they use `/kanban`, are mentioned in it, or press a card's button, and refuses a
principal it has never seen.

When a person's task is ready, they are sent it as a card in a direct message — the title, the
body, the contract and the parents' summaries — with a box and **Done** and **Block**: type a
summary, or why it is blocked, and press one. A review for a person comes the same way, with the
handoff, the commit to review when one was recorded, and **Approve** and **Request changes**.
Only the person named may press them (an operator may also answer a review, a role's included,
ending the reviewer agent's run if one is open); a card for a run
that is over says it is out of date and does nothing. A press is answered at once, and the card
shows the outcome once the report is made, gates and all; one refused for what it carried — an
empty box, a failing gate — redraws the card, saying why, ready to be pressed again. `/kanban task done`, `block`, `review`,
`approve` and `changes` do the same from any chat with the bot. A person's task never times out:
it waits for them, across restarts. The chat the task came from hears one line — "📋 *title*,
assigned to *name*", the name in plain text, never a mention — and its notices as usual; a
notice of a block carries an **Unblock** button for an operator. Only a card that cannot reach
its person — Lark answering that they are outside the app's availability (230013), or the person
having lost talk tier — is reported to the chat instead, with the commands to use. Any other
failure to send a card, a refusal of Lark's included, is taken for the gateway's: the card is
tried again, after a pause that doubles to five minutes, and the log says why each time. A
person's report is refused while another task's agent is working in the same workspace, if the
task has gates to run there.

A role whose agent is supervised may be given tasks too: its approval cards go to the chat that
follows the task, naming it, and are answered there at operator tier, as in a chat session.

**Known limitations.**

- A typed report (`/kanban task done` and the rest) leaves its card's buttons live, until the next
  press shows the card as out of date.
- A notice's **Unblock** button stays after it is pressed; a second press does nothing.
- A card that Lark refuses as unreachable is never sent again; the person can type the
  commands the chat was given.
- If a card's "Not done" redraw fails, the card's buttons may stay dead for 12 hours: Lark's
  SDK drops a second press of the same button for that long. The typed commands
  (`/kanban task done` and the rest) still work.
- The gateway learns about people only from `/kanban` messages, the people they mention, and
  the people who press cards; a principal it has never seen is refused.
- An approval forwarded to a chat counts toward the run's `max_runtime_s`: a supervised agent
  waiting on one is cancelled at that limit like any run.
- A person may review their own work: nothing refuses a reviewer who is the assignee.
- An operator's answer to a role's review runs the task's gates before it ends the reviewer
  agent's run, so they run while that agent is still working; it is told not to change the
  work under review, but nothing enforces that.
- A board's name is never renamed, and an archived board is never brought back: make a new one.
- A board's own settings keep only who changed them last, and when; there is no history of them.
- An agent task nobody can be given is not seen as stranded while `kanban.max_running`, its
  board's own `max_running` or its role's is reached: the limit is checked first, so it is not
  tried. It is reported once a slot frees and a pass tries it.
- `/kanban task show` says a ready task is waiting on its role's `max_running`, but not that it
  is waiting on a busy workspace, or on the gateway's or its board's limit.
- A task created with `mt kanban task new` is followed by no chat: nobody hears its notices, and a
  supervised role's approval requests on it reach nobody, as for any task no chat follows.
- `mt kanban` at a terminal cannot give a person work: assign people from chat.
- `mt kanban` refuses to run in a board run's shell, but that is not a security boundary: an
  agent runs as your user, could unset `MT_KANBAN_RUN` and `MT_KANBAN_TOKEN`, and could write
  the database itself. The same holds for `mt kanban gate`.
- A person's name, in a notice or a card, is the one Lark last gave with their ids, and can be
  out of date.

Before setting `kanban.enabled: true` on a live tenant, run the rest of the smoke test at the
end of docs/plans/2026-11-05-plan-d2-kanban-people.md, after the steps that must pass before
deploying this build at all (see "Sending to Lark" above). It is the section "Before turning
the board on: a smoke test against Lark".

## Repo layout

```
src/channel/lark/       adapter (send/edit/upload) and inbound (events -> router)
src/channel/            card writer, renderer, escaper
src/core/               router, session actor, registry, status projection, lanes
src/db/                 event log, sessions, turns, approvals, bindings, dedup
src/driver/acp/         ACP client: spawn, initialize, resume, prompt, permissions
src/driver/cli/         CLI fallback: one process per turn, argv in, NDJSON out
src/policy/auth.ts      allowlist tiers and the silent-refusal rule
src/config.ts           the file/environment split, validated at boot
schema/                 migrations; the event log is the system of record
docs/architecture.md    full design document
docs/specs/             the Lark channel design
docs/testing/           crash matrix for the durability contract
```

## Tests

```bash
npm test          # unit: in-process, no network, no child processes
npm run test:e2e  # spawns hand-written fake agents, one per driver, and one board run end to end
npm run typecheck
```

The e2e suite exists for the failures only a separate process produces — an agent that
exits mid-turn, one that refuses to initialize, one that advertises a capability it does
not have, one that writes its logger output onto the same stdout it streams events on.
It has already found two driver bugs that in-process doubles cannot reach.

## Reading order

1. [`docs/architecture.md`](docs/architecture.md) §0–§2 — thesis and layer model
2. §4 — the broker, and §4.6, the durability contract everything else rests on
3. §15 — build order. Milestones 1–4 are the durability guarantee; do not reorder.
4. [`docs/testing/durability.md`](docs/testing/durability.md) — what "it works" has to mean
5. [`docs/specs/2026-08-21-lark-channel-design.md`](docs/specs/2026-08-21-lark-channel-design.md)
   — the implemented slice, and the seams left for the deferred parts

## Protocol strategy

| Method | Driver | Preference |
|---|---|---|
| Agent with native ACP mode (`gemini --acp`) | `acp` | primary |
| Agent via ACP adapter (`claude-agent-acp`, `codex-acp`) | `acp` | primary |
| Structured CLI (`bytesec run --format json`) | `structured-cli` | fallback |
| PTY / TUI scraping | — | last resort, actively deprecated |

ACP already specifies capability negotiation, sessions, streaming, cancellation, and
permission requests. We don't reinvent it.

The CLI driver exists because an agent's ACP server can be broken while its command
line works perfectly, and being unable to talk to an agent at all is worse than
talking to it badly. It is a genuinely worse thing, in three specific ways:

- **No approvals.** A command line has no permission protocol — the agent never asks,
  it just acts. Approval cards stop appearing and the `operate` tier stops gating tool
  use. That is a security posture, not a rough edge, which is why `agent.unsupervised`
  has to be written down before this driver will load.
- **Resume per process,** on bytesec 0.7.4 or later; `mt role check` warns of a bytesec
  role below it, with which resume is unmeasured and may not work. Each turn is a fresh process. The
  driver reads the agent's own session id from `--session-id-file` and passes it back
  as `--session` on the next turn, which then sends only the new message; the id is stored, so a session
  resumes after a restart too, and `/status` shows it and how the last turn reached it.
  When the agent refuses the id, the turn is run again with the conversation composed
  into the prompt as a fenced transcript, so the agent recovers what was *said* but not
  the tool state behind it, and the session's log says it was `replayed`, or `fresh`
  when there was no history to carry. The id names a session in the agent's own store
  on this host; it is not a secret, and the gateway never deletes those sessions, so
  they accumulate in bytesec's store. Known limitations: a refusal is recognised by
  bytesec's wording, so one it rewords ends the turn `ambiguous`; `/attach` of an
  archived board run's session while its rework runs would put two processes on one
  agent session, which was not measured; a gateway that crashes mid-turn can leave an
  `mt-session-id-*` directory, holding only the id, in the system's temporary
  directory; and below 0.7.4, resume is unmeasured.
- **No cooperative cancel.** Cancelling kills the process, so work already done stands.

Everything specific to a protocol stops at its driver. Adding the second one required
no change to `src/driver/types.ts`, which is the return on declaring that seam while
there was only one implementation behind it; resuming it natively added one event,
`session-observed`, for an id a driver learns only from a turn.

## References

- [Agent Client Protocol](https://agentclientprotocol.com)
- [ACP agent registry](https://agentclientprotocol.com/get-started/agents)
- [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)

## License

TBD
