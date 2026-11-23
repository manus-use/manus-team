# The task board: a usage guide

This guide is for people on the team who drive the manus-team board from Lark: operators who
create and steer tasks, and the people tasks and reviews are given to. It starts with one task
for one agent and builds up to chains, fan-out and review. Section 12 is on workflows, graphs
written once and started many times, and section 13 has recipes for whole graphs of tasks.
Section 15 is on cron jobs, which run beside the board on a clock.

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

**In a group, a task gets a thread.** A `/kanban task new` typed in a group, not inside a thread,
is answered in a thread on your message, and everything about the task goes in that thread: its
notices, its person's cards, and its follow-ups' notices and cards. The group's timeline shows
only your command and its thread. A task created inside a thread uses that thread; one created
in a direct message has none. Plain text typed in a task's thread talks to an agent session, not
to the task; to comment on the task, use `/kanban task comment`. The replies below are as a direct message shows them; in a group
they say "This thread hears" where they say "This chat hears", and, for a person's task, "Their
card comes in this thread when it is ready, or by direct message if they are not in this group"
where they say "They are sent it as a card, in a direct message, once it is ready".

**Commands.** Every command is a group, then a verb. A task's commands are under `/kanban task`
(`/kanban task new`, `/kanban task show k_…`), a board's under `/kanban board`, a gate's under
`/kanban gate`, and `/kanban help` stands alone. A task command typed without `task`, such as
`/kanban new`, is an unknown command.

**Ids.** Every task has an id such as `k_…`, which the chat gives you when the task is created.
Runs have ids such as `r_…`. Wherever an example says `k_…`, use the id the chat gave you.

**Roles.** `/role list` lists the roles in chat, with what each is for, whether it can be given
work, where it works and its open runs; `/roles` is its alias, and says the same. Anyone at talk
tier may run it. Name a role from it on an `assignee:` line.

**Who may do what.** The gateway decides your tier from `auth.talk` and `auth.operate` in its
config, or from a grant (see "Letting people in", below). Anyone at talk tier may use the
board's read commands; anything that changes the board needs operator tier, except a person's
reports on their own task.

| Who | Commands |
|---|---|
| Anyone at talk tier | `/kanban help`, `task list`, `task show`, `task comment`, `gate list`, `board list` |
| Operators | `/kanban task new`, `task assign`, `task link`, `task workspace`, `task unblock`, `task stop`, `task archive`, `gate add`, `gate remove`, `board create`, `board use`, `board set`, `board archive`, and every talk-tier command |
| The person a task is assigned to | `/kanban task done`, `task block` and `task review` on that task, while it is being worked on |
| The person named as a task's reviewer, or any operator | `/kanban task approve` and `task changes` on that task, while it waits for review |

A talk-tier person who tries an operator command is told so:

> `/kanban task new` changes the board, and needs operator permission.

Being named on a task is the permission: a person assigned a task needs only talk tier to report
on it. An operator cannot report `done` on a task assigned to someone else.

The board records whoever acts as `lark:<union_id>`. If Lark sends a message without your
union_id, you can still list and show tasks, but the board refuses any change, and says to ask
the operator to check the app can read user ids.

`/kanban help` lists every command with who may run it.

### Letting people in

A tier comes from the gateway's config, `auth.talk` and `auth.operate`, or from a grant made in
chat or at the terminal. A grant counts at once, with no restart, everywhere a tier is checked:
messages, card buttons, `/kanban` and the people tasks are given to. It never removes a config
entry or the owner. In a group the person is in, @-mention them, so Lark gives their ids:

<!-- example: auth chat -->
```text
/auth grant @Carol Wu talk
/auth grant @Carol Wu operate
/auth revoke @Carol Wu
/auth list
```

> Carol Wu now has talk tier, granted by Alice. `/auth revoke lark:on_…` takes it back.

The reply is the announcement: everyone in the chat sees it. An operator grants and revokes
talk; only the owner grants operate, or revokes an operate grant, so every operator is one the
owner or the config made. A grant takes an @-mention only; `/auth revoke lark:<union_id>` takes
the id `/auth list` shows, for someone who is no longer in the chat. Granting a tier a person
has already is answered with where it comes from, and changes nothing. A revoked person is
refused from their next message on; a turn already running finishes; their tasks stay assigned,
and their next card is refused, so an operator reassigns them.

At the terminal, as the owner, for a person the bot has seen (`mt kanban people` lists them):

<!-- example: auth terminal -->
```
mt auth grant lark:on_5d1e7a operate
mt auth list
mt auth revoke lark:on_5d1e7a
```

`mt auth` judges by the config as your shell reads it, posts in no chat, and is refused in every
agent's shell. `mt auth list --json` gives each person's tier, config entries and grant, with who
made it and when, and `config_known`, false when your shell finds no owner, so that only the grants
are listed.

## 1. One task for a role

Give the task a title on the first line, and name the role on an `assignee:` line. Every line
that is not a field line is the task's body: the instructions the agent reads.

**In Lark, Enter sends the message.** Press Shift+Enter for each line break, or write the message
elsewhere and paste it in.

Paste:

```
/kanban task new Summarise the vendor contracts
assignee: worker
Read every PDF in contracts/2026 and write a one-page summary of renewal dates, notice periods and price caps to notes/contracts.md.
```

The chat replies:

> Created `k_…`: **Summarise the vendor contracts**, for role worker. This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

The dispatcher looks for work as soon as the task is created, so the agent usually starts within
moments. It runs in the role's workspace, `worker`; the paths in the body are relative to that
directory.

When the agent reports that it is done, the chat hears, with the agent's summary quoted:

> Done: **Summarise the vendor contracts** `k_…`
> > Wrote notes/contracts.md: 14 contracts, 3 renewing before March, two with no price cap.

How a message is read:

- The title is the rest of the first line, or the next line if `/kanban task new` stands alone.
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
with `/kanban task assign` (section 9).

## 2. Saying what done means

### The contract

Five optional lines tell the agent, and whoever reviews, what done means. They are put in the
agent's prompt and shown on cards and in `/kanban task show`.

| Line | Means |
|---|---|
| `outcome:` | the end state that must be true |
| `verify:` | what proves it |
| `constraints:` | what must not change or regress |
| `boundaries:` | what is in scope |
| `stop when:` | when to stop and ask instead |

Paste:

```
/kanban task new Draft the incident review for the 3 November outage
assignee: worker
outcome: docs/incidents/2026-11-03.md, with a timeline, the cause and three follow-ups
verify: every timestamp in the timeline comes from the attached logs
constraints: do not name individuals; say "the on-call engineer"
boundaries: this outage only, not the earlier DNS issue
stop when: the logs disagree about when paging started
The logs are in logs/2026-11-03/. Use docs/incidents/template.md.
```

The chat replies:

> Created `k_…`: **Draft the incident review for the 3 November outage**, for role worker. This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

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

A `--` before the command, as the terminal's `mt kanban gate add` takes one, is dropped:
`/kanban gate add k_… -- npm test` and `/kanban gate add k_… --timeout 60 -- npm test` both
store `npm test`. Only the first `--` is dropped; a later one is the command's.

List them, which anyone at talk tier may do:

```
/kanban gate list k_…
```

> Gates of `k_…`, run in this order before it may complete or go to review:
> 1\. test -s docs/incidents/2026-11-03.md (300 s, by Alice Chen)
> 2\. grep -q "## Timeline" docs/incidents/2026-11-03.md (60 s, by Alice Chen)

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
  with `/kanban task assign k_… worker`.

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
/kanban task new Write the on-call handbook page
assignee: worker
reviewer: reviewer
outcome: docs/oncall.md covers paging, escalation and handover
verify: every escalation contact has a phone number
```

> Created `k_…`: **Write the on-call handbook page**, for role worker. This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

When the worker's work is done, the chat hears:

> Review requested for **Write the on-call handbook page** `k_…`, from role reviewer.

For a person, name them with an @-mention: type @ and pick them from Lark's list.

```
/kanban task new Write the on-call handbook page
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
/kanban task new Review the on-call handbook page
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
- **A person** gets a review card, in the task's thread when they are in its group, else in a
  direct message: the handoff, what to review (the reported commit, when one was recorded), the
  body and the contract, a box, and **Approve** and **Request changes**. When it goes by direct
  message, the thread, or the chat the task came from, hears one line:

> 📋 **Write the on-call handbook page** `k_…`, review assigned to Bob Li

### Request changes

A person types what needs changing in the card's box and presses **Request changes**, or types:

```
/kanban task changes k_… Add the weekend escalation path, and a phone number for the database on-call.
```

> Changes requested on `k_…`: it goes back to its assignee, with your reason.

A reason is required: Request changes with an empty box is refused, and the card says to type
what needs changing.

The task goes back to its assignee as a **rework**. For an agent, the rework is a new run whose
prompt carries the reviewer's reason and the previous handoff in full. On bytesec, it also
continues the implementer's own session where it can, so the agent revises what it wrote knowing
why; where it cannot, the prompt still has everything it needs. The rework goes back to the
reviewer when it is done, whether the agent asks for review or reports done, and the chat hears
"Review requested for …" again.

The chat the task came from hears each request for changes, with who asked and the reason on one
line, whoever asked: a reviewer role's agent, a person by card or by command, or an operator:

> Changes requested on **Write the on-call handbook page** `k_…` by Bob Li: Add the weekend escalation path, and a phone number for the database on-call.

### Approve

A person presses **Approve**, or types, with an optional comment:

```
/kanban task approve k_… Looks right. Thanks.
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
/kanban task approve k_…
```

> Approved: `k_…` is complete.

If a reviewer role's agent is working on the review, the operator's answer takes the review from
it: its run is ended, and its turn is stopped. The reply says so:

> Approved: `k_…` is complete; the review run of role reviewer was ended.

`/kanban task changes` does the same, and the task goes back to its assignee as a rework. Anything the
reviewer agent reports afterwards is refused, as its run is over. A person reviewer's review needs
nothing ended: the operator's answer decides it, and the person's card goes out of date.

