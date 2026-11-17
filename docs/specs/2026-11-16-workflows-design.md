# Workflows: a graph of tasks, written once

This document was §21, "Workflows", of the kanban spec,
[`2026-11-02-kanban-design.md`](2026-11-02-kanban-design.md), until 2026-11-17, and builds on the
board's rules there, whose section numbers it cites as "kanban spec §n"; its own sections were
renumbered from 1, §21.1 becoming §1, the section's opening becoming §0. Where this document and the
kanban spec disagree, the kanban spec wins and this document is a bug. As there, every rule that
looks arbitrary states the mechanism that forces it, so that it is not "simplified" away later.

---

## 0. What a workflow is

A team runs the same shape of work again and again: shortlist, evaluate each candidate, recommend
one; draft, review, publish. Typing the graph each time, task by task with `parent:` lines, is slow
and goes wrong. A **workflow** is that graph written once, in a file: a list of steps, each a task
to make, with the links between them. **Starting** it makes one **instance**, `w_…`: the file read,
its params filled in, and every task and link made at once. A start is an **expansion**, the file
made into a DAG of tasks (§5), and an **apply**, the DAG made on the board. **Preview** shows the
expansion and makes nothing, and at the terminal writes it as a file, which `apply` makes; a DAG can
also be written by hand or by an agent and applied with no workflow file at all (§6). "Start",
because "run" already means one attempt at a task (kanban spec §3.3). Built by plan T (kanban spec
§12).

**A workflow is a fixed graph, with no conditions.** Every step of the file becomes tasks at the
start, and nothing in the file says "if". A workflow that must branch has a **deciding step**: a
task whose agent reads its parents' handoffs and decides, then creates the tasks of the branch it
chose with `mt kanban create`, starts another workflow, or applies a DAG of its own (§6). A gate
on that step, such as `test -s decision.md`, guards that the decision is recorded before the step
can complete. The board stays the board: a branch is a task's work, reported like any other, not a
rule the board evaluates.

**Nothing in the kernel knows about workflows** (kanban spec §1). An instance and its members are
two tables of their own (§7); `kanban_tasks`, the dispatcher, the claim, the prompt and the notices
read neither. A workflow's tasks are ordinary tasks once made: claimed, reported, blocked,
reassigned and archived as any other. This section amends kanban spec §7.3 (two worker commands),
kanban spec §7.1 (a line of the work protocol), kanban spec §9.1 (a fourth group of commands) and
kanban spec §2.6 (`mt workflow check`).

## 1. The file

One YAML file per workflow, at `$MT_HOME/workflows/<name>.yaml`:

```yaml
description: Shortlist vendors, evaluate each in parallel, then recommend one
params:
  topic:    { required: true, description: what is being bought }
  vendors:  { list: true, required: true }
  reviewer: { default: reviewer }
steps:
  shortlist:
    title: Shortlist vendors for {{topic}}
    assignee: worker                  # a role; a person as lark:<union_id>, or a param holding one
    outcome: a shortlist with one line per vendor
  evaluate:
    for_each: vendors                 # one task per item; the item is {{item}}
    parents: [shortlist]
    title: Evaluate {{item}} for {{topic}}
    assignee: worker
    gates:
      - command: test -s evaluation.md
        timeout_s: 30
  recommend:
    parents: [evaluate]               # waits for every evaluate task
    title: Recommend a vendor for {{topic}}
    assignee: worker
    reviewer: { role: "{{reviewer}}" }
    verify: every score comes from a parent's summary
```

- **The name is the file's, in the role grammar** (kanban spec §2.1), checked as `nameProblem`
  checks a role's: it is typed in chat (`/kanban workflow start vendor-eval`), and it becomes a
  path, so `../roles` must be impossible. A file whose name is not in the grammar, or an entry that
  is not a regular `.yaml` file, is not a workflow: reported once by the check and ignored, as
  `discoverRoles` ignores a badly named entry. A dot-entry is skipped silently, as `discoverRoles`
  skips one, so the directory can be under version control. A symlink is not followed, as a role's
  files are not (kanban spec §2.1), and is reported: a workflow is the operator's, kept in the home.
- **At most 64 KiB.** A workflow is a few dozen lines, and what it expands to is stored with every
  instance (§7).
- **Parsed as a role's `config.yaml` is**: the `yaml` package's `parse` (`src/roles.ts`), YAML
  1.2's core schema, so `yes` stays text; a duplicated key is an error, as the parser makes it.
  The keys are checked with `config.ts`'s `section` and `reject`, so an unknown key is an error
  that names it and its place (`steps.evaluate.timeout`). **A value that starts with `{{` must be
  quoted**: YAML reads an unquoted `{{reviewer}}` as a mapping inside a mapping. The check's error
  for a mapping where text belongs says so.
- **The top level** is `description` (text, optional), `params` (optional) and `steps` (at least
  one). Nothing else.
- **Step and param names** are in the role grammar too, and `item` is no param's: it is the
  for_each item's (§3). **Step order is the file's**: the parser keeps a mapping's keys in the
  order written, and a JavaScript object keeps its keys in insertion order except for keys that
  read as integers, which a name in the grammar, starting with a letter, never does. `show` lists
  the steps in that order, and the tasks are made in it.

**A step's fields** are `KanbanService.create`'s, as `CreateRequest` (`src/kanban/service.ts`)
names them, each checked as `create` checks it, plus the gates `addGate` takes, plus `parents`
and `for_each`:

| Field | |
|---|---|
| `title` | required; text |
| `body` | text |
| `assignee`, `reviewer` | a role name or a person's principal `lark:<union_id>`, as text; or `{ role: … }` or `{ person: … }`, which says which it must be, so a param cannot turn a role's place into a person's |
| `workspace` | a configured workspace's name |
| `priority` | a whole number |
| `outcome`, `verify`, `constraints`, `boundaries`, `stop_when` | the contract (kanban spec §4.3), text; `verify` fills `verification`, as chat's `verify:` line does |
| `failure_limit`, `retry_on_crash`, `max_runtime_s` | as kanban spec §3.1 |
| `gates` | a list of `{ command, timeout_s? }`, as `/kanban gate add` takes them (kanban spec §7.7) |
| `parents` | step names (§3) |
| `for_each` | a list param's name (§3) |

*A decision.* The design said a step takes the fields `task new` takes. Chat's `/kanban task new`
and the terminal's take fewer: no priority, failure limit, crash rule, runtime limit or gates. They
are fields `KanbanService.create` has had since plan C1, which no command line reaches, and gates
are `addGate`'s. A workflow is written once and started many times, which is where those settings
pay, so a step takes every field the service takes, with the service's own checks, rather than
the commands' subset.

## 2. Params and substitution

- **A param is text, or a list with `list: true`.** Each is `required: true` or has a `default`
  (text, or a YAML list of text for a list param), and may have a `description`; both `required`
  and `default` is a check error, and so is neither, since a param that may be left out with
  nothing in its place would leave `{{name}}` with no value. Nothing else: no numbers, no choices,
  no patterns. A param a start gives that the file does not declare is refused, so a mistyped
  `topik=` is not quietly dropped.
- **`{{name}}`, and `{{item}}` in a for_each step, in text fields only**: `title`, `body` and the
  five contract fields. Nothing else is in the braces: no expressions, no filters, no conditions,
  and spaces inside them are not allowed either. Every `{{` in a text field must open a reference
  to a declared param, or to `item` in a for_each step; any other is a check error, so a typo
  fails at the check instead of reaching a title, and a literal `{{` cannot be written (§17).
  A list param in a text field is its items joined by `, `, so `Recommend among {{vendors}}`
  reads as it should.
- **In a name field**, `assignee`, `reviewer` and `workspace`, the whole value may be one reference,
  `"{{reviewer}}"` or `"{{item}}"`, and nothing else: no name is assembled from parts. The value it
  gives must be a valid name and is checked as one: a role or workspace in the grammar (kanban spec
  §2.1) and configured, a person a principal the gateway knows to have talk tier (kanban spec §4.2).
  A list param there is a check error. A value holding a known secret is refused, as an idempotency
  key holding one is (`#idempotencyKey`): names are stored unmasked, as they identify (kanban spec
  §10.1).
- **Never in gates.** A `{{` anywhere in a gate's command is a check error. A gate is a shell
  command the gateway runs as its own user (kanban spec §7.7), and params come from chat and from
  agents: a param in a command would let anyone who may start a workflow, an agent included, write
  shell. A gate that needs a value names it as an environment variable, `$NAME`, which comes from
  the role's environment (kanban spec §7.7), never from a param.
- **A value that lands in a title** may hold no line break, no control character and no bidi
  control: a title is one line (kanban spec §7.1 flattens it, and the terminal's `task new` refuses
  the same, kanban spec §2.6), and a bidi control in it could make one task's line in a reply read
  as another's. Refused `invalid`, naming the param. A body or contract field takes them, as `task
  new`'s body does.
- **Substitution is text, once.** A value is put in as written, and not read again for braces,
  so a param holding `{{topic}}` puts those characters in the title and nothing more.
- **Sizes.** A text value is at most 8 KiB, a list at most 100 items, each at most 8 KiB, and **all
  the params together at most 64 KiB, serialized as JSON**, on every path: the worker socket refuses
  a request over 256 KiB (`DEFAULT_MAX_REQUEST_BYTES`, `src/kanban/socket.ts`) before it is read,
  and 100 items of 8 KiB would pass that, so the bound is the start's own, well inside the socket's,
  and the same from chat and the terminal; over it, `too_large`. The fields they land in are then
  held to `task new`'s limits (kanban spec §9.1: a title of 512 bytes, a body of 64 KiB, each
  contract field 8 KiB), checked on every task after substitution, from every way of starting.

## 3. Fan-out

- **`for_each: <list param>`** makes one task per item, in the list's order, each with `{{item}}`
  set to its item. An item is a list's text value, trimmed; an empty item, and an item given
  twice, are refused, as the item labels its task in `show` and two tasks with one label could not
  be told apart. **An item holding a known secret is refused** too: an item is stored masked
  (§7), and two items differing only in a secret would be stored as one label. Items are
  compared for uniqueness as given, after trimming.
- **A step naming a for_each step in `parents` waits for all of its tasks**: each task of the
  child step is linked to every task of the parent step. `recommend` above has every `evaluate`
  task as a parent, so it is claimed once all of them are done (kanban spec §4.1).
- **Two for_each steps over the same list are linked all to all**, not item by item: with
  `review` over `vendors` and `evaluate` as its parent, each review waits for every evaluation.
  Item pairing, where a vendor's review waits for that vendor's evaluation alone, is left for
  later (§17); a workflow that needs it today puts each item's work in one task.
- **An empty list is refused** at the start: a step with no tasks would hold nothing back and
  make nothing, and its children would start at once, which is not what an empty shortlist
  means.
- **At most 100 tasks** after expansion, for the whole instance. The bound is on what one start
  makes in one transaction (§8) and lists in one reply (§9). Links are not bounded
  separately: the graph is acyclic, so 100 tasks have at most C(100, 2) = 4,950 links, each a row
  of two ids written in the same transaction, a write SQLite makes in milliseconds.
  A task with more parents than a worker's `create` may name (`WORKER_LIMITS.parents`, 50) is
  allowed here: that limit is on a request's size, and the writer has none.

## 4. Checks

The same checks run in three places, from one module, `src/kanban/workflow.ts`:

| Where | When | What a broken workflow does |
|---|---|---|
| `mt workflow check [<name>]` | when an operator runs it | reported, exit 1 |
| gateway startup | once, after the roles and workspaces are loaded | reported, one line each; the gateway starts |
| an expansion | every preview and start, on the file as it is then | refused, naming the problem |

**What is checked, from the file alone and the team:**

- the YAML, the keys and their types, at every level;
- the names: the workflow's, each step's and each param's;
- at most 100 steps, as every step makes at least one task and an instance has at most 100
  (§3), so a longer file could never start;
- each step's `parents` naming steps of the file, never itself, and no cycle among the steps,
  found by a walk of the parents with the cycle named (`shortlist -> evaluate -> shortlist`);
- each step written below its parents: a parent written after its child is refused, naming
  both, so the file's order is the one the tasks are made in and a parent always comes earlier in
  the DAG (§5);
- `for_each` naming a declared list param, and `{{item}}` only in a for_each step;
- every `{{…}}` a declared param, and no list param in a name field;
- roles and workspaces written literally existing and usable, as `create` asks of them
  (`#assignable`: configured; for a role, unsupervised unless supervised roles are accepted); a
  person written literally is checked at a start, as only the gateway knows who has talk tier;
- gates: no `{{`, no mask `••••` (a command copied from masked output would run broken, §10), a
  command of at most 4 KiB with no NUL and holding no known secret (`holdsSecret`, kanban spec
  §7.7), a timeout from 1 to 600 s, at most 20 on a step, at most 600 s together, a gate with no
  `timeout_s` counted as 300 s (`GATE_LIMITS.defaultTimeoutS`), as `addGate` stores it, so three
  such gates on one step fail the check;
