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
could not be built as approved is written in its closest faithful form and listed in §21. *Revised
after review round 1*, with the user's answers to all seven of the first draft's open questions (§20,
"Decided by the user").

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
  its children once its own parents are.
- **`for_each: { step, output }`**: one task per item of an ancestor's accepted list output (§4),
  the children joining on every item.
- **`on_blocked` and `on_gave_up`**: a step whose work blocks or gives up either waits, as today, or
  is routed to a **handler** step (§5), which is made for that transition, helps, or stands in for
  the step it was routed from.

**Approach A, lazy materialization.** At the start, in the existing single transaction (workflows
spec §8), the plain steps become tasks and links, as today. Every other step but a handler becomes
a row of `kanban_workflow_pending` (§8), `waiting`; a handler has no row, its routes being its record.
The instance keeps its **plan**, frozen: each step's `when`, `for_each`, `outputs`, routes and
template (§7). When a member settles, blocks or gives up, the writer's transaction that records it
calls a pure `decide(plan, facts)` (§10), and makes, skips, fans out or routes what is now due, in
the same transaction (§9). **Editing the file never changes a running instance**, and **a workflow
using none of the new keys expands exactly as now**: no plan, no pending row, the same DAG, the same
hash.

**Nothing in the kernel learns about workflows** (workflows spec §0). The dispatcher, the claim, the
prompt and the waker read no workflow table; a task made late is an ordinary task, claimed,
reported, woken and archived as any other. The writer, `db/kanban.ts`, already writes the workflow
tables (workflows spec §8); it now also reads them inside the transitions that settle, block or
give up a task (§9). The notifier renders two new events from their payloads alone, as it renders
`workflow_started` (workflows spec §18.2). The dispatcher's pass calls one service hook that retries
a failed routing (§9.4), and reads no workflow table itself. *This amends workflows spec §0*, where
the writer's transitions read no workflow table.

## 1. The file

The vi assessment, folded into one file (bodies and contracts cut here; §18 runs it whole):

```yaml
description: CVE or supply-chain assessment, routed by its intake
board: vi
params:
  case: { required: true, description: "a CVE id, or the absolute path of a package CSV" }
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
ancestor's list output`. A param fan-out is text and a result fan-out always a mapping, so
`for_each: intake` is the param `intake` or a check error, never the step.

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
  the check foresee the most an instance can make.
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
- **A step with outputs is a role's** (decided by the user, §20). A person's done carries no
  metadata (`/kanban task done` takes a summary alone, `chat.ts`), so `workflow check` refuses
  `outputs` on a step whose assignee is written as a person, `lark:…` or `{ person: … }`, and a start
  refuses one whose assignee param names a person, naming the step: `steps.va declares outputs, which
  a role's run reports in its metadata, and its assignee is a person: a person's done gives none`.

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
  (§2.1), is refused by the same check: it carries no metadata.
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

  Each is said once, the first found, in the outputs' declared order; a value is quoted masked and
  cut at 80 characters, by `shown`, which `src/kanban/dag.ts` exports for this.
- **The instance's cap is a reservation at the reporting completion.** The report whose list a
  fan-out will read is the one checked against the instance's 500 tasks (§19): the members made, plus
  this list's items for each fan-out over it (handlers among the members made), plus one for each step this result could make, is at
  most 500, else `too_large`: `output packages would make 63 tasks, and instance w_… has 470 of its
  500`. The check is the service's, before the gates, at that run's report, where the agent can still
  shorten the list.
- **The writer never refuses a completion for the cap.** Two reports may pass the reservation at once,
  a reviewer's approval may come long after its work's report, and a stand-in's completion settles
  another step; whatever passes 500 in the transaction that decides is **skipped**, with the reason
  `the instance has 500 tasks` and a notice (§9.4, §12.2), never refused and never cut.

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
| done, then archived | the same as when it was done: its `archived` event's payload says `from: done` (§3.1) |
| not `done` | none |

- **Only an accepted result counts as success.** `state: done`, a clause on an output, a fan-out's
  source and a `{{step.output}}` are satisfied only by an accepted result: the original task's, or an
  authorised stand-in's (§5.2). **An archive is never a result.** A manual archive of an undone task can
  only resolve its member as explicitly skipped, `archived`, with no outputs: a clause on its output is
  false, a fan-out over it is skipped, and its children are decided by §3.2. "First wins" (below)
  chooses between an accepted result and an archive-skip, never makes an archive a result.
- **Done, then archived, keeps its result**: a task whose completion was accepted and which was archived
  later, its `archived` event saying `from: done`, keeps its accepted result, because the accepted
  completion is a settling fact with an earlier event id than the archive, which comes after it and so
  never wins; the archive only puts the task away.
- **Every reader of a result reads the logical step's result**: an output clause, `state: done`, a
  fan-out and a template read the member's settled row (§8), whose winner is the original or an authorised stand-in, never the original
  task's own phase. A step stood in for, whose original task the stand-in archived (§5.2), reads as
  `done` with the stand-in's outputs. `state: blocked` and `state: gave_up` read no result at all: they
  read the trigger event, before any settling (§3.1).
- **A result from a run whose review asked for changes never counts**: `latestCompletion` reads the
  latest `review_requested`, which is the rework's once it asks again, and a task in `open` has no
  accepted result at all.
- **The result is frozen per member, at its settling** (§8, `kanban_workflow_settled`, keyed
  `(instance_id, step, ref)`): a step that is no fan-out has one row, its ref the step's; a fan-out has
  one row an item, its ref the item's (`exposure:2`), and one row of its own, its ref the step's name,
  written only once every item has its row. A member's row names the task whose result is the
  member's, its own or a stand-in's, and every later read takes that task's result.
- **The winner is path-independent**: the **earliest settling fact by event id**, among the member's own task's `completed` event, each
  of its stand-ins' `completed` events, and the own task's `archived` event whose `from` is not `done` (the member is then `archived`, skipped by archive,
  with no result), whichever transaction or reconciliation writes the row (§9.2). Nothing that happens
  afterwards, an unblock, a later stand-in, an own completion after a stand-in's, an archive, changes
  which result is read. A winning stand-in's archive of the routed task (§5.2) always comes after the
  stand-in's `completed` event, so it is never the earliest fact, and never read as a skip.
- A value that is not of its type when read, which only a database edited by hand can hold, reads as
  missing: a clause on it is false (§3). The metadata is stored masked (`maskDeep`), so what decides
  is the masked value; an item holding a known secret was refused at the completion.

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
  expressions, no arithmetic, no reference to a param.
- **All clauses must hold**, and of an `any` group, at least one. One `any` at most, as approved.
- **A clause on a skipped step's output is false, not an error.** A stood-in step's outputs are its
  stand-in's, which declares the same ones (§5).
- **No clause reads a fan-out step**: its result is one an item. `workflow check` refuses one (§6).
- **No clause reads a handler**: a handler is no step's ancestor (§5.2, §6).

### 3.1 States

A step's **state**, as a clause reads it, is the phase of its tasks plus how they got there:

| State | When it is true |
|---|---|
| `done` | its settled row's winner is an accepted result, the original's or an authorised stand-in's (§2.3); a task done and then archived stays `done`, as its accepted completion came first |
| `skipped` | the step was skipped (§3.2), or its settled row is an archive of its task undone, **skipped by archive**, with no outputs |
| `blocked` | its task entered `blocked` from its work by one of `on_blocked`'s triggers (§5.1) |
| `gave_up` | its task entered `blocked` from its work by one of `on_gave_up`'s triggers (§5.1): the breaker's `gave_up`, or the transient limit's block |

**What each clause reads**, side by side:

| Clause | Reads | Before that |
|---|---|---|
| an output clause, `state: done`, a fan-out's source, a `{{step.output}}` | the ancestor's settled, accepted result: its settled row's winner (§2.3) | undecided while the ancestor is unsettled; false (a fan-out skipped, a title `(skipped)`) once it is skipped |
| `state: skipped` | the ancestor's settled row: `skipped` or `archived` | undecided while unsettled; false once it settles `done` |
| `state: blocked`, `state: gave_up` | the ancestor's **trigger event** by §5.1's table, at the moment it is written, before and without any settling | undecided until the event, or false once the ancestor settles without it; they could never be true if they waited for a settling, as a blocked step is unsettled |

**Once decided, a decision is frozen** (§3.2): a step made because `state: blocked` held stays made,
and the clause stays held for that decision, though the ancestor is unblocked and done later; a step
skipped because an output clause was false stays skipped.

`archived` is not a state a clause names. A result-reading clause reads the step's settled row, never
its task's phase: an archive of a task undone is skipped by archive; a task archived after its accepted completion
is `done`, as its row's winner is that completion. A gateway `blocked` written
by the team check of a task made late (§7.4) is neither `blocked` for a clause nor a route (§5.1).

### 3.2 When a clause is decided, and when a step is

