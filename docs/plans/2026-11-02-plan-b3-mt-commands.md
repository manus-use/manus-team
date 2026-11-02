# Plan B3 — The `mt` command: `mt role` and `mt workspace`: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `mt` executable whose `role create | list | check` and `workspace add | list` commands create and check roles and workspaces the way spec §2.6 describes. They write only files, and never disturb a running gateway.

**Architecture:**
- **Settings without Lark.** `src/config.ts` gains `loadTeamSettings`, the part of `loadConfig` that locates the home, the config file and the database and reads the workspaces and the legacy agent. It does not demand Lark credentials or an owner, so an operator's shell needs neither.
- **Shared startup code.** `loadTeam` takes those settings, so the commands run the same code as startup.
- **The command code.** It lives in `src/cli/`. It is driven by `runMt(argv, io)`, whose `io` carries the environment, two output sinks and an injectable `git`, and that is what the tests call. `src/mt.ts` is the thin executable.
- **Read-only database access.** The database is only ever opened read-only, through a new `openDbReadOnly`.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:util` `parseArgs`, `yaml` (`parseDocument`, which preserves comments), better-sqlite3 (read-only), vitest.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §2.6 (the commands), §2.1 and §2.5 (what a role directory holds, `.env` rules), §2.3 (workspace rules).

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, branch `mt-commands`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`. The live gateway runs there under `tsx watch`.
  - Never start the gateway, and never write to `~/.manus-team`.
  - Tests use temporary homes only.
- **Commits.**
  - `node_modules` is symlinked in and untracked. Commit named files only; never `git add -A`.
  - Commit messages are plain English, with no mention of Claude or AI, no `Co-Authored-By` trailer and no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything written.
