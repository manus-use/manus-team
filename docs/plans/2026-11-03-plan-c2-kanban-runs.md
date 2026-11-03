# Plan C2 — Agent runs: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board's tasks get done by agents: a dispatcher claims ready tasks and runs each claim as a fresh gateway session on a sink channel, with a composed task prompt; a run ends when its turn ends, and a run that ends without a report is classified, counted and retried in a new session that is told what the last one did; a restart closes every open run, and a run past its limit is cancelled. No worker CLI yet: in this plan a run's agent cannot report, so the tests' fake agents report through `KanbanService`, as plan C3's CLI will.

**Architecture:**
- **Configuration.** `src/config.ts` reads a `kanban:` section into `GatewayConfig.kanban`: `enabled` (default off), `maxRunning` (default `maxLiveSessions`, never above it), the breaker's limits, the runtime limit, the sweep interval and the stranded delay.
- **Pure parts.** `src/kanban/classify.ts` is the failure classifier of spec §8.1, one function over the turn's terminal and its error text. `src/kanban/prompt.ts` composes the task prompt of spec §7.1 and masks its task and context as one assembled text (spec §10.1 layer 2).
- **Reading what a run did.** `src/kanban/session-log.ts` reads a run's tool calls, and its last turn's errors and masked output, from the session event log. `src/kanban/brief.ts` gathers what a prompt is composed from: parents' handoffs, earlier attempts with their tool calls, comments, children.
- **The board.** `src/db/kanban-read.ts` gains the dispatcher's reads: open runs, a run by its session, the open agent run count, the claimable tasks in order, a task's latest completion. `src/db/kanban.ts`, still the only writer, gains `noteStranded` and `countSubmission`, which the service exposes.
- **The session layer.** `src/kanban/sink.ts` is the `kanban` channel: it discards card output and refuses approval cards. `src/core/registry.ts` gains `pinned` (an open run's actor is never retired to make room), asks `envFor` before it makes room so the dispatcher can refuse a build, and gains `archive(key)` for a closed run's session.
- **The dispatcher.** `src/kanban/dispatcher.ts` owns the run lifecycle: passes, `maxRunning`, one agent run per workspace (the claim's check), starting a run, ending it when its turn ends, the sweep (runtime limits, cooldowns, stranded notices), and the boot step that closes every run a restart killed. It holds each open run's environment in memory and gives it to the registry.
- **Wiring.** `src/index.ts` always registers the sink channel and the dispatcher's two hooks, posts boot findings only to Lark bindings, and builds and starts the dispatcher only when `kanban.enabled` is set.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §2.4 items 3–5, §4.2 (stranded), §6, §7.1, §7.4, §8, §10.1 layer 2, and the C2 row of §12.

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on branch `kanban-runs`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, and never write to `~/.manus-team`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Secrets.** Never print secret values. Tests use made-up values only.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` gives `Tests  729 passed (729)`. `npm run test:e2e` gives `Tests  49 passed (49)`. `npm run typecheck` prints nothing.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given.
- **The secret registry is process-wide.** Every test file that adds secrets calls `clearSecrets()` in `beforeEach` and `afterEach`.
- **Tests use real SQLite** through `testDb()`, the real `SessionRegistry` and `SessionActor`, `FakeDriver` agents and a `ManualClock`. No mocks. The fake agents report through `KanbanService`, using the run id the dispatcher put in their environment.
- **The import guard.** `tests/kanban-service.test.ts` checks that only `src/kanban/service.ts` imports `src/db/kanban.js`. The dispatcher reads through `db/kanban-read.js` and writes through the service. Tests may import `db/kanban.js`.

## Decisions the spec left open

Each is the reading most consistent with the rest of the spec. Decisions 1–4 change what an operator sees, and the user should confirm them. Decisions 1, 2, 4, 7 and 8 are now in the spec (§4.2, §6.1, §6.3, §7.4, §12).

1. **The dispatcher is wired into the gateway in this plan, and runs only when `kanban.enabled: true` is set.** The default is off, so merging C2 changes nothing for the live gateway: its config has no `kanban:` section. The alternative, leaving `src/index.ts` alone until C3, was rejected for three reasons:
   - The boot order of spec §8.4 lives in `start()`: reconcile, post findings only to chat bindings, then close every run the restart killed. Wiring it here is what makes C2's restart handling real code rather than a library C3 has to plug in.
   - The `kanban:` settings would otherwise be parsed and used by nothing, which is the failure the config's unknown-key rule exists to prevent.
   - C3 then only adds the socket and the token to a dispatcher that is already started and stopped with the gateway.

   Two pieces of the wiring are on whatever the flag says, and change nothing today: the `kanban` sink is in the registry's channel map, and boot findings are posted only to bindings on the Lark channel. Every existing binding is a Lark binding. The flag stays off until people can create tasks (plan D) and agents can report (plan C3). Turned on before C3, every agent run would end `protocol_violation`, since its agent has no `mt kanban` to report with (Decision 5).
2. **The `kanban:` settings are spelled in camelCase, and are file only.** The spec names them `kanban.failure_limit`, `kanban.max_running` and so on. Every other key in the config file is camelCase (`maxLiveSessions`, `passEnv`, `readOnlyTools`), and an operator who writes `failure_limit` next to `maxLiveSessions` gets an unknown-key error. So the file says `failureLimit`, `transientLimit`, `transientCooldownS`, `maxRunning`, `defaultMaxRuntimeS`, `sweepIntervalS`, `strandedAfterS` and `enabled`. There are no environment overrides, as there are none for `workspaces`. A run's own environment is `MT_KANBAN_*` (spec §7.2), and gateway settings under that prefix would read as run variables.
3. **Settings for later plans are refused until those plans use them.** `nudgeLimit` (C3) and `blockRecurrenceLimit` (D) are unknown keys in C2. An accepted setting that does nothing is how a value someone changed turns out never to have applied.
4. **`kanban.maxRunning` above `maxLiveSessions` is a startup error.** Spec §6.3 says the two limits "must not disagree". An open run's actor is pinned, so more runs than live sessions would hold the gateway over its cap for as long as they ran. Equal is allowed and is the default. Lower keeps room for chat.
5. **How the prompt refers to the worker protocol before C3.** The protocol section names the `mt kanban` commands, their JSON and the terminal reports, as spec §7.1 and §7.3 give them and C3 will provide them. The prompt does not change when C3 lands. Until then a real agent finds no such command and its run ends without a report. C2 is proven by fake agents whose scripts report through `KanbanService`, and by runs that end without reporting and reach the classifier.
6. **A turn that completes without a report ends `protocol_violation` at once.** Stop nudges (spec §7.5) are C3's. They go in the dispatcher's `terminal === 'completed'` branch, before that outcome. The agent's last output is recorded with it.
7. **Every closed run's session is archived and its binding revoked**, not only a run closed at boot. Spec §7.4 says the session "is released". One run is one session (spec §3.3), so the session is never used again whichever way the run closed. Archiving it is what makes a stale approval card for it resolve to "no longer bound", the reason §8.4 gives for doing it at boot.
8. **A task is stranded once it has sat unclaimable for `strandedAfterS` since a pass found it so.** That is the time of its `skipped_unassignable` event, and nothing may have been written on the task since. Spec §4.2 said "measured from the latest event that made it ready", but most such events are on other tasks, or are no event at all: a parent completing, a cooldown ending. The skip is written by the first pass after the task became ready, at most a sweep later. A comment or a reassignment restarts the wait, since someone is looking at the task. The notice is a `stranded` kanban event, which plan D delivers to subscribers. `stranded_notified_at` is set with it, and the next claim clears it (C1). `noteUnassignable` treats a `stranded` event like its own skip, so the notice does not cause a second skip to be written.
9. **Only a pass that tried a task can find it stranded.** While `maxRunning` agent runs are open, a pass does not try agent tasks, so one that nobody can be given is reported once a slot frees, not before. A task waiting behind a busy workspace or the limit is queued, and is never reported (spec §4.2).
10. **Cooldowns are checked by the listing.** A task in its cooldown shows `ready` (C1's note). `claimableTasks` leaves it out until `cooldown_until` has passed. The claim still refuses it as a backstop.
11. **A second rework may resume from a seeded provider-session id nobody confirmed.** C1's `reworkSeed` trusts `sessions.provider_session_id`, which is a seed until the agent reports its own. That seed is an id another session observed, the first work run's, so resuming from it resumes the same conversation. The rework prompt is written to survive a fresh start either way. Nothing changes.
12. **C2 writes `submissions`.** C1 listed its writer under C3, but the task prompt is the first submission, and its key, `kanban:<run_id>:0`, uses the count before it (spec §7.5). `countSubmission` arrives here, and C3's nudges call it too.
13. **Which earlier attempts list their tool calls:** those that ended without a report (C1's `ENDED_OUTCOMES`: failed, crashed, timed out, protocol violation, throttled, provider refused, interrupted). They are read from each attempt's own session log. A run that reported, or was cancelled or superseded by a person, lists its outcome and summary only.
14. **What layer 2 masks.** The task and worker-context sections are masked as one assembled text. Metadata is masked value by value before it is serialized into that text, since JSON escaping hides a secret containing `"` or `\` (spec §10.1). `last_output` is masked after its chunks are joined. A trailing fragment of a secret is dropped, and the text is masked before it is cut to its last 2000 characters. `role.md`, the skills list and the protocol are not masked: they are the operator's files and the gateway's text, and the run's `role_md_hash` must describe what the agent was given.
15. **A tool call is read-only when its title is exactly one of the role's `readOnlyTools`.** The structured-CLI driver titles a call with the tool's name. An ACP agent titles calls in prose, which never matches, so under ACP every call counts as a side effect. That is the safe side of `if-no-side-effects`.
16. **Review and rework context.** The prompt lists every earlier attempt with its summary. A review run therefore sees the implementer's handoff among them, and a rework sees the reviewer's reason, stored as the review run's summary (C1 Decision 7). C4 gives each its own section, adds the last gate result, and writes the rework prompt. C2 also passes the rework's seed to `registry.create`, which is the session layer's half of §5.3.
17. **A run that cannot start ends `failed`, and is counted.** If creating or attaching its session throws, nothing was started, so it is recorded with `hadSideEffects: false`, and a session created before the failure is archived with the run. A runtime that will not spawn reaches the same outcome through the actor, with the spawn error as the run's `error`.
18. **A classified run's `error` is the text the classifier read:** the turn's `agent_error` messages, joined, and a refusal thrown before the turn existed (for example, an actor that could not be built).
19. **A run's environment in C2 is `MT_KANBAN_RUN` alone.** C3 adds `MT_KANBAN_TOKEN`, `MT_KANBAN_SOCKET` and the `mt` directory on `PATH`. The environment is held only in the dispatcher's memory, as the token will be.
20. **A run's session is owned by the principal `kanban`.** It is the board's session, not a chat's.
21. **Shutdown leaves runs open.** `stop()` ends passes and stops recording, and a run whose actor is built after it starts no agent. The next boot ends each open run `interrupted` (spec §8.4). Recording outcomes during shutdown would race the database being closed. For the same reason a run's session is archived before the run is closed: a process that dies between the two leaves a decided run open, which the next boot closes, rather than a closed run whose session is still bound.
22. **An interrupted run that never got a session made no changes,** so it is recorded with `hadSideEffects: false`. Otherwise an `if-no-side-effects` task would wait for a person over a run that never started.
23. **`envFor` refuses by throwing.** The registry now asks it before retiring anything to make room, alongside its role, workspace and channel checks. When the registry is about to rebuild the session of an open run this process did not start, the dispatcher ends the run `interrupted`, closes it, archives its session and throws (spec §2.4 item 3). After boot this cannot happen, since boot closes every open run first. It is the backstop.
24. **What starts a pass.** A pass runs when a run closes, and on every sweep. Plans C3 and D call `dispatcher.pass()` after the service calls that can make a task claimable: create, link, unblock, review requested. In C2 nothing else calls the service.
25. **The runtime limit cancels a turn once its agent is running.** The `timed_out` outcome is recorded at the first sweep past the limit. A turn whose agent is still starting has nothing to cancel yet, so each later sweep tries again until it has a runtime, and then cancels once. An agent whose start never returns keeps its run open until a restart: the session layer has no way to abandon a start.
26. **The classifier reads provider errors, not every error.** Status codes count only directly after `status`, `code`, `HTTP` or `error`. Credentials are recognised by 401, 403, "unauthorized", the providers' `authentication_error` and `permission_error`, and "invalid API key", not by the bare word "authentication": `git`'s "Authentication failed" is the agent's tool failing, an ordinary failure. Timeouts count when they are a request's, a connection's or a socket's, not a test's.

## Out of scope (later plans)

- **Plan C3, the worker CLI:**
  - the run's token, `MT_KANBAN_SOCKET` and the `mt` directory on `PATH`, added to the environment `#run` builds;
  - registering the token with the masker when the run is claimed and removing it when it closes, reference-counted;
  - the `0600` socket and the `mt kanban` commands;
  - stop nudges and `kanban.nudgeLimit`, in place of the immediate `protocol_violation`;
  - forwarding a comment to an undecided run, through `countSubmission` and the same key scheme;
  - calling `dispatcher.pass()` after a worker's `create` or `link`.
- **Plan C4, review, rework and gates:**
  - the prompt's own sections for the reviewer's reason, the implementer's previous handoff, and the last gate result;
  - the rework prompt;
  - gates and the reported commit;
  - a masked crash handler.
- **Plan D, Lark:**
  - delivering `stranded` events, and every other event, to subscribers;
  - forwarding a supervised agent's approval card from the sink to the task's first subscription;
  - sending a person their run's card, since a person's run starts nothing in C2;
  - the `/kanban` commands, each followed by `dispatcher.pass()`;
  - `kanban.blockRecurrenceLimit`;
  - turning `kanban.enabled` on by default, or removing it;
  - refusing `/attach` to a run's session, which would bind a chat to it.
- **The README.** Only the new settings rows, in Task 1. A section on using the board waits until it can be used.

### What later plans need from the runs

- **C3:**
  - the run's environment is built in `Dispatcher.#run`, and `envFor` returns it;
  - a nudge goes where `#turnEnded` now records `protocol_violation`, and needs `countSubmission` for its key;
  - `#close` is where a run's token leaves the masker.
- **C4:** `briefFor` in `src/kanban/brief.ts` is where the review and rework sections are gathered.
- **D:** the `stranded` events, and `dispatcher.pass()` after each `/kanban` command that can make a task claimable.

## File structure

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | the `kanban:` section, `KanbanSettings` |
| `README.md` (modify) | the `kanban.*` settings rows |
| `src/kanban/classify.ts` (create) | `classifyFailure`, the classifier of spec §8.1 |
| `src/db/kanban-read.ts` (modify) | `openRuns`, `runBySession`, `openAgentRunCount`, `claimableTasks`, `latestCompletion` |
| `src/db/kanban.ts` (modify) | `noteStranded`, `countSubmission`; `noteUnassignable` counts a `stranded` event as noted |
| `src/kanban/service.ts` (modify) | `noteStranded`, `countSubmission` |
| `src/kanban/session-log.ts` (create) | `toolCallsOf`, `hadSideEffects`, `lastTurnOf` |
| `src/kanban/prompt.ts` (create) | `composePrompt`, the task prompt of spec §7.1, masked |
| `src/kanban/brief.ts` (create) | `briefFor`, what a prompt is composed from; `endedUnreported` |
| `src/kanban/sink.ts` (create) | `KanbanSink`, the `kanban` channel |
| `src/core/registry.ts` (modify) | `pinned`, `envFor` before making room, `archive` |
| `src/kanban/dispatcher.ts` (create) | `Dispatcher`: passes, runs, the sweep, boot |
| `src/index.ts` (modify) | the sink, the dispatcher behind `kanban.enabled`, findings by channel |
| `tests/helpers/dispatch.ts` (create) | a dispatcher over the real board and sessions, with fake agents |
| `tests/kanban-*.test.ts` (create); `tests/config.test.ts`, `tests/registry.test.ts`, `tests/gateway-startup.test.ts` (modify) | |

---
### Task 1: The `kanban:` section of the config file

**Files:**
- Modify: `src/config.ts`, `tests/config.test.ts`, `README.md`

The dispatcher's settings (Decisions 1–4). `failureLimit`, `transientLimit` and `transientCooldownS` are C1's `KanbanLimits`, which the service already takes. `maxRunning` defaults to `maxLiveSessions`, so the two limits agree unless the operator lowers one. Above it is refused. The section is file only, and an unknown key in it is an error naming the known ones, as for every other section.

- [ ] **Step 1.1: Write the failing tests.**

Add to the end of `tests/config.test.ts`:

```ts

describe('loadConfig: the kanban section', () => {
  it('defaults to the spec values, off, with maxRunning at maxLiveSessions', () => {
    expect(load().kanban).toEqual({
      enabled: false,
      maxRunning: 8,
      failureLimit: 2,
      transientLimit: 10,
      transientCooldownS: 300,
      defaultMaxRuntimeS: 14_400,
      sweepIntervalS: 60,
      strandedAfterS: 1_800,
    });
    expect(load({ MT_MAX_LIVE_SESSIONS: '3' }).kanban.maxRunning).toBe(3);
  });

  it('reads every setting from the file', () => {
    const cfg = load(
      {},
      yamlFile({
        kanban: {
          enabled: true,
          maxRunning: 4,
          failureLimit: 3,
          transientLimit: 5,
          transientCooldownS: 60,
          defaultMaxRuntimeS: 600,
          sweepIntervalS: 30,
          strandedAfterS: 120,
        },
      }),
    );
    expect(cfg.kanban).toEqual({
      enabled: true,
      maxRunning: 4,
      failureLimit: 3,
      transientLimit: 5,
      transientCooldownS: 60,
      defaultMaxRuntimeS: 600,
      sweepIntervalS: 30,
      strandedAfterS: 120,
    });
  });

  it('refuses an unknown key, naming the known ones', () => {
    expect(() => load({}, yamlFile({ kanban: { failure_limit: 3 } }))).toThrow(
      'unknown setting kanban.failure_limit (known: enabled, maxRunning, failureLimit',
    );
    // Plan C3's and plan D's settings are not accepted before they do anything.
    expect(() => load({}, yamlFile({ kanban: { nudgeLimit: 2 } }))).toThrow('unknown setting kanban.nudgeLimit');
  });

  it('refuses a value that is not a positive whole number, or a flag that is not a boolean', () => {
    expect(() => load({}, yamlFile({ kanban: { failureLimit: 0 } }))).toThrow(
      'kanban.failureLimit must be a positive integer',
    );
    expect(() => load({}, yamlFile({ kanban: { sweepIntervalS: 1.5 } }))).toThrow('positive integer');
    expect(() => load({}, yamlFile({ kanban: { enabled: 'yes' } }))).toThrow('kanban.enabled must be true or false');
    expect(() => load({}, yamlFile({ kanban: [] }))).toThrow('kanban must be a mapping');
  });

  it('refuses maxRunning above maxLiveSessions: a run is a live session', () => {
    expect(() => load({}, yamlFile({ maxLiveSessions: 4, kanban: { maxRunning: 5 } }))).toThrow(
      'kanban.maxRunning (5) is above maxLiveSessions (4)',
    );
    expect(load({}, yamlFile({ maxLiveSessions: 4, kanban: { maxRunning: 4 } })).kanban.maxRunning).toBe(4);
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/config.test.ts`. Expected: the five new tests FAIL, with `expected undefined to deeply equal { enabled: false, maxRunning: 8, …(6) }` and `unknown setting kanban (known: workspace, workspaces, db, downloads, maxLiveSessions, lark, auth, agent)`, and `Tests  5 failed | 61 passed (66)`.

- [ ] **Step 1.3: Implement.**

In `src/config.ts`, replace:

```ts
  workspaces: Readonly<Record<string, string>>;

  maxLiveSessions: number;
}

/**
 * What `loadTeam` and the `mt` commands need: where the gateway's files are, the
```

with:

```ts
  workspaces: Readonly<Record<string, string>>;

  maxLiveSessions: number;

  /** The board's dispatcher and breaker (spec §6, §8). */
  kanban: KanbanSettings;
}

/**
 * The `kanban:` section (spec §6, §8). Written in camelCase like every other key
 * in the file. File only: `MT_KANBAN_*` names are a run's own environment (spec
 * §7.2), and a gateway setting under the same prefix would read as one of them.
 */
export interface KanbanSettings {
  /** Run the dispatcher. Off until the board can be used (spec §12). */
  enabled: boolean;
  /** Open agent runs at once. Default `maxLiveSessions`, and never above it (spec §6.3). */
  maxRunning: number;
  /** Counted failures that block a task as gave_up (spec §8.2). */
  failureLimit: number;
  /** Throttled runs in a row that block a task as transient (spec §8.2). */
  transientLimit: number;
  /** The first cooldown after a throttled run, doubling each time (spec §8.2). */
  transientCooldownS: number;
  /** A run's wall-clock limit, unless its task sets one (spec §8.5). */
  defaultMaxRuntimeS: number;
  /** How often the sweep runs: runtime limits, cooldowns, stranded tasks (spec §6.1). */
  sweepIntervalS: number;
  /** How long a task nobody can be given waits before it is reported stranded (spec §4.2). */
  strandedAfterS: number;
}

export const KANBAN_DEFAULTS: Omit<KanbanSettings, 'maxRunning'> = {
  enabled: false,
  failureLimit: 2,
  transientLimit: 10,
  transientCooldownS: 300,
  defaultMaxRuntimeS: 4 * 60 * 60,
  sweepIntervalS: 60,
  strandedAfterS: 30 * 60,
};

const KANBAN_NUMBERS = [
  'maxRunning',
  'failureLimit',
  'transientLimit',
  'transientCooldownS',
  'defaultMaxRuntimeS',
  'sweepIntervalS',
  'strandedAfterS',
] as const;

/**
 * What `loadTeam` and the `mt` commands need: where the gateway's files are, the
```

In `src/config.ts`, replace:

```ts
  const allowTalk = envList(env, 'MT_ALLOW_TALK') ?? file.auth.talk;
  const allowOperate = envList(env, 'MT_ALLOW_OPERATE') ?? file.auth.operate;

  return {
```

with:

```ts
  const allowTalk = envList(env, 'MT_ALLOW_TALK') ?? file.auth.talk;
  const allowOperate = envList(env, 'MT_ALLOW_OPERATE') ?? file.auth.operate;
  const maxLiveSessions = envInteger(env, 'MT_MAX_LIVE_SESSIONS') ?? file.maxLiveSessions ?? 8;
  const maxRunning = file.kanban.maxRunning ?? maxLiveSessions;
  if (maxRunning > maxLiveSessions) {
    // A run is a session, and its actor is pinned while it is open (spec §6.3):
    // more runs than live sessions would hold the gateway over its cap.
    throw new ConfigError(
      `kanban.maxRunning (${maxRunning}) is above maxLiveSessions (${maxLiveSessions}); ` +
        'a run is a live session, so the two limits must not disagree',
    );
  }

  return {
```

In `src/config.ts`, replace:

```ts
    workspaces: team.workspaces,
    maxLiveSessions: envInteger(env, 'MT_MAX_LIVE_SESSIONS') ?? file.maxLiveSessions ?? 8,
  };
```

with:

```ts
    workspaces: team.workspaces,
    maxLiveSessions,
    kanban: {
      enabled: file.kanban.enabled ?? KANBAN_DEFAULTS.enabled,
      maxRunning,
      failureLimit: file.kanban.failureLimit ?? KANBAN_DEFAULTS.failureLimit,
      transientLimit: file.kanban.transientLimit ?? KANBAN_DEFAULTS.transientLimit,
      transientCooldownS: file.kanban.transientCooldownS ?? KANBAN_DEFAULTS.transientCooldownS,
      defaultMaxRuntimeS: file.kanban.defaultMaxRuntimeS ?? KANBAN_DEFAULTS.defaultMaxRuntimeS,
      sweepIntervalS: file.kanban.sweepIntervalS ?? KANBAN_DEFAULTS.sweepIntervalS,
      strandedAfterS: file.kanban.strandedAfterS ?? KANBAN_DEFAULTS.strandedAfterS,
    },
  };
```

In `src/config.ts`, replace:

```ts
    readOnlyTools: readonly string[];
    maskExempt: readonly string[];
  };
}

function emptyFile(): FileConfig {
```

with:

```ts
    readOnlyTools: readonly string[];
    maskExempt: readonly string[];
  };
  kanban: { enabled?: boolean } & Partial<Record<(typeof KANBAN_NUMBERS)[number], number>>;
}

function emptyFile(): FileConfig {
```

In `src/config.ts`, replace:

```ts
      unsupervised: undefined,
      readOnlyTools: [],
      maskExempt: [],
    },
  };
}

/**
```

with:

```ts
      unsupervised: undefined,
      readOnlyTools: [],
      maskExempt: [],
    },
    kanban: {},
  };
}

/**
```

In `src/config.ts`, replace:

```ts
  const agentRaw = subsection(path, root, 'agent');

  reject(path, '', root, ['workspace', 'workspaces', 'db', 'downloads', 'maxLiveSessions', 'lark', 'auth', 'agent']);
  reject(path, 'lark', larkRaw, ['appId', 'domain']);
```

with:

```ts
  const agentRaw = subsection(path, root, 'agent');
  const kanbanRaw = subsection(path, root, 'kanban');

  reject(path, '', root, [
    'workspace',
    'workspaces',
    'db',
    'downloads',
    'maxLiveSessions',
    'lark',
    'auth',
    'agent',
    'kanban',
  ]);
  reject(path, 'lark', larkRaw, ['appId', 'domain']);
```

In `src/config.ts`, replace:

```ts
    'maskExempt',
  ]);

  out.workspace = str(path, 'workspace', root['workspace']);
```

with:

```ts
    'maskExempt',
  ]);
  reject(path, 'kanban', kanbanRaw, ['enabled', ...KANBAN_NUMBERS]);

  out.workspace = str(path, 'workspace', root['workspace']);
```

In `src/config.ts`, replace:

```ts
    maskExempt: strings(path, 'agent.maskExempt', agentRaw['maskExempt']),
  };

  return out;
```

with:

```ts
    maskExempt: strings(path, 'agent.maskExempt', agentRaw['maskExempt']),
  };

  const enabled = bool(path, 'kanban.enabled', kanbanRaw['enabled']);
  if (enabled !== undefined) out.kanban.enabled = enabled;
  for (const key of KANBAN_NUMBERS) {
    const n = positiveInt(path, `kanban.${key}`, kanbanRaw[key]);
    if (n !== undefined) out.kanban[key] = n;
  }

  return out;
```

Then document the settings:

In `README.md`, replace:

```md
| `maxLiveSessions` | `MT_MAX_LIVE_SESSIONS` | Concurrent agent processes. Default 8. |
| `db`, `downloads` | `MT_DB`, `MT_DOWNLOAD_DIR` | Derived from `MT_HOME` unless set. |
```

with:

```md
| `maxLiveSessions` | `MT_MAX_LIVE_SESSIONS` | Concurrent agent processes. Default 8. |
| `kanban.enabled` | — | Run the board's dispatcher. Default **off**: nothing can create a task or report on one yet. |
| `kanban.maxRunning` | — | Open agent runs at once. Default `maxLiveSessions`, and refused above it: a run is a live session. Set it lower to keep room for chat. |
| `kanban.failureLimit` | — | Counted failures before a task gives up and blocks. Default 2: a first attempt and one retry. |
| `kanban.transientLimit`, `kanban.transientCooldownS` | — | A throttled run is retried after a cooldown, 300 s by default, doubling each time up to an hour; after 10 in a row the task blocks. |
| `kanban.defaultMaxRuntimeS` | — | A run's wall-clock limit unless its task sets one. Default 4 hours. |
| `kanban.sweepIntervalS`, `kanban.strandedAfterS` | — | How often the dispatcher checks runtimes, cooldowns and stranded tasks (default 60 s), and how long a task nobody can take waits before it is reported stranded (default 30 min). |
| `db`, `downloads` | `MT_DB`, `MT_DOWNLOAD_DIR` | Derived from `MT_HOME` unless set. |
```

- [ ] **Step 1.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  734 passed (734)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 1.5: Commit.**

```bash
git add src/config.ts tests/config.test.ts README.md
git commit -m "Read the kanban section of the config file"
```

---

### Task 2: The failure classifier

**Files:**
- Create: `src/kanban/classify.ts`, `tests/kanban-classify.test.ts`

Spec §8.1: one pure function over the turn's terminal and the text of that turn's errors. The checks run in order and the first match wins: provider refusal, then throttling, then the terminal. The text is checked before the terminal because the CLI driver reports any agent that exits early as `ambiguous`, with its stderr in the error. A 400 is an ordinary failure. The patterns are the provider's (Decision 26): `512 passed`, `line 512`, `git`'s "Authentication failed" and a test's timeout are not read as a provider refusing. The table is built from real error strings; a new provider's wording is a new row.

- [ ] **Step 2.1: Write the failing tests.** Create `tests/kanban-classify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyFailure, type FailureClass } from '../src/kanban/classify.js';
import type { TurnTerminal } from '../src/types.js';

/**
 * Real error strings, as agents and the CLI driver wrote them, with the class each
 * must get (spec §8.1). A new provider's wording is a new row.
 */
const CASES: ReadonlyArray<[TurnTerminal, string, FailureClass]> = [
  ['failed', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'terminal_provider'],
  ['ambiguous', 'the agent exited with code 1: Error: 403 Forbidden', 'terminal_provider'],
  ['failed', 'Request failed with status code 401', 'terminal_provider'],
  ['failed', 'OpenAI: Incorrect API key provided. Invalid API key', 'terminal_provider'],
  ['failed', 'model "gpt-5.6-sol" not found', 'terminal_provider'],
  ['failed', 'The model `claude-x` does not exist or you do not have access to it.', 'terminal_provider'],
  ['ambiguous', 'error: model_not_found', 'terminal_provider'],
  ['ambiguous', 'the agent exited with code 1: 429 Too Many Requests', 'rate_limited'],
  ['failed', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', 'rate_limited'],
  ['failed', 'You exceeded your current quota, please check your plan and billing details.', 'rate_limited'],
  ['failed', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'rate_limited'],
  ['ambiguous', 'HTTP 503 Service Unavailable', 'rate_limited'],
  ['failed', 'Request failed with status code 502', 'rate_limited'],
  ['ambiguous', 'read ECONNRESET', 'rate_limited'],
  ['ambiguous', 'connect ETIMEDOUT 10.0.0.1:443', 'rate_limited'],
  ['failed', 'Request timed out.', 'rate_limited'],
  // The 400 of 2026-11-02: every request refused for three minutes, then fine.
  ['failed', 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}', 'failed'],
  // Not a provider wall either way: a 400 that killed the agent is a crash.
  ['ambiguous', 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}', 'crashed'],
  ['ambiguous', 'the agent exited without finishing its turn', 'crashed'],
  ['ambiguous', '', 'crashed'],
  ['failed', 'the agent reported a failed turn', 'failed'],
  ['failed', '', 'failed'],
  ['cancelled', '', 'failed'],
  // Numbers that are not statuses are not read as one.
  ['failed', 'tests failed: 512 passed, 3 failed (src/a.ts:401)', 'failed'],
  ['failed', 'error at line 512: unexpected token', 'failed'],
  // The agent's own tools failing are not the provider refusing it.
  ['failed', 'fatal: Authentication failed for https://example.invalid/repo.git', 'failed'],
  ['failed', 'Error: Test timed out in 5000ms.', 'failed'],
  ['ambiguous', 'API Error: 403 {"type":"error","error":{"type":"permission_error"}}', 'terminal_provider'],
];

describe('classifyFailure', () => {
  it.each(CASES)('%s with %j is %s', (terminal, text, expected) => {
    expect(classifyFailure(terminal, text)).toBe(expected);
  });

  it('reads the text before the terminal: a provider error that killed the agent is not a crash', () => {
    expect(classifyFailure('ambiguous', 'Error: 401 Unauthorized')).toBe('terminal_provider');
    expect(classifyFailure('ambiguous', 'rate limit exceeded')).toBe('rate_limited');
  });

  it('checks credentials before throttling: a 401 inside a retry message still blocks', () => {
    expect(classifyFailure('failed', 'retrying after 429... then: Error: 401 Unauthorized')).toBe('terminal_provider');
  });
});
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-classify.test.ts`. Expected: FAIL, with `Error: Cannot find module '../src/kanban/classify.js'`, and `Tests  no tests`.

- [ ] **Step 2.3: Implement.** Create `src/kanban/classify.ts`:

```ts
import type { TurnTerminal } from '../types.js';

/**
 * Why a run's turn failed, when the run did not report and the dispatcher did not
 * cancel it (spec §8.1). One pure function over the turn's terminal and the text
 * of that turn's errors, so a new provider's wording is a test case and a line.
 *
 * Checked in order, first match wins. **Text before terminal**: the CLI driver
 * reports any process that exits without a finish line as `ambiguous`, with the
 * stderr tail in the error, so a 429 or a 401 that kills the agent early arrives
 * as an ambiguous terminal with a provider error in it. Classed by terminal
 * alone, a quota wall would count as a crash and a revoked credential would be
 * retried.
 *
 * **400 is an ordinary failure.** On 2026-11-02 a provider returned 400 to every
 * request for about three minutes, then recovered with nothing changed; blocking
 * on it would have turned a blip into a task waiting on a person.
 */

export type FailureClass = 'terminal_provider' | 'rate_limited' | 'crashed' | 'failed';

/** An HTTP status, where the text says it is one: `status 429`, `Error: 401`, `HTTP 503`. */
function status(codes: string): RegExp {
  return new RegExp(`\\b(?:status(?: code)?|code|http|error)\\b[\\s:=#-]{0,4}(?:${codes})\\b`, 'i');
}

/** Credentials rejected, or the model unavailable: every retry would hit the same wall. */
const TERMINAL_PROVIDER: readonly RegExp[] = [
  status('401|403'),
  /\bunauthori[sz]ed\b/i,
  /\b(?:authentication_error|permission_error)\b/,
  /\binvalid[ _-]?api[ _-]?key\b/i,
  /\bmodel\b[^\n]{0,60}\b(?:not found|does not exist|not available|unavailable)\b/i,
  /\b(?:model_not_found|no such model|unknown model)\b/i,
];

/** Throttling, or a provider that is down for now. */
const RATE_LIMITED: readonly RegExp[] = [
  status('429|5\\d\\d'),
  /\brate[ _-]?limit/i,
  /\bquota\b/i,
  /\btoo many requests\b/i,
  /\boverloaded\b/i,
  /\b(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/,
  /\b(?:connection reset|socket hang up)\b/i,
  // The provider's timeouts, not a test's: "Test timed out in 5000ms" is an ordinary failure.
  /\b(?:request|connection|connect|socket|read|gateway) (?:timed out|timeout)\b/i,
];

export function classifyFailure(terminal: TurnTerminal, errorText: string): FailureClass {
  if (TERMINAL_PROVIDER.some((p) => p.test(errorText))) return 'terminal_provider';
  if (RATE_LIMITED.some((p) => p.test(errorText))) return 'rate_limited';
  if (terminal === 'ambiguous') return 'crashed';
  return 'failed';
}
```

- [ ] **Step 2.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  764 passed (764)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 2.5: Commit.**

```bash
git add src/kanban/classify.ts tests/kanban-classify.test.ts
git commit -m "Classify a run's failure from its terminal and its errors"
```

---

### Task 3: What the dispatcher reads from the board

**Files:**
- Modify: `src/db/kanban-read.ts`
- Create: `tests/kanban-read.test.ts`

These are the reads C1 listed for C2, plus the two the prompt needs:
- `openRuns`, for restart handling;
- `runBySession`, for `envFor`;
- `openAgentRunCount`, for `maxRunning`. It counts open runs, decided or not, because a run that has reported still has its process (spec §3.3).
- `claimableTasks`, a pass's candidates (spec §6.2 step 1): in open or review, no open run, every parent finished, no cooldown running (Decision 10). They come highest priority first, then oldest, matching the index migration 003 already has. Whether anyone can take a task is still the claim's to decide.
- `latestCompletion`, a parent's handoff: the run's summary and metadata, or a person's summary from the `completed` event.

- [ ] **Step 3.1: Write the failing tests.** Create `tests/kanban-read.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSession, closeRun, complete, endRun, DEFAULT_LIMITS, link } from '../src/db/kanban.js';
import {
  claimableTasks,
  latestCompletion,
  openAgentRunCount,
  openRuns,
  runBySession,
} from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

function session(id: string): string {
  createSession(h.db, { id, agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
  return id;
}

describe('the runs a dispatcher reads', () => {
  it('lists every open run, oldest first, and no closed one', () => {
    const a = claimed(h.db, newTask(h.db, { workspace: 'web' }).taskId, {}, NOW);
    const b = claimed(h.db, newTask(h.db, { workspace: 'api' }).taskId, {}, NOW + 1);
    const c = claimed(h.db, newTask(h.db, { workspace: 'docs' }).taskId, {}, NOW + 2);
    expect(endRun(h.db, c.runId, { outcome: 'failed' }, DEFAULT_LIMITS, NOW + 3).ok).toBe(true);
    expect(closeRun(h.db, c.runId, NOW + 4).ok).toBe(true);
    expect(openRuns(h.db).map((r) => r.runId)).toEqual([a.runId, b.runId]);
  });

  it('finds a run by its session, and nothing for a session that is not a run', () => {
    const run = claimed(h.db, newTask(h.db).taskId);
    expect(attachSession(h.db, run.runId, session('s_run'), NOW).ok).toBe(true);
    session('s_chat');
    expect(runBySession(h.db, 's_run')?.runId).toBe(run.runId);
    expect(runBySession(h.db, 's_chat')).toBeUndefined();
  });

  it('counts open agent runs, decided or not, and no person run', () => {
    const decided = claimed(h.db, newTask(h.db, { workspace: 'web' }).taskId);
    claimed(h.db, newTask(h.db, { workspace: 'api' }).taskId);
    claimed(h.db, newTask(h.db, { assignee: { kind: 'human', name: ALICE } }).taskId);
    expect(openAgentRunCount(h.db)).toBe(2);
    // Reported, but still finishing: its process is still there.
    expect(complete(h.db, decided.taskId, { kind: 'run', runId: decided.runId }, { summary: 'done' }, NOW).ok).toBe(true);
    expect(openAgentRunCount(h.db)).toBe(2);
    expect(closeRun(h.db, decided.runId, NOW).ok).toBe(true);
    expect(openAgentRunCount(h.db)).toBe(1);
  });
});

describe('claimableTasks', () => {
  it('lists ready tasks and reviews by priority, then age', () => {
    newTask(h.db, { title: 'old' }, NOW);
    newTask(h.db, { title: 'urgent', priority: 5 }, NOW + 2);
    newTask(h.db, { title: 'young' }, NOW + 1);
    expect(claimableTasks(h.db, NOW + 10).map((t) => t.title)).toEqual(['urgent', 'old', 'young']);
  });

  it('leaves out a task with an open run, a todo task, a cooling task, and finished ones', () => {
    const running = newTask(h.db, { title: 'running', workspace: 'web' });
    claimed(h.db, running.taskId);
    const parent = newTask(h.db, { title: 'parent', workspace: 'api' });
    newTask(h.db, { title: 'todo', parents: [parent.taskId] });
    const cooling = newTask(h.db, { title: 'cooling', workspace: 'docs' });
    const run = claimed(h.db, cooling.taskId);
    expect(endRun(h.db, run.runId, { outcome: 'rate_limited' }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    expect(closeRun(h.db, run.runId, NOW).ok).toBe(true);

    expect(claimableTasks(h.db, NOW).map((t) => t.title)).toEqual(['parent']);
    // The cooldown is 300 s; at its end the task is claimable again.
    expect(claimableTasks(h.db, NOW + 300_000).map((t) => t.title)).toEqual(['parent', 'cooling']);
  });

  it('lists a child once its parent is done or archived', () => {
    const parent = newTask(h.db, { title: 'parent' });
    const child = newTask(h.db, { title: 'child' });
    expect(link(h.db, parent.taskId, child.taskId, ALICE, NOW).ok).toBe(true);
    expect(claimableTasks(h.db, NOW).map((t) => t.title)).toEqual(['parent']);
    expect(complete(h.db, parent.taskId, { kind: 'person', principal: ALICE }, { summary: 'did it' }, NOW).ok).toBe(true);
    expect(claimableTasks(h.db, NOW).map((t) => t.title)).toEqual(['child']);
  });
});

describe('latestCompletion', () => {
  it("gives a run's summary and metadata, as reported", () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(
      complete(h.db, task.taskId, { kind: 'run', runId: run.runId }, { summary: 'parsed', metadata: { files: 2 } }, NOW).ok,
    ).toBe(true);
    expect(latestCompletion(h.db, task.taskId)).toEqual({ summary: 'parsed', metadata: { files: 2 }, runId: run.runId });
  });

  it("gives a person's summary from the event, with no metadata", () => {
    const task = newTask(h.db);
    expect(complete(h.db, task.taskId, { kind: 'person', principal: ALICE }, { summary: 'by hand' }, NOW).ok).toBe(true);
    expect(latestCompletion(h.db, task.taskId)).toEqual({ summary: 'by hand', metadata: null, runId: null });
  });

  it('is undefined for a task never completed', () => {
    expect(latestCompletion(h.db, newTask(h.db).taskId)).toBeUndefined();
  });
});
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-read.test.ts`. Expected: every test FAILS, for example with `TypeError: (0 , openRuns) is not a function`, and `Tests  9 failed (9)`.

- [ ] **Step 3.3: Implement.**

Add to the end of `src/db/kanban-read.ts`:

```ts

// ---------------------------------------------------------------------------
// What the dispatcher reads (plan C2)
// ---------------------------------------------------------------------------

/** Every open run, oldest first: what a restart closes (spec §8.4). */
export function openRuns(db: Db): RunRow[] {
  return db
    .prepare<[], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE ended_at IS NULL ORDER BY started_at, rowid`)
    .all()
    .map(decodeRun);
}

/** The run a gateway session belongs to: at most one, by the unique index on session_id. */
export function runBySession(db: Db, sessionId: string): RunRow | undefined {
  const row = db.prepare<[string], RunRaw>(`SELECT ${RUN_COLS} FROM kanban_runs WHERE session_id = ?`).get(sessionId);
  return row === undefined ? undefined : decodeRun(row);
}

/**
 * Open agent runs, decided or not: what `kanban.maxRunning` counts (spec §6.3).
 * A run that has reported still has its process, and its live session.
 */
export function openAgentRunCount(db: Db): number {
  const row = db
    .prepare<[], { n: number }>(
      "SELECT count(*) AS n FROM kanban_runs WHERE ended_at IS NULL AND assignee_kind = 'role'",
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Tasks a pass may try to claim (spec §6.2 step 1), highest priority first, then
 * oldest: in open or review, with no open run of any kind, every parent finished,
 * and no cooldown still running. A task in its cooldown shows as ready (spec
 * §4.1), so the cooldown is checked here rather than left to the claim to refuse.
 *
 * Whether someone can take it -- the assignee, the workspace -- is the claim's to
 * decide, inside its transaction.
 */
export function claimableTasks(db: Db, now: number): TaskRow[] {
  return db
    .prepare<[number], TaskRaw>(
      `SELECT ${TASK_COLS} FROM kanban_tasks t
        WHERE t.phase IN ('open', 'review')
          AND (t.cooldown_until IS NULL OR t.cooldown_until <= ?)
          AND NOT EXISTS (SELECT 1 FROM kanban_runs r WHERE r.task_id = t.task_id AND r.ended_at IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM kanban_links l JOIN kanban_tasks p ON p.task_id = l.parent_id
             WHERE l.child_id = t.task_id AND p.phase NOT IN ('done', 'archived'))
        ORDER BY t.priority DESC, t.created_at, t.rowid`,
    )
    .all(now)
    .map(decodeTask);
}

/** A task's completion, as its children are given it: the handoff (spec §7.1). */
export interface Completion {
  summary: string;
  metadata: unknown;
  /** The run that completed it; null for a person's completion. */
  runId: string | null;
}

/**
 * The task's latest completion: its `completed` event, and the run's summary and
 * metadata when a run completed it. A person's completion has no run, and its
 * summary is the event's. Undefined if the task was never completed.
 */
export function latestCompletion(db: Db, taskId: string): Completion | undefined {
  const event = db
    .prepare<[string], EventRaw>(
      `SELECT id, task_id, run_id, kind, actor, json(payload) AS payload, created_at
         FROM kanban_events WHERE task_id = ? AND kind = 'completed' ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId);
  if (event === undefined) return undefined;
  const run = event.run_id === null ? undefined : getRun(db, event.run_id);
  if (run !== undefined) return { summary: run.summary ?? '', metadata: run.metadata, runId: run.runId };
  const payload = json(event.payload) as { summary?: unknown };
  return { summary: typeof payload.summary === 'string' ? payload.summary : '', metadata: null, runId: null };
}
```

- [ ] **Step 3.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  773 passed (773)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 3.5: Commit.**

```bash
git add src/db/kanban-read.ts tests/kanban-read.test.ts
git commit -m "Read the open runs, a run by its session, and the claimable tasks"
```

---

### Task 4: Stranded notices, and counting a run's prompts

**Files:**
- Modify: `src/db/kanban.ts`, `src/kanban/service.ts`
- Create: `tests/kanban-stranded.test.ts`

Two writers for the board's one writer.
- **`noteStranded`** (Decision 8) writes a `stranded` event and sets `stranded_notified_at`, once. It writes only while the task's latest event is the `skipped_unassignable` that found nobody to give it to, written at or before the cutoff the sweep passes in. The check is inside the transaction.
- **`countSubmission`** (Decision 12) increments an open agent run's `submissions` and returns the count before it, which keys the prompt.

`noteUnassignable` now treats a `stranded` event as already noted.

- [ ] **Step 4.1: Write the failing tests.** Create `tests/kanban-stranded.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, getRun, getTask } from '../src/db/kanban-read.js';
import { KanbanService } from '../src/kanban/service.js';
import type { Role } from '../src/roles.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { ALICE, WORKSPACES, newTask } from './helpers/kanban.js';

let h: TestDb;
let clock: ManualClock;
let service: KanbanService;

const IMPLEMENTER: Role = {
  name: 'implementer',
  source: 'directory',
  dir: undefined,
  description: undefined,
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
  },
  roleMdPath: undefined,
  skills: [],
  secretValues: [],
};

beforeEach(() => {
  h = testDb();
  clock = new ManualClock();
  service = new KanbanService({
    db: h.db,
    roles: new Map([['implementer', IMPLEMENTER]]),
    workspaces: WORKSPACES,
    clock,
  });
});

afterEach(() => h.close());

const MINUTE = 60_000;

/** A ready task for a role that is not configured: the claim notes it unassignable. */
function stranded(): string {
  const task = newTask(h.db, { assignee: { kind: 'role', name: 'gone' } }, clock.now());
  const r = service.claim(task.taskId);
  expect(r).toMatchObject({ ok: false, code: 'unassignable' });
  return task.taskId;
}

function kinds(taskId: string): string[] {
  return eventsOf(h.db, taskId).map((e) => e.kind);
}

describe('noteStranded', () => {
  it('tells once, after the task has sat unclaimable since the cutoff', () => {
    const taskId = stranded();
    const skippedAt = clock.now();
    clock.advance(30 * MINUTE);

    // Not yet: the skip is after the cutoff.
    expect(service.noteStranded(taskId, 'role "gone" is not configured', skippedAt - 1)).toEqual({
      ok: true,
      written: false,
    });
    expect(service.noteStranded(taskId, 'role "gone" is not configured', skippedAt)).toEqual({
      ok: true,
      written: true,
    });
    expect(getTask(h.db, taskId)?.strandedNotifiedAt).toBe(clock.now());
    const last = eventsOf(h.db, taskId).at(-1);
    expect(last).toMatchObject({ kind: 'stranded', actor: 'gateway', payload: { reason: 'role "gone" is not configured' } });

    // Once: a second sweep, and a second pass noting the skip, add nothing.
    expect(service.noteStranded(taskId, 'role "gone" is not configured', clock.now())).toEqual({
      ok: true,
      written: false,
    });
    expect(service.claim(taskId)).toMatchObject({ ok: false, code: 'unassignable' });
    expect(kinds(taskId)).toEqual(['created', 'skipped_unassignable', 'stranded']);
  });

  it('does not tell when something has happened since the skip', () => {
    const taskId = stranded();
    const cutoff = clock.now();
    clock.advance(MINUTE);
    expect(service.comment(taskId, 'looking at it', ALICE).ok).toBe(true);
    expect(service.noteStranded(taskId, 'role "gone" is not configured', cutoff + MINUTE)).toEqual({
      ok: true,
      written: false,
    });
  });

  it('does not tell for a task that is not waiting to be claimed', () => {
    const taskId = stranded();
    expect(service.archive(taskId, ALICE).ok).toBe(true);
    expect(service.noteStranded(taskId, 'role "gone" is not configured', clock.now())).toEqual({
      ok: true,
      written: false,
    });
  });

  it('is cleared by a claim, so a task stranded again is told again', () => {
    const taskId = stranded();
    expect(service.noteStranded(taskId, 'role "gone" is not configured', clock.now()).ok).toBe(true);
    expect(service.assign(taskId, 'implementer', ALICE).ok).toBe(true);
    const r = service.claim(taskId);
    if (!r.ok) throw new Error(r.message);
    expect(getTask(h.db, taskId)?.strandedNotifiedAt).toBeNull();
  });

  it('refuses a task that does not exist', () => {
    expect(service.noteStranded('k_none', 'x', clock.now())).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('countSubmission', () => {
  it("counts each prompt into an agent run, returning the count before it, for the prompt's key", () => {
    const task = newTask(h.db);
    const r = service.claim(task.taskId);
    if (!r.ok) throw new Error(r.message);
    expect(service.countSubmission(r.run.runId)).toEqual({ ok: true, n: 0 });
    expect(service.countSubmission(r.run.runId)).toEqual({ ok: true, n: 1 });
    expect(getRun(h.db, r.run.runId)?.submissions).toBe(2);
    expect(eventsOf(h.db, task.taskId).filter((e) => e.kind === 'submitted').map((e) => e.payload)).toEqual([
      { n: 0 },
      { n: 1 },
    ]);
  });

  it('refuses a closed run, and one that does not exist', () => {
    const task = newTask(h.db);
    const r = service.claim(task.taskId);
    if (!r.ok) throw new Error(r.message);
    expect(service.endRun(r.run.runId, { outcome: 'failed' }).ok).toBe(true);
    expect(service.closeRun(r.run.runId).ok).toBe(true);
    expect(service.countSubmission(r.run.runId)).toMatchObject({ ok: false, code: 'already_closed' });
    expect(service.countSubmission('r_none')).toMatchObject({ ok: false, code: 'not_found' });
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-stranded.test.ts`. Expected: every test FAILS, with `TypeError: service.noteStranded is not a function` or `service.countSubmission is not a function`, and `Tests  7 failed (7)`.

- [ ] **Step 4.3: Implement.** First the writers:

In `src/db/kanban.ts`, replace:

```ts
      .get(taskId);
    if (last?.kind === 'skipped_unassignable') return { ok: true, written: false };
    record(d, { taskId, kind: 'skipped_unassignable', actor: 'gateway', payload: { reason } }, now);
```

with:

```ts
      .get(taskId);
    // A stranded notice follows the skip it is about, and says the same thing.
    if (last?.kind === 'skipped_unassignable' || last?.kind === 'stranded') return { ok: true, written: false };
    record(d, { taskId, kind: 'skipped_unassignable', actor: 'gateway', payload: { reason } }, now);
```

Add to the end of `src/db/kanban.ts`:

```ts

/**
 * A task nobody can be given has waited too long (spec §4.2): its subscribers are
 * told it is stranded and why, once. The `stranded` event is the notice, which
 * plan D delivers; `stranded_notified_at` records that it went out, and a claim
 * clears it.
 *
 * Only while the task's latest event is the skip that found nobody to give it to,
 * written at or before `cutoff`: anything since -- a claim, a comment, a new
 * assignee -- means it has not been sitting unclaimable all that time.
 */
export function noteStranded(
  db: Db,
  taskId: string,
  reason: string,
  cutoff: number,
  now: number,
): Result<{ written: boolean }> {
  return tx(db, (d) => {
    const task = getTask(d, taskId);
    if (task === undefined) return refuse('not_found', `no task ${taskId}`);
    if (task.strandedNotifiedAt !== null || (task.phase !== 'open' && task.phase !== 'review')) {
      return { ok: true, written: false };
    }
    const last = d
      .prepare<[string], { kind: string; created_at: number }>(
        'SELECT kind, created_at FROM kanban_events WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(taskId);
    if (last?.kind !== 'skipped_unassignable' || last.created_at > cutoff) return { ok: true, written: false };
    d.prepare('UPDATE kanban_tasks SET stranded_notified_at = ? WHERE task_id = ?').run(now, taskId);
    record(d, { taskId, kind: 'stranded', actor: 'gateway', payload: { reason } }, now);
    return { ok: true, written: true };
  });
}

/**
 * Count a prompt sent into an agent run's session (spec §3.3): the task prompt,
 * and from plan C3 each nudge or forwarded comment. Returns the count before this
 * one, which keys the submission as `kanban:<run_id>:<n>` (spec §7.5): the actor
 * deduplicates turns on that key, so each prompt needs its own.
 */
export function countSubmission(db: Db, runId: string, now: number): Result<{ n: number }> {
  return tx(db, (d) => {
    const run = getRun(d, runId);
    if (run === undefined) return refuse('not_found', `no run ${runId}`);
    if (run.endedAt !== null) return refuse('already_closed', `run ${runId} is closed`);
    if (run.agentConfig === null) return refuse('invalid', `run ${runId} is a person's, and has no session to prompt`);
    d.prepare('UPDATE kanban_runs SET submissions = submissions + 1 WHERE run_id = ?').run(runId);
    record(d, { taskId: run.taskId, runId, kind: 'submitted', actor: 'gateway', payload: { n: run.submissions } }, now);
    return { ok: true, n: run.submissions };
  });
}
```

Then the service:

In `src/kanban/service.ts`, replace:

```ts
    return board.closeRun(this.#db, runId, this.#clock.now());
  }

  /**
   * New work on a done task is a new task with it as a parent, never a reopening
   * (spec §4.4): the done task's summary is what its children were given as their
```

with:

```ts
    return board.closeRun(this.#db, runId, this.#clock.now());
  }

  /** Count a prompt sent into a run's session; `n` is the count before it, for its key. */
  countSubmission(runId: string): Result<{ n: number }> {
    return board.countSubmission(this.#db, runId, this.#clock.now());
  }

  /**
   * Tell a task's subscribers, once, that nobody can be given it (spec §4.2),
   * if it has been sitting unclaimable since `cutoff`. Plan C2's sweep calls it.
   */
  noteStranded(taskId: string, reason: string, cutoff: number): Result<{ written: boolean }> {
    return board.noteStranded(this.#db, taskId, reason, cutoff, this.#clock.now());
  }

  /**
   * New work on a done task is a new task with it as a parent, never a reopening
   * (spec §4.4): the done task's summary is what its children were given as their
```

- [ ] **Step 4.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  780 passed (780)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 4.5: Commit.**

```bash
git add src/db/kanban.ts src/kanban/service.ts tests/kanban-stranded.test.ts
git commit -m "Record stranded notices and count the prompts sent into a run"
```

---

### Task 5: What a run did, from its session log

**Files:**
- Create: `src/kanban/session-log.ts`, `tests/kanban-session-log.test.ts`

The board keeps no copy of an agent's output: the session event log is the record (spec §8.1, §8.3).
- `toolCallsOf` lists a session's tool calls, each with its latest status.
- `hadSideEffects` checks them against the role's `readOnlyTools` (Decision 15).
- `lastTurnOf` gives the last turn's `agent_error` texts, for the classifier, and its output, for `last_output`. The output is masked after its chunks are joined, so a secret split between two chunks is masked whole (Decision 14).

- [ ] **Step 5.1: Write the failing tests.** Create `tests/kanban-session-log.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/db/events.js';
import { createSession } from '../src/db/sessions.js';
import { LAST_OUTPUT_CHARS, hadSideEffects, lastTurnOf, toolCallsOf } from '../src/kanban/session-log.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { NewEvent } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';

let h: TestDb;
const NOW = 1_760_000_000_000;
const S = 's_run';

beforeEach(() => {
  clearSecrets();
  h = testDb();
  createSession(h.db, { id: S, agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
});

afterEach(() => {
  clearSecrets();
  h.close();
});

function log(...events: NewEvent[]): void {
  for (const e of events) appendEvent(h.db, S, e, NOW);
}

const submitted = (turnId: string): NewEvent => ({ type: 'turn_submitted', actor: 'user', turnId, payload: { text: 'go' } });
const said = (turnId: string, text: string): NewEvent => ({
  type: 'agent_message_chunk',
  actor: 'agent',
  turnId,
  payload: { text },
});
const failed = (turnId: string, message: string): NewEvent => ({
  type: 'agent_error',
  actor: 'agent',
  turnId,
  payload: { message, retryable: false },
});
const tool = (turnId: string, toolCallId: string, title: string, status = 'pending'): NewEvent => ({
  type: 'tool_call',
  actor: 'agent',
  turnId,
  payload: { toolCallId, title, status, raw: {} },
});
const update = (turnId: string, toolCallId: string, status: string): NewEvent => ({
  type: 'tool_call_update',
  actor: 'agent',
  turnId,
  payload: { toolCallId, status, raw: {} },
});

describe('toolCallsOf', () => {
  it('lists every call in the session in order, with its latest status', () => {
    log(
      submitted('t_1'),
      tool('t_1', 'c1', 'read'),
      tool('t_1', 'c2', 'bash'),
      update('t_1', 'c2', 'failed'),
      update('t_1', 'c1', 'completed'),
      submitted('t_2'),
      tool('t_2', 'c3', 'edit', 'completed'),
    );
    expect(toolCallsOf(h.db, S)).toEqual([
      { toolCallId: 'c1', title: 'read', status: 'completed' },
      { toolCallId: 'c2', title: 'bash', status: 'failed' },
      { toolCallId: 'c3', title: 'edit', status: 'completed' },
    ]);
  });

  it('is empty for a session that made none', () => {
    log(submitted('t_1'), said('t_1', 'nothing to do'));
    expect(toolCallsOf(h.db, S)).toEqual([]);
  });
});

describe('hadSideEffects', () => {
  const calls = [
    { toolCallId: 'c1', title: 'read', status: 'completed' },
    { toolCallId: 'c2', title: 'grep', status: 'completed' },
  ];

  it('is false when every call is one the role lists as read-only', () => {
    expect(hadSideEffects(calls, ['read', 'grep', 'ls'])).toBe(false);
    expect(hadSideEffects([], [])).toBe(false);
  });

  it('is true for any call not on the list, and for every call when the list is empty', () => {
    expect(hadSideEffects([...calls, { toolCallId: 'c3', title: 'bash', status: 'completed' }], ['read', 'grep'])).toBe(
      true,
    );
    expect(hadSideEffects(calls, [])).toBe(true);
  });
});

describe('lastTurnOf', () => {
  it("gives the last turn's errors and what the agent said in it, and nothing from earlier turns", () => {
    log(
      submitted('t_1'),
      said('t_1', 'first turn'),
      failed('t_1', 'old error'),
      submitted('t_2'),
      said('t_2', 'Working on '),
      said('t_2', 'it.'),
      failed('t_2', 'Error: 429 Too Many Requests'),
    );
    expect(lastTurnOf(h.db, S)).toEqual({ errors: ['Error: 429 Too Many Requests'], output: 'Working on it.' });
  });

  it('is empty for a session that has had no turn', () => {
    expect(lastTurnOf(h.db, S)).toEqual({ errors: [], output: '' });
  });

  it('keeps the tail of a long output', () => {
    log(submitted('t_1'), said('t_1', `${'a'.repeat(LAST_OUTPUT_CHARS)}END`));
    const { output } = lastTurnOf(h.db, S);
    expect(output).toHaveLength(LAST_OUTPUT_CHARS);
    expect(output.endsWith('aEND')).toBe(true);
  });

  it('masks a secret split across two chunks, and drops one the turn ended part-way through', () => {
    addSecrets(['sk-live-1234567890']);
    log(submitted('t_1'), said('t_1', 'key is sk-live-'), said('t_1', '1234567890; then sk-live-12'));
    expect(lastTurnOf(h.db, S).output).toBe(`key is ${MASK}; then `);
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-session-log.test.ts`. Expected: FAIL, with `Error: Cannot find module '../src/kanban/session-log.js'`, and `Tests  no tests`.

- [ ] **Step 5.3: Implement.** Create `src/kanban/session-log.ts`:

```ts
import type { Db } from '../db/open.js';
import { lastSeq, readEvents } from '../db/events.js';
import { redactKnownSecrets, withholdSecretPrefix } from '../secrets.js';
import type { Event } from '../types.js';

/**
 * What a run did, read from its session's event log (spec §8.1, §8.3): the log
 * is the system of record, so the board never keeps its own copy of an agent's
 * output or tool calls.
 */

/** One tool call, as the agent titled it, with its last status. */
export interface ToolCall {
  toolCallId: string;
  title: string;
  status: string;
}

/** The most of an agent's last output a run records as `last_output` (spec §3.3). */
export const LAST_OUTPUT_CHARS = 2000;

function eventsOf(db: Db, sessionId: string): Event[] {
  return readEvents(db, sessionId, 0, lastSeq(db, sessionId));
}

function text(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Every tool call the session made, in order, each with its latest status. */
export function toolCallsOf(db: Db, sessionId: string): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of eventsOf(db, sessionId)) {
    const id = text(event.payload, 'toolCallId');
    if (id === undefined) continue;
    if (event.type === 'tool_call') {
      const title = text(event.payload, 'title') ?? 'tool';
      calls.set(id, { toolCallId: id, title, status: text(event.payload, 'status') ?? '' });
    } else if (event.type === 'tool_call_update') {
      const call = calls.get(id);
      const status = text(event.payload, 'status');
      if (call !== undefined && status !== undefined && status !== '') call.status = status;
    }
  }
  return [...calls.values()];
}

/**
 * Whether the calls changed anything (spec §2.1, §8.3): any call whose title is
 * not one of the role's readOnlyTools. An empty list means every call counts.
 */
export function hadSideEffects(calls: readonly ToolCall[], readOnlyTools: readonly string[]): boolean {
  return calls.some((call) => !readOnlyTools.includes(call.title));
}

/** The session's last turn, as the classifier and `last_output` need it. */
export interface LastTurn {
  /** The text of the turn's `agent_error` events, the agent's and the gateway's. */
  errors: string[];
  /**
   * The tail of what the agent said in the turn, masked (spec §10.1 layer 2): the
   * chunks are joined first, so a secret split between two is masked whole, and a
   * turn that ended part-way through one keeps none of it.
   */
  output: string;
}

export function lastTurnOf(db: Db, sessionId: string): LastTurn {
  const events = eventsOf(db, sessionId);
  const turnId = events.findLast((e) => e.type === 'turn_submitted')?.turnId ?? null;
  if (turnId === null) return { errors: [], output: '' };
  const errors: string[] = [];
  let said = '';
  for (const event of events) {
    if (event.turnId !== turnId) continue;
    if (event.type === 'agent_error') {
      const message = text(event.payload, 'message');
      if (message !== undefined) errors.push(message);
    } else if (event.type === 'agent_message_chunk') {
      said += text(event.payload, 'text') ?? '';
    }
  }
  // Masked before it is cut, so the cut cannot leave the end of a secret showing.
  return { errors, output: redactKnownSecrets(withholdSecretPrefix(said)).slice(-LAST_OUTPUT_CHARS) };
}
```

- [ ] **Step 5.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  788 passed (788)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 5.5: Commit.**

```bash
git add src/kanban/session-log.ts tests/kanban-session-log.test.ts
git commit -m "Read a run's tool calls and its last turn from its session log"
```

---

### Task 6: The task prompt

**Files:**
- Create: `src/kanban/prompt.ts`, `tests/kanban-prompt.test.ts`

Spec §7.1, in order: the role's `role.md`, its skills (name, description, the absolute path of each `SKILL.md`), the protocol for the run's kind, the task, and the worker context. The protocol follows `role.md` and says it takes precedence. It names the `mt kanban` commands as C3 will provide them (Decision 5). The task and context are one assembled text, masked as a whole, with metadata masked before it is serialized (Decision 14). `composePrompt` is pure: Task 7 gathers its input.

- [ ] **Step 6.1: Write the failing tests.** Create `tests/kanban-prompt.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composePrompt, type RunBrief } from '../src/kanban/prompt.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { RunRow, TaskRow } from '../src/kanban/types.js';
import { AGENT, NOW, VIA } from './helpers/kanban.js';

beforeEach(() => clearSecrets());
afterEach(() => clearSecrets());

function task(extra: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: 'k_task',
    title: 'Write the parser',
    body: 'Parse the config file.',
    contract: {},
    assignee: { kind: 'role', name: 'implementer' },
    reviewer: null,
    workspace: 'default',
    phase: 'open',
    blockedFrom: null,
    blockKind: null,
    blockReason: null,
    priority: 0,
    idempotencyKey: null,
    failureLimit: null,
    retryOnCrash: 'always',
    maxRuntimeS: null,
    consecutiveFailures: 0,
    consecutiveTransient: 0,
    cooldownUntil: null,
    blockRecurrences: 0,
    strandedNotifiedAt: null,
    createdBy: 'lark:on_alice',
    createdVia: VIA,
    createdAt: NOW,
    closedAt: null,
    createdFromTask: null,
    ...extra,
  };
}

function run(extra: Partial<RunRow> = {}): RunRow {
  return {
    runId: 'r_1',
    taskId: 'k_task',
    attempt: 1,
    kind: 'work',
    assignee: { kind: 'role', name: 'implementer' },
    agentConfig: AGENT,
    workspace: 'default',
    roleMdHash: null,
    sessionId: 's_1',
    seededFromRun: null,
    tokenHash: null,
    outcome: 'crashed',
    summary: null,
    metadata: null,
    reportedCommit: null,
    reportedDirty: null,
    error: 'the agent exited without finishing its turn',
    lastOutput: 'Running the tests now.',
    submissions: 1,
    startedAt: NOW,
    endedAt: NOW + 1,
    ...extra,
  };
}

function brief(extra: Partial<RunBrief> = {}): RunBrief {
  return { kind: 'work', roleMd: undefined, skills: [], task: task(), parents: [], attempts: [], comments: [], children: [], ...extra };
}

/** Where each heading first appears, to check the order. */
function at(prompt: string, heading: string): number {
  const i = prompt.indexOf(heading);
  if (i === -1) throw new Error(`no ${heading} in the prompt`);
  return i;
}

describe('composePrompt', () => {
  it('puts the role, the skills, the protocol, the task and the context in that order', () => {
    const prompt = composePrompt(
      brief({
        roleMd: 'You change code in this repository. Run the tests before you report.\n',
        skills: [{ name: 'testing', description: 'How to test here', dir: '/r/skills/testing', path: '/r/skills/testing/SKILL.md' }],
      }),
    );
    const order = ['# Your role', '# Skills', '# How to work', '# The task', '# Context'].map((h) => at(prompt, h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(prompt).toContain('You change code in this repository. Run the tests before you report.');
    expect(prompt).toContain('- testing: How to test here (/r/skills/testing/SKILL.md)');
    expect(prompt).toContain('take precedence over them');
  });

  it('leaves out the role and skills a role does not have', () => {
    const prompt = composePrompt(brief());
    expect(prompt).not.toContain('# Your role');
    expect(prompt).not.toContain('# Skills');
    expect(prompt.startsWith('# How to work')).toBe(true);
  });

  it('gives a work run the work protocol, and a review run the review protocol', () => {
    const work = composePrompt(brief());
    expect(work).toContain('mt kanban complete < handoff.json');
    expect(work).toContain('mt kanban review < handoff.json');
    expect(work).toContain('report complete rather than review');
    expect(work).not.toContain('mt kanban changes');
    const review = composePrompt(brief({ kind: 'review', task: task({ phase: 'review' }) }));
    expect(review).toContain('mt kanban changes < reason.json');
    expect(review).toContain('Do not change the workspace.');
  });

  it('gives the task its title, body and contract', () => {
    const prompt = composePrompt(
      brief({ task: task({ contract: { outcome: 'it parses', stop_when: 'the format is unclear' } }) }),
    );
    expect(prompt).toContain('k_task: Write the parser\n\nParse the config file.');
    expect(prompt).toContain('Contract:\n- Outcome: it parses\n- Stop when: the format is unclear');
  });

  it("gives each parent's handoff verbatim, and says when a parent has none", () => {
    const prompt = composePrompt(
      brief({
        parents: [
          { task: task({ taskId: 'k_p1', title: 'Design', phase: 'done' }), summary: 'Use YAML.', metadata: { doc: 'a.md' } },
          { task: task({ taskId: 'k_p2', title: 'Dropped', phase: 'archived' }), summary: null, metadata: null },
        ],
      }),
    );
    expect(prompt).toContain('## Parent k_p1: Design (done)\nSummary: Use YAML.\nMetadata: {"doc":"a.md"}');
    expect(prompt).toContain('## Parent k_p2: Dropped (archived)\nNo handoff: it was never completed.');
  });

  it('tells a retry what the earlier attempt did, its tool calls included', () => {
    const prompt = composePrompt(
      brief({
        attempts: [
          {
            run: run(),
            toolCalls: [
              { toolCallId: 'c1', title: 'edit', status: 'completed' },
              { toolCallId: 'c2', title: 'bash', status: 'failed' },
            ],
          },
          { run: run({ runId: 'r_2', attempt: 2, outcome: 'interrupted', error: null, lastOutput: null }), toolCalls: [] },
        ],
      }),
    );
    expect(prompt).toContain(
      '## Attempt 1 (work, implementer): crashed\nError: the agent exited without finishing its turn\n' +
        'Last output:\nRunning the tests now.\nTool calls:\n- edit (completed)\n- bash (failed)',
    );
    expect(prompt).toContain('## Attempt 2 (work, implementer): interrupted\nTool calls: none');
  });

  it('gives the comment thread and the children', () => {
    const prompt = composePrompt(
      brief({
        comments: [{ id: 1, taskId: 'k_task', author: 'lark:on_alice', body: 'Mind the BOM.', createdAt: NOW }],
        children: [task({ taskId: 'k_review', title: 'Review the parser', assignee: { kind: 'role', name: 'reviewer' } })],
      }),
    );
    expect(prompt).toContain('## Comments\n- lark:on_alice: Mind the BOM.');
    expect(prompt).toContain('## Children\nTasks that wait on this one:\n- k_review: Review the parser (reviewer, open)');
  });

  it('says so when there is no context yet', () => {
    expect(composePrompt(brief())).toContain('# Context\n\nNothing yet');
  });

  it('masks a known secret wherever it is in the task and the context', () => {
    addSecrets(['sk-live-1234567890']);
    const prompt = composePrompt(
      brief({
        task: task({ body: 'use sk-live-1234567890' }),
        comments: [{ id: 1, taskId: 'k_task', author: 'lark:on_alice', body: 'the key is sk-live-1234567890', createdAt: NOW }],
        attempts: [{ run: run({ error: 'auth with sk-live-1234567890 failed' }), toolCalls: undefined }],
      }),
    );
    expect(prompt).not.toContain('sk-live-1234567890');
    expect(prompt).toContain(`use ${MASK}`);
    expect(prompt).toContain(`the key is ${MASK}`);
    expect(prompt).toContain(`Error: auth with ${MASK} failed`);
  });

  it('masks a secret holding a quote inside metadata, before the metadata is serialized', () => {
    addSecrets(['pa"ss-word-1234']);
    const prompt = composePrompt(brief({ attempts: [{ run: run({ metadata: { key: 'pa"ss-word-1234' } }), toolCalls: undefined }] }));
    expect(prompt).not.toContain('ss-word-1234');
    expect(prompt).toContain(`Metadata: {"key":"${MASK}"}`);
  });
});
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-prompt.test.ts`. Expected: FAIL, with `Error: Cannot find module '../src/kanban/prompt.js'`, and `Tests  no tests`.

- [ ] **Step 6.3: Implement.** Create `src/kanban/prompt.ts`:

```ts
import { redactKnownSecrets } from '../secrets.js';
import type { Skill } from '../roles.js';
import type { ToolCall } from './session-log.js';
import { CONTRACT_FIELDS, type CommentRow, type RunKind, type RunRow, type TaskRow } from './types.js';

/**
 * A run's task prompt (spec §7.1), composed in this order: the role, its skills,
 * the protocol for the run's kind, the task, and the worker context.
 *
 * The protocol comes after role.md and says it takes precedence: a role's
 * instructions may shape how work is done, not whether it is reported. That is an
 * instruction to the model, not something the gateway can enforce; the run's
 * outcome when it ends without a report is what catches a role.md that talks an
 * agent out of reporting.
 *
 * The protocol names the `mt kanban` commands as plan C3 provides them, so the
 * prompt does not change when they arrive. Until then an agent that tries them
 * finds no such command and ends without a report.
 *
 * The task and the worker context are masked as one assembled text (spec §10.1
 * layer 2): they are built from many stored pieces -- handoffs, earlier output,
 * tool calls, comments -- and only the assembled text is sure to hold a secret
 * whole. role.md, the skills and the protocol are the operator's files and the
 * gateway's own text, and are given as they are: the run records the hash of the
 * role.md it was given.
 */

/** A parent's handoff to this task: its latest completion. */
export interface ParentHandoff {
  task: TaskRow;
  /** Null for a parent archived without being completed. */
  summary: string | null;
  metadata: unknown;
}

/** An earlier run on this task. */
export interface Attempt {
  run: RunRow;
  /** The tool calls it made, for a run that ended without a report (spec §8.3); undefined otherwise. */
  toolCalls: readonly ToolCall[] | undefined;
}

/** Everything a run's prompt is composed from. */
export interface RunBrief {
  kind: RunKind;
  /** The role.md text whose hash the run records; undefined without one. */
  roleMd: string | undefined;
  skills: readonly Skill[];
  task: TaskRow;
  parents: readonly ParentHandoff[];
  attempts: readonly Attempt[];
  comments: readonly CommentRow[];
  children: readonly TaskRow[];
}

const WORK_PROTOCOL = `You have one task, below. Orient yourself by reading the task and its context, then do the work in the current directory, which is the task's workspace.

Report through the \`mt kanban\` command, which reads JSON on stdin and answers in JSON. Exactly one terminal report ends your run:
- \`mt kanban complete < handoff.json\`, with {"summary": "...", "metadata": {...}}, when the task is done;
- \`mt kanban review < handoff.json\`, with the same fields and optionally "reviewer", to ask for this task to be reviewed;
- \`mt kanban block < block.json\`, with {"kind": "needs_input" | "capability" | "transient" | "dependency", "reason": "..."}, and "parents" (task ids) for a dependency, when you cannot go on.

Block only on genuine ambiguity, and say why. If one of the task's children below reviews this task, report complete rather than review. If you find follow-up work, create a task for it with \`mt kanban create\` rather than doing it. Never put a secret in a summary, metadata or comment. Stop once you have reported.`;

const REVIEW_PROTOCOL = `You are reviewing one task, below. Review the implementer's handoff, in the earlier attempts, and the workspace -- the current directory -- against the task and its contract. Do not change the workspace.

Report through the \`mt kanban\` command, which reads JSON on stdin and answers in JSON. Exactly one terminal report ends your run:
- \`mt kanban complete < handoff.json\`, with {"summary": "..."}, to approve;
- \`mt kanban changes < reason.json\`, with {"reason": "..."}, a specific, actionable reason, to ask for changes;
- \`mt kanban block < block.json\`, with {"kind": "...", "reason": "..."}, only for a problem the implementer cannot fix.

Never put a secret in a summary or comment. Stop once you have reported.`;

const PRECEDENCE =
  'These rules come after your role instructions and take precedence over them: those may shape how you work, not whether you report.';

const CONTRACT_LABELS: Record<(typeof CONTRACT_FIELDS)[number], string> = {
  outcome: 'Outcome',
  verification: 'Verification',
  constraints: 'Constraints',
  boundaries: 'Boundaries',
  stop_when: 'Stop when',
};

/**
 * Metadata, masked value by value before it is serialized: JSON escaping changes
 * a secret containing `"` or `\\` so that the assembled text no longer matches it
 * (spec §10.1). Every key and string is masked, as db/kanban.ts masks it on write.
 */
function json(value: unknown): string {
  const mask = (v: unknown): unknown => {
    if (typeof v === 'string') return redactKnownSecrets(v);
    if (Array.isArray(v)) return v.map(mask);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [redactKnownSecrets(k), mask(inner)]));
    }
    return v;
  };
  return JSON.stringify(mask(value));
}

function taskSection(task: TaskRow): string[] {
  const lines = ['# The task', '', `${task.taskId}: ${task.title}`];
  if (task.body !== '') lines.push('', task.body);
  const contract = CONTRACT_FIELDS.filter((f) => task.contract[f] !== undefined);
  if (contract.length > 0) {
    lines.push('', 'Contract:');
    for (const field of contract) lines.push(`- ${CONTRACT_LABELS[field]}: ${task.contract[field] ?? ''}`);
  }
  return lines;
}

function attemptLines(a: Attempt): string[] {
  const { run } = a;
  const lines = [`## Attempt ${run.attempt} (${run.kind}, ${run.assignee.name}): ${run.outcome ?? 'in progress'}`];
  if (run.summary !== null) lines.push(`Summary: ${run.summary}`);
  if (run.metadata !== null) lines.push(`Metadata: ${json(run.metadata)}`);
  if (run.error !== null) lines.push(`Error: ${run.error}`);
  if (run.lastOutput !== null && run.lastOutput !== '') lines.push('Last output:', run.lastOutput);
  if (a.toolCalls !== undefined) {
    if (a.toolCalls.length === 0) {
      lines.push('Tool calls: none');
    } else {
      lines.push('Tool calls:');
      for (const call of a.toolCalls) lines.push(`- ${call.title} (${call.status || 'no status'})`);
    }
  }
  return lines;
}

function contextSection(b: RunBrief): string[] {
  const lines = ['# Context'];
  if (b.parents.length > 0) {
    lines.push('', 'The tasks this one depends on, and what each handed off:');
    for (const p of b.parents) {
      lines.push('', `## Parent ${p.task.taskId}: ${p.task.title} (${p.task.phase})`);
      lines.push(p.summary === null ? 'No handoff: it was never completed.' : `Summary: ${p.summary}`);
      if (p.metadata !== null && p.metadata !== undefined) lines.push(`Metadata: ${json(p.metadata)}`);
    }
  }
  if (b.attempts.length > 0) {
    lines.push('', 'Earlier attempts on this task, oldest first. A retry starts fresh: check the workspace for what these left behind.');
    for (const a of b.attempts) lines.push('', ...attemptLines(a));
  }
  if (b.comments.length > 0) {
    lines.push('', '## Comments');
    for (const c of b.comments) lines.push(`- ${c.author}: ${c.body}`);
  }
  if (b.children.length > 0) {
    lines.push('', '## Children', 'Tasks that wait on this one:');
    for (const c of b.children) {
      lines.push(`- ${c.taskId}: ${c.title} (${c.assignee === null ? 'unassigned' : c.assignee.name}, ${c.phase})`);
    }
  }
  if (lines.length === 1) lines.push('', 'Nothing yet: no parents, earlier attempts, comments or children.');
  return lines;
}

export function composePrompt(b: RunBrief): string {
  const head: string[] = [];
  if (b.roleMd !== undefined && b.roleMd.trim() !== '') head.push('# Your role', '', b.roleMd.trim(), '');
  if (b.skills.length > 0) {
    head.push('# Skills', '', 'Read a skill\'s SKILL.md when it applies to what you are doing:');
    for (const s of b.skills) head.push(`- ${s.name}: ${s.description} (${s.path})`);
    head.push('');
  }
  head.push('# How to work', '', b.kind === 'work' ? WORK_PROTOCOL : REVIEW_PROTOCOL, '', PRECEDENCE, '');
  const told = [...taskSection(b.task), '', ...contextSection(b)].join('\n');
  return `${head.join('\n')}\n${redactKnownSecrets(told)}\n`;
}
```

- [ ] **Step 6.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  798 passed (798)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 6.5: Commit.**

```bash
git add src/kanban/prompt.ts tests/kanban-prompt.test.ts
git commit -m "Compose a run's task prompt, masking its task and context"
```

---

### Task 7: Gathering what a run is told

**Files:**
- Create: `src/kanban/brief.ts`, `tests/kanban-brief.test.ts`

`briefFor` reads the board when a run is claimed:
- each parent with its latest completion;
- every earlier attempt on the task, with its tool calls if it ended without a report (Decision 13), read from its own session;
- the comments and the children.

It takes C1's `Claimed` (the run, the task, the `role.md` text the claim hashed, and the role whose skill files the claim checked), so the prompt uses exactly what the run records.

- [ ] **Step 7.1: Write the failing tests.** Create `tests/kanban-brief.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/db/events.js';
import {
  addComment,
  archive,
  attachSession,
  block,
  closeRun,
  complete,
  DEFAULT_LIMITS,
  endRun,
  unblock,
} from '../src/db/kanban.js';
import { createSession } from '../src/db/sessions.js';
import { briefFor, endedUnreported } from '../src/kanban/brief.js';
import type { Role } from '../src/roles.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';

let h: TestDb;

beforeEach(() => {
  h = testDb();
});

afterEach(() => h.close());

const ROLE: Role = {
  name: 'implementer',
  source: 'directory',
  dir: '/r',
  description: undefined,
  workspace: undefined,
  agent: {
    driver: 'structured-cli',
    command: 'bytesec',
    args: [],
    env: {},
    unsupervised: true,
    passEnv: [],
    readOnlyTools: [],
    maskExempt: [],
  },
  roleMdPath: '/r/role.md',
  skills: [{ name: 'testing', description: 'How to test', dir: '/r/skills/testing', path: '/r/skills/testing/SKILL.md' }],
  secretValues: [],
};

/** A session for a run, with one tool call in its log. */
function sessionWithCall(id: string, title: string): string {
  createSession(h.db, { id, agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
  appendEvent(h.db, id, { type: 'turn_submitted', actor: 'user', turnId: 't_1', payload: { text: 'go' } }, NOW);
  appendEvent(
    h.db,
    id,
    { type: 'tool_call', actor: 'agent', turnId: 't_1', payload: { toolCallId: 'c1', title, status: 'completed', raw: {} } },
    NOW,
  );
  return id;
}

describe('briefFor', () => {
  it("gathers the parents' handoffs, the earlier attempts with their tool calls, comments and children", () => {
    const parent = newTask(h.db, { title: 'Design' });
    const p = claimed(h.db, parent.taskId);
    expect(
      complete(h.db, parent.taskId, { kind: 'run', runId: p.runId }, { summary: 'Use YAML.', metadata: { doc: 'a.md' } }, NOW)
        .ok,
    ).toBe(true);
    expect(closeRun(h.db, p.runId, NOW).ok).toBe(true);

    const task = newTask(h.db, { title: 'Build', parents: [parent.taskId] });
    const child = newTask(h.db, { title: 'Review', parents: [task.taskId] });
    const first = claimed(h.db, task.taskId);
    expect(attachSession(h.db, first.runId, sessionWithCall('s_first', 'edit'), NOW).ok).toBe(true);
    expect(endRun(h.db, first.runId, { outcome: 'crashed', error: 'exited' }, DEFAULT_LIMITS, NOW).ok).toBe(true);
    expect(closeRun(h.db, first.runId, NOW).ok).toBe(true);
    expect(addComment(h.db, task.taskId, ALICE, 'Mind the BOM.', NOW).ok).toBe(true);

    const second = claimed(h.db, task.taskId);
    const brief = briefFor(h.db, { run: second, task, roleMd: 'Be careful.', role: ROLE });

    expect(brief.kind).toBe('work');
    expect(brief.roleMd).toBe('Be careful.');
    expect(brief.skills.map((s) => s.name)).toEqual(['testing']);
    expect(brief.parents).toEqual([
      expect.objectContaining({ summary: 'Use YAML.', metadata: { doc: 'a.md' }, task: expect.objectContaining({ title: 'Design' }) }),
    ]);
    expect(brief.attempts).toHaveLength(1);
    expect(brief.attempts[0]?.run).toMatchObject({ runId: first.runId, outcome: 'crashed', error: 'exited' });
    expect(brief.attempts[0]?.toolCalls).toEqual([{ toolCallId: 'c1', title: 'edit', status: 'completed' }]);
    expect(brief.comments.map((c) => c.body)).toEqual(['Mind the BOM.']);
    expect(brief.children.map((c) => c.taskId)).toEqual([child.taskId]);
  });

  it('gives an archived parent no handoff, and an attempt that reported no tool calls', () => {
    const parent = newTask(h.db, { title: 'Dropped' });
    expect(archive(h.db, parent.taskId, ALICE, NOW).ok).toBe(true);
    const task = newTask(h.db, { parents: [parent.taskId] });
    const first = claimed(h.db, task.taskId);
    expect(attachSession(h.db, first.runId, sessionWithCall('s_first', 'edit'), NOW).ok).toBe(true);
    const by = { kind: 'run', runId: first.runId } as const;
    expect(block(h.db, task.taskId, by, { kind: 'needs_input', reason: 'which format?' }, NOW).ok).toBe(true);
    expect(closeRun(h.db, first.runId, NOW).ok).toBe(true);
    expect(unblock(h.db, task.taskId, ALICE, 'YAML', NOW).ok).toBe(true);

    const second = claimed(h.db, task.taskId);
    const brief = briefFor(h.db, { run: second, task, roleMd: undefined, role: undefined });
    expect(brief.parents).toEqual([expect.objectContaining({ summary: null, metadata: null })]);
    expect(brief.skills).toEqual([]);
    expect(brief.attempts).toEqual([{ run: expect.objectContaining({ outcome: 'blocked' }), toolCalls: undefined }]);
  });
});

describe('endedUnreported', () => {
  it('is true for the outcomes of a run that ended without a report, and for nothing else', () => {
    const task = newTask(h.db);
    const run = claimed(h.db, task.taskId);
    expect(endedUnreported(run)).toBe(false);
    for (const outcome of ['failed', 'crashed', 'timed_out', 'protocol_violation', 'rate_limited', 'interrupted'] as const) {
      expect(endedUnreported({ ...run, outcome })).toBe(true);
    }
    for (const outcome of ['completed', 'review_requested', 'blocked', 'cancelled', 'superseded'] as const) {
      expect(endedUnreported({ ...run, outcome })).toBe(false);
    }
  });
});
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-brief.test.ts`. Expected: FAIL, with `Error: Cannot find module '../src/kanban/brief.js'`, and `Tests  no tests`.

- [ ] **Step 7.3: Implement.** Create `src/kanban/brief.ts`:

```ts
import type { Db } from '../db/open.js';
import { childrenOf, commentsOf, latestCompletion, parentsOf, runsOf } from '../db/kanban-read.js';
import type { Role } from '../roles.js';
import type { Attempt, ParentHandoff, RunBrief } from './prompt.js';
import { toolCallsOf } from './session-log.js';
import { ENDED_OUTCOMES, type RunRow, type TaskRow } from './types.js';

/**
 * Gather what a run's prompt is composed from (spec §7.1), as the board holds it
 * when the run is claimed: each parent's latest handoff, every earlier attempt,
 * the comment thread and the children.
 */

/**
 * A run that ended without a report: failed, crashed, timed out, throttled,
 * interrupted, or a protocol violation. A retry is told the tool calls it made,
 * from its own session's log, so it knows what it is retrying after (spec §8.3).
 */
export function endedUnreported(run: RunRow): boolean {
  return run.outcome !== null && (ENDED_OUTCOMES as readonly string[]).includes(run.outcome);
}

export interface ClaimedRun {
  run: RunRow;
  task: TaskRow;
  /** The role.md text the claim read and hashed; undefined without one. */
  roleMd: string | undefined;
  /** The role the claim resolved, whose skill files it checked. */
  role: Role | undefined;
}

export function briefFor(db: Db, c: ClaimedRun): RunBrief {
  const taskId = c.task.taskId;
  const parents: ParentHandoff[] = parentsOf(db, taskId).map((task) => {
    const done = latestCompletion(db, task.taskId);
    return { task, summary: done?.summary ?? null, metadata: done?.metadata ?? null };
  });
  const attempts: Attempt[] = runsOf(db, taskId)
    .filter((run) => run.runId !== c.run.runId)
    .map((run) => ({
      run,
      toolCalls: endedUnreported(run) && run.sessionId !== null ? toolCallsOf(db, run.sessionId) : undefined,
    }));
  return {
    kind: c.run.kind,
    roleMd: c.roleMd,
    skills: c.role?.skills ?? [],
    task: c.task,
    parents,
    attempts,
    comments: commentsOf(db, taskId),
    children: childrenOf(db, taskId),
  };
}
```

- [ ] **Step 7.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  801 passed (801)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 7.5: Commit.**

```bash
git add src/kanban/brief.ts tests/kanban-brief.test.ts
git commit -m "Gather what a run is told: handoffs, earlier attempts and their tool calls"
```

---

### Task 8: The sink channel

**Files:**
- Create: `src/kanban/sink.ts`, `tests/kanban-sink.test.ts`

A run's session is bound on the `kanban` channel (spec §2.4 item 4, §7.1). Its card output is discarded, since the session log keeps every event. An approval card fails to send, so the actor releases the agent's request as cancelled rather than leaving it waiting on nobody. Plan D forwards approval cards to a subscriber; until then the service refuses supervised roles, so this is the backstop.

- [ ] **Step 8.1: Write the failing tests.** Create `tests/kanban-sink.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { SessionActor } from '../src/core/session-actor.js';
import { createSession } from '../src/db/sessions.js';
import { bindSession } from '../src/db/bindings.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import { getApproval } from '../src/db/approvals.js';
import { KANBAN_CHANNEL, KanbanSink } from '../src/kanban/sink.js';
import type { BindingKey } from '../src/types.js';
import { FakeDriver } from './helpers/driver.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';

const NOW = 1_760_000_000_000;
const open: TestDb[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe('KanbanSink', () => {
  it('is the kanban channel, and discards text and cards', async () => {
    const sink = new KanbanSink(() => NOW);
    expect(sink.id).toBe(KANBAN_CHANNEL);
    expect(await sink.sendText({ chatId: 'k_1', threadId: 'r_1' }, 'hello', 'u1')).toEqual({
      messageId: 'kanban:u1',
      deduped: false,
    });
    const card = await sink.openCard({ chatId: 'k_1', threadId: 'r_1' }, 'starting', 'u2');
    expect(card).toMatchObject({ messageId: 'kanban:u2', createdAt: NOW });
    await card.set('more');
    await card.finish('done');
    await sink.react('m', 'OK');
    await sink.unreact('m', 'OK');
    await sink.updateApprovalCard('m', { action: 'a', choice: 'b', answeredBy: 'c' });
  });

  it("lets a run's turn complete with every event in the session log", async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    const key: BindingKey = { channel: KANBAN_CHANNEL, appId: 'cli_app', conversationId: 'k_1', threadId: 'r_1' };
    createSession(h.db, { id: 's_run', agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
    bindSession(h.db, key, 's_run', NOW);
    const driver = new FakeDriver();
    driver.scripts.push((ctl) => {
      ctl.emit({ kind: 'message-chunk', text: 'working' });
      ctl.end('completed');
    });
    const actor = new SessionActor({
      db: h.db,
      sessionId: 's_run',
      driver,
      channel: new KanbanSink(() => clock.now()),
      key,
      target: { chatId: 'k_1', threadId: 'r_1' },
      cwd: '/tmp/workspace',
      clock,
    });

    expect(await actor.submit({ messageId: 'kanban:r_1:0', appId: 'cli_app', input: { text: 'go', paths: [] } })).toBe(
      'completed',
    );
    await actor.close();
    expect(readEvents(h.db, 's_run', 0, lastSeq(h.db, 's_run')).map((e) => e.type)).toContain('agent_message_chunk');
  });

  it('refuses an approval card, so the agent is released as cancelled rather than left waiting', async () => {
    const h = testDb();
    open.push(h);
    const clock = new ManualClock(NOW);
    const key: BindingKey = { channel: KANBAN_CHANNEL, appId: 'cli_app', conversationId: 'k_1', threadId: 'r_1' };
    createSession(h.db, { id: 's_run', agentId: 'implementer', workspaceId: 'default', ownerPrincipal: 'kanban' }, NOW);
    bindSession(h.db, key, 's_run', NOW);
    const driver = new FakeDriver();
    let answer: unknown;
    driver.scripts.push(async (ctl) => {
      answer = await ctl.ask('edit src/a.ts', [{ optionId: 'allow', name: 'Allow' }]);
      ctl.end('completed');
    });
    const actor = new SessionActor({
      db: h.db,
      sessionId: 's_run',
      driver,
      channel: new KanbanSink(() => clock.now()),
      key,
      target: { chatId: 'k_1', threadId: 'r_1' },
      cwd: '/tmp/workspace',
      clock,
    });

    await actor.submit({ messageId: 'kanban:r_1:0', appId: 'cli_app', input: { text: 'go', paths: [] } });
    await actor.close();
    expect(answer).toEqual({ kind: 'cancelled' });
    const errors = readEvents(h.db, 's_run', 0, lastSeq(h.db, 's_run')).filter((e) => e.type === 'agent_error');
    expect(JSON.stringify(errors.map((e) => e.payload))).toContain('nothing can reach a person for it');
    const approvalId = (
      readEvents(h.db, 's_run', 0, lastSeq(h.db, 's_run')).find((e) => e.type === 'approval_requested')?.payload as {
        approvalId: string;
      }
    ).approvalId;
    expect(getApproval(h.db, approvalId)?.cardMessageId).toBeNull();
  });
});
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-sink.test.ts`. Expected: FAIL, with `Error: Cannot find module '../src/kanban/sink.js'`, and `Tests  no tests`.

- [ ] **Step 8.3: Implement.** Create `src/kanban/sink.ts`:

```ts
import type {
  ApprovalCardSpec,
  ApprovalOutcomeView,
  CardSession,
  Channel,
  SendResult,
  SendTarget,
} from '../channel/types.js';

/**
 * The channel a kanban run's session posts through (spec §7.1): the `kanban`
 * entry of the registry's channel map, so a run's session never posts to Lark.
 *
 * Card output is discarded: the session log keeps every event, and `/kanban show`
 * reads it there. Nobody is watching a card for a run.
 *
 * An approval card has nowhere to go until plan D forwards it to the task's first
 * subscription, so sending one fails, and the actor releases the request as
 * cancelled -- the honest outcome, since nobody could have been asked. Until then
 * the board refuses roles whose agent asks for approval (spec §12), so this is
 * the backstop.
 */
export const KANBAN_CHANNEL = 'kanban';

class DiscardedCard implements CardSession {
  readonly messageId: string;
  readonly createdAt: number;

  constructor(messageId: string, createdAt: number) {
    this.messageId = messageId;
    this.createdAt = createdAt;
  }

  async set(_text: string): Promise<void> {}

  async finish(_text: string): Promise<void> {}
}

export class KanbanSink implements Channel {
  readonly id = KANBAN_CHANNEL;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async sendText(_target: SendTarget, _text: string, uuid: string): Promise<SendResult> {
    return { messageId: `kanban:${uuid}`, deduped: false };
  }

  async openCard(_target: SendTarget, _initialText: string, uuid: string): Promise<CardSession> {
    return new DiscardedCard(`kanban:${uuid}`, this.#now());
  }

  async sendApprovalCard(target: SendTarget, _spec: ApprovalCardSpec, _uuid: string): Promise<SendResult> {
    throw new Error(
      `task ${target.chatId} asked for approval, and nothing can reach a person for it until the board is in Lark`,
    );
  }

  async updateApprovalCard(_messageId: string, _view: ApprovalOutcomeView): Promise<void> {}

  async react(_messageId: string, _emoji: string): Promise<void> {}

  async unreact(_messageId: string, _emoji: string): Promise<void> {}
}
```

- [ ] **Step 8.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  804 passed (804)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 8.5: Commit.**

```bash
git add src/kanban/sink.ts tests/kanban-sink.test.ts
git commit -m "Give kanban runs a sink channel that posts nowhere"
```

---

### Task 9: The registry: pinning, refusing a build, archiving

**Files:**
- Modify: `src/core/registry.ts`, `tests/registry.test.ts`

The three registry changes spec §2.4 item 3 and §8.4 need:
- **`pinned`**: a dependency the registry asks when it makes room. A pinned actor, an open run's, is never retired as idle. The registry goes over its cap instead, as it does for a busy actor.
- **`envFor` before making room.** The registry now asks it with the role, workspace and channel checks, before anything is retired. `envFor` may throw to refuse the build (Decision 23), and a refusal leaves every other actor live.
- **`archive(key, reason)`**: release the actor bound at a place, archive its session and revoke the binding (Decision 7).

Chat sessions are unchanged: they are never pinned, and `envFor` returns nothing for them.

- [ ] **Step 9.1: Write the failing tests.**

In `tests/registry.test.ts`, replace:

```ts
    envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
  } = {},
```

with:

```ts
    envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
    pinned?: (sessionId: string) => boolean;
  } = {},
```

In `tests/registry.test.ts`, replace:

```ts
    ...(extra.envFor === undefined ? {} : { envFor: extra.envFor }),
    workspaces,
```

with:

```ts
    ...(extra.envFor === undefined ? {} : { envFor: extra.envFor }),
    ...(extra.pinned === undefined ? {} : { pinned: extra.pinned }),
    workspaces,
```

Add to the end of `tests/registry.test.ts`:

```ts

describe('kanban runs', () => {
  it('never retires a pinned actor to make room, even an idle one, and goes over its cap instead', async () => {
    const pinned = new Set<string>();
    const h = harness(1, { pinned: (sessionId) => pinned.has(sessionId) });
    const run = h.registry.bindOrCreate(key({ conversationId: 'oc_run' }), OWNER).session;
    pinned.add(run.id);
    await h.registry.actorFor(run.id, key({ conversationId: 'oc_run' }));
    const chat = h.registry.bindOrCreate(key({ conversationId: 'oc_chat' }), OWNER).session;
    await h.registry.actorFor(chat.id, key({ conversationId: 'oc_chat' }));

    expect(h.registry.liveActor(run.id)).toBeDefined();
    expect(h.registry.liveCount).toBe(2);
    expect(h.notes.some((n) => n.includes('over capacity'))).toBe(true);

    // Unpinned, it is an idle actor like any other.
    pinned.delete(run.id);
    const third = h.registry.bindOrCreate(key({ conversationId: 'oc_3' }), OWNER).session;
    await h.registry.actorFor(third.id, key({ conversationId: 'oc_3' }));
    expect(h.registry.liveActor(run.id)).toBeUndefined();
  });

  it('asks for the environment before making room, so a refusal retires nothing', async () => {
    const h = harness(1, {
      envFor: (sessionId) => {
        if (sessionId === 's_lost') throw new Error('run r_1 has no environment');
        return undefined;
      },
    });
    const live = h.registry.bindOrCreate(key({ conversationId: 'oc_live' }), OWNER).session;
    await h.registry.actorFor(live.id, key({ conversationId: 'oc_live' }));
    createSession(h.db.db, { id: 's_lost', agentId: 'default', workspaceId: '', ownerPrincipal: 'kanban' }, NOW);
    await expect(h.registry.actorFor('s_lost', key({ conversationId: 'oc_lost' }))).rejects.toThrow(
      'run r_1 has no environment',
    );
    expect(h.registry.liveActor(live.id)).toBeDefined();
    expect(h.workspaces.acquired).toEqual([live.id]);
  });

  it("archives the session bound at a place, closing its actor and revoking the binding", async () => {
    const h = harness();
    const at = key({ channel: 'lark', conversationId: 'k_task', threadId: 'r_1' });
    const session = h.registry.create(at, OWNER);
    await h.registry.actorFor(session.id, at);

    await h.registry.archive(at, 'the run is over');
    expect(h.registry.liveActor(session.id)).toBeUndefined();
    expect(getSession(h.db.db, session.id)?.state).toBe('archived');
    expect(resolveBinding(h.db.db, at)).toBeUndefined();
    expect(bindingsForSession(h.db.db, session.id)).toEqual([]);
    const last = readEvents(h.db.db, session.id, 0, lastSeq(h.db.db, session.id)).at(-1);
    expect(last).toMatchObject({
      type: 'session_state_changed',
      payload: { state: 'archived', reason: 'the run is over' },
    });
  });

  it('archives nothing where nothing is bound', async () => {
    const h = harness();
    await h.registry.archive(key({ conversationId: 'oc_none' }), 'nothing');
    expect(h.registry.liveCount).toBe(0);
  });
});
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/registry.test.ts`. Expected: the four new tests FAIL. The first two fail with `AssertionError: expected undefined to be defined`, and the archive tests with `TypeError: h.registry.archive is not a function`. The summary is `Tests  4 failed | 54 passed (58)`.

- [ ] **Step 9.3: Implement.**

In `src/core/registry.ts`, replace:

```ts
   * §2.4 item 3). Plan C's dispatcher holds a run's environment in memory only.
   */
  envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
  workspaces: WorkspaceProvider;
```

with:

```ts
   * §2.4 item 3). Plan C's dispatcher holds a run's environment in memory only.
   * Asked before anything is retired to make room, so it may throw to refuse the
   * build: a run's session rebuilt with its environment gone (spec §2.4 item 3).
   */
  envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
  /**
   * Sessions never retired as idle to make room: an open kanban run's (spec §2.4
   * item 3), so it cannot be rebuilt between one turn and the next. The registry
   * goes over its cap instead, as it does for busy actors.
   */
  pinned?: (sessionId: string) => boolean;
  workspaces: WorkspaceProvider;
```

In `src/core/registry.ts`, replace:

```ts
      throw new Error(`session ${sessionId} is bound on channel ${key.channel}, which this gateway does not run`);
    }

    await this.#makeRoom();
```

with:

```ts
      throw new Error(`session ${sessionId} is bound on channel ${key.channel}, which this gateway does not run`);
    }
    // With the checks, before #makeRoom: the dispatcher refuses a run's session
    // whose environment did not survive a restart (spec §2.4 item 3).
    const env = this.#deps.envFor?.(sessionId);

    await this.#makeRoom();
```

In `src/core/registry.ts`, replace:

```ts
    const workspace = await this.#deps.workspaces.acquire(sessionId, workspaceId);
    const env = this.#deps.envFor?.(sessionId);
    const target: SendTarget = { chatId: key.conversationId, threadId: key.threadId };
```

with:

```ts
    const workspace = await this.#deps.workspaces.acquire(sessionId, workspaceId);
    const target: SendTarget = { chatId: key.conversationId, threadId: key.threadId };
```

In `src/core/registry.ts`, replace:

```ts
   * Retire the least-recently-used actor that is not doing anything.
   *
   * A busy actor is never retired, even when that leaves the registry over its cap.
   * The trade is deliberate and one-sided: being over the cap is a capacity problem
   * that shows up in a metric, whereas closing a session mid-turn destroys work the
   * user is waiting for.
   */
  async #makeRoom(): Promise<void> {
```

with:

```ts
   * Retire the least-recently-used actor that is not doing anything.
   *
   * A busy actor is never retired, and nor is a pinned one -- an open kanban
   * run's -- even when that leaves the registry over its cap. The trade is
   * deliberate and one-sided: being over the cap is a capacity problem that shows
   * up in a metric, whereas closing a session mid-turn destroys work the user is
   * waiting for.
   */
  async #makeRoom(): Promise<void> {
```

In `src/core/registry.ts`, replace:

```ts
    const candidates = [...this.#actors.entries()]
      .filter(([, entry]) => !entry.actor.status().busy)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
```

with:

```ts
    const candidates = [...this.#actors.entries()]
      .filter(([sessionId, entry]) => !entry.actor.status().busy && this.#deps.pinned?.(sessionId) !== true)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
```

In `src/core/registry.ts`, replace:

```ts
    this.#actors.delete(sessionId);
    await entry.actor.close();
    await this.#deps.workspaces.release(sessionId);
  }

  async closeAll(): Promise<void> {
```

with:

```ts
    this.#actors.delete(sessionId);
    await entry.actor.close();
    await this.#deps.workspaces.release(sessionId);
  }

  /**
   * Archive the session bound at this location and revoke its binding: a kanban
   * run's session once the run is closed (spec §7.4, §8.4). It is never resumed --
   * a new run gets a new session -- and a stale approval card for it resolves to
   * "no longer bound". Its log is kept. Nothing bound here is nothing to do.
   */
  async archive(key: BindingKey, reason: string): Promise<void> {
    const bound = resolveBinding(this.#deps.db, key);
    if (bound === undefined) return;
    await this.release(bound.sessionId);
    const now = this.#clock.now();
    setState(this.#deps.db, bound.sessionId, 'archived', now);
    appendEvent(
      this.#deps.db,
      bound.sessionId,
      { type: 'session_state_changed', actor: 'gateway', payload: { state: 'archived', reason } },
      now,
    );
    revokeBindingsAt(this.#deps.db, key, now);
  }

  async closeAll(): Promise<void> {
```

- [ ] **Step 9.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  808 passed (808)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 9.5: Commit.**

```bash
git add src/core/registry.ts tests/registry.test.ts
git commit -m "Pin open runs' actors, refuse a build before making room, and archive a run's session"
```

---

### Task 10: The dispatcher: a run is a session

**Files:**
- Create: `src/kanban/dispatcher.ts`, `tests/helpers/dispatch.ts`, `tests/kanban-dispatcher.test.ts`

A pass (spec §6.2) lists the claimable tasks in order and claims each through the service. The claim enforces one open agent run per workspace (spec §6.3) inside its transaction, and refuses the rest of a busy workspace's tasks until the run there closes. A refusal is left to the board: an unassignable task is noted by the claim, and anything else waits for the next pass.

Each agent claim starts a run (spec §7.1):
- a fresh session as the run's role, in the task's workspace, bound on `kanban` at (task id, run id), seeded when the claim chose a run to resume (Decision 11);
- `attachSession`;
- the run's environment, held in memory (Decision 19);
- the task prompt, submitted as `kanban:<run_id>:<n>`.

When the turn ends (spec §7.4), a decided run keeps its outcome, and an undecided one ends: `protocol_violation` if the turn completed (Decision 6), `failed` otherwise. Task 12 brings in the classifier. The run's session is then archived, the run closed (Decision 21), and a pass looks for the next claim. A run whose session cannot be created ends the same way (Decision 17).

The harness in `tests/helpers/dispatch.ts` wires the real board, registry, actors and sink, with one `FakeDriver` per role, the way `src/index.ts` will in Task 15. Its agents report through the service, using `MT_KANBAN_RUN` from their start options.

- [ ] **Step 10.1: Write the failing tests.** First the harness. Create `tests/helpers/dispatch.ts`:

```ts
import type { Channel } from '../../src/channel/types.js';
import { SessionRegistry } from '../../src/core/registry.js';
import { NamedWorkspaces } from '../../src/core/workspace.js';
import { getRun } from '../../src/db/kanban-read.js';
import { Dispatcher, type DispatcherSettings } from '../../src/kanban/dispatcher.js';
import { KanbanService, type CreateRequest } from '../../src/kanban/service.js';
import { KanbanSink } from '../../src/kanban/sink.js';
import type { RunRow, TaskRow } from '../../src/kanban/types.js';
import type { Role } from '../../src/roles.js';
import type { TurnTerminal } from '../../src/types.js';
import { FakeChannel } from './channel.js';
import { FakeDriver } from './driver.js';
import { ManualClock, settle, testDb, type TestDb } from './db.js';
import { ALICE, VIA } from './kanban.js';

/**
 * A dispatcher over the real board, session registry and actors, with a fake
 * driver per role: the agents are scripts, and report through the service the
 * way plan C3's worker CLI will, using the run id in their environment.
 */

export const APP = 'cli_app';

export function role(name: string, extra: Partial<Role> = {}, readOnlyTools: readonly string[] = []): Role {
  return {
    name,
    source: 'directory',
    dir: undefined,
    description: undefined,
    workspace: undefined,
    agent: {
      driver: 'structured-cli',
      command: 'bytesec',
      args: ['run'],
      env: {},
      unsupervised: true,
      passEnv: [],
      readOnlyTools,
      maskExempt: [],
    },
    roleMdPath: undefined,
    skills: [],
    secretValues: [],
    ...extra,
  };
}

export interface DispatchHarness {
  t: TestDb;
  clock: ManualClock;
  service: KanbanService;
  registry: SessionRegistry;
  dispatcher: Dispatcher;
  lark: FakeChannel;
  notes: string[];
  driver(roleName: string): FakeDriver;
  /** Create a task through the service, as chat would. */
  create(req: Partial<CreateRequest>): TaskRow;
  /** The run an agent started on this driver most recently is working on. */
  runOf(driver: FakeDriver): RunRow;
  close(): void;
}

export interface HarnessOptions {
  roles?: readonly Role[];
  settings?: Partial<DispatcherSettings>;
  maxLive?: number;
  /** Another harness's database: a second gateway process, after a restart. */
  t?: TestDb;
  clock?: ManualClock;
}

export const DEFAULT_ROLES: readonly Role[] = [
  role('implementer'),
  role('reviewer'),
  role('docs-writer', { workspace: 'docs' }),
];

export function dispatchHarness(opts: HarnessOptions = {}): DispatchHarness {
  const t = opts.t ?? testDb();
  const clock = opts.clock ?? new ManualClock();
  const roles = new Map((opts.roles ?? DEFAULT_ROLES).map((r) => [r.name, r]));
  const drivers = new Map([...roles.keys(), 'default'].map((name) => [name, new FakeDriver(name)]));
  const workspaces = new Map(['default', 'web', 'api', 'docs'].map((name) => [name, `/tmp/ws-${name}`]));
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(workspaces.keys()), clock });
  const lark = new FakeChannel({ id: 'lark', clock });
  const notes: string[] = [];
  // The registry asks the dispatcher, which is built after it, as in src/index.ts.
  let dispatcher: Dispatcher | undefined;
  const registry = new SessionRegistry({
    db: t.db,
    drivers,
    channels: new Map<string, Channel>([
      ['lark', lark],
      ['kanban', new KanbanSink(() => clock.now())],
    ]),
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(workspaces),
    appId: APP,
    clock,
    maxLive: opts.maxLive ?? 8,
    note: (line) => notes.push(line),
  });
  dispatcher = new Dispatcher({
    db: t.db,
    service,
    sessions: registry,
    roles,
    appId: APP,
    settings: { maxRunning: 8, defaultMaxRuntimeS: 4 * 3600, strandedAfterS: 1800, sweepIntervalS: 60, ...opts.settings },
    clock,
    note: (line) => notes.push(line),
  });
  return {
    t,
    clock,
    service,
    registry,
    dispatcher,
    lark,
    notes,
    driver(roleName) {
      const d = drivers.get(roleName);
      if (d === undefined) throw new Error(`no driver for role ${roleName}`);
      return d;
    },
    create(req) {
      const r = service.create({ title: 'a task', assignee: 'implementer', createdBy: ALICE, createdVia: VIA, ...req });
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return r.task;
    },
    runOf(driver) {
      const runId = driver.starts.at(-1)?.env?.['MT_KANBAN_RUN'];
      const run = runId === undefined ? undefined : getRun(t.db, runId);
      if (run === undefined) throw new Error(`driver ${driver.id} has started no run`);
      return run;
    },
    close: () => t.close(),
  };
}

/** Let the runs move until `done` holds, or give up. */
export async function until(done: () => boolean, what = 'the condition'): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (done()) return;
    await settle();
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** Report complete through the service, as the agent of this driver's latest run would. */
export function reportComplete(h: DispatchHarness, driver: FakeDriver, summary = 'done'): void {
  const run = h.runOf(driver);
  const r = h.service.complete(run.taskId, { kind: 'run', runId: run.runId }, { summary });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
}

/** The next turn on this driver reports complete, then ends. */
export function completes(h: DispatchHarness, driver: FakeDriver, summary = 'done'): void {
  driver.scripts.push((ctl) => {
    reportComplete(h, driver, summary);
    ctl.end('completed');
  });
}

/** A turn held open until the test lets it end; `started` once it is running. */
export interface Held {
  started: boolean;
  /** End the turn: optionally do something first, as the agent, then end with `terminal`. */
  end(terminal?: TurnTerminal, first?: () => void): void;
}

export function holds(driver: FakeDriver): Held {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ending: { terminal: TurnTerminal; first: (() => void) | undefined } = { terminal: 'completed', first: undefined };
  const held: Held = {
    started: false,
    end(terminal = 'completed', first) {
      ending = { terminal, first };
      release?.();
    },
  };
  driver.scripts.push(async (ctl) => {
    held.started = true;
    await gate;
    ending.first?.();
    ctl.end(ending.terminal);
  });
  return held;
}
```

Then the tests. Create `tests/kanban-dispatcher.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { bindingsForSession, resolveBinding } from '../src/db/bindings.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { getSession } from '../src/db/sessions.js';
import { runKey } from '../src/kanban/dispatcher.js';
import {
  APP,
  completes,
  dispatchHarness,
  holds,
  reportComplete,
  until,
  type DispatchHarness,
} from './helpers/dispatch.js';

const open: DispatchHarness[] = [];

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe('Dispatcher: a run is a session', () => {
  it('claims a ready task and runs it in a fresh session on the kanban channel, then closes it', async () => {
    const h = harness();
    const task = h.create({ title: 'Write the parser', workspace: 'web' });
    const implementer = h.driver('implementer');
    completes(h, implementer, 'parsed');

    h.dispatcher.pass();
    await h.dispatcher.idle();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(run).toMatchObject({ outcome: 'completed', summary: 'parsed', submissions: 1 });
    expect(run?.endedAt).not.toBeNull();
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');

    // The agent ran as the role, in the task's workspace, with the run in its environment.
    expect(implementer.starts).toHaveLength(1);
    expect(implementer.starts[0]).toMatchObject({ cwd: '/tmp/ws-web', env: { MT_KANBAN_RUN: run?.runId } });
    expect(implementer.runtimes[0]?.prompts[0]?.text).toContain(`${task.taskId}: Write the parser`);

    // Its own session, bound at the run's key, archived once the run closed.
    const sessionId = run?.sessionId ?? '';
    expect(getSession(h.t.db, sessionId)).toMatchObject({ agentId: 'implementer', workspaceId: 'web', state: 'archived' });
    expect(resolveBinding(h.t.db, runKey(APP, { taskId: task.taskId, runId: run?.runId ?? '' }))).toBeUndefined();
    expect(bindingsForSession(h.t.db, sessionId)).toEqual([]);
    const submitted = readEvents(h.t.db, sessionId, 0, lastSeq(h.t.db, sessionId)).find((e) => e.type === 'turn_submitted');
    expect(submitted?.payload).toMatchObject({ messageId: `kanban:${run?.runId}:0` });

    // Nothing went to Lark.
    expect(h.lark.calls).toEqual([]);
  });

  it('ends a turn that finishes without a report as a protocol violation, and retries it in a new session', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      ctl.emit({ kind: 'message-chunk', text: 'Next I will run the tests.' });
      ctl.end('completed');
    });

    h.dispatcher.pass();
    await h.dispatcher.idle();

    // The default failure limit is 2: the first attempt, one retry, then the task gives up.
    const runs = runsOf(h.t.db, task.taskId);
    expect(runs.map((r) => r.outcome)).toEqual(['protocol_violation', 'protocol_violation']);
    expect(runs[0]).toMatchObject({ lastOutput: 'Next I will run the tests.', error: 'the run ended its turn without reporting' });
    expect(new Set(runs.map((r) => r.sessionId)).size).toBe(2);
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'blocked', blockKind: 'gave_up' });
  });

  it("seeds a rework's session from the provider session of the work it resumes", async () => {
    const h = harness();
    const task = h.create({ workspace: 'web', reviewer: 'reviewer' });
    const implementer = h.driver('implementer');
    implementer.providerSessionId = 'prov_impl';
    implementer.scripts.push((ctl) => {
      const run = h.runOf(implementer);
      expect(h.service.requestReview(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'please look' }).ok).toBe(
        true,
      );
      ctl.end('completed');
    });
    const reviewer = h.driver('reviewer');
    reviewer.scripts.push((ctl) => {
      const run = h.runOf(reviewer);
      expect(h.service.requestChanges(task.taskId, { kind: 'run', runId: run.runId }, 'add a test').ok).toBe(true);
      ctl.end('completed');
    });
    completes(h, implementer, 'with a test');

    h.dispatcher.pass();
    await h.dispatcher.idle();

    const runs = runsOf(h.t.db, task.taskId);
    expect(runs.map((r) => [r.kind, r.outcome])).toEqual([
      ['work', 'review_requested'],
      ['review', 'changes_requested'],
      ['work', 'completed'],
    ]);
    expect(runs[2]?.seededFromRun).toBe(runs[0]?.runId);
    expect(implementer.starts.map((s) => s.providerSessionId)).toEqual([undefined, 'prov_impl']);
    expect(reviewer.starts[0]?.cwd).toBe('/tmp/ws-web');
  });
});

describe('Dispatcher: one agent run per workspace', () => {
  it('runs one task at a time in a workspace, and tasks in different workspaces at once', async () => {
    const h = harness();
    const first = h.create({ title: 'first', workspace: 'web' });
    const second = h.create({ title: 'second', workspace: 'web' });
    const elsewhere = h.create({ title: 'elsewhere', workspace: 'docs', assignee: 'docs-writer' });
    const held = holds(h.driver('implementer'));
    const docs = holds(h.driver('docs-writer'));

    h.dispatcher.pass();
    await until(() => held.started && docs.started, 'both runs to start');

    expect(runsOf(h.t.db, first.taskId)).toHaveLength(1);
    expect(runsOf(h.t.db, second.taskId)).toHaveLength(0);
    expect(runsOf(h.t.db, elsewhere.taskId)).toHaveLength(1);

    // The first reports and ends; its workspace is free, and the second is claimed.
    completes(h, h.driver('implementer'));
    held.end('completed', () => reportComplete(h, h.driver('implementer')));
    docs.end('completed', () => reportComplete(h, h.driver('docs-writer')));
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, second.taskId).map((r) => r.outcome)).toEqual(['completed']);
  });

  it('holds the workspace until a run that has reported has closed', async () => {
    const h = harness();
    const parent = h.create({ title: 'parent', workspace: 'web' });
    const child = h.create({ title: 'child', parents: [parent.taskId] });
    const implementer = h.driver('implementer');
    let finish: (() => void) | undefined;
    const tidying = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reported = false;
    implementer.scripts.push(async (ctl) => {
      const run = h.runOf(implementer);
      expect(h.service.complete(parent.taskId, { kind: 'run', runId: run.runId }, { summary: 'done' }).ok).toBe(true);
      reported = true;
      // Still going: summarising, committing, in the same checkout.
      await tidying;
      ctl.end('completed');
    });
    completes(h, implementer);

    h.dispatcher.pass();
    await until(() => reported, 'the parent to report');
    h.dispatcher.pass();

    // The child is ready, but the parent's run is still open in its workspace.
    expect(getTask(h.t.db, parent.taskId)?.phase).toBe('done');
    expect(runsOf(h.t.db, child.taskId)).toHaveLength(0);

    finish?.();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, child.taskId).map((r) => [r.workspace, r.outcome])).toEqual([['web', 'completed']]);
  });

  it('claims by priority, then age', async () => {
    const h = harness();
    h.create({ title: 'old', workspace: 'web' });
    h.clock.advance(1);
    h.create({ title: 'urgent', workspace: 'web', priority: 5 });
    h.clock.advance(1);
    h.create({ title: 'young', workspace: 'web' });
    const implementer = h.driver('implementer');
    for (let i = 0; i < 3; i += 1) completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();

    const titles = implementer.runtimes.map((r) => /k_\w+: (\w+)/.exec(r.prompts[0]?.text ?? '')?.[1]);
    expect(titles).toEqual(['urgent', 'old', 'young']);
  });

  it('opens one run for a task when two dispatchers pass over one board', async () => {
    const a = harness();
    const b = harness({ t: a.t, clock: a.clock });
    const task = a.create({ workspace: 'web' });
    const held = holds(a.driver('implementer'));

    a.dispatcher.pass();
    b.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    expect(runsOf(a.t.db, task.taskId)).toHaveLength(1);
    expect(b.driver('implementer').starts).toHaveLength(0);
    held.end();
    await a.dispatcher.idle();
  });
});

describe('Dispatcher: an open run is pinned', () => {
  it("keeps an open run's actor live over the registry's cap, and lets it go once closed", async () => {
    const h = harness({ maxLive: 1 });
    const task = h.create({ workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    const sessionId = runsOf(h.t.db, task.taskId)[0]?.sessionId ?? '';
    expect(h.dispatcher.pinned(sessionId)).toBe(true);

    // A chat session arrives while the run is the only live actor.
    const at = { channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: '' };
    const chat = h.registry.bindOrCreate(at, { openId: 'ou_a', unionId: 'on_a', displayName: null }).session;
    await h.registry.actorFor(chat.id, at);
    expect(h.registry.liveActor(sessionId)).toBeDefined();
    expect(h.registry.liveCount).toBe(2);

    held.end();
    await h.dispatcher.idle();
    expect(h.dispatcher.pinned(sessionId)).toBe(false);
    expect(h.registry.liveActor(sessionId)).toBeUndefined();
  });
});
```

- [ ] **Step 10.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-dispatcher.test.ts`. Expected: FAIL, with `Error: Cannot find module '../src/kanban/dispatcher.js'`, and `Tests  no tests`.

- [ ] **Step 10.3: Implement.** Create `src/kanban/dispatcher.ts`:

```ts
import type { SessionRegistry } from '../core/registry.js';
import type { Db } from '../db/open.js';
import { claimableTasks, getRun } from '../db/kanban-read.js';
import { getSession } from '../db/sessions.js';
import type { Role } from '../roles.js';
import { systemClock, type Clock } from '../time.js';
import type { BindingKey, Principal, TurnTerminal } from '../types.js';
import { briefFor } from './brief.js';
import { composePrompt } from './prompt.js';
import type { Claimed, KanbanService } from './service.js';
import { lastTurnOf } from './session-log.js';
import { KANBAN_CHANNEL } from './sink.js';
import type { RunRow } from './types.js';

/**
 * The dispatcher (spec §6): the one component that turns "a task became ready"
 * into "a session got a prompt", and a run's ended turn into a closed run.
 *
 * **One owner, in process.** There is exactly one: two would race to claim the
 * same task, and the one-open-run index would turn that race into errors instead
 * of two agents -- better, but still noise.
 *
 * **Supervision is the actor's** (spec §6.4). The dispatcher does not poll
 * processes or expire claims: the session actor owns the agent process and
 * resolves a submission with the turn's terminal, so a run's end is an event.
 *
 * **One agent run is one gateway session** (spec §3.3), created for the run,
 * bound on the `kanban` channel at (task id, run id), and archived when the run
 * closes: a retry or a rework is a new run in a new session.
 */

export interface DispatcherSettings {
  /** Open agent runs at once (spec §6.3). */
  maxRunning: number;
  /** A run's wall-clock limit unless its task sets one (spec §8.5). */
  defaultMaxRuntimeS: number;
  /** How long a task nobody can be given waits before it is reported stranded (spec §4.2). */
  strandedAfterS: number;
  /** How often the sweep runs (spec §6.1). */
  sweepIntervalS: number;
}

export interface DispatcherDeps {
  db: Db;
  service: KanbanService;
  sessions: SessionRegistry;
  /** The roles as loaded at startup: whose readOnlyTools a run's tool calls are read against. */
  roles: ReadonlyMap<string, Role>;
  appId: string;
  settings: DispatcherSettings;
  clock?: Clock;
  /** Metadata only: ids, outcomes, counts. Never task text or agent output. */
  note?: (line: string) => void;
}

/** Who a run's session belongs to: the board, not a person in a chat. */
export const KANBAN_OWNER: Principal = { openId: 'kanban', unionId: null, displayName: 'kanban' };

/** Where a run's session is bound (spec §7.1): the kanban channel, at the task and the run. */
export function runKey(appId: string, run: { taskId: string; runId: string }): BindingKey {
  return { channel: KANBAN_CHANNEL, appId, conversationId: run.taskId, threadId: run.runId };
}

/** An agent run this process started, by its session. */
interface OpenRun {
  runId: string;
  key: BindingKey;
  /** The run's environment, held only here (spec §2.4 item 3). */
  env: Readonly<Record<string, string>>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Dispatcher {
  readonly #deps: DispatcherDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  /** Open agent runs this process started, by session id. */
  readonly #open = new Map<string, OpenRun>();
  /** Runs being started or waited on, so a test or a shutdown can wait for them. */
  readonly #inflight = new Set<Promise<void>>();

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#note = deps.note ?? (() => undefined);
  }

  /**
   * A session's environment, for the registry to give its agent (spec §2.4 item
   * 3): an open run's `MT_KANBAN_RUN`, held in memory only. Plan C3 adds the
   * run's token, its socket and the `mt` binary's directory.
   */
  envFor(sessionId: string): Readonly<Record<string, string>> | undefined {
    return this.#open.get(sessionId)?.env;
  }

  /** An open run's actor is never retired to make room (spec §2.4 item 3). */
  pinned(sessionId: string): boolean {
    return this.#open.has(sessionId);
  }

  /**
   * One pass (spec §6.2): claim what can be claimed, in order, and start each run.
   * Synchronous up to each run's first prompt, so a pass sees the runs the one
   * before it opened. Runs go on in the background; `idle()` waits for them.
   */
  pass(): void {
    for (const task of claimableTasks(this.#deps.db, this.#clock.now())) {
      const claimed = this.#deps.service.claim(task.taskId);
      // Refusals are the board's to record: the claim notes a task nobody can be
      // given; a busy workspace or a racing claim leaves it for the next pass.
      if (!claimed.ok) continue;
      this.#track(this.#run(claimed));
    }
  }

  /** Wait until no run is being started or waited on. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  #track(work: Promise<void>): void {
    const tracked = work.catch((err: unknown) => this.#note(`kanban: ${message(err)}`));
    this.#inflight.add(tracked);
    void tracked.finally(() => this.#inflight.delete(tracked));
  }

  /**
   * Start an agent run (spec §7.1): a fresh session as the run's role, in the
   * task's workspace, bound at the run's key; then the task prompt, as the
   * session's first turn. Its end is handled when the turn ends (spec §7.4).
   */
  async #run(claimed: Claimed): Promise<void> {
    const { run } = claimed;
    // A person's run is sent a card, from plan D; it holds no session.
    if (run.assignee.kind !== 'role') return;
    const key = runKey(this.#deps.appId, run);
    let sessionId: string;
    try {
      if (run.workspace === null) throw new Error(`run ${run.runId} has no workspace`);
      const seed = this.#seed(run);
      sessionId = this.#deps.sessions.create(key, KANBAN_OWNER, {
        role: run.assignee.name,
        workspace: run.workspace,
        ...(seed === undefined ? {} : { seedProviderSessionId: seed }),
      }).id;
      const attached = this.#deps.service.attachSession(run.runId, sessionId);
      if (!attached.ok) throw new Error(attached.message);
    } catch (err) {
      // Nothing was started, so nothing was changed: an ordinary failure. A
      // session created before the failure is archived with the run.
      this.#deps.service.endRun(run.runId, {
        outcome: 'failed',
        error: `the run could not start: ${message(err)}`,
        hadSideEffects: false,
      });
      this.#note(`kanban: run ${run.runId} could not start`);
      await this.#close(run.runId, key);
      return;
    }
    this.#open.set(sessionId, { runId: run.runId, key, env: { MT_KANBAN_RUN: run.runId } });

    let terminal: TurnTerminal;
    let thrown: string | undefined;
    try {
      const counted = this.#deps.service.countSubmission(run.runId);
      if (!counted.ok) throw new Error(counted.message);
      const prompt = composePrompt(briefFor(this.#deps.db, claimed));
      const actor = await this.#deps.sessions.actorFor(sessionId, key);
      // Its own key per prompt (spec §7.5): the actor deduplicates turns on it.
      terminal = await actor.submit({
        messageId: `kanban:${run.runId}:${counted.n}`,
        appId: this.#deps.appId,
        input: { text: prompt, paths: [] },
      });
    } catch (err) {
      terminal = 'failed';
      thrown = message(err);
    }
    await this.#turnEnded(sessionId, terminal, thrown);
  }

  /**
   * The provider session a rework resumes (spec §2.4 item 5, §5.3): the one the
   * claim chose to seed from. A hint, which the agent replaces with what it reports.
   */
  #seed(run: RunRow): string | undefined {
    if (run.seededFromRun === null) return undefined;
    const from = getRun(this.#deps.db, run.seededFromRun);
    if (from?.sessionId === null || from?.sessionId === undefined) return undefined;
    return getSession(this.#deps.db, from.sessionId)?.providerSessionId ?? undefined;
  }

  /**
   * The run's turn has ended (spec §7.4). A run already decided -- by its own
   * report, or by the dispatcher before it cancelled the turn -- keeps that
   * outcome: the board's truth is what the worker reported, not how its process
   * exited afterwards. An undecided one is ended here.
   */
  async #turnEnded(sessionId: string, terminal: TurnTerminal, thrown: string | undefined): Promise<void> {
    const open = this.#open.get(sessionId);
    if (open === undefined) return;
    const run = getRun(this.#deps.db, open.runId);
    if (run !== undefined && run.outcome === null) {
      const turn = lastTurnOf(this.#deps.db, sessionId);
      const error = [...turn.errors, ...(thrown === undefined ? [] : [thrown])].join('\n');
      this.#deps.service.endRun(
        run.runId,
        terminal === 'completed'
          ? // No report, and the turn completed. Plan C3 nudges first.
            { outcome: 'protocol_violation', error: 'the run ended its turn without reporting', lastOutput: turn.output }
          : { outcome: 'failed', error: error === '' ? `the turn ended ${terminal}` : error, lastOutput: turn.output },
      );
    }
    await this.#close(open.runId, open.key, sessionId);
  }

  /**
   * Archive the run's session, then close the run, and look for the next claim:
   * its workspace is free. Archived first, so a process that dies between the two
   * leaves a decided run open, which the next boot closes (spec §8.4), rather
   * than a closed run whose session is still bound.
   */
  async #close(runId: string, key: BindingKey, sessionId?: string): Promise<void> {
    await this.#deps.sessions.archive(key, 'the run is over');
    const closed = this.#deps.service.closeRun(runId);
    if (closed.ok) this.#note(`kanban: run ${runId} closed, ${closed.run.outcome ?? 'undecided'}`);
    if (sessionId !== undefined) this.#open.delete(sessionId);
    this.pass();
  }
}
```

- [ ] **Step 10.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  816 passed (816)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 10.5: Commit.**

```bash
git add src/kanban/dispatcher.ts tests/helpers/dispatch.ts tests/kanban-dispatcher.test.ts
git commit -m "Dispatch ready tasks onto fresh sessions, one agent run per workspace"
```

---

### Task 11: `kanban.maxRunning`

**Files:**
- Modify: `src/kanban/dispatcher.ts`, `tests/kanban-dispatcher.test.ts`

A pass skips an agent task while `maxRunning` agent runs are open (spec §6.2 step 2, §6.3). The count comes from the board, so it includes a run opened earlier in the same pass, and a run that has reported and is finishing. A person's run holds no process and is not limited.

- [ ] **Step 11.1: Write the failing test.**

Add to the end of `tests/kanban-dispatcher.test.ts`:

```ts

describe('Dispatcher: kanban.maxRunning', () => {
  it('opens no more agent runs than maxRunning, counting runs that have reported and are finishing', async () => {
    const h = harness({ settings: { maxRunning: 2 } });
    const web = h.create({ title: 'web', workspace: 'web' });
    h.clock.advance(1);
    const api = h.create({ title: 'api', workspace: 'api', assignee: 'reviewer' });
    h.clock.advance(1);
    const docs = h.create({ title: 'docs', assignee: 'docs-writer' });
    const implementer = h.driver('implementer');
    let finish: (() => void) | undefined;
    const tidying = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reported = false;
    implementer.scripts.push(async (ctl) => {
      reportComplete(h, implementer);
      reported = true;
      await tidying;
      ctl.end('completed');
    });
    const other = holds(h.driver('reviewer'));
    const third = holds(h.driver('docs-writer'));

    h.dispatcher.pass();
    await until(() => reported && other.started, 'two runs to start');
    h.dispatcher.pass();
    expect([web, api, docs].map((t) => runsOf(h.t.db, t.taskId).length)).toEqual([1, 1, 0]);

    // Once the reported run has closed, there is room for the third.
    finish?.();
    await until(() => third.started, 'the third run to start');
    expect(runsOf(h.t.db, docs.taskId)).toHaveLength(1);

    other.end('completed', () => reportComplete(h, h.driver('reviewer')));
    third.end('completed', () => reportComplete(h, h.driver('docs-writer')));
    await h.dispatcher.idle();
  });
});
```

- [ ] **Step 11.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/kanban-dispatcher.test.ts`. Expected: the new test FAILS with `expected [ 1, 1, 1 ] to deeply equal [ 1, 1, +0 ]`, and `Tests  1 failed | 8 passed (9)`.

- [ ] **Step 11.3: Implement.**

In `src/kanban/dispatcher.ts`, replace:

```ts
import type { Db } from '../db/open.js';
import { claimableTasks, getRun } from '../db/kanban-read.js';
import { getSession } from '../db/sessions.js';
```

with:

```ts
import type { Db } from '../db/open.js';
import { claimableTasks, getRun, openAgentRunCount } from '../db/kanban-read.js';
import { getSession } from '../db/sessions.js';
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    for (const task of claimableTasks(this.#deps.db, this.#clock.now())) {
      const claimed = this.#deps.service.claim(task.taskId);
```

with:

```ts
    for (const task of claimableTasks(this.#deps.db, this.#clock.now())) {
      const who = task.phase === 'review' ? task.reviewer : task.assignee;
      // Counted from the board, so a run opened earlier in this pass counts. A
      // person's run holds no process, and is not limited (spec §6.3).
      if (who?.kind === 'role' && openAgentRunCount(this.#deps.db) >= this.#deps.settings.maxRunning) continue;
      const claimed = this.#deps.service.claim(task.taskId);
```

- [ ] **Step 11.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  817 passed (817)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 11.5: Commit.**

```bash
git add src/kanban/dispatcher.ts tests/kanban-dispatcher.test.ts
git commit -m "Open no more agent runs than kanban.maxRunning"
```

---

### Task 12: Failure and retry

**Files:**
- Modify: `src/kanban/dispatcher.ts`
- Create: `tests/kanban-dispatch-failure.test.ts`

A turn that ended unreported, and that nobody cancelled, is classified (spec §8.1). C1's `endRun` then does the counting (spec §8.2): a provider refusal blocks at once, a throttled run cools down uncounted, and other failures count up to the failure limit. Each ending carries the agent's last output and whether it had side effects (spec §8.3), read from the session log against the role's `readOnlyTools`. The retry is a new run in a new session. Its prompt lists the failed attempt with its error, last output and tool calls (Task 7). A run that reported keeps its report, however its turn ended afterwards (spec §7.4).

- [ ] **Step 12.1: Write the failing tests.** Create `tests/kanban-dispatch-failure.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import type { TurnControl } from './helpers/driver.js';
import { completes, dispatchHarness, reportComplete, role, type DispatchHarness } from './helpers/dispatch.js';

const open: DispatchHarness[] = [];

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

/** A turn that fails the way an agent's does: an error, then a terminal. */
function fails(message: string, terminal: 'failed' | 'ambiguous' = 'failed', calls: readonly string[] = []) {
  return (ctl: TurnControl): void => {
    calls.forEach((title, i) =>
      ctl.emit({ kind: 'tool-call', toolCallId: `c${i}`, title, status: 'completed', raw: {} }),
    );
    ctl.emit({ kind: 'error', message, retryable: false });
    ctl.end(terminal);
  };
}

describe('Dispatcher: a run that fails is classified (spec §8.1)', () => {
  it('blocks at once as capability when the provider refused the credentials', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    h.driver('implementer').scripts.push(fails('API Error: 401 {"error":{"type":"authentication_error"}}'));

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => [r.outcome, r.error])).toEqual([
      ['terminal_provider', 'API Error: 401 {"error":{"type":"authentication_error"}}'],
    ]);
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'blocked', blockKind: 'capability' });
  });

  it('holds a throttled task in its cooldown, uncounted, and claims it again once the cooldown is over', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push(fails('429 Too Many Requests', 'ambiguous'));
    completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['rate_limited']);
    expect(getTask(h.t.db, task.taskId)).toMatchObject({
      phase: 'open',
      consecutiveFailures: 0,
      cooldownUntil: h.clock.now() + 300_000,
    });

    h.clock.advance(299_999);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId)).toHaveLength(1);

    h.clock.advance(1);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['rate_limited', 'completed']);
  });

  it('counts a crash, and retries it in a fresh session told what the crashed run did', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      ctl.emit({ kind: 'message-chunk', text: 'Editing the parser.' });
      fails('the agent exited without finishing its turn', 'ambiguous', ['edit', 'bash'])(ctl);
    });
    completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();

    const [crashed, retry] = runsOf(h.t.db, task.taskId);
    expect(crashed).toMatchObject({ outcome: 'crashed', lastOutput: 'Editing the parser.' });
    expect(retry).toMatchObject({ outcome: 'completed' });
    expect(retry?.sessionId).not.toBe(crashed?.sessionId);
    const prompt = implementer.runtimes[1]?.prompts[0]?.text ?? '';
    expect(prompt).toContain(
      '## Attempt 1 (work, implementer): crashed\nError: the agent exited without finishing its turn\n' +
        'Last output:\nEditing the parser.\nTool calls:\n- edit (completed)\n- bash (completed)',
    );
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'done', consecutiveFailures: 0 });
  });

  it("gives up at the task's failure limit", async () => {
    const h = harness();
    const task = h.create({ workspace: 'web', failureLimit: 3 });
    const implementer = h.driver('implementer');
    for (let i = 0; i < 3; i += 1) implementer.scripts.push(fails('the agent reported a failed turn'));

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['failed', 'failed', 'failed']);
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'blocked', blockKind: 'gave_up', consecutiveFailures: 3 });
  });

  it('records why a runtime would not start, as an ordinary failure', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    h.driver('implementer').failStartWith = new Error('spawn bytesec ENOENT');

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => [r.outcome, r.error])).toEqual([
      ['failed', 'spawn bytesec ENOENT'],
      ['failed', 'spawn bytesec ENOENT'],
    ]);
  });

  it('keeps a report when the turn fails after it: the board believes the worker, not its exit', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      reportComplete(h, implementer);
      fails('Error: 429 Too Many Requests', 'ambiguous')(ctl);
    });

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['completed']);
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');
  });
});

