# Plan E — Native resume: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session on the structured-CLI driver continues its agent's own conversation instead of re-sending it as a transcript. Each turn's process is given `--session-id-file`; the driver reads the provider session id the agent wrote there — or, for a resumed run, whose file only echoes what it was sent, the id its own events carry — reports it to the core, which stores it as the observed `provider_session_id` and logs it, and passes it back as `--session` on the next turn, which then sends only the new message. The id survives a restart in the session's row, so a cold session resumes natively too, and a rework seeded from the implementer's run continues the implementer's conversation. When the agent refuses an id as bytesec was measured to — exit 1, nothing on stdout, `persistence: session not found` or `unknown agent: <name>` as stderr's last line — the same turn is run again with the transcript, automatically, and the log says it was replayed and why: `resume: native → replay`, the one degrade the driver layer sanctions. An agent that answers `--session` with another session, as bytesec 0.7.2 did, is reported and replayed from then on. `/status` shows the provider session the last turn ran in and how it reached it. Nudges get cheaper and reworks resume; the board changes only to stop seeding a rework from an old `cli:` runtime id. `mt role check` warns of a bytesec below 0.7.4, the oldest that resumes.

**Architecture:**
- **The driver contract** (`src/driver/types.ts`, `src/types.ts`): a `session-observed` driver event — the provider session id a turn ran in, how the turn reached it (`fresh | resumed | replayed`), and why, when it did not continue the conversation it was asked to; `StartResult.providerSessionId` may be empty, meaning none yet; a `provider_session_observed` event type.
- **The actor** (`src/core/session-actor.ts`): stores each observed id with `observeProviderSessionId` and logs `provider_session_observed`; no longer stores an empty id from a start, so a seed survives until the first turn reports one.
- **The resumable id** (`src/provider-id.ts`): `isResumableProviderId`, one argv word that cannot be a flag, never a `cli:` id; shared by the driver, `/status` and the rework seed.
- **The CLI driver** (`src/driver/cli/driver.ts`): per turn, `--session-id-file` in an `mt-session-id-` directory under the system's temporary directory, read once the process exits and removed; `--session <id>` and the message alone when a session is known, from the start or from the previous turn; a resumed run's session read from its first typed event; the measured refusal recognized — exit 1, no JSON on stdout, stderr's last line — and the turn run again with the transcript unless it was stopped meanwhile; an agent that does not continue the session it is given replayed from then on; `RESUME_MIN_VERSION`.
- **Visibility** (`src/db/events.ts`, `src/core/router.ts`): `lastEventOfType`; `/status` ends with the provider session the last turn ran in, and how it reached it.
- **The board** (`src/db/kanban.ts`): `reworkSeed` seeds only from a resumable id. Otherwise no change: a nudge is a later turn in the run's session, and resumes; a rework's session is seeded with the work run's observed id (spec §2.4 item 5, §5.3) and resumes it; a retry is a new session with no seed (§8.3). End-to-end tests prove all three.
- **The version check** (`src/cli/role.ts`, `src/cli/mt.ts`): `mt role check` asks each bytesec role's command for `--version` and warns of one below 0.7.4.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, better-sqlite3.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §2.4 item 5, §5.3, §7.5, §8.3 and the E row of §12; `docs/architecture.md` §3.2, §6.1, §6.3 and §6.5, whose §6.3 records this plan's spike, in the same commit as this plan.

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on branch `native-resume`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, and never write to `~/.manus-team`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` gives `Tests  1330 passed (1330)`. `npm run test:e2e` gives `Tests  75 passed (75)`. `npm run typecheck` reports no errors.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given.
- **No real agent.** No test runs bytesec. The CLI driver's tests run the fake CLI agent, `tests/fakes/cli-agent.mjs`, which Task 2 teaches to keep sessions the way the spike below measured bytesec 0.7.4 keeping them. Each test's store is a fresh `mkdtemp` directory. `mt role check`'s tests give it a version (`MtIo.agentVersion`), so it never asks the real bytesec. Unit tests start no process.
- **Secrets.** Never print secret values. Tests use made-up values only. A provider session id is not a secret (Decision 12).
- **Words a person sees** never say "plan E".

## Measure first: what the spike found

Run on 2026-11-05 against the real `bytesec` 0.7.4, with `--model bytesec/ark-cn/seed-2-0-mini`, one-line prompts, `--format json -y`, in scratch directories under `/tmp`, no repository. Thirteen runs. Re-measure on the next bytesec version.

| Question | Measured |
|---|---|
| What `--session-id-file` writes, and when | The session id and a newline (`ses_e531361c8ffe2lveTdkChrc9D1\n`), mode `0600`, **at the process's start**: the file existed within a second, before the model answered. Written for a turn that completes, for one that fails (`--model` no provider serves: `finish: "error"`, exit 1) and for one killed by `SIGTERM` during a tool call. For a run given `--session <id>`, it holds that id — **even when the id is then refused**. |
| Does `--session <id>` resume | Yes. A run given the id of an earlier run's session answered with a word given only to the earlier run; the id file held the same id. A session whose run was killed resumes too, and remembers the killed run's prompt. |
| An unknown or expired id | Exit 1, **nothing on stdout**, and `turn 1: persistence: session not found` as stderr's last line; no turn summary. Same for a session removed with `bytesec session delete`. No time-based expiry was observed; deletion is the closest measured case. |
| `--agent` and `BYTESEC_LOCAL_APM_PATH` on a resumed run | A session made as a native agent (plan R's package, `--agent parrot`) resumes with the same flag and variable, remembers, and keeps its system prompt. **A session keeps its agent:** the same session resumed without them exits 1 with `turn 1: unknown agent: parrot`, and a default-agent session resumed with `--agent parrot` exits 1 with `turn 1: unknown agent: bytesec-agent`; both print nothing on stdout. |
| A different `--dir` | Does not matter to the session: a session resumed with another `--dir` continued the conversation and ran its tools (`pwd`) in the new directory. The store is the user's, not the project's. |
| The id in `--format json` | Every typed event (`text_delta`, `reasoning_delta`, `tool_running`, `token_stats`, …) carries `session_id`; the turn summary does not, and its `turn` is 1 on every run. A turn that fails before the model streams — the bad model — prints only the summary, so has no `session_id` on stdout at all: the id file is the one source every outcome has. |

What follows from it:
- The id file is read once the process has exited, and believed only for a run not given `--session`. For a resumed run it only echoes the id the driver sent, so the session such a run ran in is read from its events' `session_id` ("never persist the value you sent", architecture §6.3).
- Native resume needs bytesec 0.7.4: 0.7.2 answered `--session` with a new session (architecture §6.3's correction).
- A refusal happens before the turn starts and prints nothing on stdout, so running the turn again with the transcript runs nothing twice.
- Refusal is recognized by the two stderr lines above. A session made as another agent is refused the same way as an unknown one, which is what spec §5.3's like-for-like rule for a rework's seed already avoids.

## Decisions the spec left open

Each has a recommendation and its reason. *The user's decision* marks those the user made on the first draft of this plan.

1. **The id comes from `--session-id-file` — for a run not given `--session`.** In a directory made per turn with `mkdtemp` under the system's temporary directory (prefix `mt-session-id-`), removed once read: never in the workspace, where it would show in the agent's checkout and make a report's `reported_dirty` true (spec §7.8). A gateway that dies mid-turn leaves the directory behind; it holds only the id, which is no secret. A directory that cannot be made ends the turn `failed`, with the reason, before anything starts. *Why:* the file is the only source written for every outcome of a new session, a failed and a killed turn included (the spike); the `session_id` on stdout's events is absent from a turn that fails before streaming. An id that is not one argv word starting with a letter or digit is ignored, so nothing can be read as a flag: `isResumableProviderId` (`src/provider-id.ts`), one predicate shared by the driver, `/status` and the board's rework seeding (Decision 10).
2. **The id reaches the core as a driver event, on every turn.** `{ kind: 'session-observed', providerSessionId, mode, detail? }`, before `turn-ended`; the actor stores it and logs `provider_session_observed`, which is the `provider.session_observed` architecture §6.3 asks for "on every sighting". `StartResult.providerSessionId` may be `''`, meaning none yet, which the actor does not store. *Why:* a CLI runtime learns its provider's id only from a turn, and the interface observed ids only at `start`. The `cli:<nonce>` id the driver used to report is gone: stored as observed, it read as resumable and was not, and spec §5.3's rework seeding took it for a provider session.
3. **Storage: `sessions.provider_session_id`, as it is.** No migration. It survives a restart in the row; a new runtime — after a restart, an idle eviction, `/attach`, or a rework's seed — is started with it, so the first turn resumes. A `cli:` id an older build stored fails `isResumableProviderId` and is never passed back, never seeds a rework, and never shows in `/status`; that session replays, and its first turn stores a real id.
4. **The fallback is automatic, in the same turn, and only for the measured refusals.** *The user's decision.* A resumed run is taken for refused only when it exits with code 1, printed no line starting with `{` on stdout — recognized by the parser or not — was not cancelled or closed, and the last non-empty line of its stderr is exactly `turn N: persistence: session not found` or `turn N: unknown agent: <name>` (`/^turn \d+: (persistence: session not found|unknown agent: \S+)$/`). Then the same turn is run again without `--session`, with the transcript, and reported `replayed` with the reason (`fresh`, saying it started a new conversation, when there was no history to carry). A cancel or close that arrives while the refused run exits ends the turn `cancelled` instead. Every other failure of a resumed run — a crash, a failed turn, a cancel, any non-zero exit with empty stdout and other stderr — is that turn's own outcome and is never run again. *Why:* G6, "no turn is ever silently executed twice": the spike shows a refusal starts nothing, and nothing else is known to.
5. **Which session a resumed run ran in is observed from its stream, not assumed.** Given `--session X`, bytesec writes X to the id file whether or not it continues X (the spike), so for a resumed run the file is not evidence: the driver takes the `session_id` of the run's first typed event on stdout. The same id is reported `resumed`. Another id — an agent that did not continue the conversation, as bytesec 0.7.2 did — is reported `fresh`, saying which session it was asked to continue and which it ran in, stored as observed, and the runtime stops passing `--session`, carrying the conversation as a transcript from then on; that turn ran, so it is not run again. A resumed run that printed no typed event reports nothing, and the next turn continues the same session. So architecture §6.3's "never persist the value you sent" holds. A new runtime tries again once.
6. **A failed, cancelled or ambiguous turn keeps its provider session, and the next turn resumes it.** *The user's decision.* *Why:* the provider's session holds what the turn did — its tool calls, its partial work — which a transcript of what was said does not; the spike shows a killed run's session resumes. An ambiguous turn still quarantines the session (architecture §8.3); resuming it is still a person's decision. Board retries stay fresh (Decision 9, spec §8.3).
7. **What a resumed turn sends: the new message alone**, with its attachments as paths, as before. The prompt cap (96 KiB) applies to it. The actor still passes the log's prompts as `replay`, which the driver keeps for the fallback.
8. **Lifecycle.**
   - `/new` binds a new gateway session with no provider id: its first turn starts a new provider session. The archived one keeps its id, and `/attach` back resumes it.
   - Archiving a board run's session keeps its id: the rework's seed reads it (spec §5.3).
   - Provider sessions are kept: the gateway never runs `bytesec session delete`. *The user's decision.* A rework needs the work run's session after it is archived, and the store is the agent's own.
9. **The board needs no change to resume.** A nudge (spec §7.5) is a later turn of the run's session, so it resumes and sends only the reminder. A rework's session is created with the work run's observed id as its seed (§2.4 item 5), so its first turn resumes the implementer's conversation, sending the full rework prompt, which still carries the reviewer's reason and the handoff in full (§5.3). What guards a rework when the role's package changes is `recordRendering`'s package-hash check (§5.3, plan R), which drops the seed before the session is made, not the stderr rule: bytesec keeps a session's agent *name*, and a session resumed under a new package of the same name with the same `--agent` was not measured. A retry is a new run in a new session with no seed, so it starts a new provider session (§8.3). Each run is its own gateway session (§7.1). Two runs of one task share a provider session only rework after work, when the work run is closed.
10. **`seeded_from_run` names the run the rework was started from.** *The user's decision:* accepted as a known limitation. When the agent refuses the seed, the rework's session log says `replayed` or `fresh` with the reason, and the column is left as the claim set it, though spec §5.3 says it "names the run whose provider session was actually resumed". The `cli:` case is fixed: `reworkSeed` (`src/db/kanban.ts`) seeds only from an id `isResumableProviderId` accepts, so a work run whose session holds an old `cli:` id gives the rework no seed and a null `seeded_from_run`; until now every CLI rework recorded one.
11. **Visibility: `/status` only.** It ends with `provider session \`ses_…\`: the last turn resumed it` — or "replayed the conversation into it", or "started it" — read from the latest `provider_session_observed`, and says nothing when no turn has reported one (the ACP driver, or a session that has not run since this build). The card says nothing: a turn's card is the answer, not its plumbing. A refusal's reason is in the session log and the gateway's notes.
12. **Masking: the id is not a secret.** It names a session in the agent's own store on the gateway's host, readable only by the user the gateway and its agents run as. It is not added to the masker, is stored as it is in `sessions`, and is shown in `/status`. The event's payload is masked on write like every payload, so an id that happened to equal a configured secret would be masked in the log, and `/status` would show no line.
13. **No configuration switch, and a version check.** *The user's decision:* there is no `agent.resume` switch; native resume is always attempted on the structured-CLI driver, and Decisions 4 and 5 make a version that stops resuming degrade visibly. Native resume needs bytesec 0.7.4 or later (`RESUME_MIN_VERSION`): the README and architecture §6.3 say so, and `mt role check` asks each bytesec role's command for `--version`, once a command, and warns of one below 0.7.4 — a warning, not a failure, as such a role still works by replaying — or notes one whose version it cannot read. The probe is injectable (`MtIo.agentVersion`), so no test runs bytesec.
14. **Concurrency.** One actor per session runs one turn at a time through its mailbox; the CLI runtime refuses a second prompt while one is in flight; each turn is one process. So no two processes of one gateway session ever share a provider session. Two gateway sessions hold the same provider id only rework after work (Decision 9), when the work run's session is archived and its binding revoked. The one way two processes could still share one is an operator's `/attach` of the archived work run's session, by id, while its rework runs (Known limitations).

## Out of scope, and known limitations

- **`/attach` of a board run's archived session while its rework runs** would run two processes on one provider session; what bytesec does then was not measured. Only an operator, typing the session's id, can do it.
- **The refusal is recognized by its wording** (Decision 4). A bytesec that rewords it makes a refused resume an `ambiguous` turn, which quarantines the session, as a run that dies without a summary does today.
- **`/attach` from chat to an archived board run's session** is refused by bytesec with `unknown agent: <role>` when that run was native — the chat starts it without the run's `--agent` and package — so the turn replays, and its new provider id overwrites the stored one. A later rework's seed is then lost: it seeds from the chat's new session, or, if refused again, starts fresh.
- **A role package changed under the same name** is guarded by `recordRendering`'s package-hash check, not by bytesec (Decision 9); resuming under a new package with the same `--agent` name was not measured.
- **A gateway that dies mid-turn leaves its `mt-session-id-…` directory** under the system's temporary directory; it holds only the id.
- **`seeded_from_run` stays set when the agent refuses a rework's seed** (Decision 10), accepted by the user.
- **Status texts still say history "is replayed from the log"** for a suspended session (`src/core/status.ts`, and a restart's finding in `src/core/registry.ts`); for a session with a provider id it is resumed instead. The new `/status` line says which.
- **Provider sessions accumulate in the agent's store**; nothing deletes them, by the user's decision (Decision 8).
- **One model, one version.** The spike ran once per question against one small model on 0.7.4; the fake agent reproduces what it saw, not bytesec. The smoke test below is the first check against the real agent.
- **The ACP driver is unchanged**: it reports its id at `start`, and emits no `session-observed`, so `/status` shows no provider line for it.

## File structure

| File | Responsibility |
|---|---|
| `src/driver/types.ts` (modify) | `session-observed` in `DriverEvent`; an empty `StartResult.providerSessionId` |
| `src/types.ts` (modify) | the `provider_session_observed` event type |
| `src/core/session-actor.ts` (modify) | storing and logging each observation; no empty id from a start |
| `src/provider-id.ts` (create) | `isResumableProviderId`, shared by the driver, `/status` and the rework seed |
| `src/driver/cli/driver.ts` (modify) | `--session-id-file` in an `mt-session-id-` directory, `--session`, the message alone, `readSessionId`, `typedSessionId`, `lastLine`, `RESUME_REFUSED`, the refused turn run again, the stream's evidence of the session a resumed run ran in, `RESUME_MIN_VERSION` |
| `src/db/events.ts` (modify) | `lastEventOfType` |
| `src/core/router.ts` (modify) | `/status`'s provider line, `continuityLine` |
| `src/db/kanban.ts` (modify) | `reworkSeed` seeds only from a resumable id |
| `src/cli/mt.ts`, `src/cli/role.ts` (modify) | `MtIo.agentVersion`; `mt role check`'s version warning, `readAgentVersion`, `versionBelow` |
| `README.md`, `docs/architecture.md`, `docs/specs/2026-11-02-kanban-design.md` (modify) | as built |
| `tests/fakes/cli-agent.mjs` (modify) | sessions kept as bytesec 0.7.4 keeps them, under `FAKE_CLI_SESSIONS`; `FAKE_CLI_RESUME`, `FAKE_CLI_REFUSAL`; `session` in the log |
| `tests/helpers/mt.ts` (modify) | `agentVersion`, never the real agent |
| `tests/session-actor.test.ts`, `tests/cli-driver.e2e.ts`, `tests/router.test.ts`, `tests/kanban-reports.test.ts`, `tests/kanban-worker.e2e.ts`, `tests/kanban-people.e2e.ts`, `tests/mt-role.test.ts` (modify) | |

Running counts, unit then end to end: Task 1 1333 / 75, Task 2 1333 / 83, Task 3 1333 / 92, Task 4 1336 / 92, Task 5 1337 / 93, Task 6 1340 / 94, Task 7 1340 / 94.

---

### Task 1: A driver reports the provider session a turn ran in

**Files:**
- Modify: `src/driver/types.ts`, `src/types.ts`, `src/core/session-actor.ts`, `tests/session-actor.test.ts`

The interface observes a provider session id only at `start` (`StartResult`), and the CLI driver learns its provider's id only once a turn's process has written it. So a driver gets a way to report it from a turn: a `session-observed` event, emitted before `turn-ended`, carrying the id and how the turn reached the conversation (Decision 2). The actor stores it as observed and logs it as `provider_session_observed`. A start may now report no id yet, as `''`, which the actor does not store: storing it would lose the seed a rework's session was created with (spec §2.4 item 5). No driver emits the event yet; the tests script it through `FakeDriver`.

- [ ] **Step 1.1: Write the failing tests.**

In `tests/session-actor.test.ts`, replace:

```ts
} from '../src/core/session-actor.js';
import { approvalNonce } from '../src/core/ids.js';
import { createSession, getSession, setState } from '../src/db/sessions.js';
import { bindSession, resolveBinding } from '../src/db/bindings.js';
import { createTurn, openTurns } from '../src/db/turns.js';
```

with:

```ts
} from '../src/core/session-actor.js';
import { approvalNonce } from '../src/core/ids.js';
import { createSession, getSession, observeProviderSessionId, setState } from '../src/db/sessions.js';
import { bindSession, resolveBinding } from '../src/db/bindings.js';
import { createTurn, openTurns } from '../src/db/turns.js';
```

In `tests/session-actor.test.ts`, replace:

```ts
    await h.submit();
    expect(getSession(h.db.db, 's_1')?.providerSessionId).toBe('prov_rotated');
  });
```

with:

```ts
    await h.submit();
    expect(getSession(h.db.db, 's_1')?.providerSessionId).toBe('prov_rotated');
  });

  it('stores the provider session id a turn reports, and logs how the turn reached it', async () => {
    // The CLI driver learns its provider's id only from a turn (architecture §6.3).
    const h = harness();
    h.driver.scripts = [
      (ctl) => {
        ctl.emit({ kind: 'session-observed', providerSessionId: 'ses_turn', mode: 'resumed' });
        ctl.end('completed');
      },
    ];
    await h.submit();
    expect(getSession(h.db.db, 's_1')?.providerSessionId).toBe('ses_turn');
    const seen = h.events().find((e) => e.type === 'provider_session_observed');
    expect(seen).toMatchObject({ actor: 'agent', payload: { providerSessionId: 'ses_turn', mode: 'resumed' } });
    expect(seen?.turnId).not.toBeNull();
    expect(h.eventTypes().slice(-2)).toEqual(['provider_session_observed', 'turn_ended']);
  });

  it('keeps the id a session was seeded with when the start reports none yet', async () => {
    // A rework's seed (spec §2.4 item 5) must reach the driver's next start, not be
    // overwritten by a start that has nothing to report.
    const h = harness();
    observeProviderSessionId(h.db.db, 's_1', 'ses_seed');
    h.driver.providerSessionId = '';
    await h.submit();
    expect(h.driver.starts[0]?.providerSessionId).toBe('ses_seed');
    expect(getSession(h.db.db, 's_1')?.providerSessionId).toBe('ses_seed');
  });

  it('notes why a turn did not continue the conversation it was asked to', async () => {
    const h = harness();
    const detail = 'provider session ses_gone could not be resumed (persistence: session not found), so the conversation was replayed';
    h.driver.scripts = [
      (ctl) => {
        ctl.emit({ kind: 'session-observed', providerSessionId: 'ses_new', mode: 'replayed', detail });
        ctl.end('completed');
      },
    ];
    await h.submit();
    expect(h.events().find((e) => e.type === 'provider_session_observed')?.payload).toEqual({
      providerSessionId: 'ses_new',
      mode: 'replayed',
      detail,
    });
    expect(h.notes).toContain(`provider session: ${detail}`);
  });
```


- [ ] **Step 1.2: Run them to verify they fail.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` and then `npx vitest run --project unit tests/session-actor.test.ts`. Expected: the three new tests FAIL — `expected 'prov_fake_1' to be 'ses_turn'`, `expected '' to be 'ses_seed'` and `expected undefined to deeply equal { providerSessionId: 'ses_new', …(2) }`. `Tests  3 failed | 59 passed (62)`. (The typecheck also rejects `'session-observed'` as a `DriverEvent` kind until Step 1.3; vitest does not typecheck.)

- [ ] **Step 1.3: Implement.**

In `src/driver/types.ts`, replace:

```ts
      resolve: (outcome: PermissionOutcome) => void;
    }
  | { kind: 'turn-ended'; terminal: TurnTerminal; detail?: string }
  | { kind: 'error'; message: string; retryable: boolean; raw?: unknown };
```

with:

```ts
      resolve: (outcome: PermissionOutcome) => void;
    }
  /**
   * The provider's own session id, as the agent reported it for this turn, and
   * how the turn reached the conversation: continued natively (`resumed`),
   * carried as a transcript (`replayed`), or neither (`fresh`). Emitted before
   * `turn-ended`, on every sighting: the core stores the id as observed. `detail`
   * says why a turn did not continue the conversation it was asked to.
   */
  | { kind: 'session-observed'; providerSessionId: string; mode: StartMode; detail?: string }
  | { kind: 'turn-ended'; terminal: TurnTerminal; detail?: string }
  | { kind: 'error'; message: string; retryable: boolean; raw?: unknown };
