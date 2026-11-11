# Plan W: A directory of its own for each task. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the parallel tasks of a graph run side by side in one repository. Today a workspace runs one agent at a time (spec §6.3), so a role with a workspace of its own, such as `worker`, runs its tasks one after another, however wide the graph. A workspace written as `{ path, isolated: true }` gives each of its board tasks a directory of its own instead: in a git repository, a worktree under `$MT_HOME/worktrees/<workspace>/<task_id>` on the task's own branch, `mt/<task_id>`, started from its parents' work (the workspace's base with none, a parent's branch with one, a merge of their branches with several, a conflict blocking the task for a person); elsewhere, an empty folder, whose prompt lists its parents' folders. Every run of the task, its review and its rework included, works there, its gates run there and its reported commit is read there. The board never merges, pushes or rebases into anyone's branch, never deletes a branch and never removes a worktree. The one-agent limit then binds only the workspace's shared directory; the gateway's, the board's and the role's `max_running` hold as before.

**Architecture:**
- **Configuration** (`src/config.ts`): a workspace may be a mapping `{ path, isolated, base }` beside the plain path; `GatewayConfig.isolated` and `TeamSettings.isolated` name the isolated workspaces, absent when there are none.
- **The board's rows** (`schema/007_task_directories.sql`, `src/db/kanban.ts`, `src/db/kanban-read.ts`, `src/kanban/types.ts`): `kanban_tasks.worktree`, `wt:<task_id>` once a task's first agent claim in an isolated workspace has given it a directory of its own, written once, by the claim. The run records its **place**, its task's own directory or its workspace, as its `workspace`; the one-agent limit, the gates' hold on claims and `workspace_busy` count per place. `RunEnding.block` ends a run that could not start for a person to put right: blocked as `needs_input`, uncounted.
- **The directories' rows** (`src/db/workspaces.ts`): a made directory is a `workspaces` row `wt:<task_id>`, kind `git-worktree` or `plain-dir`, as architecture §9 planned, written once by `registerWorktree`; `registeredWorkspaces` leaves them out.
- **Making them** (`src/kanban/worktree.ts`, `src/db/kanban-read.ts`): `TaskDirectories.prepare(task)`, real git with no hook, no fsmonitor and no prune, in a process group killed past its time, queued per repository; `parentsInLinkOrder` for the fan-in's order.
- **The service** (`src/kanban/service.ts`): tells the claim which workspaces are isolated, runs a report's gates and reads its commit in the task's directory, and does not say a task waits on the shared directory when it would get one of its own.
- **Sessions** (`src/core/workspace.ts`): `NamedWorkspaces` resolves a `wt:` id to the recorded directory, so every actor build of a run's session finds it.
- **The dispatcher and the prompt** (`src/kanban/dispatcher.ts`, `brief.ts`, `prompt.ts`): the directory is made before the session; one that cannot be made blocks the task; the prompt says where the directory is, and where the upstream tasks' are.
- **The gateway** (`src/index.ts`): wires `TaskDirectories`, the isolated set and the lookup, and says at startup which workspaces are isolated.
- **People** (`src/kanban/chat-render.ts`, `src/cli/plain.ts`, `src/cli/operator.ts`, `src/cli/mt.ts`, `src/cli/workspace.ts`): `directory:` in `/kanban task show` and `mt kanban task show`, `mt kanban task worktree <task_id>`, `mt workspace add … --isolated`, and `mt workspace list` marking an isolated workspace.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3, `yaml`, git with `git worktree` (2.5 or later).

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §18 (new), and the W row in §12, which this plan's commit adds, with pointers in §1, §2.3, §3.1, §3.3, §6.3 and §12's text; `docs/architecture.md` §15's milestone 9 row.

---

## Ground rules

- **Where to work.**
  - Use a worktree beside the main checkout, such as `/Users/x/Develop/manus/prime-gateway-wt2`, on the branch `worktrees`, which holds this plan, from `main` at `1b818ef`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, never run real bytesec, and never read or write `~/.manus-team`. No test reads the real home: each gets a made-up `MT_HOME` and `HOME`, and every test that runs git gives it a made-up `HOME` and `GIT_CONFIG_NOSYSTEM=1`, in a temporary repository it makes.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npx vitest run --project unit` gives `Tests  1683 passed (1683)`. `npx vitest run --project e2e` gives `Tests  101 passed (101)`. `npm run typecheck` reports no errors. One unit test is known to fail now and then under load; run the suite again before looking into a single failure.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text is whole lines, and appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given.
- **One writer per table.** `db/kanban.ts` stays the only writer of every `kanban_` table, `kanban_tasks.worktree` included; `db/workspaces.ts` stays the only writer of `workspaces`, a task's directory included. `src/db/WRITERS.md` says so (Task 2).
- **Words a person sees** (replies, `mt` output, refusals, the README and the guide) never name a plan, and do not use the long dash.
- **No real agent.** No test runs bytesec. The end-to-end tests run the fake driver, with real git.

## Decisions

Each has its reason. *The user's decision* marks those the user made before this plan was written. **[you decide]** marks the ones this plan recommends and the user should confirm or change; the plan is built on the recommendation.

1. **The switch is per workspace.** *The user's decision.* `workspaces.<name>` may be a mapping, `{ path: /abs, isolated: true }`, beside the plain path, which keeps its meaning; `isolated: false` is the plain path. `path` is required in a mapping; any other key than `path`, `isolated` and `base` is refused, as everywhere in the file; `base` is refused without `isolated: true`. Every rule §2.3 checks of a path at startup holds for a mapping's, so `isolated: true` on a path that does not exist is the same startup error as any missing workspace. Read at startup: a switch takes effect at the next start. Only board tasks get directories of their own; a chat session still works in the workspace's directory.
2. **Which tasks get one: decided at a task's first agent claim, and kept.** A claim by a role, in an isolated workspace, of a task that has had no agent run, fixes `kanban_tasks.worktree` to `wt:<task_id>` (migration `007`), once, as `workspace` is fixed. Every later run of the task (a retry, a review, a rework, a person's) works there, even if the workspace is no longer isolated: the directory, and the provider sessions opened in it, must not move. A person's claim fixes none, since a person's run uses no directory.
3. **Migration.** *The user's direction*: existing tasks keep the shared directory, and only tasks claimed after the switch get directories of their own. Made exact: a task that has had an agent run in the shared directory stays there, since its work is in that checkout and a retry or rework elsewhere would lose it and its provider session. A switch needs a restart, and the restart ends every open run (§8.4), so "a workspace switched while a run is open" is that case: the run is interrupted, and its task, which had an agent run there, keeps sharing.
4. **Where the directories live.** *The user's decision*: `$MT_HOME/worktrees/<workspace>/<task_id>`, each `<workspace>` directory `0700`. Outside the repository, so the base checkout's `git status` never lists a task's directory and no checkout holds another's `.git` file; in the home, which §2.3 allows: that rule is that no workspace may *be or contain* the home or the database, and a task's directory contains neither, nor any role's `.env`. `$MT_HOME/worktrees` and its `<workspace>` directories must be real directories, as `$MT_HOME/workspaces` must, or the task blocks.
5. **Recorded as workspaces rows.** As architecture §9 and spec §2.3 planned: a made directory is the `workspaces` row `wt:<task_id>`, kind `git-worktree` or `plain-dir`, `root_path` its real path, `repo_root` the workspace's directory, `branch` for a worktree, written once by `db/workspaces.ts` (`registerWorktree`), never updated, the same directory again changing nothing and another refused. A configured name has no `:`, so the two never meet; `registeredWorkspaces`, which `mt workspace list` and the moved-directory check read, leaves `wt:` rows out.
6. **A task's place.** Where its runs work and its gates run: its own directory, by `wt:` id, else its workspace, by name (`placeOf`). A run records its place as its `workspace`, and its session as its `workspace_id`, so the registry finds the same directory on every actor build: "record it, never relocate it" (architecture §9 and Appendix A), which native resume needs, as a rework resumes the implementer's provider session in the directory it was opened in. The one-agent limit counts open agent runs per place (`openAgentRunIn` is unchanged, and the claim skips it for a task with a directory of its own, which only ever holds that task's own open run, §3.3); a report's gates holding back claims and other reports, and `workspace_busy` for a person's report, are per place too; and `task show` does not say a task waits on the shared directory's agent when the claim would give it a directory of its own. The service's own check before the claim asks the place the claim would give (`#placeFor`), not the task's place before it, so a report's gates in the shared directory do not hold back a task about to get a directory of its own.
7. **Where a task with no parents starts.** *The user's decision*: the workspace's `base:`, a branch, tag or commit, when it names one; else whatever the workspace's directory has checked out (`HEAD`) when the worktree is made. A detached `HEAD` is a commit like any other; `base:` is how to pin the start against a person checking out another branch in the base checkout. A `base` with a leading `-`, a space, a control character (C0 or C1) or a bidi control is refused at startup. A `base` naming both a branch and a tag is the branch (review follow-ups 6 and 8).
8. **Where a task with parents starts.** *The user's decision*: one parent, its branch; several, a merge of their branches, made when the worktree is made; and a follow-up with no parents starts from the task that created it, as §2.3's rule 3 already uses it for the workspace. Made exact: the upstream is the task's parents that are done (Decision 19), or the creating task, those with a worktree in the same workspace, **in the order they were linked** (`parentsInLinkOrder`, by `kanban_links`' rowid; `parentsOf` orders by creation, and is unchanged); the worktree starts from the first's branch, and each other's is merged in, one at a time. Every branch is named `refs/heads/mt/<task_id>`, so a tag of the same name cannot stand in for it. Upstream tasks without a worktree there (in another workspace, a folder, or in the shared directory) are not merged, and the base is used if none counts.
9. **A conflict.** *The user's decision*: it blocks the task as `needs_input`, naming the files. Made exact: the worktree is **recorded the moment `git worktree add` succeeds**, before any merge, so `task show` and `mt kanban task worktree` give its directory during the conflict, when the person needs it. Up to ten files, and the directory, are named; the merge is left there unconcluded. A person resolves it there (`cd "$(mt kanban task worktree <task_id>)"`), commits and unblocks; each later prepare, until the task's first session starts, checks `MERGE_HEAD` (still unconcluded blocks the task again) and merges any parent branch not yet in it (`merge-base --is-ancestor`). Once a session has started, the merges are over: the agent's work is on the branch.
10. **Nothing lands by itself.** *The user's decision.* The board never merges, pushes, rebases or resets any branch but the task's own, and that only by the fan-in's merges when its worktree is made; never forces anything; never deletes a branch; never removes a worktree. Branches stay for a person, or a final task, to merge.
11. **A workspace that is no repository.** *The user's decision*: each task gets an empty folder (`0700`), and its prompt lists its parents' folders, which it reads from; nothing is copied. What counts as a repository: the workspace's directory at the top of a working tree, or a bare repository, asked with `GIT_CEILING_DIRECTORIES` at its parent, so a directory inside some other repository (a home under version control, say) counts as none. One with a `.git` while git is missing blocks its tasks, rather than give a code task an empty folder.
12. **Lifetime.** *The user's decision*: the board never removes a worktree. Made before the task's first run, by the dispatcher, after the claim and before the session (forced: git cannot run inside the claim's transaction); found again before every later run, so retries, nudges (the same session), review and rework all use it. A done task's branch is what its children start from, a folder task's children read its folder, and a worktree removed with uncommitted work loses it. A person removes one with `git worktree remove` (which refuses one with changes) and `git branch -d` (which refuses one not merged). A directory removed while its task can still run blocks it at its next claim, saying how to make it again.
13. **Failure.** *The user's decision, as recommended*: any directory that cannot be made (a conflict, a branch of its name already there, a parent's branch or the base missing, a symlink, a repository git cannot read, git missing, a full disk, git past its time) ends the run `failed` with the reason as its error, **not counted**, and blocks the task as `needs_input` with the reason (`RunEnding.block`); no session is created, the dispatcher goes on with the pass, and the task's subscribers hear the block. Counting a git error as a failure to retry would retry a conflict for nothing and then give up with a worse message.
14. **Git safety.** Every command runs with `-c core.fsmonitor=false`, `-c core.hooksPath=/dev/null` (`worktree add` runs `post-checkout`, a merge its own hooks), no automatic gc or maintenance (`-c gc.auto=0 -c maintenance.auto=false`, which would detach processes of their own), and for the merges `-c commit.gpgSign=false -c merge.verifySignatures=false -c merge.ff=true -c rerere.enabled=false` with `merge --quiet --no-stat --no-edit --ff --no-gpg-sign --no-verify-signatures -m "Merge mt/<parent> into mt/<task_id>"`, so a user's global signing, signature-checking, fast-forward or remembered-resolution settings do not change what the board does; `worktree add` runs `--quiet`. All with the agent allowlist of the gateway's environment (`buildEnv`). **No `git worktree prune`, ever**: a person's worktree whose directory is missing for a moment (an unmounted disk, a move) would lose its admin entry, its staged index and its branch's protection; the cases prune was for are each refused with a reason instead (a directory gone, a branch in the way, a leftover). `worktree add --no-track -b mt/<task_id> <path> <commit>`, so a start is a commit, and a base checkout with uncommitted changes needs nothing (git does not ask it to be clean; the test makes one dirty). A branch `mt/<task_id>` already there with no worktree of it is **taken up only when its tip is the very commit the task would start from**, which is what a failed `worktree add` leaves (git removes the directory and keeps the branch; `worktree add <path> mt/<task_id>`, without `-b`); at any other commit it is refused, never taken over, as it may be a person's. A directory at the path that the board has not recorded is refused, with what to do (for a path `git worktree list` shows, move out anything needed, then `git worktree unlock <path>` if it is locked, and `git worktree remove --force <path>`; for any other, move it aside; review follow-up 4): a `worktree add` that was stopped leaves one, locked as initializing, and the failed add's own reason gives the same steps, so the person need not unblock twice to learn them. Bare repositories work; a shallow clone works until a fan-in's merge base is missing, which blocks with git's message. A merge commit uses the repository's own `user.name` and `user.email`. `--no-optional-locks` belongs to read-only commands that would otherwise take a lock (`status`); none of these is one.
15. **Concurrency.** The dispatcher queues the git commands of one repository, keyed by its common directory, so two claims never make worktrees in it at once; git's own locks stand between the board and everyone else, the agents included.
16. **The review run, the reported commit and gates.** A same-task review works in the task's worktree, so a reviewer reads exactly the implementer's; its prompt says the work under review is there, and does not tell it to commit. A downstream review task is a task of its own, with its own worktree from its parent's branch. The reported commit (§7.8) is the worktree's `HEAD`, the task branch's. Gates run in the task's directory; a task whose directory is not made yet refuses them `gates_cannot_run`, saying so.
17. **The prompt.** After the task's contract: where the directory is; for a work run in a worktree, that its branch is where the work goes, to be committed before reporting, since the tasks after it start from the branch and nothing is merged for it; for a folder, that it is the task's own; then the upstream tasks' directories, to read but not change, at most twenty.
18. **Seeing it.** `/kanban task show` and `mt kanban task show` add one line, `directory: <path> · branch mt/<task_id>`, or `directory: its own, not made yet: it is made when an agent next takes the task up`; `--json` adds `worktree: {path, branch}`, or null. *The user's decision*: both helpers. `mt kanban task worktree <task_id> [--board] [--json]` prints the path alone, so a person can `cd` there to resolve a conflict, and refuses `no_worktree` for a task in a shared directory or one not made yet. `mt workspace add <name> <path> --isolated` (and with `--clone`) writes the mapping, and `mt workspace list` adds `, isolated` to the status of an isolated workspace. The gateway says at startup which workspaces are isolated.
19. **Archived parents are not merged.** *The coordinator's decision, in line with the user's*: only a parent in `done` is merged into a fan-in, or started from. A parent archived, which a claim counts as finished, was abandoned: its branch is not merged, and the prompt lists its directory as abandoned, so the agent can look if it must. A task in a shared directory is told where its parents' own directories are too.
20. **A git command past its time, and what it leaves behind.** Each runs in a process group of its own, which a timeout (two minutes) kills whole, so a filter or a merge driver stuck in a child process is stopped too, not left changing the checkout; the reason says `git did not finish in 120 s, and was stopped`. Its answer is its **exit**, not the close of its output, as `spawnGate`'s is (`src/kanban/gates.ts`): once git exits, what is left of its group is killed and its output let go after half a second; past its time, the group is killed and the answer comes half a second later whether or not the output closes. So a child left in the group cannot turn a successful add into a timeout, and one that left the group (`setsid`) and holds git's stderr cannot hold up the answer, or the repository's queue, for its lifetime. Chosen over no timeout for `worktree add` and `merge`, which would leave a claim's run open, holding its slots, until a person noticed: a large checkout needs the limit raised (`timeoutMs`), not removed. What a stopped `worktree add` leaves is named at the next claim (Decision 14).
21. **A repository git will not read is no folder.** A workspace whose directory is not there blocks its task, recording nothing, so it gets a worktree once the repository is back (git would not even start in a missing directory, and a folder recorded then would stay one). Only git saying "not a git repository", with no `.git` in the directory and nothing that looks like a bare repository (`HEAD` and `objects/`), makes a folder task. Anything else git refuses (an unknown `repositoryformatversion`, a `.git` file pointing nowhere, `safe.directory` and dubious ownership) blocks the task with git's own message: an empty folder would be a code task with no code.
22. **A recorded worktree is checked again.** *The user's decision*: before every later run, `symbolic-ref --quiet HEAD` must still be `refs/heads/mt/<task_id>`, compared as the full ref so a tag of its name cannot get in the way (review follow-up 1); if an agent or a person switched branches, the task blocks, naming the branch it is on. Its branch is what its children start from and what its reported commit names, so work on another branch would be lost to both; a warning in the prompt would let the next run carry on there. The reason says to finish or abort what is in progress there (a rebase, a merge), or switch it back.
23. **Any work, not only code.** *The user's point*: a task is research, a document, data or an ops chore as often as code, and a workspace such as the user's `worker` is a plain folder. So isolation applies to any workspace, and git is used only in a repository. A task in a folder of its own is told its folder, that its results go there (a reviewer: that the work under review is there), and the folders its parents, archived ones marked, left their work in, with nothing of commits, branches or git; the tests check both prompts for those words. `task show` gives a folder as `directory: <path>`, with no branch, and `mt kanban task worktree --json` its `branch` as null. The README, the guide and spec §18 lead with a plain-folder example, a research task fanning out into three note-taking tasks that a write-up reads from, before the git case; the guide's recipe 1 says that marking `worker` isolated lets its parallel tasks run at once with no `workspace:` line each, and recipe 3 that marking `api` isolated gives the planner's parallel tasks a worktree of `api` each.
24. **A folder task also sees the workspace's own folder.** *The main agent's decision, in line with the user's "any work" direction*, made after review: each task's folder starts empty, so the work and review prompts of a task in an isolated plain folder also name the workspace's own directory (`~/.manus-team/workspaces/worker`, say) as the place to read shared inputs from, while the task's results go in its own folder. The wording says nothing of git, commits or branches. A task in a git worktree is not told, as the worktree already has the repository's files. The guide and the README say to put input files such as `vendors/candidates.md` there, or in a parent's results.

## Known limitations