A person who is neither the reviewer nor an operator is told:

> `/kanban task approve` answers a review, and is for `k_…`'s reviewer (Bob Li) or an operator.

## 4. A person's task

### Giving a person a task

Name the person on the `assignee:` line with a Lark @-mention: type @ and pick them, so Lark
sends who they are with the message. Typing the name without picking it does not work.

Paste:

```
/kanban task new Book the venue for the January offsite
assignee: @Alice Chen
outcome: a confirmed booking for 40 people, 14 to 16 January
Ask facilities for the two rooms on the third floor first.
```

Typed in a group, it is answered in a thread on your message:

> Created `k_…`: **Book the venue for the January offsite**, for Alice Chen. Their card comes in this thread when it is ready, or by direct message if they are not in this group. This thread hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

In a direct message with the bot, the reply says instead "They are sent it as a card, in a direct
message, once it is ready. This chat hears …".

When the task is ready, Alice gets a card from the bot: in the task's thread, starting with an
@-mention of her, when she is in the group; otherwise in a direct message. The card holds:

- the title, the body, the contract, and up to five parents' summaries;
- a box, with **Done** and **Block** under it.

She types a summary and presses **Done**, or types why she is stuck and presses **Block**. Block
with an empty box is refused, and the card says to type why. The box holds up to 1,000
characters; the typed commands take more.

When the card goes by direct message, the thread, or the chat the task came from, hears one line,
naming her in plain text, never as a mention. A card in the thread says the same itself.

> 📋 **Book the venue for the January offsite** `k_…`, assigned to Alice Chen

Pressing a button is answered at once. The card shows "Working on it…", then the outcome, once
any gates have run. A press refused for what it carried, such as an empty box or a failing gate,
redraws the card saying why, ready to press again. A card for a run that is over says it is out
of date and does nothing. Only the person named can press Done and Block.

A card in the thread is seen by everyone in the group, the task's body and contract included,
and anyone may press it, though only Alice's press does anything. If Lark will not take her
direct message because she is outside the app's availability, the card goes to the thread
instead, mentioning her, so the group can bring her in. If the thread refuses the card, it goes
to her by direct message, never to the top of the group.

A person's task never times out: it waits for them, across gateway restarts.

### The typed forms

Each button has a typed form, which works from any chat with the bot, a direct message included.

```
/kanban task done k_… Booked rooms 3A and 3B, confirmation in the facilities ticket.
```

> Done: `k_…` is complete.

The summary is optional. If the task names a reviewer, done sends it to them instead, and the
chat says:

> Sent `k_…` for review to Bob Li: the task names a reviewer, so done asks for review.

Pressing **Done** on the card does the same, and the card says "Sent for review to Bob Li". A
block needs a reason:

```
/kanban task block k_… Facilities need a cost centre before they will confirm.
```

> Blocked `k_…` (needs_input). An operator unblocks it with `/kanban task unblock k_… [comment]`.

To ask for review of your own task, of a reviewer the task does not name, use `/kanban task review`,
with a summary, and name the reviewer on a `reviewer:` line unless the task already names one:

```
/kanban task review k_… Holding rooms 3A and 3B until Friday.
reviewer: @Bob Li
```

> `k_…` is waiting for review, by Bob Li.

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
  (`auth.talk`, or a grant, which needs no earlier message from them). Otherwise the chat says,
  for example:

> @Carol Wu cannot be given work: being assigned lets a person report on the task, which needs talk tier, and the gateway does not know them to have it.

If a card cannot reach the person at all (Lark says they are outside the app's availability), the
chat is told, with the typed commands they can use instead.

### How chat names people

Every reply names a person by the name Lark last gave for them, in plain text, so nobody is
pinged: task lists, `task show`, gate lists, workflow replies, notices, cards, `/cron show` and
`/auth`'s replies. A `lark:on_…` in a task's title or body, as a workflow's person param puts
there, is shown by name too; the task itself keeps the id. A person the gateway has no name for is
shown as `lark:on_…`. When two people the bot has seen share a name, each is followed by the start
of their id, as "Hemanth (on_8ba3…)", so you can tell them apart.

Two places keep the id on purpose, as `/auth revoke` takes it for someone who can no longer be
mentioned:

- `/auth list` shows each person as "Name (lark:on_…)".
- A grant's reply ends "`/auth revoke lark:on_…` takes it back".

The terminal's `mt` commands show the ids, which is what you type there.

## 5. A chain, A → B → C

To run tasks in order, create each one naming the one before it on a `parent:` line. A task waits
(**todo**) until every parent is done, then becomes **ready** and starts.

Create A:

```
/kanban task new Collect last quarter's support tickets
assignee: worker
Export every ticket tagged billing from tickets/2026-q3.csv into data/billing-q3.csv.
```

> Created `k_…`: **Collect last quarter's support tickets**, for role worker. This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

Create B, with A's id as its parent:

```
/kanban task new Group the billing tickets by cause
parent: k_…
assignee: worker
Read data/billing-q3.csv and write the five most common causes, with counts, to notes/billing-causes.md.
```

Create C, with B's id as its parent:

```
/kanban task new Write the billing FAQ draft
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

A link can be added later with `/kanban task link <parent> <child>`, an operator's command, as long as
the child has not started:

```
/kanban task link k_… k_…
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

Or make `worker`'s workspace **isolated**, and give each task a directory of its own, with no
new workspaces at all. In the gateway's config, write `worker` as a mapping, keeping its path,
and add `isolated: true`:

```yaml
workspaces:
  worker:
    path: /home/me/.manus-team/workspaces/worker
    isolated: true
```

Keep its path: a workspace keeps the directory it was first used with. Then the vendor tasks
below drop their `workspace: vendor-x` lines, and the three run at once. Where `worker` is a
plain folder, as research usually is, each task gets a folder of its own under
`$MT_HOME/worktrees/worker/`, and the comparison's prompt lists the three folders their notes
are in, to read. Nothing is copied, and nothing is said about git. `/kanban task show` says where
a task's directory is.

Each task's folder starts empty. Its prompt also names `worker`'s own folder, the path above, as
the place to read shared inputs from, while the task's results go in its own folder. So put
input files such as `vendors/candidates.md` in `worker`'s own folder, or have a parent task
write them in its results.

Where the workspace is a git repository, and only there, git is used: each task's directory is a
worktree on its own branch, `mt/<task_id>`, and the write-up starts from a merge of the three
branches. If that merge conflicts, the write-up blocks, naming the files, for you to resolve in
its directory and unblock. Nothing is merged into your own branches.

Running agents are also capped by `kanban.max_running` in the gateway's config: at most that many
agent runs at once, across all workspaces. It defaults to `maxLiveSessions` (8 unless set), and
cannot be above it. Set it lower to keep room for chat sessions. A person's task holds no
workspace and does not count.

A role can be capped too, so a burst of one role's tasks across many workspaces does not take
every slot. `max_running: 2` in `roles/worker/config.yaml` lets at most two of `worker`'s runs be
open at once; `kanban.max_running_per_role` in the gateway's config is the limit for every role
that sets none of its own. A work run counts against the task's assignee, a review run against
its reviewer. Both are read at startup and refused above `kanban.max_running`. A task whose role
is at its limit waits, `/kanban task show` says so, and the tasks behind it, for other roles,
still start. Here, `max_running: 2` on `worker` would run two of the three vendor tasks at once,
and the third as soon as one of them ends.

### The tasks

The research task:

```
/kanban task new Survey the vendors
assignee: worker
outcome: notes/vendors.md lists the three vendors we shortlist, with a one-line reason each
Shortlist three log-storage vendors from vendors/candidates.md.
```

Each of the three, with the survey's id as parent and its own workspace (change the letter for B
and C):

```
/kanban task new Price out vendor A
parent: k_…
workspace: vendor-a
assignee: worker
constraints: put the findings in your summary, not only in files
Take the first vendor in the parent's summary. Find list prices for 5 TB and 50 TB a month, retention options and egress costs.
```

The write-up, with three `parent:` lines, one per vendor task:

```
/kanban task new Write the vendor comparison
parent: k_…
parent: k_…
parent: k_…
assignee: worker
outcome: docs/vendor-comparison.md, one table and a recommendation
```

How it runs:

- The survey runs first; the three vendor tasks are todo until it is done.
- Then all three are ready together and start in parallel, one in each workspace, up to
  `kanban.max_running` and `worker`'s own `max_running`, if it has one.
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
/kanban task new Plan the runbook rewrite
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
  and so on down the line. A follow-up of a task with a thread is in that thread, and so is its
  person's card, when they are in the group.
- A follow-up has the same limits as a task from chat, and can be given to a role or to a person
  the gateway knows, by `lark:<union_id>`.

## 8. Watching and steering

### The board

```
/kanban task list
```

> `k_…` **running**: Survey the vendors · role worker
> `k_…` **todo**: Price out vendor A · role worker
> `k_…` **todo**: Write the vendor comparison · role worker
> `k_…` **blocked**: Book the venue for the January offsite · Alice Chen

Without a status it shows the tasks someone may still act on, grouped as running, reviewing,
review, ready, todo, then blocked. Name a status to see only those: `todo`, `ready`, `running`,
`review`, `reviewing`, `blocked`, `done`, `archived`, or `all` for every task.

```
/kanban task list done
```

It shows at most 30 lines, then how many more. With nothing open, it says:

> No open tasks. `/kanban task list all` shows done and archived ones too.

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
/kanban task show k_…
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

It shows the task, its parents and children with the status of each, its contract, gates, its
last five runs, the last 800 characters of the latest run's output, and its last five comments.

A ready task, or one waiting for its reviewer, that the dispatcher is passing over says why, one
line for each reason that holds:

> waiting: the gateway is at its kanban.max\_running, 4 agent runs at once; it is claimed when one of them ends
> waiting: board web-app is at its max\_running, 1 agent run at once; it is claimed when one of them ends
> waiting: role worker is at its max\_running, 2 agent runs at once; it is claimed when one of them ends
> waiting: workspace api is busy with task `k_…`'s agent run; it is claimed when that run ends

Nothing is said of a task that cannot be claimed for another reason: a parent not done, nobody
assigned, a role or workspace that is not configured (section 9, Stranded).

### Comments, and who can steer

Anyone at talk tier may comment, and everyone sees comments in `/kanban task show`. Only some comments
reach the agent:

- **Steer:** an operator's comment, and the task's named assignee's or reviewer's. The agent gets
  it when its current turn ends; if no agent is working on the task, the next run reads it.
- **Stored only:** anyone else's. It is shown to people, never given to an agent.

```
/kanban task comment k_… Use UTC for every timestamp, and say so under the heading.
```

From an operator, the chat replies:

> Comment added to `k_…`. An agent working on it gets it when its current turn ends; otherwise the next run reads it.

From someone else:

> Comment added to `k_…`, for people: `/kanban task show` shows it. Only an operator's comment, or its assignee's or reviewer's, is given to the task's agent.

### Notices

The chat, or the thread, a task was created in follows it and every follow-up its runs create;
for a task created in a group at chat scope, the thread its "Created" reply opened. It hears
when a task:

- is done, with the summary;
- needs review, and from whom;
- has changes requested, by whom, with the reason;
- blocks, with the kind and the reason;
- is retried after a failure;
- gives up;
- is stranded, with nobody able to take it.

It also hears the one line saying a person was given a task or a review, when their card went by
direct message, and when a card could not reach its person. It does not hear claims by a role,
comments, links, archives, or a run retried quietly after a gateway restart.

Notices are **batched**: each chat or thread gets at most one message every couple of seconds,
listing what happened in order, at most 20 notices, then "… and N more, in the next message."
Notices due while the gateway was down are sent when it is back.

### Wakes

A task with **wake** on does more than notify: when it is done, has changes requested, blocks
in its run, gives up or is stranded, the agent of the conversation that follows it is woken
there, in its thread or the chat, to decide what to do next. Wake is off unless asked for, task
by task. Turn it on when you make the task, with a field line:

<!-- example: wake task new -->
```
/kanban task new Book the venue
assignee: worker
wake: on
```

The "Created" reply ends `Its outcomes wake the agent here.` For a task that exists, in a chat
that follows it (its thread, or the chat it was made at), at talk tier:

<!-- example: wake task wake -->
```
/kanban task wake k_7gq2 on
/kanban task wake k_7gq2 off
```

A workflow's start takes the trailing word `wake`, for every member; a step that says `wake: true`
asks for one by itself. At a terminal, `mt kanban task new … --chat oc_… --wake`, `mt kanban
workflow start … --chat oc_… --wake` and `mt kanban task wake <task_id> on|off` do the same; a
terminal's wake needs a chat to follow the task, and runs as the owner, once the gateway has seen
them in Lark. A task a run makes inherits its task's wake.

What the thread sees, for each outcome: the notice, as always; then one line,
`Waking the agent for 1 board update.`, or `2 board updates` for two at once; then the agent's card, whose first
line says it was woken by the board, and as whom. The woken turn runs as the person who turned
wake on, at talk tier: it is answered in the thread like any turn, a message typed during it
waits behind it, and `/stop` cancels it. Each outcome wakes once; a block nobody answers is not
woken again.

A woken turn may read the tasks that woke it with `mt kanban task show <id>`, and, when the
person who set the wake has operate tier, lift a block that woke it with `mt kanban task unblock
<id> <comment>`: the comment, marked `(woken by the board)`, goes to the task's next run, and the
notice is redrawn `Unblocked by <name> (woken by the board)`. It is told so in its prompt, and
told when it cannot. A block a person lifts before the turn starts is left out of it.

The limits: at most `kanban.wake.per_hour` woken turns a conversation in any hour, 6 by default
(past it the thread is told `wakes are paused here until HH:MM`, and what comes meanwhile waits
for one later turn); a task made in a woken turn's own shell is one level deeper, and a task 5
deep (`kanban.wake.max_depth`) stays notice-only; and a woken turn's agent may unblock one task
at most `kanban.wake.max_depth` times (5 by default) between two completions. A setter who loses talk tier has their tasks' outcomes
noticed and not woken, and the thread is told once. The settings, with their defaults:

<!-- example: config wake -->
```yaml
kanban:
  enabled: true
  wake:
    enabled: true
    per_hour: 6
    max_depth: 5
    hold_minutes: 10
```

With `kanban.wake.enabled: false` nothing is woken, and a wake asked for is refused; turned on
again, what waited is woken, one turn a conversation and setter. `/kanban task show` says each
task's wake: `Wake: on, set by Zhixi Sun, depth 0`, with when it last woke.

## 9. When things go wrong

### Blocked

A task blocks when its agent, or its person, cannot go on, or when the board stops it. The notice
gives the kind and the reason, and carries an **Unblock** button for an operator:

> **Draft the incident review for the 3 November outage** `k_…` is blocked (needs_input): The logs disagree about when paging started: 02:14 in pager.log, 02:31 in the incident channel.
> `/kanban task unblock k_… [comment]` once it can go on.

The kinds:

| Kind | Means |
|---|---|
| `needs_input` | a decision or information only a person can supply; also a stop, and a person's own Block |
| `capability` | something the agent cannot do here: access, a tool, rejected credentials, a model that is unavailable |
| `transient` | expected to clear by itself; the board blocks with it after 10 throttled runs in a row |
| `gave_up` | the board ran out of retries (below) |

Answer the question in the unblock's comment, which the next run reads:

```
/kanban task unblock k_… Use pager.log; the channel was opened late.
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
> `/kanban task unblock k_… [comment]` gives it a fresh set of attempts.

Fix the cause first, then unblock; the unblock resets the count. A throttled run (rate limits,
provider errors) is not counted as a failure: the task cools down, 5 minutes and doubling up to an
hour, and starts again by itself.

### Stranded

A task nobody can be given waits as ready and is never sent to anyone else. Typical causes: no
assignee, a role that was removed, or an agent task whose parents worked in different
workspaces. After 30 minutes the chat hears, once:

> Stranded: **Write the vendor comparison** `k_…`. Nobody can be given it: task k_… has no assignee

Fix it with `/kanban task assign`, or, for parents in different workspaces, set the workspace:

```
/kanban task workspace k_… worker
```

> `k_…` works in worker.

A task's workspace is fixed at its first start and never changes after; `/kanban task workspace` is
refused once it is fixed. A ready task queued behind another in its workspace, or waiting for a free slot under the gateway's, its board's or its role's `max_running`, is not stranded.

### Stop, assign and archive

**Stop** an agent that is going the wrong way. The run is cancelled and the task blocks, so it
does not start again until you unblock it:

```
/kanban task stop k_…
```

> Stopped `k_…`: its run was cancelled, and the task is blocked (needs_input). `/kanban task unblock k_…` runs it again.

Comment first with what to do differently, then unblock.

**Assign** gives a task to another role or person. A run in progress ends as superseded, and the
next start goes to the new assignee:

```
/kanban task assign k_… @Alice Chen
```

> `k_…` is now for Alice Chen; its run `r_…` was superseded.

**Archive** puts a task away for good, ending any run on it. Its children treat it as finished:

```
/kanban task archive k_…
```

> Archived `k_…`.

A done task is never reopened. For more work on it, create a new task with the done task as its
parent, and put the new evidence in the body.

### Approval cards for a supervised role

A role whose agent is supervised, such as `watched`, asks before it acts. Its approval cards go
to the chat, or the thread, that follows the task, naming it ("Task k_…, Rotate the logs, asks:
…"), and are answered there by an operator, as in a chat session. For example:

```
/kanban task new Rotate the logs
assignee: watched
Move every log in logs/ older than 30 days into logs/archive/.
```

When the agent wants to write a file, the card appears in this chat. Until someone answers, the
agent waits, and the wait counts toward the run's time limit: an approval left overnight can end
the run as timed out.

## 10. Boards

Several projects can share one gateway. Give each its own **board**: a queue of tasks of its
own. A board has its own list in chat, takes its turn with the dispatcher, so that a burst of
tasks on one board cannot hold up another, and may have its own limit on how many agents it runs
at once, and its own default workspace. One gateway, with one database, serves every board.

Every gateway has a board called `default`. Every task created before boards existed is on it,
and every chat starts on it. A gateway that never makes another board works as it always did.

### Making a board, and moving a chat onto it

```
/kanban board create web-app
```

> Created board **web-app**. `/kanban board use web-app` puts a chat on it.

A board's name follows the rule for role and workspace names: lowercase letters, digits and
`-`, starting with a letter, not ending with `-`, at most 40 characters. A name is never renamed
or reused, an archived board's included. `none` and `all` are not board names: in the board
commands, `none` means "clear" and `all` means every board.

```
/kanban board use web-app
```

> This chat is on board **web-app** now: its `/kanban task new` adds tasks to it, and `/kanban task list`
> shows them.

A chat is the whole conversation: a group and every thread in it are on one board, and no other
chat moves with it. Keep each project's group on its project's board; a direct message with the
bot can move between boards as you need.

### What a board changes

- `/kanban task new` creates the task on this chat's board. The reply names the board, unless it is
  `default`.
- `/kanban task list` shows this chat's board alone. On a board other than `default`, a line of its
  own names the board above the tasks; on `default` there is none, as before. `all` still means
  every status, on this board.
- `/kanban task show k_…` shows a task on any board, by its id, and names its board once any board
  but `default` is involved.
- Every other command that names a task (`assign`, `comment`, `approve` and the rest) works on
  a task on any board, by its id. The commands a notice gives, and its Unblock button, keep
  working after the chat has moved.
- A task's follow-ups stay on its board: those its agent creates with `mt kanban create`, and
  those a done task is given.
- `parent:` and `/kanban task link` cannot cross boards. A follow-up created from chat with `parent:`
  must be created from a chat on the parent's board; from a chat on another board it is refused:

  > Not done: task k\_… is on board default, not web-app: a task and its parents are on one board

- Notices go where they always did: to the chat a task was created in. A chat that moves to
  another board still hears about the tasks it created before.

### Listing the boards

```
/kanban board list
```

> **default**: 2 open, 14 done
> **web-app** (this chat): 3 open, 1 in review · max\_running 1 · workspace web
> `/kanban board use <name>` moves this chat to another board; `/kanban board create <name>` makes one.

`/kanban board list all` lists archived boards too.

### A board's own limit and workspace

```
/kanban board set web-app max_running 1
```

> Board **web-app** runs at most 1 agent at once now.

The gateway's own `kanban.max_running` still holds over every board together, so a board's own
is at most that; `none` clears it. One agent at a time per workspace is still the gateway's rule,
across boards: two boards' tasks in one workspace take turns. A role's own `max_running` holds
across boards too: a role at its limit waits on every board, and each board goes on to its tasks
for other roles.

```
/kanban board set web-app workspace web
```

> Board **web-app**'s tasks work in web now, unless their own workspace, their role's or their
> parents' says otherwise.

A board's workspace is the last resort, in place of `default`, for a task with no `workspace:`
line, whose role names no workspace, and whose parents have none. It applies to tasks claimed
from then on; a task already working somewhere stays there. `none` clears it, so a workspace
called `none` cannot be a board's workspace. If a board's workspace is removed from config, its
agent tasks that would land there wait as stranded, but a person's task claimed there keeps that
workspace as its own.

### Archiving a board

```
/kanban board archive web-app
```

It is refused while any of the board's tasks is open, in review or blocked: finish or archive
them first. Once it is archived, nothing more is added to it, and no chat can move onto it; its
tasks stay, and `/kanban task show` still shows them. A chat still on it is told to move before its
next `/kanban task new`, and its `/kanban board list` still lists it, marked archived. `default` is never
archived.

### Who may do what

Anyone at talk tier may list the boards. Creating, using, setting and archiving a board are
operator commands: moving a chat onto a board changes where its tasks go, and so which workspace
an agent may run in.

## 11. From a terminal

Whoever runs the gateway can drive the board from a shell on its host, with `mt kanban`: chat's
commands, in the same groups (`mt kanban task …`, `mt kanban board …`, `mt kanban gate …`), with
the same meaning, recorded as `operator:<login>`, the login of the account `mt`
runs as (under `sudo -u`, the service account). It needs no Lark settings,
and works beside the running gateway.

```
mt kanban board create web-app
mt kanban task new "Draft the Q3 summary" --board web-app --assignee docs-writer --workspace docs \
    --outcome "a page in the team wiki" --verify "the page links every source" \
    --body "Use last quarter's page as the model."
