# Workflow routing: conditions, result-driven fan-out, and handlers for blocked and failed steps

This document extends the workflows spec, [`2026-11-16-workflows-design.md`](2026-11-16-workflows-design.md),
which it cites as "workflows spec §n", and builds on the kanban spec,
[`2026-11-02-kanban-design.md`](2026-11-02-kanban-design.md), cited as "kanban spec §n", and the wake
spec, [`2026-11-19-wake-design.md`](2026-11-19-wake-design.md), cited as "wake spec §n". Where this
document and the kanban spec disagree, the kanban spec wins and this document is a bug; where it and
the workflows spec disagree, this document amends the workflows spec, and says so at the place. As
there, every rule that looks arbitrary states the mechanism that forces it.

The user approved the design section by section on 2026-11-26: approach A, lazy materialization;
the file format; accepted results and settling; the runtime; what people see; errors and limits; and
the tests. This document grounds it in the code at `e38206f` and resolves what the code forces. What
could not be built as approved is written in its closest faithful form and listed in §21.

---

## 0. What routing adds

The workflows spec makes a workflow a fixed graph (workflows spec §0): every step becomes tasks at
the start, and a branch is a deciding step's work. A team that runs the vi assessment keeps six
files today, `vi-workflow`, `-verify`, `-patch`, `-verify-patch`, `vi-supplychain` and
`-supplychain-bnpm`, which differ in which steps exist, and an operator chooses the file before the
intake has looked at the case. Routing lets one file say what the intake's result decides:

- **`outputs`**: a step declares the facts its run reports, typed, in its completion's metadata
  (§2). A completion missing one, or with the wrong type, is refused, and the run fixes it in the
  same run.
- **`when`**: a step is made only if clauses on its ancestors' accepted outputs, or on their
  lifecycle states, hold (§3); otherwise it is **skipped**, and a skipped step counts as settled for
  its children.
- **`for_each: { step, output }`**: one task per item of an ancestor's accepted list output (§4),
  the children joining on every item.
- **`on_blocked` and `on_gave_up`**: a step that blocks or gives up either waits, as today, or is
  routed to a **handler** step (§5), which is made for that transition, helps, or stands in for the
  step it was routed from.

**Approach A, lazy materialization.** At the start, in the existing single transaction (workflows
spec §8), the plain steps become tasks and links, as today. Every other step becomes a row of
`kanban_workflow_pending` (§8), `waiting`. The instance keeps its **plan**, frozen: each step's
`when`, `for_each`, `outputs`, routes and template (§7). When a member settles, blocks or gives up,
the writer's transaction that records it calls a pure `decide(plan, facts)` (§10), and makes,
skips, fans out or routes what is now due, in the same transaction (§9). **Editing the file never
changes a running instance**, and **a workflow using none of the new keys expands exactly as now**:
no plan, no pending row, the same DAG, the same hash.

**Nothing in the kernel learns about workflows** (workflows spec §0). The dispatcher, the claim, the
prompt and the waker read no workflow table; a task made late is an ordinary task, claimed,
reported, woken and archived as any other. The writer, `db/kanban.ts`, already writes the workflow
tables (workflows spec §8); it now also reads them inside the transitions that settle, block or
give up a task (§9). The notifier renders one new event from its payload alone, as it renders
`workflow_started` (workflows spec §18.2). *This amends workflows spec §0*, where the writer's
transitions read no workflow table.

## 1. The file

The vi assessment, folded into one file (bodies and contracts cut here; §18 runs it whole):

```yaml
description: CVE or supply-chain assessment, routed by its intake
board: vi
params:
  case: { required: true, description: a CVE id, or the absolute path of a package CSV }
steps:
  intake:
    title: "{{case}} · intake"
    assignee: vi-coordinator
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
      patch: boolean
      bnpm: boolean
      packages: { list: string, max: 100 }
  va:
    title: "{{case}} · va"
    assignee: vulnerability-analyst
    parents: [intake]
    when:
      - { step: intake, output: kind, equals: cve }
    on_gave_up: { route: escalate }
    outputs:
      reachable: boolean
  escalate:
    title: "{{case}} · va, escalated"
    assignee: vi-coordinator
    handler: true
    stands_in_for: va
    outputs:
      reachable: boolean
  verify:
    title: "{{case}} · verify"
    assignee: verifier
    parents: [va]
    when:
      - { step: intake, output: verify, is: true }
      - { step: va, output: reachable, is: true }
  exposure:
    title: "{{case}} · exposure of {{item}}"
    assignee: exposure-analyst
    parents: [va]
    for_each: { step: intake, output: packages }
  registry:
    title: "{{case}} · registry"
    assignee: registry-analyst
    parents: [intake]
    when:
      - { step: intake, output: bnpm, is: true }
  report:
    title: "{{case}} · report"
    assignee: report-author
    reviewer: { role: assessment-reviewer }
    parents: [va, verify, exposure, registry]
  patch:
    title: "{{case}} · patch"
    assignee: patch-author
    parents: [report]
    when:
      - { step: intake, output: patch, is: true }
```

**The new step keys**, beside workflows spec §1's, each checked as the others are, an unknown key
an error naming its place (`steps.va.on_gave_up.rout`):

| Key | |
|---|---|
| `outputs` | a mapping of output names, in the param grammar (workflows spec §1), to their types (§2) |
| `when` | a list of clauses, every one of which must hold, and at most one `{ any: [clause, …] }` among them, at least one of whose clauses must hold (§3) |
| `for_each` | a list param's name, as today, **or** `{ step: <ancestor>, output: <its list output> }` (§4) |
| `on_blocked`, `on_gave_up` | `wait`, the default, or `{ route: <handler step> }` (§5) |
| `handler` | `true` for a step made only when routed to (§5); default `false` |
| `stands_in_for` | on a handler only: the step whose dependents its accepted completion settles (§5) |

**The two `for_each` forms are told apart by their YAML type.** Text is a list param's name, as
today, read by today's code unchanged; a mapping with exactly `step` and `output` is a result's.
Anything else is `steps.<s>.for_each is a list param's name, or { step, output } naming an
ancestor's list output`. A param can never be confused with a step: a param fan-out is text, and a
result fan-out is always a mapping, so `for_each: intake` is the param `intake` or a check error.

**References to results in text.** A step made late may write `{{step.output}}` in its `title` and
`body`, naming an ancestor's declared output, filled in when the step is made (§7). Nowhere else:
not in the contract fields, not in a name field, never in a gate (§14). `{{item}}` in a result
fan-out step is its item, as in a param fan-out. The reference grammar of workflows spec §2 grows by
one form, `{{<step>.<output>}}`, both in the name grammar, with no spaces.

## 2. Outputs, and accepted results

### 2.1 The types

```yaml
outputs:
  reachable: boolean                     # true or false
  score: number                          # a finite JSON number
  note: string                           # text, at most 8 KiB
  kind: { enum: [cve, supplychain] }     # one of the values, as text
  packages: { list: string, max: 50 }    # a list of at most max items; max from 1 to 100
```

- **`boolean`, `number`, `string`** are written as the bare word; **`enum`** as `{ enum: [values] }`,
  1 to 50 values, each text of 1 to 256 bytes on one line, none twice; **`list`** as `{ list: <type>,
  max: <n> }`, its type `boolean`, `number`, `string` or `{ enum: […] }`, `max` a whole number from 1
  to 100, required: a list's length is what a fan-out over it makes (§4), and its bound is what lets
  the check refuse a file that could make more than an instance holds.
- **Every declared output is required.** There is no optional output: a clause on a value a run may
  leave out would be true or false by accident. A run with nothing to report says so in the value,
  an empty list, `false`, or an enum value the file gives for it.
- **Where they are reported.** Each output is a **top-level key of the report's `metadata`**, by
  its name: `{"summary": "…", "metadata": {"reachable": false}}`. Other keys of the metadata stay
  free, as today (kanban spec §7.3). The metadata's own bounds are unchanged
  (`WORKER_LIMITS.metadata`, 16 KiB serialized, 64 deep), so outputs share them.
- **The agent is told.** The expansion adds one sentence to a step's `outcome` contract field when
  the step declares outputs: `Report in the metadata of your completion: reachable (true or false);
  packages (a list of at most 50 texts).` The prompt (kanban spec §7.1) renders the contract as it
  does today and reads no workflow table, so the seam holds; `mt kanban show` shows it in `contract`.
  The field's 8 KiB is checked after the sentence is added, by `workflow check` and at every start.
- **A step with outputs is a role's.** A person's done carries no metadata (`/kanban task done`
  takes a summary alone, `chat.ts`), so `workflow check` refuses `outputs` on a step whose assignee
  is written as a person, `lark:…` or `{ person: … }`, and a start refuses one whose assignee param
  names a person, naming the step: `steps.va declares outputs, which a role's run reports in its
  metadata, and its assignee is a person: a person's done gives none`.

### 2.2 The check at completion

A run's completion whose metadata misses a declared output, or holds one of the wrong type, is
**refused**, the run left undecided, so the agent fixes the metadata and reports again in the same
run, as after a failing gate (kanban spec §7.7).

- **Where it sits.** In `KanbanService.complete` and `KanbanService.requestReview`
  (`src/kanban/service.ts`), after `handoffRefused` and **before `#report`**, so a report refused for
  its outputs runs no gate. It reads the task's member row (`memberOf`), its instance's plan, and
  the step's outputs: one indexed read for any task, and nothing more for a task that is no member or
  whose instance has no plan. The worker's `complete` and `review` commands (`src/kanban/worker.ts`)
  reach it unchanged, as both call the service; their schemas already carry `metadata`.