- **Disk.** Each worktree is a whole checkout, and each task installs its own dependencies.
- **Nothing is cleaned up** (Decision 12). A person removes merged worktrees and branches by hand.
- **Chat sessions** in an isolated workspace still share its directory, with each other and with any task still working there.
- **An upstream task in another workspace** is not merged in: its branch is in another repository. Its directory is listed in the prompt.
- **A parent's uncommitted work** is not on its branch, so its children do not see it; the prompt says to commit, and the reported commit says when it was not.
- **A gateway stopped while it merges** leaves the worktree as git left it; the next claim finds the merge unconcluded, or git's lock, and blocks.
- **A home inside a git repository**: an agent's own git commands in a folder task's directory find that repository, and so does the reported commit (§7.8's own edge case).
- **No identity for a merge**: a repository with no `user.name` and `user.email` blocks a fan-in task with git's own message.
- **The worker's `mt kanban show`** does not give the directory; the agent's current directory is it, and the prompt says so.
- **Submodules** are not initialised in a task's worktree: `git worktree add` leaves them empty, and an agent that needs one runs `git submodule update --init` itself.
- **What of a repository's own configuration still applies**: its `.gitattributes` filters and `core.autocrlf` at checkout, its merge drivers and `merge.*` settings (`conflictStyle`, rename detection) in a fan-in, and its `user.name` and `user.email` for the merge commit. They are the repository's, as they are for its agents; the overrides of Decision 14 are only those that change what the board itself does.
- **Merges stop once a session starts.** A parent's branch that gains commits after its child's first session began is not merged again.
- **Dubious ownership** (`safe.directory`) is not tested: it needs a repository another user owns. git refuses such a repository, and the task blocks with its message (Decision 21).
- **A stopped `worktree add`** leaves a locked, half-made worktree, which a person removes as the block's reason says.
- **Two gateways on one repository** would each queue only their own git commands; git's locks still keep the repository whole, and a failed command blocks its task.

## Another branch, merged before this plan

`small-fixes` was merged into `main` before this plan was generated, so every quoted text matches `main` with it: `src/kanban/waiting.ts`, `mt kanban task new --key`, the changes-requested notice and chat's `gate add --`. This plan touches the same places in these, and only these, files:

- `src/kanban/service.ts`: `#waiting` (Task 4) skips `workspaceBusy` for a task that has, or would get, a directory of its own.
- `src/db/kanban-read.ts`: `TaskView` gains `workdir` after `small-fixes`' `waiting` (Task 4).
- `src/cli/plain.ts` and `src/kanban/chat-render.ts`: the `directory:` line goes after the children line that `small-fixes` changed to show statuses (Task 9).
- `src/cli/operator.ts`: `show`'s JSON and `TASK_COMMANDS`, beside `--key`'s changes to `create` (Task 9); `tests/mt-kanban-operator-tasks.test.ts`'s list of task verbs.
- `tests/helpers/dispatch.ts`: the harness's service gets `isolated` beside `small-fixes`' `maxRunning` (Task 7).
- `README.md` and `docs/kanban-guide.md`: separate paragraphs (Task 10).

Nothing in `chat-parse.ts`, `notices.ts` or `waiting.ts` changes.

## File map

| File | Responsibility |
|---|---|
| `src/config.ts`, `config.example.yaml` (modify) | the mapping form; `isolated` on `GatewayConfig` and `TeamSettings` |
| `schema/007_task_directories.sql` (create) | `kanban_tasks.worktree` |
| `src/kanban/types.ts`, `src/db/kanban-read.ts` (modify) | `TaskRow.worktree`; `TaskView.workdir`; `parentsInLinkOrder` |
| `src/db/workspaces.ts`, `src/db/WRITERS.md` (modify) | `registerWorktree`, `worktreeOf`, `worktreeId`, `isWorktreeId`; `registeredWorkspaces` without `wt:` rows |
| `src/db/kanban.ts`, `src/kanban/workspace.ts` (modify) | the claim's directory and place, `reportCheck` per place, `RunEnding.block`; `placeOf` |
| `src/kanban/service.ts` (modify) | `isolated`, places for reports, gates and the commit in the task's directory, `#waiting` |
| `src/kanban/worktree.ts` (create) | `TaskDirectories`, `Workdirs`, `Prepared`, `taskBranch` |
| `src/core/workspace.ts` (modify) | `NamedWorkspaces` resolves `wt:` ids |
| `src/kanban/dispatcher.ts`, `brief.ts`, `prompt.ts` (modify) | the directory before the session; the prompt's directory lines |
| `src/index.ts` (modify) | the wiring, and the startup line |
| `src/kanban/chat-render.ts`, `src/cli/plain.ts`, `src/cli/operator.ts`, `src/cli/mt.ts`, `src/cli/workspace.ts` (modify) | `directory:`, `mt kanban task worktree`, `--isolated` |
| `README.md`, `docs/kanban-guide.md` (modify) | isolated workspaces |
| `tests/helpers/dispatch.ts`, `tests/config.test.ts`, `tests/gateway-startup.test.ts`, `tests/kanban-boards-schema.test.ts`, `tests/kanban-schema.test.ts`, `tests/kanban-prompt.test.ts`, `tests/workspace.test.ts`, `tests/mt-kanban-operator-tasks.test.ts`, `tests/mt-workspace.test.ts` (modify) | |
| `tests/kanban-worktree-schema.test.ts`, `tests/kanban-worktree-claim.test.ts`, `tests/kanban-worktree-service.test.ts`, `tests/kanban-worktree.e2e.ts`, `tests/kanban-dispatch-worktree.test.ts`, `tests/kanban-worktree-dispatch.e2e.ts`, `tests/kanban-worktree-chat.test.ts`, `tests/mt-kanban-worktree.test.ts` (create) | |

Running counts, unit then end to end: Task 1 1685 / 101, Task 2 1690 / 101, Task 3 1699 / 101, Task 4 1706 / 101, Task 5 1706 / 125, Task 6 1707 / 125, Task 7 1713 / 125, Task 8 1714 / 126, Task 9 1720 / 126, Task 10 1720 / 126, review follow-ups 1724 / 133.

---

### Task 1: A workspace written as a mapping

**Files:**

- Modify: `src/config.ts`, `tests/config.test.ts`

A workspace may be `{ path, isolated, base }` beside the plain path (Decisions 1 and 7). The paths stay in `workspaces`, as every caller reads them; the isolated ones are named in `isolated`, which is absent when there are none, so `loadTeamSettings` and `loadConfig` agree with the existing test that compares them.

- [ ] **Step 1.1: Write the tests.**

In `tests/config.test.ts`, replace:

```ts
  it('leaves the agent undefined when nothing configures one', () => {
```

with:

```ts
  it('reads a workspace written as a mapping, isolated or not, beside the plain form', () => {
    const cfg = load(
      {},
      yamlFile({
        workspace: undefined,
        workspaces: {
          default: '/srv/a',
          web: { path: '/srv/web', isolated: true },
          api: { path: '/srv/api', isolated: true, base: 'main' },
          docs: { path: '/srv/docs', isolated: false },
        },
      }),
    );
    expect(cfg.workspaces).toEqual({ default: '/srv/a', web: '/srv/web', api: '/srv/api', docs: '/srv/docs' });
    expect(cfg.isolated).toEqual({ web: {}, api: { base: 'main' } });
    // No isolated workspace, no setting: as before.
    expect(load().isolated).toBeUndefined();
  });

  it('refuses a mapping without a path, with an unknown key, with base but not isolated, or with a base git would misread', () => {
    const bad = (entry: unknown) => () => load({}, yamlFile({ workspace: undefined, workspaces: { default: '/srv/a', web: entry } }));
    expect(bad({ isolated: true })).toThrow('workspaces.web.path is required when the workspace is a mapping');
    expect(bad({ path: '/srv/web', shared: true })).toThrow(/unknown setting workspaces\.web\.shared/);
    expect(bad({ path: '/srv/web', isolated: 'yes' })).toThrow('workspaces.web.isolated must be true or false');
    expect(bad({ path: '/srv/web', base: 'main' })).toThrow('workspaces.web.base applies only to an isolated workspace');
    expect(bad({ path: '/srv/web', isolated: true, base: '--upload-pack=x' })).toThrow(
      'workspaces.web.base must be a branch, a tag or a commit',
    );
    expect(bad({ path: '/srv/web', isolated: true, base: 'two words' })).toThrow('workspaces.web.base must be');
  });

  it('leaves the agent undefined when nothing configures one', () => {
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/config.test.ts`. Expected: `Tests  2 failed | 75 passed (77)`: a mapping is refused as not a string.

- [ ] **Step 1.3: Implement.**

In `src/config.ts`, replace:

```ts

  maxLiveSessions: number;

  /** The board's dispatcher and breaker (spec §6, §8). */
  kanban: KanbanSettings;
```

with:

```ts
  /** The workspaces whose tasks each get their own directory (spec §18), by name; absent, none. */
  isolated?: Readonly<Record<string, IsolatedWorkspace>>;

  maxLiveSessions: number;

  /** The board's dispatcher and breaker (spec §6, §8). */
  kanban: KanbanSettings;
}

/**
 * A workspace written as `{ path, isolated: true }` (spec §18): each of its tasks
 * gets a directory of its own, so its tasks run side by side.
 */
export interface IsolatedWorkspace {
  /**
   * Where a task with no parents starts, in a git workspace: a branch, a tag or a
   * commit. Unset, whatever the workspace's directory has checked out when the
   * task's directory is made.
   */
  base?: string;
```

In `src/config.ts`, replace:

```ts
  workspaces: Readonly<Record<string, string>>;
  agent: AgentConfig | undefined;
```

with:

```ts
  workspaces: Readonly<Record<string, string>>;
  /** The isolated workspaces (spec §18), by name; absent when there are none. */
  isolated?: Readonly<Record<string, IsolatedWorkspace>>;
  agent: AgentConfig | undefined;
```

In `src/config.ts`, replace:

```ts
    maxLiveSessions,
```

with:

```ts
    ...(team.isolated === undefined ? {} : { isolated: team.isolated }),
    maxLiveSessions,
```

In `src/config.ts`, replace:

```ts
    agent,
```

with:

```ts
    ...(Object.keys(file.isolated).length === 0 ? {} : { isolated: file.isolated }),
    agent,
```

In `src/config.ts`, replace:

```ts
  db: string | undefined;
```

with:

```ts
  isolated: Record<string, IsolatedWorkspace>;
  db: string | undefined;
```

In `src/config.ts`, replace:

```ts
    db: undefined,
```

with:

```ts
    isolated: {},
    db: undefined,
```

In `src/config.ts`, replace:

```ts
  out.workspaces = stringMap(path, 'workspaces', root['workspaces']);
```

with:

```ts
  const workspaces = workspaceEntries(path, root['workspaces']);
  out.workspaces = workspaces.paths;
  out.isolated = workspaces.isolated;
```

In `src/config.ts`, replace:

```ts
function stringMap(path: string, key: string, value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(section(path, key, value))) {
    const text = str(path, `${key}.${name}`, entry);
    if (text !== undefined) out[name] = text;
  }
  return out;
```

with:

```ts
/** A base as git names one: no leading `-`, which git would read as an option, and no space or control character. */
const BASE_REF = /^(?!-)[^\s\u0000-\u001f\u007f]+$/;

/**
 * `workspaces:`, each a path, or a mapping `{ path, isolated, base }` (spec §18):
 * the paths, and the workspaces whose tasks each get a directory of their own.
 * `isolated: false` is the same as the plain path; `base` needs `isolated: true`.
 */
function workspaceEntries(
  path: string,
  value: unknown,
): { paths: Record<string, string>; isolated: Record<string, IsolatedWorkspace> } {
  const paths: Record<string, string> = {};
  const isolated: Record<string, IsolatedWorkspace> = {};
  if (value === undefined || value === null) return { paths, isolated };
  for (const [name, entry] of Object.entries(section(path, 'workspaces', value))) {
    const key = `workspaces.${name}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      const text = str(path, key, entry);
      if (text !== undefined) paths[name] = text;
      continue;
    }
    const fields = section(path, key, entry);
    reject(path, key, fields, ['path', 'isolated', 'base']);
    const dir = str(path, `${key}.path`, fields['path']);
    if (dir === undefined) throw new ConfigError(`${path}: ${key}.path is required when the workspace is a mapping`);
    paths[name] = dir;
    const on = bool(path, `${key}.isolated`, fields['isolated']) ?? false;
    const base = str(path, `${key}.base`, fields['base']);
    if (base !== undefined && !on) {
      throw new ConfigError(`${path}: ${key}.base applies only to an isolated workspace: set ${key}.isolated to true, or remove it`);
    }
    if (base !== undefined && !BASE_REF.test(base)) {
      throw new ConfigError(`${path}: ${key}.base must be a branch, a tag or a commit, got ${JSON.stringify(base)}`);
    }
    if (on) isolated[name] = base === undefined ? {} : { base };
  }
  return { paths, isolated };
```

- [ ] **Step 1.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1685 passed (1685)`. Run `npx vitest run --project e2e`. Expected: `Tests  101 passed (101)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.5: Commit.**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "Read a workspace written as a mapping, path, isolated and base, beside the plain path, and refuse one without a path, with an unknown key, with a base and no isolation, or with a base git would read as an option"
```

---

### Task 2: A task's directory, in the schema

**Files:**

- Create: `schema/007_task_directories.sql`, `tests/kanban-worktree-schema.test.ts`
- Modify: `src/db/WRITERS.md`, `src/db/kanban-read.ts`, `src/db/workspaces.ts`, `src/kanban/types.ts`, `tests/gateway-startup.test.ts`, `tests/kanban-boards-schema.test.ts`, `tests/kanban-prompt.test.ts`, `tests/kanban-schema.test.ts`

Migration `007` adds `kanban_tasks.worktree`, null for every task already on the board, and `TaskRow` reads it. A made directory is a `workspaces` row `wt:<task_id>` (Decision 5), written by `registerWorktree` and read by `worktreeOf`. Three tests that name the schema's version move to 7, and one that builds a task on a database migrated only to 6 migrates to 7, as every task row is now read with the column. The prompt test's hand-built task gains the field.

- [ ] **Step 2.1: Write the tests.**

In `tests/gateway-startup.test.ts`, replace:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 6 (${config.dbPath})\n`))).toBe(true);
```

with:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 7 (${config.dbPath})\n`))).toBe(true);
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
    expect(migrate(db, SCHEMA_DIR)).toBe(6);
```

with:

```ts
    expect(migrate(db, SCHEMA_DIR)).toBe(7);
```

In `tests/kanban-boards-schema.test.ts`, replace:

```ts
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 6 });
  });

  it('puts a task created afterwards on default unless it says otherwise', () => {
    db = migratedTo(6);
```

with:

```ts
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 7 });
  });

  it('puts a task created afterwards on default unless it says otherwise', () => {
    // As far as the code it runs needs: 007 adds the column every task row is read with.
    db = migratedTo(7);
```

In `tests/kanban-prompt.test.ts`, replace:

```ts
    board: 'default',
    ...extra,
```

with:

```ts
    board: 'default',
    worktree: null,
    ...extra,
```

In `tests/kanban-schema.test.ts`, replace:

```ts
    // 004 adds a column to kanban_comments and an index, 005 the people table, 006 the boards' two tables.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(6);
```

with:

```ts
    // 004 adds a column to kanban_comments and an index, 005 the people table, 006 the boards' two tables, 007 a column.
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(7);
```

Create `tests/kanban-worktree-schema.test.ts`:

```ts
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import {
  registeredWorkspaces,
  registerWorkspaces,
  registerWorktree,
  worktreeId,
  worktreeOf,
  type TaskDirectory,
} from '../src/db/workspaces.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { newTask } from './helpers/kanban.js';

/**
 * A task's own directory (spec §18): the column the claim fixes it in
 * (migration 007), and the workspaces row that records it once made.
 */

const NOW = 1_760_000_000_000;
const open: TestDb[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function db(): TestDb {
  const t = testDb();
  open.push(t);
  return t;
}

const DIR: TaskDirectory = {
  id: 'wt:k_one',
  kind: 'git-worktree',
  rootPath: '/home/mt/worktrees/web/k_one',
  repoRoot: '/srv/web',
  branch: 'mt/k_one',
};

describe('migration 007', () => {
  it('gives every task already on the board no directory of its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-wt-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) {
        if (/^00[1-6]_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      }
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(6);
        d.prepare(
          `INSERT INTO kanban_tasks (task_id, title, contract, phase, created_by, created_via, created_at)
           VALUES ('k_old', 'from before', jsonb('{}'), 'open', 'lark:on_alice', jsonb('{}'), ?)`,
        ).run(NOW);
        expect(migrate(d, SCHEMA_DIR)).toBe(7);
        expect(getTask(d, 'k_old')).toMatchObject({ taskId: 'k_old', workspace: null, worktree: null });
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a new task with no directory of its own', () => {
    const t = db();
    expect(newTask(t.db).worktree).toBeNull();
  });
});

describe('registerWorktree', () => {
  it("records a task's directory once, and the same again changes nothing", () => {
    const t = db();
    expect(worktreeId('k_one')).toBe('wt:k_one');
    expect(worktreeOf(t.db, 'wt:k_one')).toBeUndefined();
    expect(registerWorktree(t.db, DIR, NOW)).toEqual({ ok: true, added: ['wt:k_one'] });
    expect(registerWorktree(t.db, DIR, NOW + 1)).toEqual({ ok: true, added: [] });
    expect(worktreeOf(t.db, 'wt:k_one')).toEqual(DIR);
    const folder: TaskDirectory = { id: 'wt:k_two', kind: 'plain-dir', rootPath: '/home/mt/worktrees/notes/k_two', repoRoot: '/srv/notes', branch: null };
    registerWorktree(t.db, folder, NOW);
    expect(worktreeOf(t.db, 'wt:k_two')).toEqual(folder);
  });

  it('refuses another directory for a recorded id, and an id that is not a task directory', () => {
    const t = db();
    registerWorktree(t.db, DIR, NOW);
    expect(registerWorktree(t.db, { ...DIR, rootPath: '/elsewhere/k_one' }, NOW)).toEqual({
      error: 'wt:k_one is /home/mt/worktrees/web/k_one, recorded when it was made, not /elsewhere/k_one',
    });
    expect(registerWorktree(t.db, { ...DIR, id: 'web' }, NOW)).toEqual({ error: "web is not a task's directory id" });
    expect(worktreeOf(t.db, 'web')).toBeUndefined();
  });

  it("leaves tasks' directories out of the configured workspaces' registrations", () => {
    const t = db();
    registerWorkspaces(t.db, new Map([['web', '/srv/web']]), NOW);
    registerWorktree(t.db, DIR, NOW);
    expect(registeredWorkspaces(t.db)).toEqual(new Map([['web', '/srv/web']]));
  });
});
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-worktree-schema.test.ts tests/kanban-boards-schema.test.ts tests/kanban-schema.test.ts tests/gateway-startup.test.ts tests/kanban-prompt.test.ts`. Expected: `Test Files  4 failed | 1 passed (5)` and `Tests  8 failed | 53 passed (61)`: there is no migration 007, and the new file cannot import `registerWorktree`.

- [ ] **Step 2.3: Implement.**

Create `schema/007_task_directories.sql`:

```sql
-- manus-team migration 007: a task's own directory, in an isolated workspace
-- See docs/specs/2026-11-02-kanban-design.md §18.
--
-- A task in a workspace written `{ path, isolated: true }` works in a directory of
-- its own, so tasks in one repository run side by side. Which it does is decided
-- once, at its first agent claim, and kept: `worktree` is the id of its directory,
-- `wt:<task_id>`, a row the workspaces table gains when the directory is made;
-- null, the task works in its workspace's shared directory, as every task did
-- before this migration. Written once, by the claim, while null; db/kanban.ts is
-- its only writer (src/db/WRITERS.md). No default and no rewrite: every existing
-- task reads null.
ALTER TABLE kanban_tasks ADD COLUMN worktree TEXT;

UPDATE schema_version SET version = 7;
```

In `src/db/WRITERS.md`, replace:

```markdown
| `workspaces` | `db/workspaces.ts` | Rows are added, never updated: `root_path` is fixed the first time a name is seen (spec §2.3). `repo_root`, `branch` and `lock_holder` stay null until worktrees. |
| `kanban_tasks` | `db/kanban.ts` | `phase` is written only by its named transitions, each of which checks the current phase (spec §4.1). `workspace` is written once, while null. `board` (migration 006) is set at the insert and never changed. |
```

with:

```markdown
| `workspaces` | `db/workspaces.ts` | Rows are added, never updated: `root_path` is fixed the first time a name is seen (spec §2.3). A task's own directory (`wt:<task_id>`, spec §18) is added by `registerWorktree` once it is made, with `repo_root`, and `branch` for a worktree. `lock_holder` stays null. |
| `kanban_tasks` | `db/kanban.ts` | `phase` is written only by its named transitions, each of which checks the current phase (spec §4.1). `workspace` is written once, while null. `board` (migration 006) is set at the insert and never changed. `worktree` (migration 007) is written once, by a claim, while null (spec §18). |
```

In `src/db/kanban-read.ts`, replace:

```ts
  board: string;
}
```

with:

```ts
  board: string;
  worktree: string | null;
}
```

In `src/db/kanban-read.ts`, replace:

```ts
    board: r.board,
  };
```

with:

```ts
    board: r.board,
    worktree: r.worktree,
  };
```

In `src/db/kanban-read.ts`, replace:

```ts
  json(created_via) AS created_via, created_at, closed_at, created_from_task, board`;
```

with:

```ts
  json(created_via) AS created_via, created_at, closed_at, created_from_task, board, worktree`;
```

In `src/db/workspaces.ts`, replace:

```ts
/** Each registered name → its recorded directory. Empty before the migrations create the table. */
export function registeredWorkspaces(db: Db): Map<string, string> {
  try {
    const rows = db.prepare<[], { id: string; root_path: string }>('SELECT id, root_path FROM workspaces').all();
```

with:

```ts
/** Each registered name → its recorded directory; not a task's own directory. Empty before the migrations create the table. */
export function registeredWorkspaces(db: Db): Map<string, string> {
  try {
    const rows = db
      .prepare<[], { id: string; root_path: string }>(`SELECT id, root_path FROM workspaces WHERE id NOT LIKE 'wt:%'`)
      .all();
```

In `src/db/workspaces.ts`, replace:

```ts
    db.close();
  }
}
```

with:

```ts
    db.close();
  }
}

/**
 * A task's own directory, in an isolated workspace (spec §18): a git worktree on
 * its own branch, or a folder of its own. Its id is `wt:<task_id>`, which no
 * configured name can be, since a name has no `:`.
 */
export interface TaskDirectory {
  id: string;
  kind: 'git-worktree' | 'plain-dir';
  /** Absolute and real; it never moves (architecture Appendix A). */
  rootPath: string;
  /** The workspace's own directory: the repository a worktree belongs to, or the workspace a folder was made for. */
  repoRoot: string;
  /** The worktree's branch; null for a folder. */
  branch: string | null;
}

/** A task's directory id: the task's own, kind-prefixed (spec §2.3). */
export function worktreeId(taskId: string): string {
  return `wt:${taskId}`;
}

export function isWorktreeId(id: string): boolean {
  return id.startsWith('wt:');
}

/**
 * Record a task's directory once it is made, before any session works in it.
 * Written once: the same directory again changes nothing, and another for the
 * same id is refused, as a configured name's is (spec §2.3).
 */
export function registerWorktree(db: Db, dir: TaskDirectory, now: number): RegisterResult {
  if (!isWorktreeId(dir.id)) return { error: `${dir.id} is not a task's directory id` };
  return txImmediate(db, (d) => {
    const row = d.prepare<[string], { root_path: string }>('SELECT root_path FROM workspaces WHERE id = ?').get(dir.id);
    if (row !== undefined) {
      return row.root_path === dir.rootPath
        ? { ok: true, added: [] }
        : { error: `${dir.id} is ${row.root_path}, recorded when it was made, not ${dir.rootPath}` };
    }
    d.prepare('INSERT INTO workspaces (id, kind, root_path, repo_root, branch, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      dir.id,
      dir.kind,
      dir.rootPath,
      dir.repoRoot,
      dir.branch,
      now,
    );
    return { ok: true, added: [dir.id] };
  });
}

/** A task's directory as it was recorded when made; undefined before then. */
export function worktreeOf(db: Db, id: string): TaskDirectory | undefined {
  if (!isWorktreeId(id)) return undefined;
  const row = db
    .prepare<[string], { id: string; kind: string; root_path: string; repo_root: string | null; branch: string | null }>(
      'SELECT id, kind, root_path, repo_root, branch FROM workspaces WHERE id = ?',
    )
    .get(id);
  if (row === undefined) return undefined;
  return {
    id: row.id,
    kind: row.kind === 'git-worktree' ? 'git-worktree' : 'plain-dir',
    rootPath: row.root_path,
    repoRoot: row.repo_root ?? '',
    branch: row.branch,
  };
}
```

In `src/kanban/types.ts`, replace:

```ts
  board: string;
}
```

with:

```ts
  board: string;
  /**
   * Its own directory's id, `wt:<task_id>`, for a task in an isolated workspace
   * (spec §18): decided at its first agent claim and fixed; null, the workspace's
   * shared directory.
   */
  worktree: string | null;
}
```

- [ ] **Step 2.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1690 passed (1690)`. Run `npx vitest run --project e2e`. Expected: `Tests  101 passed (101)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.5: Commit.**

```bash
git add schema/007_task_directories.sql tests/kanban-worktree-schema.test.ts src/db/WRITERS.md src/db/kanban-read.ts src/db/workspaces.ts src/kanban/types.ts tests/gateway-startup.test.ts tests/kanban-boards-schema.test.ts tests/kanban-prompt.test.ts tests/kanban-schema.test.ts
git commit -m "Add kanban_tasks.worktree in migration 007, for a task with a directory of its own, and record such a directory in the workspaces table as wt:<task_id>, once, leaving those rows out of the configured workspaces' registrations"
```

---

### Task 3: The claim gives a task its directory

**Files:**

- Create: `tests/kanban-worktree-claim.test.ts`
- Modify: `src/db/kanban.ts`, `src/kanban/workspace.ts`

A task's first agent claim in an isolated workspace fixes `worktree` (Decisions 2 and 3). The run records its place as its `workspace`; the one-agent check is skipped for a task with a directory of its own; a report's gates hold back, and `workspace_busy` refuses, per place (Decision 6). `RunEnding.block` blocks a run's task for a person, uncounted (Decision 13).

- [ ] **Step 3.1: Write the tests.**

Create `tests/kanban-worktree-claim.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addGate, claim, closeRun, DEFAULT_LIMITS, endRun, reportCheck, requestReview } from '../src/db/kanban.js';
import { eventsOf, getRun, getTask } from '../src/db/kanban-read.js';
import { placeOf } from '../src/kanban/workspace.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, claimantFor, NOW, WORKSPACES, newTask } from './helpers/kanban.js';