```

In `src/driver/types.ts`, replace:

```ts

export interface StartResult {
  providerSessionId: string;
  mode: StartMode;
```

with:

```ts

export interface StartResult {
  /**
   * Empty when the agent has reported none yet: a driver that learns its
   * provider's id only from a turn reports it then, with `session-observed`.
   */
  providerSessionId: string;
  mode: StartMode;
```

In `src/types.ts`, replace:

```ts
  | 'session_state_changed'
  | 'generation_bumped'
  | 'agent_error';
```

with:

```ts
  | 'session_state_changed'
  | 'generation_bumped'
  /** The provider session id a turn ran in, and how it reached it (architecture §6.3). */
  | 'provider_session_observed'
  | 'agent_error';
```

In `src/core/session-actor.ts`, replace:

```ts
        return undefined;

      case 'turn-ended':
        return event.terminal;
```

with:

```ts
        return undefined;

      case 'session-observed':
        // Observed, never assumed: on every sighting, what the agent reported.
        observeProviderSessionId(this.#db, this.sessionId, event.providerSessionId);
        this.#append({
          type: 'provider_session_observed',
          actor: 'agent',
          turnId,
          generation,
          payload: {
            providerSessionId: event.providerSessionId,
            mode: event.mode,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
          },
        });
        if (event.detail !== undefined) this.#note(`provider session: ${event.detail}`);
        return undefined;

      case 'turn-ended':
        return event.terminal;
```

In `src/core/session-actor.ts`, replace:

```ts

      // Observed, never assumed. Agents mint their own id and can rotate it, so
      // what gets stored is what the agent just reported -- not what we sent.
      observeProviderSessionId(this.#db, this.sessionId, result.providerSessionId);
      setExecution(this.#db, this.sessionId, `${BOOT_ID}:${session.generation}`, this.#driver.id);
      setState(this.#db, this.sessionId, 'live', this.#clock.now());
```

with:

```ts

      // Observed, never assumed. Agents mint their own id and can rotate it, so
      // what gets stored is what the agent just reported -- not what we sent. An
      // empty one is none yet: the CLI driver learns it from a turn, and storing
      // '' would lose a seed the session was created with (spec §2.4 item 5).
      if (result.providerSessionId !== '') {
        observeProviderSessionId(this.#db, this.sessionId, result.providerSessionId);
      }
      setExecution(this.#db, this.sessionId, `${BOOT_ID}:${session.generation}`, this.#driver.id);
      setState(this.#db, this.sessionId, 'live', this.#clock.now());
```


- [ ] **Step 1.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/session-actor.test.ts`. Expected: `Tests  62 passed (62)`.

- [ ] **Step 1.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1333 passed (1333)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  75 passed (75)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.6: Commit.**

```bash
git add src/driver/types.ts src/types.ts src/core/session-actor.ts tests/session-actor.test.ts
git commit -m "Let a driver report, from a turn, the provider session id the turn ran in and whether it resumed, replayed or started the conversation, store it as observed and log it as provider_session_observed, and keep a session's seed when a start reports no id yet"
```

---

### Task 2: The CLI driver reads the agent's session id, and continues that session

**Files:**
- Create: `src/provider-id.ts`
- Modify: `src/driver/cli/driver.ts`, `tests/fakes/cli-agent.mjs`, `tests/cli-driver.e2e.ts`

Every turn's process is given `--session-id-file`, in an `mt-session-id-` directory of its own under the system's temporary directory, read once the process has exited and then removed; a directory that cannot be made ends the turn `failed` before anything starts (Decision 1). For a run not given `--session`, the id the agent wrote is reported as `session-observed` and kept: the next turn passes it as `--session` and sends the message alone (Decision 7). For a resumed run the file only echoes what was sent, so the session it ran in is the `session_id` of its first typed event on stdout: the same id is reported `resumed`, and a run that printed no typed event reports nothing and goes on with the same session (Decision 5; another id is Task 3's). A runtime started with a stored id — a restart's, an eviction's, a rework's seed — continues it from its first turn and says `resumed` at start; a `cli:` id from an older build fails `isResumableProviderId` and is never passed back (Decision 3). A failed or cancelled turn keeps its session (Decision 6). The fake agent learns to keep sessions as the spike measured bytesec 0.7.4 keeping them — the id written at the start, a refused id echoed, a session's agent kept — under `FAKE_CLI_SESSIONS`, with the variations Task 3 needs; without it, it writes no id, as an agent that cannot resume, so every existing test still sees the transcript.

- [ ] **Step 2.1: Write the failing tests.**

In `tests/fakes/cli-agent.mjs`, replace:

```js
 * beside the log, token included: a test that later reports as a run whose
 * process has gone needs it, and the token is a test's own.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MODE = process.env['FAKE_CLI_MODE'] ?? 'basic';
const LOG = process.env['FAKE_CLI_LOG'];

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
const prompt = dashdash === -1 ? '' : argv.slice(dashdash + 1).join(' ');

if (LOG !== undefined) {
  const apm = process.env['BYTESEC_LOCAL_APM_PATH'] ?? null;
  const run = process.env['MT_KANBAN_RUN'] ?? null;
  appendFileSync(LOG, `${JSON.stringify({ argv, prompt, apm, run })}\n`);
}
```

with:

```js
 * beside the log, token included: a test that later reports as a run whose
 * process has gone needs it, and the token is a test's own.
 *
 * With `FAKE_CLI_SESSIONS` set to a directory, it keeps sessions there as
 * bytesec 0.7.4 keeps them in its local store, as plan E's spike measured:
 *
 *   - `--session-id-file <path>` is written at the start, before the turn, with
 *     the session's id and a newline: on success, failure and cancel alike, and
 *     with the id asked for even when that id is then refused;
 *   - without `--session`, a new session is made, as the agent the run names
 *     (`--agent`, else `bytesec-agent`);
 *   - `--session <id>` continues that session, whatever `--dir` says; one the
 *     store does not hold exits 1 with nothing on stdout and
 *     `turn 1: persistence: session not found` on stderr, and one made as
 *     another agent exits 1 with `turn 1: unknown agent: <its agent>`;
 *   - `FAKE_CLI_RESUME=ignore` makes a new session even when `--session` names
 *     one, as 0.7.2 did, so the id written is not the one asked for;
 *     `FAKE_CLI_RESUME=echo` does too, but writes the id asked for to the file,
 *     so only the `session_id` on its events says which session it ran in;
 *   - `FAKE_CLI_REFUSAL` changes how a refusal looks: `noisy` prints a typed
 *     event nobody has a projection for before it, `trailing` writes another
 *     stderr line after it, and `slow` waits 1.5 s first, so a test can stop it.
 *
 * Each session's file holds its agent and every prompt it was sent. Without
 * `FAKE_CLI_SESSIONS` the agent writes no id, as an agent that cannot resume.
 * The log line carries `--session`'s value as `session` (null when absent).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MODE = process.env['FAKE_CLI_MODE'] ?? 'basic';
const LOG = process.env['FAKE_CLI_LOG'];
const SESSIONS = process.env['FAKE_CLI_SESSIONS'];

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
const prompt = dashdash === -1 ? '' : argv.slice(dashdash + 1).join(' ');
const flags = dashdash === -1 ? argv : argv.slice(0, dashdash);

/** A flag's value, before the `--` that starts the prompt. */
function flag(name) {
  const i = flags.indexOf(name);
  return i === -1 ? undefined : flags[i + 1];
}

const asked = flag('--session');

if (LOG !== undefined) {
  const apm = process.env['BYTESEC_LOCAL_APM_PATH'] ?? null;
  const run = process.env['MT_KANBAN_RUN'] ?? null;
  appendFileSync(LOG, `${JSON.stringify({ argv, prompt, apm, run, session: asked ?? null })}\n`);
}

let SESSION = 'ses_fake_cli';

/** Refuse to continue the session, as bytesec does: before the turn, exit 1. Written synchronously, then gone. */
function refuse(line) {
  const how = process.env['FAKE_CLI_REFUSAL'];
  // Blocks; a SIGTERM still ends the process.
  if (how === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  if (how === 'noisy') writeSync(1, `${JSON.stringify({ type: 'sentiment_delta', session_id: asked, mood: 'wary' })}\n`);
  writeSync(2, `${line}\n`);
  if (how === 'trailing') writeSync(2, 'session store closed\n');
  process.exit(1);
}

if (SESSIONS !== undefined) {
  mkdirSync(SESSIONS, { recursive: true });
  const agent = flag('--agent') ?? 'bytesec-agent';
  const resume = process.env['FAKE_CLI_RESUME'];
  const continuing = asked !== undefined && resume !== 'ignore' && resume !== 'echo';
  SESSION = continuing ? asked : `ses_fake_${randomBytes(6).toString('hex')}`;
  const idFile = flag('--session-id-file');
  if (idFile !== undefined) writeFileSync(idFile, `${asked !== undefined && resume === 'echo' ? asked : SESSION}\n`);
  const file = join(SESSIONS, `${SESSION}.json`);
  if (continuing) {
    if (!existsSync(file)) refuse('turn 1: persistence: session not found');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (stored.agent !== agent) refuse(`turn 1: unknown agent: ${stored.agent}`);
    writeFileSync(file, JSON.stringify({ agent, prompts: [...stored.prompts, prompt] }));
  } else {
    writeFileSync(file, JSON.stringify({ agent, prompts: [prompt] }));
  }
}
```

In `tests/fakes/cli-agent.mjs`, replace:

```js
  summary('completed', `reported on ${title}`);
}

const SESSION = 'ses_fake_cli';

function emit(object) {
```

with:

```js
  summary('completed', `reported on ${title}`);
}

function emit(object) {
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
```

with:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
 *
 * `tests/fakes/cli-agent.mjs` writes its argv to a log on every invocation. That
 * log is the only way to see the composed prompt, and the composed prompt *is* this
 * driver's session handling: with no resume available, continuity exists only as
 * text the driver puts on the command line.
 */
```

with:

```ts
 *
 * `tests/fakes/cli-agent.mjs` writes its argv to a log on every invocation. That
 * log is the only way to see the composed prompt and the `--session` asked for,
 * and those two *are* this driver's session handling: the provider's session
 * continued natively, or, from an agent that cannot resume, the conversation as
 * text the driver puts on the command line. With `sessions`, the fake keeps
 * sessions as bytesec 0.7.4 does (plan E's spike).
 */
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
  cwd: string;
  /** One entry per process the driver started, in order. */
  invocations(): Array<{ argv: string[]; prompt: string; apm: string | null }>;
}
```

with:

```ts
  cwd: string;
  /** One entry per process the driver started, in order. */
  invocations(): Invocation[];
  /** The prompts the fake's store holds for a provider session. */
  stored(id: string): { agent: string; prompts: string[] };
}

interface Invocation {
  argv: string[];
  prompt: string;
  apm: string | null;
  session: string | null;
}
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
    args?: string[];
    env?: Record<string, string>;
  } = {},
): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'prime-cli-'));
  const logPath = join(dir, 'invocations.log');
  const driver = createCliDriver({
    command: process.execPath,
    args: [AGENT],
    env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: logPath },
    ...(opts.maxPromptBytes === undefined ? {} : { maxPromptBytes: opts.maxPromptBytes }),
  });

  const started = await driver.start({ cwd: dir, replay: opts.replay, args: opts.args, env: opts.env });

  cleanups.push(async () => {
```

with:

```ts
    args?: string[];
    env?: Record<string, string>;
    /** A store for the fake's sessions, shared by every start given the same one. */
    sessions?: string;
    providerSessionId?: string | undefined;
  } = {},
): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'mt-cli-test-'));
  const logPath = join(dir, 'invocations.log');
  const driver = createCliDriver({
    command: process.execPath,
    args: [AGENT],
    env: {
      FAKE_CLI_MODE: mode,
      FAKE_CLI_LOG: logPath,
      ...(opts.sessions === undefined ? {} : { FAKE_CLI_SESSIONS: opts.sessions }),
    },
    ...(opts.maxPromptBytes === undefined ? {} : { maxPromptBytes: opts.maxPromptBytes }),
  });

  const started = await driver.start({
    cwd: dir,
    replay: opts.replay,
    args: opts.args,
    env: opts.env,
    providerSessionId: opts.providerSessionId,
  });

  cleanups.push(async () => {
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { argv: string[]; prompt: string; apm: string | null });
    },
  };
}
```

with:

```ts
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Invocation);
    },
    stored: (id) => {
      if (opts.sessions === undefined) throw new Error('this start keeps no sessions');
      return JSON.parse(readFileSync(join(opts.sessions, `${id}.json`), 'utf8')) as { agent: string; prompts: string[] };
    },
  };
}