- **A step is settled** when it is `done` (its member's winning completion, its own task's or a done
  stand-in's, §2.3, §5.2), when its row is `skipped` **and every parent of it is settled**, or, for a fan-out, when every
  item is (§4.2). So a skipped step holds its children until its own ancestors are through: an early
  skip never lets a descendant run before an ancestor still at work.
- **A clause is decided** once its ancestor is settled: an output clause by the accepted result, a
  `state: done` or `state: skipped` clause by how it settled.
- **A `state: blocked` or `state: gave_up` clause is decided at the transition**: true the moment the
  ancestor's task enters that state from its work, false once the ancestor settles without having
  entered it. A blocked or gave-up step is unsettled (§4.2), so a clause on it decided only at
  settling could never be true; it reads "the step blocked on the way", the approved "how it got
  there".
- **A step is skipped as soon as its `when` is certainly false**: a clause false, or an `any` group
  every clause of which is false. Its row is `skipped` at once, and its notice said; it counts as
  settled for its children only once its own parents are (above).
- **A step is made once its `when` is certainly true and every parent step is settled.** It is made
  with links to its **effective parents** (below), which are all done, so it is claimable at once
  (kanban spec §4.1). A parent read by a true `blocked` or `gave_up` clause is not waited for and not
  linked: the step was made because that parent is stuck.
- **Effective parents.** For each parent step: a done step gives its winning task, its own or the
  stand-in in its place (§5.2), or for a fan-out each item's winning task; **a winning task done and
  then archived is still given**, and linked, as the kernel treats an archived parent as finished
  (kanban spec §4.1) and its handoff is kept (`latestCompletion` reads its events whatever its phase),
  so a child of done-then-archived parents keeps its handoffs and is never made with no link. **It
  keeps the handoff, not the branch**: in an isolated workspace, `#upstream` (`src/kanban/worktree.ts`)
  merges only parents whose phase is `done`, so an archived parent's branch is not merged in; a
  step skipped by its `when` or by an empty or skipped source gives, in its place, its own effective
  parents, recursively; a step skipped by archive gives none. So a child keeps its nearest settled,
  non-skipped ancestors as parents: their handoffs reach its prompt (kanban spec §7.1), their order
  holds, and in an isolated workspace its worktree starts from their branches (kanban spec §18.5).
  `report` above, with `verify` skipped, is linked to `va`'s task (or its stand-in), to the exposure
  items, and to `registry`'s task if it was made. **No link goes to a task archived undone**, and every
  link goes to a task that was done.
- **Rewiring past a skipped parent preserves ordering only.** Effective parents give the made task its
  links, so its order, and its parents' handoffs as prompt context (kanban spec §7.1); **never
  outputs**. A clause, a fan-out or a `{{step.output}}` on a skipped step reads that step, not the
  ancestors it was rewired to: a clause on a skipped step's output is false, and a fan-out over it is
  skipped. `(skipped)` (§7.4) is a **display placeholder in titles and bodies only**, never a value a
  condition, a fan-out or anything else reads.
- **Skipped by archive spreads.** A step **counts as skipped by archive** when its task was archived
  undone, or when it was skipped otherwise (by its `when`, its source or the cap) and every one of its
  parents counts as skipped by archive. A step whose parents all count so is **skipped by archive** too, `its parents were archived`, never
  made with no link: archiving is how a case is put away, not how it is let through. A step with
  some parents archived and others settled otherwise is decided by the others.
- **Effective parents are empty only by archive.** Roots are plain (§7.1), so made at the start and
  settled done or archived; every chain of skipped steps ends at a done task, which is given, or at
  an archive, which the rule above turns into a skip. So a made step always has a link, but for a
  parent read by a true `blocked` or `gave_up` clause (above), which is not linked by design.
- **Decided once.** Each pending step is decided exactly once (§9), and never again.

## 4. Result-driven fan-out and the join

### 4.1 The fan-out

`for_each: { step: intake, output: packages }` makes one task per item of `intake`'s accepted
`packages`, in the list's order, each with `{{item}}` set to its item, as a param fan-out does
(workflows spec §3).

- **When.** Only once the named step is settled `done`, its review included (kanban spec §5.3), and
  from the frozen accepted result of its settled row's winner (§2.3); and as any pending step, once its
  `when` holds and its parents are settled (§3.2).
- **The source is the logical step, never its task's phase.** A source settled by a stand-in fans out
  from the **stand-in's accepted list**, though its original task was archived by the stand-in (§5.2).
  A source done and archived later fans out from its own accepted list. Only a source whose settled row
  is `skipped` or `archived` (an archive of its task undone) **skips the fan-out**, `intake was skipped`
  or `intake was archived`, as there is no accepted list to read.
- **The source is an ancestor, and its output a list.** `workflow check` refuses a non-ancestor, an
  undeclared output, and an output of another type (§6).
- **The items** are the list's values, texts as given, numbers and booleans as JSON writes them,
  each trimmed, none empty or twice, none holding a known secret, and, when `{{item}}` lands in a
  title, none holding a line break, control character or bidi control: a list param's rules
  (workflows spec §3), checked at the completion that reports the list (§2.2), not at the fan-out,
  which is never refused (§9).
- **An empty list skips the step**, `intake.packages is empty`. *This amends workflows spec §3*, where
  an empty list param is refused at the start: a param is the starter's, who can give another, and a
  result is the case's, which may truly have no packages.
- **Refs** are `<step>:<n>`, as a param fan-out's (workflows spec §5), the item in the member row's
  `item`, masked.
- **No fan-out over another fan-out's items.** A `for_each` whose `step` is a fan-out step, of either
  form, is refused by `workflow check` (§6). Item pairing stays out (workflows spec §17).

### 4.2 The join

**The join marker is the fan-out step's own pending row**, not a gate: once fanned out, the row is
`made`, and its `items` column holds the item set, each item with its task's id and ref (§8). A gate
cannot be the marker: a gate is a shell command run at a report (kanban spec §7.7), not a hold on a
claim.

- **A fan-out step is settled once every item is settled**: its task done, its task skipped by
  archive, or stood in for by a done handler (§5.2), each item by its own settled row; the step's own
  row is written then, and not before (§8). **First one wins per item**: two stand-ins of one item,
  or an item's own completion after its stand-in's, settle that item once, by the earliest settling
  fact (§2.3). **A fan-out whose items are all archived undone counts as skipped by archive**: its own
  row's `how` is `archived`; with any item done or stood in for, its own row's `how` is `done`.
- **A child of a fan-out waits for that.** It is pending (§7), decided only when its fan-out parent
  is settled (§3.2), and made with its effective parents: each item's winning task, its own or its
  stand-in, and no item archived undone.
- **A blocked or gave-up item holds the join under its own rules**: with `wait`, until a person
  unblocks it and it is done, or archives it; with a route to a helper, the same, while the helper
  works; with a stand-in, until the stand-in is done, which archives the item (§5.2).
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
- **Which transitions.** Each trigger event once, from the code (`block` and `endRun`, `db/kanban.ts`):

  | Trigger | Event | Routes by |
  |---|---|---|
  | a run's own `block`, `needs_input`, `capability` or `transient` | `blocked`, actor `run:<run_id>`, `kind` not `dependency` | `on_blocked` |
  | a run's end refused by the provider (`terminal_provider`) | `run_ended`, `next: blocked`, `blockKind: capability` | `on_blocked` |
  | a cautious retry (`if-no-side-effects`, a run that may have changed things) | `run_ended`, `next: blocked`, `blockKind: needs_input` | `on_blocked` |
  | a run whose directory cannot be made (`ending.block`) | `run_ended`, `next: blocked`, `blockKind: needs_input` | `on_blocked` |
  | the breaker, at the failure limit after `failed`, `crashed`, `timed_out` or `protocol_violation` runs | `run_ended`, `next: blocked`, `blockKind: gave_up` | `on_gave_up` |
  | the transient limit, `rate_limited` that many times in a row (`transientLimit`, 10) | `run_ended`, `next: blocked`, `blockKind: transient` | `on_gave_up` |

  The two `on_gave_up` rows are the **terminal failure endings**: the board stopped retrying by its own
  limit. The code has no other ending that blocks: `interrupted` retries, or blocks `needs_input` only as
  a cautious retry (third row); a cooldown blocks nothing. A run's own `transient` block is a run's
  report, so `on_blocked`; the transient limit's is the board giving up, so `on_gave_up`, which the
  `state: gave_up` clause reads the same way (§3.1). A `dependency` block never sits in `blocked`
  (kanban spec §5.4) and is no trigger.
- **Only from the work.** A transition routes only when the task blocks from `open`, its
  `blocked_from` being `open`. A block or give-up of a **review** run waits: the work is done, the
  review is a reviewer's, and a handler standing in for the step would settle it past its own
  reviewer.
- **A person's block and a person's stop route nothing** (decided by the user, §20): only a run's blocks
  route; a person blocking or stopping is a person acting already, as the
  wake spec reasons for its outcomes (wake spec §2.2, §2.3). Nor does a gateway `blocked` written by
  the team check (§7.4), nor `stopped`. The table above is the whole list.
- **No route from a member already settled.** A task whose member a stand-in has settled is archived
  by it (§5.2), so it cannot block again; and the writer routes no transition of a task whose member
  (the step, or its item) has its settled row (§8). **The first to complete wins**, per member.
- **A fan-out step's routes are per item**: each item's task is routed for its own transitions, the
  handler made for that item, `{{item}}` set to it.
- **A handler's own `on_blocked` and `on_gave_up` are `wait`**: `workflow check` refuses a route from
  a handler, so routes never chain.

### 5.2 Handlers

```yaml
  escalate:
    handler: true
    stands_in_for: va                  # optional; requires the same outputs as va
    outputs:
      reachable: boolean
```

- **A handler is made only when routed to**, never at the start and never by `decide`'s other
  outcomes, and has **no pending row**: its route rows are its record (§8). A handler never routed to
  leaves nothing behind, and an instance with one reaches `done` as if it were not in the file.
- **It takes no `parents`, `when` or `for_each`**, and is made with **no link**, as the task it handles
  is blocked and a link would hold it behind that task. No other step may name it in `parents`,
  `when` or `for_each` (§6): it is no step's ancestor. Its other fields are a step's.
- **Its ancestors**, for its `{{step.output}}` references, are the routed step's, the routed step
  itself excluded, as it has no result: so `escalate` may read `{{intake.kind}}`.
- **Its context comes from records.** The source task's id, its step and item, and its directory are
  read from the route row (`kanban_workflow_routes`: `from_task`, the handler's `task_id`) and the board's
  own rows (the source's member row, its `kanban_tasks` row, its worktree row for the path). **`mt kanban
  unblock` (§5.4), and anything else a handler is allowed, is authorised by those records alone.** The
  paragraph below only describes them: editing a body, or a body cut at 64 KiB, changes no authority.
- **Its body gains a fixed paragraph at the making**, after the file's, so the agent knows what it
  handles while the prompt stays workflow-agnostic (kanban spec §7.1 renders the body as it is):

  ```
  Routed from `k_…` (step va, item lodash): it gave up: failed 2 times; last crashed.
  Its directory: /home/mt/worktrees/k_… (when it has one of its own)
  This task stands in for it: your accepted completion is read in va's place, and archives it.
  `mt kanban unblock` with {"task_id": "k_…", "comment": "…"} returns it to work instead.
  ```

  The second sentence is `It blocked (capability): <reason>.` for a block; the third is `This task
  helps it: its dependents wait for it, not for you.` without `stands_in_for`. The paragraph is the
  board's text, masked on write as the body is, and **kept whole**: when the body would pass its 64 KiB,
  only the file's part of it is cut (`cutToBytes`, §7.4), so the paragraph always reaches the agent. Its
  second sentence for the transient limit is `It stopped after 10 throttles: <reason>.`
- **The worker's `show`** of a handler's task returns `routed_from`, `{"task_id", "step", "item",
  "event_id"}`, read from its route row and the source's member row, so an agent can read its source
  from the records whatever its body says.
- **Where it works.** A handler whose step names no workspace, and whose role names none, is made
  with the routed task's workspace when that is fixed: it is there to look at that task's work, and
  kanban spec §2.3's rule 3 would give it the board's, as it has no parents.
- **Its worktree base.** In an isolated workspace (kanban spec §18), a task's worktree starts from its
  parents' branches, or with none from its `created_from_task`'s (`#upstream`,
  `src/kanban/worktree.ts`). A handler has no parent, and making the routed task its
  `created_from_task` would give that task's later runs the right to link it (kanban spec §7.2) and
  change a run's start's inherited wake; there is no simple non-gating source. So there are **two
  cases**, with no code change: in a chat's or a terminal's start, **a handler starts from the
  workspace's base**, as it has no parent and no `created_from_task`; in a **run's start**, its
  `created_from_task` is the run's task, as every member's is (§7.4), and `#upstream` starts it from
  that creating task's branch, when it has one in the same workspace. In both, it reads the routed
  task's work at the directory its paragraph names, which helps only if its agent may read outside its
  own worktree (the guide says so, §16).
  The skipped case needs nothing more: a child of a skipped step is linked to its effective parents
  (§3.2), whose branches it starts from.
- **`{{item}}`** in a handler is the routed item's; `workflow check` allows it only when every step
  routing to it is a fan-out step.
- **Without `stands_in_for`, the handler only helps**: it investigates, comments, or unblocks the task
  it was routed from (§5.4), and that task's dependents keep waiting for it, under its own rules.
- **With `stands_in_for: <step>`**, which must be one of the steps that route to it, and declare
  exactly the same outputs, name for name and type for type: **the handler's accepted completion
  settles that step for its dependents**, its outputs read in that step's place.
  - **Its review is the step's.** A stand-in for a step that has a reviewer is made with that step's
    reviewer, as the plan resolved it at the start, so its completion asks for review (kanban spec §5.3)
    and counts, as an accepted result, only once that review passes. A stand-in handler takes no
    `reviewer` of its own: `workflow check` refuses one (§6).
  - **Its outputs are checked as the step's.** Its work report goes through the same output check
    (§2.2), as its step declares the same outputs; a stand-in whose assignee is a person, which could
    give none, is refused by the check (§2.1, §6).
  - **Its gates include the step's.** The stand-in's task is made with every gate of the step it stands
    in for, as the plan holds them (§7.3), in the step's order, and then its own, each through
    `insertGate` by the instance's creator. They run at its report (kanban spec §7.7) in its own
    directory, as any task's gates do, so it must produce there the artifacts the step promised (for
    `va`, `result.json` passing `vi-workflow-gate`); a gate that fails refuses the report, the run
    undecided, and its completion counts only when every gate passes. A stand-in for a fan-out item
    takes the fan-out step's gates.
  - **Its contract includes the step's.** A task's contract is five text fields, stored as one JSON
    object of masked text (`kanban_tasks.contract`, `maskContract` in `db/kanban.ts`) and rendered in
    the prompt one labelled field at a time (kanban spec §7.1, §4.3). So the merge is per field: for each
    of `outcome`, `verification`, `constraints`, `boundaries` and `stop_when`, when the step sets it, the
    stand-in's field is `the step's (va): <the step's text>`; when the handler sets it too, a blank line
    and `this handler's: <its text>` follow. A field only the handler sets is its text alone. The
    handler's fields are added, never replacing the step's, and its reviewer, the step's, reviews
    against both. The step's `outcome` carries its outputs sentence (§2.1), so the stand-in's does too.
    Each merged field is held to the contract field's 8 KiB, checked at the start with the rest of the
    templates (§6), never cut.
  - **Frozen at the start.** The step's reviewer, outputs, gates and contract are read from the plan's
    entry for the step (§7.3), as resolved at the start, never from the file at the making.
  - In the transaction of its accepted completion (decided by the user, §20):
  - the routed member's settled row (§8) is written with the winner, the earliest settling fact by
    event id (§2.3). If the winner is another, an earlier stand-in, the routed task's own completion or
    its archive undone, **this completion settles nothing and archives nothing** but closes its own task;
  - when this stand-in wins, and only then, **the routed task is archived unless it is already
    archived** (a person archived it after its own done, which is no settling fact, §2.3; the sweep
    then writes only the row), whatever phase it is in,
    `blocked`, `open` with a rerun after a handler's unblock, or `review`, through `archiveIn`
    (`db/kanban.ts`), which supersedes its undecided run and writes `from: <its actual phase>`, the
    payload gaining `workflow: "w_…"` and `standIn: "k_…"`, with a comment, not steering: `Stood in for
    by escalate:1 (k_…), whose result is read in va's place.`. **The runs it superseded are
    cancelled** on every path (§9.5). A task already done, the loser, is archived `from: done`, its
    result unread;
    Its chat hears no notice for the archive (an archive is none, kanban spec §9.4), but the
    `workflow_routed` notice says it stood in (§12.2). The routing does not read this archive as
    skipped by archive: the step's settled row was written first, and wins.
  - So the board is left clean, and can be archived once the instance is through (kanban spec §16.8).
- **A handler left open** after its member was settled by the routed task's own completion (it was
  unblocked and done first) gets one comment, written with the insert of the member's settled row and
  only when that insert adds the row, so a reconciliation never writes it twice, not steering, `va was completed by
  its own task k_…; this handler's result will not be read: finish or archive it`, and a line of the
  `workflow_routed` notice. Nothing archives it: it may be mid-run, and a person decides. It keeps the
  instance running until it is done or archived (§12.4).