- **Which reports.** A **work** report: `complete` on a task in `open`, whether it then goes to
  `done` or, naming a reviewer, to `review` (kanban spec §5.3), and `review`. Not a reviewer's
  `complete` on a task in `review`: an approval hands off the work run's metadata, already checked
  when the work asked for review (`latestCompletion`, `src/db/kanban-read.ts`). A person's work
  report on a member whose step declares outputs, which only an assignment after the start can make
  (§2.1), is refused with the same check: it carries no metadata.
- **The code is `invalid`**, as for every malformed input a run can correct, and the message names
  the output. The worker answers `{"ok": false, "code": "invalid", "message": "…"}`, exit 1, as for
  any refusal (`src/cli/kanban.ts`). The messages:
  - `output reachable is missing`
  - `output reachable must be true or false; got "yes"`
  - `output score must be a number; got "7"`
  - `output note must be text; got 3`; `output note is 9120 bytes; at most 8192`
  - `output kind must be one of cve, supplychain; got "library"`
  - `output packages must be a list of at most 50 strings; got 63` (and `… got a string`, for one
    that is no list); `item 4 of output packages must be text; got 7`
  - for a list that a fan-out reads (§4): `item 2 of output packages is empty`, `output packages
    names "lodash" twice; each item labels its task`, `an item of output packages holds a known
    secret`, and, when `{{item}}` lands in a title, `item 5 of output packages holds a line break, a
    control character or a bidi control, and an item lands in a title`;
  - a string output a later title reads by `{{step.output}}` is held to the same line rule.
  - The instance's bound (§19) is `too_large`: `output packages would make 63 tasks, and instance
    w_… has 470 of its 500`.
  Each is said once, the first found, in the outputs' declared order; a value is quoted masked and
  cut at 80 characters, as `shown` quotes one (`src/kanban/dag.ts`).
- **The writer checks the bound again.** Two reports may pass the check at once; the transaction
  that decides (§9) counts the members again, and a completion that would pass 500 is refused there,
  `too_large`, rolled back, the run undecided, as the gates' bounds are checked again in `applyDag`.

### 2.3 Accepted results

**An accepted result is the metadata of the work run whose report took the task to `done`**, read
by `latestCompletion`, which already gives a reviewed task's children the implementer's handoff and
not the reviewer's approval (kanban spec §4.4). Mapped to the code:

| The task's history | Its accepted result |
|---|---|
| a work run's `complete`, no reviewer | that run's `metadata` (`decide(…, 'completed', handoff)`) |
| a work run's `complete` or `review`, then the reviewer's `complete` | the metadata of the work run behind the latest `review_requested` event |
| an operator's `approve`, taking a role reviewer's review (kanban spec §5.1) | the same: the review run ends `superseded`, and the handoff is the latest review request's |
| `changes` after a review | none from that request: the task is `open` again, and the next request's run is the one read once it is approved |
| not `done` | none |

**A result from a run whose review asked for changes never counts**: `latestCompletion` reads the
latest `review_requested`, which is the rework's once it asks again, and a task in `open` has no
accepted result at all, as only a `done` task is read. A value that is not of its type when read,
which only a database edited by hand can hold, reads as missing: a clause on it is false (§3).
The metadata is stored masked (`maskDeep`), so what decides is the masked value; a value holding a
known secret differs from the one reported, and an item holding one was refused at the completion.

## 3. Conditions

```yaml
when:
  - { step: intake, output: kind, equals: cve }          # equals: a string, enum value, number or boolean
  - { step: intake, output: kind, in: [cve, ghsa] }      # in: a list of such values
  - { step: va, output: reachable, is: true }            # is: true or false, on a boolean
  - { step: va, output: score, at_least: 7 }             # at_least, at_most: on a number
  - { step: va, state: gave_up }                         # state: done, skipped, gave_up or blocked
  - any:
      - { step: va, output: score, at_least: 9 }
      - { step: intake, output: kind, equals: ghsa }
```

- **A clause names one ancestor of the step**, by `step`, transitively through `parents` (workflows
  spec §1), and either one of its declared outputs with one test, or its `state`. Nothing else: no
  expressions, no arithmetic, no reference to a param, which the start already knows and the file
  can branch on by having two files.
- **All clauses must hold**, and of an `any` group, at least one. One `any` at most, as approved:
  two would be an `and` of `or`s, which a reader of the file has to work out.
- **A clause on a skipped step's output is false, not an error** (§3.2). So is a clause on a stood-in
  step's output when the stand-in gave none, which cannot happen, as a handler that stands in must
  declare the same outputs (§5).
- **No clause reads a fan-out step.** A fan-out step has one result an item; which one a clause
  would read is undefined, so `workflow check` refuses an output or `state` clause naming one
  (§19).

### 3.1 States

A step's **state**, as a clause reads it, is the phase of its tasks plus how they got there:

| State | When it is true |
|---|---|
| `done` | the step is settled by its task's accepted completion, or by a stand-in's (§5) |
| `skipped` | the step was skipped (§3.2), or its task was archived before it was done |
| `blocked` | its task entered `blocked` by a run's block, or by a run's end that blocks it, of a kind but `gave_up` (§5.1) |
| `gave_up` | its task entered `blocked` as `gave_up`, by the breaker (kanban spec §8.2) |

`archived` is not a state a clause names: **archiving a waiting step's parent counts as
settled-skipped for its children**, so an archived task reads as `skipped`, and a clause on its
output is false. *A decision, forced by the code:* an archived task that was done before it was
archived keeps its phase `archived` and its `closed_at`, and is read as `skipped` too, as `isFinished`
treats both alike and the kernel keeps no "was done" bit a clause could read without reading events.

### 3.2 When a clause is decided, and when a step is

- **A clause is decided** once its ancestor is **settled**: `done`, `skipped`, or stood in for by a
  done handler (§5). Then an output clause is true or false by the accepted result, and a `state:
  done` or `state: skipped` clause by how it settled.
- **A `state: blocked` or `state: gave_up` clause is decided at the transition**: true the moment
  the ancestor's task enters that state, false once the ancestor settles without having entered it.
  *A decision, forced by the design:* a blocked or gave-up step is unsettled (§4.2), so a clause on
  it decided only at settling could never be true. It reads "the step blocked on the way", the
  approved "how it got there".
- **A step is skipped as soon as its `when` is certainly false**: a clause false, or an `any` group
  every clause of which is false. It waits for nothing more, as nothing can make it true.
- **A step is made once its `when` is certainly true and every parent step is settled**, a fan-out
  parent by every item (§4.2). It is made then with links to its parents' tasks, which are all done,
  archived or stood in for, so it is claimable at once (kanban spec §4.1). **A parent read by a true
  `blocked` or `gave_up` clause is not waited for and not linked**: the step was made because that
  parent is stuck, and a link would hold it behind the parent.
- **A step with no `when`** among the pending steps (one that is pending because a parent is, §7)
  is made once every parent is settled. **If every parent was skipped, it is still made**, with no
  link to them: a skipped step counts as settled for its children, as an archived parent does in
  the kernel (kanban spec §4.1). So `report` above is made after `verify` is skipped and `exposure`
  is settled, with `verify` no parent of it.
- **Decided once.** Each pending step is decided exactly once (§9), and never again: a step made
  stays made when an ancestor is later archived, and a step skipped stays skipped when a task it
  read is later unblocked and done.

## 4. Result-driven fan-out and the join

### 4.1 The fan-out

`for_each: { step: intake, output: packages }` makes one task per item of `intake`'s accepted
`packages`, in the list's order, each with `{{item}}` set to its item, as a param fan-out does
(workflows spec §3).

- **When.** Only once the named step is `done`, its review included (kanban spec §5.3), and from its
  accepted result (§2.3); and as any pending step, once its `when` holds and its parents are
  settled (§3.2). A stood-in source is read through its stand-in's result (§5.2).
- **The source is an ancestor, and its output a list.** `workflow check` refuses a non-ancestor, an
  undeclared output, and an output of another type (§6).
- **The items** are the list's values, texts as given, numbers and booleans as JSON writes them,
  each trimmed, none empty or twice, none holding a known secret, and, when `{{item}}` lands in a
  title, none holding a line break, control character or bidi control: the same rules as a list
  param's items (workflows spec §3), checked at the completion that reports the list (§2.2), not at
  the fan-out, which must never be refused (§9).
- **An empty list skips the step**, its pending row `skipped` with the reason `intake.packages is
  empty`; its children read it as skipped (§3.2). *This amends workflows spec §3*, where an empty list
  param is refused at the start: a param is the starter's, who can give another, and a result is the
  case's, which may truly have no packages.
- **Refs** are `<step>:<n>`, as a param fan-out's (workflows spec §5), the item in the member row's
  `item`, masked.
- **No fan-out over another fan-out's items.** A `for_each` whose `step` is itself a fan-out step,
  of either form, is refused by `workflow check`, `steps.audit.for_each names exposure, itself a
  fan-out: a fan-out over another fan-out's items is not supported`. Item pairing, which this would
  need, stays out (workflows spec §17).

### 4.2 The join

**The join marker is the fan-out step's own pending row**, not a gate: once fanned out, the row is
`made`, and its `items` column holds the item set, each item with its task's id and its place
(§8). A gate cannot be the marker: a gate is a shell command run at a report (kanban spec §7.7), not
a hold on a claim.

- **A fan-out step is settled once every item's task is settled**: done, archived, which counts as
  skipped, or stood in for by a done handler (§5.2).
- **A child of a fan-out waits for that.** It is pending (§7), and decided only when its fan-out
  parent is settled (§3.2); it is then made with a link to each item's task that is done, and to each
  done stand-in in place of the item it stood in for, and none to an archived item. So it is
  claimable at once, and its prompt's parents are the items' handoffs (kanban spec §7.1), as a fan-in
  on a param fan-out is given them.
