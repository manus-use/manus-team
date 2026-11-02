# Plan B1 — Roles and workspaces in configuration: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At startup the gateway loads its **roles** (directories under `$MT_HOME/roles/`, each with `config.yaml`, optional `role.md`, `skills/` and `.env`) and its **workspaces** (a named map), validates all of it, and refuses to start on any mistake — while running exactly as today on the role `default` and the workspace `default`.

**Architecture:** Two steps at startup. `loadConfig` stays a pure parser of the gateway's own file and environment; it learns the `workspaces:` map, and its `agent:` block becomes optional. A new `loadTeam` reads the role directories and checks the workspaces on disk, and returns the roles and the resolved workspaces. Small pure modules do the parts that have rules: `names.ts` (the name grammar), `dotenv.ts` (the `.env` format), `workspaces.ts` (resolution and containment), `roles.ts` (one role directory), `team.ts` (putting it together, and the role `default`). The gateway still drives one agent and one workspace — the role `default`'s and workspace `default` — until plan B2 gives each session its own.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext — relative imports end in `.js`; strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), vitest, `yaml`.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §2.1 (a role's `config.yaml`, the role `default`), §2.2 (`role.md`, skills, tools), §2.3 (workspaces), §2.5 (a role's `.env`).

**Out of scope (later plans):** the `workspaces` database table and the "never relocated" rule (B2, it needs the database); a driver, workspace and environment per session (B2); the `mt` CLI (B3); masking (F).

---

## Ground rules

- **Work in the worktree `/Users/x/Develop/manus/prime-gateway-work`, branch `roles-workspaces`.** Never edit `/Users/x/Develop/manus/prime-gateway`: the live gateway runs from there under `tsx watch`.
- `node_modules` is symlinked into the worktree and shows as untracked. Commit named files only — **never `git add -A`**.
- **Node 22:** `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline:** `npm test` → `Tests  401 passed (401)`; `npm run typecheck` → no output. If not, stop.
- **Commit messages:** no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text. Use the messages given.
- **Tests that need files use real temporary directories** (`mkdtempSync(join(tmpdir(), 'mt-…-'))`), removed in `afterEach`. On macOS `tmpdir()` is under `/var`, which is a symlink to `/private/var`; compare against `realpathSync(...)` wherever a resolved path is expected.

---

## File structure

| File | Responsibility |
|---|---|
| `src/names.ts` (create) | the role/workspace name grammar, and reserved role names |
| `src/dotenv.ts` (create) | parsing a role's `.env` — `KEY=value`, comments, quotes, nothing else |
| `src/config.ts` (modify) | `workspaces:` map; optional `agent:` with `readOnlyTools`/`maskExempt`; `home` and `workspaces` on `GatewayConfig`; exporting the validation helpers roles reuse |
| `src/workspaces.ts` (create) | resolving declared workspaces on disk, and every containment rule |
| `src/roles.ts` (create) | discovering role directories, and loading one: `config.yaml`, `.env`, `role.md`, skills |
| `src/team.ts` (create) | `loadTeam`: workspaces + roles + the role `default` |
| `src/index.ts` (modify) | call `loadTeam` at startup; run the role `default`'s agent in workspace `default` |
| `README.md` (modify) | roles, workspaces, and the credentials rule |
| `tests/names.test.ts`, `tests/dotenv.test.ts`, `tests/workspaces.test.ts`, `tests/roles.test.ts`, `tests/team.test.ts` (create); `tests/config.test.ts` (modify) | tests |

---

### Task 1: The name grammar

**Files:** Create `src/names.ts`, `tests/names.test.ts`.

- [ ] **Step 1.1: Write the failing tests** — create `tests/names.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isReservedRoleName, nameProblem } from '../src/names.js';

/**
 * Role and workspace names become paths, assignee values typed in chat, and
 * keys stored in the database, so one grammar keeps all three safe: no `/` or
 * `..` to leave a directory, no `:` to look like a person's principal, one case
 * so two names cannot differ only by it.
 */
describe('nameProblem', () => {
  it('accepts lowercase letters, digits and hyphens, starting with a letter', () => {
    for (const name of ['default', 'implementer', 'docs-writer', 'r2', 'a'.repeat(40)]) {
      expect(nameProblem('role', name)).toBeUndefined();
    }
  });

  it('refuses anything else, and says why', () => {
    for (const name of ['Reviewer', '2fast', '../roles', 'a/b', 'a:b', 'a.b', '-x', '', 'a'.repeat(41)]) {
      expect(nameProblem('workspace', name)).toMatch(/workspace name .* must be lowercase/);
    }
  });
});

