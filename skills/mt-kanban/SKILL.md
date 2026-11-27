---
name: mt-kanban
description: Working on the manus-team task board with mt kanban and /kanban. Read it in a board run (MT_KANBAN_RUN is set, or the prompt has "# How to work"), in a chat when someone asks to put work on the board, and in a turn whose message starts "Board update:".
---

# The manus-team board

The gateway runs agents on a task board. This skill adds judgement to what the gateway already
tells you; it never overrides a run's protocol, and the gateway's refusals win over anything here.
Read the part for where you are.

## Where you are

Your environment says, and so does the message that started your turn:

| You see | You are |
|---|---|
| `MT_KANBAN_RUN` and `MT_KANBAN_TOKEN` set | in a board run: read "In a board run" |
| `MT_CRON_FIRE` set | in a cron fire: no board command works there; only "What not to do" applies |
| `MT_AGENT_SESSION` set, none of the above, and the message starts "Board update: you are woken" | in a woken turn: read "In a woken turn" |
| `MT_AGENT_SESSION` set, none of the above | in a chat session: read "In a chat session" |
| none of them | not started by the gateway: this skill does not apply |

`MT_AGENT_SESSION` is set in every session the gateway starts, board runs and fires included, so
it alone does not tell a chat from a run. `MT_WAKE_TOKEN` is in every chat session while wakes are
on, woken or not: the "Board update:" message is what marks a woken turn. `MT_CRON_TOKEN` in a chat
session means cron is on, which changes what your shell may run.

A run whose prompt starts "Board update: you are this task's run" is a board run a wake made for a
role. It reads the tasks below it with `mt kanban wake-show < show.json` and lifts a block with
`mt kanban wake-unblock < unblock.json`, each `{"task_id": "k_..."}` with an optional "comment"
for the unblock, and reports as any run does.

## In a board run

The protocol under "# How to work" in your prompt is the contract: the commands, their JSON and
the rules. `mt kanban show` prints the task and everything the prompt cut. This part is how to
use it well.

**One terminal report, then stop.** A work run ends with exactly one of
`mt kanban complete < handoff.json`, `mt kanban review < handoff.json` or
`mt kanban block < block.json`; a review run with `complete`, `mt kanban changes < reason.json` or
`block`. A second report is refused `already_reported`. Do the work, the comments and the
follow-ups first, and report last. "unreachable" means try the same report once more. A run that
ends without a report is nudged, then retried or blocked: never leave it to that.

**A summary someone can act on.** Say what was done, where the output is (paths in the workspace,
a branch and commit, document links, task ids), and what is left, naming the follow-up that holds
it. Put structured facts in "metadata". When your task's outcome names outputs, report each as a
top-level key of "metadata", of the type it names; a completion without them is refused, and you
report again in the same run. A good `mt kanban complete`:

```json
{"summary": "Wrote notes/contracts.md: 14 contracts, 3 renewing before March. Left: contracts/2026/acme.pdf and brill.pdf are scans with no text, so they are not in it.", "metadata": {"files": ["notes/contracts.md"], "unread": 2}}
```

**The block kinds.** Block only when you cannot go on, and say exactly what would unblock you.

- `needs_input`: a decision or a fact only a person can give. Ask one question that can be
  answered in a line.
- `capability`: something you cannot do here: an access, a tool, a credential or a service you
  lack. Name it.
- `transient`: something you expect to clear by itself, such as a service that is down. The task
  still waits, blocked, until someone unblocks it, so first retry within your run if it may clear
  in minutes.
- `dependency`: another task must finish first. Give its id in "parents"; it must be on this
  board and not finished, or the block is refused. The task is not blocked: it waits for the
  parents and is claimed again.

`gave_up` is the board's own, after repeated failures; you never report it. A good
`mt kanban block`:

```json
{"kind": "needs_input", "reason": "The brief names two keynote speakers and the agenda has one slot. Which one: Ana Ruiz or Ben Okafor?"}
```

**Read the comments before blocking for input.** `mt kanban show` lists the task's comments, and
an unblock's comment is among them. If the answer is in a comment, the body, the contract, a
parent's handoff or the workspace, use it. A comment a person adds while you work reaches you in
your session; answer with `mt kanban comment < comment.json`, `{"body": "..."}`, and go on.

**Never guess past the contract.** Its outcome, verification, constraints, boundaries and stop
when are the person's terms. Do not widen the outcome, cross a boundary or skip a verification
because it would be easier. When the work cannot meet them as written, or meeting one breaks
another, block `needs_input` saying which and why, rather than report complete on a reading of
your own.