describe('Dispatcher: retry_on_crash if-no-side-effects (spec §8.3)', () => {
  it("retries a run whose tool calls were all its role's read-only tools", async () => {
    const h = harness({ roles: [role('implementer', {}, ['read', 'grep'])] });
    const task = h.create({ workspace: 'web', retryOnCrash: 'if-no-side-effects' });
    const implementer = h.driver('implementer');
    implementer.scripts.push(fails('the agent exited', 'ambiguous', ['read', 'grep']));
    completes(h, implementer);

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['crashed', 'completed']);
  });

  it('holds a run that changed something for a person, rather than retrying it', async () => {
    const h = harness({ roles: [role('implementer', {}, ['read', 'grep'])] });
    const task = h.create({ workspace: 'web', retryOnCrash: 'if-no-side-effects' });
    h.driver('implementer').scripts.push(fails('the agent exited', 'ambiguous', ['read', 'edit']));

    h.dispatcher.pass();
    await h.dispatcher.idle();

    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['crashed']);
    expect(getTask(h.t.db, task.taskId)).toMatchObject({
      phase: 'blocked',
      blockKind: 'needs_input',
      blockReason: 'the run ended crashed after changing things; look before it is retried',
    });
  });
});
```

- [ ] **Step 12.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-dispatch-failure.test.ts`. Expected: five tests FAIL, because every unreported failure is still `failed`. For example, `expected [ [ 'failed', …(1) ], …(1) ] to deeply equal [ [ 'terminal_provider', …(1) ] ]` and `expected [ 'failed' ] to deeply equal [ 'crashed' ]`. The failure-limit, runtime-start and report-stands tests pass already. The summary is `Tests  5 failed | 3 passed (8)`.