/**
 * A task's own directory, decided at its claim (spec §18): its first agent claim
 * in an isolated workspace fixes it on the task, its runs record it as where they
 * work, and the one-agent limit of the workspace's shared directory does not hold
 * them back.
 */

const ISOLATED: ReadonlySet<string> = new Set(['web']);

let t: TestDb;
beforeEach(() => {
  t = testDb();
});
afterEach(() => t.close());

function claimIn(taskId: string, opts: { isolated?: ReadonlySet<string>; reportingIn?: ReadonlyMap<string, string> } = {}) {
  return claim(
    t.db,
    {
      taskId,
      claimant: claimantFor(t.db, taskId),
      workspaces: WORKSPACES,
      isolated: opts.isolated ?? ISOLATED,
      ...(opts.reportingIn === undefined ? {} : { reportingIn: opts.reportingIn }),
    },
    NOW,
  );
}

describe('a claim in an isolated workspace', () => {
  it('gives each task a directory of its own, so two of them run at once', () => {
    const a = newTask(t.db, { workspace: 'web' });
    const b = newTask(t.db, { workspace: 'web' });
    const first = claimIn(a.taskId);
    const second = claimIn(b.taskId);
    if (!first.ok || !second.ok) throw new Error('both claims should succeed');
    expect(first.run.workspace).toBe(`wt:${a.taskId}`);
    expect(second.run.workspace).toBe(`wt:${b.taskId}`);
    expect(getTask(t.db, a.taskId)).toMatchObject({ workspace: 'web', worktree: `wt:${a.taskId}` });
    expect(placeOf(second.task)).toBe(`wt:${b.taskId}`);
    const claimed = eventsOf(t.db, a.taskId).find((e) => e.kind === 'claimed');
    expect(claimed?.payload).toMatchObject({ workspace: 'web', worktree: `wt:${a.taskId}` });
  });

  it('keeps the shared directory, one agent at a time, for a workspace that is not isolated', () => {
    const a = newTask(t.db, { workspace: 'api' });
    const b = newTask(t.db, { workspace: 'api' });
    const first = claimIn(a.taskId);
    expect(first.ok && first.run.workspace).toBe('api');
    expect(first.ok && first.task.worktree).toBeNull();
    expect(claimIn(b.taskId)).toMatchObject({ ok: false, code: 'workspace_busy' });
    // Its claimed event is as it was.
    expect(eventsOf(t.db, a.taskId).find((e) => e.kind === 'claimed')?.payload).not.toHaveProperty('worktree');
  });

  it('leaves a task that has had an agent run in the shared directory there, and counts it against the shared one', () => {
    const old = newTask(t.db, { workspace: 'web' });
    // Its first run, before the workspace was isolated.
    const before = claimIn(old.taskId, { isolated: new Set() });
    if (!before.ok) throw new Error(before.message);
    endRun(t.db, before.run.runId, { outcome: 'failed', error: 'x' }, DEFAULT_LIMITS, NOW);
    closeRun(t.db, before.run.runId, NOW);
    const again = claimIn(old.taskId);
    if (!again.ok) throw new Error(again.message);
    expect(again.run.workspace).toBe('web');
    expect(again.task.worktree).toBeNull();
    // A second shared task waits for it; a new task, with a directory of its own, does not.
    const shared = newTask(t.db, { workspace: 'web' });
    claim(t.db, { taskId: shared.taskId, claimant: claimantFor(t.db, shared.taskId), workspaces: WORKSPACES }, NOW);
    expect(getRun(t.db, again.run.runId)?.endedAt).toBeNull();
    const fresh = newTask(t.db, { workspace: 'web' });
    expect(claimIn(fresh.taskId)).toMatchObject({ ok: true, run: { workspace: `wt:${fresh.taskId}` } });
  });

  it('keeps a task its own directory once it has one, though the workspace is no longer isolated', () => {
    const a = newTask(t.db, { workspace: 'web' });
    const first = claimIn(a.taskId);
    if (!first.ok) throw new Error(first.message);
    endRun(t.db, first.run.runId, { outcome: 'failed', error: 'x' }, DEFAULT_LIMITS, NOW);
    closeRun(t.db, first.run.runId, NOW);
    const retry = claimIn(a.taskId, { isolated: new Set() });
    expect(retry).toMatchObject({ ok: true, run: { workspace: `wt:${a.taskId}` }, task: { worktree: `wt:${a.taskId}` } });
  });

  it("gives a person's run no directory: a person's run does not use one", () => {
    const task = newTask(t.db, { workspace: 'web', assignee: { kind: 'human', name: ALICE } });
    const r = claimIn(task.taskId);
    expect(r).toMatchObject({ ok: true, run: { workspace: 'web' }, task: { worktree: null } });
  });

  it("is held back by a report's gates in the shared directory only when it works there", () => {
    const shared = newTask(t.db, { workspace: 'api' });
    const own = newTask(t.db, { workspace: 'web' });
    const reporting = new Map([
      ['api', 'k_other'],
      ['web', 'k_other'],
    ]);
    expect(claimIn(shared.taskId, { reportingIn: reporting })).toMatchObject({ ok: false, code: 'not_claimable' });
    expect(claimIn(own.taskId, { reportingIn: reporting })).toMatchObject({ ok: true });
  });

  it("does not refuse a person's review with gates for another task's agent run in the shared directory", () => {
    const own = newTask(t.db, { workspace: 'web' });
    const work = claimIn(own.taskId);
    if (!work.ok) throw new Error(work.message);
    const asked = requestReview(t.db, own.taskId, { kind: 'run', runId: work.run.runId }, { summary: 'done', reviewer: { kind: 'human', name: ALICE } }, NOW);
    if (!asked.ok) throw new Error(asked.message);
    closeRun(t.db, work.run.runId, NOW);
    const review = claimIn(own.taskId);
    if (!review.ok) throw new Error(review.message);
    expect(review.run.workspace).toBe(`wt:${own.taskId}`);
    // A task in the shared directory now has an agent at work there.
    const shared = newTask(t.db, { workspace: 'web' });
    expect(claimIn(shared.taskId, { isolated: new Set() })).toMatchObject({ ok: true, run: { workspace: 'web' } });
    addGate(t.db, own.taskId, { command: 'true', timeoutS: 5 }, ALICE, NOW);
    // The gates of the person's approval run in the task's own directory, where nobody else works.
    expect(reportCheck(t.db, own.taskId, { kind: 'person', principal: ALICE, as: 'reviewer' }, 'complete')).toMatchObject({ ok: true });
    // A task in the shared directory is held back, as before.
    const other = newTask(t.db, { workspace: 'web', assignee: { kind: 'human', name: ALICE } });
    claimIn(other.taskId);
    addGate(t.db, other.taskId, { command: 'true', timeoutS: 5 }, ALICE, NOW);
    expect(reportCheck(t.db, other.taskId, { kind: 'person', principal: ALICE, as: 'assignee' }, 'complete')).toMatchObject({
      ok: false,
      code: 'workspace_busy',
    });
  });
});

describe('a run that could not start for a reason only a person can put right', () => {
  it('blocks its task as needs_input with the reason, uncounted', () => {
    const a = newTask(t.db, { workspace: 'web' });
    const r = claimIn(a.taskId);
    if (!r.ok) throw new Error(r.message);
    const ended = endRun(
      t.db,
      r.run.runId,
      { outcome: 'failed', error: 'merging conflicts in a.txt', hadSideEffects: false, block: 'merging conflicts in a.txt' },
      DEFAULT_LIMITS,
      NOW,
    );
    expect(ended).toMatchObject({ ok: true, next: 'blocked', run: { outcome: 'failed' } });
    expect(getTask(t.db, a.taskId)).toMatchObject({
      phase: 'blocked',
      blockKind: 'needs_input',
      blockReason: 'merging conflicts in a.txt',
      blockedFrom: 'open',
      consecutiveFailures: 0,
    });
  });

  it('is only a failed run', () => {
    const a = newTask(t.db, { workspace: 'web' });
    const r = claimIn(a.taskId);
    if (!r.ok) throw new Error(r.message);
    expect(endRun(t.db, r.run.runId, { outcome: 'crashed', block: 'x' }, DEFAULT_LIMITS, NOW)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-worktree-claim.test.ts`. Expected: `Tests  7 failed | 2 passed (9)`: the claim knows no isolated workspace. The two that pass say what does not change: a workspace that is not isolated, and a person's claim.

- [ ] **Step 3.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
import { resolveTaskWorkspace } from '../kanban/workspace.js';
```

with:

```ts
import { placeOf, resolveTaskWorkspace } from '../kanban/workspace.js';
import { worktreeId } from './workspaces.js';
```

In `src/db/kanban.ts`, replace:

```ts
   * The workspaces whose gates a report is running now, each with the task
   * reported on. A task's workspace may be resolved only here, so a claim whose
   * workspace resolves to one of them is refused here, in the transaction.
```

with:

```ts
   * The isolated workspaces (spec §18): a task's first agent claim in one gives
   * the task a directory of its own. Absent, none is.
   */
  isolated?: ReadonlySet<string>;
  /**
   * The places -- a workspace's shared directory, by name, or a task's own, by
   * its `wt:` id -- whose gates a report is running now, each with the task
   * reported on. A task's workspace may be resolved only here, so a claim whose
   * place resolves to one of them is refused here, in the transaction.
```

In `src/db/kanban.ts`, replace:

```ts
 * holds no workspace.
 */
```

with:

```ts
 * holds no workspace.
 *
 * The task's first agent claim in an isolated workspace gives it a directory of
 * its own (spec §18), fixed on the task as `worktree`: its runs, this one on,
 * record that as theirs, and the one-agent limit of the workspace's shared
 * directory does not apply to them. A task that has had an agent run in the
 * shared directory keeps it, and so does a task whose workspace is no longer
 * isolated.
 */
```

In `src/db/kanban.ts`, replace:

```ts
    const testing = workspace === null ? undefined : input.reportingIn?.get(workspace);
    if (testing !== undefined) {
      return refuse('not_claimable', `workspace ${workspace ?? ''} is running the gates of a report on task ${testing}`);
    }
    if (agent) {
      if (workspace === null || !input.workspaces.has(workspace)) {
        return refuse('unassignable', `task ${task.taskId}'s workspace ${String(workspace)} is not configured`);
      }
      const busy = openAgentRunIn(d, workspace);
      if (busy !== undefined) {
        return refuse('workspace_busy', `workspace ${workspace} has an open agent run, ${busy.runId}`);
      }
    }

    const runs = runsOf(d, task.taskId);
```

with:

```ts
    const runs = runsOf(d, task.taskId);
    const worktree =
      task.worktree ??
      (agent && workspace !== null && input.isolated?.has(workspace) === true && !runs.some((r) => r.agentConfig !== null)
        ? worktreeId(task.taskId)
        : null);
    // Where the run works, and the task's gates run: its own directory, else its workspace's.
    const place = placeOf({ workspace, worktree });
    const testing = place === null ? undefined : input.reportingIn?.get(place);
    if (testing !== undefined) {
      return refuse('not_claimable', `workspace ${place ?? ''} is running the gates of a report on task ${testing}`);
    }
    if (agent) {
      if (workspace === null || !input.workspaces.has(workspace)) {
        return refuse('unassignable', `task ${task.taskId}'s workspace ${String(workspace)} is not configured`);
      }
      // One agent at a time in a shared directory; a task's own holds only its own runs.
      const busy = worktree === null ? openAgentRunIn(d, workspace) : undefined;
      if (busy !== undefined) {
        return refuse('workspace_busy', `workspace ${workspace} has an open agent run, ${busy.runId}`);
      }
    }

```

In `src/db/kanban.ts`, replace:

```ts
      workspace,
      input.claimant.roleMdHash,
      seededFromRun,
      input.tokenHash ?? null,
      now,
    );
    // A claimed task is no longer stranded (spec §3.1).
    d.prepare('UPDATE kanban_tasks SET workspace = ?, stranded_notified_at = NULL WHERE task_id = ?').run(
      workspace,
```

with:

```ts
      place,
      input.claimant.roleMdHash,
      seededFromRun,
      input.tokenHash ?? null,
      now,
    );
    // A claimed task is no longer stranded (spec §3.1).
    d.prepare('UPDATE kanban_tasks SET workspace = ?, worktree = ?, stranded_notified_at = NULL WHERE task_id = ?').run(
      workspace,
      worktree,
```

In `src/db/kanban.ts`, replace:

```ts
        payload: { kind, attempt, assignee: who.name, assigneeKind: who.kind, workspace, seededFromRun },
```

with:

```ts
        payload: {
          kind,
          attempt,
          assignee: who.name,
          assigneeKind: who.kind,
          workspace,
          seededFromRun,
          ...(worktree === null ? {} : { worktree }),
        },
```

In `src/db/kanban.ts`, replace:

```ts
  const workspace = r.task.workspace;
```

with:

```ts
  // Its own directory, if it has one (spec §18): no other task's agent works there.
  const workspace = placeOf(r.task);
```

In `src/db/kanban.ts`, replace:

```ts
  hadSideEffects?: boolean;
}
```

with:

```ts
  hadSideEffects?: boolean;
  /**
   * For a `failed` run that could not start for a reason only a person can put
   * right -- its task's directory could not be made (spec §18): the run is not
   * counted, and the task blocks as `needs_input` with this reason.
   */
  block?: string;
}
```

In `src/db/kanban.ts`, replace:

```ts
    const before = mustGet(d, run.taskId);
```

with:

```ts
    if (ending.block !== undefined && ending.outcome !== 'failed') {
      return refuse('invalid', 'only a failed run blocks its task for a person');
    }
    const before = mustGet(d, run.taskId);
```

In `src/db/kanban.ts`, replace:

```ts
        const failures = before.consecutiveFailures + 1;
```

with:

```ts
        // Nothing ran: not the task's failure, and nothing a retry would change.
        if (ending.block !== undefined) {
          blockAs = { kind: 'needs_input', reason: ending.block };
          break;
        }
        const failures = before.consecutiveFailures + 1;
```

In `src/kanban/workspace.ts`, replace:

```ts
  return { workspace: f.boardWorkspace ?? DEFAULT_WORKSPACE };
}
```

with:

```ts
  return { workspace: f.boardWorkspace ?? DEFAULT_WORKSPACE };
}

/**
 * Where a task's runs work and its gates run (spec §18): its own directory, by its
 * `wt:` id, once its first agent claim in an isolated workspace has given it one;
 * else its workspace's shared directory, by name; null while it has neither.
 */
export function placeOf(task: { workspace: string | null; worktree: string | null }): string | null {
  return task.worktree ?? task.workspace;
}
```

- [ ] **Step 3.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1699 passed (1699)`. Run `npx vitest run --project e2e`. Expected: `Tests  101 passed (101)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.5: Commit.**

```bash
git add tests/kanban-worktree-claim.test.ts src/db/kanban.ts src/kanban/workspace.ts
git commit -m "Give a task its own directory at its first agent claim in an isolated workspace, keep it for every later run, record it as the run's place, hold only the shared directory to one agent, and let a run that could not start block its task for a person, uncounted"
```

---

### Task 4: The service, in the task's directory

**Files:**

- Create: `tests/kanban-worktree-service.test.ts`
- Modify: `src/db/kanban-read.ts`, `src/kanban/service.ts`

The service tells the claim which workspaces are isolated, runs a report's gates and reads its commit in the task's directory, refuses gates while it is not made yet, holds reports and claims per place (Decision 16), and `show` gives `workdir` and does not say a task waits on the shared directory's agent when the claim would give it a directory of its own (Decision 6). Its own check before the claim computes the place the claim would give (`#placeFor`), so a report's gates in the shared directory do not hold back a task about to get a directory of its own.

- [ ] **Step 4.1: Write the tests.**

Create `tests/kanban-worktree-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerWorktree } from '../src/db/workspaces.js';
import type { CommitReader } from '../src/kanban/commit.js';
import type { GateExit, GateRunOptions } from '../src/kanban/gates.js';
import { KanbanService } from '../src/kanban/service.js';
import type { RunRow, TaskRow } from '../src/kanban/types.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * The service and a task's own directory (spec §18): the claim is told which
 * workspaces are isolated, a report's checks run in the task's directory, a
 * report there holds back no other task, and `show` says where the directory is.
 */

const ROLES = new Map([role('default'), role('implementer')].map((r) => [r.name, r]));
const DIRS = new Map([...WORKSPACES].map((w) => [w, `/ws/${w}`]));
const SHA = '0123456789abcdef0123456789abcdef01234567';

let t: TestDb;
let s: KanbanService;
let ran: Array<{ command: string; cwd: string }>;
let read: string[];
let release: (() => void) | undefined;

beforeEach(() => {
  t = testDb();
  ran = [];
  read = [];
  release = undefined;
  const runGate = async (command: string, opts: GateRunOptions): Promise<GateExit> => {
    ran.push({ command, cwd: opts.cwd });
    if (command === 'slow') await new Promise<void>((resolve) => (release = resolve));
    return { exitCode: 0, signal: null, timedOut: false, output: '' };
  };
  const readCommit: CommitReader = async (cwd) => {
    read.push(cwd);
    return { commit: SHA, dirty: false };
  };
  s = new KanbanService({
    db: t.db,
    roles: ROLES,
    workspaces: WORKSPACES,
    isolated: new Set(['web']),
    clock: new ManualClock(),
    checks: { workspaceDirs: DIRS, env: { PATH: '/usr/bin' }, runGate, readCommit },
  });
});
afterEach(() => t.close());

function create(workspace = 'web'): TaskRow {
  const r = s.create({ title: 'a task', assignee: 'implementer', workspace, createdBy: ALICE, createdVia: VIA });
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

function claim(taskId: string): RunRow {
  const r = s.claim(taskId);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.run;
}

/** The task's directory, as the dispatcher records it once made. */
function made(taskId: string): string {
  const path = `/home/mt/worktrees/web/${taskId}`;
  registerWorktree(t.db, { id: `wt:${taskId}`, kind: 'git-worktree', rootPath: path, repoRoot: '/ws/web', branch: `mt/${taskId}` }, NOW);
  return path;
}

describe('a task with a directory of its own', () => {
  it('is claimed with one, beside another task in the same workspace', () => {
    const a = create();
    const b = create();
    expect(claim(a.taskId).workspace).toBe(`wt:${a.taskId}`);
    expect(claim(b.taskId).workspace).toBe(`wt:${b.taskId}`);
  });

  it('runs its gates, and reads its commit, in its own directory', async () => {
    const task = create();
    s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = claim(task.taskId);
    const dir = made(task.taskId);
    expect(await s.complete(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' })).toMatchObject({
      ok: true,
      run: { reportedCommit: SHA },
    });
    expect(ran).toEqual([{ command: 'npm test', cwd: dir }]);
    expect(read).toEqual([dir]);
  });

  it('refuses gates it cannot run yet: its directory is made before its next agent run', async () => {
    const task = create();
    s.addGate(task.taskId, { command: 'npm test' }, ALICE);
    const run = claim(task.taskId);
    expect(await s.complete(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' })).toMatchObject({
      ok: false,
      code: 'gates_cannot_run',
      message: `task ${task.taskId}'s own directory has not been made yet, so its gates cannot run; it is made before its next agent run`,
    });
    expect(ran).toEqual([]);
  });

  it('holds back no other task while its gates run, as a shared directory does', async () => {
    const task = create();
    s.addGate(task.taskId, { command: 'slow' }, ALICE);
    const run = claim(task.taskId);
    made(task.taskId);
    const report = s.complete(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ran.map((r) => r.command)).toEqual(['slow']);
    // Another task in the same workspace starts in its own directory meanwhile.
    expect(s.claim(create().taskId)).toMatchObject({ ok: true });
    release?.();
    expect(await report).toMatchObject({ ok: true });
  });

  it("is not said to wait on the shared directory's agent run", () => {
    // A task first claimed before the workspace was isolated works in the shared directory.
    const shared = create();
    const before = new KanbanService({ db: t.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock() });
    const r = before.claim(shared.taskId);
    if (!r.ok) throw new Error(r.message);
    const waiting = create();
    expect(s.show(waiting.taskId)).toMatchObject({ ok: true });
    const view = s.show(waiting.taskId);
    expect(view.ok && view.view.waiting).toBeUndefined();
    // As the claim agrees: it gets a directory of its own, and is not held back.
    expect(s.claim(waiting.taskId)).toMatchObject({ ok: true, run: { workspace: `wt:${waiting.taskId}` } });
  });

  it("is claimed while a report's gates run in the shared directory, which it does not work in", async () => {
    // A task first claimed before the workspace was isolated works in the shared directory.
    const shared = create();
    s.addGate(shared.taskId, { command: 'slow' }, ALICE);
    const before = new KanbanService({ db: t.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock() });
    const run = before.claim(shared.taskId);
    if (!run.ok) throw new Error(run.message);
    const report = s.complete(shared.taskId, { kind: 'run', runId: run.run.runId }, { summary: 'done' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ran.map((r) => r.cwd)).toEqual(['/ws/web']);
    const fresh = create();
    expect(s.claim(fresh.taskId)).toMatchObject({ ok: true, run: { workspace: `wt:${fresh.taskId}` } });
    // A second shared task still waits for the shared directory's agent.
    const other = create();
    const plain = new KanbanService({ db: t.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock() });
    expect(plain.claim(other.taskId)).toMatchObject({ ok: false, code: 'workspace_busy' });
    release?.();
    expect(await report).toMatchObject({ ok: true });
  });

  it('says where its directory is, and its branch, once made', () => {
    const task = create();
    claim(task.taskId);
    expect(s.show(task.taskId)).toMatchObject({ ok: true, view: { workdir: { path: null, branch: null } } });
    const dir = made(task.taskId);
    expect(s.show(task.taskId)).toMatchObject({ ok: true, view: { workdir: { path: dir, branch: `mt/${task.taskId}` } } });
    const shared = create('api');
    claim(shared.taskId);
    const view = s.show(shared.taskId);
    expect(view.ok && view.view.workdir).toBeUndefined();
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-worktree-service.test.ts`. Expected: `Tests  7 failed (7)`: the service takes no `isolated`, so every task is claimed in the shared directory.

- [ ] **Step 4.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts
import type {
```

with:

```ts
import { worktreeOf } from './workspaces.js';
import type {
```

In `src/db/kanban-read.ts`, replace:

```ts
  waiting?: readonly Waiting[];
}
```

with:

```ts
  waiting?: readonly Waiting[];
  /**
   * For a task with a directory of its own (spec §18): where it is, and its
   * branch for a git worktree. `path` is null until the directory is made,
   * before the task's next agent run.
   */
  workdir?: { path: string | null; branch: string | null };
}
```

In `src/db/kanban-read.ts`, replace:

```ts
    comments: commentsOf(db, taskId),
  };
}
```

with:

```ts
    comments: commentsOf(db, taskId),
    ...(task.worktree === null ? {} : { workdir: workdirOf(db, task.worktree) }),
  };
}

function workdirOf(db: Db, worktree: string): { path: string | null; branch: string | null } {
  const made = worktreeOf(db, worktree);
  return { path: made?.rootPath ?? null, branch: made?.branch ?? null };
}
```

In `src/kanban/service.ts`, replace:

```ts
import { resolveTaskWorkspace } from './workspace.js';
```

with:

```ts
import { isWorktreeId, worktreeId, worktreeOf } from '../db/workspaces.js';
import { placeOf, resolveTaskWorkspace } from './workspace.js';
```

In `src/kanban/service.ts`, replace:

```ts
  clock?: Clock;
```

with:

```ts
  /** The isolated ones (spec §18), whose tasks each get a directory of their own; absent, none. */
  isolated?: ReadonlySet<string>;
  clock?: Clock;
```

In `src/kanban/service.ts`, replace:

```ts
  readonly #clock: Clock;
```

with:

```ts
  readonly #isolated: ReadonlySet<string>;
  readonly #clock: Clock;
```

In `src/kanban/service.ts`, replace:

```ts
   * Tasks a report is running its checks for, with the task's workspace and the
   * report's end. One at a time per task: a second report would run the same
   * gates again, at once, in the same checkout. And no claim meanwhile, of the
   * task or of another in that workspace, which would start an agent in a
   * checkout being tested.
```

with:

```ts
   * Tasks a report is running its checks for, with where the gates run -- the
   * task's own directory, by its `wt:` id, or its workspace's shared one (spec
   * §18) -- and the report's end. One at a time per task: a second report would
   * run the same gates again, at once, in the same checkout. And no claim
   * meanwhile, of the task or of another working there, which would start an
   * agent in a checkout being tested.
```

In `src/kanban/service.ts`, replace:

```ts
    this.#clock = deps.clock ?? systemClock;
```

with:

```ts
    this.#isolated = deps.isolated ?? new Set();
    this.#clock = deps.clock ?? systemClock;
```

In `src/kanban/service.ts`, replace:

```ts
    const testing = task.workspace === null ? undefined : this.#reportingIn(task.workspace);
    if (testing !== undefined) {
      return board.refuse(
        'not_claimable',
        `workspace ${task.workspace ?? ''} is running the gates of a report on task ${testing}`,
```

with:

```ts
    const place = this.#placeFor(task);
    const testing = place === null ? undefined : this.#reportingIn(place);
    if (testing !== undefined) {
      return board.refuse(
        'not_claimable',
        `workspace ${place ?? ''} is running the gates of a report on task ${testing}`,
```

In `src/kanban/service.ts`, replace:

```ts
            reportingIn: this.#reportingWorkspaces(),
```

with:

```ts
            isolated: this.#isolated,
            reportingIn: this.#reportingWorkspaces(),
```

In `src/kanban/service.ts`, replace:

```ts
    // One report's checks in a workspace at a time: two reports' gates in one checkout would trip over each other.
    const other = now.task.workspace === null ? undefined : this.#reportingIn(now.task.workspace);
    if (other !== undefined) {
      return board.refuse(
        'report_in_progress',
        `workspace ${now.task.workspace ?? ''} is running the gates of a report on another task, ${other}; ` +
```

with:

```ts
    // One report's checks in a checkout at a time: two reports' gates in one would trip over each other.
    const place = placeOf(now.task);
    const other = place === null ? undefined : this.#reportingIn(place);
    if (other !== undefined) {
      return board.refuse(
        'report_in_progress',
        `workspace ${place ?? ''} is running the gates of a report on another task, ${other}; ` +
```

In `src/kanban/service.ts`, replace:

```ts
    this.#reporting.set(taskId, { workspace: now.task.workspace, done: checked });
```

with:

```ts
    this.#reporting.set(taskId, { workspace: place, done: checked });
```

In `src/kanban/service.ts`, replace:

```ts
   * The reported commit (spec §7.8): for an agent's report, its workspace's HEAD
   * and whether the tree had uncommitted changes; neither when the workspace
   * is not a git repository. A person's report records neither: there is no
   * agent state to pin.
```

with:

```ts
   * The reported commit (spec §7.8): for an agent's report, the HEAD of the
   * directory its run works in -- the task's own, or its workspace's (spec §18)
   * -- and whether the tree had uncommitted changes; neither when that is not a
   * git repository. A person's report records neither: there is no agent state
   * to pin.
```

In `src/kanban/service.ts`, replace:

```ts
    const dir = checks.workspaceDirs.get(run.workspace);
```

with:

```ts
    const dir = this.#dirOf(run.workspace);
```

In `src/kanban/service.ts`, replace:

```ts
    const cwd = checks.workspaceDirs.get(task.workspace);
    if (cwd === undefined) {
      return board.refuse(
        'gates_cannot_run',
        `task ${id}'s workspace ${JSON.stringify(task.workspace)} is no longer configured, so its gates cannot run`,
```

with:

```ts
    if (!checks.workspaceDirs.has(task.workspace)) {
      return board.refuse(
        'gates_cannot_run',
        `task ${id}'s workspace ${JSON.stringify(task.workspace)} is no longer configured, so its gates cannot run`,
      );
    }
    // In the task's own directory, if it has one (spec §18).
    const cwd = this.#dirOf(placeOf(task) ?? task.workspace);
    if (cwd === undefined) {
      return board.refuse(
        'gates_cannot_run',
        `task ${id}'s own directory has not been made yet, so its gates cannot run; it is made before its next agent run`,
```

In `src/kanban/service.ts`, replace:

```ts
      },
    };
  }

```

with:

```ts
      },
    };
  }

  /**
   * Where a claim of the task now would put its run (spec §18.2): its own
   * directory, the one its first agent claim in an isolated workspace would give
   * it, or its workspace's shared one; null while its workspace is not fixed,
   * which the claim's own transaction checks once it is.
   */
  #placeFor(task: TaskRow): string | null {
    if (task.worktree !== null || task.workspace === null) return placeOf(task);
    const who = task.phase === 'review' ? task.reviewer : task.assignee;
    const fresh =
      who?.kind === 'role' &&
      this.#isolated.has(task.workspace) &&
      !runsOf(this.#db, task.taskId).some((r) => r.agentConfig !== null);
    return fresh ? worktreeId(task.taskId) : task.workspace;
  }

  /** A place's directory: a task's own, as recorded once it was made (spec §18), or a configured workspace's. */
  #dirOf(place: string): string | undefined {
    if (isWorktreeId(place)) return worktreeOf(this.#db, place)?.rootPath;
    return this.#checks?.workspaceDirs.get(place);
  }