describe('isReservedRoleName', () => {
  it('reserves the driver ids, which old sessions store where a role name now goes', () => {
    expect(isReservedRoleName('acp')).toBe(true);
    expect(isReservedRoleName('structured-cli')).toBe(true);
    expect(isReservedRoleName('implementer')).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail** — `npx vitest run --project unit tests/names.test.ts` → FAIL, `../src/names.js` cannot be resolved.

- [ ] **Step 1.3: Write `src/names.ts`:**

```ts
import { KNOWN_DRIVERS } from './driver/registry.js';

/**
 * The grammar for role and workspace names.
 *
 * A name becomes a path (`roles/<name>/`, `workspaces/<name>/`), a value typed
 * in chat, and a key in the database, so it cannot contain `/`, `.` or `..`
 * (which would leave its directory), `:` (which would look like a person's
 * principal, `lark:…`), or upper case (two names differing only by case).
 */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** Why `name` is not a valid role or workspace name, or undefined if it is. */
export function nameProblem(kind: 'role' | 'workspace', name: string): string | undefined {
  if (NAME_PATTERN.test(name)) return undefined;
  return (
    `${kind} name ${JSON.stringify(name)} must be lowercase letters, digits and '-', ` +
    'start with a letter, and be at most 40 characters'
  );
}

/**
 * Driver ids cannot be role names. Sessions created before roles existed store
 * a driver id where a role name now goes, and read it as the role `default`; a
 * role called `acp` would make those rows ambiguous.
 */
export function isReservedRoleName(name: string): boolean {
  return (KNOWN_DRIVERS as readonly string[]).includes(name);
}
```

- [ ] **Step 1.4: Run the tests** → `Tests  3 passed (3)`.

- [ ] **Step 1.5: Commit**

```bash
git add src/names.ts tests/names.test.ts
git commit -m "Give role and workspace names one grammar"
```

---

### Task 2: A role's `.env` format

**Files:** Create `src/dotenv.ts`, `tests/dotenv.test.ts`.

- [ ] **Step 2.1: Write the failing tests** — create `tests/dotenv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseEnvFile } from '../src/dotenv.js';

/**
 * A deliberately small format. Anything outside it is an error naming the line,
 * not a guess -- and an error never quotes a value, because the values are the
 * secrets this file exists to hold.
 */
function values(text: string): Record<string, string> {
  const r = parseEnvFile(text, '.env');
  if ('error' in r) throw new Error(r.error);
  return r.values;
}

function error(text: string): string {
  const r = parseEnvFile(text, '.env');
  if (!('error' in r)) throw new Error('expected an error');
  return r.error;
}

describe('parseEnvFile', () => {
  it('reads KEY=value lines, skipping blank lines and comments', () => {
    expect(values('# tokens\n\nGH_TOKEN=abc\nAPI_URL = https://x.example/v1 \n')).toEqual({
      GH_TOKEN: 'abc',
      API_URL: 'https://x.example/v1',
    });
  });

  it('removes one pair of matching quotes', () => {
    expect(values(`A="has spaces"\nB='single'\nC="it's"`)).toEqual({
      A: 'has spaces',
      B: 'single',
      C: "it's",
    });
  });

  it('takes a dollar sign literally, because nothing is expanded', () => {
    expect(values('A=$HOME/x')).toEqual({ A: '$HOME/x' });
  });

  it('refuses export, naming the line', () => {
    expect(error('A=1\nexport B=2')).toMatch(/^\.env:2: `export` is not supported/);
  });

  it('refuses a line with no equals sign', () => {
    expect(error('A=1\njust text')).toMatch(/^\.env:2: expected KEY=value/);
  });

  it('refuses a name that is not a variable name', () => {
    expect(error('1A=x')).toMatch(/^\.env:1: "1A" is not a valid variable name/);
  });

  it('refuses an unterminated quote', () => {
    expect(error('A="never closed')).toMatch(/^\.env:1: unterminated quote/);
  });

  it('refuses a variable set twice', () => {
    expect(error('A=1\nA=2')).toMatch(/^\.env:2: A is set twice/);
  });

  it('never puts a value in an error', () => {
    expect(error('A="sk-secret-value')).not.toContain('sk-secret-value');
    expect(error('A=sk-secret-value\nA=sk-other')).not.toContain('sk-');
  });
});
```

- [ ] **Step 2.2: Run them to verify they fail** — `npx vitest run --project unit tests/dotenv.test.ts` → FAIL, `../src/dotenv.js` cannot be resolved.

- [ ] **Step 2.3: Write `src/dotenv.ts`:**

```ts
/**
 * The format of a role's `.env`.
 *
 * `KEY=value` lines, blank lines, and comments starting with `#`. A value may be
 * wrapped in one pair of single or double quotes, which are removed. Nothing is
 * expanded, there is no `export`, and there are no multi-line values. Anything
 * else is an error naming the line: a guess at what an unusual line meant is how
 * a secret ends up half-read.
 *
 * Errors name lines and keys, never values -- the values are secrets.
 */

export type EnvFileResult = { values: Record<string, string> } | { error: string };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvFile(text: string, source: string): EnvFileResult {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    const at = `${source}:${i + 1}`;
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('export ')) {
      return { error: `${at}: \`export\` is not supported; write NAME=value` };
    }
    const eq = line.indexOf('=');
    if (eq <= 0) return { error: `${at}: expected KEY=value` };

    const key = line.slice(0, eq).trim();
    if (!VARIABLE_NAME.test(key)) {
      return { error: `${at}: ${JSON.stringify(key)} is not a valid variable name` };
    }

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || value[value.length - 1] !== quote) {
        return { error: `${at}: unterminated quote` };
      }
      value = value.slice(1, -1);
    }

    if (Object.hasOwn(values, key)) return { error: `${at}: ${key} is set twice` };
    values[key] = value;
  }

  return { values };
}
```

- [ ] **Step 2.4: Run the tests** → `Tests  9 passed (9)`.

- [ ] **Step 2.5: Commit**

```bash
git add src/dotenv.ts tests/dotenv.test.ts
git commit -m "Parse a role's .env in a small, strict format"
```

---

### Task 3: The gateway's config: workspaces map, optional agent

**Files:** Modify `src/config.ts`, `tests/config.test.ts`.

- [ ] **Step 3.1: Write the failing tests.** In `tests/config.test.ts`:

1. The agent block becomes optional, so every read of it must allow `undefined`: replace every `cfg.agent.` with `cfg.agent?.`, **and** every `).agent.` with `).agent?.` (calls written as `load(...).agent.args` and the like, around lines 423–457). Where the result is passed to `Object.values` (around line 391), write `Object.values(cfg.agent?.env ?? {})`.
2. In the test `'names both sources for a value it cannot find'`, delete the three lines that expect `loadEnvOnly({ ...ENV_ONLY, MT_AGENT_COMMAND: undefined })` to throw `/agent\.command in the config file, or MT_AGENT_COMMAND/`. (A missing agent is no longer `loadConfig`'s error: a role directory may supply it — Task 7.)
3. Append:

```ts
describe('loadConfig: roles and workspaces', () => {
  it('reads named workspaces from the file', () => {
    const cfg = load({}, yamlFile({ workspace: undefined, workspaces: { default: '/srv/a', docs: '/srv/b' } }));
    expect(cfg.workspaces).toEqual({ default: '/srv/a', docs: '/srv/b' });
    expect(cfg.workspaceDir).toBe('/srv/a');
  });

  it('makes the single workspace setting the workspace named default', () => {
    expect(load().workspaces).toEqual({ default: '/srv/repo' });
    expect(load({ MT_WORKSPACE: '/srv/env' }).workspaces).toEqual({ default: '/srv/env' });
  });

  it('refuses a default workspace set both ways', () => {
    const file = yamlFile({ workspaces: { default: '/srv/a' } });
    expect(() => load({}, file)).toThrow(/workspaces\.default and workspace/);
  });

  it('leaves the agent undefined when nothing configures one', () => {
    expect(loadEnvOnly({ ...ENV_ONLY, MT_AGENT_COMMAND: undefined }).agent).toBeUndefined();
  });

  it('treats an agent variable alone as configuring the agent, which then needs a command', () => {
    expect(() =>
      loadEnvOnly({ ...ENV_ONLY, MT_AGENT_COMMAND: undefined, MT_AGENT_DRIVER: 'acp' }),
    ).toThrow(/agent\.command in the config file, or MT_AGENT_COMMAND/);
  });

  it('reads readOnlyTools and maskExempt in the agent block', () => {
    const file = yamlFile({
      agent: { command: 'claude-agent-acp', readOnlyTools: ['read'], maskExempt: ['API_URL'] },
    });
    const cfg = load({}, file);
    expect(cfg.agent?.readOnlyTools).toEqual(['read']);
    expect(cfg.agent?.maskExempt).toEqual(['API_URL']);
  });

  it('exposes the home it settled on', () => {
    expect(load().home).toBe(HOME);
  });
});
```

(`yamlFile` merges its override one level deep and serializes with `yaml`, which leaves out keys whose value is `undefined` — so `workspace: undefined` drops the base file's single workspace for the first test.)

- [ ] **Step 3.2: Run them to verify they fail** — `npx vitest run --project unit tests/config.test.ts` → 6 of the 7 new tests FAIL (unknown setting `workspaces`; `workspaces`/`home` undefined; agent always built). The one that "treats an agent variable alone" already passes — today's code requires a command too. Typecheck fails too on `cfg.agent?.readOnlyTools` — expected at this step.

- [ ] **Step 3.3: Update `src/config.ts`:**

1. **Export the environment type:** `type Env = …` → `export type Env = …`.

2. **The agent type.** Replace the inline `agent: { … }` in `GatewayConfig` with `agent: AgentConfig | undefined;`, and add before `GatewayConfig`:

   ```ts
   /** How to run a coding agent: the gateway's `agent:` block, or a role's (`roles.ts`). */
   export interface AgentConfig {
     /** Which driver runs the agent. One of `KNOWN_DRIVERS`. */
     driver: KnownDriver;
     command: string;
     args: readonly string[];
     /** Extra environment for the agent process. Where credentials go. */
     env: Readonly<Record<string, string>>;
     /**
      * The operator has accepted that the agent acts without asking.
      *
      * Required by `structured-cli`, which has no permission protocol, and refused
      * by every driver that does. It is a written acknowledgement rather than a
      * switch: a driver that quietly stops showing approval cards is a security
      * posture nobody chose.
      */
     unsupervised: boolean;
     /** Variable names forwarded from the gateway's environment. */
     passEnv: readonly string[];
     /** The agent's tool names that only read (spec §2.1, §8.3). */
     readOnlyTools: readonly string[];
     /** Environment names whose values are not secret, so not masked (spec §10.1). */
     maskExempt: readonly string[];
   }
   ```

   Doc-comment the field: `/** The \`agent:\` block or \`MT_AGENT_*\` variables, if either is present. Absent means a role directory must supply the role \`default\` (\`team.ts\`). */`

3. **New fields on `GatewayConfig`**, after `configPath`:

   ```ts
     /** The directory the config, database, downloads and roles live under. */
     home: string;
   ```

   and after `workspaceDir`:

   ```ts
     /** Workspace name → declared absolute path; checked on disk by `workspaces.ts`. Always has `default`. */
     workspaces: Readonly<Record<string, string>>;
   ```

   Keep `workspaceDir` and make its comment `/** The workspace named default — what every session uses until plan B2. */`.

4. **The file.** In `FileConfig`, add `workspaces: Record<string, string>;` and `agentPresent: boolean;`, and to its `agent` add `readOnlyTools: readonly string[]; maskExempt: readonly string[];`. In `emptyFile()`, add `workspaces: {}`, `agentPresent: false`, and in `agent` `readOnlyTools: [], maskExempt: []`.

   In `parseFile`: add `'workspaces'` to the root's known keys and `'readOnlyTools', 'maskExempt'` to the agent's; then set

   ```ts
     out.workspaces = stringMap(path, 'workspaces', root['workspaces']);
     out.agentPresent = root['agent'] !== undefined && root['agent'] !== null;
   ```

   and in `out.agent` add

   ```ts
       readOnlyTools: strings(path, 'agent.readOnlyTools', agentRaw['readOnlyTools']),
       maskExempt: strings(path, 'agent.maskExempt', agentRaw['maskExempt']),
   ```

   Add, next to `strings`:

   ```ts
   function stringMap(path: string, key: string, value: unknown): Record<string, string> {
     if (value === undefined || value === null) return {};
     const out: Record<string, string> = {};
     for (const [name, entry] of Object.entries(section(path, key, value))) {
       const text = str(path, `${key}.${name}`, entry);
       if (text !== undefined) out[name] = text;
     }
     return out;
   }
   ```

5. **`loadConfig`.** Replace the block that computes `workspaceDir` (from `const workspaceDir =` through its `isAbsolute` check) with:

   ```ts
     const single = envString(env, 'MT_WORKSPACE') ?? file.workspace;
     if (single !== undefined && file.workspaces['default'] !== undefined) {
       throw new ConfigError(
         'workspaces.default and workspace (or MT_WORKSPACE) are both set: keep only workspaces.default',
       );
     }
     const workspaces: Record<string, string> = {
       ...file.workspaces,
       ...(single === undefined ? {} : { default: single }),
     };
     const workspaceDir =
       workspaces['default'] ??
       fail('a workspace is required: set workspaces.default, or workspace in the config file, or MT_WORKSPACE');
     if (!isAbsolute(workspaceDir)) {
       // Relative resolves against the gateway's cwd, which is whatever the service
       // manager set. The workspace would then depend on how the process was launched.
       throw new ConfigError(`the workspace must be an absolute path, got ${JSON.stringify(workspaceDir)}`);
     }
   ```

   Move the agent code — from `const command =` through `requireSupervisionMatch(driver, unsupervised);` — into a new function, and replace the command's space check with a call to a new exported `checkCommand`:

   ```ts
   /** The legacy `agent:` block, with its `MT_AGENT_*` overrides applied. */
   function legacyAgent(env: Env, file: FileConfig): AgentConfig {
     const command =
       envString(env, 'MT_AGENT_COMMAND') ??
       file.agent.command ??
       fail('an agent command is required: set agent.command in the config file, or MT_AGENT_COMMAND');
     checkCommand(command);
     const argsFromEnv = envString(env, 'MT_AGENT_ARGS');
     const args = argsFromEnv === undefined ? file.agent.args : shellWords(argsFromEnv);
     const driver = driverOf(envString(env, 'MT_AGENT_DRIVER') ?? file.agent.driver ?? 'acp');
     const unsupervised = envFlag(env, 'MT_AGENT_UNSUPERVISED') ?? file.agent.unsupervised ?? false;
     requireSupervisionMatch(driver, unsupervised);
     return {
       driver,
       command,
       args,
       env: agentEnv(env, file.agent.passEnv),
       unsupervised,
       passEnv: file.agent.passEnv,
       readOnlyTools: file.agent.readOnlyTools,
       maskExempt: file.agent.maskExempt,
     };
   }

   /**
    * `command: bytesec acp` is a subcommand written where the binary goes. The agent
    * is spawned with `shell: false`, so this asks for a file whose name contains a
    * space and fails as an ENOENT at the first prompt -- long after boot, and
    * reported as the agent not starting rather than as a typo here. Absolute paths
    * are exempt: `/Applications/My App/bin/agent` is a real thing.
    */
   export function checkCommand(command: string): void {
     if (!/\s/.test(command) || isAbsolute(command)) return;
     const [first = '', ...rest] = command.split(/\s+/);
     throw new ConfigError(
       `the agent command ${JSON.stringify(command)} contains a space, and is not a path. ` +
         `Arguments belong in agent.args: command: ${first}, args: [${rest.join(', ')}]. ` +
         'Use an absolute path if the binary really is named that.',
     );
   }
   ```

   In `loadConfig`, where the agent code was, put:

   ```ts
     // The agent block is optional: a role directory may define the role default
     // instead (team.ts). An MT_AGENT_* variable alone counts as configuring it.
     const agentFromEnv =
       ['MT_AGENT_COMMAND', 'MT_AGENT_ARGS', 'MT_AGENT_DRIVER', 'MT_AGENT_UNSUPERVISED'].some(
         (key) => envString(env, key) !== undefined,
       ) ||
       Object.keys(env).some(
         (key) => key.startsWith(AGENT_ENV_PREFIX) && key.length > AGENT_ENV_PREFIX.length && env[key] !== undefined,
       );
     const agent = file.agentPresent || agentFromEnv ? legacyAgent(env, file) : undefined;
   ```

   and in the returned object replace the `agent: { … }` literal with `agent,`, and add `home,` and `workspaces,`.

6. **Export what `roles.ts` reuses**, by adding `export` to: `driverOf`, `requireSupervisionMatch`, `shellWords`, `section`, `subsection`, `str`, `strings`, `bool`.

7. **`passEnv` for any caller.** Split the first loop of `agentEnv` into an exported function, and have `agentEnv` call it:

   ```ts
   /** Values for `passEnv` names, from the gateway's environment. `where` prefixes the errors. */
   export function passEnvValues(
     env: Env,
     passEnv: readonly string[],
     where: string,
   ): Record<string, string> {
     const out: Record<string, string> = {};
     for (const name of passEnv) {
       if (name.startsWith('MT_') || name.startsWith('LARK_')) {
         // The gateway's own configuration, and in the Lark case its identity. An
         // agent holding those can reconfigure or impersonate the gateway.
         throw new ConfigError(`${where} must not forward ${name}: it belongs to the gateway`);
       }
       const value = env[name];
       if (value === undefined || value === '') {
         throw new ConfigError(`${where} names ${name}, which is not set in the environment`);
       }
       out[name] = value;
     }
     return out;
   }
   ```

   `agentEnv` becomes `const out = passEnvValues(env, passEnv, 'agent.passEnv');` followed by its existing prefix loop and `return out;`. (The messages are unchanged for the gateway's block.)

8. **`reject` takes hints for where secrets and values belong**, so a role's file can point at the role's `.env` instead of the gateway's variables. `export` it, and add a fifth parameter:

   ```ts
     hints: { secret: string; env: string } = {
       secret:
         'Set it in the environment instead (LARK_APP_SECRET for the app secret, ' +
         'MT_AGENT_ENV_* for the agent, or name it in agent.passEnv).',
       env: 'List the variable names in agent.passEnv, or set MT_AGENT_ENV_<NAME> in the environment.',
     },
   ```

   In the credential message, replace the three concatenated pieces after `must not hold one. ` with `${hints.secret}`; in the `env` message, replace the sentence after `would put values in the file. ` with `${hints.env}`. The gateway's messages are unchanged.

- [ ] **Step 3.4: Run the config tests** — `npx vitest run --project unit tests/config.test.ts` → all pass, including the 7 new ones.

Where to put the new functions: `legacyAgent` and `checkCommand` directly after `loadConfig`; `stringMap` directly before `strings`.

- [ ] **Step 3.5: Typecheck** — `npm run typecheck`. Expected errors **only** in `src/index.ts`, where `config.agent` is now possibly undefined. Leave them: Task 7 replaces that code. (The full suite still runs — vitest does not typecheck.)

- [ ] **Step 3.6: Full suite** — `npm test 2>&1 | tail -4` → `Tests  420 passed (420)` (401 + 3 + 9 + 7).

- [ ] **Step 3.7: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "Read named workspaces, and let a role directory supply the default agent"
```