- [ ] **Step 12.3: Implement.**

In `src/kanban/dispatcher.ts`, replace:

```ts
import { briefFor } from './brief.js';
import { composePrompt } from './prompt.js';
import type { Claimed, KanbanService } from './service.js';
import { lastTurnOf } from './session-log.js';
import { KANBAN_CHANNEL } from './sink.js';
```

with:

```ts
import { briefFor } from './brief.js';
import { classifyFailure } from './classify.js';
import { composePrompt } from './prompt.js';
import type { Claimed, KanbanService } from './service.js';
import { hadSideEffects, lastTurnOf, toolCallsOf } from './session-log.js';
import { KANBAN_CHANNEL } from './sink.js';
```

In `src/kanban/dispatcher.ts`, replace:

```ts
      const turn = lastTurnOf(this.#deps.db, sessionId);
      const error = [...turn.errors, ...(thrown === undefined ? [] : [thrown])].join('\n');
      this.#deps.service.endRun(
        run.runId,
        terminal === 'completed'
          ? // No report, and the turn completed. Plan C3 nudges first.
            { outcome: 'protocol_violation', error: 'the run ended its turn without reporting', lastOutput: turn.output }
          : { outcome: 'failed', error: error === '' ? `the turn ended ${terminal}` : error, lastOutput: turn.output },
      );
    }
    await this.#close(open.runId, open.key, sessionId);
  }
```