### 5.3 Once per transition, at most 3 per routed task

- **A route is keyed on the transition's event**: the `blocked` or `run_ended` event that blocked the
  task. Its row's key is (instance, handler, event id) (§8), so a replay of the transition, a retried
  transaction or a reconciliation (§11) makes no second handler.
- **At most 3 routes per routed task** (decided by the user, §20), counting only `made` route rows, not
  `over_limit` or `over_cap`: each item of a fan-out has its own
  3, and for a step that is no fan-out its task's 3 are the step's. A task routed 3 times, whose next
  block would route again, falls back to `wait`: no handler is made, and a route row records
  `over_limit` with that event's id, so the notice (§12.2) is said once: `` `k_…` va gave up again, and
  has been routed to escalate 3 times: it waits for a person now (/kanban task unblock k_… [comment])
  ``, its first clause `va stopped after 10 throttles again` for the transient limit, and `va blocked
  again` for an `on_blocked` trigger.
- **At the cap.** A route that would pass the instance's 500 tasks records `over_cap` instead, and
  falls back to `wait` with its notice, `the instance has 500 tasks`, so it is never tried again for
  that event.
- **Due only while the block stands.** A route is due for a task's current block: the task is
  `blocked` by that event, from its work, with no `unblocked` after it, and its step not settled. A
  block lifted before the route was made, which only a failed routing (§9.4) leaves behind, routes
  nothing when reconciled.
- **A handler's ref** is `<handler>:<n>`, its n-th route in the instance, from 1, unique in the
  instance as refs are (workflows spec §7), and within a ref's 64 bytes.

### 5.4 A handler's run unblocks its task

A run may report on its own task and comment on any (kanban spec §7.3), but no worker command
unblocks another task: `mt kanban task unblock` is the operator's, refused in a run's shell
(`OPERATOR_GROUPS`). So that a helper can unblock (decided by the user, §20), the worker API gains
**`unblock`**, a thirteenth command, scoped as `wake-unblock` is to a reaction task's wake (wake spec
§19.8):

```
mt kanban unblock < {"task_id": "k_…", "comment": "the registry answers again; retried with the mirror"}
```

- **Only a handler's work run**, an agent's, while it may act (kanban spec §7.2), and only for the task
  its route was made from (`kanban_workflow_routes.task_id` is the run's task, found by the index of
  §8), while that task is still blocked by the route's event: the stale check of `unblock`'s
  `blockedAt` (`db/kanban.ts`), given the route's event id. Otherwise `wrong_task`: `run r_… may
  unblock only the task its handler was routed from`, for a review run too; and `stale` once that
  block was lifted by anyone else.
- **Its authority is the operator's file, with no tier.** The operator wrote the route and the
  handler; the run's token proves it is that handler's run. No person's tier is checked, as none is
  behind a run, and the scope is one task's one block.
- **A repeat answers `ok`.** An unblock whose block this same run already lifted, its `unblocked`
  event's actor being the run, answers `{"ok": true, "task_id": "k_…", "phase": "open", "changed":
  false}`, so an agent re-running a command whose answer it missed is not told it failed.
- **What it does is `unblock`'s**: the task returns to the phase it left, a `gave_up` one with a fresh
  set of attempts, a `transient` one with its throttling count reset; its comment, if any, steers the
  next run, prefixed `(by the handler escalate:1) `. The `unblocked` event's actor is the run.
- **Loops are bounded by §5.3**: a task that gives up again routes again, at most 3 times.
- The work protocol (kanban spec §7.1) gives the command no line: the handler's body says it (§5.2).

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
| a handler named in `parents`, `when` or `for_each` | `steps.report.parents names escalate, a handler, which is made only when routed to and is no step's parent` |
| a handler routed from nowhere | `steps.escalate is a handler, and no step routes to it: add on_blocked or on_gave_up: { route: escalate } to the step it handles` |
| a route to a step that is no handler, or to none | `steps.va.on_gave_up routes to report, which is not a handler (handler: true)` |
| `stands_in_for` with other outputs, or naming a step that does not route to it | `steps.escalate stands in for va, and its outputs differ: va declares reachable (boolean), escalate reachable (string)` |
| a stand-in that cannot meet the step's review or outputs: a `reviewer` of its own, or a person's assignee where the step declares outputs | `steps.escalate stands in for va, and takes va's reviewer (role assessment-reviewer): it names none of its own` |
| a stand-in whose gates, the step's and its own together, pass `addGate`'s bounds (20 a task, 600 s together, a gate with no `timeout_s` counted as 300 s), so one of the step's would have to go | `steps.escalate stands in for va, and va's 2 gates with its own 19 are 21: a task has at most 20` |
| a stand-in whose merged contract field passes 8 KiB | `steps.escalate stands in for va: its contract's verification with va's is 9300 bytes; at most 8192` |
| a stand-in whose workspace, written or its role's, certainly differs from the step's (§4's `certainOf`), so the step's gates would run in another checkout | `steps.escalate stands in for va, whose gates run in workspace vi, and escalate works in ops` |
| a handler with `parents`, `when` or `for_each`, or a route from a handler | `steps.escalate is a handler, made with no parents when routed to: it takes no parents` |
| a clause list with two `any` groups, an empty `any`, or a clause with two tests | `steps.verify.when has two any groups; it takes one` |
| `{{step.output}}` in a plain step, a contract field, a name field or a gate | `steps.va.title names {{intake.kind}}, and va is made at the start, before any result` |
| outputs on a person's step | §2.1 |
| a cycle | as today, `the steps' parents make a cycle: …`; a route adds no edge a cycle could close, as a handler has no parents and is no step's parent |

**What a check says of each step.** `mt workflow check <name>` prints, after the workflow's line, one
line a step; chat's and the terminal's preview (§12.3) show the same words. Without a name, each
workflow's one line is unchanged but for its step count:

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
parentheses joined by `or`; `per item of <step>.<output>`, or `per item of <param>`; `handler for
<steps>`, with `, standing in`; and `when its parents are settled` for a pending step with no `when` of
its own. A clause reads `va.reachable is true`, `intake.kind is cve`, `intake.kind is one of cve,
ghsa`, `va.score is at least 7`, `va gave up`, `va blocked`, `va is skipped`, `va is done`.

**What a start checks beyond the file**, before its transaction (workflows spec §6 step 2): every
template as `create` would check it (§7), with every reference to a result filled with a placeholder
of its declared type's widest form, so that a template too long already is refused at the start, not
cut later. **The cap is not a start's**: an instance's 500 is reserved at each reporting completion
(§2.2), and whatever passes it later is skipped (§9.4); a file whose lists' `max` could pass 500 starts,
and preview says how many it could make (§12.3).

## 7. Expansion: plain and pending steps, and the frozen plan

### 7.1 Which steps are plain

**A step is plain** when it has none of `when`, a result `for_each`, or `handler: true`, **and**
every parent of it is plain, **and** no parent of it is the `stands_in_for` of a handler. A handler
is made by routes alone. Every other step is **pending**.

A child of a pending step cannot be made at the start: its links name its parents' tasks, and a
link's foreign key needs the parent's row (`kanban_links`), which a pending parent has not got; made
without it, it would be claimed before its parent is decided. So a pending step's descendants are
pending too (§21). And a child of a step a handler may stand in for is pending, so that it can be
linked to the stand-in once there is one (§3.2): a link is never deleted (WRITERS.md).

**Old workflows don't change.** A file using no new key has every step plain: `expand` gives today's
DAG, byte for byte, its hash unchanged, the instance's `plan` null, and no pending row.

### 7.2 What a start makes

`expand(workflow, params, board, …)` returns **`{ dag, plan }`**: the DAG of the plain steps' tasks,
format 1 as today (workflows spec §5), and the plan, `null` when the file uses no new key. The
start's one transaction (workflows spec §8, `applyDag` in `db/kanban.ts`) writes, beside today's rows,
the instance's `plan` column and one `kanban_workflow_pending` row a pending step, `waiting`. **A
handler gets none**: it is decided by routes, each its own row (§8), so status and reconciliation
never see it waiting.

### 7.3 The plan

The plan is JSON, stored in `kanban_workflow_instances.plan`, and never changed after the start:

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

- **Every step is in it**, in the file's order, plain ones included, each with its resolved reviewer,
  outputs, gates and contract, which a stand-in for it takes (§5.2): a plain step's outputs are what
  its completion is checked against (§2.2), and its routes are what its blocks are routed by. `made` is
  `start`, `decide` or `route`.
- **A template** is a DAG task's fields (workflows spec §5) with the params already filled in, and the
  references to results, `{{step.output}}` and a result fan-out's `{{item}}`, left in place. A pending
  step over a **list param** is expanded at the start, one template an item, as `templates`.
- **`wake`** is the member's wake as the start resolved it for that step (`#members`,
  `src/kanban/service.ts`), or `null`. A run's start stores none: its late members inherit their
  creating task's wake at the making, as `insertTask` does for any task a run makes (wake spec §3.1).
- **Masked on write, but for what decides and what runs.** The templates' text, titles, bodies,
  contract fields and items, are masked value by value, as the stored DAG's are (workflows spec §7).
  **Not masked**: the gates' commands, stored as written as the DAG's are; and the **clause values and
  enum values**, as a value masked in the plan would no longer equal the value a run reports, which is
  masked only where a known secret is in it. A clause or enum value holding a known secret is refused
  by `workflow check`, as a gate holding one is (workflows spec §4), so none is stored. Shown, the plan
  is masked again, as every output is.
- **At most 1 MiB** in its canonical form, as a start's DAG (workflows spec §5); a file that would pass
  it is refused at the start, `too_large`.

### 7.4 A step made late

When `decide` makes a step (§10), the writer inserts its tasks **as the start would have**, through
the same `insertTask` (`db/kanban.ts`):

- **its fields** from its template, each `{{step.output}}` filled from the frozen results as text,
  once, as params are (workflows spec §2): a list as its items joined by `, `, a number as JSON writes
  it, a boolean as `true` or `false`, a skipped step's as `(skipped)` (decided by the user, §20), a
  display placeholder in this text only, which nothing reads as a value (§3.2). `{{item}}`
  from the item. A handler's body gains its paragraph (§5.2), kept whole, the file's part cut to fit.
  **Titles and bodies are cut** to `task new`'s limits (512
  bytes, 64 KiB) with `cutToBytes` (`src/kanban/limits.ts`), as a reaction task's are (wake spec
  §19.3): the writer must not refuse for a later step's length, and the start already refused a
  template too long without its results (§6);
- **its creator** the instance's: `created_by`, `created_via` and, for a run's start, the same
  `created_from_task`, as `applyDag` gave the start's members;
- **its board** the instance's (workflows spec §19.2), whatever the file names now;
- **its links** to its effective parents' tasks (§3.2), each a task that was done, none to a task
  archived undone;
- **its subscriptions** copied from the instance's first member's, as they are at the making, through
  `insertTask`'s copied subscriptions, which today take one row for a reaction task (wake spec §19.3)
  and now take a list: recomputed from `created_via`, a chat start's late task would follow the chat
  at chat scope, though `threadSubscriptions` moved every member into the reply's thread (workflows
  spec §9). A start that no chat follows gives none;
- **its gates** through `insertGate`, as `applyDag`'s, by the instance's creator;
- **its member row** in `kanban_workflow_tasks`, its ref (§4.1, §5.3), its step and item, and its
  position the next after the instance's last. *This amends workflows spec §7*, where members are
  exactly what the apply made: a member is what the apply made, or what the instance's plan made
  later; a follow-up or a task linked in later is still only related;
- **its `created` event**, with `workflow`, `workflowName`, `ref`, `step` and `item` as a start's
  member's (workflows spec §8), and `routedFrom`, the routed task's id, for a handler;