- **A blocked or gave-up item holds the join under its own rules**: with `wait`, until a person
  unblocks it and it is done, or archives it; with a route to a helper, the same, while the helper
  works; with a stand-in, until the stand-in is done (§5).
- **A fan-out of one is still a fan-out**: its task's ref is `<step>:1`.

## 5. Blocked and failed steps: routes and handlers

### 5.1 `on_blocked` and `on_gave_up`

```yaml
  va:
    on_blocked: wait                   # the default: today's behaviour
    on_gave_up: { route: escalate }
```

- **`wait`** is today's: the task blocks, the chat hears (kanban spec §9.4), a person acts
  (workflows spec §11).
- **`{ route: <handler> }`** also makes the handler's task, once for that transition (§5.3).
- **Which transitions.** `on_gave_up`: the breaker's `gave_up` (`endRun` with `next` `blocked` and
  kind `gave_up`, kanban spec §8.2). `on_blocked`: a run's own `block` of any kind but `dependency`,
  which never sits in `blocked` (kanban spec §5.4), and a run's end that blocks the task for any other
  kind: `capability`, `transient`, `needs_input` for a cautious retry or a directory that cannot be
  made (`endRun`). **A person's block and a person's stop route nothing**: they are a person acting
  already, as the wake spec reasons for its outcomes (wake spec §2.2, §2.3). The rule is the wake's,
  read from the event's actor: `run:<run_id>` for a run's `blocked`, `gateway` for `run_ended`.
- **A fan-out step's routes are per item**: each item's task is routed for its own transitions, the
  handler made for that item, `{{item}}` set to it.
- **A handler's own `on_blocked` and `on_gave_up` are `wait`**: `workflow check` refuses a route
  from a handler, so routes never chain.

### 5.2 Handlers

```yaml
  escalate:
    handler: true
    stands_in_for: va                  # optional; requires the same outputs as va
    outputs:
      reachable: boolean
```

- **A handler is made only when routed to**, never at the start and never by `decide`'s other
  outcomes. It takes no `parents`, `when` or `for_each`: it is made with **no link**, as the task it
  handles is blocked and a link would hold it behind that task. Its other fields are a step's.
- **Where it works.** A handler whose step names no workspace, and whose role names none, is made
  with the routed task's workspace when that is fixed: it is there to look at that task's work, and
  kanban spec §2.3's rule 3 would otherwise give it the board's (it has no parents).
- **`{{item}}`** in a handler is the routed item's, and `workflow check` allows it only when every
  step routing to it is a fan-out step.
- **Without `stands_in_for`, the handler only helps**: it investigates, comments, or unblocks the
  task it was routed from (§5.4), and that task's dependents keep waiting for it, under its own rules.
- **With `stands_in_for: <step>`**, which must be one of the steps that route to it, and declare
  exactly the same outputs, name for name and type for type: **the handler's accepted completion
  settles that step for its dependents**, and its outputs are read in that step's place, by clauses
  and by a fan-out. The routed task itself stays as it is, blocked; a person may still unblock or
  archive it.
  - *A decision, forced by the code:* **a done stand-in wins.** Were the routed task later unblocked
    and done too, both would have a result; the step's result is the stand-in's whenever one is
    done, and the task's own only while none is, so the result is a function of the rows, not of
    which finished first. As every decision is made once (§3.2), this matters only for steps not yet
    decided.
  - **A routed task stood in for counts as finished** in the instance's status (§12.4), so an
    instance whose escalation answered is `done`, not `blocked (1)`, though the task stays blocked on
    the board until someone archives it, and its board cannot be archived until then (kanban spec
    §16.8).

### 5.3 Once per transition, at most 3

- **A route is keyed on the transition's event**: the `blocked` or `run_ended` event that blocked
  the task. Its row's key is (instance, handler, event id) (§8), so a replay of the transition, a
  retried transaction or a reconciliation (§11) makes no second handler.
- **At most 3 routes per routed task.** A task routed 3 times, whose next block would route again,
  falls back to `wait`: no handler is made, and the route's row records `over_limit` with that
  event's id, so the notice (§12.2) is said once: `` `k_…` va gave up again, and has been routed to
  escalate 3 times: it waits for a person now (/kanban task unblock k_… [comment]) ``. *A decision:*
  counted per task, so each item of a fan-out has its own 3; for a step that is no fan-out, a task is
  the step, as approved. See §21.
- **Due only while the block stands.** A route is due for a task's current block: the task is
  `blocked` by that event, with no `unblocked` after it. A block lifted before the route was made,
  which only a failed routing (§9.4) can leave behind, routes nothing when reconciled.
- **A handler's ref** is `<handler>:<n>`, its n-th route in the instance, from 1, unique in the
  instance as refs are (workflows spec §7), whatever step and item it handles, and within the 64
  bytes of a ref, which `<handler>:<routed ref>:<n>` would not always be.

### 5.4 A handler's run unblocks its task

A run may report on its own task and comment on any (kanban spec §7.3), but no worker command
unblocks another task: `mt kanban task unblock` is the operator's, refused in a run's shell
(`OPERATOR_GROUPS`). So that a helper can unblock, as approved, the worker API gains **`unblock`**,
a thirteenth command, scoped as `wake-unblock` is to a reaction task's wake (wake spec §19.8):

```
mt kanban unblock < {"task_id": "k_…", "comment": "the registry answers again; retried with the mirror"}
```

- **Only a handler's run**, and only for the task its route was made from, while that task is still
  blocked by the route's event: the stale check of `unblock`'s `blockedAt` (`db/kanban.ts`), given the
  route's event id. Otherwise `wrong_task`: `run r_… may unblock only the task its handler was routed
  from`, or `stale` once that block was lifted.
- **What it does is `unblock`'s**: the task returns to the phase it left, a `gave_up` one with a fresh
  set of attempts, a `transient` one with its throttling count reset; its comment, if any, steers the
  next run, prefixed `(by the handler escalate:1) `. The `unblocked` event's actor is the run.
- **Loops are bounded by §5.3**: a task that gives up again routes again, at most 3 times.
- The work protocol (kanban spec §7.1) gains its line only in a handler's prompt, beside `complete`'s.

This command is an addition the approved design implies but does not name, and is listed in §21.

## 6. Checks

`checkWorkflow` (`src/kanban/workflow.ts`) runs everywhere it runs today (workflows spec §4): `mt
workflow check`, the startup lines, every preview and start. **It refuses**, each naming its place:

| Problem | Message |
|---|---|
| an output name outside the grammar, an unknown type, a list with no `max` or one past 100, an enum empty or with a value twice | `steps.intake.outputs.packages: a list needs its max, from 1 to 100` |
| a clause, `for_each` or `{{step.output}}` naming an undeclared output | `steps.verify.when[1] names va.score, which va does not declare (it declares reachable)` |
| one naming a step that is not an ancestor | `steps.verify.when[0] names report, which is not an ancestor of verify: a condition reads only steps its parents come after` |
| a type mismatch | `steps.verify.when[1]: at_least compares a number, and va.reachable is a boolean`; `steps.va.when[0]: equals library is not one of intake.kind's values (cve, supplychain)`; `steps.exposure.for_each names intake.kind, which is no list` |
| a clause on a fan-out step | `steps.report.when[0] names exposure, a fan-out step, whose items each have their own result` |
| a nested fan-out | `steps.audit.for_each names exposure, itself a fan-out: a fan-out over another fan-out's items is not supported` |
| a handler routed from nowhere | `steps.escalate is a handler, and no step routes to it: add on_blocked or on_gave_up: { route: escalate } to the step it handles` |
| a route to a step that is no handler, or to none | `steps.va.on_gave_up routes to report, which is not a handler (handler: true)` |
| `stands_in_for` with other outputs, or naming a step that does not route to it | `steps.escalate stands in for va, and its outputs differ: va declares reachable (boolean), escalate reachable (string)` |
| a handler with `parents`, `when` or `for_each`, or a route from a handler | `steps.escalate is a handler, made with no parents when routed to: it takes no parents` |
| a clause list with two `any` groups, an empty `any`, or a clause with two tests | `steps.verify.when has two any groups; it takes one` |
| `{{step.output}}` in a plain step, a contract field, a name field or a gate | `steps.va.title names {{intake.kind}}, and va is made at the start, before any result` |
| outputs on a person's step | §2.1 |
| a cycle | as today, `the steps' parents make a cycle: …`; a route adds no edge a cycle could close, as a handler has no parents and stands in only for the step it is routed from |

**What a check says of each step.** `mt workflow check <name>` prints, after the workflow's line, one
line a step; chat's and the terminal's preview (§12.3) show the same words. Without a name, each
workflow's one line is unchanged but for its step count, `ok, 8 steps (1 always, 6 on results, 1 handler)`:

```
vi-workflow: ok, 8 steps (1 always, 6 on results, 1 handler); params: case (required); board vi
  intake: always
  va: when intake.kind is cve; on gave up, routed to escalate
  escalate: handler for va, standing in
  verify: when intake.verify is true and va.reachable is true
  exposure: per item of intake.packages
  registry: when intake.bnpm is true
  report: when its parents are settled
  patch: when intake.patch is true
```

The words: `always` for a plain step; `when <clauses>`, joined by `and`, an `any` group in
parentheses joined by `or`; `per item of <step>.<output>`, or `per item of <param>` as today's
fan-out reads; `handler for <steps>`, with `, standing in`; and `when its parents are settled` for a
pending step with no `when` of its own. A clause reads `va.reachable is true`, `intake.kind is cve`,
`intake.kind is one of cve, ghsa`, `va.score is at least 7`, `va gave up`, `va blocked`, `va is
skipped`, `va is done`.