with:

```ts
      const turn = lastTurnOf(this.#deps.db, sessionId);
      // A refusal the actor rethrew is in the log already; one from before the turn is not.
      const errors = thrown === undefined || turn.errors.includes(thrown) ? turn.errors : [...turn.errors, thrown];
      const error = errors.join('\n');
      const ending =
        terminal === 'completed'
          ? // No report, and the turn completed. Plan C3 nudges first.
            { outcome: 'protocol_violation' as const, error: 'the run ended its turn without reporting' }
          : // Classified only here, for a turn nobody cancelled: a run the
            // dispatcher cancels is decided before it asks (spec §6.4).
            { outcome: classifyFailure(terminal, error), error: error === '' ? `the turn ended ${terminal}` : error };
      this.#deps.service.endRun(run.runId, { ...ending, lastOutput: turn.output, ...this.#sideEffects(run, sessionId) });
    }
    await this.#close(open.runId, open.key, sessionId);
  }

  /**
   * Whether the run made a tool call outside its role's readOnlyTools (spec
   * §8.3), read from its session's log. Left out -- unknown, which the board
   * takes as yes -- when the role is no longer configured.
   */
  #sideEffects(run: RunRow, sessionId: string): { hadSideEffects?: boolean } {
    const role = this.#deps.roles.get(run.assignee.name);
    if (role === undefined) return {};
    return { hadSideEffects: hadSideEffects(toolCallsOf(this.#deps.db, sessionId), role.agent.readOnlyTools) };
  }
```