- [ ] **Step 3.8: Variables alone, and no command (added after review).** With `roles/default/` present and only, say, `MT_AGENT_ARGS` or an `MT_AGENT_ENV_*` set, the error above advised setting `MT_AGENT_COMMAND`, which only leads to the "both define the role default" error. So when there is no `agent:` block in the file, at least one `MT_AGENT_*` variable is set, and `MT_AGENT_COMMAND` is not, `loadConfig` names the variables that are set (names only, never values) and gives both ways out: `MT_AGENT_ARGS, MT_AGENT_ENV_TOKEN are set but MT_AGENT_COMMAND is not. MT_AGENT_* variables define the role default: if <home>/roles/default exists, unset them; otherwise also set MT_AGENT_COMMAND`. It stays in `loadConfig` rather than `loadTeam`, so `loadConfig` never returns a half-built agent. An `agent:` block without a command keeps the `agent.command` message. The "treats an agent variable alone" test now expects the new message, and a test that the file-block message is unchanged is added: the suite goes to `Tests  421 passed (421)`. Commit: `Say which MT_AGENT_ variables define the role default when no command is set`.

---

### Task 4: Workspaces on disk

**Files:** Create `src/workspaces.ts`, `tests/workspaces.test.ts`.

- [ ] **Step 4.1: Write the failing tests** — create `tests/workspaces.test.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspaces } from '../src/workspaces.js';

/**
 * A workspace is where an unsupervised agent writes, so the rules are about what
 * must never end up inside one: the gateway's home (every role's secrets, the
 * database) -- and about two names never sharing one checkout, which would give
 * the one-run-per-workspace limit two counters for one directory.
 */
let root: string;
let home: string;
let db: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-ws-')));
  home = join(root, 'home');
  mkdirSync(home);
  db = join(home, 'gateway.db');
  writeFileSync(db, '');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function dir(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function resolved(declared: Record<string, string>): ReadonlyMap<string, string> {
  const r = resolveWorkspaces(declared, home, db);
  if ('error' in r) throw new Error(r.error);
  return r.workspaces;
}

function refused(declared: Record<string, string>): string {
  const r = resolveWorkspaces(declared, home, db);
  if (!('error' in r)) throw new Error('expected an error');
  return r.error;
}

describe('resolveWorkspaces', () => {
  it('resolves each workspace to its real path', () => {
    const a = dir('repos', 'a');
    expect([...resolved({ default: a }).entries()]).toEqual([['default', a]]);
  });

  it('requires a workspace named default', () => {
    expect(refused({ docs: dir('d') })).toMatch(/workspace named default is required/);
  });

  it('refuses a name outside the grammar', () => {
    expect(refused({ default: dir('a'), '../roles': dir('b') })).toMatch(/must be lowercase/);
  });

  it('refuses a relative path', () => {
    expect(refused({ default: 'repos/a' })).toMatch(/must be an absolute path/);
  });

  it('refuses a directory that does not exist', () => {
    expect(refused({ default: join(root, 'missing') })).toMatch(/does not exist or is not a directory/);
  });

  it("refuses a workspace that is or contains the gateway's home", () => {
    expect(refused({ default: root })).toMatch(/contains the gateway's home/);
    expect(refused({ default: home })).toMatch(/contains the gateway's home/);
  });

  it('refuses a workspace containing a home that does not exist yet, through a symlink', () => {
    // A fresh install: the home is not created until the gateway starts. The
    // workspace is reached through a symlink, so only a real-path comparison sees it.
    const real = dir('real');
    const link = join(root, 'link');
    symlinkSync(real, link);
    const r = resolveWorkspaces({ default: link }, join(link, 'not-yet-home'), join(link, 'not-yet-home', 'gateway.db'));
    expect('error' in r && r.error).toMatch(/contains the gateway's home/);
  });

  it('refuses a workspace that contains the database, wherever it is', () => {
    const elsewhere = dir('data');
    const otherDb = join(elsewhere, 'gateway.db');
    writeFileSync(otherDb, '');
    const r = resolveWorkspaces({ default: elsewhere }, home, otherDb);
    expect('error' in r && r.error).toMatch(/contains the gateway's database/);
  });

  it('allows only workspaces/<name> inside the home', () => {
    const managed = join(home, 'workspaces', 'docs');
    mkdirSync(managed, { recursive: true });
    expect(resolved({ default: dir('a'), docs: managed }).get('docs')).toBe(managed);
    const roles = join(home, 'roles');
    mkdirSync(roles);
    expect(refused({ default: roles })).toMatch(/inside the gateway's home, only/);
  });

  it('refuses two names for one directory', () => {
    const a = dir('a');
    expect(refused({ default: a, other: a })).toMatch(/are the same directory/);
  });

  it('refuses one workspace inside another', () => {
    expect(refused({ default: dir('a'), inner: dir('a', 'inner') })).toMatch(/are nested/);
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail** — `npx vitest run --project unit tests/workspaces.test.ts` → FAIL, `../src/workspaces.js` cannot be resolved.

- [ ] **Step 4.3: Write `src/workspaces.ts`:**

```ts
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { nameProblem } from './names.js';