- **its team check.** A task whose assignee, reviewer or workspace no longer passes `checkTask`
  against the team as the gateway holds it (a role removed, a workspace removed, a person who lost
  talk tier) **is made, and blocked at once** as `needs_input`: `role verifier is not configured, so
  this step's task cannot be given to it: /kanban task assign k_… <role>`, through `enterBlocked`, its
  `blocked` event's actor `gateway`. Its chat hears it as any block (kanban spec §9.4); it wakes
  nothing, routes nothing and is no `state: blocked`, its actor being no run's (§3.1, §5.1).

## 8. Schema (migration `015_workflow_routing.sql`)

```sql
-- manus-team migration 015: workflow routing
-- See docs/specs/2026-11-26-workflow-routing-design.md §8.
ALTER TABLE kanban_workflow_instances ADD COLUMN plan TEXT CHECK (plan IS NULL OR json_valid(plan));
ALTER TABLE kanban_workflow_instances ADD COLUMN routing_failed_at INTEGER;  -- a fault not yet reconciled (§9.4)

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

-- A member's settling, plain steps included: whose result is the member's, for good (§2.3).
-- ref: the step's name for a step that is no fan-out, and for a fan-out's own row; an item's ref for an item.
CREATE TABLE kanban_workflow_settled (
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  step         TEXT NOT NULL,
  ref          TEXT NOT NULL,
  how          TEXT NOT NULL CHECK (how IN ('done', 'stood_in', 'skipped', 'archived')),
  task_id      TEXT REFERENCES kanban_tasks(task_id),               -- the winner; null for skipped, archived, a fan-out's own row
  event_id     INTEGER NOT NULL,                                   -- see §8: the fact that settled it, not the transaction
  settled_at   INTEGER NOT NULL,
  PRIMARY KEY (instance_id, step, ref)
) STRICT, WITHOUT ROWID;

CREATE TABLE kanban_workflow_routes (
  instance_id  TEXT NOT NULL REFERENCES kanban_workflow_instances(instance_id),
  handler      TEXT NOT NULL,
  event_id     INTEGER NOT NULL,                                   -- the blocked or run_ended event routed
  from_task    TEXT NOT NULL REFERENCES kanban_tasks(task_id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('made', 'over_limit', 'over_cap')),
  task_id      TEXT REFERENCES kanban_tasks(task_id),               -- the handler's task; null unless made
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (instance_id, handler, event_id),
  CHECK ((outcome = 'made') = (task_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_kanban_workflow_routes_from ON kanban_workflow_routes(from_task);
CREATE INDEX idx_kanban_workflow_routes_task ON kanban_workflow_routes(task_id) WHERE task_id IS NOT NULL;

UPDATE schema_version SET version = 15;
```

- **A pending row a pending step**, keyed (instance, step): the approved key for a step's decision.
  `state` moves once, from `waiting` to `made` or `skipped`, by `UPDATE … WHERE state = 'waiting'`,
  whose one changed row is the guard that a decision is made once (§9.2). **No handler has one.**
- **A settled row a member's settling**, keyed `(instance_id, step, ref)`: one for a step that is no
  fan-out, one an item of a fan-out, and the fan-out's own, its ref the step's name, written only once
  every item has its row. Plain steps included. Written by `INSERT` into its key, by whichever
  `routeAfter` or reconciliation first finds the facts justify it (§9.2); a later one finds the key
  taken and changes nothing. Its winner is the facts' (§2.3), not the writer's. **`event_id` is the
  fact, not the transaction**: for `done` and `stood_in`, the winner's `completed` event; for
  `archived`, the task's `archived` event; for `skipped`, the greatest `event_id` of its parents' rows,
  the settling that let it count, and so too for a step **skipped by archive spreading** (§3.2), whose
  parents' rows are what made it so; for a fan-out's own row, the greatest of its items'. So a row written
  by a reconciliation holds the same `event_id` the gateway's transaction would have written.
- **A route row a route**, keyed (instance, handler, event): the approved key. `over_limit` and
  `over_cap` record a route refused, so it is never tried again and its notice is said once. The index
  on `task_id` finds a handler's route from its task, for `mt kanban unblock` (§5.4).
- **`routing_failed_at`** is set by a routing fault and cleared by the reconciliation that succeeds
  (§9.4).
- **`skipped` is a pending-row state only**, never a task's phase (§20, decision 1).
- **The plan is a column**, not a key of the stored DAG: the DAG stays format 1, canonical and hashed
  as today, so old DAGs, `show --dag` and `apply` are untouched (§13.5).
- **009-era instances.** Every instance made before 015 gets `plan` and `routing_failed_at` null, and no
  row in the three tables: the routing reads find a null plan and do nothing, so they are shown, run
  and archived as before.
- **Foreign keys** are allowed, as the tables are new and the columns are added to a table of the
  workflows' own (workflows spec §7). `ALTER TABLE … ADD COLUMN` of a nullable column writes no
  existing row, so the migration's transaction is as short as 009's.
- **No board is added**, so workflows spec §19.4's claim about migrations that add one holds.
- **WRITERS.md** gains the three tables' rows and amends three: `kanban_workflow_instances` (`plan`,
  written by `applyDag` only; `routing_failed_at`, by the routing), `kanban_workflow_tasks` (rows added
  later by the routing, §7.4) and `kanban_events` (`workflow_routed` and `workflow_route_failed`,
  §12.2).
- **An unmigrated database**, between this build and the start that migrates it: a start of a file
  that uses the new keys is refused, `invalid`, `the database is not yet migrated to version 15: start
  the gateway once, so it is migrated`, as an unmigrated wake is (`NOT_MIGRATED`); a start of a file
  that uses none works as today; the routing reads find no column and do nothing.

## 9. The writer: deciding inside the settling transaction

### 9.1 Which transitions decide

The deciding is in `db/kanban.ts`, in the transaction of each transition that can change what a
pending step reads, after the transition's own rows and event:

| Writer | When it routes |
|---|---|
| `complete` | when the task becomes `done`, not when it goes to `review`; a stand-in's also archives its routed task (§5.2) |
| `block` | a run's block from the work, of a kind but `dependency` (§5.1) |
| `endRun` | `next` is `blocked` and the task blocked from the work |
| `archive` | always: the task now reads as done (`from: done`) or skipped by archive (§3.1) |
| `archiveWorkflow` | every waiting row is skipped, `the instance was archived`, and nothing is made |
| `stop`, `unblock`, `requestChanges`, `assign`, the claim, everything else | nothing: a person's stop routes nothing (§5.1), and none of the others changes what a step reads |

**Cancelling a case is `workflow archive`** (workflows spec §10): it archives every member and skips
every waiting step, without deciding, so nothing more is made. Archiving members one by one is not a
cancel: each archive is decided on, and a step whose other parents are done is still made (§3.2).

### 9.2 The helper

```ts
// db/kanban.ts, called inside each transaction above
function routeAfter(d: Db, taskId: string, cause: RouteCause, eventId: number, now: number, team?: RouteTeam): void
```

1. **One read** finds the task's member row joined to its instance's `plan`; a task that is no member,
   or whose instance has no plan, returns at once. This is the only cost every settling transition
   pays: one primary-key lookup, `memberOf`.
2. It **sweeps every step and member** of the instance, and writes each settled row the facts
   justify that is not yet written (§8): each member with a settling fact, its winner the earliest by
   event id (§2.3); each skipped step whose parents are now settled;
   each fan-out whose items all have rows. Only then, for a member whose winner is a stand-in, is the
   routed task archived, unless it is already archived, when the sweep writes only the row (§5.2). So the rows are the same whatever transition, fault or reconciliation
   came first: a stand-in's completion whose routing faulted, followed by the routed task's own
   completion, gives the stand-in the row, as its `completed` id is lower; an archive undone whose
   routing faulted, followed by a stand-in's completion, gives `archived`, as the archive's id is lower.
3. It reads the **facts** of the instance: every member with its task's phase, its block event read
   as a trigger by §5.1's table (a run's `blocked`, or a `run_ended` with `next: blocked`, and its
   payload), never by the task's `block_kind`, and its archive's `from`; the settled rows, and each settled step's frozen result, by `latestCompletion`
   of the task its row names; the pending rows; the route rows. All within the transaction.
4. It calls the pure **`decide(plan, facts)`** (§10), and applies each outcome: a `made` step's tasks
   (§7.4), with its row set `made`, `reason`, `cause_event` and `decided_at`; a `skipped` row; a
   fan-out's tasks and its `items`; a route's handler task and its route row; an `over_limit` or
   `over_cap` route row; a step skipped at the cap.
5. **Until nothing more is due**: a skip, a made row or a settled row may decide another step in the same
   transaction, so it calls `decide` again on the new facts, at most once a step of the plan, which
   bounds the loop. A step made is a new open task, which decides nothing until it settles.
6. It writes **one `workflow_routed` event** on the transitioning task, listing every decision of the
   transaction, for the notice (§12.2).
7. It returns the runs it superseded (§5.2), which the transition's result carries to its caller (§9.5).

**Exactly once.** A row moves from `waiting` only by an `UPDATE … WHERE state = 'waiting'` that must
change one row, and a settled row and a route row are `INSERT`s into their keys: a second attempt, by
a replay of the same transition, a retried transaction (`SQLITE_BUSY` before the commit leaves nothing
written), or a reconciliation racing the gateway (§11), finds the row decided or the key taken, and
makes nothing. Decisions are recomputed from the facts each time, never from the order the events
came in: two transactions that settle two parents of one step, in either order, give the same
decision.

### 9.3 Without circular imports