```

In `src/kanban/service.ts`, replace:

```ts
    const busy = workspaceBusy(this.#db, workspace);
```

with:

```ts
    // A task with a directory of its own, or about to get one, holds no shared directory (spec §18).
    const own =
      task.worktree !== null || (this.#isolated.has(workspace) && !view.runs.some((r) => r.agentConfig !== null));
    const busy = own ? undefined : workspaceBusy(this.#db, workspace);
```

- [ ] **Step 4.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1706 passed (1706)`. Run `npx vitest run --project e2e`. Expected: `Tests  101 passed (101)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.5: Commit.**

```bash
git add tests/kanban-worktree-service.test.ts src/db/kanban-read.ts src/kanban/service.ts
git commit -m "Tell the claim which workspaces are isolated, run a report's gates and read its commit in the task's own directory, hold reports and claims back per directory, and say in show where the directory is, and no wait on the shared one for a task that gets its own"
```

---

### Task 5: Making the directories

**Files:**

- Create: `src/kanban/worktree.ts`, `tests/kanban-worktree.e2e.ts`
- Modify: `src/db/kanban-read.ts`

`TaskDirectories.prepare` makes, or finds, a task's directory with real git (Decisions 4, 7 to 11, 14, 15, 19 and 20). It never rejects: a reason comes back for a person. Git runs in a process group of its own, killed whole past its time, and its answer is its exit: what it leaves holding its output is not waited for. A worktree is recorded the moment `git worktree add` succeeds, so a conflict's directory can be shown; the fan-in's merges go on at each later prepare until the task's first session starts. A recorded worktree that is no longer on its branch blocks. `parentsInLinkOrder` gives the parents in the order they were linked. The tests are end to end, with real git in temporary repositories under a made-up home.

- [ ] **Step 5.1: Write the tests.**

Create `tests/kanban-worktree.e2e.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archive, claim, closeRun, complete, link } from '../src/db/kanban.js';
import { getTask } from '../src/db/kanban-read.js';
import { worktreeOf } from '../src/db/workspaces.js';
import { runGit, TaskDirectories } from '../src/kanban/worktree.js';
import type { TaskRow } from '../src/kanban/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { claimantFor, NOW, newTask } from './helpers/kanban.js';

/**
 * A task's own directory against real git (spec §18): a worktree on its own
 * branch, from its parents' work, with a fan-in's merge made, a conflict left for
 * a person and taken up again once resolved; a folder for a workspace that is no
 * repository; and every refusal leaving the repository as it was.
 */

let dir: string;
let t: TestDb;
/** git's environment: a made-up home, so no test reads the real one's configuration. */
let env: Record<string, string>;
let repo: string;
let root: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `write ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

function directories(workspaces: Record<string, string> = { web: repo }, isolated: Record<string, { base?: string }> = { web: {} }) {
  return new TaskDirectories({ db: t.db, root, workspaceDirs: new Map(Object.entries(workspaces)), isolated, env });
}

/** A task claimed in an isolated workspace, so it has a directory of its own to make. */
function claimed(workspace = 'web', extra: Parameters<typeof newTask>[1] = {}): TaskRow {
  const task = newTask(t.db, { workspace, ...extra });
  const r = claim(
    t.db,
    { taskId: task.taskId, claimant: claimantFor(t.db, task.taskId), workspaces: new Set([workspace]), isolated: new Set([workspace]) },
    NOW,
  );
  if (!r.ok) throw new Error(r.message);
  return r.task;
}

/** Finish a task's run as done, so its children can be claimed. */
function finish(task: TaskRow): void {
  const run = claimantRun(task);
  const r = complete(t.db, task.taskId, { kind: 'run', runId: run }, { summary: 'done' }, NOW);
  if (!r.ok) throw new Error(r.message);
  closeRun(t.db, run, NOW);
}

function claimantRun(task: TaskRow): string {
  const row = t.db.prepare<[string], { run_id: string }>('SELECT run_id FROM kanban_runs WHERE task_id = ? AND ended_at IS NULL').get(task.taskId);
  if (row === undefined) throw new Error(`task ${task.taskId} has no open run`);
  return row.run_id;
}

async function made(d: TaskDirectories, task: TaskRow): Promise<string> {
  const r = await d.prepare(getTask(t.db, task.taskId) ?? task);
  if (!r.ok) throw new Error(r.reason);
  return r.dir.rootPath;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-worktree-')));
  env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
  repo = join(dir, 'web');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@example.com');
  commit(repo, 'README', 'hello\n');
  root = join(dir, 'home', 'worktrees');
  mkdirSync(join(dir, 'home'));
  t = testDb();
});

afterEach(() => {
  t.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a task with no parents', () => {
  it("starts from what the workspace has checked out, on its own branch, outside the repository, and leaves the base checkout's changes behind", async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'README'), 'changed, not committed\n');
    const task = claimed();
    const d = directories();
    const path = await made(d, task);
    expect(path).toBe(join(realpathSync(root), 'web', task.taskId));
    expect(git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(`mt/${task.taskId}`);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(path, 'README'), 'utf8')).toBe('hello\n');
    expect(worktreeOf(t.db, `wt:${task.taskId}`)).toEqual({
      id: `wt:${task.taskId}`,
      kind: 'git-worktree',
      rootPath: path,
      repoRoot: repo,
      branch: `mt/${task.taskId}`,
    });
    // The base checkout is as it was, and its own status does not see the worktree.
    expect(git(repo, 'status', '--porcelain')).toBe('M README');
    expect((statSync(join(root, 'web')).mode & 0o777).toString(8)).toBe('700');
    // Every later run uses the same directory.
    expect(await made(d, task)).toBe(path);
  });

  it("starts from the workspace's configured base instead", async () => {
    git(repo, 'checkout', '-q', '-b', 'release');
    const release = commit(repo, 'CHANGES', 'one\n');
    git(repo, 'checkout', '-q', 'main');
    const task = claimed();
    const path = await made(directories({ web: repo }, { web: { base: 'release' } }), task);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(release);
    const missing = claimed();
    expect(await directories({ web: repo }, { web: { base: 'nowhere' } }).prepare(missing)).toEqual({
      ok: false,
      reason: 'the base nowhere of workspace web is not a commit there',
    });
  });

  it('runs no hook of the repository', async () => {
    const marker = join(dir, 'hook-ran');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await made(directories(), claimed());
    expect(existsSync(marker)).toBe(false);
  });

  it('is made from a bare repository too', async () => {
    const bare = join(dir, 'bare.git');
    git(dir, 'clone', '-q', '--bare', repo, bare);
    const path = await made(directories({ web: bare }), claimed());
    expect(readFileSync(join(path, 'README'), 'utf8')).toBe('hello\n');
  });
});

describe('a task with parents', () => {
  it("starts from its one parent's branch", async () => {
    const d = directories();
    const parent = claimed();
    const parentDir = await made(d, parent);
    const work = commit(parentDir, 'a.txt', 'from the parent\n');
    finish(parent);
    const child = newTask(t.db, { workspace: 'web', parents: [parent.taskId] });
    const r = claim(t.db, { taskId: child.taskId, claimant: claimantFor(t.db, child.taskId), workspaces: new Set(['web']), isolated: new Set(['web']) }, NOW);
    if (!r.ok) throw new Error(r.message);
    const childDir = await made(d, r.task);
    expect(git(childDir, 'rev-parse', 'HEAD')).toBe(work);
  });

  it("merges several parents' branches, and leaves a conflict for a person, taking it up again once resolved", async () => {
    const d = directories();
    const [a, b, c] = [claimed(), claimed(), claimed()];
    commit(await made(d, a), 'a.txt', 'from a\n');
    commit(await made(d, b), 'README', 'from b\n');
    commit(await made(d, c), 'README', 'from c\n');
    for (const p of [a, b, c]) finish(p);
    const child = newTask(t.db, { workspace: 'web' });
    for (const p of [a, b, c]) link(t.db, p.taskId, child.taskId, 'lark:on_alice', NOW);
    const r = claim(t.db, { taskId: child.taskId, claimant: claimantFor(t.db, child.taskId), workspaces: new Set(['web']), isolated: new Set(['web']) }, NOW);
    if (!r.ok) throw new Error(r.message);
    const path = join(realpathSync(root), 'web', child.taskId);

    const conflicted = await d.prepare(r.task);
    expect(conflicted).toEqual({
      ok: false,
      reason:
        `merging the branch mt/${c.taskId} of its parent ${c.taskId} conflicts in README. ` +
        `Resolve it in ${path}: fix those files and commit there, then unblock the task`,
    });
    // Recorded already, so show and mt kanban task worktree can point the person at it.
    expect(worktreeOf(t.db, `wt:${child.taskId}`)?.rootPath).toBe(path);
    // Taken up again before it is resolved: still waiting for the person.
    expect(await d.prepare(r.task)).toEqual({
      ok: false,
      reason: `a merge in ${path} is not finished: resolve its conflicts and commit there, then unblock the task`,
    });
    // The person resolves it.
    writeFileSync(join(path, 'README'), 'from b and c\n');
    git(path, 'add', 'README');
    git(path, 'commit', '-q', '--no-edit');
    expect(await made(d, r.task)).toBe(path);
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('from a\n');
    for (const p of [a, b, c]) expect(spawnSync('git', ['merge-base', '--is-ancestor', `mt/${p.taskId}`, 'HEAD'], { cwd: path, env }).status).toBe(0);
    // The base branch was never touched.
    expect(git(repo, 'log', '--format=%s', 'main')).toBe('write README');
  });

  it("refuses a parent's branch that is gone", async () => {
    const d = directories();
    const parent = claimed();
    const parentDir = await made(d, parent);
    finish(parent);
    git(repo, 'worktree', 'remove', parentDir);
    git(repo, 'branch', '-D', `mt/${parent.taskId}`);
    const child = newTask(t.db, { workspace: 'web', parents: [parent.taskId] });
    const r = claim(t.db, { taskId: child.taskId, claimant: claimantFor(t.db, child.taskId), workspaces: new Set(['web']), isolated: new Set(['web']) }, NOW);
    if (!r.ok) throw new Error(r.message);
    expect(await d.prepare(r.task)).toEqual({ ok: false, reason: `the branch mt/${parent.taskId} of its parent ${parent.taskId} is not there` });
  });
});

describe('what it refuses, changing nothing', () => {
  it('a branch of its name that is there already, at another commit than it would start from', async () => {
    const task = claimed();
    git(repo, 'branch', `mt/${task.taskId}`);
    commit(repo, 'later.txt', 'later\n');
    const before = git(repo, 'rev-parse', `mt/${task.taskId}`);
    const r = await directories().prepare(task);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(`a branch mt/${task.taskId} is there already`) });
    expect(git(repo, 'rev-parse', `mt/${task.taskId}`)).toBe(before);
    expect(existsSync(join(root, 'web', task.taskId))).toBe(false);
  });

  it('a directory that is gone once made, keeping its branch', async () => {
    const d = directories();
    const task = claimed();
    const path = await made(d, task);
    rmSync(path, { recursive: true, force: true });
    const r = await d.prepare(task);
    expect(r).toEqual({
      ok: false,
      reason: `its directory ${path} is gone; make it again from its branch with git worktree add ${path} mt/${task.taskId}, in ${repo}, then unblock the task`,
    });
    expect(git(repo, 'branch', '--list', `mt/${task.taskId}`)).toContain(`mt/${task.taskId}`);
  });

  it('a symlinked directory for the worktrees', async () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, root);
    const r = await directories().prepare(claimed());
    expect(r).toEqual({ ok: false, reason: `${root} is a symlink; tasks' directories must be real directories under the gateway's home` });
  });
});

describe('what it takes care over', () => {
  /** A child of these parents, linked in this order, claimed. */
  function childOf(parents: readonly TaskRow[]): TaskRow {
    const child = newTask(t.db, { workspace: 'web' });
    for (const p of parents) link(t.db, p.taskId, child.taskId, 'lark:on_alice', NOW);
    const r = claim(t.db, { taskId: child.taskId, claimant: claimantFor(t.db, child.taskId), workspaces: new Set(['web']), isolated: new Set(['web']) }, NOW);
    if (!r.ok) throw new Error(r.message);
    return r.task;
  }

  it('starts a fan-in from the parent linked first, not the one made first', async () => {
    const d = directories();
    const [a, b] = [claimed(), claimed()];
    commit(await made(d, a), 'a.txt', 'a\n');
    const tipB = commit(await made(d, b), 'b.txt', 'b\n');
    for (const p of [a, b]) finish(p);
    const child = childOf([b, a]);
    const path = await made(d, child);
    expect(git(path, 'rev-parse', 'HEAD^1')).toBe(tipB);
    expect(git(path, 'log', '-1', '--format=%s')).toBe(`Merge mt/${a.taskId} into mt/${child.taskId}`);
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\n');
  });

  it("merges no archived parent's work, which was abandoned", async () => {
    const d = directories();
    const [kept, dropped] = [claimed(), claimed()];
    commit(await made(d, kept), 'kept.txt', 'kept\n');
    commit(await made(d, dropped), 'dropped.txt', 'dropped\n');
    finish(kept);
    archive(t.db, dropped.taskId, 'lark:on_alice', NOW);
    const path = await made(d, childOf([kept, dropped]));
    expect(existsSync(join(path, 'kept.txt'))).toBe(true);
    expect(existsSync(join(path, 'dropped.txt'))).toBe(false);
  });

  it("takes a parent's branch, never a tag of the same name", async () => {
    const d = directories();
    const parent = claimed();
    const work = commit(await made(d, parent), 'a.txt', 'a\n');
    finish(parent);
    git(repo, 'tag', `mt/${parent.taskId}`, 'main');
    const path = await made(d, childOf([parent]));
    expect(git(path, 'rev-parse', 'HEAD')).toBe(work);
  });

  it('takes up the branch a failed git worktree add left, at the commit it would start from', async () => {
    writeFileSync(join(repo, '.gitattributes'), '* filter=broken\n');
    git(repo, 'add', '.gitattributes');
    git(repo, 'commit', '-q', '-m', 'attributes');
    git(repo, 'config', 'filter.broken.smudge', 'false');
    git(repo, 'config', 'filter.broken.required', 'true');
    const d = directories();
    const task = claimed();
    expect(await d.prepare(task)).toMatchObject({ ok: false, reason: expect.stringContaining('git worktree add failed') });
    expect(git(repo, 'branch', '--list', `mt/${task.taskId}`)).toContain(`mt/${task.taskId}`);
    git(repo, 'config', '--unset', 'filter.broken.required');
    git(repo, 'config', '--unset', 'filter.broken.smudge');
    const path = await made(d, task);
    expect(git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(`mt/${task.taskId}`);
  });

  it('stops a git command past its time, with what it started, and names what it left for a person', async () => {
    writeFileSync(join(repo, '.gitattributes'), '* filter=slow\n');
    git(repo, 'add', '.gitattributes');
    git(repo, 'commit', '-q', '-m', 'attributes');
    const marker = join(dir, 'filter-finished');
    git(repo, 'config', 'filter.slow.smudge', `sleep 3; touch '${marker}'; cat`);
    const task = claimed();
    const quick = new TaskDirectories({ db: t.db, root, workspaceDirs: new Map([['web', repo]]), isolated: { web: {} }, env, timeoutMs: 500 });
    const began = Date.now();
    const first = await quick.prepare(task);
    expect(first).toMatchObject({ ok: false, reason: expect.stringContaining('git did not finish in 1 s, and was stopped') });
    // What to do is in the first reason already, so the person need not unblock twice to learn it.
    expect(first).toMatchObject({ reason: expect.stringContaining(`git worktree remove --force ${join(realpathSync(root), 'web', task.taskId)}`) });
    expect(Date.now() - began).toBeLessThan(2500);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    // The filter was in its process group, and was killed with it.
    expect(existsSync(marker)).toBe(false);
    git(repo, 'config', '--unset', 'filter.slow.smudge');
    const path = join(realpathSync(root), 'web', task.taskId);
    expect(await quick.prepare(task)).toMatchObject({ ok: false, reason: expect.stringContaining(`${path} is there already, left by a git worktree add that did not finish`) });
    // The person does as the reason says.
    git(repo, 'worktree', 'unlock', path);
    git(repo, 'worktree', 'remove', '--force', path);
    expect(await made(quick, task)).toBe(path);
  });

  it('blocks a recorded worktree that is no longer on its branch', async () => {
    const d = directories();
    const task = claimed();
    const path = await made(d, task);
    git(path, 'checkout', '-q', '-b', 'elsewhere');
    expect(await d.prepare(task)).toEqual({
      ok: false,
      reason:
        `${path} is on branch elsewhere, not its branch mt/${task.taskId}: finish or abort what is in progress there ` +
        `(a rebase, a merge), or switch it back to mt/${task.taskId}; then unblock the task`,
    });
  });

  it('blocks a git workspace whose directory is gone, and records nothing, so it is a worktree once the repository is back', async () => {
    const away = join(dir, 'away');
    renameSync(repo, away);
    const task = claimed();
    expect(await directories().prepare(task)).toEqual({ ok: false, reason: `workspace web's directory ${repo} is not there` });
    expect(worktreeOf(t.db, `wt:${task.taskId}`)).toBeUndefined();
    renameSync(away, repo);
    const path = await made(directories(), task);
    expect(worktreeOf(t.db, `wt:${task.taskId}`)).toMatchObject({ kind: 'git-worktree', rootPath: path });
  });

  it('blocks a repository git refuses to read, rather than give its task an empty folder', async () => {
    git(repo, 'config', 'core.repositoryformatversion', '99');
    const task = claimed();
    expect(await directories().prepare(task)).toMatchObject({ ok: false, reason: expect.stringContaining("git cannot read workspace web's repository") });
    expect(existsSync(join(root, 'web', task.taskId))).toBe(false);
    // A .git file pointing nowhere is no repository git can read either.
    const broken = join(dir, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, '.git'), 'gitdir: /nowhere/at/all\n');
    const other = claimed('broken');
    expect(await directories({ broken }, { broken: {} }).prepare(other)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("git cannot read workspace broken's repository"),
    });
  });
});