/** A directory for the fake's sessions, removed after the test. */
function store(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mt-cli-sessions-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function observed(events: readonly DriverEvent[]): Extract<DriverEvent, { kind: 'session-observed' }> | undefined {
  return events.find((e): e is Extract<DriverEvent, { kind: 'session-observed' }> => e.kind === 'session-observed');
}

/** The value after a flag in an invocation's argv, before the prompt. */
function flagOf(invocation: Invocation | undefined, name: string): string | undefined {
  const argv = invocation?.argv ?? [];
  const end = argv.indexOf('--');
  const i = argv.slice(0, end === -1 ? argv.length : end).indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}
```

In `tests/cli-driver.e2e.ts`, replace:

```ts

describe('CLI driver: establishing a session', () => {
  it('starts without a process, and says the id is not the provider’s', async () => {
    const s = await start('basic');
    // No process yet: there is nothing for one to hold open between turns.
    expect(s.invocations()).toEqual([]);
    // A `cli:` id rather than one the agent minted. The agent mints a new session
    // per process and will not take one back, so recording its id would put
    // something in the log that reads as resumable and is not.
    expect(s.result.providerSessionId).toMatch(/^cli:/);
    expect(s.runtime.providerSessionId).toBe(s.result.providerSessionId);
    expect(s.result.mode).toBe('fresh');
  });

  it('reports replayed whenever there is history to carry', async () => {
    // Not `resumed`, ever. The degrade is permanent here rather than a fallback,
    // and reporting it every time is the point: the user is entitled to know the
    // agent is working from a transcript.
    const s = await start('basic', { replay: [said('earlier')] });
    expect(s.result.mode).toBe('replayed');
```

with:

```ts

describe('CLI driver: establishing a session', () => {
  it('starts without a process, and reports no provider id until a turn does', async () => {
    const s = await start('basic');
    // No process yet: there is nothing for one to hold open between turns.
    expect(s.invocations()).toEqual([]);
    // The agent mints its session's id in the first turn's process; an id made up
    // here would be stored as observed and handed back as one to resume.
    expect(s.result.providerSessionId).toBe('');
    expect(s.runtime.providerSessionId).toBe('');
    expect(s.result.mode).toBe('fresh');
  });

  it('reports replayed when there is history to carry and no session to continue', async () => {
    // The user is entitled to know the agent is working from a transcript.
    const s = await start('basic', { replay: [said('earlier')] });
    expect(s.result.mode).toBe('replayed');
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
});

describe('CLI driver: things going wrong', () => {
  it('hands over the reason a turn failed, from stderr', async () => {
```

with:

```ts
});

describe('CLI driver: native resume', () => {
  it('reads the id the agent writes, and reports it with how the turn reached the conversation', async () => {
    const s = await start('basic', { sessions: store() });
    const events = await collect(s.runtime.prompt(said('remember pickle')));

    // Before the terminal, so the core stores it with the turn still open.
    expect(kinds(events)).toEqual(['message-chunk', 'message-chunk', 'usage', 'session-observed', 'turn-ended']);
    const seen = observed(events);
    expect(seen?.providerSessionId).toMatch(/^ses_fake_/);
    expect(seen?.mode).toBe('fresh');
    expect(s.runtime.providerSessionId).toBe(seen?.providerSessionId);
    // A first turn asks for no session, and is told where to write the one it ran in.
    const [first] = s.invocations();
    expect(first?.session).toBeNull();
    // The id file is the driver's own, outside the workspace, and gone once read.
    const idFile = flagOf(first, '--session-id-file') ?? '';
    expect(idFile.startsWith(s.cwd)).toBe(false);
    expect(existsSync(idFile)).toBe(false);
  });

  it('continues that session on the next turn, sending only the new message', async () => {
    const s = await start('basic', { sessions: store() });
    const first = observed(await collect(s.runtime.prompt(said('remember pickle'))));
    const events = await collect(s.runtime.prompt(said('what did I say?')));

    const second = s.invocations()[1];
    expect(second?.session).toBe(first?.providerSessionId);
    // No transcript: the provider's session holds the conversation.
    expect(second?.prompt).toBe('what did I say?');
    expect(observed(events)).toEqual({
      kind: 'session-observed',
      providerSessionId: first?.providerSessionId,
      mode: 'resumed',
    });
    expect(s.stored(first?.providerSessionId ?? '').prompts).toEqual(['remember pickle', 'what did I say?']);
  });

  it('starts from a session observed before, and says so, without the transcript', async () => {
    // A restart, an idle eviction or a rework's seed (spec §2.4 item 5).
    const sessions = store();
    const before = await start('basic', { sessions });
    const id = observed(await collect(before.runtime.prompt(said('remember pickle'))))?.providerSessionId;

    const s = await start('basic', { sessions, providerSessionId: id, replay: [said('remember pickle')] });
    expect(s.result).toEqual({ providerSessionId: id, mode: 'resumed' });
    await collect(s.runtime.prompt(said('what did I say?')));
    expect(s.invocations()[0]?.session).toBe(id);
    expect(s.invocations()[0]?.prompt).toBe('what did I say?');
  });

  it('never hands back an id it stored before it could resume', async () => {
    // A session from before native resume holds `cli:<nonce>`, which names a runtime.
    const s = await start('basic', { sessions: store(), providerSessionId: 'cli:1a2b3c4d', replay: [said('asked before')] });
    expect(s.result).toEqual({ providerSessionId: '', mode: 'replayed' });
    const events = await collect(s.runtime.prompt(said('asking now')));
    expect(s.invocations()[0]?.session).toBeNull();
    expect(s.invocations()[0]?.prompt).toContain('> asked before');
    expect(observed(events)?.mode).toBe('replayed');
  });

  it('keeps the session of a turn that failed, and continues it on the next', async () => {
    // The provider's session holds what the failed turn did; a transcript holds only what was said.
    const s = await start('error', { sessions: store() });
    const events = await collect(s.runtime.prompt(said('go')));
    expect(kinds(events)).toEqual(['session-observed', 'error', 'turn-ended']);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'failed' });

    await collect(s.runtime.prompt(said('again')));
    expect(s.invocations()[1]?.session).toBe(observed(events)?.providerSessionId);
  });

  it('keeps the session of a cancelled turn', async () => {
    const s = await start('hang', { sessions: store() });
    const iterator = s.runtime.prompt(said('forever'))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ kind: 'message-chunk' });
    await s.runtime.cancel();
    const rest: DriverEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      rest.push(next.value);
    }
    expect(kinds(rest)).toEqual(['session-observed', 'turn-ended']);
    expect(rest.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'cancelled' });
    expect(s.runtime.providerSessionId).toMatch(/^ses_fake_/);
  });

  it('reports nothing for a resumed turn that printed no typed event, and goes on continuing the session', async () => {
    // Given --session, the id file only echoes it: the agent's own events are the evidence.
    const sessions = store();
    const before = await start('basic', { sessions });
    const id = observed(await collect(before.runtime.prompt(said('remember pickle'))))?.providerSessionId;

    const s = await start('unstreamed', { sessions, providerSessionId: id });
    const events = await collect(s.runtime.prompt(said('what did I say?')));
    expect(kinds(events)).toEqual(['message-chunk', 'turn-ended']);
    expect(s.runtime.providerSessionId).toBe(id);
    await collect(s.runtime.prompt(said('and now?')));
    expect(s.invocations()[1]?.session).toBe(id);
  });

  it('ends a turn failed, saying why, when it cannot make the directory for the id', async () => {
    const s = await start('basic', { sessions: store() });
    const saved = process.env['TMPDIR'];
    process.env['TMPDIR'] = join(s.cwd, 'no-such-directory');
    let events: DriverEvent[];
    try {
      events = await collect(s.runtime.prompt(said('go')));
    } finally {
      if (saved === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = saved;
    }
    expect(kinds(events)).toEqual(['error', 'turn-ended']);
    expect((events[0] as Extract<DriverEvent, { kind: 'error' }>).message).toMatch(/^could not make a directory for the agent's session id: /);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'failed' });
    expect(s.invocations()).toEqual([]);
  });
});

describe('CLI driver: things going wrong', () => {
  it('hands over the reason a turn failed, from stderr', async () => {
```


- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project e2e tests/cli-driver.e2e.ts`. Expected: nine FAIL — the first establishing test with `expected 'cli:…' to be ''`, and the eight in "CLI driver: native resume", as no `--session-id-file` is passed and no `session-observed` is emitted (for example `expected [ 'error', 'turn-ended' ] to deeply equal [ 'session-observed', 'error', …(1) ]`, and, for the directory that cannot be made, `expected [ 'message-chunk', …(3) ] to deeply equal [ 'error', 'turn-ended' ]`). `Tests  9 failed | 26 passed (35)`.

- [ ] **Step 2.3: Implement.**

Create `src/provider-id.ts`:

```ts
/**
 * Whether a stored provider session id is one a driver may hand back to its agent
 * to resume (architecture §6.3, plan E): one argv word, starting with a letter or
 * a digit, so it can never be read as a flag, and at most 200 characters.
 *
 * A `cli:<nonce>` id, which the CLI driver stored before it could resume, is not
 * one: it names a runtime, not a provider's session. So it is never passed back
 * as `--session`, never seeds a rework (spec §5.3), and never shows in `/status`.
 */
const RESUMABLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

export function isResumableProviderId(id: unknown): id is string {
  return typeof id === 'string' && RESUMABLE.test(id);
}
```

In `src/driver/cli/driver.ts`, replace:

```ts
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { delimiter, isAbsolute, join } from 'node:path';
```

with:

```ts
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { delimiter, isAbsolute, join } from 'node:path';
```

In `src/driver/cli/driver.ts`, replace:

```ts
  DriverEvent,
  PromptInput,
  StartOptions,
  StartResult,
```

with:

```ts
  DriverEvent,
  PromptInput,
  StartMode,
  StartOptions,
  StartResult,
```

In `src/driver/cli/driver.ts`, replace:

```ts
import type { TurnTerminal } from '../../types.js';
import { buildEnv } from '../env.js';

/**
```

with:

```ts
import type { TurnTerminal } from '../../types.js';
import { buildEnv } from '../env.js';
import { isResumableProviderId } from '../../provider-id.js';

/**
```

In `src/driver/cli/driver.ts`, replace:

```ts
 *    security posture, which is why `agent.unsupervised` has to be written down
 *    in the config before this driver will load at all.
 * 2. **No resume.** Each turn is a fresh process with a fresh agent session, and
 *    the session ids it mints cannot be handed back to it. Continuity is therefore
 *    reconstructed: the conversation so far is composed into the prompt as a
 *    transcript. That costs input tokens on every turn, and it means the agent
 *    recovers what was *said* but not the tool state behind it.
 * 3. **No cooperative cancel.** Cancelling means killing the process, so work
 *    already done stands.
 *
 * The wire format below is ByteSec's `run --format json` stream, verified against
 * 0.7.2 rather than inferred. Everything specific to it -- the flag spellings, the
 * event names -- stops at this file, in the same way ACP stops at `../acp`.
 */
```

with:

```ts
 *    security posture, which is why `agent.unsupervised` has to be written down
 *    in the config before this driver will load at all.
 * 2. **Resume per process.** Each turn is a fresh process, which continues the
 *    provider's own session: the driver reads the id the agent writes to
 *    `--session-id-file` and passes it back as `--session` on the next turn, which
 *    then carries only the new message. Until the agent has written an id, the
 *    conversation is composed into the prompt as a transcript, which recovers
 *    what was *said* but not the tool state behind it.
 * 3. **No cooperative cancel.** Cancelling means killing the process, so work
 *    already done stands.
 *
 * The wire format below is ByteSec's `run --format json` stream, verified against
 * 0.7.2 rather than inferred, and its sessions against 0.7.4 (plan E's spike).
 * Everything specific to it -- the flag spellings, the event names -- stops at
 * this file, in the same way ACP stops at `../acp`.
 */
```

In `src/driver/cli/driver.ts`, replace:

```ts
/** How long a finished turn waits for the tail of stderr. See `drain`. */
const STDERR_DRAIN_MS = 100;

/** Resolve once the stream has ended, or once the wait stops being worth it. */
```

with:

```ts
/** How long a finished turn waits for the tail of stderr. See `drain`. */
const STDERR_DRAIN_MS = 100;

/** The id the agent wrote, or undefined when it wrote none, or nothing usable. */
function readSessionId(path: string): string | undefined {
  try {
    const id = readFileSync(path, 'utf8').trim();
    return isResumableProviderId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The `session_id` of a typed event on stdout: which session the agent says it is in. */
function typedSessionId(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as unknown;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
    const { type, session_id: id } = obj as Record<string, unknown>;
    return typeof type === 'string' && typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}


/** Resolve once the stream has ended, or once the wait stops being worth it. */
```

In `src/driver/cli/driver.ts`, replace:

```ts

class CliRuntime implements AgentRuntime {
  readonly providerSessionId: string;
  /** The fence label for the transcript, unguessable so it cannot be forged. */
  readonly #nonce: string;
```

with:

```ts

class CliRuntime implements AgentRuntime {
  /** The fence label for the transcript, unguessable so it cannot be forged. */
  readonly #nonce: string;
```

In `src/driver/cli/driver.ts`, replace:

```ts
  #history: Exchange[];
  #maxPromptBytes: number;

  /** Set synchronously by `prompt`, so a second caller is refused, not queued. */
```

with:

```ts
  #history: Exchange[];
  #maxPromptBytes: number;
  /** The provider session the next turn continues, if there is one. */
  #resume: string | undefined;
  /** The last id the agent reported, or the one this runtime was started to continue. */
  #providerSessionId: string;

  /** Set synchronously by `prompt`, so a second caller is refused, not queued. */
```

In `src/driver/cli/driver.ts`, replace:

```ts
    this.#maxPromptBytes = config.maxPromptBytes ?? MAX_PROMPT_BYTES;
    this.#nonce = randomUUID().slice(0, 8);
    // The provider mints a session id per process and will not take one back, so
    // there is nothing durable to observe. This id names *this runtime*, and says
    // so, rather than recording a provider id that looks resumable and is not.
    this.providerSessionId = `cli:${this.#nonce}`;

    // Prior prompts come from the event log, which is the system of record. Their
```

with:

```ts
    this.#maxPromptBytes = config.maxPromptBytes ?? MAX_PROMPT_BYTES;
    this.#nonce = randomUUID().slice(0, 8);
    // The id the session observed before, or was seeded with (spec §2.4 item 5).
    // Empty until the first turn reports one otherwise: the agent mints it.
    this.#resume = isResumableProviderId(opts.providerSessionId) ? opts.providerSessionId : undefined;
    this.#providerSessionId = this.#resume ?? '';

    // Prior prompts come from the event log, which is the system of record. Their
```

In `src/driver/cli/driver.ts`, replace:

```ts
  }

  /**
   * `fresh` or `replayed`, never `resumed`.
   *
   * The provider cannot resume, so `resume: native -> replay` -- the one degrade
   * this layer sanctions -- is not a fallback here but the permanent state. When
   * there is history to carry, that is `replayed`, and the user is entitled to see
   * it every time rather than have it look like a resumed session.
   */
  startResult(): StartResult {
    return {
      providerSessionId: this.providerSessionId,
      mode: this.#history.length === 0 ? 'fresh' : 'replayed',
    };
  }
```

with:

```ts
  }

  get providerSessionId(): string {
    return this.#providerSessionId;
  }

  /**
   * What the first turn will do: continue a provider session (`resumed`), carry
   * the history as a transcript (`replayed`), or neither. Nothing is spawned
   * yet, so `resumed` is an intent; each turn reports what it actually did with
   * `session-observed`.
   */
  startResult(): StartResult {
    return {
      providerSessionId: this.#providerSessionId,
      mode: this.#resume !== undefined ? 'resumed' : this.#history.length === 0 ? 'fresh' : 'replayed',
    };
  }
```

In `src/driver/cli/driver.ts`, replace:

```ts
  async *#run(input: PromptInput): AsyncGenerator<DriverEvent> {
    try {
      const composed = this.#compose(input);
      if (composed === undefined) {
        const size = Buffer.byteLength(renderInput(input), 'utf8');
```

with:

```ts
  async *#run(input: PromptInput): AsyncGenerator<DriverEvent> {
    try {
      const resume = this.#resume;
      // A resumed turn carries only the new message: the provider has the rest.
      const composed = resume === undefined ? this.#compose(input) : this.#alone(input);
      if (composed === undefined) {
        const size = Buffer.byteLength(renderInput(input), 'utf8');
```

In `src/driver/cli/driver.ts`, replace:

```ts
      }

      yield* this.#runTurn(input, composed);
    } finally {
      this.#inflight = false;
```

with:

```ts
      }

      yield* this.#runTurn(input, composed, resume);
    } finally {
      this.#inflight = false;
```

In `src/driver/cli/driver.ts`, replace:

```ts
  }

  async *#runTurn(input: PromptInput, composed: string): AsyncGenerator<DriverEvent> {
    const args = [
      ...this.#config.args,
```

with:

```ts
  }

  /**
   * One turn, in one process.
   *
   * The id file lives in a directory of its own under the system's temporary
   * directory, never the workspace, where it would show in the agent's checkout,
   * and is removed once read. A gateway that dies mid-turn leaves the directory
   * behind; it holds only the id, which is no secret.
   */
  async *#runTurn(input: PromptInput, composed: string, resume: string | undefined): AsyncGenerator<DriverEvent> {
    let dir: string;
    try {
      dir = mkdtempSync(join(tmpdir(), 'mt-session-id-'));
    } catch (err) {
      yield {
        kind: 'error',
        message: `could not make a directory for the agent's session id: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      };
      // Nothing was started, so nothing is unclear.
      yield { kind: 'turn-ended', terminal: 'failed' };
      return;
    }
    try {
      yield* this.#attempt(input, composed, resume, join(dir, 'session-id'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Run the agent once, yielding the whole turn. */
  async *#attempt(
    input: PromptInput,
    composed: string,
    resume: string | undefined,
    idFile: string,
  ): AsyncGenerator<DriverEvent> {
    // Whether this attempt carries a transcript, before it adds its own exchange.
    const carried = resume === undefined && this.#history.length > 0;
    const args = [
      ...this.#config.args,
```

In `src/driver/cli/driver.ts`, replace:

```ts
      '--dir',
      this.#cwd,
      // Unsupervised, explicitly. There is no channel on which a permission
      // request could be answered -- stdin is closed -- so an agent that stopped
```

with:

```ts
      '--dir',
      this.#cwd,
      // The provider session to continue, and where the agent says which one it
      // ran in (plan E). Written at the process's start, even for a turn that
      // then fails, and with the id asked for, whether or not it was continued.
      ...(resume === undefined ? [] : ['--session', resume]),
      '--session-id-file',
      idFile,
      // Unsupervised, explicitly. There is no channel on which a permission
      // request could be answered -- stdin is closed -- so an agent that stopped
```

In `src/driver/cli/driver.ts`, replace:

```ts
    let summary: TurnSummary | undefined;
    let said = false;

    const lines = createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        const parsed = parseLine(line);
        if (parsed === undefined) continue;
```

with:

```ts
    let summary: TurnSummary | undefined;
    let said = false;
    /** The session the agent's first typed event says it is in. */
    let streamedId: string | undefined;

    const lines = createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        if (line.trim().startsWith('{')) streamedId ??= typedSessionId(line.trim());
        const parsed = parseLine(line);
        if (parsed === undefined) continue;
```

In `src/driver/cli/driver.ts`, replace:

```ts

    const code = await exited;

    // Streamed nothing, but reported an answer. Some builds do not stream at all,
```

with:

```ts

    const code = await exited;

    // Which session the run was in. Given --session, the agent writes back the
    // id it was given whether or not it continued that session, so only its own
    // stream is evidence; without one, the file it wrote is.
    const ranIn = resume === undefined ? readSessionId(idFile) : streamedId;
    const seen = this.#observe(ranIn, resume, carried);
    if (seen !== undefined) yield seen;

    // Streamed nothing, but reported an answer. Some builds do not stream at all,
```

In `src/driver/cli/driver.ts`, replace:

```ts
  }

  /** Record the exchange, so the next turn can be told about it. */
  #remember(input: PromptInput, answer: string): void {
    this.#history.push({ prompt: renderInput(input), answer: answer.trim() });
  }
```

with:

```ts
  }

  /**
   * The provider session this attempt ran in, as the agent reported it, and how
   * the turn reached the conversation; the next turn continues it. Undefined when
   * the agent reported none -- an agent that cannot resume, whose next turn
   * replays, or a resumed run that printed no typed event, whose next turn
   * continues the same session.
   *
   * Kept after a failed or cancelled turn too: the provider's session holds what
   * that turn did, which a transcript of what was said does not.
   */
  #observe(observed: string | undefined, resume: string | undefined, carried: boolean): DriverEvent | undefined {
    if (!isResumableProviderId(observed)) return undefined;
    // Another session than the one asked for is not a resumed turn; it is not reported yet.
    if (resume !== undefined && observed !== resume) return undefined;
    this.#providerSessionId = observed;
    this.#resume = observed;
    const mode: StartMode = resume !== undefined ? 'resumed' : carried ? 'replayed' : 'fresh';
    return { kind: 'session-observed', providerSessionId: observed, mode };
  }

  /** Record the exchange, so the next turn can be told about it. */
  #remember(input: PromptInput, answer: string): void {
    this.#history.push({ prompt: renderInput(input), answer: answer.trim() });
  }

  /** The message alone, for a resumed turn; undefined when it does not fit. */
  #alone(input: PromptInput): string | undefined {
    const message = renderInput(input);
    return Buffer.byteLength(message, 'utf8') > this.#maxPromptBytes ? undefined : message;
  }
```


- [ ] **Step 2.4: Run them to verify they pass.** Run `npx vitest run --project e2e tests/cli-driver.e2e.ts`. Expected: `Tests  35 passed (35)`.

- [ ] **Step 2.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1333 passed (1333)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  83 passed (83)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.6: Commit.**

```bash
git add src/provider-id.ts src/driver/cli/driver.ts tests/fakes/cli-agent.mjs tests/cli-driver.e2e.ts
git commit -m "Have the CLI driver give each turn's process a session id file in a directory of its own outside the workspace, report the provider session the agent ran in, from that file or, for a resumed run, from its events, and continue it on the next turn with --session and the message alone, from a stored id after a restart too, never handing back an old cli: id"
```

---

### Task 3: When the agent will not resume

**Files:**
- Modify: `src/driver/cli/driver.ts`, `tests/cli-driver.e2e.ts`

A resumed run that the agent refuses before the turn starts — exit 1, no line starting with `{` on stdout, not cancelled, and stderr's last non-empty line exactly `turn N: persistence: session not found` or `turn N: unknown agent: <name>` — is run again in the same turn without `--session`, with the transcript, and reported `replayed` with the reason, or `fresh` when there was nothing to carry (Decision 4). A cancel or close that arrives as the refused run exits ends the turn `cancelled` rather than starting the second process. A resumed run whose events name another session is reported `fresh`, saying so, and the runtime replays from then on (Decision 5). Four of the new tests hold lines the implementation must not cross — a run that printed anything, a refusal that is not stderr's last line, a refusal cancelled while it waits, and a resumed run that fails after starting are never run again — and pass before it as well as after.

- [ ] **Step 3.1: Write the failing tests.**

In `tests/cli-driver.e2e.ts`, replace:

```ts
});

describe('CLI driver: things going wrong', () => {
  it('hands over the reason a turn failed, from stderr', async () => {
```

with:

```ts
});

describe('CLI driver: when the agent will not resume', () => {
  it('runs the turn again with the transcript when the agent refuses the session, in the same turn', async () => {
    const s = await start('basic', { sessions: store(), providerSessionId: 'ses_gone', replay: [said('asked before')] });
    const events = await collect(s.runtime.prompt(said('asking now')));

    // One turn, completed: the refusal started nothing, so nothing ran twice.
    expect(kinds(events)).toEqual(['message-chunk', 'message-chunk', 'usage', 'session-observed', 'turn-ended']);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
    const [refused, replayed] = s.invocations();
    expect(s.invocations()).toHaveLength(2);
    expect(refused?.session).toBe('ses_gone');
    expect(refused?.prompt).toBe('asking now');
    expect(replayed?.session).toBeNull();
    expect(replayed?.prompt).toContain('> asked before');
    const seen = observed(events);
    expect(seen?.mode).toBe('replayed');
    expect(seen?.providerSessionId).not.toBe('ses_gone');
    expect(seen?.detail).toBe(
      'provider session ses_gone could not be resumed (persistence: session not found), so the conversation was replayed',
    );

    // The new session is the one continued from now on.
    await collect(s.runtime.prompt(said('and now')));
    expect(s.invocations()[2]?.session).toBe(seen?.providerSessionId);
    expect(s.invocations()[2]?.prompt).toBe('and now');
  });

  it('says a refused session with no history to carry started a new conversation', async () => {
    const s = await start('basic', { sessions: store(), providerSessionId: 'ses_gone' });
    const seen = observed(await collect(s.runtime.prompt(said('hello'))));
    expect(seen?.mode).toBe('fresh');
    expect(seen?.detail).toBe(
      'provider session ses_gone could not be resumed (persistence: session not found), so this turn started a new conversation',
    );
  });

  it('takes a session made as another agent for refused', async () => {
    // bytesec keeps a session's agent: resumed as another, it exits before the turn.
    const sessions = store();
    const writer = await start('basic', { sessions, args: ['--agent', 'writer'] });
    const id = observed(await collect(writer.runtime.prompt(said('draft it'))))?.providerSessionId;

    const s = await start('basic', { sessions, args: ['--agent', 'editor'], providerSessionId: id });
    const events = await collect(s.runtime.prompt(said('edit it')));
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'completed' });
    expect(s.invocations()).toHaveLength(2);
    expect(observed(events)?.detail).toContain('(unknown agent: writer)');
  });

  it('stops resuming an agent that answers --session with another session', async () => {
    // bytesec 0.7.2 did: the turn ran, but not in the conversation it was asked to continue.
    const s = await start('basic', { sessions: store(), env: { FAKE_CLI_RESUME: 'ignore' } });
    const first = observed(await collect(s.runtime.prompt(said('remember pickle'))));
    const second = observed(await collect(s.runtime.prompt(said('what did I say?'))));
    expect(s.invocations()[1]?.session).toBe(first?.providerSessionId);
    expect(second?.mode).toBe('fresh');
    expect(second?.detail).toBe(
      `asked to continue provider session ${first?.providerSessionId ?? ''}, the agent ran in ` +
        `${second?.providerSessionId ?? ''} instead, so later turns carry the conversation as a transcript`,
    );

    await collect(s.runtime.prompt(said('and now?')));
    const third = s.invocations()[2];
    expect(third?.session).toBeNull();
    expect(third?.prompt).toContain('> remember pickle');
  });

  it('takes the session a resumed run ran in from its events, not from the id file', async () => {
    // bytesec writes back the id it was given even when it does not continue it.
    const s = await start('basic', { sessions: store(), env: { FAKE_CLI_RESUME: 'echo' } });
    const first = observed(await collect(s.runtime.prompt(said('remember pickle'))));
    const second = observed(await collect(s.runtime.prompt(said('what did I say?'))));
    expect(s.invocations()[1]?.session).toBe(first?.providerSessionId);
    expect(second?.mode).toBe('fresh');
    expect(second?.providerSessionId).toMatch(/^ses_fake_/);
    expect(second?.providerSessionId).not.toBe(first?.providerSessionId);
    expect(s.runtime.providerSessionId).toBe(second?.providerSessionId);
    await collect(s.runtime.prompt(said('and now?')));
    expect(s.invocations()[2]?.session).toBeNull();
  });

  it('does not take a run that printed anything for refused, whatever stderr says', async () => {
    const s = await start('basic', { sessions: store(), providerSessionId: 'ses_gone', env: { FAKE_CLI_REFUSAL: 'noisy' } });
    const events = await collect(s.runtime.prompt(said('hello')));
    expect(s.invocations()).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
  });

  it('takes only the last line of stderr for a refusal', async () => {
    const s = await start('basic', { sessions: store(), providerSessionId: 'ses_gone', env: { FAKE_CLI_REFUSAL: 'trailing' } });
    const events = await collect(s.runtime.prompt(said('hello')));
    expect(s.invocations()).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
  });

  it('does not run a refused turn again once it is cancelled', async () => {
    const s = await start('basic', { sessions: store(), providerSessionId: 'ses_gone', env: { FAKE_CLI_REFUSAL: 'slow' } });
    const turn = collect(s.runtime.prompt(said('hello')));
    // Until the refusing process has started.
    for (let i = 0; i < 200 && s.invocations().length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    await s.runtime.cancel();
    const events = await turn;
    expect(events).toEqual([{ kind: 'turn-ended', terminal: 'cancelled' }]);
    expect(s.invocations()).toHaveLength(1);
  });

  it('does not run a resumed turn again when it fails after starting', async () => {
    // Only a refusal before the turn is safe to run again; a crash is the turn's own outcome.
    const sessions = store();
    const before = await start('basic', { sessions });
    const id = observed(await collect(before.runtime.prompt(said('remember pickle'))))?.providerSessionId;

    const s = await start('crash', { sessions, providerSessionId: id });
    const events = await collect(s.runtime.prompt(said('go')));
    expect(s.invocations()).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'turn-ended', terminal: 'ambiguous' });
    expect(observed(events)?.mode).toBe('resumed');
  });
});

describe('CLI driver: things going wrong', () => {
  it('hands over the reason a turn failed, from stderr', async () => {
```


- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project e2e tests/cli-driver.e2e.ts`. Expected: five of the nine new tests FAIL. The refused session ends with an `error` (`expected [ 'error', 'turn-ended' ] to deeply equal [ 'message-chunk', …(4) ]`); the other agent's session ends `ambiguous` instead of `completed` (`expected { kind: 'turn-ended', …(1) } to deeply equal { kind: 'turn-ended', …(1) }`); and the session with no history, the agent that answers with another session and the one that only echoes the id report nothing (`expected undefined to be 'fresh'`). `Tests  5 failed | 39 passed (44)`.

- [ ] **Step 3.3: Implement.**

In `src/driver/cli/driver.ts`, replace:

```ts
 *    provider's own session: the driver reads the id the agent writes to
 *    `--session-id-file` and passes it back as `--session` on the next turn, which
 *    then carries only the new message. Until the agent has written an id, the
 *    conversation is composed into the prompt as a transcript, which recovers
 *    what was *said* but not the tool state behind it.
 * 3. **No cooperative cancel.** Cancelling means killing the process, so work
 *    already done stands.
```

with:

```ts
 *    provider's own session: the driver reads the id the agent writes to
 *    `--session-id-file` and passes it back as `--session` on the next turn, which
 *    then carries only the new message. When the agent refuses the id, the turn is
 *    run again with the conversation composed into the prompt as a transcript --
 *    `resume: native -> replay`, the one degrade this layer sanctions -- which
 *    recovers what was *said* but not the tool state behind it.
 * 3. **No cooperative cancel.** Cancelling means killing the process, so work
 *    already done stands.
```

In `src/driver/cli/driver.ts`, replace:

```ts
 * The wire format below is ByteSec's `run --format json` stream, verified against
 * 0.7.2 rather than inferred, and its sessions against 0.7.4 (plan E's spike).
 * Everything specific to it -- the flag spellings, the event names -- stops at
 * this file, in the same way ACP stops at `../acp`.
 */
```

with:

```ts
 * The wire format below is ByteSec's `run --format json` stream, verified against
 * 0.7.2 rather than inferred, and its sessions against 0.7.4 (plan E's spike).
 * Everything specific to it -- the flag spellings, the event names, the stderr
 * of a refused session -- stops at this file, in the same way ACP stops at
 * `../acp`.
 */
```

In `src/driver/cli/driver.ts`, replace:

```ts
const STDERR_DRAIN_MS = 100;

/** The id the agent wrote, or undefined when it wrote none, or nothing usable. */
function readSessionId(path: string): string | undefined {
```

with:

```ts
const STDERR_DRAIN_MS = 100;

/**
 * The last line of stderr when bytesec 0.7.4 will not continue a session: an id
 * its store does not hold, or one made as another agent. Both exit 1 before the
 * turn starts, with nothing on stdout (plan E's spike). Matched only as the whole
 * last line, so a turn that merely mentions it is not taken for a refusal.
 */
const RESUME_REFUSED = /^turn \d+: (persistence: session not found|unknown agent: \S+)$/;

/** The id the agent wrote, or undefined when it wrote none, or nothing usable. */
function readSessionId(path: string): string | undefined {
```

In `src/driver/cli/driver.ts`, replace:

```ts
}


/** Resolve once the stream has ended, or once the wait stops being worth it. */
```

with:

```ts
}

/** The last non-empty line of stderr, without colour codes. */
function lastLine(stderr: string): string {
  return (
    stderr
      .replace(ANSI, '')
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line !== '') ?? ''
  );
}

/** Resolve once the stream has ended, or once the wait stops being worth it. */
```

In `src/driver/cli/driver.ts`, replace:

```ts
  /** The provider session the next turn continues, if there is one. */
  #resume: string | undefined;
  /** The last id the agent reported, or the one this runtime was started to continue. */
  #providerSessionId: string;
```

with:

```ts
  /** The provider session the next turn continues, if there is one. */
  #resume: string | undefined;
  /** Cleared once the agent answers `--session` with another session: it does not resume. */
  #native = true;
  /** The last id the agent reported, or the one this runtime was started to continue. */
  #providerSessionId: string;
```

In `src/driver/cli/driver.ts`, replace:

```ts
   * the history as a transcript (`replayed`), or neither. Nothing is spawned
   * yet, so `resumed` is an intent; each turn reports what it actually did with
   * `session-observed`.
   */
  startResult(): StartResult {
```

with:

```ts
   * the history as a transcript (`replayed`), or neither. Nothing is spawned
   * yet, so `resumed` is an intent; each turn reports what it actually did with
   * `session-observed`, a refused id included.
   */
  startResult(): StartResult {
```

In `src/driver/cli/driver.ts`, replace:

```ts
  async *#run(input: PromptInput): AsyncGenerator<DriverEvent> {
    try {
      const resume = this.#resume;
      // A resumed turn carries only the new message: the provider has the rest.
      const composed = resume === undefined ? this.#compose(input) : this.#alone(input);
```

with:

```ts
  async *#run(input: PromptInput): AsyncGenerator<DriverEvent> {
    try {
      const resume = this.#native ? this.#resume : undefined;
      // A resumed turn carries only the new message: the provider has the rest.
      const composed = resume === undefined ? this.#compose(input) : this.#alone(input);
```

In `src/driver/cli/driver.ts`, replace:

```ts
      }

      yield* this.#runTurn(input, composed, resume);
    } finally {
      this.#inflight = false;
```

with:

```ts
      }

      yield* this.#runTurn(input, composed, resume, undefined);
    } finally {
      this.#inflight = false;
```

In `src/driver/cli/driver.ts`, replace:

```ts

  /**
   * One turn, in one process.
   *
   * The id file lives in a directory of its own under the system's temporary
```

with:

```ts

  /**
   * One turn, in one process -- or two, when the agent refuses to continue the
   * session it was given: then the turn is run again with the transcript, which
   * is safe because a refused resume starts nothing (`#attempt`).
   *
   * The id file lives in a directory of its own under the system's temporary
```

In `src/driver/cli/driver.ts`, replace:

```ts
   * behind; it holds only the id, which is no secret.
   */
  async *#runTurn(input: PromptInput, composed: string, resume: string | undefined): AsyncGenerator<DriverEvent> {
    let dir: string;
    try {
```

with:

```ts
   * behind; it holds only the id, which is no secret.
   */
  async *#runTurn(
    input: PromptInput,
    composed: string,
    resume: string | undefined,
    refused: string | undefined,
  ): AsyncGenerator<DriverEvent> {
    let dir: string;
    try {
```

In `src/driver/cli/driver.ts`, replace:

```ts
      return;
    }
    try {
      yield* this.#attempt(input, composed, resume, join(dir, 'session-id'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Run the agent once, yielding the whole turn. */
  async *#attempt(
    input: PromptInput,
    composed: string,
    resume: string | undefined,
    idFile: string,
  ): AsyncGenerator<DriverEvent> {
    // Whether this attempt carries a transcript, before it adds its own exchange.
    const carried = resume === undefined && this.#history.length > 0;
```

with:

```ts
      return;
    }
    let refusal: string | undefined;
    try {
      refusal = yield* this.#attempt(input, composed, resume, refused, join(dir, 'session-id'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (refusal === undefined) return;
    // Stopped while the refused run was exiting: nothing ran, and nothing will.
    if (this.#closed) {
      yield { kind: 'turn-ended', terminal: 'cancelled', detail: 'runtime closed' };
      return;
    }
    if (this.#cancelled) {
      yield { kind: 'turn-ended', terminal: 'cancelled' };
      return;
    }
    this.#resume = undefined;
    yield* this.#runTurn(input, this.#compose(input) ?? composed, undefined, refusal);
  }

  /**
   * Run the agent once. Returns why it refused to continue `resume`, when it did
   * and yielded nothing; otherwise undefined, having yielded the whole turn.
   */
  async *#attempt(
    input: PromptInput,
    composed: string,
    resume: string | undefined,
    refused: string | undefined,
    idFile: string,
  ): AsyncGenerator<DriverEvent, string | undefined> {
    // Whether this attempt carries a transcript, before it adds its own exchange.
    const carried = resume === undefined && this.#history.length > 0;
```

In `src/driver/cli/driver.ts`, replace:

```ts
      // The provider session to continue, and where the agent says which one it
      // ran in (plan E). Written at the process's start, even for a turn that
      // then fails, and with the id asked for, whether or not it was continued.
      ...(resume === undefined ? [] : ['--session', resume]),
      '--session-id-file',
```

with:

```ts
      // The provider session to continue, and where the agent says which one it
      // ran in (plan E). Written at the process's start, even for a turn that
      // then fails, and with the id asked for even when that id is refused.
      ...(resume === undefined ? [] : ['--session', resume]),
      '--session-id-file',
```

In `src/driver/cli/driver.ts`, replace:

```ts
    let summary: TurnSummary | undefined;
    let said = false;
    /** The session the agent's first typed event says it is in. */
    let streamedId: string | undefined;
```

with:

```ts
    let summary: TurnSummary | undefined;
    let said = false;
    /** Any JSON line on stdout, recognized or not: a refused resume prints none. */
    let started = false;
    /** The session the agent's first typed event says it is in. */
    let streamedId: string | undefined;
```

In `src/driver/cli/driver.ts`, replace:

```ts
    try {
      for await (const line of lines) {
        if (line.trim().startsWith('{')) streamedId ??= typedSessionId(line.trim());
        const parsed = parseLine(line);
        if (parsed === undefined) continue;
```

with:

```ts
    try {
      for await (const line of lines) {
        if (line.trim().startsWith('{')) {
          started = true;
          streamedId ??= typedSessionId(line.trim());
        }
        const parsed = parseLine(line);
        if (parsed === undefined) continue;
```

In `src/driver/cli/driver.ts`, replace:

```ts
    const code = await exited;

    // Which session the run was in. Given --session, the agent writes back the
    // id it was given whether or not it continued that session, so only its own
    // stream is evidence; without one, the file it wrote is.
    const ranIn = resume === undefined ? readSessionId(idFile) : streamedId;
    const seen = this.#observe(ranIn, resume, carried);
    if (seen !== undefined) yield seen;
```

with:

```ts
    const code = await exited;

    // Refused before the turn started: exit 1, no JSON on stdout at all, and one
    // of the two measured refusals as stderr's last line. Nothing ran, so running
    // the turn again with the transcript cannot run anything twice. Anything else
    // -- any JSON line, another exit, other stderr, a cancel -- is the turn's own
    // outcome, never run again (G6).
    if (resume !== undefined && !started && code === 1 && !this.#cancelled && !this.#closedDuringTurn) {
      const refusal = RESUME_REFUSED.exec(lastLine(stderr));
      if (refusal !== null) return `provider session ${resume} could not be resumed (${refusal[1] ?? ''})`;
    }

    // Which session the run was in. Given --session, the agent writes back the
    // id it was given whether or not it continued that session, so only its own
    // stream is evidence; without one, the file it wrote is.
    const ranIn = resume === undefined ? readSessionId(idFile) : streamedId;
    const seen = this.#observe(ranIn, resume, refused, carried);
    if (seen !== undefined) yield seen;
```

In `src/driver/cli/driver.ts`, replace:

```ts
   *
   * Kept after a failed or cancelled turn too: the provider's session holds what
   * that turn did, which a transcript of what was said does not.
   */
  #observe(observed: string | undefined, resume: string | undefined, carried: boolean): DriverEvent | undefined {
    if (!isResumableProviderId(observed)) return undefined;
    // Another session than the one asked for is not a resumed turn; it is not reported yet.
    if (resume !== undefined && observed !== resume) return undefined;
    this.#providerSessionId = observed;
    this.#resume = observed;
    const mode: StartMode = resume !== undefined ? 'resumed' : carried ? 'replayed' : 'fresh';
    return { kind: 'session-observed', providerSessionId: observed, mode };
  }
```

with:

```ts
   *
   * Kept after a failed or cancelled turn too: the provider's session holds what
   * that turn did, which a transcript of what was said does not. An agent that
   * answers `--session` with another session did not continue the conversation
   * -- bytesec 0.7.2 did that -- so this runtime stops asking it to.
   */
  #observe(
    observed: string | undefined,
    resume: string | undefined,
    refused: string | undefined,
    carried: boolean,
  ): DriverEvent | undefined {
    if (!isResumableProviderId(observed)) return undefined;
    this.#providerSessionId = observed;
    let mode: StartMode;
    let detail: string | undefined;
    if (resume !== undefined && observed !== resume) {
      this.#native = false;
      mode = 'fresh';
      detail =
        `asked to continue provider session ${resume}, the agent ran in ${observed} instead, ` +
        'so later turns carry the conversation as a transcript';
    } else if (resume !== undefined) {
      mode = 'resumed';
    } else {
      mode = carried ? 'replayed' : 'fresh';
      if (refused !== undefined) {
        detail = `${refused}, so ${carried ? 'the conversation was replayed' : 'this turn started a new conversation'}`;
      }
    }
    if (this.#native) this.#resume = observed;
    return { kind: 'session-observed', providerSessionId: observed, mode, ...(detail === undefined ? {} : { detail }) };
  }
```


- [ ] **Step 3.4: Run them to verify they pass.** Run `npx vitest run --project e2e tests/cli-driver.e2e.ts`. Expected: `Tests  44 passed (44)`.

- [ ] **Step 3.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1333 passed (1333)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  92 passed (92)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.6: Commit.**

```bash
git add src/driver/cli/driver.ts tests/cli-driver.e2e.ts
git commit -m "Run a turn again with the transcript, in the same turn, only when the agent refuses the provider session it was asked to continue as bytesec was measured to, exiting 1 with nothing on stdout and the refusal as stderr's last line, unless the turn was stopped meanwhile; report a resumed run whose events name another session, and stop resuming that agent"
```

---

### Task 4: `/status` says which provider session the last turn ran in

**Files:**
- Modify: `src/db/events.ts`, `src/core/router.ts`, `tests/router.test.ts`

`/status` ends with a line for the latest `provider_session_observed`: the id, and whether the last turn resumed it, replayed the conversation into it or started it (Decision 11). Nothing when no turn has reported one. The id is shown only when `isResumableProviderId` accepts it, so a payload the log masked, an old `cli:` id or anything odd in it cannot break the line; it is no secret (Decision 12). The read goes by the events table's `(session_id, type, seq)` index.

- [ ] **Step 4.1: Write the failing tests.**

In `tests/router.test.ts`, replace:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACK_EMOJI, KANBAN_OFF, Router, type InboundCardAction, type KanbanCommands } from '../src/core/router.js';
import { CARD_COALESCE_MS } from '../src/channel/card-writer.js';
import { SessionRegistry } from '../src/core/registry.js';
```

with:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACK_EMOJI, KANBAN_OFF, Router, continuityLine, type InboundCardAction, type KanbanCommands } from '../src/core/router.js';
import { CARD_COALESCE_MS } from '../src/channel/card-writer.js';
import { SessionRegistry } from '../src/core/registry.js';
```

In `tests/router.test.ts`, replace:

```ts
    expect(lastReply(h)).toContain('**working**');
    expect(lastReply(h)).toContain('1 open turn(s)');
  });
```

with:

```ts
    expect(lastReply(h)).toContain('**working**');
    expect(lastReply(h)).toContain('1 open turn(s)');
  });

  it('says which provider session the last turn ran in, and how it reached it', async () => {
    const h = harness();
    h.driver.scripts = [
      (ctl) => {
        ctl.emit({ kind: 'session-observed', providerSessionId: 'ses_abc', mode: 'replayed' });
        ctl.end('completed');
      },
      (ctl) => {
        ctl.emit({ kind: 'session-observed', providerSessionId: 'ses_abc', mode: 'resumed' });
        ctl.end('completed');
      },
    ];
    await h.router.onMessage(msg({ text: 'remember pickle' }));
    await flush();
    await h.router.onMessage(msg({ text: 'what did I say?' }));
    await flush();
    await h.router.onMessage(msg({ text: '/status' }));
    // The latest turn's, not the first's.
    expect(lastReply(h)).toMatch(/\nprovider session `ses_abc`: the last turn resumed it$/);
  });

  it('says nothing of a provider session no turn has reported', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'hello' }));
    await flush();
    await h.router.onMessage(msg({ text: '/status' }));
    expect(lastReply(h)).not.toContain('provider session');
  });
```

In `tests/router.test.ts`, replace:

```ts
    value: { approvalId, optionId, nonce },
  };
}
```

with:

```ts
    value: { approvalId, optionId, nonce },
  };
}

describe('continuityLine', () => {
  it('reads each mode, and drops an id that is not one argv word', () => {
    expect(continuityLine({ providerSessionId: 'ses_1', mode: 'fresh' })).toBe('\nprovider session `ses_1`: the last turn started it');
    expect(continuityLine({ providerSessionId: 'ses_1', mode: 'replayed' })).toBe(
      '\nprovider session `ses_1`: the last turn replayed the conversation into it',
    );
    expect(continuityLine({ providerSessionId: 'ses_1', mode: 'later' })).toBe('\nprovider session `ses_1`');
    expect(continuityLine({ providerSessionId: 'a`b', mode: 'fresh' })).toBe('');
    expect(continuityLine({ providerSessionId: '-x', mode: 'fresh' })).toBe('');
    expect(continuityLine({ providerSessionId: 'cli:1a2b3c4d', mode: 'fresh' })).toBe('');
    expect(continuityLine(null)).toBe('');
  });
});
```


- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/router.test.ts`. Expected: two FAIL — `expected '**idle**: Idle and attached. Send a m…' to match /\nprovider session `ses_abc`: the las…/` and `TypeError: (0 , continuityLine) is not a function`; "says nothing of a provider session no turn has reported" passes. `Tests  2 failed | 73 passed (75)`.

- [ ] **Step 4.3: Implement.**

In `src/db/events.ts`, replace:

```ts
import type { Db } from './open.js';
import { txImmediate } from './open.js';
import type { Event, NewEvent } from '../types.js';
import { redactValues } from '../secrets.js';
```

with:

```ts
import type { Db } from './open.js';
import { txImmediate } from './open.js';
import type { Event, EventType, NewEvent } from '../types.js';
import { redactValues } from '../secrets.js';
```

In `src/db/events.ts`, replace:

```ts
}

export function lastSeq(db: Db, sessionId: string): number {
  const row = db
```

with:

```ts
}

/** A session's latest event of one type, by the index on (session, type, seq). */
export function lastEventOfType(db: Db, sessionId: string, type: EventType): Event | undefined {
  const row = db
    .prepare<[string, string], EventRowRaw>(
      `SELECT session_id, seq, ts, generation, broker_seq, turn_id, type, actor, json(payload) AS payload
         FROM events
        WHERE session_id = ? AND type = ?
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(sessionId, type);
  return row === undefined ? undefined : decode(row);
}

export function lastSeq(db: Db, sessionId: string): number {
  const row = db
```

In `src/core/router.ts`, replace:

```ts
import type { Db } from '../db/open.js';
import { appendEvent } from '../db/events.js';
import { claimMessage, recordOutcome } from '../db/dedup.js';
import { getApproval } from '../db/approvals.js';
```

with:

```ts
import type { Db } from '../db/open.js';
import { appendEvent, lastEventOfType } from '../db/events.js';
import { claimMessage, recordOutcome } from '../db/dedup.js';
import { getApproval } from '../db/approvals.js';
```

In `src/core/router.ts`, replace:

```ts
import { forDisplay, truncate } from '../channel/escape.js';
import { redactKnownSecrets } from '../secrets.js';
import { label } from '../kanban/chat-render.js';
import type {
```

with:

```ts
import { forDisplay, truncate } from '../channel/escape.js';
import { redactKnownSecrets } from '../secrets.js';
import { isResumableProviderId } from '../provider-id.js';
import { label } from '../kanban/chat-render.js';
import type {
```

In `src/core/router.ts`, replace:

```ts
          `**${view.label}**: ${forDisplay(view.detail)}\n` +
            `session \`${binding.sessionId}\` · generation ${view.generation} · ` +
            `${view.openTurns} open turn(s) · ${view.pendingApprovals} pending approval(s)`,
        );
        return;
```

with:

```ts
          `**${view.label}**: ${forDisplay(view.detail)}\n` +
            `session \`${binding.sessionId}\` · generation ${view.generation} · ` +
            `${view.openTurns} open turn(s) · ${view.pendingApprovals} pending approval(s)` +
            continuityLine(lastEventOfType(this.#deps.db, binding.sessionId, 'provider_session_observed')?.payload),
        );
        return;
```

In `src/core/router.ts`, replace:

```ts
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}
```

with:

```ts
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/** How each way a turn reached its provider session reads in `/status`. */
const CONTINUITY: Readonly<Record<string, string>> = {
  resumed: 'the last turn resumed it',
  replayed: 'the last turn replayed the conversation into it',
  fresh: 'the last turn started it',
};

/**
 * `/status`'s line for the provider session the last turn ran in, from its
 * `provider_session_observed` event; nothing when no turn has reported one. The
 * id is no secret (plan E): it names a session in the agent's own store on this
 * host, which only this host's user can read. Shown only when it is an id a
 * driver would pass back (`isResumableProviderId`), so nothing in it can break
 * the line, and an old `cli:` runtime id is not taken for a provider session.
 */
export function continuityLine(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const { providerSessionId: id, mode } = payload as { providerSessionId?: unknown; mode?: unknown };
  if (!isResumableProviderId(id)) return '';
  const how = typeof mode === 'string' ? CONTINUITY[mode] : undefined;
  return `\nprovider session \`${id}\`${how === undefined ? '' : `: ${how}`}`;
}
```


- [ ] **Step 4.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/router.test.ts`. Expected: `Tests  75 passed (75)`.

- [ ] **Step 4.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1336 passed (1336)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  92 passed (92)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.6: Commit.**

```bash
git add src/db/events.ts src/core/router.ts tests/router.test.ts
git commit -m "End /status with the provider session the last turn ran in and whether it resumed it, replayed the conversation into it or started it, from the latest provider_session_observed event"
```

---

### Task 5: On the board: nudges and reworks resume, retries start fresh, and no `cli:` seed

**Files:**
- Modify: `src/db/kanban.ts`, `tests/kanban-reports.test.ts`, `tests/kanban-worker.e2e.ts`, `tests/kanban-people.e2e.ts`

The board needs one change: `reworkSeed` takes any provider id its work run's session holds for one to resume, so a `cli:` id an older build stored gave a rework a `seeded_from_run` for a conversation nothing could continue. It now seeds only from an id `isResumableProviderId` accepts (Decision 10). The rest is proved end to end, with the fake agent keeping sessions in both stacks (Decision 9): a nudge continues the run's provider session and is sent alone, with no transcript; a retry after a crash is a new run whose session starts a new provider session, with no seed; a rework after a person's changes resumes the implementer's provider session, its run recording `seeded_from_run`, its prompt still carrying the reviewer's reason in full. The nudge test's transcript assertion changes, since the second turn now carries none. The end-to-end tests pass as soon as they are written: that behaviour is Tasks 1 to 3's.

- [ ] **Step 5.1: Write the tests.**

In `tests/kanban-reports.test.ts`, replace:

```ts
  });

  it('refuses changes from a work run', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
```

with:

```ts
  });

  it('does not seed a rework from an id the CLI driver stored before it could resume', () => {
    // A `cli:` id names the work run's runtime, not a provider session (plan E).
    expect(reviewed(AGENT, 'cli:1a2b3c4d').rework.seededFromRun).toBeNull();
  });

  it('refuses changes from a work run', () => {
    const task = newTask(h.db, { reviewer: REVIEWER });
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
import type { Driver } from '../src/driver/types.js';
import { eventsOf, getTask, runsOf } from '../src/db/kanban-read.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { KanbanService } from '../src/kanban/service.js';
```

with:

```ts
import type { Driver } from '../src/driver/types.js';
import { eventsOf, getTask, runsOf } from '../src/db/kanban-read.js';
import { getSession } from '../src/db/sessions.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { KanbanService } from '../src/kanban/service.js';
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
  dir: string;
  workspace: string;
  invocations(): Array<{ prompt: string; run: string | null }>;
  /** The environment the agent ran with, as it wrote it down. */
  runEnv(): Record<string, string>;
```

with:

```ts
  dir: string;
  workspace: string;
  invocations(): Array<{ prompt: string; run: string | null; session: string | null }>;
  /** The environment the agent ran with, as it wrote it down. */
  runEnv(): Record<string, string>;
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
  });
  const drivers = new Map<string, Driver>([
    ['implementer', createCliDriver({ command: process.execPath, args: [AGENT], env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: log } })],
  ]);
  let dispatcher: Dispatcher | undefined;
```

with:

```ts
  });
  const drivers = new Map<string, Driver>([
    [
      'implementer',
      createCliDriver({
        command: process.execPath,
        args: [AGENT],
        // The fake keeps its sessions as bytesec does, so a run's turns resume (plan E).
        env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: log, FAKE_CLI_SESSIONS: join(dir, 'sessions') },
      }),
    ],
  ]);
  let dispatcher: Dispatcher | undefined;
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { prompt: string; run: string | null }),
    runEnv: () => JSON.parse(readFileSync(join(dir, 'kanban-env.json'), 'utf8')) as Record<string, string>,
  };
```

with:

```ts
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { prompt: string; run: string | null; session: string | null }),
    runEnv: () => JSON.parse(readFileSync(join(dir, 'kanban-env.json'), 'utf8')) as Record<string, string>,
  };
```

In `tests/kanban-worker.e2e.ts`, replace:

```ts
    expect(first?.run).toBe(run?.runId);
    expect(second?.run).toBe(run?.runId);
    // The CLI driver carries the first turn into the second as a transcript, then the nudge.
    expect(second?.prompt).toContain('Next I will report.');
    expect(second?.prompt).toContain('You ended your turn without reporting, so your run is not over (reminder 1 of 2).');
  });
});
```

with:

```ts
    expect(first?.run).toBe(run?.runId);
    expect(second?.run).toBe(run?.runId);
    // The nudge continues the run's provider session, and is sent alone: no transcript (plan E).
    const provider = getSession(s.t.db, run?.sessionId ?? '')?.providerSessionId;
    expect(provider).toMatch(/^ses_fake_/);
    expect(first?.session).toBeNull();
    expect(second?.session).toBe(provider);
    expect(second?.prompt).toMatch(/^You ended your turn without reporting, so your run is not over \(reminder 1 of 2\)\./);
    expect(second?.prompt).not.toContain('Next I will report.');
  });

  it('a retry after a crash starts a new provider session, not the crashed one', async () => {
    const s = await build('crash');
    const taskId = create(s, 'Flaky job');

    s.dispatcher.pass();
    await s.dispatcher.idle();

    // Retries start fresh (spec §8.3): a new run, a new session, and nothing resumed.
    const runs = runsOf(s.t.db, taskId);
    expect(runs.map((r) => r.outcome)).toEqual(['crashed', 'crashed']);
    expect(runs.map((r) => r.seededFromRun)).toEqual([null, null]);
    expect(s.invocations().map((i) => i.session)).toEqual([null, null]);
    const providers = runs.map((r) => getSession(s.t.db, r.sessionId ?? '')?.providerSessionId);
    expect(providers[0]).toMatch(/^ses_fake_/);
    expect(providers[1]).toMatch(/^ses_fake_/);
    expect(providers[1]).not.toBe(providers[0]);
  });
});
```

In `tests/kanban-people.e2e.ts`, replace:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

with:

```ts
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

In `tests/kanban-people.e2e.ts`, replace:

```ts
import { getApproval } from '../src/db/approvals.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
```

with:

```ts
import { getApproval } from '../src/db/approvals.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { getSession } from '../src/db/sessions.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
```

In `tests/kanban-people.e2e.ts`, replace:

```ts
        command: process.execPath,
        args: [AGENT],
        env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: join(dir, 'invocations.log') },
      }),
    ],
```

with:

```ts
        command: process.execPath,
        args: [AGENT],
        // The fake keeps its sessions as bytesec does, so a rework resumes (plan E).
        env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: join(dir, 'invocations.log'), FAKE_CLI_SESSIONS: join(dir, 'sessions') },
      }),
    ],