- **`src/kanban/routing.ts`**, new and pure: the plan's types, `decide(plan, facts)`, `checkOutputs(
  declared, metadata, bounds)` for §2.2, the effective parents, the step descriptions of §6, the clause
  words of §12, and the handler's paragraph (§5.2). It imports only `./types.js`, `./limits.js`,
  `./dag.js` (`titleRefused`, `shown`, `DAG_LIMITS`) and `../secrets.js`. It imports no `db/` module, no
  `service.ts`, no `workflow.ts`.
- **`db/kanban.ts` imports `routing.ts`**, as it already imports the pure `kanban/dag.ts` and
  `kanban/task-checks.ts`. `workflow.ts` imports `routing.ts` to check the new keys and build the plan;
  `service.ts` imports it for the completion check. Nothing in `routing.ts` points back.
- **The team.** The writer knows rows, not the team (`db/kanban.ts`'s own comment), so the service,
  which holds it, passes a `RouteTeam` (`TaskFacts`' roles, workspaces, `supervisedRoles` and
  `canTalk`) to each deciding writer as one more optional argument, as `recordRoleWake` is given
  `TaskFacts` today: `complete`, `block`, `endRun`, `archive` and the reconciliation. Without it, as in
  the writer's own tests, a made task is not checked against the team, and its claim finds a removed
  role as any task's does (kanban spec §4.2).

### 9.4 The cap, and a failure in the routing

- **The cap.** The instance's 500 counts **every member, handlers included**. It is checked **before
  anything is made**: a step whose making, all its tasks counted, would pass it is skipped, `the instance
  has 500 tasks`, and a route that would records `over_cap` (§5.3); each is a line of the transaction's
  notice. **A fan-out makes all its items in one transaction, or none**: never a partial fan-out. The
  writer never refuses the transition for it (§2.2). A step skipped so is skipped as by its `when`:
  its children are decided by their other parents, and its own children through its effective
  parents.
- **A fault**, a bug or a row that cannot be read, must never lose the transition: a task's own
  completion, block or archive stands without its routing. So the routing runs in a **savepoint**
  inside the transition's transaction (a nested `db.transaction`, which better-sqlite3 runs as
  `SAVEPOINT`), and on a throw:
  - **`db.inTransaction` is checked.** If the outer transaction is gone, as SQLite rolls one back on
    some errors (`SQLITE_FULL`, `SQLITE_IOERR`, an interrupt), the error is rethrown: the transition
    failed with it, and its caller sees the failure, as without routing.
  - Otherwise the savepoint has rolled back alone; the transition commits, and in it, outside the
    savepoint, the instance's `routing_failed_at` is set and one `workflow_route_failed` event is
    written on the task, its error masked and cut at 500 characters.
  - **One notice per instance per fault**: the event's payload carries `first: true` only when it sets
    `routing_failed_at` from null, and only such an event is a notice (`renderNotice` passes the others), so a run of faults on one instance says it once until a
    reconciliation succeeds: `` Routing of vi-workflow `w_…` failed after **CVE-2026-12345 · va** `k_…`:
    <error>. The gateway tries again; `mt kanban workflow reconcile w_…` tries now. ``
  - **Retried on the dispatcher's pass**: each pass calls `KanbanService.retryRouting()`, which
    reconciles (§11) every instance with `routing_failed_at` set, at most once a minute each, and
    clears it on success. The time each was last tried is kept in the service's memory, not stored:
    after a restart every such instance is tried at the startup's reconciliation anyway (§11). The dispatcher reads no workflow table: the hook is the service's.

### 9.5 Runs the routing supersedes

The sweep archives a winning stand-in's routed task (§5.2), which supersedes its undecided run. Its turn
must be cancelled and closed, as after any archive.

- **Every writer that calls `routeAfter` returns them**, as `superseded: RunRow[]` in its result:
  `complete`, `block`, `endRun`, `archive`, and the reconciliation; so do the service's
  `reconcileWorkflow`, `reconcileAll` and `retryRouting`.
- **The service cancels them itself**, through one new dependency, `KanbanServiceDeps.cancelRun(runId)`,
  which the gateway gives as the dispatcher's `cancel(runId)` (`src/kanban/dispatcher.ts`), the same
  call chat's `#decided` makes after an archive. *Why the service, not a hook on `WorkerApiDeps`*: the
  paths are five callers, chat, the worker API, the dispatcher's own `endRun`, the boot reconciliation
  and the retry, and two of them have no caller to hand the runs back to. One place in the service covers
  all, and a caller that also cancels (chat's `#decided`) cancels an already-cancelled run, which
  `cancel` answers `false` and does nothing. The results still carry `superseded`, for tests and for
  chat's reply.
- **The dispatcher's `#cancelDecided`**, which cancels at each pass the turns of runs decided beside the
  gateway (a terminal's archive), stays the backstop: a terminal's `reconcile`, which has no dispatcher
  in its process, is cancelled there, at the next pass after its nudge.

## 10. `decide(plan, facts)`

Pure, in `src/kanban/routing.ts`:

```ts
interface StepFact {
  step: string;
  row: 'waiting' | 'made' | 'skipped' | null;            // a pending step's row; null for a plain step
  settled: { how: 'done' | 'stood_in' | 'skipped' | 'archived'; taskId: string | null } | null;  // the step's own row
  members: ReadonlyMap<string, { how: 'done' | 'stood_in' | 'archived'; taskId: string | null }>;  // by ref: its item rows, or its one row
  entered: { blocked: boolean; gaveUp: boolean };        // from the work, ever: the state clauses (§3.2)
  result: Readonly<Record<string, OutputValue>> | null;  // the frozen accepted result
  tasks: readonly { taskId: string; ref: string; item: string | null;
                    phase: Phase; archivedFrom: Phase | null; standIn: string | null }[];
  skippedBy: 'when' | 'source' | 'cap' | 'archive' | null;
}
interface RouteFact { taskId: string; step: string; item: string | null; eventId: number; kind: 'blocked' | 'gave_up'; routes: number }
interface Facts { steps: ReadonlyMap<string, StepFact>; due: readonly RouteFact[]; members: number; cap: number }
```

`RouteFact.kind`, `entered.blocked` and `entered.gaveUp` are set from §5.1's table by the **trigger
event**, a run's `blocked` or a `run_ended`, and never from the task's `block_kind`: a run's own
`transient` block and the transient limit's block both leave the task's kind `transient`, and only the
event tells them apart (the first is a `blocked` with actor `run:<run_id>`, so `blocked`; the second a
`run_ended` with `blockKind: transient`, so `gave_up`).

```ts

type Decision =
  | { step: string; outcome: 'made'; parents: string[]; why: string }
  | { step: string; outcome: 'skipped'; by: 'when' | 'source' | 'cap' | 'archive'; why: string }
  | { step: string; outcome: 'fanned_out'; items: string[]; parents: string[] }
  | { step: string; outcome: 'settled'; how: 'skipped' | 'archived' }     // a skipped step whose parents are now settled
  | { step: string; outcome: 'route'; handler: string; from: RouteFact; standsIn: boolean }
  | { step: string; outcome: 'over_limit' | 'over_cap'; handler: string; from: RouteFact };

function decide(plan: Plan, facts: Facts): Decision[];   // only what is due now; waiting is the absence of a decision
```

For each pending step still `waiting`, in the plan's order: its `when` (§3.2): certainly false,
`skipped` with the first false clause as `why`; undecided, nothing; true, and every parent settled:
its effective parents; all of its parents skipped by archive, `skipped` by archive; a fan-out over a
skipped or archived source, `skipped` by source; otherwise `made`, or `fanned_out` with the source's
items, or `skipped` for none; any of these past `cap`, `skipped` by cap. For each skipped step not yet
settled whose parents are now settled, `settled`. For each `due` route, whose step is not settled: its
step's `on_blocked` or `on_gave_up`, by the kind; `wait`, nothing; fewer than 3 for the task,
`route`, or `over_cap` past the cap; 3, `over_limit`.

`decide` is total: a missing result, a value of the wrong type, a step it does not know, each reads as
false or as unsettled, never as an exception, so a fault in the facts cannot make a wrong task.

## 11. Reconciliation

`reconcile(instance)` is the helper of §9.2 given no transitioning task: it reads the facts, decides
what is due, and makes it, in one transaction of its own. Its `workflow_routed` event goes on the
member whose settling decided the first of its decisions, the latest-settled ancestor that step reads,
so the notice reaches the instance's chat as any would.

- **At gateway start**, after the migration and before the dispatcher's first pass, for every
  instance with a plan and either a `waiting` pending row, a skipped step not yet settled, a blocked
  member whose step routes and has a route due, or `routing_failed_at` set. **A handler never makes an
  instance due**: it has no row, so an instance whose only unused step is a handler is not reconciled
  at every boot. One line, a note: `workflows: reconciled 2 instances, 3 steps decided`, or nothing when
  none was due.
- **On the dispatcher's pass**, for the instances with `routing_failed_at` set (§9.4).
- **At the terminal**, `mt kanban workflow reconcile w_… [--board <b>] [--json]`, the operator's,
  beside `show` and `archive` in `WORKFLOW_COMMANDS` (`src/cli/operator.ts`) and in `SUBCOMMANDS.workflow`
  (`src/cli/mt.ts`): the verb is the one the gateway already uses for the sessions it puts right at
  boot (`reconcileBoot`), a name the user kept (§20). It answers `reconciled w_…:
  verify skipped (intake.verify is false); exposure: 3 tasks` or `w_…: nothing was due`, then the nudge,
  as after `start` (workflows spec §6). `--json` gives `{"ok", "instance_id", "decisions": [{"step",
  "outcome", "task_ids"}]}`. Refused `not_found`, `other_board`, and `no_board` on an unmigrated
  database, as `show` is.
- **All are safe against the gateway**: the keys of §9.2 make a reconciliation that races a settling
  transition decide nothing twice.

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
- `k_…` archived · role vulnerability-analyst
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

- **The step line**: `✓ <step>: done (<outputs>)`, the scalar outputs as `name=value` and a list as its
  count and name, cut at 120 characters; `▶ <step>: running`, or for a fan-out `N items, M done`; `⏭
  <step>: skipped (<why>)`, with `, waiting for <parents>` while it is not yet settled; `⏳ <step>:
  waiting for <its unsettled parents and read ancestors>`; `⛔ <step>: blocked`; `↪ <handler>: routed
  from <step> (<gave up|stopped after 10 throttles|blocked>)`, with `, standing in`. **A handler never routed to shows no line**,
  and counts in nothing. A step made late shows as a plain one once made.
- **The order** is the plan's, the file's; tasks under their step in position order. Late members
  have later positions than the start's (§7.4), so `show` groups by step first, where today it walks
  positions.
- **A failed routing** (§9.4) adds one line after the head while `routing_failed_at` is set: `Routing
  failed at 10:41: <error>. The gateway tries again; \`mt kanban workflow reconcile w_…\` tries now.`
- **How it reads them**: `KanbanService.instance(id)` reads, beside today's members, `pendingOf`,
  `settledOf` and `routesOf` (`src/db/kanban-read.ts`), and the frozen results of the settled steps that
  declare outputs; the pure `stepLines(plan, members, pending, settled, routes, results)` in
  `routing.ts` makes the lines; `renderInstance` (`src/kanban/chat-render.ts`) and the terminal's plain
  text (`src/cli/plain.ts`) print them, chat's cut to fit as today (workflows spec §10). `--json` gains
  `steps: [{"step", "state", "why", "items", "routes"}]`. An instance with no plan shows as today.
- **`show --plan`**, at the terminal only, beside `--dag`, prints the stored plan, masked. `--dag`
  prints the start's DAG as today, and for an instance with a plan says on stderr that the DAG holds only the steps made at the start, the rest in `--plan` (§13.5).

### 12.2 Notices

**`workflow_routed`**, on the transitioning task (§9.2), its payload the instance (`workflow`,
`workflowName`), the task's step, and `decisions`, each `{step, outcome, why, taskIds, items, count,
handler}`, items at most 20 with the count, masked on write as every payload is, the names and refs in
`BOARD_KEYS` already. The notifier renders it from the payload alone, as `workflow_started` (workflows
spec §18.2), with `renderNotice`:

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
- ✓ escalate stands in for va: reachable=true; `k_…` va archived
- ▶ exposure fanned out, 3 tasks: lodash, minimist, qs
```

- **It reaches the instance's chat or thread**, as the transitioning task's subscriptions are the
  instance's (§7.4), and is **batched** with the transition's own notice, which comes first, its event
  being earlier: at most 20 notices and 3,800 characters a message, every 2 s (kanban spec §9.4).
  Items, titles and reasons are masked and escaped as every notice's.
- **Its lines**: made, skipped (by `when`, source, cap or archive), fanned out, routed, stood in,
  over the limit and over the cap. A reconciliation's decisions are one more such event (§11).
- **`workflow_route_failed`** is a notice when its payload has `first: true`, once a fault (§9.4).
- **Neither wakes**: `WAKE_KINDS` (`src/kanban/waker.ts`) is unchanged, and the wake spec's outcomes
  stay exactly its five (wake spec §2.2); both are notices that are no outcome, as `workflow_started`
  is (wake spec §2.3). A task made late wakes on its own outcomes, by its step's wake (§7.3).

### 12.3 Preview, and the start's reply

- **Preview** (workflows spec §6) lists the plain tasks as today, then the pending steps and the
  handlers, each with the words of §6: `verify: when intake.verify is true and va.reachable is true`,
  `exposure: per item of intake.packages, at most 100`, `escalate: handler for va, standing in`. Its
  first line counts both: `vi-workflow would make 1 task now, and up to 108 more as results come, on
  board vi:`, the most from the lists' `max` and 3 routes a routed task; past 500, `, at most 500 in
  all`. The same in chat and at the terminal.
- **The start's reply** (workflows spec §9) lists the tasks made, then one line, `5 more steps are made
  as results come: \`/kanban workflow show w_…\` follows them.`, among the fixed lines the cut keeps.
- **The worker's answer** to `start-workflow` gains `"waiting": ["va", "verify", …]`, the pending steps
  by name, handlers not among them, beside `tasks`; `mt kanban workflow start --json` the same.

### 12.4 Status

`instanceStatus` (`src/kanban/workflow.ts`) is given the pending and settled rows too:

- a **waiting** step, and a skipped step not yet settled, count as one unfinished, so the instance is
  never `done` while one is;
- a **skipped** step, settled, counts as finished;
- a **handler never routed to** counts as nothing; a handler's task **left open** after its member was
  settled otherwise (§5.2) is a member like any, and keeps the instance `running` until it is done or
  archived;
- otherwise as today: done is every member and step finished, an archived member finished, blocked any
  member blocked. A routed task stood in for is archived (§5.2), so it is finished like any.

The count reads "6 of 10 done", members and unmade steps together, a waiting fan-out as one.
`instances` keeps its one aggregate query of phases and adds one over the pending rows.

## 13. Boards, keys, wake, workspaces, and the DAG paths

### 13.1 Boards (workflows spec §19)

A late task goes on the **instance's** board, `kanban_workflow_instances.board`, decided once at the
start (workflows spec §19.2) and never read from the file again. The writer checks the board live
(`liveBoard`), and a board found archived skips the step, `board vi is archived`, never a refusal.

### 13.2 Idempotency keys

The instance's key covers its start (workflows spec §6), and a late task carries no key, as a member
carries none: it is made in a transaction keyed by its pending row or its route row. **A repeat of the
start** answers the instance as it is now, `existing: true`, its tasks every member made so far, late
ones included, and its `waiting` the steps still pending.

### 13.3 Wake

A late member's wake is its step's, as the start resolved it (§7.3), under the setter's live tier
check at each wake (wake spec §5.3). A run's start's late members inherit their creating task's wake
when they are made (wake spec §3.1). A handler's task is woken by its own outcomes only, by its step's
wake. `workflow_routed` and `workflow_route_failed` wake nothing (§12.2).

### 13.4 Workspaces

A late task with parents resolves its workspace by kanban spec §2.3's rule 3, from its effective
parents, at its claim; they are done by then, so fixed. A handler takes the routed task's fixed
workspace when its step and role name none, and starts from the workspace's base (§5.2). A fan-out in
one shared workspace runs one item at a time, as a param fan-out does (workflows spec §12).

### 13.5 `apply`, `apply-dag` and `preview --json`

**Conditions are workflow starts' only.** A DAG stays a fixed graph, format 1, with no `when`,
`for_each` over a result, route or handler, so `apply`, `apply --dry-run` and `apply-dag` are
unchanged, and so is every DAG's hash. Why:

- a DAG is what will be made, task by task, checked and hashed before its transaction (workflows spec
  §5); a step whose tasks depend on a result has no tasks to write, so a DAG carrying one would be a
  second expansion engine with its own format, the plan, under a hash it could not stand behind;
- an agent planning a graph has its own judgement: a deciding step (workflows spec §0) makes the branch
  it chose, which is what routing replaces for the operator's file, not for an agent;
- the gates rule (workflows spec §5) stands as it is: a plan's gates come from the operator's file
  alone, and `apply-dag` has no path to them.

So **`preview --json` is refused for any file that uses any routing key**, `outputs` included, `invalid`:
`workflow vi-workflow uses outputs, when, for_each over an output, on_gave_up, handler, which a DAG cannot
carry: start it with workflow start`, the keys named as the file uses them. A DAG made without them would
make the tasks without their checks and routes, which only a start keeps. **`apply` and `apply --dry-run`
refuse a DAG whose `workflow` label names such a file**, with the same message, read by a light read of
the file as `workflowBoard`'s (workflows spec §19.3), `workflowRouting(dir, name)`, after step 0 so a
repeat is answered; a file that cannot be read checks nothing, as there. **`apply-dag`** takes no label
at all (workflows spec §6), so it can never name such a file. **`show --dag`** of a routed instance prints its
start's DAG with the stderr line of §12.1. A start, from chat, the terminal or a run's
`start-workflow`, is the only way to make a routed instance.

### 13.6 The worker's `start-workflow`

A run's start of a routed workflow is as today's (workflows spec §6), on its task's board, created from
its task; its late members are created from the same task, follow its subscriptions as copied from the
first member (§7.4), and inherit its wake (§13.3). Its answer gains `waiting` (§12.3).

## 14. Security and masking

- **Values from results only fill titles and bodies**: never a name field, so a run's result cannot
  choose who runs next or where; never a gate, as no param reaches one (workflows spec §2); never a
  contract field, as approved. `workflow check` refuses a `{{step.output}}` anywhere else.
- **Results are an agent's text**, stored masked (`maskDeep`), and a fan-out's items and the made
  titles are masked again on write, as a task's are. An item holding a known secret is refused at the
  completion (§2.2), as a param's is (workflows spec §3).
- **Conditions run no code.** A clause compares a stored value; nothing is evaluated. Clause and enum
  values are stored unmasked, so they compare, and refused by the check when they hold a known secret
  (§7.3).
- **A handler's `unblock`** (§5.4) reaches only the task its handler was routed from, under the same
  stale check a button has; its authority is the operator's file, and no tier.
- **A stand-in's archive** (§5.2) archives only the task its route was made from, in the transaction
  that settles its step.
- **The plan is the operator's file**, frozen; its gates are stored as written, as the DAG's are
  (workflows spec §7), and a run's DAG never carries one (§13.5).

## 15. The cases

- **The intake reports no `packages`**: refused, `output packages is missing`; the agent reports again
  with `"packages": []`, and `exposure` is skipped, `intake.packages is empty`.
- **The intake reports 63 packages, `max` 50**: refused, `output packages must be a list of at most
  50 strings; got 63`; never cut to 50.
- **An early skip below a running step**: `verify` skipped at the intake, while `va` runs: `verify` is
  `skipped`, said at once, but `report` waits for `va` too, as `verify` is settled only once `va` is,
  and `report` is then linked to `va`'s task in `verify`'s place.
- **A reviewer asks for changes on a task whose result a step reads**: nothing is decided; the rework
  reports again, its outputs checked, and the approval decides from the rework's result.
- **A done ancestor archived later**: read as done, with its result (`from: done`); its children are
  linked to it as to any done parent, so they keep its handoff.
- **An undone root archived**: skipped by archive; a child whose parents were all so archived is
  skipped by archive too, never made with no link; a child with another parent done is made, linked to
  that one.
- **Cancelling a case**: `/kanban workflow archive w_…`, which skips every waiting step and makes
  nothing.
- **A fan-out whose source was skipped or archived undone**: skipped, `intake was skipped`.
- **A fan-out whose source was stood in for**: the source's original task was archived by the stand-in,
  and the fan-out reads the stand-in's accepted list, never the archived task's phase.
- **An undone task archived by hand**: its member is skipped, with no outputs; a clause on them is false,
  a fan-out over it skipped. Archiving never stands for success.
- **A clause on the output of a skipped step whose child was rewired to its grandparent**: false; the
  grandparent's outputs are not read in its place, and a title shows `(skipped)`.
- **The transient limit reached** (10 throttles in a row): routed by `on_gave_up`, as a give-up; a run's
  own `transient` block by `on_blocked`.
- **A stand-in that fails one of the step's gates**: its report is refused, `gate_failed`, the run
  undecided; nothing settles until it reports with every gate passing, or its routed task completes
  first.
- **A `state: blocked` step made, then its ancestor unblocked and done**: the step stays made; the
  decision is frozen.
- **A stand-in for a reviewed step**: made with the step's reviewer; its completion goes to review, and
  settles the step only once the review passes; changes requested on it settle nothing.
- **A fan-out of 60 items when the instance has 450 members**: none of its items is made; it is skipped,
  `the instance has 500 tasks`, with the notice. A handler counts among the 450.
- **A terminal `apply` of a DAG labelled `vi-workflow`**, printed by `show --dag`: refused, as the file
  uses routing keys; with the label set to `null` it applies the fixed tasks, as "(no workflow)".
- **A plain task archived by hand, its children plain too**: as today, its children are released
  (kanban spec §4.1).
- **`va` gives up, `on_gave_up` routes to a stand-in, the stand-in reports**: `va`'s step is settled by
  the stand-in; `va`'s task is archived with the comment naming it; its dependents are linked to the
  stand-in; the instance counts as through.
- **A routed task archived by a person after its stand-in was done**: the stand-in had settled the
  member; the archive changes nothing. **Archived before**: skipped by archive, and the stand-in, done
  later, settles nothing and archives nothing.
- **Two stand-ins of one member, both done**, a step's or an item's: the lower `completed` id wins,
  whichever transaction wrote the row; the other settles nothing; no route is made for the member after.
- **An item's own completion after its stand-in's**: the stand-in won (lower id) and archived the item's
  task, its rerun superseded and its turn cancelled; if its own completion came after the stand-in's,
  but before a sweep wrote the row (after a fault), it is archived `from: done`, unread.
- **The routed task's own completion before its stand-in's**: the task wins; the stand-in, still open,
  gets its comment and keeps the instance running until it is finished or archived.
- **A stand-in completing while the routed task's rerun is open** (a helper or person unblocked it): the
  stand-in wins; the routed task is archived from `open`, its run superseded, and the service cancels
  its turn (§9.5).
- **A fault in a stand-in's completion's routing, then the routed task's own completion, then a
  reconcile**: the own completion's sweep, or the reconcile, writes the row for the stand-in, its
  `completed` id being lower, and archives the routed task `from: done`: one winner, the same as
  without the fault.
- **A block in review**: a reviewer's run that blocks or gives up waits; no handler.
- **`va` gives up a fourth time**: no handler; one notice that it waits for a person.
- **The stand-in itself gives up**: it waits, as a handler's routes are `wait`; a person unblocks one of
  them, or archives the stand-in and unblocks `va`, whose own completion then settles it.
- **A handler is never routed to**: no row, no line in `show`; the instance reaches `done`.
- **A role removed from config before a step is made**: the task is made and blocked, `needs_input`,
  with the reason, which routes nothing; `/kanban task assign` moves it and `/kanban task unblock` frees
  it.
- **The file edited while an instance runs**: nothing changes for it; the plan is frozen.
- **The gateway stops between a completion's commit and anything else**: nothing is lost, as the
  decision was in the completion's transaction. A routing fault is retried on the next pass and at the
  next start.
- **Two items' completions commit at once, both the last but one**: the second's transaction sees both
  done and makes the join's child; the first's saw one left and made nothing.
- **The cap reached at a reviewer's approval or at a stand-in's completion**: what would pass 500 is
  skipped with its notice; the approval, or the completion, stands.
- **A terminal reconciliation while the gateway decides the same step**: one of the two finds the row
  decided, and makes nothing.
- **A chat start whose reply's thread is opened after a member settled**, which the hold of up to 30 s
  (`CARD_SEND_MS`, `src/kanban/cards.ts`) makes rare: the late task copied the first member's
  subscription at chat scope, and `threaded`, which reads the members at its move, moves it too.
- **A start with a key, repeated after tasks were made late**: answers the instance with every member
  now, `existing: true`.
- **A workflow with no new key**: started, shown and archived exactly as today; no plan, no row, no
  `workflow_routed`.

## 16. Wiring

- **`src/kanban/routing.ts`**, new and pure (§9.3): the plan's types, `decide`, the effective parents,
  `checkOutputs`, `stepLines`, `clauseText`, the handler's paragraph, and the reference filler of §7.4.
- **`src/kanban/workflow.ts`**: `STEP_KEYS` gains `outputs`, `when`, `on_blocked`, `on_gave_up`,
  `handler` and `stands_in_for`; `WorkflowStep` gains them, `forEach` becoming `string | { step, output }
  | undefined`; `checkWhole` gains §6's checks, an ancestors map from the parents, and the
  `{{step.output}}` references; `expand` returns `{ dag, plan }`, plain steps in the DAG as today; the
  outputs sentence in `outcome` (§2.1); `instanceStatus` given the pending and settled rows (§12.4).
- **`src/kanban/dag.ts`**: `shown` exported; `DAG_LIMITS.tasks`' comment becomes "Tasks in one DAG, and
  so made at one start; an instance with a plan may make up to 500 in all".
- **`src/kanban/service.ts`**: `#outputsRefused` in `complete` and `requestReview`, with the cap's
  reservation (§2.2); the `RouteTeam` passed to `board.complete`, `block`, `endRun` and `archive`;
  `#expanded` and `#write` carrying the plan, its templates checked as §6 says, and the wake resolved per
  pending step (§7.3); `startWorkflow`'s answer's `waiting`; `instance()` reading pending, settled and
  route rows; `reconcileWorkflow(id)`, `reconcileAll()` and `retryRouting()`; `unblockFromHandler(run,
  taskId, comment)` for §5.4.
- **`src/db/kanban.ts`**: `routeAfter`, its savepoint and `inTransaction` check (§9); `applyDag` writing
  `plan` and the pending rows; the settled rows; the stand-in's archive and comment; `insertTask`'s
  copied subscriptions as a list; the made task's team check and its `blocked`; `archiveWorkflow`
  skipping waiting rows; `workflow_routed` and `workflow_route_failed`; `routedFrom` and `standIn` in
  `BOARD_KEYS`.
- **`src/db/kanban-read.ts`**: `InstanceRow.plan` and `routingFailedAt`; `pendingOf`, `settledOf`,
  `routesOf`, `routesFrom(taskId)`, `routeOfHandler(taskId)`; `memberOf` returning the plan's presence;
  `hasRouting(db)` for an unmigrated database; the instances due at start.
- **`src/kanban/dispatcher.ts`**: one call of `retryRouting()` a pass (§9.4).
- **`src/kanban/worker.ts`**: `unblock` in `WORKER_COMMANDS`, its schema `{task_id, comment?}`;
  `madeAnswer`'s `waiting`; `#show`'s `routed_from` for a handler's task, from `routeOfHandler`.
- **`src/kanban/chat-render.ts`**: `renderInstance`'s step lines and failure line; `renderNotice`'s
  `workflow_routed` and `workflow_route_failed`; `renderPreview`'s pending steps and first line;
  `renderStarted`'s "more steps" line. **`src/kanban/notices.ts`**: nothing but passing the events, as
  `renderNotice` decides.
- **`src/cli/operator.ts`**: `reconcile` in `WORKFLOW_COMMANDS`; `show --plan`; `preview --json`'s
  refusal, and `apply`'s for a DAG labelled with a routed file (§13.5); the `--dag` stderr line. **`src/cli/plain.ts`**: their text.
  **`src/cli/workflow.ts`**: `mt workflow check`'s step lines and counts. **`src/cli/mt.ts`**:
  `reconcile` in `SUBCOMMANDS.workflow`, and `USAGE`.
- **`src/index.ts`**: `reconcileAll` after the migration, before the dispatcher starts, and its note.
- **`schema/015_workflow_routing.sql`** (§8). **`src/db/WRITERS.md`** (§8).
- **`skills/mt-kanban/SKILL.md`** gains one line beside "Put structured facts in metadata": `When your
  task's outcome names outputs, report each as a top-level key of "metadata", of the type it names; a
  completion without them is refused, and you report again in the same run.`
- **`docs/kanban-guide.md` §12**: a section "Routing on results", with the folded vi file of §1, how a
  step is shown, cancelling by `workflow archive`, `reconcile`, and that a handler's "Its directory"
  line helps only if the handler's agent may read outside its own worktree (its role's sandbox and
  tools, kanban spec §2.2).