**What a start checks beyond the file**, before its transaction (workflows spec §6 step 2): every
template as `create` would check it (§7), with every reference to a result filled with a placeholder
of its declared type's widest form, so that a template too long already is refused at the start, not
cut later; and the bound of §19, from the lists' `max`.

## 7. Expansion: plain and pending steps, and the frozen plan

### 7.1 Which steps are plain

**A step is plain** when it has none of `when`, a result `for_each`, or `handler: true`, **and**
every parent of it is plain, **and** no parent of it is the `stands_in_for` of a handler. Every other
step is **pending**.

*A decision, forced by the code*, listed in §21: the approved design makes "a step with `when`,
with result `for_each`, or with `handler: true`" pending. A child of such a step cannot be made at
the start: its links name its parents' tasks, and a link's foreign key needs the parent's row
(`kanban_links`), which a pending parent has not got. A child made then without that link would be
claimed before its parent is decided. So a pending step's descendants are pending too. And a child of
a step a handler may stand in for is pending, so that it can be linked to the stand-in once there is
one (§4.2): a link is never deleted (WRITERS.md), so a child linked to the routed task at the start
would wait behind it, blocked, forever.

**Old workflows don't change.** A file using no new key has every step plain: `expand` gives today's
DAG, byte for byte, its hash unchanged, the instance's `plan` null, and no pending row.

### 7.2 What a start makes

`expand(workflow, params, board, …)` returns **`{ dag, plan }`**: the DAG of the plain steps' tasks,
format 1 as today (workflows spec §5), and the plan, `null` when the file uses no new key. The
start's one transaction (workflows spec §8, `applyDag` in `db/kanban.ts`) writes, beside today's
rows, the instance's `plan` column, and one `kanban_workflow_pending` row a pending step, `waiting`.
A handler's row is `waiting` too, for good: it is decided by routes, each of its own row (§8).

### 7.3 The plan

The plan is JSON, stored in `kanban_workflow_instances.plan`, **masked on write but for its gates**,
as the stored DAG is (workflows spec §7), and never changed after the start:

```json
{
  "format": 1,
  "steps": [
    { "step": "intake", "made": "start", "parents": [], "outputs": {
        "kind": { "enum": ["cve", "supplychain"] }, "verify": "boolean", "patch": "boolean",
        "bnpm": "boolean", "packages": { "list": "string", "max": 100 } },
      "on_blocked": "wait", "on_gave_up": "wait" },
    { "step": "va", "made": "decide", "parents": ["intake"],
      "when": [{ "step": "intake", "output": "kind", "equals": "cve" }],
      "outputs": { "reachable": "boolean" }, "on_gave_up": { "route": "escalate" },
      "template": { "title": "CVE-2026-12345 · va", "body": "…", "assignee": "vulnerability-analyst",
                    "reviewer": null, "workspace": null, "priority": 0, "contract": { "outcome": "…" },
                    "failure_limit": 2, "retry_on_crash": "always", "max_runtime_s": 3600,
                    "gates": [{ "command": "vi-workflow-gate result.json", "timeout_s": 30 }],
                    "wake": null } },
    { "step": "escalate", "made": "route", "handler": true, "stands_in_for": "va", "…": "…" },
    { "step": "exposure", "made": "decide", "parents": ["va"],
      "for_each": { "step": "intake", "output": "packages" }, "…": "…" }
  ]
}
```

- **Every step is in it**, in the file's order, plain ones included: a plain step's outputs are what
  its completion is checked against (§2.2), and its routes are what its blocks are routed by.
  `made` is `start`, `decide` or `route`.
- **A template** is a DAG task's fields (workflows spec §5) with the params already filled in, as
  the start knew them, and the references to results, `{{step.output}}` and a result fan-out's
  `{{item}}`, left in place. A pending step over a **list param** (`for_each: vendors` whose parent is
  pending) is expanded at the start, one template an item, as `templates`, since its items are known.
- **`wake`** is the member's wake as the start resolved it for that step (`#members`,
  `src/kanban/service.ts`): its setter, depth, role and too-deep mark, or `null`. A task made late
  gets it as its start would have, so a step's `wake: true` and a start's `--wake` hold for a step
  made an hour later. A run's start stores none: its late members inherit their creating task's wake
  at the making, as `insertTask` does for any task a run makes (wake spec §3.1).
- **At most 1 MiB** in its canonical form, as a start's DAG (workflows spec §5); a file that would
  pass it is refused at the start, `too_large`.

### 7.4 A step made late

When `decide` makes a step (§10), the writer inserts its tasks **as the start would have**, through
the same `insertTask` (`db/kanban.ts`):

- **its fields** from its template, each `{{step.output}}` filled from the accepted results as text,
  once, as params are (workflows spec §2): a list as its items joined by `, `, a number as JSON writes
  it, a boolean as `true` or `false`, a skipped step's as nothing. `{{item}}` from the item.
  **Titles and bodies are cut** to `task new`'s limits (512 bytes, 64 KiB) with `cutToBytes`
  (`src/kanban/limits.ts`), as a reaction task's are (wake spec §19.3): the writer must not refuse a
  completion for a later step's length, and the start already refused a template too long without
  its results (§6);
- **its creator** the instance's: `created_by`, `created_via` and, for a run's start, the same
  `created_from_task`, as `applyDag` gave the start's members;
- **its board** the instance's (workflows spec §19.2), whatever the file names now;
- **its links** to its parents' tasks (§3.2, §4.2);
- **its subscriptions** copied from the instance's first member's, as they are at the making, through
  `insertTask`'s copied subscriptions, which today take one row for a reaction task (wake spec §19.3)
  and now take a list. *Forced by the code:* recomputed from `created_via`, a chat start's late task
  would follow the chat at chat scope, though `threadSubscriptions` moved every member into the
  reply's thread (workflows spec §9). A start that no chat follows gives none;
- **its gates** through `insertGate`, as `applyDag`'s, by the instance's creator;
- **its member row** in `kanban_workflow_tasks`, its ref (§4.1, §5.3), its step and item, and its
  position the next after the instance's last. *This amends workflows spec §7*, where members are
  exactly what the apply made: a member is what the apply made, or what the instance's plan made
  later, and a follow-up or a task linked in later is still only related;
- **its `created` event**, with `workflow`, `workflowName`, `ref`, `step` and `item` as a start's
  member's (workflows spec §8), and `routedFrom`, the routed task's id, for a handler;
- **its team check.** A task whose assignee, reviewer or workspace no longer passes `checkTask`
  against the team as the gateway holds it (a role removed, a workspace removed, a person who lost
  talk tier) **is made, and blocked at once** as `needs_input`, with the reason: `role verifier is
  not configured, so this step's task cannot be given to it: /kanban task assign k_… <role>`, as
  `enterBlocked` writes it, its `blocked` event's actor `gateway`. Its chat hears it as any block
  (kanban spec §9.4), and it wakes nothing, its actor being no run's (wake spec §2.2). The team
  reaches the writer as §9.3 says.

## 8. Schema (migration `015_workflow_routing.sql`)

```sql
-- manus-team migration 015: workflow routing
-- See docs/specs/2026-11-26-workflow-routing-design.md §8.
ALTER TABLE kanban_workflow_instances ADD COLUMN plan TEXT CHECK (plan IS NULL OR json_valid(plan));

CREATE TABLE kanban_workflow_pending (
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  step         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('waiting', 'made', 'skipped')),
  reason       TEXT CHECK (reason IS NULL OR json_valid(reason)),  -- why it was made or skipped, masked
  items        TEXT CHECK (items IS NULL OR json_valid(items)),    -- a fan-out's join marker: [{item, task_id, ref}]
  cause_event  INTEGER,                                            -- the event whose transaction decided it
  decided_at   INTEGER,
  PRIMARY KEY (instance_id, step),
  CHECK ((state = 'waiting') = (decided_at IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_kanban_workflow_pending_waiting ON kanban_workflow_pending(instance_id) WHERE state = 'waiting';

CREATE TABLE kanban_workflow_routes (
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  handler      TEXT NOT NULL,
  event_id     INTEGER NOT NULL,                                   -- the blocked or run_ended event routed
  from_task    TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('made', 'over_limit')),
  task_id      TEXT REFERENCES kanban_tasks(task_id),               -- the handler's task; null when over_limit
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (instance_id, handler, event_id),
  CHECK ((outcome = 'made') = (task_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_kanban_workflow_routes_from ON kanban_workflow_routes(from_task);

UPDATE schema_version SET version = 15;
```

- **A pending row a pending step**, keyed (instance, step): the approved unique key for a step's
  decision. `state` moves once, from `waiting` to `made` or `skipped`, by `UPDATE … WHERE state =
  'waiting'`, whose one changed row is the guard that a decision is made once (§9.2). A handler's row
  stays `waiting`.
- **A route row a route**, keyed (instance, handler, event): the approved key for a route.
  `over_limit` records the fourth route refused, so its notice is said once.
- **`skipped` is a pending-row state only**, never a task's phase (§20, decision 1): a skipped step
  never becomes a task.
- **The plan is a column**, not a key of the stored DAG: the DAG stays format 1, canonical and hashed
  as today, so old DAGs, `show --dag` and `apply` are untouched (§13.5).
- **Foreign keys** are allowed, as both tables are new and the column is added to a table of the
  workflows' own (workflows spec §7). The `ALTER TABLE` adds a nullable column, which SQLite writes
  into no existing row; the migration's transaction is as short as 009's.