```

In `tests/kanban-people.e2e.ts`, replace:

```ts
    ]);

    // The second review's card; the first one is out of date now.
    expect(await s.cards().deliver()).toBe(1);
```

with:

```ts
    ]);

    // The rework continued the implementer's provider session, under the like-for-like
    // rule (spec §5.3): same agent, both given their role in the prompt.
    const [work, , rework] = runsOf(s.t.db, taskId);
    expect(rework?.seededFromRun).toBe(work?.runId);
    const provider = getSession(s.t.db, work?.sessionId ?? '')?.providerSessionId;
    expect(provider).toMatch(/^ses_fake_/);
    const invocations = readFileSync(join(s.dir, 'invocations.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { run: string | null; session: string | null; prompt: string });
    expect(invocations.map((i) => [i.run, i.session])).toEqual([
      [work?.runId, null],
      [rework?.runId, provider],
    ]);
    // Its prompt still carries the reviewer's reason in full, for an agent that cannot resume.
    expect(invocations[1]?.prompt).toContain('cite the sources');
    // The provider session the rework ran in is the implementer's own.
    expect(getSession(s.t.db, rework?.sessionId ?? '')?.providerSessionId).toBe(provider);

    // The second review's card; the first one is out of date now.
    expect(await s.cards().deliver()).toBe(1);
```


- [ ] **Step 5.2: Run them.** Run `npx vitest run --project unit tests/kanban-reports.test.ts`. Expected: the new test FAILS with `expected 'r_…' to be null`. `Tests  1 failed | 21 passed (22)`. Run `npx vitest run --project e2e tests/kanban-worker.e2e.ts tests/kanban-people.e2e.ts`. Expected: `Tests  7 passed (7)`. To see that they test something, remove `FAKE_CLI_SESSIONS` from `kanban-worker.e2e.ts`'s driver and run it again: the nudge and retry tests fail, with `.toMatch() expects to receive a string, but got object`: no provider session was stored. Put it back.

- [ ] **Step 5.3: Implement.**

In `src/db/kanban.ts`, replace:

```ts
import { txImmediate } from './open.js';
import { newRunId, newTaskId } from '../core/ids.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import type { GateRun } from '../kanban/gates.js';
```

with:

```ts
import { txImmediate } from './open.js';
import { newRunId, newTaskId } from '../core/ids.js';
import { isResumableProviderId } from '../provider-id.js';
import { redactKnownSecrets, redactValues } from '../secrets.js';
import type { GateRun } from '../kanban/gates.js';
```

In `src/db/kanban.ts`, replace:

```ts
    .prepare<[string], { provider_session_id: string | null }>('SELECT provider_session_id FROM sessions WHERE id = ?')
    .get(work.sessionId);
  return seen?.provider_session_id ? work.runId : null;
}
```

with:

```ts
    .prepare<[string], { provider_session_id: string | null }>('SELECT provider_session_id FROM sessions WHERE id = ?')
    .get(work.sessionId);
  // A `cli:` id names a runtime, not a provider session: nothing to resume.
  return isResumableProviderId(seen?.provider_session_id) ? work.runId : null;
}
```


- [ ] **Step 5.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/kanban-reports.test.ts`. Expected: `Tests  22 passed (22)`.