- a step whose parents certainly work in different workspaces, because each parent step names its
  workspace or its role names one, and the step names none and its role names none: its tasks would
  be unresolvable at their claim (kanban spec §2.3 rule 3), so it is refused, saying to set the
  step's workspace. A parent whose workspace is decided later, at its claim, cannot be judged, and
  is not.

**What only an expansion can check**, with the params given: the params themselves, each value put
in a name field, the items, the count of 100, every task's sizes, every person, and the workspace
rule above with the substituted names.

**A broken workflow does not stop the gateway.** Startup is where a role or workspace that does not
resolve is fatal (kanban spec §2.1, §2.3), because every task depends on them; a workflow is used
only when someone previews or starts it, so only it is unusable, and saying so at startup is enough.
The startup lines are notes, masked, beside `roles: …; workspaces: …`:

```
workflow onboarding is not usable: steps.welcome.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead
workflows: release, vendor-eval; not usable: onboarding
```

with `workflows: none` when the directory is missing or empty. **A file that cannot be read** (its
mode, say, or an entry whose `lstat` fails) is one broken workflow, `the file cannot be read:
<code>` (`EACCES`), never a broken directory: every other file is still checked, listed and usable,
at startup, in `mt workflow check` and at a start. Only the directory itself failing to be read is
the `ConfigError` `listWorkflows` throws, which startup turns into its two lines and `mt workflow
check` into one refusal, exit 1, never a stack trace. **`loadStartup`** (`src/index.ts`) runs the
check, after `loadTeam`, and returns its lines with the config and the team, so `createGateway`
notes them and `mt service check` (kanban spec §20.5), which calls the `loadStartup` of the build it
checks, prints them as `warning:` lines (`src/cli/service.ts`) and does not fail on them, as the
gateway would start. So the check under `mt update` is the new build's.

**`mt workflow check [<name>]`** is beside `mt role check` (kanban spec §2.6): it reads files only,
and finds the home, the config and the roles as the gateway does: this shell's environment over the
gateway's `.env`, as `roleCheck` reads it (`readGatewayEnv`, then `withGatewayEnv`), then
`loadTeamSettings` and `loadTeam` with `unsetPassEnv`, so a role whose passEnv this shell lacks is
still checked as a role. It registers the team's secrets, and the Lark app secret when set, as
`openBoard` does (`src/cli/gate.ts`), so a gate holding one is refused here as at a start; the names
this shell leaves unset are said on stderr, as `openBoard` says them, since a gate holding those
values cannot be refused here. It prints a line a workflow:

```
vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)
onboarding: not usable: steps.welcome.gates[0].command holds {{, and a gate is a shell command: ...
```

then the entries it ignored. Exit 0 when every workflow it checked is usable, 1 otherwise, 2 for a
wrong command line; with a name, that workflow only, and a name with no file is 1. It works in any
shell, a board run's included, as it changes nothing and needs no authority; it does not open the
database. In a board run's shell it reads neither the gateway's `.env` nor any secret but that
shell's (`withGatewayFile` returns the shell as it is there), so its secret check is weaker there,
and it says so in one line.

**The files are read at each expansion**, not held from startup. An edit, a new file or a removed
one takes effect at the next preview or start, with no restart and nothing to reload; the startup
check is for reporting alone, and a file broken after it is refused at its next preview or start
with the same message. Reading a file of at most 64 KiB and checking it is far quicker than an
apply's transaction, so nothing is cached.

## 5. The DAG

A start is two steps, which can also be taken apart: the **expansion**, which reads the file, fills
in the params and expands each for_each into a **DAG**, a JSON document of the tasks to make and
their links; and the **apply**, which checks a DAG against the board and makes it, in one
transaction. `start` is the two in one step, as before. `preview --json` at the terminal writes the
expansion out, so an operator can see, diff and keep exactly what a start would make, and edit it
before it is made; `apply` lets a DAG come from elsewhere: written by hand at the terminal, or by an
agent planning a graph (§6). Whatever path made it, an instance is made from a DAG, and stores
the DAG it was made from (§7).

```json
{
  "format": 1,
  "workflow": "vendor-eval",
  "params": { "topic": "log storage", "vendors": ["acme", "globex"], "reviewer": "reviewer" },
  "board": "research",
  "tasks": [
    { "ref": "shortlist", "step": "shortlist", "item": null,
      "title": "Shortlist vendors for log storage", "body": "",
      "assignee": "worker", "reviewer": null, "workspace": null, "priority": 0,
      "contract": { "outcome": "a shortlist with one line per vendor" },
      "failure_limit": null, "retry_on_crash": "always", "max_runtime_s": null,
      "parents": [], "gates": [] },
    { "ref": "evaluate:1", "step": "evaluate", "item": "acme",
      "title": "Evaluate acme for log storage", "assignee": "worker",
      "parents": ["shortlist"], "gates": [{ "command": "test -s evaluation.md", "timeout_s": 30 }] },
    { "ref": "evaluate:2", "step": "evaluate", "item": "globex", "…": "…" },
    { "ref": "recommend", "step": "recommend", "item": null,
      "title": "Recommend a vendor for log storage", "assignee": "worker",
      "reviewer": "reviewer", "contract": { "verification": "every score comes from a parent's summary" },
      "parents": ["evaluate:1", "evaluate:2"], "gates": [] }
  ]
}
```

**The top level**, every key checked, an unknown one refused naming its place:

| Key | Default | |
|---|---|---|
| `format` | none | required; the number `1`. Any other is refused, saying which this build reads, so a DAG written for a later format is never half understood |
| `workflow` | `null` | the name of the workflow it was expanded from, in the role grammar, or `null` for a DAG with none, which shows as "(no workflow)" (§10). A label: apply reads no file by it. One holding a known secret is refused `invalid` in the shape, so before an apply's key lookup, without quoting it, as the name is stored and shown |
| `params` | `{}` | the params it was expanded with, each named in the param grammar (§1), text or lists of text, at most 64 KiB serialized (§2); `{}` or absent for a DAG with none. A record: apply substitutes nothing |
| `board` | `null` | a board's name, or `null` or absent for the path's own board (§6) |
| `tasks` | none | an array of 1 to 100 tasks, in the order they are made |

**A task**, an object, every key checked as at the top:

| Key | Default | |
|---|---|---|
| `ref` | none | required; unique in the DAG; 1 to 64 bytes of letters, digits, `.`, `_`, `:` and `-`. What `parents` name. A ref names its task in every refusal after its own, so one holding a known secret is refused right after this grammar check, without quoting it |
| `step` | the `ref` | the step it came from, in the same characters. A label `show` groups by |
| `item` | `null` | the for_each item, text, or `null`; at most 8 KiB, holding no known secret, as items do (§3) |
| `title` | none | required; as `create` takes it |
| `body` | `null` | text; `""` is taken as `null`, as `create` stores either as no body |
| `assignee`, `reviewer`, `workspace` | `null` | a name: a role, or a person as `lark:<union_id>`, or a workspace |
| `priority` | `0` | a whole number |
| `contract` | `{}` | an object of the five stored fields, `verification` and `stop_when` by those names, each text; a field not set is **omitted**, and a field given as `null` is taken as omitted |
| `failure_limit`, `max_runtime_s` | `null` | as kanban spec §3.1 |
| `retry_on_crash` | `"always"` | or `"if-no-side-effects"` |
| `parents` | `[]` | refs of tasks **earlier in the array**; no ref twice |
| `gates` | `[]` | a list of `{ command, timeout_s }`, `timeout_s` defaulting to `300`, as `addGate` takes them (kanban spec §7.7), taken as written; only where gates may come from (below) |

Every key takes its default when absent, and `null` given for a key whose default is not `null`
(`step`, `priority`, `contract`, `retry_on_crash`, `parents`, `gates`, `params`) is refused
`invalid`, so a key has one way to say "not set". **Every string** in a DAG, and in a start's
params, must be well formed (`String.prototype.isWellFormed`): JSON's `\ud800` escape can give a
lone surrogate, which is no text and cannot be stored as UTF-8; it is refused `invalid`.

**Why each rule:**

- **Refs, not task ids.** Nothing is made yet, so there are no ids to name; a ref is the DAG's own
  name for a task. The expansion writes a step's ref as its name, and a for_each task's as
  `<step>:<n>`, its item's place in the list from 1: an item is free text of up to 8 KiB, which a
  ref, typed in `parents` and read in a refusal, cannot be. The item is in its own field.
- **Parents come earlier.** A parent named later in the array, or not in it, is refused, naming the
  ref. So the refs form a DAG by construction, with no walk needed to find a cycle, and the array is
  the one order in which the writer can make the tasks, as a link's foreign key is checked at its
  insert, `show` lists them, and positions are numbered (§7). The expansion writes them in that
  order: step order, then item order, and a step's parents come before it in a file with no cycle
  (§4).
- **Parents are refs only.** A DAG makes a graph of its own, and its members are exactly what it
  made (§7); a task already on the board is linked afterwards, with `link`, by whoever may link
  it (§11).
- **Nothing is substituted.** A DAG holds the text that will be stored. A `{{` anywhere in it is
  plain text, gates included, so no step of apply turns data into shell.
- **Every field explicit in an expanded DAG.** The expansion writes every key of every task, nulls
  included, so the file reads as what will be made; a hand-written DAG may leave out what it does
  not set.
- **The canonical form.** One serialization of a DAG, used to measure it and to hash it on every
  path: compact JSON (no spaces or line breaks) of the DAG as parsed, without `idempotency_key` and
  `dry_run`, every key of the tables above written in their order, a key left out written as its
  default from the tables (`step` as the `ref`, `body` as `null`, a contract field not set omitted),
  a contract's fields in `CONTRACT_FIELDS`' order, the params sorted by name, in plain code-unit
  order, as a DAG's param names are held to the param grammar (§1), which is ASCII, and every
  string as given, **unmasked**. So reindenting a file, reordering its keys, or writing a default
  out or leaving it out changes neither its size nor its hash; a different value does. `preview
  --json` writes exactly this form, but indented, with every default written out in the same way, so
  deleting a key that holds its default from a previewed file never changes the hash.
- **Sizes**, of the canonical form in UTF-8. **192 KiB for `apply-dag`**, the one path where a DAG
  crosses the worker socket: the socket refuses a request over 256 KiB
  (`DEFAULT_MAX_REQUEST_BYTES`), and the DAG travels inside one as its `input` object, beside the
  envelope's run, token and command, so the bound leaves room for the envelope; `mt kanban
  apply-dag` measures it before sending. Before any of that, `mt kanban apply-dag` reads stdin up to
  the socket's 256 KiB, its raw cap, as every worker command does. **1 MiB for a start**, expanded
  on the gateway, **and for a terminal `apply`**, which read a file and send nothing over the
  socket: the bound is only on what is stored with the instance (§7), and the 100 tasks, each held
  to `task new`'s limits, are the bound that matters. A terminal `apply` reads a file or `-` up to a
  **raw cap of 4 MiB**, apart from the canonical 1 MiB: indentation and defaults written out make a
  file larger than its canonical form, and the raw cap only stops a wrong file being read whole.
  **Text must be UTF-8**: the bytes read are decoded with `new TextDecoder('utf-8', { fatal: true,
  ignoreBOM: true })`, and bytes that are not UTF-8 are refused `invalid`, never replaced by U+FFFD,
  which would apply a DAG other than the one written and hash it as that. `ignoreBOM` keeps a byte
  order mark in the text, where it is a leading U+FEFF, which `JSON.parse` refuses, so a DAG with a
  BOM is refused as invalid JSON rather than read as if it had none. So `readAll`
  (`src/cli/kanban.ts`) returns bytes, and the worker CLI decodes them so for **every** worker
  command, not only `apply-dag`: a report or a comment with a broken byte is refused rather than
  stored with a replacement character, which is safer and as simple. `MtIo.stdin` (`src/cli/mt.ts`)
  returns `Uint8Array | undefined` instead of text, and the test fakes that give it return
  `Buffer.from(text)`: `tests/mt-kanban.test.ts:76`, `tests/mt-kanban-operator-tasks.test.ts:73` and
  `:482`, and `tests/mt-kanban-worktree.test.ts:53`. The terminal's reads decode the same way:
  `apply`'s file and `-`, and `bodyOf`'s stdin and its `readFileSync(file)` for `--body-file`. On
  the gateway's side, the worker socket (`src/kanban/socket.ts`, where it joins a request's chunks)
  decodes strictly too, and refuses a request that is not UTF-8 as `bad_request`, as it refuses one
  that is not JSON. Within the bound, the params' 64 KiB, at most 100 tasks, and every task held to
  `task new`'s limits (kanban spec §9.1), its title to the characters a title takes (§2), its gates
  to `addGate`'s (§4: 20 a task, 600 s together, a gate with no `timeout_s` counted as 300 s).
- **Checked as tasks are.** Each task is checked as `create` checks it (`#assignable`, the
  workspace, the contract, the numbers, the crash rule), each gate as `addGate`, and the step whose
  parents certainly disagree on a workspace refused as in a file (§4), here from the DAG's own
  names.