- **Secrets.** Never print secret values. No command output may contain a `.env` value or an `MT_AGENT_ENV_*` value.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` gives `Tests  493 passed (493)`; `npm run typecheck` prints nothing.
- **Edits.** Find each edit by its quoted text, not by line number.

## Behaviour common to every command

- **Exit codes:**
  - `0`: done.
  - `1`: refused, or a check failed. A `ConfigError` lands here as `mt: <message>` on stderr.
  - `2`: the command line was wrong. stderr gets the problem, then the usage.
- **Locating state.** The commands find the home, the config file and the database exactly as the gateway does:
  - the home is `MT_HOME`;
  - the config file is `MT_CONFIG`, else `$MT_HOME/config.yaml`;
  - the database is `MT_DB`, else `db:`, else `$MT_HOME/gateway.db`.

  They read these from the shell they run in.

## Out of scope

- **`mt kanban` and putting `mt` on an agent's `PATH`.** Both are plan C.
- **Installing `mt` globally.** In a checkout it runs as `npm run -s mt -- …`; `package.json` declares `bin` for an installed build.

## File structure

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | `TeamSettings`, `loadTeamSettings`; `loadConfig` built on the same pieces |
| `src/team.ts`, `src/roles.ts` (modify) | `loadTeam(settings, env, opts)`; `LoadOptions.unsetPassEnv` |
| `src/db/open.ts` (modify) | `openDbReadOnly` |
| `src/db/workspaces.ts` (modify) | `registeredWorkspaces`, `registrationsAt`, `movedMessage` |
| `src/cli/mt.ts` (create) | `runMt`, `MtIo`, usage, exit codes, `table`, `refuse` |
| `src/cli/role.ts` (create) | `roleList`, `roleCreate`, `roleCheck` |
| `src/cli/workspace.ts` (create) | `workspaceAdd`, `workspaceList` |
| `src/mt.ts` (create) | the executable |
| `package.json` (modify) | `bin` and an `mt` script |
| `tests/helpers/mt.ts` (create) | a temporary home with a config file, and a runner |
| `tests/mt.test.ts`, `tests/mt-role.test.ts`, `tests/mt-workspace.test.ts` (create) | |
| `tests/config.test.ts`, `tests/team.test.ts`, `tests/workspace-registry.test.ts` (modify) | |
| `README.md` (modify) | the `mt` section |

---

### Task 1: Settings without Lark: `loadTeamSettings`

**Files:**
- Modify: `src/config.ts` (`loadConfig`, plus new exports), `src/team.ts` (`loadTeam`'s parameter type)
- Test: `tests/config.test.ts`

`loadConfig` fails without `LARK_APP_SECRET`, `LARK_APP_ID` and an owner, and an operator creating a role should need none of them. So the part that locates files and reads the workspaces and the legacy agent becomes its own function, and `loadConfig` is rebuilt on it. `loadConfig` keeps its error order: the owner is still checked before the workspaces, because it reads the file first and the team settings second.

- [ ] **Step 1.1: Write the failing tests.** Add to `tests/config.test.ts`, and add `loadTeamSettings` to its `../src/config.js` import:

```ts
describe('loadTeamSettings', () => {
  it('reads where things are, the workspaces and the agent, without Lark settings or an owner', () => {
    const s = loadTeamSettings(
      { MT_HOME: '/srv/mt', MT_WORKSPACE: '/srv/repo', MT_AGENT_COMMAND: 'claude-agent-acp' },
      () => undefined,
    );
    expect(s).toMatchObject({
      home: '/srv/mt',
      configPath: undefined,
      dbPath: '/srv/mt/gateway.db',
      workspaces: { default: '/srv/repo' },
    });
    expect(s.agent?.command).toBe('claude-agent-acp');
  });

  it('agrees with loadConfig on everything they share', () => {
    const env = {
      MT_HOME: '/srv/mt',
      MT_WORKSPACE: '/srv/repo',
      MT_AGENT_COMMAND: 'claude-agent-acp',
      MT_OWNER_OPEN_ID: 'ou_owner',
      LARK_APP_ID: 'cli_app',
      LARK_APP_SECRET: 'app-secret',
    };
    const c = loadConfig(env, () => undefined);
    const s = loadTeamSettings(env, () => undefined);
    expect(s).toEqual({ home: c.home, configPath: c.configPath, dbPath: c.dbPath, workspaces: c.workspaces, agent: c.agent });
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail.** `npx vitest run --project unit tests/config.test.ts`. Expected: FAIL. `loadTeamSettings` is not exported, so the tests fail with `loadTeamSettings is not a function`.

- [ ] **Step 1.3: Implement.** In `src/config.ts`:

1. After the `GatewayConfig` interface, add:

```ts
/**
 * What `loadTeam` and the `mt` commands need: where the gateway's files are, the
 * workspaces, and the legacy agent block. No Lark settings and no owner, so an
 * operator can create a role from a shell that holds no gateway credentials.
 */
export interface TeamSettings {
  home: string;
  /** The file read, or undefined for an environment-only deployment. */
  configPath: string | undefined;
  dbPath: string;
  /** Workspace name → declared absolute path. Always has `default`. */
  workspaces: Readonly<Record<string, string>>;
  agent: AgentConfig | undefined;
}
```

2. Split the opening of `loadConfig` into a helper. Move these lines out of `loadConfig`: from `const home = envString(env, 'MT_HOME') ?? …` down to `const file = text === undefined ? emptyFile() : parseFile(path, text);`, including the `MT_CONFIG points at … which does not exist` check. Put them into:

```ts
interface Located {
  home: string;
  path: string;
  text: string | undefined;
  file: FileConfig;
}

function locate(env: Env, readFile: FileReader): Located {
  // (the moved lines, unchanged)
  return { home, path, text, file };
}
```

3. Move the workspace block and the agent block out of `loadConfig`, keeping their comments and messages unchanged. The workspace block runs from `const single = envString(env, 'MT_WORKSPACE') ?? file.workspace;` through the absolute-path check. The agent block runs from the `agentVariables` computation through `const agent = …`. Put them into:

```ts
function teamSettingsFrom(env: Env, { home, path, text, file }: Located): TeamSettings {
  // (the moved workspace lines, unchanged)
  // (the moved agent lines, unchanged)
  return {
    home,
    configPath: text === undefined ? undefined : path,
    dbPath: envString(env, 'MT_DB') ?? file.db ?? join(home, 'gateway.db'),
    workspaces,
    agent,
  };
}

/** The team half of the configuration, for `loadTeam` and the `mt` commands. */
export function loadTeamSettings(env: Env = process.env, readFile: FileReader = readIfPresent): TeamSettings {
  return teamSettingsFrom(env, locate(env, readFile));
}
```

4. In `loadConfig`:
   - begin with `const located = locate(env, readFile);` and `const { file } = located;`;
   - keep the owner lines where they are;
   - after them, add `const team = teamSettingsFrom(env, located);`;
   - in the returned object, use `team.dbPath`, `team.configPath`, `team.home`, `team.agent` and `team.workspaces`, and `join(located.home, 'downloads')` for the downloads default.

   Nothing else in the returned object changes.

In `src/team.ts`, change `import { type AgentConfig, ConfigError, type Env, type GatewayConfig } from './config.js';` to import `type TeamSettings` instead of `type GatewayConfig`. Change `export function loadTeam(config: GatewayConfig, env: Env): Team {` to `export function loadTeam(config: TeamSettings, env: Env): Team {`. `GatewayConfig` has every field of `TeamSettings`, so every caller still compiles.

- [ ] **Step 1.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  495 passed (495)`; `npm run typecheck` → no output. If any existing config test now fails, the error order changed: compare against Step 1.3 item 4 and restore the order.

- [ ] **Step 1.5: Commit.**

```bash
git add src/config.ts src/team.ts tests/config.test.ts
git commit -m "Read the team half of the configuration without needing Lark settings"
```

---

### Task 2: Read registered workspaces without disturbing the gateway

**Files:**
- Modify: `src/db/open.ts`, `src/db/workspaces.ts`
- Test: `tests/workspace-registry.test.ts`

The commands read the `workspaces` table opened read-only. A read-only connection never migrates, never writes and never checkpoints. A database that does not exist yet is "no registrations", and it is not created. `movedMessage` becomes shared, so `mt workspace add` refuses in the same words as startup.

- [ ] **Step 2.1: Write the failing tests.** Add to `tests/workspace-registry.test.ts`:
  - imports: `import { existsSync, mkdtempSync, rmSync } from 'node:fs';`, `import { tmpdir } from 'node:os';`, `import { join } from 'node:path';` and `import Database from 'better-sqlite3';`;
  - extend the workspaces import to `import { registerWorkspaces, registrationsAt } from '../src/db/workspaces.js';`.

```ts
describe('registrationsAt', () => {
  it('is empty for a database that does not exist, and does not create one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-reg-'));
    try {
      const path = join(dir, 'gateway.db');
      expect(registrationsAt(path)).toEqual(new Map());
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads what the gateway registered', () => {
    const t = db();
    registerWorkspaces(t.db, new Map([['default', '/srv/a']]), NOW);
    expect(registrationsAt(join(t.dir, 'gateway.db'))).toEqual(new Map([['default', '/srv/a']]));
  });

  it('is empty for a database the migrations have not reached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-reg-'));
    try {
      const path = join(dir, 'gateway.db');
      const raw = new Database(path);
      raw.exec('CREATE TABLE other (a TEXT)');
      raw.close();
      expect(registrationsAt(path)).toEqual(new Map());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/workspace-registry.test.ts`. Expected: FAIL, because `registrationsAt` is not exported.

- [ ] **Step 2.3: Implement.** In `src/db/open.ts`, add the export below after `openDb`. It uses the same `better-sqlite3` default import that `openDb` uses. If `existsSync` is not yet imported from `node:fs` there, add it.

```ts
/**
 * Read-only, for the `mt` commands (spec §2.6). It never migrates, writes or
 * checkpoints, so a running gateway is not disturbed. A database that does not
 * exist yet -- a fresh install -- is undefined, and is not created.
 */
export function openDbReadOnly(path: string): Db | undefined {
  if (!existsSync(path)) return undefined;
  return new Database(path, { readonly: true, fileMustExist: true });
}
```

In `src/db/workspaces.ts`:
- import `openDbReadOnly` from `./open.js`;
- move the error text out of `registerWorkspaces` into the exported `movedMessage` below, and have `registerWorkspaces` return `{ error: movedMessage(name, row.root_path, path) }`;
- add the two readers.

```ts
/** The refusal for a name whose directory moved. Shared with `mt workspace add`. */
export function movedMessage(name: string, recorded: string, path: string): string {
  return (
    `workspace ${name} is ${recorded} (recorded when the name was first used), but the config ` +
    `now resolves to ${path}. A workspace's directory never moves: the sessions opened in it would be ` +
    'orphaned. Give the new directory a new name.'
  );
}

/** Each registered name → its recorded directory. Empty before the migrations create the table. */
export function registeredWorkspaces(db: Db): Map<string, string> {
  try {
    const rows = db.prepare<[], { id: string; root_path: string }>('SELECT id, root_path FROM workspaces').all();
    return new Map(rows.map((r) => [r.id, r.root_path]));
  } catch (err) {
    if (err instanceof Error && /no such table/.test(err.message)) return new Map();
    throw err;
  }
}

/** The registrations in the database at `dbPath`, read without disturbing a running gateway. */
export function registrationsAt(dbPath: string): Map<string, string> {
  const db = openDbReadOnly(dbPath);
  if (db === undefined) return new Map();
  try {
    return registeredWorkspaces(db);
  } finally {
    db.close();
  }
}
```

- [ ] **Step 2.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  498 passed (498)`; `npm run typecheck` → no output.

- [ ] **Step 2.5: Commit.**

```bash
git add src/db/open.ts src/db/workspaces.ts tests/workspace-registry.test.ts
git commit -m "Read registered workspaces from a database opened read-only"
```

---

### Task 3: A role can be loaded with unset `passEnv` names recorded, not fatal

**Files:**
- Modify: `src/roles.ts` (`loadRoleDir`, plus a new `LoadOptions`), `src/team.ts` (`loadTeam`)
- Test: `tests/team.test.ts`

`mt role check` reports this shell's environment separately from the files (spec §2.6). A `passEnv` name that is not set is the environment's problem, so the check needs to load the team without failing on it. The gateway itself never passes the option.

- [ ] **Step 3.1: Write the failing test.** Add it inside `describe('loadTeam', …)` in `tests/team.test.ts`:

```ts
  it('can record unset passEnv names instead of failing, for mt role check', () => {
    roleDir('reviewer', `${ROLE_AGENT}  passEnv: [REVIEW_TOKEN]\n`);
    const e = env();
    expect(() => teamFor(e)).toThrow(/REVIEW_TOKEN, which is not set/);
    const unset: string[] = [];
    const team = loadTeam(loadConfig(e, () => undefined), e, { unsetPassEnv: unset });
    expect(unset).toEqual(['reviewer: REVIEW_TOKEN']);
    expect(team.roles.has('reviewer')).toBe(true);
  });
```

- [ ] **Step 3.2: Run it to verify it fails.** `npx vitest run --project unit tests/team.test.ts`. Expected: FAIL. `loadTeam` ignores the third argument, so it throws `REVIEW_TOKEN, which is not set`.

- [ ] **Step 3.3: Implement.** In `src/roles.ts`, export:

```ts
/** How strictly a role is loaded. */
export interface LoadOptions {
  /**
   * When given, a `passEnv` name that is not set is recorded here as `role: NAME`
   * instead of failing. `mt role check` reports this shell's environment apart
   * from the files (spec §2.6). The gateway itself never passes it.
   */
  unsetPassEnv?: string[];
}

function withUnsetRecorded(role: string, env: Env, passEnv: readonly string[], unset: string[]): Env {
  const filled: Record<string, string | undefined> = { ...env };
  for (const key of passEnv) {
    const value = env[key];
    if (value === undefined || value === '') {
      unset.push(`${role}: ${key}`);
      filled[key] = '(unset)';
    }
  }
  return filled;
}
```

Then:
- Give `loadRoleDir` a fifth parameter, `opts: LoadOptions = {}`.
- Replace `const fromGateway = passEnvValues(env, passEnv, \`${configPath}: agent.passEnv\`);` with:

```ts
  // The MT_/LARK_ refusal still applies to every name: passEnvValues checks it first.
  const lookup = opts.unsetPassEnv === undefined ? env : withUnsetRecorded(name, env, passEnv, opts.unsetPassEnv);
  const fromGateway = passEnvValues(lookup, passEnv, `${configPath}: agent.passEnv`);
```

In `src/team.ts`:
- import `type LoadOptions` from `./roles.js`;
- change the signature to `export function loadTeam(config: TeamSettings, env: Env, opts: LoadOptions = {}): Team {`;
- pass `opts` as the fifth argument of `loadRoleDir(…)`.

- [ ] **Step 3.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  499 passed (499)`; `npm run typecheck` → no output.

- [ ] **Step 3.5: Commit.**

```bash
git add src/roles.ts src/team.ts tests/team.test.ts
git commit -m "Let a team be loaded with unset passEnv names recorded rather than fatal"
```

---

### Task 4: The `mt` executable and its dispatcher

**Files:**
- Create: `src/cli/mt.ts`, `src/mt.ts`, `tests/helpers/mt.ts`, `tests/mt.test.ts`
- Modify: `package.json`

- [ ] **Step 4.1: Write the test helper.** Create `tests/helpers/mt.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMt, type Git } from '../../src/cli/mt.js';

/**
 * A temporary gateway home with a config file and a workspace, and a runner that
 * captures what `mt` prints. Every test gets its own; nothing touches ~/.manus-team.
 */
export interface MtFixture {
  root: string;
  home: string;
  workspace: string;
  configPath: string;
  env: Record<string, string | undefined>;
  run(
    argv: string[],
    opts?: { env?: Record<string, string | undefined>; git?: Git },
  ): Promise<{ code: number; out: string; err: string }>;
  cleanup(): void;
}

export function mtFixture(config?: (workspace: string) => string): MtFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-cli-')));
  const home = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
  const configPath = join(home, 'config.yaml');
  writeFileSync(
    configPath,
    config?.(workspace) ??
      [
        '# test config',
        `workspace: ${workspace}`,
        'agent:',
        '  driver: structured-cli',
        '  command: bytesec',
        '  args: [run, -m, test-model]',
        '  unsupervised: true',
        '',
      ].join('\n'),
  );
  const env = { MT_HOME: home, PATH: process.env['PATH'], HOME: process.env['HOME'] };
  return {
    root,
    home,
    workspace,
    configPath,
    env,
    async run(argv, opts = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runMt(argv, {
        env: { ...env, ...opts.env },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        ...(opts.git === undefined ? {} : { git: opts.git }),
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 4.2: Write the failing tests.** Create `tests/mt.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mtFixture, type MtFixture } from './helpers/mt.js';

let fx: MtFixture;
afterEach(() => fx.cleanup());

describe('mt', () => {
  it('prints the usage: exit 2 when there is no command, 0 when asked for help', async () => {
    fx = mtFixture();
    const none = await fx.run([]);
    expect(none.code).toBe(2);
    expect(none.out).toMatch(/mt role create <name>/);
    expect((await fx.run(['help'])).code).toBe(0);
  });

  it('refuses an unknown command with the usage, exit 2', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'fly']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command: role fly/);
    expect(r.err).toMatch(/usage:/);
  });
});
```

- [ ] **Step 4.3: Run them to verify they fail.** `npx vitest run --project unit tests/mt.test.ts`. Expected: FAIL, because `../../src/cli/mt.js` cannot be resolved.

- [ ] **Step 4.4: Implement.** Create `src/cli/mt.ts`:

```ts
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ConfigError, type Env } from '../config.js';

/**
 * `mt`: commands that create and check roles and workspaces (spec §2.6).
 *
 * They only write files. They do not talk to the gateway and take no authority
 * from it, so they give an agent -- which runs as the same user and could edit the
 * same files by hand -- nothing it did not already have. A change takes effect at
 * the gateway's next start.
 */

export type Git = (args: readonly string[]) => Promise<{ code: number; stderr: string }>;

export interface MtIo {
  /** The shell's environment. The service's may differ, and output says so where it matters. */
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Runs git; injectable so a failed clone can be tested. */
  git?: Git;
}

export const USAGE = [
  'usage:',
  '  mt role create <name> [--clone-from <role>] [--description "..."]',
  '  mt role list',
  '  mt role check [<name>]',
  '  mt workspace add <name> <absolute-path>',
  '  mt workspace add <name> --clone <git-url>',
  '  mt workspace list',
].join('\n');

export class UsageError extends Error {}

/** Strict: an unknown option is a usage error, not something to guess at. */
export function parse<T extends NonNullable<ParseArgsConfig['options']>>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** Prints a refusal and returns its exit code. */
export function refuse(io: MtIo, message: string): number {
  io.err(`mt: ${message}`);
  return 1;
}

/** Rows as aligned columns, for the list commands. */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
}

/** Exit codes: 0 done, 1 refused or a check failed, 2 the command line was wrong. */
export async function runMt(argv: readonly string[], io: MtIo): Promise<number> {
  const [group, command] = argv;
  try {
    if (group === undefined) {
      io.out(USAGE);
      return 2;
    }
    if (group === 'help' || group === '--help' || group === '-h') {
      io.out(USAGE);
      return 0;
    }
    // (later tasks add each command here)
    throw new UsageError(`unknown command: ${[group, command].filter((s) => s !== undefined).join(' ')}`);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`mt: ${err.message}`);
      io.err(USAGE);
      return 2;
    }
    if (err instanceof ConfigError) return refuse(io, err.message);
    throw err;
  }
}
```

Create `src/mt.ts`:

```ts
#!/usr/bin/env node
import { runMt } from './cli/mt.js';

/** The `mt` executable. Everything it does is in `./cli`; this only wires the process to it. */
process.exitCode = await runMt(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
```

In `package.json`, add `"bin": { "mt": "dist/mt.js" },` after `"engines"`, and add the script `"mt": "tsx src/mt.ts",` after `"dev"`.

The dispatcher reads `rest = argv.slice(2)` in Task 5. Add `const rest = argv.slice(2);` then. Adding it now would trip `noUnusedLocals`.

- [ ] **Step 4.5: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  501 passed (501)`; `npm run typecheck` → no output. Smoke test: `npm run -s mt -- help` prints the usage.

- [ ] **Step 4.6: Commit.**

```bash
git add src/cli/mt.ts src/mt.ts package.json tests/helpers/mt.ts tests/mt.test.ts
git commit -m "Add the mt executable and its command dispatcher"
```

---

### Task 5: `mt role list`

**Files:**
- Create: `src/cli/role.ts`, `tests/mt-role.test.ts`
- Modify: `src/cli/mt.ts`

`mt role list` lists the role `default`, whether it comes from the `agent:` block or from `roles/default/`, and every role directory, with its driver and description. It reads `config.yaml` loosely: a broken role still gets a line, and `mt role check` says what is wrong with it.

- [ ] **Step 5.1: Write the failing tests.** Create `tests/mt-role.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mtFixture, type MtFixture } from './helpers/mt.js';

let fx: MtFixture;
afterEach(() => fx.cleanup());

function roleDir(name: string, config: string): string {
  const dir = join(fx.home, 'roles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), config);
  return dir;
}

const ACP_AGENT = 'agent:\n  driver: acp\n  command: claude-agent-acp\n';

describe('mt role list', () => {
  it('lists the role default from the agent: block, and each role directory', async () => {
    fx = mtFixture();
    roleDir('reviewer', `description: Reviews code\n${ACP_AGENT}`);
    const r = await fx.run(['role', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^default\s+structured-cli\s+agent: block$/m);
    expect(r.out).toMatch(/^reviewer\s+acp\s+roles\/reviewer\s+Reviews code$/m);
  });

  it('refuses an unknown option as a usage error', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'list', '--bogus']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/bogus/);
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** `npx vitest run --project unit tests/mt-role.test.ts`. Expected: FAIL with `unknown command: role list`.

- [ ] **Step 5.3: Implement.** Create `src/cli/role.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadTeamSettings } from '../config.js';
import { discoverRoles } from '../roles.js';
import { table, type MtIo } from './mt.js';

/** `mt role list`: every role, its driver, where it comes from, and its description. */
export function roleList(io: MtIo): number {
  const settings = loadTeamSettings(io.env);
  const rolesDir = join(settings.home, 'roles');
  const found = discoverRoles(rolesDir);
  const rows: string[][] = [];
  if (settings.agent !== undefined && !found.names.includes('default')) {
    rows.push(['default', settings.agent.driver, 'agent: block', '']);
  }
  for (const name of found.names) {
    const summary = summarize(join(rolesDir, name, 'config.yaml'));
    rows.push([name, summary.driver, `roles/${name}`, summary.description]);
  }
  if (rows.length === 0) io.out('no roles: create one with mt role create <name>');
  for (const line of table(rows)) io.out(line);
  for (const note of found.notes) io.out(`note: ${note}`);
  return 0;
}

/** Read loosely, so a broken role still gets a line; `mt role check` says what is wrong with it. */
function summarize(path: string): { driver: string; description: string } {
  try {
    const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    const agent = raw?.['agent'] as Record<string, unknown> | undefined;
    const driver = agent?.['driver'];
    const description = raw?.['description'];
    return {
      driver: typeof driver === 'string' ? driver : '?',
      description: typeof description === 'string' ? description : '',
    };
  } catch {
    return { driver: '?', description: '(unreadable config.yaml)' };
  }
}
```

In `src/cli/mt.ts`:
- import `roleList` from `./role.js`;
- in `runMt`, add `const rest = argv.slice(2);` after the destructuring;
- before the `unknown command` throw, add:

```ts
    if (group === 'role' && command === 'list') {
      expectNothing(parse(rest, {}).positionals, 'role list');
      return roleList(io);
    }
```

Then add this helper next to `parse`:

```ts
function expectNothing(positionals: readonly string[], what: string): void {
  if (positionals.length > 0) throw new UsageError(`${what} takes no arguments`);
}
```

- [ ] **Step 5.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  503 passed (503)`; `npm run typecheck` → no output.

- [ ] **Step 5.5: Commit.**

```bash
git add src/cli/role.ts src/cli/mt.ts tests/mt-role.test.ts
git commit -m "Add mt role list"
```

---

### Task 6: `mt role create`

**Files:**
- Modify: `src/cli/role.ts`, `src/cli/mt.ts`, `tests/mt-role.test.ts`

Spec §2.6 and §2.5. What it writes:
- `config.yaml`, copied from `default` or from `--clone-from`;
- `role.md`, a starter one, or the source's when cloning;
- `skills/`, empty, or the source's when cloning;
- `.env`, empty and `0600`;
- a `.gitignore` holding `.env`.

What it refuses:
- a bad name or a reserved one;
- a role that already exists. The one exception is `default` while that role still comes from the `agent:` block;
- `--clone-from` together with the name `default`.

When the source is the legacy `default`:
- the agent is the `agent:` block, with any `MT_AGENT_COMMAND`/`ARGS`/`DRIVER`/`UNSUPERVISED` set in this shell applied, and it says which were applied;
- `MT_AGENT_ENV_*` values are never copied, but their names are listed;
- `mt role create default` also prints the cutover.

It writes into a dot-named staging directory, which `discoverRoles` ignores, and renames that into place, so a failure halfway leaves no half-made role.

- [ ] **Step 6.1: Write the failing tests.** Add to `tests/mt-role.test.ts`:
  - imports: `readFileSync`, `statSync`, `existsSync` and `chmodSync` from `node:fs`, `parse as parseYaml` from `yaml`, and `loadRoleDir` from `../src/roles.js`;
  - then the `describe` below.

```ts
describe('mt role create', () => {
  it('writes a role from the agent: block, with an empty owner-only .env and a .gitignore', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'create', 'reviewer']);
    expect(r.code).toBe(0);
    const dir = join(fx.home, 'roles', 'reviewer');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('');
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env\n');
    expect(statSync(join(dir, 'skills')).isDirectory()).toBe(true);
    expect(existsSync(join(dir, 'role.md'))).toBe(true);
    const config = parseYaml(readFileSync(join(dir, 'config.yaml'), 'utf8')) as { agent: Record<string, unknown> };
    expect(config.agent).toMatchObject({ driver: 'structured-cli', command: 'bytesec', args: ['run', '-m', 'test-model'] });
    // What it wrote is a role the gateway accepts.
    expect(() => loadRoleDir('reviewer', dir, fx.env, new Set(['default']))).not.toThrow();
  });

  it('names the overrides it applied and the secrets it did not copy, never their values', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'create', 'reviewer'], {
      env: { MT_AGENT_ARGS: 'run -m other-model', MT_AGENT_ENV_API_KEY: 'sk-not-for-printing' },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MT_AGENT_ARGS/);
    expect(r.out).toMatch(/MT_AGENT_ENV_API_KEY/);
    expect(r.out).toMatch(/API_KEY=/);
    const config = readFileSync(join(fx.home, 'roles', 'reviewer', 'config.yaml'), 'utf8');
    expect(config).toMatch(/other-model/);
    expect(`${r.out}${r.err}${config}`).not.toMatch(/sk-not-for-printing/);
  });

  it('refuses a bad name, a reserved name, and a role that exists', async () => {
    fx = mtFixture();
    expect((await fx.run(['role', 'create', 'Reviewer'])).code).toBe(1);
    expect((await fx.run(['role', 'create', 'acp'])).err).toMatch(/reserved/);
    expect((await fx.run(['role', 'create', 'reviewer'])).code).toBe(0);
    const again = await fx.run(['role', 'create', 'reviewer']);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
  });

  it('copies config.yaml, role.md and skills with --clone-from, but never .env', async () => {
    fx = mtFixture();
    const source = roleDir('impl', `# keep me\n${ACP_AGENT}`);
    writeFileSync(join(source, 'role.md'), 'Write the code.\n');
    mkdirSync(join(source, 'skills', 'tdd'), { recursive: true });
    writeFileSync(join(source, 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: Test first\n---\n');
    writeFileSync(join(source, '.env'), 'TOKEN=impl-only\n');
    chmodSync(join(source, '.env'), 0o600);

    const r = await fx.run(['role', 'create', 'reviewer', '--clone-from', 'impl', '--description', 'Reviews code']);
    expect(r.code).toBe(0);
    const dir = join(fx.home, 'roles', 'reviewer');
    const config = readFileSync(join(dir, 'config.yaml'), 'utf8');
    expect(config).toMatch(/# keep me/);
    expect((parseYaml(config) as { description: string }).description).toBe('Reviews code');
    expect(readFileSync(join(dir, 'role.md'), 'utf8')).toBe('Write the code.\n');
    expect(existsSync(join(dir, 'skills', 'tdd', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('');
  });

  it('moves the legacy default into roles/default, and prints the cutover', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'create', 'default']);
    expect(r.code).toBe(0);
    expect(existsSync(join(fx.home, 'roles', 'default', 'config.yaml'))).toBe(true);
    expect(r.out).toMatch(/remove the agent: block/);
    expect(r.out).toMatch(/mt role check/);
  });

  it('refuses --clone-from with default, and a source that is not a role', async () => {
    fx = mtFixture();
    roleDir('impl', ACP_AGENT);
    expect((await fx.run(['role', 'create', 'default', '--clone-from', 'impl'])).err).toMatch(/--clone-from/);
    expect((await fx.run(['role', 'create', 'x', '--clone-from', 'nope'])).err).toMatch(/no role nope/);
    expect((await fx.run(['role', 'create', 'x', '--clone-from', '../impl'])).code).toBe(1);
  });
});
```

- [ ] **Step 6.2: Run them to verify they fail.** `npx vitest run --project unit tests/mt-role.test.ts`. Expected: the six new tests FAIL with `unknown command: role create`.

- [ ] **Step 6.3: Implement.** Add to `src/cli/role.ts`. Merge the new names into the existing imports:
- `cpSync`, `existsSync`, `mkdirSync`, `mkdtempSync`, `renameSync`, `rmSync` and `writeFileSync` from `node:fs`;
- `parseDocument` and `stringify as stringifyYaml` from `yaml`;
- `type AgentConfig` from `../config.js`;
- `isReservedRoleName` and `nameProblem` from `../names.js`;
- `refuse` from `./mt.js`.

```ts
const DEFAULT_ROLE = 'default';
const AGENT_OVERRIDES = ['MT_AGENT_COMMAND', 'MT_AGENT_ARGS', 'MT_AGENT_DRIVER', 'MT_AGENT_UNSUPERVISED'] as const;
const AGENT_ENV_PREFIX = 'MT_AGENT_ENV_';

function starterRoleMd(name: string): string {
  return (
    `<!-- Standing instructions for the ${name} role, given to its agent at every claim.\n` +
    '     Say what the role does, how it works, and what it must not do. -->\n'
  );
}

export interface CreateOptions {
  cloneFrom?: string | undefined;
  description?: string | undefined;
}

/** `mt role create` (spec §2.6). */
export function roleCreate(name: string, opts: CreateOptions, io: MtIo): number {
  const problem = nameProblem('role', name);
  if (problem !== undefined) return refuse(io, problem);
  if (isReservedRoleName(name)) return refuse(io, `role name ${name} is reserved: it is a driver id`);
  if (name === DEFAULT_ROLE && opts.cloneFrom !== undefined) {
    return refuse(io, 'the role default is always made from the agent: block; --clone-from cannot be used with it');
  }
  if (opts.cloneFrom !== undefined) {
    // A name, never a path: `--clone-from ../x` must not read outside roles/.
    const sourceProblem = nameProblem('role', opts.cloneFrom);
    if (sourceProblem !== undefined) return refuse(io, sourceProblem);
  }

  const settings = loadTeamSettings(io.env);
  const rolesDir = join(settings.home, 'roles');
  const dir = join(rolesDir, name);
  if (existsSync(dir)) return refuse(io, `${dir} already exists`);

  const source = opts.cloneFrom ?? DEFAULT_ROLE;
  const sourceDir = join(rolesDir, source);
  let configText: string;
  let legacy = false;
  if (existsSync(join(sourceDir, 'config.yaml'))) {
    configText = readFileSync(join(sourceDir, 'config.yaml'), 'utf8');
  } else if (source === DEFAULT_ROLE && settings.agent !== undefined) {
    configText = renderAgentConfig(settings.agent);
    legacy = true;
  } else {
    return refuse(io, `there is no role ${source} to copy from`);
  }
  if (opts.description !== undefined) {
    const doc = parseDocument(configText);
    doc.set('description', opts.description);
    configText = String(doc);
  }
  // role.md and skills/ come with --clone-from; copying from default takes config.yaml only.
  const copyDir = opts.cloneFrom === undefined ? undefined : sourceDir;

  mkdirSync(rolesDir, { recursive: true, mode: 0o700 });
  // Dot-named, so discoverRoles ignores it until the rename puts it in place.
  const staging = mkdtempSync(join(rolesDir, `.${name}-`));
  try {
    writeFileSync(join(staging, 'config.yaml'), configText);
    const roleMd = copyDir === undefined ? undefined : join(copyDir, 'role.md');
    writeFileSync(
      join(staging, 'role.md'),
      roleMd !== undefined && existsSync(roleMd) ? readFileSync(roleMd, 'utf8') : starterRoleMd(name),
    );
    const skills = copyDir === undefined ? undefined : join(copyDir, 'skills');
    if (skills !== undefined && existsSync(skills)) cpSync(skills, join(staging, 'skills'), { recursive: true });
    else mkdirSync(join(staging, 'skills'));
    // Never cloned (spec §2.5): one credential with two owners is how a rotated
    // refresh token gets revoked for the other.
    writeFileSync(join(staging, '.env'), '', { mode: 0o600, flag: 'wx' });
    writeFileSync(join(staging, '.gitignore'), '.env\n');
    renameSync(staging, dir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  io.out(`created role ${name} at ${dir}, with config.yaml from ${legacy ? 'the agent: block' : `role ${source}`}`);
  if (legacy) reportLegacyCopy(dir, io);
  if (name === DEFAULT_ROLE) reportCutover(dir, settings.configPath, io);
  io.out(`check it with: mt role check ${name}`);
  return 0;
}

function renderAgentConfig(agent: AgentConfig): string {
  const block: Record<string, unknown> = {
    driver: agent.driver,
    command: agent.command,
    args: [...agent.args],
    unsupervised: agent.unsupervised,
  };
  if (agent.passEnv.length > 0) block['passEnv'] = [...agent.passEnv];
  if (agent.readOnlyTools.length > 0) block['readOnlyTools'] = [...agent.readOnlyTools];
  if (agent.maskExempt.length > 0) block['maskExempt'] = [...agent.maskExempt];
  // Names only. The agent block's env holds values, and none of them is written.
  return `# Written by mt role create from the gateway's agent: block.\n${stringifyYaml({ agent: block })}`;
}

function reportLegacyCopy(dir: string, io: MtIo): void {
  for (const key of AGENT_OVERRIDES) {
    const value = io.env[key];
    if (value !== undefined && value.trim() !== '') {
      io.out(`applied ${key} from this shell (the service's environment may differ)`);
    }
  }
  const secrets = Object.keys(io.env)
    .filter((key) => key.startsWith(AGENT_ENV_PREFIX) && key.length > AGENT_ENV_PREFIX.length)
    .sort();
  if (secrets.length > 0) {
    io.out(`not copied, because they are secrets: ${secrets.join(', ')}`);
    io.out(`put them in ${join(dir, '.env')} as:`);
    for (const key of secrets) io.out(`  ${key.slice(AGENT_ENV_PREFIX.length)}=...`);
  }
}

function reportCutover(dir: string, configPath: string | undefined, io: MtIo): void {
  io.out('to make this the role default:');
  io.out(`  1. put the values listed above, if any, in ${join(dir, '.env')}`);
  io.out(
    `  2. remove the agent: block${configPath === undefined ? '' : ` from ${configPath}`}, ` +
      "and every MT_AGENT_* variable from the service's environment",
  );
  io.out('  3. run mt role check');
  io.out('  4. restart the gateway');
  io.out('until 1 and 2 are done the gateway will not start: it refuses to run with the role default defined twice');
}
```

In `src/cli/mt.ts`, import `roleCreate`, and add before the `unknown command` throw:

```ts
    if (group === 'role' && command === 'create') {
      const { values, positionals } = parse(rest, {
        'clone-from': { type: 'string' },
        description: { type: 'string' },
      });
      const [name, extra] = positionals;
      if (name === undefined || extra !== undefined) throw new UsageError('role create takes one name');
      return roleCreate(name, { cloneFrom: values['clone-from'], description: values.description }, io);
    }
```

- [ ] **Step 6.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  509 passed (509)`; `npm run typecheck` → no output.

- [ ] **Step 6.5: Commit.**

```bash
git add src/cli/role.ts src/cli/mt.ts tests/mt-role.test.ts
git commit -m "Add mt role create, copying from the agent block or another role but never a .env"
```

---

### Task 7: `mt role check`

**Files:**
- Modify: `src/cli/role.ts`, `src/cli/mt.ts`, `tests/mt-role.test.ts`

The check runs the startup validation (spec §2.6). It loads the team settings and the team, checks each role's `.env`, and refuses any workspace name the database recorded for a different directory. It reports in two parts:
- **Files:** problems that come from the files.
- **This shell's environment:** unset `passEnv` names, and anything that only goes wrong because of this shell's `MT_AGENT_*` variables. A problem counts as the environment's if it disappears when those variables are removed.

The output notes that the service's environment may differ. With a name, the check also confirms that role exists. The rest of the team is checked as well, because startup checks all of it.

- [ ] **Step 7.1: Write the failing tests.** Add to `tests/mt-role.test.ts`:
  - imports: `openDb` and `migrate` from `../src/db/open.js`, `registerWorkspaces` from `../src/db/workspaces.js`, and `SCHEMA_DIR` from `./helpers/db.js`;
  - then the `describe` below.

```ts
describe('mt role check', () => {
  it('passes a sound team', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^files: ok$/m);
    expect(r.out).toMatch(/^this shell's environment: ok$/m);
    expect(r.out).toMatch(/service's environment may differ/);
  });

  it('reports a broken role file under the files', async () => {
    fx = mtFixture();
    roleDir('broken', 'agent: [\n');
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^files:\n {2}.*broken/m);
    expect(r.out).toMatch(/^this shell's environment: ok$/m);
  });

  it("reports an unset passEnv name as this shell's, apart from the files", async () => {
    fx = mtFixture();
    roleDir('reviewer', `${ACP_AGENT}  passEnv: [REVIEW_TOKEN]\n`);
    const r = await fx.run(['role', 'check', 'reviewer']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^files: ok$/m);
    expect(r.out).toMatch(/role reviewer names REVIEW_TOKEN in agent.passEnv, and it is not set in this shell/);
  });

  it("reports MT_AGENT_* variables beside roles/default as this shell's", async () => {
    fx = mtFixture((ws) => `workspace: ${ws}\n`);
    roleDir('default', ACP_AGENT);
    const r = await fx.run(['role', 'check'], { env: { MT_AGENT_COMMAND: 'bytesec' } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^files: ok$/m);
    expect(r.out).toMatch(/define the role default; keep one/);
  });

  it('refuses a workspace the database recorded at another directory', async () => {
    fx = mtFixture();
    const db = openDb(join(fx.home, 'gateway.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['default', '/elsewhere']]), 0);
    db.close();
    const r = await fx.run(['role', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/workspace default is \/elsewhere/);
  });

  it('says so when the named role does not exist', async () => {
    fx = mtFixture();
    const r = await fx.run(['role', 'check', 'nobody']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/there is no role nobody/);
  });
});
```

- [ ] **Step 7.2: Run them to verify they fail.** `npx vitest run --project unit tests/mt-role.test.ts`. Expected: the six new tests FAIL with `unknown command: role check`.

- [ ] **Step 7.3: Implement.** Add to `src/cli/role.ts`:
- **Imports:** add `ConfigError` and `type Env` to the `../config.js` import. Add `loadTeam` from `../team.js`, and `movedMessage` and `registrationsAt` from `../db/workspaces.js`.
- **Code:** add the following, and export `roleCheck`.

```ts
interface Attempt {
  error?: string;
  /** `role: NAME` for each passEnv name not set in the environment checked. */
  unset: string[];
}

/** One run of the startup validation against `env`. Never throws a ConfigError. */
function attempt(env: Env, only: string | undefined): Attempt {
  const unset: string[] = [];
  try {
    const settings = loadTeamSettings(env);
    const team = loadTeam(settings, env, { unsetPassEnv: unset });
    if (only !== undefined && !team.roles.has(only)) return { error: `there is no role ${only}`, unset };
    const recorded = registrationsAt(settings.dbPath);
    for (const [name, path] of team.workspaces) {
      const was = recorded.get(name);
      if (was !== undefined && was !== path) return { error: movedMessage(name, was, path), unset };
    }
    return { unset: only === undefined ? unset : unset.filter((u) => u.startsWith(`${only}: `)) };
  } catch (err) {
    if (err instanceof ConfigError) return { error: err.message, unset };
    throw err;
  }
}

function withoutAgentVariables(env: Env): Env {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('MT_AGENT_')) out[key] = value;
  }
  return out;
}

/**
 * `mt role check [name]` (spec §2.6): the startup validation, in two parts --
 * what the files say, and what this shell's environment adds. A problem that
 * goes away without this shell's MT_AGENT_* variables is the environment's.
 */
export function roleCheck(only: string | undefined, io: MtIo): number {
  const real = attempt(io.env, only);
  const files: string[] = [];
  const environment = real.unset.map((entry) => {
    const [role, key] = entry.split(': ');
    return `role ${role} names ${key} in agent.passEnv, and it is not set in this shell`;
  });
  if (real.error !== undefined) {
    const stripped = attempt(withoutAgentVariables(io.env), only);
    if (stripped.error === real.error) {
      files.push(real.error);
    } else {
      environment.push(real.error);
      if (stripped.error !== undefined) files.push(stripped.error);
    }
  }
  report('files', files, io);
  report("this shell's environment", environment, io);
  io.out("note: the environment was checked in this shell; the service's environment may differ");
  return files.length + environment.length === 0 ? 0 : 1;
}

function report(what: string, problems: readonly string[], io: MtIo): void {
  if (problems.length === 0) {
    io.out(`${what}: ok`);
    return;
  }
  io.out(`${what}:`);
  for (const p of problems) io.out(`  ${p}`);
}
```

In `src/cli/mt.ts`, import `roleCheck` and add:

```ts
    if (group === 'role' && command === 'check') {
      const [name, extra] = parse(rest, {}).positionals;
      if (extra !== undefined) throw new UsageError('role check takes at most one name');
      return roleCheck(name, io);
    }
```

- [ ] **Step 7.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  515 passed (515)`; `npm run typecheck` → no output.

- [ ] **Step 7.5: Commit.**

```bash
git add src/cli/role.ts src/cli/mt.ts tests/mt-role.test.ts
git commit -m "Add mt role check, reporting the files apart from this shell's environment"
```

---

### Task 8: `mt workspace add <name> <path>`

**Files:**
- Create: `src/cli/workspace.ts`, `tests/mt-workspace.test.ts`
- Modify: `src/cli/mt.ts`

Spec §2.6. The command adds the name to `workspaces:` in the config file, editing it in place so its comments survive. Before writing, it runs every check that startup runs, by calling `resolveWorkspaces` on the result. It refuses:
- a name outside the grammar;
- a name already in the workspaces;
- `default` while `workspace:` or `MT_WORKSPACE` sets it;
- a name the database recorded for a different directory;
- anything else the next start would refuse.

It also refuses when there is no config file. The file is written to a temporary file next to it and renamed into place, with the original's mode.

- [ ] **Step 8.1: Write the failing tests.** Create `tests/mt-workspace.test.ts`:

```ts
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadTeamSettings } from '../src/config.js';
import { migrate, openDb } from '../src/db/open.js';
import { registerWorkspaces } from '../src/db/workspaces.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

let fx: MtFixture;
afterEach(() => fx.cleanup());

function docsDir(): string {
  const dir = join(fx.root, 'docs');
  mkdirSync(dir);
  return dir;
}

describe('mt workspace add', () => {
  it('adds a workspace to the config file, keeping its comments', async () => {
    fx = mtFixture();
    const docs = docsDir();
    const r = await fx.run(['workspace', 'add', 'docs', docs]);
    expect(r.code).toBe(0);
    const text = readFileSync(fx.configPath, 'utf8');
    expect(text).toMatch(/# test config/);
    expect((parseYaml(text) as { workspaces: Record<string, string> }).workspaces['docs']).toBe(docs);
    expect(loadTeamSettings(fx.env).workspaces['docs']).toBe(docs);
  });

  it('refuses when there is no config file', async () => {
    fx = mtFixture();
    rmSync(fx.configPath);
    const r = await fx.run(['workspace', 'add', 'docs', docsDir()], { env: { MT_WORKSPACE: fx.workspace } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no config file/);
  });

  it('refuses a name already in the workspaces, and default while workspace: sets it', async () => {
    fx = mtFixture();
    const docs = docsDir();
    expect((await fx.run(['workspace', 'add', 'docs', docs])).code).toBe(0);
    expect((await fx.run(['workspace', 'add', 'docs', docs])).err).toMatch(/already/);
    expect((await fx.run(['workspace', 'add', 'default', docs])).err).toMatch(/workspace: in the config file/);
  });

  it('refuses what the next start would refuse, and leaves the file as it was', async () => {
    fx = mtFixture();
    const before = readFileSync(fx.configPath, 'utf8');
    for (const path of ['docs', join(fx.root, 'missing'), fx.home, join(fx.workspace, 'inner')]) {
      if (path.endsWith('inner')) mkdirSync(path);
      const r = await fx.run(['workspace', 'add', 'docs', path]);
      expect(r.code, path).toBe(1);
    }
    expect(readFileSync(fx.configPath, 'utf8')).toBe(before);
  });

  it('refuses a name the database recorded for a different directory', async () => {
    fx = mtFixture();
    const db = openDb(join(fx.home, 'gateway.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['docs', '/elsewhere']]), 0);
    db.close();
    const r = await fx.run(['workspace', 'add', 'docs', docsDir()]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/workspace docs is \/elsewhere/);
  });

  it('refuses a name outside the grammar, and a wrong command line', async () => {
    fx = mtFixture();
    expect((await fx.run(['workspace', 'add', 'Docs', docsDir()])).code).toBe(1);
    expect((await fx.run(['workspace', 'add', 'docs'])).code).toBe(2);
  });
});
```

- [ ] **Step 8.2: Run them to verify they fail.** `npx vitest run --project unit tests/mt-workspace.test.ts`. Expected: FAIL with `unknown command: workspace add`.

- [ ] **Step 8.3: Implement.** Create `src/cli/workspace.ts`:

```ts
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { loadTeamSettings } from '../config.js';
import { movedMessage, registrationsAt } from '../db/workspaces.js';
import { nameProblem } from '../names.js';
import { resolveWorkspaces } from '../workspaces.js';
import { refuse, type Git, type MtIo } from './mt.js';

export type AddTarget = { path: string } | { cloneUrl: string };

/** `mt workspace add` (spec §2.6). Refuses anything the next start would refuse. */
export async function workspaceAdd(name: string, target: AddTarget, io: MtIo): Promise<number> {
  const settings = loadTeamSettings(io.env);
  if (settings.configPath === undefined) {
    return refuse(
      io,
      `there is no config file (looked for ${io.env['MT_CONFIG'] ?? join(settings.home, 'config.yaml')}); ` +
        'create one, then add workspaces to it',
    );
  }
  const configPath = settings.configPath;
  const problem = nameProblem('workspace', name);
  if (problem !== undefined) return refuse(io, problem);

  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  if (settings.workspaces[name] !== undefined) {
    const single = name === 'default' && (doc.has('workspace') || (io.env['MT_WORKSPACE'] ?? '') !== '');
    return refuse(
      io,
      single
        ? "the workspace default is already set by workspace: in the config file, or by MT_WORKSPACE in this shell (the service's environment may differ)"
        : `workspace ${name} is already in ${configPath}`,
    );
  }
  const recorded = registrationsAt(settings.dbPath).get(name);

  let path: string;
  let cloned: string | undefined;
  if ('path' in target) {
    path = target.path;
  } else {
    const parent = join(settings.home, 'workspaces');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    path = join(realpathSync(parent), name);
    if (existsSync(path)) return refuse(io, `${path} already exists`);
    if (recorded !== undefined && recorded !== path) return refuse(io, movedMessage(name, recorded, path));
    // `--` so a URL starting with `-` cannot be read as an option. Any URL git
    // accepts is allowed: this runs as the operator, who could run git directly.
    const result = await (io.git ?? runGit)(['clone', '--', target.cloneUrl, path]);
    if (result.code !== 0) {
      rmSync(path, { recursive: true, force: true });
      const tail = result.stderr.trim().split('\n').slice(-3).join('\n');
      return refuse(io, `git clone failed (exit ${result.code})${tail === '' ? '' : `:\n${tail}`}`);
    }
    cloned = path;
  }
  const undo = (): void => {
    if (cloned !== undefined) rmSync(cloned, { recursive: true, force: true });
  };

  const resolved = resolveWorkspaces({ ...settings.workspaces, [name]: path }, settings.home, settings.dbPath);
  if ('error' in resolved) {
    undo();
    return refuse(io, resolved.error);
  }
  const real = resolved.workspaces.get(name) ?? path;
  if (recorded !== undefined && recorded !== real) {
    undo();
    return refuse(io, movedMessage(name, recorded, real));
  }

  doc.setIn(['workspaces', name], path);
  writeInPlace(configPath, String(doc));
  io.out(`added workspace ${name} (${real}) to ${configPath}; the gateway uses it from its next start`);
  return 0;
}

/** Through a temporary file beside it, with the same mode, so a failed write leaves the old file. */
function writeInPlace(path: string, text: string): void {
  const real = realpathSync(path);
  const tmp = `${real}.mt-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: statSync(real).mode & 0o777, flag: 'wx' });
  renameSync(tmp, real);
}

const runGit: Git = (args) =>
  new Promise((resolve) => {
    const child = spawn('git', [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => resolve({ code: 127, stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
```

In `src/cli/mt.ts`, import `workspaceAdd` and add:

```ts
    if (group === 'workspace' && command === 'add') {
      const { values, positionals } = parse(rest, { clone: { type: 'string' } });
      const [name, path, extra] = positionals;
      if (name === undefined || extra !== undefined || (path === undefined) === (values.clone === undefined)) {
        throw new UsageError('workspace add takes a name and either an absolute path or --clone <git-url>');
      }
      return workspaceAdd(name, path === undefined ? { cloneUrl: values.clone ?? '' } : { path }, io);
    }
```

- [ ] **Step 8.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  521 passed (521)`; `npm run typecheck` → no output.

- [ ] **Step 8.5: Commit.**

```bash
git add src/cli/workspace.ts src/cli/mt.ts tests/mt-workspace.test.ts
git commit -m "Add mt workspace add, refusing anything the next start would refuse"
```

---

### Task 9: `mt workspace add --clone`

**Files:**
- Modify: `tests/mt-workspace.test.ts` (the code is in Task 8)

The clone path is already written. These tests prove it end to end:
- with real `git` against a local repository;
- with an injected `git` that fails after leaving a partial directory;
- with a target directory that already exists.

- [ ] **Step 9.1: Write the tests.** Add to `tests/mt-workspace.test.ts`. Import `execFileSync` from `node:child_process`, and `existsSync` and `writeFileSync` from `node:fs`. Import `type Git` from `../src/cli/mt.js`.

```ts
describe('mt workspace add --clone', () => {
  it('clones into the home and adds it', async () => {
    fx = mtFixture();
    const source = join(fx.root, 'source');
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-q', '-m', 'init']);
    const r = await fx.run(['workspace', 'add', 'docs', '--clone', source]);
    expect(r.code, r.err).toBe(0);
    const target = join(fx.home, 'workspaces', 'docs');
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(loadTeamSettings(fx.env).workspaces['docs']).toBe(target);
  });

  it('removes a failed clone and leaves the config file alone', async () => {
    fx = mtFixture();
    const before = readFileSync(fx.configPath, 'utf8');
    const git: Git = async (args) => {
      const target = args[3] ?? '';
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'partial'), 'x');
      return { code: 128, stderr: 'fatal: repository not found' };
    };
    const r = await fx.run(['workspace', 'add', 'docs', '--clone', 'https://example.invalid/x.git'], { git });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/git clone failed \(exit 128\)/);
    expect(r.err).toMatch(/repository not found/);
    expect(existsSync(join(fx.home, 'workspaces', 'docs'))).toBe(false);
    expect(readFileSync(fx.configPath, 'utf8')).toBe(before);
  });

  it('refuses when the clone directory exists, without running git', async () => {
    fx = mtFixture();
    mkdirSync(join(fx.home, 'workspaces', 'docs'), { recursive: true });
    let ran = false;
    const git: Git = async () => {
      ran = true;
      return { code: 0, stderr: '' };
    };
    const r = await fx.run(['workspace', 'add', 'docs', '--clone', 'https://example.invalid/x.git'], { git });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already exists/);
    expect(ran).toBe(false);
  });
});
```

- [ ] **Step 9.2: Run them.** `npx vitest run --project unit tests/mt-workspace.test.ts`. Expected: all pass. To prove the cleanup test can fail, temporarily delete the `rmSync(path, …)` line in the `result.code !== 0` branch and watch the second test fail; then restore the line.

- [ ] **Step 9.3: Run everything.** `npm test 2>&1 | tail -4` → `Tests  524 passed (524)`; `npm run typecheck` → no output.

- [ ] **Step 9.4: Commit.**

```bash
git add tests/mt-workspace.test.ts
git commit -m "Test cloning a workspace, and cleaning up a failed clone"
```

---

### Task 10: `mt workspace list`

**Files:**
- Modify: `src/cli/workspace.ts`, `src/cli/mt.ts`, `tests/mt-workspace.test.ts`

For each configured workspace, the list shows its declared path and whether the database has registered it. A registration at a different directory means the gateway will refuse to start. Names that are registered but no longer configured are listed too: those names stay taken.

- [ ] **Step 10.1: Write the failing test.** Add to `tests/mt-workspace.test.ts`:

```ts
describe('mt workspace list', () => {
  it('lists each workspace and whether the gateway has registered it', async () => {
    fx = mtFixture();
    const db = openDb(join(fx.home, 'gateway.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['default', fx.workspace], ['old', '/srv/old']]), 0);
    db.close();
    const r = await fx.run(['workspace', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`^default\\s+${fx.workspace}\\s+registered$`, 'm'));
    expect(r.out).toMatch(/^old\s+\/srv\/old\s+registered, not in the config$/m);
  });
});
```

- [ ] **Step 10.2: Run it to verify it fails.** Expected: FAIL with `unknown command: workspace list`.

- [ ] **Step 10.3: Implement.** Add the following to `src/cli/workspace.ts`. Also add `table` to its `./mt.js` import.

```ts
/** `mt workspace list`: each workspace, and whether the gateway has registered it. */
export function workspaceList(io: MtIo): number {
  const settings = loadTeamSettings(io.env);
  const recorded = registrationsAt(settings.dbPath);
  const rows: string[][] = [];
  for (const name of Object.keys(settings.workspaces).sort()) {
    const declared = settings.workspaces[name] ?? '';
    const was = recorded.get(name);
    let real: string | undefined;
    try {
      real = realpathSync(declared);
    } catch {
      real = undefined;
    }
    const status =
      was === undefined
        ? 'not registered yet'
        : was === real
          ? 'registered'
          : `registered at ${was}: the gateway will refuse to start`;
    rows.push([name, declared, status]);
  }
  for (const [name, path] of [...recorded].sort(([a], [b]) => a.localeCompare(b))) {
    if (settings.workspaces[name] === undefined) rows.push([name, path, 'registered, not in the config']);
  }
  for (const line of table(rows)) io.out(line);
  return 0;
}
```

In `src/cli/mt.ts`, import `workspaceList` and add:

```ts
    if (group === 'workspace' && command === 'list') {
      expectNothing(parse(rest, {}).positionals, 'workspace list');
      return workspaceList(io);
    }
```

- [ ] **Step 10.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  525 passed (525)`; `npm run typecheck` → no output.

- [ ] **Step 10.5: Commit.**

```bash
git add src/cli/workspace.ts src/cli/mt.ts tests/mt-workspace.test.ts
git commit -m "Add mt workspace list"
```

---

### Task 11: README, and a read-only run against the real home

**Files:**
- Modify: `README.md`

- [ ] **Step 11.1: README.** Add a new `### The mt command` section after the "### Roles and workspaces" section ends, and before `### Chat commands`:

````markdown
### The mt command

`mt` creates and checks roles and workspaces. In a checkout, run it as `npm run -s mt -- …`.

```
mt role create <name> [--clone-from <role>] [--description "..."]
mt role list
mt role check [<name>]
mt workspace add <name> <absolute-path>
mt workspace add <name> --clone <git-url>
mt workspace list
```

It finds the home, config file and database the way the gateway does (`MT_HOME`, `MT_CONFIG`,
`MT_DB`), from the shell it runs in, and needs no Lark settings. It only writes files and
never contacts the gateway; changes take effect at the next start.

- `role create` writes `config.yaml` (from the role `default`, or `--clone-from`), a starter
  `role.md`, `skills/`, an empty `0600` `.env` and a `.gitignore`. A `.env` is never copied.
  `mt role create default` moves an `agent:` block into `roles/default/` and prints the steps
  that finish the move.
- `role check` runs the startup checks, and reports what comes from this shell's environment
  separately: the service's environment may differ.
- `workspace add` edits `workspaces:` in the config file, keeping its comments, and refuses
  anything the next start would refuse. `--clone` clones into `$MT_HOME/workspaces/<name>`.
````

Commit:

```bash
git add README.md
git commit -m "Document the mt command"
```

- [ ] **Step 11.2: Read-only run against the real home.** These three commands only read. `role check` opens the database read-only, and it is never written.

```bash
cd /Users/x/Develop/manus/prime-gateway-work
export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH
npm run -s mt -- role list; echo "exit $?"
npm run -s mt -- workspace list; echo "exit $?"
npm run -s mt -- role check; echo "exit $?"
```

Expected:
- **`role list`:** one line, `default  structured-cli  agent: block`, then `exit 0`.
- **`workspace list`:** `default  /Users/x/Develop/manus/bytesec-agents  registered`, then `exit 0`.
- **`role check`:** `files: ok`, `this shell's environment: ok`, the note, and `exit 0`.

If `role check` reports an environment problem, that is this shell's environment and not a bug. Report it, since the service's environment may differ.

Do **not** run `role create` or `workspace add` against the real home.

- [ ] **Step 11.3: Report, without merging.** Merging is the controller's step, after asking the user.

---

## Done when

- `npm test` → `Tests  525 passed (525)`, `npm run test:e2e` → `Tests  49 passed (49)`, and `npm run typecheck` prints nothing, all under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` → no output.
- Task 11.2 prints what it expects.
