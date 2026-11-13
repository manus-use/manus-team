# Plan U: Updating a deployed gateway, `mt update`. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a deploy one command. `mt update` checks the checkout the service runs, its branch and upstream, the service and the locks, fetches, and shows what is coming; then, asked or with `--yes`, fast-forwards, runs `npm ci` only when the dependencies changed, builds, has the new build check itself (`mt service check`), backs the database up, restarts the service with `mt service restart`'s own code and waits for the gateway to say it connected. A failure before the restart goes back to the old commit and its build, the running gateway untouched; a gateway that moved meanwhile, a restart that is not confirmed, or a going back that fails stops with exit 3 and the steps to take by hand. A build refuses a database a newer build migrated. `mt update --check` shows and changes nothing.

**Architecture:**
- **The schema's refusal** (`src/db/open.ts`, `src/index.ts`): `migrate()` refuses a `user_version` above the highest migration file as a `SchemaTooNewError extends ConfigError`, before anything runs; `createGateway` closes the database and throws a new one naming the database and `<home>/backups`, the original as its `cause`. `main` reports it as `configuration error:` and exit 78, as any `ConfigError`.
- **The service** (`src/cli/service.ts`): `state()` gains `unreadable`; `mt service check` prints the version line, then install's check (with a unit) or a hand-run gateway's (without), then imports `dist/index.js` and opens an in-memory database; `serviceView` gives `update.ts` the unit, the state, the home's lock, the service's environment, the log and the restart.
- **The pieces** (`src/cli/shell.ts`, `src/db/backup.ts`, `src/cli/update-lock.ts`, `src/cli/update-advice.ts`): the quoting and the npm beside the node; the backup and its retention; the two locks; the steps back, the steps forward and the commands to finish by hand.
- **The command** (`src/cli/update.ts`, `src/cli/mt.ts`): `updateCommand` and the `Update` class, steps 2 to 7 of spec §20.1, every git, npm and child node call through `UpdateDeps.run`; `runDetached`, the real runner, a session of its own with time limits; `realUpdateDeps`, the real terminal, signals and service calls.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`), vitest, better-sqlite3 11, git.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §20 (from line 3307 to the end), plan U's row in §12 (line 2199), and §17's command list (line 2433), which names `check` already.

---

## Ground rules

- **Where to work.**
  - Use the worktree beside the main checkout, `/Users/x/Develop/manus/prime-gateway-wt2`, on the branch `mt-update`, which holds this plan, from `31313b2`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, never run the real `mt update` or `mt service`, never reach the network, and never read or write `~/.manus-team`. Every unit test gives `mt update` a fake git, a fake npm and a fake launchd or systemd through `UpdateDeps` and `ServiceDeps` (`tests/helpers/update.ts`, `tests/helpers/service.ts`), with a made-up `HOME` and gateway home. The end-to-end test runs real git, against a bare origin it makes in a temporary directory, with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` and a made-up `HOME`, a fake npm beside a real node, and the fake service.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npx vitest run --project unit` gives `Tests  1781 passed (1781)`. `npx vitest run --project e2e` gives `Tests  157 passed (157)`. `npm run typecheck` reports no errors. One unit test is known to fail now and then under load; run the suite again before looking into a single failure.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text is whole lines, and appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given. Every step of this plan was applied in that order, from `31313b2`, in a throwaway copy, and gave the counts it states.
- **One writer.** `db/` modules stay the only writers of a database: the backup is `src/db/backup.ts`, which writes only its own copy, from a read-only connection to the gateway's; `mt update` reads the gateway's database only through `openDbReadOnly`. `src/db/WRITERS.md` says so (Tasks 1 and 6).
- **Words a person sees** (`mt` output, refusals, the printed steps, the README) never name a plan, and do not use the long dash.
- **No real agent.** No test runs bytesec.

## Decisions

Each has its reason. Where the code and the spec disagree, the code is the fact, and the decision says which reading keeps the spec's intent; those are listed again under "Where the code forced a reading" below.

1. **`highestMigration` and `migrate` read the same files.** `migrationFiles(schemaDir)`, `NNN_*.sql`, is shared; the refusal comes before any `BEGIN`, so a refused database is untouched, and an empty directory's highest is 0.
2. **`createGateway` closes the database on every error from `migrate`**, the refusal completed and every other rethrown as it was. Its message keeps `migrate`'s words and adds the path and `join(config.home, 'backups')`.
3. **`schemaDirOf(env)`** in `src/config.ts` is what `loadConfig` gives as `schemaDir` (`MT_SCHEMA_DIR`, else `BUNDLED_SCHEMA_DIR`, now exported), so `mt service check`'s "this build: up to N" reads the directory the gateway reads.
4. **`mt service check`'s lines.** `database: <path> at version 8; this build: up to 9`, with ` (migrations from <dir>, MT_SCHEMA_DIR)` when the directory is not the bundled one, `database: <path>: no database; ...` with none, and `database: unknown (<error>)` when the settings, or the gateway's `.env`, are refused. Then `checking as <unit> starts it: with PATH <the unit's>, MT_HOME <home> and <.env>`, or `checking as a gateway started by hand from this shell, over <.env>: no service is installed`, which also shows a test which `PATH` was used. Then `warning:` and `note:` lines, and `ok: this build would start as <unit>` or `... as a gateway started by hand from this shell`. A problem is `mt: ...`, exit 1.
5. **The module load imports two files**: `dist/index.js`, the gateway's graph, and `dist/db/open.js`, already in that graph, for `openDb(':memory:')`, which loads the native module. `ServiceDeps.importModule` is optional, `import()` by default, so the existing `mt service` tests and their `ServiceDeps` literals are unchanged.
6. **`ServiceView`** is what `update.ts` takes of `mt service`: `installed`, `recorded`, `state`, `lockPid`, `env` and `restart`, over the same `Service` class, whose `installed`, `recorded` and `lockPid` become public. `restart` calls `start(true)`, the code of `mt service restart`, and answers why it did not restart, or undefined.
7. **Every update call has a time limit.** `LIMITS`: `git fetch` 120 s, a call that runs a hook (`merge --ff-only`, `reset --keep`) 120 s, `npm ci` 20 min, `npm run build` 10 min, the new build's `mt service check` 120 s, and every other git call, local plumbing, 30 s.
8. **`runDetached`** spawns with `detached: true` and `stdio: ['ignore', 'pipe', 'pipe']`, kills the process group (`process.kill(-pid)`) with SIGTERM at the limit or an abort, then SIGKILL 5 s later, and keeps the last 256 KiB of each stream. A signal's exit is `128 + n`. A second after the SIGKILL it destroys the child's stdout and stderr and answers with what was captured, exit 137, so a process that left the group and holds the pipes open cannot hang the update.
9. **`git` runs with `GIT_TERMINAL_PROMPT=0`**, and from the fetch on with `GIT_SSH_COMMAND='ssh -o BatchMode=yes'` unless this shell sets `GIT_SSH_COMMAND` or `git config --get core.sshCommand` answers. npm and the check run with the same environment and the node's directory first on `PATH`. `MT_KANBAN_*` are dropped from every child's environment.
10. **`--check` and `--yes` together** are a usage error, exit 2, as are any argument and any other option.
11. **The question** is `update and restart the service? [y/N] `, or `update, and back up the database? [y/N] ` when no restart follows. `y` or `yes`, any case, trimmed, goes on.
12. **What step 3 says.** The header, the commits (50, then `and N more`), the new migrations in one line, a `warning:` for each changed one, the `MT_SCHEMA_DIR` warning, `the dependencies changed: npm ci runs` or `node_modules/.package-lock.json is missing: npm ci runs` (nothing when it does not run), `N agent runs are open: ...` when the service will be restarted and some are, and the service's line; with no service and `kanban.enabled` not set, a line that no lock shows a gateway run by hand.
13. **The database at step 3** is found with `loadTeamSettings(env, undefined, { unsetPassEnv: [] })`, so a `passEnv` name the service lacks is not a refusal, as `mt service check`'s version line finds it: with a unit, over `ServiceView.env`; without, this shell over the `.env`, with `MT_HOME` as `mt service` finds it.
14. **The lock's JSON** holds `pid`, `home`, `checkout`, `step`, `old`, `new`, `servicePid` and `userVersion` (`null` for none), `db` and `backup`, both locks the same line. The steps are `check`, `show`, `merge`, `npm ci`, `build`, `preflight`, `backup`, `restart`, `confirm` and `going back`; `check` and `show` changed nothing (`UNCHANGED_STEPS`).
15. **A dead update's locks are named together, once.** A stale lock found at either place makes the update read the other place too, and the advice ends with one `rm` of every lock naming the dead pid, so it is followed once and a backup is never restored twice. A checkout's lock left by an update of another home gives no steps, as its database and service are that home's: `an update of <home> died at its step <step>; run MT_HOME='<home>' mt update for what to do`, exit 1. A lock's database that cannot be read is an unknown version: both ways are printed, with `mt service check` to read it.
16. **A signal after step 3's last call** stops the update at the start of `apply()`, and before `--check` returns, `interrupted by <signal>: nothing changed`, exit 1: the calls of step 3 check after each, but a signal can arrive between the last of them and the merge.
17. **The lock's staging file is synced** (`fsyncSync`) before it is linked or renamed into place, so a power cut never leaves a lock half written.
18. **A merge that fails goes back, timed out or not.** `reset --keep` to the commit `HEAD` is still on changes nothing, and the build runs again; a timed-out one whose `HEAD` is the new commit says the merge landed and its hook hung.
19. **`npm ci` runs again going back when the update started one**, failed or not: one that failed half way leaves `node_modules` only another can mend.
20. **Going back's failure** prints what failed, the call that failed going back with its last 20 lines, `git status`, and the commands to finish by hand, with `git reset --keep <old>` among them when it is the reset that failed. Going back ends with `git status --porcelain --untracked-files=normal`: "back at <old>" is said only of a clean tree, and a tree a hook or the build wrote into is stuck the same way, exit 3.
21. **The confirmation's wait** is 240 polls of the injected `sleep(250)` after the restart call returns, as `restartJob`'s drain is, reading the log from the size it had before the call, from its start when it is now shorter. A line that starts `configuration error:` or `failed to start:` fails at once; `connected as` counts only after a `schema at version N (` line.
22. **Output is masked and never fails.** Every line the update prints goes through `redactKnownSecrets`; the update wraps `io.out` and `io.err`, the service's own lines included, so EPIPE and EIO thrown by a write are ignored, and `realUpdateDeps().guardOutput` ignores them on `process.stdout` and `process.stderr`'s `error` events.
23. **The service's calls during an update run detached too.** `realUpdateDeps()` gives the service `runSyncDetached` for `ServiceDeps.run`: each `launchctl` or `systemctl` call runs through a small node wrapper that ignores the terminal's signals and runs the command in a session of its own, so a Ctrl-C in the terminal reaches `mt` alone and the restart call is let finish, as §20.11 asks. `mt service` itself is unchanged.
24. **Tasks 9 to 12 build `src/cli/update.ts` in four steps**: `--check` alone first (steps 1 to 3, a usage error without `--check`), then `--yes` and the question with steps 4 to 7, then a dead update's lock, then the signals. Each leaves the suite green.

## Known limitations

From spec §20.15, kept as it says: no `--to <ref>`, no installing node, no schedule; builds from before this plan do not refuse a newer database; no trial of the new migrations; the restart interrupts every agent run and chat turn; a board run's `mt`, and the operator's `mt kanban`, are the new build's between the build and the restart, on a database the old gateway has not migrated; a crash restart in steps 4 to 6 runs the new tree, noticed, not prevented; two homes on one checkout, only this home's service restarted; a changed unit not rewritten; `mt service install` and the like not locked against an update; a stale lock needs a person; the backup misses the writes between it and the stop. Besides:

- **An error nothing foresaw** (a bug: not a refusal, a failure or a signal) keeps the locks once the update is past step 3: `run()` prints `mt: unexpected error at its step <step>: <message, masked>`, names both locks, says to run `mt update` again for what to do, and exits 3, and the next run gives a dead update's advice for that step. Before step 4 nothing changed, so the locks are released and it exits 1. A process that never runs its `finally` (a `kill -9`, a power cut) leaves its locks too.
- **SIGQUIT and SIGKILL** are not handled: the second cannot be, and the first is not a terminal's usual way to stop.
- **The version line needs the native module.** With better-sqlite3's module built for another node, `openDbReadOnly` fails too, so `mt service check` prints `database: unknown (...)` before failing at the module load. The printed steps back's check line says to go on when it prints `at version N`, `database: unknown (...)`, or nothing.
- **The steps forward** build the tree as it is; they do not fast-forward it, as §20.6 gives them. They follow a database that moved, which needs a crash restart on the new tree, so after the merge.
- **The end-to-end test runs macOS's fake launchd only**; systemd's restart call is covered by the unit tests' fake.

## Where the code forced a reading

- **The stand-in is `(unset here)`, not `(unset)`.** §20.5 names `'(unset)'` and has it registered as a secret, "so it is masked in the output like one". `src/secrets.ts` never masks a value shorter than `MIN_SECRET_LENGTH`, 8, so `'(unset)'`, 7, could not be. The stand-in is the 12 characters `(unset here)`, registered with `addSecrets`, and masked.
- **`state()` asks for the domain only after the job's print fails.** §20.2 says it "first probes the domain ... and only then the job". A job that prints has a domain, so the result is the same; asking in that order would add a call to every state read, a loaded job's and each of `mt service restart`'s 240 drain polls among them. Two existing tests list the calls after a job not loaded, and gain `launchctl print gui/501`; the `notLoaded` helper now answers for the job only, its domain answering by default.
- **The open runs are counted by `openAgentRunCount`**, which `src/db/kanban-read.ts` already has with exactly §20.3's query, plus a new `hasBoard`, so a database with no `kanban_runs` is "no board" rather than an error.
- **The home in a hand-run gateway's check** is the one `mt service` finds (`MT_HOME`, else `~/.manus-team` under `ServiceDeps.home`), set as `MT_HOME` in the environment `mt service check` and `mt update` load, since `gatewayHome` reads `os.homedir()` where `mt service` reads `ServiceDeps.home`. On a real host the two are the same path; in a test the second is the made-up home.
- **The lock also records the database's path (`db`)**, which §20.10's list does not name: a later run's advice reads that database's `user_version` again, and the steps back name it.
- **"the newest of each version among the rest"** (§20.8) is read as the newest of each version not already among the five, kept besides them, so a version among the five keeps no second backup. The intent, a way back for each schema, is kept by either reading.
- **The restart call's failure** is either `start(true)` refusing, which prints its own `mt: ...` and returns 1, or a `CommandFailed` from `launchctl` or `systemctl`; both are "a restart call that fails", exit 3.
- **`ServiceDeps.run` is synchronous** (`spawnSync`), so a signal during one `launchctl` or `systemctl` call is handled when the call returns, and the drain's `sleep` lets one in between calls: either way the call finishes, as §20.11 asks.
- **The fake timers of §20.14** are the injected `sleep`, as `mt service`'s own tests drive its drain; the wait counts polls, not the clock.
- **A failed `.partial`'s leftovers** include its `-wal` and `-shm` besides the `-journal` §20.8 names: the copy of a WAL database is opened in WAL mode until its journal mode is set.
- **A lock file that holds no update's state** is refused, naming the `rm`, as a held lock is never cleared.

## File map

| File | Responsibility |
|---|---|
| `src/db/open.ts` (modify) | `highestMigration`, `SchemaTooNewError`; `migrate` refuses a newer database |
| `src/index.ts` (modify) | `createGateway` closes the database and completes the refusal; `loadStartup`'s contract |
| `src/config.ts` (modify) | `BUNDLED_SCHEMA_DIR` exported, `schemaDirOf` |
| `src/cli/service.ts` (modify) | `State.unreadable`; `mt service check`, with and without a unit; `versionLine`; `ServiceView`, `serviceView`; install's closing line |
| `src/cli/shell.ts` (create) | `shQuote`, `findNpm`, `mtCommand`, `npmCommand` |
| `src/db/backup.ts` (create) | `backupDatabase`, `backupName`, `pruneBackups` |
| `src/db/kanban-read.ts` (modify) | `hasBoard` |
| `src/db/WRITERS.md` (modify) | `user_version`'s refusal; the backup |
| `src/cli/update-lock.ts` (create) | `UpdateLock`, `readUpdateLock`, `UpdateStep` |
| `src/cli/update-advice.ts` (create) | `stepsBack`, `stepsForward`, `finishByHand` |
| `src/cli/update.ts` (create) | `updateCommand`, `UpdateDeps`, `runDetached`, `runSyncDetached`, `realUpdateDeps`, `Update` |
| `src/cli/mt.ts` (modify) | `mt update`, refused in a board run's shell; `MtIo.update`; the usage |
| `README.md` (modify) | "Running as a service", "Deploying", the `mt` command list |
| `tests/helpers/service.ts`, `tests/helpers/update.ts` (create) | the fake service, the fake git and npm |
| `tests/schema-too-new.test.ts`, `tests/mt-service-check.test.ts`, `tests/update-backup.test.ts`, `tests/update-lock.test.ts`, `tests/update-advice.test.ts`, `tests/update-run.test.ts`, `tests/mt-update-check.test.ts`, `tests/mt-update-show.test.ts`, `tests/mt-update-apply.test.ts`, `tests/mt-update-restart.test.ts`, `tests/mt-update-locks.test.ts`, `tests/mt-update-signals.test.ts`, `tests/mt-update.e2e.ts` (create) | |
| `tests/mt-service.test.ts` (modify) | the domain's call, the usage, install's closing line |

Running counts, unit then end to end: Task 1 1785 / 157, Task 2 1788 / 157, Task 3 1791 / 157, Task 4 1802 / 157, Task 5 1808 / 157, Task 6 1816 / 157, Task 7 1822 / 157, Task 8 1831 / 157, Task 9 1884 / 157, Task 10 1919 / 157, Task 11 1944 / 157, Task 12 1959 / 157, Task 13 1959 / 157, Task 14 1959 / 164.

How §20.14's tests map to the tasks: `migrate()`'s refusal, its highest of 0, at and below migrated (Task 1); `createGateway` closing and completing it, and the start ending with `configuration error:` and exit 78 (Task 2); an unreadable state on each system (Task 3); `mt service check` with a unit, install's cases through it, the unit's `PATH`, the version line first and as `database: unknown`, `MT_SCHEMA_DIR`'s directory, a failed import and a failed native load naming the `npm ci` (Task 4); with no unit, no `.env` required, install's checks not run, a `ConfigError` before `loadStartup`, the stand-ins and their notes, masked, never for a value the `.env` sets (Task 5); the backup's name, modes, `.partial`, journal mode, `quick_check`, version and retention (Task 6); the locks (Task 7); the printed commands naming node and npm by path, quoted (Task 8); each refusal of step 2, a configuration the old build rejects, the database from the service's environment, nothing new, the commits and their cap, a new and a changed migration, `npm ci` and the service's line said or not, `--check` running no merge, the open runs, the `MT_SCHEMA_DIR` warning, the time limits and batch mode (Task 9); no terminal without `--yes`, a "no", `npm ci` skipped or run, npm beside the node and its directory first on `PATH`, each failure of steps 4 to 6 going back, a changed pid and a changed version at the backup and at going back, going back failing, a stopped service, a failed restart call, the confirmation and its failures (Task 10); a stale lock at each step, its version equal to the database's and not (Task 11); each signal at each step, a second one while going back, the drain's and `systemctl restart`'s, and EPIPE (Task 12); and the end-to-end list (Task 14).

---

### Task 1: A database newer than the build, refused by `migrate`

**Files:**

- Create: `tests/schema-too-new.test.ts`
- Modify: `src/db/WRITERS.md`, `src/db/open.ts`

Spec §20.6. `migrate()` refuses a `user_version` above the highest `NNN` among the build's migration files, before any migration runs, as a `SchemaTooNewError extends ConfigError` carrying `dbVersion` and `buildVersion`, in `migrate`'s own words, which know no home. `highestMigration(schemaDir)` gives that highest, 0 for a directory with none, for `mt service check` (Task 4). WRITERS.md's row for `user_version` says the runner refuses.

- [ ] **Step 1.1: Write the tests.**

Create `tests/schema-too-new.test.ts`:

```ts
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { SchemaTooNewError, highestMigration, migrate, openDb, type Db } from '../src/db/open.js';
import { SCHEMA_DIR } from './helpers/db.js';

/**
 * A database newer than the build (spec §20.6): `migrate()` refuses one whose
 * `user_version` is above the highest migration file, before anything runs, and
 * migrates one at or below it as before.
 */

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-newer-'));
  db = openDb(join(dir, 'team.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A schema directory holding the bundled migrations numbered up to `top`. */
function schemaUpTo(top: number): string {
  const only = join(dir, `schema-${top}`);
  mkdirSync(only);
  for (const f of readdirSync(SCHEMA_DIR)) {
    if (/^\d+_.*\.sql$/.test(f) && Number(f.slice(0, f.indexOf('_'))) <= top) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
  }
  return only;
}

const tables = (): string[] =>
  db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

describe('highestMigration', () => {
  it('is the highest NNN among the files, and 0 for a directory with none', () => {
    expect(highestMigration(schemaUpTo(3))).toBe(3);
    expect(highestMigration(SCHEMA_DIR)).toBe(readdirSync(SCHEMA_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).length);
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    expect(highestMigration(empty)).toBe(0);
  });
});

describe('migrate on a database newer than the build', () => {
  it('refuses it as a SchemaTooNewError with both versions, applying nothing', () => {
    db.pragma('user_version = 5');
    let thrown: unknown;
    try {
      migrate(db, schemaUpTo(3));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SchemaTooNewError);
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown).toMatchObject({
      name: 'SchemaTooNewError',
      dbVersion: 5,
      buildVersion: 3,
      message:
        'the database is at schema version 5, and this build knows only up to 3: it was migrated by a newer build. ' +
        'Run that build, or restore a backup of version 3 (spec §20.8)',
    });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(5);
    expect(tables()).toEqual([]);
  });

  it('refuses any migrated database from a directory with no migration file', () => {
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    expect(migrate(db, empty)).toBe(0);
    db.pragma('user_version = 1');
    expect(() => migrate(db, empty)).toThrow(SchemaTooNewError);
  });

  it('migrates one below the highest file, and leaves one at it as it is', () => {
    expect(migrate(db, schemaUpTo(3))).toBe(3);
    expect(migrate(db, SCHEMA_DIR)).toBe(highestMigration(SCHEMA_DIR));
    const before = tables();
    expect(migrate(db, SCHEMA_DIR)).toBe(highestMigration(SCHEMA_DIR));
    expect(tables()).toEqual(before);
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/schema-too-new.test.ts`. Expected: `Tests  4 failed (4)`: `(0 , highestMigration) is not a function`: there is no `highestMigration` or `SchemaTooNewError` yet.

- [ ] **Step 1.3: Implement.**

In `src/db/WRITERS.md`, replace:

```markdown
| `schema_version`, `user_version` | `db/open.ts` (`migrate`) | Migration files own the `schema_version` row contents; the runner owns `user_version`. |
```

with:

```markdown
| `schema_version`, `user_version` | `db/open.ts` (`migrate`) | Migration files own the `schema_version` row contents; the runner owns `user_version`, and refuses a database above its highest file (spec §20.6). |
```

In `src/db/open.ts`, replace:

```ts
import { join } from 'node:path';
```

with:

```ts
import { join } from 'node:path';
import { ConfigError } from '../config.js';
```

In `src/db/open.ts`, replace:

```ts
}

/**
 * Apply any migration in `schemaDir` newer than the recorded version.
```

with:

```ts
}

/** The migration files in `schemaDir`, `NNN_name.sql`, with their numbers. */
function migrationFiles(schemaDir: string): { file: string; version: number }[] {
  return readdirSync(schemaDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ file: f, version: Number(f.slice(0, f.indexOf('_'))) }));
}

/** The highest `NNN` among the migration files in `schemaDir`: the newest schema this build knows. 0 when there are none. */
export function highestMigration(schemaDir: string): number {
  return migrationFiles(schemaDir).reduce((top, m) => Math.max(top, m.version), 0);
}

/**
 * A database whose `user_version` is above every migration this build has: a
 * newer build migrated it (spec §20.6). A configuration error, so the gateway
 * says it in one line and exits 78, which keeps systemd from a restart loop.
 */
export class SchemaTooNewError extends ConfigError {
  readonly dbVersion: number;
  readonly buildVersion: number;

  constructor(message: string, dbVersion: number, buildVersion: number, cause?: unknown) {
    super(message);
    this.name = 'SchemaTooNewError';
    this.dbVersion = dbVersion;
    this.buildVersion = buildVersion;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Apply any migration in `schemaDir` newer than the recorded version.
```

In `src/db/open.ts`, replace:

```ts
 * this. The `schema_version` table remains the migrations' own business.
 */
```

with:

```ts
 * this. The `schema_version` table remains the migrations' own business.
 *
 * A database above the highest file is refused before anything runs, as a
 * `SchemaTooNewError`: an older build put back on a migrated database, by hand
 * or by a crash restart, stops rather than run on a schema it does not know. A
 * directory with no file has a highest of 0, so it refuses any migrated database.
 */
```

In `src/db/open.ts`, replace:

```ts
  const current = Number(db.pragma('user_version', { simple: true }));
```

with:

```ts
  const current = Number(db.pragma('user_version', { simple: true }));
  const files = migrationFiles(schemaDir);
  const highest = files.reduce((top, m) => Math.max(top, m.version), 0);
  if (current > highest) {
    throw new SchemaTooNewError(
      `the database is at schema version ${current}, and this build knows only up to ${highest}: it was migrated by a newer build. ` +
        `Run that build, or restore a backup of version ${highest} (spec §20.8)`,
      current,
      highest,
    );
  }
```

In `src/db/open.ts`, replace:

```ts
  const pending = readdirSync(schemaDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ file: f, version: Number(f.slice(0, f.indexOf('_'))) }))
```

with:

```ts
  const pending = files
```

- [ ] **Step 1.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1785 passed (1785)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.5: Commit.**

```bash
git add src/db/WRITERS.md src/db/open.ts tests/schema-too-new.test.ts
git commit -m "Refuse a database newer than the build in migrate, as a SchemaTooNewError carrying both versions, before any migration runs"
```

---

### Task 2: The gateway stops on a newer database, its database closed

**Files:**

- Modify: `src/index.ts`, `tests/schema-too-new.test.ts`

Spec §20.6 and §20.13. `createGateway` closes the database whenever `migrate` throws, and for a `SchemaTooNewError` throws a new one, its message completed with the database's path and `<home>/backups`, the original as its `cause`. `main` already turns a `ConfigError` into `configuration error: ...` and exit 78; a test runs `src/main.ts` on a newer database to see it. `loadStartup` gains the comment §20.5 asks for: `mt service check` imports it by name (Task 5).

- [ ] **Step 2.1: Write the tests.**

In `tests/schema-too-new.test.ts`, replace:

```ts
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
```

with:

```ts
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
```

In `tests/schema-too-new.test.ts`, replace:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
```

with:

```ts
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
```

In `tests/schema-too-new.test.ts`, replace:

```ts
import { SchemaTooNewError, highestMigration, migrate, openDb, type Db } from '../src/db/open.js';
import { SCHEMA_DIR } from './helpers/db.js';
```

with:

```ts
import { SchemaTooNewError, highestMigration, migrate, openDb, type Db } from '../src/db/open.js';
import { createGateway } from '../src/index.js';
import { loadTeam } from '../src/team.js';
import { SCHEMA_DIR } from './helpers/db.js';
```

In `tests/schema-too-new.test.ts`, replace:

```ts
/**
```

with:

```ts
const LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

/**
```

In `tests/schema-too-new.test.ts`, replace:

```ts
    expect(tables()).toEqual(before);
  });
});
```

with:

```ts
    expect(tables()).toEqual(before);
  });
});

describe('createGateway on a database newer than the build', () => {
  const env = (home: string): Record<string, string> => ({
    MT_HOME: home,
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: join(dir, 'repo'),
    MT_OWNER_OPEN_ID: 'ou_owner',
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret-never-printed',
    MT_AGENT_COMMAND: 'bytesec',
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
  });

  /** A home whose database a newer build migrated: one version above this build's. */
  function newerHome(): { home: string; dbPath: string; version: number } {
    const home = join(dir, 'home');
    mkdirSync(home);
    const dbPath = join(home, 'team.db');
    const newer = openDb(dbPath);
    const version = highestMigration(SCHEMA_DIR) + 1;
    newer.pragma(`user_version = ${version}`);
    newer.close();
    return { home, dbPath, version };
  }

  beforeEach(() => mkdirSync(join(dir, 'repo')));
  afterEach(() => vi.restoreAllMocks());

  it('closes the database and throws a new SchemaTooNewError naming the database and the backups, the original as its cause', async () => {
    const { home, dbPath, version } = newerHome();
    const config = loadConfig(env(home), () => undefined);
    const team = loadTeam(config, env(home));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const close = vi.spyOn(Database.prototype, 'close');
    let thrown: unknown;
    try {
      await createGateway(config, team);
    } catch (err) {
      thrown = err;
    }
    const top = highestMigration(SCHEMA_DIR);
    expect(thrown).toBeInstanceOf(SchemaTooNewError);
    expect(thrown).toMatchObject({
      dbVersion: version,
      buildVersion: top,
      message:
        `the database at ${dbPath} is at schema version ${version}, and this build knows only up to ${top}: it was migrated by a newer build. ` +
        `Run that build, or restore a backup of version ${top} from ${join(home, 'backups')} (spec §20.8)`,
    });
    expect((thrown as Error).cause).toBeInstanceOf(SchemaTooNewError);
    expect((thrown as Error).cause).not.toBe(thrown);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the database before any other error from migrate is thrown, as it was', async () => {
    const home = join(dir, 'home');
    mkdirSync(home);
    const broken = join(dir, 'broken-schema');
    mkdirSync(broken);
    writeFileSync(join(broken, '001_broken.sql'), 'CREATE TABLE;');
    const config = { ...loadConfig(env(home), () => undefined), schemaDir: broken };
    const team = loadTeam(config, env(home));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const close = vi.spyOn(Database.prototype, 'close');
    await expect(createGateway(config, team)).rejects.toThrow(/^migration 001_broken\.sql failed/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops the gateway with configuration error: and exit 78', async () => {
    const { home, dbPath, version } = newerHome();
    const r = await new Promise<{ code: number | null; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, ['--import', LOADER, MAIN], {
        env: { ...env(home), HOME: dir, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => (stderr += d));
      child.once('error', fail);
      child.once('close', (code) => done({ code, stderr }));
    });
    expect(r.code).toBe(78);
    expect(r.stderr).toContain(`\nconfiguration error: the database at ${dbPath} is at schema version ${version}, `);
    expect(r.stderr).not.toContain('app-secret-never-printed');
  }, 30_000);
});
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/schema-too-new.test.ts`. Expected: `Tests  3 failed | 4 passed (7)`: the database is not closed, the message names no path, and the gateway stops with `migrate`'s own words.

- [ ] **Step 2.3: Implement.**

In `src/index.ts`, replace:

```ts
import { migrate, openDb, type Db } from './db/open.js';
```

with:

```ts
import { SchemaTooNewError, migrate, openDb, type Db } from './db/open.js';
```

In `src/index.ts`, replace:

```ts
 * process environment, which the file never enters.
 */
```

with:

```ts
 * process environment, which the file never enters.
 *
 * `mt service check` relies on it, with no unit installed (spec §20.5): it imports
 * this module from the build it checks and calls `loadStartup(env)` by this name,
 * with one argument, the environment, and takes a `ConfigError` thrown as the
 * reason the gateway would not start. Change its name, its argument or what it
 * throws knowing that `mt update`'s preflight runs that check.
 */
```

In `src/index.ts`, replace:

```ts
  const version = migrate(db, config.schemaDir);
```

with:

```ts
  let version: number;
  try {
    version = migrate(db, config.schemaDir);
  } catch (err) {
    db.close();
    if (!(err instanceof SchemaTooNewError)) throw err;
    // migrate knows no home: the message is completed here, with where the backups are (spec §20.6).
    throw new SchemaTooNewError(
      `the database at ${config.dbPath} is at schema version ${err.dbVersion}, and this build knows only up to ${err.buildVersion}: ` +
        `it was migrated by a newer build. Run that build, or restore a backup of version ${err.buildVersion} ` +
        `from ${join(config.home, 'backups')} (spec §20.8)`,
      err.dbVersion,
      err.buildVersion,
      err,
    );
  }