- [ ] **Step 12.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  825 passed (825)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 12.5: Commit.**

```bash
git add src/kanban/dispatcher.ts tests/kanban-dispatch-failure.test.ts
git commit -m "Classify a run that ends unreported, and tell its retry what it did"
```

---

### Task 13: The sweep: runtime limits, cooldowns, stranded tasks

**Files:**
- Modify: `src/kanban/dispatcher.ts`
- Create: `tests/kanban-dispatch-sweep.test.ts`

The sweep runs every `sweepIntervalS` (spec §6.1) and handles what only time changes:
- **The runtime limit** (spec §8.5). An undecided run past its task's `max_runtime_s`, else `defaultMaxRuntimeS`, ends `timed_out`. That outcome is recorded before the turn is cancelled, so the classifier never sees the turn (spec §6.4). A decided run past the limit has its turn cancelled and keeps its outcome. A turn is cancelled once, when its agent has a runtime (Decision 25).
- **Cooldowns.** The sweep's pass claims a task whose cooldown has ended.
- **Stranded tasks** (Decisions 8 and 9). A pass remembers what it found unassignable and why. The sweep asks the service to note each one whose skip is older than `strandedAfterS`.

`start()` sweeps at once and then on a timer. `stop()` ends passes and recording (Decision 21). The dispatcher now checks for that in two more places: after a run's actor is built, and between archiving a run's session and closing the run.