- **No board is added**, so workflows spec §19.4's claim about migrations that add one holds.
- **WRITERS.md** gains the two tables' rows and amends three: `kanban_workflow_instances` (`plan`,
  written by `applyDag` only), `kanban_workflow_tasks` (rows added later by the routing, §7.4) and
  `kanban_events` (`workflow_routed` and `workflow_route_failed`, §9.4, §12.2).
- **An unmigrated database**, between this build and the start that migrates it: a start of a file
  that uses the new keys is refused, `invalid`, `the database is not yet migrated to version 15:
  start the gateway once, so it is migrated`, as an unmigrated wake is (`NOT_MIGRATED`); a start
  of a file that uses none works as today; the routing reads find no column and do nothing.

## 9. The writer: deciding inside the settling transaction

### 9.1 Which transitions decide

The deciding is in `db/kanban.ts`, in the transaction of each transition that can change what a
pending step reads, after the transition's own rows and event:

| Writer | When it routes |
|---|---|
| `complete` | when the task becomes `done`, not when it goes to `review` |
| `block` | a run's block, of a kind but `dependency` (§5.1); a person's block decides nothing |
| `endRun` | `next` is `blocked` |
| `archive` | always: the task now reads as skipped (§3.1) |
| `archiveWorkflow` | every waiting row is skipped, `the instance was archived`, and nothing is made |
| `stop`, `unblock`, `requestChanges`, `assign`, the claim, everything else | nothing: a person's stop routes nothing (§5.1), and none of the others changes what a step reads |

*A decision.* `archiveWorkflow` skips every waiting row without deciding: its members are archived
one by one, and a decision after each would make children of the archived parents, the "skipped
parent satisfies the dependency" rule (§3.2), in an instance being put away.

### 9.2 The helper

```ts
// db/kanban.ts, called inside each transaction above
function routeAfter(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): Result<object>
```

1. **One read** finds the task's member row joined to its instance's `plan`; a task that is no member,
   or whose instance has no plan, returns at once. This is the only cost every settling transition
   pays: one primary-key lookup, `memberOf`.
2. It reads the **facts** of the instance: every member with its task's phase, block kind and block
   event; each done step's accepted result, by `latestCompletion`, only for the steps the plan reads;
   the pending rows; the route rows. All within the transaction, so what it reads is what is true.
3. It calls the pure **`decide(plan, facts)`** (§10), and applies each outcome: a `made` step's tasks
   (§7.4), with its row set `made`, `reason`, `cause_event` and `decided_at`; a `skipped` row; a
   fan-out's tasks and its `items`; a route's handler task and its route row.
4. **Until nothing more is due**: a step skipped may decide another in the same transaction (a skip
   cascades), so it calls `decide` again on the new facts, at most once a step of the plan, which
   bounds the loop. A step made is a new open task, which decides nothing until it settles.
5. It writes **one `workflow_routed` event** on the transitioning task, listing every decision of the
   transaction, for the notice (§12.2).

**Exactly once.** A row moves from `waiting` only by an `UPDATE … WHERE state = 'waiting'` that must
change one row, and a route is an `INSERT` into its primary key: a second attempt, by a replay of the
same transition, a retried transaction (`SQLITE_BUSY` before the commit leaves nothing written), or a
reconciliation racing the gateway (§11), finds the row decided or the key taken, and makes nothing.
Decisions are recomputed from the facts each time, never from the order the events came in: two
transactions that settle two parents of one step, in either order, give the same decision.

### 9.3 Without circular imports

- **`src/kanban/routing.ts`**, new and pure: the plan's types, `decide(plan, facts)`, `checkOutputs(
  declared, metadata, bounds)` for §2.2, the step descriptions of §6, and the clause words of §12. It
  imports only `./types.js`, `./limits.js`, `./dag.js` (`titleRefused`, `DAG_LIMITS`) and
  `../secrets.js`. It imports no `db/` module, no `service.ts`, no `workflow.ts`.
- **`db/kanban.ts` imports `routing.ts`**, as it already imports the pure `kanban/dag.ts` and
  `kanban/task-checks.ts`. `workflow.ts` imports `routing.ts` to check the new keys and build the plan;
  `service.ts` imports it for the completion check. The direction `db -> pure kanban module` is the
  one that exists; nothing in `routing.ts` points back.
- **The team.** The writer knows rows, not the team (`db/kanban.ts`'s own comment), so the service,
  which holds it, passes a `RouteTeam` (`TaskFacts`' roles, workspaces, `supervisedRoles` and
  `canTalk`) to each deciding writer as one more optional argument, as `recordRoleWake` is given
  `TaskFacts` today. `KanbanService` passes `this.#facts()` from `complete`, `block`,
  `endRun`, `archive` and `reconcileWorkflow`. Without it, as in the writer's own tests, a made task
  is not checked against the team, and its claim finds a removed role as any task's does (kanban spec
  §4.2).

### 9.4 A failure in the routing

The routing runs in a **savepoint** inside the transition's transaction (a nested `db.transaction`,
which better-sqlite3 runs as `SAVEPOINT`). Two kinds of failure, kept apart:

- **A refusal it means**, the bound of 500 passed by a completion (§2.2), rolls back the whole
  transition, which is refused `too_large`: the run stays undecided, and its next report meets the
  service's own check, which explains. From every other path, which cannot be refused for it (a
  block, a run's end, an archive), a step whose making would pass 500 is skipped instead, `the
  instance has 500 tasks`, and a route falls back to `wait`, both said in the notice.
- **A fault**, a bug or a row that cannot be read, rolls back the savepoint only: the transition
  stands, as a task's own completion must not be lost to its routing, and one `workflow_route_failed`
  event on the task, no notice, records the error, masked and cut at 500 characters. `workflow show`
  says so (§12.1), and reconciliation (§11) decides again from the facts.

## 10. `decide(plan, facts)`

Pure, in `src/kanban/routing.ts`:

```ts
interface StepFact {
  step: string;
  state: 'unmade' | 'skipped' | 'unsettled' | 'done';   // a pending step's row, or its tasks' phases
  entered: { blocked: boolean; gaveUp: boolean };        // ever, for the state clauses (§3.2)
  result: Readonly<Record<string, OutputValue>> | null;  // the accepted result, or the stand-in's
  tasks: readonly { taskId: string; ref: string; item: string | null; settled: 'done' | 'archived' | 'stood_in' | null; standIn?: string }[];
}
interface RouteFact { taskId: string; step: string; item: string | null; eventId: number; kind: 'blocked' | 'gave_up'; routes: number }
interface Facts { steps: ReadonlyMap<string, StepFact>; due: readonly RouteFact[]; members: number }

type Decision =
  | { step: string; outcome: 'made'; parents: string[]; why: string }
  | { step: string; outcome: 'skipped'; why: string }
  | { step: string; outcome: 'fanned_out'; items: string[]; parents: string[] }
  | { step: string; outcome: 'route'; handler: string; from: RouteFact; standsIn: boolean }
  | { step: string; outcome: 'over_limit'; handler: string; from: RouteFact };

function decide(plan: Plan, facts: Facts): Decision[];   // only what is due now; waiting is the absence of a decision
```

For each pending step still `waiting`, in the plan's order: its `when` (§3.2): certainly false,
`skipped` with the first false clause as `why`; undecided, nothing; true, and its parents settled
(§3.2, §4.2): `made`, or for a fan-out, `fanned_out` with the source's items, or `skipped` for none.
For each `due` route: its step's `on_blocked` or `on_gave_up`, by the kind; `wait`, nothing; a route
with fewer than 3 for the task, `route`; with 3, `over_limit`. A route due for a step whose route is
`wait` never reaches `decide`: the writer gathers only blocked members whose step routes.

`decide` is total: a missing result, a value of the wrong type, a step it does not know, each reads
as false or as unsettled, never as an exception, so a fault in the facts cannot make a wrong task.

## 11. Reconciliation

`reconcile(instance)` is the same helper as §9.2, given no transitioning task: it reads the facts,
decides what is due, and makes it, in one transaction of its own. Its `workflow_routed` event goes on
the member whose settling decided the first of its decisions, the latest-settled ancestor that step
reads, so the notice reaches the instance's chat as any would.

- **At gateway start**, after the migration and before the dispatcher's first pass, for every
  instance with a plan and either a `waiting` row or a blocked member whose step routes. It decides
  what a failed routing (§9.4), a database written by a terminal of an older build, or a crash
  between a commit and nothing else, left due. One line, a note: `workflows: reconciled 2 instances,
  3 steps decided`, or nothing when none was due.
- **At the terminal**, `mt kanban workflow reconcile w_… [--board <b>] [--json]`, the operator's,
  beside `show` and `archive` in `WORKFLOW_COMMANDS` (`src/cli/operator.ts`): the verb "reconcile"
  because the gateway already says it for the sessions it puts right at boot (`reconcileBoot`). It
  answers `reconciled w_…: verify skipped (intake.verify is false); exposure: 3 tasks` or `w_…: nothing
  was due`, then the nudge, as after `start` (workflows spec §6). `--json` gives `{"ok", "instance_id",
  "decisions": [{"step", "outcome", "task_ids"}]}`. Refused `not_found`, `other_board`, and `no_board`
  on an unmigrated database, as `show` is.
- **Both are safe against the gateway**: the keys of §9.2 make a reconciliation that races a
  settling transition decide nothing twice.

## 12. What people see

### 12.1 `workflow show`

`/kanban workflow show w_…` and `mt kanban workflow show w_…` list **every step**, real or pending, in
the file's order, each with a line saying where it is and why, and under it its tasks, as today:

```
**vi-workflow** `w_…`: running, 6 of 10 done · board: **vi**
Started by Zhixi Sun, in chat, 2026-11-26 10:02
Params: case=CVE-2026-12345
✓ intake: done (kind=cve, verify=false, patch=false, bnpm=false, 3 packages)
- `k_…` done · role vi-coordinator
✓ va: done, stood in for by escalate (reachable=true)
- `k_…` blocked (gave up): failed 2 times; last crashed · role vulnerability-analyst
↪ escalate: routed from va (gave up), standing in
- `k_…` escalate:1 done · role vi-coordinator
⏭ verify: skipped (intake.verify is false)
▶ exposure: 3 items, 1 done
- `k_…` lodash: done · role exposure-analyst
- `k_…` minimist: running · role exposure-analyst
- `k_…` qs: ready · role exposure-analyst
⏭ registry: skipped (intake.bnpm is false)
⏳ report: waiting for exposure
⏳ patch: waiting for report
```

- **The step line**: `✓ <step>: done (<outputs>)`, the scalar outputs as `name=value` and a list as
  its count and name, cut at 120 characters; `▶ <step>: running`, or for a fan-out `N items, M done`;
  `⏭ <step>: skipped (<why>)`; `⏳ <step>: waiting for <its unsettled parents and read ancestors>`;
  `⛔ <step>: blocked`; `↪ <handler>: routed from <step> (<gave up|blocked>)`, with `, standing in`.
  A handler never routed to shows no line. A step made late shows as a plain one once made.
- **The order** is the plan's, the file's; tasks under their step in position order. Late members
  have later positions than the start's (§7.4), so `show` groups by step first, where today it walks
  positions.
- **A failed routing** (§9.4) adds one line after the head: `Routing failed at 10:41: <error>.
  \`mt kanban workflow reconcile w_…\` decides again.`