```

- [ ] **Step 2.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1788 passed (1788)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.5: Commit.**

```bash
git add src/index.ts tests/schema-too-new.test.ts
git commit -m "Have createGateway close the database and complete a newer database's refusal with its path and the backups, and say on loadStartup that mt service check relies on it"
```

---

### Task 3: A service state that cannot be read

**Files:**

- Modify: `src/cli/service.ts`, `tests/mt-service.test.ts`

Spec §20.2. `state()` gains `unreadable`: on macOS, a job whose `launchctl print` fails is "not loaded" only when its domain, `launchctl print gui/<uid>`, answers; on Linux a non-zero `systemctl --user show` is unreadable. `mt service`'s own commands take an unreadable state as they took "not loaded", so they are unchanged; `mt service status` says `loaded: unknown (<why>)`, and `mt update` refuses it (Task 9). `failure()` is the message `must()` already built, shared. The tests' `notLoaded` helper answers for the job alone, its domain by default, and two call lists gain the domain's print.

- [ ] **Step 3.1: Write the tests.**

In `tests/mt-service.test.ts`, replace:

```ts
}
function notLoaded(f: Fx): void {
```

with:

```ts
}
/** launchctl print answers that the job is not loaded; its domain, `gui/<uid>`, answers by default. */
function notLoaded(f: Fx): void {
```

In `tests/mt-service.test.ts`, replace:

```ts
  f.answers.push({
    match: (c) => c.cmd === 'launchctl' && c.args[0] === 'print',
    result: { code: 113, stderr: 'Could not find service "team.manus.gateway" in domain for user gui: 501\n' },
```

with:

```ts
  f.answers.push({
    match: (c) => c.cmd === 'launchctl' && c.args[0] === 'print' && c.args[1] !== `gui/${UID}`,
    result: { code: 113, stderr: 'Could not find service "team.manus.gateway" in domain for user gui: 501\n' },
```

In `tests/mt-service.test.ts`, replace:

```ts
    expect(words(fx)).toEqual([
      `launchctl print gui/${UID}/team.manus.gateway`,
      `launchctl enable gui/${UID}/team.manus.gateway`,
      `launchctl bootstrap gui/${UID} ${plistPath(fx)}`,
```

with:

```ts
    expect(words(fx)).toEqual([
      `launchctl print gui/${UID}/team.manus.gateway`,
      `launchctl print gui/${UID}`,
      `launchctl enable gui/${UID}/team.manus.gateway`,
      `launchctl bootstrap gui/${UID} ${plistPath(fx)}`,
```

In `tests/mt-service.test.ts`, replace:

```ts
        `launchctl print gui/${UID}/team.manus.gateway`,
        `launchctl enable gui/${UID}/team.manus.gateway`,
```

with:

```ts
        `launchctl print gui/${UID}/team.manus.gateway`,
        `launchctl print gui/${UID}`,
        `launchctl enable gui/${UID}/team.manus.gateway`,
```

In `tests/mt-service.test.ts`, replace:

```ts
describe('mt service logs', () => {
```

with:

```ts
describe('a state the manager cannot give', () => {
  it('is unknown on macOS when the gui domain cannot be printed, never "not loaded"', async () => {
    fx = fixture();
    fx.answers.push({
      match: (c) => c.cmd === 'launchctl' && c.args[0] === 'print' && c.args[1] === `gui/${UID}`,
      result: { code: 125, stderr: 'Bad request.\nCould not find domain for user gui: 501\n' },
    });
    notLoaded(fx);
    const r = await fx.run(['service', 'status']);
    expect(r.out).toMatch(/^loaded: unknown \(launchctl print gui\/501 failed \(exit 125\): Bad request\. Could not find domain for user gui: 501\)$/m);
    expect(words(fx)).toEqual([`launchctl print gui/${UID}/team.manus.gateway`, `launchctl print gui/${UID}`]);
  });

  it('is "not loaded" on macOS when the domain answers and the job does not', async () => {
    fx = fixture();
    notLoaded(fx);
    const r = await fx.run(['service', 'status']);
    expect(r.out).toMatch(/^loaded: no$/m);
    expect(words(fx)).toEqual([`launchctl print gui/${UID}/team.manus.gateway`, `launchctl print gui/${UID}`]);
  });

  it('is unknown on Linux when systemctl --user show fails, as with no user bus', async () => {
    fx = fixture();
    fx.answers.push({
      match: (c) => c.cmd === 'systemctl' && c.args[1] === 'show',
      result: { code: 1, stderr: 'Failed to connect to bus: No medium found\n' },
    });
    const r = await fx.run(['service', 'status'], { platform: 'linux' });
    expect(r.out).toMatch(/^loaded: unknown \(systemctl --user show manus-team\.service --property=\S+ failed \(exit 1\): Failed to connect to bus: No medium found\)$/m);
    expect(r.out).toMatch(/^running: no$/m);
  });
});

describe('mt service logs', () => {
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-service.test.ts`. Expected: `Tests  5 failed | 42 passed (47)`: the domain is never asked, and `loaded: no` is said for both.

- [ ] **Step 3.3: Implement.**

In `src/cli/service.ts`, replace:

```ts
interface State {
```

with:

```ts
export interface State {
```

In `src/cli/service.ts`, replace:

```ts
  lastExit: string | undefined;
}
```

with:

```ts
  lastExit: string | undefined;
  /**
   * Why the manager could not be asked, when it could not: no gui domain on
   * macOS, no user bus on Linux. Then `loaded` and `running` are false and mean
   * nothing; `mt update` refuses rather than take it as stopped (spec §20.2).
   */
  unreadable: string | undefined;
}

/** A failed command's first lines, for a message: `cmd args failed (exit N): what it said`. */
function failure(cmd: string, args: readonly string[], r: RunResult): string {
  const said = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(0, 3).join(' ');
  return `${[cmd, ...args].join(' ')} failed (exit ${r.code})${said === '' ? '' : `: ${said}`}`;
}
```

In `src/cli/service.ts`, replace:

```ts
    if (r.code !== 0) {
      const said = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(0, 3).join(' ');
      throw new CommandFailed(`${[cmd, ...args].join(' ')} failed (exit ${r.code})${said === '' ? '' : `: ${said}`}`);
    }
```

with:

```ts
    if (r.code !== 0) throw new CommandFailed(failure(cmd, args, r));
```

In `src/cli/service.ts`, replace:

```ts
  private state(): State {
```

with:

```ts
  /**
   * What the manager says of the job. A failure to ask is `unreadable`, never
   * "not loaded": on macOS a job that cannot be printed is not loaded only when
   * its domain can be, as `gui/<uid>` is missing without a console login; on
   * Linux `systemctl --user show` answers for any unit, so its failure is the
   * user bus's.
   */
  state(): State {
    const none = { loaded: false, running: false, pid: undefined, lastExit: undefined, unreadable: undefined };
```

In `src/cli/service.ts`, replace:

```ts
      if (r.code !== 0) return { loaded: false, running: false, pid: undefined, lastExit: undefined };
```

with:

```ts
      if (r.code !== 0) {
        // Only when the job's print fails: a job that prints has a domain.
        const domain = this.run('launchctl', ['print', this.t.domain]);
        return domain.code === 0 ? none : { ...none, unreadable: failure('launchctl', ['print', this.t.domain], domain) };
      }
```

In `src/cli/service.ts`, replace:

```ts
      return { loaded: true, running, pid: pid === undefined ? undefined : Number(pid), lastExit: exit };
```

with:

```ts
      return { loaded: true, running, pid: pid === undefined ? undefined : Number(pid), lastExit: exit, unreadable: undefined };
```

In `src/cli/service.ts`, replace:

```ts
    const r = this.run('systemctl', [
      '--user',
      'show',
      this.t.name,
      '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus',
    ]);
```

with:

```ts
    const args = ['--user', 'show', this.t.name, '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus'];
    const r = this.run('systemctl', args);
    if (r.code !== 0) return { ...none, unreadable: failure('systemctl', args, r) };
```

In `src/cli/service.ts`, replace:

```ts
      loaded: r.code === 0 && prop('LoadState') === 'loaded',
```

with:

```ts
      loaded: prop('LoadState') === 'loaded',
```

In `src/cli/service.ts`, replace:

```ts
      lastExit: active === 'failed' ? (prop('ExecMainStatus') ?? undefined) : undefined,
    };
```

with:

```ts
      lastExit: active === 'failed' ? (prop('ExecMainStatus') ?? undefined) : undefined,
      unreadable: undefined,
    };
```

In `src/cli/service.ts`, replace:

```ts
    io.out(`loaded: ${state.loaded ? 'yes' : 'no'}`);
```

with:

```ts
    io.out(`loaded: ${state.unreadable !== undefined ? `unknown (${state.unreadable})` : state.loaded ? 'yes' : 'no'}`);
```

- [ ] **Step 3.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1791 passed (1791)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.5: Commit.**

```bash
git add src/cli/service.ts tests/mt-service.test.ts
git commit -m "Take a launchd domain or systemd user bus that cannot be asked as an unreadable state, never as a stopped service, and say so in mt service status"
```

---

### Task 4: `mt service check`, with a unit

**Files:**

- Create: `src/cli/shell.ts`, `tests/helpers/service.ts`, `tests/mt-service-check.test.ts`
- Modify: `src/cli/service.ts`, `src/config.ts`, `tests/mt-service.test.ts`

Spec §20.5. A new subcommand. First the version line, from the settings alone over the service's environment (`HOME`, the unit's `PATH`, `MT_HOME`, the `.env`), its database read read-only, and the highest migration of `schemaDirOf(env)`; then install's own `gatewayEnv` and `checkEnvironment`, with the unit's `PATH`; last, `dist/index.js` and `dist/db/open.js` imported through `ServiceDeps.importModule`, and an in-memory database opened. A unit `mt service install` did not write is refused after the version line. `src/cli/shell.ts` holds the quoting and the npm beside the node, which the native module's refusal names; `tests/helpers/service.ts` is a fake launchd and systemd for this task's tests and the update's. With no unit, this task refuses, as not installed; Task 5 replaces that.

- [ ] **Step 4.1: Write the tests.**

Create `tests/helpers/service.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunResult, ServiceDeps } from '../../src/cli/service.js';
import { launchdPlist, serviceNames, systemdUnit } from '../../src/service/unit.js';

/**
 * A user home, a gateway home and a checkout in a temporary directory, and a
 * fake launchd and systemd behind `ServiceDeps`: every launchctl and systemctl
 * call is recorded and answered from `job`, none is run. Nothing here reads or
 * writes the real home, or reaches the real service.
 */

export const UID = 501;
export const SECRET = 'lark-secret-never-printed-0000';

export interface Call {
  cmd: string;
  args: string[];
}

export interface ServiceFake {
  root: string;
  /** The user's home. */
  home: string;
  /** The gateway's home, `<home>/.manus-team`. */
  mtHome: string;
  checkout: string;
  /** The node the unit records, in a directory of its own. */
  node: string;
  calls: Call[];
  /** What the manager knows of the job: loaded or not, and the pid of the gateway it runs. */
  job: { loaded: boolean; pid: number | undefined };
  /** False: `launchctl print gui/<uid>` fails, as without a console login. */
  domain: boolean;
  /** The pid the next start gives. */
  nextPid: number;
  /** Called at each start of the gateway, a kickstart or a systemctl start or restart. */
  onStart: (pid: number) => void;
  /** An answer for a call, ahead of the fake's own; undefined to let the fake answer. */
  override: (call: Call) => Partial<RunResult> | undefined;
  /** Pids alive, for the gateway lock. */
  alive: Set<number>;
  /** The files `importModule` was asked for. */
  imports: string[];
  /** What `importModule` answers for a file, or throws; a file not named here is not found. */
  modules: Record<string, Record<string, unknown> | Error>;
  deps(platform?: NodeJS.Platform): ServiceDeps;
  /** Write the unit as `mt service install` writes it, recording `path`. */
  install(opts?: { platform?: NodeJS.Platform; path?: string; checkout?: string; mtHomeSet?: string }): string;
  /** The words of each call, `cmd args...`. */
  words(): string[];
  cleanup(): void;
}

/** A config the gateway starts on, given the .env: an owner, a workspace and an agent. */
export function serviceConfig(workspace: string, extra = ''): string {
  return `workspace: ${workspace}\nauth:\n  owner: ou_owner\nagent:\n  driver: acp\n  command: claude-agent-acp\n${extra}`;
}

export async function serviceFake(opts: { env?: string | false; config?: string } = {}): Promise<ServiceFake> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-svc-')));
  const home = join(root, 'My Home');
  const mtHome = join(home, '.manus-team');
  const checkout = join(root, 'the checkout');
  const workspace = join(root, 'repo');
  mkdirSync(mtHome, { recursive: true, mode: 0o700 });
  mkdirSync(join(checkout, 'dist'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(checkout, 'dist', 'main.js'), '');
  mkdirSync(join(root, 'node bin'));
  const node = join(root, 'node bin', 'node');
  writeFileSync(node, '');
  writeFileSync(join(mtHome, 'config.yaml'), opts.config ?? serviceConfig(workspace));
  if (opts.env !== false) {
    writeFileSync(join(mtHome, '.env'), opts.env ?? `LARK_APP_SECRET=${SECRET}\nLARK_APP_ID=cli_test\n`, { mode: 0o600 });
  }
  const f: ServiceFake = {
    root,
    home,
    mtHome,
    checkout,
    node,
    calls: [],
    job: { loaded: false, pid: undefined },
    domain: true,
    nextPid: 5000,
    onStart: () => {},
    override: () => undefined,
    alive: new Set(),
    imports: [],
    modules: {
      [join(checkout, 'dist', 'index.js')]: await import('../../src/index.js'),
      [join(checkout, 'dist', 'db', 'open.js')]: await import('../../src/db/open.js'),
    },
    deps(platform = 'darwin') {
      const start = (): void => {
        f.job.pid = f.nextPid++;
        f.onStart(f.job.pid);
      };
      return {
        platform,
        home,
        uid: UID,
        node,
        checkout,
        run: (cmd, args) => {
          const call = { cmd, args: [...args] };
          f.calls.push(call);
          const over = f.override(call);
          if (over !== undefined) return { code: 0, stdout: '', stderr: '', ...over };
          const ok = { code: 0, stdout: '', stderr: '' };
          if (cmd === 'launchctl') {
            const [verb, a1] = args;
            if (verb === 'print' && a1 === `gui/${UID}`) return f.domain ? ok : { code: 125, stdout: '', stderr: 'Bad request.\n' };
            if (verb === 'print') {
              if (!f.job.loaded) return { code: 113, stdout: '', stderr: 'Could not find service\n' };
              const running = f.job.pid !== undefined;
              return { ...ok, stdout: `${a1} = {\n\tstate = ${running ? 'running' : 'not running'}\n${running ? `\tpid = ${f.job.pid}\n` : ''}}\n` };
            }
            if (verb === 'kill' && a1 === 'SIGTERM') f.job.pid = undefined;
            if (verb === 'kickstart') start();
            if (verb === 'bootout') f.job = { loaded: false, pid: undefined };
            if (verb === 'bootstrap') {
              f.job.loaded = true;
              start();
            }
            return ok;
          }
          if (cmd === 'systemctl') {
            const verb = args[1];
            if (verb === 'show') {
              const running = f.job.pid !== undefined;
              return {
                ...ok,
                stdout: `LoadState=${f.job.loaded ? 'loaded' : 'not-found'}\nActiveState=${running ? 'active' : 'inactive'}\nMainPID=${f.job.pid ?? 0}\n`,
              };
            }
            if (verb === 'restart' || verb === 'start') start();
            if (verb === 'stop') f.job.pid = undefined;
            return ok;
          }
          return ok;
        },
        follow: async (cmd, args) => {
          f.calls.push({ cmd, args: [...args] });
          return 0;
        },
        alive: (pid) => f.alive.has(pid),
        sleep: async () => {},
        importModule: async (file) => {
          f.imports.push(file);
          const m = f.modules[file];
          if (m instanceof Error) throw m;
          if (m === undefined) throw new Error(`Cannot find module '${file}'`);
          return m;
        },
      };
    },
    install(o = {}) {
      const platform = o.platform ?? 'darwin';
      const mtHomeAt = o.mtHomeSet ?? mtHome;
      const names = serviceNames(home, mtHomeAt);
      const spec = {
        label: platform === 'darwin' ? names.label : names.unit,
        node,
        main: join(o.checkout ?? checkout, 'dist', 'main.js'),
        checkout: o.checkout ?? checkout,
        path: o.path ?? '/unit/bin:/usr/bin:/bin',
        mtHome: o.mtHomeSet,
        log: join(mtHomeAt, 'logs', 'gateway.log'),
      };
      const file =
        platform === 'darwin'
          ? join(home, 'Library', 'LaunchAgents', `${names.label}.plist`)
          : join(home, '.config', 'systemd', 'user', names.unit);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, platform === 'darwin' ? launchdPlist(spec) : systemdUnit(spec));
      f.job.loaded = true;
      return file;
    },
    words: () => f.calls.map((c) => [c.cmd, ...c.args].join(' ')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return f;
}
```

Create `tests/mt-service-check.test.ts`:

```ts
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { highestMigration, migrate, openDb } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { SECRET, serviceConfig, serviceFake, type ServiceFake } from './helpers/service.js';

/**
 * `mt service check` (spec §20.5): the database's version line first, whatever
 * follows; with a unit, install's check of the configuration, with the PATH the
 * unit records; last, the gateway's modules and the native module, loaded. No
 * launchctl or systemctl call, and nothing under the real home.
 */

let fx: ServiceFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const TOP = highestMigration(SCHEMA_DIR);

async function check(env: Record<string, string | undefined> = {}): Promise<{ code: number; out: string[]; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['service', 'check'], {
    env: { PATH: '/opt/my tools/bin:/usr/bin:/bin', HOME: fx.home, ...env },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    service: fx.deps(),
  });
  return { code, out, err: err.join('\n') };
}

/** The gateway's database, migrated to `version`. */
function database(version = TOP): string {
  const path = join(fx.mtHome, 'team.db');
  const db = openDb(path);
  migrate(db, SCHEMA_DIR);
  db.pragma(`user_version = ${version}`);
  db.close();
  return path;
}

describe('mt service check with a unit', () => {
  it('prints the version line first, checks as the unit starts the gateway, loads the modules, and calls no manager', async () => {
    fx = await serviceFake();
    fx.install({ path: '/unit/bin:/usr/bin' });
    const db = database();
    const r = await check();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `database: ${db} at version ${TOP}; this build: up to ${TOP}`,
      `checking as team.manus.gateway starts it: with PATH /unit/bin:/usr/bin, MT_HOME ${fx.mtHome} and ${join(fx.mtHome, '.env')}`,
      'ok: this build would start as team.manus.gateway',
    ]);
    expect(fx.imports).toEqual([join(fx.checkout, 'dist', 'index.js'), join(fx.checkout, 'dist', 'db', 'open.js')]);
    expect(fx.calls).toEqual([]);
  });

  it('says there is no database when there is none', async () => {
    fx = await serviceFake();
    fx.install();
    const r = await check();
    expect(r.out[0]).toBe(`database: ${join(fx.mtHome, 'team.db')}: no database; this build: up to ${TOP}`);
  });

  it("refuses without the gateway's .env, after the version line", async () => {
    fx = await serviceFake({ env: false });
    fx.install();
    const r = await check({ LARK_APP_SECRET: SECRET });
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^database: .*: no database; this build: up to \d+$/);
    expect(r.err).toMatch(/\.env does not exist\. The service starts with no shell environment/);
    expect(fx.imports).toEqual([]);
  });

  it('refuses a .env that does not set LARK_APP_SECRET, even when this shell does', async () => {
    fx = await serviceFake({ env: 'LARK_APP_ID=cli_test\n' });
    fx.install();
    const r = await check({ LARK_APP_SECRET: SECRET });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not set LARK_APP_SECRET/);
    expect(r.out.join('\n') + r.err).not.toContain(SECRET);
  });

  it('refuses a configuration the gateway would not start on as the service, naming the problem', async () => {
    fx = await serviceFake({ config: `workspace: /tmp\nagent:\n  driver: acp\n  command: claude-agent-acp\n` });
    fx.install();
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: the gateway would not start as the service, which has only PATH, MT_HOME and .*\.env: an owner is required/);
  });

  it('warns of every passEnv name, which the service will not have', async () => {
    fx = await serviceFake();
    writeFileSync(join(fx.mtHome, 'config.yaml'), serviceConfig(join(fx.root, 'repo'), '  passEnv: [GH_TOKEN]\n'));
    fx.install();
    const r = await check({ GH_TOKEN: 'ghp_never_printed' });
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/warning: role default names GH_TOKEN in agent\.passEnv/);
    expect(r.out.join('\n') + r.err).not.toContain('ghp_never_printed');
  });

  it('refuses a unit mt service install did not write, saying to write it again', async () => {
    fx = await serviceFake();
    const file = fx.install();
    writeFileSync(file, '<plist>edited by hand</plist>\n');
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^database: /);
    expect(r.err).toBe(`mt: ${file} was not written by mt service install; run mt service install to write it again`);
  });
});

describe("mt service check's version line", () => {
  it('names a schema directory MT_SCHEMA_DIR sets, as the gateway reads it', async () => {
    fx = await serviceFake();
    const dir = join(fx.root, 'other schema');
    mkdirSync(dir);
    writeFileSync(join(dir, '001_only.sql'), 'SELECT 1;');
    writeFileSync(join(fx.mtHome, '.env'), `LARK_APP_SECRET=${SECRET}\nLARK_APP_ID=cli_test\nMT_SCHEMA_DIR=${dir}\n`);
    chmodSync(join(fx.mtHome, '.env'), 0o600);
    fx.install();
    const r = await check();
    expect(r.out[0]).toBe(`database: ${join(fx.mtHome, 'team.db')}: no database; this build: up to 1 (migrations from ${dir}, MT_SCHEMA_DIR)`);
  });

  it('is database: unknown when the settings are refused, and the check then fails at the same error', async () => {
    fx = await serviceFake({ config: 'workspace: [not, a, path\n' });
    fx.install();
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^database: unknown \(.*config\.yaml/);
    expect(r.err).toMatch(/config\.yaml/);
  });

  it('is printed when the import of the gateway fails, which fails the check', async () => {
    fx = await serviceFake();
    fx.install();
    database(3);
    fx.modules[join(fx.checkout, 'dist', 'index.js')] = new SyntaxError("Unexpected token '?'");
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out[0]).toBe(`database: ${join(fx.mtHome, 'team.db')} at version 3; this build: up to ${TOP}`);
    expect(r.err).toBe(`mt: the gateway's modules do not load from ${join(fx.checkout, 'dist', 'index.js')}: Unexpected token '?'`);
  });

  it('is printed when the native module fails to load, and the refusal names the npm ci to run, by its paths', async () => {
    fx = await serviceFake();
    fx.install();
    writeFileSync(join(fx.root, 'node bin', 'npm'), '#!/bin/sh\n', { mode: 0o755 });
    fx.modules[join(fx.checkout, 'dist', 'db', 'open.js')] = {
      openDb: () => {
        throw new Error('was compiled against a different Node.js version using NODE_MODULE_VERSION 131');
      },
    };
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^database: /);
    expect(r.err).toBe(
      `mt: better-sqlite3's native module does not load under ${fx.node}: was compiled against a different Node.js version using NODE_MODULE_VERSION 131. ` +
        `Build it for this node by hand: cd '${fx.checkout}' && PATH='${join(fx.root, 'node bin')}':"$PATH" '${join(fx.root, 'node bin', 'npm')}' ci`,
    );
  });
});
```

In `tests/mt-service.test.ts`, replace:

```ts
    expect(r.err).toMatch(/mt service <install\|uninstall\|start\|stop\|restart\|status\|logs>/);
```

with:

```ts
    expect(r.err).toMatch(/mt service <install\|uninstall\|start\|stop\|restart\|status\|logs\|check>/);
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-service-check.test.ts tests/mt-service.test.ts`. Expected: `Tests  12 failed | 46 passed (58)`: `mt service <...>: unknown command check`, and the usage test still lists seven subcommands.

- [ ] **Step 4.3: Implement.**

In `src/cli/service.ts`, replace:

```ts
import { AGENT_ENV_PREFIX, ConfigError, GATEWAY_ENV_NAMES, loadConfig, loadTeamSettings, type Env } from '../config.js';
```

with:

```ts
import { pathToFileURL } from 'node:url';
import {
  AGENT_ENV_PREFIX,
  BUNDLED_SCHEMA_DIR,
  ConfigError,
  GATEWAY_ENV_NAMES,
  loadConfig,
  loadTeamSettings,
  schemaDirOf,
  type Env,
} from '../config.js';
import { highestMigration, openDbReadOnly } from '../db/open.js';
```

In `src/cli/service.ts`, replace:

```ts
import { lockHolder, privateDir } from '../kanban/socket.js';
import { loadTeam } from '../team.js';
```

with:

```ts
import { lockHolder, privateDir } from '../kanban/socket.js';
import { redactKnownSecrets } from '../secrets.js';
import { loadTeam } from '../team.js';
```

In `src/cli/service.ts`, replace:

```ts
import type { MtIo } from './mt.js';
```

with:

```ts
import type { MtIo } from './mt.js';
import { findNpm, npmCommand, shQuote } from './shell.js';
```

In `src/cli/service.ts`, replace:

```ts
  sleep: (ms: number) => Promise<void>;
}
```

with:

```ts
  sleep: (ms: number) => Promise<void>;
  /**
   * Imports a module of the build by its path: `mt service check` loads the
   * gateway's graph this way (spec §20.5). Injectable so a test gives modules
   * of its own; the real one is `import()`.
   */
  importModule?: (file: string) => Promise<Record<string, unknown>>;
}

/** `import()` of a file by its path. */
export async function importFile(file: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}
```

In `src/cli/service.ts`, replace:

```ts
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
```

with:

```ts
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    importModule: importFile,
  };
```

In `src/cli/service.ts`, replace:

```ts
  '  mt service logs [-f] [-n <lines>]',
].join('\n');
```

with:

```ts
  '  mt service logs [-f] [-n <lines>]',
  '  mt service check',
].join('\n');
```

In `src/cli/service.ts`, replace:

```ts
const SUBCOMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'] as const;
```

with:

```ts
const SUBCOMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'check'] as const;
```

In `src/cli/service.ts`, replace:

```ts
        return await svc.stop();
      default:
```

with:

```ts
        return await svc.stop();
      case 'check':
        return await svc.check();
      default:
```

In `src/cli/service.ts`, replace:

```ts
class CommandFailed extends Error {}
```

with:

```ts
class CommandFailed extends Error {}

/** An error's message, or the value as text. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `database: <path> at version 8; this build: up to 9` (spec §20.5): the
 * database the gateway would open, found from `env` by the settings alone, its
 * `user_version` read read-only, and the highest migration of the directory the
 * gateway reads them from, named when it is not this build's own. Never throws:
 * settings that are refused, or an environment that could not be read, given as
 * the error, give `database: unknown (<error>)`.
 */
export function versionLine(env: Env | Error): string {
  try {
    if (env instanceof Error) throw env;
    const settings = loadTeamSettings(env, undefined, { unsetPassEnv: [] });
    const dir = schemaDirOf(env);
    const build = `this build: up to ${highestMigration(dir)}${dir === BUNDLED_SCHEMA_DIR ? '' : ` (migrations from ${dir}, MT_SCHEMA_DIR)`}`;
    const db = openDbReadOnly(settings.dbPath);
    if (db === undefined) return `database: ${settings.dbPath}: no database; ${build}`;
    try {
      return `database: ${settings.dbPath} at version ${Number(db.pragma('user_version', { simple: true }))}; ${build}`;
    } finally {
      db.close();
    }
  } catch (err) {
    return `database: unknown (${errorText(err)})`;
  }
}
```

In `src/cli/service.ts`, replace:

```ts
  async uninstall(): Promise<number> {
```

with:

```ts
  /**
   * `mt service check` (spec §20.5): whether this build would start as the
   * service, without installing; what `mt update` runs, in the new build, as
   * its preflight. First the database's version line, whatever the rest finds;
   * then install's check of the configuration, with the PATH the unit records;
   * last, the gateway's modules and better-sqlite3's native one, loaded.
   */
  async check(): Promise<number> {
    const { t, io, deps } = this;
    const recorded = this.recorded();
    if (!this.installed()) throw new CommandFailed(`not installed: ${t.file} does not exist`);
    const path = recorded?.path ?? io.env['PATH'] ?? '';
    let env: Env | Error;
    try {
      env = { HOME: deps.home, PATH: path, MT_HOME: t.mtHome, ...readGatewayEnv({ MT_HOME: t.mtHome }).values };
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      env = err;
    }
    io.out(redactKnownSecrets(versionLine(env)));
    if (recorded === undefined) {
      throw new CommandFailed(`${t.file} was not written by mt service install; run mt service install to write it again`);
    }
    io.out(`checking as ${t.name} starts it: with PATH ${recorded.path}, MT_HOME ${t.mtHome} and ${join(t.mtHome, '.env')}`);
    const file = this.gatewayEnv();
    const checked = this.checkEnvironment(file, recorded.path);
    for (const warning of checked.warnings) io.out(`warning: ${warning}`);
    if (checked.problem !== undefined) {
      throw new CommandFailed(
        `the gateway would not start as the service, which has only PATH, MT_HOME and ${file.path}: ${checked.problem}`,
      );
    }
    await this.loadModules();
    io.out(`ok: this build would start as ${t.name}`);
    return 0;
  }

  /**
   * The gateway's whole module graph, imported from this build's dist/index.js,
   * which starts nothing; and an in-memory database, which loads better-sqlite3's
   * native module. Dynamic, so a broken graph fails the check, not mt itself.
   * Answers the imported index, for its loadStartup.
   */
  private async loadModules(): Promise<Record<string, unknown>> {
    const { deps } = this;
    const importModule = deps.importModule ?? importFile;
    const index = join(deps.checkout, 'dist', 'index.js');
    let gateway: Record<string, unknown>;
    try {
      gateway = await importModule(index);
    } catch (err) {
      throw new CommandFailed(`the gateway's modules do not load from ${index}: ${errorText(err)}`);
    }
    try {
      const open = await importModule(join(deps.checkout, 'dist', 'db', 'open.js'));
      const openDb = open['openDb'];
      if (typeof openDb !== 'function') throw new Error('dist/db/open.js has no openDb');
      (openDb(':memory:') as { close(): void }).close();
    } catch (err) {
      const npm = findNpm(deps.node, this.io.env['PATH']) ?? 'npm';
      throw new CommandFailed(
        `better-sqlite3's native module does not load under ${deps.node}: ${errorText(err)}. ` +
          `Build it for this node by hand: cd ${shQuote(deps.checkout)} && ${npmCommand(deps.node, npm, 'ci')}`,
      );
    }
    return gateway;
  }

  async uninstall(): Promise<number> {
```

Create `src/cli/shell.ts`:

```ts
import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

/**
 * Commands printed for a person to type, and the npm they name (spec §20.4,
 * §20.9): every path quoted as `install.sh` quotes one, and node and npm named
 * by their paths, never a bare `npm` or `mt`, which in another shell would be
 * another node's, or another home's or checkout's launcher.
 */

/** A word for sh, as install.sh's `quote` writes one: in single quotes, each `'` as `'\''`. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The npm beside `node`, else the first on `path`, as an absolute path; undefined when there is none. */
export function findNpm(node: string, path: string | undefined): string | undefined {
  const beside = join(dirname(node), 'npm');
  if (executable(beside)) return beside;
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    if (executable(join(dir, 'npm'))) return join(dir, 'npm');
  }
  return undefined;
}

/** `PATH='<node's directory>':"$PATH"`, put before a command so it, and what it starts, run that node. */
export function withNodeFirst(node: string): string {
  return `PATH=${shQuote(dirname(node))}:"$PATH"`;
}

/** `'<node>' '<checkout>/dist/mt.js'`, with the node's directory first on PATH: `mt` as every printed block names it. */
export function mtCommand(node: string, checkout: string): string {
  return `${withNodeFirst(node)} ${shQuote(node)} ${shQuote(join(checkout, 'dist', 'mt.js'))}`;
}

/** `'<npm>' <args>`, with the node's directory first on PATH. */
export function npmCommand(node: string, npm: string, args: string): string {
  return `${withNodeFirst(node)} ${shQuote(npm)} ${args}`;
}
```

In `src/config.ts`, replace:

```ts
const BUNDLED_SCHEMA_DIR = fileURLToPath(new URL('../schema', import.meta.url));
```

with:

```ts
export const BUNDLED_SCHEMA_DIR = fileURLToPath(new URL('../schema', import.meta.url));

/** Where the gateway reads its migrations: `MT_SCHEMA_DIR` when `env` sets it, else this build's own. What `loadConfig` gives as `schemaDir`. */
export function schemaDirOf(env: Env): string {
  return envString(env, 'MT_SCHEMA_DIR') ?? BUNDLED_SCHEMA_DIR;
}
```

In `src/config.ts`, replace:

```ts
    schemaDir: envString(env, 'MT_SCHEMA_DIR') ?? BUNDLED_SCHEMA_DIR,
```

with:

```ts
    schemaDir: schemaDirOf(env),
```

- [ ] **Step 4.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1802 passed (1802)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 4.5: Commit.**

```bash
git add src/cli/service.ts src/cli/shell.ts src/config.ts tests/helpers/service.ts tests/mt-service-check.test.ts tests/mt-service.test.ts
git commit -m "Add mt service check, which prints the database's version first, runs install's check of the configuration with the PATH the unit records, and loads the gateway's modules and the native module"
```

---

### Task 5: `mt service check` with no unit: a gateway started by hand

**Files:**

- Modify: `src/cli/service.ts`, `tests/mt-service-check.test.ts`

Spec §20.5. With no unit, `gatewayEnv` and `checkEnvironment` are not run, and no `.env` is required. In order: the version line, over this shell over the `.env`; `loadTeamSettings` and `loadTeam` with `unsetPassEnv`, a `ConfigError` failing there; the module load, whose `dist/index.js` gives `loadStartup`; then `loadStartup` on a copy of this shell's environment, a stand-in filling each name unset or empty in the merged one, each passEnv name so recorded and `LARK_APP_SECRET`, each with its note. The stand-in is `(unset here)`, registered as a secret (see "Where the code forced a reading"). The home is the one `mt service` finds, set as `MT_HOME`.

- [ ] **Step 5.1: Write the tests.**

In `tests/mt-service-check.test.ts`, replace:

```ts
import { clearSecrets } from '../src/secrets.js';
```

with:

```ts
import { MASK, clearSecrets, redactKnownSecrets } from '../src/secrets.js';
```

In `tests/mt-service-check.test.ts`, replace:

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

describe('mt service check with no unit installed: a gateway started by hand', () => {
  it('needs no .env, and runs neither of install\'s checks of it', async () => {
    fx = await serviceFake({ env: false });
    const r = await check({ LARK_APP_SECRET: SECRET, LARK_APP_ID: 'cli_shell', MT_ALLOW_TALK: 'ou_a' });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `database: ${join(fx.mtHome, 'team.db')}: no database; this build: up to ${TOP}`,
      `checking as a gateway started by hand from this shell, over ${join(fx.mtHome, '.env')}: no service is installed`,
      'ok: this build would start as a gateway started by hand from this shell',
    ]);
    expect(fx.imports).toEqual([join(fx.checkout, 'dist', 'index.js'), join(fx.checkout, 'dist', 'db', 'open.js')]);
  });

  it('fails at a ConfigError from the settings or the team, before loadStartup and before any import', async () => {
    fx = await serviceFake();
    const role = join(fx.mtHome, 'roles', 'broken');
    mkdirSync(role, { recursive: true });
    writeFileSync(join(role, 'config.yaml'), 'agent:\n  driver: nonsense\n');
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/^database: /);
    expect(r.err).toMatch(/^mt: the gateway would not start: .*agent\.driver must be one of/);
    expect(fx.imports).toEqual([]);
  });

  it("fails at loadStartup's ConfigError, from the build's own dist/index.js", async () => {
    fx = await serviceFake({ config: `workspace: /tmp\nagent:\n  driver: acp\n  command: claude-agent-acp\n` });
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: the gateway would not start: an owner is required/);
    expect(fx.imports).toEqual([join(fx.checkout, 'dist', 'index.js'), join(fx.checkout, 'dist', 'db', 'open.js')]);
  });

  it('fills a stand-in, with its note, for each unset passEnv name and an unset or empty secret, masked', async () => {
    fx = await serviceFake({ env: 'LARK_APP_ID=cli_test\n' });
    writeFileSync(join(fx.mtHome, 'config.yaml'), serviceConfig(join(fx.root, 'repo'), '  passEnv: [GH_TOKEN, SET_HERE]\n'));
    let seen: Record<string, string | undefined> | undefined;
    const real = await import('../src/index.js');
    fx.modules[join(fx.checkout, 'dist', 'index.js')] = {
      loadStartup: (env: Record<string, string | undefined>) => {
        seen = env;
        return real.loadStartup(env);
      },
    };
    const r = await check({ SET_HERE: 'from the shell', LARK_APP_SECRET: '   ' });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith('note: '))).toEqual([
      'note: GH_TOKEN is not set here: the gateway will need it from the shell that starts it',
      'note: LARK_APP_SECRET is not set here: the gateway will need it from the shell that starts it',
    ]);
    expect(seen?.['GH_TOKEN']).toBe('(unset here)');
    expect(seen?.['LARK_APP_SECRET']).toBe('(unset here)');
    expect(seen?.['SET_HERE']).toBe('from the shell');
    expect(redactKnownSecrets('a (unset here) b')).toBe(`a ${MASK} b`);
  });

  it('never fills a value the .env sets', async () => {
    fx = await serviceFake();
    let seen: Record<string, string | undefined> | undefined;
    const real = await import('../src/index.js');
    fx.modules[join(fx.checkout, 'dist', 'index.js')] = {
      loadStartup: (env: Record<string, string | undefined>) => {
        seen = env;
        return real.loadStartup(env);
      },
    };
    const r = await check();
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith('note: '))).toEqual([]);
    // The copy is this shell's; loadStartup reads the .env itself.
    expect(seen?.['LARK_APP_SECRET']).toBeUndefined();
  });

  it('prints the version line from this shell over the .env, with a database', async () => {
    fx = await serviceFake();
    const db = database(4);
    const r = await check();
    expect(r.out[0]).toBe(`database: ${db} at version 4; this build: up to ${TOP}`);
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-service-check.test.ts`. Expected: `Tests  6 failed | 11 passed (17)`: with no unit, `mt service check` refuses as not installed.

- [ ] **Step 5.3: Implement.**

In `src/cli/service.ts`, replace:

```ts
import { readGatewayEnv, type GatewayEnvFile } from '../gateway-env.js';
```

with:

```ts
import { gatewayEnvPath, loadGatewayEnv, readGatewayEnv, type GatewayEnvFile } from '../gateway-env.js';
```

In `src/cli/service.ts`, replace:

```ts
import { redactKnownSecrets } from '../secrets.js';
```

with:

```ts
import { addSecrets, redactKnownSecrets } from '../secrets.js';
```

In `src/cli/service.ts`, replace:

```ts
class CommandFailed extends Error {}
```

with:

```ts
class CommandFailed extends Error {}

/**
 * What a name left unset is given for `loadStartup`, when a gateway started by
 * hand is checked. Registered as a secret, so it is masked like one; at least
 * MIN_SECRET_LENGTH long, as a shorter value is never masked.
 */
const STAND_IN = '(unset here)';
```

In `src/cli/service.ts`, replace:

```ts
    const { t, io, deps } = this;
    const recorded = this.recorded();
```

with:

```ts
    const { t, io, deps } = this;
    if (!this.installed()) return await this.checkByHand();
    const recorded = this.recorded();
```

In `src/cli/service.ts`, replace:

```ts
    if (!this.installed()) throw new CommandFailed(`not installed: ${t.file} does not exist`);
    const path = recorded?.path ?? io.env['PATH'] ?? '';
```

with:

```ts
    const path = recorded?.path ?? io.env['PATH'] ?? '';
```

In `src/cli/service.ts`, replace:

```ts
    io.out(`ok: this build would start as ${t.name}`);
    return 0;
```

with:

```ts
    io.out(`ok: this build would start as ${t.name}`);
    return 0;
  }

  /**
   * With no unit installed, a gateway started by hand from this shell is
   * checked (spec §20.5): no .env is required, as such a gateway may take its
   * secret from the shell. `mt role check`'s loads, over this shell's
   * environment over the .env, collecting the passEnv names left unset; then
   * the startup's own `loadStartup`, from the build's dist/index.js, on a copy
   * of this shell's environment in which a stand-in fills only what is unset
   * or empty in the merged one: each such passEnv name, and the Lark secret.
   */
  private async checkByHand(): Promise<number> {
    const { io, t } = this;
    // The home as this command found it, which is where such a gateway would look.
    const shell: Env = { ...io.env, MT_HOME: t.mtHome };
    let merged: Env | Error;
    try {
      merged = loadGatewayEnv(shell).env;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      merged = err;
    }
    io.out(redactKnownSecrets(versionLine(merged)));
    if (merged instanceof Error) throw new CommandFailed(merged.message);
    io.out(`checking as a gateway started by hand from this shell, over ${gatewayEnvPath(shell)}: no service is installed`);
    const unset: string[] = [];
    try {
      const settings = loadTeamSettings(merged, undefined, { unsetPassEnv: unset });
      loadTeam(settings, merged, { unsetPassEnv: unset });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      throw new CommandFailed(`the gateway would not start: ${err.message}`);
    }
    const gateway = await this.loadModules();
    const loadStartup = gateway['loadStartup'];
    if (typeof loadStartup !== 'function') throw new CommandFailed("the build's dist/index.js has no loadStartup");

    const copy: Record<string, string | undefined> = { ...shell };
    const blank = (name: string): boolean => (merged[name] ?? '').trim() === '';
    const filled = [...new Set(unset.map((entry) => entry.split(': ')[1] ?? ''))].filter(blank);
    if (blank('LARK_APP_SECRET')) filled.push('LARK_APP_SECRET');
    addSecrets([STAND_IN]);
    for (const name of filled) {
      copy[name] = STAND_IN;
      io.out(`note: ${name} is not set here: the gateway will need it from the shell that starts it`);
    }
    try {
      loadStartup(copy);
    } catch (err) {
      throw new CommandFailed(`the gateway would not start: ${errorText(err)}`);
    }
    io.out('ok: this build would start as a gateway started by hand from this shell');
    return 0;
```

- [ ] **Step 5.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1808 passed (1808)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add src/cli/service.ts tests/mt-service-check.test.ts
git commit -m "Check a gateway started by hand in mt service check when no unit is installed, with role check's loads and the startup's own loadStartup, stand-ins filling only names left unset"
```

---

### Task 6: The backup

**Files:**

- Create: `src/db/backup.ts`, `tests/update-backup.test.ts`
- Modify: `src/db/WRITERS.md`

Spec §20.8. `src/db/backup.ts`, a `db/` module since it writes a database file. `backupDatabase` creates `.<name>.partial` 0600 with `wx`, runs better-sqlite3's `backup()` with a progress of `0x7fffffff`, every page in one step, sets the copy's `journal_mode = DELETE`, requires `quick_check` to say `ok` and the copy's `user_version` to be the one given, and renames it into place; on failure it removes the `.partial` and its journal, `-wal` and `-shm`. `pruneBackups` keeps the five newest of the database's name pattern, by the time in the name, and the newest of each version besides, and removes any `.partial` left behind. The update makes `backups/` with `privateDir` (Task 10). WRITERS.md gains the backup's row.

- [ ] **Step 6.1: Write the tests.**

Create `tests/update-backup.test.ts`:

```ts
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupError, backupDatabase, backupName, pruneBackups } from '../src/db/backup.js';
import { migrate, openDb, openDbReadOnly, type Db } from '../src/db/open.js';
import { SCHEMA_DIR } from './helpers/db.js';