- [ ] **Step 13.1: Write the failing tests.** Create `tests/kanban-dispatch-sweep.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventsOf, getTask, runsOf } from '../src/db/kanban-read.js';
import { ALICE } from './helpers/kanban.js';
import { completes, dispatchHarness, holds, reportComplete, until, type DispatchHarness } from './helpers/dispatch.js';

const open: DispatchHarness[] = [];

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

afterEach(() => {
  vi.useRealTimers();
  while (open.length > 0) open.pop()?.close();
});

const MINUTE = 60_000;

describe('Dispatcher: the runtime limit (spec §8.5)', () => {
  it('ends a run past its limit timed_out, recorded before its turn is cancelled, so the classifier never sees it', async () => {
    const h = harness();
    const task = h.create({ workspace: 'web', maxRuntimeS: 60 });
    const implementer = h.driver('implementer');
    let release: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    implementer.scripts.push(async (ctl) => {
      started = true;
      await cancelled;
      // What a provider error at the moment of cancelling looks like: the classifier would say terminal_provider.
      ctl.emit({ kind: 'error', message: 'Error: 401 Unauthorized', retryable: false });
      ctl.end('failed');
    });
    completes(h, implementer);

    h.dispatcher.pass();
    await until(() => started, 'the run to start');
    h.clock.advance(59_999);
    h.dispatcher.sweep();
    expect(runsOf(h.t.db, task.taskId)[0]?.outcome).toBeNull();

    h.clock.advance(1);
    h.dispatcher.sweep();
    const [run] = runsOf(h.t.db, task.taskId);
    expect(run).toMatchObject({ outcome: 'timed_out', error: 'the run passed its limit of 60 s', endedAt: null });
    expect(implementer.runtimes[0]?.cancels).toBe(1);

    // A second sweep does not cancel again.
    h.dispatcher.sweep();
    expect(implementer.runtimes[0]?.cancels).toBe(1);

    release?.();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['timed_out', 'completed']);
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');
  });

  it('cancels a run whose agent was still starting at the limit, at the first sweep after it has started', async () => {
    const h = harness({ settings: { defaultMaxRuntimeS: 60 } });
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    let release: (() => void) | undefined;
    const slowStart = new Promise<void>((resolve) => {
      release = resolve;
    });
    implementer.onStart = () => slowStart;
    const held = holds(implementer);

    h.dispatcher.pass();
    await until(() => implementer.starts.length === 1, 'the agent to be starting');
    h.clock.advance(60_000);
    h.dispatcher.sweep();
    // Recorded at once; there is no turn to cancel yet.
    expect(runsOf(h.t.db, task.taskId)[0]?.outcome).toBe('timed_out');

    release?.();
    await until(() => held.started, 'the agent to start');
    expect(implementer.runtimes[0]?.cancels).toBe(0);
    h.dispatcher.sweep();
    expect(implementer.runtimes[0]?.cancels).toBe(1);

    implementer.onStart = undefined;
    held.end('cancelled');
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId)[0]?.endedAt).not.toBeNull();
  });

  it('keeps the outcome of a run that has reported, and only closes it', async () => {
    const h = harness({ settings: { defaultMaxRuntimeS: 120 } });
    const task = h.create({ workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');
    reportComplete(h, h.driver('implementer'));

    h.clock.advance(120 * 1000);
    h.dispatcher.sweep();
    expect(h.driver('implementer').runtimes[0]?.cancels).toBe(1);
    held.end('cancelled');
    await h.dispatcher.idle();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(run?.outcome).toBe('completed');
    expect(run?.endedAt).not.toBeNull();
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'done', consecutiveFailures: 0 });
  });
});

describe('Dispatcher: stranded tasks (spec §4.2)', () => {
  /** A task whose parents finished in different workspaces: nobody may guess which to use. */
  function unclaimable(h: DispatchHarness): string {
    const web = h.create({ title: 'web half', workspace: 'web' });
    const api = h.create({ title: 'api half', workspace: 'api' });
    for (const parent of [web, api]) {
      expect(h.service.complete(parent.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' }).ok).toBe(true);
    }
    return h.create({ title: 'join', parents: [web.taskId, api.taskId] }).taskId;
  }

  function stranded(h: DispatchHarness, taskId: string): unknown[] {
    return eventsOf(h.t.db, taskId)
      .filter((e) => e.kind === 'stranded')
      .map((e) => e.payload);
  }

  it('reports a task nobody can be given once it has waited strandedAfterS, and only once', () => {
    const h = harness();
    const taskId = unclaimable(h);

    h.dispatcher.sweep();
    h.clock.advance(30 * MINUTE - 1);
    h.dispatcher.sweep();
    expect(stranded(h, taskId)).toEqual([]);

    h.clock.advance(1);
    h.dispatcher.sweep();
    expect(stranded(h, taskId)).toEqual([
      { reason: expect.stringContaining('parents are in different workspaces') },
    ]);
    expect(getTask(h.t.db, taskId)?.strandedNotifiedAt).toBe(h.clock.now());

    h.clock.advance(60 * MINUTE);
    h.dispatcher.sweep();
    expect(stranded(h, taskId)).toHaveLength(1);
  });

  it('never reports a task that is only waiting its turn behind a busy workspace', async () => {
    const h = harness();
    h.create({ title: 'running', workspace: 'web' });
    const queued = h.create({ title: 'queued', workspace: 'web' });
    const held = holds(h.driver('implementer'));
    h.dispatcher.pass();
    await until(() => held.started, 'the run to start');

    h.clock.advance(31 * MINUTE);
    h.dispatcher.sweep();
    expect(stranded(h, queued.taskId)).toEqual([]);
    expect(eventsOf(h.t.db, queued.taskId).map((e) => e.kind)).toEqual(['created']);

    held.end('completed', () => reportComplete(h, h.driver('implementer')));
    completes(h, h.driver('implementer'));
    await h.dispatcher.idle();
  });
});

describe('Dispatcher: start and stop', () => {
  it('passes at once, sweeps every sweepIntervalS, and does nothing once stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = harness({ settings: { sweepIntervalS: 60 } });
    const first = h.create({ title: 'first', workspace: 'web' });
    const implementer = h.driver('implementer');
    completes(h, implementer);
    completes(h, implementer);

    h.dispatcher.start();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, first.taskId).map((r) => r.outcome)).toEqual(['completed']);

    // A task that no event announced is found by the next sweep.
    const second = h.create({ title: 'second', workspace: 'web' });
    vi.advanceTimersByTime(60_000);
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, second.taskId).map((r) => r.outcome)).toEqual(['completed']);

    h.dispatcher.stop();
    const third = h.create({ title: 'third', workspace: 'web' });
    vi.advanceTimersByTime(120_000);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, third.taskId)).toEqual([]);
  });
});
```