/**
 * Checking the declared workspaces against the disk (spec §2.3).
 *
 * A workspace is a directory an unsupervised agent writes in, so it must never
 * hold the gateway's home -- every role's `.env`, the database -- and two names
 * must never share one checkout, or the one-run-per-workspace limit would count
 * the same directory twice. Every rule here is checked at startup, so a typo
 * fails the start instead of the first task.
 *
 * Returns an error rather than throwing, so it needs nothing from `config.ts`.
 */

export type WorkspacesResult = { workspaces: ReadonlyMap<string, string> } | { error: string };

export function resolveWorkspaces(
  declared: Readonly<Record<string, string>>,
  home: string,
  dbPath: string,
): WorkspacesResult {
  if (declared['default'] === undefined) {
    return { error: 'a workspace named default is required: chat sessions and the role default use it' };
  }
  const homeReal = realOrResolved(home);
  const dbReal = realOrResolved(dbPath);
  const out = new Map<string, string>();

  for (const name of Object.keys(declared).sort()) {
    const path = declared[name] ?? '';
    const problem = nameProblem('workspace', name);
    if (problem !== undefined) return { error: problem };
    if (!isAbsolute(path)) return { error: `workspace ${name}: ${JSON.stringify(path)} must be an absolute path` };
    if (!isDirectory(path)) return { error: `workspace ${name}: ${path} does not exist or is not a directory` };
    const real = realpathSync(path);

    if (within(homeReal, real)) {
      return { error: `workspace ${name}: ${real} contains the gateway's home ${homeReal}, which holds every role's secrets` };
    }
    if (within(dbReal, real)) {
      return { error: `workspace ${name}: ${real} contains the gateway's database ${dbReal}` };
    }
    const managed = join(homeReal, 'workspaces', name);
    if (within(real, homeReal) && real !== managed) {
      return { error: `workspace ${name}: inside the gateway's home, only ${managed} may be a workspace` };
    }
    for (const [other, otherReal] of out) {
      if (real === otherReal) {
        return { error: `workspaces ${other} and ${name} are the same directory (${real})` };
      }
      if (within(real, otherReal) || within(otherReal, real)) {
        return { error: `workspaces ${other} and ${name} are nested (${otherReal}, ${real}): a workspace may not contain another` };
      }
    }
    out.set(name, real);
  }
  return { workspaces: out };
}

/** True when `inner` is `outer` or lies inside it. */
function within(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The real path, even for a path that does not exist yet.
 *
 * On a fresh install the home and the database do not exist, so they cannot be
 * realpath'd directly -- but the workspace can, and comparing a resolved path
 * with a real one misses containment through any symlink (on macOS, `/tmp` is
 * `/private/tmp`). So the nearest existing ancestor is realpath'd and the rest
 * of the path appended to it.
 */
function realOrResolved(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}
```

- [ ] **Step 4.4: Run the tests** → `Tests  11 passed (11)`.

- [ ] **Step 4.5: Commit**

```bash
git add src/workspaces.ts tests/workspaces.test.ts
git commit -m "Check workspaces on disk, and keep the gateway's home out of every one"
```

---

### Task 5: One role directory — `config.yaml`

**Files:** Create `src/roles.ts`, `tests/roles.test.ts`.

- [ ] **Step 5.1: Write the failing tests** — create `tests/roles.test.ts`:

```ts
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverRoles, loadRoleDir } from '../src/roles.js';

