# Examples: workflows and cron jobs

Ready-to-copy workflows and cron jobs for a team on the board. Each one says when to use it,
gives the whole file or command, how to start it from chat and from a terminal, what happens,
and the one pattern it shows. The board guide, [kanban-guide.md](kanban-guide.md), explains
each feature: section 12 for workflows and section 15 for cron jobs.

Most examples are not about code. A task is any work: gathering notes, writing a post,
granting access, a follow-up after an incident.

**The team they assume.** Four roles, all unsupervised:

- `worker`: does the work, in its own workspace, `worker`.
- `reviewer`: reviews, with no workspace of its own, so its review runs where the work is.
- `triage`: routes requests, in its own workspace, made with `mt role create triage
  --own-workspace`. Its `role.md` is in workflow 6.
- `default`: the role chat sessions run as.

And people, named in chat by @-mention: type @ and pick them from Lark's list. A person must
have used `/kanban`, or been @-mentioned in it, before they can be given work, and needs talk
tier. At a terminal, which has no mentions, a person is `lark:<union_id>`: `mt kanban people`
lists the people the gateway knows, with their ids and whether they have talk tier.

**Where things go.** A workflow is one file, `~/.manus-team/workflows/<name>.yaml`, read at
each preview and start, so an edit needs no restart. `mt workflow check <name>` checks it on
the gateway's host. Starting one is an operator's command. Cron needs `cron.enabled: true` in
the gateway's config, and a restart.

**Ids.** `k_…` is a task, `w_…` a workflow's instance, `c_…` a cron job. Use the ones the
chat gives you. `oc_xxx` stands for a chat's id, as Lark gives it; `mt cron list` shows the
chat each job posts to.

Every example here is checked by `tests/docs-examples.test.ts`: each workflow file by the
gateway's own checker, each command by the gateway's own parsers.

## Part 1: workflows

### 1. weekly-report

Use it when the same report is written every week from the same few places: gather each source
at once, write it up when all are in, and have a person read it before it goes out.

<!-- example: workflow weekly-report -->
```yaml
description: Gather the week from several sources at once, write the report, and have it reviewed
params:
  week:     { required: true, description: "the week the report covers, such as 2026-W47" }
  sources:  { list: true, default: [support tickets, sales calls, release notes] }
  reviewer: { required: true, description: "who reviews the report: a person by @-mention, or a role" }
steps:
  gather:
    for_each: sources
    title: Gather the main points from {{item}} for {{week}}
    assignee: worker
    outcome: at most ten points from {{item}} for {{week}}, each saying where it came from
    constraints: put the points in your summary, not only in a file
  write:
    parents: [gather]
    title: Write the weekly report for {{week}}
    assignee: worker
    reviewer: "{{reviewer}}"
    outcome: the report, one section a source, with three lines at the top on what matters most
    verify: every point comes from a parent's summary
```

Start it from chat:

<!-- example: start weekly-report chat -->
```
/kanban workflow start weekly-report week=2026-W47 reviewer=@Bob Li
```

From a terminal on the gateway's host, here with the `reviewer` role as the reviewer; a person
would be `--param reviewer=lark:<union_id>`:

<!-- example: start weekly-report terminal -->
```
$ mt workflow check weekly-report
weekly-report: ok, 2 steps; params: week (required), sources (list, default support tickets, sales calls, release notes), reviewer (required)
$ mt kanban workflow start weekly-report --board reports --param week=2026-W47 --param reviewer=reviewer --key weekly-2026-47
```

