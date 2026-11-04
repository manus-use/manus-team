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
log and approvals. Values shorter than 8 characters are not masked. A secret the agent finds by
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
| `kanban.enabled` | — | Run the board's dispatcher. Default **off**: nothing can create a task or report on one yet. The `kanban:` keys are snake_case, as the kanban design spells them; the rest of the file is camelCase. They are set in the file only, and each number has a ceiling (below); a value above it is a startup error. |
| `kanban.max_running` | — | Open agent runs at once. Default `maxLiveSessions`, and refused above it: a run is a live session. Set it lower to keep room for chat. At most 256. |
| `kanban.failure_limit` | — | Counted failures before a task gives up and blocks. Default 2: a first attempt and one retry. At most 100. |
| `kanban.transient_limit`, `kanban.transient_cooldown_s` | — | A throttled run is retried after a cooldown, 300 s by default, doubling each time up to an hour; after 10 in a row the task blocks. At most 1000 in a row, and a first cooldown of at most 3600 s. |
| `kanban.default_max_runtime_s` | — | A run's wall-clock limit unless its task sets one. Default 4 hours, at most 7 days. |
| `kanban.sweep_interval_s`, `kanban.stranded_after_s` | — | How often the dispatcher checks runtimes, cooldowns and stranded tasks (default 60 s), and how long a task nobody can take waits before it is reported stranded (default 30 min). At most 3600 s and 30 days. |
| `kanban.nudge_limit` | — | Reminders sent into a run whose turn ended without a report, before the run ends as a protocol violation. Default 2; 0 sends none. At most 10. |
| `db`, `downloads` | `MT_DB`, `MT_DOWNLOAD_DIR` | Derived from `MT_HOME` unless set. |
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

A **role** is who does a kind of work, and how it is run. Each is a directory under
`$MT_HOME/roles/`:

```
roles/implementer/
  config.yaml     # the coding agent, an optional workspace, an optional description
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

`mt` creates and checks roles and workspaces. In a checkout, run it as `npm run -s mt -- …`.

```
mt role create <name> [--clone-from <role>] [--description "..."] [--own-workspace]
mt role list
mt role check [<name>]
mt workspace add <name> <absolute-path>
mt workspace add <name> --clone <git-url>
mt workspace list
```

It finds the home, config file and database the way the gateway does (`MT_HOME`, `MT_CONFIG`,
`MT_DB`), from the shell it runs in, and needs no Lark settings. It only writes files and
never contacts the gateway; changes take effect at the next start.

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

### Chat commands

| Command | Tier | Effect |
|---|---|---|
| `/new` | operate | Fresh session in this thread, retiring the current one |
| `/sessions`, `/ls` | talk | Sessions bound in this chat |
| `/attach <session-id>` | operate | Bind this thread to an existing session |
| `/status` | talk | What this session is doing |
| `/stop`, `/cancel` | operate | Cancel the current turn |
| `/help` | talk | List commands |
| `/cd <path>` | operate | Declared, and honestly unavailable in this build — every session shares the one configured workspace |

Approvals are answered by clicking a card button, never by typing: the agent's blocked
`session/request_permission` call *is* the pending request, and a chat verb would be a
second way to mutate it with no capability the button doesn't already have.

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
npm run test:e2e  # spawns hand-written fake agents, one per driver
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
- **No resume.** Each turn is a fresh process with a fresh agent session, and the ids
  it mints cannot be handed back. Continuity is reconstructed by composing the
  conversation into the prompt as a fenced transcript, so the agent recovers what was
  *said* but not the tool state behind it — and pays input tokens for it every turn.
  Sessions started this way report `replayed`, never `resumed`.
- **No cooperative cancel.** Cancelling kills the process, so work already done stands.

Everything specific to a protocol stops at its driver. Adding the second one required
no change to `src/driver/types.ts`, which is the return on declaring that seam while
there was only one implementation behind it.

## References

- [Agent Client Protocol](https://agentclientprotocol.com)
- [ACP agent registry](https://agentclientprotocol.com/get-started/agents)
- [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)

## License

TBD