mt kanban task list --board web-app
mt kanban task show k_…
mt kanban task stop k_…
mt kanban people
mt kanban task new "Book the venue for the offsite" --assignee lark:on_5d1e7a --chat oc_xxx
```

> created k\_…: Draft the Q3 summary, for role docs-writer, in docs, on board web-app

- There is no `board use`: a terminal is no chat. `task new` and `task list` take
  `--board <name>`, and are on `default` without it.
- The task commands that name a task (`show`, `assign`, `link`, `unblock`, `stop`, `archive`
  and `comment`) work on a task on any board, by id. Give them `--board <name>` to be sure: a task
  on another board is then refused, and for `link` both tasks must be on it.

  > mt: task k\_… is on board default, not web-app
- `task new` takes the lines of `/kanban task new` as flags: `--assignee`, `--reviewer`, `--workspace`,
  `--parent` (as often as needed), `--outcome`, `--verify`, `--constraints`, `--boundaries` and
  `--stop-when`. The body is `--body "…"`, or `--body-file` with a file, or `-` to read it from
  stdin.
- A person is `lark:<union_id>`: `--assignee`, `--reviewer` and `task assign` take one, checked
  as chat checks one: known to this gateway, and at talk tier by the owner and `auth.talk` this
  shell's settings give, or by a grant. `mt kanban people` lists the people the gateway knows, by
  name, with their `lark:` ids and `talk` or `no`, a grant counted; `--json` says whether talk
  tier comes from the config or a grant. There are no @-mentions here: `@Alice` is refused.
- `--chat oc_…` makes that chat follow the task, as a chat follows a task made in it: the gateway
  posts it a line, "Created `k_…` **Book the venue for the offsite**, for Dana Wu, by
  operator:alice from a terminal.", then the task's notices. `--thread omt_…` puts them in a thread
  of that chat whose root the board already knows, from a task made in it from chat; a thread it
  does not know is refused. A chat outside a non-empty `auth.chats` is refused, as the gateway
  would not answer there. Without `--chat`, no chat follows the task, so nobody is told when it
  is done or blocks: look with `mt kanban task show`. The board is still `--board`, whatever the
  chat. With `--key`, a second run answers the first task and names the chat that follows it.
- `task list` has an `age` column, the time since each task's phase last changed (todo, ready
  and running count as one, from when it was made or sent back), `45m`, `5h` or `3d`; `--json` gives each task's `created_at` and `status_since`, in milliseconds.
- After a change, the running gateway is told to look for work at once, and to stop the agent
  of a run the change ended. If no gateway answers, `mt` says so, and why; the change stands,
  and the gateway acts on it at its next sweep, or when it next starts. Do not run the command
  again: a second `task new` makes a second task. If the board is off on the gateway
  (`kanban.enabled` unset, or false), `mt` says that instead: nothing runs the change until it
  is turned on.
- `mt kanban task worktree <task_id>` prints the directory of a task in an isolated workspace,
  alone, so you can `cd "$(mt kanban task worktree k_…)"` to resolve a merge there. In `mt kanban
  task show --json`, such a task's `worktree` is `{"path", "branch", "made", "first"}`, and null
  for a task in a shared directory: `path` and `branch` are null and `made` false until the
  directory is made; `first` is true while no agent has taken the task up, so its first agent
  claim makes it, and false once one has.
- A task command needs `task`: `mt kanban new`, without it, is an unknown command. `mt kanban
  show`, `comment` and `link` are the commands an agent runs inside a board run, which take JSON
  on stdin and work only there.
- Add `--json` for one line of JSON, for scripts. `mt` exits 0 when done, 1 when refused, and
  2 for a wrong command line.

## 12. Workflows

A team runs the same shape of work again and again: shortlist, evaluate each candidate,
recommend one; draft, review, publish. A **workflow** is that graph written once, in a file on
the gateway's host, and started as often as needed. **Starting** it makes one **instance**,
`w_…`: every task and every link of the graph, at once, in one go, or none of them.

Six workflows ready to copy, from a weekly report to a triage step that routes requests, are in
[examples.md](examples.md), part 1.

### The file

One YAML file a workflow, at `~/.manus-team/workflows/<name>.yaml`, named as a role is:
lowercase letters, digits and `-`. This is `vendor-eval.yaml`:

<!-- example: workflow vendor-eval -->
```yaml
description: Shortlist vendors, evaluate each in parallel, then recommend one
params:
  topic:    { required: true, description: what is being bought }
  vendors:  { list: true, required: true }
  reviewer: { default: reviewer }
steps:
  shortlist:
    title: Shortlist vendors for {{topic}}
    assignee: worker
    outcome: a shortlist with one line per vendor
  evaluate:
    for_each: vendors
    parents: [shortlist]
    title: Evaluate {{item}} for {{topic}}
    assignee: worker
    gates:
      - command: test -s evaluation.md
        timeout_s: 30
  recommend:
    parents: [evaluate]
    title: Recommend a vendor for {{topic}}
    assignee: worker
    reviewer: { role: "{{reviewer}}" }
    verify: every score comes from a parent's summary