- **Superseded runs** (§9.5): `superseded` in the results of `complete`, `block`, `endRun`, `archive` and
  the reconciliations; `KanbanServiceDeps.cancelRun`, given by `src/index.ts` as a late-bound
  closure, `(id) => dispatcher?.cancel(id) ?? false`, as `wakes: () => …` is, since the `KanbanService`
  is built before the `Dispatcher`; `src/kanban/worker.ts` unchanged for it.
  **`docs/specs/2026-11-16-workflows-design.md`**: the notes in §0 and §17 that this document extends
  them.

**What stays.** `PHASES`, `REPORTED_OUTCOMES`, `BLOCK_KINDS` and `RefusalCode` (`src/kanban/types.ts`)
are unchanged: no phase, outcome, block kind or refusal code is added. The dispatcher (but its one
hook), the claim, the prompt, the waker, the progress cards and the tiers are unchanged, and work per
task.

## 17. Testing

- **Unit, `decide()`**, with plans and facts written by hand, no database:
  - every clause: `equals` on a string, an enum, a number and a boolean; `in`; `is: true` and `false`;
    `at_least` and `at_most` at, below and above the bound; each `state`, `blocked` and `gave_up` true at
    the transition from the work and false once settled without it, and a gateway `blocked` not counted;
  - `any`: one of three true, none true; with other clauses false first;
  - skipped reads: a clause on a skipped step's output false; `state: skipped` true; a clause on a
    skipped step rewired to a done grandparent still false, the grandparent's outputs never read in its
    place; `(skipped)` in a title and body only, read by no clause or fan-out;
  - archive is not success: an undone task archived resolving its member as skipped, with no outputs, for
    `state: done`, an output clause and a fan-out's source alike; a done task archived later keeping its
    accepted result, its completion's event id earlier than the archive's;
  - **an early skip**: a step skipped while its parent runs is not settled, and its child waits for that
    parent, then is linked to it as an effective parent; a chain of two skips linked through to the
    nearest done ancestor; effective parents empty only by archive, and the step then skipped by archive;
    a step skipped by its `when` whose parents all count as skipped by archive, counting so itself;
    done-then-archived parents linked, the child keeping their handoffs;
  - ancestor reads: a clause on a grandparent decided when it settles, the step made only when its
    parents are;
  - fan-out: items in order, refs `step:n`; an empty list skipped; **a source settled by a stand-in
    fanning out from the stand-in's accepted list**, its original task archived; **a skipped source and an archived
    undone source skipping the fan-out**, an archived done source read; the join's child decided only
    when every item is settled, linked to each item's winner, none to an item archived undone; the
    fan-out's own row written only after every item's;
  - **archiving**: a done ancestor archived read as done with its result; an undone root archived
    skipping by archive a child whose parents were all archived, and not a child with another parent
    done;
  - caps: a step and a route past 500 from each path skipped and `over_cap`; handlers counted; a fan-out
    that would pass 500 making none of its items, never a part;
  - triggers: each row of §5.1's table routing by its key, the transient limit's block by `on_gave_up`
    and a run's own `transient` block by `on_blocked`, and `stopped`, a person's block and the team
    check's block routing nothing;
  - stand-ins: **a stand-in failing one of the step's gates not settling the step**, the run left
    undecided, and settling once it passes; **a stand-in's contract showing the step's fields**, `the
    step's (va): …` then `this handler's: …`, in each field both set, and the step's alone where the
    handler sets none; the step's gates made first on the stand-in's task, its own after; the step's
    reviewer, gates and contract read from the plan after the file is edited; a `state: blocked` decision
    staying made after the ancestor is unblocked and done; a stand-in for a reviewed step made with that reviewer, settling only once approved, and
    changes requested on it settling nothing; its completion's outputs checked as the step's;
  - routes and stand-ins: once per event; the fourth `over_limit`; per item; a review-phase block
    routing nothing; **the first to complete winning per member, and no route due for a member it
    settled**; **two stand-ins of one item**, the lower `completed` id winning; **an item's own
    completion after its stand-in's**, unread; only `made` rows counting toward 3; a helper
    leaving dependents waiting; **an unused handler, and the instance still `done`**;
  - totality: a result of the wrong type read as false; an unknown step unsettled.