describe('git that leaves something behind', () => {
  /** A git alias that runs `sh` as the command: what a filter or a merge driver could leave running. */
  const alias = (script: string) => ['-c', `alias.leave=!${script}`, 'leave'];
  const setsid = (seconds: number) => `perl -MPOSIX -e 'if (fork() == 0) { POSIX::setsid(); sleep ${seconds}; exit 0 }'`;

  it('answers when git exits, though a child it left in its group holds its output', async () => {
    const began = Date.now();
    const r = await runGit(alias('(sleep 5 >&2 &); exit 3'), { cwd: repo, env, timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 3 });
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('answers when git exits, though a child that left its group holds its output', async () => {
    const began = Date.now();
    const r = await runGit(alias(`${setsid(5)}; exit 4`), { cwd: repo, env, timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 4 });
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('answers past its time, though a child that left its group holds its output', async () => {
    const began = Date.now();
    const r = await runGit(alias(`${setsid(5)}; sleep 5`), { cwd: repo, env, timeoutMs: 300 });
    expect(r).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - began).toBeLessThan(1500);
  });

  it('records a worktree whose filter left a child holding its output', async () => {
    writeFileSync(join(repo, '.gitattributes'), '* filter=lingers\n');
    git(repo, 'add', '.gitattributes');
    git(repo, 'commit', '-q', '-m', 'attributes');
    git(repo, 'config', 'filter.lingers.smudge', '(sleep 5 >&2 &); cat');
    const task = claimed();
    const began = Date.now();
    const path = await made(directories(), task);
    expect(Date.now() - began).toBeLessThan(4000);
    expect(worktreeOf(t.db, `wt:${task.taskId}`)?.rootPath).toBe(path);
  });
});

describe('in one repository at once', () => {
  it('makes each claim its worktree in turn', async () => {
    const d = directories();
    const tasks = [claimed(), claimed(), claimed(), claimed()];
    const all = await Promise.all(tasks.map((task) => d.prepare(task)));
    expect(all.every((r) => r.ok)).toBe(true);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(5);
  });
});

describe('a workspace that is not a repository', () => {
  it('gives each task an empty folder of its own, even inside a repository above it', async () => {
    const notes = join(repo, 'notes');
    mkdirSync(notes);
    const task = claimed('notes');
    const path = await made(directories({ notes }, { notes: {} }), task);
    expect(path).toBe(join(realpathSync(root), 'notes', task.taskId));
    expect(statSync(path).isDirectory()).toBe(true);
    expect((statSync(path).mode & 0o777).toString(8)).toBe('700');
    expect(worktreeOf(t.db, `wt:${task.taskId}`)).toMatchObject({ kind: 'plain-dir', branch: null, repoRoot: notes });
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project e2e tests/kanban-worktree.e2e.ts`. Expected: `Test Files  1 failed (1)` and `Tests  no tests`: `src/kanban/worktree.ts` does not exist yet.

- [ ] **Step 5.3: Implement.**

In `src/db/kanban-read.ts`, replace:

```ts
        WHERE task_id IN (SELECT parent_id FROM kanban_links WHERE child_id = ?)
        ORDER BY created_at, rowid`,
    )
    .all(taskId)
```

with:

```ts
        WHERE task_id IN (SELECT parent_id FROM kanban_links WHERE child_id = ?)
        ORDER BY created_at, rowid`,
    )
    .all(taskId)
    .map(decodeTask);
}

/** The task's parents in the order they were linked: the order a fan-in merges their branches in (spec §18.5). */
export function parentsInLinkOrder(db: Db, taskId: string): TaskRow[] {
  return db
    .prepare<[string], TaskRaw>(
      `SELECT ${TASK_COLS} FROM kanban_tasks
         JOIN (SELECT parent_id, rowid AS link FROM kanban_links WHERE child_id = ?) ON parent_id = task_id
        ORDER BY link`,
    )
    .all(taskId)
```

Create `src/kanban/worktree.ts`:

```ts
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { IsolatedWorkspace } from '../config.js';
import { getTask, parentsInLinkOrder, runsOf } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { registerWorktree, worktreeOf, type TaskDirectory } from '../db/workspaces.js';
import { systemClock, type Clock } from '../time.js';
import type { TaskRow } from './types.js';

/**
 * A task's own directory, in an isolated workspace (spec §18): made before the
 * task's first run, reused by every later one, and never removed by the board.
 *
 * In a git workspace it is a worktree of the workspace's repository, on its own
 * branch, `mt/<task_id>`, under `$MT_HOME/worktrees/<workspace>/<task_id>`:
 * outside the repository, so the base checkout's `git status` never sees it.
 * It starts from its parents' work -- the workspace's base with none, a parent's
 * branch with one, and with several the merge of their branches, made here. It
 * is recorded as soon as `git worktree add` succeeds, so a merge that conflicts
 * leaves a directory a person can be pointed to; the merges go on at each later
 * prepare until the task's first session starts. Nothing is ever merged into the
 * base, pushed or rebased; no branch is deleted, no worktree removed and none
 * pruned. In any other workspace it is an empty folder of its own, and the
 * task's prompt lists its parents' folders.
 *
 * Every git command runs with no hook and no fsmonitor, in the environment an
 * agent gets, in a process group of its own that is killed whole when it runs
 * past its time; and the commands in one repository run one at a time, so two
 * claims never make worktrees in it at once. Git's own locks still guard against
 * everyone else, the agents included.
 */

/** A task's directory, made or found; or why it could not be, for a person to put right. */
export type Prepared = { ok: true; dir: TaskDirectory } | { ok: false; reason: string };

/** What the dispatcher asks before a run in a task's own directory. */
export interface Workdirs {
  /** Never rejects. */
  prepare(task: TaskRow): Promise<Prepared>;
}

/** One git command's end: its exit code, null when it did not exit by itself; what it wrote; and why it could not start. */
export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The error code when git could not start: `ENOENT`, no git. */
  error?: string;
  /** It ran past its time, and its process group was killed. */
  timedOut?: boolean;
}

export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number },
) => Promise<GitResult>;

export interface TaskDirectoriesDeps {
  db: Db;
  /** `$MT_HOME/worktrees`: in the home, which no workspace may contain (spec §2.3). */
  root: string;
  /** Each configured workspace's real directory, by name. */
  workspaceDirs: ReadonlyMap<string, string>;
  /** The isolated workspaces, each with its base, if it names one. */
  isolated: Readonly<Record<string, IsolatedWorkspace>>;
  /** What git is given: an agent's environment, never the gateway's own. */
  env: Readonly<Record<string, string>>;
  git?: GitRunner;
  /** How long one git command may take; default two minutes, as checking out a large repository is slow. */
  timeoutMs?: number;
  clock?: Clock;
}

const GIT_TIMEOUT_MS = 120_000;
/** At most this much of what git writes is kept, of each stream. */
const OUTPUT_BYTES = 1024 * 1024;
/** At most this many conflicting files are named. */
const FILES_NAMED = 10;
/**
 * How long, once git has exited or been killed, its output may stay open: a
 * process it started that left the group, or outlived the kill, can hold the
 * pipes for as long as it lives, and is not waited for (as `spawnGate` does).
 */
const OUTPUT_GRACE_MS = 500;

/**
 * The settings every command overrides: no hook (`worktree add` runs
 * `post-checkout`, a merge its own), no fsmonitor, no automatic gc or
 * maintenance, which detach processes of their own, and for the fan-in's merges
 * no signing, no signature checks, no remembered resolution and a fast-forward
 * where one will do, whatever the user's global configuration says.
 */
const OVERRIDES = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgSign=false',
  '-c', 'merge.ff=true',
  '-c', 'rerere.enabled=false',
  '-c', 'merge.verifySignatures=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
] as const;

/**
 * The real git, in a process group of its own, so a timeout kills what it
 * started too: a filter, a merge driver. Its answer is its exit, not the close of
 * its output: once git has exited, or been killed past its time, what is left
 * of its group is killed, and its output is let go after a short grace, so a
 * process that left the group (`setsid`) and holds git's stderr can hold up
 * neither the answer nor the repository's queue.
 */
export const runGit: GitRunner = (args, opts) =>
  new Promise((done) => {
    const child = spawn('git', [...OVERRIDES, ...args], {
      cwd: opts.cwd,
      env: { ...opts.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exitCode: number | null = null;
    let settled = false;
    let letGo: NodeJS.Timeout | undefined;
    const group = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    };
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(letGo);
      group();
      child.stdout.destroy();
      child.stderr.destroy();
      if (error !== undefined) done({ code: null, stdout, stderr, error });
      else done(timedOut ? { code: null, stdout, stderr, timedOut: true } : { code: exitCode, stdout, stderr });
    };
    const graceThenFinish = (): void => {
      letGo ??= setTimeout(() => finish(), OUTPUT_GRACE_MS);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-OUTPUT_BYTES);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      group();
      graceThenFinish();
    }, opts.timeoutMs);
    child.once('error', (err: NodeJS.ErrnoException) => finish(err.code ?? err.message));
    child.once('exit', (code) => {
      exitCode = code;
      // It ended in time: what follows is not its own running past the timeout.
      clearTimeout(timer);
      // What git left behind in its group, holding its output open.
      group();
      graceThenFinish();
    });
    child.once('close', () => finish());
  });

/** The branch of a task's worktree. */
export function taskBranch(taskId: string): string {
  return `mt/${taskId}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(reason: string): Prepared {
  return { ok: false, reason };
}

export class TaskDirectories implements Workdirs {
  readonly #deps: TaskDirectoriesDeps;
  readonly #git: GitRunner;
  readonly #timeoutMs: number;
  readonly #clock: Clock;
  /** The tail of each repository's queue, by its common directory. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(deps: TaskDirectoriesDeps) {
    this.#deps = deps;
    this.#git = deps.git ?? runGit;
    this.#timeoutMs = deps.timeoutMs ?? GIT_TIMEOUT_MS;
    this.#clock = deps.clock ?? systemClock;
  }

  async prepare(task: TaskRow): Promise<Prepared> {
    try {
      return await this.#prepare(task);
    } catch (err) {
      // A full disk, a permission: the task waits for a person, the dispatcher goes on.
      return fail(`its directory could not be made: ${message(err)}`);
    }
  }

  async #prepare(task: TaskRow): Promise<Prepared> {
    const { taskId, worktree, workspace } = task;
    if (worktree === null || workspace === null) return fail(`task ${taskId} has no directory of its own`);
    const made = worktreeOf(this.#deps.db, worktree);
    if (made !== undefined) {
      if (!isDirectory(made.rootPath)) return fail(gone(made));
      if (made.kind === 'plain-dir' || made.branch === null) return { ok: true, dir: made };
      return this.#serial(await this.#commonDir(made.repoRoot), () => this.#again(task, made));
    }
    const base = this.#deps.workspaceDirs.get(workspace);
    if (base === undefined) return fail(`workspace ${workspace} is not configured`);
    // A repository moved away is no folder: git would not even start there, and a folder recorded now would stay one.
    if (!isDirectory(base)) return fail(`workspace ${workspace}'s directory ${base} is not there`);
    const parent = this.#parentFor(workspace);
    if ('problem' in parent) return fail(parent.problem);
    const path = join(parent.dir, taskId);

    // Only the workspace's own directory counts as a repository, never one above it.
    const probe = await this.#run(base, ['rev-parse', '--git-common-dir'], { ceiling: dirname(base) });
    if (probe.code !== 0) {
      // Only git saying there is no repository here, with nothing here that looks like one, is a folder.
      const looks = existsSync(join(base, '.git')) || (existsSync(join(base, 'HEAD')) && existsSync(join(base, 'objects')));
      if (!looks && (probe.error === 'ENOENT' || (probe.code !== null && /not a git repository/i.test(probe.stderr)))) {
        return this.#folder(worktree, base, path);
      }
      if (probe.error === 'ENOENT') return fail(`workspace ${workspace} is a git repository, and git is not installed`);
      return fail(`git cannot read workspace ${workspace}'s repository: ${this.#said(probe)}`);
    }
    const common = realpathSync(resolve(base, probe.stdout.trim()));
    return this.#serial(common, () => this.#worktree(task, worktree, base, path));
  }

  /** `<root>/<workspace>`, made `0700` if it is not there, and refused unless a real directory. */
  #parentFor(workspace: string): { dir: string } | { problem: string } {
    const root = this.#deps.root;
    const dir = join(root, workspace);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const d of [root, dir]) {
      const stat = lstatSync(d);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return { problem: `${d} is ${stat.isSymbolicLink() ? 'a symlink' : 'not a directory'}; tasks' directories must be real directories under the gateway's home` };
      }
    }
    return { dir: realpathSync(dir) };
  }

  /** A workspace that is not a repository: an empty folder of the task's own. */
  #folder(id: string, base: string, path: string): Prepared {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (err) {
      // Made before, and not recorded: a stop between the two.
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
        throw err;
      }
    }
    return this.#record({ id, kind: 'plain-dir', rootPath: path, repoRoot: base, branch: null });
  }

  /** A new worktree on the task's branch, from its parents' work; under its repository's queue. */
  async #worktree(task: TaskRow, id: string, base: string, path: string): Promise<Prepared> {
    const branch = taskBranch(task.taskId);
    const starts = this.#upstream(task);
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
      // Not recorded, so not one this gateway finished: a git worktree add that was stopped, or someone else's.
      return fail(`${path} is there already, left by a git worktree add that did not finish, or put there by someone else. ${clearAway(base, path)}`);
    }
    const configured = task.workspace === null ? undefined : this.#deps.isolated[task.workspace]?.base;
    const first = starts[0];
    const from = first !== undefined ? `refs/heads/${first.branch}` : configured ?? 'HEAD';
    const start = await this.#run(base, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`]);
    if (start.code !== 0) {
      return fail(
        start.code === null
          ? this.#said(start)
          : first !== undefined
            ? `the branch ${first.branch} of its parent ${first.taskId} is not there`
            : configured !== undefined
              ? `the base ${configured} of workspace ${task.workspace ?? ''} is not a commit there`
              : `workspace ${task.workspace ?? ''} has no commit to start from`,
      );
    }
    const commit = start.stdout.trim();
    const tip = await this.#run(base, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    let added: GitResult;
    if (tip.code === 0) {
      // A branch of its name with no worktree: one a failed add left, at the very commit it would start from, is
      // taken up; any other may be a person's, and is never taken over.
      if (tip.stdout.trim() !== commit) {
        return fail(`a branch ${branch} is there already, with no worktree of it at ${path}; rename or remove the branch, then unblock the task`);
      }
      added = await this.#run(base, ['worktree', 'add', '--quiet', path, branch]);
    } else {
      added = await this.#run(base, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, path, commit]);
    }
    if (added.code !== 0) {
      const left = lstatSync(path, { throwIfNoEntry: false }) === undefined ? '' : `. It left ${path}. ${clearAway(base, path)}`;
      return fail(`git worktree add failed: ${this.#said(added)}${left}`);
    }
    const dir: TaskDirectory = { id, kind: 'git-worktree', rootPath: path, repoRoot: base, branch };
    const recorded = this.#record(dir);
    if (!recorded.ok) return recorded;
    return this.#merges(dir, starts);
  }

  /** A recorded worktree, again: still on its branch, and its parents' branches merged until its first session starts. */
  async #again(task: TaskRow, dir: TaskDirectory): Promise<Prepared> {
    const branch = dir.branch ?? taskBranch(task.taskId);
    const on = await this.#run(dir.rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (on.code !== 0 || on.stdout.trim() !== branch) {
      // Its branch is what its children start from, and what its reported commit names: work on another would be lost to both.
      const now = on.code === 0 ? `branch ${on.stdout.trim()}` : on.code === null ? this.#said(on) : 'no branch';
      return fail(
        `${dir.rootPath} is on ${now}, not its branch ${branch}: finish or abort what is in progress there (a rebase, a merge), ` +
          `or switch it back to ${branch}; then unblock the task`,
      );
    }
    const started = runsOf(this.#deps.db, task.taskId).some((r) => r.sessionId !== null);
    return started ? { ok: true, dir } : this.#merges(dir, this.#upstream(task));
  }

  /** Each parent's branch not yet in the worktree merged in, one at a time; a conflict left for a person. */
  async #merges(dir: TaskDirectory, starts: ReadonlyArray<{ taskId: string; branch: string }>): Promise<Prepared> {
    const path = dir.rootPath;
    const merging = await this.#run(path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    if (merging.code === 0) {
      return fail(`a merge in ${path} is not finished: resolve its conflicts and commit there, then unblock the task`);
    }
    for (const s of starts) {
      const ref = `refs/heads/${s.branch}`;
      const inside = await this.#run(path, ['merge-base', '--is-ancestor', ref, 'HEAD']);
      if (inside.code === 0) continue;
      if (inside.code !== 1) return fail(`the branch ${s.branch} of its parent ${s.taskId} cannot be read: ${this.#said(inside)}`);
      const merged = await this.#run(path, [
        'merge', '--quiet', '--no-stat', '--no-edit', '--ff', '--no-gpg-sign', '--no-verify-signatures',
        '-m', `Merge ${s.branch} into ${dir.branch ?? ''}`, ref,
      ]);
      if (merged.code === 0) continue;
      const conflicted = await this.#run(path, ['diff', '--name-only', '--diff-filter=U']);
      const files = conflicted.stdout.split('\n').filter((f) => f !== '');
      if (files.length === 0) return fail(`merging the branch ${s.branch} of its parent ${s.taskId} failed: ${this.#said(merged)}`);
      const more = files.length > FILES_NAMED ? ` and ${files.length - FILES_NAMED} more` : '';
      return fail(
        `merging the branch ${s.branch} of its parent ${s.taskId} conflicts in ${files.slice(0, FILES_NAMED).join(', ')}${more}. ` +
          `Resolve it in ${path}: fix those files and commit there, then unblock the task`,
      );
    }
    return { ok: true, dir };
  }

  /**
   * The branches a git task starts from: its parents that are done -- or, with
   * none, the task that created it, as §2.3 uses it in place of parents -- that
   * have a worktree in the same workspace, in the order they were linked. An
   * archived parent's work was abandoned, and is not merged.
   */
  #upstream(task: TaskRow): Array<{ taskId: string; branch: string }> {
    const db = this.#deps.db;
    const parents = parentsInLinkOrder(db, task.taskId);
    const from = parents.length === 0 && task.createdFromTask !== null ? getTask(db, task.createdFromTask) : undefined;
    const upstream = parents.length > 0 ? parents : from === undefined ? [] : [from];
    return upstream.flatMap((p) => {
      if (p.phase !== 'done' || p.worktree === null || p.workspace !== task.workspace) return [];
      const dir = worktreeOf(db, p.worktree);
      return dir?.kind === 'git-worktree' && dir.branch !== null ? [{ taskId: p.taskId, branch: dir.branch }] : [];
    });
  }

  #record(dir: TaskDirectory): Prepared {
    const r = registerWorktree(this.#deps.db, dir, this.#clock.now());
    return 'error' in r ? fail(r.error) : { ok: true, dir };
  }

  /** A repository's common directory: what its worktrees share, and its queue's key. */
  async #commonDir(repo: string): Promise<string> {
    const r = await this.#run(repo, ['rev-parse', '--git-common-dir']);
    return r.code === 0 ? realpathSync(resolve(repo, r.stdout.trim())) : repo;
  }

  /** `fn` after every earlier one in the same repository has finished. */
  async #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(key) ?? Promise.resolve();
    const mine = before.then(fn, fn);
    const tail = mine.catch(() => undefined);
    this.#queues.set(key, tail);
    try {
      return await mine;
    } finally {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
  }

  #run(cwd: string, args: readonly string[], opts: { ceiling?: string } = {}): Promise<GitResult> {
    return this.#git(args, {
      cwd,
      env: opts.ceiling === undefined ? this.#deps.env : { ...this.#deps.env, GIT_CEILING_DIRECTORIES: opts.ceiling },
      timeoutMs: this.#timeoutMs,
    });
  }

  /** The last lines git wrote, or that it did not finish in time, for a reason a person reads. */
  #said(r: GitResult): string {
    if (r.timedOut === true) return `git did not finish in ${Math.round(this.#timeoutMs / 1000)} s, and was stopped`;
    const text = `${r.stderr}\n${r.stdout}`.trim();
    return text === '' ? 'git said nothing' : text.split('\n').slice(-3).join(' ').trim();
  }
}

/** What a person runs to clear a half-made or unrecorded worktree out of a task's way. */
function clearAway(base: string, path: string): string {
  return (
    `If it holds nothing you need, in ${base} run git worktree unlock ${path} if git worktree list shows it locked, ` +
    `then git worktree remove --force ${path}, or move it aside; then unblock the task`
  );
}

