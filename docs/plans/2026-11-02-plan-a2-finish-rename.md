# Plan A2 — Finish the rename: MT_* variables, ~/.manus-team, mt: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gateway reads its configuration from `MT_*` variables and lives in `~/.manus-team`, while a deployment still configured with `PGW_*` and `~/.prime-gateway` keeps working unchanged — with warnings that say what to rename.

**Architecture:** Two new pure modules run at the very start of `loadConfig`. `src/env-names.ts` turns the legacy `PGW_*` names into `MT_*` under the transition rules, so the rest of `config.ts` only ever reads `MT_*`. `src/home.ts` chooses the home directory, with the fallback to the old one. Neither throws — they return warnings and errors, and `loadConfig` turns errors into `ConfigError` — so they import nothing from `config.ts` and are tested without a filesystem. `GatewayConfig` gains `warnings`, which startup prints with its other operator notes.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext — relative imports end in `.js`), vitest.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §13 ("The rename"), and §12's row for plan A2.

---

## Ground rules

- **Work in the worktree `/Users/x/Develop/manus/prime-gateway-work`, on branch `full-rename`. Never edit the main checkout** (`/Users/x/Develop/manus/prime-gateway`): the live gateway runs there under `tsx watch`, and any source change in it restarts the gateway and kills its running turns.
- **The worktree has no `node_modules`.** Link the main checkout's once, before Task 1:
  ```bash
  cd /Users/x/Develop/manus/prime-gateway-work && ln -s ../prime-gateway/node_modules node_modules
  ```
  The link may show as untracked (`node_modules/` in `.gitignore` matches directories, and this is a
  symlink). That is harmless because every commit step names its files — **never `git add -A`**.
- **Node 22 for every command**, or ~170 unrelated tests fail on a native module:
  ```bash
  export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH
  ```
- **Baseline:** `npm test` → `Tests  399 passed (399)`; `npm run typecheck` → no output. If not, stop.
- **Commit messages:** no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text. Use the messages given.
- **Find edits by their text.** Line numbers are a guide, as of commit `6de85b1`.

## The rules being implemented (spec §13, condensed)

- **Legacy names:** exactly `HOME`, `CONFIG`, `DB`, `DOWNLOAD_DIR`, `SCHEMA_DIR`, `WORKSPACE`, `MAX_LIVE_SESSIONS`, `OWNER_OPEN_ID`, `ALLOW_TALK`, `ALLOW_OPERATE`, `ALLOW_CHATS`, `ALLOW_DM`, `ALLOW_MENTION_ALL`, `AGENT_COMMAND`, `AGENT_ARGS`, `AGENT_DRIVER`, `AGENT_UNSUPERVISED`, and the prefix `AGENT_ENV_*` — each read as `MT_<name>`, and also as `PGW_<name>`. Nothing else has a `PGW_` form.
- **"Set"** keeps each variable's existing meaning: blank is unset, except the three lists (`ALLOW_TALK`, `ALLOW_OPERATE`, `ALLOW_CHATS`), where an empty value is meaningful, and `AGENT_ENV_*`, where any defined value is passed through.
- **Only old set** → used, warning. **Both, equal** → warning to remove the old one. **Both, different** → error naming both variables, **never their values**. `AGENT_ENV_*` is reconciled **per suffix**, over the union of suffixes under either prefix.
- **Home:** `MT_HOME`/`PGW_HOME` set → that, no fallback. Neither set: only `~/.prime-gateway` exists → use it, warn with the move command; both `~/.manus-team` and `~/.prime-gateway` exist → error; otherwise `~/.manus-team`. Nothing is moved, nothing is created by the resolver.
- **`passEnv`** refuses `MT_*`, `PGW_*` and `LARK_*`.
- **Warnings** go to standard error at startup, never to a chat.

---

## File structure