To have the thread's agent woken by the report's outcomes, a write-up done or a gather blocked,
end the start with the word `wake`: each outcome's notice comes as before, and then the agent is
woken in the thread to decide what to do next (the guide's section 8, "Wakes", says how):

<!-- example: wake weekly-report chat -->
```
/kanban workflow start weekly-report week=2026-W47 reviewer=@Bob Li wake
```

From a terminal, a wake needs a chat to follow the tasks, and runs as the owner:

<!-- example: wake weekly-report terminal -->
```
$ mt kanban workflow start weekly-report --param week=2026-W47 --param reviewer=reviewer --chat <chat_id> --wake
```

What happens: four tasks at once. The three gathers start together; the write-up waits for all
three, and its prompt holds their summaries. When `worker` is done writing, the report goes to
Bob Li as a review card, and is done when he approves it. The three gathers run side by side
only if `worker` is an isolated workspace (guide, section 6); in a shared one they queue.

**The pattern:** fan-out over a list param, `for_each: sources`, and a fan-in, `parents:
[gather]`, which waits for every task the fan-out made. `reviewer: "{{reviewer}}"`, with no
`role:` or `person:`, takes either, so one file serves chat and the terminal.

### 2. content-pipeline

Use it for anything written, checked and then published: a blog post, a release note, a
newsletter. A role checks the draft, and a person signs it off before it goes out.

<!-- example: workflow content-pipeline -->
```yaml
description: Draft a piece, have the reviewer role check it, get a person's sign-off, then publish it
params:
  topic:    { required: true, description: "what the piece is about" }
  approver: { required: true, description: "who signs it off, by @-mention" }
steps:
  draft:
    title: Draft a blog post on {{topic}}
    assignee: worker
    reviewer: reviewer
    outcome: draft.md, 600 to 900 words, with a title and a one-line summary
    constraints: every claim links its source; put the whole draft in your summary too
    gates:
      - command: test -s draft.md
        timeout_s: 30
  approve:
    parents: [draft]
    title: Approve the post on {{topic}} for publishing
    assignee: { person: "{{approver}}" }
    body: The draft is in the summary above. Press Done to approve it, or Block saying what must change.
  publish:
    parents: [approve]
    title: Publish the post on {{topic}}
    assignee: worker
    outcome: the post is live, and its link is in your summary
```

Start it from chat:

<!-- example: start content-pipeline chat -->
```
/kanban workflow start content-pipeline topic="our new export button" approver=@Dana Wu
```

From a terminal, the approver is `--param approver=lark:<union_id>`, an id `mt kanban people`
lists, and `--chat oc_xxx` names the group that hears. Check the file there:

<!-- example: check content-pipeline -->
```
$ mt workflow check content-pipeline
content-pipeline: ok, 3 steps; params: topic (required), approver (required)
```

What happens: `worker` drafts. Its report runs the gate first: until `draft.md` exists and is
not empty, the report is refused and the agent is told why. Then the `reviewer` role reviews the
same task, in the same workspace, and approves it or sends it back with a reason. Once it is
approved, Dana gets a card holding the draft's summary, with **Done** and **Block**. Her Done
releases the publish task.

**The pattern:** two kinds of check on one draft. The reviewer role checks the task itself
(`reviewer:` on the step), and a person's approval is a task of its own between the draft and
the publish, so nothing is published until she presses Done. The gate makes "the file exists"
a fact rather than a claim.

### 3. incident-followup

Use it once an incident is over: the facts first, then one task for each person who owns a
follow-up, so each sees exactly what is theirs.

<!-- example: workflow incident-followup -->
```yaml
description: After an incident, a timeline and a root cause, then one follow-up task for each owner
params:
  incident: { required: true, description: "the incident, such as INC-2041" }
  owners:   { list: true, required: true, description: "the people who own follow-ups, by @-mention" }
steps:
  timeline:
    title: Write the timeline of {{incident}}
    assignee: worker
    outcome: timeline.md, each entry with a time and the log, alert or message it comes from
    constraints: name no individual; say "the on-call engineer"
  cause:
    parents: [timeline]
    title: Find the root cause of {{incident}}
    assignee: worker
    outcome: the root cause in one paragraph and the contributing factors as a list, in your summary
    stop_when: the evidence points to two causes and nothing tells them apart
  actions:
    for_each: owners
    parents: [cause]
    title: Your follow-ups from {{incident}}
    assignee: "{{item}}"
    body: Read the root cause above. Reply with what you will change, and by when, then press Done.
```

Start it from chat, with one @-mention for each owner, joined by commas:

<!-- example: start incident-followup chat -->
```
/kanban workflow start incident-followup incident=INC-2041 owners=@Alice Chen,@Bob Li
```

From a terminal, the owners are `lark:` ids, `--param owners=lark:on_…,lark:on_…`. Check the
file there:

<!-- example: check incident-followup -->
```
$ mt workflow check incident-followup
incident-followup: ok, 3 steps; params: incident (required), owners (list, required)
```

What happens: the timeline, then the root cause, by `worker`. If the evidence is split, the
cause task blocks and asks rather than guessing (`stop_when`). Once the cause is done, Alice and
Bob each get a card of their own with the root cause's summary on it. Each is done when its
owner presses Done.

**The pattern:** `for_each` over a list of people, with `assignee: "{{item}}"`: one task for
each person, all waiting for the same parent.

### 4. onboarding

Use it when someone joins: a person grants access to each system while an agent prepares the
starter docs, and the first-day checklist waits for both.

<!-- example: workflow onboarding -->
```yaml
description: Access to each system for a new starter, starter docs, then a first-day checklist
params:
  starter: { required: true, description: "the new starter's name" }
  systems: { list: true, default: [email, chat, code hosting, expenses] }
  admin:   { required: true, description: "who grants access, by @-mention" }
  manager: { required: true, description: "who runs the first day, by @-mention" }
steps:
  access:
    for_each: systems
    title: Give {{starter}} access to {{item}}
    assignee: { person: "{{admin}}" }
    outcome: "{{starter}} can sign in to {{item}}"
  docs:
    title: Prepare the starter docs for {{starter}}
    assignee: worker
    outcome: welcome.md, with the first week's plan, who to ask for what, and links to the team's main pages
    constraints: put the whole of welcome.md in your summary too
    gates:
      - command: test -s welcome.md
  checklist:
    parents: [access, docs]
    title: Run the first-day checklist with {{starter}}
    assignee: { person: "{{manager}}" }
    body: Every access task is done, and the starter docs are in the summaries above. Go through them with {{starter}}, then press Done.
```

Start it from chat. `systems` has a default, so it can be left out:

<!-- example: start onboarding chat -->
```
/kanban workflow start onboarding starter="Mei Lin" admin=@Ravi Patel manager=@Dana Wu
```

From a terminal, the admin and the manager are `lark:` ids, as `mt kanban people` lists them.
Check the file there:

<!-- example: check onboarding -->
```
$ mt workflow check onboarding
onboarding: ok, 3 steps; params: starter (required), systems (list, default email, chat, code hosting, expenses), admin (required), manager (required)
```

What happens: six tasks. Ravi gets four cards at once, one a system, and `worker` writes
`welcome.md` at the same time. A person's task holds no workspace, so nothing queues behind
anything. Dana's checklist card comes when all five are done, with their summaries on it.

**The pattern:** people and an agent side by side in one graph, and a fan-in over both:
`parents: [access, docs]` waits for every access task and the docs.

### 5. multi-service-change

Use it for one change that touches several services in one repository: each service changed
at once in a directory of its own, then one check of them together, then a person releases.

The repository's workspace must be **isolated**, so the services' tasks run side by side, each
in a worktree of its own. Add it on the gateway's host:

```
mt workspace add services /srv/repos/services --isolated
```

which writes these lines in the gateway's config; restart the gateway after either:

<!-- example: config services -->
```yaml
workspaces:
  services:
    path: /srv/repos/services
    isolated: true
    base: main        # optional: the branch a task with no parents starts from
```

<!-- example: workflow multi-service-change -->
```yaml
description: One change made in several services side by side, checked together, then released by a person
params:
  change:   { required: true, description: "the change, in one line" }
  services: { list: true, required: true, description: "the services' directories in the repository" }
  releaser: { required: true, description: "who releases, by @-mention" }
steps:
  edit:
    for_each: services
    title: Make the change in {{item}}
    body: "The change: {{change}}"
    assignee: worker
    workspace: services
    boundaries: files under {{item}}/ only
    verify: the tests of {{item}} pass
  integrate:
    parents: [edit]
    title: Check the change across every service together
    body: "The change: {{change}}"
    assignee: worker
    workspace: services
    outcome: the services build together and the integration tests pass
    gates:
      - command: ./scripts/integration-test.sh
        timeout_s: 600
  release:
    parents: [integrate]
    title: Release the change to {{services}}
    body: The integration task's summary above names its branch. Merge it, release, then press Done with the version.
    assignee: { person: "{{releaser}}" }
```

Start it from chat:

<!-- example: start multi-service-change chat -->
```
/kanban workflow start multi-service-change change="log every request's trace id" services=billing,orders,search releaser=@Ravi Patel
```

From a terminal, the releaser is a `lark:` id, as `mt kanban people` lists it. Check the file
there:

<!-- example: check multi-service-change -->
```
$ mt workflow check multi-service-change
multi-service-change: ok, 3 steps; params: change (required), services (list, required), releaser (required)
```

What happens: three edits at once, each in its own worktree on its own branch, `mt/<task_id>`.
The integration task starts from a merge of the three branches; if they conflict, it blocks,
naming the files. Its report runs `./scripts/integration-test.sh` in its directory, and is
refused until the script passes. Then Ravi's card comes. The gateway never merges into your
branches: merging is the release task's, Ravi's.

**The pattern:** an isolated workspace for a fan-out that must not queue, and a gate on the
fan-in, so "it works together" is checked, not said. `{{services}}` in a title is the list's
items joined by `, `.

### 6. triage-and-route

Use it as the front door for requests: one agent reads each request and routes it, starting the
workflow that fits, or handing it to a person when none does.

A workflow has no conditions, so the branch is the deciding agent's: its run starts a workflow
with `mt kanban start-workflow`, or creates a task with `mt kanban create`. The rules it follows
live in its role. An excerpt of `roles/triage/role.md`:

<!-- example: role.md triage -->
```markdown
# Triage

You route requests. You never do the work yourself. Read the request, then do exactly one of
these:

- **Something to write and publish**, a post, a page or an announcement: start the workflow
  content-pipeline, with `topic` from the request and `approver` Dana Wu, lark:on_5d1e7a.
- **An incident that is over**: start incident-followup, with `incident` from the request and
  `owners` the on-call lead, lark:on_9b04c2.
- **Anything else**: create one task for Sam Park, lark:on_2f6b81, titled with the request,
  its body saying what you found and why no workflow fits.

Start a workflow with `mt kanban start-workflow < start.json`, and create a task with
`mt kanban create < task.json`. Before you report, write decision.md: what you decided, why,
and the ids the command answered with. If the request is unclear, block with needs_input and
ask.
```

The `lark:on_…` ids are examples: use your people's. `/kanban task show` of a task given to a
person prints theirs, and each must be known to the gateway and have talk tier. They are in the
role, not in a param, because a param used only in a body or a contract never turns an
@-mention into a person's id: only one that lands in `assignee` or `reviewer` does.

The workflow:

<!-- example: workflow triage-and-route -->
```yaml
description: Read a request, decide what it needs, and start the workflow for it or hand it to a person
params:
  request: { required: true, description: "the request, as the asker wrote it" }
steps:
  decide:
    title: "Triage: {{request}}"
    assignee: triage
    body: |
      The request, as written: {{request}}

      Route it as your role's instructions say. Write decision.md first: what you
      decided, why, and what you started or created.
    outcome: the request is routed, and decision.md says how
    gates:
      - command: test -s decision.md
        timeout_s: 30
```

Start it from chat:

<!-- example: start triage-and-route chat -->
```
/kanban workflow start triage-and-route request="a post on how we cut build times in half"
```

or from a terminal. Started there, no chat follows the triage task, nor the workflow it starts,
unless `--chat oc_xxx` names one: then that chat follows the triage task, and so the workflow
its run starts, as a run's work follows its task's chats. Without it, watch them with `mt kanban
workflow show w_…`.

<!-- example: start triage-and-route terminal -->
```
$ mt workflow check triage-and-route
triage-and-route: ok, 1 step; params: request (required)
$ mt kanban workflow start triage-and-route --param request="a post on how we cut build times in half" --key triage-build-times
```

What happens: the `triage` agent reads the request and starts content-pipeline from its run,
with this as `start.json`:

<!-- example: kanban-agent start-workflow -->
```json
{"workflow": "content-pipeline", "params": {"topic": "how we cut build times in half", "approver": "lark:on_5d1e7a"}, "idempotency_key": "route"}
```

For a request no workflow fits, it creates a task for a person instead, with this as
`task.json`:

<!-- example: kanban-agent create -->
```json
{"title": "Look into the request for a second office printer", "body": "No workflow fits: it is a purchase. The request: a second printer for the third floor.", "assignee": "lark:on_2f6b81", "idempotency_key": "route"}
```

Either way it writes `decision.md`, and its report is refused until the gate finds it. The tasks
it makes are created from the triage task: they follow its chat and thread, and show as a related
instance in `/kanban workflow show` of the triage instance. A run's params are given as JSON, so
a person is a `lark:` id there, never an @-mention.

**The pattern:** a deciding step. Its agent chooses the branch and makes it, and a gate holds the
step open until the decision is written down. It starts a workflow, not a graph of its own with
`mt kanban apply-dag`, because a started workflow brings its file's gates, here the draft's, and
`apply-dag` from a run takes none.

## Part 2: cron jobs

A cron job is a schedule, a role and a prompt. At each time the gateway opens a fresh session of
the role, gives it the prompt, and posts the answer to the chat the job was made in, or the one
`--chat` names. An answer of exactly `[nothing to report]` is not posted. An optional **script**,
the operator's, runs first, in the role's workspace, and its output goes in the prompt.

Two facts shape the scripts below:

- **A script must exit 0.** A script that fails ends the fire without running the agent; the
  chat gets one line, and three failures in a row pause the job. A check that is meant to find
  failures prints them and exits 0.
- **A script is the operator's shell, not an agent's.** It runs with the role's environment,
  and none of the gateway's `MT_KANBAN_*` or `MT_CRON_*` variables, so the operator's `mt`
  commands work in it. The gateway puts its own `mt` first on the script's `PATH`, and gives it
  its `MT_HOME`, `MT_CONFIG` and `MT_DB`, so plain `mt` in a script is this gateway's `mt`, on
  its own config and database, whatever else the host has installed.

A script runs in the job's workspace, which the role's agents write to: keep the script itself
outside it, under `$MT_HOME` for example, so it never runs what an agent left there. A gateway
run by hand passes its scripts none of its own settings but those three: a setting only in its
shell, such as `MT_ALLOW_CHATS`, belongs in the config file or the `.env`, where both read it.

From chat each job is a `/cron add`, at operator tier; from a terminal, `mt cron add`, with
`--chat` saying where it posts. Without `--chat`, a terminal's job posts nowhere, and its results
are kept in its history only.

### 1. A daily digest

Use it when a team wants to know each morning what changed, without reading the log.

Two jobs, as Monday's look back covers the weekend: Tuesday to Friday at 09:00 the last 24
hours, and Monday at 09:00 the last 72. A single `every weekday 09:00` job with
`--since=yesterday` would miss, on a Monday, Friday after 09:00 and the whole weekend.

<!-- example: cron daily-digest chat -->
```text
/cron add "0 9 * * 2-5" worker Summarise the commits to the web repository below, from the last day, for the team: what changed, in at most five lines, grouped by area. If there are none, answer [nothing to report].
name: Yesterday in web
tz: Asia/Shanghai
script: git -C /srv/repos/web log --since='24 hours ago' --oneline --no-merges
```

<!-- example: cron daily-digest-monday chat -->
```text
/cron add "every monday 09:00" worker Summarise the commits to the web repository below, from Friday morning on, for the team: what changed, in at most five lines, grouped by area. If there are none, answer [nothing to report].
name: The weekend in web
tz: Asia/Shanghai
script: git -C /srv/repos/web log --since='72 hours ago' --oneline --no-merges
```

The first at the terminal; the Monday one is the same, with its own schedule, prompt, name and
`--since`:

<!-- example: cron daily-digest terminal -->
```
mt cron add "0 9 * * 2-5" worker \
    "Summarise the commits to the web repository below, from the last day, for the team: what changed, in at most five lines, grouped by area. If there are none, answer [nothing to report]." \
    --name "Yesterday in web" --tz Asia/Shanghai --chat oc_xxx \
    --script "git -C /srv/repos/web log --since='24 hours ago' --oneline --no-merges"
```

What happens: each morning the script lists the commits since the last digest, and the agent
summarises them. On a day with none, the answer is `[nothing to report]`, and nothing is posted.
For a folder of documents instead of a repository, the script could be `find docs -type f
-mtime -1`, run in the role's workspace.

**The pattern:** a script gathers, the agent explains, and `[nothing to report]` keeps quiet
days quiet.

### 2. A health check every 30 minutes

Use it to hear about a problem only when there is one.

<!-- example: cron health-check chat -->
```text
/cron add "every 30m" worker Below are the health page's HTTP status and the root disk's use. If the status is 200 and the disk is under 85% full, answer [nothing to report]. Otherwise say in one line what is wrong, and what to check first.
name: Health
script: curl -s -o /dev/null -m 10 -w 'status %{http_code}\n' https://status.example.com/health; df -h / | tail -n 1
```

<!-- example: cron health-check terminal -->
```
mt cron add "every 30m" worker \
    "Below are the health page's HTTP status and the root disk's use. If the status is 200 and the disk is under 85% full, answer [nothing to report]. Otherwise say in one line what is wrong, and what to check first." \
    --name Health --chat oc_xxx \
    --script "curl -s -o /dev/null -m 10 -w 'status %{http_code}\n' https://status.example.com/health; df -h / | tail -n 1"
```

What happens: every 30 minutes, the script prints a line such as `status 200` and the disk's
line from `df`. Unreachable, curl prints `status 000`, and the script still exits 0, as its
last command is `df`, so the agent runs and says so. When all is well, nothing is posted.

**The pattern:** the script never fails on the thing it checks; it reports it, and the agent
decides whether to speak.

### 3. A weekly board review

Use it to have someone look over the board each week for work that is stuck.

<!-- example: cron board-review chat -->
```text
/cron add "every friday 16:00" worker Below are the open tasks on the board web-app, each with its status and its age, how long since it was made, sent back, blocked or put in review. List each task that is blocked, and each whose age is 7d or more, with its id, title, assignee and age. One line each. If there are none, answer [nothing to report].
name: Board review
script: mt kanban task list --board web-app
```

<!-- example: cron board-review terminal -->
```
mt cron add "every friday 16:00" worker \
    "Below are the open tasks on the board web-app, each with its status and its age, how long since it was made, sent back, blocked or put in review. List each task that is blocked, and each whose age is 7d or more, with its id, title, assignee and age. One line each. If there are none, answer [nothing to report]." \
    --name "Board review" --chat oc_xxx \
    --script "mt kanban task list --board web-app"
```

What happens: each Friday at 16:00 the script lists the board's open tasks, a line each, with
its id, its status, its `age`, how long since it was made, sent back, blocked or put in review
(`45m`, `5h`, `3d`), its assignee and its title. The agent flags what is blocked, and what has
sat for a week or more. Nothing is kept between fires: the age is the board's, from the time
each task's phase last changed, so a `/cron run` in the middle of the week sees the same ages a Friday would.

**The pattern:** the script reads the board, because a fire's agent cannot: in its shell the
operator's `mt kanban` commands are refused. The board's own times say what is stale, so the
script keeps no state of its own.

### 4. One-off reminders

Use them for a nudge at a set time. A one-off fires once and is then done.

<!-- example: cron reminder-in chat -->
```text
/cron add "in 2h" worker Remind everyone that the release freeze starts at 18:00 today, and that anything not merged by then waits for Monday.
name: Freeze reminder
```

<!-- example: cron reminder-at chat -->
```text
/cron add "2026-12-01 09:00" worker Say that the Q4 budget review is today at 14:00, and ask each team to bring its numbers.
name: Budget review
tz: Asia/Shanghai
```

<!-- example: cron reminder-at terminal -->
```
mt cron add "2026-12-01 09:00" worker "Say that the Q4 budget review is today at 14:00, and ask each team to bring its numbers." \
    --name "Budget review" --tz Asia/Shanghai --chat oc_xxx
```

What happens: the first posts two hours after it is added; the second at 09:00 on 1 December in
Shanghai's time. A time written with an offset, `2026-12-01T09:00+08:00`, needs no `tz:`. A
one-off missed by more than an hour, the gateway being down, is skipped, not posted late.

**The pattern:** `in <n>m|h|d` or a date and time, for the job that happens once.

### 5. An agent's own follow-up

Use it when someone asks the agent in chat to look at something again later. The agent adds the
job itself, from its shell.

A chat with the bot, where Dana has operator tier:

> **Dana:** We have just deployed billing 2.4. Check its error rate again tomorrow at 09:00 and
> tell us here.

The agent writes `job.json` and runs `mt cron add < job.json`:

<!-- example: cron-agent add -->
```json
{"schedule": "2026-11-18 09:00", "tz": "Asia/Shanghai", "name": "Billing 2.4 error rate", "prompt": "Billing 2.4 was deployed on 2026-11-17. Check the billing service's error rate since then and compare it with the week before. Say in two lines whether it rose, and by how much.", "idempotency_key": "billing-2.4-check"}
```

The gateway answers:

<!-- example: cron-agent answer -->
```json
{"ok": true, "job_id": "c_…", "name": "Billing 2.4 error rate", "schedule": "2026-11-18 09:00", "tz": "Asia/Shanghai", "state": "active", "next_run_at": "2026-11-18T09:00:00+08:00", "created_by": "session:…", "existing": false}
```

> **Agent:** Done: I will check billing 2.4's error rate at 09:00 tomorrow, and post it here.

What happens: at 09:00 the next day a fresh session of the chat's own role, `default`, gets the
prompt and posts its answer in this chat, or in this thread if Dana asked in one. The fresh
session remembers nothing of today's chat, so the prompt says everything it needs. The fields
an agent may give are `schedule` and `prompt`, and optionally `name`, `tz` and
`idempotency_key`: never a role, which is its own, nor a script, which is the operator's. Asked
by someone at talk tier, the add is refused (`needs_operator`), and the agent says an operator
must ask, or use `/cron add`.

**The pattern:** an agent schedules its own follow-up, behind an operator's request, as its own
role and with no script.

### 6. A workflow on a schedule

Use it to start a workflow by the clock: here, workflow 1, weekly-report, every Monday morning.

<!-- example: cron weekly-workflow chat -->
```text
/cron add "every monday 09:00" worker The script below has just started this week's report workflow, and printed its answer as JSON; the gateway posts the start's reply in this chat. If existing is true, say in one line that this week's report was already started. Otherwise answer [nothing to report].
name: Weekly report
script: mt kanban workflow start weekly-report --board reports --param week=$(date +%G-W%V) --param reviewer=lark:on_5d1e7a --key weekly-$(date +%G-%V) --chat oc_xxx --json
```

<!-- example: cron weekly-workflow terminal -->
```
mt cron add "every monday 09:00" worker \
    "The script below has just started this week's report workflow, and printed its answer as JSON; the gateway posts the start's reply in this chat. If existing is true, say in one line that this week's report was already started. Otherwise answer [nothing to report]." \
    --name "Weekly report" --chat oc_xxx \
    --script 'mt kanban workflow start weekly-report --board reports --param week=$(date +%G-W%V) --param reviewer=lark:on_5d1e7a --key weekly-$(date +%G-%V) --chat oc_xxx --json'
```

The board `reports` is made once, with `/kanban board create reports` or `mt kanban board create
reports`.

What happens: each Monday at 09:00 the script starts weekly-report as the operator, with the
week filled in, such as `2026-W47`, and Dana Wu, `lark:on_5d1e7a`, as the reviewer: the start
checks her as chat would, known to the gateway and at talk tier. `--chat oc_xxx`, this chat's id,
makes the chat follow every task of the instance, and the gateway posts the start's reply here,
naming the instance and its tasks, then each task's notices. `--key weekly-2026-47` makes the
start safe to repeat: a second start that week, from `/cron run` or a retry, makes nothing,
posts nothing, and answers with the same instance and `"existing": true`, which the agent says.
`date` runs on the gateway's host, in its zone, not in the job's `tz`, so near midnight on a
Sunday the two can disagree about the week.

**The pattern:** the script does the operator's part, the gateway the telling. A fire's agent
cannot start a workflow: `mt kanban start-workflow` works only in a board run, and the
operator's `mt kanban workflow start` is refused in an agent's shell. So the script starts it,
`--chat` says who hears, and the agent speaks only when there is something the reply does not
say.