**Gates.** If the prompt lists gates, `complete` and `review` run them first, in the workspace,
and are refused `gate_failed` unless each exits 0. Run them yourself before you report. A refusal
leaves the run open: fix the work and report again. Gates are the operator's: a run cannot add
or remove one, and a task you create gets none.

**Follow-ups.** Work outside this task goes on the board, not into this run:

- one task, or a short chain: `mt kanban create < task.json`, each naming the earlier ones in
  "parents" so they run in order;
- a graph planned at once: `mt kanban apply-dag < dag.json`, all or none; send it with
  "dry_run": true first and read the answer;
- a shape the operator already wrote: `mt kanban start-workflow < start.json`;
  `mt workflow check` lists the workflows and their params.

Choose each assignee from `mt role list`, by what its description says it is for. Give an
"idempotency_key" to anything you might send twice. Follow-ups stay on this task's board and
inherit its chat and its wake. Name the tasks you made in your summary.

**Review runs.** Judge the handoff and the work against the task and its contract, and change
nothing. `changes` takes a reason the assignee can act on: what is wrong, where, and what would
make it right. Block only for what the assignee cannot fix.

## In a chat session

You are the `default` role, talking with a person. Put work on the board only when they ask for
it ("make a task", "put it on the board", "have the worker do it"), never on your own initiative.

**Turn the request into board work.**

1. A workflow that fits comes first: ask them to send `/kanban workflow list`, or run
   `mt workflow check` yourself. `/kanban workflow preview <name> key=value` shows what one
   would make, and `/kanban workflow start <name> key=value` starts it.
2. Otherwise one task. Choose the assignee from `/role list` (`mt role list` in your shell), and
   a reviewer when someone other than its author should check the work.
3. Write the outcome and how to verify it, so the agent knows what done means.
4. Add `wake: on` when they want you to carry on once it is done or blocked. For a task that
   exists: `/kanban task wake <id> on`.

Then give them the exact message, ready to paste (in Lark, Shift+Enter makes each line break):

```
/kanban task new Summarise the vendor contracts
assignee: worker
reviewer: reviewer
outcome: notes/contracts.md lists each contract's renewal date, notice period and price cap
verify: every PDF in contracts/2026 is in the list
wake: on
Read every PDF in contracts/2026 and write a one-page summary to notes/contracts.md.
```

**The tiers.** `/kanban task new`, `/kanban workflow start` and a wake that names a role need
operate tier. `/kanban task wake <id> on`, `/kanban task show <id>`, `/kanban workflow list` and
`/role list` need talk tier. When the person sends the command, the gateway checks their tier,
records them as its maker and has this chat follow the task. That is why you hand them the
command rather than make the work yourself.

**What your shell can do.**

- With cron on (`MT_CRON_TOKEN` set), every operator command, `mt kanban task new` among them, is
  refused in your shell as `operator_command`, and the worker's commands answer `not_in_a_run`.
- With cron off, your shell runs `mt kanban task new` and the other operator commands with the
  operator's authority, whoever you are talking to. Do not use that: a person at talk tier would
  get work made that they cannot make themselves, and the task would be the operator's, with no
  chat following it. A wake set from your shell is refused unless the board woke this turn.

Either way, give the person the `/kanban` command to send. Run one yourself only when the
operator asks you to, in so many words. Never create work nobody asked for.

## In a woken turn

The board woke you because a task with wake on had an outcome: done, changes requested, blocked
by its run, gave up, or stranded. Each outcome wakes you once; a block nobody answers does not wake
you again.

1. Read each task before acting: `mt kanban task show <id>`. A person may have answered, or
   lifted the block, since the turn began.
2. Lift a block only with an answer that the task's comments, this thread or the repository
   gives you: `mt kanban task unblock <id> <comment>`. The comment goes to the task's next run, so
   make it the answer itself. Where the prompt says you cannot lift a block, do not try.
3. Otherwise ask in the thread: say what is blocked and the one question a person must answer.
4. For a completion, tell the thread what was done and where, from the summary.

Only `mt kanban task show` and `mt kanban task unblock` are for this turn, and only for the tasks
that woke it; anything else is refused or must not be used. Make no task, workflow or wake here:
suggest the `/kanban` command to a person instead.

## What not to do

- No cron jobs from a board run or a woken turn: no `mt cron add`. A person adds one with
  `/cron add`.
- No tasks on another board. Follow-ups stay on your task's board; a parent on another board is
  refused `other_board`, and so is a key already used on another. Do not work around it.
- No secrets in a title, body, comment, summary, metadata or reason: no tokens, keys, passwords
  or values from your environment. Say where a secret is kept, never what it is. The board masks
  the secrets it knows, not every one.
- No `mt auth`: it is refused in every agent's shell. People change tiers, with `/auth` in chat
  or `mt auth` at their own terminal.
