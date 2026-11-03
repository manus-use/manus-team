# Plan R — Native rendering: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A role whose coding agent is bytesec runs each board task as a native bytesec agent package. Its `role.md` becomes the agent's own system prompt, its skills load as bytesec skills, and the task prompt leaves both out, so they are not sent twice. The package is written in a directory the gateway manages under `$MT_HOME`, never in a workspace. A role can opt out with `agent.native: false`, a render that fails falls back to today's prompt injection, and every agent without a renderer keeps that injection (spec §7.1).

**Architecture:**
- **Names.** `src/names.ts` tightens the role and workspace grammar so a name cannot end in `-`. Every role name is then a valid bytesec package name.
- **Configuration.** `src/roles.ts` reads `agent.native` from a role directory's `config.yaml` into `AgentConfig.native`.
- **The session layer.** `StartOptions` gains `args`, which the structured-CLI driver puts after the configured `agent.args` and which the ACP driver refuses. `SessionActorDeps` gains `args`, and the registry asks a new `argsFor` hook on every actor build, as it asks `envFor`.
- **Rendering.** `src/render/types.ts` is the renderer interface. `src/render/bytesec.ts` is bytesec's renderer: which roles it takes, what package a role becomes, and how a run uses it. `src/render/native.ts` decides whether a role is rendered (`nativeFor`), writes a content-addressed package atomically (`renderNative`) and removes old ones (`sweepRole`, `sweepRoles`).
- **The run.** The claim also hands over the `role.md` bytes it hashed. The dispatcher renders the role just after the claim, gives the run `--agent <role>` and `BYTESEC_LOCAL_APM_PATH`, and composes its prompt without `role.md` and the skills. `src/index.ts` points it at `$MT_HOME/rendered`.
- **The `mt` CLI.** `mt role check` says, one line a role, whether the role's runs are rendered, and why not.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §2.1, §2.2, §2.4 item 3, §2.6, §2.7 (new), §7.1, §10, §11, and the R row of §12, as amended in the same commit as this plan.

---

## The spike

Done before this plan, on bytesec 0.7.4. Its findings are why the design is what it is.

**What works:**
- `BYTESEC_LOCAL_APM_PATH=<one package directory>` in the agent's environment, with `bytesec run … --agent <name>`, loads that package's agent. The package directory is the one that holds `apm.json`.
- **A directory of packages fails silently**: bytesec exits 1 with no output. bytesec's code accepts either a package directory or one holding `packages/`, so each run is pointed at its own role's single package.
- **The package layout**, copied from a real package:
  - `<pkg>/apm.json`: `{"name": "<role>", "description": "...", "source": "default", "path": ""}`;
  - `<pkg>/agents/<role>.md`: front matter `name`, `description` and `mode: primary`, then the system prompt;
  - `<pkg>/skills/<skill>/SKILL.md`, with front matter `name` and `description`.
- **Confirmed by real runs:** the agent's md body became its system prompt, since it answered with a codeword that existed only there. The package's skill was listed as loaded.
- **Precedence:** an agent from the override wins over a project package of the same name. In bytesec's code they are assigned, not `??=`.

**Limits:**
- `BYTESEC_NO_GLOBAL_APM=1` did not hide the user-level skill `bytedcli`, which appeared in both runs. A role gets its own skills plus the user's global ones.
- `bytesec agent list` does not show override packages, so the gateway cannot verify a rendered package by listing it.
- bytesec's package-name pattern is `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`. Its skill-name rule is the same pattern, with no `--` and at most 64 characters. `bytesec-agent` is reserved: `--agent bytesec-agent` runs the built-in agent and looks up no package.

**What `mode: primary` does to bytesec's own instructions.** The open risk was that the md body replaces the default agent's instructions. bytesec's bundled code was read with `strings ~/.local/bin/bytesec`, read-only, and settles most of it (Decision 19):
- `LLM.resolvePrompts` builds the system prompt from:
  - the provider header;
  - the **provider prompt**, `SystemPrompt.provider(model)`, always;
  - a body whose persona is the agent's prompt, wrapped by `bytesecAgentInstructions` in "Use the user's language…" and `AGENT_GUIDELINES` (tool usage, git and workspace hygiene);
  - the environment and instruction sections.
- For an agent with no prompt, that body's persona is bytesec's default identity, "You are bytesec, the default security agent…".
- Models that take an instructions prompt get bytesec's shared instructions followed by the agent's prompt.
- So the md body takes the place of the default identity paragraph only. The provider prompt, the tool and workspace guidelines and the environment section stay. `mode` only says the agent may be run directly. Tools worked in the spike.

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on branch `native-render`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, and never write to `~/.manus-team`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Secrets.** Never print secret values. Tests use made-up values only.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` gives `Tests  931 passed (931)`. `npm run test:e2e` gives `Tests  49 passed (49)`. `npm run typecheck` prints nothing.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given.
- **No real bytesec.** No test runs bytesec or reaches the network. The dispatcher's tests read the `StartOptions` a `FakeDriver` was given. The CLI driver's end-to-end tests read the argv and the `BYTESEC_LOCAL_APM_PATH` the fake CLI agent logs. The manual smoke test at the end is the only real run, and it is not part of any count.
- **Real files.** Rendering tests write under a fresh `mkdtemp` directory, removed after each test, and realpath it first (on macOS `/tmp` is `/private/tmp`).

## Decisions the spec left open

Each is the reading most consistent with the rest of the spec. Decisions 1–3 and 6 are the user's. **Decision 19, the default-instructions risk, and Decision 20 are for the user to confirm.** All of them are now in the spec, mostly in its new §2.7.

1. **Plan R comes now, before C3.** The spec's order becomes A, A2, B, F, C1, C2, R, C3, C4, D (§12). R needs C2's claim, which reads and hashes `role.md`, and C2's dispatcher, which builds a run's environment. C3 then makes reportable runs that already get their role natively.
2. **"The agent is bytesec" means driver `structured-cli` and a command whose basename is `bytesec`.**
   - The structured-CLI driver speaks only bytesec's `run --format json` wire format (its own comment says so), so a role on it running `bytesec` takes `run`'s flags.
   - The basename, not the whole path, so `/opt/homebrew/bin/bytesec` counts.
   - A wrapper script with another name does not count: it may not pass `--agent` or the environment on, and the run would fail rather than fall back.
   - An ACP agent is never rendered, even `bytesec acp`: ACP was not part of the spike, and the ACP driver refuses per-session arguments (Decision 12).
3. **The opt-out is `agent.native: false`** in a role directory's `config.yaml`.
   - `true` is accepted, and is the default.
   - The legacy `agent:` block refuses the key as unknown: its role has no `role.md` and no skills, so the key could only mislead.
   - `AgentConfig.native` is optional and set only when the file gives it, so no existing `AgentConfig` literal changes.
4. **A role with no `role.md` and no skills is not rendered.** That covers the role `default` made from the `agent:` block, so chat is unchanged. **Chat is unchanged in every case**:
   - rendering happens only for a kanban run, in the dispatcher;
   - a chat session never got `role.md` either, even from a `roles/default/` directory.

   A role with skills but no `role.md` is rendered with an empty agent body, and bytesec then keeps its own default identity.
5. **When bytesec's renderer refuses a role, the role is injected**, and `mt role check` says why. It refuses:
   - a name outside bytesec's package pattern (none after Task 1, but the renderer does not rely on it);
   - the name `bytesec-agent`;
   - `agent.args` that already pass `--agent` or `--agent=…`: the operator chose an agent;
   - an environment that already sets `BYTESEC_LOCAL_APM_PATH` or `OPENCODE_LOCAL_APM_PATH`, which bytesec also reads: a session's value would silently win over the operator's;
   - a skill whose name bytesec's skill-name rule refuses: bytesec would not load it.

   Refusing the whole role is simpler than rendering part of it. It also keeps what the agent is told in one place.
6. **A role or workspace name may not end in `-`.**
   - `NAME_PATTERN` becomes `^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$`: still a letter first and at most 40 characters.
   - `--` inside a name stays allowed: bytesec's package pattern allows it.
   - The live home has no `roles/` directory and one workspace, `default`, so it still passes. The README and spec §2.1 and §2.3 say so.
7. **Rendering happens just after the claim, from the claim's own bytes.**
   - `Claimed` gains `roleMdBytes`, the bytes `#claimant` hashed. The package's `role.md` is therefore exactly what `role_md_hash` names, even if the file is edited between the claim and the render, or is not UTF-8.
   - The dispatcher renders at the start of `#drive`, before the session exists.
   - Skills are read at the render; the claim has just checked that each `SKILL.md` is a readable regular file.
   - The service stays free of the filesystem layout of `$MT_HOME/rendered`, which is the dispatcher's.
8. **A package's directory is named by its content**: `$MT_HOME/rendered/<role>/<sha256>/`, which is itself the package directory.
   - The hash is over the package's own files, sorted by path, each path and its bytes length-prefixed. It covers `role.md`, every skill file, the description and whatever the renderer writes, by construction.
   - Two runs on two versions of a role's files never share a directory.
   - A directory that exists is reused as it is: it was renamed into place whole, so it is complete.
9. **A package is written atomically, privately and from regular files only.**
   - It is written in a `.stage-XXXXXX` directory (`mkdtemp`) beside its final place, and renamed. A failed write removes the staging.
   - Directories are `0700` and files `0600`. A render root, or a role directory in it, that is a symlink or a file is refused rather than followed.
   - Only regular files are copied, as `mt role create` copies them: symlinks, FIFOs and sockets are skipped, and so is any `.env`.
   - A `SKILL.md` that is not itself a regular file fails the render, since the skill would arrive without it.
   - A package over 16 MiB or 2,000 files fails it too. It is read whole at each claim, and a skill that size is a mistake.
10. **Old packages are swept at two moments.**
    - **When a role is rendered**, its other packages are removed, except those of open runs: the dispatcher keeps each open run's package directory.
    - **At boot**, when nothing is open, the directories of roles no longer configured are removed, and so is any staging a dead process left. Each role's other packages go at its next render.

    So a role keeps its newest package, for an operator to inspect, and every running agent keeps its own. A render and its sweep run synchronously, with the run's entry in `#open` written before the next `await`. A sweep therefore always sees every package in use, since one process renders.
11. **The workspace rules already keep packages out of every workspace.**
    - `$MT_HOME/rendered` is inside the home.
    - No workspace may be or contain the home.
    - Inside the home only `workspaces/<name>` may be one (spec §2.3).

    So neither `rendered/` nor a package in it can be a workspace or lie in one. `src/workspaces.ts` is unchanged, and a test pins the rule (Task 6).
12. **How the run gets the package: arguments and environment, both held by the dispatcher.**
    - `StartOptions` and `SessionActorDeps` gain `args`, as they gained `env` (spec §2.4 item 3).
    - The CLI driver puts them after `agent.args` and before its own flags: `bytesec run -m <model> --agent <role> --format json --dir <ws> -y -- <prompt>`. Every turn's process gets them.
    - The ACP driver refuses non-empty `args`: the codebase refuses mismatches rather than degrade quietly.
    - The registry asks a new `argsFor` hook after `envFor`. It is a second hook rather than a change to `envFor`'s type, so `envFor` keeps its one refusal path and its callers do not change.
    - The environment goes through the existing `envFor`, as `{ ...rendered.env, MT_KANBAN_RUN }`, so plan C3's token joins it in one place.
13. **`BYTESEC_NO_GLOBAL_APM` is not set.** The spike showed no effect: the user's global skill loaded with it set.
14. **A native run's prompt leaves out `# Your role` and `# Skills`, and nothing else.**
    - From `# How to work` on, it is byte for byte what an injected run gets.
    - The protocol's precedence line stays. It says the rules "come after your role instructions", which is still true: they are now the system prompt.
    - The brief still carries `roleMd` and `skills`.
15. **The package is not masked.**
    - It holds only the operator's files, `role.md` and the skills, which are not masked in a prompt either (C2 Decision 14).
    - A secret an operator typed into `role.md` reaches the agent either way. If it is a known value, the masker still masks it in what the agent writes back.
    - No `.env` is copied.
    - The package's path, in `BYTESEC_LOCAL_APM_PATH`, is not a secret and is not added to the masker.
16. **The renderer interface is four functions**:
    - `handles(role)`: is the role's agent this renderer's;
    - `refuses(role)`: why not this one, or undefined;
    - `files(role, roleMdBytes, skills)`: the package's files;
    - `launch(role, dir)`: `{ args, env }`.

    `RENDERERS` lists them in order. Reading skills and writing packages is shared, in `native.ts`. A Claude Code renderer is one more entry.
17. **A failed render falls back to prompt injection, with a note in the log.** It does not fail the run:
    - the claim has just read every file, so the run can still be told everything;
    - failing it would count a disk or permissions problem against the task's `failure_limit`;
    - the operator sees the note: `kanban: run <id>: rendering role <name> for bytesec failed, so its role.md and skills go in the prompt: <error>`.

    A sweep that fails is noted, and changes nothing else.
18. **`mt role check` prints one line a role when the check passes**, from the same `nativeFor` the dispatcher uses:
    - `native: role implementer runs as a bytesec agent package`;
    - `native: role default does not: it has no role.md and no skills`.

    With a role named, only that role's line is printed. On a failed check there is no team, so no lines.