- **Unit, output checking at completion**: each type's refusal, word for word; missing; the list's
  `max`; the cap's reservation at the reporting completion, `too_large`; items empty, repeated, holding
  a secret, holding a line break when `{{item}}` is in a title; outputs checked on `complete` from `open`
  and on `review`, not on an approval; a person's done refused on a step with outputs; no gate run on a
  refusal; the run undecided after it and its next report taken.
- **Unit, the writer**: each transition of §9.1 deciding, and the others not; exactly once under a
  replay of the same transition, a transaction retried after `SQLITE_BUSY`, two settlings in either
  order, and a reconciliation after a restart, each leaving one row and one task; the settled row
  written once, plain steps included, a later own completion reading the stand-in's result; **the cap
  at a reviewer's approval and at a stand-in's completion**, skipped with the notice, the transition
  committed; a stand-in archiving its routed task with the comment, from its actual phase, review
  included, the archive not read as a skip; a stand-in that settles nothing archiving nothing; a stand-in winning over a routed
  task already archived (`from: done`, archived by a person), the sweep writing only the row and no
  second archive; a
  handler left open after the routed task's own completion, given its comment and notice; **a stand-in
  completing while the routed task's rerun is open**, the run superseded, returned in `superseded`, and
  its turn cancelled by the service's `cancelRun`; **a fault in a stand-in's completion's routing, then the routed
  task's own completion, then a reconcile**, one winner, the stand-in, with the same `event_id` the
  gateway would have written; **an archive's routing faulting, then the stand-in completing, then a
  reconcile**, giving `archived`, the stand-in settling nothing and archiving nothing; **a reconcile that
  archives a routed task with an open run**, the run superseded and its turn cancelled through
  `cancelRun`, and the same from `block`, `endRun`, `archive` and the retry; a fan-out whose items are all
  archived undone, its own row `archived`; a done-then-archived parent linked and its branch not merged;
  the open handler's comment written once under a reconcile repeated; `workflow_route_failed`'s `first: true` on the first only; a
  fault in the routing rolling back its savepoint only, the completion kept, `routing_failed_at` set,
  one notice for two faults, and the dispatcher's retry clearing it; **a savepoint fault after the outer
  transaction was aborted**, rethrown, nothing committed; a made task's links, subscriptions copied from
  the first member in a thread, gates, member row and `created` payload; **a handler's body carrying the
  routed task's id**, step, kind and reason, and its unblock line; a removed role's task made and blocked,
  routing nothing; `archiveWorkflow` skipping every waiting row and making nothing; a workflow with no
  new key writing no plan and no row, its DAG and hash byte for byte as before.
- **Unit, the schema**: **migration 015 on a database with 009-era instances**, their `plan` null, no
  rows, shown, archived and repeated by key as before; the checks of each table; an unmigrated database
  refusing a routed start.
- **Unit, the file rules**, through `workflow check`: each row of §6's table, message for message, **a
  handler as a parent, in a `when` and as a `for_each` source refused**; the two `for_each` forms;
  `{{step.output}}` allowed in a pending step's title and body, and in a handler's from the routed
  step's ancestors, and refused elsewhere; the step lines and counts; the outputs sentence past 8 KiB
  refused; a clause value holding a known secret refused.
- **Unit, the plan**: **clause and enum values stored unmasked** and compared with a reported value,
  the templates' text masked, the gates as written.
- **Unit, seeing it**: `workflow show`'s lines for each state, an unused handler absent, its order by
  step, the failed-routing line, `--json`'s `steps`, `--plan`; the status with waiting, skipped and
  stood-in steps; the notices' text, batched, masked, and no wake; preview's lines and first line;
  `preview --json` refused for a file using any routing key, `outputs` alone included, with the message
  naming the keys; `apply` and `apply --dry-run` refusing a DAG labelled with such a file, after a repeat
  by key is answered, and checking nothing for a file that cannot be read; the start's answer's `waiting`; `reconcile`'s answers and refusals.
- **Unit, the handler's records**: a body of 64 KiB from the file cut so the paragraph is kept whole;
  `show`'s `routed_from` from the route row; a run's own `transient` block read as `blocked` and the
  transient limit's as `gave_up`, by their events, both tasks' kind `transient`, and the notice and
  `show` saying `stopped after 10 throttles`.
- **Unit, the worker's `unblock`**: authorised by the route row alone, a handler whose body was edited or
  cut still allowed and one with no route row refused; a handler's work run unblocking its routed task
  with a comment;
  **a repeat by the same run answering `ok`, `changed: false`**; refused `wrong_task` for another task,
  for a run that is no handler's, and **for a review run of the handler**; `stale` after another lifted
  the block.
- **Unit, workspaces**: **a handler in an isolated workspace** made with the routed task's workspace,
  its worktree started from the workspace's base, its body naming the routed task's directory; a child
  of a skipped step starting from its effective parents' branches.
- **End to end, a vi-style instance** from a fake chat, through the real socket and the fake CLI agent:
  `intake` completes with `{"kind": "cve", "verify": false, "patch": false, "bnpm": false, "packages":
  ["lodash", "minimist", "qs"]}`, after one refused report without `packages`; `verify` and `registry`
  are skipped and `exposure`, here a child of `intake`, fans out into three tasks, in one notice; the
  items complete; `va` reaches its failure limit and gives up, `escalate` is routed and stands in, `va`
  archived with its comment; `report` is made, linked to the three items and to `escalate`, joins and is
  reviewed; `patch` is skipped; the instance ends `done`; a gateway restart in the middle decides nothing
  twice.

## 18. Smoke

1. Fold the real `vi-workflow`, `-verify`, `-patch`, `-verify-patch`, `vi-supplychain` and
   `-supplychain-bnpm` into one file as §1 does, with their bodies and gates whole, and run `mt workflow
   check vi-workflow`: `ok`, the step lines of §6.
2. Preview it in chat: one task now, and the pending steps and the handler with their words.
3. Start it for a CVE in the vi chat; the intake reports `verify: false`; see `verify` skipped in one
   notice in the thread, and `report` still waiting for `va`.
4. Report `packages` with 101 items: refused, the agent reports again; then three items: three exposure
   tasks, named in one notice.
5. Stop the gateway while an exposure runs; start it; no `workflows: reconciled …` line, as nothing was
   due, and the instance goes on; `mt kanban workflow reconcile w_…` answers `w_…: nothing was due`.
6. Make `va` give up: a role whose fake agent exits at once (`crashed`), or `max_runtime_s: 1`, with
   `failure_limit: 1`. `escalate` is routed; have it `mt kanban unblock` va once, va gives up again,
   `escalate:2` is made; its completion stands in, and `va` is archived with its comment.
7. Block an exposure item from chat, `/kanban task block k_… waiting on the vendor`: no handler, no
   routing notice.
8. Archive one exposure item mid-instance: the join goes on without it; `report` is not linked to it.
9. Edit the file mid-instance (remove `patch`): the running instance still decides `patch` from its
   plan; a new start has no `patch`.
10. `/kanban workflow show w_…` at each stage, against §12.1; `mt kanban workflow show w_… --plan`.
11. Start it again for a supply-chain CSV with `bnpm: true`: `va` and `verify` skipped, `registry` made,
    `report` joining `exposure` and `registry`; `escalate` never routed, no line, the instance `done`.