- [ ] **Step 13.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-dispatch-sweep.test.ts`. Expected: every test FAILS, with `h.dispatcher.sweep is not a function` or `h.dispatcher.start is not a function`, and `Tests  6 failed (6)`.

- [ ] **Step 13.3: Implement.**

In `src/kanban/dispatcher.ts`, replace:

```ts
import type { Db } from '../db/open.js';
import { claimableTasks, getRun, openAgentRunCount } from '../db/kanban-read.js';
import { getSession } from '../db/sessions.js';
```

with:

```ts
import type { Db } from '../db/open.js';
import { claimableTasks, getRun, getTask, openAgentRunCount } from '../db/kanban-read.js';
import { getSession } from '../db/sessions.js';
```

In `src/kanban/dispatcher.ts`, replace:

```ts
  key: BindingKey;
  /** The run's environment, held only here (spec §2.4 item 3). */
  env: Readonly<Record<string, string>>;
}

function message(err: unknown): string {
```

with:

```ts
  key: BindingKey;
  /** The run's environment, held only here (spec §2.4 item 3). */
  env: Readonly<Record<string, string>>;
  /** Its turn has been cancelled for running past its limit: once is enough. */
  cancelling: boolean;
}

function message(err: unknown): string {
```

In `src/kanban/dispatcher.ts`, replace:

```ts
  /** Runs being started or waited on, so a test or a shutdown can wait for them. */
  readonly #inflight = new Set<Promise<void>>();

  constructor(deps: DispatcherDeps) {
```

with:

```ts
  /** Runs being started or waited on, so a test or a shutdown can wait for them. */
  readonly #inflight = new Set<Promise<void>>();
  /** What the last pass found nobody could be given, and why: the sweep's stranded candidates. */
  #unassignable = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(deps: DispatcherDeps) {
```

In `src/kanban/dispatcher.ts`, replace:

```ts
  pass(): void {
    for (const task of claimableTasks(this.#deps.db, this.#clock.now())) {
```

with:

```ts
  pass(): void {
    if (this.#stopped) return;
    const unassignable = new Map<string, string>();
    for (const task of claimableTasks(this.#deps.db, this.#clock.now())) {
```

In `src/kanban/dispatcher.ts`, replace:

```ts
      // given; a busy workspace or a racing claim leaves it for the next pass.
      if (!claimed.ok) continue;
      this.#track(this.#run(claimed));
    }
```

with:

```ts
      // given; a busy workspace or a racing claim leaves it for the next pass.
      if (!claimed.ok) {
        if (claimed.code === 'unassignable') unassignable.set(task.taskId, claimed.message);
        continue;
      }
      this.#track(this.#run(claimed));
    }
    this.#unassignable = unassignable;
  }

  /**
   * The sweep (spec §6.1), for what only time changes: runs past their runtime
   * limit, cooldowns that have ended -- the pass claims those -- and tasks that
   * have sat unclaimable long enough to be reported stranded.
   */
  sweep(): void {
    if (this.#stopped) return;
    this.#limitRuntimes();
    this.pass();
    this.#noteStranded();
  }

  /** Sweep every `sweepIntervalS`, starting now. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        this.#note(`kanban: sweep failed: ${message(err)}`);
      }
    }, this.#deps.settings.sweepIntervalS * 1000);
    this.#timer.unref();
    this.sweep();
  }

  /**
   * Stop: no more passes, and nothing more recorded. Open runs stay open; their
   * agents die with the gateway, and the next boot ends them (spec §8.4).
   */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Cancel the turn of a run past `max_runtime_s` (spec §8.5): wall-clock,
   * whatever it is doing, for the run that is busy and getting nowhere. An
   * undecided run ends `timed_out`, recorded before the turn is cancelled, so it
   * is the run's outcome and not the classifier's (spec §6.4). A decided run past
   * the limit keeps its outcome, and is closed once its turn ends.
   */
  #limitRuntimes(): void {
    const now = this.#clock.now();
    for (const [sessionId, open] of this.#open) {
      if (open.cancelling) continue;
      const run = getRun(this.#deps.db, open.runId);
      if (run === undefined || run.endedAt !== null) continue;
      const limitS = getTask(this.#deps.db, run.taskId)?.maxRuntimeS ?? this.#deps.settings.defaultMaxRuntimeS;
      if (now - run.startedAt < limitS * 1000) continue;
      if (run.outcome === null) {
        this.#deps.service.endRun(run.runId, {
          outcome: 'timed_out',
          error: `the run passed its limit of ${limitS} s`,
          lastOutput: lastTurnOf(this.#deps.db, sessionId).output,
          ...this.#sideEffects(run, sessionId),
        });
      }
      // Only a running agent can be cancelled. One still starting is cancelled by
      // a later sweep, once it has a runtime.
      const actor = this.#deps.sessions.liveActor(sessionId);
      if (actor?.presence !== 'live') continue;
      open.cancelling = true;
      this.#note(`kanban: run ${run.runId} passed its runtime limit; cancelling its turn`);
      void actor.cancel();
    }
  }

  /** Tell, once, about each task the last pass found nobody to give to, if it has waited long enough (spec §4.2). */
  #noteStranded(): void {
    const cutoff = this.#clock.now() - this.#deps.settings.strandedAfterS * 1000;
    for (const [taskId, reason] of this.#unassignable) {
      const noted = this.#deps.service.noteStranded(taskId, reason, cutoff);
      if (noted.ok && noted.written) this.#note(`kanban: task ${taskId} is stranded`);
    }
```

In `src/kanban/dispatcher.ts`, replace:

```ts
      return;
    }
    this.#open.set(sessionId, { runId: run.runId, key, env: { MT_KANBAN_RUN: run.runId } });

    let terminal: TurnTerminal;
```

with:

```ts
      return;
    }
    this.#open.set(sessionId, { runId: run.runId, key, env: { MT_KANBAN_RUN: run.runId }, cancelling: false });

    let terminal: TurnTerminal;
```

In `src/kanban/dispatcher.ts`, replace:

```ts
      const actor = await this.#deps.sessions.actorFor(sessionId, key);
      // Its own key per prompt (spec §7.5): the actor deduplicates turns on it.
```

with:

```ts
      const actor = await this.#deps.sessions.actorFor(sessionId, key);
      // Stopped while the actor was built: start no agent the shutdown will not close.
      if (this.#stopped) return;
      // Its own key per prompt (spec §7.5): the actor deduplicates turns on it.
```

In `src/kanban/dispatcher.ts`, replace:

```ts
    const open = this.#open.get(sessionId);
    if (open === undefined) return;
    const run = getRun(this.#deps.db, open.runId);
```

with:

```ts
    const open = this.#open.get(sessionId);
    // Stopped: the gateway is shutting down, and the next boot ends the run.
    if (open === undefined || this.#stopped) return;
    const run = getRun(this.#deps.db, open.runId);
```

In `src/kanban/dispatcher.ts`, replace:

```ts
   * leaves a decided run open, which the next boot closes (spec §8.4), rather
   * than a closed run whose session is still bound.
   */
  async #close(runId: string, key: BindingKey, sessionId?: string): Promise<void> {
    await this.#deps.sessions.archive(key, 'the run is over');
    const closed = this.#deps.service.closeRun(runId);
```

with:

```ts
   * leaves a decided run open, which the next boot closes (spec §8.4), rather
   * than a closed run whose session is still bound. Stopped in between, the run is
   * left for that boot too: the database may be closing.
   */
  async #close(runId: string, key: BindingKey, sessionId?: string): Promise<void> {
    await this.#deps.sessions.archive(key, 'the run is over');
    if (this.#stopped) return;
    const closed = this.#deps.service.closeRun(runId);
```

- [ ] **Step 13.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  831 passed (831)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 13.5: Commit.**

```bash
git add src/kanban/dispatcher.ts tests/kanban-dispatch-sweep.test.ts
git commit -m "Sweep for runs past their limit, ended cooldowns and stranded tasks"
```

---

### Task 14: Gateway restart

**Files:**
- Modify: `src/kanban/dispatcher.ts`
- Create: `tests/kanban-dispatch-restart.test.ts`

`boot()` is step 3–4 of spec §8.4, run after `reconcileBoot` and before the first pass. Every open agent run's process died with the gateway:
- an undecided run ends `interrupted`. It is not counted, and is claimable again subject to `retry_on_crash`; a run that never got a session made no changes (Decision 22);
- a decided run keeps its outcome;
- either way the run is closed, its session archived and its binding revoked.

A person's run is left alone. The backstop for a rebuild that boot did not cover is `envFor` (Decision 23).

The tests run the old gateway's dispatcher until its run is working, mark the run's session as from a previous boot, and stop that dispatcher. A second harness on the same database is the restarted gateway.

- [ ] **Step 14.1: Write the failing tests.** Create `tests/kanban-dispatch-restart.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { bindingsForSession } from '../src/db/bindings.js';
import { getTask, openRunOf, runsOf } from '../src/db/kanban-read.js';
import { getSession, setExecution } from '../src/db/sessions.js';
import { runKey } from '../src/kanban/dispatcher.js';
import { ALICE, claimed, newTask } from './helpers/kanban.js';
import type { TurnControl } from './helpers/driver.js';
import {
  APP,
  completes,
  dispatchHarness,
  reportComplete,
  role,
  until,
  type DispatchHarness,
} from './helpers/dispatch.js';

const open: DispatchHarness[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

/**
 * The gateway before the restart: a run whose agent made a tool call and is
 * still working when the process dies. Its turn never ends here.
 */
async function before(opts: Parameters<typeof dispatchHarness>[0] = {}, report = false) {
  const h = dispatchHarness(opts);
  open.push(h);
  const task = h.create({ title: 'Build', workspace: 'web' });
  const implementer = h.driver('implementer');
  let running = false;
  implementer.scripts.push(async (ctl: TurnControl) => {
    ctl.emit({ kind: 'tool-call', toolCallId: 'c1', title: 'edit', status: 'completed', raw: {} });
    if (report) reportComplete(h, implementer);
    running = true;
    await new Promise<void>(() => undefined);
  });
  h.dispatcher.pass();
  await until(() => running, 'the run to be working');
  const run = runsOf(h.t.db, task.taskId)[0];
  if (run?.sessionId === null || run === undefined) throw new Error('no run');
  // Its handle names the boot that died, as a real restart would find it.
  setExecution(h.t.db, run.sessionId, 'previous-boot:0', 'implementer');
  // The old process is gone: nothing it holds runs again.
  h.dispatcher.stop();
  return { task, run, sessionId: run.sessionId };
}

/** The gateway after the restart, on the same database. */
function after(h0: DispatchHarness, opts: Parameters<typeof dispatchHarness>[0] = {}): DispatchHarness {
  return dispatchHarness({ ...opts, t: h0.t, clock: h0.clock });
}

describe('Dispatcher: a gateway restart (spec §8.4)', () => {
  it('ends an undecided run interrupted, uncounted, archives its session, and tells the retry', async () => {
    const { task, run, sessionId } = await before();
    const h = after(open[0] as DispatchHarness);

    const findings = h.registry.reconcileBoot();
    expect(findings.find((f) => f.sessionId === sessionId)?.bindings).toEqual([
      runKey(APP, { taskId: task.taskId, runId: run.runId }),
    ]);
    await h.dispatcher.boot();

    expect(runsOf(h.t.db, task.taskId)[0]).toMatchObject({
      outcome: 'interrupted',
      error: 'the gateway restarted during the run',
    });
    expect(openRunOf(h.t.db, task.taskId)).toBeUndefined();
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'open', consecutiveFailures: 0 });
    expect(getSession(h.t.db, sessionId)?.state).toBe('archived');
    expect(bindingsForSession(h.t.db, sessionId)).toEqual([]);

    const implementer = h.driver('implementer');
    completes(h, implementer);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId).map((r) => r.outcome)).toEqual(['interrupted', 'completed']);
    expect(implementer.runtimes[0]?.prompts[0]?.text).toContain(
      '## Attempt 1 (work, implementer): interrupted\nError: the gateway restarted during the run\nTool calls:\n- edit (completed)',
    );
  });

  it('keeps the outcome of a run that had reported, and only closes it', async () => {
    const { task } = await before({}, true);
    const h = after(open[0] as DispatchHarness);
    h.registry.reconcileBoot();
    await h.dispatcher.boot();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(run?.outcome).toBe('completed');
    expect(run?.endedAt).not.toBeNull();
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');
  });

  it('holds an interrupted run that changed something for a person under if-no-side-effects', async () => {
    const opts = { roles: [role('implementer', {}, ['read'])] };
    const h0 = dispatchHarness(opts);
    open.push(h0);
    const task = h0.create({ workspace: 'web', retryOnCrash: 'if-no-side-effects' });
    const implementer = h0.driver('implementer');
    let running = false;
    implementer.scripts.push(async (ctl: TurnControl) => {
      ctl.emit({ kind: 'tool-call', toolCallId: 'c1', title: 'edit', status: 'completed', raw: {} });
      running = true;
      await new Promise<void>(() => undefined);
    });
    h0.dispatcher.pass();
    await until(() => running, 'the run to be working');
    h0.dispatcher.stop();

    const h = after(h0, opts);
    await h.dispatcher.boot();
    expect(getTask(h.t.db, task.taskId)).toMatchObject({ phase: 'blocked', blockKind: 'needs_input' });
  });

  it("leaves a person's run alone: it holds no process", async () => {
    const h0 = dispatchHarness();
    open.push(h0);
    const task = newTask(h0.t.db, { assignee: { kind: 'human', name: ALICE } });
    const run = claimed(h0.t.db, task.taskId);
    await h0.dispatcher.boot();
    expect(openRunOf(h0.t.db, task.taskId)?.runId).toBe(run.runId);
  });

  it("refuses to rebuild an open run's session without its environment, and ends the run interrupted", async () => {
    const { task, run, sessionId } = await before();
    const h = after(open[0] as DispatchHarness);

    await expect(h.registry.actorFor(sessionId, runKey(APP, run))).rejects.toThrow(
      `run ${run.runId} has ended interrupted: its environment did not survive a restart`,
    );
    await h.dispatcher.idle();
    expect(runsOf(h.t.db, task.taskId)[0]).toMatchObject({ outcome: 'interrupted' });
    expect(openRunOf(h.t.db, task.taskId)).toBeUndefined();
    expect(getSession(h.t.db, sessionId)?.state).toBe('archived');
    expect(h.driver('implementer').starts).toEqual([]);
  });
});
```

- [ ] **Step 14.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/kanban-dispatch-restart.test.ts`. Expected: every test FAILS. Four fail with `h.dispatcher.boot is not a function` (or `h0.dispatcher.boot`), and the last with `promise resolved "SessionActor{ sessionId: 's_…' }" instead of rejecting`. The summary is `Tests  5 failed (5)`.

- [ ] **Step 14.3: Implement.**

In `src/kanban/dispatcher.ts`, replace:

```ts
import type { Db } from '../db/open.js';
import { claimableTasks, getRun, getTask, openAgentRunCount } from '../db/kanban-read.js';
import { getSession } from '../db/sessions.js';
```

with:

```ts
import type { Db } from '../db/open.js';
import { claimableTasks, getRun, getTask, openAgentRunCount, openRuns, runBySession } from '../db/kanban-read.js';
import { getSession } from '../db/sessions.js';
```

In `src/kanban/dispatcher.ts`, replace:

```ts
   * run's token, its socket and the `mt` binary's directory.
   */
  envFor(sessionId: string): Readonly<Record<string, string>> | undefined {
    return this.#open.get(sessionId)?.env;
  }
```

with:

```ts
   * run's token, its socket and the `mt` binary's directory.
   *
   * An open run's session this process did not start has lost its environment
   * with the process that did. It is not rebuilt: the run ends `interrupted`, and
   * the build is refused, rather than prompting an agent that could not report.
   */
  envFor(sessionId: string): Readonly<Record<string, string>> | undefined {
    const open = this.#open.get(sessionId);
    if (open !== undefined) return open.env;
    const run = runBySession(this.#deps.db, sessionId);
    if (run === undefined || run.endedAt !== null) return undefined;
    this.#interrupt(run);
    this.#track(this.#deps.sessions.archive(runKey(this.#deps.appId, run), 'its environment did not survive a restart'));
    throw new Error(
      `run ${run.runId} has ended interrupted: its environment did not survive a restart, so its agent could not report`,
    );
  }

  /**
   * After a restart (spec §8.4 steps 3 and 4), before the first pass: every open
   * agent run's process died with the gateway. An undecided run ends
   * `interrupted` -- not counted, since the task did nothing wrong, and claimable
   * again subject to retry_on_crash. A decided one keeps its outcome. Either way
   * it is closed, its session archived and its binding revoked: never resumed, as
   * a new run gets a new session. A person's run holds no process, and is left.
   */
  async boot(): Promise<void> {
    for (const run of openRuns(this.#deps.db)) {
      if (run.agentConfig === null) continue;
      this.#interrupt(run);
      await this.#deps.sessions.archive(runKey(this.#deps.appId, run), 'the gateway restarted; the run is over');
    }
  }

  /** End an open run whose process is gone, keeping a reported outcome, and close it. */
  #interrupt(run: RunRow): void {
    if (run.outcome === null) {
      this.#deps.service.endRun(run.runId, {
        outcome: 'interrupted',
        error: 'the gateway restarted during the run',
        // A run whose session never started cannot have changed anything.
        ...(run.sessionId === null
          ? { hadSideEffects: false }
          : { lastOutput: lastTurnOf(this.#deps.db, run.sessionId).output, ...this.#sideEffects(run, run.sessionId) }),
      });
    }
    this.#deps.service.closeRun(run.runId);
    this.#note(`kanban: run ${run.runId} closed after a restart`);
  }
```

- [ ] **Step 14.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  836 passed (836)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 14.5: Commit.**

```bash
git add src/kanban/dispatcher.ts tests/kanban-dispatch-restart.test.ts
git commit -m "Close every open run after a restart, and refuse one rebuilt without its environment"
```

---

### Task 15: Starting the dispatcher with the gateway

**Files:**
- Modify: `src/index.ts`, `tests/gateway-startup.test.ts`

The wiring of Decision 1:
- the registry always has the `kanban` sink and the dispatcher's two hooks, which read a dispatcher that may not exist;
- boot findings are posted only to bindings on the Lark channel (spec §8.4 step 2), through `findingsOn`;
- with `kanban.enabled`, the gateway builds a `KanbanService` with the configured limits and a `Dispatcher`. `start()` runs `dispatcher.boot()` straight after `reconcileBoot`, before the channel connects, and `dispatcher.start()` once the findings are posted. `stop()` stops the dispatcher first.

With the flag off, as in the live config, chat behaves exactly as before.

- [ ] **Step 15.1: Write the failing tests.**

In `tests/gateway-startup.test.ts`, replace:

```ts
import { migrate, openDb } from '../src/db/open.js';
import { createGateway, registerConfiguredSecrets } from '../src/index.js';
import { loadTeam, type Team } from '../src/team.js';
```

with:

```ts
import { migrate, openDb } from '../src/db/open.js';
import { createGateway, findingsOn, registerConfiguredSecrets } from '../src/index.js';
import { loadTeam, type Team } from '../src/team.js';
```

Add to the end of `tests/gateway-startup.test.ts`:

```ts

describe('the board, at startup', () => {
  it('builds no dispatcher unless kanban.enabled is set: chat runs as it did', async () => {
    const gateway = await createGateway(config, team);
    try {
      expect(gateway.dispatcher).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });

  it('builds the dispatcher when kanban.enabled is set', async () => {
    const gateway = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    try {
      expect(gateway.dispatcher).toBeDefined();
    } finally {
      await gateway.stop();
    }
  });

  it("posts boot findings to the chat channel's bindings only: a kanban binding's conversation is a task", () => {
    const lark = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: '' };
    const kanban = { channel: 'kanban', appId: 'cli_app', conversationId: 'k_task', threadId: 'r_run' };
    const findings = [
      { sessionId: 's_chat', message: 'chat', held: false, bindings: [lark] },
      { sessionId: 's_run', message: 'run', held: true, bindings: [kanban] },
      { sessionId: 's_both', message: 'both', held: false, bindings: [kanban, lark] },
    ];
    expect(findingsOn('lark', findings)).toEqual([
      { sessionId: 's_chat', message: 'chat', held: false, bindings: [lark] },
      { sessionId: 's_both', message: 'both', held: false, bindings: [lark] },
    ]);
  });
});
```

- [ ] **Step 15.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/gateway-startup.test.ts`. Expected: two tests FAIL, with `expected undefined to be defined` and `(0 , findingsOn) is not a function`, and `Tests  2 failed | 6 passed (8)`.

- [ ] **Step 15.3: Implement.**

In `src/index.ts`, replace:

```ts
import { Router } from './core/router.js';
import { DEFAULT_ROLE, DEFAULT_WORKSPACE, SessionRegistry } from './core/registry.js';
import { NamedWorkspaces } from './core/workspace.js';
```

with:

```ts
import { Router } from './core/router.js';
import { DEFAULT_ROLE, DEFAULT_WORKSPACE, SessionRegistry, type BootFinding } from './core/registry.js';
import { NamedWorkspaces } from './core/workspace.js';
```

In `src/index.ts`, replace:

```ts
import { systemClock } from './time.js';
import { addSecrets, redactKnownSecrets } from './secrets.js';

/**
```

with:

```ts
import { systemClock } from './time.js';
import { addSecrets, redactKnownSecrets } from './secrets.js';
import { Dispatcher } from './kanban/dispatcher.js';
import { KanbanService } from './kanban/service.js';
import { KanbanSink } from './kanban/sink.js';
import type { Channel } from './channel/types.js';

/**
```

In `src/index.ts`, replace:

```ts
export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly db: Db;
}

/**
 * Register every secret the configuration and the team hold: the Lark app secret
```

with:

```ts
export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly db: Db;
  /** The board's dispatcher, when `kanban.enabled` is set. */
  readonly dispatcher: Dispatcher | undefined;
}

/**
 * The boot findings to post on one channel, each with only its bindings there
 * (spec §8.4 step 2). A finding for a kanban run's session is bound on the
 * `kanban` channel, whose conversation id is a task id, not a chat: the
 * dispatcher handles those sessions instead.
 */
export function findingsOn(channelId: string, findings: readonly BootFinding[]): BootFinding[] {
  return findings
    .map((f) => ({ ...f, bindings: f.bindings.filter((key) => key.channel === channelId) }))
    .filter((f) => f.bindings.length > 0);
}

/**
 * Register every secret the configuration and the team hold: the Lark app secret
```

In `src/index.ts`, replace:

```ts
    allowMentionAll: config.auth.allowMentionAll,
  });

  const registry = new SessionRegistry({
    db,
    drivers,
    // Lark only, until plan C adds the kanban sink.
    channels: new Map([[adapter.id, adapter]]),
    workspaces: new NamedWorkspaces(team.workspaces),
    appId: config.lark.appId,
    maxLive: config.maxLiveSessions,
```

with:

```ts
    allowMentionAll: config.auth.allowMentionAll,
  });

  // The registry asks the dispatcher, which needs the registry, so it is read late.
  let dispatcher: Dispatcher | undefined;
  const registry = new SessionRegistry({
    db,
    drivers,
    // A chat's session posts to Lark; a kanban run's into the sink (spec §2.4 item 4).
    channels: new Map<string, Channel>([
      [adapter.id, adapter],
      ['kanban', new KanbanSink()],
    ]),
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(team.workspaces),
    appId: config.lark.appId,
    maxLive: config.maxLiveSessions,
```

In `src/index.ts`, replace:

```ts
    maxLive: config.maxLiveSessions,
    note,
  });

  const router = new Router({
    db,
```

with:

```ts
    maxLive: config.maxLiveSessions,
    note,
  });

  // Off until the board can be used: nothing can create a task before plan D,
  // and no agent can report before plan C3 (spec §12).
  if (config.kanban.enabled) {
    const { failureLimit, transientLimit, transientCooldownS } = config.kanban;
    const service = new KanbanService({
      db,
      roles: team.roles,
      workspaces: new Set(team.workspaces.keys()),
      limits: { failureLimit, transientLimit, transientCooldownS },
    });
    dispatcher = new Dispatcher({
      db,
      service,
      sessions: registry,
      roles: team.roles,
      appId: config.lark.appId,
      settings: config.kanban,
      note,
    });
    note(`kanban: dispatching up to ${config.kanban.maxRunning} agent run(s) at once`);
  }

  const router = new Router({
    db,
```

In `src/index.ts`, replace:

```ts
  let stopped = false;

  return {
    db,

    async start(): Promise<void> {
      // Before connecting. Reconciling against a channel that is already delivering
      // means deciding what happened to the last turn while the next one runs.
```

with:

```ts
  let stopped = false;

  return {
    db,
    dispatcher,

    async start(): Promise<void> {
      // Before connecting. Reconciling against a channel that is already delivering
      // means deciding what happened to the last turn while the next one runs.
```

In `src/index.ts`, replace:

```ts
      const findings = registry.reconcileBoot();
      note(`reconciled ${findings.length} session(s) needing attention`);

      await adapter.connect();
```

with:

```ts
      const findings = registry.reconcileBoot();
      note(`reconciled ${findings.length} session(s) needing attention`);
      // Then every run the restart killed is closed, before anything can claim (spec §8.4).
      await dispatcher?.boot();

      await adapter.connect();
```

In `src/index.ts`, replace:

```ts
      // already held, and refusing to start would remove the only way to look at it.
      for (const finding of findings) {
        for (const key of finding.bindings) {
```

with:

```ts
      // already held, and refusing to start would remove the only way to look at it.
      for (const finding of findingsOn(adapter.id, findings)) {
        for (const key of finding.bindings) {
```

In `src/index.ts`, replace:

```ts
        60_000,
      );
      housekeeping.unref();
    },

    async stop(): Promise<void> {
```

with:

```ts
        60_000,
      );
      housekeeping.unref();
      dispatcher?.start();
    },

    async stop(): Promise<void> {
```

In `src/index.ts`, replace:

```ts
      if (housekeeping !== undefined) clearInterval(housekeeping);
      // Stop taking work before draining it, or the drain never finishes.
```

with:

```ts
      if (housekeeping !== undefined) clearInterval(housekeeping);
      // No more claims; the runs still open are ended by the next boot.
      dispatcher?.stop();
      // Stop taking work before draining it, or the drain never finishes.
```

- [ ] **Step 15.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  839 passed (839)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 15.5: Commit.**

```bash
git add src/index.ts tests/gateway-startup.test.ts
git commit -m "Start the dispatcher with the gateway when kanban.enabled is set"
```

- [ ] **Step 15.6: Run everything.** Run:
  - `npm test 2>&1 | tail -4`: expect `Tests  839 passed (839)`;
  - `npm run test:e2e 2>&1 | tail -4`: expect `Tests  49 passed (49)`;
  - `npm run typecheck`: expect no output;
  - `git grep -n -E "UPDATE kanban_|INSERT INTO kanban_" -- src`: expect matches in `src/db/kanban.ts` only;
  - `git grep -n -i "p[g]w" -- . ':!package-lock.json'`: expect no output.

- [ ] **Step 15.7: Report, without merging.** Merging into the main checkout restarts the live gateway. That is the controller's step, after asking the user. With no `kanban:` section in the live config the dispatcher is not built, and chat runs as before.

---

## Done when

- `npm test` gives `Tests  839 passed (839)`. `npm run test:e2e` gives `Tests  49 passed (49)`. `npm run typecheck` prints nothing. All of these run under Node 22, in the worktree.
- Only `src/db/kanban.ts` writes a `kanban_` table, and only `src/kanban/service.ts` imports it (Step 15.6, and the guard in `tests/kanban-service.test.ts`).
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- A task assigned to a role is claimed, run as a fresh session on the sink channel, and closed when its turn ends. It has one agent run per workspace and no more than `maxRunning` agent runs open. A run that ends unreported is classified, counted and retried in a new session told what the last one did. A restart closes every open run. A run past its limit ends `timed_out`. Each of these has a test against the real board, registry and actors.
- With `kanban.enabled` unset, the gateway builds no dispatcher.