19. **The default-instructions risk: render by default, keep `agent.native: false` as the operator's escape hatch, and add nothing to the package to restore bytesec's defaults.** *For the user to confirm.*
    - From the code (see the spike): `mode: primary` with a body replaces only bytesec's default identity paragraph. The provider prompt and `AGENT_GUIDELINES` stay.
    - Restoring that paragraph would tell a coding role it is "the default security agent for the ByteSec platform", which is the part a role should replace.
    - What is not known is whether real coding work gets worse under a short `role.md` persona. The plan ends with a manual smoke test against real bytesec, and the operator should watch the first real tasks.
    - If they degrade, `agent.native: false` restores injection for that role without a code change.
20. **A run's `agent_config` does not record whether the run was native.** *For the user to confirm.*
    - The snapshot is taken in the claim's transaction, before the render, and a render can still fall back.
    - The log line `kanban: run <id> runs role <name> as a native bytesec agent` says which runs were. The run's `role_md_hash` keeps its meaning.
    - C4's rework seeding compares `agent_config`, so it treats a native and an injected run of one agent as the same agent. Both resume nothing under the CLI driver until plan E.
21. **The package's details.**
    - The description, in `apm.json` and the front matter, is the role's `description` flattened to one line, or `the <role> role`. It is written as a JSON string, which YAML reads as a double-quoted scalar.
    - The agent body is the raw `role.md` bytes, untrimmed. The prompt trims them, but here they are a file, not part of a larger text.

## Out of scope (later plans)

- **A Claude Code renderer.** A second `Renderer` in `RENDERERS`; its format and launch need their own spike.
- **Rendering for ACP agents**, including `bytesec acp`.
- **Tool policies through the package.** A bytesec agent's front matter can carry `tools` and `permission`. Whether they hold under `run -y` is untested, so `tools` stays refused at startup for every driver (spec §2.2).
- **Hiding the user's global skills** from a rendered role. No switch the spike tried does it.
- **Verifying a package with bytesec.** `bytesec agent list` does not show override packages.
- **Recording native rendering in `agent_config`** (Decision 20).

### Known limitations, not fixed here

- A rendered role also gets the user's global bytesec skills, such as `bytedcli`.
- The fallback covers a render that fails, not a bytesec that rejects a package it was given, for example after an upgrade that changes the lookup. Such a run's turn fails and is classified like any other failure (spec §8.1). `agent.native: false` is the operator's way out.
- The spike and the code reading are of bytesec 0.7.4 only.
- A role edited several times while its runs are open keeps one package per open version until those runs close and the role renders again.
- A skill's symlinked files are not copied, and a skill whose `SKILL.md` is a symlink makes the whole role fall back to injection for that run. Either is reported only in the log, not by `mt role check`, which reads no skill files beyond what startup reads.
- Rendering reads every skill file at each claim, synchronously, up to 16 MiB.

### What later plans need

- **C3:**
  - a run's environment is `{ ...rendered?.env, MT_KANBAN_RUN }` in `Dispatcher.#drive`; the token, socket and `PATH` join it there;
  - nudges and forwarded comments are new turns in the same session, and the CLI driver gives every turn the session's `args`, so a nudged native run stays native;
  - the CLI driver's replayed history now carries a shorter first prompt for a native run, which leaves more room for the transcript.
- **C4:**
  - review and rework runs are rendered like work runs, from the reviewer's or the implementer's role;
  - rework seeding compares `agent_config`, which is the same for native and injected runs (Decision 20).
- **A Claude Code renderer:** implement `Renderer` in `src/render/`, add it to `RENDERERS` in `src/render/native.ts`, and give its CLI driver per-session `args` as Task 3 does here, or launch through the environment only.

## File structure

| File | Responsibility |
|---|---|
| `src/names.ts` (modify) | the grammar without a trailing `-` |
| `src/config.ts` (modify) | `AgentConfig.native` |
| `src/roles.ts` (modify) | reading `agent.native` from a role's `config.yaml` |
| `src/driver/types.ts` (modify) | `StartOptions.args` |
| `src/driver/cli/driver.ts` (modify) | a session's `args` after the configured ones |
| `src/driver/acp/driver.ts` (modify) | refusing per-session `args` |
| `src/core/session-actor.ts` (modify) | `SessionActorDeps.args`, passed to every start |
| `src/core/registry.ts` (modify) | the `argsFor` hook |
| `src/render/types.ts` (create) | `Renderer`, `PackageFile`, `SkillFiles`, `Launch` |
| `src/render/bytesec.ts` (create) | `bytesecRenderer` |
| `src/render/native.ts` (create) | `RENDERERS`, `nativeFor`, `renderNative`, `sweepRole`, `sweepRoles`, `packageHash` |
| `src/kanban/service.ts` (modify) | `Claimed.roleMdBytes` |
| `src/kanban/prompt.ts`, `src/kanban/brief.ts` (modify) | `RunBrief.native`; the prompt without `role.md` and the skills |
| `src/kanban/dispatcher.ts` (modify) | rendering after the claim, `argsFor`, the sweeps, the fallback |
| `src/index.ts` (modify) | `renderRoot` and `argsFor` wired |
| `src/cli/role.ts` (modify) | `mt role check`'s `native:` lines |
| `README.md` (modify) | the name grammar; native rendering; `mt role check` |
| `tests/render-bytesec.test.ts`, `tests/render-native.test.ts`, `tests/kanban-dispatch-native.test.ts` (create) | |
| `tests/names.test.ts`, `tests/roles.test.ts`, `tests/config.test.ts`, `tests/driver-build.test.ts`, `tests/cli-driver.e2e.ts`, `tests/fakes/cli-agent.mjs`, `tests/registry.test.ts`, `tests/workspaces.test.ts`, `tests/kanban-service.test.ts`, `tests/kanban-prompt.test.ts`, `tests/kanban-brief.test.ts`, `tests/helpers/dispatch.ts`, `tests/mt-role.test.ts` (modify) | |

Running counts, unit then end to end: Task 1 932 / 49, Task 2 934 / 49, Task 3 935 / 51, Task 4 937, Task 5 943, Task 6 956, Task 7 956, Task 8 958, Task 9 963, Task 10 965 / 51.

---

### Task 1: A name may not end in `-`

**Files:**
- Modify: `src/names.ts`, `tests/names.test.ts`, `README.md`