**Where gates may come from.** A gate is a shell command the gateway runs as its own user, and
defining one is the operator's (kanban spec §10). So a DAG's gates are taken:

- from the terminal's `apply`, whose user is the operator, who may define gates anyway (kanban spec
  §2.6), a hand-written DAG's included;
- from an expansion on the gateway's side of the operator's own file: chat's `start` and a run's
  `start-workflow`, whose gates are the file's, which no param reaches (§2);
- **never from a DAG a run hands in**: `apply-dag` refuses a DAG with any gate, `invalid`, saying
  that gates are the operator's and that a workflow file's gates come with `start-workflow`. An
  empty `gates` list is no gate.

**What else a run's DAG may not set.** `priority`, `failure_limit`, `retry_on_crash` and
`max_runtime_s` are refused from `apply-dag`, `invalid`, as gates are, unless absent or at their
defaults (`null`, `0` for `priority`, `"always"`): a run's `mt kanban create` takes none of them
(`SCHEMAS.create`, `src/kanban/worker.ts`), as they set the order of the queue, the failure
breaker and the runtime limit, which are the operator's, and an agent's DAG gets no more than its
`create`. `workflow` and `params` must be absent, or `null` and `{}` (§6).

A gate command holding the mask `••••` is refused wherever a workflow's or a DAG's gate is taken:
by the file's check (§4), by a start and by an apply. `/kanban gate add` and `mt kanban gate add`
are unchanged: a gate typed by hand is the operator's command as written.

A DAG an agent writes could otherwise put any command on a task, which `mt kanban create` does not
allow and `mt kanban gate` refuses in a run's shell (kanban spec §2.6).

## 6. Preview, start and apply

| | Chat | Terminal |
|---|---|---|
| see what would be made, make nothing | `/kanban workflow preview <name> k=v …` | `mt kanban workflow preview <name> --param k=v …` |
| make it in one step | `/kanban workflow start <name> k=v …` | `mt kanban workflow start <name> --param k=v …` |
| get the DAG as a file | none | `mt kanban workflow preview … --json > dag.json` |
| check a file, make nothing | none | `mt kanban workflow apply dag.json --dry-run` |
| make it from a file | none | `mt kanban workflow apply dag.json --key k` |

```
mt kanban start-workflow < start.json   # a run: {"workflow", "params"?, "idempotency_key"?}, expanded and applied on the gateway
mt kanban apply-dag < dag.json          # a run: a DAG of its own, with no gates, and "idempotency_key"? and "dry_run"? beside its keys
```

The verbs are the same in chat and at the terminal, and the terminal takes `--board` with
`preview` and `start`, `--key` with `start` and `apply`, and `--json` with each; plan V adds
`--chat` and `--thread` to `start` and `apply` (§18).

**Preview** reads the file (§4), checks the params against it, substitutes and expands, and shows
the DAG it would make, the same in chat and at the terminal: a readable summary, one line a task,
with its ref, its title, its assignee and its parents' refs, and how many gates it has (§9), and
"Nothing was made", or the refusal a start would get now. It writes nothing. **In chat**, on the
gateway, it makes every check a start makes before its transaction, the board's and the people's
included, but not the key's: a preview has no message id of its own to repeat, as its message is not
the start's, so the lookup could never match. The start's checks without the start. **At the
terminal** it loads exactly as `openBoard` does (`src/cli/gate.ts`), but opens no database:
`loadTeamSettings` and `loadTeam` with `unsetPassEnv`, the team's secrets and the Lark app secret
registered, the same note on stderr for the passEnv names this shell leaves unset, and facts with
`supervisedRoles: true`, as `openBoard`'s service has, so that `preview`, `apply --dry-run` and
`apply` judge a DAG against one configuration. With no database there is no `KanbanService` to ask,
so **the per-task checks of `create`** (`#assignable`, the workspace's being configured, the names,
the contract, the numbers, the crash rule) **move into a pure function**, `taskProblems(task,
facts)`, whose facts are the roles, the workspaces, `supervisedRoles`, and a talk check that may be
absent, when a person is refused as at the terminal; it reads no database. No check of `create`'s
reads the isolated workspaces, so they are not among the facts. `create`, `previewWorkflow` and the
terminal's preview all call it, so one function judges a task however it is made (§15). What
needs the database, the board's being there and live and the key, is `apply --dry-run`'s and
`apply`'s; a person is refused, as a terminal start refuses one. (Plan V checks a person at the
terminal's start and apply, and leaves the preview's unchecked: §18.)

**`preview --json`** at the terminal prints the DAG file itself instead (§5), and nothing else
on stdout: JSON with two-space indents and keys in the order of §5, so two previews of one file
and params are byte for byte the same and `diff` shows a change. It is masked, as every line `mt`
prints is; that changes no gate, as a gate holding a known secret is refused (§4), and text
masked is masked again when stored. A refusal goes to stderr, exit 1, so a refused preview never
leaves half a file in `dag.json`. Its `board` is `--board`'s, else `default`.

**Apply** reads a DAG from a regular file, or stdin for `-`, as `--body-file` reads a body (kanban
spec §2.6), and makes exactly it: the steps below, the checks again, then the one transaction. What
it makes is the DAG, and only the DAG: a workflow file edited since the preview changes nothing.
**`apply --dry-run`** makes every check apply makes, against the board's database, the key's lookup
included, and writes nothing: no transaction, no nudge. Its answer has apply's shape with `dry_run:
true` and no instance id: `would make 5 tasks, 5 links, 1 gate, on board research`, then a line a
task, each followed by its gates' commands, one a line with its timeout, masked, so the operator
sees every command the apply would put on the board before it does; or with `--json` `{"ok": true,
"dry_run": true, "existing", "board", "tasks": [{"ref", "step", "item", "gates": [{"command",
"timeout_s"}]}]}`; a key already used answers `existing: true` with the instance's id, as apply
would. It cannot say what changes between it and the apply, which is why apply checks again.

**Start** is the expansion and the apply in one call, with the expanded DAG never written out, as
before. There is **no apply from chat**: a DAG is a file, made by `preview --json` or a tool and
kept beside a script, not typed into a message of at most 4,000 characters, and chat's start
already expands the operator's file.

**From a run**, two commands, both the worker's, with JSON on stdin (kanban spec §7.3):

- **`start-workflow`**, as before: expanded and applied on the gateway, from the operator's file,
  its gates included;
- **`apply-dag`**, new, a tenth command: a DAG the agent wrote itself, as one JSON object, which may
  carry two more keys beside the DAG's own, `idempotency_key` and `dry_run`, taken off before the
  DAG is checked. With `"dry_run": true` it is `apply --dry-run`: every check, nothing written, the
  answer with `dry_run: true` and no `instance_id`, so an agent can check a graph before it makes
  it. It costs one flag on a path the terminal has anyway. No gates, and none of the four settings
  `create` does not take (§5). Its `workflow` must be absent or `null`, and its `params` absent or
  `{}`: a name would say the operator's file made the instance, and params would say they were
  filled into it, where an agent made its tasks; `start-workflow` starts a workflow. Its `board`, if
  given, must be the run's task's, else `other_board`: a run's work stays on its board (kanban spec
  §16.5), and a DAG that names another is refused rather than moved quietly. This is the planner's
  way to make a whole graph at once (the guide's Recipe 3): a run's `create` makes one task, and a
  claimable one is claimed before `create` answers (kanban spec §7.2), so a graph made task by task
  can start running half made, and is left half made if the agent stops; `apply-dag` makes all of it
  in one transaction, or nothing.
- *A decision.* **No preview for agents.** It would cost little, but what it expanded could not be
  applied: a file with gates gives a DAG `apply-dag` refuses, and its `workflow` name
  too. A preview an agent cannot act on invites editing it around the rule, and `start-workflow`'s
  refusal already names the usable workflows and their params (below), which is what an agent needs
  to choose one.

**Params from chat.** The rest of the message after the name, on any lines, is `key=value` pairs,
separated by spaces, tabs or line breaks. **A pair splits at its first `=`**: the key before it,
in the param grammar, and the value after, which may hold more `=`. A value is either up to the
next space, or quoted with `"…"`; a typed `"` may arrive as `“` or `”`, either side, as phone and
macOS keyboards substitute them, so a value opening with any of the three is quoted, and closes at
`”` or `"`. There is no escape inside quotes,
so a value cannot hold a `"` (§17). A **list** is comma-separated, each item trimmed, or the
key repeated, each occurrence adding its items; **a quoted value is one item**, not split, so
`vendors="Acme, Inc"` is one vendor. A text param given twice is refused. **A word that is not a
pair** is refused with the usage line; when it follows a value ending in `,`, as in `vendors=acme,
globex`, the refusal adds: "Leave no space after a list's commas, as `vendors=acme,globex`, or
quote a value that holds spaces, as `topic="log storage"`." Its list example is two items, as a
quoted list value would be one.

**A person** is given by @-mention, `owner=@Alice Smith`. Lark's text shows a mention as `@Name`,
and a name may hold spaces, so the parser cannot find where such a value ends by itself:
`KanbanChat` passes **the message's mention names** (`InboundMessage.mentions`) into the parser,
which is pure all the same, and an unquoted value starting with `@` is matched against them, the
longest name first, so `@Alice Smith` is taken whole where `@Alice` is a mention too. A mention name
followed by `,` goes on as a list, and each item after a comma is matched the same way, so
`owners=@Alice Smith,@Bob Jones` is two people. Once each `@` is resolved, a list naming one person
twice, by two mentions or a mention and a principal, is refused as any repeated item is. The parser
returns each pair as `{ key, value, quoted }`, knowing no workflow. The service reads the pairs
against the file, and **`@` is resolved only for a param that lands in a person field**, an
`assignee` or `reviewer` the file writes as `"{{owner}}"` or `{ person: "{{owner}}" }`: there
`KanbanChat` turns it into its `lark:<union_id>`, as `/kanban task new`'s `assignee:` line is read
(kanban spec §9.1, D2), and a name no mention has, or two share, is refused as there. For any other
param `@Alice` is text, put in as typed. A param used both in a person field and in text gets the
principal in both (§17).

Preview reads its pairs in the same way.

**Params at the terminal**, for `preview` and `start`: `--param key=value`, repeated; the shell has
already removed the quotes, so a list param's value is split at every comma, and repeating the key
adds items. An item holding a comma cannot be given here (§17). **From a run**, as JSON: a text
param is a string, a list param an array of strings, and the other type is refused; nothing is
split.

**Who may preview, start and apply:**

- **in chat**, `start` at operator tier, as `/kanban task new`: a start starts agents, unsupervised,
  in workspaces (kanban spec §9.1). A person named, in a param or in the file, needs talk tier, as
  when named in `task new` (kanban spec §4.2). `preview` is talk tier: it makes nothing, and says no
  more than `list` and the board's own tasks do;
- **at the terminal**, the operator, as `mt kanban task new`, recorded as `operator:<login>`:
  `preview`, `start` and `apply`, with or without `--dry-run`. As there, only roles are given work:
  a terminal reads no Lark settings, so a person, in a param, the file or a DAG, is refused
  (`person_not_assignable`, kanban spec §2.6). Plan V lifts this: a person is checked for talk
  tier there as chat checks one (§18.3);
- **from an agent's run**, `start-workflow` and `apply-dag`, allowed as `mt kanban create` is
  (kanban spec §7.3), with the run's token, in the run's scope (kanban spec §7.2): before the run is
  decided, and after its own report, until it closes. The tasks are recorded as created from the
  run's task (`created_from_task`), as a run's follow-ups are, so the run may link them (kanban spec
  §7.2).

**The worker's command.** *A decision, forced by the code.* The design wrote the run's start as `mt
kanban workflow start … --param …`. Since 2026-11-09 the two grammars of `mt kanban` are told apart
by name alone (kanban spec §7.3): a group, `task`, `board`, `gate`, is the operator's and refused in
a run's shell (`OPERATOR_GROUPS`, `src/cli/mt.ts`), and a worker's command takes no arguments and
reads one JSON object on stdin, because an agent's free text through shell arguments invites quoting
failures, and params are free text. So the worker gets its own commands, **`mt kanban
start-workflow`** and **`mt kanban apply-dag`**, and `workflow` is an operator's group like the
others: in a run's shell, `mt kanban workflow …` is refused as `operator_command`, its message
naming the two. The request and answer of `start-workflow`:

```
{"workflow": "vendor-eval", "params": {"topic": "log storage", "vendors": ["acme", "globex"]}, "idempotency_key": "ls-1"}
{"ok": true, "instance_id": "w_…", "existing": false, "board": "research",
 "tasks": [{"task_id": "k_…", "ref": "shortlist", "step": "shortlist", "item": null},
           {"task_id": "k_…", "ref": "evaluate:1", "step": "evaluate", "item": "acme"}, …]}
```