12. Start an old file, unchanged: the same DAG hash as before the build, no plan.

## 19. Limits

- **Caps**: a fan-out at most its `max`, at most 100; an instance at most **500 tasks** in all, handlers included, a fan-out made
  whole or not at all, the
  start's at most 100 as today (workflows spec §3, §5). The reporting completion whose list would pass
  either is refused, never cut (§2.2); what passes 500 later, at an approval, a stand-in or a race, is
  skipped with its reason and a notice, never refused (§9.4). *This amends workflows spec §3*: 100 is
  the start's bound, 500 the instance's.
- **At most 3 routes per routed task** (§5.3), then `wait`; a route at the cap is `over_cap`.
- **No expressions**: the five tests and four states, one `any` group.
- **No clause on a fan-out step, and no fan-out over a fan-out**; no item pairing (workflows spec §17).
- **No clause on a list output**: a list is read by a fan-out only.
- **No optional outputs**, and outputs only from a role's run.
- **Handlers do not chain**, take no parents, are no step's parent, and start from the workspace's base.
- **No routing on a person's block or stop**, on a review's block, or on the team check's (§5.1).
- **No routing in a DAG**: `apply`, `apply-dag` and `preview --json` stay fixed graphs (§13.5).
- **The plan is frozen**: no step of an instance is added or changed after its start, the routing's own
  late tasks aside (workflows spec §11).
- **A late task's title and body are cut** to `task new`'s limits, not refused (§7.4).

## 20. Decisions

**Decided by the user**, after the first draft (its open questions 1 to 7):

- **Outputs are roles' only, for now** (Q1): a step with outputs must be a role's (§2.1).
- **The handler's `mt kanban unblock` stays** (Q2), for the routed task only (§5.4).
- **The route cap of 3 is per routed task** (Q3), so per fan-out item (§5.3).
- **An accepted stand-in archives the task it stood in for** (Q4), with a comment naming the handler
  (§5.2).
- **A skipped step's output in a title reads `(skipped)`** (Q5) (§7.4).
- **The verb stays `mt kanban workflow reconcile`** (Q6) (§11).
- **Routes only on a run's blocks** (Q7): a person's block or stop routes nothing (§5.1).

**Decided where the code forced a detail the design did not settle:**

1. **`skipped` is a pending-row state only, not a task phase.** `kanban_tasks.phase` has a `CHECK`
   listing its five values (`003_kanban.sql`), which SQLite cannot widen without rebuilding the kernel's
   live table, and `PHASES`, the display status, the dispatcher's claimable query, the board counts and
   every renderer would each learn a sixth phase for something nobody works on. A skipped step never
   becomes a task, so it has no row to carry a phase: its pending row says so, the instance's status
   reads it (§12.4), and the board's core is unchanged.
2. **The steps below a pending step are pending too**, and so are the children of a step a handler may
   stand in for (§7.1): links need both rows and are never deleted.
3. **A skipped step is settled only once its parents are, and children link to effective parents**
   (§3.2): an early skip lets nothing run early, and handoffs, order and worktree bases skip over it.
4. **Skipped by archive spreads, and is never let through** (§3.2): a step whose parents were all
   archived undone is skipped, never made with no link. An archive read `from: done` is done.
5. **`state: blocked` and `state: gave_up` are decided at the transition from the work** (§3.2); a
   parent read by a true one is not linked.
6. **Accepted results are `latestCompletion`'s metadata of a `done` task**, frozen per member in
   `kanban_workflow_settled`, keyed `(instance_id, step, ref)` with an item's ref for a fan-out's items
   and the step's name for the step's own row (§2.3, §8). The winner is the earliest settling fact by
   event id, among the own task's `completed`, its stand-ins' `completed` and its own archive undone,
   written by whichever sweep finds it first, so settling is path-independent; only then is a winning
   stand-in's routed task archived, whatever its phase, its superseded runs cancelled by the service
   through `cancelRun` (§9.5). Done-then-archived parents are linked,
   not recursed past: the kernel takes an archived parent as finished, and the child keeps its handoff.
7. **The outputs check is the service's, before the gates, code `invalid`** (§2.2), on work reports
   only; the cap is a reservation there, `too_large`, and the writer never refuses for it.
8. **Outputs are top-level keys of `metadata`**, and the agent is told by one sentence added to the
   task's `outcome` (§2.1); a handler by a paragraph added to its body (§5.2). The prompt reads no
   workflow table.
9. **The join marker is the fan-out's pending row with its `items`** (§4.2), not a gate.
10. **Handlers have no pending row**; routes are rows of their own, keyed (instance, handler, event),
    with `over_limit` and `over_cap` (§8).
11. **`decide` is pure, in `routing.ts`, imported by `db/kanban.ts`** (§9.3); the team is passed by the
    service as one optional argument; the routing runs in a savepoint, `inTransaction` checked on a
    fault, a fault noticed once and retried on the dispatcher's pass (§9.4).
12. **Late tasks copy the first member's subscriptions** (§7.4); their wake is frozen in the plan, a run's
    start's inherited at the making.
13. **Conditions are workflow starts' only** (§13.5): `preview --json` refused for any file using any
    routing key, `outputs` included; `apply` refusing a DAG labelled with such a file, by a light read;
    `apply-dag` needing nothing, as it takes no label; `show --plan` beside `--dag`.
14. **The notices are events on the transitioning task** (§12.2), rendered from their payloads, no wake;
    there is no instance event table, as an event belongs to a task (workflows spec §7).
15. **Reconciliation is the same helper**, at start, on the dispatcher's pass after a fault, and as `mt
    kanban workflow reconcile` (§11).
16. **A handler with no workspace of its own works in the routed task's, from the workspace's base**
    (§5.2), as there is no simple non-gating source for its worktree.
17. **Only the work's transitions route**; a person's, a review's and the team check's blocks do not
    (§5.1).
18. **Cancelling is `archiveWorkflow`**, which skips every waiting step without deciding (§9.1).
19. **Late titles and bodies are cut**, as a reaction task's (§7.4); templates are checked at the start
    with placeholders.
20. **Clause and enum values are stored unmasked**, and refused when they hold a known secret (§7.3).
21. **Only an accepted result is success** (§2.3), for the clauses that read a result: an archive of a
    task undone resolves its member as skipped, with no outputs; a task archived after its accepted
    completion keeps its result, as the completion's event comes first. `state: blocked` and `state:
    gave_up` read no result: they read the trigger event when it is written, and a decision on them is
    frozen like any (§3.1).
22. **Rewiring past a skipped parent is ordering only** (§3.2): links, order and handoffs as prompt
    context, never outputs; `(skipped)` is a display placeholder, never a value.
23. **Triggers are listed once, by event** (§5.1): the transient limit's block is a terminal failure
    ending, `on_gave_up`, with the breaker's `gave_up`; every other run-end block and a run's own block
    are `on_blocked`.
24. **A handler's context and authority are the route row's and the board's rows** (§5.2); its body's
    paragraph only describes them.
25. **A stand-in takes its step's reviewer, output check, gates and contract** (§5.2), from the frozen
    plan, so its result is accepted as the step's own would be: the step's gates first, then its own;
    each contract field merged as `the step's (va): …` then `this handler's: …`; `workflow check`
    refusing a stand-in whose gates, contract or workspace would weaken the step's.
26. **The cap counts handlers, is checked before anything is made, and a fan-out is all or none**
    (§9.4).
27. **Every reader reads the logical step's result**, its settled row's winner (§2.3, §4.1): a stood-in
    source fans out from the stand-in's list.

## 21. Departures from the approved design

1. **More steps are pending than the three kinds named.** Approved: a step with `when`, result
   `for_each` or `handler: true` becomes a pending row. Written: also every step below a pending step,
   and every child of a step a handler may stand in for (§7.1), as a link needs its parent's row and is
   never removed. And a handler, though named among them, gets **no** row: its route rows are its record,
   so an unused handler holds nothing back.
2. **More tables, and two columns.** Approved: one table, `kanban_workflow_pending (instance, step,
   state)`, and the plan stored by the instance. Written: that table with `reason`, `items`,
   `cause_event` and `decided_at`; `kanban_workflow_routes`, for the approved route key, which a row keyed
   (instance, step) cannot hold; `kanban_workflow_settled`, to freeze each member's result, a step's or an item's,
   path-independently; and the columns `plan`, so the stored DAG and its hash stay as they are, and
   `routing_failed_at`, for the fault's notice and retry.
3. **"Skipped, with an instance event"** is the pending row plus a `workflow_routed` event on the task
   whose transition decided it: `kanban_events` rows belong to a task (workflows spec §7).
4. **"A skipped step counts as settled for its children"** holds only once its own parents are settled,
   and **"if a skipped step was its only parent, the child's dependency is satisfied"** becomes a link to
   the child's effective parents, the nearest settled, non-skipped ancestors (§3.2), so an early skip lets
   nothing run before its ancestors.
5. **"Archiving a waiting step's parent counts as settled-skipped"** is kept for an undone parent, but a
   step whose parents were all archived so is skipped, not made with no link; and a parent archived after
   it was done reads as done, with its result (§3.1, §3.2).
6. **`state: blocked` and `state: gave_up`** are decided at the transition, not when the ancestor settles
   (§3.2), as approved "waiting while an ancestor it reads is unsettled" would make them never true. A
   step is also skipped as soon as its `when` is false, before its parents settle, though not settled
   until they are.
7. **A handler's `unblock` needs a worker command that did not exist**: `mt kanban unblock`, scoped to the
   routed task, by the handler's work run, with no tier (§5.4). The user kept it (§20).
8. **The 500 cap.** Approved: "a result over either cap is refused at completion, never cut". Written: the
   reporting completion is refused, as a reservation (§2.2); what passes 500 later, at an approval, a
   stand-in or a race, is skipped with a notice, as a writer transition cannot be refused for it without
   losing a report nobody can fix.
9. **Only the work's transitions route**: a block or give-up in review waits (§5.1), as a stand-in would
   otherwise settle a step past its reviewer.
10. **A handler's prompt context** is a paragraph the board appends to its body (§5.2), as the prompt reads
    no workflow table; and its worktree starts from the workspace's base, not from the routed task's work
    (§5.2).
11. **A routing fault** sends one notice and is retried on the dispatcher's pass (§9.4): the dispatcher
    calls one service hook, where before it called none for workflows.
12. **The refusal messages** are the `message` of the worker's JSON refusal, `{"ok": false, "code":
    "invalid", …}`; there is no `refused:` prefix, which the worker CLI does not print.
13. **Late titles and bodies are cut** to their limits rather than refused (§7.4); "never cut" is kept for
    what it named, the fan-out and instance caps.
14. **Routing is not in DAGs** (§13.5): `preview --json` of a file using any routing key, `outputs`
    included, is refused, and `apply` refuses a DAG labelled with such a file, where every file today
    previews to an applicable DAG.
15. **Values from results do not reach the contract fields**, only titles and bodies, as approved; the
    outputs sentence the expansion adds to `outcome` (§2.1) is the file's, not a result's.
16. **Clause and enum values are not masked in the plan** (§7.3), where the stored DAG masks every text
    but its gates.
17. **A stand-in's archive supersedes a live run** of the routed task (§5.2): when the stand-in wins
    while the routed task was unblocked and reworking, that rework is ended, and the service cancels its
    turn (§9.5), on every path that sweeps.
18. **A handler left open** after the routed task won is not archived, only told (§5.2), and keeps the
    instance running.
19. **The first completion wins, not the first stand-in.** Approved: the first stand-in wins. Written: per
    member, the earliest settling fact by event id among the routed task's completion, its stand-ins'
    completions and its archive undone (§2.3), so the routed task's own completion, or its archive, before
    any stand-in's wins too, and the result never depends on which
    transaction, fault or reconciliation wrote the row. An archive is never a result: it wins only as a
    skip (§2.3).
20. **The transient limit's block routes by `on_gave_up`**, not `on_blocked` (§5.1), and `state:
    gave_up` reads true there too: approved, the breaker's `gave_up` alone was a give-up; the board
    stopping after 10 throttles is as terminal. Both are told by the trigger event, as the task's block
    kind is `transient` for either.
21. **A stand-in takes the step's reviewer, gates and contract** (§5.2), and a stand-in handler may name
    no reviewer of its own; approved, a handler's fields were a step's, its reviewer, gates and contract
    its own alone. Its gates and contract fields are added to the step's, never replacing them.
22. **`preview --json` is refused for `outputs` alone**, and `apply` refuses a DAG labelled with a routed
    file (§13.5); approved, the DAG paths were not discussed, and the first draft let an outputs-only file
    preview.

## 22. Open questions for the user

None. The first draft's seven questions are decided (§20).