/**
 * A role is a self-contained directory: its coding agent, its instructions,
 * its skills, its own secrets. Everything wrong with one is found at startup,
 * when it is a line to fix, not at the first claim, when it strands a task.
 */
let rolesDir: string;
const WORKSPACES = new Set(['default', 'docs']);

beforeEach(() => {
  rolesDir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-roles-')));
});

afterEach(() => rmSync(rolesDir, { recursive: true, force: true }));

const AGENT = 'agent:\n  driver: structured-cli\n  command: bytesec\n  args: [run]\n  unsupervised: true\n';

function role(name: string, config: string, files: Record<string, string> = {}): string {
  const dir = join(rolesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), config);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function load(name: string, env: Record<string, string> = {}) {
  return loadRoleDir(name, join(rolesDir, name), env, WORKSPACES);
}

describe('discoverRoles', () => {
  it('finds role directories, ignores dot-entries, and reports anything else', () => {
    role('implementer', AGENT);
    role('reviewer', AGENT);
    mkdirSync(join(rolesDir, '.git'));
    writeFileSync(join(rolesDir, 'README.md'), 'notes');
    mkdirSync(join(rolesDir, 'Bad_Name'));
    const found = discoverRoles(rolesDir);
    expect(found.names).toEqual(['implementer', 'reviewer']);
    expect(found.notes).toHaveLength(2);
    expect(found.notes.join('\n')).toContain('README.md');
    expect(found.notes.join('\n')).toContain('Bad_Name');
  });

  it('finds nothing when there is no roles directory', () => {
    expect(discoverRoles(join(rolesDir, 'absent'))).toEqual({ names: [], notes: [] });
  });

  it('refuses a role named like a driver', () => {
    role('acp', AGENT);
    expect(() => discoverRoles(rolesDir)).toThrow(/reserved/);
  });
});