`apply-dag`'s input is the DAG (§5), with `idempotency_key` beside its keys, and its answer the
same shape, each task with its `ref`, so the agent can find the task it called `recommend`.

`params` is optional, and absent means `{}`, for a workflow whose params all have defaults or that
has none; `workflow` is required. `badInput` (`src/kanban/worker.ts`) gains a field kind for
`params`: an object whose values are text or lists of text, within §2's sizes, its depth bounded as
metadata's is. A refusal is the worker's usual JSON; an unknown workflow is `unknown_workflow`, a
new code, whose message names the workflows that are usable and their params, so an agent that
guessed a name learns the right one from the refusal itself. The message is cut at 4 KiB, the size
of a gate refusal's output (kanban spec §7.7), the names first and the params after, with how many
were left out: the worker CLI has no message limit of its own, and an agent's context should not
take a directory's worth. The work protocol (kanban spec §7.1) gains one line beside `mt kanban
create`'s, naming the command and its JSON, and another for `apply-dag`, saying it carries no gates.
`mt kanban apply-dag` refuses a DAG whose canonical form is over 192 KiB itself, before it is sent,
as `too_large`, and input that is not UTF-8 as `invalid`.

**The steps of an apply**, in `KanbanService.applyDag`, whatever path the DAG came by; a start
expands the file into a DAG first (step 1), and an apply reads it; a preview and a dry run stop
before step 3. **An apply reads before step 0**: it reads the DAG, within its raw cap, decodes it as
strict UTF-8, parses it, checks its shape (the format, every key known, every type, well-formed
strings, the refs and parents, where its gates came from, and from a run the settings it may not
set), makes it canonical and measures it (§5). Only then is the key looked up: the hash the
lookup compares is the canonical form's, and a DAG with an unknown key or the wrong shape is refused
`invalid` before any `existing` answer, as it is not a DAG at all. A start keeps step 0 first, as it
has no DAG until its file is expanded:

0. **look the key up first**, read-only, when there is one: an instance with that key on this board
   is answered at once, `existing: true`, before a file is read or a param or task checked. A repeat
   is a redelivery, or an agent re-running a command whose answer it did not see; the file may have
   been edited or removed since, or a person's tier changed, and answering a repeat with a refusal
   would tell the caller the start failed when it was made. A key on another board is `other_board`.
   **A key reused for something else is refused `invalid`**, naming the instance: for a start, a key
   used for another workflow's name; for an apply, a key used for another DAG, told by the SHA-256
   of its canonical form (§5), which the instance keeps (§7); and a key a start used, given to
   an apply, or an apply's given to a start, told by the instance's `source`. A key reused by
   mistake must not return an instance of something else. The writer looks the key up again in its
   transaction (§8), the guard against two racing;
1. for a start, the expansion (above), then the same shape checks, canonical form and measure; for
   an apply, nothing more, as it read its DAG before step 0;
2. check every task as `create` would (`#assignable`, the workspace, the contract, the numbers,
   the crash rule), and every gate as `addGate` would, plus the 100 and every name, **just before
   the transaction**, against the team and the people as the process holds them in memory, and the
   board as the database has it **now**: a role removed, or a person who lost talk
   tier, between a preview and its apply is refused at the apply. **One failure refuses the whole
   apply**, naming the ref, and the step and item (`evaluate:2, step evaluate, item "globex": role
   "evaluator" is not configured`), and nothing is made. The checks run before any write, so a
   refusal costs no transaction;
3. in one transaction, the writer's `applyDag` (§8) writes the instance with its DAG, every task,
   every link, every gate and every member row. Inside it, what is in the database is checked
   again: the board, live, the key, and the gates' bounds. The roles, the workspaces and the people
   are in memory, not in the database, and are not read again inside it: they were checked in step
   2, an instant before, as `create` checks them before `createTask`;
4. tell the dispatcher once: chat's `changed()`, the terminal's one nudge (kanban spec §2.6), the
   worker socket's `changed()` after the answer. One pass finds every root task ready.

**The terminal's answer**, to `start` and `apply`. Plain text, as the other operator commands'
(kanban spec §2.6): `started vendor-eval as w_…, on board research, 5 tasks`, or `applied a DAG with
no workflow as w_…` and the rest, then a line a task, `k_… evaluate:1  Evaluate acme for log storage
role worker`, every task, uncut, masked and stripped of control characters; a repeat says `already
made, as w_…`, with its tasks. With `--json`, one line in the worker's answer shape: `{"ok": true,
"instance_id", "existing", "board", "tasks": [{"task_id", "ref", "step", "item"}]}`, or the refusal.
Then the nudge, as after `task new`: when the config leaves `kanban.enabled` unset or false, no
gateway is asked, and it says the board is off and nothing runs the tasks until it is turned on; a
gateway that does not answer loses nothing, and it says why without saying to try again: a second
start without `--key` makes a second instance.

**The refusals of a start or an apply**, on every path, in the worker's codes (`RefusalCode`, and
the worker API's own):

| Code | When |
|---|---|
| `unknown_workflow` | no usable file of that name; the message names the usable ones (above) |
| `invalid` | from a run, a field `start-workflow` does not take, as `badInput` refuses one for every worker command; a DAG of another format, with an unknown key, a ref missing, repeated or of other characters, a parent not earlier in it, not UTF-8; from a run, gates, a setting `create` does not take, a `workflow` name or params; a gate command holding the mask `••••`; the file is broken (§4), a param unknown, missing, of the wrong type, given twice, or with a character a title refuses, an item empty, repeated or holding a secret, a name holding a secret, a key reused for another workflow or another DAG, or used by a start for an apply or the reverse, or in another's namespace, 101 tasks |
| `too_large` | a DAG's canonical form past 192 KiB from a run or 1 MiB elsewhere, the params past 64 KiB, a value or an item past 8 KiB, a list past 100 items, a task's field past `task new`'s limits after substitution |
| `unknown_role`, `supervised_role`, `unknown_workspace` | a name, in the file or from a param, as `create` refuses it, naming the step and item |
| `person_not_assignable` | a person without talk tier, or any person at the terminal (kanban spec §2.6), which plan V narrows to a person without talk tier there too (§18.3) |
| `unknown_board`, `board_archived` | the board, as for `task new` (kanban spec §16.4) |
| `other_board` | the key's instance is on another board (kanban spec §16.5); from a run, a DAG naming a board not its task's |
| `no_board` | at the terminal, no database, or one not yet migrated (§7) |
| `run_superseded`, `unauthorized` | from a run: the run is over or decided by another, or the token is not a run's (kanban spec §7.2) |
| `operator_command` | `mt kanban workflow …` in a run's shell (§6) |
| `bad_request` | from a run: the request is not JSON, or not an object |

`preview` and `apply --dry-run` give the same refusals, having made nothing. In chat each is said as
any refusal is, "Not done: …", on one line (kanban spec §9.1).

**The board**: in chat, the chat's board (kanban spec §16.4), refused when it is archived, as `task
new` is; at the terminal, for `preview` and `start`, `--board`, else `default`, and `preview --json`
writes it into the DAG; for `apply`, the DAG's `board`, else `default`; from a run, its task's
board, for `start-workflow` whatever else (kanban spec §16.5), as its request has no board field,
and for `apply-dag` refusing another (above). One instance is on one board: every task is made on
it, and a parent and its child are on one board anyway (kanban spec §16.5).

**Idempotency**, keyed on the instance, not its tasks:

- chat's key is the Lark message's, `lark:<message_id>`, as a task's is, so a redelivery starts
  nothing twice;
- the terminal's and an agent's are `--key` and `idempotency_key`, on `start` and `apply` alike,
  namespaced as tasks' keys are (kanban spec §3.1): `operator:<key>`, and `run-task:<the run's
  task>:<key>`, so an agent's key is scoped to its task, and a key in another's namespace is
  refused;
- a repeat returns the instance it made, `existing: true`, and makes nothing; a key used on another
  board is refused `other_board` (kanban spec §16.5); a key is kept for good, an archived instance's
  included;
- without a key, at the terminal or from a run, every start or apply is a new instance, as an
  unkeyed `task new` is. A preview takes no key: it makes nothing. A dry run takes one, to say
  whether the apply would answer with an instance already made.

The tasks themselves carry no key: they are made in the instance's transaction or not at all, so
the instance's key covers them, and a key of their own would only be a second thing to keep unique.

**The stored DAG.** The instance keeps the DAG it was made from (§7), the expanded one for a
start, in place of a copy of the file: the DAG is what was made, the file only what it was made
from, and a hand-applied DAG has no file. An edit to the file, or its removal, never changes an
instance already made; `show --dag` prints the stored DAG, so what an instance was made of can
always be read, and the instance keeps the workflow's name when it has one.

## 7. Schema (migration `009_workflows.sql`)

| Table, column | Notes |
|---|---|
| `kanban_workflow_instances` | `instance_id` (`w_…`, opaque, `newWorkflowId` in `src/core/ids.ts`), `name` (the workflow's, or null for a DAG with none), `dag` (JSON: the DAG it was made from, §5, the expanded one for a start, its string values masked on write but its gates' commands, which are stored as written), `dag_sha256` (of the DAG's canonical form, §5, unmasked: how a repeated key tells the same DAG from another, §6; never printed, in `show`, `show --json` or `show --dag`), `source` (`start` or `apply`, so a key cannot pass between the two, §6), `board` (`REFERENCES kanban_boards(name)`), `created_by`, `created_via` (JSON, as a task's: the chat, the run, or `{kind: operator}`), `idempotency_key` (unique, nullable), `created_at`; `STRICT` |
| `kanban_workflow_tasks` | `task_id` (the key, `REFERENCES kanban_tasks(task_id)`), `instance_id` (`REFERENCES kanban_workflow_instances`), `ref` (the task's ref in the DAG), `step`, `item` (the for_each item, masked on write; null for a task without one), `position` (the task's place in the DAG's array, from 0); `UNIQUE (instance_id, position)`, `UNIQUE (instance_id, ref)`, as refs are unique in a DAG; `STRICT, WITHOUT ROWID` |

- **A task records its instance, step and item in the members table, not in `kanban_tasks`.** kanban
  spec §1's seam promised that nothing in the kernel knows about workflows, and a column on the
  kernel's table would be read, or carried, by everything that reads a task. In a table of its own,
  a member row is found by its task's key; besides the workflow commands, its one reader is `task
  show` (§10), which joins it for its one line, and nothing else ever reads it: not the dispatcher,
  the claim, the prompt or the notices. `task_id` as the key makes a task a member of at most one
  instance.
- **Members are exactly what the apply made.** Rows are written in the apply's transaction and
  never added, changed or removed: a follow-up, a task linked in later or a task made by a deciding
  step is related to the instance (§10), never a member.
- **Foreign keys** are allowed here, unlike on `kanban_tasks.board` (kanban spec §16.2): both tables
  are new, not columns added to a live table.
- **An index on `(board, created_at)`** for `/kanban workflow instances`, which reads at most the
  board's 200 most recent instances, newest first, so a board with years of them lists as fast as a
  new one; older ones are reached by id, with `show`.
- **An index on `kanban_tasks(created_from_task)`**, added by `009`: `show`'s related tasks
  (§10) are found by it, and nothing indexes that column today. A new index on a live table
  writes no row of it, and is built in `009`'s transaction.
- **An unmigrated database.** Between a build with plan T and the start that migrates (kanban spec
  §20.15), the tables are not there. The workflow commands at the terminal look for them as
  `openBoard` looks for `kanban_gates`, and refuse `no_board` with "start the gateway once, so it is
  migrated", changing nothing; `task show`'s one line (§10) reads the members table only when it
  exists, so `mt kanban task show` keeps working on such a database.
- **The DAG is stored in place of the file.** It is what was made, task by task, and a hand-applied
  DAG has no file to keep (§6). Its params are inside it, so there is no `params` column. **Masked
  on write, but for its gates**: its string values are masked value by value, as an event payload is
  (layer 3, kanban spec §10.1), so the params, titles and bodies in it are stored as the tasks store
  them; a gate's command is stored as written, as `kanban_gates` stores it, since a masked command
  would record a command other than the one that runs, and a gate holding a known secret is refused
  (§4, §5) so none is stored. Wherever the DAG is shown, it is masked again, as every reply and
  every line `mt` prints is.
- **No new event table, and no instance event.** `kanban_events` rows belong to a task, its `task_id
  NOT NULL` (kanban spec §3.4, as kanban spec §16.2 found for boards). The instance's own row says
  who started it, how and when; its history is its tasks' events.
- `UPDATE schema_version SET version = 9`, as every migration ends.

## 8. The writer, and the events

- **One writer.** `db/kanban.ts` writes both tables, as it writes every `kanban_` table, and
  WRITERS.md gains their rows. **`applyDag(db, instance, tasks, now)`** takes the checked DAG's
  tasks in their array's order, each with its member fields, its parents as positions of earlier
  tasks, and its gates, and the instance with its name, its DAG and its hash. In one `tx`: the board
  is worked out (the run's task's for a run), the key looked up again, as the race guard behind step
  0 (a repeat returns the instance and its members, `existing: true`; another board's is
  `other_board`; another workflow's name, or for an apply another DAG's hash, `invalid`), the board
  checked live (kanban spec §16.8); then the instance row; then each task through the same insert
  `createTask` uses, which plan T moves into a helper of both, so a workflow's task is made exactly
  as any task is, with its subscription (§9) and its `created` event; then its links, its gates
  through the insert `addGate` uses, again a shared helper, which checks the 20 and the 600 s again
  inside the transaction; then its member row. A refusal rolls back everything (`tx`), so an apply,
  a start's included, makes all of it or none.
- **Each task still writes its own `created` event**, with the instance, step and item added to the
  payload: `workflow`, the instance's id `w_…`, `workflowName`, its name or null, `ref`, `step` and
  `item`; and each gate its `gate_added`. Every change to a task writes one (kanban spec §3.4): a
  subscription's cursor and a worker's prior context read a task's own events, and a task with no
  `created` would be the one task whose events start in the middle. `workflow`,
  `workflowName`, `ref` and `step` join `BOARD_KEYS`, as they identify; `item` is a param's text,
  and is masked. `created` is no notice (kanban spec §9.4), so a start of 100 tasks sends no
  notices, only its reply.
- **A gate's `created_by`** is who made the instance, as recorded on it, and its `gate_added` event
  carries `workflow`. The command came from the operator's file or the operator's DAG, but the apply
  is what put it on the task. Its payload's `workflow` is the instance's id, as in `created`.
- **`archiveWorkflow(db, instanceId, by, now)`** archives, in one `tx`, every member not already
  archived, through the same body `archive` runs, which plan T moves into a helper: an undecided
  run ends `superseded`, a decided one is closed, a done task keeps the time it was done. Each
  writes its own `archived` event, with `workflow` in its payload. It returns the runs it decided,
  for their turns to be cancelled (§10).
- **`threadSubscriptions(db, taskIds, at, threadId, rootId)`** replaces `threadSubscription`'s one
  task with a list, moving each in one transaction under the same rules (kanban spec §19.4): only a
  subscription still at chat scope with no root moves. `/kanban task new` calls it with one.

## 9. Who hears, and the reply

**Subscriptions**, written by `createTask`'s `subscribe()` for each task as for any, in the start's
transaction:

- **a chat start**: every task is subscribed to the chat, as a task from `task new` is, so the
  starting chat follows every task. 100 tasks are 100 rows, one transaction;
- **a terminal start**: `{kind: operator}`, which no chat follows (kanban spec §2.6), so no
  subscription; with plan V's `--chat`, every task is subscribed to that chat, and the reply is
  posted there by the notifier (§18);
- **a run's start**: each task gets every subscription of the run's task, as a follow-up does
  (kanban spec §9.4), with its thread and root (kanban spec §19.4).

A task still has at most one subscription per bot (kanban spec §19.1), which plan L's routing relies
on.

**The reply is one message**: the instance, then one line per task, in position order, each with
its id, its title and its assignee:

```
Started vendor-eval as `w_…`, 5 tasks:
- `k_…` Shortlist vendors for log storage, for role worker
- `k_…` Evaluate acme for log storage, for role worker
- …
This thread hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.
```

with the board named when it is not `default`, as `task new`'s reply does. **Two wordings**, as
`#created` renders for `task new` (kanban spec §19.5): the thread's, "This thread hears …", with a
person's card said to come in this thread, or by direct message if they are not in this group; and
the chat's, "This chat hears …", with a person's card said to come by direct message. A start in a
group at chat scope answers `{ text, quoted, thread }`: `text` in the thread's words, and `quoted`,
the chat's words, which the router sends instead when Lark refuses the threaded reply (kanban spec
§19.4). A start in a direct message, or in a thread with no root known, is answered in the chat's
words alone; in a group's thread whose root is known, in the thread's. **It fits Lark's limits** as
every reply does: a text sent as one message is at most 4,000 characters (`ONE_MESSAGE`), and the
router cuts a reply to it. A cut reply would lose its last line, which says who hears, and part of a
task's line. So the reply lists at most 30 tasks, as `/kanban task list` lists at most 30 lines
(kanban spec §9.1), each title cut at 80 characters, and drops task lines from the end until the
whole is under 3,800 characters, the notices' own bound (kanban spec §9.4); a line then says how
many more there are and that `/kanban workflow show w_…` lists them all. A repeat answers "Already
started, as `w_…`.", as `task new`'s does. The same holds for an instance made from a run's DAG,
which the run's subscriptions follow, and for a terminal's, which no chat follows.