function gone(dir: TaskDirectory): string {
  return dir.kind === 'git-worktree' && dir.branch !== null
    ? `its directory ${dir.rootPath} is gone; make it again from its branch with git worktree add ${dir.rootPath} ${dir.branch}, in ${dir.repoRoot}, then unblock the task`
    : `its directory ${dir.rootPath} is gone; make the folder again, then unblock the task`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
```

- [ ] **Step 5.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1706 passed (1706)`. Run `npx vitest run --project e2e`. Expected: `Tests  125 passed (125)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add src/kanban/worktree.ts tests/kanban-worktree.e2e.ts src/db/kanban-read.ts
git commit -m "Make a task's own directory with git: a worktree on mt/<task_id> outside the repository, recorded once added, from the base, a parent's branch or a merge of its done parents' in link order, a conflict left for a person and taken up once resolved, or a folder for a workspace that is no repository; with no hook and no prune, in a process group killed past its time, queued per repository, refusing whatever is in the way"
```

---

### Task 6: A session finds its task's directory

**Files:**

- Modify: `src/core/workspace.ts`, `tests/workspace.test.ts`

A run's session records its place, `wt:<task_id>` (Decision 6). `NamedWorkspaces` resolves that id to the directory recorded when it was made, on every actor build, and still refuses an id it does not know.

- [ ] **Step 6.1: Write the tests.**

In `tests/workspace.test.ts`, replace:

```ts
  it('refuses a name that is no longer configured, rather than using another', async () => {
```

with:

```ts
  it("gives a kanban run's session its task's own directory, as recorded when made", async () => {
    const own = new NamedWorkspaces(new Map([['default', '/srv/a']]), (id) =>
      id === 'wt:k_1' ? { kind: 'git-worktree', rootPath: '/home/mt/worktrees/web/k_1' } : undefined,
    );
    expect(own.has('wt:k_1')).toBe(true);
    expect(own.has('wt:k_2')).toBe(false);
    expect(await own.acquire('s_1', 'wt:k_1')).toEqual({ id: 'wt:k_1', kind: 'git-worktree', cwd: '/home/mt/worktrees/web/k_1' });
    expect(await own.acquire('s_1', 'default')).toEqual({ id: 'default', kind: 'plain-dir', cwd: '/srv/a' });
    await expect(own.acquire('s_1', 'wt:k_2')).rejects.toThrow(/workspace wt:k_2 is not configured/);
  });

  it('refuses a name that is no longer configured, rather than using another', async () => {
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/workspace.test.ts`. Expected: `Tests  1 failed | 2 passed (3)`.

- [ ] **Step 6.3: Implement.**

In `src/core/workspace.ts`, replace:

```ts
 * Each session works in the named workspace it records, and a workspace is one
 * configured directory.
```

with:

```ts
 * A task's own directory (spec §18), by its `wt:` id, as it was recorded when it
 * was made; undefined for one not made.
 */
export type TaskDirLookup = (id: string) => { kind: Workspace['kind']; rootPath: string } | undefined;

/**
 * Each session works in the named workspace it records, and a workspace is one
 * configured directory -- or, for a kanban run's session, its task's own
 * directory (spec §18), looked up by the `wt:` id the session records.
```

In `src/core/workspace.ts`, replace:

```ts

  /**
   * @param paths Workspace name → real path, as `loadTeam` resolved and checked
   *   them at startup. Resolved once, there: a symlink swapped in later cannot
   *   redirect an agent with write access to a different tree.
   */
  constructor(paths: ReadonlyMap<string, string>) {
    this.#paths = paths;
  }

  has(workspaceId: string): boolean {
    return this.#paths.has(workspaceId);
  }

  async acquire(_sessionId: string, workspaceId: string): Promise<Workspace> {
    const cwd = this.#paths.get(workspaceId);
    if (cwd === undefined) throw new Error(`workspace ${workspaceId} is not configured`);
    return { id: workspaceId, kind: this.kind, cwd };
```

with:

```ts
  readonly #taskDirs: TaskDirLookup | undefined;

  /**
   * @param paths Workspace name → real path, as `loadTeam` resolved and checked
   *   them at startup. Resolved once, there: a symlink swapped in later cannot
   *   redirect an agent with write access to a different tree.
   * @param taskDirs Tasks' own directories, as recorded when they were made, and
   *   never moved after; absent, none.
   */
  constructor(paths: ReadonlyMap<string, string>, taskDirs?: TaskDirLookup) {
    this.#paths = paths;
    this.#taskDirs = taskDirs;
  }

  has(workspaceId: string): boolean {
    return this.#paths.has(workspaceId) || this.#taskDirs?.(workspaceId) !== undefined;
  }

  async acquire(_sessionId: string, workspaceId: string): Promise<Workspace> {
    const cwd = this.#paths.get(workspaceId);
    if (cwd !== undefined) return { id: workspaceId, kind: this.kind, cwd };
    const own = this.#taskDirs?.(workspaceId);
    if (own === undefined) throw new Error(`workspace ${workspaceId} is not configured`);
    return { id: workspaceId, kind: own.kind, cwd: own.rootPath };
```

- [ ] **Step 6.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1707 passed (1707)`. Run `npx vitest run --project e2e`. Expected: `Tests  125 passed (125)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.5: Commit.**

```bash
git add src/core/workspace.ts tests/workspace.test.ts
git commit -m "Give a kanban run's session its task's own directory, as recorded when it was made, on every actor build"
```

---

### Task 7: The dispatcher and the prompt

**Files:**

- Create: `tests/kanban-dispatch-worktree.test.ts`
- Modify: `src/kanban/brief.ts`, `src/kanban/dispatcher.ts`, `src/kanban/prompt.ts`, `tests/helpers/dispatch.ts`, `tests/kanban-prompt.test.ts`

Before a run in a task's own directory, the dispatcher has it made; one that cannot be made ends the run and blocks the task, uncounted, and the pass goes on (Decisions 12 and 13). The prompt says where the directory is, and where the upstream tasks' are, an archived parent's marked as abandoned; a task in a shared directory is still told where its parents' own directories are (Decision 17). The harness takes `isolated` and `workdirs`, and resolves `wt:` ids from its database. In a folder, the prompt says nothing of commits, branches or git, to the worker or the reviewer (Decision 23).

- [ ] **Step 7.1: Write the tests.**

In `tests/helpers/dispatch.ts`, replace:

```ts
import { Dispatcher, type DispatcherSettings, type WorkerAccess } from '../../src/kanban/dispatcher.js';
import { KanbanService, type CreateRequest, type People, type ReportChecks } from '../../src/kanban/service.js';
import { KanbanSink } from '../../src/kanban/sink.js';
import type { RunRow, TaskRow } from '../../src/kanban/types.js';
```

with:

```ts
import { worktreeOf } from '../../src/db/workspaces.js';
import { Dispatcher, type DispatcherSettings, type WorkerAccess } from '../../src/kanban/dispatcher.js';
import { KanbanService, type CreateRequest, type People, type ReportChecks } from '../../src/kanban/service.js';
import { KanbanSink } from '../../src/kanban/sink.js';
import type { RunRow, TaskRow } from '../../src/kanban/types.js';
import type { Workdirs } from '../../src/kanban/worktree.js';
```

In `tests/helpers/dispatch.ts`, replace:

```ts
  people?: People;
}
```

with:

```ts
  people?: People;
  /** The isolated workspaces (spec §18); absent, none. */
  isolated?: ReadonlySet<string>;
  /** What makes a task's own directory; absent, nothing does. */
  workdirs?: Workdirs;
}
```

In `tests/helpers/dispatch.ts`, replace:

```ts
    ...(opts.settings?.maxRunningPerRole === undefined ? {} : { maxRunningPerRole: opts.settings.maxRunningPerRole }),
  });
```

with:

```ts
    ...(opts.settings?.maxRunningPerRole === undefined ? {} : { maxRunningPerRole: opts.settings.maxRunningPerRole }),
    ...(opts.isolated === undefined ? {} : { isolated: opts.isolated }),
  });
```

In `tests/helpers/dispatch.ts`, replace:

```ts
    workspaces: new NamedWorkspaces(workspaces),
```

with:

```ts
    workspaces: new NamedWorkspaces(workspaces, (id) => worktreeOf(t.db, id)),
```

In `tests/helpers/dispatch.ts`, replace:

```ts
    ...(opts.worker === undefined ? {} : { worker: opts.worker }),
  });
```

with:

```ts
    ...(opts.worker === undefined ? {} : { worker: opts.worker }),
    ...(opts.workdirs === undefined ? {} : { workdirs: opts.workdirs }),
  });
```

Create `tests/kanban-dispatch-worktree.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { getSession } from '../src/db/sessions.js';
import { registerWorktree, worktreeOf } from '../src/db/workspaces.js';
import type { TaskRow } from '../src/kanban/types.js';
import type { Prepared, Workdirs } from '../src/kanban/worktree.js';
import { NOW } from './helpers/kanban.js';
import { completes, dispatchHarness, holds, until, type DispatchHarness } from './helpers/dispatch.js';

/**
 * The dispatcher and a task's own directory (spec §18): made before the task's
 * first run, so the tasks of one isolated workspace run side by side, each in
 * its own; found again by a retry; and one that cannot be made blocking its task
 * for a person, uncounted, while the pass goes on.
 */

const open: DispatchHarness[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

/** A stand-in for the real directories: records each ask, and makes `/own/<task>` unless told to refuse. */
class FakeWorkdirs implements Workdirs {
  readonly asked: string[] = [];
  readonly refuse = new Map<string, string>();
  h!: DispatchHarness;

  async prepare(task: TaskRow): Promise<Prepared> {
    this.asked.push(task.taskId);
    const reason = this.refuse.get(task.taskId);
    if (reason !== undefined) return { ok: false, reason };
    const id = task.worktree ?? '';
    const dir = { id, kind: 'git-worktree' as const, rootPath: `/own/${task.taskId}`, repoRoot: '/tmp/ws-web', branch: `mt/${task.taskId}` };
    registerWorktree(this.h.t.db, dir, NOW);
    return { ok: true, dir: worktreeOf(this.h.t.db, id) ?? dir };
  }
}

function harness(): { h: DispatchHarness; dirs: FakeWorkdirs } {
  const dirs = new FakeWorkdirs();
  const h = dispatchHarness({ isolated: new Set(['web']), workdirs: dirs, settings: { maxRunning: 4 } });
  dirs.h = h;
  open.push(h);
  return { h, dirs };
}

describe('Dispatcher: tasks in an isolated workspace', () => {
  it('runs two at once, each in a directory of its own', async () => {
    const { h, dirs } = harness();
    const a = h.create({ title: 'a', workspace: 'web' });
    const b = h.create({ title: 'b', workspace: 'web' });
    const implementer = h.driver('implementer');
    const first = holds(implementer);
    const second = holds(implementer);
    h.dispatcher.pass();
    await until(() => first.started && second.started, 'both runs to start');
    expect(dirs.asked.sort()).toEqual([a.taskId, b.taskId].sort());
    expect(implementer.starts.map((s) => s.cwd).sort()).toEqual([`/own/${a.taskId}`, `/own/${b.taskId}`].sort());
    const [run] = runsOf(h.t.db, a.taskId);
    expect(getSession(h.t.db, run?.sessionId ?? '')).toMatchObject({ workspaceId: `wt:${a.taskId}` });
    // Its prompt says where it is, and that its branch is where the work goes.
    const prompt = implementer.runtimes.map((r) => r.prompts[0]?.text ?? '').find((p) => p.includes(`${a.taskId}: a`)) ?? '';
    expect(prompt).toContain(`Your directory, the current one, is /own/${a.taskId}: a git worktree of this task's own, on its branch mt/${a.taskId}.`);
    first.end();
    second.end();
    await h.dispatcher.idle();
  });

  it('runs a retry in the same directory', async () => {
    const { h, dirs } = harness();
    const task = h.create({ title: 'a', workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => ctl.end('failed'));
    completes(h, implementer);
    h.dispatcher.pass();
    await until(() => getTask(h.t.db, task.taskId)?.phase === 'done', 'the retry to complete');
    await h.dispatcher.idle();
    expect(dirs.asked).toEqual([task.taskId, task.taskId]);
    expect(implementer.starts.map((s) => s.cwd)).toEqual([`/own/${task.taskId}`, `/own/${task.taskId}`]);
  });

  it('blocks a task whose directory cannot be made, for a person, uncounted, and goes on to the next', async () => {
    const { h, dirs } = harness();
    const stuck = h.create({ title: 'stuck', workspace: 'web', priority: 1 });
    const next = h.create({ title: 'next', workspace: 'web' });
    dirs.refuse.set(stuck.taskId, 'merging conflicts in README');
    const implementer = h.driver('implementer');
    completes(h, implementer);
    h.dispatcher.pass();
    await until(() => getTask(h.t.db, next.taskId)?.phase === 'done', 'the next task to complete');
    await h.dispatcher.idle();
    expect(getTask(h.t.db, stuck.taskId)).toMatchObject({
      phase: 'blocked',
      blockKind: 'needs_input',
      blockReason: 'merging conflicts in README',
      consecutiveFailures: 0,
    });
    const [run] = runsOf(h.t.db, stuck.taskId);
    expect(run).toMatchObject({ outcome: 'failed', error: 'the run could not start: merging conflicts in README', sessionId: null });
    expect(run?.endedAt).not.toBeNull();
    // No agent started for it.
    expect(implementer.starts.map((s) => s.cwd)).toEqual([`/own/${next.taskId}`]);
  });

  it("tells a task in a shared directory where its parents' own directories are", async () => {
    const { h } = harness();
    const parent = h.create({ title: 'a', workspace: 'web' });
    const child = h.create({ title: 'b', workspace: 'api', parents: [parent.taskId] });
    const implementer = h.driver('implementer');
    completes(h, implementer);
    completes(h, implementer);
    h.dispatcher.pass();
    await until(() => getTask(h.t.db, child.taskId)?.phase === 'done', 'the child to complete');
    await h.dispatcher.idle();
    const prompt = implementer.runtimes[1]?.prompts[0]?.text ?? '';
    expect(prompt).not.toContain('Your directory');
    expect(prompt).toContain(`- ${parent.taskId}: /own/${parent.taskId} (branch mt/${parent.taskId})`);
    expect(implementer.starts[1]?.cwd).toBe('/tmp/ws-api');
  });

  it('keeps a task in a workspace that is not isolated in the shared directory, asking for nothing', async () => {
    const { h, dirs } = harness();
    const task = h.create({ title: 'a', workspace: 'api' });
    const implementer = h.driver('implementer');
    completes(h, implementer);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'done', worktree: null });
    expect(dirs.asked).toEqual([]);
    expect(implementer.starts[0]?.cwd).toBe('/tmp/ws-api');
  });
});
```

In `tests/kanban-prompt.test.ts`, replace:

```ts
    );
  });
});
```

with:

```ts
    );
  });
});

describe('composePrompt: a task with a directory of its own', () => {
  it("says where it is, that its branch is where a work run's work goes, and where the tasks it follows left theirs", () => {
    const workdir = {
      path: '/home/mt/worktrees/web/k_task',
      branch: 'mt/k_task',
      upstream: [
        { taskId: 'k_parent', path: '/home/mt/worktrees/web/k_parent', branch: 'mt/k_parent', abandoned: false },
        { taskId: 'k_dropped', path: '/home/mt/worktrees/web/k_dropped', branch: 'mt/k_dropped', abandoned: true },
      ],
    };
    const work = composePrompt(brief({ workdir }));
    expect(work).toContain(
      [
        'Your directory, the current one, is /home/mt/worktrees/web/k_task: a git worktree of this task\'s own, on its branch mt/k_task. ' +
          'Commit your work on that branch before you report: the tasks that follow this one start from it, and nothing is merged for you.',
        'The tasks this one follows left their work in their own directories, which you may read but not change:',
        '- k_parent: /home/mt/worktrees/web/k_parent (branch mt/k_parent)',
        '- k_dropped: /home/mt/worktrees/web/k_dropped (branch mt/k_dropped), archived: its work was abandoned, and is not merged into this task',
      ].join('\n'),
    );
    expect(at(work, 'Your directory')).toBeGreaterThan(at(work, '# The task'));
    expect(at(work, 'Your directory')).toBeLessThan(at(work, '# Context'));
    // A reviewer is not told to commit: it does not change the work under review.
    expect(composePrompt(brief({ kind: 'review', workdir }))).toContain(
      "Your directory, the current one, is /home/mt/worktrees/web/k_task: the task's own git worktree, on its branch mt/k_task, where the work under review is.",
    );
    // A folder, and its parents' folders, in a workspace that is no repository.
    const folder = composePrompt(
      brief({ workdir: { path: '/w/notes/k_task', branch: null, upstream: [{ taskId: 'k_a', path: '/w/notes/k_a', branch: null, abandoned: false }] } }),
    );
    expect(folder).toContain("Your directory, the current one, is /w/notes/k_task: a folder of this task's own. Put the task's results there.");
    expect(folder).toContain('- k_a: /w/notes/k_a\n');
    // A task need not be code: in a folder, nothing is said of commits, branches or git, to the worker or the reviewer.
    const reviewFolder = composePrompt(
      brief({
        kind: 'review',
        workdir: {
          path: '/w/notes/k_task',
          branch: null,
          upstream: [
            { taskId: 'k_a', path: '/w/notes/k_a', branch: null, abandoned: false },
            { taskId: 'k_b', path: '/w/notes/k_b', branch: null, abandoned: true },
          ],
        },
      }),
    );
    expect(reviewFolder).toContain("Your directory, the current one, is /w/notes/k_task: a folder of this task's own, where the work under review is.");
    expect(reviewFolder).toContain('- k_b: /w/notes/k_b, archived: its work was abandoned\n');
    for (const text of [folder, reviewFolder]) {
      const lines = text.slice(text.indexOf('Your directory'), text.indexOf('# Context')).toLowerCase();
      for (const word of ['commit', 'branch', 'git']) expect(lines).not.toContain(word);
    }
    // Nothing in a shared directory, but where the tasks it follows left their work, when they have directories of their own.
    expect(composePrompt(brief())).not.toContain('Your directory');
    const shared = composePrompt(
      brief({ workdir: { path: null, branch: null, upstream: [{ taskId: 'k_a', path: '/w/web/k_a', branch: 'mt/k_a', abandoned: false }] } }),
    );
    expect(shared).not.toContain('Your directory');
    expect(shared).toContain(
      'The tasks this one follows left their work in their own directories, which you may read but not change:\n- k_a: /w/web/k_a (branch mt/k_a)',
    );
  });
});
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-dispatch-worktree.test.ts tests/kanban-prompt.test.ts`. Expected: `Test Files  2 failed (2)` and `Tests  5 failed | 28 passed (33)`.

- [ ] **Step 7.3: Implement.**

In `src/kanban/brief.ts`, replace:

```ts
import {
  changesAsked,
  childrenOf,
  commentsOf,
  gatesOf,
  lastGateRun,
  latestCompletion,
  latestReviewRequest,
  parentsOf,
  runsOf,
} from '../db/kanban-read.js';
import type { Attempt, ParentHandoff, RunBrief } from './prompt.js';
```

with:

```ts
import { worktreeOf } from '../db/workspaces.js';
import {
  changesAsked,
  childrenOf,
  commentsOf,
  gatesOf,
  getTask,
  parentsInLinkOrder,
  lastGateRun,
  latestCompletion,
  latestReviewRequest,
  parentsOf,
  runsOf,
} from '../db/kanban-read.js';
import type { Attempt, OwnDirectory, ParentHandoff, RunBrief } from './prompt.js';
```

In `src/kanban/brief.ts`, replace:

```ts
  return {
```

with:

```ts
  const workdir = ownDirectory(db, c.task);
  return {
```

In `src/kanban/brief.ts`, replace:

```ts
  };
}
```

with:

```ts
    ...(workdir === undefined ? {} : { workdir }),
  };
}

/**
 * The task's own directory (spec §18), if it has one, and those of the tasks it
 * follows -- its parents in link order, or with none the task that created it --
 * that have one, an archived one marked as abandoned; undefined when there is
 * neither. A task in a shared directory is still told where its parents' are.
 */
function ownDirectory(db: Db, task: Claimed['task']): OwnDirectory | undefined {
  const own = task.worktree === null ? undefined : worktreeOf(db, task.worktree);
  const parents = parentsInLinkOrder(db, task.taskId);
  const from = parents.length === 0 && task.createdFromTask !== null ? getTask(db, task.createdFromTask) : undefined;
  const upstream = (parents.length > 0 ? parents : from === undefined ? [] : [from]).flatMap((p) => {
    const dir = p.worktree === null ? undefined : worktreeOf(db, p.worktree);
    return dir === undefined ? [] : [{ taskId: p.taskId, path: dir.rootPath, branch: dir.branch, abandoned: p.phase === 'archived' }];
  });
  if (own === undefined && upstream.length === 0) return undefined;
  return { path: own?.rootPath ?? null, branch: own?.branch ?? null, upstream };
}
```

In `src/kanban/dispatcher.ts`, replace:

```ts
import { nativeFor, renderNative, sweepRole, sweepRoles, type Rendered } from '../render/native.js';
```

with:

```ts
import { isWorktreeId } from '../db/workspaces.js';
import { nativeFor, renderNative, sweepRole, sweepRoles, type Rendered } from '../render/native.js';
```

In `src/kanban/dispatcher.ts`, replace:

```ts
import { limitsReached } from './waiting.js';

```

with:

```ts
import { limitsReached } from './waiting.js';
import type { Prepared, Workdirs } from './worktree.js';

```

In `src/kanban/dispatcher.ts`, replace:

```ts
  nameOf?: (principal: string) => string | undefined;
}
```

with:

```ts
  nameOf?: (principal: string) => string | undefined;
  /**
   * Makes a task's own directory, in an isolated workspace (spec §18), before
   * its first run. Absent, a run that needs one blocks its task.
   */
  workdirs?: Workdirs;
}
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    // Before the session, and synchronously up to the run's entry in #open, so
```

with:

```ts
    // In its task's own directory, if it has one: made before the task's first run (spec §18).
    if (run.workspace !== null && isWorktreeId(run.workspace)) {
      if (!(await this.#prepare(claimed, handle))) return;
      // Stopped while it was made: the next boot ends the run.
      if (this.#stopped) return;
    }
    // Before the session, and synchronously up to the run's entry in #open, so
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    await this.#turnEnded(sessionId, terminal, thrown);
  }
```

with:

```ts
    await this.#turnEnded(sessionId, terminal, thrown);
  }

  /**
   * The task's own directory (spec §18), made before its first run and found
   * again by every later one. One that cannot be made -- a merge that conflicts,
   * a branch of its name already there, a full disk -- blocks the task for a
   * person, with the reason. The run started nothing, so it is not counted, and
   * the pass goes on: the next claim may well be in another repository.
   */
  async #prepare(claimed: Claimed, handle: RunHandle): Promise<boolean> {
    const { run } = claimed;
    const workdirs = this.#deps.workdirs;
    let prepared: Prepared;
    try {
      prepared =
        workdirs === undefined
          ? { ok: false, reason: 'this gateway makes no directories for tasks' }
          : await workdirs.prepare(claimed.task);
    } catch (err) {
      prepared = { ok: false, reason: `its directory could not be made: ${message(err)}` };
    }
    if (prepared.ok || this.#stopped) return prepared.ok;
    this.#end(run.runId, {
      outcome: 'failed',
      error: `the run could not start: ${prepared.reason}`,
      hadSideEffects: false,
      block: prepared.reason,
    });
    this.#note(`kanban: run ${run.runId} could not start: its task's directory could not be made`);
    await this.#close(handle);
    return false;
  }
```

In `src/kanban/prompt.ts`, replace:

```ts
/** Everything a run's prompt is composed from. */
```

with:

```ts
/** A run in its task's own directory (spec §18): where it is, and where the tasks it follows left their work. */
export interface OwnDirectory {
  /** Null for a task in its workspace's shared directory, which is told only where the tasks it follows are. */
  path: string | null;
  /** The worktree's branch; null for a folder. */
  branch: string | null;
  /** `abandoned`: an archived parent, whose work is not merged into the task's. */
  upstream: ReadonlyArray<{ taskId: string; path: string; branch: string | null; abandoned: boolean }>;
}