- [ ] **Step 5.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1337 passed (1337)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  93 passed (93)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.6: Commit.**

```bash
git add src/db/kanban.ts tests/kanban-reports.test.ts tests/kanban-worker.e2e.ts tests/kanban-people.e2e.ts
git commit -m "Seed a rework only from a provider session id an agent could resume, not from an old cli: runtime id, and show end to end that a nudge continues its run's provider session with the reminder alone, that a retry after a crash starts a new one, and that a rework resumes the implementer's"
```

---

### Task 6: `mt role check` warns of a bytesec that cannot resume

**Files:**
- Modify: `src/driver/cli/driver.ts`, `src/cli/mt.ts`, `src/cli/role.ts`, `tests/helpers/mt.ts`, `tests/mt-role.test.ts`, `tests/cli-driver.e2e.ts`

Native resume needs bytesec 0.7.4 (`RESUME_MIN_VERSION`, Decision 13). `mt role check` asks each role whose structured-CLI command is bytesec for `<command> --version`, once a command, and prints a warning for one below 0.7.4, or a note when no version can be read; neither changes its exit code, since such a role still works, by replaying. The probe is `MtIo.agentVersion`, which the test fixture always sets — to `0.7.4` unless a test says otherwise — so no test runs bytesec; the real one, `readAgentVersion`, is tested end to end against `node --version`.