- **How it reads them**: `KanbanService.instance(id)` reads, beside today's members, `pendingOf(db,
  instance)` and `routesOf(db, instance)` (`src/db/kanban-read.ts`), and the accepted results of the
  done steps that declare outputs; the pure `stepLines(plan, members, pending, routes, results)` in
  `routing.ts` makes the lines; `renderInstance` (`src/kanban/chat-render.ts`) and the terminal's
  plain text (`src/cli/plain.ts`) print them, chat's cut to fit as today (workflows spec §10).
  `--json` gains `steps: [{"step", "state", "why", "items", "routes"}]`. An instance with no plan shows
  as today, with no step lines.
- **`show --plan`**, at the terminal only, beside `--dag`, prints the stored plan, masked. `--dag`
  prints the start's DAG as today, and for an instance with a plan says on stderr that the DAG holds
  only the steps made at the start, the rest in `--plan` (§13.5).

### 12.2 Notices

One event, **`workflow_routed`**, on the transitioning task (§9.2), its payload the instance
(`workflow`, `workflowName`), the task's step, and `decisions`, each `{step, outcome, why, taskIds,
items, count, handler}`, items at most 20 with the count, masked on write as every payload is, the
names and refs in `BOARD_KEYS` already. The notifier renders it from the payload alone, as
`workflow_started` (workflows spec §18.2), with `renderNotice`:

```
After **CVE-2026-12345 · intake** `k_…`, in vi-workflow `w_…`:
- ⏭ verify skipped: intake.verify is false
- ⏭ registry skipped: intake.bnpm is false
- ✓ va made: `k_…`
```
```
After **CVE-2026-12345 · va** `k_…` gave up, in vi-workflow `w_…`:
- ↪ escalate routed from va: `k_…`, standing in
```
```
After **CVE-2026-12345 · va, escalated** `k_…`, in vi-workflow `w_…`:
- ✓ escalate stands in for va: reachable=true
- ▶ exposure fanned out, 3 tasks: lodash, minimist, qs
```

- **It reaches the instance's chat or thread**, as the transitioning task's subscriptions are the
  instance's (§7.4), and is **batched** with the transition's own notice, which comes first, its
  event being earlier: at most 20 notices and 3,800 characters a message, every 2 s (kanban spec
  §9.4). Items, titles and reasons are masked and escaped as every notice's.
- **Skipped, fanned out, routed, stood in, and over the limit** are its lines; a step made plainly is
  one line too, so the chat sees each task appear. A reconciliation's decisions are one more such
  event (§11).
- **It wakes nothing**: `WAKE_KINDS` (`src/kanban/waker.ts`) is unchanged, and the wake spec's outcomes
  stay exactly its five (wake spec §2.2); `workflow_routed` is one more notice that is no outcome, as
  `workflow_started` is (wake spec §2.3). A task made late wakes on its own outcomes, by the wake its
  step was given (§7.3).
- `workflow_route_failed` is no notice.

### 12.3 Preview, and the start's reply

- **Preview** (workflows spec §6) lists the plain tasks as today, then the pending steps, each with the
  words of §6: `verify: when intake.verify is true and va.reachable is true`, `exposure: per item of
  intake.packages, at most 100`, `escalate: handler for va, standing in`. Its first line counts both:
  `vi-workflow would make 1 task now, and up to 108 more as results come, on board vi:`, the most from the
  lists' `max`. The same in chat and at the terminal.
- **The start's reply** (workflows spec §9) lists the tasks made, then one line, `5 more steps are made
  as results come: \`/kanban workflow show w_…\` follows them.`, among the fixed lines the cut keeps.
- **The worker's answer** to `start-workflow` gains `"waiting": ["va", "verify", …]`, the pending steps
  by name, beside `tasks`; `mt kanban workflow start --json` the same.

### 12.4 Status

`instanceStatus` (`src/kanban/workflow.ts`) is given the pending rows and the stand-ins too:

- a **waiting** step counts as one unfinished, so an instance with a step waiting is never `done`;
- a **skipped** step counts as finished;
- a member **stood in for** by a done handler counts as finished, and not as blocked;
- otherwise as today: done is every member and step finished, blocked any member blocked.

The members count reads "6 of 10 done", members and unmade steps together, a waiting fan-out as one.
`instances` keeps its one aggregate query of phases and adds one over the pending rows.

## 13. Boards, keys, wake, workspaces, and the DAG paths

### 13.1 Boards (workflows spec §19)

A late task goes on the **instance's** board, `kanban_workflow_instances.board`, decided once at the
start (workflows spec §19.2) and never read from the file again. The board cannot have been archived
meanwhile: a waiting step always has an unsettled ancestor, whose task is open, in review or blocked,
and a board with such a task is not archived (kanban spec §16.8). The writer checks it live anyway
(`liveBoard`), and a board found archived skips the step, `board vi is archived`, never a refusal.

### 13.2 Idempotency keys

The instance's key covers its start (workflows spec §6), and a late task carries no key, as a member
carries none: it is made in a transaction keyed by its pending row or its route row, which is its
uniqueness. **A repeat of the start** answers the instance as it is now, `existing: true`, its tasks
every member made so far, late ones included, and its `waiting` the steps still pending.

### 13.3 Wake

A late member's wake is its step's, as the start resolved it (§7.3): `wake: true` and a start's `wake`
hold for a step made later, under the setter's live tier check at each wake (wake spec §5.3). A run's
start's late members inherit their creating task's wake when they are made (wake spec §3.1). A
handler's task is woken by its own outcomes only, by its own step's wake. `workflow_routed` wakes
nothing (§12.2).

### 13.4 Workspaces

A late task with parents resolves its workspace by kanban spec §2.3's rule 3, from them, at its claim,
as any member; its parents are done by then, so fixed. A handler, with no parents, takes the routed
task's fixed workspace when its own step and role name none (§5.2). A fan-out in one shared workspace
runs one item at a time, as a param fan-out does (workflows spec §12).

### 13.5 `apply`, `apply-dag` and `preview --json`

*A decision.* **Conditions are workflow starts' only.** A DAG stays a fixed graph, format 1, with no
`when`, `for_each` over a result, route or handler, so `apply`, `apply --dry-run` and `apply-dag` are
unchanged, and so is every DAG's hash. Why:

- a DAG is what will be made, task by task, checked and hashed before its transaction (workflows spec
  §5); a step whose tasks depend on a result has no tasks to write, so a DAG carrying one would be a
  second expansion engine with its own format, the plan, under a hash it could not stand behind;
- an agent planning a graph has its own judgement: a deciding step (workflows spec §0) makes the
  branch it chose, which is what routing replaces for the operator's file, not for an agent;
- the gates rule (workflows spec §5) stands as it is: a plan's gates come from the operator's file
  alone, and `apply-dag` has no path to them.

So **`preview --json` of a file that uses the new keys is refused**, `invalid`: `workflow vi-workflow
routes on results (when, for_each over an output, handlers), and a DAG holds a fixed graph: start it
with mt kanban workflow start`. **`show --dag`** of a routed instance prints its start's DAG with the
stderr line of §12.1, and applying it makes only those tasks, which is what it says. A start, from
chat, the terminal or a run's `start-workflow`, is the only way to make a routed instance.

### 13.6 The worker's `start-workflow`

A run's start of a routed workflow is as today's (workflows spec §6), on its task's board, created
from its task; its late members are created from the same task, follow its subscriptions as copied
from the first member (§7.4), and inherit its wake (§13.3). Its answer gains `waiting` (§12.3).

## 14. Security and masking

- **Values from results only fill titles and bodies**: never a name field, so a run's result cannot
  choose who runs next or where; never a gate, as no param reaches one (workflows spec §2); never a
  contract field, as approved. `workflow check` refuses a `{{step.output}}` anywhere else.
- **Results are an agent's text**, stored masked (`maskDeep`), and a fan-out's items and the made
  titles are masked again on write, as a task's are. An item holding a known secret is refused at the
  completion (§2.2), as a param's is (workflows spec §3), since items label their tasks.