/** Everything a run's prompt is composed from. */
```

In `src/kanban/prompt.ts`, replace:

```ts
  reviewerName?: string;
}
```

with:

```ts
  reviewerName?: string;
  /** The task's own directory (spec §18); undefined in a workspace's shared one. */
  workdir?: OwnDirectory;
}
```

In `src/kanban/prompt.ts`, replace:

```ts
  return [...lines, ...reviewerLines(b), ...gateLines(b)];
```

with:

```ts
  return [...lines, ...directoryLines(b), ...reviewerLines(b), ...gateLines(b)];
}

/** At most this many of the directories of the tasks a run follows are listed. */
const UPSTREAM_LISTED = 20;

/**
 * A run in its task's own directory (spec §18): where it is; for a worktree's
 * work, that its branch is where the work goes, since the board merges nothing;
 * and where the tasks it follows left their work, to read.
 */
function directoryLines(b: RunBrief): string[] {
  const w = b.workdir;
  if (w === undefined) return [];
  if (w.path === null && w.upstream.length === 0) return [];
  const where = `Your directory, the current one, is ${flat(w.path ?? '')}`;
  const lines = [''];
  if (w.path !== null) {
    lines.push(
      w.branch === null
        ? b.kind === 'review'
          ? `${where}: a folder of this task's own, where the work under review is.`
          : `${where}: a folder of this task's own. Put the task's results there.`
        : b.kind === 'review'
          ? `${where}: the task's own git worktree, on its branch ${flat(w.branch)}, where the work under review is.`
          : `${where}: a git worktree of this task's own, on its branch ${flat(w.branch)}. Commit your work on that branch ` +
            'before you report: the tasks that follow this one start from it, and nothing is merged for you.',
    );
  }
  if (w.upstream.length > 0) {
    lines.push('The tasks this one follows left their work in their own directories, which you may read but not change:');
    for (const u of w.upstream.slice(0, UPSTREAM_LISTED)) {
      const branch = u.branch === null ? '' : ` (branch ${flat(u.branch)})`;
      const abandoned = !u.abandoned
        ? ''
        : u.branch === null
          ? ', archived: its work was abandoned'
          : ', archived: its work was abandoned, and is not merged into this task';
      lines.push(`- ${u.taskId}: ${flat(u.path)}${branch}${abandoned}`);
    }
    if (w.upstream.length > UPSTREAM_LISTED) lines.push(`- and ${w.upstream.length - UPSTREAM_LISTED} more`);
  }
  return lines;
```

- [ ] **Step 7.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1713 passed (1713)`. Run `npx vitest run --project e2e`. Expected: `Tests  125 passed (125)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.5: Commit.**

```bash
git add tests/kanban-dispatch-worktree.test.ts src/kanban/brief.ts src/kanban/dispatcher.ts src/kanban/prompt.ts tests/helpers/dispatch.ts tests/kanban-prompt.test.ts
git commit -m "Make a task's own directory before its run, block the task when it cannot be made, and tell the agent in its prompt where its directory is, that its branch is where the work goes, and where its upstream tasks left theirs"
```

---

### Task 8: The gateway, and a DAG end to end

**Files:**

- Create: `tests/kanban-worktree-dispatch.e2e.ts`
- Modify: `src/index.ts`, `tests/gateway-startup.test.ts`, `tests/helpers/dispatch.ts`

The gateway wires it all: `TaskDirectories` under `$MT_HOME/worktrees` with an agent's environment, the isolated set, and the session lookup; and says at startup which workspaces are isolated. The end-to-end test runs a DAG against real git through the harness: two parallel tasks of one role at once, and their child from the merge of their branches, its gate and its commit in its own worktree. The harness takes a workspace's real directory (`dirs`).

- [ ] **Step 8.1: Write the tests.**

In `tests/gateway-startup.test.ts`, replace:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 7 (${config.dbPath})\n`))).toBe(true);
    } finally {
```

with:

```ts
      expect(lines.some((l) => l.endsWith(` schema at version 7 (${config.dbPath})\n`))).toBe(true);
    } finally {
      await gateway.stop();
    }
  });

  it('says, with the board on, which workspaces give each task a directory of its own', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const gateway = await createGateway({ ...config, isolated: { default: {} }, kanban: { ...config.kanban, enabled: true } }, team);
    try {
      expect(lines.some((l) => l.endsWith(' kanban: each task in default gets a directory of its own\n'))).toBe(true);
    } finally {
```

In `tests/helpers/dispatch.ts`, replace:

```ts
  workdirs?: Workdirs;
}
```

with:

```ts
  workdirs?: Workdirs;
  /** A workspace's directory in place of its stand-in, `/tmp/ws-<name>`, by name. */
  dirs?: Readonly<Record<string, string>>;
}
```

In `tests/helpers/dispatch.ts`, replace:

```ts
  const workspaces = new Map(['default', 'web', 'api', 'docs'].map((name) => [name, `/tmp/ws-${name}`]));
```

with:

```ts
  const workspaces = new Map(['default', 'web', 'api', 'docs'].map((name) => [name, opts.dirs?.[name] ?? `/tmp/ws-${name}`]));
```

Create `tests/kanban-worktree-dispatch.e2e.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun, getTask, runsOf } from '../src/db/kanban-read.js';
import { worktreeOf } from '../src/db/workspaces.js';
import { TaskDirectories } from '../src/kanban/worktree.js';
import type { FakeDriver } from './helpers/driver.js';
import { completes, dispatchHarness, reportComplete, type DispatchHarness } from './helpers/dispatch.js';
import { testDb } from './helpers/db.js';
import { ALICE } from './helpers/kanban.js';

/**
 * A DAG in an isolated git workspace, end to end (spec §18): two parallel tasks
 * of one role run at once, each committing in its own worktree; their child
 * starts from the merge of their branches, its gates run there and its commit is
 * read there; and the base branch is never touched.
 */

let dir: string;
let repo: string;
let env: Record<string, string>;
let h: DispatchHarness;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** The directory a turn's run works in, read from the board as the agent would find its cwd. */
function runDir(runId: string): string {
  const run = getRun(h.t.db, runId);
  const task = run === undefined ? undefined : getTask(h.t.db, run.taskId);
  const cwd = task?.worktree === null || task === undefined ? undefined : worktreeOf(h.t.db, task.worktree)?.rootPath;
  if (cwd === undefined) throw new Error(`run ${runId} has no directory of its own`);
  return cwd;
}

/**
 * The next `n` turns on this driver each wait until all `n` have started, then
 * write and commit a file named after their task in their own directory, and
 * report complete. Resolves `started` once all are running at once.
 */
function together(driver: FakeDriver, n: number): { started: Promise<void> } {
  let count = 0;
  let all!: () => void;
  const started = new Promise<void>((resolve) => (all = resolve));
  for (let i = 0; i < n; i += 1) {
    driver.scripts.push(async (ctl) => {
      count += 1;
      if (count === n) all();
      await started;
      const runId = ctl.env?.['MT_KANBAN_RUN'] ?? '';
      const cwd = runDir(runId);
      const file = `${getRun(h.t.db, runId)?.taskId ?? ''}.txt`;
      writeFileSync(join(cwd, file), 'work\n');
      git(cwd, 'add', file);
      git(cwd, 'commit', '-q', '-m', `add ${file}`);
      await reportComplete(h, runId);
      ctl.end('completed');
    });
  }
  return { started };
}

/** Real git takes real time: wait for `done` in wall-clock time, or give up. */
async function eventually(done: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 30_000;
  while (!done()) {
    if (Date.now() > until) throw new Error(`gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-wt-dispatch-')));
  env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
  repo = join(dir, 'web');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@example.com');
  writeFileSync(join(repo, 'README'), 'hello\n');
  git(repo, 'add', 'README');
  git(repo, 'commit', '-q', '-m', 'first');
  mkdirSync(join(dir, 'home'));
  const t = testDb();
  const dirs = new Map([['web', repo]]);
  h = dispatchHarness({
    t,
    isolated: new Set(['web']),
    dirs: { web: repo },
    settings: { maxRunning: 4 },
    // The gates and the commit, for real, in the run's own directory.
    checks: { workspaceDirs: dirs, env },
    workdirs: new TaskDirectories({ db: t.db, root: join(dir, 'home', 'worktrees'), workspaceDirs: dirs, isolated: { web: {} }, env }),
  });
});

afterEach(() => {
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a DAG in an isolated git workspace', () => {
  it('runs two parallel tasks of one role at once, and starts their child from the merge of their branches', async () => {
    const a = h.create({ title: 'write a', workspace: 'web' });
    const b = h.create({ title: 'write b', workspace: 'web' });
    const child = h.create({ title: 'check both', workspace: 'web', parents: [a.taskId, b.taskId] });
    h.service.addGate(child.taskId, { command: `test -f ${a.taskId}.txt && test -f ${b.taskId}.txt` }, ALICE);
    const implementer = h.driver('implementer');
    // Both at once: the workspace's one-agent limit does not hold tasks with directories of their own.
    const both = together(implementer, 2);
    completes(h, implementer);
    h.dispatcher.pass();
    await both.started;
    const starts = implementer.starts.map((s) => s.cwd);
    expect(new Set(starts).size).toBe(2);
    expect(starts).not.toContain(repo);
    await eventually(() => getTask(h.t.db, child.taskId)?.phase === 'done', 'the child to complete');
    await h.dispatcher.idle();

    const childDir = runDir(runsOf(h.t.db, child.taskId)[0]?.runId ?? '');
    expect(readFileSync(join(childDir, `${a.taskId}.txt`), 'utf8')).toBe('work\n');
    expect(readFileSync(join(childDir, `${b.taskId}.txt`), 'utf8')).toBe('work\n');
    // Its gate passed in its own directory, and its reported commit is its branch's HEAD.
    const [run] = runsOf(h.t.db, child.taskId);
    expect(run).toMatchObject({ outcome: 'completed', reportedCommit: git(repo, 'rev-parse', `mt/${child.taskId}`), reportedDirty: false });
    // Nothing landed on the base branch, and the base checkout is as it was.
    expect(git(repo, 'log', '--format=%s', 'main')).toBe('first');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/gateway-startup.test.ts`. Expected: `Tests  1 failed | 15 passed (16)`: the gateway says nothing of isolated workspaces. Run `npx vitest run --project e2e tests/kanban-worktree-dispatch.e2e.ts`. Expected: `Tests  1 passed (1)`: it drives what Tasks 1 to 7 built, through the harness, which builds its own `TaskDirectories`; it stays as the proof of the whole.

- [ ] **Step 8.3: Implement.**

In `src/index.ts`, replace:

```ts
import { registerWorkspaces } from './db/workspaces.js';
import { LarkAdapter } from './channel/lark/adapter.js';
import { LarkInbound } from './channel/lark/inbound.js';
import { buildRoleDrivers } from './driver/build.js';
```

with:

```ts
import { registerWorkspaces, worktreeOf } from './db/workspaces.js';
import { LarkAdapter } from './channel/lark/adapter.js';
import { LarkInbound } from './channel/lark/inbound.js';
import { buildRoleDrivers } from './driver/build.js';
import { buildEnv } from './driver/env.js';
```

In `src/index.ts`, replace:

```ts
import type { Channel } from './channel/types.js';
```

with:

```ts
import { TaskDirectories } from './kanban/worktree.js';
import type { Channel } from './channel/types.js';
```

In `src/index.ts`, replace:

```ts
    workspaces: new NamedWorkspaces(team.workspaces),
```

with:

```ts
    // A kanban run in a task's own directory works there, as recorded when it was made (spec §18).
    workspaces: new NamedWorkspaces(team.workspaces, (id) => worktreeOf(db, id)),
```

In `src/index.ts`, replace:

```ts
      limits: { failureLimit, transientLimit, transientCooldownS },
```

with:

```ts
      // Each task in one of these gets a directory of its own (spec §18).
      isolated: new Set(Object.keys(config.isolated ?? {})),
      limits: { failureLimit, transientLimit, transientCooldownS },
```

In `src/index.ts`, replace:

```ts
      nameOf: (principal) => people.nameOf(principal),
    });
```

with:

```ts
      nameOf: (principal) => people.nameOf(principal),
      // In the home too, outside every workspace's repository (spec §18). Git gets what an agent gets.
      workdirs: new TaskDirectories({
        db,
        root: join(config.home, 'worktrees'),
        workspaceDirs: team.workspaces,
        isolated: config.isolated ?? {},
        env: buildEnv(process.env),
      }),
    });
```

In `src/index.ts`, replace:

```ts
    note(`kanban: dispatching up to ${config.kanban.maxRunning} agent run(s) at once`);
  }
```

with:

```ts
    note(`kanban: dispatching up to ${config.kanban.maxRunning} agent run(s) at once`);
    const isolated = Object.keys(config.isolated ?? {}).sort();
    if (isolated.length > 0) note(`kanban: each task in ${isolated.join(', ')} gets a directory of its own`);
  }
```

- [ ] **Step 8.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1714 passed (1714)`. Run `npx vitest run --project e2e`. Expected: `Tests  126 passed (126)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.5: Commit.**

```bash
git add tests/kanban-worktree-dispatch.e2e.ts src/index.ts tests/gateway-startup.test.ts tests/helpers/dispatch.ts
git commit -m "Wire tasks' own directories into the gateway, under the home's worktrees directory, say at startup which workspaces are isolated, and run a DAG end to end with real git"
```

---

### Task 9: Seeing it, in chat and at the terminal

**Files:**

- Create: `tests/kanban-worktree-chat.test.ts`, `tests/mt-kanban-worktree.test.ts`
- Modify: `src/cli/mt.ts`, `src/cli/operator.ts`, `src/cli/plain.ts`, `src/cli/workspace.ts`, `src/kanban/chat-render.ts`, `tests/mt-kanban-operator-tasks.test.ts`, `tests/mt-workspace.test.ts`

`/kanban task show` and `mt kanban task show` say where a task's directory is, or that it is not made yet; `mt kanban task worktree` prints it alone, during a conflict too, since the worktree is recorded once added; `mt workspace add --isolated` writes the mapping, and `mt workspace list` marks it (Decision 18). The list of task verbs gains `worktree`. A folder shows as `directory: <path>`, with no branch.

- [ ] **Step 9.1: Write the tests.**

Create `tests/kanban-worktree-chat.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claim } from '../src/db/kanban.js';
import { taskView } from '../src/db/kanban-read.js';
import { registerWorktree } from '../src/db/workspaces.js';
import { renderShow } from '../src/kanban/chat-render.js';
import { testDb, type TestDb } from './helpers/db.js';
import { claimantFor, NOW, WORKSPACES, newTask } from './helpers/kanban.js';

/** `/kanban task show` and a task's own directory (spec §18): where it is, and its branch, escaped as any text. */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

function show(taskId: string): string {
  const view = taskView(h.db, taskId);
  if (view === undefined) throw new Error('no view');
  return renderShow(view, []);
}

describe('/kanban task show', () => {
  it("says where a task's own directory is, once made, and nothing for a shared one", () => {
    const task = newTask(h.db, { workspace: 'web' });
    claim(h.db, { taskId: task.taskId, claimant: claimantFor(h.db, task.taskId), workspaces: WORKSPACES, isolated: new Set(['web']) }, NOW);
    expect(show(task.taskId).split('\n')).toContain('directory: its own, not made yet: it is made when an agent next takes the task up');
    registerWorktree(
      h.db,
      { id: `wt:${task.taskId}`, kind: 'git-worktree', rootPath: `/home/mt/worktrees/web/${task.taskId}`, repoRoot: '/srv/web', branch: `mt/${task.taskId}` },
      NOW,
    );
    // Escaped for Lark's markdown, as every piece of text is: an id's `_` would start emphasis.
    const id = task.taskId.replace(/_/g, '\\_');
    expect(show(task.taskId).split('\n')).toContain(`directory: /home/mt/worktrees/web/${id} · branch mt/${id}`);
    expect(show(newTask(h.db, { workspace: 'web' }).taskId)).not.toContain('directory:');
  });
});
```

In `tests/mt-kanban-operator-tasks.test.ts`, replace:

```ts
    const takes = 'mt: kanban task takes new, list, show, assign, link, unblock, stop, archive or comment';
```

with:

```ts
    const takes = 'mt: kanban task takes new, list, show, assign, link, unblock, stop, archive, comment or worktree';
```

Create `tests/mt-kanban-worktree.test.ts`:

```ts
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { claim } from '../src/db/kanban.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { registerWorktree } from '../src/db/workspaces.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { claimantFor, NOW, newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * A task's own directory at the terminal (spec §18): `mt kanban task show` says
 * where it is, and `mt kanban task worktree` prints it alone, to `cd` to.
 */

let f: MtFixture;
let gateway: Db;

beforeEach(() => {
  clearSecrets();
  f = mtFixture((workspace) =>
    [`workspace: ${workspace}`, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
  );
  gateway = openDb(join(f.home, 'team.db'));
  migrate(gateway, SCHEMA_DIR);
});

afterEach(() => {
  clearSecrets();
  gateway.close();
  f.cleanup();
});

async function mt(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['kanban', ...argv], {
    env: { ...f.env, HOME: f.root },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdinIsTTY: false,
    stdin: async () => '',
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A task claimed in an isolated default, its directory made or not. */
function isolatedTask(made: boolean): { taskId: string; path: string } {
  const task = newTask(gateway, { assignee: { kind: 'role', name: 'default' }, workspace: 'default' });
  const r = claim(
    gateway,
    { taskId: task.taskId, claimant: claimantFor(gateway, task.taskId), workspaces: new Set(['default']), isolated: new Set(['default']) },
    NOW,
  );
  if (!r.ok) throw new Error(r.message);
  const path = join(f.home, 'worktrees', 'default', task.taskId);
  if (made) {
    registerWorktree(gateway, { id: `wt:${task.taskId}`, kind: 'git-worktree', rootPath: path, repoRoot: f.workspace, branch: `mt/${task.taskId}` }, NOW);
  }
  return { taskId: task.taskId, path };
}

describe('mt kanban task worktree', () => {
  it("prints a task's own directory alone, and in JSON its branch", async () => {
    const { taskId, path } = isolatedTask(true);
    expect(await mt(['task', 'worktree', taskId])).toEqual({ code: 0, out: path, err: '' });
    const json = await mt(['task', 'worktree', taskId, '--json']);
    expect(JSON.parse(json.out)).toEqual({ ok: true, task_id: taskId, workspace: 'default', path, branch: `mt/${taskId}` });
  });

  it('refuses a task in a shared directory, and one whose directory is not made yet', async () => {
    const shared = newTask(gateway, { workspace: 'default' });
    expect(await mt(['task', 'worktree', shared.taskId])).toEqual({
      code: 1,
      out: '',
      err: `mt: task ${shared.taskId} works in the shared directory of workspace default, not a directory of its own`,
    });
    const { taskId } = isolatedTask(false);
    expect(JSON.parse((await mt(['task', 'worktree', taskId, '--json'])).out)).toEqual({
      ok: false,
      code: 'no_worktree',
      message: `task ${taskId}'s own directory is not made yet: it is made when an agent next takes the task up`,
    });
    expect((await mt(['task', 'worktree'])).code).toBe(2);
  });
});

describe('a task with a folder of its own', () => {
  it('reads as a folder: no branch, in show or worktree', async () => {
    const task = newTask(gateway, { assignee: { kind: 'role', name: 'default' }, workspace: 'default' });
    const r = claim(
      gateway,
      { taskId: task.taskId, claimant: claimantFor(gateway, task.taskId), workspaces: new Set(['default']), isolated: new Set(['default']) },
      NOW,
    );
    if (!r.ok) throw new Error(r.message);
    const path = join(f.home, 'worktrees', 'default', task.taskId);
    registerWorktree(gateway, { id: `wt:${task.taskId}`, kind: 'plain-dir', rootPath: path, repoRoot: f.workspace, branch: null }, NOW);
    const shown = (await mt(['task', 'show', task.taskId])).out;
    expect(shown.split('\n')).toContain(`directory: ${path}`);
    expect(shown).not.toContain('branch');
    expect(await mt(['task', 'worktree', task.taskId])).toEqual({ code: 0, out: path, err: '' });
    expect(JSON.parse((await mt(['task', 'worktree', task.taskId, '--json'])).out)).toMatchObject({ path, branch: null });
  });
});

describe('mt kanban task show', () => {
  it("says where a task's own directory is, and its branch", async () => {
    const { taskId, path } = isolatedTask(true);
    const r = await mt(['task', 'show', taskId]);
    expect(r.out.split('\n')).toContain(`directory: ${path} · branch mt/${taskId}`);
    expect(JSON.parse((await mt(['task', 'show', taskId, '--json'])).out).task.worktree).toEqual({ path, branch: `mt/${taskId}` });
    const later = isolatedTask(false);
    expect((await mt(['task', 'show', later.taskId])).out.split('\n')).toContain('directory: its own, not made yet: it is made when an agent next takes the task up');
    const shared = newTask(gateway, { workspace: 'default' });
    expect((await mt(['task', 'show', shared.taskId])).out).not.toContain('directory:');
    expect(JSON.parse((await mt(['task', 'show', shared.taskId, '--json'])).out).task.worktree).toBeNull();
  });
});
```

In `tests/mt-workspace.test.ts`, replace:

```ts
    expect(loadTeamSettings(fx.env).workspaces['docs']).toBe(docs);
  });