| File | Responsibility |
|---|---|
| `src/env-names.ts` (create) | the legacy-name table and `normalizeLegacyEnv` |
| `tests/env-names.test.ts` (create) | the transition rules |
| `src/home.ts` (create) | `resolveHome`: which directory is the gateway's home |
| `tests/home.test.ts` (create) | the four home cases |
| `src/config.ts` (modify) | call both at the top of `loadConfig`; read `MT_*`; refuse both prefixes in `passEnv`; carry `warnings` |
| `tests/config.test.ts` (modify) | existing tests move to `MT_*`; new tests prove the legacy path end to end |
| `src/index.ts` (modify) | print `config.warnings` at startup |
| `src/identity.ts` (modify) | its comment, which still says the old names are kept |
| `README.md`, `config.example.yaml`, `docs/testing/durability.md` (modify) | the new names, and how to upgrade |

---

### Task 1: The legacy-name layer

**Files:**
- Create: `src/env-names.ts`
- Create: `tests/env-names.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `tests/env-names.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LEGACY_NAMES, normalizeLegacyEnv } from '../src/env-names.js';

/**
 * The rename keeps a running deployment working: every variable that existed
 * before it is still read under its old `PGW_` name, and the operator is told
 * what to rename. Two settings that disagree are refused rather than one
 * silently winning -- and the refusal names variables, never values, because
 * some of them are secrets.
 */