/**
 * The backup before an update's restart (spec §20.8): its name, owner-only
 * through a `.partial`, one whole file in journal mode DELETE, checked, and the
 * backups kept. A real WAL database, read through a read-only connection, as
 * the update reads the gateway's.
 */

let root: string;
let dir: string;
let dbPath: string;
let writer: Db;
let reader: Db;
const AT = new Date('2026-11-12T15:30:00.000Z');
const SHA = '8b64aa1f00000000000000000000000000000000';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mt-backup-'));
  dir = join(root, 'backups');
  mkdirSync(dir, { mode: 0o700 });
  dbPath = join(root, 'team.db');
  writer = openDb(dbPath);
  migrate(writer, SCHEMA_DIR);
  writer.exec("CREATE TABLE IF NOT EXISTS backup_probe (n INTEGER); INSERT INTO backup_probe VALUES (1), (2), (3);");
  reader = openDbReadOnly(dbPath) as Db;
});
afterEach(() => {
  reader.close();
  writer.close();
  rmSync(root, { recursive: true, force: true });
});

const version = (): number => Number(writer.pragma('user_version', { simple: true }));

describe('backupName', () => {
  it("is the database's name, its version, the old commit and the UTC time with no colon", () => {
    expect(backupName('/home/x/.manus-team/team.db', 8, SHA, AT)).toBe('team-v8-8b64aa1-20261112T153000Z.db');
    expect(backupName('/data/other.db', 12, 'abcdef0123', AT)).toBe('other-v12-abcdef0-20261112T153000Z.db');
  });
});