The role and workspace grammar loses a trailing `-` (Decision 6). `NAME_PATTERN` becomes `^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$`: a letter first, a letter or digit last, at most 40 characters. Every role name is then also a valid bytesec package name (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`), which the package is named after. `--` inside a name stays allowed, as bytesec's package pattern allows it. One function checks both kinds of name, so roles at discovery and in `mt role create`, and workspaces at startup and in `mt workspace add`, all change with it.

The live home was checked, read-only: `~/.manus-team` has no `roles/` directory, and its config has one workspace, from `workspace:`, named `default`. Nothing it holds is refused.

- [ ] **Step 1.1: Write the failing tests.**

In `tests/names.test.ts`, replace:

```ts
    for (const name of ['default', 'implementer', 'docs-writer', 'r2', 'a'.repeat(40)]) {
```

with:

```ts
    for (const name of ['default', 'implementer', 'docs-writer', 'r2', 'a', 'a--b', 'a'.repeat(40)]) {
```

In `tests/names.test.ts`, replace:

```ts
  it('refuses anything else, and says why', () => {
```

with:

```ts
  it("refuses a name ending in '-', which bytesec would refuse as an agent's name", () => {
    for (const name of ['x-', 'docs-', `${'a'.repeat(39)}-`]) {
      expect(nameProblem('role', name)).toMatch(/role name .* must be lowercase .*not end with '-'/);
    }
  });

  it('refuses anything else, and says why', () => {
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/names.test.ts`. Expected: the new test FAILS, with `TypeError: .toMatch() expects to receive a string, but got undefined` (`x-` is still accepted), and `Tests  1 failed | 3 passed (4)`.

- [ ] **Step 1.3: Implement.**

In `src/names.ts`, replace:

```ts
 * principal, `lark:…`), or upper case (two names differing only by case).
 */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
```

with:

```ts
 * principal, `lark:…`), or upper case (two names differing only by case). It
 * may not end in `-`, so a role's name is also a valid bytesec package name
 * (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`), which native rendering needs.
 */
export const NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
```

In `src/names.ts`, replace:

```ts
    'start with a letter, and be at most 40 characters'
```

with:

```ts
    "start with a letter, not end with '-', and be at most 40 characters"
```

In `README.md`, replace:

```md
gateway at startup. Role and workspace names are lowercase letters, digits and `-`, start
with a letter, and are at most 40 characters; `acp` and `structured-cli` are reserved as
```

with:

```md
gateway at startup. Role and workspace names are lowercase letters, digits and `-`, start
with a letter, do not end with `-`, and are at most 40 characters; `acp` and `structured-cli` are reserved as
```

- [ ] **Step 1.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  932 passed (932)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 1.5: Commit.**

```bash
git add src/names.ts tests/names.test.ts README.md
git commit -m "Refuse a role or workspace name that ends in a hyphen"
```

---

### Task 2: `agent.native` in a role's config

**Files:**
- Modify: `src/config.ts`, `src/roles.ts`, `tests/roles.test.ts`, `tests/config.test.ts`

A role directory's `config.yaml` may say `agent.native: false` to keep its `role.md` and skills in the task prompt (Decision 3). `AgentConfig` gains an optional `native`, set only when the file gives it, so every existing `AgentConfig` literal and `toEqual` stays as it is. The legacy `agent:` block does not accept the key: its role has no `role.md` and no skills. Its test passes already, and pins that boundary.

- [ ] **Step 2.1: Write the failing tests.**

In `tests/roles.test.ts`, replace:

```ts
  it('requires every passEnv name to be set', () => {
```

with:

```ts
  it('reads agent.native, which only a role directory has', () => {
    role('plain', AGENT);
    role('injected', `${AGENT}  native: false\n`);
    expect(load('plain').role.agent.native).toBeUndefined();
    expect(load('injected').role.agent.native).toBe(false);
    role('bad', `${AGENT}  native: no\n`);
    expect(() => load('bad')).toThrow(/agent\.native must be true or false, got "no"/);
  });

  it('requires every passEnv name to be set', () => {
```

In `tests/config.test.ts`, replace:

```ts
  it('refuses a value of the wrong type', () => {
    expect(() => load({}, yamlFile({ auth: { talk: 'ou_a' } }))).toThrow('auth.talk must be a list');
```

with:

```ts
  it("refuses agent.native in the agent: block, whose role has no role.md or skills to render", () => {
    expect(() => load({}, yamlFile({ agent: { native: false } }))).toThrow(/unknown setting agent\.native \(known: driver, /);
  });

  it('refuses a value of the wrong type', () => {
    expect(() => load({}, yamlFile({ auth: { talk: 'ou_a' } }))).toThrow('auth.talk must be a list');
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/roles.test.ts tests/config.test.ts`. Expected: the roles test FAILS, with `ConfigError: …/injected/config.yaml: unknown setting agent.native (known: driver, command, args, unsupervised, passEnv, readOnlyTools, maskExempt)`; the config test passes; and `Tests  1 failed | 95 passed (96)`.

- [ ] **Step 2.3: Implement.**

In `src/config.ts`, replace:

```ts
  /** Environment names whose values are not secret, so not masked (spec §10.1). */
  maskExempt: readonly string[];
}
```

with:

```ts
  /** Environment names whose values are not secret, so not masked (spec §10.1). */
  maskExempt: readonly string[];
  /**
   * A role directory's `agent.native`. Unset or true, a role whose agent has a
   * renderer runs as a native agent package; false keeps its role.md and skills
   * in the task prompt (spec §2.2, plan R). The `agent:` block has no such key:
   * its role has no role.md and no skills to render.
   */
  native?: boolean;
}
```

In `src/roles.ts`, replace:

```ts
    ['driver', 'command', 'args', 'unsupervised', 'passEnv', 'readOnlyTools', 'maskExempt'],
```

with:

```ts
    ['driver', 'command', 'args', 'unsupervised', 'passEnv', 'readOnlyTools', 'maskExempt', 'native'],
```

In `src/roles.ts`, replace:

```ts
  const maskExempt = strings(configPath, 'agent.maskExempt', agentRaw['maskExempt']);
  return {
```

with:

```ts
  const maskExempt = strings(configPath, 'agent.maskExempt', agentRaw['maskExempt']);
  const native = bool(configPath, 'agent.native', agentRaw['native']);
  return {
```

In `src/roles.ts`, replace:

```ts
        readOnlyTools: strings(configPath, 'agent.readOnlyTools', agentRaw['readOnlyTools']),
        maskExempt,
      },
```

with:

```ts
        readOnlyTools: strings(configPath, 'agent.readOnlyTools', agentRaw['readOnlyTools']),
        maskExempt,
        ...(native === undefined ? {} : { native }),
      },
```

- [ ] **Step 2.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  934 passed (934)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 2.5: Commit.**

```bash
git add src/config.ts src/roles.ts tests/roles.test.ts tests/config.test.ts
git commit -m "Let a role opt out of native rendering with agent.native: false"
```

---

### Task 3: A session's own arguments reach its agent's command line

**Files:**
- Modify: `src/driver/types.ts`, `src/driver/cli/driver.ts`, `src/driver/acp/driver.ts`, `tests/fakes/cli-agent.mjs`, `tests/cli-driver.e2e.ts`, `tests/driver-build.test.ts`

`StartOptions` gains `args`: extra arguments for one session's agent, as `env` is extra environment (Decision 12). The CLI driver puts them after the configured `agent.args` (the subcommand and model) and before its own flags, so `bytesec run -m <model> --agent implementer --format json --dir <ws> -y -- <prompt>`. The CLI driver spawns a process per turn, and every turn gets them. The ACP driver refuses any: nothing renders for an ACP agent, and starting one without the arguments its session was given would run a different agent.

The fake CLI agent's log line gains `apm`, the value of `BYTESEC_LOCAL_APM_PATH` in its environment, so the end-to-end test sees both halves of what a native run is given. No test runs real bytesec.

- [ ] **Step 3.1: Write the failing tests.**

In `tests/fakes/cli-agent.mjs`, replace:

```js
 * Every invocation appends its argv to `FAKE_CLI_LOG` as one JSON line. That file
 * is how a test sees the composed prompt -- which is the whole of this driver's
 * session handling, and otherwise invisible.
 */
```

with:

```js
 * Every invocation appends its argv to `FAKE_CLI_LOG` as one JSON line. That file
 * is how a test sees the composed prompt -- which is the whole of this driver's
 * session handling, and otherwise invisible. The line also carries the one
 * environment variable a native package is named by, `BYTESEC_LOCAL_APM_PATH`,
 * as `apm` (null when unset).
 */
```

In `tests/fakes/cli-agent.mjs`, replace:

```js
  appendFileSync(LOG, `${JSON.stringify({ argv, prompt })}\n`);
```

with:

```js
  const apm = process.env['BYTESEC_LOCAL_APM_PATH'] ?? null;
  appendFileSync(LOG, `${JSON.stringify({ argv, prompt, apm })}\n`);
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
  /** One entry per process the driver started, in order. */
  invocations(): Array<{ argv: string[]; prompt: string }>;
```

with:

```ts
  /** One entry per process the driver started, in order. */
  invocations(): Array<{ argv: string[]; prompt: string; apm: string | null }>;
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
  opts: { replay?: PromptInput[]; maxPromptBytes?: number } = {},
```

with:

```ts
  opts: {
    replay?: PromptInput[];
    maxPromptBytes?: number;
    args?: string[];
    env?: Record<string, string>;
  } = {},
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
  const started = await driver.start({ cwd: dir, replay: opts.replay });
```

with:

```ts
  const started = await driver.start({ cwd: dir, replay: opts.replay, args: opts.args, env: opts.env });
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
        .map((line) => JSON.parse(line) as { argv: string[]; prompt: string });
```

with:

```ts
        .map((line) => JSON.parse(line) as { argv: string[]; prompt: string; apm: string | null });
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
  it('maps a tool call through its states under one id', async () => {
```

with:

```ts
  it("puts a session's own arguments after the configured ones, and its environment in the agent's", async () => {
    // How a kanban run reaches its role's native agent package (plan R).
    const s = await start('basic', { args: ['--agent', 'implementer'], env: { BYTESEC_LOCAL_APM_PATH: '/pkg/a' } });
    await collect(s.runtime.prompt(said('go')));
    await collect(s.runtime.prompt(said('again')));

    // Every turn is a process, and each is given them.
    for (const { argv, apm } of s.invocations()) {
      // argv after the script: the configured args are the script itself here.
      expect(argv.slice(0, 3)).toEqual(['--agent', 'implementer', '--format']);
      expect(apm).toBe('/pkg/a');
    }
    expect(s.invocations()).toHaveLength(2);
  });

  it('gives an agent no extra arguments, and no package, when the session has none', async () => {
    const s = await start('basic');
    await collect(s.runtime.prompt(said('go')));
    expect(s.invocations()[0]?.argv[0]).toBe('--format');
    expect(s.invocations()[0]?.apm).toBeNull();
  });

  it('maps a tool call through its states under one id', async () => {
```

In `tests/driver-build.test.ts`, replace:

```ts
describe('buildRoleDrivers', () => {
```

with:

```ts
describe('the acp driver and per-session arguments', () => {
  it('refuses them before it starts anything: nothing renders for an acp agent', async () => {
    const acp = buildDriver(agent({ driver: 'acp', unsupervised: false }));
    await expect(acp.start({ cwd: tmpdir(), args: ['--agent', 'implementer'] })).rejects.toThrow(
      'the acp driver takes no per-session arguments; only a structured-cli agent is given them',
    );
    // An empty list is no arguments: the start goes on, and fails on the missing binary.
    await expect(acp.start({ cwd: tmpdir(), args: [] })).rejects.toThrow(/ACP session failed to start/);
  });
});

describe('buildRoleDrivers', () => {
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/driver-build.test.ts`. Expected: the new test FAILS, with `expected [Function] to throw error including 'the acp driver takes no per-session a…' but got 'ACP session failed to start: ACP conn…'`, and `Tests  1 failed | 3 passed (4)`. Then run `npx vitest run --project e2e tests/cli-driver.e2e.ts`. Expected: the first new test FAILS, with `expected [ '--format', 'json', '--dir' ] to deeply equal [ Array(3) ]`; the second passes already; and `Tests  1 failed | 26 passed (27)`.

- [ ] **Step 3.3: Implement.**

In `src/driver/types.ts`, replace:

```ts
   * How a run's `MT_KANBAN_*` variables reach the agent (spec §2.4 item 3).
   */
  env?: Readonly<Record<string, string>> | undefined;
}
```

with:

```ts
   * How a run's `MT_KANBAN_*` variables reach the agent (spec §2.4 item 3).
   */
  env?: Readonly<Record<string, string>> | undefined;
  /**
   * Extra arguments for this session's agent, after the driver's own `args`:
   * how a kanban run names the native agent package its role was rendered into
   * (`--agent <role>`, plan R). Only the structured-CLI driver takes them; the
   * ACP driver refuses any, rather than start an agent without them.
   */
  args?: readonly string[] | undefined;
}
```

In `src/driver/cli/driver.ts`, replace:

```ts
  #env: Readonly<Record<string, string>>;
  #history: Exchange[];
```

with:

```ts
  #env: Readonly<Record<string, string>>;
  /** This session's own arguments, after the configured ones (StartOptions.args). */
  #args: readonly string[];
  #history: Exchange[];
```

In `src/driver/cli/driver.ts`, replace:

```ts
    this.#env = opts.env ?? {};
    this.#maxPromptBytes = config.maxPromptBytes ?? MAX_PROMPT_BYTES;
```

with:

```ts
    this.#env = opts.env ?? {};
    this.#args = opts.args ?? [];
    this.#maxPromptBytes = config.maxPromptBytes ?? MAX_PROMPT_BYTES;
```

In `src/driver/cli/driver.ts`, replace:

```ts
    const args = [
      ...this.#config.args,
      // The parsing contract. Passed by the driver rather than left to the
```

with:

```ts
    const args = [
      ...this.#config.args,
      // This session's own, such as the native agent a kanban run is given. After
      // the subcommand and model the operator configured, before the driver's
      // flags, so none of them can displace the parsing contract or the prompt.
      ...this.#args,
      // The parsing contract. Passed by the driver rather than left to the
```

In `src/driver/acp/driver.ts`, replace:

```ts
    async start(opts: StartOptions) {
      return startAcpSession(config, opts);
```

with:

```ts
    async start(opts: StartOptions) {
      // Nothing renders for an ACP agent, so a session given its own arguments is
      // a mistake: starting without them would quietly run a different agent.
      if (opts.args !== undefined && opts.args.length > 0) {
        throw new Error('the acp driver takes no per-session arguments; only a structured-cli agent is given them');
      }
      return startAcpSession(config, opts);
```

- [ ] **Step 3.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  935 passed (935)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  51 passed (51)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 3.5: Commit.**

```bash
git add src/driver/types.ts src/driver/cli/driver.ts src/driver/acp/driver.ts tests/fakes/cli-agent.mjs tests/cli-driver.e2e.ts tests/driver-build.test.ts
git commit -m "Give a session's agent arguments of its own, after the configured ones"
```

---

### Task 4: The registry asks for a session's arguments

**Files:**
- Modify: `src/core/session-actor.ts`, `src/core/registry.ts`, `tests/registry.test.ts`

The session layer carries the arguments as it carries the environment (spec §2.4 item 3, amended). `SessionActorDeps` gains `args`, which the actor passes to every start. The registry gains an `argsFor` hook, asked on every actor build right after `envFor`, so the dispatcher can give an open run's agent its `--agent` (Decision 12). It is a second hook, not a change to `envFor`: `envFor` keeps its one job of refusing a run this process did not start, and `argsFor` only reads what an open run holds. The second test passes already, and pins that a session with no arguments gets `undefined`, not `[]`.

- [ ] **Step 4.1: Write the failing tests.**

In `tests/registry.test.ts`, replace:

```ts
    envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
    pinned?: (sessionId: string) => boolean;
  } = {},
```

with:

```ts
    envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
    argsFor?: (sessionId: string) => readonly string[] | undefined;
    pinned?: (sessionId: string) => boolean;
  } = {},
```

In `tests/registry.test.ts`, replace:

```ts
    ...(extra.envFor === undefined ? {} : { envFor: extra.envFor }),
```

with:

```ts
    ...(extra.envFor === undefined ? {} : { envFor: extra.envFor }),
    ...(extra.argsFor === undefined ? {} : { argsFor: extra.argsFor }),
```

In `tests/registry.test.ts`, replace:

```ts
  it('creates a session as a role, in a workspace, seeded from another session', async () => {
```

with:

```ts
  it("asks for the session's own arguments on every build, and passes them to the start", async () => {
    // A kanban run's --agent, for its role's native package (plan R).
    let builds = 0;
    const h = harness(DEFAULT_MAX_LIVE, {
      argsFor: () => {
        builds += 1;
        return ['--agent', `role-${builds}`];
      },
    });
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    const first = await h.registry.actorFor(session.id, key());
    await first.submit({ messageId: 'om_a', appId: 'cli_app', input: { text: 'hi', paths: [] } });
    await h.registry.release(session.id);
    const second = await h.registry.actorFor(session.id, key());
    await second.submit({ messageId: 'om_a2', appId: 'cli_app', input: { text: 'again', paths: [] } });
    expect(h.driver.starts.map((s) => s.args)).toEqual([
      ['--agent', 'role-1'],
      ['--agent', 'role-2'],
    ]);
  });

  it('starts an agent with no arguments of its own when nothing gives any', async () => {
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    const actor = await h.registry.actorFor(session.id, key());
    await actor.submit({ messageId: 'om_n', appId: 'cli_app', input: { text: 'hi', paths: [] } });
    expect(h.driver.starts[0]?.args).toBeUndefined();
  });

  it('creates a session as a role, in a workspace, seeded from another session', async () => {
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/registry.test.ts`. Expected: the first new test FAILS, with `expected [ undefined, undefined ] to deeply equal [ [ '--agent', 'role-1' ], …(1) ]`, and `Tests  1 failed | 61 passed (62)`.

- [ ] **Step 4.3: Implement.**

In `src/core/session-actor.ts`, replace:

```ts
  /** Extra environment for this session's agent, passed to every start (spec §2.4 item 3). */
  env?: Readonly<Record<string, string>> | undefined;
  clock?: Clock;
```

with:

```ts
  /** Extra environment for this session's agent, passed to every start (spec §2.4 item 3). */
  env?: Readonly<Record<string, string>> | undefined;
  /** Extra arguments for this session's agent, passed to every start (plan R). */
  args?: readonly string[] | undefined;
  clock?: Clock;
```

In `src/core/session-actor.ts`, replace:

```ts
  readonly #env: Readonly<Record<string, string>> | undefined;
  readonly #clock: Clock;
```

with:

```ts
  readonly #env: Readonly<Record<string, string>> | undefined;
  readonly #args: readonly string[] | undefined;
  readonly #clock: Clock;
```

In `src/core/session-actor.ts`, replace:

```ts
    this.#env = deps.env;
```

with:

```ts
    this.#env = deps.env;
    this.#args = deps.args;
```

In `src/core/session-actor.ts`, replace:

```ts
        env: this.#env,
      });
```

with:

```ts
        env: this.#env,
        args: this.#args,
      });
```

In `src/core/registry.ts`, replace:

```ts
  envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
  /**
   * Sessions never retired as idle to make room: an open kanban run's (spec §2.4
```

with:

```ts
  envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
  /**
   * Extra arguments for a session's agent, asked on every actor build, after
   * `envFor`: a kanban run's `--agent <role>` when its role was rendered as a
   * native agent package (plan R). Held by the dispatcher, as the environment is.
   */
  argsFor?: (sessionId: string) => readonly string[] | undefined;
  /**
   * Sessions never retired as idle to make room: an open kanban run's (spec §2.4
```

In `src/core/registry.ts`, replace:

```ts
    const env = this.#deps.envFor?.(sessionId);

    await this.#makeRoom();
```

with:

```ts
    const env = this.#deps.envFor?.(sessionId);
    const args = this.#deps.argsFor?.(sessionId);

    await this.#makeRoom();
```

In `src/core/registry.ts`, replace:

```ts
      ...(env === undefined ? {} : { env }),
      clock: this.#clock,
```

with:

```ts
      ...(env === undefined ? {} : { env }),
      ...(args === undefined ? {} : { args }),
      clock: this.#clock,
```

- [ ] **Step 4.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  937 passed (937)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 4.5: Commit.**

```bash
git add src/core/session-actor.ts src/core/registry.ts tests/registry.test.ts
git commit -m "Ask for a session's own agent arguments on every actor build"
```

---

### Task 5: bytesec's renderer

**Files:**
- Create: `src/render/types.ts`, `src/render/bytesec.ts`, `tests/render-bytesec.test.ts`

The renderer interface and bytesec's renderer (Decisions 2, 5 and 16). A `Renderer` says which roles' agents are its own (`handles`), why one of those cannot be rendered (`refuses`), what files the package holds (`files`), and how a run uses it (`launch`). It reads no files and writes none: `./native.ts`, in Task 6, does that. The layout is copied from a real bytesec package, which the spike loaded:
- `apm.json`: `{"name": "<role>", "description": "...", "source": "default", "path": ""}`;
- `agents/<role>.md`: front matter `name`, `description` and `mode: primary`, then the `role.md` bytes, unchanged;
- `skills/<skill>/…`: every file of each skill.

The description is the role's `description`, flattened to one line, or `the <role> role`. It is written as a JSON string, which YAML reads as a double-quoted scalar, so a colon or a quote cannot break the front matter.

- [ ] **Step 5.1: Write the failing tests.**

Create `tests/render-bytesec.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bytesecRenderer } from '../src/render/bytesec.js';
import type { AgentConfig } from '../src/config.js';
import type { Role } from '../src/roles.js';

/**
 * bytesec's renderer: which roles it takes, and the package a role becomes --
 * the layout copied from a real bytesec 0.7.4 package, which the spike loaded.
 */

function role(name: string, extra: Partial<Role> = {}, agent: Partial<AgentConfig> = {}): Role {
  return {
    name,
    source: 'directory',
    dir: `/roles/${name}`,
    description: undefined,
    workspace: undefined,
    agent: {
      driver: 'structured-cli',
      command: 'bytesec',
      args: ['run', '-m', 'model-a'],
      env: {},
      unsupervised: true,
      passEnv: [],
      readOnlyTools: [],
      maskExempt: [],
      ...agent,
    },
    roleMdPath: `/roles/${name}/role.md`,
    skills: [],
    secretValues: [],
    ...extra,
  };
}

const skill = (name: string) => ({ name, description: 'd', dir: `/s/${name}`, path: `/s/${name}/SKILL.md` });

function text(files: ReturnType<typeof bytesecRenderer.files>): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.path, f.bytes.toString('utf8')]));
}

describe('bytesecRenderer: which roles', () => {
  it('handles a structured-cli agent whose command is bytesec, by its basename', () => {
    expect(bytesecRenderer.handles(role('implementer'))).toBe(true);
    expect(bytesecRenderer.handles(role('implementer', {}, { command: '/opt/bin/bytesec' }))).toBe(true);
    // A wrapper may not pass --agent or the environment on.
    expect(bytesecRenderer.handles(role('implementer', {}, { command: 'bytesec-wrapper' }))).toBe(false);
    expect(bytesecRenderer.handles(role('implementer', {}, { driver: 'acp', command: 'bytesec' }))).toBe(false);
  });

  it('renders a role it handles unless something stands in the way, and says what', () => {
    expect(bytesecRenderer.refuses(role('implementer'))).toBeUndefined();
    expect(bytesecRenderer.refuses(role('bytesec-agent'))).toBe(
      'bytesec keeps the agent name bytesec-agent for its own agent',
    );
    expect(bytesecRenderer.refuses(role('implementer', {}, { args: ['run', '--agent', 'other'] }))).toBe(
      'its agent.args already choose a bytesec agent with --agent',
    );
    expect(bytesecRenderer.refuses(role('implementer', {}, { args: ['run', '--agent=other'] }))).toMatch(/--agent/);
    expect(bytesecRenderer.refuses(role('implementer', {}, { env: { BYTESEC_LOCAL_APM_PATH: '/p' } }))).toBe(
      'its environment already sets BYTESEC_LOCAL_APM_PATH',
    );
    expect(bytesecRenderer.refuses(role('implementer', {}, { env: { OPENCODE_LOCAL_APM_PATH: '/p' } }))).toBe(
      'its environment already sets OPENCODE_LOCAL_APM_PATH',
    );
    expect(bytesecRenderer.refuses(role('Bad-'))).toBe('bytesec cannot name an agent "Bad-"');
  });

  it("refuses a role with a skill bytesec cannot load, by bytesec's own rule", () => {
    expect(bytesecRenderer.refuses(role('implementer', { skills: [skill('git-hygiene')] }))).toBeUndefined();
    for (const name of ['Testing', 'a--b', '-x', 'x_y', 'a'.repeat(65)]) {
      expect(bytesecRenderer.refuses(role('implementer', { skills: [skill(name)] }))).toMatch(
        /^bytesec cannot load its skill .*: a bytesec skill name is lowercase/,
      );
    }
  });
});

describe('bytesecRenderer: the package', () => {
  it('writes apm.json, the agent as mode primary with role.md as its body, and the skills', () => {
    const files = bytesecRenderer.files(
      role('implementer', { description: 'Writes: "code"\nwell' }),
      Buffer.from('You change code in this repository.\n'),
      [{ name: 'testing', files: [{ path: 'SKILL.md', bytes: Buffer.from('---\nname: testing\n---\n') }, { path: 'references/ci.md', bytes: Buffer.from('ci') }] }],
    );
    expect(files.map((f) => f.path)).toEqual([
      'apm.json',
      'agents/implementer.md',
      'skills/testing/SKILL.md',
      'skills/testing/references/ci.md',
    ]);
    const t = text(files);
    expect(JSON.parse(t['apm.json'] ?? '')).toEqual({
      name: 'implementer',
      description: 'Writes: "code" well',
      source: 'default',
      path: '',
    });
    expect(t['agents/implementer.md']).toBe(
      '---\nname: implementer\ndescription: "Writes: \\"code\\" well"\nmode: primary\n---\nYou change code in this repository.\n',
    );
    expect(t['skills/testing/references/ci.md']).toBe('ci');
  });

  it("gives role.md's bytes unchanged, and an empty body without one", () => {
    const bytes = Buffer.from([0x68, 0x69, 0xff, 0x0a]);
    const agent = bytesecRenderer.files(role('implementer'), bytes, []).find((f) => f.path === 'agents/implementer.md');
    expect(agent?.bytes.subarray(-4)).toEqual(bytes);
    const bare = text(bytesecRenderer.files(role('implementer', { roleMdPath: undefined }), undefined, []));
    // No body: bytesec keeps its own default identity.
    expect(bare['agents/implementer.md']).toBe('---\nname: implementer\ndescription: "the implementer role"\nmode: primary\n---\n');
  });

  it('launches the package by its directory and the role as the agent', () => {
    expect(bytesecRenderer.launch(role('implementer'), '/home/rendered/implementer/abc')).toEqual({
      args: ['--agent', 'implementer'],
      env: { BYTESEC_LOCAL_APM_PATH: '/home/rendered/implementer/abc' },
    });
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/render-bytesec.test.ts`. Expected: FAIL, with `Error: Cannot find module '../src/render/bytesec.js'`, and `Tests  no tests`.

- [ ] **Step 5.3: Implement.**

Create `src/render/types.ts`:

```ts
import type { Role } from '../roles.js';

/**
 * Native rendering (plan R): a role delivered to its coding agent in the
 * agent's own format -- role.md as its system prompt, the skills through its
 * own skill loading -- instead of in the task prompt (spec §2.2, §7.1).
 *
 * A renderer is one coding agent's format. It decides which roles it takes, and
 * says, as files and launch arguments, what a role becomes; `./native.ts` reads
 * the role's files, writes the package and says where it is. Only bytesec has a
 * renderer; Claude Code's is a later one behind the same interface.
 */

/** One file of a rendered package: its path inside the package, `/`-separated, and its bytes. */
export interface PackageFile {
  path: string;
  bytes: Buffer;
}

/** A skill as rendering reads it: its name, and every regular file under its directory. */
export interface SkillFiles {
  name: string;
  /** Paths relative to the skill's directory. */
  files: readonly PackageFile[];
}

/** What a run is given to use a package: arguments after its agent's own, and environment. */
export interface Launch {
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

export interface Renderer {
  /** Its name in notes and in `mt role check`. */
  readonly id: string;
  /** Whether the role's agent is this renderer's. */
  handles(role: Role): boolean;
  /** Why a role it handles cannot be rendered, or undefined when it can. */
  refuses(role: Role): string | undefined;
  /** The package's files, from the role.md bytes the claim read and the skills as read now. */
  files(role: Role, roleMd: Buffer | undefined, skills: readonly SkillFiles[]): PackageFile[];
  /** How a run uses the package written at `dir`. */
  launch(role: Role, dir: string): Launch;
}
```

Create `src/render/bytesec.ts`:

```ts
import { basename } from 'node:path';
import type { Role } from '../roles.js';
import type { Launch, PackageFile, Renderer, SkillFiles } from './types.js';

/**
 * bytesec's renderer (plan R): a role becomes a bytesec agent package.
 *
 * Verified against bytesec 0.7.4 by a spike, not inferred:
 * - `BYTESEC_LOCAL_APM_PATH=<package dir>` in the agent's environment, with
 *   `bytesec run --agent <name>`, loads the package's agent `agents/<name>.md`.
 *   The package directory is the one holding `apm.json`. Pointed at a directory
 *   of packages instead, bytesec exits 1 and prints nothing, so each run is
 *   pointed at its own role's one package.
 * - The agent file's body becomes the agent's system prompt, in place of the
 *   default agent's identity paragraph; bytesec still adds its provider prompt
 *   and its tool and workspace guidelines around it. Its skills are loaded as
 *   the package's own. An agent from this path wins over a project package of
 *   the same name.
 * - The user's global skills are loaded too: `BYTESEC_NO_GLOBAL_APM=1` did not
 *   hide them, so it is not set.
 */

const COMMAND = 'bytesec';
/** bytesec's own pattern for an agent package's name. */
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** bytesec's own rule for a skill's name: no `--`, at most 64 characters. */
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SKILL_NAME_MAX = 64;
/** Agent names bytesec keeps for itself: `--agent bytesec-agent` runs its built-in agent, not a package. */
const RESERVED = ['bytesec-agent'];
/** The variable naming the package, and the older name bytesec also reads. */
export const APM_PATH = 'BYTESEC_LOCAL_APM_PATH';
const APM_PATH_OLD = 'OPENCODE_LOCAL_APM_PATH';

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export const bytesecRenderer: Renderer = {
  id: 'bytesec',

  /**
   * The structured-CLI driver speaks bytesec's `run --format json` and nothing
   * else, so a role on it whose command is bytesec is a bytesec agent. The
   * basename, not the whole path, so `/opt/bin/bytesec` counts; a wrapper script
   * with another name does not, since it may not pass `--agent` or the
   * environment on.
   */
  handles(role) {
    return role.agent.driver === 'structured-cli' && basename(role.agent.command) === COMMAND;
  },

  refuses(role) {
    if (!PACKAGE_NAME.test(role.name)) return `bytesec cannot name an agent ${JSON.stringify(role.name)}`;
    if (RESERVED.includes(role.name)) return `bytesec keeps the agent name ${role.name} for its own agent`;
    if (role.agent.args.some((a) => a === '--agent' || a.startsWith('--agent='))) {
      return 'its agent.args already choose a bytesec agent with --agent';
    }
    for (const key of [APM_PATH, APM_PATH_OLD]) {
      if (role.agent.env[key] !== undefined) return `its environment already sets ${key}`;
    }
    for (const skill of role.skills) {
      if (!SKILL_NAME.test(skill.name) || skill.name.includes('--') || skill.name.length > SKILL_NAME_MAX) {
        return (
          `bytesec cannot load its skill ${JSON.stringify(skill.name)}: a bytesec skill name is lowercase ` +
          "letters, digits and single '-', not at either end, and at most 64 characters"
        );
      }
    }
    return undefined;
  },

  files(role: Role, roleMd: Buffer | undefined, skills: readonly SkillFiles[]): PackageFile[] {
    const description = oneLine(role.description ?? '') || `the ${role.name} role`;
    const apm = { name: role.name, description, source: 'default', path: '' };
    // JSON strings are YAML double-quoted scalars, so a description holding a
    // colon or a quote cannot break the front matter.
    const matter = ['---', `name: ${role.name}`, `description: ${JSON.stringify(description)}`, 'mode: primary', '---', ''];
    const files: PackageFile[] = [
      { path: 'apm.json', bytes: Buffer.from(`${JSON.stringify(apm, null, 2)}\n`) },
      // role.md as the claim read it, byte for byte: the run records its hash.
      { path: `agents/${role.name}.md`, bytes: Buffer.concat([Buffer.from(matter.join('\n')), roleMd ?? Buffer.alloc(0)]) },
    ];
    for (const skill of skills) {
      for (const f of skill.files) files.push({ path: `skills/${skill.name}/${f.path}`, bytes: f.bytes });
    }
    return files;
  },

  launch(role: Role, dir: string): Launch {
    return { args: ['--agent', role.name], env: { [APM_PATH]: dir } };
  },
};
```

- [ ] **Step 5.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  943 passed (943)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 5.5: Commit.**

```bash
git add src/render/types.ts src/render/bytesec.ts tests/render-bytesec.test.ts
git commit -m "Describe how a role becomes a bytesec agent package"
```

---

### Task 6: Writing a package, and sweeping old ones

**Files:**
- Create: `src/render/native.ts`, `tests/render-native.test.ts`
- Modify: `tests/workspaces.test.ts`

Which roles are rendered (`nativeFor`), writing a package (`renderNative`) and removing old ones (`sweepRole`, `sweepRoles`). Decisions 7–11:
- **Content-addressed.** The directory is `<root>/<role>/<sha256>`, the hash of the package's own files, each path and its bytes length-prefixed. One that exists is used as it is, never rewritten.
- **Atomic.** It is written in a `.stage-` directory beside it, then renamed. A write that fails removes the staging.
- **Regular files only.** A skill's symlinks, FIFOs and sockets are skipped, as are `.env` files. A `SKILL.md` that is not a regular file fails the render, since the skill would arrive without it. More than 16 MiB, or 2,000 files, fails it too: the package is read whole at each claim.
- **Private.** Directories are `0700`, files `0600`. A render root, or a role's directory in it, that is a symlink or a file is refused.
- **Sweeping.** `sweepRole` removes a role's packages except those it is told to keep. `sweepRoles`, at boot, removes the directories of roles no longer configured, and staging left by a process that died.

The workspace test passes already: it pins that `$MT_HOME/rendered`, and a package in it, cannot be a workspace, since inside the home only `workspaces/<name>` may be one (spec §2.3). `src/workspaces.ts` needs no change.

- [ ] **Step 6.1: Write the failing tests.**

Create `tests/render-native.test.ts`:

```ts
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import { bytesecRenderer } from '../src/render/bytesec.js';
import { MAX_PACKAGE_BYTES, nativeFor, packageHash, renderNative, sweepRole, sweepRoles } from '../src/render/native.js';
import type { Role } from '../src/roles.js';

/**
 * Writing a role's native package: content-addressed under the gateway's home,
 * atomic, regular files only, private; and removing the ones nothing uses.
 */

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mt-render-')));
  root = join(base, 'home', 'rendered');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A role directory on disk, with a role.md and one skill. */
function roleOnDisk(name = 'implementer', agent: Partial<AgentConfig> = {}): Role {
  const dir = join(base, 'roles', name);
  const skillDir = join(dir, 'skills', 'testing');
  mkdirSync(join(skillDir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'role.md'), 'You change code in this repository.\n');
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: testing\ndescription: How to test\n---\nRun npm test.\n');
  writeFileSync(join(skillDir, 'references', 'ci.md'), 'ci notes');
  return {
    name,
    source: 'directory',
    dir,
    description: 'Writes code',
    workspace: undefined,
    agent: {
      driver: 'structured-cli',
      command: 'bytesec',
      args: ['run'],
      env: {},
      unsupervised: true,
      passEnv: [],
      readOnlyTools: [],
      maskExempt: [],
      ...agent,
    },
    roleMdPath: join(dir, 'role.md'),
    skills: [{ name: 'testing', description: 'How to test', dir: skillDir, path: join(skillDir, 'SKILL.md') }],
    secretValues: [],
  };
}

const md = (r: Role) => readFileSync(r.roleMdPath ?? '');

/** Every path under `dir`, relative, directories marked with a trailing `/`. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => `${join(e.parentPath, e.name).slice(dir.length + 1)}${e.isDirectory() ? '/' : ''}`)
    .sort();
}

describe('nativeFor', () => {
  it("renders a bytesec role that has a role.md or skills, unless it says not to", () => {
    const r = roleOnDisk();
    expect(nativeFor(r)).toEqual({ ok: true, renderer: bytesecRenderer });
    expect(nativeFor({ ...r, skills: [] })).toMatchObject({ ok: true });
    expect(nativeFor({ ...r, roleMdPath: undefined })).toMatchObject({ ok: true });
    expect(nativeFor({ ...r, agent: { ...r.agent, native: true } })).toMatchObject({ ok: true });
    expect(nativeFor({ ...r, agent: { ...r.agent, native: false } })).toEqual({ ok: false, reason: 'agent.native is false' });
    // The agent: block's role: nothing to render, and chat is as it was.
    expect(nativeFor({ ...r, roleMdPath: undefined, skills: [] })).toEqual({
      ok: false,
      reason: 'it has no role.md and no skills',
    });
  });

  it("says why when the role's agent has no renderer, or its renderer refuses it", () => {
    const r = roleOnDisk();
    expect(nativeFor({ ...r, agent: { ...r.agent, driver: 'acp', command: '/usr/bin/claude-agent-acp' } })).toEqual({
      ok: false,
      reason: 'no renderer for its agent (acp, claude-agent-acp)',
    });
    expect(nativeFor({ ...r, agent: { ...r.agent, args: ['run', '--agent', 'x'] } })).toEqual({
      ok: false,
      reason: 'its agent.args already choose a bytesec agent with --agent',
    });
  });
});

describe('renderNative', () => {
  it("writes the package in the gateway's home, named by its content, and says how to run it", () => {
    const r = roleOnDisk();
    const out = renderNative(root, r, bytesecRenderer, md(r));
    expect(out.dir).toMatch(new RegExp(`^${root}/implementer/[0-9a-f]{64}$`));
    expect(out.args).toEqual(['--agent', 'implementer']);
    expect(out.env).toEqual({ BYTESEC_LOCAL_APM_PATH: out.dir });
    expect(tree(out.dir)).toEqual([
      'agents/',
      'agents/implementer.md',
      'apm.json',
      'skills/',
      'skills/testing/',
      'skills/testing/SKILL.md',
      'skills/testing/references/',
      'skills/testing/references/ci.md',
    ]);
    expect(readFileSync(join(out.dir, 'agents', 'implementer.md'), 'utf8')).toMatch(
      /mode: primary\n---\nYou change code in this repository\.\n$/,
    );
    // Private: the directories 0700, the files 0600.
    for (const d of [root, join(root, 'implementer'), out.dir, join(out.dir, 'skills', 'testing')]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
    expect(statSync(join(out.dir, 'apm.json')).mode & 0o777).toBe(0o600);
  });

  it('reuses a finished package, and gives new content a new directory', () => {
    const r = roleOnDisk();
    const first = renderNative(root, r, bytesecRenderer, md(r));
    writeFileSync(join(first.dir, 'marker'), 'x');
    expect(renderNative(root, r, bytesecRenderer, md(r)).dir).toBe(first.dir);
    // Not rewritten: what is in it stays.
    expect(readdirSync(first.dir)).toContain('marker');

    writeFileSync(join(r.dir ?? '', 'skills', 'testing', 'references', 'ci.md'), 'changed');
    const second = renderNative(root, r, bytesecRenderer, md(r));
    expect(second.dir).not.toBe(first.dir);
    // A run on the old package is not disturbed.
    expect(lstatSync(first.dir).isDirectory()).toBe(true);
  });

  it('renders the role.md bytes the claim read, not the file as it is now', () => {
    const r = roleOnDisk();
    writeFileSync(r.roleMdPath ?? '', 'edited after the claim\n');
    const out = renderNative(root, r, bytesecRenderer, Buffer.from('as claimed\n'));
    expect(readFileSync(join(out.dir, 'agents', 'implementer.md'), 'utf8')).toMatch(/---\nas claimed\n$/);
  });

  it('copies only regular files: no symlink, and no .env', () => {
    const r = roleOnDisk();
    const skillDir = r.skills[0]?.dir ?? '';
    writeFileSync(join(base, 'outside.txt'), 'not the role');
    symlinkSync(join(base, 'outside.txt'), join(skillDir, 'link.txt'));
    symlinkSync(join(base, 'roles'), join(skillDir, 'linked-dir'));
    writeFileSync(join(skillDir, '.env'), 'TOKEN=x');
    const out = renderNative(root, r, bytesecRenderer, md(r));
    expect(tree(join(out.dir, 'skills', 'testing'))).toEqual(['SKILL.md', 'references/', 'references/ci.md']);
  });

  it('fails, leaving nothing behind, when a SKILL.md is a symlink or the package is too large', () => {
    const r = roleOnDisk();
    const skill = r.skills[0]?.path ?? '';
    writeFileSync(join(base, 'real.md'), '---\nname: testing\ndescription: d\n---\n');
    rmSync(skill);
    symlinkSync(join(base, 'real.md'), skill);
    expect(() => renderNative(root, r, bytesecRenderer, md(r))).toThrow(`${skill} is not a regular file`);

    const big = roleOnDisk('big');
    writeFileSync(join(big.skills[0]?.dir ?? '', 'blob.bin'), Buffer.alloc(MAX_PACKAGE_BYTES));
    expect(() => renderNative(root, big, bytesecRenderer, md(big))).toThrow(
      /role big's package would be \d+ bytes; at most 16777216 are rendered/,
    );
    // Both are found before anything is written.
    expect(lstatSync(root, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('removes its staging when a write fails part way, so no package is half written', () => {
    const r = roleOnDisk();
    const twice = {
      ...bytesecRenderer,
      files: () => [
        { path: 'a.md', bytes: Buffer.from('1') },
        { path: 'a.md', bytes: Buffer.from('2') },
      ],
    };
    expect(() => renderNative(root, r, twice, md(r))).toThrow(/EEXIST/);
    expect(readdirSync(join(root, 'implementer'))).toEqual([]);
  });

  it('refuses a rendered directory that is a symlink, and writes nothing through it', () => {
    const r = roleOnDisk();
    mkdirSync(join(base, 'home'), { recursive: true });
    mkdirSync(join(base, 'elsewhere'));
    symlinkSync(join(base, 'elsewhere'), root);
    expect(() => renderNative(root, r, bytesecRenderer, md(r))).toThrow(`${root} is not a directory`);
    expect(readdirSync(join(base, 'elsewhere'))).toEqual([]);
  });

  it('hashes paths and bytes so that moving bytes between files changes it', () => {
    const a = packageHash([{ path: 'a', bytes: Buffer.from('bc') }]);
    expect(packageHash([{ path: 'ab', bytes: Buffer.from('c') }])).not.toBe(a);
    expect(packageHash([{ path: 'a', bytes: Buffer.from('bc') }])).toBe(a);
  });
});

describe('sweeping old packages', () => {
  it("removes a role's packages but those kept, and any staging left behind", () => {
    const r = roleOnDisk();
    const old = renderNative(root, r, bytesecRenderer, Buffer.from('old\n'));
    const held = renderNative(root, r, bytesecRenderer, Buffer.from('held\n'));
    const now = renderNative(root, r, bytesecRenderer, md(r));
    mkdirSync(join(root, 'implementer', '.stage-abc'));
    const other = renderNative(root, roleOnDisk('reviewer'), bytesecRenderer, Buffer.from('r\n'));
    sweepRole(root, 'implementer', new Set([now.dir, held.dir]));
    expect(readdirSync(join(root, 'implementer')).sort()).toEqual([now.dir, held.dir].map((d) => d.slice(-64)).sort());
    expect(lstatSync(old.dir, { throwIfNoEntry: false })).toBeUndefined();
    // Another role's packages are not this sweep's.
    expect(lstatSync(other.dir).isDirectory()).toBe(true);
    // A role with nothing rendered yet is nothing to sweep.
    expect(() => sweepRole(root, 'nobody', new Set())).not.toThrow();
  });

  it("at boot, removes the packages of roles no longer configured, and staging, and keeps each role's own", () => {
    const r = roleOnDisk();
    const kept = renderNative(root, r, bytesecRenderer, md(r));
    renderNative(root, roleOnDisk('retired'), bytesecRenderer, Buffer.from('r\n'));
    mkdirSync(join(root, 'implementer', '.stage-xyz'));
    mkdirSync(join(root, '.stray'));
    sweepRoles(root, new Set(['implementer', 'reviewer']));
    expect(readdirSync(root)).toEqual(['implementer']);
    expect(readdirSync(join(root, 'implementer'))).toEqual([kept.dir.slice(-64)]);
    // Before anything was ever rendered: nothing to do.
    expect(() => sweepRoles(join(base, 'absent'), new Set())).not.toThrow();
  });
});
```

In `tests/workspaces.test.ts`, replace:

```ts
  it('refuses two names for one directory', () => {
```

with:

```ts
  it("refuses the rendered packages, or one of them, as a workspace: they are the home's (plan R)", () => {
    const pkg = join(home, 'rendered', 'implementer', 'a'.repeat(64));
    mkdirSync(pkg, { recursive: true });
    expect(refused({ default: join(home, 'rendered') })).toMatch(/inside the gateway's home, only/);
    expect(refused({ default: pkg })).toMatch(/inside the gateway's home, only/);
  });

  it('refuses two names for one directory', () => {
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/render-native.test.ts tests/workspaces.test.ts`. Expected: `tests/render-native.test.ts` FAILS, with `Error: Cannot find module '../src/render/native.js'`; the workspace tests pass; and `Test Files  1 failed | 1 passed (2)`, `Tests  13 passed (13)`.

- [ ] **Step 6.3: Implement.**

Create `src/render/native.ts`:

```ts
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Role } from '../roles.js';
import { bytesecRenderer } from './bytesec.js';
import type { Launch, PackageFile, Renderer, SkillFiles } from './types.js';

/**
 * Writing a role's native package (plan R), and removing old ones.
 *
 * **Where.** `$MT_HOME/rendered/<role>/<hash>/`, which is itself the package:
 * inside the gateway's home, never in a workspace. A workspace may not contain
 * the home, and inside the home only `workspaces/<name>` may be one (spec §2.3),
 * so an agent's checkout never holds a rendered package, and no package is
 * written into a repository.
 *
 * **Content-addressed.** The hash is of the package's own files, so it covers
 * role.md, every skill file, and whatever the renderer writes around them. Two
 * runs on two versions of a role's files get two directories, and a finished
 * package is never rewritten: one that exists is used as it is.
 *
 * **Atomic.** A package is written in a dot-directory beside it and renamed into
 * place, so a directory with a hash name is always complete.
 *
 * **Only regular files.** A skill's symlinks, FIFOs and sockets are not copied,
 * as `mt role create` copies none; nor is any `.env`. A SKILL.md that is not a
 * regular file fails the render: the skill would arrive without it.
 *
 * **Private.** Directories are 0700 and files 0600.
 */

/** The renderers, in the order they are asked. */
export const RENDERERS: readonly Renderer[] = [bytesecRenderer];

/** The most a package may hold: rendering reads it whole at each claim. */
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 2000;

const STAGING = '.stage-';

export type Native = { ok: true; renderer: Renderer } | { ok: false; reason: string };

/**
 * Whether a role's runs are rendered, and by which renderer, or why not. Read
 * from the role as loaded: rendering itself can still fail, and then the run's
 * role.md and skills go in its prompt.
 */
export function nativeFor(role: Role): Native {
  if (role.agent.native === false) return { ok: false, reason: 'agent.native is false' };
  if (role.roleMdPath === undefined && role.skills.length === 0) {
    return { ok: false, reason: 'it has no role.md and no skills' };
  }
  const renderer = RENDERERS.find((r) => r.handles(role));
  if (renderer === undefined) {
    return { ok: false, reason: `no renderer for its agent (${role.agent.driver}, ${basename(role.agent.command)})` };
  }
  const refused = renderer.refuses(role);
  return refused === undefined ? { ok: true, renderer } : { ok: false, reason: refused };
}

export interface Rendered extends Launch {
  /** The package directory. */
  dir: string;
}

/**
 * Render a role's package under `root` from the role.md bytes the claim read,
 * and say how a run uses it. Throws when it cannot: the caller falls back to
 * the task prompt.
 */
export function renderNative(root: string, role: Role, renderer: Renderer, roleMd: Buffer | undefined): Rendered {
  const files = renderer.files(role, roleMd, role.skills.map(readSkill));
  checkFiles(role, files);
  const roleDir = privateDir(privateDir(root), role.name);
  const dir = join(roleDir, packageHash(files));
  const existing = lstatSync(dir, { throwIfNoEntry: false });
  if (existing === undefined) {
    const staging = mkdtempSync(join(roleDir, STAGING));
    try {
      for (const f of files) {
        const path = join(staging, ...f.path.split('/'));
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, f.bytes, { mode: 0o600, flag: 'wx' });
      }
      renameSync(staging, dir);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
  } else if (!existing.isDirectory()) {
    throw new Error(`${dir} is in the way: it is not a directory`);
  }
  return { dir, ...renderer.launch(role, dir) };
}

/**
 * Remove a role's packages other than those in `keep` -- the one just rendered,
 * and those of runs still open -- and any staging left by a process that died
 * mid-write. A role's newest package therefore stays until its next render.
 */
export function sweepRole(root: string, roleName: string, keep: ReadonlySet<string>): void {
  const roleDir = join(root, roleName);
  for (const entry of entries(roleDir)) {
    const path = join(roleDir, entry);
    if (!keep.has(path)) rmSync(path, { recursive: true, force: true });
  }
}

/**
 * At boot: remove the packages of roles no longer configured, and any staging
 * a process left behind. Nothing is open at boot, so nothing else is in use;
 * each role's other old packages go at its next render.
 */
export function sweepRoles(root: string, roles: ReadonlySet<string>): void {
  for (const entry of entries(root)) {
    const path = join(root, entry);
    if (!roles.has(entry)) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    for (const inner of entries(path)) {
      if (inner.startsWith(STAGING)) rmSync(join(path, inner), { recursive: true, force: true });
    }
  }
}

/** A directory's entries, or none when it is missing. Never follows a symlink. */
function entries(dir: string): string[] {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) return [];
  return readdirSync(dir).sort();
}

/** `parent/name` as a real directory, made 0700 if missing; a symlink or a file is refused. */
function privateDir(parent: string, name?: string): string {
  const dir = name === undefined ? parent : join(parent, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  return dir;
}

/** Every regular file under a skill's directory, but any `.env`; its SKILL.md must be one. */
function readSkill(skill: Role['skills'][number]): SkillFiles {
  if (lstatSync(skill.path, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error(`${skill.path} is not a regular file`);
  }
  const files: PackageFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile() && entry.name !== '.env') files.push({ path: rel, bytes: readFileSync(path) });
    }
  };
  walk(skill.dir, '');
  return { name: skill.name, files };
}

function checkFiles(role: Role, files: readonly PackageFile[]): void {
  if (files.length > MAX_PACKAGE_FILES) {
    throw new Error(`role ${role.name}'s package would hold ${files.length} files; at most ${MAX_PACKAGE_FILES} are rendered`);
  }
  const size = files.reduce((n, f) => n + f.bytes.length, 0);
  if (size > MAX_PACKAGE_BYTES) {
    throw new Error(`role ${role.name}'s package would be ${size} bytes; at most ${MAX_PACKAGE_BYTES} are rendered`);
  }
  for (const f of files) {
    const parts = f.path.split('/');
    if (f.path.startsWith('/') || parts.some((p) => p === '' || p === '.' || p === '..')) {
      throw new Error(`a package file may not be at ${JSON.stringify(f.path)}`);
    }
  }
}

/** sha256 of every file's path and bytes, in path order, each length-prefixed so no two packages hash alike. */
export function packageHash(files: readonly PackageFile[]): string {
  const hash = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${Buffer.byteLength(f.path)}:${f.path}:${f.bytes.length}:`);
    hash.update(f.bytes);
  }
  return hash.digest('hex');
}
```

- [ ] **Step 6.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  956 passed (956)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 6.5: Commit.**

```bash
git add src/render/native.ts tests/render-native.test.ts tests/workspaces.test.ts
git commit -m "Write a role's native package by its content, atomically, and sweep old ones"
```

---

### Task 7: A claim gives the role.md bytes it hashed

**Files:**
- Modify: `src/kanban/service.ts`, `tests/kanban-service.test.ts`

The claim already reads `role.md` once and hashes the bytes (`#claimant`). `Claimed` gains `roleMdBytes`, those same bytes, so the package is rendered from exactly what the run's `role_md_hash` names, even when the file is not UTF-8 or has changed since (Decision 7). It is optional, and absent for a role with no `role.md` and for a person's run, so the existing `Claimed` literals in tests stay as they are. Both edits are to existing tests.

- [ ] **Step 7.1: Write the failing tests.**

In `tests/kanban-service.test.ts`, replace:

```ts
    expect(r.roleMd).toBe('hi\uFFFD\n');
    expect(r.role).toBe(implementer);
```

with:

```ts
    expect(r.roleMd).toBe('hi\uFFFD\n');
    // The bytes themselves too, which a native package is rendered from.
    expect(r.roleMdBytes).toEqual(bytes);
    expect(r.role).toBe(implementer);
```

In `tests/kanban-service.test.ts`, replace:

```ts
    expect(ok(s.claim(task.taskId))).toMatchObject({
      run: { agentConfig: null, roleMdHash: null },
      roleMd: undefined,
      role: undefined,
    });
```

with:

```ts
    const claimed = ok(s.claim(task.taskId));
    expect(claimed).toMatchObject({
      run: { agentConfig: null, roleMdHash: null },
      roleMd: undefined,
      role: undefined,
    });
    expect(claimed).not.toHaveProperty('roleMdBytes');
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-service.test.ts`. Expected: one test FAILS, with `expected undefined to deeply equal Buffer[ 104, 105, 255, 10 ]`, and `Tests  1 failed | 28 passed (29)`.

- [ ] **Step 7.3: Implement.**

In `src/kanban/service.ts`, replace:

```ts
  /** The role.md whose hash the run records, for plan C2's prompt; undefined without one. */
  roleMd: string | undefined;
```

with:

```ts
  /** The role.md whose hash the run records, for plan C2's prompt; undefined without one. */
  roleMd: string | undefined;
  /** The same role.md as the bytes that were hashed, which a native package is rendered from (plan R). */
  roleMdBytes?: Buffer;
```

In `src/kanban/service.ts`, replace:

```ts
      roleMd: resolved.ok ? resolved.roleMd : undefined,
      role: resolved.ok ? resolved.role : undefined,
    };
```

with:

```ts
      roleMd: resolved.ok ? resolved.roleMd : undefined,
      ...(resolved.ok && resolved.roleMdBytes !== undefined ? { roleMdBytes: resolved.roleMdBytes } : {}),
      role: resolved.ok ? resolved.role : undefined,
    };
```

In `src/kanban/service.ts`, replace:

```ts
  #claimant(task: TaskRow): Result<{ claimant: board.Claimant; roleMd: string | undefined; role: Role | undefined }> {
```

with:

```ts
  #claimant(
    task: TaskRow,
  ): Result<{ claimant: board.Claimant; roleMd: string | undefined; roleMdBytes?: Buffer; role: Role | undefined }> {
```

In `src/kanban/service.ts`, replace:

```ts
      roleMd: bytes?.toString('utf8'),
      role,
    };
```

with:

```ts
      roleMd: bytes?.toString('utf8'),
      ...(bytes === undefined ? {} : { roleMdBytes: bytes }),
      role,
    };
```

- [ ] **Step 7.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  956 passed (956)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 7.5: Commit.**

```bash
git add src/kanban/service.ts tests/kanban-service.test.ts
git commit -m "Give a claim the role.md bytes it hashed"
```

---

### Task 8: A native run's prompt leaves role.md and the skills out

**Files:**
- Modify: `src/kanban/prompt.ts`, `src/kanban/brief.ts`, `tests/kanban-prompt.test.ts`, `tests/kanban-brief.test.ts`

`RunBrief` gains `native`, and `briefFor` takes it as an option. A native run's prompt leaves out `# Your role` and `# Skills`, and is otherwise byte for byte the prompt an injected run gets from `# How to work` on (Decision 14). The protocol's precedence line stays: the role's instructions still come before it, now as the system prompt. The brief still carries `roleMd` and `skills`, so what a run was given stays visible in one place.

- [ ] **Step 8.1: Write the failing tests.**

In `tests/kanban-prompt.test.ts`, replace:

```ts
  it('leaves out the role and skills a role does not have', () => {
```

with:

```ts
  it('leaves out the role and the skills a native run was given as its agent package, and keeps the rest', () => {
    const native = composePrompt(
      brief({
        roleMd: 'You change code in this repository.\n',
        skills: [{ name: 'testing', description: 'How to test here', dir: '/r/skills/testing', path: '/r/skills/testing/SKILL.md' }],
        native: true,
      }),
    );
    expect(native).not.toContain('# Your role');
    expect(native).not.toContain('You change code in this repository.');
    expect(native).not.toContain('# Skills');
    expect(native).not.toContain('/r/skills/testing/SKILL.md');
    expect(native.startsWith('# How to work')).toBe(true);
    const order = ['# How to work', '# The task', '# Context'].map((h) => at(native, h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(native).toContain('take precedence over them');
    // Everything after the role and the skills is what an injected prompt has.
    const injected = composePrompt(brief({ roleMd: 'You change code in this repository.\n' }));
    expect(injected.slice(injected.indexOf('# How to work'))).toBe(native);
  });

  it('leaves out the role and skills a role does not have', () => {
```

In `tests/kanban-brief.test.ts`, replace:

```ts
describe('endedUnreported', () => {
```

with:

```ts
describe('briefFor: a native run', () => {
  it("says so, and still carries the role's files, which the prompt then leaves out", () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    const c = { run, task, roleMd: 'Be careful.', role: ROLE };
    expect(briefFor(h.db, c, { native: true })).toMatchObject({ native: true, roleMd: 'Be careful.' });
    expect(briefFor(h.db, c)).not.toHaveProperty('native');
  });
});

describe('endedUnreported', () => {
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-prompt.test.ts tests/kanban-brief.test.ts`. Expected: both new tests FAIL, with `expected '# Your role\n\nYou change code in thi…' not to contain '# Your role'` and `expected { kind: 'work', …(7) } to match object { native: true, roleMd: 'Be careful.' }`, and `Tests  2 failed | 20 passed (22)`.

- [ ] **Step 8.3: Implement.**

In `src/kanban/prompt.ts`, replace:

```ts
/**
 * A run's task prompt (spec §7.1), composed in this order: the role, its skills,
 * the protocol for the run's kind, the task, and the worker context.
 *
```

with:

```ts
/**
 * A run's task prompt (spec §7.1), composed in this order: the role, its skills,
 * the protocol for the run's kind, the task, and the worker context. A run whose
 * role was rendered as a native agent package (plan R) has its role.md as the
 * agent's system prompt and its skills loaded by the agent, so its prompt leaves
 * both out rather than send them twice; the rest is the same.
 *
```

In `src/kanban/prompt.ts`, replace:

```ts
  /** The role.md text, as the claim read the file whose hash the run records; undefined without one. */
  roleMd: string | undefined;
  skills: readonly Skill[];
```

with:

```ts
  /** The role.md text, as the claim read the file whose hash the run records; undefined without one. */
  roleMd: string | undefined;
  skills: readonly Skill[];
  /** The role reached the agent as a native package: role.md and the skills are not in the prompt. */
  native?: boolean;
```

In `src/kanban/prompt.ts`, replace:

```ts
export function composePrompt(b: RunBrief): string {
  const head: string[] = [];
  if (b.roleMd !== undefined && b.roleMd.trim() !== '') head.push('# Your role', '', b.roleMd.trim(), '');
  if (b.skills.length > 0) {
```

with:

```ts
export function composePrompt(b: RunBrief): string {
  const head: string[] = [];
  const injected = b.native !== true;
  if (injected && b.roleMd !== undefined && b.roleMd.trim() !== '') head.push('# Your role', '', b.roleMd.trim(), '');
  if (injected && b.skills.length > 0) {
```

In `src/kanban/brief.ts`, replace:

```ts
export function briefFor(db: Db, c: Claimed): RunBrief {
```

with:

```ts
/** `native`: the run's role was rendered as a native agent package, so its prompt leaves role.md and the skills out. */
export function briefFor(db: Db, c: Claimed, opts: { native?: boolean } = {}): RunBrief {
```

In `src/kanban/brief.ts`, replace:

```ts
    skills: c.role?.skills ?? [],
    task: c.task,
```

with:

```ts
    skills: c.role?.skills ?? [],
    ...(opts.native === true ? { native: true } : {}),
    task: c.task,
```

- [ ] **Step 8.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  958 passed (958)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 8.5: Commit.**

```bash
git add src/kanban/prompt.ts src/kanban/brief.ts tests/kanban-prompt.test.ts tests/kanban-brief.test.ts
git commit -m "Leave role.md and the skills out of a native run's prompt"
```

---

### Task 9: The dispatcher runs a role natively

**Files:**
- Create: `tests/kanban-dispatch-native.test.ts`
- Modify: `src/kanban/dispatcher.ts`, `src/index.ts`, `tests/helpers/dispatch.ts`

The dispatcher renders a run's role and hands the package to its agent (Decisions 7, 10, 12, 17):
- **When.** At the start of `#drive`, before the run's session is created, and synchronously up to the run's entry in `#open`. So when a later run's render sweeps, every open run's package is already marked in use.
- **What the run gets.** Its environment is `{ ...rendered.env, MT_KANBAN_RUN }`, through the existing `envFor`; its arguments are `rendered.args`, through the new `argsFor`; its prompt is composed with `native: true`. `OpenRun` keeps the package directory, so the sweep spares it while the run is open.
- **Failure.** A render that throws is noted, `kanban: run <id>: rendering role <name> for bytesec failed, so its role.md and skills go in the prompt: <error>`, and the run goes on injected. A sweep that throws is noted and changes nothing else.
- **Boot.** After it closes every open run, `boot()` sweeps the packages of roles no longer configured, and any staging.

`DispatcherDeps` gains `renderRoot`. Absent, nothing is rendered, which is why every existing dispatcher test is unchanged: the harness passes it only when a test asks. The harness also wires `argsFor`, and `src/index.ts` gives the gateway's dispatcher `$MT_HOME/rendered` and the registry `argsFor`.

The second test passes already, since injection is today's behaviour. It pins that a role with `agent.native: false`, or a gateway with no render root, keeps it.

- [ ] **Step 9.1: Write the failing tests.**

Create `tests/kanban-dispatch-native.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import type { Role } from '../src/roles.js';
import { completes, dispatchHarness, holds, reportComplete, role, until, type DispatchHarness } from './helpers/dispatch.js';

/**
 * Native rendering in the dispatcher (plan R): a bytesec role with a role.md or
 * skills runs as its own agent package, given by `--agent` and
 * `BYTESEC_LOCAL_APM_PATH`, and its prompt leaves role.md and the skills out.
 */

const open: DispatchHarness[] = [];
let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mt-native-')));
  root = join(base, 'home', 'rendered');
});

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
  rmSync(base, { recursive: true, force: true });
});

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

/** The role implementer, on bytesec, with a role.md and a skill on disk. */
function implementer(extra: Partial<Role['agent']> = {}): Role {
  const dir = join(base, 'roles', 'implementer');
  const skillDir = join(dir, 'skills', 'testing');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(dir, 'role.md'), 'You change code in this repository.\n');
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: testing\ndescription: How to test\n---\nRun npm test.\n');
  const r = role('implementer', {
    dir,
    roleMdPath: join(dir, 'role.md'),
    skills: [{ name: 'testing', description: 'How to test', dir: skillDir, path: join(skillDir, 'SKILL.md') }],
  });
  return { ...r, agent: { ...r.agent, ...extra } };
}

const promptOf = (h: DispatchHarness, i: number) => h.driver('implementer').runtimes[i]?.prompts[0]?.text ?? '';
const packages = () => readdirSync(join(root, 'implementer')).sort();

describe('Dispatcher: native rendering', () => {
  it("runs a bytesec role as its own package: --agent, the package in its environment, and a prompt without its files", async () => {
    const h = harness({ roles: [implementer()], renderRoot: root });
    const task = h.create({ title: 'Write the parser', workspace: 'web' });
    completes(h, h.driver('implementer'));
    h.dispatcher.pass();
    await h.dispatcher.idle();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');
    const start = h.driver('implementer').starts[0];
    expect(start?.args).toEqual(['--agent', 'implementer']);
    const dir = start?.env?.['BYTESEC_LOCAL_APM_PATH'] ?? '';
    expect(dir).toMatch(new RegExp(`^${root}/implementer/[0-9a-f]{64}$`));
    expect(start?.env?.['MT_KANBAN_RUN']).toBe(run?.runId);
    expect(readFileSync(join(dir, 'agents', 'implementer.md'), 'utf8')).toMatch(/---\nYou change code in this repository\.\n$/);
    expect(readFileSync(join(dir, 'skills', 'testing', 'SKILL.md'), 'utf8')).toContain('Run npm test.');

    const prompt = promptOf(h, 0);
    expect(prompt).not.toContain('# Your role');
    expect(prompt).not.toContain('# Skills');
    expect(prompt.startsWith('# How to work')).toBe(true);
    expect(prompt).toContain(`${task.taskId}: Write the parser`);
    expect(h.notes).toContain(`kanban: run ${run?.runId} runs role implementer as a native bytesec agent`);
  });

  it('keeps role.md and the skills in the prompt for a role that opts out, or with no render root', async () => {
    for (const opts of [{ roles: [implementer({ native: false })], renderRoot: root }, { roles: [implementer()] }]) {
      const h = harness(opts);
      h.create({ workspace: 'web' });
      completes(h, h.driver('implementer'));
      h.dispatcher.pass();
      await h.dispatcher.idle();
      const start = h.driver('implementer').starts[0];
      expect(start?.args).toBeUndefined();
      expect(start?.env).toEqual({ MT_KANBAN_RUN: expect.any(String) });
      const prompt = promptOf(h, 0);
      expect(prompt).toContain('# Your role\n\nYou change code in this repository.');
      expect(prompt).toContain(`- testing: How to test (${join(base, 'roles', 'implementer', 'skills', 'testing', 'SKILL.md')})`);
    }
    expect(readdirSync(base)).toEqual(['roles']);
  });

  it('puts role.md and the skills in the prompt when rendering fails, and says so', async () => {
    mkdirSync(join(base, 'home'));
    writeFileSync(root, 'not a directory');
    const h = harness({ roles: [implementer()], renderRoot: root });
    const task = h.create({ workspace: 'web' });
    completes(h, h.driver('implementer'));
    h.dispatcher.pass();
    await h.dispatcher.idle();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(run?.outcome).toBe('completed');
    expect(h.driver('implementer').starts[0]?.args).toBeUndefined();
    expect(promptOf(h, 0)).toContain('# Your role');
    expect(h.notes.join('\n')).toContain(
      `kanban: run ${run?.runId}: rendering role implementer for bytesec failed, so its role.md and skills go in the prompt: `,
    );
  });

  it('gives runs on two versions of role.md their own packages, and removes one once nothing uses it', async () => {
    const r = implementer();
    const h = harness({ roles: [r], renderRoot: root });
    const agent = h.driver('implementer');
    const first = h.create({ title: 'first', workspace: 'web' });
    const held = holds(agent);
    h.dispatcher.pass();
    await until(() => held.started, 'the first run to be working');

    // Edited while the first run works: the next claim reads the new text.
    writeFileSync(r.roleMdPath ?? '', 'You change code, and you test it.\n');
    const second = h.create({ title: 'second', workspace: 'api' });
    completes(h, agent);
    h.dispatcher.pass();
    await until(() => getTask(h.t.db, second.taskId)?.phase === 'done', 'the second task to be done');

    const dirs = agent.starts.map((s) => s.env?.['BYTESEC_LOCAL_APM_PATH'] ?? '');
    const a = dirs[0] ?? '';
    const b = dirs[1] ?? '';
    expect(a).not.toBe(b);
    // The first run is still open, so its package was kept.
    expect(packages()).toEqual([a, b].map((d) => d.slice(-64)).sort());
    expect(readFileSync(join(b, 'agents', 'implementer.md'), 'utf8')).toMatch(/you test it\.\n$/);

    const firstRun = runsOf(h.t.db, first.taskId)[0]?.runId ?? '';
    held.end('completed', () => reportComplete(h, firstRun));
    await h.dispatcher.idle();
    // The next render sweeps: the first package is no longer in use.
    h.create({ title: 'third', workspace: 'web' });
    completes(h, agent);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(agent.starts[2]?.env?.['BYTESEC_LOCAL_APM_PATH']).toBe(b);
    expect(packages()).toEqual([b.slice(-64)]);
  });

  it('at boot, removes the packages of roles no longer configured, and any left half written', async () => {
    const h = harness({ roles: [implementer()], renderRoot: root });
    mkdirSync(join(root, 'retired', 'a'.repeat(64)), { recursive: true });
    mkdirSync(join(root, 'implementer', 'b'.repeat(64)), { recursive: true });
    mkdirSync(join(root, 'implementer', '.stage-x1'));
    await h.dispatcher.boot();
    expect(readdirSync(root)).toEqual(['implementer']);
    expect(packages()).toEqual(['b'.repeat(64)]);
  });
});
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-dispatch-native.test.ts`. Expected: four tests FAIL, for example with `expected undefined to deeply equal [ '--agent', 'implementer' ]` and `expected [ 'implementer', 'retired' ] to deeply equal [ 'implementer' ]`, and `Tests  4 failed | 1 passed (5)`.

- [ ] **Step 9.3: Implement.**

In `tests/helpers/dispatch.ts`, replace:

```ts
  /** Another harness's database: a second gateway process, after a restart. */
  t?: TestDb;
  clock?: ManualClock;
}
```

with:

```ts
  /** Another harness's database: a second gateway process, after a restart. */
  t?: TestDb;
  clock?: ManualClock;
  /** Where roles are rendered natively; absent, none is. */
  renderRoot?: string;
}
```

In `tests/helpers/dispatch.ts`, replace:

```ts
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
```

with:

```ts
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    argsFor: (sessionId) => dispatcher?.argsFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
```

In `tests/helpers/dispatch.ts`, replace:

```ts
    clock,
    note: (line) => notes.push(line),
  });
  return {
```

with:

```ts
    clock,
    note: (line) => notes.push(line),
    ...(opts.renderRoot === undefined ? {} : { renderRoot: opts.renderRoot }),
  });
  return {
```

In `src/kanban/dispatcher.ts`, replace:

```ts
import { getSession } from '../db/sessions.js';
import type { Role } from '../roles.js';
```

with:

```ts
import { getSession } from '../db/sessions.js';
import { nativeFor, renderNative, sweepRole, sweepRoles, type Rendered } from '../render/native.js';
import type { Role } from '../roles.js';
```

In `src/kanban/dispatcher.ts`, replace:

```ts
 * **One agent run is one gateway session** (spec §3.3), created for the run,
 * bound on the `kanban` channel at (task id, run id), and archived when the run
 * closes: a retry or a rework is a new run in a new session.
 */
```

with:

```ts
 * **One agent run is one gateway session** (spec §3.3), created for the run,
 * bound on the `kanban` channel at (task id, run id), and archived when the run
 * closes: a retry or a rework is a new run in a new session.
 *
 * **A role with a renderer runs natively** (plan R). Just after the claim, from
 * the role.md bytes the claim read, the role is rendered as its agent's own
 * package under `renderRoot`; the run is given the package through its
 * environment and arguments, and its prompt leaves role.md and the skills out.
 * A render that fails is noted and the run goes on with them in its prompt
 * instead (spec §7.1): the role's files were readable at the claim, so the run
 * can still be told everything, and failing it would count a disk problem
 * against the task.
 */
```

In `src/kanban/dispatcher.ts`, replace:

```ts
  /** Metadata only: ids, outcomes, counts. Never task text or agent output. */
  note?: (line: string) => void;
}
```

with:

```ts
  /** Metadata only: ids, outcomes, counts. Never task text or agent output. */
  note?: (line: string) => void;
  /**
   * Where roles are rendered as native agent packages: `$MT_HOME/rendered`
   * (plan R). Absent, nothing is, and every run's role.md and skills go in its
   * prompt.
   */
  renderRoot?: string;
}
```

In `src/kanban/dispatcher.ts`, replace:

```ts
  /** The run's environment, held only here (spec §2.4 item 3). */
  env: Readonly<Record<string, string>>;
```

with:

```ts
  /** The run's environment, held only here (spec §2.4 item 3). */
  env: Readonly<Record<string, string>>;
  /** Its agent's own arguments: `--agent <role>` for a native run (plan R), else none. */
  args: readonly string[];
  /** The native package it runs, kept from the sweep while the run is open. */
  packageDir: string | undefined;
```

In `src/kanban/dispatcher.ts`, replace:

```ts
  /** An open run's actor is never retired to make room (spec §2.4 item 3). */
  pinned(sessionId: string): boolean {
```

with:

```ts
  /**
   * A session's own arguments, for the registry to give its agent: an open
   * native run's `--agent <role>` (plan R). Asked after `envFor`, which has
   * already refused a run this process did not start.
   */
  argsFor(sessionId: string): readonly string[] | undefined {
    const args = this.#open.get(sessionId)?.args;
    return args === undefined || args.length === 0 ? undefined : args;
  }

  /** An open run's actor is never retired to make room (spec §2.4 item 3). */
  pinned(sessionId: string): boolean {
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    for (const run of runs) {
      if (run.agentConfig === null) continue;
      await this.#endLost(run, 'the gateway restarted; the run is over');
    }
    await this.#archiveLeftovers();
  }
```

with:

```ts
    for (const run of runs) {
      if (run.agentConfig === null) continue;
      await this.#endLost(run, 'the gateway restarted; the run is over');
    }
    await this.#archiveLeftovers();
    this.#sweepRenders();
  }

  /**
   * After a restart nothing is open, so no package is in use: those of roles no
   * longer configured, and any half-written one, are removed (plan R).
   */
  #sweepRenders(): void {
    const root = this.#deps.renderRoot;
    if (root === undefined) return;
    try {
      sweepRoles(root, new Set(this.#deps.roles.keys()));
    } catch (err) {
      this.#note(`kanban: sweeping the rendered packages after a restart failed: ${message(err)}`);
    }
  }
```

In `src/kanban/dispatcher.ts`, replace:

```ts
  async #drive(claimed: Claimed, handle: RunHandle): Promise<void> {
    const { run } = claimed;
    const key = handle.key;
    let sessionId: string;
```

with:

```ts
  async #drive(claimed: Claimed, handle: RunHandle): Promise<void> {
    const { run } = claimed;
    const key = handle.key;
    // Before the session, and synchronously up to the run's entry in #open, so
    // the sweep of another run's render sees this one's package as in use.
    const rendered = this.#render(claimed);
    let sessionId: string;
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    const open: OpenRun = Object.assign(handle, {
      sessionId,
      env: { MT_KANBAN_RUN: run.runId },
      cancelling: false,
      released: false,
    });
```

with:

```ts
    const open: OpenRun = Object.assign(handle, {
      sessionId,
      env: { ...rendered?.env, MT_KANBAN_RUN: run.runId },
      args: rendered?.args ?? [],
      packageDir: rendered?.dir,
      cancelling: false,
      released: false,
    });
```

In `src/kanban/dispatcher.ts`, replace:

```ts
      const prompt = composePrompt(briefFor(this.#deps.db, claimed));
```

with:

```ts
      const prompt = composePrompt(briefFor(this.#deps.db, claimed, { native: rendered !== undefined }));
```

In `src/kanban/dispatcher.ts`, replace:

```ts
  /**
   * The provider session a rework resumes (spec §2.4 item 5, §5.3): the one the
```

with:

```ts
  /**
   * Render the run's role as its agent's native package (plan R), or undefined
   * when it is not rendered: no render root, a person's run, a role with no
   * renderer or one that opted out -- or a render that failed, which is noted.
   * Then the role's packages that neither this run nor an open one uses are
   * removed, so a role keeps its newest package and those still running.
   */
  #render(claimed: Claimed): Rendered | undefined {
    const root = this.#deps.renderRoot;
    const role = claimed.role;
    if (root === undefined || role === undefined) return undefined;
    const native = nativeFor(role);
    if (!native.ok) return undefined;
    const runId = claimed.run.runId;
    let rendered: Rendered;
    try {
      rendered = renderNative(root, role, native.renderer, claimed.roleMdBytes);
    } catch (err) {
      this.#note(
        `kanban: run ${runId}: rendering role ${role.name} for ${native.renderer.id} failed, ` +
          `so its role.md and skills go in the prompt: ${message(err)}`,
      );
      return undefined;
    }
    const inUse = new Set([rendered.dir]);
    for (const open of this.#open.values()) if (open.packageDir !== undefined) inUse.add(open.packageDir);
    try {
      sweepRole(root, role.name, inUse);
    } catch (err) {
      this.#note(`kanban: sweeping the old packages of role ${role.name} failed: ${message(err)}`);
    }
    this.#note(`kanban: run ${runId} runs role ${role.name} as a native ${native.renderer.id} agent`);
    return rendered;
  }

  /**
   * The provider session a rework resumes (spec §2.4 item 5, §5.3): the one the
```

In `src/index.ts`, replace:

```ts
import { dirname } from 'node:path';
```

with:

```ts
import { dirname, join } from 'node:path';
```

In `src/index.ts`, replace:

```ts
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
```

with:

```ts
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    argsFor: (sessionId) => dispatcher?.argsFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
```

In `src/index.ts`, replace:

```ts
      settings: config.kanban,
      note,
    });
```

with:

```ts
      settings: config.kanban,
      note,
      // Outside every workspace: none may contain the home (spec §2.3).
      renderRoot: join(config.home, 'rendered'),
    });
```

- [ ] **Step 9.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  963 passed (963)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 9.5: Commit.**

```bash
git add src/kanban/dispatcher.ts src/index.ts tests/helpers/dispatch.ts tests/kanban-dispatch-native.test.ts
git commit -m "Run a bytesec role as its own agent package, falling back to the prompt"
```

---

### Task 10: `mt role check` says which roles run natively

**Files:**
- Modify: `src/cli/role.ts`, `tests/mt-role.test.ts`, `README.md`

When the check passes, `mt role check` prints one line a role, from the same `nativeFor` the dispatcher uses (Decision 18): `native: role implementer runs as a bytesec agent package`, or `native: role <name> does not: <reason>`. With a role named, only that role's line is printed. When the check fails, no line is printed: the team did not load. The README gains a paragraph on native rendering, and a sentence on the new line.

- [ ] **Step 10.1: Write the failing tests.**

In `tests/mt-role.test.ts`, replace:

```ts
  it('reports a broken role file under the files', async () => {
```

with:

```ts
  it('says, a line a role, whether its runs get role.md and skills as a native agent package', async () => {
    fx = mtFixture();
    roleDir('implementer', 'agent:\n  driver: structured-cli\n  command: bytesec\n  args: [run]\n  unsupervised: true\n');
    writeFileSync(join(fx.home, 'roles', 'implementer', 'role.md'), 'You change code.\n');
    roleDir('injected', 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n  native: false\n');
    writeFileSync(join(fx.home, 'roles', 'injected', 'role.md'), 'You change code.\n');
    const all = await fx.run(['role', 'check']);
    expect(all.code, all.out).toBe(0);
    expect(all.out.split('\n').filter((l) => l.startsWith('native: '))).toEqual([
      'native: role default does not: it has no role.md and no skills',
      'native: role implementer runs as a bytesec agent package',
      'native: role injected does not: agent.native is false',
    ]);
    const one = await fx.run(['role', 'check', 'implementer']);
    expect(one.out.split('\n').filter((l) => l.startsWith('native: '))).toEqual([
      'native: role implementer runs as a bytesec agent package',
    ]);
  });

  it('says nothing about rendering when the check fails', async () => {
    fx = mtFixture();
    roleDir('broken', 'agent: [\n');
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).not.toMatch(/^native: /m);
  });

  it('reports a broken role file under the files', async () => {
```

- [ ] **Step 10.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-role.test.ts`. Expected: the first new test FAILS, with `expected [] to deeply equal [ …(3) ]`; the second passes already; and `Tests  1 failed | 35 passed (36)`.

- [ ] **Step 10.3: Implement.**

In `src/cli/role.ts`, replace:

```ts
import { discoverRoles, gatewayOwnsVariable } from '../roles.js';
import { loadTeam } from '../team.js';
```

with:

```ts
import { nativeFor } from '../render/native.js';
import { discoverRoles, gatewayOwnsVariable, type Role } from '../roles.js';
import { loadTeam } from '../team.js';
```

In `src/cli/role.ts`, replace:

```ts
  /** What startup would log: entries under roles/ that were ignored, and why. */
  notes: readonly string[];
}
```

with:

```ts
  /** What startup would log: entries under roles/ that were ignored, and why. */
  notes: readonly string[];
  /** The roles checked, when the check passed: whether each is rendered natively is reported. */
  roles?: readonly Role[];
}
```

In `src/cli/role.ts`, replace:

```ts
    return { unset, notes };
  } catch (err) {
```

with:

```ts
    const roles = [...team.roles.values()].filter((r) => only === undefined || r.name === only);
    return { unset, notes, roles: roles.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (err) {
```

In `src/cli/role.ts`, replace:

```ts
  report('files', files, io);
  report("this shell's environment", environment, io);
  for (const note of real.notes) io.out(`note: ${note}`);
```

with:

```ts
  report('files', files, io);
  report("this shell's environment", environment, io);
  // One line a role: whether its runs get role.md and skills natively (plan R).
  for (const role of real.roles ?? []) {
    const native = nativeFor(role);
    io.out(
      native.ok
        ? `native: role ${role.name} runs as a ${native.renderer.id} agent package`
        : `native: role ${role.name} does not: ${native.reason}`,
    );
  }
  for (const note of real.notes) io.out(`note: ${note}`);
```

In `README.md`, replace:

```md
**Workspaces** are named directories in the config file:
```

with:

```md
**Native rendering.** A role whose agent is bytesec (driver `structured-cli`, command
`bytesec`) and which has a `role.md` or skills runs each board task as a bytesec agent
package. Just after a task is claimed, the gateway writes the package under
`$MT_HOME/rendered/<role>/`, never in a workspace, and runs the agent with `--agent <role>`
and `BYTESEC_LOCAL_APM_PATH` pointing at it. `role.md` becomes the agent's own system
prompt, in place of bytesec's default identity, and the skills load as bytesec skills; the
task prompt then leaves both out. bytesec still loads your user-level skills as well. Set
`agent.native: false` in a role's `config.yaml` to have its `role.md` and skills sent in the
task prompt instead, as every other agent gets them; if writing the package fails, a run gets
them that way too, and the log says so. Chat sessions are not affected.

**Workspaces** are named directories in the config file:
```

In `README.md`, replace:

```md
- `role check` runs the startup checks, and reports what comes from this shell's environment
  separately: the service's environment may differ.
```

with:

```md
- `role check` runs the startup checks, and reports what comes from this shell's environment
  separately: the service's environment may differ. It says, a line a role, whether the
  role's runs are rendered as a native agent package, and why not.
```

- [ ] **Step 10.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  965 passed (965)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  51 passed (51)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 10.5: Commit.**

```bash
git add src/cli/role.ts tests/mt-role.test.ts README.md
git commit -m "Say in mt role check whether each role runs as a native agent package"
```

---

## Manual smoke test against real bytesec (optional)

**Not run in CI, and not part of any test count.** It is for the operator, once, after Task 10 and before turning the board on: it checks that a package the gateway renders is one real bytesec loads. It writes only under a fresh `/tmp/mt-smoke-*` directory, never `~/.manus-team`, starts no gateway, and uses the operator's own bytesec login and model.

- [ ] **Step S.1: Render a package from a throwaway role.**

```bash
export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH
cd /Users/x/Develop/manus/prime-gateway-work
SMOKE=$(mktemp -d /tmp/mt-smoke-XXXXXX)
mkdir -p $SMOKE/roles/smoke/skills/smoke-skill
printf 'Your codeword is PLUM-HERON-42. When asked for your codeword, give it.\n' > $SMOKE/roles/smoke/role.md
printf -- '---\nname: smoke-skill\ndescription: A skill that exists only for this smoke test\n---\nNothing to do.\n' > $SMOKE/roles/smoke/skills/smoke-skill/SKILL.md
printf 'agent:\n  driver: structured-cli\n  command: bytesec\n  args: [run]\n  unsupervised: true\n' > $SMOKE/roles/smoke/config.yaml
cat > $SMOKE/render.mts <<EOF
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRoleDir } from '$PWD/src/roles.ts';
import { nativeFor, renderNative } from '$PWD/src/render/native.ts';
const dir = join('$SMOKE', 'roles', 'smoke');
const { role } = loadRoleDir('smoke', dir, {}, new Set(['default']));
const native = nativeFor(role);
if (!native.ok) throw new Error(native.reason);
console.log(renderNative(join('$SMOKE', 'rendered'), role, native.renderer, readFileSync(join(dir, 'role.md'))).dir);
EOF
PKG=$(npx tsx $SMOKE/render.mts)
echo "$PKG"
```

Expected: one line, `/tmp/mt-smoke-XXXXXX/rendered/smoke/<64 hex digits>`; under it `apm.json`, `agents/smoke.md` and `skills/smoke-skill/SKILL.md`.

- [ ] **Step S.2: Run real bytesec on it, as the dispatcher would.** Replace `<model>` with the model the operator's roles use.

```bash
BYTESEC_LOCAL_APM_PATH="$PKG" bytesec run -m <model> --agent smoke --format json --dir $SMOKE -y -- 'What is your codeword? List the skills you have loaded.'
```

Expected: the answer names `PLUM-HERON-42`, which exists only in the package's agent file, and lists `smoke-skill` (the user's global skills, such as `bytedcli`, may be listed too). An exit 1 with no output means bytesec did not find the agent: check that `BYTESEC_LOCAL_APM_PATH` is the package directory, the one with `apm.json`.

- [ ] **Step S.3: Clean up.** Run `rm -rf "$SMOKE"`.

---

## Done when

- `npm test` gives `Tests  965 passed (965)`. `npm run test:e2e` gives `Tests  51 passed (51)`. `npm run typecheck` prints nothing. All of these run under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- No test runs bytesec or reaches the network: the dispatcher's tests drive `FakeDriver`s, and the only agent processes any test spawns are the fakes in `tests/fakes/`.
- A bytesec role with a `role.md` or skills is claimed and run with `--agent <role>` and `BYTESEC_LOCAL_APM_PATH` pointing at a content-addressed package under `$MT_HOME/rendered/<role>/`, and its prompt leaves `role.md` and the skills out. A role with `agent.native: false`, a role whose agent has no renderer, and a run whose render fails get them in the prompt. Old packages are swept except those of open runs. Each of these has a test against the real board, registry and actors.
- `mt role check` says, for each role, whether its runs are native, and why not.