describe('normalizeLegacyEnv', () => {
  it('reads an old name as the new one, and says so', () => {
    const r = normalizeLegacyEnv({ PGW_WORKSPACE: '/srv/repo' });
    expect(r.env['MT_WORKSPACE']).toBe('/srv/repo');
    expect(r.env['PGW_WORKSPACE']).toBeUndefined();
    expect(r.warnings).toEqual(['PGW_WORKSPACE is deprecated: rename it to MT_WORKSPACE']);
    expect(r.conflicts).toEqual([]);
  });

  it('leaves a new name alone, with nothing to say', () => {
    const r = normalizeLegacyEnv({ MT_WORKSPACE: '/srv/repo' });
    expect(r.env['MT_WORKSPACE']).toBe('/srv/repo');
    expect(r.warnings).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it('accepts both names with the same value, and suggests removing the old one', () => {
    const r = normalizeLegacyEnv({ MT_DB: '/var/db', PGW_DB: '/var/db' });
    expect(r.env['MT_DB']).toBe('/var/db');
    expect(r.env['PGW_DB']).toBeUndefined();
    expect(r.warnings).toEqual(['PGW_DB has the same value as MT_DB: remove PGW_DB']);
    expect(r.conflicts).toEqual([]);
  });

  it('refuses both names with different values, naming the variables and not the values', () => {
    const r = normalizeLegacyEnv({ MT_DB: '/a/secret-path', PGW_DB: '/b/other-path' });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toContain('MT_DB');
    expect(r.conflicts[0]).toContain('PGW_DB');
    expect(r.conflicts[0]).not.toContain('/a/secret-path');
    expect(r.conflicts[0]).not.toContain('/b/other-path');
  });

  it('treats a blank value as unset for an ordinary variable', () => {
    const r = normalizeLegacyEnv({ MT_HOME: '  ', PGW_HOME: '/srv/home' });
    expect(r.env['MT_HOME']).toBe('/srv/home');
    expect(r.conflicts).toEqual([]);
  });

  it('treats an empty list as set, because it means "nobody but the owner"', () => {
    const r = normalizeLegacyEnv({ MT_ALLOW_TALK: '', PGW_ALLOW_TALK: 'ou_a' });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toContain('MT_ALLOW_TALK');
  });

  it('reconciles the agent environment one variable at a time', () => {
    const r = normalizeLegacyEnv({
      PGW_AGENT_ENV_FOO: 'f',
      MT_AGENT_ENV_BAR: 'b',
      PGW_AGENT_ENV_BAZ: '1',
      MT_AGENT_ENV_BAZ: '1',
    });
    expect(r.env['MT_AGENT_ENV_FOO']).toBe('f');
    expect(r.env['MT_AGENT_ENV_BAR']).toBe('b');
    expect(r.env['MT_AGENT_ENV_BAZ']).toBe('1');
    expect(r.env['PGW_AGENT_ENV_FOO']).toBeUndefined();
    expect(r.conflicts).toEqual([]);
  });

  it('refuses one agent variable set two ways, without printing either value', () => {
    const r = normalizeLegacyEnv({
      MT_AGENT_ENV_API_KEY: 'sk-new-secret',
      PGW_AGENT_ENV_API_KEY: 'sk-old-secret',
    });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toContain('MT_AGENT_ENV_API_KEY');
    expect(r.conflicts[0]).not.toContain('sk-new-secret');
    expect(r.conflicts[0]).not.toContain('sk-old-secret');
  });

  it('gives variables added after the rename no old name', () => {
    const r = normalizeLegacyEnv({ PGW_KANBAN_TOKEN: 't' });
    expect(r.env['MT_KANBAN_TOKEN']).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it('covers exactly the variables that existed before the rename', () => {
    expect([...LEGACY_NAMES].sort()).toEqual(
      [
        'AGENT_ARGS', 'AGENT_COMMAND', 'AGENT_DRIVER', 'AGENT_UNSUPERVISED',
        'ALLOW_CHATS', 'ALLOW_DM', 'ALLOW_MENTION_ALL', 'ALLOW_OPERATE', 'ALLOW_TALK',
        'CONFIG', 'DB', 'DOWNLOAD_DIR', 'HOME', 'MAX_LIVE_SESSIONS', 'OWNER_OPEN_ID',
        'SCHEMA_DIR', 'WORKSPACE',
      ].sort(),
    );
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail**

Run: `npx vitest run --project unit tests/env-names.test.ts`
Expected: FAIL because `../src/env-names.js` cannot be resolved.

- [ ] **Step 1.3: Write the module**

Create `src/env-names.ts`:

```ts
/**
 * Reading configuration written for the old name.
 *
 * The product was `prime-gateway`, and its variables were `PGW_*`. They are now
 * `MT_*`. A running deployment's environment still says `PGW_*`, so during the
 * transition each variable that existed before the rename is read under both
 * names, and the operator is told what to rename. After this runs, the rest of
 * the configuration reads `MT_*` only.
 *
 * Pure: it returns what it found instead of throwing, so it needs nothing from
 * `config.ts` and is tested without a process environment. See
 * docs/specs/2026-11-02-kanban-design.md §13.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export const NEW_PREFIX = 'MT_';
export const OLD_PREFIX = 'PGW_';
const AGENT_ENV = 'AGENT_ENV_';

/**
 * Every variable that existed before the rename, without its prefix.
 *
 * Exactly these. A variable added afterwards -- `MT_KANBAN_TOKEN`, say -- never
 * had a `PGW_` form, and accepting one would invent a second name for it.
 */
export const LEGACY_NAMES = [
  'HOME',
  'CONFIG',
  'DB',
  'DOWNLOAD_DIR',
  'SCHEMA_DIR',
  'WORKSPACE',
  'MAX_LIVE_SESSIONS',
  'OWNER_OPEN_ID',
  'ALLOW_TALK',
  'ALLOW_OPERATE',
  'ALLOW_CHATS',
  'ALLOW_DM',
  'ALLOW_MENTION_ALL',
  'AGENT_COMMAND',
  'AGENT_ARGS',
  'AGENT_DRIVER',
  'AGENT_UNSUPERVISED',
] as const;

/**
 * How a variable's reader decides it is set -- kept as it was, so the rename
 * changes no variable's meaning.
 *
 * - `text`: blank counts as unset (`envString` and the readers built on it).
 * - `defined`: any defined value counts, empty included -- the lists, where an
 *   empty value deliberately means "nobody but the owner", and the agent's
 *   environment, which is passed through as given.
 */
type Reading = 'text' | 'defined';

const DEFINED_NAMES: ReadonlySet<string> = new Set(['ALLOW_TALK', 'ALLOW_OPERATE', 'ALLOW_CHATS']);

export interface Normalized {
  /** The environment with every legacy name moved to its new name. */
  env: Env;
  /** For the operator: an old name was used, or is redundant. */
  warnings: string[];
  /** Both names set to different values. Each names the variables, never the values. */
  conflicts: string[];
}

function isSet(reading: Reading, value: string | undefined): value is string {
  if (value === undefined) return false;
  return reading === 'defined' || value.trim() !== '';
}

function sameValue(reading: Reading, a: string, b: string): boolean {
  return reading === 'defined' ? a === b : a.trim() === b.trim();
}

export function normalizeLegacyEnv(env: Env): Normalized {
  const out: Record<string, string | undefined> = { ...env };
  const warnings: string[] = [];
  const conflicts: string[] = [];

  const reconcile = (suffix: string, reading: Reading): void => {
    const newKey = `${NEW_PREFIX}${suffix}`;
    const oldKey = `${OLD_PREFIX}${suffix}`;
    const newValue = env[newKey];
    const oldValue = env[oldKey];
    if (!isSet(reading, oldValue)) return;

    // Whatever happens next, nothing downstream reads the old name.
    delete out[oldKey];

    if (!isSet(reading, newValue)) {
      out[newKey] = oldValue;
      warnings.push(`${oldKey} is deprecated: rename it to ${newKey}`);
    } else if (sameValue(reading, newValue, oldValue)) {
      warnings.push(`${oldKey} has the same value as ${newKey}: remove ${oldKey}`);
    } else {
      conflicts.push(`${newKey} and ${oldKey} are both set, to different values: keep only ${newKey}`);
    }
  };

  for (const name of LEGACY_NAMES) {
    reconcile(name, DEFINED_NAMES.has(name) ? 'defined' : 'text');
  }

  // The agent's environment is a family, one variable per suffix, so it is
  // reconciled per suffix -- over the suffixes set under either prefix.
  const suffixes = new Set<string>();
  for (const key of Object.keys(env)) {
    for (const prefix of [NEW_PREFIX, OLD_PREFIX]) {
      const family = `${prefix}${AGENT_ENV}`;
      if (key.startsWith(family) && key.length > family.length) {
        suffixes.add(key.slice(prefix.length));
      }
    }
  }
  for (const suffix of suffixes) reconcile(suffix, 'defined');

  return { env: out, warnings, conflicts };
}
```

- [ ] **Step 1.4: Run the tests to verify they pass**

Run: `npx vitest run --project unit tests/env-names.test.ts`
Expected: `Tests  10 passed (10)`.

- [ ] **Step 1.5: Commit**

```bash
git add src/env-names.ts tests/env-names.test.ts
git commit -m "Read the variables from before the rename under their new names"
```

---

### Task 2: Choosing the home

**Files:**
- Create: `src/home.ts`
- Create: `tests/home.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `tests/home.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveHome } from '../src/home.js';

const USER = '/home/op';
const NEW = '/home/op/.manus-team';
const OLD = '/home/op/.prime-gateway';

/** A filesystem in which exactly these paths exist. */
function only(...paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

/**
 * The home holds the configuration, the database and the secrets, so choosing
 * the wrong one is not a cosmetic mistake: a gateway that silently picked an
 * empty new home over a populated old one would start with every session and
 * binding apparently gone.
 */
describe('resolveHome', () => {
  it('uses an explicit home, and looks nowhere else', () => {
    const exists = (): boolean => {
      throw new Error('an explicit home must not be second-guessed');
    };
    expect(resolveHome({ MT_HOME: '/srv/mt' }, USER, exists)).toEqual({
      home: '/srv/mt',
      warnings: [],
    });
  });

  it('uses the new home on a fresh install', () => {
    expect(resolveHome({}, USER, only())).toEqual({ home: NEW, warnings: [] });
  });

  it('uses the new home once it is the only one', () => {
    expect(resolveHome({}, USER, only(NEW))).toEqual({ home: NEW, warnings: [] });
  });

  it('keeps using the old home until it is moved, and says how to move it', () => {
    const r = resolveHome({}, USER, only(OLD));
    if ('error' in r) throw new Error(r.error);
    expect(r.home).toBe(OLD);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(`mv ${OLD} ${NEW}`);
    expect(r.warnings[0]).toContain('PGW_');
    expect(r.warnings[0]).toContain('MT_');
  });

  it('refuses to choose when both homes exist', () => {
    const r = resolveHome({}, USER, only(NEW, OLD));
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toContain(NEW);
    expect(r.error).toContain(OLD);
    expect(r.error).toContain('MT_HOME');
  });
});
```

- [ ] **Step 2.2: Run them to verify they fail**

Run: `npx vitest run --project unit tests/home.test.ts`
Expected: FAIL because `../src/home.js` cannot be resolved.

- [ ] **Step 2.3: Write the module**

Create `src/home.ts`:

```ts
import { join } from 'node:path';
import type { Env } from './env-names.js';

/**
 * Which directory is the gateway's home.
 *
 * The home holds the config file, the database and its lock, the downloads, and
 * the roles, so every part of the gateway -- and every `mt` command -- has to
 * agree on it. This is the one place it is decided.
 *
 * Expects an environment already passed through `normalizeLegacyEnv`, so
 * `MT_HOME` here already includes a legacy `PGW_HOME`. Pure: the filesystem is a
 * parameter, nothing is created or moved, and an impossible choice is returned
 * rather than thrown. See docs/specs/2026-11-02-kanban-design.md §13.
 */

export const NEW_HOME = '.manus-team';
export const OLD_HOME = '.prime-gateway';

export type HomeResult = { home: string; warnings: string[] } | { error: string };

export function resolveHome(
  env: Env,
  userHome: string,
  exists: (path: string) => boolean,
): HomeResult {
  const explicit = env['MT_HOME']?.trim();
  if (explicit !== undefined && explicit !== '') return { home: explicit, warnings: [] };

  const fresh = join(userHome, NEW_HOME);
  const old = join(userHome, OLD_HOME);
  const hasFresh = exists(fresh);
  const hasOld = exists(old);

  if (hasFresh && hasOld) {
    // A second home appears before a move is finished -- an interrupted copy, a
    // directory made by hand, a tool that created `roles/` under it. Preferring
    // it would start the gateway on an empty database.
    return {
      error:
        `both ${fresh} and ${old} exist, so the gateway cannot tell which is its home. ` +
        'Merge or remove one, or set MT_HOME.',
    };
  }

  if (hasOld) {
    // Not moved automatically: moving a live database under a running process is
    // how a log loses its last writes.
    return {
      home: old,
      warnings: [
        `using ${old}, the home from before the rename. To move it, stop the gateway and run: ` +
          `mv ${old} ${fresh} -- and rename any PGW_* variables to MT_* in its environment.`,
      ],
    };
  }

  return { home: fresh, warnings: [] };
}
```

- [ ] **Step 2.4: Run the tests to verify they pass**

Run: `npx vitest run --project unit tests/home.test.ts`
Expected: `Tests  5 passed (5)`.

- [ ] **Step 2.5: Commit**

```bash
git add src/home.ts tests/home.test.ts
git commit -m "Choose the home in one place, falling back to the old one"
```

---

### Task 3: Configuration reads MT_*

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 3.1: Move the existing tests to the new names**

In `tests/config.test.ts`, replace every `PGW_` with `MT_` — including inside the error-message regexes (`/PGW_CONFIG points at …/` → `/MT_CONFIG points at …/`, `/agent\.passEnv, or set PGW_AGENT_ENV_/` → `MT_AGENT_ENV_`). Nothing else in the file changes in this step.

Run: `npx vitest run --project unit tests/config.test.ts`
Expected: FAIL — many tests, because `config.ts` still reads `PGW_*`. This is the red step for the rename itself.

- [ ] **Step 3.2: Add the end-to-end transition tests**

Append to `tests/config.test.ts`:

```ts
describe('loadConfig: the rename transition', () => {
  it('still reads a variable under its old name, and reports it', () => {
    const cfg = load({ PGW_WORKSPACE: '/srv/legacy' });
    expect(cfg.workspaceDir).toBe('/srv/legacy');
    expect(cfg.warnings).toContain('PGW_WORKSPACE is deprecated: rename it to MT_WORKSPACE');
  });

  it('refuses an old and a new variable that disagree', () => {
    expect(() => load({ MT_DB: '/a.db', PGW_DB: '/b.db' })).toThrow(/MT_DB and PGW_DB/);
  });

  it('passes an agent variable set under the old prefix', () => {
    expect(load({ PGW_AGENT_ENV_FOO: 'bar' }).agent.env['FOO']).toBe('bar');
  });

  it('refuses to forward either prefix through passEnv', () => {
    for (const name of ['MT_DB', 'PGW_DB', 'LARK_APP_SECRET']) {
      const file = yamlFile({ agent: { command: 'claude-agent-acp', passEnv: [name] } });
      expect(() => load({ [name]: 'x' }, file)).toThrow('belongs to the gateway');
    }
  });

  it('keeps using the old home until it is moved, with everything derived from it', () => {
    const cfg = loadConfig(
      { LARK_APP_SECRET: 'app-secret' },
      reader({ '/u/.prime-gateway/config.yaml': FULL_FILE }),
      (path) => path === '/u/.prime-gateway',
      '/u',
    );
    expect(cfg.configPath).toBe('/u/.prime-gateway/config.yaml');
    expect(cfg.dbPath).toBe('/u/.prime-gateway/gateway.db');
    expect(cfg.downloadDir).toBe('/u/.prime-gateway/downloads');
    expect(cfg.warnings.some((w) => w.includes('mv /u/.prime-gateway /u/.manus-team'))).toBe(true);
  });

  it('refuses to start when both homes exist', () => {
    expect(() =>
      loadConfig({ LARK_APP_SECRET: 'app-secret' }, reader({}), () => true, '/u'),
    ).toThrow(/both \/u\/\.manus-team and \/u\/\.prime-gateway exist/);
  });

  it('has nothing to report when only the new names are used', () => {
    expect(load().warnings).toEqual([]);
  });
});
```

(`load`, `reader`, `yamlFile`, `FULL_FILE` and `BASE` are the file's existing helpers. `BASE` now sets `MT_HOME`, which is why the other tests never consult the filesystem for the home.)

- [ ] **Step 3.3: Update `src/config.ts`**

1. **Imports**, at the top with the others:

   ```ts
   import { existsSync } from 'node:fs';
   import { normalizeLegacyEnv } from './env-names.js';
   import { resolveHome } from './home.js';
   ```

   (If `node:fs` is already imported for `readFileSync`, add `existsSync` to that import instead.)

2. **`GatewayConfig`** gains, as its last field:

   ```ts
     /**
      * For the operator, printed at startup: settings read under a name from before
      * the rename, or a home that has not been moved yet. Never shown in a chat.
      */
     warnings: readonly string[];
   ```

3. **The head of `loadConfig`.** Replace

   ```ts
   export function loadConfig(
     env: Env = process.env,
     readFile: FileReader = readIfPresent,
   ): GatewayConfig {
     const home = envString(env, 'PGW_HOME') ?? join(homedir(), '.prime-gateway');
   ```

   with

   ```ts
   export function loadConfig(
     rawEnv: Env = process.env,
     readFile: FileReader = readIfPresent,
     pathExists: (path: string) => boolean = existsSync,
     userHome: string = homedir(),
   ): GatewayConfig {
     // Names from before the rename first, so everything below reads MT_* only.
     const legacy = normalizeLegacyEnv(rawEnv);
     if (legacy.conflicts.length > 0) throw new ConfigError(legacy.conflicts.join('; '));
     const env = legacy.env;

     const chosen = resolveHome(env, userHome, pathExists);
     if ('error' in chosen) throw new ConfigError(chosen.error);
     const home = chosen.home;
   ```

4. **Every other `PGW_` in `src/config.ts` becomes `MT_`** — the `envString`/`envList`/`envFlag`/`envInteger` keys, the `fail(...)` and `ConfigError` message texts, the doc comments, and `AGENT_ENV_PREFIX = 'MT_AGENT_ENV_'` — **except** the `passEnv` check, which becomes:

   ```ts
       if (name.startsWith('MT_') || name.startsWith('PGW_') || name.startsWith('LARK_')) {
   ```

   and keeps its existing message.

5. **The returned object** gains, last:

   ```ts
       warnings: [...legacy.warnings, ...chosen.warnings],
   ```

- [ ] **Step 3.4: Run the config tests**

Run: `npx vitest run --project unit tests/config.test.ts`
Expected: all pass, including the 7 new ones.

- [ ] **Step 3.5: No old name left in config**

Run: `git grep -n "PGW_" -- src/config.ts`
Expected: exactly one line — the `passEnv` check.

- [ ] **Step 3.6: Full suite and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: `Tests  421 passed (421)` (399 + 10 + 5 + 7), no typecheck output. If another file constructs a `GatewayConfig` literal, typecheck names it: add `warnings: []` there.

- [ ] **Step 3.7: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "Read configuration from MT_* variables, and the old names during the transition"
```

---

### Task 4: Say it at startup

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 4.1: Print the warnings**

In `src/index.ts`, directly after the existing `note(...)` call that reports where the settings came from (`'no config file; settings from the environment alone'` / `settings from …`), add:

```ts
  // Names from before the rename, and a home not yet moved. Said once, at the top,
  // where an operator reading the log after an upgrade will look.
  for (const warning of config.warnings) note(`warning: ${warning}`);
```

- [ ] **Step 4.2: Full suite and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: `Tests  421 passed (421)`, no typecheck output.

- [ ] **Step 4.3: Commit**

```bash
git add src/index.ts
git commit -m "Report rename warnings when the gateway starts"
```

---

### Task 5: Docs under the new names

**Files:**
- Modify: `src/identity.ts`
- Modify: `README.md`
- Modify: `config.example.yaml`
- Modify: `docs/testing/durability.md`

- [ ] **Step 5.1: `src/identity.ts` comment.** Replace the doc comment above `PRODUCT_NAME` with:

```ts
/**
 * The product's name, as it identifies itself to the platforms and agents it
 * talks to.
 *
 * The environment variables (`MT_*`) and the home (`~/.manus-team`) carry the
 * same name. Their pre-rename forms, `PGW_*` and `~/.prime-gateway`, are still
 * read during the transition: see `src/env-names.ts` and `src/home.ts`.
 */
```

- [ ] **Step 5.2: `README.md`.** Replace every `PGW_` with `MT_`, and every `~/.prime-gateway` with `~/.manus-team` (lines 71, 75, 76, 93–108, 114). Then add this section directly after the configuration table and its notes (after the paragraph containing line 114):

```markdown
### Upgrading from prime-gateway

The variables were `PGW_*` and the home was `~/.prime-gateway`. Both still work: each
`PGW_*` variable is read as its `MT_*` name, and if `~/.manus-team` does not exist the
gateway keeps using `~/.prime-gateway`. Each prints a warning at startup saying what to
change. To finish the move, stop the gateway, then:

    mv ~/.prime-gateway ~/.manus-team

and rename `PGW_` to `MT_` in the service's environment. A variable set under both names
to different values, or both homes existing at once, stops the gateway at startup rather
than letting one silently win. Attachment paths recorded before the move point into the
old directory and will not resolve afterwards; new messages are unaffected.
```

- [ ] **Step 5.3: `config.example.yaml`.** Replace every `PGW_` with `MT_`, and `~/.prime-gateway` with `~/.manus-team` (lines 3, 4, 13, 23).

- [ ] **Step 5.4: `docs/testing/durability.md`.** Line 150: `` `$PGW_HOME` `` → `` `$MT_HOME` ``.

- [ ] **Step 5.5: Verify**

Run:

```bash
git grep -n "PGW_" -- src README.md config.example.yaml docs/testing docs/architecture.md
```

Expected — every match is about the transition, and nothing else:

| Where | What |
|---|---|
| `src/env-names.ts` | `OLD_PREFIX`, and its doc comment |
| `src/config.ts` | the `passEnv` check |
| `src/home.ts` | the move warning's text, and its doc comment (`legacy PGW_HOME`) |
| `src/identity.ts` | the comment naming the old forms |
| `README.md` | the "Upgrading from prime-gateway" section |
| `docs/architecture.md` | the "Formerly" note |

Then run `git grep -n "prime-gateway" -- src README.md config.example.yaml` — expected: `src/home.ts` (`OLD_HOME`), `src/env-names.ts` (its doc comment: "The product was `prime-gateway`"), `src/identity.ts` (comment), and the README upgrade section only.

- [ ] **Step 5.6: Full suite**

Run: `npm test 2>&1 | tail -4`
Expected: `Tests  421 passed (421)`.

- [ ] **Step 5.7: Commit**

```bash
git add src/identity.ts README.md config.example.yaml docs/testing/durability.md
git commit -m "Document the MT_* names and how to upgrade from prime-gateway"
```

---

### Task 6: Check it against the live deployment (read-only)

The live gateway runs from the main checkout with `~/.prime-gateway` and whatever its terminal's environment holds. Before this branch is merged — which restarts it — confirm the transition path works for *this* deployment, without touching it.

- [ ] **Step 6.1: Load the real config through the new code, read-only**

```bash
cd /Users/x/Develop/manus/prime-gateway-work
export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH
LARK_APP_SECRET="${LARK_APP_SECRET:-placeholder}" npx tsx -e "
import { loadConfig } from './src/config.ts';
const c = loadConfig();
console.log('home db:', c.dbPath);
console.log('config:', c.configPath);
for (const w of c.warnings) console.log('warning:', w);
"
```

Expected on this machine: `home db: /Users/x/.prime-gateway/gateway.db`, `config: /Users/x/.prime-gateway/config.yaml`, and a warning containing `mv /Users/x/.prime-gateway /Users/x/.manus-team`. This only reads files; it opens no database.

This uses *your* shell's environment, which may differ from the live gateway's. Check the live process for old or new names — **names only, never values**, since its environment holds `LARK_APP_SECRET`:

```bash
for pid in $(pgrep -f "tsx.*src/main.ts"); do
  ps eww -o command= -p "$pid" | tr ' ' '\n' | grep -E '^(PGW|MT)_[A-Z_]*=' | cut -d= -f1
done | sort -u
```

Any `PGW_*` names listed will produce a deprecation warning after the merge; an `MT_X` and `PGW_X` pair listed together could be a conflict — compare them by hand, out of band, before merging.

- [ ] **Step 6.2: Report**, without merging: the warnings it printed, and that merging this branch into the main checkout will restart the live gateway (it runs under `tsx watch`) onto this code.

---

## Done when

- `npm test` → `Tests  421 passed (421)` and `npm run typecheck` clean, under Node 22, in the worktree.
- Step 5.5's greps show only transition-related matches.
- Step 6.1 shows the live deployment would keep working from `~/.prime-gateway`, with the warnings.
- Nothing has been merged into the main checkout, and the live gateway has not been restarted.