- [ ] **Step 6.1: Write the failing tests.**

In `tests/helpers/mt.ts`, replace:

```ts
  run(
    argv: string[],
    opts?: { env?: Record<string, string | undefined>; git?: Git },
  ): Promise<{ code: number; out: string; err: string }>;
  cleanup(): void;
```

with:

```ts
  run(
    argv: string[],
    opts?: { env?: Record<string, string | undefined>; git?: Git; agentVersion?: (command: string) => string | undefined },
  ): Promise<{ code: number; out: string; err: string }>;
  cleanup(): void;
```

In `tests/helpers/mt.ts`, replace:

```ts
        err: (line) => err.push(line),
        ...(opts.git === undefined ? {} : { git: opts.git }),
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
```

with:

```ts
        err: (line) => err.push(line),
        ...(opts.git === undefined ? {} : { git: opts.git }),
        // Never the real agent: no test runs bytesec.
        agentVersion: opts.agentVersion ?? (() => '0.7.4'),
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
```

In `tests/mt-role.test.ts`, replace:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadTeamSettings } from '../src/config.js';
import { loadRoleDir } from '../src/roles.js';
```

with:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { versionBelow } from '../src/cli/role.js';
import { loadTeamSettings } from '../src/config.js';
import { loadRoleDir } from '../src/roles.js';
```

