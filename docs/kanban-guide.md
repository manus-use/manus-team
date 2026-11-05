# The task board: a usage guide

This guide is for people on the team who drive the manus-team board from Lark: operators who
create and steer tasks, and the people tasks and reviews are given to. It starts with one task
for one agent and builds up to chains, fan-out and review.

A task is any work, not only code: research, writing a document, a script, an ops chore. It is
given to a **role**, whose agent runs it in a **workspace** (a directory on the gateway's host),
or to a **person**, who gets it as a card in Lark.

The examples use two roles:

- `worker`: a bytesec agent that runs unsupervised, in its own workspace, `worker`. Most
  examples use it.
- `watched`: a supervised test role. Its agent asks before it writes a file, and the question
  comes to the chat as an approval card.

A third role, `reviewer`, appears in the review examples. It does not exist until someone
creates it on the gateway's host with `mt role create reviewer`, and it is loaded at the
gateway's next start.

## Before you start

**Where to type.** `/kanban` works in any chat the bot is in. In a group, start the message with
an @-mention of the bot, or the gateway does not read it. In a direct message with the bot, just
type the command. The examples below leave the bot's mention out.

**Ids.** Every task has an id such as `k_…`, which the chat gives you when the task is created.
Runs have ids such as `r_…`. Wherever an example says `k_…`, use the id the chat gave you.

**Who may do what.** The gateway decides your tier from `auth.talk` and `auth.operate` in its
config. Anyone at talk tier may use the board's read commands; anything that changes the board
needs operator tier, except a person's reports on their own task.

| Who | Commands |
|---|---|
| Anyone at talk tier | `/kanban help`, `list`, `show`, `comment`, `gate list` |
| Operators | `/kanban new`, `assign`, `link`, `workspace`, `unblock`, `stop`, `archive`, `gate add`, `gate remove`, and every talk-tier command |
| The person a task is assigned to | `/kanban done`, `block` and `review` on that task, while it is being worked on |
| The person named as a task's reviewer, or any operator | `/kanban approve` and `changes` on that task, while it waits for review |

A talk-tier person who tries an operator command is told so:

> `/kanban new` changes the board, and needs operator permission.

Being named on a task is the permission: a person assigned a task needs only talk tier to report
on it. An operator cannot report `done` on a task assigned to someone else.

The board records whoever acts as `lark:<union_id>`. If Lark sends a message without your
union_id, you can still list and show tasks, but the board refuses any change, and says to ask
the operator to check the app can read user ids.

`/kanban help` lists every command with who may run it.

## 1. One task for a role

Give the task a title on the first line, and name the role on an `assignee:` line. Every line
that is not a field line is the task's body: the instructions the agent reads.

**In Lark, Enter sends the message.** Press Shift+Enter for each line break, or write the message
elsewhere and paste it in.

Paste:

```
/kanban new Summarise the vendor contracts
assignee: worker
Read every PDF in contracts/2026 and write a one-page summary of renewal dates, notice periods and price caps to notes/contracts.md.
```

The chat replies:

> Created `k_…`: **Summarise the vendor contracts**, for role worker. This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.

The dispatcher looks for work as soon as the task is created, so the agent usually starts within
moments. It runs in the role's workspace, `worker`; the paths in the body are relative to that
directory.

When the agent reports that it is done, the chat hears, with the agent's summary quoted:

> Done: **Summarise the vendor contracts** `k_…`
> > Wrote notes/contracts.md: 14 contracts, 3 renewing before March, two with no price cap.

How a message is read:

- The title is the rest of the first line, or the next line if `/kanban new` stands alone.
- A field line is its label at the very start of a line, in any case, then a colon:
  `assignee:`, `reviewer:`, `workspace:`, `parent:`, `outcome:`, `verify:`, `constraints:`,
  `boundaries:` and `stop when:`. Field lines may come in any order, among the body's lines.
- An indented line, or one that only mentions a label mid-sentence, stays in the body.
- Each field may be given once, except `parent:`. A field with no value, or given twice, is
  refused.
- A bare word names a role; an @-mention names a person (section 4).
- An unknown role or workspace is refused at once, and nothing is created.
- The same message delivered twice makes one task: the second time the chat says
  "Already created, as `k_…`."

Limits: a title is at most 512 bytes, a body at most 64 KiB, and each contract field at most
8 KiB. A longer title is refused with "A title is at most 512 bytes; put the rest in the body."

A task may be created with no `assignee:` line. It waits until an operator gives it to someone
with `/kanban assign` (section 9).

## 2. Saying what done means

### The contract

Five optional lines tell the agent, and whoever reviews, what done means. They are put in the
agent's prompt and shown on cards and in `/kanban show`.

| Line | Means |
|---|---|
| `outcome:` | the end state that must be true |
| `verify:` | what proves it |
| `constraints:` | what must not change or regress |
| `boundaries:` | what is in scope |
| `stop when:` | when to stop and ask instead |

Paste:

```
/kanban new Draft the incident review for the 3 November outage
assignee: worker
outcome: docs/incidents/2026-11-03.md, with a timeline, the cause and three follow-ups
verify: every timestamp in the timeline comes from the attached logs
constraints: do not name individuals; say "the on-call engineer"
boundaries: this outage only, not the earlier DNS issue
stop when: the logs disagree about when paging started
The logs are in logs/2026-11-03/. Use docs/incidents/template.md.
```

The chat replies:

> Created `k_…`: **Draft the incident review for the 3 November outage**, for role worker. This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.

A vague definition of done is the most common reason delegated work stops early, or never stops.
`stop when:` is how you tell the agent to block and ask rather than guess.

### Gates

A **gate** is any shell command that must exit 0 before the task may complete or go to review.
It runs in the task's workspace, so it can check that a file exists, a link answers or a script
passes. When a gate fails, the report is refused, and the agent is shown the command, its exit
and the end of its output, so it can fix the work and report again.

Adding a gate is an operator's command. The rest of the message after the task id is the command,
exactly as written.

Paste:

```
/kanban gate add k_… test -s docs/incidents/2026-11-03.md
```

The chat replies:

> Gate 1 added to `k_…` (300 s): test -s docs/incidents/2026-11-03.md

Give a timeout in seconds with `--timeout` (or `--timeout=60`) before the command:

```
/kanban gate add k_… --timeout 60 grep -q "## Timeline" docs/incidents/2026-11-03.md
```

> Gate 2 added to `k_…` (60 s): grep -q "## Timeline" docs/incidents/2026-11-03.md

List them, which anyone at talk tier may do:

```
/kanban gate list k_…
```

> Gates of `k_…`, run in this order before it may complete or go to review:
> 1\. test -s docs/incidents/2026-11-03.md (300 s, by lark:on_…)
> 2\. grep -q "## Timeline" docs/incidents/2026-11-03.md (60 s, by lark:on_…)

Remove one by its number:

```
/kanban gate remove k_… 2
```

> Gate 2 removed from `k_…`: grep -q "## Timeline" docs/incidents/2026-11-03.md

Limits and rules:

- At most 20 gates a task, and a command of at most 4 KiB.
- A gate's timeout is 300 s unless you give one, and at most 600 s. All of a task's gates
  together may run for at most 600 s.
- Gates run in the order listed, with the environment of the role whose agent last ran the task.
- A command that holds a known secret is refused. Put the value in the role's `.env`, and name
  it in the command as `$NAME`.
- A report runs the gates it read when it started: a gate added while the agent is already
  reporting counts from the next report.
- The agent's prompt lists the gates the task had when the run started. To be sure the agent
  sees them, create the task with no `assignee:` line, add the gates, then give it to the role
  with `/kanban assign k_… worker`.

## 3. Review

A task can be reviewed before it is done. Name the reviewer on a `reviewer:` line: a role by its
name, or a person by @-mention.

A task that names a reviewer is always reviewed before it is done. The agent's prompt names the
reviewer and tells it to ask for review when the work is done. If it reports done instead, the
board sends the task for review all the same, with the same summary, and the agent is told
"sent for review to role reviewer". The same holds for a person's task: their done goes to the
reviewer. The task's gates run once, as for any review. Nothing needs to be said in the body.

Paste:

```
/kanban new Write the on-call handbook page
assignee: worker
reviewer: reviewer
outcome: docs/oncall.md covers paging, escalation and handover
verify: every escalation contact has a phone number
```

> Created `k_…`: **Write the on-call handbook page**, for role worker. This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.

When the worker's work is done, the chat hears:

> Review requested for **Write the on-call handbook page** `k_…`, from role reviewer.

For a person, name them with an @-mention: type @ and pick them from Lark's list.

```
/kanban new Write the on-call handbook page
assignee: worker
reviewer: @Bob Li
```

> Review requested for **Write the on-call handbook page** `k_…`, from Bob Li.

A task with no `reviewer:` line is done when its assignee says so. Its agent may still ask for
review, naming a reviewer then, and from then on the task has that reviewer.

### A separate review task

The other way to review is a task of its own, whose parent is the work to review. The work is
done when its assignee says so, and that releases the review task:

```
/kanban new Review the on-call handbook page
parent: k_…
assignee: reviewer
Check docs/oncall.md against its parent's outcome, and list anything missing.
```

Use one way or the other, not both. A task that names a reviewer and also has a review task
under it is reviewed twice: by its reviewer first, since its done goes to them, and then, once
they approve, by the review task.

### What the reviewer gets

- **A reviewer role** gets a review run in the task's own workspace, so it reads the checkout the
  implementer wrote. Its prompt holds the implementer's handoff (summary and metadata), the
  commit the implementer reported when the workspace is a git repository, the task, its contract
  and its gates. It is told not to change the work, and to approve or ask for changes with a
  specific reason.
- **A person** gets a review card in a direct message: the handoff, what to review (the reported
  commit, when one was recorded), the body and the contract, a box, and **Approve** and
  **Request changes**. The chat the task came from hears one line:

> 📋 **Write the on-call handbook page** `k_…`, review assigned to Bob Li

### Request changes

A person types what needs changing in the card's box and presses **Request changes**, or types:

```
/kanban changes k_… Add the weekend escalation path, and a phone number for the database on-call.
```

> Changes requested on `k_…`: it goes back to its assignee, with your reason.

A reason is required: Request changes with an empty box is refused, and the card says to type
what needs changing.

The task goes back to its assignee as a **rework**. For an agent, the rework is a new run whose
prompt carries the reviewer's reason and the previous handoff in full. On bytesec, it also
continues the implementer's own session where it can, so the agent revises what it wrote knowing
why; where it cannot, the prompt still has everything it needs. The rework goes back to the
reviewer when it is done, whether the agent asks for review or reports done, and the chat hears
"Review requested for …" again. A request for changes is not itself a notice.

### Approve

A person presses **Approve**, or types, with an optional comment:

```
/kanban approve k_… Looks right. Thanks.
```

> Approved: `k_…` is complete.

Approving runs the task's gates first, as any completion does. The chat hears the Done notice
with the approval's comment, if it had one, or just "Done: **title** `k_…`." if it had none. A
task's children (section 5) are given the implementer's handoff, not the approval.

### An operator answering a review

An operator may answer any review, a person's or a role's, with the same two commands. This is
for a reviewer who is away, a review a role cannot take, or a review an operator wants to settle
now.

```
/kanban approve k_…
```

> Approved: `k_…` is complete.

If a reviewer role's agent is working on the review, the operator's answer takes the review from
it: its run is ended, and its turn is stopped. The reply says so:

> Approved: `k_…` is complete; the review run of role reviewer was ended.

`/kanban changes` does the same, and the task goes back to its assignee as a rework. Anything the
reviewer agent reports afterwards is refused, as its run is over. A person reviewer's review needs
nothing ended: the operator's answer decides it, and the person's card goes out of date.

A person who is neither the reviewer nor an operator is told:

> `/kanban approve` answers a review, and is for `k_…`'s reviewer (Bob Li (lark:on_…)) or an operator.

## 4. A person's task

### Giving a person a task

Name the person on the `assignee:` line with a Lark @-mention: type @ and pick them, so Lark
sends who they are with the message. Typing the name without picking it does not work.

Paste:

```
/kanban new Book the venue for the January offsite
assignee: @Alice Chen
outcome: a confirmed booking for 40 people, 14 to 16 January
Ask facilities for the two rooms on the third floor first.
```

The chat replies:

> Created `k_…`: **Book the venue for the January offsite**, for Alice Chen (lark:on_…). They are sent it as a card, in a direct message, once it is ready. This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.

When the task is ready, Alice gets a card in a direct message from the bot:

- the title, the body, the contract, and up to five parents' summaries;
- a box, with **Done** and **Block** under it.

She types a summary and presses **Done**, or types why she is stuck and presses **Block**. Block
with an empty box is refused, and the card says to type why. The box holds up to 1,000
characters; the typed commands take more.

The chat the task came from hears one line, naming her in plain text, never as a mention:

> 📋 **Book the venue for the January offsite** `k_…`, assigned to Alice Chen

Pressing a button is answered at once. The card shows "Working on it…", then the outcome, once
any gates have run. A press refused for what it carried, such as an empty box or a failing gate,
redraws the card saying why, ready to press again. A card for a run that is over says it is out
of date and does nothing. Only the person named can press Done and Block.

A person's task never times out: it waits for them, across gateway restarts.

### The typed forms

Each button has a typed form, which works from any chat with the bot, a direct message included.

```
/kanban done k_… Booked rooms 3A and 3B, confirmation in the facilities ticket.
```

> Done: `k_…` is complete.

The summary is optional. If the task names a reviewer, done sends it to them instead, and the
chat says:

> Sent `k_…` for review to Bob Li (lark:on_…): the task names a reviewer, so done asks for review.

Pressing **Done** on the card does the same, and the card says "Sent for review to Bob Li". A
block needs a reason:

```
/kanban block k_… Facilities need a cost centre before they will confirm.
```

> Blocked `k_…` (needs_input). An operator unblocks it with `/kanban unblock k_… [comment]`.

To ask for review of your own task, of a reviewer the task does not name, use `/kanban review`,
with a summary, and name the reviewer on a `reviewer:` line unless the task already names one:

```
/kanban review k_… Holding rooms 3A and 3B until Friday.
reviewer: @Bob Li
```

> `k_…` is waiting for review, by Bob Li (lark:on_…).

Without a `reviewer:` line on either the command or the task, the chat says:

> Nobody is named to review `k_…`: add a line `reviewer: <role or @person>`.

`done`, `block` and `review` are only for the person the task is assigned to, while the task is
being worked on. Anyone else, an operator included, is told who the task is for.

### Who can be named

The gateway must know a person, and they must have talk tier:

- **Known:** the gateway learns a person's ids when they send a `/kanban` message, are
  @-mentioned in one, or press a board card. A person @-mentioned in the very message that names
  them is known from that message. A person named as `lark:<union_id>` typed out, or by an agent,
  must already be known.
- **Talk tier:** being assigned lets a person report on the task, so they need talk tier
  (`auth.talk`). Otherwise the chat says, for example:

> @Carol Wu cannot be given work: being assigned lets a person report on the task, which needs talk tier, and the gateway does not know them to have it.

If a card cannot reach the person at all (Lark says they are outside the app's availability), the
chat is told, with the typed commands they can use instead.

## 5. A chain, A → B → C

To run tasks in order, create each one naming the one before it on a `parent:` line. A task waits
(**todo**) until every parent is done, then becomes **ready** and starts.

Create A:

```
/kanban new Collect last quarter's support tickets
assignee: worker
Export every ticket tagged billing from tickets/2026-q3.csv into data/billing-q3.csv.
```

> Created `k_…`: **Collect last quarter's support tickets**, for role worker. This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.

Create B, with A's id as its parent:

```
/kanban new Group the billing tickets by cause
parent: k_…
assignee: worker
Read data/billing-q3.csv and write the five most common causes, with counts, to notes/billing-causes.md.
```

Create C, with B's id as its parent:

```
/kanban new Write the billing FAQ draft
parent: k_…
assignee: worker
outcome: docs/faq/billing.md answers each of the top five causes
```

How the chain runs:

- **A** starts at once.
- **B** is todo until A is done. When A's run ends, the dispatcher looks for work again, finds B
  ready and starts it.
- **C** starts when B is done, the same way.
- Each child's prompt holds each parent's latest completion summary and metadata, verbatim: B
  reads what A said it did and where its results are. For a parent that went through review,
  the child gets the implementer's handoff. A person's card shows the same, under
  "From its parents".
- All three run in `worker`, the role's own workspace, so B finds A's files where A left them.
- An archived parent counts as finished too: archiving A releases B.

A link can be added later with `/kanban link <parent> <child>`, an operator's command, as long as
the child has not started:

```
/kanban link k_… k_…
```

> `k_…` now waits for `k_…`.

The first id is the parent, the second the child. A link that would make a cycle, or one onto a
task that has started, is refused.

## 6. Fan-out and fan-in

A research task, three tasks under it that run in parallel, and a write-up that waits for all
three:

```
               Survey the vendors
              /        |         \
       Vendor A    Vendor B    Vendor C      in parallel, one workspace each
              \        |         /
            Write the vendor comparison      waits for all three
```

### One agent per workspace

A workspace runs **one agent at a time**: two agents editing one directory would overwrite each
other. Tasks in the same workspace queue, one after the other. The three middle tasks would all
run in `worker` and queue, unless each names a workspace of its own.

An operator adds workspaces on the gateway's host. Each directory must already exist, and the
gateway reads them at its next start:

```
mt workspace add vendor-a /srv/work/vendor-a
mt workspace add vendor-b /srv/work/vendor-b
mt workspace add vendor-c /srv/work/vendor-c
```

A `workspace:` line on the task beats the role's own workspace.

Running agents are also capped by `kanban.max_running` in the gateway's config: at most that many
agent runs at once, across all workspaces. It defaults to `maxLiveSessions` (8 unless set), and
cannot be above it. Set it lower to keep room for chat sessions. A person's task holds no
workspace and does not count.

### The tasks

The research task:

```
/kanban new Survey the vendors
assignee: worker
outcome: notes/vendors.md lists the three vendors we shortlist, with a one-line reason each
Shortlist three log-storage vendors from vendors/candidates.md.
```

Each of the three, with the survey's id as parent and its own workspace (change the letter for B
and C):

```
/kanban new Price out vendor A
parent: k_…
workspace: vendor-a
assignee: worker
constraints: put the findings in your summary, not only in files
Take the first vendor in the parent's summary. Find list prices for 5 TB and 50 TB a month, retention options and egress costs.
```

The write-up, with three `parent:` lines, one per vendor task:

```
/kanban new Write the vendor comparison
parent: k_…
parent: k_…
parent: k_…
assignee: worker
outcome: docs/vendor-comparison.md, one table and a recommendation
```

How it runs:

- The survey runs first; the three vendor tasks are todo until it is done.
- Then all three are ready together and start in parallel, one in each workspace, up to
  `kanban.max_running`.
- The write-up is todo until **all three** are done. It runs in `worker`, the role's own
  workspace, and its prompt holds all three summaries.
- The vendor tasks' files stay in their own workspaces. That is why each is told to put its
  findings in its summary: the summary is what the write-up reads.

Several parents can also go on one line, separated by spaces or commas:
`parent: k_…, k_…, k_…`.

## 7. Follow-ups an agent creates

An agent can create tasks itself, from inside its run, with `mt kanban create`. Its protocol
tells it to create a task for follow-up work it finds, rather than doing it. You can also ask for
it in the body:

```
/kanban new Plan the runbook rewrite
assignee: worker
outcome: one follow-up task per out-of-date section of runbooks/oncall.md, in reading order
Read runbooks/oncall.md. For each out-of-date section, create a follow-up task for role worker with mt kanban create, each naming the one before it in "parents", so they run in order. Do not rewrite the sections yourself.
```

The agent sends JSON such as:

```json
{"title": "Rewrite the paging section", "body": "…", "assignee": "worker", "parents": ["k_…"]}
```

What to know:

- **Order comes from `parents`.** A follow-up with no parents can start at once. `mt kanban link`
  only works on a task that has not started yet, and a follow-up that can start is claimed
  before `create` answers, so linking afterwards usually fails. Creating them in order, each
  naming the one before, is what sequences them.
- **Where they run.** A follow-up for a role with its own workspace runs there; one for a role
  without works where the creating task did. A follow-up with no parents is not held back by the
  task that created it, but it queues behind that task's run if they share a workspace.
- **This chat hears about them.** A follow-up inherits the subscriptions of the task that created
  it, so the chat that created the parent hears when each follow-up is done, blocks or gives up,
  and so on down the line.
- A follow-up has the same limits as a task from chat, and can be given to a role or to a person
  the gateway knows, by `lark:<union_id>`.

## 8. Watching and steering

### The board

```
/kanban list
```

> `k_…` **running**: Survey the vendors · role worker
> `k_…` **todo**: Price out vendor A · role worker
> `k_…` **todo**: Write the vendor comparison · role worker
> `k_…` **blocked**: Book the venue for the January offsite · lark:on_…

Without a status it shows the tasks someone may still act on, grouped as running, reviewing,
review, ready, todo, then blocked. Name a status to see only those: `todo`, `ready`, `running`,
`review`, `reviewing`, `blocked`, `done`, `archived`, or `all` for every task.

```
/kanban list done
```

It shows at most 30 lines, then how many more. With nothing open, it says:

> No open tasks. `/kanban list all` shows done and archived ones too.

What the statuses mean:

| Status | Means |
|---|---|
| todo | waiting for a parent to finish |
| ready | can start, and is waiting its turn |
| running | an agent or a person is working on it |
| review | waiting for its reviewer |
| reviewing | its reviewer is working on it |
| blocked | needs someone to act (section 9) |
| done | complete |
| archived | put away |

### One task

```
/kanban show k_…
```

> **Draft the incident review for the 3 November outage** `k_…`: running
> assignee: role worker · reviewer: nobody · workspace: worker
> > The logs are in logs/2026-11-03/. Use docs/incidents/template.md.
>
> **Contract**
> outcome: docs/incidents/2026-11-03.md, with a timeline, the cause and three follow-ups
> verification: every timestamp in the timeline comes from the attached logs
> constraints: do not name individuals; say "the on-call engineer"
> boundaries: this outage only, not the earlier DNS issue
> stop_when: the logs disagree about when paging started
> **Gates**
> 1\. test -s docs/incidents/2026-11-03.md (300 s)
> **Runs**
> #1 work · role worker · working

It shows the task, its parents and children, its contract, gates, its last five runs, the last
800 characters of the latest run's output, and its last five comments.

### Comments, and who can steer

Anyone at talk tier may comment, and everyone sees comments in `/kanban show`. Only some comments
reach the agent:

- **Steer:** an operator's comment, and the task's named assignee's or reviewer's. The agent gets
  it when its current turn ends; if no agent is working on the task, the next run reads it.
- **Stored only:** anyone else's. It is shown to people, never given to an agent.

```
/kanban comment k_… Use UTC for every timestamp, and say so under the heading.
```

From an operator, the chat replies:

> Comment added to `k_…`. An agent working on it gets it when its current turn ends; otherwise the next run reads it.

From someone else:

> Comment added to `k_…`, for people: `/kanban show` shows it. Only an operator's comment, or its assignee's or reviewer's, is given to the task's agent.

### Notices

The chat, or the thread, a task was created in follows it and every follow-up its runs create.
It hears when a task:

- is done, with the summary;
- needs review, and from whom;
- blocks, with the kind and the reason;
- is retried after a failure;
- gives up;
- is stranded, with nobody able to take it.

It also hears the one line saying a person was given a task or a review, and when a card could
not reach its person. It does not hear claims by a role, comments, links, requests for changes,
archives, or a run retried quietly after a gateway restart.

Notices are **batched**: each chat or thread gets at most one message every couple of seconds,
listing what happened in order, at most 20 notices, then "… and N more, in the next message."
Notices due while the gateway was down are sent when it is back.

## 9. When things go wrong

### Blocked

A task blocks when its agent, or its person, cannot go on, or when the board stops it. The notice
gives the kind and the reason, and carries an **Unblock** button for an operator:

> **Draft the incident review for the 3 November outage** `k_…` is blocked (needs_input): The logs disagree about when paging started: 02:14 in pager.log, 02:31 in the incident channel.
> `/kanban unblock k_… [comment]` once it can go on.

The kinds:

| Kind | Means |
|---|---|
| `needs_input` | a decision or information only a person can supply; also a stop, and a person's own Block |
| `capability` | something the agent cannot do here: access, a tool, rejected credentials, a model that is unavailable |
| `transient` | expected to clear by itself; the board blocks with it after 10 throttled runs in a row |
| `gave_up` | the board ran out of retries (below) |

Answer the question in the unblock's comment, which the next run reads:

```
/kanban unblock k_… Use pager.log; the channel was opened late.
```

> `k_…` is unblocked, back to open.

A task that keeps blocking for the same reason after unblocks (2 times, by default) gets a
different notice, which suggests rewriting the task, or archiving it and creating a clearer one,
rather than unblocking it again.

### Retries and giving up

A run that fails, crashes, runs past its time limit (4 hours unless set otherwise) or ends without
reporting is retried in a fresh session, whose prompt says what the last attempt did. The chat
hears:

> Retrying **Summarise the vendor contracts** `k_…`. The last attempt ended crashed: …

By default a task gets its first attempt and one retry. After that, it blocks:

> Gave up on **Summarise the vendor contracts** `k_…`: failed 2 times; last crashed: …
> `/kanban unblock k_… [comment]` gives it a fresh set of attempts.

Fix the cause first, then unblock; the unblock resets the count. A throttled run (rate limits,
provider errors) is not counted as a failure: the task cools down, 5 minutes and doubling up to an
hour, and starts again by itself.

### Stranded

A task nobody can be given waits as ready and is never sent to anyone else. Typical causes: no
assignee, a role that was removed, or an agent task whose parents worked in different
workspaces. After 30 minutes the chat hears, once:

> Stranded: **Write the vendor comparison** `k_…`. Nobody can be given it: task k_… has no assignee

Fix it with `/kanban assign`, or, for parents in different workspaces, set the workspace:

```
/kanban workspace k_… worker
```

> `k_…` works in worker.

A task's workspace is fixed at its first start and never changes after; `/kanban workspace` is
refused once it is fixed. A ready task queued behind another in its workspace is not stranded.

### Stop, assign and archive

**Stop** an agent that is going the wrong way. The run is cancelled and the task blocks, so it
does not start again until you unblock it:

```
/kanban stop k_…
```

> Stopped `k_…`: its run was cancelled, and the task is blocked (needs_input). `/kanban unblock k_…` runs it again.

Comment first with what to do differently, then unblock.

**Assign** gives a task to another role or person. A run in progress ends as superseded, and the
next start goes to the new assignee:

```
/kanban assign k_… @Alice Chen
```

> `k_…` is now for Alice Chen (lark:on_…); its run `r_…` was superseded.

**Archive** puts a task away for good, ending any run on it. Its children treat it as finished:

```
/kanban archive k_…
```

> Archived `k_…`.

A done task is never reopened. For more work on it, create a new task with the done task as its
parent, and put the new evidence in the body.

### Approval cards for a supervised role

A role whose agent is supervised, such as `watched`, asks before it acts. Its approval cards go
to the chat that follows the task, naming it ("Task k_…, Rotate the logs, asks: …"), and are
answered there by an operator, as in a chat session. For example:

```
/kanban new Rotate the logs
assignee: watched
Move every log in logs/ older than 30 days into logs/archive/.
```

When the agent wants to write a file, the card appears in this chat. Until someone answers, the
agent waits, and the wait counts toward the run's time limit: an approval left overnight can end
the run as timed out.

## 10. Rules of thumb

- Write `outcome:` and `verify:` on every task you care about, and `stop when:` on anything
  risky.
- Ask agents to say where their results are. A summary is what a child task and a reviewer read
  first.
- Use a gate for anything checkable. A gate that fails tells the agent exactly what is wrong.
- Want the agent to see the gates? Create the task without an assignee, add the gates, then
  `/kanban assign` it.
- Want review? Name a `reviewer:` on the task, or make a separate review task under it, not both.
- Want parallel work? Give each task its own workspace, or they queue.
- Order follow-ups with `parent:` lines, or `parents` from an agent, when you create them.
- Steer with a comment; stop only when the agent is going the wrong way.
- Unblock with a comment that answers the question the block asked.
- Never put a secret in a task, a comment or a gate. Put it in the role's `.env`.