describe('loadRoleDir: config.yaml', () => {
  it('reads the agent, the workspace and the description', () => {
    role('implementer', `description: Writes code\nworkspace: docs\n${AGENT}`);
    const { role: r } = load('implementer');
    expect(r.description).toBe('Writes code');
    expect(r.workspace).toBe('docs');
    expect(r.agent.driver).toBe('structured-cli');
    expect(r.agent.command).toBe('bytesec');
    expect(r.agent.args).toEqual(['run']);
    expect(r.source).toBe('directory');
  });

  it('requires a config.yaml', () => {
    mkdirSync(join(rolesDir, 'empty'));
    expect(() => load('empty')).toThrow(/cannot read .*config\.yaml/);
  });

  it('refuses an unknown setting', () => {
    role('r', `${AGENT}colour: blue\n`);
    expect(() => load('r')).toThrow(/unknown setting colour/);
  });

  it("refuses a credential in the file, pointing at the role's .env", () => {
    role('r', `${AGENT}  apiToken: abc\n`);
    expect(() => load('r')).toThrow(/looks like a credential.*role's \.env/);
  });

  it('refuses a tools policy no available agent can enforce', () => {
    role('r', `${AGENT}tools:\n  deny: [deploy]\n`);
    expect(() => load('r')).toThrow(/declares a tools policy, but its agent's driver \(structured-cli\) cannot enforce one/);
  });

  it('refuses a workspace that is not configured', () => {
    role('r', `workspace: nowhere\n${AGENT}`);
    expect(() => load('r')).toThrow(/workspace "nowhere" is not configured/);
  });

  it('applies the supervision rule to the role agent', () => {
    role('r', 'agent:\n  driver: structured-cli\n  command: bytesec\n');
    expect(() => load('r')).toThrow(/has no way to ask for permission/);
  });

  it('requires every passEnv name to be set', () => {
    role('r', `${AGENT}  passEnv: [GH_TOKEN]\n`);
    expect(() => load('r')).toThrow(/names GH_TOKEN, which is not set/);
    expect(load('r', { GH_TOKEN: 'ghp_x' }).role.agent.env).toEqual({ GH_TOKEN: 'ghp_x' });
  });
});

describe('loadRoleDir: .env, role.md, skills', () => {
  function withEnv(text: string, mode = 0o600): void {
    const dir = role('r', `${AGENT}  passEnv: [GH_TOKEN]\n`);
    writeFileSync(join(dir, '.env'), text);
    chmodSync(join(dir, '.env'), mode);
  }

  it("gives the role's agent its .env values, and records them as secrets", () => {
    withEnv('API_KEY=sk-role\n');
    const { role: r } = load('r', { GH_TOKEN: 'ghp_x' });
    expect(r.agent.env).toEqual({ GH_TOKEN: 'ghp_x', API_KEY: 'sk-role' });
    expect([...r.secretValues].sort()).toEqual(['ghp_x', 'sk-role']);
  });

  it('refuses a .env other users can read, and leaves its mode alone', () => {
    withEnv('API_KEY=sk-role\n', 0o644);
    expect(() => load('r', { GH_TOKEN: 'ghp_x' })).toThrow(/must be 0600/);
  });

  it('refuses a .env that is a symlink', () => {
    const dir = role('r', AGENT);
    writeFileSync(join(rolesDir, 'elsewhere'), 'A=1\n');
    symlinkSync(join(rolesDir, 'elsewhere'), join(dir, '.env'));
    expect(() => load('r')).toThrow(/is a symlink/);
  });

  it("refuses the gateway's own names and PATH", () => {
    for (const line of ['MT_DB=x', 'LARK_APP_SECRET=x', 'PATH=/bin']) {
      withEnv(`${line}\n`);
      expect(() => load('r', { GH_TOKEN: 'ghp_x' })).toThrow(/may not be set in a role's \.env/);
      rmSync(join(rolesDir, 'r'), { recursive: true, force: true });
    }
  });

  it('refuses a variable set in .env and named in passEnv', () => {
    withEnv('GH_TOKEN=from-file\n');
    expect(() => load('r', { GH_TOKEN: 'ghp_x' })).toThrow(/GH_TOKEN is set in \.env and named in agent\.passEnv/);
  });

  it('accepts a role without a .env', () => {
    role('r', AGENT);
    expect(load('r').role.agent.env).toEqual({});
  });

  it('records role.md when it is there', () => {
    role('with', AGENT, { 'role.md': 'You change code.' });
    role('without', AGENT);
    expect(load('with').role.roleMdPath).toBe(join(rolesDir, 'with', 'role.md'));
    expect(load('without').role.roleMdPath).toBeUndefined();
  });

  it('reads each skill directory from its SKILL.md front matter', () => {
    role('r', AGENT, {
      'skills/testing/SKILL.md': '---\nname: testing\ndescription: How to run the tests\n---\nRun npm test.\n',
      'skills/testing/references/ci.md': 'notes',
    });
    const dir = join(rolesDir, 'r', 'skills', 'testing');
    expect(load('r').role.skills).toEqual([
      { name: 'testing', description: 'How to run the tests', dir, path: join(dir, 'SKILL.md') },
    ]);
  });

  it('refuses a skill without front matter', () => {
    role('r', AGENT, { 'skills/bare/SKILL.md': 'just text' });
    expect(() => load('r')).toThrow(/must start with front matter/);
  });

  it('refuses a skill directory with no SKILL.md', () => {
    role('r', AGENT, { 'skills/empty/notes.md': 'x' });
    expect(() => load('r')).toThrow(/needs a SKILL\.md/);
  });

  it("refuses a skill whose name is not its directory's", () => {
    role('r', AGENT, { 'skills/testing/SKILL.md': '---\nname: other\ndescription: d\n---\n' });
    expect(() => load('r')).toThrow(/does not match its directory/);
  });

  it('reports a loose file in skills/ and ignores it', () => {
    role('r', AGENT, { 'skills/stray.md': 'x' });
    const loaded = load('r');
    expect(loaded.role.skills).toEqual([]);
    expect(loaded.notes.join('\n')).toContain('stray.md');
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail** — `npx vitest run --project unit tests/roles.test.ts` → FAIL, `../src/roles.js` cannot be resolved.

- [ ] **Step 5.3: Write `src/roles.ts`:**

```ts
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type AgentConfig,
  ConfigError,
  type Env,
  bool,
  checkCommand,
  driverOf,
  passEnvValues,
  reject,
  requireSupervisionMatch,
  section,
  shellWords,
  str,
  strings,
  subsection,
} from './config.js';
import type { KnownDriver } from './driver/registry.js';
import { parseEnvFile } from './dotenv.js';
import { isReservedRoleName, nameProblem } from './names.js';

/**
 * Roles: who does a kind of work, and how it is run (spec §2.1–§2.2, §2.5).
 *
 * A role is a directory under `$MT_HOME/roles/`: `config.yaml` naming its coding
 * agent, an optional `role.md` of standing instructions, optional `skills/`, and
 * an optional `.env` for its own secrets. Everything wrong with one is found
 * here, at startup.
 */

export interface Skill {
  name: string;
  description: string;
  /** The skill's directory, `skills/<name>/`: its SKILL.md and anything beside it. */
  dir: string;
  /** Its SKILL.md. */
  path: string;
}

export interface Role {
  name: string;
  /** A role directory, or the gateway's `agent:` block standing in for `default`. */
  source: 'directory' | 'agent-block';
  dir: string | undefined;
  description: string | undefined;
  /** A workspace name the role always works in, or undefined (spec §2.3). */
  workspace: string | undefined;
  agent: AgentConfig;
  /** The path of `role.md` if the role has one; its contents are read at each claim. */
  roleMdPath: string | undefined;
  skills: readonly Skill[];
  /** Every value this role's agent is given from a secret source, for masking (spec §10.1). */
  secretValues: readonly string[];
}

/** Drivers that can enforce a role's tool policy. None yet (spec §2.2). */
const TOOL_POLICY_DRIVERS: readonly KnownDriver[] = [];

const HINTS = {
  secret: "Put it in the role's .env instead.",
  env: "Put the values in the role's .env, or name them in agent.passEnv.",
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface Discovered {
  names: string[];
  notes: string[];
}

/**
 * The role directories under `rolesDir`.
 *
 * Dot-entries are ignored, so the directory can be under version control.
 * Anything else that is not a valid role -- a file, a badly named directory --
 * is reported once and ignored. A directory named like a driver is an error.
 *
 * Symlinks are not followed: a symlinked role directory is reported as not a
 * directory, and a symlinked `role.md` or `.env` is refused. That is stricter
 * than the spec requires, deliberately -- a role is meant to be self-contained,
 * and a link is how it quietly stops being.
 */
export function discoverRoles(rolesDir: string): Discovered {
  let entries;
  try {
    entries = readdirSync(rolesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { names: [], notes: [] };
    throw new ConfigError(`cannot read ${rolesDir}: ${(err as Error).message}`);
  }

  const names: string[] = [];
  const notes: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const where = join(rolesDir, entry.name);
    if (!entry.isDirectory()) {
      notes.push(`ignoring ${where}: not a directory, so not a role`);
      continue;
    }
    if (isReservedRoleName(entry.name)) {
      throw new ConfigError(`${where}: role name ${JSON.stringify(entry.name)} is reserved: it is a driver id`);
    }
    const problem = nameProblem('role', entry.name);
    if (problem !== undefined) {
      notes.push(`ignoring ${where}: ${problem}`);
      continue;
    }
    names.push(entry.name);
  }
  return { names, notes };
}

// ---------------------------------------------------------------------------
// One role
// ---------------------------------------------------------------------------

export function loadRoleDir(
  name: string,
  dir: string,
  env: Env,
  workspaceNames: ReadonlySet<string>,
): { role: Role; notes: string[] } {
  const configPath = join(dir, 'config.yaml');
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new ConfigError(`role ${name}: cannot read ${configPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${configPath} is not valid YAML: ${(err as Error).message}`);
  }
  const root = section(configPath, '', parsed ?? {});
  const agentRaw = subsection(configPath, root, 'agent');
  reject(configPath, '', root, ['description', 'workspace', 'tools', 'agent'], HINTS);
  reject(
    configPath,
    'agent',
    agentRaw,
    ['driver', 'command', 'args', 'unsupervised', 'passEnv', 'readOnlyTools', 'maskExempt'],
    HINTS,
  );
  if (root['agent'] === undefined || root['agent'] === null) {
    throw new ConfigError(`${configPath}: agent is required`);
  }

  const workspace = str(configPath, 'workspace', root['workspace']);
  if (workspace !== undefined && !workspaceNames.has(workspace)) {
    throw new ConfigError(
      `${configPath}: workspace ${JSON.stringify(workspace)} is not configured (known: ${[...workspaceNames].join(', ')})`,
    );
  }

  const driver = driverOf(str(configPath, 'agent.driver', agentRaw['driver']) ?? 'acp');
  if (root['tools'] !== undefined && root['tools'] !== null && !TOOL_POLICY_DRIVERS.includes(driver)) {
    // Silently accepting it would leave a role believed to be restricted that is not.
    throw new ConfigError(
      `${configPath}: role ${name} declares a tools policy, but its agent's driver (${driver}) ` +
        'cannot enforce one. Remove tools, or use an agent that can enforce it.',
    );
  }
  const command = str(configPath, 'agent.command', agentRaw['command']);
  if (command === undefined) throw new ConfigError(`${configPath}: agent.command is required`);
  checkCommand(command);
  const args = Array.isArray(agentRaw['args'])
    ? strings(configPath, 'agent.args', agentRaw['args'])
    : shellWords(str(configPath, 'agent.args', agentRaw['args']) ?? '');
  const unsupervised = bool(configPath, 'agent.unsupervised', agentRaw['unsupervised']) ?? false;
  requireSupervisionMatch(driver, unsupervised);

  const passEnv = strings(configPath, 'agent.passEnv', agentRaw['passEnv']);
  const fromGateway = passEnvValues(env, passEnv, `${configPath}: agent.passEnv`);
  const fromFile = readRoleEnv(dir);
  for (const key of Object.keys(fromFile)) {
    if (passEnv.includes(key)) {
      throw new ConfigError(`role ${name}: ${key} is set in .env and named in agent.passEnv; keep one`);
    }
  }

  const { skills, notes } = readSkills(dir);
  return {
    role: {
      name,
      source: 'directory',
      dir,
      description: str(configPath, 'description', root['description']),
      workspace,
      agent: {
        driver,
        command,
        args,
        env: { ...fromGateway, ...fromFile },
        unsupervised,
        passEnv,
        readOnlyTools: strings(configPath, 'agent.readOnlyTools', agentRaw['readOnlyTools']),
        maskExempt: strings(configPath, 'agent.maskExempt', agentRaw['maskExempt']),
      },
      roleMdPath: readRoleMd(dir),
      skills,
      // Empty values are not secrets, and masking an empty string would mangle everything.
      secretValues: [...Object.values(fromGateway), ...Object.values(fromFile)].filter((v) => v !== ''),
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// .env, role.md, skills
// ---------------------------------------------------------------------------

/**
 * A role's own secrets (spec §2.5). The one file the gateway reads secrets from,
 * so it is checked at every point where it could leak or travel: it must be a
 * regular file (a symlink could point anywhere), owned by the gateway's user,
 * and readable by nobody else. A loose mode is refused, not fixed: a file that
 * was readable may already have been read, and tightening it quietly hides that.
 */
function readRoleEnv(dir: string): Record<string, string> {
  const path = join(dir, '.env');
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError(`cannot inspect ${path}: ${(err as Error).message}`);
  }
  if (stat.isSymbolicLink()) {
    throw new ConfigError(`${path} is a symlink; a role's .env must be a regular file, so it cannot point anywhere else`);
  }
  if (!stat.isFile()) throw new ConfigError(`${path} is not a regular file`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new ConfigError(`${path} is owned by another user; it must belong to the user the gateway runs as`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new ConfigError(
      `${path} can be read or written by other users (mode ${(stat.mode & 0o777).toString(8)}); ` +
        'it must be 0600. The gateway does not change it itself: a file that was readable may already have been read.',
    );
  }

  const parsed = parseEnvFile(readFileSync(path, 'utf8'), path);
  if ('error' in parsed) throw new ConfigError(parsed.error);
  for (const key of Object.keys(parsed.values)) {
    if (key.startsWith('MT_') || key.startsWith('LARK_')) {
      throw new ConfigError(`${path}: ${key} may not be set in a role's .env: it belongs to the gateway`);
    }
    if (key === 'PATH') {
      throw new ConfigError(`${path}: PATH may not be set in a role's .env: the gateway sets it for every run`);
    }
  }
  return parsed.values;
}

/** `role.md` is optional; present, it must be a readable regular file. */
function readRoleMd(dir: string): string | undefined {
  const path = join(dir, 'role.md');
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(`cannot inspect ${path}: ${(err as Error).message}`);
  }
  if (!stat.isFile()) throw new ConfigError(`${path} is not a regular file`);
  try {
    readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`${path} cannot be read: ${(err as Error).message}`);
  }
  return path;
}

/**
 * Skills: each `skills/<name>/` directory holding a `SKILL.md` whose front matter
 * gives a `name` (its directory's) and a one-line `description`, with anything else
 * the skill needs beside it -- the format bytesec agent packages and Claude Code
 * both use, so a skill works with either and can be rendered natively later
 * (spec §2.2, plan R). Anything else in `skills/` is reported and ignored.
 */
function readSkills(dir: string): { skills: Skill[]; notes: string[] } {
  const skillsDir = join(dir, 'skills');
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { skills: [], notes: [] };
    throw new ConfigError(`cannot read ${skillsDir}: ${(err as Error).message}`);
  }

  const skills: Skill[] = [];
  const notes: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const dir = join(skillsDir, entry.name);
    if (!entry.isDirectory()) {
      notes.push(`ignoring ${dir}: a skill is a directory holding a SKILL.md`);
      continue;
    }
    const path = join(dir, 'SKILL.md');
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ConfigError(`${dir}: a skill directory needs a SKILL.md`);
      }
      throw new ConfigError(`${path} cannot be read: ${(err as Error).message}`);
    }
    const matter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    if (matter === undefined) {
      throw new ConfigError(`${path}: a skill must start with front matter (--- name: … description: … ---)`);
    }
    let fields: unknown;
    try {
      fields = parseYaml(matter);
    } catch (err) {
      throw new ConfigError(`${path}: its front matter is not valid YAML: ${(err as Error).message}`);
    }
    const meta = section(path, 'front matter', fields ?? {});
    const name = str(path, 'name', meta['name']);
    const description = str(path, 'description', meta['description']);
    if (name === undefined || description === undefined) {
      throw new ConfigError(`${path}: its front matter needs a name and a description`);
    }
    if (name !== entry.name) {
      throw new ConfigError(
        `${path}: its name ${JSON.stringify(name)} does not match its directory ${JSON.stringify(entry.name)}`,
      );
    }
    skills.push({ name, description, dir, path });
  }
  return { skills, notes };
}
```

- [ ] **Step 5.4: Run the tests** → `npx vitest run --project unit tests/roles.test.ts` → `Tests  23 passed (23)`.

- [ ] **Step 5.5: Full suite** — `npm test 2>&1 | tail -4` → `Tests  455 passed (455)` (421 + 11 workspaces + 23 roles).

- [ ] **Step 5.6: Commit**

```bash
git add src/roles.ts tests/roles.test.ts
git commit -m "Load a role directory: its agent, instructions, skills and own secrets"
```

---

### Task 6: The team — roles, workspaces, and the role default

**Files:** Create `src/team.ts`, `tests/team.test.ts`.

- [ ] **Step 6.1: Write the failing tests** — create `tests/team.test.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadTeam } from '../src/team.js';

/**
 * The role default runs chat sessions, so there must be exactly one source for
 * it: a roles/default directory, or the gateway's agent: block. Both would be a
 * silent override -- a deployment running a command nobody can find in its
 * config -- and neither would leave chat with nothing to run.
 */
let root: string;
let home: string;
let workspace: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-team-')));
  home = join(root, 'home');
  workspace = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    MT_HOME: home,
    MT_WORKSPACE: workspace,
    MT_OWNER_OPEN_ID: 'ou_owner',
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: 'claude-agent-acp',
    ...extra,
  };
}