```

with:

```ts
    expect(loadTeamSettings(fx.env).workspaces['docs']).toBe(docs);
  });

  it('adds an isolated workspace as a mapping the gateway reads', async () => {
    fx = mtFixture();
    const docs = docsDir();
    const r = await fx.run(['workspace', 'add', 'docs', docs, '--isolated']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('the gateway uses it, each of its tasks in a directory of its own, from its next start');
    const text = readFileSync(fx.configPath, 'utf8');
    expect((parseYaml(text) as { workspaces: Record<string, unknown> }).workspaces['docs']).toEqual({ path: docs, isolated: true });
    const settings = loadTeamSettings(fx.env);
    expect(settings.workspaces['docs']).toBe(docs);
    expect(settings.isolated).toEqual({ docs: {} });
    const listed = await fx.run(['workspace', 'list']);
    expect(listed.out).toMatch(new RegExp(`^docs\\s+${docs}\\s+not registered yet, isolated$`, 'm'));
  });
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-worktree-chat.test.ts tests/mt-kanban-worktree.test.ts tests/mt-kanban-operator-tasks.test.ts tests/mt-workspace.test.ts`. Expected: `Test Files  4 failed (4)` and `Tests  7 failed | 43 passed (50)`.

- [ ] **Step 9.3: Implement.**

In `src/cli/mt.ts`, replace:

```ts
  '  mt workspace add <name> <absolute-path>',
  '  mt workspace add <name> --clone <git-url>',
```

with:

```ts
  '  mt workspace add <name> <absolute-path> [--isolated]',
  '  mt workspace add <name> --clone <git-url> [--isolated]',
```

In `src/cli/mt.ts`, replace:

```ts
  '  mt kanban gate add <task_id> [--timeout <s>] -- <command...>',
```

with:

```ts
  '  mt kanban task worktree <task_id> [--board <name>] [--json]',
  '  mt kanban gate add <task_id> [--timeout <s>] -- <command...>',
```

In `src/cli/mt.ts`, replace:

```ts
      const { values, positionals } = parse(rest, { clone: { type: 'string' } });
      const [name, path, extra] = positionals;
      if (name === undefined || extra !== undefined || (path === undefined) === (values.clone === undefined)) {
        throw new UsageError('workspace add takes a name and either an absolute path or --clone <git-url>');
      }
      // `await`, so a ConfigError from the async command is caught below and
      // reported as `mt: …` rather than escaping as a stack trace.
      return await workspaceAdd(name, path === undefined ? { cloneUrl: values.clone ?? '' } : { path }, withGatewayFile(io));
```

with:

```ts
      const { values, positionals } = parse(rest, { clone: { type: 'string' }, isolated: { type: 'boolean' } });
      const [name, path, extra] = positionals;
      if (name === undefined || extra !== undefined || (path === undefined) === (values.clone === undefined)) {
        throw new UsageError('workspace add takes a name and either an absolute path or --clone <git-url>');
      }
      // `await`, so a ConfigError from the async command is caught below and
      // reported as `mt: …` rather than escaping as a stack trace.
      return await workspaceAdd(
        name,
        path === undefined ? { cloneUrl: values.clone ?? '' } : { path },
        withGatewayFile(io),
        { isolated: values.isolated === true },
      );
```

In `src/cli/operator.ts`, replace:

```ts
          phase: task.phase,
```

with:

```ts
          // Its own directory (spec §18), or null in the workspace's shared one; its path is null until made.
          worktree: r.view.workdir === undefined ? null : { path: r.view.workdir.path, branch: r.view.workdir.branch },
          phase: task.phase,
```

In `src/cli/operator.ts`, replace:

```ts
/** The verbs of `mt kanban task`: chat's task commands that a terminal has (spec §2.6). */
export const TASK_COMMANDS: readonly string[] = ['new', 'list', 'show', 'assign', 'link', 'unblock', 'stop', 'archive', 'comment'];
```

with:

```ts
/**
 * `mt kanban task worktree <task> [--board <name>]`: a task's own directory
 * (spec §18), alone on its line, so a person can `cd "$(mt kanban task worktree k_…)"`
 * to resolve a merge there. Refused for a task in a shared directory.
 */
function worktree(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const taskId = oneTask(positionals, 'worktree');
  const board = boardFlag(values.board);
  return act(io, values.json === true, 'mt kanban task worktree', (service) => {
    const guard = offBoard(service, board, taskId);
    if (guard !== undefined) return guard;
    const r = service.show(taskId);
    if (!r.ok) return refused(r);
    const { task, workdir } = r.view;
    if (workdir === undefined) {
      const where = task.workspace === null ? 'has no workspace yet' : `works in the shared directory of workspace ${task.workspace}`;
      return refused({ code: 'no_worktree', message: `task ${taskId} ${where}, not a directory of its own` });
    }
    if (workdir.path === null) {
      return refused({ code: 'no_worktree', message: `task ${taskId}'s own directory is not made yet: it is made when an agent next takes the task up` });
    }
    return {
      ok: true,
      lines: [line(workdir.path, 4096)],
      json: { task_id: taskId, workspace: task.workspace, path: workdir.path, branch: workdir.branch },
    };
  });
}

/** The verbs of `mt kanban task`: chat's task commands that a terminal has (spec §2.6), and `worktree`. */
export const TASK_COMMANDS: readonly string[] = ['new', 'list', 'show', 'assign', 'link', 'unblock', 'stop', 'archive', 'comment', 'worktree'];
```

In `src/cli/operator.ts`, replace:

```ts
      return comment(rest, io);
    default:
```

with:

```ts
      return comment(rest, io);
    case 'worktree':
      return worktree(rest, io);
    default:
```

In `src/cli/plain.ts`, replace:

```ts
import { table } from './args.js';

```

with:

```ts
import { table } from './args.js';
import { workdirLine } from '../kanban/chat-render.js';

```

In `src/cli/plain.ts`, replace:

```ts
  if (task.body.trim() !== '') out.push('', ...indented(task.body, 4000), '');
```

with:

```ts
  if (view.workdir !== undefined) out.push(workdirLine(view.workdir, (t) => line(t, 4096)));
  if (task.body.trim() !== '') out.push('', ...indented(task.body, 4000), '');
```

In `src/cli/workspace.ts`, replace:

```ts
 * Adds `name: path` under `workspaces:` and writes the config file in place,
 * keeping its comments and mode. Throws if the file cannot be written; the file
 * is then as it was.
 */
export function addToConfig(ws: NewWorkspace, path: string): void {
```

with:

```ts
 * Adds `name: path` under `workspaces:` -- `name: { path, isolated: true }` for an
 * isolated workspace (spec §18) -- and writes the config file in place, keeping
 * its comments and mode. Throws if the file cannot be written; the file is then
 * as it was.
 */
export function addToConfig(ws: NewWorkspace, path: string, opts: { isolated?: boolean } = {}): void {
```

In `src/cli/workspace.ts`, replace:

```ts
  doc.setIn(['workspaces', ws.name], path);
```

with:

```ts
  doc.setIn(['workspaces', ws.name], opts.isolated === true ? doc.createNode({ path, isolated: true }) : path);
```

In `src/cli/workspace.ts`, replace:

```ts
/** `mt workspace add` (spec §2.6). Refuses anything the next start would refuse. */
export async function workspaceAdd(name: string, target: AddTarget, io: MtIo): Promise<number> {
```

with:

```ts
/** `mt workspace add` (spec §2.6). Refuses anything the next start would refuse. `isolated`: each task gets its own directory (spec §18). */
export async function workspaceAdd(
  name: string,
  target: AddTarget,
  io: MtIo,
  opts: { isolated?: boolean } = {},
): Promise<number> {
```

In `src/cli/workspace.ts`, replace:

```ts
    addToConfig(ws, path);
  } catch (err) {
    undo();
    return refuse(io, `cannot write ${configPath}: ${(err as Error).message}`);
  }
  io.out(addedMessage(name, final.real, configPath));
  return 0;
}

export function addedMessage(name: string, real: string, configPath: string): string {
  return `added workspace ${name} (${real}) to ${configPath}; the gateway uses it from its next start`;
```

with:

```ts
    addToConfig(ws, path, opts);
  } catch (err) {
    undo();
    return refuse(io, `cannot write ${configPath}: ${(err as Error).message}`);
  }
  io.out(addedMessage(name, final.real, configPath, opts.isolated === true));
  return 0;
}

export function addedMessage(name: string, real: string, configPath: string, isolated = false): string {
  const own = isolated ? ', each of its tasks in a directory of its own,' : '';
  return `added workspace ${name} (${real}) to ${configPath}; the gateway uses it${own} from its next start`;
```

In `src/cli/workspace.ts`, replace:

```ts
    rows.push([name, declared, status]);
```

with:

```ts
    rows.push([name, declared, settings.isolated?.[name] === undefined ? status : `${status}, isolated`]);
```

In `src/kanban/chat-render.ts`, replace:

```ts
  if (task.body.trim() !== '') out.push(block(task.body, 1500));
```

with:

```ts
  if (view.workdir !== undefined) out.push(workdirLine(view.workdir, label));
  if (task.body.trim() !== '') out.push(block(task.body, 1500));
```

In `src/kanban/chat-render.ts`, replace:

```ts
  return out.join('\n');
}
```

with:

```ts
  return out.join('\n');
}

/**
 * Where a task with a directory of its own works (spec §18): `/kanban task show`
 * and `mt kanban task show` say so, in the same words.
 */
export function workdirLine(w: { path: string | null; branch: string | null }, escape: (text: string) => string = (t) => t): string {
  if (w.path === null) return 'directory: its own, not made yet: it is made when an agent next takes the task up';
  return `directory: ${escape(w.path)}${w.branch === null ? '' : ` · branch ${escape(w.branch)}`}`;
}
```

- [ ] **Step 9.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1720 passed (1720)`. Run `npx vitest run --project e2e`. Expected: `Tests  126 passed (126)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.5: Commit.**

```bash
git add tests/kanban-worktree-chat.test.ts tests/mt-kanban-worktree.test.ts src/cli/mt.ts src/cli/operator.ts src/cli/plain.ts src/cli/workspace.ts src/kanban/chat-render.ts tests/mt-kanban-operator-tasks.test.ts tests/mt-workspace.test.ts
git commit -m "Say in task show, in chat and at the terminal, where a task's own directory is, print it with mt kanban task worktree, and write an isolated workspace with mt workspace add --isolated, which mt workspace list marks"
```

---

### Task 10: The README and the guide

**Files:**

- Modify: `README.md`, `docs/kanban-guide.md`, `config.example.yaml`

Isolated workspaces in the README's workspaces section and command list, in the guide's fan-out section, its recipes 1 and 3, its terminal section and its rules of thumb, and in the example config: each leads with a plain folder, research fanning out into note-taking tasks that a write-up reads, and shows the git case after (Decision 23).

- [ ] **Step 10.1: Write it.**

In `README.md`, replace:

```markdown
A workspace's name keeps the directory it was first used with: the gateway records it, and
```

with:

````markdown
A workspace runs one agent at a time, since two agents in one directory would overwrite each
other. An **isolated** workspace gives each board task a directory of its own instead, so its
tasks run side by side. A task need not be code, and a workspace need not be a repository:

```yaml
workspaces:
  worker:
    path: /home/me/.manus-team/workspaces/worker
    isolated: true
```

Here `worker` is a plain folder. A research task fans out into three note-taking tasks, which
run at once, each in an empty folder of its own under `$MT_HOME/worktrees/worker/`; the write-up
task that waits for all three is told, in its prompt, the folders they left their notes in, and
reads them there. Nothing is copied, and nothing is said to the agents about git.

The same works for a git repository, and git is used only there:

```yaml
workspaces:
  web:
    path: /srv/repos/web
    isolated: true
    base: main        # optional
```

There a task's directory is a worktree under `$MT_HOME/worktrees/<workspace>/`, on its own
branch, `mt/<task_id>`. A task with no parents starts from `base`, or, without one, from
whatever the repository has checked out; a task with one parent starts from that parent's
branch, and a task with several from a merge of their branches, in the order they were linked;
an archived parent's work is not merged. Submodules are not initialised in a task's directory.
A merge that conflicts blocks the task, naming the files: resolve it in the task's directory
(`cd "$(mt kanban task worktree <task_id>)"`), commit, and unblock the task. The gateway never
merges, pushes or rebases into your branches, and never deletes a branch or a worktree: merging
the work is yours, or a final task's.

Either way, every run of a task, its review and its rework included, works in its directory,
and its gates run there. A task that had already run in the shared directory before the switch
stays there.

A workspace's name keeps the directory it was first used with: the gateway records it, and
````

In `README.md`, replace:

```markdown
mt workspace add <name> <absolute-path>
mt workspace add <name> --clone <git-url>
```

with:

```markdown
mt workspace add <name> <absolute-path> [--isolated]
mt workspace add <name> --clone <git-url> [--isolated]
```

In `README.md`, replace:

```markdown
mt kanban gate add <task_id> [--timeout <s>] -- <command...>
```

with:

```markdown
mt kanban task worktree <task_id> [--board <name>] [--json]
mt kanban gate add <task_id> [--timeout <s>] -- <command...>
```

In `config.example.yaml`, replace:

```yaml
#   docs: /srv/repos/docs

```

with:

```yaml
#   docs: /srv/repos/docs
#   # Isolated: each board task gets a directory of its own, so tasks run side by
#   # side. In a plain folder, an empty folder each, whose prompt lists its
#   # parents' folders. In a git repository, and only there, a worktree on the
#   # branch mt/<task_id>, started from `base` (unset: whatever the directory has
#   # checked out) or from the task's parents. Nothing is ever merged for you.
#   notes:
#     path: /srv/notes
#     isolated: true
#   web:
#     path: /srv/repos/web
#     isolated: true
#     base: main

```

In `docs/kanban-guide.md`, replace:

```markdown
Running agents are also capped by `kanban.max_running` in the gateway's config: at most that many
```

with:

````markdown
Or make `worker`'s workspace **isolated**, and give each task a directory of its own, with no
new workspaces at all. In the gateway's config:

```yaml
workspaces:
  worker:
    path: /srv/work/research
    isolated: true
```

Then the three vendor tasks run at once. Where `worker` is a plain folder, as research usually
is, each vendor task gets an empty folder of its own, and the comparison's prompt lists the three
folders their notes are in, to read. Nothing is copied, and nothing is said about git.
`/kanban task show` says where a task's directory is.

Where the workspace is a git repository, and only there, git is used: each task's directory is a
worktree on its own branch, `mt/<task_id>`, and the write-up starts from a merge of the three
branches. If that merge conflicts, the write-up blocks, naming the files, for you to resolve in
its directory and unblock. Nothing is merged into your own branches.

Running agents are also capped by `kanban.max_running` in the gateway's config: at most that many
````

In `docs/kanban-guide.md`, replace:

```markdown
- A task command needs `task`: `mt kanban new`, without it, is an unknown command. `mt kanban
```

with:

```markdown
- `mt kanban task worktree <task_id>` prints the directory of a task in an isolated workspace,
  alone, so you can `cd "$(mt kanban task worktree k_…)"` to resolve a merge there.
- A task command needs `task`: `mt kanban new`, without it, is an unknown command. `mt kanban
```

In `docs/kanban-guide.md`, replace:

```markdown
workspace the gateway does not have yet is refused at once, and nothing is created.

```

with:

```markdown
workspace the gateway does not have yet is refused at once, and nothing is created.

Simpler, once your gateway has isolated workspaces: mark `worker`'s own workspace `isolated: true`
(section 6) and restart. Then the three prototypes need no `workspace:` line: each runs at once in
a folder of its own in `worker`, and the recommendation's prompt lists their folders to read.

```

In `docs/kanban-guide.md`, replace:

```markdown
  workspace, in the body or in `role.md`.
```

with:

```markdown
  workspace, in the body or in `role.md`, or make the workspace they share isolated (section 6):
  with `worker`'s marked `isolated: true`, the planner's parallel tasks run at once with no
  `"workspace"` at all.
```

In `docs/kanban-guide.md`, replace:

```markdown
- **One workspace per parallel branch.** Tasks that share a workspace run one after the other,
  however wide the graph. Then check the role's `max_running`: it caps the width too.
```

with:

```markdown
- **One workspace per parallel branch, or an isolated one.** Tasks that share a workspace run one
  after the other, however wide the graph, unless the workspace is isolated (section 6), which
  gives each task a directory of its own. Then check the role's `max_running`: it caps the width
  too.
```

In `docs/kanban-guide.md`, replace:

```markdown
- Want parallel work? Give each task its own workspace, or they queue.
```

with:

```markdown
- Want parallel work? Make the workspace isolated, or give each task its own, or they queue.
```

- [ ] **Step 10.2: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1720 passed (1720)`. Run `npx vitest run --project e2e`. Expected: `Tests  126 passed (126)`. Run `npm run typecheck`. Expected: no errors. Run `git grep -n -i "p[g]w" -- . ':!package-lock.json'`. Expected: no output. Run `git diff -U0 README.md docs/kanban-guide.md config.example.yaml | grep '^+' | grep -c "$(printf '\342\200\224')"`, which counts the long dashes added. Expected: `0`.

- [ ] **Step 10.3: Commit.**

```bash
git add README.md docs/kanban-guide.md config.example.yaml
git commit -m "Describe isolated workspaces in the README, the usage guide and the example config: a directory of its own for each task, where it starts, a conflict to resolve, and nothing merged for you"
```

---

## Done when

- `npx vitest run --project unit` gives `Tests  1724 passed (1724)`. `npx vitest run --project e2e` gives `Tests  133 passed (133)`, after the review follow-ups. `npm run typecheck` reports no errors. All under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- A workspace written `{ path, isolated: true }` loads, and a bad mapping is refused (`tests/config.test.ts`).
- Two tasks of one role in an isolated workspace run at once, each in its own directory; a retry uses the same one; a directory that cannot be made blocks its task, uncounted (`tests/kanban-worktree-claim.test.ts`, `tests/kanban-dispatch-worktree.test.ts`).
- Against real git: a worktree from `HEAD` or `base`, a parent's branch, a fan-in's merge in link order without archived parents, a branch never shadowed by a tag, a conflict recorded with its directory, left for a person and taken up once resolved, a failed add's branch taken up, a git past its time stopped with its filter and its leftover named, git's answer not held up by what it leaves holding its output, a moved-away repository blocked and recorded as nothing, a worktree off its branch blocked, a repository git cannot read blocked, no hook run, a bare repository, a folder for a plain directory, and every refusal changing nothing (`tests/kanban-worktree.e2e.ts`); and a DAG whose two parallel tasks run at once and whose child starts from their merge, with its gate and its commit in its own worktree, and nothing on the base branch (`tests/kanban-worktree-dispatch.e2e.ts`).
- `task show` says where the directory is, `mt kanban task worktree` prints it, and `mt workspace add --isolated` writes the mapping (`tests/kanban-worktree-chat.test.ts`, `tests/mt-kanban-worktree.test.ts`, `tests/mt-workspace.test.ts`).

## Review follow-ups

A review of the built plan found these; each was fixed test first, where it changed behaviour. Counts after them: unit `Tests  1724 passed (1724)`, e2e `Tests  133 passed (133)`.

1. **A tag named `mt/<task_id>` blocked a recorded worktree on every later run**, as `symbolic-ref --short HEAD` printed `heads/mt/<task_id>`. Fixed: `symbolic-ref --quiet HEAD` is compared with `refs/heads/<branch>`, and `refs/heads/` is stripped only for the reason. Tested: a worktree made, `git tag mt/<id>`, prepared again, goes on; a detached worktree is still named as on no branch.
2. **A folder task's folder starts empty, with no way to its inputs.** Decided (Decision 24): its work and review prompts name the workspace's own folder for shared inputs, with nothing of git; a worktree's do not. Tested in the prompt's text and through the dispatcher, for a folder and for a worktree. Recorded in spec §18.8 and its amendment note.
3. **The guide.** Section 6's YAML keeps `worker`'s path, `/home/me/.manus-team/workspaces/worker`, as the README and §18.1 do, with `isolated: true`, says to keep the path, as a workspace keeps the directory it was first used with, and that the vendor tasks then drop their `workspace: vendor-x` lines. Section 6 and Recipe 1 say each task's folder starts empty and its prompt names `worker`'s own folder for shared inputs, where input files such as `vendors/candidates.md` go, or in a parent's results; Recipe 1 says "a folder of its own under `$MT_HOME/worktrees/worker/`". Recipe 3 now names `api`, whose parallel tasks each get a worktree of `api`. The README says the same in half a line.
4. **A path git lists was told to be moved aside**, which leaves a registered worktree. Fixed: a path `git worktree list` shows is told to move out anything needed, then `git worktree unlock <path>` if locked, and `git worktree remove --force <path>`; only a path git does not list is told to move it aside. Tested both.
5. **`#parentFor` made a directory before looking.** Fixed: the root, and `<root>/<workspace>` if it is there, are lstat'ed before the mkdir, so a symlinked root has nothing made in its target, and a dangling symlink is "a symlink", not ENOENT. Tested a symlinked root, a dangling root and a symlinked workspace directory.
6. **An ambiguous `base:`** took the tag. Fixed: `refs/heads/<base>` when it exists, else the name as given. Tested a branch and a tag of one name, and a tag alone. Recorded in spec §18.5.
7. **An earlier attempt that never started** put its block's whole text, a person's how-to, into the next work prompt. Fixed: it is given as `did not start: <reason>`, cut at its first clause. Tested.
8. **`base` let bidi and C1 controls through.** Fixed: `BASE_REF` refuses `BIDI` (from `src/text.ts`) and `[\u0080-\u009f]` too. Tested. Recorded in spec §18.1.
9. **The shared-task test claimed without checking.** It now asserts `workspace_busy` for the second shared task.
10. **Refusals named a task's directory by its `wt:` id.** Fixed: `placeName` gives `task k_…'s directory` for a `wt:` place, in `db/kanban.ts`'s claim and the service's claim and report refusals. Tested at the claim. Recorded in spec §18.2.
11. **The README's command list** gave `[--json]` for `mt kanban task worktree` alone. Dropped, to match the other lines.
12. **`src/cli/plain.ts`'s imports** had a second import from `chat-render.js` out of order. Merged into the first.

## Before using it: a smoke test against the live gateway

For the user, once the plan is built and merged. It uses a scratch repository and a scratch folder, never a real project, and a role on a cheap model; `<role>` below is its name. Run `mt` as the gateway's user (in a checkout, `npm run -s mt -- …`).

1. Make a scratch repository with one commit, and a scratch folder:
   ```bash
   mkdir -p ~/scratch-wt && cd ~/scratch-wt && git init -q -b main && echo hello > README && git add README && git commit -qm first
   mkdir -p ~/scratch-notes
   ```
2. `mt workspace add scratch ~/scratch-wt --isolated` and `mt workspace add notes ~/scratch-notes --isolated`; `mt workspace list` shows both `not registered yet, isolated`. Deploy as usual (`npm run build && mt service restart`, or restart `npm run dev`). The log says `kanban: each task in notes, scratch gets a directory of its own`.
3. Two at once:
   ```bash
   mt kanban task new "Smoke: write alpha.txt containing alpha, commit it, report complete" --assignee <role> --workspace scratch --key smoke-a
   mt kanban task new "Smoke: write beta.txt containing beta, commit it, report complete" --assignee <role> --workspace scratch --key smoke-b
   ```
   `mt kanban task list running` shows both running at the same time. `mt kanban task show <id>` says `directory: …/worktrees/scratch/<id> · branch mt/<id>`. `git -C ~/scratch-wt worktree list` lists both.
4. A fan-in: `mt kanban task new "Smoke: check that alpha.txt and beta.txt are both here, then report complete" --assignee <role> --workspace scratch --parent <a> --parent <b>`. It reaches `done`; `ls "$(mt kanban task worktree <c>)"` shows both files; `git -C ~/scratch-wt log --oneline main` still shows only `first`.
5. A conflict: two tasks that each write `same.txt` with different text and commit, then a child of both. The child blocks as `needs_input`, naming `same.txt`, in chat if it was created there, and in `mt kanban task show`, which gives its directory too. `cd "$(mt kanban task worktree <child>)"`, fix `same.txt`, `git add same.txt && git commit --no-edit`, then `mt kanban task unblock <child>`: it runs and reaches `done`.
6. A folder, the case most of the board's work is: `mt kanban task new "Smoke: write notes.md saying hi" --assignee <role> --workspace notes`, then a child of it, "list your parents' folders and read notes.md there". The child's summary quotes `hi`; each task's directory is under `…/worktrees/notes/`.
7. Clean up: `mt kanban task archive <id>` for each; then by hand, `git -C ~/scratch-wt worktree remove <path>` for each worktree and `git -C ~/scratch-wt branch -D mt/<id>` for each branch (the board never does either); remove `scratch` and `notes` from `workspaces:` in the config, and restart. Their names stay registered, as every removed workspace's does.