**With plan L's threads.** A start in a group at chat scope is answered in a thread on the command
(kanban spec §19.1), and the thread is the instance's: `KanbanAnswer.thread` names the instance,
`w_…`, where it names a task for `task new`, and `KanbanChat.threaded` tells the two apart by the
prefix, moving every member's subscription to the thread in one `threadSubscriptions` call. Every
task's cards and notices then go there, as one task's do (kanban spec §19.5), and a deciding step's
follow-ups inherit the thread (kanban spec §19.4). **The hold** (kanban spec §19.4) is set on every
member, synchronously, before the dispatcher is told, and released for all of them by `threaded`, or
by its timer: a person's card for a root task must not go by direct message in the moment before the
move. The router is unchanged but for the name in its log lines. A start inside an existing thread
uses that thread, and one in a direct message has none, as for a task (kanban spec §19.1).

**Preview's reply** has the same shape and the same bounds, saying what would be made, with each
task's ref, its parents' refs and how many gates it has, and ending "Nothing was made: `/kanban
workflow start …` makes it", or the refusal a start would get. It makes no instance, so no thread
and no subscription: it is answered as any reply is.

**Notices** are unchanged. 100 tasks in one thread are one conversation (kanban spec §9.4), so their
notices are batched: at most 20 a message, every 2 s.

## 10. Seeing and managing

```
/kanban workflow list                 # the workflow files: name, description, params
/kanban workflow instances [all]      # the instances on this chat's board: open ones by default
/kanban workflow show w_…             # one instance in detail
/kanban workflow archive w_…          # archive all of its tasks
```

The same are `mt kanban workflow list|instances|show|archive`, with `--board` and `--json` as the
operator's other commands take them (kanban spec §2.6), and `show --dag`, which is the terminal's
alone: a DAG of up to 1 MiB is no chat message. `list`, `instances`, `show` and `preview` are talk
tier, as `task list` and `task show` are; `start` and `archive` operate. `/kanban workflow` is a
fourth group, beside `task`, `board` and `gate` (kanban spec §9.1); `/kanban workflow` with no verb
lists its verbs, and `/kanban help` gains them.

**`list`** reads the directory at each call, as an expansion reads its file: each usable workflow
with its description and params, and each one that is not usable with why, so a person in chat
learns why a start would be refused. At most 30, then how many more. An instance made from a DAG
with no workflow is not in `list`, which lists files; it is in `instances`, as "(no workflow)".

**Status is derived, never stored**, from the members' phases and their display status (kanban spec
§4.1), by one pure function, for kanban spec §4.1's reason: stored, it would have to be rewritten
from every place a task changes:

| Status | When |
|---|---|
| **archived** | every member is archived |
| **done** | every member is done or archived, and not all archived |
| **blocked** | any member is blocked; shown with the count, "blocked (2)" |
| **running** | otherwise: some member is not done |

*A decision.* The design said done is every task done. A member archived by hand, with the rest
done, would then leave the instance running for good, with nothing left to run, so an archived
member counts as finished here, as an archived parent does for its children (kanban spec §4.1).
Blocked is checked before running, as a blocked task is what a person must act on. Members are
counted the same way, done or archived of the total, and said "done" ("running, 1 of 4 done"), but
"finished" for an archived instance ("archived, 4 of 4 finished"), in chat and at the terminal: its
members are archived, not done. Counting only done members instead would read "0 of 4 done" for
every archived instance, a finished one's included, and "3 of 4 done" for a done one with a member
archived by hand.

**`instances`** lists the board's instances, newest first: id, name, status, members done of
total, who started it and when. By default only running and blocked; `all` adds done and
archived. It reads at most the 200 most recent (§7), and shows at most 30 lines, as `task
list`, then how many more; past 200 it says that older instances are shown by id.

**`show`** names an instance by id, on any board, as `task show` names a task (kanban spec §16.4):
in chat it names the instance's board when that is not the chat's; at the terminal with `--board` it
refuses `other_board` an instance on another board, and `unknown_board` a board that does not exist,
as the task commands do (kanban spec §16.5). An id that is no instance's is `not_found`.

- the name, or "(no workflow)", the description from the file when it is still there, who made it (a
  person by the name Lark last gave, as `show` names people), when, how (chat, terminal, or a run,
  by its task), the board, and the params, masked and escaped;
- each step's tasks, in position order, each with its id, display status and assignee, a for_each
  task labelled with its item; a blocked task with its kind and reason, as its notice gives them;
- **related tasks**, listed apart, as not members: a task that is not a member and has a member
  as a parent, or as its `created_from_task`. A related task that is a member of another instance,
  as a deciding step's start makes, is shown as that instance, one line;
- in chat, cut to fit one message as the reply is (§9), saying what was cut; the terminal's
  gives everything, and its `--json` gives each task's `phase` and `status`, as `task show --json`
  does;
- `--dag`, at the terminal only, prints the stored DAG, masked, as JSON: what was made. `apply`
  takes it again to make another instance like it, with any secret in its text now `••••`. A gate
  command never holds a known secret (§4), so masking leaves gates as they are; but `apply` refuses
  a gate command containing the mask `••••`, saying the DAG was printed masked and the command must
  be written out again, as a masked command would run broken (kanban spec §10.1). The hash is not
  printed.

`/kanban task show` of a member gains one line: the instance, its step and item.

**`archive`**:

- archives every member not already archived, in one transaction (§8), as `/kanban task
  archive` archives one: an undecided run is superseded, and its running turn cancelled, the
  caller cancelling each run the writer returned, as `#decided` does for one; a done task keeps
  the time it was done;
- operator tier, at the terminal the operator, as archiving a task is (kanban spec §10);
- related tasks are left alone: they are not members. One whose parent was a member is released by
  the archive, as any child of an archived parent is (kanban spec §4.1);
- the key stays used (§6);
- an instance already wholly archived says so and changes nothing;
- the dispatcher is told once, as after `task archive`.

## 11. Failure, and changes after start

- **Nothing is automatic.** A member blocks as any task does (kanban spec §5.4), and the chat that
  follows it hears. People unblock it, reassign it, comment on it, or route around it with `link`,
  as the guide's Recipe 5 shows for any graph. The instance shows as blocked until then.
- **Changes after the start are made with the ordinary task commands.** There are no edits at the
  level of an instance: its members are tasks, and every change to a task already has its command,
  its tier and its event. A link made to or from a member does not make the other task a member.
- **Steps cannot be added to an instance once made**, from the file or otherwise: the file may
  have changed since, and the stored DAG is the record of what was made. Starting the workflow
  again, or applying a DAG, makes a new instance; a run that needs more tasks beside an instance
  makes them with `create`, which leaves them related, not members.

## 12. Workspaces

A workflow's tasks resolve their workspaces at their claims, by kanban spec §2.3, like any task's:

- **A step's own `workspace`** is rule 1, and its role's explicit one rule 2.
- **A task with parents in the instance** uses rule 3. At its start every member's workspace is
  null, as none is claimed; by its claim its parents are done, so claimed, so fixed: the evaluations
  land where the shortlist was made, and the recommendation where the evaluations were, unless their
  roles name workspaces of their own. Parents in different workspaces leave an agent task
  unresolvable (kanban spec §4.2); the check refuses what it can foresee (§4), and the rest is
  `/kanban task workspace`, as for any task.
- **A root step**, or a DAG's task with no parents, has none. From a run, its tasks have the run's
  task as `created_from_task`, rule 3's stand-in, so they work where the deciding step did; from
  chat or the terminal, rule 4, the board's workspace or `default`.
- **A fan-out in one shared workspace runs one task at a time** (kanban spec §6.3): the evaluations
  of the example queue behind each other in the shortlist's checkout. They run side by side only in
  an isolated workspace (kanban spec §18), where each gets a directory of its own, a fan-in like
  `recommend` starting from the merge of its parents' branches (kanban spec §18.5), or with roles
  that work in workspaces of their own. The guide says so with the example.

## 13. Security and masking

- **Starting and applying are creating**, with its tier: operator in chat, the operator at the
  terminal, a run's token from a run (kanban spec §10). An apply makes only what `create` and
  `addGate` make, and its gates come only from the operator (below).