In `tests/mt-role.test.ts`, replace:

```ts
  });

  it('says nothing about rendering when the check fails', async () => {
    fx = mtFixture();
```

with:

```ts
  });

  it('warns of a bytesec role whose bytesec cannot resume a session, asking each command once', async () => {
    fx = mtFixture();
    roleDir('implementer', 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
    const asked: string[] = [];
    const r = await fx.run(['role', 'check'], { agentVersion: (command) => (asked.push(command), '0.7.2') });
    // A warning, not a failure: the role still works, replaying its conversation.
    expect(r.code).toBe(0);
    expect(asked).toEqual(['bytesec']);
    expect(r.out.split('\n').filter((l) => l.startsWith('warning: '))).toEqual([
      'warning: role default runs bytesec 0.7.2, which cannot resume a session, so its sessions replay their conversation instead; native resume needs 0.7.4 or later',
      'warning: role implementer runs bytesec 0.7.2, which cannot resume a session, so its sessions replay their conversation instead; native resume needs 0.7.4 or later',
    ]);
  });

  it('notes a bytesec whose version cannot be read, and asks no other agent', async () => {
    fx = mtFixture();
    roleDir('reviewer', ACP_AGENT);
    const asked: string[] = [];
    const r = await fx.run(['role', 'check'], { agentVersion: (command) => (asked.push(command), undefined) });
    expect(r.code).toBe(0);
    expect(asked).toEqual(['bytesec']);
    expect(r.out).toMatch(/^note: role default: bytesec --version gave no version; native resume needs bytesec 0\.7\.4 or later$/m);
  });

  it('says nothing of a bytesec that resumes, comparing versions part by part', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'check'], { agentVersion: () => '0.10.0' });
    expect(r.out).not.toMatch(/resume/);
    expect([versionBelow('0.7.2', '0.7.4'), versionBelow('0.7.4', '0.7.4'), versionBelow('0.10.0', '0.7.4'), versionBelow('1.0', '0.7.4')]).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it('says nothing about rendering when the check fails', async () => {
    fx = mtFixture();
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliDriver, resolveExecutable } from '../src/driver/cli/driver.js';
import type { AgentRuntime, DriverEvent, PromptInput, StartResult } from '../src/driver/types.js';
```

with:

```ts
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAgentVersion } from '../src/cli/role.js';
import { createCliDriver, resolveExecutable } from '../src/driver/cli/driver.js';
import type { AgentRuntime, DriverEvent, PromptInput, StartResult } from '../src/driver/types.js';
```

In `tests/cli-driver.e2e.ts`, replace:

```ts
    // quarantines a session.
    await expect(driver.start({ cwd: tmpdir() })).rejects.toThrow(/not an executable file/);
  });
```

with:

```ts
    // quarantines a session.
    await expect(driver.start({ cwd: tmpdir() })).rejects.toThrow(/not an executable file/);
  });

  it("reads an agent's version from its --version, and nothing from a command that cannot run", () => {
    // `mt role check` asks bytesec this way (plan E); node answers `v22.…`.
    expect(readAgentVersion(process.execPath, process.env)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readAgentVersion('/nonexistent/agent-binary', process.env)).toBeUndefined();
  });
```


- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-role.test.ts`. Expected: three FAIL — `expected [] to deeply equal [ 'bytesec' ]` twice and `TypeError: (0 , versionBelow) is not a function`. `Tests  3 failed | 37 passed (40)`. Run `npx vitest run --project e2e tests/cli-driver.e2e.ts`. Expected: one FAILS, `TypeError: (0 , readAgentVersion) is not a function`. `Tests  1 failed | 44 passed (45)`.

- [ ] **Step 6.3: Implement.**

In `src/driver/cli/driver.ts`, replace:

```ts
/** How long a finished turn waits for the tail of stderr. See `drain`. */
const STDERR_DRAIN_MS = 100;

/**
```

with:

```ts
/** How long a finished turn waits for the tail of stderr. See `drain`. */
const STDERR_DRAIN_MS = 100;

/** The oldest bytesec whose `--session` continues a conversation (architecture §6.3). */
export const RESUME_MIN_VERSION = '0.7.4';

/**
```

In `src/cli/mt.ts`, replace:

```ts
  /** Stdin is a terminal: `mt kanban` refuses rather than wait on one for input that never comes. */
  stdinIsTTY?: boolean;
}
```

with:

```ts
  /** Stdin is a terminal: `mt kanban` refuses rather than wait on one for input that never comes. */
  stdinIsTTY?: boolean;
  /** An agent command's version, from `<command> --version`; injectable so `mt role check` is tested without one. */
  agentVersion?: (command: string) => string | undefined;
}
```

In `src/cli/role.ts`, replace:

```ts
import {
  chmodSync,
```

with:

```ts
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
```

In `src/cli/role.ts`, replace:

```ts
} from '../config.js';
import { movedMessage, registrationsAt } from '../db/workspaces.js';
import { isReservedRoleName, nameProblem } from '../names.js';
import { nativeFor } from '../render/native.js';
```

with:

```ts
} from '../config.js';
import { movedMessage, registrationsAt } from '../db/workspaces.js';
import { RESUME_MIN_VERSION } from '../driver/cli/driver.js';
import { isReservedRoleName, nameProblem } from '../names.js';
import { nativeFor } from '../render/native.js';
```

In `src/cli/role.ts`, replace:

```ts
    );
  }
  for (const note of real.notes) io.out(`note: ${note}`);
  io.out("note: the environment was checked in this shell; the service's environment may differ");
  return files.length + environment.length === 0 ? 0 : 1;
}
```

with:

```ts
    );
  }
  resumeVersions(real.roles ?? [], io);
  for (const note of real.notes) io.out(`note: ${note}`);
  io.out("note: the environment was checked in this shell; the service's environment may differ");
  return files.length + environment.length === 0 ? 0 : 1;
}

/**
 * A line for each bytesec role whose bytesec cannot resume a session, or whose
 * version cannot be read: native resume needs `RESUME_MIN_VERSION` (plan E). A
 * warning, not a failure -- such a role still works, replaying its conversation
 * as a transcript. Each command is asked once.
 */
function resumeVersions(roles: readonly Role[], io: MtIo): void {
  const ask = io.agentVersion ?? ((command: string) => readAgentVersion(command, io.env));
  const versions = new Map<string, string | undefined>();
  for (const role of roles) {
    const { driver, command } = role.agent;
    if (driver !== 'structured-cli' || basename(command) !== 'bytesec') continue;
    if (!versions.has(command)) versions.set(command, ask(command));
    const version = versions.get(command);
    if (version === undefined) {
      io.out(`note: role ${role.name}: ${command} --version gave no version; native resume needs bytesec ${RESUME_MIN_VERSION} or later`);
    } else if (versionBelow(version, RESUME_MIN_VERSION)) {
      io.out(
        `warning: role ${role.name} runs bytesec ${version}, which cannot resume a session, so its sessions ` +
          `replay their conversation instead; native resume needs ${RESUME_MIN_VERSION} or later`,
      );
    }
  }
}