```

- **A step is a task to make.** It takes the fields `create` does: `title`, `body`,
  `assignee`, `reviewer`, `workspace`, `priority`, the contract (`outcome`, `verify`,
  `constraints`, `boundaries`, `stop_when`), `failure_limit`, `retry_on_crash` and
  `max_runtime_s`, and `gates`, as `/kanban gate add` takes them. An unknown key is an error
  that names its place, such as `steps.evaluate.timeout`.
- **`parents`** names the steps a step waits for, each written above it. A step whose parent is
  a `for_each` step waits for all of its tasks.
- **`for_each: <list param>`** makes one task an item, with `{{item}}` set to the item. Two
  `for_each` steps over one list are linked all to all: each review waits for every evaluation.
- **Params** are text, or lists with `list: true`; each is `required: true` or has a `default`.
  `{{name}}` fills them into the text fields, a list as its items joined by `, `. In
  `assignee`, `reviewer` and `workspace` the whole value may be one reference, `"{{reviewer}}"`,
  and it is checked as a name. **Quote a value that starts with `{{`**: YAML reads an unquoted
  `{{reviewer}}` as a mapping.
- **Params never reach a gate.** A gate is a shell command the gateway runs; a `{{` in one is an
  error. A gate that needs a value names it as an environment variable, `$NAME`, from the role's
  environment.
- **At most 100 tasks** an instance, and a file of at most 64 KiB.

`mt workflow check` reads the files, and says of each whether it is usable, and why not:

```
$ mt workflow check
vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)
```

The gateway checks them at startup too, and notes the broken ones; a broken workflow does not
stop it. The files are read at each preview and start, so an edit needs no restart.

### Starting it

```
/kanban workflow start vendor-eval topic="log storage" vendors=acme,globex
```

> Started vendor-eval as `w_…`, 4 tasks:
> - `k_…` Shortlist vendors for log storage, for role worker
> - `k_…` Evaluate acme for log storage, for role worker
> - `k_…` Evaluate globex for log storage, for role worker
> - `k_…` Recommend a vendor for log storage, for role worker
> This thread hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

- **Params** are `key=value`, split at the first `=`. Quote a value with spaces, `"…"`; a list
  is comma-separated, or its key repeated, and a quoted value is one item, so
  `vendors="Acme, Inc"` is one vendor. A person is an @-mention, `owner=@Alice Smith`, for a param
  that lands in `assignee` or `reviewer`.
- **An operator's command**, as `/kanban task new` is: a start starts agents. The tasks go on this
  chat's board, and this chat follows every one; in a group the reply opens a thread of its own,
  the instance's, where its cards and notices go.
- **One failure refuses the whole start**, naming the task, and nothing is made:

  > Not done: evaluate:2, step evaluate, item "globex": role "evaluator" is not configured
- **A start is keyed by its message**: a redelivery makes nothing twice.

`/kanban workflow preview vendor-eval topic="log storage" vendors=acme,globex` says what a start
would make, with each task's parents and gates, and makes nothing. Anyone allowed may preview.

### Seeing and managing

```
/kanban workflow list                 # the workflow files: name, description, params
/kanban workflow instances [all]      # this chat's board's instances: running and blocked unless all
/kanban workflow show w_…             # one instance: its steps' tasks, and its related tasks apart
/kanban workflow archive w_…          # archive every task of it
```

An instance's status is derived from its tasks: **blocked** when any is, with how many,
**done** when every one is done or archived, **archived** when every one is, **running**
otherwise. Nothing is automatic on a failure: a blocked task is unblocked, reassigned or routed
around with the task commands, as in recipe 5. Its tasks are ordinary tasks, and every change to
one is made with them. `/kanban task show` of one says which instance and step it is from.

### A step that decides

A workflow has no conditions: every step becomes tasks at the start. One that must branch has a
**deciding step**, whose agent reads its parents' handoffs, decides, and then makes the tasks of
the branch it chose, with `mt kanban create`, by starting another workflow with `mt kanban
start-workflow`, or with a graph of its own, `mt kanban apply-dag`. A gate on that step, such as
`test -s decision.md`, holds it until the decision is written down:

```yaml
  decide:
    parents: [evaluate]
    title: Decide whether to pilot a vendor or look again, for {{topic}}
    assignee: worker
    body: >
      Read the evaluations. Write decision.md saying which and why. To pilot, start the
      workflow pilot with mt kanban start-workflow; to look again, start vendor-eval
      with a new list of vendors.
    gates:
      - command: test -s decision.md
```

The tasks it makes are created from the deciding task, follow its chat and thread, and show as
a related instance in `/kanban workflow show` of the first.

### Workspaces

A workflow's tasks resolve their workspaces at their claims, as any task's do: a step's own
`workspace`, its role's, its parents', the board's. **A fan-out in one shared workspace runs one
task at a time**: the evaluations above queue behind each other in the shortlist's workspace.
They run side by side only in an isolated workspace (section 6), or with roles that work in
workspaces of their own. A step whose parents certainly work in different workspaces, and which
names none, is refused by the check: set its `workspace`.

### From a terminal, and from an agent

At the terminal, `mt kanban workflow start vendor-eval --param topic="log storage" --param
vendors=acme,globex --key ls-1` starts it, with `--board` and `--json` as the other commands
take them, and `mt kanban workflow preview … --json > dag.json` writes the **DAG** a start would
make: a JSON file of every task, its parents by ref, and its gates. Edit it if need be, check it
with `mt kanban workflow apply dag.json --dry-run`, which lists every task and gate command and
makes nothing, and make it with `mt kanban workflow apply dag.json --key ls-1` (recipe 4). `mt
kanban workflow show w_… --dag` prints the DAG an instance was made from, which `apply` takes
again.

`start` and `apply` take `--chat oc_… [--thread omt_…]` as `task new` does: every task of the
instance is followed from that chat, and the gateway posts there the start's reply, naming the
instance and its tasks. A param that lands in a person field, and a DAG's `assignee` or
`reviewer`, take `lark:<union_id>`, checked at the start and by `apply --dry-run`; the preview
opens no database, so it leaves people unchecked and says so.

An agent starts a workflow from its run with `mt kanban start-workflow < start.json`, as
`{"workflow": "vendor-eval", "params": {"topic": "log storage", "vendors": ["acme", "globex"]}}`,
and makes a graph of its own at once with `mt kanban apply-dag < dag.json` (recipe 3), which
takes no gates: gates are the operator's.

## 13. Recipes: graphs of tasks

Each recipe below is a small graph of tasks (a DAG: each task waits for its parents, and nothing
waits on itself), with the messages to paste, what happens at each step, and what goes wrong.
They use the roles as one team runs them:

- `worker`: a bytesec agent, in its own workspace, `worker`.
- `reviewer`: a bytesec agent with no workspace of its own, so its review runs work where the
  task under review works.
- `planner`: a bytesec agent, in its own workspace, `planner`, that splits a goal into tasks
  (recipe 3).
- `watched`: the supervised test role. No recipe needs it.

And the limits, in the gateway's config:

```yaml
kanban:
  enabled: true
  max_running: 4            # agent runs at once, across every board and role
  max_running_per_role: 2   # agent runs at once as any one role that sets no max_running
```

Neither `worker` nor `reviewer` sets a `max_running` of its own, so each may have two agent runs
open at once. On top of both limits, a workspace runs one agent at a time.

Ids in the replies are shown as `k_…`; the chat gives the real ones.

### Recipe 1: research, then parallel work, then a write-up

```
                Write the caching options brief          (worker, in worker)
               /               |               \
   Prototype option A   Prototype option B   Prototype option C   (worker, in research-a, -b, -c)
               \               |               /
                Write the caching recommendation          (worker, in worker)
```

**Before you start: one workspace per parallel task.** All three prototypes are for `worker`,
whose own workspace is `worker`. Without a `workspace:` line, each would run there, and since a
workspace runs one agent at a time, they would run one after the other. On the gateway's host:

```
mt workspace add research-a /srv/work/research-a
mt workspace add research-b /srv/work/research-b
mt workspace add research-c /srv/work/research-c
mt service restart
```

Each directory must exist first. The gateway reads its workspaces when it starts, so restart it
(`mt service restart` for the service; stop and start it otherwise). A `workspace:` naming a
workspace the gateway does not have yet is refused at once, and nothing is created.

Simpler, once your gateway has isolated workspaces: mark `worker`'s own workspace `isolated: true`
(section 6), keeping its path, and restart. Then the three prototypes need no `workspace:` line:
each runs at once in a folder of its own under `$MT_HOME/worktrees/worker/`, and the
recommendation's prompt lists their folders to read. Each folder starts empty, and each prompt
names `worker`'s own folder for shared inputs: keep an input file, such as `docs/reports-api.md`
below, there, or in a parent's results.

**The tasks.** The brief:

```
/kanban task new Write the caching options brief
assignee: worker
outcome: a brief naming three caching options for the reports API, each with what to measure
verify: each option names one benchmark command
constraints: put the brief itself in your summary, not only in a file
Read docs/reports-api.md and propose three ways to cache report results.
```

> Created `k_…`: **Write the caching options brief**, for role worker. This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

Each prototype, with the brief's id as parent, and its own workspace (change the letter for B and
C):

```
/kanban task new Prototype caching option A
parent: k_…
workspace: research-a
assignee: worker
outcome: a measured p95 latency for option A, with and without the cache
constraints: put the numbers and how you got them in your summary
Take option A from the parent's brief. Build the smallest prototype that can be measured.
```

> Created `k_…`: **Prototype caching option A**, for role worker, in research-a. This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

The reply names the workspace when the task has its own. The write-up, with the three prototypes
as parents, on one line:

```
/kanban task new Write the caching recommendation
parent: k_…, k_…, k_…
assignee: worker
outcome: docs/caching.md, one table of the three options and a recommendation
verify: every number in the table comes from a parent's summary
```

`/kanban task list` now shows:

> `k_…` **ready**: Write the caching options brief · role worker
> `k_…` **todo**: Prototype caching option A · role worker
> `k_…` **todo**: Prototype caching option B · role worker
> `k_…` **todo**: Prototype caching option C · role worker
> `k_…` **todo**: Write the caching recommendation · role worker

**What happens:**

1. The brief starts at once, in `worker`. The prototypes and the write-up are todo.
2. The brief's agent reports complete. The chat hears:

   > Done: **Write the caching options brief** `k_…`
   > > Brief: A) per-report memo cache, B) Redis with 10-minute TTL, C) precomputed nightly snapshots. Benchmark: npm run bench:reports.

3. All three prototypes are ready together. `worker` may have two agent runs open at once
   (`max_running_per_role: 2`), so the dispatcher starts A and B, the oldest first, in
   research-a and research-b. C waits, and `/kanban task show` on it says:

   > waiting: role worker is at its max\_running, 2 agent runs at once; it is claimed when one of them ends

   C starts as soon as A's or B's run ends. The gateway's `max_running: 4` does not bind here:
   only two runs are open.
4. Each prototype's prompt holds the brief's summary and metadata, under "The tasks this one
   depends on, and what each handed off". The brief's files stay in `worker`; a prototype in
   research-a cannot find them by a relative path. That is why the brief is told to put the brief
   itself in its summary.
5. The write-up stays todo until all three prototypes are done, then runs in `worker`, the role's
   own workspace. Its prompt holds each parent's handoff:

   ```
   The tasks this one depends on, and what each handed off:

   ## Parent k_…: Prototype caching option A (done)
   Summary: Option A: p95 410 ms with the cache, 900 ms without (npm run bench:reports, 200 runs).

   ## Parent k_…: Prototype caching option B (done)
   Summary: Option B: p95 120 ms with the cache, 900 ms without (npm run bench:reports, 200 runs).

   ## Parent k_…: Prototype caching option C (done)
   Summary: Option C: p95 35 ms with the cache, 900 ms without (npm run bench:reports, 200 runs).
   ```

   Each parent's metadata follows its summary, when it reported any.

**Pitfalls:**

- **No `workspace:` lines, no parallelism.** The three prototypes would all run in `worker`, one
  at a time, whatever the role's limit. `/kanban task show` on a waiting one says `waiting:
  workspace worker is busy with task k_…'s agent run`.
- **The role's limit, not the workspaces, sets the width.** With `max_running_per_role: 2`, three
  workspaces still run two prototypes at once. To run all three, set `max_running: 3` in
  `roles/worker/config.yaml` (at most `kanban.max_running`), and restart the gateway.
- **The write-up reads summaries, not files.** Each prototype's files are in its own workspace.
  Tell every parallel task to put its findings in its summary, as the `constraints:` line does.
- **The write-up does not follow its parents' workspaces.** Its role names `worker`, which comes
  before the parents' workspace in the order a workspace is chosen. For a role with no workspace
  of its own, such as `reviewer`, a task whose parents are in three different workspaces is
  stranded until you give it one with `/kanban task workspace k_… <name>`.

### Recipe 2: build, review, release

```
   Add CSV export to the reports API     (worker, in api; reviewer: role reviewer; gate: npm test)
        |   work -> review -> changes -> rework -> review -> approved
        v
   Release the CSV export                (Dana Park, as a card)
```

`api` is a workspace holding the repository (`mt workspace add api /srv/repos/api`).

**The tasks.** Create the implementation with no `assignee:` line, so the gate is in place before
its agent starts and its prompt lists it:

```
/kanban task new Add CSV export to the reports API
workspace: api
reviewer: reviewer
outcome: GET /reports/:id.csv returns the report as CSV, with a header row
verify: npm test passes, and a new test covers the CSV route
constraints: do not change the JSON route's output
stop when: the report model has fields that cannot be flattened to columns
```

> Created `k_…`: **Add CSV export to the reports API**, for nobody yet (`/kanban task assign k_… <role or @person>` gives it to someone), in api. This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

Add the gate. Everything after the task id is the command, as typed:

```
/kanban gate add k_… npm test
```

> Gate 1 added to `k_…` (300 s): npm test

For work that is not code, a gate is any check that exits 0, such as
`/kanban gate add k_… grep -q "CSV export" CHANGELOG.md`.

Then give it to the role:

```
/kanban task assign k_… worker
```

> `k_…` is now for role worker.

The release, for a person, with the implementation as parent. Type @ and pick her from Lark's
list:

```
/kanban task new Release the CSV export
parent: k_…
assignee: @Dana Park
outcome: v2.4.0 tagged and deployed, and the changelog says CSV export is new
Deploy with the usual checklist in docs/release.md.
```

> Created `k_…`: **Release the CSV export**, for Dana Park. They are sent it as a card, in a direct message, once it is ready. This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

**What happens:**

1. The implementation starts in `api`. Its prompt names the reviewer and lists the gate. The
   release is todo; Dana gets nothing yet.
2. The agent reports. Since the task names a reviewer, its report goes to review whether it asks
   for review or reports complete; `npm test` runs first, and a failing gate refuses the report
   and shows the agent why. The chat hears:

   > Review requested for **Add CSV export to the reports API** `k_…`, from role reviewer.

3. A review run of `reviewer` starts in `api`, the task's workspace, so it reads the checkout the
   implementer left. Its prompt holds the handoff, the reported commit when `api` is a git repository, the
   contract and the gate.
   It counts against `reviewer`'s limit of two, and holds `api` while it runs.
4. **Request changes.** The reviewer asks for changes with a reason. The chat hears:

   > Changes requested on **Add CSV export to the reports API** `k_…` by role reviewer: Values with commas are not quoted: a report titled "A, B" breaks the row. Quote fields per RFC 4180 and add a test.

   `/kanban task show k_…` shows it under the runs too:

   > **Runs**
   > #1 work · role worker · review\_requested: Added GET /reports/:id.csv in src/routes/reports.ts, with test/export.test.ts. npm test passes.
   > #2 review · role reviewer · changes\_requested: Values with commas are not quoted: a report titled "A, B" breaks the row. Quote fields per RFC 4180 and add a test.

   A person, or an operator, asks for changes the same way from chat:

   ```
   /kanban task changes k_… Values with commas are not quoted: a report titled "A, B" breaks the row. Quote fields per RFC 4180 and add a test.
   ```

   > Changes requested on `k_…`: it goes back to its assignee, with your reason.

5. **Rework.** A new work run of `worker` starts in `api`. Its prompt carries the reason and the
   previous handoff in full, and on bytesec it continues the implementer's own session where it
   can. When it reports, the gate runs again, and the chat hears "Review requested for …" again.
6. **Approve.** The reviewer approves; the gate runs once more, and the chat hears:

   > Done: **Add CSV export to the reports API** `k_…`
   > > Approved: quoting is right, and the JSON route is unchanged.

7. The release is ready. Dana gets a card in a direct message. Under "From its parents" it shows
   the implementer's last handoff, the rework's, not the approval. The chat hears:

   > 📋 **Release the CSV export** `k_…`, assigned to Dana Park

8. She does the release, types a summary in the card's box and presses **Done**, or types:

   ```
   /kanban task done k_… Tagged v2.4.0 and deployed; changelog updated.
   ```

   > Done: `k_…` is complete.

   and the chat hears "Done: **Release the CSV export** `k_…`" with her summary.

**Pitfalls:**

- **`--` is optional in chat.** `/kanban gate add k_… -- npm test` stores `npm test`, as the
  terminal's `mt kanban gate add k_… -- npm test` does. A `--timeout` goes before the `--`: after
  it, `/kanban gate add k_… -- --timeout 60 npm test` is refused with the usage.
- **A gate added after the agent starts** is not in its prompt, though it still runs on its
  report. Hence the order above: create, gate, assign.
- **Choose one way to review.** Do not also put a review task under the implementation: it would
  be reviewed twice.
- **The release card waits for the approval.** A task in review is not done, so its children stay
  todo through every round of changes.
- **Dana must be known to the gateway and have talk tier**, or the release is refused when you
  create it (section 4).

### Recipe 3: a planner breaks work into a DAG

Instead of writing each task yourself, give a goal to a role whose agent writes the graph, and
makes all of it at once. The `planner` role's `role.md` says what to make. An excerpt, from
`~/.manus-team/roles/planner/role.md` on the gateway's host:

```markdown
You plan; you do not do the work. Split the goal in your task into 3 to 8 tasks for the role
`worker`. Give each task a contract with an "outcome" and a "verification". Where a task's
result needs checking, name `reviewer` as its "reviewer".

Write the plan as one DAG and make it with `mt kanban apply-dag`: each task has a "ref", and
its "parents" name the refs of the tasks it needs, each written earlier in the list. Check it
first with "dry_run": true, then send it again without it. Give it an "idempotency_key", such as
"plan-1", so that sending it again does not make it twice.

When the graph is made, report complete, with a summary that lists each task's id and title in
order.
```

**The task.** A goal, and a contract for the plan:

```
/kanban task new Plan the reports CSV export
assignee: planner
outcome: 3 to 8 tasks for worker on the board, in dependency order, that together ship CSV export for every report type
verify: each task has an outcome and a verify line, and only the tasks that need it have a reviewer
stop when: it is unclear which report types are in scope
Goal: every report in the reports API can be downloaded as CSV. The code is in the api workspace: give every task "workspace": "api". Release is done by people, not by these tasks.
```

> Created `k_…`: **Plan the reports CSV export**, for role planner. This chat hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.

**What the planner does.** Its agent runs in `planner`, reads the goal, and sends one
`mt kanban apply-dag` with the whole graph:

```json
{"format": 1, "idempotency_key": "plan-1", "tasks": [
  {"ref": "columns", "title": "Write the CSV column mapping for every report type", "body": "List each report type and its columns in docs/csv-columns.md.", "assignee": "worker", "workspace": "api", "contract": {"outcome": "docs/csv-columns.md covers every report type", "verification": "each report type in src/reports/ appears in it"}},
  {"ref": "serializer", "title": "Add the CSV serializer", "body": "Implement src/csv.ts from the mapping in docs/csv-columns.md.", "assignee": "worker", "reviewer": "reviewer", "workspace": "api", "parents": ["columns"]},
  {"ref": "routes", "title": "Add the CSV routes", "assignee": "worker", "reviewer": "reviewer", "workspace": "api", "parents": ["serializer"]},
  {"ref": "docs", "title": "Document CSV export", "assignee": "worker", "workspace": "api", "parents": ["routes"]}
]}
```

answered with every task, by its ref:

```json
{"ok":true,"instance_id":"w_…","existing":false,"board":"default","tasks":[{"task_id":"k_…","ref":"columns","step":"columns","item":null},…]}
```

The graph is made in one transaction, all of it or none, so no task starts before its parents
are linked, and a planner that stops half way leaves no half of a graph. With `"dry_run": true`
the same DAG is checked as an apply checks it and nothing is made: the answer has `"dry_run":
true` and no `instance_id`. Sending it again with the same key answers with the same instance
and `"existing":true`, and makes nothing; a key is the planning task's own. A refusal names the
task it is about:

```json
{"ok":false,"code":"unknown_role","message":"serializer: role \"reviwer\" is not configured"}
```

A planner's DAG takes no gates, and no `priority`, `failure_limit`, `retry_on_crash` or
`max_runtime_s` but at their defaults, as its `mt kanban create` takes none: they are the
operator's. Add gates afterwards with `/kanban gate add`. The planner then reports complete, and
the chat hears:

> Done: **Plan the reports CSV export** `k_…`
> > Made 4 tasks for worker, as w\_…, in order: k\_… column mapping; k\_… serializer (reviewer: reviewer); k\_… routes (reviewer: reviewer); k\_… docs.

**Where the tasks go:**

- **On the planner's board.** A task an agent makes is on the board of the task it ran, and a
  DAG naming another board is refused.
- **This chat follows them.** Each task inherits the planning task's subscriptions, so the chat
  that created the plan hears when each one is done, needs review, blocks, gives up or is
  stranded, and so on down the line.
- **They are not the plan's children.** The planning task does not wait for them, and is done as
  soon as it reports. `/kanban workflow show w_…` lists them, as "(no workflow)".
- **They run in `worker`, unless the plan names a workspace.** `worker` has its own workspace, so
  without `"workspace"` every task runs there, one at a time, however wide the graph. Here the body
  asks for `api`, where the code is. To run branches in parallel, give each branch its own
  workspace, in the body or in `role.md`, or make the workspace they share isolated (section 6):
  with `api` marked `isolated: true`, the planner's parallel tasks each get a worktree of `api`
  and run at once.

**Checking the graph.** `/kanban workflow show w_…`, or `/kanban task list`:

> `k_…` **ready**: Write the CSV column mapping for every report type · role worker
> `k_…` **todo**: Add the CSV serializer · role worker
> `k_…` **todo**: Add the CSV routes · role worker
> `k_…` **todo**: Document CSV export · role worker

`/kanban task show k_…` on any of them gives its parents and children, and the instance it is
from, so you can walk the graph:

> **Add the CSV serializer** `k_…`: todo
> assignee: role worker · reviewer: role reviewer · workspace: api
> workflow: `w_…` (no workflow), step serializer
> parents: `k_…` (ready)
> children: `k_…` (todo)
> > Implement src/csv.ts from the mapping in docs/csv-columns.md.

Check that every task but the first has a parent, that no task you expected in parallel has a
sibling as parent, and that the reviewers are where checking is needed.

**Pitfalls:**

- **A vague goal gets blocked.** The board tells every agent to block on genuine ambiguity, and
  `stop when:` says where that is. The chat hears, for example:

  > **Plan the reporting work** `k_…` is blocked (needs\_input): The goal does not say what "better" means: faster, more formats, or new report types? Name the outcome you want.
  > `/kanban task unblock k_… [comment]` once it can go on.

  Answer the question in the unblock; the next run reads it:

  ```
  /kanban task unblock k_… Better means CSV export for every report type; the rest is out of scope.
  ```

  > `k_…` is unblocked, back to open.

- **A parent comes before its child.** A task's `parents` name refs written earlier in the list;
  a ref named later, or not in the DAG, is refused, naming it. A task already on the board is no
  parent here: link it afterwards with `mt kanban link`.
- **Too many tasks at the root.** Every task with no parents starts as soon as there is room.
  Keep the plan to one or two roots.
- **A plan the team makes again and again** is better as a workflow file (section 12): the
  planner then starts it with `mt kanban start-workflow`, and the file's gates come with it.

### Recipe 4: a DAG from the terminal

The graph of recipe 1, a brief, three prototypes in parallel and a recommendation that waits for
all three, kept as a workflow file on the gateway's host and made from a shell there. The file,
`~/.manus-team/workflows/caching.yaml`:

<!-- example: workflow caching -->
```yaml
description: A brief, three prototypes in parallel, and a recommendation
params:
  options: { list: true, default: [a, b, c] }
steps:
  brief:
    title: Write the caching options brief
    assignee: worker
    outcome: a brief naming three caching options for the reports API, each with what to measure
    constraints: put the brief itself in your summary, not only in a file
    body: Read docs/reports-api.md and propose three ways to cache report results.
  proto:
    for_each: options
    parents: [brief]
    title: Prototype caching option {{item}}
    assignee: worker
    workspace: research
    outcome: a measured p95 latency for option {{item}}, with and without the cache
  report:
    parents: [proto]
    title: Write the caching recommendation
    assignee: worker
    outcome: docs/caching.md, one table of the three options and a recommendation
    verify: every number in the table comes from a parent's summary
```

`research` is an isolated workspace (section 6), so the three prototypes each get a directory
of their own and run side by side; in a shared one they would queue. Add it once, on the
gateway's host, from a git repository, and restart the gateway:

```
$ mt workspace add research /srv/repos/research --isolated
```

or, by hand, in `config.yaml`:

```yaml
workspaces:
  default: /srv/repos/main
  research: { path: /srv/repos/research, isolated: true }
```

Every prototype names the same workspace, `research`. A name field takes a name, or one whole
reference such as `"{{item}}"`, never one put together from parts, so `"research-{{item}}"` is
refused by the check.

```
$ mt workflow check caching
caching: ok, 3 steps; params: options (list, default a, b, c)
```

**Preview it as a file.** `preview --json` writes the DAG a start would make, every key of every
task written out, and nothing else on stdout; a refusal goes to stderr, so it never leaves half a
file:

```
$ mt kanban workflow preview caching --board web-app --json > caching.json
```

The file is the plan: diff it, keep it beside the script, or edit it. Here the report gets a
reviewer, by hand:

```json
    {
      "ref": "report",
      "step": "report",
      "item": null,
      "title": "Write the caching recommendation",
      "body": null,
      "assignee": "worker",
      "reviewer": "reviewer",
```

**Check it, then make it.** `--dry-run` makes every check an apply makes, against the board as it
is now, and lists every task and every gate command, and makes nothing:

```
$ mt kanban workflow apply caching.json --dry-run
would make 5 tasks, 6 links, 0 gates, on board web-app; nothing was made
  brief    Write the caching options brief   role worker
  proto:1  Prototype caching option a        role worker  after brief
  proto:2  Prototype caching option b        role worker  after brief
  proto:3  Prototype caching option c        role worker  after brief
  report   Write the caching recommendation  role worker  after proto:1, proto:2, proto:3
$ mt kanban workflow apply caching.json --key caching:web-app --json
{"ok":true,"instance_id":"w_…","existing":false,"board":"web-app","tasks":[{"task_id":"k_…","ref":"brief","step":"brief","item":null},…],"nudged":true}
```

`--key` makes the apply safe to run again: a second run with the same key and the same DAG makes
nothing and answers with the instance, `"existing":true`; the same key with a DAG changed since
is refused, as is a key a `start` used. Without a key every apply is a new instance. A key is kept
for good, an archived instance's included: to make the graph again, change the key.

Instead of the preview and the apply, `mt kanban workflow start caching --board web-app --key
caching-start:web-app` does both in one step, with the file as it is, when there is nothing to
edit. Its key is a new one: a start refuses a key an apply used.

Notes:

- **The apply checks again.** A role removed, a board archived or a workspace dropped between the
  preview and the apply is refused at the apply, naming the task. A workflow file edited since
  changes nothing: the apply makes the DAG.
- **Gates come with the file and the DAG at the terminal**, as the operator's: a gate command
  holding the mask `••••`, as one printed masked by `show --dag` would, is refused, and must be
  written out again.
- **No chat follows these tasks**, so nobody is told when they are done or block. Watch with
  `mt kanban workflow show w_…`, or start the workflow from chat if a group should hear.
- **A DAG written by hand** needs only `"format": 1` and its tasks, each with a `ref` and a
  `title`; every other key takes its default. It shows as "(no workflow)".
- **Scripting `mt kanban task new`** still works for a graph that is no workflow: each `--key`
  returns its task on a second run, and `--parent` links it.

### Recipe 5: when a task in the middle fails

```
   Export last quarter's invoices        done
              |
   Reconcile with the ledger             blocked
        /            \
   Write the report   Flag unpaid        todo: waiting for their parent
```

**It blocks, and everything under it waits.** The middle task's agent cannot reach the finance
database and blocks. The chat hears:

> **Reconcile the invoices with the ledger** `k_…` is blocked (capability): The finance database refuses this role: permission denied for schema ledger.
> `/kanban task unblock k_… [comment]` once it can go on.

A task that fails twice (by default) blocks the same way, with "Gave up on …" and the last error.
The two children stay todo, since a blocked parent is not finished. The chat hears nothing about
them until they move.

**See why.**

```
/kanban task list blocked
```

> `k_…` **blocked**: Reconcile the invoices with the ledger · role worker

`/kanban task list todo` shows what is waiting. Then:

```
/kanban task show k_…
```

> **Reconcile the invoices with the ledger** `k_…`: blocked
> assignee: role worker · reviewer: nobody · workspace: worker
> blocked (capability): The finance database refuses this role: permission denied for schema ledger.
> parents: `k_…` (done)
> children: `k_…` (todo), `k_…` (todo)
> > Compare data/invoices-q3.csv with the ledger in the finance database.
> **Runs**
> #1 work · role worker · blocked: The finance database refuses this role: permission denied for schema ledger.

**Unblock it** once the cause is fixed, with a comment that answers the block:

```
/kanban task unblock k_… The role has read access to the ledger schema now; try again.
```

> `k_…` is unblocked, back to open.

The next run reads the comment, and when it is done, the children start as they would have.

**Reroute it** when it cannot be fixed. Create a replacement, with the failed task's parents as
its own:

```
/kanban task new Reconcile the invoices from the ledger export
parent: k_…
assignee: worker
Finance put the ledger export in data/ledger-q3.csv. Compare it with data/invoices-q3.csv; do not use the finance database.
```

Link it into each child that has not started, the replacement's id first:

```
/kanban task link k_… k_…
```

> `k_…` now waits for `k_…`.

Then archive the failed task:

```
/kanban task archive k_…
```

> Archived `k_…`.

Each child now waits for the replacement alone. `/kanban task show` on one:

> **Write the reconciliation report** `k_…`: todo
> assignee: role worker · reviewer: nobody · workspace: not yet fixed
> parents: `k_…` (archived), `k_…` (ready)

When the replacement is done, the children start, and their prompts hold its handoff. Under the
archived parent they read "No handoff: it was never completed."

**Pitfalls:**

- **Link first, archive last.** An archived parent counts as finished. Archive the failed task
  before linking the replacement, and a child whose other parents are done starts at once, with
  no handoff from the failed task, and can no longer be linked.
- **Only a child that has not started can be linked.** A link onto a task that has started, or
  finished, is refused:

  > Not done: task k\_… is done; a parent added now could not hold it back

- **A link that would make a cycle is refused**, such as the replacement under one of its own
  children:

  > Not done: task k\_… is already upstream of k\_…; the link would make a cycle

- **A done task is never reopened.** If a task finished, and its result turns out wrong, create a
  follow-up with the done task as parent, and the new evidence in its body:

  ```
  /kanban task new Recheck the reconciliation with the corrected ledger
  parent: k_…
  assignee: worker
  Finance corrected 3 ledger rows after the reconciliation ran; see data/ledger-q3-fixed.csv.
  ```

  The follow-up takes the done task's place. Link it into any of the done task's children that
  have not started yet; most will have started as soon as it was done, and those keep the handoff
  they were given.
- **Unblocking without changing anything** blocks again for the same reason. After two such
  unblocks (by default) the notice says to rewrite the task, or archive it and create a clearer
  one.

### Recipe 6: two projects side by side

```
   board web-app (group "Web")           board billing (group "Billing")
   Redesign the login page                Add proration to plan changes
              |                                       |
   Ship the login page                    Review the proration rules
```

**Make the boards and put each group on its own.** An operator, in any chat:

```
/kanban board create web-app
```

> Created board **web-app**. `/kanban board use web-app` puts a chat on it.

and `/kanban board create billing`. Then in the Web group:

```
/kanban board use web-app
```

> This chat is on board **web-app** now: its `/kanban task new` adds tasks to it, and `/kanban task list` shows them.

and in the Billing group, `/kanban board use billing`.

**Give each its limit and workspace:**

```
/kanban board set web-app max_running 2
```

> Board **web-app** runs at most 2 agents at once now.

```
/kanban board set web-app workspace web
```

> Board **web-app**'s tasks work in web now, unless their own workspace, their role's or their parents' says otherwise.

and the same for `billing`, with its workspace `billing`. A board's `max_running` is at most the
gateway's:

> Not done: a board's max\_running is a whole number from 1 to the gateway's kanban.max\_running, 4

From the terminal: `mt kanban board create billing`, `mt kanban board set billing max_running 2`,
`mt kanban board set billing workspace billing`. There is no `board use` at a terminal; give
`--board` instead.

`/kanban board list`:

> **default**: 10 open, 11 done
> **billing**: 2 open · max\_running 2 · workspace billing
> **web-app** (this chat): 1 open · max\_running 2 · workspace web
> `/kanban board use <name>` moves this chat to another board; `/kanban board create <name>` makes one.

**Each board's DAG is its own.** Build each graph from its own group, as in recipes 1 to 5.
`/kanban task list` in the Web group shows web-app's tasks alone, under "Board **web-app**:". A
task's follow-ups, and the tasks a planner makes from it, stay on its board.

**No parents across boards.** From the Billing group, a `parent:` naming a web-app task, or a
link between the two, is refused:

> Not done: task k\_… is on board web-app, not billing: a task and its parents are on one board

If billing's work really waits on web-app's, keep both on one board, or start billing's task once
web-app's is done.

**Fairness.** Each dispatcher pass gives the boards turns, by name, starting after the board that
got the last agent run, so a burst on web-app cannot hold billing's tasks back. Within a board,
priority and then age decide. A board at its own `max_running` gives up its turn.

**Limits that hold across boards:**

- the gateway's `max_running: 4`, over both boards together;
- each role's limit: `worker` has at most two agent runs open, on web-app and billing together. A
  `worker` task on billing waits while two web-app `worker` tasks run, and `/kanban task show`
  says it is waiting on its role's `max_running`, as it says a wait on the gateway's or a board's
  limit, or on a busy workspace. Billing's turn goes on to its tasks for other
  roles;
- one agent per workspace: two boards' tasks in one workspace take turns.

**Pitfalls:**

- **A board's workspace does not apply to `worker`'s or `planner`'s tasks.** It is the last
  resort, after the task's own `workspace:`, its role's own workspace, and its parents'. `worker`
  has its own, so a `worker` task on billing with no `workspace:` line runs in `worker`, not in
  `billing`:

  > assignee: role worker · reviewer: nobody · workspace: worker · board: billing

  Both boards' `worker` tasks then share `worker`, one at a time. Give `worker`'s tasks a
  `workspace:` line on each board. A board's workspace does apply to a task for `reviewer`, or for
  a person, that has no parents to follow, since they name no workspace of their own.
- **Moving a chat moves only that chat.** A group and its threads are one chat. Tasks created
  before a move stay on their board, and their notices still come to the chat.
- **A board's `max_running` cannot raise the role's.** With two boards at 2 each, `worker` still
  has two runs open in all.

### Recipe 7: rules of thumb for DAGs

- **Set every link when you create the task**, with `parent:` lines, `--parent`, or `parents` in
  `mt kanban create`. A task with no parents is claimed within moments, and a link onto a task
  that has started is refused.
- **One workspace per parallel branch, or an isolated one.** Tasks that share a workspace run one
  after the other, however wide the graph, unless the workspace is isolated (section 6), which
  gives each task a directory of its own. Then check the role's `max_running`: it caps the width
  too.
- **Name a reviewer on the task, or use a separate review task, not both.** Both means two
  reviews.
- **Keep tasks small and checkable.** Give each an `outcome:` and a `verify:`, and a gate where a
  command can check it. A small task that blocks costs little to reroute.
- **Prefer shallow graphs.** Each level waits for the slowest task above it, and a block anywhere
  holds back everything under it. Two or three levels are usually enough.
- **Put the handoff in the summary.** A child, and a reviewer, read their parents' summaries
  first, and a child in another workspace cannot read its parents' files by relative path.
- **Use idempotency keys when scripting.** An agent's `mt kanban create` and `mt kanban apply-dag`
  take an `idempotency_key`, and the terminal's `task new`, `workflow start` and `workflow apply`
  take `--key` (recipe 4).
- **Use `--board` on scripted commands**, every one, so that a task lands on, and a command acts
  on, the board you mean.
- **Reroute with link first, archive last** (recipe 5).

## 14. Rules of thumb

- Write `outcome:` and `verify:` on every task you care about, and `stop when:` on anything
  risky.
- Ask agents to say where their results are. A summary is what a child task and a reviewer read
  first.
- Use a gate for anything checkable. A gate that fails tells the agent exactly what is wrong.
- Want the agent to see the gates? Create the task without an assignee, add the gates, then
  `/kanban task assign` it.
- Want review? Name a `reviewer:` on the task, or make a separate review task under it, not both.
- Want parallel work? Make the workspace isolated, or give each task its own, or they queue.
- Several projects? Give each a board, keep its group on it with `/kanban board use`, and give
  the board the project's workspace.
- Order follow-ups with `parent:` lines, or `parents` from an agent, when you create them.
- Steer with a comment; stop only when the agent is going the wrong way.
- Unblock with a comment that answers the question the block asked.
- Never put a secret in a task, a comment or a gate. Put it in the role's `.env`.

## 15. Cron jobs

A cron job is not a task. It is a schedule, a role and a prompt: at each time the gateway
opens a fresh session of the role, gives it the prompt, and posts the answer to the chat the
job was made in. Nothing reports, nothing is reviewed, and the board does not see it. Cron is
on when the operator sets `cron.enabled: true` in config.yaml and restarts the gateway.

Cron jobs ready to copy, from a daily digest to a workflow started on a schedule, are in
[examples.md](examples.md), part 2.

### Making one in chat

```text
/cron add "every weekday 09:00" worker List the open PRs in the web repository, oldest first.
name: Daily PRs
tz: Asia/Shanghai
```

The schedule is in quotes, then the role, then the prompt, which may run over several lines.
`name:`, `tz:` and `script:` lines are optional, each once. The answer names the job:

```text
Added c_8f2k1m0q4x7z, *Daily PRs*: every weekday 09:00 (Asia/Shanghai), next 2026-11-18 09:00, as worker, posting here.
```

Made in a thread, the job posts in that thread. Its schedule is a cron expression
(`0 9 * * 1-5`), `every 30m`, `every 2h`, `every day 09:00`, `every monday 09:00`, or a
one-off: `in 30m`, or a time, `2026-11-18 09:00`. The shortest period is 5 minutes.

### What a fire posts

Each answer comes with a header: the job's name, its time and how long it took.

```text
**Daily PRs** · 2026-11-18 09:00 Asia/Shanghai · 3m 12s
Two open PRs: #12, fix the parser (3 days), and #14, docs (1 day).
```

An agent that has nothing to say answers exactly `[nothing to report]`, and nothing is
posted. Write that into the prompt when quiet days are the usual case: "If no PR is older
than a week, answer [nothing to report]". A failed fire is one line; three in a row pause the
job, with the line saying how to resume it.

Each fire's prompt carries the job's previous result, so a job can say what changed since
yesterday. A script, set by an operator, runs first, and its output goes in the prompt:

```text
/cron add "every day 08:30" worker Say which of these builds failed, and why.
script: ./tools/last-builds.sh
```

### Seeing and changing jobs

`/cron list` and `/cron show <id>` are anyone's; `pause`, `resume`, `run` (fire once now) and
`remove` are an operator's. Each sees only this chat's jobs. There is no edit in chat: an
operator changes a job at the terminal, `mt cron edit c_… --schedule "every day 10:00"`, or
you remove it and add it again.

### An agent's job

A chat agent can add a job for you, from its shell, with `mt cron add < job.json` and
`{"schedule": "every day 09:00", "prompt": "..."}`, when an operator asked it in that turn:
asked by someone at talk tier, it is refused, and says so. A board run's agent can add one
too, posting to its task's chat. The job runs as the agent's own role, with no script; the
agent may pause or remove only the jobs it made.

An agent's add is judged by the turn running when it arrives, so a process the agent left
running in the background could keep retrying until an operator's turn runs, and its add would
then pass. The tokens keep an agent's ordinary use of `mt cron` in its own chat and its own jobs;
they are cooperative, not a lock.