- **Gates are the operator's.** A gate is operator-defined (kanban spec §10). A DAG's gates are
  taken only from the terminal, whose user is the operator, and from an expansion on the gateway of
  the operator's file in the home; never from a DAG a run hands in (§5), and never substituted.
  Nobody who starts a workflow, in chat or from a run, can put text in a gate, since no param
  reaches one (§2), and nothing in a DAG is substituted. An agent runs as the gateway's user and
  could write a file in `$MT_HOME/workflows` itself, as it could edit `config.yaml` or a role's
  files (kanban spec §2.6): that is not a boundary, and not a new one.
- **Params are free text**, from chat and from agents. They are masked on write in the instance's
  stored DAG and in each member's `item` (layer 3, kanban spec §10.1), and land in titles, bodies
  and contracts, which `createTask` masks as it masks any; every reply that shows them masks them
  again (layer 1). A param in a name field is refused if it holds a known secret, as names are
  stored unmasked.
- **The stored DAG** is masked on write but for its gates, and shown masked (§7).
- **Names stay names**: a role, workspace or person is checked as a name before it is used as one,
  so a param can never become a path (kanban spec §2.3) or a principal the gateway does not know
  (kanban spec §4.2).

## 14. The cases

- **A file edited between the check and a start**: the start reads it then, and is refused if it
  is broken now.
- **A file edited between a `preview --json` and its apply**: nothing changes; the apply makes the
  DAG, which is what was previewed. Preview again to take the edit.
- **A role removed, a workspace removed, a board archived, or a person who lost talk tier, between
  a preview and its apply**: the apply checks again (§6), and is refused, naming the ref.
- **A DAG edited by hand at the terminal** after its preview: applied as edited, with its gates, by
  the operator, who may define gates anyway; the instance keeps the workflow's name it says, and
  the edited DAG.
- **A DAG applied twice with one key**: the second answers the first, `existing: true`; with the
  same key and another DAG, refused `invalid`.
- **A run's DAG with a gate, or a workflow name**: refused; nothing is made.
- **A file removed after a start**: its instances are unaffected, and `show --dag` prints what was
  made.
- **Two starts or applies with one key at once**: the second's transaction finds the first's row and
  answers with it, `existing: true`; the unique index is the backstop.
- **A role removed from config after a start**: its tasks become unassignable at their claims, as
  any task's do (kanban spec §4.2); a new start is refused.
- **A start on an archived board**: refused, as `task new` is (kanban spec §16.8). A board with a
  running instance cannot be archived, as its tasks are open (kanban spec §16.8).
- **A deciding step that starts another workflow**: the new instance's tasks are created from the
  deciding task, follow its chat, and show as one related instance in the first's `show`.
- **A deciding step that starts its own workflow again**: allowed, each a new instance. The board
  has no bound on this, as it has none on `mt kanban create` making tasks that make tasks
  (§17).
- **A run's start repeated after the run closed**: refused `run_superseded`, as every command of
  a closed run is (kanban spec §7.2); the instance it made stands.
- **A member archived by hand**: its children are released (kanban spec §4.1); the instance counts
  it as finished (§10).
- **A person in a param who has lost talk tier since the start**: their task is unassignable at
  its claim, as any person's would be.

## 15. Wiring

- **`src/kanban/workflow.ts`**, new and pure but for one file read: `readWorkflow(dir, name)`, the
  parse and checks (`checkWorkflow(text, facts)`, the facts being the roles, workspaces and whether
  supervised roles are accepted), `expand(workflow, params, board)` to a DAG (§5),
  `readDag(json)` and `checkDagShape(dag, from)`, which knows where gates may come from, and the
  status function. The service, `mt workflow check` and the startup check all call it. Its gate
  check uses `holdsSecret`, today a private function of `service.ts`, which plan T moves to a shared
  module both import, so the pure module does not import the service.
- **`src/kanban/task-checks.ts`**, new and pure: `taskProblems(task, facts)`, the per-task checks
  `create` makes today in `#assignable`, `#contract` and its own body, moved out of the service with
  their messages unchanged; its facts are the roles, the workspaces, `supervisedRoles` and an
  optional talk check. It returns the first problem, in `create`'s order today: the title,
  `createdBy`, `createdVia`, the types of the body, workspace, board and parents, the contract, the
  workspace being configured, the numbers, the crash rule, the assignee, the reviewer. `create`
  calls it, then `#idempotencyKey`, which stays in the service, as it reads the database for a run's
  task. It also exports the pure assignable check, `assignable(name, facts)`, returning the
  `Assignee` or the refusal, which `assign`, `assignReviewer`, `requestReview` (a named reviewer)
  and `create` all use in place of `#assignable`. `KanbanService.create`, `previewWorkflow` and the
  terminal's preview call `taskProblems`; it needs no database.
- **`src/kanban/service.ts`**: `KanbanServiceDeps.workflowsDir`, `$MT_HOME/workflows`, given by the
  gateway and by `openBoard` (`src/cli/gate.ts`); `previewWorkflow`, `applyDag` with its `dryRun`,
  and `startWorkflow`, which is the expansion then `applyDag`, `workflows()` (for `list`),
  `instances(board, all)`, `instance(id)` (for `show`) and `archiveWorkflow`, each checking its
  input as the others do.
- **`src/db/kanban.ts`**: `applyDag`, `archiveWorkflow`, `threadSubscriptions`, with
  `createTask`'s insert, `addGate`'s and `archive`'s moved into helpers they share; `BOARD_KEYS`
  gains `workflow`, `workflowName`, `ref` and `step`. **`src/db/kanban-read.ts`**: the instance, its
  members, the related tasks, and the instances of a board. **`src/db/WRITERS.md`**: the two tables'
  rows, and `kanban_subscriptions`' row naming `threadSubscriptions`.
- **`src/kanban/chat-parse.ts`**: the `workflow` group and its verbs, and the pairs of `preview`
  and `start`.
  **`src/kanban/chat.ts`**: their tiers, the @-mentions resolved, the holds and `threaded` for an
  instance; its id rendering takes `w_…` as the board's own ids. **`src/kanban/chat-render.ts`**:
  the reply, the preview, `list`, `instances` and `show`, cut to fit.
- **`src/kanban/worker.ts`**: `start-workflow` and `apply-dag` in `WORKER_COMMANDS`, their schemas,
  the `params` field kind, and for `apply-dag` the DAG read by `readDag` rather than by `badInput`'s
  flat schema, its gates refused; `unknown_workflow` and `too_large` in `RefusalCode`, as
  `KanbanService.startWorkflow` refuses sizes itself, on every path, and not only the worker API.
  **`src/kanban/prompt.ts`**: their lines in the work protocol. **`src/cli/kanban.ts`**'s usage
  gains them, and its 192 KiB check of `apply-dag`'s canonical form; `readAll` returns bytes, and
  every worker command's input is decoded with a fatal `TextDecoder`.
- **`src/cli/mt.ts`**: `workflow` in `OPERATOR_GROUPS` and `SUBCOMMANDS`, the refusal in a run's
  shell naming `start-workflow` and `apply-dag`, `mt workflow check`, and `USAGE`.
  **`src/cli/operator.ts`**: the `workflow` group, `preview` and its `--json` writing the DAG to
  stdout, `apply` and its `--dry-run` reading one as `--body-file` reads a body, with a nudge after
  `start`, `apply` and `archive`. **`src/cli/plain.ts`**: their plain text.
- **`src/index.ts`**: `loadStartup` runs the workflow check and returns its lines, which
  `createGateway` notes after the roles' line. **`src/cli/service.ts`**: `check` prints them as
  `warning:` lines, from the `loadStartup` of the build it checks.
- **`schema/009_workflows.sql`**.
- **`tsconfig.json`**: `"ES2024.String"` added to `lib`, for `String.prototype.isWellFormed`.

## 16. Testing

- **Unit, the file**: each key at each level, and an unknown one refused naming its place; an
  unquoted `{{` and its hint; a duplicated key; the names' grammar, `item` reserved, a badly named
  file or a symlink ignored with one note; the size limit; parents that do not exist, a self-parent
  and a cycle named; `for_each` on a text param or an undeclared one; `{{item}}` outside a for_each
  step; an undeclared reference; a list param in a name field; `required` with `default`, and
  neither; a `{{` in a gate refused, and `$NAME` accepted; a gate holding a known secret, too long,
  too slow, twenty-one gates, and 601 s together; a literal role or workspace not configured, a
  supervised role; a foreseeable workspace conflict refused and an unforeseeable one not; step
  order kept as written.