- **Conditions run no code.** A clause is a comparison of a stored value; there is no expression, no
  template logic, nothing evaluated.
- **A handler's `unblock`** (§5.4) reaches only the task its handler was routed from, under the same
  stale check a button has, so a run cannot unblock any other task.
- **The plan is the operator's file**, frozen; its gates are stored as written, as the DAG's are
  (workflows spec §7), and a run's DAG never carries one (§13.5).

## 15. The cases

- **The intake reports no `packages`**: refused, `output packages is missing`; the agent reports
  again with `"packages": []`, and `exposure` is skipped, `intake.packages is empty`.
- **The intake reports 63 packages, `max` 50**: refused, `output packages must be a list of at most
  50 strings; got 63`; never cut to 50.
- **A reviewer asks for changes on a task whose result a step reads**: nothing is decided; the rework
  reports again, its outputs checked, and the reviewer's approval decides from the rework's result.
- **An ancestor archived before it was done**: its pending children read it as skipped; a clause on its
  output is false, and a child with no `when` whose only parent it was is made with no link.
- **A plain task archived by hand, its children plain too**: as today, its children are released
  (kanban spec §4.1); routing changes nothing for plain steps.
- **`va` gives up, `on_gave_up` routes to a stand-in, the stand-in reports**: va's dependents are
  decided with the stand-in's result, linked to the stand-in; `va` stays blocked on the board, and the
  instance counts it finished.
- **`va` gives up a fourth time**: no handler; one notice that it waits for a person.
- **The stand-in itself gives up**: it waits, as a handler's routes are `wait`; va's dependents wait
  for a person to unblock or archive one of them. Archiving the handler and unblocking va lets va's
  own completion settle it.
- **A role removed from config before a step is made**: the task is made and blocked, needs_input,
  with the reason; `/kanban task assign` moves it to another role and `/kanban task unblock` frees it.
- **The file edited while an instance runs**: nothing changes for it; the plan is frozen. A new start
  takes the edit.
- **The gateway stops between a completion's commit and anything else**: nothing is lost, as the
  decision was in the completion's transaction. A routing fault there is reconciled at the next start.
- **Two items' completions commit at once, both the last but one**: the second's transaction sees
  both done and makes the join's child; the first's saw one left and made nothing.
- **A terminal reconciliation while the gateway decides the same step**: one of the two finds the row
  decided, and makes nothing.
- **A chat start whose reply's thread is opened after a member settled**, which the 5 s hold makes
  rare: the late task copied the first member's subscription at chat scope, and `threaded`, which reads
  the members at its move, moves it too.
- **A board on which a routed instance still has a waiting step**: cannot be archived, as some
  ancestor's task is open.
- **A start with a key, repeated after tasks were made late**: answers the instance with every member
  now, `existing: true`.
- **A workflow with no new key**: started, shown and archived exactly as today; no plan, no pending
  row, no `workflow_routed`.

## 16. Wiring

- **`src/kanban/routing.ts`**, new and pure (§9.3): the plan's types, `decide`, `checkOutputs`,
  `stepLines`, `clauseText`, and the reference filler of §7.4.
- **`src/kanban/workflow.ts`**: `STEP_KEYS` gains `outputs`, `when`, `on_blocked`, `on_gave_up`,
  `handler` and `stands_in_for`; `WorkflowStep` gains them, `forEach` becoming `string | { step,
  output } | undefined`; `checkWhole` gains §6's checks, an ancestors map from the parents, and the
  `{{step.output}}` references; `expand` returns `{ dag, plan }`, plain steps in the DAG as today; the
  outputs sentence in `outcome` (§2.1); `instanceStatus` given the pending rows (§12.4).
- **`src/kanban/service.ts`**: `#outputsRefused` in `complete` and `requestReview` (§2.2); the
  `RouteTeam` passed to `board.complete`, `block`, `endRun` and `archive`; `#expanded` and
  `#write` carrying the plan, its templates checked as §6 says, and the wake resolved per pending step
  (§7.3); `startWorkflow`'s answer's `waiting`; `instance()` reading pending rows and routes;
  `reconcileWorkflow(id)` and `reconcileAll()`; `unblockFromHandler(run, taskId, comment)` for §5.4.
- **`src/db/kanban.ts`**: `routeAfter` and its savepoint (§9); `applyDag` writing `plan` and the
  pending rows; `insertTask`'s copied subscriptions as a list; the made task's team check and its
  `blocked`; `archiveWorkflow` skipping waiting rows; `workflow_routed` and `workflow_route_failed`;
  `routedFrom` in `BOARD_KEYS`.
- **`src/db/kanban-read.ts`**: `InstanceRow.plan`; `pendingOf`, `routesOf`, `routesFrom(taskId)`;
  `memberOf` returning the plan's presence; `hasRouting(db)` for an unmigrated database.
- **`src/kanban/worker.ts`**: `unblock` in `WORKER_COMMANDS`, its schema `{task_id, comment?}`;
  `madeAnswer`'s `waiting`. **`src/kanban/prompt.ts`**: the `unblock` line in a handler's protocol.
- **`src/kanban/chat-render.ts`**: `renderInstance`'s step lines; `renderNotice`'s `workflow_routed`;
  `renderPreview`'s pending steps and its first line; `renderStarted`'s "more steps" line.
  **`src/kanban/notices.ts`**: nothing but passing the event, as `renderNotice` decides.
- **`src/cli/operator.ts`**: `reconcile` in `WORKFLOW_COMMANDS`; `show --plan`; `preview --json`'s
  refusal for a routed file; the `--dag` stderr line. **`src/cli/plain.ts`**: their text.
  **`src/cli/workflow.ts`**: `mt workflow check`'s step lines and counts. **`src/cli/mt.ts`**: `USAGE`.
- **`src/index.ts`**: `reconcileAll` after the migration, before the dispatcher starts, and its note.
- **`schema/015_workflow_routing.sql`** (§8). **`src/db/WRITERS.md`** (§8).
- **`skills/mt-kanban/SKILL.md`** gains one line beside "Put structured facts in metadata": `When your
  task's outcome names outputs, report each as a top-level key of "metadata", of the type it names; a
  completion without them is refused, and you report again in the same run.`
- **`docs/kanban-guide.md` §12**: a section "Routing on results", with the folded vi file of §1, how a
  step is shown, and `reconcile`. **`docs/specs/2026-11-16-workflows-design.md`**: the note in §0 and
  §17 that this document extends them.