/** The first `x.y.z` that `<command> --version` prints, or undefined when it cannot be run or prints none. */
export function readAgentVersion(command: string, env: Env): string | undefined {
  const r = spawnSync(command, ['--version'], { encoding: 'utf8', env, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error !== undefined || r.status !== 0) return undefined;
  return /\d+\.\d+\.\d+/.exec(r.stdout)?.[0];
}

/** Whether `x.y.z` is older than `min`, comparing each part as a number. */
export function versionBelow(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
```


- [ ] **Step 6.4: Run them to verify they pass.** Run `npx vitest run --project unit tests/mt-role.test.ts`. Expected: `Tests  40 passed (40)`. Run `npx vitest run --project e2e tests/cli-driver.e2e.ts`. Expected: `Tests  45 passed (45)`.

- [ ] **Step 6.5: Run every suite.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  1340 passed (1340)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  94 passed (94)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.6: Commit.**

```bash
git add src/driver/cli/driver.ts src/cli/mt.ts src/cli/role.ts tests/helpers/mt.ts tests/mt-role.test.ts tests/cli-driver.e2e.ts
git commit -m "Have mt role check ask each bytesec role's command for its version, once a command, and warn of one below 0.7.4, whose sessions replay their conversation instead of resuming, or note one whose version it cannot read"
```

---

### Task 7: The README, the architecture and the spec, as built

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/specs/2026-11-02-kanban-design.md`

The README's account of the CLI driver says it cannot resume; the architecture's §6.3 says "as built — no resume", §6.1 puts every degrade inside `start`, and §3.2 lists no `provider_session_observed`; the spec's E row has no "as built". Each is brought up to date, with the minimum bytesec version. (The spike's measurements went into §6.3 with this plan.)

- [ ] **Step 7.1: Edit.**

In `README.md`, replace:

```markdown
  use. That is a security posture, not a rough edge, which is why `agent.unsupervised`
  has to be written down before this driver will load.
- **No resume.** Each turn is a fresh process with a fresh agent session, and the ids
  it mints cannot be handed back. Continuity is reconstructed by composing the
  conversation into the prompt as a fenced transcript, so the agent recovers what was
  *said* but not the tool state behind it — and pays input tokens for it every turn.
  Sessions started this way report `replayed`, never `resumed`.
- **No cooperative cancel.** Cancelling kills the process, so work already done stands.

Everything specific to a protocol stops at its driver. Adding the second one required
no change to `src/driver/types.ts`, which is the return on declaring that seam while
there was only one implementation behind it.

## References
```

with:

```markdown
  use. That is a security posture, not a rough edge, which is why `agent.unsupervised`
  has to be written down before this driver will load.
- **Resume per process,** on bytesec 0.7.4 or later; `mt role check` warns of a bytesec
  role below it, whose sessions replay instead. Each turn is a fresh process. The
  driver reads the agent's own session id from `--session-id-file` and passes it back
  as `--session` on the next turn, which then sends only the new message; the id is stored, so a session
  resumes after a restart too, and `/status` shows it and how the last turn reached it.
  When the agent refuses the id, the turn is run again with the conversation composed
  into the prompt as a fenced transcript, so the agent recovers what was *said* but not
  the tool state behind it, and the session's log says it was `replayed`. The id names
  a session in the agent's own store on this host; it is not a secret, and the gateway
  never deletes those sessions.
- **No cooperative cancel.** Cancelling kills the process, so work already done stands.

Everything specific to a protocol stops at its driver. Adding the second one required
no change to `src/driver/types.ts`, which is the return on declaring that seam while
there was only one implementation behind it; resuming it natively added one event,
`session-observed`, for an id a driver learns only from a turn.

## References
```

In `docs/architecture.md`, replace:

````markdown
session_state_changed
generation_bumped          a new runtime incarnation
agent_error
```
````

with:

````markdown
session_state_changed
generation_bumped          a new runtime incarnation
provider_session_observed  { providerSessionId, mode, detail? } -- the provider session a turn ran in
agent_error
```
````

In `docs/architecture.md`, replace:

```markdown
(start_requested, started, attached, detached, exited, lost, start_failed): those are the
two-phase start of §8, and without them a crash between spawn and record is exactly the invisible
orphan §8.1 describes. `generation_bumped` is the only runtime-lifecycle event that exists. There
is likewise no `provider.session_observed` — §6.3 still says the provider session id is observed
continuously; the actor writes `sessions.provider_session_id` only from what a driver's `start`
reports, which for the CLI driver is a `cli:` id naming the runtime, not the provider's session. No `workspace.checkpoint`
(milestone 9), no `file.changed`, no `terminal.output`, no `approval.parked` or
`approval.auto_resolved` (parking and the policy engine of §10 are schema-only).
```

with:

```markdown
(start_requested, started, attached, detached, exited, lost, start_failed): those are the
two-phase start of §8, and without them a crash between spawn and record is exactly the invisible
orphan §8.1 describes. `generation_bumped` is the only runtime-lifecycle event that exists.
`provider_session_observed` is the `provider.session_observed` of §6.3, as plan E built it: the
CLI driver reports, on every turn, the provider session id the agent wrote and whether the turn
`resumed` it, `replayed` the conversation into it, or started it `fresh`, and the actor stores the
id in `sessions.provider_session_id` and logs the event. There is no `workspace.checkpoint`
(milestone 9), no `file.changed`, no `terminal.output`, no `approval.parked` or
`approval.auto_resolved` (parking and the policy engine of §10 are schema-only).
```

In `docs/architecture.md`, replace:

```markdown
   happened. The caller almost never wants to choose — it wants the session usable and wants to
   know what it got, because "resumed" and "replayed" differ in what the agent remembers. The
   automatic `native → replay` degrade of §6.5 lives inside `start`.
3. **Streaming is per-turn, not a session-wide `events()`.** `prompt` returns an
   `AsyncIterable<DriverEvent>` that ends at `turn-ended` or a terminal `error`. A single global
```

with:

```markdown
   happened. The caller almost never wants to choose — it wants the session usable and wants to
   know what it got, because "resumed" and "replayed" differ in what the agent remembers. The
   automatic `native → replay` degrade of §6.5 lives inside `start` — for the ACP driver. The
   CLI driver starts no process until a turn, so it learns that an id is refused only then: its
   degrade lives inside that turn, and every turn reports what it did as a `session-observed`
   event (§6.3).
3. **Streaming is per-turn, not a session-wide `events()`.** `prompt` returns an
   `AsyncIterable<DriverEvent>` that ends at `turn-ended` or a terminal `error`. A single global
```

In `docs/architecture.md`, replace:

```markdown
rate limit, not the agent.

**One process per turn, and — as built — no resume.** The driver spawns per turn and re-sends the
prior conversation as a fenced transcript in the prompt, so the agent recovers what was *said*, not
the tool state behind it, and after a gateway restart only the prompts are replayed.

**Correction (2026-11-02): resume now works.** On bytesec 0.7.2, `--session <id>` was measured and
```

with:

```markdown
rate limit, not the agent.

**One process per turn, resumed natively** (plan E, `docs/plans/2026-11-05-plan-e-native-resume.md`),
on **bytesec 0.7.4 or later**, which `mt role check` warns of for a bytesec role below it. The driver
spawns per turn with `--session-id-file` in a directory of its own under the system's temporary
directory — never the workspace — reads the id after the process exits, and reports it as a
`session-observed` driver event, which the actor stores as `sessions.provider_session_id` and logs
as `provider_session_observed`. The next turn passes it back as `--session` and sends only the new
message. For a run given `--session`, the id file is not evidence — it echoes what was sent — so the
session it ran in is taken from the `session_id` of its first typed event on stdout, and a run that
printed none reports nothing: "never persist the value you sent" holds. A new runtime — after a restart, an idle eviction, or for a rework seeded from another
session — starts from the stored id, so `start` reports `resumed` for it; a `cli:` id, which this
driver stored before it could resume, is never passed back. The id is kept after a failed or
cancelled turn too: the provider's session holds what that turn did. When the agent refuses the id
before the turn starts — exit 1, no JSON line on stdout, and `turn N: persistence: session not
found` or `turn N: unknown agent: <name>` as the whole last line of stderr — the same turn is run again without `--session`, with the conversation as a fenced
transcript, and reported `replayed`, with the reason — `resume: native → replay`, automatically,
and safe because the refused run started nothing. An agent that answers `--session` with another
session — its events name another — did not continue the conversation, as 0.7.2 did: that turn is
reported `fresh`, with the reason, and the runtime replays from then on. `/status` shows the provider session the last turn
ran in, and how it reached it.

**Correction (2026-11-02): resume now works.** On bytesec 0.7.2, `--session <id>` was measured and
```

In `docs/architecture.md`, replace:

````markdown
```

Also handle: the interactive resume dialog (`Would you like to resume? 1. Yes / 2. No`) which blocks unattended runs with no error and no exit code — needs a **startup-stall detector**, not just a turn timeout. And project-scoped session lookup means the workspace path is part of session identity: **record it, never relocate it.**

### 6.4 PTY driver — fallback only, actively being deleted
````

with:

````markdown
```

Also handle: the interactive resume dialog (`Would you like to resume? 1. Yes / 2. No`) which blocks unattended runs with no error and no exit code — needs a **startup-stall detector**, not just a turn timeout. And project-scoped session lookup means the workspace path is part of session identity: **record it, never relocate it.** bytesec's store is not project-scoped (above), but the rule stands: a session is always given its own workspace.

### 6.4 PTY driver — fallback only, actively being deleted
````

In `docs/specs/2026-11-02-kanban-design.md`, replace:

```markdown
| **D1. The board in chat** | every `/kanban` command a role's task needs (§9.1), through `KanbanService` only, with the tiers of §9.1, never refused for a busy chat session; people still refused, and the person-only commands answered as arriving in a later update; only an operator's chat comment steering an agent (`kanban_comments.steers`, migration `004`, §7.5); rendering escaped and masked, gate commands included (§9.3, §7.7); subscriptions and their notices, batched per conversation, delivered from the cursors and caught up after a restart, a conversation that cannot be reached let go of (§9.4); `kanban.block_recurrence_limit` (§5.4); `/kanban` answering that the board is off when `kanban.enabled` is unset | C4 |
| **D2. People** | people as assignees and reviewers: direct-message cards with Done, Block, Approve and Request changes; the person send target by union_id; card `kind` routing; the group one-line notice; `/kanban done`, `block` and `review` by a human assignee, `approve` and `changes` by a person reviewer; approval forwarding for supervised roles; an operator's `approve` and `changes` from chat; the named assignee's and reviewer's comments steering; refusing a person's report while another task's agent run is open in the workspace (`workspace_busy`, §7.7); the mentioned users' ids carried on an inbound message. As built (`docs/plans/2026-11-05-plan-d2-kanban-people.md`), also: the `people` table (migration `005`) that checks a person named by principal for talk tier (§4.2); cards delivered from the board, `card_sent` and `card_failed` (§9.2); and the uuid passed to Lark for every message sent as one (§9.4) | D1 |
| **E. Native resume** | the CLI driver captures the provider session id and passes `--session` (architecture §6.3), with transcript replay as the fallback | B; independent of C and D |
| **R. Native rendering** | the spike, done on bytesec 0.7.4: `BYTESEC_LOCAL_APM_PATH=<one package dir>` with `bytesec run --agent <name>` loads that package's agent, whose body becomes the system prompt, and its skills; a directory of packages fails silently; a package's agent may use only the package's skills. Then (§2.7): the role grammar tightened so a name cannot end in `-`; `agent.native`; `agent.skills`, imported from where bytesec finds a user's skills, since a native agent sees only its package's; `StartOptions.args` and the registry's `argsFor`; a renderer interface with bytesec's renderer; content-addressed, atomic packages under `$MT_HOME/rendered`, swept; the dispatcher rendering just after the claim, recording on the run whether it is native and by which package, and falling back to prompt injection when a render fails; the prompt leaving `role.md` and the skills out of a native run; `mt role check` saying which roles run natively. Claude Code's renderer is later. Prompt injection (§7.1) stays the fallback | B2, C2 |
| **F. Masking** | the registry and `redactKnownSecrets` (§10.1); masking inside the escapers (layer 1); trailing-prefix withholding in `renderCard`; masking session `events` and `approvals.payload` on write (layer 3). The kanban parts land in C1 (layer 3), C2 (layer 2) and C3 (worker tokens) | B (the resolved agent environments); best done before C, since it protects chat sessions too |
```

with:

```markdown
| **D1. The board in chat** | every `/kanban` command a role's task needs (§9.1), through `KanbanService` only, with the tiers of §9.1, never refused for a busy chat session; people still refused, and the person-only commands answered as arriving in a later update; only an operator's chat comment steering an agent (`kanban_comments.steers`, migration `004`, §7.5); rendering escaped and masked, gate commands included (§9.3, §7.7); subscriptions and their notices, batched per conversation, delivered from the cursors and caught up after a restart, a conversation that cannot be reached let go of (§9.4); `kanban.block_recurrence_limit` (§5.4); `/kanban` answering that the board is off when `kanban.enabled` is unset | C4 |
| **D2. People** | people as assignees and reviewers: direct-message cards with Done, Block, Approve and Request changes; the person send target by union_id; card `kind` routing; the group one-line notice; `/kanban done`, `block` and `review` by a human assignee, `approve` and `changes` by a person reviewer; approval forwarding for supervised roles; an operator's `approve` and `changes` from chat; the named assignee's and reviewer's comments steering; refusing a person's report while another task's agent run is open in the workspace (`workspace_busy`, §7.7); the mentioned users' ids carried on an inbound message. As built (`docs/plans/2026-11-05-plan-d2-kanban-people.md`), also: the `people` table (migration `005`) that checks a person named by principal for talk tier (§4.2); cards delivered from the board, `card_sent` and `card_failed` (§9.2); and the uuid passed to Lark for every message sent as one (§9.4) | D1 |
| **E. Native resume** | the CLI driver captures the provider session id and passes `--session` (architecture §6.3), with transcript replay as the fallback. As built (`docs/plans/2026-11-05-plan-e-native-resume.md`), on bytesec 0.7.4 or later, which `mt role check` warns of: the id read from `--session-id-file` after each turn — for a resumed run, from its events' `session_id`, since the file echoes the id sent — and reported as a `session-observed` driver event, stored as the observed `provider_session_id` and logged as `provider_session_observed`; a resumed turn sends only the new message; a refused id — exit 1, nothing on stdout, and `persistence: session not found` or `unknown agent:` as stderr's last line — runs the same turn again with the transcript, automatically; a `cli:` id from before never seeds a rework; nudges and a seeded rework resume with no change to the board; `/status` shows the provider session and how the last turn reached it | B; independent of C and D |
| **R. Native rendering** | the spike, done on bytesec 0.7.4: `BYTESEC_LOCAL_APM_PATH=<one package dir>` with `bytesec run --agent <name>` loads that package's agent, whose body becomes the system prompt, and its skills; a directory of packages fails silently; a package's agent may use only the package's skills. Then (§2.7): the role grammar tightened so a name cannot end in `-`; `agent.native`; `agent.skills`, imported from where bytesec finds a user's skills, since a native agent sees only its package's; `StartOptions.args` and the registry's `argsFor`; a renderer interface with bytesec's renderer; content-addressed, atomic packages under `$MT_HOME/rendered`, swept; the dispatcher rendering just after the claim, recording on the run whether it is native and by which package, and falling back to prompt injection when a render fails; the prompt leaving `role.md` and the skills out of a native run; `mt role check` saying which roles run natively. Claude Code's renderer is later. Prompt injection (§7.1) stays the fallback | B2, C2 |
| **F. Masking** | the registry and `redactKnownSecrets` (§10.1); masking inside the escapers (layer 1); trailing-prefix withholding in `renderCard`; masking session `events` and `approvals.payload` on write (layer 3). The kanban parts land in C1 (layer 3), C2 (layer 2) and C3 (worker tokens) | B (the resolved agent environments); best done before C, since it protects chat sessions too |
```


- [ ] **Step 7.2: Check.** Run `git grep -n -i "p[g]w" -- . ':!package-lock.json'`. Expected: no output. Run `git grep -n "as built — no resume" -- README.md docs/architecture.md docs/specs`. Expected: no output. Run `npm test 2>&1 | tail -4`. Expected: `Tests  1340 passed (1340)`. Run `npm run test:e2e 2>&1 | tail -4`. Expected: `Tests  94 passed (94)`. Then run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.3: Commit.**

```bash
git add README.md docs/architecture.md docs/specs/2026-11-02-kanban-design.md
git commit -m "Document native resume as built, on bytesec 0.7.4 or later: the CLI driver continuing the agent's own session with --session, the session a resumed run ran in read from its events, the measured refusals replayed in the same turn, provider_session_observed in the log, and the provider session in /status"
```

---

## Done when

- `npm test` gives `Tests  1340 passed (1340)`. `npm run test:e2e` gives `Tests  94 passed (94)`. `npm run typecheck` reports no errors. All of these run under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- A CLI turn reports the provider session it ran in — from the id file for a new session, from its events for a resumed one — which the session stores and logs; the next turn passes it back with `--session` and the message alone; a session started with a stored id resumes from its first turn, and a `cli:` id is never passed back, never seeds a rework and never shows in `/status` (`tests/cli-driver.e2e.ts`, `tests/session-actor.test.ts`, `tests/kanban-reports.test.ts`, `tests/router.test.ts`).
- Only a measured refusal — exit 1, nothing on stdout, the refusal as stderr's last line — runs the same turn again with the transcript, once, reported `replayed` with the reason, and not once the turn is cancelled; a resumed run whose events name another session is replayed from then on; a resumed turn that fails after starting is never run again (`tests/cli-driver.e2e.ts`).
- The id file is never in the workspace, and is gone after the turn; a directory that cannot be made fails the turn before anything starts (`tests/cli-driver.e2e.ts`).
- `/status` shows the provider session the last turn ran in and how it reached it, and nothing when none was reported (`tests/router.test.ts`).
- On the board, a nudge resumes its run's provider session, a rework resumes the implementer's, and a retry starts a new one (`tests/kanban-worker.e2e.ts`, `tests/kanban-people.e2e.ts`).
- `mt role check` warns of a bytesec role below 0.7.4 (`tests/mt-role.test.ts`).

## Before turning it on: a smoke test against the live gateway

For the user, once the plan is built and deployed; no test runs bytesec. Use a cheap model.

0. `bytesec --version` prints 0.7.4 or later, and `mt role check` prints no `warning:` about resume.
1. In a chat, send "Remember the word PELICAN. Reply OK.", then `/status`: it ends with `provider session \`ses_…\`: the last turn started it`.
2. Send "What word did I ask you to remember?" It answers PELICAN, and `/status` says the last turn resumed it, with the same id.
3. `/new`, then send anything, then `/status`: a different provider id, and "the last turn started it".
4. If convenient, with the board on: a task whose agent stops once without reporting is nudged, and its run's session log has a `provider_session_observed` for the nudge's turn with `"mode": "resumed"` and the first turn's id (`SELECT json(payload) FROM events WHERE session_id = '<the run's session>' AND type = 'provider_session_observed'`); or a rework after Request changes has the work run's id there.
5. With a workspace that is a real git repository, during a turn: `ls -d "${TMPDIR:-/tmp}"/mt-session-id-*` shows the turn's directory, and `git status` in the workspace shows no new file; after the turn the directory is gone.