- **Unit, a start**: a repeated key answered before the file is read, with the file since removed or
  broken, and a key reused for another workflow refused; the params past 64 KiB in each path; a pair
  split at its first `=`; `vendors=acme, globex` refused with the hint; an @-mention whose name
  holds a space matched whole, longest first, resolved only for a person field and kept as text
  elsewhere; a line break, control or bidi character in a value landing in a title refused; an item
  holding a known secret refused; a gate with no `timeout_s` counted as 300 s; the terminal's plain
  and `--json` answers, with the board off; the workflow commands refused `no_board` on an
  unmigrated database, and `task show` working there; `show` of another board's instance by
  `--board`; `unknown_workflow`'s message cut at 4 KiB; a missing required param, an unknown one, a
  default filled in; chat's pairs, quoted and curly-quoted values, a list by commas and by
  repeating, a quoted item with a comma, a text param twice, an @-mention with a space in its name,
  a stray word; the terminal's split at commas; a run's JSON with the wrong type; substitution in
  every text field and a value holding `{{` left as written; a name-valued param invalid, unknown, a
  person without talk tier, holding a known secret; an empty list, a duplicate item, 101 tasks; a
  title past 512 bytes after substitution; one failure refusing the whole start, naming the step and
  item, with nothing written; all to all links between two for_each steps, and a fan-in on every
  task of a for_each step; every task, link, gate and member row in one transaction, and a refusal
  inside it rolling all of them back; each task's `created` event with `workflow`, `step` and
  `item`, and no notice; the gate's `created_by`; the key in each namespace, a repeat `existing:
  true` with nothing made, another board's key `other_board`, an archived instance's key still used;
  the board in each path, an archived board refused; a run's start on its task's board whatever
  else, its tasks created from its task, and linkable by the run; the dispatcher told once.
- **Unit, seeing and managing**: the status table, a hand-archived member among done ones; `list`
  with a broken file; `instances` by default and with `all`; `show`'s steps in order, items,
  blocked reasons, related tasks apart and another instance as one line, `--dag`; `archive` of
  every member in one transaction, runs superseded and their turns cancelled, related tasks left,
  a second archive changing nothing; the tiers of each command, and a sender with no union_id.
- **Unit, the DAG**: an unknown key refused before an `existing` answer, with a key already used;
  each default of the task table, a key holding its default deleted from a previewed file leaving
  the hash as it was, `body` `""` and `null` the same, a contract field `null` and omitted the same,
  `null` refused where the default is not `null`, the params ordered by code point; a lone surrogate
  refused; a gate holding `••••` refused by the file's check, a start and an apply, and accepted by
  `gate add`; the terminal's raw cap of 4 MiB and `apply-dag`'s of 256 KiB; a broken byte refused by
  every worker command, a report's included; `taskProblems` giving `create`'s messages with and
  without a talk check; `create`'s refusals unchanged, each in its order, before and after the move;
  `assign`, `assignReviewer` and `review` refusing through `assignable` as before; a BOM refused as
  invalid JSON; a request to the socket that is not UTF-8 refused `bad_request`; a DAG param name
  outside the grammar refused; the canonical form the same for a reindented file, reordered keys and
  defaults written or left out, and different for one changed value; its size measured, 192 KiB for
  `apply-dag` and 1 MiB for a start and a terminal apply; bytes that are not UTF-8 refused, from a
  file and from stdin; from a run, `priority`, `failure_limit`, `retry_on_crash` and `max_runtime_s`
  refused unless at their defaults, and `workflow` and `params` unless absent, `null` and `{}`; a
  gate command holding `••••` refused; a repeated ref refused by the members table's unique index as
  a backstop; format 1 and another refused; every key at each level, an unknown one refused naming
  its place; a ref missing, repeated, too long or of other characters; `step` absent taken from the
  ref; a parent later in the array, absent, or named twice; 0 and 101 tasks; 192 KiB and one byte
  more; the params' 64 KiB; every task field checked as `create` checks it; a `{{` kept as text, in
  a gate too; gates at the terminal and in an expansion of the file accepted, from a run's
  `apply-dag` refused, and `gates: []` accepted; a run's DAG with a `workflow` name refused, with
  another board `other_board`, with none on its task's board.
- **Unit, preview and apply**: `preview --json` byte for byte the same twice, every key written,
  refs `step` and `step:n`, a refusal on stderr with nothing on stdout; preview's summary the same
  in chat and at the terminal; `apply --dry-run`, and `apply-dag` with `dry_run`, writing nothing,
  refusing what apply would, answering `dry_run: true` with no instance id, and `existing: true` for
  a used key; an apply of a preview making what a start makes; a role removed, a person who lost
  talk tier and a board archived between preview and apply refused at apply; a file edited after a
  preview changing nothing; a repeat by key with the same DAG `existing: true`, with another
  refused, and a start's key given to an apply and the reverse refused; the hash in no output;
  preview at the terminal loading as `openBoard` does, opening no database; a dry run listing each
  gate's command; the stored DAG masked but for its gates, and its hash taken before masking; a DAG
  with no workflow shown as "(no workflow)"; `show --dag` applied again making a like instance;
  preview making nothing, at talk tier, with a refusal as start's.
- **Unit, chat's reply**: 30 lines at most, cut titles, the count of the rest, under 3,800
  characters with 100 tasks of 512-byte titles; the thread naming the instance, every member held
  and released by `threaded`, and every member's subscription moved in one call; a start in a
  direct message and inside a thread.
- **Unit, the checks' output**: the startup lines, `workflows: none`, a broken workflow not
  stopping the start; `mt workflow check` with and without a name, its exit codes, in a run's
  shell; `mt service check`'s warnings passing.
- **Unit, the worker**: `apply-dag`'s input and answer with refs, its key taken off before the
  check, its 192 KiB refused by `mt kanban apply-dag` before sending; `start-workflow`'s schema,
  `unknown_workflow` naming the usable ones, the answer's tasks, `mt kanban workflow start` in a
  run's shell refused naming `start-workflow`.
- **End to end**: the example workflow started from a fake chat in a group, its three steps run by
  the fake CLI agent through the real socket, the evaluations after the shortlist and the
  recommendation after them all, its notices in the instance's thread; a deciding step's agent
  starting a second workflow through `mt kanban start-workflow`, whose tasks follow the first's
  thread; a planner's agent applying a graph of five tasks with `apply-dag`, all made before any is
  claimed, its root claimed after the answer, its tasks following the planner's chat; a terminal
  `preview --json`, edit, `apply --dry-run` and apply, followed by no chat.

## 17. Limits

- **No conditions and no loops.** A workflow is a fixed graph; branching is a deciding step's work
  (§0).
- **No item pairing.** Two for_each steps over one list are linked all to all (§3).
- **Params are text and lists of text.** No numbers, choices or patterns; no literal `{{` in a text
  field; in chat no `"` inside a value; at the terminal no comma inside an item (the worker's JSON
  has neither limit).
- **At most 100 tasks an instance**, one board, and a DAG whose canonical form is at most 192 KiB
  from a run and 1 MiB elsewhere.
- **No apply from chat**, and no preview for agents: chat previews and starts the operator's files;
  an agent starts a file with `start-workflow` or applies its own DAG (§6).
- **A DAG's parents are its own refs.** It cannot name a task already on the board; that is a
  `link` after the apply.
- **No gates from an agent's DAG**, and no workflow name on one. A graph an agent plans gets its
  checks from its contract and its reviewer; an operator adds gates to its tasks afterwards with
  `gate add`.
- **No edits at the level of an instance**, and no steps added once started (§11).
- **No bound on agents starting workflows from workflows**, or applying DAGs from tasks a DAG made:
  a deciding step can start its own workflow again, as an agent can create tasks that create tasks
  today. Each start is a task's work, which a person can stop.
- **A person's name in a text field is their principal**, as substituted, not the name Lark gives,
  when the same param also names a person field; a param that lands only in text keeps `@Name` as
  typed.
- **The terminal checks against its own shell's configuration**, as `mt kanban task new` does: a
  role added to the files but not yet loaded by the gateway is accepted there, and runs once the
  gateway has it.
- **The reply lists 30 tasks**; `show` lists every one at the terminal.
- **No history of an instance** beyond its row and its tasks' events, as a board has none (kanban
  spec §16.2).

*Added on 2026-11-13.* The user chose: the name "workflow", an instance `w_…`, and the verb "start";
a fixed graph with no conditions, branching by a deciding step with a gate that the decision is
recorded; one YAML file a workflow under `$MT_HOME/workflows`, named in the role grammar; a step's
fields as a task's, with `parents` and `for_each`, an unknown key an error; params as text or lists,
required or with a default, an unknown one refused; `{{name}}` and `{{item}}` in text fields only,
names checked as names, and never in gates; a for_each fan-in on every task, all to all between two
for_each steps, an empty list refused; the checks, by `mt workflow check` and at startup, a broken
workflow not stopping the gateway; starting from chat at operator tier, from the terminal and from a
run, with the run's tasks created from its task; one failure refusing the whole start, at most 100
tasks, one transaction, the dispatcher told once; the board by path; keys as tasks'; the starting
chat following every task, in one reply with a line a task, in plan L's thread; the file read at the
start and a copy stored; `list`, `instances`, `show` and `archive`; status derived; nothing
automatic on failure; changes after the start through the task commands alone. The main agent
decided, where the code forced it: the worker's start as a ninth command, `mt kanban
start-workflow`, with JSON on stdin, as the grammar of kanban spec §7.3 refuses a group in a run's
shell and a worker's command takes no arguments; a step's fields as `KanbanService.create`'s, which
the commands' `task new` does not all take, with gates as `addGate`'s; `assignee` and `reviewer` as
text or `{ role }` / `{ person }`; a members table, not columns on `kanban_tasks`, so the kernel's
table stays as it was; no instance event, as an event belongs to a task, and each task's own
`created` kept, with the instance in its payload; the instance's key alone, its tasks keyless; the
reply cut to 30 lines and under 3,800 characters, as Lark takes 4,000 in one message; subscriptions
written per task by `subscribe()`, and moved into the thread together by `threadSubscriptions`,
every member held meanwhile; the workspace check of a step whose parents certainly disagree; params
masked on write, names refused if they hold a secret, the copy stored unmasked and shown masked; the
`yaml` parser and `section`/`reject` helpers the role files use; the file read at each start, the
startup check only reporting, and `mt service check` warning; and done counting an archived member
as finished. *Amended on 2026-11-13.* A first review kept the worker's `start-workflow` and the
step's fields as `create`'s with `addGate`'s gates, which the user approved, and found: that a
repeat could be refused by a file changed since, so the key is looked up first, read-only, the
writer's lookup kept as the race guard, and a key reused for another workflow refused; that an
@-mention with a space could not be parsed, so the parser is given the message's mention names and
returns `{ key, value, quoted }`, and `@` is resolved only for a person field; that the params had
no total bound against the socket's 256 KiB, so 64 KiB; that kanban spec §7.1, §7.3, §2.6's operator
block and its "Who reads it" did not name the new commands; an unmigrated database; the reply's two
wordings; the link bound, 4,950; a gate's default timeout in the 600 s; `mt workflow check`'s `.env`
and secrets; the characters a title refuses; the payload's `workflow` as the instance's id, the name
apart; items holding a secret; `task show` as the members table's other reader; an index on
`created_from_task` and the 200 instances `instances` reads; `unknown_workflow`'s size; the
terminal's answer, `show` on another board, the pair's first `=`, a stray word's hint; and a table
of a start's refusals. *Amended on 2026-11-16.* The user chose to split a start into a render, which
makes the file into a checkable DAG and writes nothing, and an apply, which makes exactly a DAG,
with start kept as the two in one step: `mt kanban workflow render`, `check-dag`, `apply` and
`start` at the terminal; `/kanban workflow preview` and `start` in chat, with no apply there; for
agents `start-workflow` as before and a new `apply-dag`, for a DAG of the agent's own, with no
gates; a versioned DAG format, its `workflow` name or null, its params and board, and tasks with
unique refs, their fields and parents as refs; an apply that checks everything again, so what
changed since the render is refused then; keys as before; the applied DAG stored in place of the
file's copy, the name kept, `show --dag`, and "(no workflow)" for a DAG with none; gates only from
the terminal or a render of the operator's file, never from an agent's DAG and never substituted.
The main agent decided: refs of a for_each task as `<step>:<n>`, the item in its own field, as an
item is free text; parents only earlier in the array, so the refs are a DAG by construction and the
writer's order is the array's; parents only within the DAG; nothing in a DAG substituted, a `{{`
plain text; 192 KiB for a whole DAG, below the socket's 256 KiB with room for the envelope, on every
path; render opening no database, the board, the key and the people being apply's; render's output
deterministic and masked; check-dag against the database, writing nothing; `apply-dag`'s key beside
the DAG's keys, its `workflow` required null and its board its task's; a repeated apply told from
another by the DAG's SHA-256, kept on the instance; the stored DAG masked on write but for its
gates, with no `params` column; `ref` on each member and in the events; preview at talk tier, making
nothing; and no `render-workflow` for agents, as what it rendered could not be applied. *Amended on
2026-11-16, again.* The user approved new verbs, the same in chat and at the terminal: `preview` to
see what a start would make, printing one summary in both and, at the terminal with `--json`, the
DAG file; `start` to make it in one step; `apply` to make a DAG from a file, and `apply --dry-run`
to check one and make nothing. `render` and `check-dag` are gone, `preview` and `apply --dry-run`
doing their work. The word "plan" was avoided: the planner role and the guide's Recipe 3 already use
it for an agent that breaks work into tasks, and terraform's `plan` is a diff against existing
state, where a DAG is made from nothing. A chat apply of a saved draft is left for later. The main
agent added `dry_run` to `apply-dag`, as one flag on a path the terminal has anyway. A third review
then found: that the DAG's hash had no defined input, so one canonical form is measured and hashed
on every path, unmasked, untouched by reindenting; that 192 KiB belongs only to `apply-dag`, which
crosses the socket, a start and a terminal apply having 1 MiB, and that text not in UTF-8 is refused
rather than replaced; that a run's DAG could set the priority, the failure breaker and the runtime
limit its `create` cannot, so they are refused, and its `workflow` and `params` too; that `show
--dag` printed masked text whose gates `apply` would run broken, so a gate holding the mask is
refused, and `--dag` is the terminal's; that preview must load its configuration as `openBoard`
does; the stored DAG holding the params; refs unique in the members table; what the transaction
checks again and what is checked just before it; the hash never printed; a key passing between a
start and an apply refused, by the instance's `source`; and each gate's command in a dry run's
answer. *Amended on 2026-11-16, a third time.* A fourth review found: that an apply looked its key
up before it had a DAG to hash, so an apply reads, decodes, parses, checks the shape of and makes
canonical its DAG first, refusing an unknown key before any `existing` answer, a start keeping its
order; that the strict UTF-8 needed bytes, so `readAll` returns them and every worker command
decodes them strictly, with raw caps of 4 MiB at the terminal and the socket's 256 KiB for
`apply-dag`, and that the DAG crosses the socket as an object, so its room is the envelope's; that
the terminal's preview had no service to check tasks with, so `create`'s per-task checks move into a
pure `taskProblems`; each task key's default, `body` as `null` and a contract field not set omitted,
so a default deleted never changes the hash, and the params by code point; lone surrogates; the
mask's refusal by the file's check, a start and an apply, `gate add` unchanged; no key check in
chat's preview; and the 192 KiB and 1 MiB in plan T's row and the limits. *Amended on 2026-11-16, a
fourth time.* A fifth review approved the section, and its minor points were folded in: `MtIo.stdin`
returning bytes, with the test fakes named; a BOM refused, through `ignoreBOM`; the socket decoding
strictly; `ES2024.String` for `isWellFormed`; `taskProblems`'s order, `#idempotencyKey` staying in
the service, and the pure `assignable` shared by every caller; no isolated workspaces among the
facts; and a DAG's param names held to the param grammar. *Amended on 2026-11-16, a fifth time.* The
plan's review was folded in. The user chose to skip a dot-entry in the workflows directory silently,
as `discoverRoles` does, a badly named file, an entry that is not a regular `.yaml` file and a
symlink still reported. The reviewer accepted the plan's reading that a step is written below its
parents, a parent written after its child refused by the check, now in §4.

## 18. From a terminal: chats and people

The kanban spec's §22 gives the terminal's `mt kanban task new` a chat that follows its task and a
person by principal. A workflow started or applied at a terminal needs both more: an instance of
many tasks that no chat follows is heard by nobody, and a workflow whose reviewer is a person could
not be started from a script at all, which is why the cookbook's weekly workflow names a role.
Built by plan V (kanban spec §12). This section amends §6 (the terminal's flags, who may, the
refusals) and §9 (who hears, and the reply).

### 18.1 `--chat` on start and apply

```
mt kanban workflow start <name> [--board <name>] [--param k=v]… [--key <k>] --chat oc_… [--thread omt_…]
mt kanban workflow apply <dag.json|-> [--key <k>] [--dry-run] --chat oc_… [--thread omt_…]
```

- **Checked as `task new`'s** (kanban spec §22.1): the chat's shape, `mt cron add --chat`'s; this
  bot's app id from the settings, refused without one in cron's words; a chat outside a non-empty
  `auth.chats` refused, in the same words as there; a thread's shape, only with `--chat`, and its
  root by `threadRootOf`, a thread with no root known refused. The shapes are
  checked before the board is opened, the root once it is.
- **Every member follows the chat**: the writer's `applyDag` gives each task's insert the
  instance's `follow`, which `subscribe()` writes, in the one transaction (§8), as a chat start's
  every task is subscribed to its chat (§9). A task still has at most one subscription per bot:
  a terminal's task has no other.
- **Not a key of the DAG.** Where an instance is heard is the caller's, not part of what is made:
  one DAG file, kept beside a script, may be applied by different callers to different chats, and
  its hash (§5), which tells a repeat from another DAG, must not change with where it is heard. So
  `NewInstance` gains `follow` beside `createdVia`, and a DAG with a `chat` key is refused as any
  unknown key is (§5).
- **`apply --dry-run`** takes both flags, makes the same checks, writes nothing, and its answer
  adds who would follow. **`preview`** takes neither, a usage error, "--chat is start's and apply's:
  a preview makes nothing to follow".
- **A repeat by key** is answered at step 0 (§6), `existing: true`, before the flags are looked at:
  no subscription is added and no reply posted, whatever `--chat` names now, as a repeat makes
  nothing. Its answer's `follows` is what the instance was made with, read from its first member's
  stored subscription of this bot, or `null` with none, never the flag given now.
- **The terminal only.** `startWorkflow` and `applyDag` refuse `follow` unless `createdVia` is
  `{kind: operator}`, `invalid`; the worker's `start-workflow` schema and `apply-dag`'s DAG have no
  such field. A run's start is followed by its task's chats already (§9).
- **No thread is opened, and nothing is held.** A chat start in a group at chat scope is answered
  in a thread on its command, and its members are held until their subscriptions move there (§9).
  A terminal sends no message to open a thread on, and its subscriptions are written where they
  stay, so there is no move to wait for.

### 18.2 The start's reply, posted by the notifier

*A decision.* The terminal has no Lark client, so it cannot send the reply itself. Two ways were
open: the reply queued in the database for the gateway to send, as a notice, or the subscription
alone written, the chat's first message being the gateway's first notice. **The reply is queued,
as an event of the instance's first member**, for these reasons:

- **The chat must be told what it follows.** With the subscription alone, the chat first hears of
  the instance when one task is done, maybe hours later, as one task's line with no instance id to
  `show`, and a 100-task instance's notices arrive with nothing to tie them together. The reply
  names the instance and every task, as a chat start's does; the approved design asks for it.
- **The events and the notifier are already an outbox**, with all an outbox needs: at least once,
  from a cursor written in the gateway's own transaction; a batch's uuid from its (subscription,
  event) pairs, so a resend after a restart shows once; a chat that cannot be reached let go of and
  said once; the catch-up after an outage (kanban spec §9.4). A table of its own would need a
  writer, a sender beside the notifier's, and each of those rules again, for one message an
  instance.
- **The text cannot be made at the terminal.** A member's id is made inside the writer's
  transaction (`newTaskId`, in `insertTask`), so a complete reply exists only there; and rendered
  at the send, it is masked and worded as every notice is. So the event holds the facts, and the
  notifier makes the text.

**How.** When the instance has a `follow`, `applyDag` writes one more event in its transaction,
after the member rows: **`workflow_started`, on the member at position 0**, its actor the
instance's creator, its payload `workflow` (the instance's id), `workflowName`, `board`, `by` (who
started it), `count` (its members), `people` (whether any member names a person as assignee or
reviewer), and `tasks`, the first 30 members in position order, each `taskId`, `title`, `assignee`
(its name, or null) and `assigneeKind` (`role`, `human`, or null), flat as a task row keeps them:
the reply lists at most 30 (§9), so the payload holds no more, at most about 20 KiB. It is masked on write as every payload is, `workflow` and `workflowName`
being in `BOARD_KEYS` already (§8). An event belongs to a task (§7), and the first member's one
subscription is the `follow`, so the event reaches exactly the chat named, once.

**The notifier renders it** with `renderStarted` (`src/kanban/chat-render.ts`), the chat start's
own renderer, from the payload alone: it never reads the workflow tables, so the kernel's seam
(§0) holds, the notifier reading one event of a task as it reads any. Its words are the thread's
when the subscription it goes to is in a thread with a root, else the chat's (§9). Its first line
names who started it, as nobody in the chat typed it: "operator:alice started vendor-eval from a
terminal as `w_…`, 5 tasks:". It is held to the reply's own bounds, 30 lines and under 3,800
characters (§9), and it is **never cut**: the notifier takes a batch's first notice whole, its
`BATCH_CHARS` bounding only the notices added after it, so the reply goes as one message or with
the notices that fit beside it, never split. It comes before any notice of its members, as its
event is written before the dispatcher is told (§6 step 4). With `kanban.enabled` off no notifier
runs, so the reply waits, as the tasks do, until the board is on; the terminal's answer already
says it is off. A workflow's members get no `task_created_followed` (kanban spec §22.1): this reply
names them all.

**The terminal's answer** adds `chat oc_… follows its tasks, and is sent this reply` (`, in thread
omt_…`), and `--json` adds `"follows": {"chat", "thread"}`, null without `--chat`; for a repeat,
the stored subscription (§18.1).

### 18.3 A person from the terminal

- **`lark:<union_id>` is taken at the terminal** wherever a person may go: a param that lands in a
  person field (`--param owner=lark:on_…`, §2), a person the file writes, and a DAG's `assignee` or
  `reviewer` (§5). Each is checked at step 2 (§6) by `checkDagTasks` (`src/kanban/dag.ts`) with the
  service's facts, whose talk check plan V gives the terminal's service (kanban spec §22.2): known
  in `people` for this bot's app, and at talk tier by the open_id last seen. The `terminal` rule in
  `checkDagTasks` that refused every person there goes.
- **A refusal** is `person_not_assignable` in chat's words, naming the ref, step and item as any
  task's refusal does (§6), and the terminal adds the hint that `mt kanban people` lists the people
  this gateway knows.
- **No @-mentions at the terminal.** A value starting with `@` in a param that lands in a person
  field is refused `invalid` at the terminal, with the hint, "there are no @-mentions at the
  terminal: a person is lark:<union_id>, which mt kanban people lists"; one that lands only in text
  is text, as typed, as in chat (§6). **A run's `start-workflow` keeps today's refusal**,
  `person_not_assignable`, "… is a person: give a person work from chat, by @-mention, where the
  gateway can check they have talk tier": an agent has no `mt kanban people`, and its refusal is
  unchanged. The branch is on the start's `createdVia`, where `paramValues` (`src/kanban/workflow.ts`)
  refuses an `@` with no `personOf` today: `{kind: operator}` gets the terminal's `invalid` and
  hint, `{kind: run}` the existing refusal. The expansion is given the start's `createdVia` kind for
  this, beside its `GivenParams`, whose `from: 'terminal'` and `from: 'json'` say the same today but
  would not if a path were added.
- **The preview does not check a person.** It opens no database (§6), and `people` is in the
  database, as the board and the key are, which a preview already leaves to `apply --dry-run` and
  `apply`. So a person in the grammar passes the preview's checks: **only the preview's facts** get
  `canTalk: () => true`, built in the preview's own function in `src/cli/operator.ts`; a start and
  an apply, `--dry-run` included, always check with the service's facts, whose talk check is the
  `PeopleDirectory`'s, or absent, refusing every person. The preview says on stderr,
  for each: "lark:… is checked at the start, against the people this gateway knows; mt kanban
  workflow apply --dry-run checks it now". Opening the database for this one read would make the
  preview's rule "no database, unless", for a check the start makes anyway.
- **Cards** go as for any task (kanban spec §22.2): a member followed in a thread with a root may
  get its person's card there (kanban spec §19.2).

### 18.4 The cases

- **A start from a cron script with `--chat` and `--key`, run twice in a week**: one instance, each
  member followed once, one reply; the second start answers `existing: true`.
- **The gateway down at the start**: the reply is posted when it comes back, in the notifier's
  catch-up, before its members' notices.
- **The first member archived before the reply is sent**: the reply is sent, as an archived task's
  pending notices are.
- **A chat the bot is not in**: the instance is made; the notifier lets the conversation go (kanban
  spec §9.4).
- **A person who loses talk tier between `apply --dry-run` and `apply`**: refused at the apply, as
  §14 says for chat.
- **A DAG naming a person, previewed and applied**: the preview notes the person unchecked; the
  apply checks them.

### 18.5 Wiring

- **`src/cli/operator.ts`**: `--chat` and `--thread` on `start` and `apply`, refused on `preview`,
  `auth.chats` checked; `follow` passed; the answer's `follows`, the stored subscription for a
  repeat; the preview's facts accepting a person in the grammar,
  with its stderr line; an `@` person refused with the hint, and the hint on `person_not_assignable`.
- **`src/kanban/service.ts`**: `StartRequest.follow` and the apply request's, refused unless from
  the operator; the dry run's answer saying who would follow.
- **`src/db/kanban.ts`**: `applyDag` giving each member's insert the `follow`, and writing
  `workflow_started` on the first member.
- **`src/kanban/dag.ts`**: the terminal's refusal of every person removed. **`src/kanban/workflow.ts`**:
  the `@` refusal branching on the start's `createdVia`.
- **`src/kanban/chat-render.ts`**: `renderStarted` given who started it, and the payload's task
  shape, which the chat's reply builds from its rows; `renderNotice` rendering `workflow_started`.
  **`src/kanban/notices.ts`**: the subscription's thread and root passed to the
  renderer, for the words.
- **`docs/examples.md`**: example 6's script passes `--chat oc_xxx` to `mt kanban workflow start`,
  its prompt no longer asks the agent to post the instance, which the reply does, and its reviewer
  may be a person, `--param reviewer=lark:on_…`; "a workflow started from a terminal is followed by
  no chat" becomes what `--chat` changes.

### 18.6 Testing

- **`--chat`**: every member's subscription in the apply's transaction, at chat scope and in a
  thread with its root; a thread with none refused; a malformed chat or thread and no app id refused
  before the board is opened; a chat outside a non-empty `auth.chats` refused; a repeat's `follows`
  the stored subscription, or `null`; `preview --chat` a usage error; `apply --dry-run --chat` writing
  nothing and saying who would follow; a repeat by key adding no subscription and no second event;
  `follow` refused by the service from chat and from a run; a DAG with a `chat` key refused.
- **The reply**: one `workflow_started` on the first member, with the payload's keys, 30 tasks of
  100, masked; none without `--chat`, none for a chat's start or a run's; the notifier sending it
  once and never cut, in the chat's words at chat scope and the thread's in a thread, under 3,800
  characters for 100 tasks of 512-byte titles, before a member's first notice; no
  `task_created_followed` on any member; resent after a restart with the
  same uuid; the notifier reading no workflow table to render it.
- **People**: a person in a param, the file and a DAG accepted with talk tier and refused without,
  naming the ref, with the hint; `@` in a person field refused `invalid` with the hint at the
  terminal and `person_not_assignable` from a run, in a text field kept; the preview
  accepting a person with its stderr line, and `apply --dry-run` refusing one without talk tier.

### 18.7 Limits

- **No thread opened from a terminal**, no hold, and no thread followed whose root the board does
  not know (kanban spec §22.1).
- **No reply for a repeat by key**, and no second chat for an instance once made.
- **The preview leaves people unchecked**, as it leaves the board and the key.
- **No `--chat` for an agent's start or DAG**: a run's are followed by its task's chats.

*Added on 2026-11-17.* The user chose, with the kanban spec's §22: `--chat oc_… [--thread omt_…]`
on `mt kanban workflow start` and `apply`, every member following the chat, the start's reply
posted there; `lark:<union_id>` at the terminal in params and an applied DAG, checked as chat
checks one, with no @-mentions; and cron example 6 passing `--chat`. The main agent decided: the
reply queued as a `workflow_started` event on the first member, which the notifier renders with
the chat start's renderer from the payload alone, rather than the subscription alone, as the chat
must be told what it follows, the events and the notifier already deliver at least once, and the
ids exist only inside the writer's transaction; the payload's first 30 tasks, as the reply lists
30; the first line naming who started it; `follow` beside the DAG, not in it, so its hash is the
same wherever it is heard; `--dry-run` checking the flags and `preview` refusing them; a repeat
adding nothing; the service refusing `follow` from anyone but the operator; no hold, as nothing
moves; and the preview leaving people unchecked, with a line on stderr, as it opens no database.
*Amended on 2026-11-17.* With the kanban spec's §22, after the first review and three decisions of
the user's: (A) a person at the terminal's `task assign` too, which leaves this section as it was;
(B) a terminal's `task new --chat` posting a "Created" line by its own `task_created_followed`
event, which a workflow's members never get, their reply naming them; (C) a chat outside a
non-empty `auth.chats` refused for `start` and `apply` (§18.1). The review also found, and this
revision takes: a repeat's `follows` the stored subscription; the payload's tasks flat, `assignee`
and `assigneeKind`; the reply never cut, not "at most 3,800" by the batch; no `task show` history,
which does not exist, so its line and its wiring go, and §8's reason no longer names one; the `@`
refusal branching on `createdVia`, a run's keeping `person_not_assignable`; and only the
preview's facts accepting every person.