describe('backupDatabase', () => {
  it('copies the database whole, owner-only, in journal mode DELETE, leaving no .partial', async () => {
    const { path } = await backupDatabase(reader, { dir, dbPath, version: version(), sha: SHA, at: AT });
    expect(path).toBe(join(dir, `team-v${version()}-8b64aa1-20261112T153000Z.db`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([`team-v${version()}-8b64aa1-20261112T153000Z.db`]);
    const copy = new Database(path, { readonly: true });
    try {
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(Number(copy.pragma('user_version', { simple: true }))).toBe(version());
      expect(copy.prepare('SELECT count(*) AS n FROM backup_probe').get()).toEqual({ n: 3 });
    } finally {
      copy.close();
    }
  });

  it('holds what is committed in the WAL, not yet checkpointed', async () => {
    writer.exec('INSERT INTO backup_probe VALUES (4)');
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    const { path } = await backupDatabase(reader, { dir, dbPath, version: version(), sha: SHA, at: AT });
    const copy = new Database(path, { readonly: true });
    try {
      expect(copy.prepare('SELECT count(*) AS n FROM backup_probe').get()).toEqual({ n: 4 });
    } finally {
      copy.close();
    }
  });

  it('fails on a quick_check that is not ok, and removes the .partial and its journal', async () => {
    const failing = backupDatabase(reader, {
      dir,
      dbPath,
      version: version(),
      sha: SHA,
      at: AT,
      quickCheck: () => {
        writeFileSync(join(dir, `.${backupName(dbPath, version(), SHA, AT)}.partial-journal`), '');
        return '*** in database main ***\nPage 7: btreeInitPage() returns error code 11';
      },
    });
    await expect(failing).rejects.toThrow(BackupError);
    await expect(failing).rejects.toThrow(/quick_check says: \*\*\* in database main/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("fails on a copy whose user_version is not the update's, and leaves nothing", async () => {
    await expect(backupDatabase(reader, { dir, dbPath, version: version() - 1, sha: SHA, at: AT })).rejects.toThrow(
      `the copy is at schema version ${version()}, not ${version() - 1}: the database moved during the backup`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("never takes another's .partial", async () => {
    const theirs = join(dir, `.${backupName(dbPath, version(), SHA, AT)}.partial`);
    writeFileSync(theirs, 'not ours');
    await expect(backupDatabase(reader, { dir, dbPath, version: version(), sha: SHA, at: AT })).rejects.toThrow(/EEXIST/);
    expect(existsSync(theirs)).toBe(true);
  });
});

describe('pruneBackups', () => {
  it('keeps the five newest and the newest of each version, removes the rest and any .partial, and touches nothing else', () => {
    const names = [
      'team-v6-aaaaaaa-20261101T000000Z.db',
      'team-v7-bbbbbbb-20261102T000000Z.db',
      'team-v7-ccccccc-20261103T000000Z.db',
      ...[4, 5, 6, 7, 8, 9, 10, 11].map((d) => `team-v8-ddddddd-202611${String(d).padStart(2, '0')}T000000Z.db`),
    ];
    const others = ['notes.txt', 'other-v8-eeeeeee-20261101T000000Z.db', 'team.db', 'team-v8-latest.db'];
    const leftovers = ['.team-v8-fffffff-20261112T000000Z.db.partial', '.team-v8-fffffff-20261112T000000Z.db.partial-journal'];
    for (const name of [...names, ...others, ...leftovers]) writeFileSync(join(dir, name), '');
    expect(pruneBackups(dir, dbPath)).toEqual(
      [
        'team-v7-bbbbbbb-20261102T000000Z.db',
        'team-v8-ddddddd-20261104T000000Z.db',
        'team-v8-ddddddd-20261105T000000Z.db',
        'team-v8-ddddddd-20261106T000000Z.db',
        ...leftovers,
      ].sort(),
    );
    expect(readdirSync(dir).sort()).toEqual(
      [
        'team-v6-aaaaaaa-20261101T000000Z.db',
        'team-v7-ccccccc-20261103T000000Z.db',
        ...[7, 8, 9, 10, 11].map((d) => `team-v8-ddddddd-202611${String(d).padStart(2, '0')}T000000Z.db`),
        ...others,
      ].sort(),
    );
  });

  it('runs after each backup', async () => {
    for (const d of [1, 2, 3, 4, 5, 6]) writeFileSync(join(dir, `team-v${version()}-aaaaaaa-2026110${d}T000000Z.db`), '');
    const { removed } = await backupDatabase(reader, { dir, dbPath, version: version(), sha: SHA, at: AT });
    expect(removed).toEqual([`team-v${version()}-aaaaaaa-20261101T000000Z.db`, `team-v${version()}-aaaaaaa-20261102T000000Z.db`]);
  });
});
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/update-backup.test.ts`. Expected: `Tests  no tests`: `Cannot find module '../src/db/backup.js'`.

- [ ] **Step 6.3: Implement.**

In `src/db/WRITERS.md`, replace:

```markdown
| `schema_version`, `user_version` | `db/open.ts` (`migrate`) | Migration files own the `schema_version` row contents; the runner owns `user_version`, and refuses a database above its highest file (spec §20.6). |
```

with:

```markdown
| `schema_version`, `user_version` | `db/open.ts` (`migrate`) | Migration files own the `schema_version` row contents; the runner owns `user_version`, and refuses a database above its highest file (spec §20.6). |
| a backup, `$MT_HOME/backups/<db>-v<N>-<sha>-<time>.db` | `db/backup.ts` | Written whole by `backupDatabase`, SQLite's online backup from `mt update`'s read-only connection to the gateway's database, which it never writes; then only its own copy's journal mode is set (spec §20.8). `pruneBackups` removes the older ones. |
```

Create `src/db/backup.ts`:

```ts
import Database from 'better-sqlite3';
import { chmodSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Db } from './open.js';

/**
 * The database's backup before an update's restart (spec §20.8): SQLite's
 * online backup, in one step, from a read-only connection while the gateway
 * runs, to `<dir>/<db>-v<version>-<old short sha>-<UTC time>.db`.
 *
 * In one step, so the copy is one read transaction: in WAL mode, a consistent
 * snapshot of every committed transaction, which the gateway's writes never
 * restart and never wait on. Written owner-only through a `.partial`, created
 * 0600 before the backup opens it, then checked (`quick_check`, and the version
 * the update recorded) and renamed into place. The copy is one whole file, its
 * journal mode DELETE, so opening it later gives it no `-wal` or `-shm`.
 *
 * The source is only read. The copy is the only file written, and nothing in
 * the gateway's database changes.
 */

/** The UTC time with no colon, which some file systems and scp refuse: `20261112T153000Z`. */
export function backupStamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll('-', '').replaceAll(':', '');
}

/** The database file's name less `.db`: `team` for `team.db`. */
function baseName(dbPath: string): string {
  return basename(dbPath).replace(/\.db$/, '');
}

/** `team-v8-8b64aa1-20261112T153000Z.db`. */
export function backupName(dbPath: string, version: number, sha: string, at: Date): string {
  return `${baseName(dbPath)}-v${version}-${sha.slice(0, 7)}-${backupStamp(at)}.db`;
}

/** How many of a database's backups are kept, newest first, besides the newest of each version. */
export const BACKUPS_KEPT = 5;

/** A backup that was taken but is not good: its check failed. */
export class BackupError extends Error {}

export interface BackupOptions {
  /** The directory, made owner-only by the caller. */
  dir: string;
  /** The database's path, for the backup's name. */
  dbPath: string;
  /** The `user_version` the copy must have: the one the update recorded. */
  version: number;
  /** The commit the checkout was on. */
  sha: string;
  at: Date;
  /** The copy's integrity check; `PRAGMA quick_check` unless a test says otherwise. */
  quickCheck?: (copy: Db) => string;
}

/**
 * Back `source` up into `opts.dir`, check the copy, and prune the older
 * backups. Answers the backup's path and the files removed. Throws, leaving no
 * `.partial` or journal of its own, when the copy fails or its check does.
 */
export async function backupDatabase(source: Db, opts: BackupOptions): Promise<{ path: string; removed: string[] }> {
  const name = backupName(opts.dbPath, opts.version, opts.sha, opts.at);
  const path = join(opts.dir, name);
  const partial = join(opts.dir, `.${name}.partial`);
  // Before the backup opens it, so it never exists with the umask's mode. `wx`: never another's.
  writeFileSync(partial, '', { flag: 'wx', mode: 0o600 });
  try {
    chmodSync(partial, 0o600);
    // Every remaining page in one step: better-sqlite3 takes the callback's number of pages per step.
    await source.backup(partial, { progress: () => 0x7fffffff });
    const copy = new Database(partial);
    try {
      copy.pragma('journal_mode = DELETE');
      const checked = (opts.quickCheck ?? ((db: Db) => String(db.pragma('quick_check', { simple: true }))))(copy);
      if (checked !== 'ok') throw new BackupError(`the copy's quick_check says: ${checked}`);
      const version = Number(copy.pragma('user_version', { simple: true }));
      if (version !== opts.version) {
        throw new BackupError(`the copy is at schema version ${version}, not ${opts.version}: the database moved during the backup`);
      }
    } finally {
      copy.close();
    }
    renameSync(partial, path);
  } catch (err) {
    for (const leftover of ['', '-journal', '-wal', '-shm']) rmSync(`${partial}${leftover}`, { force: true });
    throw err;
  }
  return { path, removed: pruneBackups(opts.dir, opts.dbPath) };
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Keep the BACKUPS_KEPT newest backups of this database's name, by the time in
 * their name, and the newest of each version besides; remove the rest, and any
 * `.partial` an update that died left. Nothing else in `dir` is touched.
 * Answers the names removed.
 */
export function pruneBackups(dir: string, dbPath: string): string[] {
  const base = escape(baseName(dbPath));
  const backup = new RegExp(`^${base}-v([0-9]+)-[0-9a-f]+-([0-9]{8}T[0-9]{6}Z)\\.db$`);
  const partial = new RegExp(`^\\.${base}-v[0-9]+-[0-9a-f]+-[0-9]{8}T[0-9]{6}Z\\.db\\.partial(-journal|-wal|-shm)?$`);
  const backups: { name: string; version: string; stamp: string }[] = [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const m = backup.exec(name);
    if (m !== null) backups.push({ name, version: m[1] ?? '', stamp: m[2] ?? '' });
    else if (partial.test(name)) removed.push(name);
  }
  backups.sort((a, b) => (a.stamp === b.stamp ? b.name.localeCompare(a.name) : b.stamp.localeCompare(a.stamp)));
  const kept = new Set(backups.slice(0, BACKUPS_KEPT).map((b) => b.name));
  const versions = new Set<string>();
  for (const b of backups) {
    // The newest of each version: a backup is the way back only for the build of its schema.
    if (!versions.has(b.version)) kept.add(b.name);
    versions.add(b.version);
  }
  for (const b of backups) if (!kept.has(b.name)) removed.push(b.name);
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed.sort();
}
```

- [ ] **Step 6.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1816 passed (1816)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.5: Commit.**

```bash
git add src/db/WRITERS.md src/db/backup.ts tests/update-backup.test.ts
git commit -m "Back the database up by SQLite's online backup in one step, owner-only through a partial file, checked, in journal mode DELETE, and keep the five newest and the newest of each version"
```

---

### Task 7: The update's locks

**Files:**

- Create: `src/cli/update-lock.ts`, `tests/update-lock.test.ts`

Spec §20.10. `UpdateLock.take` writes the state to a staging file, synced, and links it into place, as `lockGateway` does, and answers what a lock already there holds instead, never removing it; `write` rewrites it by staging and rename; `release` removes it while it names this process. `readUpdateLock` refuses a symlink and answers undefined for a file that holds no update's state.

- [ ] **Step 7.1: Write the tests.**

Create `tests/update-lock.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateLock, readUpdateLock, type UpdateLockState } from '../src/cli/update-lock.js';

/**
 * `mt update`'s locks (spec §20.10): taken atomically by link, holding one JSON
 * line, rewritten whole by their holder, removed only by it, and never cleared
 * automatically, however dead the pid they name.
 */

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-update-lock-'));
  path = join(dir, 'update.pid');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const STATE: UpdateLockState = { pid: 4321, home: '/h', checkout: '/c', step: 'check' };

function take(state: UpdateLockState = STATE): UpdateLock {
  const lock = UpdateLock.take(path, state);
  if (!(lock instanceof UpdateLock)) throw new Error('not taken');
  return lock;
}

describe('UpdateLock', () => {
  it('is taken with one JSON line, owner-only, and leaves no staging file', () => {
    take();
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(STATE)}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['update.pid']);
  });

  it('is refused while held, answering what it holds, and never removed, even for a dead pid', () => {
    writeFileSync(path, `${JSON.stringify({ ...STATE, pid: 999999, step: 'build', old: 'a', new: 'b' })}\n`);
    const second = UpdateLock.take(path, { ...STATE, pid: 1 });
    expect(second).toEqual({ held: { ...STATE, pid: 999999, step: 'build', old: 'a', new: 'b' } });
    expect(readUpdateLock(path)?.pid).toBe(999999);
    expect(readdirSync(dir)).toEqual(['update.pid']);
  });

  it('answers held undefined for a file that holds no update', () => {
    writeFileSync(path, 'garbage\n');
    expect(UpdateLock.take(path, STATE)).toEqual({ held: undefined });
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a symlink in its place', () => {
    symlinkSync(join(dir, 'elsewhere'), path);
    writeFileSync(join(dir, 'elsewhere'), JSON.stringify(STATE));
    expect(() => UpdateLock.take(path, STATE)).toThrow(/is not a file of its own \(a symlink\)/);
  });

  it('is rewritten whole before each step by its holder, and removed by it', () => {
    const lock = take();
    lock.write({ ...STATE, step: 'backup', backup: '/h/backups/team-v8.db', servicePid: 4242, userVersion: 8 });
    expect(readUpdateLock(path)).toEqual({ ...STATE, step: 'backup', backup: '/h/backups/team-v8.db', servicePid: 4242, userVersion: 8 });
    expect(readdirSync(dir)).toEqual(['update.pid']);
    lock.release();
    expect(existsSync(path)).toBe(false);
    lock.release();
  });

  it('is not removed by a holder whose pid it no longer names', () => {
    const lock = take();
    writeFileSync(path, `${JSON.stringify({ ...STATE, pid: 77 })}\n`);
    lock.release();
    expect(readUpdateLock(path)?.pid).toBe(77);
  });
});
```

- [ ] **Step 7.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/update-lock.test.ts`. Expected: `Tests  no tests`: `Cannot find module '../src/cli/update-lock.js'`.

- [ ] **Step 7.3: Implement.**

Create `src/cli/update-lock.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * `mt update`'s two locks (spec §20.10): one per checkout,
 * `<git dir>/mt-update.lock`, and one per home, `$MT_HOME/run/update.pid`.
 *
 * Each is taken as `lockGateway` takes the gateway's: written whole to a
 * staging file beside it and linked into place, which fails if one is there.
 * It holds one JSON line, what the update has recorded, rewritten by staging
 * and rename before each step begins, so it never names a step older than what
 * was done. Removed by its holder only. A lock left by an update that died is
 * never cleared automatically: two processes clearing one at once could each
 * remove the other's fresh lock, and an update that died needs a person anyway.
 */

/** The step an update is at, as its lock names it. Up to `show`, it has changed nothing. */
export type UpdateStep =
  | 'check'
  | 'show'
  | 'merge'
  | 'npm ci'
  | 'build'
  | 'preflight'
  | 'backup'
  | 'restart'
  | 'confirm'
  | 'going back';

/** The steps after which nothing has changed: step 3 or before. */
export const UNCHANGED_STEPS: readonly UpdateStep[] = ['check', 'show'];

export interface UpdateLockState {
  /** The update's own pid. */
  pid: number;
  home: string;
  checkout: string;
  step: UpdateStep;
  /** The commit the branch was on, and the upstream's. */
  old?: string | undefined;
  new?: string | undefined;
  /** The service's pid at step 3; null when it was not running. */
  servicePid?: number | null | undefined;
  /** The database's `user_version` at step 3; null when there was no database. */
  userVersion?: number | null | undefined;
  /** The database's path. */
  db?: string | undefined;
  /** The backup, once taken. */
  backup?: string | undefined;
}

/** What a lock file holds, or undefined for one that holds no update's state. Refuses what is not a file of its own. */
export function readUpdateLock(path: string): UpdateLockState | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw new Error(`${path} is not a file of its own (a symlink); refusing to use it as the update lock`);
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a file of its own; refusing to use it as the update lock`);
    const buf = Buffer.alloc(64 * 1024);
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8').trim();
    try {
      const value = JSON.parse(text) as Partial<UpdateLockState>;
      if (typeof value.pid !== 'number' || typeof value.step !== 'string') return undefined;
      return value as UpdateLockState;
    } catch {
      return undefined;
    }
  } finally {
    closeSync(fd);
  }
}

/** The state written whole to a new staging file beside `path`, and synced, so the link or rename puts a whole file in place. */
function staged(path: string, state: UpdateLockState): string {
  const staging = join(dirname(path), `.${basename(path)}-${randomUUID()}`);
  const fd = openSync(staging, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return staging;
}

export class UpdateLock {
  private released = false;

  private constructor(
    readonly path: string,
    private readonly pid: number,
  ) {}

  /**
   * Take the lock at `path`, holding `state`; or, when it is there already,
   * what it holds: `held` undefined for a file that holds no update's state.
   * Never removes one that is there.
   */
  static take(path: string, state: UpdateLockState): UpdateLock | { held: UpdateLockState | undefined } {
    const staging = staged(path, state);
    try {
      linkSync(staging, path);
      return new UpdateLock(path, state.pid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return { held: readUpdateLock(path) };
    } finally {
      rmSync(staging, { force: true });
    }
  }

  /** Rewrite it whole, by staging and rename: only its holder does. */
  write(state: UpdateLockState): void {
    if (this.released) return;
    const staging = staged(this.path, state);
    try {
      renameSync(staging, this.path);
    } finally {
      rmSync(staging, { force: true });
    }
  }

  /** Remove it, if it still names this process. */
  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      if (readUpdateLock(this.path)?.pid === this.pid) unlinkSync(this.path);
    } catch {
      // Gone already, or not ours: nothing of ours is left.
    }
  }
}
```

- [ ] **Step 7.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1822 passed (1822)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.5: Commit.**

```bash
git add src/cli/update-lock.ts tests/update-lock.test.ts
git commit -m "Add the update's locks, taken by link, rewritten whole by their holder, and never cleared automatically"
```

---

### Task 8: The printed steps

**Files:**

- Create: `src/cli/update-advice.ts`, `tests/update-advice.test.ts`

Spec §20.6, §20.7 and §20.9. `stepsBack`, `stepsForward` and `finishByHand`, as lists of command lines: mt as `PATH='<node dir>':"$PATH" '<node>' '<checkout>/dist/mt.js'`, npm by its path with the same `PATH`, every path quoted as `install.sh` quotes one, `export MT_HOME='<home>'` first when the home is not the default, and, with no service, the restart of a gateway run by hand split around the restore. With `checkVersion`, the steps back read the version again after the stop, and go on when the check prints `at version N`, `database: unknown (...)`, or nothing. The tests also cover `shQuote` and `findNpm` (Task 4).

- [ ] **Step 8.1: Write the tests.**

Create `tests/update-advice.test.ts`:

```ts
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findNpm, shQuote } from '../src/cli/shell.js';
import { finishByHand, stepsBack, stepsForward, type AdvicePaths } from '../src/cli/update-advice.js';

/**
 * The blocks mt update prints for a person (spec §20.6, §20.7, §20.9): mt and
 * npm named by their paths, quoted, the node's directory first on PATH, and the
 * home exported when it is not the default.
 */

const P: AdvicePaths = {
  node: "/opt/node 22/bin/node",
  npm: "/opt/node 22/bin/npm",
  checkout: "/src/it's here",
  home: '/srv/team home',
  homeSet: true,
  db: '/srv/team home/team.db',
  service: true,
};
const MT = `PATH='/opt/node 22/bin':"$PATH" '/opt/node 22/bin/node' '/src/it'\\''s here/dist/mt.js'`;
const NPM = `PATH='/opt/node 22/bin':"$PATH" '/opt/node 22/bin/npm'`;

describe('shQuote', () => {
  it("quotes as install.sh does, a single quote as '\\''", () => {
    expect(shQuote("a b'c")).toBe(`'a b'\\''c'`);
  });
});

describe('findNpm', () => {
  it('takes the npm beside the node, else the first on PATH, else none', () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-npm-'));
    try {
      for (const d of ['node', 'path1', 'path2']) mkdirSync(join(root, d));
      const write = (path: string): void => {
        writeFileSync(path, '#!/bin/sh\n');
        chmodSync(path, 0o755);
      };
      write(join(root, 'path2', 'npm'));
      const path = `${join(root, 'path1')}:relative:${join(root, 'path2')}`;
      expect(findNpm(join(root, 'node', 'node'), path)).toBe(join(root, 'path2', 'npm'));
      write(join(root, 'node', 'npm'));
      expect(findNpm(join(root, 'node', 'node'), path)).toBe(join(root, 'node', 'npm'));
      expect(findNpm(join(root, 'path1', 'node'), join(root, 'path1'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the steps back', () => {
  it('stop the service, go back, build, restore the backup over the database, and start it', () => {
    expect(stepsBack(P, { old: '8b64aa1', backup: '/srv/team home/backups/team-v8-8b64aa1-20261112T153000Z.db' })).toEqual([
      "export MT_HOME='/srv/team home'",
      `${MT} service stop`,
      `cd '/src/it'\\''s here'`,
      'git reset --keep 8b64aa1',
      `${NPM} ci && ${NPM} run build`,
      "rm -f '/srv/team home/team.db-wal' '/srv/team home/team.db-shm'",
      "cp '/srv/team home/backups/team-v8-8b64aa1-20261112T153000Z.db' '/srv/team home/team.db'",
      `${MT} service start`,
    ]);
  });

  it('leave the restore out with no backup, and the export with the default home', () => {
    expect(stepsBack({ ...P, homeSet: false }, { old: '8b64aa1', backup: undefined })).toEqual([
      `${MT} service stop`,
      `cd '/src/it'\\''s here'`,
      'git reset --keep 8b64aa1',
      `${NPM} ci && ${NPM} run build`,
      `${MT} service start`,
    ]);
  });

  it('read the version again after the stop, when the service started again on its own', () => {
    const lines = stepsBack(P, { old: '8b64aa1', backup: undefined, checkVersion: 8 });
    expect(lines[3]).toBe(
      `${MT} service check  # it should print "at version 8": if it does, or prints "database: unknown (...)", or nothing, go on; ` +
        'if it prints another version, follow the steps forward instead',
    );
    expect(lines[2]).toBe(`cd '/src/it'\\''s here'`);
  });

  it('split the restart of a gateway run by hand around the restore', () => {
    expect(stepsBack({ ...P, service: false }, { old: '8b64aa1', backup: '/b.db' })).toEqual([
      "export MT_HOME='/srv/team home'",
      '# stop the gateway, if it runs',
      `cd '/src/it'\\''s here'`,
      'git reset --keep 8b64aa1',
      `${NPM} ci && ${NPM} run build`,
      "rm -f '/srv/team home/team.db-wal' '/srv/team home/team.db-shm'",
      "cp '/b.db' '/srv/team home/team.db'",
      '# then start it',
    ]);
  });
});

describe('the steps forward', () => {
  it('make the new tree whole, check it and restart the service', () => {
    expect(stepsForward(P)).toEqual([
      "export MT_HOME='/srv/team home'",
      `cd '/src/it'\\''s here'`,
      `${NPM} ci && ${NPM} run build`,
      `${MT} service check`,
      `${MT} service restart`,
    ]);
  });

  it('say to restart a gateway run by hand', () => {
    expect(stepsForward({ ...P, service: false, homeSet: false }).slice(-1)).toEqual(['# restart the gateway (stop it if it runs, then start it)']);
  });
});

describe('the commands to finish by hand', () => {
  it('build in the checkout, with the reset when it is what failed', () => {
    expect(finishByHand(P, { reset: undefined })).toEqual(["export MT_HOME='/srv/team home'", `cd '/src/it'\\''s here' && ${NPM} ci && ${NPM} run build`]);
    expect(finishByHand({ ...P, homeSet: false }, { reset: '8b64aa1' })).toEqual([
      `cd '/src/it'\\''s here' && git reset --keep 8b64aa1 && ${NPM} ci && ${NPM} run build`,
    ]);
  });
});
```

- [ ] **Step 8.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/update-advice.test.ts`. Expected: `Tests  no tests`: `Cannot find module '../src/cli/update-advice.js'`.

- [ ] **Step 8.3: Implement.**

Create `src/cli/update-advice.ts`:

```ts
import { mtCommand, npmCommand, shQuote } from './shell.js';

/**
 * The blocks `mt update` prints for a person to type (spec §20.6, §20.7,
 * §20.9): the steps back, the steps forward, and the commands to finish going
 * back by hand. Each names mt as `'<node>' '<checkout>/dist/mt.js'` and npm by
 * its path, with the node's directory first on PATH, every path quoted as
 * install.sh quotes one, and starts with `export MT_HOME='<home>'` when the
 * home is not the default: the service, the home and the database are found
 * from it.
 */

export interface AdvicePaths {
  node: string;
  npm: string;
  checkout: string;
  /** The gateway's home. */
  home: string;
  /** Whether the home is set, not the default: then each block exports it. */
  homeSet: boolean;
  /** The database the gateway opens. */
  db: string;
  /** Whether a service is installed; else a gateway started by hand is restarted by hand. */
  service: boolean;
}

function header(p: AdvicePaths): string[] {
  return p.homeSet ? [`export MT_HOME=${shQuote(p.home)}`] : [];
}

const build = (p: AdvicePaths): string => `${npmCommand(p.node, p.npm, 'ci')} && ${npmCommand(p.node, p.npm, 'run build')}`;

/**
 * The steps back (spec §20.9): stop the gateway, the old commit and its build,
 * the backup restored over the database with its `-wal` and `-shm` removed,
 * and start it. With no backup the restore is left out. With `checkVersion`,
 * when the service started again on its own during the update, a check after
 * the stop reads the database's version again before anything goes back.
 */
export function stepsBack(p: AdvicePaths, opts: { old: string; backup: string | undefined; checkVersion?: number | null }): string[] {
  const mt = mtCommand(p.node, p.checkout);
  const check =
    opts.checkVersion === undefined
      ? []
      : [
          `${mt} service check  # it should print ${opts.checkVersion === null ? '"no database"' : `"at version ${opts.checkVersion}"`}: ` +
            'if it does, or prints "database: unknown (...)", or nothing, go on; if it prints another version, follow the steps forward instead',
        ];
  const restore = opts.backup === undefined ? [] : [`rm -f ${shQuote(`${p.db}-wal`)} ${shQuote(`${p.db}-shm`)}`, `cp ${shQuote(opts.backup)} ${shQuote(p.db)}`];
  return [
    ...header(p),
    p.service ? `${mt} service stop` : '# stop the gateway, if it runs',
    `cd ${shQuote(p.checkout)}`,
    ...check,
    `git reset --keep ${opts.old}`,
    build(p),
    ...restore,
    p.service ? `${mt} service start` : '# then start it',
  ];
}

/** The steps forward (spec §20.6): the new tree made whole, checked, and started. */
export function stepsForward(p: AdvicePaths): string[] {
  const mt = mtCommand(p.node, p.checkout);
  return [
    ...header(p),
    `cd ${shQuote(p.checkout)}`,
    build(p),
    `${mt} service check`,
    p.service ? `${mt} service restart` : '# restart the gateway (stop it if it runs, then start it)',
  ];
}

/** The commands to finish going back by hand (spec §20.7), the reset among them when it is what failed. */
export function finishByHand(p: AdvicePaths, opts: { reset: string | undefined }): string[] {
  return [
    ...header(p),
    `cd ${shQuote(p.checkout)}${opts.reset === undefined ? '' : ` && git reset --keep ${opts.reset}`} && ${build(p)}`,
  ];
}
```

- [ ] **Step 8.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1831 passed (1831)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 8.5: Commit.**

```bash
git add src/cli/update-advice.ts tests/update-advice.test.ts
git commit -m "Write the steps back, the steps forward and the commands to finish by hand, naming node, npm and mt by their paths, quoted"
```

---

### Task 9: `mt update --check`: steps 1 to 3

**Files:**

- Create: `src/cli/update.ts`, `tests/helpers/update.ts`, `tests/mt-update-check.test.ts`, `tests/mt-update-show.test.ts`, `tests/update-run.test.ts`
- Modify: `src/cli/mt.ts`, `src/cli/service.ts`, `src/db/kanban-read.ts`

Spec §20.1 to §20.3, §20.10 and §20.11's runner. `src/cli/update.ts`: `UpdateDeps`, `LIMITS`, `runDetached` (a session of its own, no stdin, the group killed at its limit or an abort, and its pipes let go a second after the SIGKILL), `runSyncDetached` and `realUpdateDeps`, and the `Update` class's first two steps. `inspect` (step 2): the checkout is the top of its worktree; the two locks, the checkout's first; the unit, its checkout (by `realpath`), its node, its state, another gateway on the home; a branch with an upstream; clean, with no operation under way; the fetch, in batch mode; an ancestor of the upstream; up to date; no ignored file at an added path. `show` (step 3): the commits, the migrations, the database found as the gateway would find it, the `MT_SCHEMA_DIR` warning, `npm ci`, the open runs and the service's line, recorded in the locks. `mt.ts` reaches it as `mt update`, refused in a board run's shell, and `service.ts` exports `serviceView`. This task's command takes only `--check`; Task 10 adds `--yes` and the question. `tests/helpers/update.ts` is the fake git and npm, over Task 4's fake service.

- [ ] **Step 9.1: Write the tests.**

Create `tests/helpers/update.ts`:

```ts
import { appendFileSync, chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMt } from '../../src/cli/mt.js';
import type { UpdateDeps, UpdateRunOptions, UpdateRunResult } from '../../src/cli/update.js';
import { migrate, openDb } from '../../src/db/open.js';
import { SCHEMA_DIR } from './db.js';
import { serviceFake, type ServiceFake } from './service.js';

/**
 * `mt update` over a fake git, a fake npm and a fake service: every git, npm
 * and child node call is recorded and answered from `repo`, a model of the
 * checkout and its upstream, and none is run. The service is `serviceFake`'s,
 * whose gateway writes its two startup lines to the log at each start. Nothing
 * reaches the network, the real service or the real home.
 */

export const OLD = '8b64aa1c0ffee00000000000000000000000000a';
export const NEW = '4f0c2de0000000000000000000000000000000b';
export const SCHEMA_FILES = readdirSync(SCHEMA_DIR).filter((f) => /^[0-9]+_.*\.sql$/.test(f)).sort();
export const TOP = SCHEMA_FILES.length;

/** The checkout and its upstream, as git would answer for them. */
export interface Repo {
  /** What `git rev-parse --show-toplevel` answers; undefined for a directory that is no git checkout. */
  top: string | undefined;
  gitDir: string;
  /** Undefined: a detached HEAD. */
  branch: string | undefined;
  /** Undefined: no upstream. */
  upstream: string | undefined;
  remote: string;
  status: string[];
  head: string;
  upstreamSha: string;
  /** Whether HEAD is an ancestor of the upstream. */
  ancestor: boolean;
  /** `git log --oneline HEAD..<upstream>`. */
  commits: string[];
  /** The paths the incoming commits add, and those under schema/ they change. */
  added: string[];
  modified: string[];
  /** `git ls-tree --name-only <upstream> schema/`. */
  tree: string[];
  depsChanged: boolean;
  sshCommand: boolean;
}

export interface Run {
  cmd: string;
  args: string[];
  opts: UpdateRunOptions;
}

export interface UpdateFake extends ServiceFake {
  repo: Repo;
  /** Every git, npm and node call, in order. */
  runs: Run[];
  /** An answer for a call, ahead of the fake's own; undefined to let the fake answer. */
  answer: (run: Run) => Partial<UpdateRunResult> | undefined;
  npm: string;
  dbPath: string;
  /** The questions asked, and the answers to give, in order. */
  asked: string[];
  replies: string[];
  /** Called while the question is asked, and at each sleep of the wait for the gateway. */
  whileAsking: () => void;
  whileSleeping: () => void;
  /** The handler mt update gave onSignal, while it is set. */
  signal: ((signal: NodeJS.Signals) => void) | undefined;
  slept: number;
  /** The words of each git, npm and node call: `git fetch origin`, `npm ci`, `node check`. */
  ran(): string[];
  update(argv: string[], opts?: { env?: Record<string, string | undefined>; tty?: boolean; platform?: NodeJS.Platform; out?: (line: string) => void }): Promise<{ code: number; out: string; err: string }>;
}

/** The gateway's two startup lines, as src/index.ts writes them. */
export function startupLines(version: number, dbPath: string): string {
  return `2026-11-12T15:31:00.000Z schema at version ${version} (${dbPath})\n2026-11-12T15:31:02.000Z connected as ou_bot\n`;
}

/**
 * A service installed and running (pid 4242) on a home whose database is at
 * this build's version, a checkout on main tracking origin/main, clean, three
 * commits behind, none adding a migration, the dependencies unchanged.
 */
export async function updateFake(opts: { env?: string | false; config?: string; service?: 'running' | 'stopped' | 'none'; db?: boolean } = {}): Promise<UpdateFake> {
  const svc = await serviceFake(opts);
  const gitDir = join(svc.root, 'git dir');
  mkdirSync(gitDir);
  mkdirSync(join(svc.checkout, 'node_modules'));
  writeFileSync(join(svc.checkout, 'node_modules', '.package-lock.json'), '{}');
  const npm = join(svc.root, 'node bin', 'npm');
  writeFileSync(npm, '#!/bin/sh\n');
  chmodSync(npm, 0o755);
  const dbPath = join(svc.mtHome, 'team.db');
  if (opts.db !== false) {
    const db = openDb(dbPath);
    migrate(db, SCHEMA_DIR);
    db.close();
  }
  const service = opts.service ?? 'running';
  if (service !== 'none') svc.install();
  if (service === 'running') svc.job.pid = 4242;
  mkdirSync(join(svc.mtHome, 'logs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(svc.mtHome, 'logs', 'gateway.log'), '2026-11-12T09:00:00.000Z connected as ou_bot\n', { mode: 0o600 });

  const f = svc as UpdateFake;
  f.repo = {
    top: svc.checkout,
    gitDir,
    branch: 'main',
    upstream: 'origin/main',
    remote: 'origin',
    status: [],
    head: OLD,
    upstreamSha: NEW,
    ancestor: true,
    commits: ['4f0c2de Add the third thing', '91aa310 Say the second thing', '2c7d001 Take the first thing'],
    added: [],
    modified: [],
    tree: SCHEMA_FILES.map((name) => `schema/${name}`),
    depsChanged: false,
    sshCommand: false,
  };
  f.runs = [];
  f.answer = () => undefined;
  f.npm = npm;
  f.dbPath = dbPath;
  f.asked = [];
  f.replies = [];
  f.signal = undefined;
  f.whileAsking = () => {};
  f.whileSleeping = () => {};
  f.slept = 0;
  f.onStart = () => appendFileSync(join(svc.mtHome, 'logs', 'gateway.log'), startupLines(TOP, dbPath));
  f.ran = () =>
    f.runs.map((r) => {
      if (r.cmd === npm) return ['npm', ...r.args].join(' ');
      if (r.cmd === svc.node) return `node ${r.args.slice(1).join(' ')}`;
      return [r.cmd, ...r.args].join(' ');
    });

  const ok = (stdout = ''): UpdateRunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
  const fail = (code: number, stderr: string): UpdateRunResult => ({ code, stdout: '', stderr, timedOut: false });
  const git = (args: string[]): UpdateRunResult => {
    const { repo } = f;
    const words = args.join(' ');
    if (words === 'rev-parse --show-toplevel') return repo.top === undefined ? fail(128, 'fatal: not a git repository') : ok(`${repo.top}\n`);
    if (words === 'rev-parse --absolute-git-dir') return ok(`${repo.gitDir}\n`);
    if (words === 'symbolic-ref --quiet --short HEAD') return repo.branch === undefined ? fail(1, '') : ok(`${repo.branch}\n`);
    if (words === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
      return repo.upstream === undefined ? fail(128, `fatal: no upstream configured for branch '${repo.branch}'`) : ok(`${repo.upstream}\n`);
    }
    if (words.startsWith('config --get branch.')) return ok(`${repo.remote}\n`);
    if (words === 'config --get core.sshCommand') return repo.sshCommand ? ok('ssh -i key\n') : fail(1, '');
    if (words === 'status --porcelain --untracked-files=normal') return ok(repo.status.map((l) => `${l}\n`).join(''));
    if (args[0] === 'rev-parse' && args[1] === '--git-path') {
      return ok(args.filter((_, i) => i % 2 === 0 && i > 0).map((name) => `${join(repo.gitDir, name)}\n`).join(''));
    }
    if (args[0] === 'fetch') return ok();
    if (words === `rev-parse HEAD ${repo.upstream}`) return ok(`${repo.head}\n${repo.upstreamSha}\n`);
    if (words === 'rev-parse HEAD') return ok(`${repo.head}\n`);
    if (args[0] === 'merge-base') return repo.ancestor ? ok() : fail(1, '');
    if (words === `diff --name-only --diff-filter=A HEAD ${repo.upstream}`) return ok(repo.added.map((p) => `${p}\n`).join(''));
    if (words === `diff --name-only --diff-filter=M HEAD ${repo.upstream} -- schema/`) return ok(repo.modified.map((p) => `${p}\n`).join(''));
    if (args[0] === 'log') return ok(repo.commits.map((c) => `${c}\n`).join(''));
    if (args[0] === 'ls-tree') return ok(repo.tree.map((p) => `${p}\n`).join(''));
    if (args[0] === 'diff' && args[1] === '--quiet') return repo.depsChanged ? fail(1, '') : ok();
    if (args[0] === 'merge') {
      repo.head = repo.upstreamSha;
      return ok('Fast-forward\n');
    }
    if (args[0] === 'reset') {
      repo.head = args[2] ?? repo.head;
      return ok();
    }
    if (words === 'status') return ok('On branch main\nnothing to commit, working tree clean\n');
    return fail(1, `the fake git does not know: git ${words}`);
  };

  const deps = (platform: NodeJS.Platform): UpdateDeps => ({
    run: async (cmd, args, runOpts) => {
      const run = { cmd, args: [...args], opts: runOpts };
      f.runs.push(run);
      const over = f.answer(run);
      if (over !== undefined) return { ...ok(), ...over };
      if (cmd === 'git') return git([...args]);
      if (cmd === npm && args[0] === 'ci') {
        writeFileSync(join(svc.checkout, 'node_modules', '.package-lock.json'), '{}');
        return ok('added 120 packages\n');
      }
      if (cmd === npm) return ok('> tsc -p tsconfig.build.json\n');
      if (cmd === svc.node) return ok(`database: ${dbPath} at version ${TOP}; this build: up to ${TOP}\nok: this build would start\n`);
      return fail(127, `the fake does not know: ${cmd}`);
    },
    ask: async (question, signal) => {
      f.asked.push(question);
      f.whileAsking();
      if (signal.aborted) throw new Error('The operation was aborted');
      return f.replies.shift() ?? '';
    },
    now: () => new Date('2026-11-12T15:30:00.000Z'),
    sleep: async (ms) => {
      f.slept += ms;
      f.whileSleeping();
    },
    onSignal: (handler) => {
      f.signal = handler;
      return () => {
        f.signal = undefined;
      };
    },
    guardOutput: () => {},
    pid: 999_999_001,
    alive: (pid) => f.alive.has(pid),
    service: svc.deps(platform),
  });

  f.update = async (argv, o = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const updateDeps = deps(o.platform ?? 'darwin');
    const code = await runMt(['update', ...argv], {
      env: { PATH: '/usr/bin:/bin', HOME: svc.home, ...o.env },
      out: o.out ?? ((line) => out.push(line)),
      err: (line) => err.push(line),
      stdinIsTTY: o.tty ?? false,
      service: updateDeps.service,
      update: updateDeps,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return f;
}
```

Create `tests/mt-update-check.test.ts`:

```ts
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets } from '../src/secrets.js';
import { updateFake, type UpdateFake } from './helpers/update.js';

/**
 * `mt update`'s first step (spec §20.2): every refusal before anything
 * changes, each exit 1 with no merge, and the locks left as they were found.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

describe('mt update refuses before anything changes', () => {
  it('in a board run shell, before looking at anything', async () => {
    fx = await updateFake();
    const r = await fx.update(['--check'], { env: { MT_KANBAN_RUN: 'r_1' } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: mt update is an operator's command, not a board run's/);
    expect(fx.runs).toEqual([]);
  });

  it('a wrong command line, exit 2', async () => {
    fx = await updateFake();
    expect((await fx.update(['--check', '--yes'])).code).toBe(2);
    expect((await fx.update(['now'])).code).toBe(2);
    expect((await fx.update(['--force'])).code).toBe(2);
    expect(fx.runs).toEqual([]);
  });

  it('a checkout that is no git checkout, as one from a tarball', async () => {
    fx = await updateFake();
    fx.repo.top = undefined;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is not a git checkout, so there is nothing to update it from/);
  });

  it('a checkout that is not the top of its worktree', async () => {
    fx = await updateFake();
    fx.repo.top = fx.root;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`is not the top of a git worktree (${fx.root} is)`);
  });

  it('a service that runs another checkout, naming both', async () => {
    fx = await updateFake();
    const other = join(fx.root, 'other checkout');
    mkdirSync(other);
    fx.install({ checkout: other });
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`the service runs ${other}, and this mt is ${fx.checkout}'s`);
    expect(r.err).toContain('mt service install');
  });

  it('a service on the same checkout by another path, which it is', async () => {
    fx = await updateFake();
    const link = join(fx.root, 'link to checkout');
    symlinkSync(fx.checkout, link);
    fx.install({ checkout: link });
    expect((await fx.update(['--check'])).code).toBe(0);
  });

  it('a unit that mt service install did not write', async () => {
    fx = await updateFake();
    writeFileSync(fx.install(), '<plist>by hand</plist>\n');
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/was not written by mt service install.*run mt service install to write it again/);
  });

  it("a service whose node is gone", async () => {
    fx = await updateFake();
    rmSync(fx.node);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`the node the service runs, ${fx.node}, is gone`);
  });

  it('a service state that cannot be read on macOS, never taken as stopped', async () => {
    fx = await updateFake();
    fx.job.loaded = false;
    fx.domain = false;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the service's state cannot be read, and is not taken as stopped: launchctl print gui\/501 failed.*console/);
  });

  it('a service state that cannot be read on Linux', async () => {
    fx = await updateFake();
    fx.install({ platform: 'linux' });
    fx.override = (c) => (c.cmd === 'systemctl' && c.args[1] === 'show' ? { code: 1, stderr: 'Failed to connect to bus: No medium found' } : undefined);
    const r = await fx.update(['--check'], { platform: 'linux' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/cannot be read.*Failed to connect to bus.*loginctl enable-linger/);
  });

  it('another gateway holding the home, not the service', async () => {
    fx = await updateFake();
    mkdirSync(join(fx.mtHome, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'gateway.pid'), '777\n');
    fx.alive.add(777);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/a gateway \(pid 777\) is running on .*, not as the service; perhaps npm run dev/);
  });

  it('a gateway holding the home with no service installed, as tsx watch would restart at the merge', async () => {
    fx = await updateFake({ service: 'none' });
    mkdirSync(join(fx.mtHome, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'gateway.pid'), '778\n');
    fx.alive.add(778);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/a gateway \(pid 778\) is running on .* with no service installed.*tsx watch/);
  });

  it('a detached HEAD', async () => {
    fx = await updateFake();
    fx.repo.branch = undefined;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/has a detached HEAD/);
  });

  it('a branch with no upstream, naming the command to set it, never guessing one', async () => {
    fx = await updateFake();
    fx.repo.branch = 'task/k_1';
    fx.repo.upstream = undefined;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('task/k_1 has no upstream to update from. Name the one it tracks, once: git branch --set-upstream-to=origin/task/k_1');
    expect(fx.ran().some((w) => w.startsWith('git fetch'))).toBe(false);
  });

  it('a change to a tracked file, a staged one, and an untracked file', async () => {
    fx = await updateFake();
    fx.repo.status = [' M src/index.ts', 'A  notes.md', '?? scratch.txt'];
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toBe(`mt: ${fx.checkout} is not clean; commit, stash or remove these first:\n   M src/index.ts\n  A  notes.md\n  ?? scratch.txt`);
    expect(fx.ran()).toContain('git status --porcelain --untracked-files=normal');
  });

  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    it(`an operation under way that status may not show: ${name}`, async () => {
      fx = await updateFake();
      writeFileSync(join(fx.repo.gitDir, name), '');
      const r = await fx.update(['--check']);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`an operation is under way in ${fx.checkout} (${name})`);
    });
  }

  it('a failed fetch, with what git said, and nothing changed', async () => {
    fx = await updateFake();
    fx.answer = (run) => (run.args[0] === 'fetch' ? { code: 128, stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' } : undefined);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/git fetch origin failed \(exit 128\): .*Could not read from remote repository\. Nothing changed\. .*credential helper or an ssh agent/);
  });

  it('a branch that is not an ancestor of its upstream: commits made here, or a force-push', async () => {
    fx = await updateFake();
    fx.repo.ancestor = false;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      'mt: main has commits origin/main does not: made here, or origin/main was rewritten (force-pushed). ' +
        'Joining them is for a person: see git log origin/main..main and git log main..origin/main',
    );
  });

  it('an ignored file at a path the incoming commits add', async () => {
    fx = await updateFake();
    fx.repo.added = ['docs/new.md', 'config.yaml', '.env'];
    writeFileSync(join(fx.checkout, 'config.yaml'), 'mine');
    writeFileSync(join(fx.checkout, '.env'), 'mine');
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the incoming commits add config\.yaml, \.env, already in .* and ignored by git, which would overwrite them in the fast-forward without a word\. Move them aside/);
  });

  it("a home whose run directory is not its own", async () => {
    fx = await updateFake();
    mkdirSync(join(fx.root, 'elsewhere'));
    symlinkSync(join(fx.root, 'elsewhere'), join(fx.mtHome, 'run'));
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/run is not a directory of its own \(a symlink or a file\); refusing to put the update lock there/);
  });

  it('an update under way, by its live pid, from the home lock', async () => {
    fx = await updateFake();
    mkdirSync(join(fx.mtHome, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(join(fx.mtHome, 'run', 'update.pid'), `${JSON.stringify({ pid: 31337, home: fx.mtHome, checkout: fx.checkout, step: 'build' })}\n`);
    fx.alive.add(31337);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`an update (pid 31337) is under way on ${fx.mtHome}, from ${fx.checkout}, at its step build`);
  });

  it("an update under way, from the checkout's lock", async () => {
    fx = await updateFake();
    writeFileSync(join(fx.repo.gitDir, 'mt-update.lock'), `${JSON.stringify({ pid: 31338, home: '/elsewhere', checkout: fx.checkout, step: 'merge' })}\n`);
    fx.alive.add(31338);
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('an update (pid 31338) is under way on /elsewhere');
  });
});

describe("mt update's checks", () => {
  it('run git in the checkout, never prompting, ssh in batch mode', async () => {
    fx = await updateFake();
    await fx.update(['--check']);
    const fetch = fx.runs.find((r) => r.args[0] === 'fetch');
    expect(fetch?.opts).toMatchObject({ cwd: fx.checkout, timeoutMs: 120_000 });
    expect(fetch?.opts.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' });
  });

  it("leave the user's own ssh command alone, from the environment or core.sshCommand", async () => {
    fx = await updateFake();
    await fx.update(['--check'], { env: { GIT_SSH_COMMAND: 'ssh -i mine' } });
    expect(fx.runs.find((r) => r.args[0] === 'fetch')?.opts.env['GIT_SSH_COMMAND']).toBe('ssh -i mine');
    fx.runs = [];
    fx.repo.sshCommand = true;
    await fx.update(['--check']);
    expect(fx.runs.find((r) => r.args[0] === 'fetch')?.opts.env['GIT_SSH_COMMAND']).toBeUndefined();
  });

  it('say so when the branch is up to date, exit 0, and release both locks', async () => {
    fx = await updateFake();
    fx.repo.upstreamSha = fx.repo.head;
    const r = await fx.update(['--check']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`manus-team at ${fx.checkout}, on main, tracking origin/main: up to date at 8b64aa1`);
    expect(fx.ran().filter((w) => w.startsWith('git log'))).toEqual([]);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(fx.repo.gitDir, 'mt-update.lock'))).toBe(false);
    expect(existsSync(join(fx.mtHome, 'run', 'update.pid'))).toBe(false);
  });
});
```

Create `tests/mt-update-show.test.ts`:

```ts
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readUpdateLock } from '../src/cli/update-lock.js';
import { openDb } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { ALICE, claimed, newTask } from './helpers/kanban.js';
import { SECRET } from './helpers/service.js';
import { NEW, OLD, TOP, updateFake, type UpdateFake } from './helpers/update.js';

/**
 * `mt update`'s second step (spec §20.3): what it shows before the question,
 * found as the gateway would find it; `--check` stopping there; and the
 * question, asked only at a terminal.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const merged = (): boolean => fx.ran().some((w) => w.startsWith('git merge --ff-only'));

describe('mt update --check', () => {
  it('shows the branch, the commits and the service, records them, and changes nothing', async () => {
    fx = await updateFake();
    let lock: unknown;
    fx.answer = (run) => {
      if (run.args[0] === 'ls-tree') lock = readUpdateLock(join(fx.mtHome, 'run', 'update.pid'));
      return undefined;
    };
    const r = await fx.update(['--check']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toEqual([
      'fetching origin',
      `manus-team at ${fx.checkout}, on main, tracking origin/main`,
      '3 new commits, 8b64aa1..4f0c2de:',
      '  4f0c2de Add the third thing',
      '  91aa310 Say the second thing',
      '  2c7d001 Take the first thing',
      'the service is running (pid 4242) and is restarted',
    ]);
    expect(merged()).toBe(false);
    expect(lock).toMatchObject({ step: 'show', old: OLD, new: NEW });
    expect(fx.asked).toEqual([]);
  });

  it('shows at most 50 commits, then how many more', async () => {
    fx = await updateFake();
    fx.repo.commits = Array.from({ length: 53 }, (_, i) => `${String(i).padStart(7, '0')} Commit ${i}`);
    const out = (await fx.update(['--check'])).out.split('\n');
    expect(out).toContain('53 new commits, 8b64aa1..4f0c2de:');
    expect(out.filter((l) => /^ {2}\d{7} Commit/.test(l))).toHaveLength(50);
    expect(out).toContain('  and 3 more');
  });

  it('says a new migration moves the database, from its version to the new tree\'s highest, with a backup first', async () => {
    fx = await updateFake();
    fx.repo.added = [`schema/${String(TOP + 1).padStart(3, '0')}_example.sql`, 'docs/x.md'];
    fx.repo.tree.push(`schema/${String(TOP + 1).padStart(3, '0')}_example.sql`);
    const r = await fx.update(['--check']);
    expect(r.out).toContain(
      `migration ${String(TOP + 1).padStart(3, '0')}_example.sql is new: the restart moves the database from version ${TOP} to ${TOP + 1}, ` +
        'and a backup is taken first; going back after it needs the backup',
    );
  });

  it('warns of a changed migration, which the runner never runs again', async () => {
    fx = await updateFake();
    fx.repo.modified = ['schema/003_kanban.sql'];
    expect((await fx.update(['--check'])).out).toContain(
      'warning: migration 003_kanban.sql was changed: the runner never runs again one the database has applied',
    );
  });

  it('says npm ci runs when package.json or package-lock.json changed, and when the installed tree is missing', async () => {
    fx = await updateFake();
    expect((await fx.update(['--check'])).out).not.toContain('npm ci');
    fx.repo.depsChanged = true;
    expect((await fx.update(['--check'])).out).toContain('the dependencies changed: npm ci runs');
    expect(fx.ran()).toContain('git diff --quiet HEAD origin/main -- package.json package-lock.json');
    fx.repo.depsChanged = false;
    rmSync(join(fx.checkout, 'node_modules', '.package-lock.json'));
    expect((await fx.update(['--check'])).out).toContain('node_modules/.package-lock.json is missing: npm ci runs');
  });

  it("counts the open agent runs on the service's database, never a person's", async () => {
    fx = await updateFake();
    const db = openDb(fx.dbPath);
    try {
      claimed(db, newTask(db, { workspace: 'web' }).taskId);
      claimed(db, newTask(db, { workspace: 'api' }).taskId);
      claimed(db, newTask(db, { assignee: { kind: 'human', name: ALICE } }).taskId);
    } finally {
      db.close();
    }
    const r = await fx.update(['--check']);
    expect(r.out).toContain('2 agent runs are open: the restart interrupts them, and they are retried as retry_on_crash allows');
  });

  it('says a stopped service is not started, and that the update stops after the backup', async () => {
    fx = await updateFake({ service: 'stopped' });
    const r = await fx.update(['--check']);
    expect(r.out).toContain('the service is stopped, and is not started: the update stops after the backup');
    expect(r.out).not.toContain('is restarted');
  });

  it('says with no service that the gateway is the person\'s to restart, and that with kanban off no lock shows one', async () => {
    fx = await updateFake({ service: 'none' });
    const r = await fx.update(['--check']);
    expect(r.out).toContain('no service is installed: the update stops after the backup, and the gateway is yours to restart');
    expect(r.out).toContain('kanban is off, so a gateway started by hand holds no lock to find: stop one that runs before going on');
  });

  it("finds the database as the service would, never from this shell's MT_DB", async () => {
    fx = await updateFake();
    const elsewhere = join(fx.root, 'elsewhere.db');
    const db = openDb(elsewhere);
    db.pragma('user_version = 3');
    db.close();
    fx.repo.added = ['schema/099_x.sql'];
    fx.repo.tree.push('schema/099_x.sql');
    const r = await fx.update(['--check'], { env: { MT_DB: elsewhere, MT_CONFIG: join(fx.root, 'nowhere.yaml') } });
    expect(r.err).toBe('');
    expect(r.out).toContain(`from version ${TOP} to 99`);
    expect(readUpdateLock(join(fx.mtHome, 'run', 'update.pid'))).toBeUndefined();
  });

  it("finds the database from this shell over the .env with no service, as a gateway started by hand would", async () => {
    fx = await updateFake({ service: 'none' });
    const elsewhere = join(fx.root, 'elsewhere.db');
    const db = openDb(elsewhere);
    db.pragma('user_version = 3');
    db.close();
    fx.repo.added = ['schema/099_x.sql'];
    fx.repo.tree.push('schema/099_x.sql');
    const r = await fx.update(['--check'], { env: { MT_DB: elsewhere } });
    expect(r.out).toContain('from version 3 to 99');
  });

  it('stops at a configuration the running build rejects, with the error', async () => {
    fx = await updateFake();
    writeFileSync(join(fx.mtHome, 'config.yaml'), 'workspace: /tmp\nkanban:\n  a_key_only_the_new_build_knows: 1\n');
    const r = await fx.update(['--check']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: the running build rejects the configuration, so the database cannot be found: .*a_key_only_the_new_build_knows.*undo the edit, update, then make it$/);
  });

  it('warns that MT_SCHEMA_DIR, in the service\'s .env, is not what this report reads', async () => {
    fx = await updateFake({ env: `LARK_APP_SECRET=${SECRET}\nLARK_APP_ID=cli_test\nMT_SCHEMA_DIR=/opt/schema\n` });
    chmodSync(join(fx.mtHome, '.env'), 0o600);
    const r = await fx.update(['--check']);
    expect(r.out).toMatch(/^warning: MT_SCHEMA_DIR is set, to \/opt\/schema: this report and the restart's confirmation assume the bundled schema\//m);
  });

  it('says there is no database for a home whose gateway never started', async () => {
    fx = await updateFake({ db: false });
    fx.repo.added = ['schema/099_x.sql'];
    const r = await fx.update(['--check']);
    expect(r.out).toContain('migration 099_x.sql is new; there is no database yet, so nothing to back up');
  });
});
```

Create `tests/update-run.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { realUpdateDeps, runDetached, runSyncDetached } from '../src/cli/update.js';

/**
 * How mt update runs git and npm (spec §20.11), for real, with sh: in a
 * session of its own with no stdin, its output kept, and its whole process
 * group killed at its time limit or when aborted, SIGTERM then SIGKILL.
 */

const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
const sh = (script: string, timeoutMs = 10_000, signal?: AbortSignal) => runDetached('sh', ['-c', script], { cwd: process.cwd(), env, timeoutMs, signal });

describe('runDetached', () => {
  it('runs in a process group and a session of its own, with no stdin', async () => {
    const r = await sh('echo "$$ $(ps -o pgid= -p $$) $(ps -o sess= -p $$ 2>/dev/null || ps -o sid= -p $$)"; read line; echo "read: $?"');
    expect(r.code).toBe(0);
    const [pid, pgid] = r.stdout.trim().split(/\s+/);
    expect(pgid).toBe(pid);
    expect(r.stdout).toContain('read: 1');
    expect(r.timedOut).toBe(false);
  });

  it('keeps stdout and stderr, and the exit code', async () => {
    expect(await sh('echo out; echo err >&2; exit 3')).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('kills the whole group at its time limit, a child of the command included', async () => {
    const started = Date.now();
    const r = await sh('sleep 30 & wait', 1_500);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(143);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('sends SIGKILL 5 seconds after a SIGTERM that is ignored', async () => {
    const started = Date.now();
    const r = await sh('trap "" TERM; sleep 30', 1_500);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(137);
    expect(Date.now() - started).toBeGreaterThanOrEqual(6_400);
  }, 20_000);

  it('answers a second after the SIGKILL when a process that left the group holds its output', async () => {
    // A grandchild in a session of its own keeps stdout open; it prints its pid first, so the test can end it.
    const leave = `node -e "const c = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); console.log(c.pid); c.unref();"`;
    const started = Date.now();
    const r = await sh(`${leave}; trap "" TERM; sleep 30`, 1_500);
    try {
      expect(r).toMatchObject({ code: 137, timedOut: true });
      expect(Date.now() - started).toBeGreaterThanOrEqual(7_400);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      process.kill(Number(r.stdout.trim()), 'SIGKILL');
    }
  }, 20_000);

  it('kills the group when aborted', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 1_000);
    const r = await sh('sleep 30', 10_000, abort.signal);
    expect(r).toMatchObject({ code: 143, timedOut: false });
  });

  it('answers 127 for a command that is not there', async () => {
    const r = await runDetached('/nonexistent/git', [], { cwd: process.cwd(), env, timeoutMs: 1000 });
    expect(r.code).toBe(127);
  });
});

describe('runSyncDetached', () => {
  it("runs the service's command in a session of its own, waiting for it, with its output and exit code", () => {
    const r = runSyncDetached('sh', ['-c', 'echo "$$ $(ps -o pgid= -p $$)"; echo err >&2; exit 4']);
    expect(r.code).toBe(4);
    const [pid, pgid] = r.stdout.trim().split(/\s+/);
    expect(pgid).toBe(pid);
    expect(r.stderr).toBe('err\n');
  });

  it('answers 127 for a command that is not there', () => {
    expect(runSyncDetached('/nonexistent/launchctl', []).code).toBe(127);
  });
});

describe('the real deps', () => {
  it('listen for SIGINT, SIGHUP and SIGTERM until told to stop', () => {
    const deps = realUpdateDeps();
    const before = ['SIGINT', 'SIGHUP', 'SIGTERM'].map((s) => process.listenerCount(s));
    const seen: string[] = [];
    const off = deps.onSignal((s) => seen.push(s));
    expect(['SIGINT', 'SIGHUP', 'SIGTERM'].map((s) => process.listenerCount(s))).toEqual(before.map((n) => n + 1));
    process.emit('SIGHUP', 'SIGHUP');
    expect(seen).toEqual(['SIGHUP']);
    off();
    expect(['SIGINT', 'SIGHUP', 'SIGTERM'].map((s) => process.listenerCount(s))).toEqual(before);
  });

  it('take EPIPE and EIO on stdout as no failure', () => {
    const deps = realUpdateDeps();
    const streams = [process.stdout, process.stderr];
    const before = streams.map((s) => s.listeners('error'));
    deps.guardOutput();
    try {
      expect(() => process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
      expect(() => process.stderr.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' }))).not.toThrow();
    } finally {
      streams.forEach((s, i) => {
        for (const l of s.listeners('error')) if (!before[i]?.includes(l)) s.off('error', l as (err: Error) => void);
      });
    }
  });
});
```

- [ ] **Step 9.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-update-check.test.ts tests/mt-update-show.test.ts tests/update-run.test.ts`. Expected: `Tests  41 failed | 1 passed (42)`: `unknown command: update`, and `tests/update-run.test.ts` fails to load: `Cannot find module '../src/cli/update.js'`. The one that passes is the wrong command line's exit 2, which an unknown command gives too.

- [ ] **Step 9.3: Implement.**

In `src/cli/mt.ts`, replace:

```ts
import { SERVICE_USAGE, serviceCommand, type ServiceDeps } from './service.js';
import { workspaceAdd, workspaceList } from './workspace.js';
```

with:

```ts
import { SERVICE_USAGE, serviceCommand, type ServiceDeps } from './service.js';
import { updateCommand, type UpdateDeps } from './update.js';
import { workspaceAdd, workspaceList } from './workspace.js';
```

In `src/cli/mt.ts`, replace:

```ts
  service?: ServiceDeps;
}
```

with:

```ts
  service?: ServiceDeps;
  /** git, npm, the terminal and the signals for `mt update`; injectable so no test runs either, or reaches the network or the real service. */
  update?: UpdateDeps;
}
```

In `src/cli/mt.ts`, replace:

```ts
  SERVICE_USAGE,
  '  mt kanban board list [all] [--json]',
```

with:

```ts
  SERVICE_USAGE,
  '  mt update --check',
  '  mt kanban board list [all] [--json]',
```

In `src/cli/mt.ts`, replace:

```ts
/** Exit codes: 0 done, 1 refused or a check failed, 2 the command line was wrong. */
```

with:

```ts
/** Exit codes: 0 done, 1 refused or a check failed, 2 the command line was wrong; `mt update` adds 3, a person is needed. */
```

In `src/cli/mt.ts`, replace:

```ts
    }
    if (group === 'workspace' && command === 'list') {
```

with:

```ts
    }
    if (group === 'update') {
      // As mt service: an agent updating the gateway would end its own run, and every other.
      if (inBoardRun(io.env)) return refuse(io, runShellRefusal('mt update'));
      return await updateCommand(argv.slice(1), io);
    }
    if (group === 'workspace' && command === 'list') {
```

In `src/cli/service.ts`, replace:

```ts
  return { kind: 'systemd', name: names.unit, file: join(deps.home, '.config', 'systemd', 'user', names.unit), ...common };
}
```

with:

```ts
  return { kind: 'systemd', name: names.unit, file: join(deps.home, '.config', 'systemd', 'user', names.unit), ...common };
}

/** What `mt update` needs of the service (spec §20.13): its unit, its state, the home's lock, its environment, its log, and its restart. */
export interface ServiceView {
  readonly kind: 'launchd' | 'systemd';
  readonly name: string;
  /** The plist or the unit file. */
  readonly file: string;
  readonly mtHome: string;
  /** MT_HOME as this shell sets it, or undefined for the default home. */
  readonly mtHomeSet: string | undefined;
  readonly log: string;
  installed(): boolean;
  /** What the unit records, or undefined for a unit `mt service install` did not write, or none. */
  recorded(): Recorded | undefined;
  state(): State;
  /** The pid the gateway lock names, when that process is alive. */
  lockPid(): number | undefined;
  /**
   * The service's environment, as its settings are loaded: HOME, the PATH the
   * unit records, MT_HOME and the gateway's .env. A .env the gateway would
   * refuse is a ConfigError.
   */
  env(recorded: Recorded): Env;
  /** `mt service restart`'s own code: undefined when it restarted, else why not. */
  restart(): Promise<string | undefined>;
}

export function serviceView(io: MtIo, deps: ServiceDeps): ServiceView {
  const t = target(io, deps);
  const svc = new Service(t, deps, io);
  return {
    kind: t.kind,
    name: t.name,
    file: t.file,
    mtHome: t.mtHome,
    mtHomeSet: t.mtHomeSet,
    log: t.log,
    installed: () => svc.installed(),
    recorded: () => svc.recorded(),
    state: () => svc.state(),
    lockPid: () => svc.lockPid(),
    env: (recorded) => ({ HOME: deps.home, PATH: recorded.path, MT_HOME: t.mtHome, ...readGatewayEnv({ MT_HOME: t.mtHome }).values }),
    restart: async () => {
      try {
        return (await svc.start(true)) === 0 ? undefined : 'mt service restart refused, as said above';
      } catch (err) {
        if (err instanceof CommandFailed) return err.message;
        throw err;
      }
    },
  };
}
```

In `src/cli/service.ts`, replace:

```ts
  private installed(): boolean {
```

with:

```ts
  installed(): boolean {
```

In `src/cli/service.ts`, replace:

```ts
  private recorded(): Recorded | undefined {
```

with:

```ts
  recorded(): Recorded | undefined {
```

In `src/cli/service.ts`, replace:

```ts
  private lockPid(): number | undefined {
```

with:

```ts
  lockPid(): number | undefined {
```

Create `src/cli/update.ts`:

```ts
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ConfigError, loadTeamSettings, type Env, type TeamSettings } from '../config.js';
import { hasBoard, openAgentRunCount } from '../db/kanban-read.js';
import { openDbReadOnly, type Db } from '../db/open.js';
import { loadGatewayEnv } from '../gateway-env.js';
import { privateDir } from '../kanban/socket.js';
import { redactKnownSecrets } from '../secrets.js';
import { parse, UsageError } from './args.js';
import type { MtIo } from './mt.js';
import { realServiceDeps, serviceView, type RunResult, type ServiceDeps, type ServiceView } from './service.js';
import { findNpm, shQuote } from './shell.js';
import { UpdateLock, type UpdateLockState, type UpdateStep } from './update-lock.js';

/**
 * `mt update` (spec §20): a deploy in one command. It checks before it
 * changes anything, goes back by itself while going back is safe, keeps the
 * way back once it is not, and says where it stopped.
 *
 * 1. Refused in a board run's shell, by `runMt`.
 * 2. Check: the two locks; the checkout this mt runs from, which the service
 *    must run; the service's state; a branch with an upstream; clean; then
 *    `git fetch`, and the branch an ancestor of its upstream.
 * 3. Show what's coming, record the service's pid and the database's version,
 *    and ask. `--check` stops here.
 * 4. `git merge --ff-only`, `npm ci` when the dependencies changed, the build.
 * 5. The new build's `mt service check`.
 * 6. The backup, once the pid and the version are found unchanged.
 * 7. `mt service restart`'s own code, and up to 60 seconds for `connected as`.
 *
 * Every git, npm and child node call goes through `UpdateDeps.run`, in a
 * process group of its own, so a test gives a fake git and a fake npm, and a
 * fake service through `ServiceDeps`, and nothing reaches the network, the
 * real service or the real home.
 *
 * Exit codes: 0 updated and confirmed, up to date, `--check` done, or stopped
 * after the backup with no service to restart; 1 refused, declined, or failed
 * and gone back; 2 a wrong command line; 3 a person is needed.
 */

export interface UpdateRunOptions {
  cwd: string;
  env: Env;
  /** Past it, the call's process group is killed, SIGTERM then SIGKILL after 5 seconds, and `timedOut` is true. */
  timeoutMs: number;
  /** Aborted to stop the call: its process group is killed as at a timeout. */
  signal?: AbortSignal | undefined;
}

export interface UpdateRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface UpdateDeps {
  /** Runs a command to completion, capturing its output, in a session of its own with no terminal and no stdin. */
  run: (cmd: string, args: readonly string[], opts: UpdateRunOptions) => Promise<UpdateRunResult>;
  /** Asks at the terminal; rejects when `signal` is aborted. */
  ask: (question: string, signal: AbortSignal) => Promise<string>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Calls `handler` at each SIGINT, SIGHUP and SIGTERM until the returned function is called. */
  onSignal: (handler: (signal: NodeJS.Signals) => void) => () => void;
  /** From now on, EPIPE and EIO on stdout and stderr are not a failure (spec §20.11). */
  guardOutput: () => void;
  /** This process's pid, which its locks hold. */
  pid: number;
  /** Whether a process has this pid. */
  alive: (pid: number) => boolean;
  /** The service, the checkout this mt runs from, and its node. */
  service: ServiceDeps;
}

/** How long each call may take (spec §20.11). The calls that run no hook and reach no network get LOCAL_MS. */
export const LIMITS = {
  local: 30_000,
  fetch: 120_000,
  hook: 120_000,
  npmCi: 20 * 60_000,
  build: 10 * 60_000,
  check: 120_000,
} as const;

/** How long a killed group has between SIGTERM and SIGKILL, and after it, before its output is let go. */
const KILL_AFTER_MS = 5_000;
const GONE_AFTER_MS = 1_000;

const COMMITS_SHOWN = 50;

/** The operations under way that `git status` may not show (spec §20.2). */
const OPERATIONS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'] as const;

/** A migration file, as the runner reads one. */
const MIGRATION = /^schema\/([0-9]+)_[^/]*\.sql$/;

/**
 * The real ones: git and npm spawned detached, this terminal, this process's
 * signals. With no `service` given, the service's own: `mt service`'s, but for
 * its launchctl and systemctl calls, each in a session of its own, so a
 * terminal's Ctrl-C cannot stop the restart half way (spec §20.11).
 */
export function realUpdateDeps(given?: ServiceDeps): UpdateDeps {
  const service = given ?? { ...realServiceDeps(), run: runSyncDetached };
  return {
    run: runDetached,
    ask: async (question, signal) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // A Ctrl-C at the prompt reaches readline, not the process: send it on, as any other would arrive.
      rl.on('SIGINT', () => process.kill(process.pid, 'SIGINT'));
      try {
        return await rl.question(question, { signal });
      } finally {
        rl.close();
      }
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    onSignal: (handler) => {
      const names: NodeJS.Signals[] = ['SIGINT', 'SIGHUP', 'SIGTERM'];
      const listeners = names.map((name) => [name, () => handler(name)] as const);
      for (const [name, listener] of listeners) process.on(name, listener);
      return () => {
        for (const [name, listener] of listeners) process.off(name, listener);
      };
    },
    guardOutput: () => {
      for (const stream of [process.stdout, process.stderr]) {
        stream.on('error', (err: NodeJS.ErrnoException) => {
          if (!isClosedOutput(err)) throw err;
        });
      }
    },
    pid: process.pid,
    alive: service.alive,
    service,
  };
}

/**
 * The wrapper `runSyncDetached` runs: the command in a session of its own, its
 * output and exit code passed on, and the terminal's signals ignored, so the
 * wrapper stays to the end too.
 */
const DETACHED_WRAPPER = [
  "const { spawn } = require('node:child_process');",
  "for (const s of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(s, () => {});",
  "const child = spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'inherit' });",
  "child.on('error', (err) => { process.stderr.write(err.message); process.exit(127); });",
  'child.on(\'exit\', (code) => process.exit(code ?? 1));',
].join('\n');

/** `ServiceDeps.run`, synchronous as `mt service`'s, with the command detached from this terminal. */
export function runSyncDetached(cmd: string, args: readonly string[]): RunResult {
  const r = spawnSync(process.execPath, ['-e', DETACHED_WRAPPER, cmd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error !== undefined) return { code: 127, stdout: '', stderr: r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** EPIPE or EIO: a closed terminal or pipe, which never stops an update half way. */
function isClosedOutput(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPIPE' || code === 'EIO';
}

/** Output kept of a call: its last bytes, which is where a failure says why. */
const OUTPUT_KEPT = 256 * 1024;

/**
 * Run `cmd` detached, a session of its own with no controlling terminal and no
 * stdin, so a terminal's Ctrl-C reaches mt alone and nothing it starts can
 * prompt on /dev/tty. At its time limit, or when aborted, its whole process
 * group is sent SIGTERM, and SIGKILL 5 seconds later.
 */
export function runDetached(cmd: string, args: readonly string[], opts: UpdateRunOptions): Promise<UpdateRunResult> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killer: NodeJS.Timeout | undefined;
    const child = spawn(cmd, [...args], { cwd: opts.cwd, env: { ...opts.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (kept: string, more: string): string => (kept + more).slice(-OUTPUT_KEPT);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout = keep(stdout, d)));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = keep(stderr, d)));
    const group = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Gone already.
      }
    };
    const kill = (): void => {
      if (killer !== undefined) return;
      group('SIGTERM');
      killer = setTimeout(() => {
        group('SIGKILL');
        // A process that left the group may hold the pipes open: let them go, and answer with what was said.
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code: 137, stdout, stderr, timedOut });
        }, GONE_AFTER_MS).unref();
      }, KILL_AFTER_MS);
      killer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    timer.unref();
    if (opts.signal?.aborted === true) kill();
    opts.signal?.addEventListener('abort', kill, { once: true });
    const finish = (r: UpdateRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      done(r);
    };
    child.once('error', (err) => finish({ code: 127, stdout, stderr: `${stderr}${err.message}`, timedOut }));
    child.once('close', (code, signal) => {
      const number = signal === null ? 1 : 128 + (osConstants.signals[signal] ?? 0);
      finish({ code: code ?? number, stdout, stderr, timedOut });
    });
  });
}

/** An end to the update: its exit code, and the refusal to print, if any. */
class Stop extends Error {
  constructor(
    readonly code: number,
    readonly refusal: string | undefined,
  ) {
    super(refusal ?? `exit ${code}`);
  }
}

const short = (sha: string | undefined): string => (sha ?? '').slice(0, 7);
const lines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');
const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** `mt update --check`. */
export async function updateCommand(argv: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(argv, { check: { type: 'boolean' } });
  if (positionals.length > 0) throw new UsageError('update takes no arguments');
  if (values.check !== true) throw new UsageError('update takes --check, which shows what is new and changes nothing');
  const deps = io.update ?? realUpdateDeps(io.service);
  return await new Update(io, deps).run();
}

class Update {
  private readonly view: ServiceView;
  private readonly checkout: string;
  private readonly shellEnv: Env;
  private gitEnv: Env;
  private node: string;
  private branch = '';
  private upstream = '';
  private remote = '';
  private old = '';
  private new = '';
  private upToDate = false;
  private installed = false;
  private willRestart = false;
  private servicePid: number | null = null;
  private dbPath = '';
  private db: Db | undefined;
  private version: number | null = null;
  private newest = 0;
  private added: string[] = [];
  private readonly locks: UpdateLock[] = [];
  private lock: UpdateLockState;

  private readonly io: MtIo;

  constructor(
    io: MtIo,
    private readonly deps: UpdateDeps,
  ) {
    this.io = io;
    this.view = serviceView(this.io, deps.service);
    this.checkout = realpathOr(deps.service.checkout);
    this.node = deps.service.node;
    // This shell's, never a board run's, and nothing git or npm starts may prompt.
    const env: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(io.env)) if (!name.startsWith('MT_KANBAN_')) env[name] = value;
    this.shellEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
    this.gitEnv = this.shellEnv;
    this.lock = { pid: deps.pid, home: this.view.mtHome, checkout: this.checkout, step: 'check' };
  }

  // -------------------------------------------------------------------------
  // Output, masked.

  private say(line: string): void {
    this.io.out(redactKnownSecrets(line));
  }

  private sayErr(line: string): void {
    this.io.err(redactKnownSecrets(line));
  }

  private warn(line: string): void {
    this.say(`warning: ${line}`);
  }

  // -------------------------------------------------------------------------
  // The calls.

  private async call(cmd: string, args: readonly string[], timeoutMs: number, env: Env): Promise<{ r: UpdateRunResult; said: string }> {
    const r = await this.deps.run(cmd, args, { cwd: this.checkout, env, timeoutMs });
    return { r, said: (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ').replace(/\.$/, '') };
  }

  private async git(args: readonly string[], timeoutMs: number = LIMITS.local): Promise<UpdateRunResult> {
    return (await this.call('git', args, timeoutMs, this.gitEnv)).r;
  }

  /** git's output, or a refusal: nothing has changed when one of these fails. */
  private async mustGit(args: readonly string[]): Promise<string> {
    const { r, said } = await this.call('git', args, LIMITS.local, this.gitEnv);
    if (r.code !== 0) throw new Stop(1, `git ${args.join(' ')} failed (exit ${r.code})${said === '' ? '' : `: ${said}`}`);
    return r.stdout;
  }

  private writeLock(step: UpdateStep): void {
    this.lock = { ...this.lock, step };
    for (const lock of this.locks) lock.write(this.lock);
  }

  /** Take a lock, after `prepare` makes its directory; a directory or a file not of its own is a refusal. */
  private takeLock(path: string, prepare: () => void = () => {}): void {
    let taken: ReturnType<typeof UpdateLock.take>;
    try {
      prepare();
      taken = UpdateLock.take(path, this.lock);
    } catch (err) {
      throw new Stop(1, err instanceof Error ? err.message : String(err));
    }
    if (taken instanceof UpdateLock) {
      this.locks.push(taken);
      return;
    }
    throw this.heldLock(path, taken.held);
  }

  /** A lock found held: an update under way, or one that died. */
  private heldLock(path: string, held: UpdateLockState | undefined): Stop {
    if (held === undefined) {
      return new Stop(1, `${path} holds no update's state; if no mt update runs, remove it: rm ${shQuote(path)}`);
    }
    if (this.deps.alive(held.pid)) {
      return new Stop(1, `an update (pid ${held.pid}) is under way on ${held.home}, from ${held.checkout}, at its step ${held.step} (${path})`);
    }
    return new Stop(1, `an update (pid ${held.pid}) died at its step ${held.step}; its lock is never cleared by itself: ${path}`);
  }

  // -------------------------------------------------------------------------
  // Step 2: check.

  private async inspect(): Promise<void> {
    const { view, io } = this;
    const platform = this.deps.service.platform;
    if (platform !== 'darwin' && platform !== 'linux') throw new Stop(1, `mt update supports macOS and Linux only, not ${platform}`);
    const top = await this.git(['rev-parse', '--show-toplevel']);
    if (top.code !== 0) {
      throw new Stop(1, `${this.checkout} is not a git checkout, so there is nothing to update it from: ${top.stderr.trim()}`);
    }
    if (realpathOr(top.stdout.trim()) !== this.checkout) {
      throw new Stop(1, `${this.checkout} is not the top of a git worktree (${top.stdout.trim()} is): mt update updates the checkout this mt runs from`);
    }
    const gitDir = (await this.mustGit(['rev-parse', '--absolute-git-dir'])).trim();

    // The unit, and the node the update uses.
    this.installed = view.installed();
    const recorded = view.recorded();
    if (recorded !== undefined) this.node = recorded.node;

    this.takeLock(join(gitDir, 'mt-update.lock'));
    this.takeLock(join(view.mtHome, 'run', 'update.pid'), () => privateDir(join(view.mtHome, 'run'), 'the update lock'));

    if (this.installed) {
      if (recorded === undefined) {
        throw new Stop(1, `${view.file} was not written by mt service install, so what the service runs cannot be read; run mt service install to write it again`);
      }
      if (realpathOr(recorded.checkout) !== this.checkout) {
        throw new Stop(
          1,
          `the service runs ${recorded.checkout}, and this mt is ${this.checkout}'s: updating it would build one tree and restart the service on another. ` +
            `Run mt service install from the checkout to update, or mt update from ${recorded.checkout}`,
        );
      }
      if (!existsSync(recorded.node)) {
        throw new Stop(1, `the node the service runs, ${recorded.node}, is gone; run mt service install again with the node to use`);
      }
      const state = view.state();
      if (state.unreadable !== undefined) {
        const hint =
          view.kind === 'launchd'
            ? 'a LaunchAgent needs someone logged in at the Mac\'s console: log in there, then run this again'
            : "run it where the user's systemd answers: a login session, or with loginctl enable-linger";
        throw new Stop(1, `the service's state cannot be read, and is not taken as stopped: ${state.unreadable}. ${hint}`);
      }
      const holder = view.lockPid();
      if (holder !== undefined && holder !== state.pid) {
        throw new Stop(
          1,
          `a gateway (pid ${holder}) is running on ${view.mtHome}, not as the service; perhaps npm run dev. ` +
            'Stop it first: the restarted service could not take the home',
        );
      }
      this.willRestart = state.running;
      this.servicePid = state.running ? (state.pid ?? null) : null;
    } else {
      const holder = view.lockPid();
      if (holder !== undefined) {
        throw new Stop(
          1,
          `a gateway (pid ${holder}) is running on ${view.mtHome} with no service installed; perhaps npm run dev, whose tsx watch ` +
            'would restart it on the new code at the merge, before the build, the check and the backup. Stop it first',
        );
      }
    }
    if (findNpm(this.node, this.shellEnv['PATH']) === undefined) {
      throw new Stop(1, `there is no npm beside ${this.node}, nor on PATH`);
    }

    const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch.code !== 0) {
      throw new Stop(1, `${this.checkout} has a detached HEAD: check out the branch to update, then run this again`);
    }
    this.branch = branch.stdout.trim();
    const upstream = await this.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    if (upstream.code !== 0) {
      throw new Stop(
        1,
        `${this.branch} has no upstream to update from. Name the one it tracks, once: git branch --set-upstream-to=origin/${this.branch}`,
      );
    }
    this.upstream = upstream.stdout.trim();
    const remote = await this.git(['config', '--get', `branch.${this.branch}.remote`]);
    this.remote = remote.stdout.trim() || (this.upstream.split('/')[0] ?? 'origin');

    const status = lines(await this.mustGit(['status', '--porcelain', '--untracked-files=normal']));
    if (status.length > 0) {
      const shown = status.slice(0, 10).map((l) => `  ${l}`);
      if (status.length > 10) shown.push(`  and ${status.length - 10} more`);
      throw new Stop(1, `${this.checkout} is not clean; commit, stash or remove these first:\n${shown.join('\n')}`);
    }
    const where = lines(await this.mustGit(['rev-parse', ...OPERATIONS.flatMap((name) => ['--git-path', name])]));
    const pending = OPERATIONS.filter((_, i) => existsSync(resolve(this.checkout, where[i] ?? '')));
    if (pending.length > 0) {
      throw new Stop(1, `an operation is under way in ${this.checkout} (${pending.join(', ')}): finish it, or abort it, first`);
    }

    // Batch mode for ssh, unless the user chose their own.
    const sshCommand = await this.git(['config', '--get', 'core.sshCommand']);
    if (io.env['GIT_SSH_COMMAND'] === undefined && sshCommand.code !== 0) {
      this.gitEnv = { ...this.shellEnv, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
    }
    this.say(`fetching ${this.remote}`);
    const fetch = await this.call('git', ['fetch', this.remote], LIMITS.fetch, this.gitEnv);
    if (fetch.r.code !== 0) {
      throw new Stop(
        1,
        `git fetch ${this.remote} ${fetch.r.timedOut ? `did not finish in ${LIMITS.fetch / 1000} seconds` : `failed (exit ${fetch.r.code})`}` +
          `${fetch.said === '' ? '' : `: ${fetch.said}`}. Nothing changed. A remote that needs a password or a host key needs a credential helper or an ssh agent`,
      );
    }
    [this.old = '', this.new = ''] = lines(await this.mustGit(['rev-parse', 'HEAD', this.upstream]));
    const ancestor = await this.git(['merge-base', '--is-ancestor', 'HEAD', this.upstream]);
    if (ancestor.code === 1) {
      throw new Stop(
        1,
        `${this.branch} has commits ${this.upstream} does not: made here, or ${this.upstream} was rewritten (force-pushed). ` +
          `Joining them is for a person: see git log ${this.upstream}..${this.branch} and git log ${this.branch}..${this.upstream}`,
      );
    }
    if (ancestor.code !== 0) throw new Stop(1, `git merge-base --is-ancestor HEAD ${this.upstream} failed (exit ${ancestor.code})`);
    this.lock = { ...this.lock, old: this.old, new: this.new };
    if (this.old === this.new) {
      this.upToDate = true;
      return;
    }
    this.added = lines(await this.mustGit(['diff', '--name-only', '--diff-filter=A', 'HEAD', this.upstream]));
    const inTheWay = this.added.filter((path) => lstatSync(join(this.checkout, path), { throwIfNoEntry: false }) !== undefined);
    if (inTheWay.length > 0) {
      throw new Stop(
        1,
        `the incoming commits add ${inTheWay.join(', ')}, already in ${this.checkout} and ignored by git, which would overwrite ` +
          `${inTheWay.length === 1 ? 'it' : 'them'} in the fast-forward without a word. Move ${inTheWay.length === 1 ? 'it' : 'them'} aside, or tell the commit's author`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: show what's coming, record, ask.

  /** Answers false when there is nothing new. */
  private async show(): Promise<boolean> {
    const { view } = this;
    if (this.upToDate) {
      this.say(`manus-team at ${this.checkout}, on ${this.branch}, tracking ${this.upstream}: up to date at ${short(this.old)}`);
      return false;
    }
    this.writeLock('show');
    this.say(`manus-team at ${this.checkout}, on ${this.branch}, tracking ${this.upstream}`);

    const commits = lines(await this.mustGit(['log', '--oneline', '--no-decorate', `HEAD..${this.upstream}`]));
    this.say(`${plural(commits.length, 'new commit')}, ${short(this.old)}..${short(this.new)}:`);
    for (const commit of commits.slice(0, COMMITS_SHOWN)) this.say(`  ${commit}`);
    if (commits.length > COMMITS_SHOWN) this.say(`  and ${commits.length - COMMITS_SHOWN} more`);

    // The database, found as the gateway would find it.
    const recorded = view.recorded();
    let settings: TeamSettings;
    let env: Env;
    try {
      env = recorded !== undefined ? view.env(recorded) : loadGatewayEnv({ ...this.shellEnv, MT_HOME: view.mtHome }).env;
      settings = loadTeamSettings(env, undefined, { unsetPassEnv: [] });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      throw new Stop(
        1,
        `the running build rejects the configuration, so the database cannot be found: ${err.message}. ` +
          'A config edited ahead of an update, for a key only the new build knows, is the usual cause: undo the edit, update, then make it',
      );
    }
    this.dbPath = settings.dbPath;
    this.db = openDbReadOnly(settings.dbPath);
    this.version = this.db === undefined ? null : Number(this.db.pragma('user_version', { simple: true }));

    const tree = lines(await this.mustGit(['ls-tree', '--name-only', this.upstream, 'schema/']));
    this.newest = tree.reduce((top, path) => Math.max(top, Number(MIGRATION.exec(path)?.[1] ?? 0)), 0);
    const fresh = this.added.filter((path) => MIGRATION.test(path)).map((path) => basename(path)).sort();
    if (fresh.length > 0) {
      const which = `${fresh.length === 1 ? 'migration' : 'migrations'} ${fresh.join(', ')} ${fresh.length === 1 ? 'is' : 'are'} new`;
      this.say(
        this.version === null
          ? `${which}; there is no database yet, so nothing to back up`
          : `${which}: the restart moves the database from version ${this.version} to ${this.newest}, and a backup is taken first; going back after it needs the backup`,
      );
    }
    const changed = lines(await this.mustGit(['diff', '--name-only', '--diff-filter=M', 'HEAD', this.upstream, '--', 'schema/']));
    for (const path of changed.filter((p) => MIGRATION.test(p))) {
      this.warn(`migration ${basename(path)} was changed: the runner never runs again one the database has applied`);
    }
    const schemaDir = env['MT_SCHEMA_DIR']?.trim();
    if (schemaDir !== undefined && schemaDir !== '') {
      this.warn(
        `MT_SCHEMA_DIR is set, to ${schemaDir}: this report and the restart's confirmation assume the bundled schema/, and the gateway reads ${schemaDir}. ` +
          'The new build refuses a database newer than that directory, and its mt service check reads it',
      );
    }

    const dependencies = await this.git(['diff', '--quiet', 'HEAD', this.upstream, '--', 'package.json', 'package-lock.json']);
    const installedTree = existsSync(join(this.checkout, 'node_modules', '.package-lock.json'));
    if (dependencies.code !== 0) this.say('the dependencies changed: npm ci runs');
    else if (!installedTree) this.say('node_modules/.package-lock.json is missing: npm ci runs');

    const runs = this.db === undefined || !hasBoard(this.db) ? undefined : openAgentRunCount(this.db);
    if (this.willRestart && runs !== undefined && runs > 0) {
      this.say(`${plural(runs, 'agent run')} ${runs === 1 ? 'is' : 'are'} open: the restart interrupts them, and they are retried as retry_on_crash allows`);
    }
    if (this.willRestart) {
      this.say(`the service is running (pid ${this.servicePid ?? 'unknown'}) and is restarted`);
    } else if (this.installed) {
      this.say('the service is stopped, and is not started: the update stops after the backup');
    } else {
      this.say('no service is installed: the update stops after the backup, and the gateway is yours to restart');
      if (settings.kanbanEnabled !== true) {
        this.say('kanban is off, so a gateway started by hand holds no lock to find: stop one that runs before going on');
      }
    }

    this.lock = { ...this.lock, servicePid: this.servicePid, userVersion: this.version, db: this.dbPath };
    this.writeLock('show');
    return true;
  }

  // -------------------------------------------------------------------------

  async run(): Promise<number> {
    try {
      await this.inspect();
      await this.show();
      return 0;
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      if (err.refusal !== undefined) this.sayErr(`mt: ${err.refusal}`);
      return err.code;
    } finally {
      this.db?.close();
      for (const lock of [...this.locks].reverse()) lock.release();
    }
  }
}
```

In `src/db/kanban-read.ts`, replace:

```ts
    .get(at.channel, at.appId, at.conversationId)?.board;
}
```

with:

```ts
    .get(at.channel, at.appId, at.conversationId)?.board;
}

/** Whether the database has the board's tables: one migrated before the board has none (spec §20.3). */
export function hasBoard(db: Db): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_runs'").get() !== undefined;
}
```

- [ ] **Step 9.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1884 passed (1884)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 9.5: Commit.**

```bash
git add src/cli/mt.ts src/cli/service.ts src/cli/update.ts src/db/kanban-read.ts tests/helpers/update.ts tests/mt-update-check.test.ts tests/mt-update-show.test.ts tests/update-run.test.ts
git commit -m "Add mt update --check, which checks the checkout, the branch, the service and the locks, fetches, and shows what is coming without changing anything"
```

---

### Task 10: `mt update --yes` and the question: steps 4 to 7

**Files:**

- Create: `tests/mt-update-apply.test.ts`, `tests/mt-update-restart.test.ts`
- Modify: `src/cli/mt.ts`, `src/cli/update.ts`, `tests/mt-update-show.test.ts`

Spec §20.3's question, §20.4 to §20.9. `confirm` asks at a terminal unless `--yes`, and refuses with none. `apply`: `git merge --ff-only`, `npm ci` when the dependencies changed, `npm run build`, the new build's `mt service check` as the preflight, each a `step` that writes the lock first; then `unmoved`, which reads the pid and the version again and stops with exit 3 and the steps back or forward when either moved; then the backup into `privateDir(backups)`. A failure goes back (`goBack`): `unmoved` again, `git reset --keep <old>`, `npm ci` if one ran, the build, `git status --porcelain`, and exit 1; going back that fails, or leaves the tree not clean, is `stuck`, exit 3. `restart`: a stopped service or none is not started, exit 0; else `ServiceView.restart`, then the log read past where it was for `connected as` after the schema line, 240 polls of 250 ms; a failure there, or none, prints the log's tail and the steps back, exit 3.

- [ ] **Step 10.1: Write the tests.**

Create `tests/mt-update-apply.test.ts`:

```ts
import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readUpdateLock } from '../src/cli/update-lock.js';
import { openDb } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { NEW, OLD, TOP, updateFake, type UpdateFake } from './helpers/update.js';

/**
 * `mt update`'s steps 4 to 6 (spec §20.4 to §20.8): the fast-forward, npm ci
 * only when it must, the build, the new build's check and the backup; each
 * failure going back with reset --keep, npm ci only if one ran, and the build,
 * the restart never called; and a gateway that moved meanwhile stopping it,
 * exit 3, with no going back.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const NPM = (): string => `PATH='${join(fx.root, 'node bin')}':"$PATH" '${fx.npm}'`;
const MT = (): string => `PATH='${join(fx.root, 'node bin')}':"$PATH" '${fx.node}' '${join(fx.checkout, 'dist', 'mt.js')}'`;
/** The check that the tree is clean once gone back. */
const STATUS = 'git status --porcelain --untracked-files=normal';
const restarted = (): boolean => fx.words().some((w) => / kill SIGTERM | kickstart /.test(` ${w} `));
/** The calls after the fetch's checks: what the update did. */
const did = (): string[] => {
  const all = fx.ran();
  return all.slice(all.findIndex((w) => w.startsWith('git diff --quiet')) + 1);
};
const failing = (word: string, result: { code?: number; stderr?: string; timedOut?: boolean }) => (run: { cmd: string; args: string[] }) =>
  [run.cmd === fx.npm ? 'npm' : run.cmd === fx.node ? 'node' : run.cmd, ...run.args].join(' ').startsWith(word) ? result : undefined;

describe('mt update --yes', () => {
  it('fast-forwards, builds, checks, backs up, restarts and confirms, exit 0', async () => {
    fx = await updateFake();
    const r = await fx.update(['--yes']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(did()).toEqual(['git merge --ff-only origin/main', 'npm run build', 'node service check']);
    expect(r.out).toContain(`updated main from 8b64aa1 to 4f0c2de; the gateway is connected, at schema version ${TOP}`);
    const backups = readdirSync(join(fx.mtHome, 'backups'));
    expect(backups).toEqual([`team-v${TOP}-8b64aa1-20261112T153000Z.db`]);
    expect(statSync(join(fx.mtHome, 'backups')).mode & 0o777).toBe(0o700);
    expect(fx.words().filter((w) => / (kill|kickstart) /.test(` ${w} `))).toEqual([
      'launchctl kill SIGTERM gui/501/team.manus.gateway',
      'launchctl kickstart gui/501/team.manus.gateway',
    ]);
    expect(existsSync(join(fx.mtHome, 'run', 'update.pid'))).toBe(false);
  });

  it('runs npm with the node the unit records, its directory first on PATH, and the check with no board-run variable', async () => {
    fx = await updateFake();
    await fx.update(['--yes'], { env: { MT_HOME: undefined } });
    const build = fx.runs.find((r) => r.cmd === fx.npm);
    expect(build?.opts.env['PATH']).toBe(`${join(fx.root, 'node bin')}:/usr/bin:/bin`);
    expect(build?.opts.timeoutMs).toBe(10 * 60_000);
    const check = fx.runs.find((r) => r.cmd === fx.node);
    expect(check?.args).toEqual([join(fx.checkout, 'dist', 'mt.js'), 'service', 'check']);
    expect(Object.keys(check?.opts.env ?? {}).filter((k) => k.startsWith('MT_KANBAN_'))).toEqual([]);
    expect(fx.runs.find((r) => r.args[0] === 'merge')?.opts.timeoutMs).toBe(120_000);
  });

  it('runs npm ci when the dependencies changed, within 20 minutes, and skips it when neither file did', async () => {
    fx = await updateFake();
    fx.repo.depsChanged = true;
    await fx.update(['--yes']);
    expect(did().slice(0, 3)).toEqual(['git merge --ff-only origin/main', 'npm ci', 'npm run build']);
    expect(fx.runs.find((r) => r.cmd === fx.npm && r.args[0] === 'ci')?.opts.timeoutMs).toBe(20 * 60_000);
  });

  it('changes nothing when step 2 refuses: no merge, no npm, no restart', async () => {
    fx = await updateFake();
    fx.repo.ancestor = false;
    expect((await fx.update(['--yes'])).code).toBe(1);
    expect(fx.ran().filter((w) => /^git (merge --ff-only|reset)|^npm |^node /.test(w))).toEqual([]);
    expect(restarted()).toBe(false);
  });

  it('prints what the new build\'s check says', async () => {
    fx = await updateFake();
    const r = await fx.update(['--yes']);
    expect(r.out).toContain(`  database: ${fx.dbPath} at version ${TOP}; this build: up to ${TOP}`);
  });
});

describe('a failure in steps 4 to 6 goes back', () => {
  it('a failed build: reset --keep to the old commit, the build again, no npm ci, the restart never called, exit 1', async () => {
    fx = await updateFake();
    let builds = 0;
    fx.answer = (run) => (run.cmd === fx.npm && run.args[1] === 'build' && builds++ === 0 ? { code: 2, stdout: 'src/x.ts(1,1): error TS1005\n' } : undefined);
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(did()).toEqual(['git merge --ff-only origin/main', 'npm run build', `git reset --keep ${OLD}`, 'npm run build', STATUS]);
    expect(fx.repo.head).toBe(OLD);
    expect(r.err).toBe('mt: npm run build failed (exit 2)\n  src/x.ts(1,1): error TS1005');
    expect(r.out).toContain('the checkout is back at 8b64aa1, and the gateway as it was');
    expect(restarted()).toBe(false);
    expect(existsSync(join(fx.mtHome, 'backups'))).toBe(false);
  });

  it('a failed npm ci: npm ci again going back, as it may have left node_modules half there', async () => {
    fx = await updateFake();
    fx.repo.depsChanged = true;
    let cis = 0;
    fx.answer = (run) => (run.cmd === fx.npm && run.args[0] === 'ci' && cis++ === 0 ? { code: 1, stderr: 'npm ERR! network' } : undefined);
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(did()).toEqual(['git merge --ff-only origin/main', 'npm ci', `git reset --keep ${OLD}`, 'npm ci', 'npm run build', STATUS]);
  });

  it('a failed check of the new build, with its last lines, masked', async () => {
    fx = await updateFake();
    fx.answer = failing('node', { code: 1, stderr: `mt: the gateway would not start as the service: ${'lark-secret-never-printed-0000'}` });
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: mt service check failed \(exit 1\)\n {2}mt: the gateway would not start as the service: ••••$/);
    expect(did()).toEqual(['git merge --ff-only origin/main', 'npm run build', 'node service check', `git reset --keep ${OLD}`, 'npm run build', STATUS]);
  });

  it('a merge that failed, and one that timed out with HEAD at the new commit, both go back', async () => {
    fx = await updateFake();
    fx.answer = failing('git merge --ff-only', { code: 1, stderr: 'fatal: Not possible to fast-forward' });
    expect((await fx.update(['--yes'])).code).toBe(1);
    expect(did()).toContain(`git reset --keep ${OLD}`);
    fx.runs = [];
    fx.answer = (run) => {
      if (run.args[0] !== 'merge') return undefined;
      fx.repo.head = NEW;
      return { code: 143, timedOut: true };
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('mt: git merge --ff-only origin/main did not finish in 120 seconds (HEAD is at 4f0c2de: the merge landed, and its post-merge hook did not end)');
    expect(fx.repo.head).toBe(OLD);
  });

  it('a build past its 10 minutes', async () => {
    fx = await updateFake();
    let builds = 0;
    fx.answer = (run) => (run.cmd === fx.npm && builds++ === 0 ? { code: 143, timedOut: true } : undefined);
    expect((await fx.update(['--yes'])).err).toContain('mt: npm run build did not finish in 10 minutes');
  });

  it('a failed backup', async () => {
    fx = await updateFake();
    const { mkdirSync, symlinkSync } = await import('node:fs');
    mkdirSync(join(fx.root, 'not mine'));
    symlinkSync(join(fx.root, 'not mine'), join(fx.mtHome, 'backups'));
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: the backup failed: .*backups is not a directory of its own/);
    expect(did()).toContain(`git reset --keep ${OLD}`);
    expect(restarted()).toBe(false);
  });

  it('going back that fails too: git status and the commands to finish by hand, exit 3', async () => {
    fx = await updateFake();
    fx.answer = (run) => {
      if (run.cmd === fx.npm && run.args[1] === 'build') return { code: 2, stdout: 'error TS1005' };
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('mt: npm run build failed (exit 2); and going back, npm run build failed (exit 2):');
    expect(r.out).toContain('git status says:\n  On branch main');
    expect(r.out).toContain(`to finish going back by hand:\n  cd '${fx.checkout}' && ${NPM()} ci && ${NPM()} run build`);
    expect(r.out).toContain('a crash restart would run whatever dist/ and node_modules now hold');
  });

  it('a tree not clean after going back: stuck, with what git status says, exit 3', async () => {
    fx = await updateFake();
    let builds = 0;
    fx.answer = (run) => {
      if (run.cmd === fx.npm && run.args[1] === 'build' && builds++ === 0) return { code: 2 };
      if (run.args[0] === 'status' && run.args[1] === '--porcelain' && builds > 0) return { stdout: '?? dist-leftover.txt\n' };
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('mt: npm run build failed (exit 2); and going back, the checkout is not clean:\n  ?? dist-leftover.txt');
    expect(r.out).not.toContain('the checkout is back at');
    expect(r.out).toContain(`to finish going back by hand:\n  cd '${fx.checkout}' && ${NPM()} ci && ${NPM()} run build`);
  });

  it('a reset that fails going back names it in the commands to finish', async () => {
    fx = await updateFake();
    fx.answer = (run) => (run.args[0] === 'reset' ? { code: 1, stderr: "error: Entry 'x' not uptodate. Cannot merge." } : run.cmd === fx.npm ? { code: 2 } : undefined);
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.out).toContain(`cd '${fx.checkout}' && git reset --keep ${OLD} && ${NPM()} ci`);
  });
});

describe('a gateway that moved during the update', () => {
  it('only its pid, at the backup: the steps back reading the version again, and the steps forward, exit 3, no going back', async () => {
    fx = await updateFake();
    fx.answer = (run) => {
      if (run.cmd === fx.node) fx.job.pid = 4310;
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe(`mt: the service's pid was 4242 and is 4310; the database is still at version ${TOP}`);
    expect(r.out).toContain(`  ${MT()} service check  # it should print "at version ${TOP}"`);
    expect(r.out).toContain('the steps forward, if the check prints another version:');
    expect(did()).not.toContain(`git reset --keep ${OLD}`);
    expect(existsSync(join(fx.mtHome, 'backups'))).toBe(false);
    expect(restarted()).toBe(false);
  });

  it('its database version, at the backup: the steps forward, no backup, exit 3', async () => {
    fx = await updateFake();
    fx.answer = (run) => {
      if (run.cmd === fx.node) {
        const db = openDb(fx.dbPath);
        db.pragma(`user_version = ${TOP + 1}`);
        db.close();
      }
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe(
      `mt: the database moved from version ${TOP} to version ${TOP + 1} before a backup was taken: the old build can no longer run on it, and there is no way back`,
    );
    expect(r.out).toContain(`the steps forward, which make the new tree whole and start it:\n  cd '${fx.checkout}'\n  ${NPM()} ci && ${NPM()} run build\n  ${MT()} service check\n  ${MT()} service restart`);
    expect(existsSync(join(fx.mtHome, 'backups'))).toBe(false);
  });

  it('its pid, at going back: no going back either, exit 3', async () => {
    fx = await updateFake();
    fx.answer = (run) => {
      if (run.cmd !== fx.npm) return undefined;
      fx.job.pid = 4311;
      return { code: 2 };
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toContain("the service's pid was 4242 and is 4311");
    expect(did()).toEqual(['git merge --ff-only origin/main', 'npm run build']);
  });

  it('its version, at going back: the steps forward, exit 3', async () => {
    fx = await updateFake();
    fx.answer = (run) => {
      if (run.cmd !== fx.npm) return undefined;
      const db = new Database(fx.dbPath);
      db.pragma(`user_version = ${TOP + 1}`);
      db.close();
      return { code: 2 };
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toContain(`moved from version ${TOP} to version ${TOP + 1} before a backup was taken`);
  });

  it('the lock records the pid and the version at step 3, and each step before it begins', async () => {
    fx = await updateFake();
    const steps: unknown[] = [];
    fx.answer = (run) => {
      steps.push(readUpdateLock(join(fx.mtHome, 'run', 'update.pid'))?.step);
      if (run.cmd === fx.npm) expect(readUpdateLock(join(fx.repo.gitDir, 'mt-update.lock'))).toMatchObject({ servicePid: 4242, userVersion: TOP, old: OLD, new: NEW, db: fx.dbPath });
      return undefined;
    };
    await fx.update(['--yes']);
    expect([...new Set(steps.filter((s) => s !== undefined))]).toEqual(['check', 'show', 'merge', 'build', 'preflight']);
  });
});

describe('a service that is stopped, or none', () => {
  it('is not started: the update stops after the backup, exit 0', async () => {
    fx = await updateFake({ service: 'stopped' });
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(0);
    expect(readdirSync(join(fx.mtHome, 'backups'))).toHaveLength(1);
    expect(r.out).toContain(`the service is stopped, so it is not started: start it with ${MT()} service start`);
    expect(fx.words().filter((w) => / (kickstart|bootstrap) /.test(` ${w} `))).toEqual([]);
  });

  it('with no service, the backup is taken and the restart is the person\'s', async () => {
    fx = await updateFake({ service: 'none' });
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(0);
    expect(readdirSync(join(fx.mtHome, 'backups'))).toHaveLength(1);
    expect(r.out).toContain('no service is installed: restart the gateway (stop it if it runs, then start it)');
  });
});
```

Create `tests/mt-update-restart.test.ts`:

```ts
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets } from '../src/secrets.js';
import { OLD, TOP, startupLines, updateFake, type UpdateFake } from './helpers/update.js';

/**
 * `mt update`'s step 7 (spec §20.9): `mt service restart`'s own code, then the
 * service log read past where it was for `connected as` after the schema
 * line, for up to 60 seconds; else the log's tail and the steps back, exit 3,
 * never an automatic going back.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const log = (): string => join(fx.mtHome, 'logs', 'gateway.log');
const NPM = (): string => `PATH='${join(fx.root, 'node bin')}':"$PATH" '${fx.npm}'`;
const MT = (): string => `PATH='${join(fx.root, 'node bin')}':"$PATH" '${fx.node}' '${join(fx.checkout, 'dist', 'mt.js')}'`;
const backup = (): string => join(fx.mtHome, 'backups', readdirSync(join(fx.mtHome, 'backups'))[0] ?? '');

function stepsBack(): string {
  return [
    `  ${MT()} service stop`,
    `  cd '${fx.checkout}'`,
    `  git reset --keep ${OLD}`,
    `  ${NPM()} ci && ${NPM()} run build`,
    `  rm -f '${fx.dbPath}-wal' '${fx.dbPath}-shm'`,
    `  cp '${backup()}' '${fx.dbPath}'`,
    `  ${MT()} service start`,
  ].join('\n');
}

describe('the confirmation', () => {
  it('is connected as, after the schema line', async () => {
    fx = await updateFake();
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('restarting team.manus.gateway');
    expect(r.out).toContain(`the gateway is connected, at schema version ${TOP}`);
  });

  it('is not the schema line alone: none in 60 seconds is the log\'s tail and the steps back, exit 3', async () => {
    fx = await updateFake();
    fx.onStart = () => appendFileSync(log(), `2026-11-12T15:31:00.000Z schema at version ${TOP} (${fx.dbPath})\n`);
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('mt: the new gateway did not say it connected within 60 seconds');
    expect(fx.slept).toBe(60_000);
    expect(r.out).toContain(`the service log's last 30 lines:\n  2026-11-12T09:00:00.000Z connected as ou_bot\n  2026-11-12T15:31:00.000Z schema at version ${TOP}`);
    expect(r.out).toContain(`a restore loses what it wrote since the backup:\n${stepsBack()}`);
    expect(fx.repo.head).not.toBe(OLD);
  });

  it('is not a connected line from before the restart', async () => {
    fx = await updateFake();
    fx.onStart = () => {};
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
  });

  it('is found after the log was rotated at the start, reading it from its beginning', async () => {
    fx = await updateFake();
    appendFileSync(log(), 'x'.repeat(5000) + '\n');
    fx.onStart = () => writeFileSync(log(), startupLines(TOP, fx.dbPath));
    expect((await fx.update(['--yes'])).code).toBe(0);
  });

  it('warns of a version below the new tree\'s highest', async () => {
    fx = await updateFake();
    fx.onStart = () => appendFileSync(log(), startupLines(TOP - 1, fx.dbPath));
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`warning: the gateway is at schema version ${TOP - 1}, below the new tree's ${TOP}`);
  });

  for (const line of ['configuration error: the database at /x is at schema version 9', 'failed to start: Error: boom']) {
    it(`ends the wait at once at ${line.split(':')[0]}:`, async () => {
      fx = await updateFake();
      fx.onStart = () => appendFileSync(log(), `2026-11-12T15:31:00.000Z no config file\n${line}\n`);
      const r = await fx.update(['--yes']);
      expect(r.code).toBe(3);
      expect(r.err).toBe(`mt: the new gateway did not start: ${line}`);
      expect(fx.slept).toBe(0);
      expect(r.out).toContain(stepsBack());
    });
  }
});

describe('the restart call', () => {
  it('that fails is exit 3, with its error and the steps back', async () => {
    fx = await updateFake();
    fx.override = (c) => (c.args[0] === 'kill' ? { code: 3, stderr: 'Boot-out failed: 3: No such process' } : undefined);
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('mt: the restart failed: launchctl kill SIGTERM gui/501/team.manus.gateway failed (exit 3): Boot-out failed: 3: No such process');
    expect(r.out).toContain(`whether one runs, and which, is for ${MT()} service status`);
    expect(r.out).toContain(stepsBack());
  });

  it("is systemctl restart on Linux", async () => {
    fx = await updateFake();
    fx.install({ platform: 'linux' });
    fx.job.pid = 4242;
    const r = await fx.update(['--yes'], { platform: 'linux' });
    expect(r.code).toBe(0);
    expect(fx.words()).toContain('systemctl --user restart manus-team.service');
  });

  it('prints the steps back for a home other than the default with its export', async () => {
    fx = await updateFake();
    const home = fx.mtHome;
    fx.install({ mtHomeSet: home });
    fx.job.pid = 4242;
    fx.onStart = () => {};
    const r = await fx.update(['--yes'], { env: { MT_HOME: home } });
    expect(r.code).toBe(3);
    expect(r.out).toContain(`a restore loses what it wrote since the backup:\n  export MT_HOME='${home}'\n  ${MT()} service stop`);
  });
});
```

In `tests/mt-update-show.test.ts`, replace:

```ts
  });
});
```

with:

```ts
  });
});

describe("mt update's question", () => {
  it('is refused with no terminal and no --yes', async () => {
    fx = await updateFake();
    const r = await fx.update([]);
    expect(r.code).toBe(1);
    expect(r.err).toBe('mt: no terminal to ask at; run mt update --yes, or --check');
    expect(merged()).toBe(false);
  });

  it('is asked at a terminal, and anything but y or yes changes nothing, exit 1', async () => {
    fx = await updateFake();
    for (const reply of ['', 'n', 'no', 'yes please']) {
      fx.replies = [reply];
      const r = await fx.update([], { tty: true });
      expect(r.code).toBe(1);
      expect(r.out.split('\n').slice(-1)).toEqual(['nothing changed']);
    }
    expect(fx.asked).toEqual(Array(4).fill('update and restart the service? [y/N] '));
    expect(merged()).toBe(false);
  });

  it('goes on at y or yes', async () => {
    fx = await updateFake();
    fx.replies = [' YES '];
    expect((await fx.update([], { tty: true })).code).toBe(0);
    expect(merged()).toBe(true);
  });

  it("is asked with no restart in its words when there is none to make", async () => {
    fx = await updateFake({ service: 'stopped' });
    fx.replies = ['n'];
    await fx.update([], { tty: true });
    expect(fx.asked).toEqual(['update, and back up the database? [y/N] ']);
  });
});
```

- [ ] **Step 10.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-update-apply.test.ts tests/mt-update-restart.test.ts tests/mt-update-show.test.ts`. Expected: `Tests  35 failed | 13 passed (48)`: `--yes` is an unknown option, exit 2, and with neither flag the command line is wrong too.

- [ ] **Step 10.3: Implement.**

In `src/cli/mt.ts`, replace:

```ts
  '  mt update --check',
```

with:

```ts
  '  mt update [--check | --yes]',
```

In `src/cli/update.ts`, replace:

```ts
import { existsSync, lstatSync, realpathSync } from 'node:fs';
```

with:

```ts
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
```

In `src/cli/update.ts`, replace:

```ts
import { basename, join, resolve } from 'node:path';
```

with:

```ts
import { basename, delimiter, dirname, join, resolve } from 'node:path';
```

In `src/cli/update.ts`, replace:

```ts
import { ConfigError, loadTeamSettings, type Env, type TeamSettings } from '../config.js';
import { hasBoard, openAgentRunCount } from '../db/kanban-read.js';
```

with:

```ts
import { ConfigError, loadTeamSettings, type Env, type TeamSettings } from '../config.js';
import { backupDatabase } from '../db/backup.js';
import { hasBoard, openAgentRunCount } from '../db/kanban-read.js';
```

In `src/cli/update.ts`, replace:

```ts
import { findNpm, shQuote } from './shell.js';
```

with:

```ts
import { findNpm, mtCommand, shQuote } from './shell.js';
import { finishByHand, stepsBack, stepsForward, type AdvicePaths } from './update-advice.js';
```

In `src/cli/update.ts`, replace:

```ts
/** How long a killed group has between SIGTERM and SIGKILL, and after it, before its output is let go. */
```

with:

```ts
/** How long the restarted gateway has to say it connected, and how often its log is read. */
export const CONFIRM_MS = 60_000;
const POLL_MS = 250;
/** How long a killed group has between SIGTERM and SIGKILL, and after it, before its output is let go. */
```

In `src/cli/update.ts`, replace:

```ts
const COMMITS_SHOWN = 50;
```

with:

```ts
const COMMITS_SHOWN = 50;
const FAILED_TAIL = 20;
const LOG_TAIL = 30;
```

In `src/cli/update.ts`, replace:

```ts
const short = (sha: string | undefined): string => (sha ?? '').slice(0, 7);
```

with:

```ts
/** What failed in steps 4 to 6, to say when the update has gone back. */
interface Failure {
  what: string;
  output: string;
}

const short = (sha: string | undefined): string => (sha ?? '').slice(0, 7);
```

In `src/cli/update.ts`, replace:

```ts
const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
```

with:

```ts
const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const versionText = (v: number | null): string => (v === null ? 'no database' : `version ${v}`);
```

In `src/cli/update.ts`, replace:

```ts
/** `mt update --check`. */
```

with:

```ts
/** The `user_version` of the database at `path`, read-only; null when there is none. */
function versionOf(path: string): number | null {
  const db = openDbReadOnly(path);
  if (db === undefined) return null;
  try {
    return Number(db.pragma('user_version', { simple: true }));
  } finally {
    db.close();
  }
}

/** A file's last `n` lines, or none when it is missing. */
function tailOf(path: string, n: number): string[] {
  const text = readFrom(path, 0);
  const all = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return text === '' ? [] : all.slice(-n);
}

/** The bytes of `path` from `offset`, or from its start when it is shorter, as after a rotation. */
function readFrom(path: string, offset: number): string {
  const st = statSync(path, { throwIfNoEntry: false });
  if (st === undefined) return '';
  const start = st.size < offset ? 0 : offset;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    const read = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** `mt update [--check | --yes]`. */
```

In `src/cli/update.ts`, replace:

```ts
  const { values, positionals } = parse(argv, { check: { type: 'boolean' } });
```

with:

```ts
  const { values, positionals } = parse(argv, { check: { type: 'boolean' }, yes: { type: 'boolean' } });
```

In `src/cli/update.ts`, replace:

```ts
  if (values.check !== true) throw new UsageError('update takes --check, which shows what is new and changes nothing');
```

with:

```ts
  if (values.check === true && values.yes === true) throw new UsageError('update takes --check or --yes, not both');
```

In `src/cli/update.ts`, replace:

```ts
  return await new Update(io, deps).run();
```

with:

```ts
  return await new Update(io, deps, { check: values.check === true, yes: values.yes === true }).run();
```

In `src/cli/update.ts`, replace:

```ts
  private node: string;
  private branch = '';
```

with:

```ts
  private node: string;
  private npm = 'npm';
  private branch = '';
```

In `src/cli/update.ts`, replace:

```ts
  private newest = 0;
  private added: string[] = [];
```

with:

```ts
  private newest = 0;
  private needCi = false;
  private ranCi = false;
  private backup: string | undefined;
  private added: string[] = [];
```

In `src/cli/update.ts`, replace:

```ts
  private lock: UpdateLockState;
```

with:

```ts
  private lock: UpdateLockState;
  private readonly abort = new AbortController();
```

In `src/cli/update.ts`, replace:

```ts
    private readonly deps: UpdateDeps,
  ) {
```

with:

```ts
    private readonly deps: UpdateDeps,
    private readonly opts: { check: boolean; yes: boolean },
  ) {
```

In `src/cli/update.ts`, replace:

```ts
    this.say(`warning: ${line}`);
  }
```

with:

```ts
    this.say(`warning: ${line}`);
  }

  private block(title: string, commands: readonly string[]): void {
    this.say(title);
    for (const command of commands) this.say(`  ${command}`);
  }

  private get paths(): AdvicePaths {
    return {
      node: this.node,
      npm: this.npm,
      checkout: this.checkout,
      home: this.view.mtHome,
      homeSet: this.view.mtHomeSet !== undefined,
      db: this.dbPath,
      service: this.installed,
    };
  }

  private get npmEnv(): Env {
    return { ...this.gitEnv, PATH: [dirname(this.node), this.shellEnv['PATH'] ?? ''].filter((p) => p !== '').join(delimiter) };
  }
```

In `src/cli/update.ts`, replace:

```ts
    // The unit, and the node the update uses.
```

with:

```ts
    // The unit, and the node and npm the update and its printed steps use.
```

In `src/cli/update.ts`, replace:

```ts
    if (recorded !== undefined) this.node = recorded.node;
```

with:

```ts
    if (recorded !== undefined) this.node = recorded.node;
    this.npm = findNpm(this.node, this.shellEnv['PATH']) ?? 'npm';
```

In `src/cli/update.ts`, replace:

```ts
    const installedTree = existsSync(join(this.checkout, 'node_modules', '.package-lock.json'));
    if (dependencies.code !== 0) this.say('the dependencies changed: npm ci runs');
```

with:

```ts
    const installedTree = existsSync(join(this.checkout, 'node_modules', '.package-lock.json'));
    this.needCi = dependencies.code !== 0 || !installedTree;
    if (dependencies.code !== 0) this.say('the dependencies changed: npm ci runs');
```

In `src/cli/update.ts`, replace:

```ts
  }

  // -------------------------------------------------------------------------

```

with:

```ts
  }

  /** The question, at a terminal, unless `--yes`. */
  private async confirm(): Promise<void> {
    if (this.opts.yes) return;
    if (this.io.stdinIsTTY !== true) throw new Stop(1, 'no terminal to ask at; run mt update --yes, or --check');
    const question = this.willRestart ? 'update and restart the service? [y/N] ' : 'update, and back up the database? [y/N] ';
    const answer = await this.deps.ask(question, this.abort.signal);
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      this.say('nothing changed');
      throw new Stop(1, undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Steps 4 to 6: update, preflight, backup. A failure goes back.

  private async apply(): Promise<void> {
    const merge = await this.step('merge', `merging ${this.upstream}, fast-forward only`, 'git', ['merge', '--ff-only', this.upstream], LIMITS.hook, this.gitEnv);
    if (merge !== undefined) {
      // Timed out or not, it goes back; HEAD at the new commit is a merge that landed and a hook that hung.
      const head = await this.deps.run('git', ['rev-parse', 'HEAD'], { cwd: this.checkout, env: this.gitEnv, timeoutMs: LIMITS.local });
      if (head.stdout.trim() === this.new) merge.what += ` (HEAD is at ${short(this.new)}: the merge landed, and its post-merge hook did not end)`;
    }
    await this.goBackIf(merge);
    if (this.needCi) {
      this.ranCi = true;
      await this.goBackIf(await this.step('npm ci', 'running npm ci', this.npm, ['ci'], LIMITS.npmCi, this.npmEnv));
    }
    await this.goBackIf(await this.step('build', 'running npm run build', this.npm, ['run', 'build'], LIMITS.build, this.npmEnv));
    const check = [join(this.checkout, 'dist', 'mt.js'), 'service', 'check'];
    await this.goBackIf(await this.step('preflight', 'checking the new build: mt service check', this.node, check, LIMITS.check, this.npmEnv));

    this.unmoved();
    this.writeLock('backup');
    let failed: Failure | undefined;
    if (this.db === undefined) {
      this.say('there is no database, so no backup: the gateway has not started on this home');
    } else {
      const dir = join(this.view.mtHome, 'backups');
      try {
        privateDir(dir, 'the backups');
        const at = this.deps.now();
        const { path, removed } = await backupDatabase(this.db, { dir, dbPath: this.dbPath, version: this.version ?? 0, sha: this.old, at });
        this.backup = path;
        this.lock = { ...this.lock, backup: path };
        this.writeLock('backup');
        this.say(`backed up the database to ${path}${removed.length === 0 ? '' : `; removed ${plural(removed.length, 'older backup')}`}`);
      } catch (err) {
        failed = { what: `the backup failed: ${err instanceof Error ? err.message : String(err)}`, output: '' };
      }
    }
    await this.goBackIf(failed);
  }

  /** Run one of steps 4 to 6 to its end; its failure, or undefined. */
  private async step(step: UpdateStep, line: string, cmd: string, args: readonly string[], timeoutMs: number, env: Env): Promise<Failure | undefined> {
    this.writeLock(step);
    this.say(line);
    const r = await this.deps.run(cmd, args, { cwd: this.checkout, env, timeoutMs });
    const output = `${r.stdout}${r.stdout.endsWith('\n') || r.stdout === '' ? '' : '\n'}${r.stderr}`;
    if (r.code === 0 && !r.timedOut) {
      if (step === 'preflight') for (const said of lines(r.stdout)) this.say(`  ${said}`);
      return undefined;
    }
    const name = step === 'merge' ? `git merge --ff-only ${this.upstream}` : step === 'preflight' ? 'mt service check' : step === 'npm ci' ? 'npm ci' : 'npm run build';
    const limit = timeoutMs >= 600_000 ? `${timeoutMs / 60_000} minutes` : `${timeoutMs / 1000} seconds`;
    return { what: r.timedOut ? `${name} did not finish in ${limit}` : `${name} failed (exit ${r.code})`, output };
  }

  private async goBackIf(failure: Failure | undefined): Promise<void> {
    if (failure !== undefined) await this.goBack(failure);
  }

  /** The service's pid now: null when it is not running. */
  private pidNow(): number | null | 'unreadable' {
    if (!this.installed) return null;
    const state = this.view.state();
    if (state.unreadable !== undefined) return 'unreadable';
    return state.running ? (state.pid ?? null) : null;
  }

  /** The database's `user_version` now, on the read-only connection; null with no database. */
  private versionNow(): number | null {
    return this.db === undefined ? versionOf(this.dbPath) : Number(this.db.pragma('user_version', { simple: true }));
  }

  /**
   * Before the backup and before any going back (spec §20.6): did a gateway
   * start again meanwhile, a crash restart on the new tree, or migrate the
   * database? Either stops the update, exit 3, with what to do.
   */
  private unmoved(): void {
    const version = this.versionNow();
    if (version !== this.version) {
      this.sayErr(
        `mt: the database moved from ${versionText(this.version)} to ${versionText(version)} before a backup was taken: ` +
          'the old build can no longer run on it, and there is no way back',
      );
      this.block('the steps forward, which make the new tree whole and start it:', stepsForward(this.paths));
      throw new Stop(3, undefined);
    }
    const pid = this.pidNow();
    if (pid === this.servicePid) return;
    const was = this.servicePid === null ? 'the service was not running' : `the service's pid was ${this.servicePid}`;
    const is = pid === 'unreadable' ? 'its state cannot be read now' : pid === null ? 'it is not running now' : `is ${pid}`;
    this.sayErr(`mt: ${was} and ${is}; the database is still at ${versionText(this.version)}`);
    this.block(
      'the steps back, which hold while the version is unchanged after the stop:',
      stepsBack(this.paths, { old: this.old, backup: undefined, checkVersion: this.version }),
    );
    this.block('the steps forward, if the check prints another version:', stepsForward(this.paths));
    throw new Stop(3, undefined);
  }

  /** Spec §20.7: back to the old commit, its tree and its build; the running gateway untouched. */
  private async goBack(failure: Failure): Promise<never> {
    this.unmoved();
    this.writeLock('going back');
    this.say(`${failure.what}: going back to ${short(this.old)}`);
    const run = (cmd: string, args: readonly string[], timeoutMs: number, env: Env): Promise<UpdateRunResult> =>
      this.deps.run(cmd, args, { cwd: this.checkout, env, timeoutMs });
    const reset = await run('git', ['reset', '--keep', this.old], LIMITS.hook, this.gitEnv);
    const failed = (what: string, r: UpdateRunResult): string => `${what} ${r.timedOut ? 'did not finish' : `failed (exit ${r.code})`}`;
    const output = (r: UpdateRunResult): string => `${r.stdout}\n${r.stderr}`;
    if (reset.code !== 0 || reset.timedOut) return await this.stuck(failure, failed(`git reset --keep ${short(this.old)}`, reset), output(reset), this.old);
    if (this.ranCi) {
      const ci = await run(this.npm, ['ci'], LIMITS.npmCi, this.npmEnv);
      if (ci.code !== 0 || ci.timedOut) return await this.stuck(failure, failed('npm ci', ci), output(ci), undefined);
    }
    const build = await run(this.npm, ['run', 'build'], LIMITS.build, this.npmEnv);
    if (build.code !== 0 || build.timedOut) return await this.stuck(failure, failed('npm run build', build), output(build), undefined);
    // Back at the old commit is said only of a clean tree: a hook or a build that wrote into it leaves it for a person.
    const status = await run('git', ['status', '--porcelain', '--untracked-files=normal'], LIMITS.local, this.gitEnv);
    if (status.code !== 0 || status.stdout.trim() !== '') {
      return await this.stuck(failure, status.code !== 0 ? failed('git status', status) : 'the checkout is not clean', output(status), undefined);
    }
    this.sayErr(`mt: ${failure.what}`);
    for (const line of lines(failure.output).slice(-FAILED_TAIL)) this.sayErr(`  ${line}`);
    this.say(`the checkout is back at ${short(this.old)}, and the gateway as it was`);
    throw new Stop(1, undefined);
  }

  /** Going back failed too: what is left, and how to finish by hand. Exit 3. */
  private async stuck(failure: Failure, what: string, output: string, reset: string | undefined): Promise<never> {
    this.sayErr(`mt: ${failure.what}; and going back, ${what}:`);
    for (const line of lines(output).slice(-FAILED_TAIL)) this.sayErr(`  ${line}`);
    const status = await this.deps.run('git', ['status'], { cwd: this.checkout, env: this.gitEnv, timeoutMs: LIMITS.local });
    this.block('git status says:', lines(status.stdout));
    this.block('to finish going back by hand:', finishByHand(this.paths, { reset }));
    this.say('the gateway still runs from memory, but a crash restart would run whatever dist/ and node_modules now hold');
    throw new Stop(3, undefined);
  }

  // -------------------------------------------------------------------------
  // Step 7: restart and confirm.

  private async restart(): Promise<number> {
    const { view } = this;
    const mt = mtCommand(this.node, this.checkout);
    if (!this.willRestart) {
      this.say(
        this.installed
          ? `the service is stopped, so it is not started: start it with ${mt} service start`
          : 'no service is installed: restart the gateway (stop it if it runs, then start it)',
      );
      return 0;
    }
    this.writeLock('restart');
    const from = statSync(view.log, { throwIfNoEntry: false })?.size ?? 0;
    this.say(`restarting ${view.name}`);
    const failed = await view.restart();
    if (failed !== undefined) {
      this.sayErr(`mt: the restart failed: ${failed}`);
      this.say(`the old gateway may have been sent SIGTERM already; whether one runs, and which, is for ${mt} service status`);
      this.stepsBackAfterRestart();
      return 3;
    }
    this.writeLock('confirm');
    for (let waited = 0; ; waited += POLL_MS) {
      const seen = lines(readFrom(view.log, from));
      const failure = seen.find((l) => l.startsWith('configuration error:') || l.startsWith('failed to start:'));
      if (failure !== undefined) {
        this.sayErr(`mt: the new gateway did not start: ${failure}`);
        return this.notConfirmed();
      }
      const schema = seen.findIndex((l) => / schema at version [0-9]+ \(/.test(l));
      const connected = schema === -1 ? -1 : seen.findIndex((l, i) => i > schema && / connected as /.test(l));
      if (connected !== -1) {
        const version = Number(/ schema at version ([0-9]+) \(/.exec(seen[schema] ?? '')?.[1]);
        if (version < this.newest) {
          this.warn(`the gateway is at schema version ${version}, below the new tree's ${this.newest}: it reads its migrations from elsewhere (MT_SCHEMA_DIR)`);
        }
        this.say(`updated ${this.branch} from ${short(this.old)} to ${short(this.new)}; the gateway is connected, at schema version ${version}`);
        return 0;
      }
      if (waited >= CONFIRM_MS) break;
      await this.deps.sleep(POLL_MS);
    }
    this.sayErr(`mt: the new gateway did not say it connected within ${CONFIRM_MS / 1000} seconds`);
    return this.notConfirmed();
  }

  private notConfirmed(): number {
    this.block(`the service log's last ${LOG_TAIL} lines:`, tailOf(this.view.log, LOG_TAIL));
    this.stepsBackAfterRestart();
    return 3;
  }

  private stepsBackAfterRestart(): void {
    if (this.backup === undefined) this.say('no backup was taken, as there was no database: the steps back leave out the restore');
    this.block(
      'the steps back, never taken by themselves: the new gateway may have migrated and written, and a restore loses what it wrote since the backup:',
      stepsBack(this.paths, { old: this.old, backup: this.backup }),
    );
  }

  // -------------------------------------------------------------------------

```

In `src/cli/update.ts`, replace:

```ts
      await this.show();
      return 0;
```

with:

```ts
      if (!(await this.show())) return 0;
      if (this.opts.check) return 0;
      await this.confirm();
      await this.apply();
      return await this.restart();
```

- [ ] **Step 10.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1919 passed (1919)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 10.5: Commit.**

```bash
git add src/cli/mt.ts src/cli/update.ts tests/mt-update-apply.test.ts tests/mt-update-restart.test.ts tests/mt-update-show.test.ts
git commit -m "Have mt update fast-forward, run npm ci only when the dependencies changed, build, check the new build, back up and restart, going back on a failure, and stop with exit 3 when the gateway moved"
```

---

### Task 11: A lock left by an update that died

**Files:**

- Create: `tests/mt-update-locks.test.ts`
- Modify: `src/cli/update.ts`

Spec §20.10. A held lock whose pid is dead is refused, as before, and now with what to do, and the lock is never removed: at `check` or `show`, that it changed nothing and the `rm`; later, the database's `user_version` read again, read-only, from the lock's `db`: unchanged, the steps back, with the restore only when the lock names a backup; moved, the steps forward, and at `restart` or `confirm` with a backup, the steps back with its restore besides. Then one `rm` of every lock naming the dead pid, the checkout's and the home's, read both. A checkout's lock of another home gives no steps, only `run MT_HOME=<home> mt update`; a database that cannot be read gives both ways. An error nothing foresaw after step 3 keeps the locks for that advice, exit 3; before step 4 it releases them, exit 1.

- [ ] **Step 11.1: Write the tests.**

Create `tests/mt-update-locks.test.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateLockState, UpdateStep } from '../src/cli/update-lock.js';
import { openDb } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { SECRET } from './helpers/service.js';
import { NEW, OLD, TOP, updateFake, type UpdateFake } from './helpers/update.js';

/**
 * A lock left by an update that died (spec §20.10): never cleared, never
 * taken as up to date, refused with what it says, and what to do: that it
 * changed nothing, or the steps back or forward by the database's version read
 * again, then the rm.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const DEAD = 424_242;
const homeLock = (): string => join(fx.mtHome, 'run', 'update.pid');

function died(step: UpdateStep, extra: Partial<UpdateLockState> = {}, where: 'home' | 'checkout' = 'home'): string {
  const state: UpdateLockState = {
    pid: DEAD,
    home: fx.mtHome,
    checkout: fx.checkout,
    step,
    ...(['check'].includes(step) ? {} : { old: OLD, new: NEW }),
    ...(['check', 'show'].includes(step) ? {} : { servicePid: 4242, userVersion: TOP, db: fx.dbPath }),
    ...extra,
  };
  const path = where === 'home' ? homeLock() : join(fx.repo.gitDir, 'mt-update.lock');
  mkdirSync(join(fx.mtHome, 'run'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state)}\n`);
  return path;
}

function migrateTo(version: number): void {
  const db = openDb(fx.dbPath);
  db.pragma(`user_version = ${version}`);
  db.close();
}

describe('an error nothing foresaw', () => {
  it('after the merge: the locks are kept, saying the step, exit 3; the next run gives the advice', async () => {
    fx = await updateFake();
    fx.onStart = () => {};
    fx.whileSleeping = () => {
      throw new Error(`disk on fire ${SECRET}`);
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('mt: unexpected error at its step confirm: disk on fire ••••');
    expect(r.out).toContain(`its locks are kept, saying where it stopped: ${join(fx.repo.gitDir, 'mt-update.lock')}, ${homeLock()}; run mt update again for what to do`);
    expect(existsSync(homeLock())).toBe(true);
    fx.whileSleeping = () => {};
    const again = await fx.update(['--yes']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('died at its step confirm');
    expect(again.out).toContain('the steps back:');
  });

  it('before the merge: nothing changed, the locks go, exit 1, masked', async () => {
    fx = await updateFake();
    fx.whileAsking = () => {
      throw new Error(`no tty ${SECRET}`);
    };
    const r = await fx.update([], { tty: true });
    expect(r.code).toBe(1);
    expect(r.err).toBe('mt: unexpected error: no tty ••••');
    expect(existsSync(homeLock())).toBe(false);
    expect(existsSync(join(fx.repo.gitDir, 'mt-update.lock'))).toBe(false);
  });
});

describe('a lock left by an update that died', () => {
  for (const step of ['check', 'show'] as const) {
    it(`at ${step}: it changed nothing, remove it; exit 1, the lock kept`, async () => {
      fx = await updateFake();
      const path = died(step);
      const r = await fx.update(['--yes']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(new RegExp(`^mt: an update \\(pid ${DEAD}\\) died at its step ${step}.*; its lock is never cleared by itself: `));
      expect(r.out).toBe(`it changed nothing; remove its lock: rm '${path}'`);
      expect(existsSync(path)).toBe(true);
      expect(fx.ran().some((w) => w.startsWith('git fetch'))).toBe(false);
    });
  }

  for (const step of ['merge', 'npm ci', 'build', 'preflight', 'backup', 'going back'] as const) {
    it(`at ${step}, the database's version unchanged: the steps back, then the rm`, async () => {
      fx = await updateFake();
      const path = died(step);
      const r = await fx.update(['--yes']);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`died at its step ${step}, updating 8b64aa1..4f0c2de`);
      expect(r.out).toContain(`the database is still at version ${TOP}\nthe steps back:`);
      expect(r.out).toContain(`  git reset --keep ${OLD}`);
      expect(r.out).not.toContain('cp ');
      expect(r.out.split('\n').slice(-1)).toEqual([`then remove its lock: rm '${path}'`]);
      expect(r.out).not.toMatch(/up to date/);
    });

    it(`at ${step}, the database's version moved: the steps forward`, async () => {
      fx = await updateFake();
      died(step);
      migrateTo(TOP + 1);
      const r = await fx.update(['--yes']);
      expect(r.out).toContain(`the database moved from version ${TOP} to version ${TOP + 1}: the old build can no longer run on it\nthe steps forward:`);
      expect(r.out).not.toContain('git reset --keep');
    });
  }

  for (const step of ['restart', 'confirm'] as const) {
    it(`at ${step} with a backup named, unchanged: the steps back with its restore`, async () => {
      fx = await updateFake();
      died(step, { backup: '/b/team-v8.db' });
      const r = await fx.update(['--yes']);
      expect(r.out).toContain(`  cp '/b/team-v8.db' '${fx.dbPath}'`);
    });

    it(`at ${step} with a backup named, moved: the steps forward, and the steps back with its restore remain possible`, async () => {
      fx = await updateFake();
      died(step, { backup: '/b/team-v8.db' });
      migrateTo(TOP + 1);
      const r = await fx.update(['--yes']);
      expect(r.out).toContain('the steps forward:');
      expect(r.out).toContain('or the steps back, with its backup, which remain possible:');
      expect(r.out).toContain(`  cp '/b/team-v8.db' '${fx.dbPath}'`);
    });
  }

  it('left in both places: one message, and an rm of both', async () => {
    fx = await updateFake();
    const home = died('build');
    const checkout = died('build', {}, 'checkout');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`its locks are never cleared by itself: ${checkout}, ${home}`);
    expect(r.out.split('\n').slice(-1)).toEqual([`then remove its locks: rm '${checkout}' '${home}'`]);
    expect(r.out.match(/the steps back:/g)).toHaveLength(1);
  });

  it("in the checkout's lock, of another home: no steps, but how to ask that home", async () => {
    fx = await updateFake();
    died('backup', { home: '/srv/other home' }, 'checkout');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toBe("mt: an update of /srv/other home died at its step backup; run MT_HOME='/srv/other home' mt update for what to do");
    expect(r.out).toBe('');
  });

  it("whose database cannot be read: both ways, and how to read the version", async () => {
    fx = await updateFake();
    const garbage = join(fx.root, 'not a database.db');
    writeFileSync(garbage, 'not sqlite at all, but long enough to be read as a header '.repeat(10));
    died('build', { db: garbage });
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^the database's version cannot be read here \(.*\): read it with .* service check$/m);
    expect(r.out).toContain(`at version ${TOP}, the steps back:`);
    expect(r.out).toContain('at another, the steps forward:');
  });

  it("in the checkout's lock too", async () => {
    fx = await updateFake();
    const path = died('build', {}, 'checkout');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.out.split('\n').slice(-1)).toEqual([`then remove its lock: rm '${path}'`]);
  });

  it('a lock file that holds no update', async () => {
    fx = await updateFake();
    mkdirSync(join(fx.mtHome, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(homeLock(), 'garbage');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toBe(`mt: ${homeLock()} holds no update's state; if no mt update runs, remove it: rm '${homeLock()}'`);
  });
});
```

- [ ] **Step 11.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-update-locks.test.ts`. Expected: `Tests  24 failed | 1 passed (25)`: a dead update's lock is refused with no advice, and an error nothing foresaw escapes `mt update` with its locks released.

- [ ] **Step 11.3: Implement.**

In `src/cli/update.ts`, replace:

```ts
import { UpdateLock, type UpdateLockState, type UpdateStep } from './update-lock.js';
```

with:

```ts
import { UNCHANGED_STEPS, UpdateLock, readUpdateLock, type UpdateLockState, type UpdateStep } from './update-lock.js';
```

In `src/cli/update.ts`, replace:

```ts
  private readonly locks: UpdateLock[] = [];
  private lock: UpdateLockState;
```

with:

```ts
  private readonly locks: UpdateLock[] = [];
  /** The checkout's lock and the home's, once known. */
  private lockPaths: string[] = [];
  /** Set when an unexpected error after step 3 leaves the locks for a person. */
  private keepLocks = false;
  private lock: UpdateLockState;
```

In `src/cli/update.ts`, replace:

```ts
  /** A lock found held: an update under way, or one that died. */
```

with:

```ts
  /** A lock found held: an update under way, or one that died, with what to do. */
```

In `src/cli/update.ts`, replace:

```ts
    return new Stop(1, `an update (pid ${held.pid}) died at its step ${held.step}; its lock is never cleared by itself: ${path}`);
```

with:

```ts
    // Died: a kill -9, a power cut, or an error it did not foresee. Never cleared here; what to do depends on how far it got.
    if (held.home !== this.view.mtHome) {
      // The checkout's lock, left by an update of another home: that home's database and service are the ones to look at.
      return new Stop(1, `an update of ${held.home} died at its step ${held.step}; run MT_HOME=${shQuote(held.home)} mt update for what to do`);
    }
    const commits = held.old === undefined ? '' : `, updating ${short(held.old)}..${short(held.new)}`;
    // Both locks it left, named together, so the advice is followed once.
    const left = this.lockPaths.filter((p) => {
      try {
        return readUpdateLock(p)?.pid === held.pid;
      } catch {
        return false;
      }
    });
    if (!left.includes(path)) left.push(path);
    const locks = left.length === 1 ? 'its lock' : 'its locks';
    this.sayErr(`mt: an update (pid ${held.pid}) died at its step ${held.step}${commits}; ${locks} ${left.length === 1 ? 'is' : 'are'} never cleared by itself: ${left.join(', ')}`);
    const rm = `then remove ${locks}: rm ${left.map(shQuote).join(' ')}`;
    if (UNCHANGED_STEPS.includes(held.step)) {
      this.say(`it changed nothing; remove ${locks}: rm ${left.map(shQuote).join(' ')}`);
      return new Stop(1, undefined);
    }
    const paths = { ...this.paths, db: held.db ?? this.dbPath };
    const was = held.userVersion ?? null;
    const back = { old: held.old ?? 'HEAD', backup: held.backup };
    let now: number | null;
    try {
      now = held.db === undefined ? null : versionOf(held.db);
    } catch (err) {
      this.say(`the database's version cannot be read here (${err instanceof Error ? err.message : String(err)}): read it with ${mtCommand(this.node, this.checkout)} service check`);
      this.block(`at ${versionText(was)}, the steps back:`, stepsBack(paths, back));
      this.block('at another, the steps forward:', stepsForward(paths));
      this.say(rm);
      return new Stop(1, undefined);
    }
    if (now === was) {
      this.say(`the database is still at ${versionText(was)}`);
      this.block('the steps back:', stepsBack(paths, back));
    } else {
      this.say(`the database moved from ${versionText(was)} to ${versionText(now)}: the old build can no longer run on it`);
      this.block('the steps forward:', stepsForward(paths));
      if ((held.step === 'restart' || held.step === 'confirm') && held.backup !== undefined) {
        this.block('or the steps back, with its backup, which remain possible:', stepsBack(paths, back));
      }
    }
    this.say(rm);
    return new Stop(1, undefined);
```

In `src/cli/update.ts`, replace:

```ts
    this.takeLock(join(gitDir, 'mt-update.lock'));
```

with:

```ts
    this.lockPaths = [join(gitDir, 'mt-update.lock'), join(view.mtHome, 'run', 'update.pid')];
    this.takeLock(join(gitDir, 'mt-update.lock'));
```

In `src/cli/update.ts`, replace:

```ts
  async run(): Promise<number> {
```

with:

```ts
  /**
   * An error nothing foresaw. Up to step 3 nothing changed: the locks go, exit 1.
   * After it the update may be half way, so the locks stay, saying where it
   * stopped, for the next run's advice: exit 3.
   */
  private unexpected(err: unknown): number {
    const message = err instanceof Error ? err.message : String(err);
    if (UNCHANGED_STEPS.includes(this.lock.step)) {
      this.sayErr(`mt: unexpected error: ${message}`);
      return 1;
    }
    this.keepLocks = true;
    this.sayErr(`mt: unexpected error at its step ${this.lock.step}: ${message}`);
    this.say(`its locks are kept, saying where it stopped: ${this.locks.map((l) => l.path).join(', ')}; run mt update again for what to do`);
    return 3;
  }

  async run(): Promise<number> {
```

In `src/cli/update.ts`, replace:

```ts
      if (!(err instanceof Stop)) throw err;
```

with:

```ts
      if (!(err instanceof Stop)) return this.unexpected(err);
```

In `src/cli/update.ts`, replace:

```ts
      for (const lock of [...this.locks].reverse()) lock.release();
```

with:

```ts
      if (!this.keepLocks) for (const lock of [...this.locks].reverse()) lock.release();
```

- [ ] **Step 11.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1944 passed (1944)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 11.5: Commit.**

```bash
git add src/cli/update.ts tests/mt-update-locks.test.ts
git commit -m "Say what to do when an update's lock was left by one that died: that it changed nothing, or the steps back or forward by the database's version read again"
```

---

### Task 12: Signals, and a terminal that is gone

**Files:**

- Create: `tests/mt-update-signals.test.ts`
- Modify: `src/cli/update.ts`

Spec §20.11. SIGINT, SIGHUP and SIGTERM, through `UpdateDeps.onSignal`, are one. Before the merge (`phase` `before`) the running call's group is killed through its `AbortSignal`, the question too, and the update ends, nothing changed, exit 1. From the merge to the backup (`changing`) the running command is let finish and `goBackIf` goes back. Going back ignores a second one. The restart call is let finish, and the wait then stops: exit 3 with the steps back. A signal after step 3's last call stops at the start of `apply()`, and before `--check` returns. The update wraps `io.out` and `io.err` so EPIPE and EIO are no failure, and calls `guardOutput` first.

- [ ] **Step 12.1: Write the tests.**

Create `tests/mt-update-signals.test.ts`:

```ts
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets } from '../src/secrets.js';
import { OLD, updateFake, type UpdateFake, type Run } from './helpers/update.js';

/**
 * Signals and a closed terminal (spec §20.11): SIGINT, SIGHUP and SIGTERM are
 * one. Before the merge the running child is stopped and nothing changes,
 * exit 1; from the merge to the backup the running command is let finish and
 * the update goes back; a second one while going back is ignored; the restart
 * call is let finish and the wait stops, exit 3. EPIPE and EIO on output are
 * not a failure.
 */

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const words = (run: Run): string =>
  run.cmd === fx.node ? `node ${run.args.slice(1).join(' ')}` : [run.cmd === fx.npm ? 'npm' : run.cmd, ...run.args].join(' ');
const restarted = (): boolean => fx.words().some((w) => / kill SIGTERM | kickstart /.test(` ${w} `));

describe('a signal before the merge', () => {
  for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) {
    it(`${signal} during the fetch: its group is stopped, nothing changed, exit 1`, async () => {
      fx = await updateFake();
      let aborted: boolean | undefined;
      fx.answer = (run) => {
        if (run.args[0] !== 'fetch') return undefined;
        fx.signal?.(signal);
        aborted = run.opts.signal?.aborted;
        return { code: 143 };
      };
      const r = await fx.update(['--yes']);
      expect(r.code).toBe(1);
      expect(aborted).toBe(true);
      expect(r.err).toBe(`mt: interrupted by ${signal}: nothing changed`);
      expect(fx.ran().some((w) => w.startsWith('git merge --ff-only'))).toBe(false);
      expect(existsSync(join(fx.mtHome, 'run', 'update.pid'))).toBe(false);
    });
  }

  it('at the question: nothing changed, exit 1', async () => {
    fx = await updateFake();
    fx.whileAsking = () => fx.signal?.('SIGINT');
    const r = await fx.update([], { tty: true });
    expect(r.code).toBe(1);
    expect(r.err).toBe('mt: interrupted by SIGINT: nothing changed');
    expect(fx.ran().some((w) => w.startsWith('git merge --ff-only'))).toBe(false);
  });
});

describe('a signal after the last call of step 3', () => {
  for (const argv of [['--yes'], ['--check']]) {
    it(`stops ${argv[0]} with nothing changed, exit 1`, async () => {
      fx = await updateFake();
      const r = await fx.update(argv, {
        out: (line) => {
          if (line.startsWith('the service is running')) fx.signal?.('SIGTERM');
        },
      });
      expect(r.code).toBe(1);
      expect(r.err).toBe('mt: interrupted by SIGTERM: nothing changed');
      expect(fx.ran().some((w) => w.startsWith('git merge --ff-only'))).toBe(false);
    });
  }
});

describe('a signal from the merge to the backup', () => {
  for (const [word, step] of [
    ['git merge --ff-only', 'the merge'],
    ['npm run build', 'the build'],
    ['node service check', 'the check'],
  ] as const) {
    it(`during ${step}: let finish, then going back, exit 1`, async () => {
      fx = await updateFake();
      let builds = 0;
      fx.answer = (run) => {
        if (words(run).startsWith(word) && (word !== 'npm run build' || builds++ === 0)) fx.signal?.('SIGTERM');
        return undefined;
      };
      const r = await fx.update(['--yes']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('SIGTERM: going back once the running command ends');
      expect(r.err).toBe('mt: interrupted by SIGTERM');
      expect(fx.ran()).toContain(`git reset --keep ${OLD}`);
      expect(restarted()).toBe(false);
    });
  }

  it('during npm ci: let finish, then going back with npm ci again', async () => {
    fx = await updateFake();
    fx.repo.depsChanged = true;
    let cis = 0;
    fx.answer = (run) => {
      if (words(run) === 'npm ci' && cis++ === 0) fx.signal?.('SIGHUP');
      return undefined;
    };
    expect((await fx.update(['--yes'])).code).toBe(1);
    expect(fx.ran().filter((w) => w === 'npm ci')).toHaveLength(2);
  });

  it('a second one while going back is ignored, and going back carries on', async () => {
    fx = await updateFake();
    let builds = 0;
    fx.answer = (run) => {
      if (words(run) === 'npm run build' && builds++ === 0) fx.signal?.('SIGINT');
      if (run.args[0] === 'reset') fx.signal?.('SIGINT');
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('SIGINT: ignored, as stopping now would leave the state being undone');
    expect(fx.ran().slice(-3)).toEqual([`git reset --keep ${OLD}`, 'npm run build', 'git status --porcelain --untracked-files=normal']);
  });
});

describe('a signal at the restart', () => {
  it("during macOS's drain: the call is let finish, then the steps back, exit 3", async () => {
    fx = await updateFake();
    fx.override = (c) => {
      if (c.args[0] === 'kill') fx.signal?.('SIGINT');
      return undefined;
    };
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(fx.words()).toContain('launchctl kickstart gui/501/team.manus.gateway');
    expect(r.out).toContain('SIGINT: the restart call is let finish');
    expect(r.err).toBe('mt: interrupted by SIGINT while waiting for the new gateway to connect');
    expect(r.out).toContain('the steps back, never taken by themselves');
    expect(readdirSync(join(fx.mtHome, 'backups'))).toHaveLength(1);
  });

  it("during Linux's systemctl restart: likewise, exit 3", async () => {
    fx = await updateFake();
    fx.install({ platform: 'linux' });
    fx.job.pid = 4242;
    fx.override = (c) => {
      if (c.args[1] === 'restart') fx.signal?.('SIGTERM');
      return undefined;
    };
    const r = await fx.update(['--yes'], { platform: 'linux' });
    expect(r.code).toBe(3);
    expect(fx.words()).toContain('systemctl --user restart manus-team.service');
  });

  it('during the wait: it stops waiting, exit 3', async () => {
    fx = await updateFake();
    fx.onStart = () => {};
    fx.whileSleeping = () => fx.signal?.('SIGHUP');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(3);
    expect(fx.slept).toBe(250);
    expect(r.err).toBe('mt: interrupted by SIGHUP while waiting for the new gateway to connect');
  });
});

describe('output that cannot be written', () => {
  it('is no failure: EPIPE and EIO are ignored, and the update goes on', async () => {
    fx = await updateFake();
    let n = 0;
    const r = await fx.update(['--yes'], {
      out: () => {
        n += 1;
        const err = Object.assign(new Error('write EPIPE'), { code: n % 2 === 0 ? 'EPIPE' : 'EIO' });
        throw err;
      },
    });
    expect(r.code).toBe(0);
    expect(n).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 12.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-update-signals.test.ts`. Expected: `Tests  15 failed (15)`: no handler is given to `onSignal`, so a signal changes nothing, and a write that throws EPIPE ends the update.

- [ ] **Step 12.3: Implement.**

In `src/cli/update.ts`, replace:

```ts
class Update {
```

with:

```ts
/** Where the update is, for what a signal does (spec §20.11). */
type Phase = 'before' | 'changing' | 'going back' | 'restart' | 'waiting';

class Update {
```

In `src/cli/update.ts`, replace:

```ts
  private lock: UpdateLockState;
  private readonly abort = new AbortController();
```

with:

```ts
  private lock: UpdateLockState;
  private phase: Phase = 'before';
  private signalled: NodeJS.Signals | undefined;
  private readonly abort = new AbortController();
```

In `src/cli/update.ts`, replace:

```ts
    this.io = io;
```

with:

```ts
    // Output that cannot be written is no failure, the service's own lines included.
    const safe =
      (write: (line: string) => void) =>
      (line: string): void => {
        try {
          write(line);
        } catch (err) {
          if (!isClosedOutput(err)) throw err;
        }
      };
    this.io = { ...io, out: safe(io.out), err: safe(io.err) };
```

In `src/cli/update.ts`, replace:

```ts
  private async call(cmd: string, args: readonly string[], timeoutMs: number, env: Env): Promise<{ r: UpdateRunResult; said: string }> {
    const r = await this.deps.run(cmd, args, { cwd: this.checkout, env, timeoutMs });
    return { r, said: (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ').replace(/\.$/, '') };
```

with:

```ts
  private async call(cmd: string, args: readonly string[], timeoutMs: number, env: Env): Promise<{ r: UpdateRunResult; said: string }> {
    const before = this.phase === 'before';
    const r = await this.deps.run(cmd, args, { cwd: this.checkout, env, timeoutMs, signal: before ? this.abort.signal : undefined });
    if (before && this.signalled !== undefined) throw new Stop(1, `interrupted by ${this.signalled}: nothing changed`);
    return { r, said: (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ').replace(/\.$/, '') };
```

In `src/cli/update.ts`, replace:

```ts
    const question = this.willRestart ? 'update and restart the service? [y/N] ' : 'update, and back up the database? [y/N] ';
    const answer = await this.deps.ask(question, this.abort.signal);
```

with:

```ts
    let answer: string;
    try {
      answer = await this.deps.ask(this.willRestart ? 'update and restart the service? [y/N] ' : 'update, and back up the database? [y/N] ', this.abort.signal);
    } catch (err) {
      if (this.signalled !== undefined) throw new Stop(1, `interrupted by ${this.signalled}: nothing changed`);
      throw err;
    }
    if (this.signalled !== undefined) throw new Stop(1, `interrupted by ${this.signalled}: nothing changed`);
```

In `src/cli/update.ts`, replace:

```ts
  private async apply(): Promise<void> {
    const merge = await this.step('merge', `merging ${this.upstream}, fast-forward only`, 'git', ['merge', '--ff-only', this.upstream], LIMITS.hook, this.gitEnv);
```

with:

```ts
  private async apply(): Promise<void> {
    if (this.signalled !== undefined) throw new Stop(1, `interrupted by ${this.signalled}: nothing changed`);
    this.phase = 'changing';
    const merge = await this.step('merge', `merging ${this.upstream}, fast-forward only`, 'git', ['merge', '--ff-only', this.upstream], LIMITS.hook, this.gitEnv);
```

In `src/cli/update.ts`, replace:

```ts
  private async goBackIf(failure: Failure | undefined): Promise<void> {
```

with:

```ts
  /** Go back after a failure, or after a signal once the command running at it has ended (spec §20.11). */
  private async goBackIf(failure: Failure | undefined): Promise<void> {
```

In `src/cli/update.ts`, replace:

```ts
    if (failure !== undefined) await this.goBack(failure);
  }
```

with:

```ts
    if (failure !== undefined) await this.goBack(failure);
    if (this.signalled !== undefined) await this.goBack({ what: `interrupted by ${this.signalled}`, output: '' });
  }
```

In `src/cli/update.ts`, replace:

```ts
    this.unmoved();
    this.writeLock('going back');
```

with:

```ts
    this.unmoved();
    this.phase = 'going back';
    this.writeLock('going back');
```

In `src/cli/update.ts`, replace:

```ts
    this.writeLock('restart');
    const from = statSync(view.log, { throwIfNoEntry: false })?.size ?? 0;
```

with:

```ts
    this.writeLock('restart');
    this.phase = 'restart';
    const from = statSync(view.log, { throwIfNoEntry: false })?.size ?? 0;
```

In `src/cli/update.ts`, replace:

```ts
    }
    this.writeLock('confirm');
```

with:

```ts
    }
    this.phase = 'waiting';
    this.writeLock('confirm');
```

In `src/cli/update.ts`, replace:

```ts
    for (let waited = 0; ; waited += POLL_MS) {
```

with:

```ts
    for (let waited = 0; this.signalled === undefined; waited += POLL_MS) {
```

In `src/cli/update.ts`, replace:

```ts
    this.sayErr(`mt: the new gateway did not say it connected within ${CONFIRM_MS / 1000} seconds`);
```

with:

```ts
    this.sayErr(
      this.signalled !== undefined
        ? `mt: interrupted by ${this.signalled} while waiting for the new gateway to connect`
        : `mt: the new gateway did not say it connected within ${CONFIRM_MS / 1000} seconds`,
    );
```

In `src/cli/update.ts`, replace:

```ts
  // -------------------------------------------------------------------------

  /**
   * An error nothing foresaw. Up to step 3 nothing changed: the locks go, exit 1.
```

with:

```ts
  // -------------------------------------------------------------------------

  private onSignal(signal: NodeJS.Signals): void {
    if (this.phase === 'going back') {
      this.say(`${signal}: ignored, as stopping now would leave the state being undone`);
      return;
    }
    if (this.signalled !== undefined) return;
    this.signalled = signal;
    if (this.phase === 'before') this.abort.abort();
    else if (this.phase === 'changing') this.say(`${signal}: going back once the running command ends`);
    else if (this.phase === 'restart') this.say(`${signal}: the restart call is let finish`);
  }

  /**
   * An error nothing foresaw. Up to step 3 nothing changed: the locks go, exit 1.
```

In `src/cli/update.ts`, replace:

```ts
  async run(): Promise<number> {
    try {
```

with:

```ts
  async run(): Promise<number> {
    this.deps.guardOutput();
    const off = this.deps.onSignal((signal) => this.onSignal(signal));
    try {
```

In `src/cli/update.ts`, replace:

```ts
      if (this.opts.check) return 0;
```

with:

```ts
      if (this.opts.check) {
        if (this.signalled !== undefined) throw new Stop(1, `interrupted by ${this.signalled}: nothing changed`);
        return 0;
      }
```

In `src/cli/update.ts`, replace:

```ts
    } finally {
      this.db?.close();
```

with:

```ts
    } finally {
      off();
      this.db?.close();
```

- [ ] **Step 12.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1959 passed (1959)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 12.5: Commit.**

```bash
git add src/cli/update.ts tests/mt-update-signals.test.ts
git commit -m "Take SIGINT, SIGHUP and SIGTERM as one in mt update, stopping before the merge, going back after it, letting the restart finish, and never failing at a closed terminal"
```

---

### Task 13: install's closing line, and the README

**Files:**

- Modify: `README.md`, `src/cli/service.ts`, `tests/mt-service.test.ts`

Spec §20.13. `mt service install` ends with `to deploy a change: mt update`, and `service.ts`'s comment names it. The README's "Running as a service" lists `mt service check`; its "Deploying" gives `mt update`, `--check` and `--yes`, what each step does, the exit codes, and the deploy by hand kept for a gateway run by hand; "The mt command" lists both.

- [ ] **Step 13.1: Write the tests.**

In `tests/mt-service.test.ts`, replace:

```ts
    expect(r.out).toContain('mt service status');
    expect(r.out).not.toMatch(/warning/);
```

with:

```ts
    expect(r.out).toContain('mt service status');
    expect(r.out.split('\n').slice(-1)).toEqual(['to deploy a change: mt update']);
    expect(r.out).not.toMatch(/warning/);
```

- [ ] **Step 13.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/mt-service.test.ts`. Expected: `Tests  1 failed | 46 passed (47)`: install still ends with `npm run build && mt service restart`.

- [ ] **Step 13.3: Implement.**

In `README.md`, replace:

````markdown
mt service uninstall    # stop it and remove the unit; $MT_HOME is left as it is
```
````

with:

````markdown
mt service uninstall    # stop it and remove the unit; $MT_HOME is left as it is
mt service check        # would this build start as the service? install's check, without installing
```
````

In `README.md`, replace:

```markdown
git pull && npm ci && npm run build && mt service restart
```

with:

````markdown
mt update            # show what's new on the branch, ask, then update and restart
mt update --check    # only show what's new; change nothing
mt update --yes      # no question, for scripts
```

`mt update` updates the checkout this `mt` runs from, which must be the one the service runs, on
the branch checked out, from the upstream that branch tracks (`git branch
--set-upstream-to=origin/main` names one). It refuses a checkout that is not clean, or that has
commits its upstream lacks. Before it changes anything it shows the commits, any new migration,
whether `npm ci` runs, how many agent runs a restart interrupts, and whether the service is
restarted. Then it fast-forwards, runs `npm ci` only when `package.json` or `package-lock.json`
changed, builds, and has the new build check itself (`mt service check`); a failure there goes
back to the old commit and its build, and the running gateway never notices. It backs the
database up to `$MT_HOME/backups`, owner-only (the five newest are kept, and the newest of each
schema version), restarts the service, and waits up to 60 seconds for the log to say the gateway
connected. If it does not, it prints the log's last lines and the steps back, to take by hand: it
never goes back by itself once the new gateway has the database. A stopped service is left
stopped. It exits 0 when done or up to date, 1 when it refused or went back and nothing changed,
and 3 when a person is needed, saying what to do. A build refuses a database that a newer build
migrated, with `configuration error:` and exit 78, so an old build put back by hand stops rather
than run on it: restore the backup of its version first.

A gateway run by hand (`npm run dev`, `npm start`) is not restarted, and `mt update` refuses while
one holds the home: stop it, run `mt update`, then start it again. The deploy by hand is still:

```bash
git pull && npm ci && npm run build   # then restart the gateway
````

In `README.md`, replace:

```markdown
mt service logs [-f] [-n <lines>]
mt kanban board list [all]
```

with:

```markdown
mt service logs [-f] [-n <lines>]
mt service check
mt update [--check | --yes]
mt kanban board list [all]
```

In `src/cli/service.ts`, replace:

```ts
 * `npm run build && mt service restart`.
```

with:

```ts
 * `mt update` (`cli/update.ts`), which ends with `mt service restart`'s code.
```

In `src/cli/service.ts`, replace:

```ts
    io.out('to deploy a change: npm run build && mt service restart');
```

with:

```ts
    io.out('to deploy a change: mt update');
```

- [ ] **Step 13.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1959 passed (1959)`. Run `npx vitest run --project e2e`. Expected: `Tests  157 passed (157)`. Run `npm run typecheck`. Expected: no errors. Run `git diff -- README.md | grep "^+" | grep -c "—"`. Expected: `0`.

- [ ] **Step 13.5: Commit.**

```bash
git add README.md src/cli/service.ts tests/mt-service.test.ts
git commit -m "Name mt update in install's closing line and in the README's Deploying, with mt service check"
```

---

### Task 14: End to end, with real git

**Files:**

- Create: `tests/mt-update.e2e.ts`

Spec §20.14. A bare origin and a clone tracking it, in a temporary directory; a fake npm beside a real node, whose `ci` and `run build` write marker files, the build failing when the tree holds `FAIL_BUILD`; the fake launchd of `tests/helpers/service.ts`, whose gateway appends its two startup lines at each start; `realUpdateDeps` with that service, so git, npm and the check run for real. Then the backup of a real WAL database while another process writes to it, restored as §20.9 says.

- [ ] **Step 14.1: Write the test.**

Create `tests/mt-update.e2e.ts`:

```ts
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { realUpdateDeps, type UpdateDeps } from '../src/cli/update.js';
import { backupDatabase } from '../src/db/backup.js';
import { highestMigration, migrate, openDb, openDbReadOnly, type Db } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { serviceFake, type ServiceFake } from './helpers/service.js';
import { startupLines } from './helpers/update.js';

/**
 * `mt update` with real git, against a temporary bare origin (spec §20.14): a
 * clone tracking it, a fake npm beside a real node whose ci and build write
 * marker files, and a fake service whose gateway appends its two startup lines
 * at each start. Nothing reaches the network, the real service or the real home.
 */

const TOP = highestMigration(SCHEMA_DIR);

interface Fx {
  svc: ServiceFake;
  origin: string;
  seed: string;
  marks: string;
  git(cwd: string, ...args: string[]): string;
  commit(message: string, files: Record<string, string>): string;
  update(argv: string[]): Promise<{ code: number; out: string; err: string }>;
  head(): string;
}

let fx: Fx | undefined;
afterEach(() => {
  clearSecrets();
  fx?.svc.cleanup();
  fx = undefined;
});

/** git's environment, never the real home's config: no global or system file, and the made-up home. */
const GIT_ENV = {
  PATH: process.env['PATH'],
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** The fake npm: `ci` writes the installed tree's marker, `run build` a dist/ whose mt.js answers service check, failing when FAIL_BUILD is in the tree. */
const NPM = `#!/bin/sh
case "$1" in
  ci) mkdir -p node_modules && echo '{}' > node_modules/.package-lock.json && echo ci >> "$MARKS" ;;
  run)
    if [ -f FAIL_BUILD ]; then echo 'src/x.ts(1,1): error TS1005' >&2; exit 2; fi
    mkdir -p dist
    printf '%s\\n' "console.log('database: e2e at version 1; this build: up to 1'); console.log('ok: this build would start');" > dist/mt.js
    : > dist/main.js
    echo "build $(git rev-parse --short HEAD)" >> "$MARKS"
    ;;
esac
`;

async function fixture(): Promise<Fx> {
  const svc = await serviceFake();
  const { root, checkout } = svc;
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const marks = join(root, 'marks');
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', args, { cwd, env: { ...GIT_ENV, HOME: svc.home }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(root, 'clone', '--quiet', origin, seed);
  const commit = (message: string, files: Record<string, string>): string => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(seed, path, '..'), { recursive: true });
      if (text === '') rmSync(join(seed, path), { force: true });
      else writeFileSync(join(seed, path), text);
    }
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', message);
    git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  commit('The first commit', {
    'package.json': '{"name":"e2e"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    '.gitignore': 'dist/\nnode_modules/\n',
    'schema/001_first.sql': 'SELECT 1;\n',
  });
  rmSync(checkout, { recursive: true, force: true });
  git(root, 'clone', '--quiet', origin, checkout);
  mkdirSync(join(checkout, 'node_modules'));
  writeFileSync(join(checkout, 'node_modules', '.package-lock.json'), '{}');
  mkdirSync(join(checkout, 'dist'));
  writeFileSync(join(checkout, 'dist', 'main.js'), '');

  // A real node, with the fake npm beside it.
  rmSync(svc.node);
  symlinkSync(process.execPath, svc.node);
  writeFileSync(join(root, 'node bin', 'npm'), NPM);
  chmodSync(join(root, 'node bin', 'npm'), 0o755);

  const db = openDb(join(svc.mtHome, 'team.db'));
  migrate(db, SCHEMA_DIR);
  db.close();
  svc.install();
  svc.job.pid = 4242;
  mkdirSync(join(svc.mtHome, 'logs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(svc.mtHome, 'logs', 'gateway.log'), '', { mode: 0o600 });
  svc.onStart = () => appendFileSync(join(svc.mtHome, 'logs', 'gateway.log'), startupLines(TOP, join(svc.mtHome, 'team.db')));

  const f: Fx = {
    svc,
    origin,
    seed,
    marks,
    git,
    commit,
    head: () => git(checkout, 'rev-parse', 'HEAD'),
    async update(argv) {
      const out: string[] = [];
      const err: string[] = [];
      const service = svc.deps();
      const deps: UpdateDeps = { ...realUpdateDeps(service), guardOutput: () => {}, ask: async () => 'n' };
      const code = await runMt(['update', ...argv], {
        env: { ...GIT_ENV, HOME: svc.home, MARKS: marks },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        service,
        update: deps,
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
  };
  return f;
}

const marks = (f: Fx): string[] => (existsSync(f.marks) ? readFileSync(f.marks, 'utf8').trim().split('\n') : []);

describe('mt update against a real origin', () => {
  it('--check shows the commit pushed, and changes nothing', async () => {
    fx = await fixture();
    const old = fx.head();
    fx.commit('Add a feature', { 'src/feature.ts': 'export {};\n' });
    const r = await fx.update(['--check']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^1 new commit, [0-9a-f]{7}\.\.[0-9a-f]{7}:\n {2}[0-9a-f]{7} Add a feature$/m);
    expect(fx.head()).toBe(old);
    expect(marks(fx)).toEqual([]);
    expect(fx.svc.words().filter((w) => / (kill|kickstart) /.test(` ${w} `))).toEqual([]);
  });

  it('--yes fast-forwards, builds, checks, backs up and restarts the service, confirmed by its log', async () => {
    fx = await fixture();
    const newer = fx.commit('Add a feature', { 'src/feature.ts': 'export {};\n' });
    const r = await fx.update(['--yes']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(fx.head()).toBe(newer);
    // Neither package file changed and the tree was there: no npm ci.
    expect(marks(fx)).toEqual([`build ${newer.slice(0, 7)}`]);
    expect(fx.svc.words()).toContain('launchctl kickstart gui/501/team.manus.gateway');
    expect(readdirSync(join(fx.svc.mtHome, 'backups'))).toHaveLength(1);
    expect(r.out).toContain(`the gateway is connected, at schema version ${TOP}`);
    expect(fx.git(fx.svc.checkout, 'status', '--porcelain')).toBe('');
  });

  it('runs npm ci when the lockfile changed', async () => {
    fx = await fixture();
    fx.commit('Bump a dependency', { 'package-lock.json': '{"lockfileVersion":3,"x":1}\n' });
    expect((await fx.update(['--yes'])).code).toBe(0);
    expect(marks(fx)[0]).toBe('ci');
  });

  it('a failing build leaves the branch at the old commit, the push still ahead, the service untouched', async () => {
    fx = await fixture();
    const old = fx.head();
    fx.commit('Break the build', { FAIL_BUILD: 'yes\n' });
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('mt: npm run build failed (exit 2)\n  src/x.ts(1,1): error TS1005');
    expect(fx.head()).toBe(old);
    expect(fx.git(fx.svc.checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(fx.git(fx.svc.checkout, 'rev-list', '--count', 'HEAD..origin/main')).toBe('1');
    expect(existsSync(join(fx.svc.checkout, 'FAIL_BUILD'))).toBe(false);
    expect(fx.git(fx.svc.checkout, 'status', '--porcelain')).toBe('');
    expect(fx.svc.words().filter((w) => / (kill|kickstart) /.test(` ${w} `))).toEqual([]);
    expect(existsSync(join(fx.svc.mtHome, 'backups'))).toBe(false);
  });

  it('refuses a commit made in the checkout', async () => {
    fx = await fixture();
    fx.commit('Upstream moves', { 'a.txt': 'a\n' });
    writeFileSync(join(fx.svc.checkout, 'local.txt'), 'mine\n');
    fx.git(fx.svc.checkout, 'add', 'local.txt');
    fx.git(fx.svc.checkout, 'commit', '--quiet', '-m', 'A local commit');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('main has commits origin/main does not: made here, or origin/main was rewritten (force-pushed)');
  });

  it('refuses an origin that was force-pushed', async () => {
    fx = await fixture();
    fx.commit('A commit the clone fetches', { 'a.txt': 'a\n' });
    expect((await fx.update(['--yes'])).code).toBe(0);
    fx.git(fx.seed, 'reset', '--quiet', '--hard', 'HEAD~1');
    writeFileSync(join(fx.seed, 'b.txt'), 'b\n');
    fx.git(fx.seed, 'add', 'b.txt');
    fx.git(fx.seed, 'commit', '--quiet', '-m', 'History rewritten');
    fx.git(fx.seed, 'push', '--quiet', '--force', 'origin', 'HEAD:main');
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('main has commits origin/main does not');
  });
});

describe('the backup of a real WAL database, written to meanwhile', () => {
  it('is a consistent copy, restored as the steps back say, and opened at the version it had', async () => {
    fx = await fixture();
    const dbPath = join(fx.svc.mtHome, 'team.db');
    const setup = openDb(dbPath);
    setup.exec('CREATE TABLE probe (n INTEGER)');
    setup.close();
    // A second connection, in another process, writing all the while.
    const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
    const writer = spawn(
      process.execPath,
      ['-e', `const D = require(${JSON.stringify(sqlite)}); const db = new D(${JSON.stringify(dbPath)}); db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 1000'); let n = 0; console.log('ready'); setInterval(() => db.prepare('INSERT INTO probe VALUES (?)').run(++n), 1);`],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise<void>((ready) => writer.stdout.once('data', () => ready()));
      await new Promise((wait) => setTimeout(wait, 200));
      const reader = openDbReadOnly(dbPath) as Db;
      const dir = join(fx.svc.mtHome, 'backups');
      mkdirSync(dir, { mode: 0o700 });
      let path: string;
      try {
        ({ path } = await backupDatabase(reader, { dir, dbPath, version: TOP, sha: fx.head(), at: new Date() }));
      } finally {
        reader.close();
      }
      await new Promise((wait) => setTimeout(wait, 100));
      writer.kill('SIGKILL');
      await new Promise((gone) => writer.once('exit', gone));
      const copied = new Database(path, { readonly: true });
      const rows = (copied.prepare('SELECT count(*) AS n FROM probe').get() as { n: number }).n;
      copied.close();
      expect(rows).toBeGreaterThan(0);

      // The newer database, then the restore of §20.9: its -wal and -shm removed, the backup copied over it.
      const newer = openDb(dbPath);
      newer.pragma(`user_version = ${TOP + 1}`);
      newer.close();
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      copyFileSync(path, dbPath);
      const restored = openDb(dbPath);
      try {
        expect(Number(restored.pragma('user_version', { simple: true }))).toBe(TOP);
        expect(restored.pragma('quick_check', { simple: true })).toBe('ok');
        expect((restored.prepare('SELECT count(*) AS n FROM probe').get() as { n: number }).n).toBe(rows);
      } finally {
        restored.close();
      }
    } finally {
      writer.kill('SIGKILL');
    }
  });
});
```

- [ ] **Step 14.2: Run it.** Run `npx vitest run --project e2e tests/mt-update.e2e.ts`. Expected: `Tests  7 passed (7)`.

- [ ] **Step 14.3: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  1959 passed (1959)`. Run `npx vitest run --project e2e`. Expected: `Tests  164 passed (164)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 14.4: Commit.**

```bash
git add tests/mt-update.e2e.ts
git commit -m "Test mt update end to end against a real bare origin, and the backup of a WAL database written to meanwhile, restored at its version"
```

## Done when

- `npx vitest run --project unit` gives `Tests  1999 passed (1999)`, with the review follow-ups. `npx vitest run --project e2e` gives `Tests  164 passed (164)`, run twice. `npm run typecheck` and `npm run build` report no errors. All under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing, and `git diff 31313b2 -- src README.md | grep "^+" | grep -c "—"` prints `0`.
- A build refuses a database newer than its migrations, before running any, and the gateway stops with `configuration error:` and exit 78, its database closed (`tests/schema-too-new.test.ts`).
- `mt service status` says `loaded: unknown (...)` when launchd's domain or systemd's user bus cannot be asked (`tests/mt-service.test.ts`).
- `mt service check` prints the database's version first, then install's check with the unit's `PATH`, or a hand-run gateway's with no unit, then loads the new build's modules and native module (`tests/mt-service-check.test.ts`).
- `mt update --check` changes nothing; every refusal of step 2 is exit 1 with nothing changed; `mt update --yes` fast-forwards, builds, checks, backs up and restarts, confirmed by `connected as`, goes back on each failure before the restart, and stops with exit 3 and the steps back or forward when a person is needed (`tests/mt-update-*.test.ts`).
- A dead update's locks are named together with one `rm`, another home's checkout lock sends to that home, and an error nothing foresaw after step 3 keeps the locks, exit 3 (`tests/mt-update-locks.test.ts`); a signal after step 3's last call changes nothing (`tests/mt-update-signals.test.ts`); a tree not clean after going back is stuck, exit 3 (`tests/mt-update-apply.test.ts`).
- End to end, with real git: `--check` changes nothing, `--yes` updates and restarts, a failing build leaves the old commit, a local commit and a force-push are refused, and a WAL database's backup taken while another process writes is restored at the version it had (`tests/mt-update.e2e.ts`).

## Before relying on it: the smoke checklist

For the user, once the plan is built and merged, on the real host, before a deploy is left to `mt update`. Run each command as the gateway's user. `<checkout>` below is the checkout's path. On this host no service is installed yet, `mt` is not on `PATH`, `$MT_HOME/bin/mt` runs `src/mt.ts` through tsx rather than the build, and the live database is at version 7: step 0 makes it ready. Until `PATH` has an `mt` that is this build's, `<mt>` in every item is `~/.nvm/versions/node/v22.15.0/bin/node <checkout>/dist/mt.js`, never a bare `mt`. The items need the service installed (`<mt> service status` says `running: yes`), the checkout on `main` tracking `origin/main`, and a scratch branch pushed to the origin for items 6 and 7.

0. **Make the host ready**, once, in this order.
   1. Stop any `npm run dev` gateway (Ctrl-C in its terminal): it holds the home, and the service could not take it.
   2. Back up the database first, while nothing has it open: `sqlite3 ~/.manus-team/team.db ".backup /tmp/team-v7.db"`. The first start below migrates it from version 7 to 8, and to any later version on this branch; this copy is the way back from that.
   3. Build and install the service with Node 22: `cd <checkout> && PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH npm run build && ~/.nvm/versions/node/v22.15.0/bin/node dist/mt.js service install`. Install records the node that runs it, and the service runs that node from then on, so the default node (23 here, for which `better-sqlite3` would not load) must never run it. Install starts the service: its first start, which migrates the database.
   4. From here on, until `PATH` has `mt`, name it as `~/.nvm/versions/node/v22.15.0/bin/node <checkout>/dist/mt.js`, the `<mt>` of every item.

**macOS (launchd).**

1. **The first run.** After step 0, the service already runs this build, and its first start was this build's: `<mt> service logs -n 20` says `schema at version 8` and `connected as`; go on to item 2. On a host whose service runs a build from before this plan instead, which has no `mt update`, deploy this build once by hand, with the node the service runs, the `node:` line of `<mt> service status`, first on `PATH`, never the shell's default node (23 here, for which a build of `better-sqlite3` would not load in the service): `git -C <checkout> pull && cd <checkout> && PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH npm run build && <mt> service restart`, with that node's directory in place of `~/.nvm/versions/node/v22.15.0/bin` if it is another. No `npm ci`: this plan adds no dependency. `<mt> service logs -n 20` says `schema at version 8` and `connected as`. From now on `mt update` is there.
2. **The check, alone.** `<mt> service check` prints `database: ~/.manus-team/team.db at version 8; this build: up to 8` (the path in full; "at version 8" only once the first start has migrated it, at step 0 or item 1, and "up to" the branch's highest if it has a later migration), `checking as team.manus.gateway starts it: with PATH ...`, and `ok: this build would start as team.manus.gateway`, exit 0 (`echo $?`).
3. **Nothing new.** `<mt> update --check` prints `fetching origin` and `... up to date at <sha>`, exit 0. `ls ~/.manus-team/run` shows no `update.pid`, and `ls <checkout>/.git/mt-update.lock` says no such file.
4. **A real update.** Push a harmless commit to `origin/main` (a line in a doc). `<mt> update --check` shows it, and `the service is running (pid N) and is restarted`; `git -C <checkout> log -1 --oneline` is unchanged. Then `<mt> update`, answer `y`: it says `merging origin/main, fast-forward only`, `running npm run build`, the check's lines, `backed up the database to ~/.manus-team/backups/team-v8-<sha>-<time>.db`, `restarting team.manus.gateway`, and `updated main from <old> to <new>; the gateway is connected, at schema version 8`, exit 0. `ls -l ~/.manus-team/backups` shows the file `-rw-------` in a `drwx------` directory; `sqlite3 -readonly <backup> "pragma journal_mode; pragma user_version"` prints `delete` and `8`. The gateway answers in Lark.
5. **A "no".** Push another harmless commit. `<mt> update`, answer `n`: `nothing changed`, exit 1, and `git -C <checkout> log -1` is unchanged. `<mt> update --yes </dev/null` with the question skipped updates it, exit 0.
6. **A failing build goes back.** On a scratch branch with an upstream: `git -C <checkout> switch -c smoke-update && git -C <checkout> push -u origin smoke-update`. In a scratch clone, `git clone "$(git -C <checkout> remote get-url origin)" /tmp/smoke-clone && cd /tmp/smoke-clone && git switch smoke-update`, add `src/smoke.ts` holding `const x: number = 'a';`, commit and push. Back in any shell, `<mt> update --yes`: it fails at `npm run build`, goes back, and prints `npm run build failed (exit 2)` with tsc's lines and `the checkout is back at <old>, and the gateway as it was`, exit 1. `git -C <checkout> status` is clean, on `smoke-update` at the old commit, with no `src/smoke.ts`; `<mt> service status` shows the same pid as before; `ls ~/.manus-team/backups` has no new file. Then `git -C <checkout> switch main`: the service runs `<checkout>` whichever branch is checked out.
7. **Refusals.** `touch <checkout>/smoke.txt && <mt> update --check`: refused as not clean, naming `?? smoke.txt`, exit 1; `rm <checkout>/smoke.txt`. A local commit, `git -C <checkout> commit --allow-empty -m smoke`, then, in the scratch clone, `cd /tmp/smoke-clone && git switch main && git pull`, commit and push a harmless change to `origin/main`, and `<mt> update --check`: refused as `main has commits origin/main does not`; `git -C <checkout> reset --keep HEAD~1` drops it. `git -C <checkout> switch smoke-update && git -C <checkout> branch --unset-upstream && <mt> update --check`: refused naming `git branch --set-upstream-to=origin/smoke-update`; then `git -C <checkout> switch main`.
8. **Ctrl-C.** Push a harmless commit, run `<mt> update`, and press Ctrl-C at the question: `interrupted by SIGINT: nothing changed`, exit 1. Run `<mt> update --yes` and press Ctrl-C while it says `running npm run build`: the build finishes, then `SIGINT: going back once the running command ends`, and it goes back, exit 1, the pid unchanged.
9. **A closed ssh session.** Over ssh, with a console login, push a harmless commit, run `<mt> update --yes` and close the terminal window while it says `running npm run build`. The hangup is a signal: the build finishes, the update goes back, and nothing is left half way. Log in again: `git -C <checkout> log -1` is the old commit, `<mt> service status` the same pid, and `ls ~/.manus-team/run` shows no `update.pid`. To update over a link that may drop, run it in `tmux` or under `nohup`. Over ssh with no console login, `<mt> update --check` is refused with `the service's state cannot be read`, naming the console login.
10. **A database too new.** With `git -C <checkout> log` at a commit of this plan, make a copy of the database, `cp ~/.manus-team/team.db /tmp/smoke.db && sqlite3 /tmp/smoke.db "pragma user_version = 99"`, and run the gateway on the copy by hand with the service stopped: `<mt> service stop`, then `cd <checkout> && MT_DB=/tmp/smoke.db '<node>' dist/main.js`, `<node>` the path on the `node:` line of `<mt> service status`, never a bare `node`. It prints `configuration error: the database at /tmp/smoke.db is at schema version 99, and this build knows only up to 8: ... from ~/.manus-team/backups` and exits 78 (`echo $?`). Then `<mt> service start`, and `rm /tmp/smoke.db`.
11. **Ctrl-C during the restart.** Push a harmless commit, run `<mt> update --yes`, and press Ctrl-C while it says `restarting team.manus.gateway`: it says `SIGINT: the restart call is let finish`, then `interrupted by SIGINT while waiting for the new gateway to connect`, and either `it connected; check ... service status` or, when the log did not say so yet, the steps back, exit 3. `<mt> service status` shows it running (`running: yes`, a new pid), and `<mt> service logs -n 20` says `connected as`: the drain was not cut half way. Its locks are kept, and its last line is `then remove its locks: rm '<checkout>/.git/mt-update.lock' '~/.manus-team/run/update.pid'` (the paths in full). `<mt> update --check` now refuses with the dead lock's advice at step `confirm`, never `up to date`, saying first `if mt service status and mt service logs show it connected, only the rm is needed`; run that rm, and `<mt> update --check` says `up to date`.

**Linux (systemd), if there is one.** Items 2 to 8 again, where `team.manus.gateway` is `manus-team.service`: the restart is `systemctl --user restart`, item 4's `<mt> service status` shows a new `MainPID`, and item 8's Ctrl-C during `restarting manus-team.service` lets the call finish and prints the steps back, exit 3 (then `<mt> service status` and `<mt> service logs` say whether it came back). In a shell with no user bus (`env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS <mt> update --check`), it is refused with `the service's state cannot be read`, naming `loginctl enable-linger`. A database too new (item 10) stops the service as `failed` with exit 78, which `RestartPreventExitStatus=78` keeps from restarting: `systemctl --user status manus-team.service` says so.

**Clean up.** `git push origin --delete smoke-update`, `git -C <checkout> branch -D smoke-update`; the smoke commits on `main` stay, harmless; `ls ~/.manus-team/backups` keeps at most five of version 8.

## Review follow-ups

The final review of the branch at 73401c4 found these. Each behaviour fix was written test first, and its test seen to fail.

1. **Renames and quoted names.** The adds, the changed migrations and the schema tree are read with `-z` and split on NUL, the diffs with `--no-renames`, so a file renamed onto an ignored path is refused, a renamed migration is reported as new, and a name past ASCII is read as it is. Tests: a rename onto an ignored `config.yaml`, an ignored `notes/café.md`, a migration renamed into `schema/`, and one named past ASCII (`tests/mt-update-check.test.ts`, `tests/mt-update-show.test.ts`; the fake git now detects renames unless told not to, and quotes as `core.quotePath` does unless `-z`).
2. **Ctrl-D at the question.** `askAt(input, output)` answers `''` on the interface's `close`, which is no: exit 1, the locks released. Tests: a typed answer, a closed input, an abort (`tests/update-run.test.ts`).
3. **A dead update's home lock from another checkout** is refused with no steps: "an update from <checkout> died at its step X; run mt update from <checkout> for what to do", exit 1, the lock kept (`tests/mt-update-locks.test.ts`). Spec §20.10.
4. **runSyncDetached** spawns its wrapper with `detached: true` too (cast, as Node's types leave it out of `spawnSync`'s options), keeping the wrapper's handlers. Test: the wrapper's process group is its own (`tests/update-run.test.ts`). Smoke item 11: Ctrl-C during `restarting team.manus.gateway`, then `mt service status` shows it running. Spec §20.11.
5. **ENOTDIR.** A path added under an ignored file is refused, naming the nearest existing parent: "the incoming commits add data (where they add data/seed/rows.json), ...". Spec §20.2.
6. **stuck()** says "the gateway still runs from memory" only when the update would restart it; else "the gateway's next start would run whatever dist/ and node_modules now hold". Tests for a stopped service and none (`tests/mt-update-apply.test.ts`). Spec §20.7.
7. **runDetached** starts a 2 second grace at `exit`, then destroys the pipes and answers the real exit code. Test: a command that exits 4 while a grandchild holds its stdout answers 4, not a time-out, in 2 to 6 seconds.
8. **The locks** sync their directory after each `link` and `rename`. Test: `tests/update-lock-sync.test.ts`, over a pass-through mock of `node:fs`. Spec §20.10.
9. **mt service status and stop on an unreadable state.** status prints `running: unknown`; stop on macOS refuses it, naming the console login, through `unreadableHint`, which `mt update`'s refusal now shares. The two tests that pinned `running: no` updated, and one added for stop (`tests/mt-service.test.ts`). Spec §20.2.
10. **The backup** throws BackupError when `journal_mode = DELETE` does not answer `delete` (a `journalMode` hook for the test, as `quickCheck` is), and refuses a source that is not read-only before it writes anything. New test: a backup while another connection writes pairs of rows, the copy passing `quick_check` with as many of each, between the counts before and after (`tests/update-backup.test.ts`). Spec §20.8.
11. **versionLine** with a schema directory that cannot be read keeps the database's path and version and says "this build's highest is unknown (migrations from <dir>, MT_SCHEMA_DIR: ENOENT ...)" (`tests/mt-service-check.test.ts`). Spec §20.5.
12. **The native-load advice** names the npm beside the node, else the one on the unit's recorded `PATH` when a unit exists (`tests/mt-service-check.test.ts`). Spec §20.5.
13. **The dead lock's steps back** include the restore lines only when it died at `restart` or `confirm`, under the restart's warning, also on the steps back beside the steps forward; at `confirm`, "if mt service status and mt service logs show it connected, only the rm is needed" first. Test: a dead lock at `backup` with a backup named gives no restore lines; the tests at `restart` and `confirm` pin the title and the line (`tests/mt-update-locks.test.ts`). Spec §20.10.
14. **Tests.** A signal during the backup: let finish, then going back, exit 1, the restart never called (`tests/mt-update-signals.test.ts`, through a `whileBackingUp` hook at the backup's `now()`). The real `guardOutput` in a child whose stdout's reader has gone: it lives on, where without it the child dies of the EPIPE (`tests/update-run.test.ts`). The e2e's writer: its first line raced against its exit, and its exit awaited only when it has not happened (`tests/mt-update.e2e.ts`).
15. **Smoke item 9** says "with a console login" for its first half.
16. **README "Deploying"**: `npm ci` also when `node_modules/.package-lock.json` is missing; a failed backup goes back too; with `kanban.enabled` off and no service, a hand-run gateway holds no lock, so stop it first; `git branch --set-upstream-to=origin/main` on one line.
17. **Wording.** Two locks "are never cleared by themselves". "(spec §20.8)" dropped from `createGateway`'s configuration error and from `SchemaTooNewError`'s message, with `tests/schema-too-new.test.ts` and smoke item 10 updated. Spec §20.6.

The final review of the branch at e48960f found these too. Each behaviour fix was written test first, and its test seen to fail.

18. **Every exit 3 keeps both locks.** A restart not confirmed, a failed restart call, the pid or the version moved, and going back failed released them, so a run again said "up to date", exit 0, the merge having landed. Now each exit 3 keeps them, as `unexpected()` did, and ends with "its locks are kept, saying where it stopped: <locks>; run <mt> update again for what to do" and "then remove its locks: rm <locks>", as a dead lock's advice ends. Test: after each kind of exit 3 (not confirmed, a configuration error at the start, a failed restart call, a signal during the wait, the pid moved, the version moved, going back failed), both locks are there, the last line is their rm, and a run again is exit 1 with the dead lock's advice and never "up to date" (`tests/mt-update-locks.test.ts`). README "Deploying" says so. Spec §20.10, §20.12.
19. **The smoke checklist on this host.** A step 0 before item 1: stop any `npm run dev` gateway; back up the version 7 database with `sqlite3 ... ".backup /tmp/team-v7.db"`; build with Node 22 and run `service install` with Node 22's node, as install records the node that runs it; and `<mt>`, `~/.nvm/versions/node/v22.15.0/bin/node <checkout>/dist/mt.js`, in every item until `PATH` has `mt`. Item 1 says step 0's install was the first start; item 2 that "at version 8" holds only after it, which migrated 7 to 8 (and to any later version on this branch), covered by step 0's backup. Item 11 says the locks are now kept, and the rm it prints.
20. **`mt service check` on a database newer than the build** fails right after the version line, exit 1, with `migrate`'s own refusal, with a unit and without, nothing imported. Tests in `tests/mt-service-check.test.ts`. And step 3 refuses an incoming tree whose highest migration is below the database's version when `MT_SCHEMA_DIR` is unset, "the incoming commits remove migrations: ...", exit 1, nothing merged; with `MT_SCHEMA_DIR` set it is not refused, and a new migration then says "the database is at version N already, at or above the new tree's M", no longer "moves the database from version 8 to 2". Tests in `tests/mt-update-show.test.ts`; the e2e's origin now holds the real migrations, as its database is at their version. Spec §20.3, §20.5.
21. **A signal during the restart wait** reads the log once more before reporting: when it shows `connected as` after the schema line, "it connected; check <mt> service status", with no steps back and so no restore, exit 3. Tests: Ctrl-C during macOS's drain with the gateway connected by then, and during the wait with the lines arriving (`tests/mt-update-signals.test.ts`); the drain test without them keeps the steps back. Spec §20.9.
22. **runSyncDetached** gives `spawnSync` a `timeout` of 180 seconds (`RESTART_CALL_MS`) and `killSignal: 'SIGKILL'`, as the wrapper ignores SIGTERM; a timeout answers 124, "did not finish in 180 seconds", a failed restart call, exit 3. Tests: a real `sleep` past a 0.3 second limit answers 124 at once with what it said (`tests/update-run.test.ts`), and a timed-out call is exit 3 with the steps back (`tests/mt-update-restart.test.ts`). Spec §20.11.
23. **The dead lock's refusals** for another home and from another checkout, and the kept locks' line, name `mt` as `mtCommand(node, checkout)` with the checkout the lock holds, not a bare `mt` (`tests/mt-update-locks.test.ts`). Spec §20.10.
24. **Masking.** The values of this shell's environment whose names pass `isSecretName` (`LARK_APP_SECRET`, `MT_AGENT_ENV_*`) are registered as secrets when the update starts, so an exported `LARK_APP_SECRET` is masked in its output. Test: a failed check printing a shell's `LARK_APP_SECRET` and `MT_AGENT_ENV_GH_TOKEN` shows both masked, `LARK_APP_ID` as written (`tests/mt-update-apply.test.ts`). Spec §20.12.

Final counts, under Node 22 in the worktree: `npx vitest run --project unit` gives `Tests  1999 passed (1999)` in 124 files; `npx vitest run --project e2e` gives `Tests  164 passed (164)`, run twice; `npx tsc --noEmit` and `npm run build` report no errors; `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing, and `git diff 31313b2 -- src README.md | grep "^+" | grep -c "—"` prints `0`.