**What stays.** `PHASES`, `REPORTED_OUTCOMES`, `BLOCK_KINDS` and `RefusalCode` (`src/kanban/types.ts`) are unchanged:
no phase, outcome, block kind or refusal code is added. The dispatcher, the claim, the prompt (but a
handler's one line), the waker, the progress cards and the tiers are unchanged, and work per task.

## 17. Testing

- **Unit, `decide()`**, with plans and facts written by hand, no database:
  - every clause: `equals` on a string, an enum, a number and a boolean; `in`; `is: true` and `false`;
    `at_least` and `at_most` at, below and above the bound; each `state`, `blocked` and `gave_up` true at
    the transition and false once settled without it;
  - `any`: one of three true, none true; with other clauses false first;
  - skipped reads: a clause on a skipped step's output false; `state: skipped` true; a child with no
    `when` whose parents are all skipped made with no parents; an archived ancestor read as skipped;
  - ancestor reads: a clause on a grandparent decided when it settles, the step made only when its
    parents are; a step skipped before its parents settle;
  - fan-out: items in order, refs `step:n`; an empty list skipped; the join's child decided only when
    every item is done, archived or stood in, linked to the done ones and the stand-ins;
  - caps: a fan-out over the instance's 500 from a block path skipped with its reason;
  - routes and stand-ins: once per event; the fourth `over_limit`; per item; a stand-in's result read in
    place, and winning over a later own completion; a helper leaving dependents waiting;
  - totality: a result of the wrong type read as false; an unknown step unsettled.
- **Unit, output checking at completion**: each type's refusal, word for word; missing; the list's
  `max` and the instance's 500, `too_large`; items empty, repeated, holding a secret, holding a line
  break when `{{item}}` is in a title; outputs checked on `complete` from `open` and on `review`, not on
  an approval; a person's done refused on a step with outputs; no gate run on a refusal; the run
  undecided after it and its next report taken.
- **Unit, the writer**: each transition of §9.1 deciding, and the others not; exactly once under a
  replay of the same transition, a transaction retried after `SQLITE_BUSY`, two settlings in either
  order, and a reconciliation after a restart, each leaving one row and one task; a fault in the
  routing rolling back its savepoint only, the completion kept, `workflow_route_failed` written, and
  reconciliation deciding it; the 500 re-checked in the transaction; a made task's links, subscriptions
  copied from the first member in a thread, gates, member row and `created` payload; a removed role's
  task made and blocked; `archiveWorkflow` skipping every waiting row and making nothing; a workflow
  with no new key writing no plan and no row, its DAG and hash byte for byte as before.
- **Unit, the file rules**, through `workflow check`: each row of §6's table, message for message;
  the two `for_each` forms; `{{step.output}}` allowed in a pending step's title and body and refused
  elsewhere; the step lines and counts; the outputs sentence past 8 KiB refused.
- **Unit, seeing it**: `workflow show`'s lines for each state, its order by step, the failed-routing
  line, `--json`'s `steps`, `--plan`; the status with waiting, skipped and stood-in steps; the notices'
  text, batched, masked, and no wake; preview's lines and first line; `preview --json` refused for a
  routed file; the start's answer's `waiting`; `reconcile`'s answers and refusals.
- **Unit, the worker's `unblock`**: a handler's run unblocking its routed task with a comment; refused
  `wrong_task` for another task or a run that is no handler's, `stale` after the block was lifted.
- **End to end, a vi-style instance** from a fake chat, through the real socket and the fake CLI agent:
  `intake` completes with `{"kind": "cve", "verify": false, "patch": false, "bnpm": false, "packages":
  ["lodash", "minimist", "qs"]}`, after one refused report without `packages`; `verify` and `registry`
  are skipped and `exposure`, here a child of `intake`, fans out into three tasks, in one notice; the
  items complete; `va` reaches its failure limit and gives up, `escalate` is routed and stands in; its completion makes
  `report`, linked to the three items and to `escalate`, which joins and is reviewed; `patch` is skipped;
  the instance ends `done`; a gateway restart in the middle decides nothing twice.

## 18. Smoke

1. Fold the real `vi-workflow`, `-verify`, `-patch`, `-verify-patch`, `vi-supplychain` and
   `-supplychain-bnpm` into one file as §1 does, with their bodies and gates whole, and run `mt workflow
   check vi-workflow`: `ok`, the step lines of §6.
2. Preview it in chat: one task now, and the pending steps with their words.
3. Start it for a CVE in the vi chat; the intake reports `verify: false`; see `verify` skipped in one
   notice in the thread.
4. Report `packages` with 101 items: refused, the agent reports again; then three items: three
   exposure tasks, named in one notice.
5. Stop the gateway while an exposure runs; start it; `workflows: reconciled …` says nothing was due,
   and the instance goes on.
6. Make `va` give up (a failing gate, `failure_limit: 1`): `escalate` is routed; have it `mt kanban
   unblock` va once, va gives up again, `escalate:2` is made; its completion stands in.
7. `/kanban workflow show w_…` at each stage, against §12.1; `mt kanban workflow show w_… --plan`.
8. Start it again for a supply-chain CSV with `bnpm: true`: `va` and `verify` skipped, `registry` made,
   `report` joining `exposure` and `registry`.
9. Start an old file, unchanged: the same DAG hash as before the build, no plan.

## 19. Limits

- **Caps**: a fan-out at most its `max`, at most 100; an instance at most **500 tasks** in all, the
  start's at most 100 as today (workflows spec §3, §5). A result over either is refused at the
  completion, never cut. *This amends workflows spec §3*: 100 is the start's bound, 500 the instance's.
- **At most 3 routes per routed task** (§5.3), then `wait`.
- **No expressions**: the five tests and four states, one `any` group.
- **No clause on a fan-out step, and no fan-out over a fan-out**; no item pairing (workflows spec §17).
- **No clause on a list output**: a list is read by a fan-out only.
- **No optional outputs**, and outputs only from a role's run.
- **Handlers do not chain**, and a handler takes no parents.
- **Routing on a person's block or stop**: none (§5.1).
- **No routing in a DAG**: `apply`, `apply-dag` and `preview --json` stay fixed graphs (§13.5).
- **The plan is frozen**: no step of an instance is added or changed after its start, the routing's
  own late tasks aside (workflows spec §11).
- **A late task's title and body are cut** to `task new`'s limits, not refused (§7.4).
- **A stood-in task stays blocked on the board** until someone archives it (§5.2).

## 20. Decisions

Where the code forced a detail the design did not settle:

1. **`skipped` is a pending-row state only, not a task phase.** `kanban_tasks.phase` has a `CHECK`
   listing its five values (`003_kanban.sql`), which SQLite cannot widen without rebuilding the
   kernel's live table, and `PHASES`, the display status, the dispatcher's claimable query, the board
   counts and every renderer would each learn a sixth phase for something no person or agent ever
   works on. A skipped step never becomes a task, so it has no row to carry a phase: its row in
   `kanban_workflow_pending` says so, the instance's status reads it (§12.4), and the board's core is
   unchanged.
2. **The steps below a pending step are pending too**, and so are the children of a step a handler
   may stand in for (§7.1): links need both rows and are never deleted.
3. **A step is skipped as soon as its `when` is certainly false**, and made only once it is true and
   its parents are settled (§3.2), so a made task is claimable at once and the join needs no hold.
4. **`state: blocked` and `state: gave_up` are decided at the transition** (§3.2), as a blocked step
   is unsettled; a parent read by a true one is not linked.
5. **Accepted results are `latestCompletion`'s metadata of a `done` task** (§2.3), the review's
   handoff rule kept; a value of the wrong type reads as missing.
6. **The outputs check is the service's, before the gates, code `invalid`** (§2.2), on work reports
   only; the bound of 500 `too_large`, re-checked in the writer.
7. **Outputs are top-level keys of `metadata`**, and the agent is told by one sentence added to the
   task's `outcome` (§2.1), as the prompt reads no workflow table.
8. **The join marker is the fan-out's pending row with its `items`** (§4.2), not a gate.
9. **Routes are rows of their own**, `kanban_workflow_routes`, keyed (instance, handler, event), with
   `over_limit` for the fourth (§8); counted per routed task.
10. **`decide` is pure, in `routing.ts`, imported by `db/kanban.ts`** (§9.3); the team is passed by the
    service as one optional argument; the routing runs in a savepoint, a refusal it means refusing the
    completion and a fault rolling back only itself (§9.4).
11. **Late tasks copy the first member's subscriptions** (§7.4), as a chat start's thread is moved
    after the start; their wake is frozen in the plan, but a run's start's, inherited at the making.
12. **Conditions are workflow starts' only**: no DAG format change, `preview --json` refused for a
    routed file, `show --plan` beside `--dag` (§13.5).
13. **The notice is one `workflow_routed` event on the transitioning task** (§12.2), rendered from its
    payload, no wake; there is no instance event table, as an event belongs to a task (workflows spec
    §7), and the pending and route rows are the instance's own record.
14. **Reconciliation is the same helper**, at start and as `mt kanban workflow reconcile` (§11).
15. **A handler with no workspace of its own works in the routed task's** (§5.2), and is made with no
    link.
16. **Persons' blocks and stops route nothing**, by the wake's rule on the event's actor (§5.1).
17. **`archiveWorkflow` skips every waiting step** without deciding (§9.1).
18. **Late titles and bodies are cut**, as a reaction task's (§7.4); the start checks templates with
    placeholders so a template too long is refused at the start.

## 21. Departures from the approved design

1. **More steps are pending than the three kinds named.** Approved: "every other step", a step with
   `when`, result `for_each` or `handler: true`, becomes a pending row. Written: also every step below
   a pending step, and every child of a step a handler may stand in for (§7.1, decision 2), as a link
   needs its parent's row and is never removed. A file with no new key is untouched.
2. **A second table, and a column.** Approved: one table, `kanban_workflow_pending (instance, step,
   state)`, and the plan stored by the instance. Written: that table with `reason`, `items`,
   `cause_event` and `decided_at`; a second, `kanban_workflow_routes`, for the approved route key
   (instance, handler, transition event), which a row keyed (instance, step) cannot hold; and the plan
   as a new `plan` column, so the stored DAG and its hash stay as they are.
3. **"Skipped, with an instance event"** is the pending row plus a `workflow_routed` event on the task
   whose transition decided it: `kanban_events` rows belong to a task (workflows spec §7), and the
   notifier delivers per task's subscription.
4. **`state: blocked` and `state: gave_up`** are decided at the transition, not when the ancestor
   settles (§3.2), as approved "waiting while an ancestor it reads is unsettled" would make them never
   true. A step is also skipped before its parents settle when its `when` is already false.
5. **A handler's `unblock` needs a worker command that does not exist.** Approved: the helper
   "investigates, comments or unblocks". A run cannot unblock another task today, so the worker API
   gains `mt kanban unblock`, scoped to the task the handler was routed from (§5.4).
6. **"At most 3 times per step"** is counted per routed task, so each item of a fan-out has its own 3
   (§5.3); for a step that is no fan-out, the same as approved.
7. **The refusal messages** are the `message` of the worker's JSON refusal, `{"ok": false, "code":
   "invalid", …}`; there is no `refused:` prefix, which the worker CLI does not print.
8. **Outputs are a role's.** A person's done carries no metadata, so a step with outputs must be a
   role's, checked by `workflow check` and at the start (§2.1).
9. **Late titles and bodies are cut** to their limits rather than refused (§7.4); the approved "never
   cut" is kept for what it named, the fan-out and instance caps.
10. **Conditions are not in DAGs** (§13.5): `preview --json` of a routed file is refused, where every
    file today previews to an applicable DAG.
11. **Values from results do not reach the contract fields**, only titles and bodies, as approved; the
    outputs sentence the expansion adds to `outcome` (§2.1) is the file's, not a result's.

## 22. Open questions for the user

1. **A person's step with outputs.** Refused by the check (§2.1, departure 8). Should a person be able
   to give outputs from chat instead, as field lines on `/kanban task done` (`reachable: false`)? It
   would need chat's parser and the card to carry them.
2. **The handler's `mt kanban unblock`** (§5.4, departure 5): keep it, or let helpers only comment,
   unblocking staying a person's?
3. **Routes per item or per step** (§5.3, departure 6): 3 for each item of a fan-out, or 3 for the
   whole step across its items?
4. **A stood-in task** stays blocked on the board, the instance counting it finished (§5.2). Should the
   stand-in's acceptance archive it instead, so the board is clean and can be archived?
5. **A skipped step's output in a title** fills nothing (§7.4). Would you rather it read `(skipped)`?
6. **The verb** `mt kanban workflow reconcile` (§11), after the boot's own word; or another name?
7. **Routing on a person's block or stop** is off (§5.1). Should `on_blocked` also route a person's
   `/kanban task block`?