function teamFor(e: Record<string, string | undefined>) {
  return loadTeam(loadConfig(e, () => undefined), e);
}

function roleDir(name: string, config: string): void {
  const dir = join(home, 'roles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), config);
}

const ROLE_AGENT = 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n';

describe('loadTeam', () => {
  it("makes the gateway's agent block the role default when there is no roles/default", () => {
    const team = teamFor(env());
    const role = team.roles.get('default');
    expect(role?.source).toBe('agent-block');
    expect(role?.agent.command).toBe('claude-agent-acp');
    expect(team.workspaces.get('default')).toBe(workspace);
  });

  it('uses roles/default when it exists and nothing else defines the default', () => {
    roleDir('default', ROLE_AGENT);
    const team = teamFor(env({ MT_AGENT_COMMAND: undefined }));
    expect(team.roles.get('default')?.source).toBe('directory');
    expect(team.roles.get('default')?.agent.command).toBe('bytesec');
  });

  it('refuses a role default defined twice', () => {
    roleDir('default', ROLE_AGENT);
    expect(() => teamFor(env())).toThrow(/define the role default; keep one/);
  });

  it('refuses to start with no role default at all', () => {
    expect(() => teamFor(env({ MT_AGENT_COMMAND: undefined }))).toThrow(/there is no role default/);
  });

  it('loads other roles beside the default, and passes on what it ignored', () => {
    roleDir('reviewer', ROLE_AGENT);
    writeFileSync(join(home, 'roles', 'notes.txt'), 'x');
    const team = teamFor(env());
    expect([...team.roles.keys()].sort()).toEqual(['default', 'reviewer']);
    expect(team.notes.some((n) => n.includes('notes.txt'))).toBe(true);
  });

  it('refuses a workspace that breaks the rules, before reading any role', () => {
    expect(() => teamFor(env({ MT_WORKSPACE: home }))).toThrow(/contains the gateway's home/);
  });
});
```

- [ ] **Step 6.2: Run them to verify they fail** — `npx vitest run --project unit tests/team.test.ts` → FAIL, `../src/team.js` cannot be resolved.

- [ ] **Step 6.3: Write `src/team.ts`:**

```ts
import { join } from 'node:path';
import { type AgentConfig, ConfigError, type Env, type GatewayConfig } from './config.js';
import { discoverRoles, loadRoleDir, type Role } from './roles.js';
import { resolveWorkspaces } from './workspaces.js';

/**
 * Everything about who works where, loaded and checked at startup.
 *
 * Separate from `loadConfig` because it reads the disk -- role directories,
 * `.env` files, workspace paths -- where `loadConfig` reads one file and the
 * environment. `mt role check` (plan B3) runs the same function.
 */

export interface Team {
  roles: ReadonlyMap<string, Role>;
  /** Workspace name → real path. */
  workspaces: ReadonlyMap<string, string>;
  /** For the operator's log: entries under roles/ that were ignored, and why. */
  notes: readonly string[];
}

export function loadTeam(config: GatewayConfig, env: Env): Team {
  const resolved = resolveWorkspaces(config.workspaces, config.home, config.dbPath);
  if ('error' in resolved) throw new ConfigError(resolved.error);
  const workspaceNames = new Set(resolved.workspaces.keys());

  const rolesDir = join(config.home, 'roles');
  const found = discoverRoles(rolesDir);
  const notes = [...found.notes];
  const roles = new Map<string, Role>();
  for (const name of found.names) {
    const loaded = loadRoleDir(name, join(rolesDir, name), env, workspaceNames);
    roles.set(name, loaded.role);
    notes.push(...loaded.notes);
  }

  // Exactly one source for the role default (spec §2.1).
  const defaultDir = join(rolesDir, 'default');
  if (roles.has('default') && config.agent !== undefined) {
    throw new ConfigError(
      `both ${defaultDir} and the agent: block (or MT_AGENT_* variables) define the role default; keep one`,
    );
  }
  if (!roles.has('default')) {
    if (config.agent === undefined) {
      throw new ConfigError(
        `there is no role default: create ${defaultDir}, or set agent: in the config file (or MT_AGENT_COMMAND)`,
      );
    }
    roles.set('default', roleFromAgentBlock(config.agent));
  }

  return { roles, workspaces: resolved.workspaces, notes };
}

/** The gateway's `agent:` block, standing in for a roles/default directory. */
function roleFromAgentBlock(agent: AgentConfig): Role {
  return {
    name: 'default',
    source: 'agent-block',
    dir: undefined,
    description: undefined,
    workspace: undefined,
    agent,
    roleMdPath: undefined,
    skills: [],
    secretValues: Object.values(agent.env).filter((v) => v !== ''),
  };
}
```

- [ ] **Step 6.4: Run the tests** → `Tests  6 passed (6)`.

- [ ] **Step 6.5: Commit**

```bash
git add src/team.ts tests/team.test.ts
git commit -m "Load the team: workspaces, role directories, and one role default"
```

---

### Task 7: Startup uses the team

**Files:** Modify `src/index.ts`.

- [ ] **Step 7.1: `createGateway` takes the team.** Change its signature to `export async function createGateway(config: GatewayConfig, team: Team): Promise<Gateway>` and add `import { loadTeam, type Team } from './team.js';`. At the top of the function body, after the existing `note(...)` that reports where the settings came from, add:

```ts
  for (const line of team.notes) note(line);
  // Until plan B2 gives each session its own role and workspace, every session
  // runs the role default's agent in the workspace named default.
  const defaultRole = team.roles.get('default');
  const defaultWorkspace = team.workspaces.get('default');
  if (defaultRole === undefined || defaultWorkspace === undefined) {
    throw new Error('loadTeam returned no role or workspace named default');
  }
  const agent = defaultRole.agent;
  note(
    `roles: ${[...team.roles.keys()].sort().join(', ')}; ` +
      `workspaces: ${[...team.workspaces.keys()].sort().join(', ')}`,
  );
```

- [ ] **Step 7.2: Replace the uses.** In the rest of `createGateway`, replace every `config.agent.` with `agent.` (the `command`/`args`/`env` passed to both drivers, `getDriver(config.agent.driver)`, `config.agent.unsupervised`), and both uses of `config.workspaceDir` (`allowedFileDirs` and `new PlainDirWorkspaces(...)`) with `defaultWorkspace`.

- [ ] **Step 7.3: `main` loads it.** In `main()`, replace

```ts
  const config = loadConfig();
  const gateway = await createGateway(config);
```

with

```ts
  const config = loadConfig();
  // Read and checked before anything starts: a broken role or workspace found
  // later strands work; found here it is a line in the startup error.
  const team = loadTeam(config, process.env);
  const gateway = await createGateway(config, team);
```

`loadTeam` throws `ConfigError`, which `main.ts` already turns into a one-line error and exit 78.

- [ ] **Step 7.4: Typecheck and full suite** — `npm run typecheck` → no output; `npm test 2>&1 | tail -4` → `Tests  461 passed (461)`.

- [ ] **Step 7.5: Commit**

```bash
git add src/index.ts
git commit -m "Load roles and workspaces at startup, and run the role default"
```

---

### Task 8: Document roles and workspaces

**Files:** Modify `README.md`.

- [ ] **Step 8.1: The credentials rule.** In the paragraph starting `**Credentials never go in the file.**`, replace that bold sentence with `**Credentials go in the environment, or in a role's \`.env\`.**`, and append to the end of the paragraph: `A role's \`.env\` is the one file secrets are read from: it must be \`0600\` and a regular file owned by the gateway's user. It may not set \`MT_*\`, \`LARK_*\` or \`PATH\`.` Rewrap the paragraph to the width of the text around it.

- [ ] **Step 8.2: A section on roles and workspaces**, placed after the paragraph that ends `exits 78.` (the "Everything is validated at boot" paragraph, after the configuration table) and before `### Chat commands` — not next to the credentials paragraph, which would put the whole configuration table under this heading:

````markdown
### Roles and workspaces

A **role** is who does a kind of work, and how it is run. Each is a directory under
`$MT_HOME/roles/`:

```
roles/implementer/
  config.yaml     # the coding agent, an optional workspace, an optional description
  role.md         # optional standing instructions
  skills/<name>/SKILL.md   # optional; front matter gives name and description
  .env            # optional; this role's own secrets, 0600
```

```yaml
# roles/implementer/config.yaml
description: Writes and changes code
workspace: default
agent:
  driver: structured-cli
  command: bytesec
  args: [run, -m, bytesec/modelhub-sg/gpt-5.6-sol]
  unsupervised: true
```

The role `default` runs chat sessions. It is `roles/default/` if that exists, and otherwise
the gateway's own `agent:` block (in the table above); having both, or neither, stops the
gateway at startup. Role and workspace names are lowercase letters, digits and `-`, start
with a letter, and are at most 40 characters; `acp` and `structured-cli` are reserved as
role names. A directory under `roles/` with a reserved name stops the gateway at startup;
one with any other invalid name is skipped, with a note in the startup log, and one whose
name starts with `.` is skipped silently. In this build every chat session runs the role
`default` in the workspace `default`; other roles are loaded and checked at startup, and
run once tasks arrive.

**Workspaces** are named directories in the config file:

```yaml
workspaces:
  default: /srv/repos/bytesec-agents
  docs: /srv/repos/docs
```

The single `workspace:` setting is the same as `workspaces.default`. A workspace must be an
absolute path to an existing directory; may not be or contain `$MT_HOME` or the database;
inside `$MT_HOME` only `workspaces/<name>` may be one; and no two workspaces may share or
nest in one directory. Everything here is checked at startup.

Once `roles/default/` exists, remove the `agent:` block **and** every `MT_AGENT_*` variable,
including `MT_AGENT_ENV_*`: any of them still counts as a second definition of the role
`default`, and the gateway will not start with two.
````

- [ ] **Step 8.3: Table rows.** In the configuration table:
  - after the `workspace` row, add: | `workspaces` | — | Named workspaces: `name: absolute-path`. Must include `default` (or use `workspace`). |
  - in the `agent.command` row, replace `Required.` with: Required unless `roles/default/` exists.
  - in the `workspace` row, replace `Required.` with: Required unless `workspaces` is set.
  - after the `agent.unsupervised` row, add: | `agent.readOnlyTools` | — | The agent's tool names that only read. Checked at startup but not used in this build; automatic retry of a failed run will use it. |
  - and: | `agent.maskExempt` | — | Variable names whose values are not secret. Checked at startup but not used in this build: nothing is masked yet. |

- [ ] **Step 8.3b: `config.example.yaml`.** After its `workspace:` setting, add a commented example:

```yaml
# Or several named workspaces; `default` is required, and replaces `workspace`:
# workspaces:
#   default: /srv/repos/main
#   docs: /srv/repos/docs
```

- [ ] **Step 8.4: Full suite** — `npm test 2>&1 | tail -4` → `Tests  461 passed (461)`.

- [ ] **Step 8.5: Commit**

```bash
git add README.md config.example.yaml
git commit -m "Document roles, workspaces, and where a role's secrets go"
```

---

### Task 9: Check against the live deployment (read-only)

- [ ] **Step 9.1:**

```bash
cd /Users/x/Develop/manus/prime-gateway-work
export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH
LARK_APP_SECRET=placeholder npx tsx -e "
import { loadConfig } from './src/config.ts';
import { loadTeam } from './src/team.ts';
const c = loadConfig();
const t = loadTeam(c, process.env);
for (const [n, r] of t.roles) console.log('role', n, r.source, r.agent.driver, r.agent.command);
for (const [n, p] of t.workspaces) console.log('workspace', n, p);
for (const note of t.notes) console.log('note', note);
"
```

Expected on this machine: `role default agent-block structured-cli bytesec`, `workspace default /Users/x/Develop/manus/bytesec-agents`, no notes (there is no `~/.manus-team/roles/`). It reads files only and opens no database.

- [ ] **Step 9.2: Report** — without merging.

---

## Done when

- `Tests  461 passed (461)` and `npm run typecheck` clean, under Node 22, in the worktree.
- Task 9 shows the live deployment loads as the role `default` from its `agent:` block, in workspace `default`.
- Nothing merged into the main checkout.
