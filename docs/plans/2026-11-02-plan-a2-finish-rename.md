# Plan A2 — Finish the rename: MT_* variables, ~/.manus-team, mt: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gateway reads its configuration from `MT_*` variables and lives in `~/.manus-team`. The old `PGW_*` names are not read; one left set stops startup with a message naming it.

**Architecture:** A rename inside `src/config.ts` — every `PGW_` key becomes `MT_`, the home default becomes `~/.manus-team` — plus one guard at the top of `loadConfig` that refuses any `PGW_*` variable. No transition layer: the only deployment set no `PGW_*` variable, and its home has already been moved (spec §13).

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext — relative imports end in `.js`), vitest.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §13, and §12's row for A2.

---

## Ground rules

- **Work in the worktree `/Users/x/Develop/manus/prime-gateway-work`, branch `full-rename`.** Never edit the main checkout (`/Users/x/Develop/manus/prime-gateway`): the gateway runs from there under `tsx watch`.
- **Link `node_modules` once**, before Task 1: `cd /Users/x/Develop/manus/prime-gateway-work && ln -s ../prime-gateway/node_modules node_modules`. The link may show as untracked; every commit step names its files — **never `git add -A`**.
- **Node 22:** `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline:** `npm test` → `Tests  399 passed (399)`; `npm run typecheck` → no output. If not, stop.
- **Commit messages:** no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
- **Find edits by their text;** line numbers are a guide.

---

### Task 1: Configuration reads MT_*, refuses PGW_*

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1.1: Move the existing tests to the new names**

In `tests/config.test.ts`, replace every `PGW_` with `MT_` — including in the error-message regexes (`/PGW_CONFIG points at …/` → `/MT_CONFIG points at …/`, `/agent\.passEnv, or set PGW_AGENT_ENV_/` → `MT_AGENT_ENV_`). Nothing else changes in this step.

- [ ] **Step 1.2: Add tests for the rename**

Append to `tests/config.test.ts`:

```ts
describe('loadConfig: after the rename', () => {
  it('refuses to start while an old variable is still set, naming it and not its value', () => {
    let message = '';
    try {
      load({ PGW_DB: '/var/lib/secret-path.db' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('PGW_DB');
    expect(message).toContain('MT_DB');
    expect(message).not.toContain('/var/lib/secret-path.db');
  });

  it('names every old variable that is set, not just the first', () => {
    expect(() => load({ PGW_DB: '/a', PGW_WORKSPACE: '/b' })).toThrow(/PGW_DB, PGW_WORKSPACE/);
  });

  it('looks for its home in ~/.manus-team by default', () => {
    const files = reader({});
    loadConfig({ ...ENV_ONLY, LARK_APP_SECRET: 'app-secret' }, files);
    expect(files.asked).toEqual([join(homedir(), '.manus-team', 'config.yaml')]);
  });

  it('refuses to forward the gateway\'s own variables through passEnv', () => {
    for (const name of ['MT_DB', 'LARK_APP_SECRET']) {
      const file = yamlFile({ agent: { command: 'claude-agent-acp', passEnv: [name] } });
      expect(() => load({ [name]: 'x' }, file)).toThrow('belongs to the gateway');
    }
  });
});
```

If `homedir` is not already imported in the test file, add `import { homedir } from 'node:os';` (and `join` from `node:path` if missing) at the top. `load`, `reader`, `yamlFile`, `ENV_ONLY` are the file's existing helpers; `ENV_ONLY` sets no `MT_HOME`, which is what makes the default-home test meaningful.

- [ ] **Step 1.3: Run the config tests to verify they fail**

Run: `npx vitest run --project unit tests/config.test.ts`
Expected: FAIL — every test in the file, because `BASE` and `ENV_ONLY` now set `MT_*` keys that `config.ts` does not read yet.

- [ ] **Step 1.4: Update `src/config.ts`**

1. **Every `PGW_` becomes `MT_`** — the `envString`/`envList`/`envFlag`/`envInteger` keys, the `fail(...)` and `ConfigError` message texts, the doc comments, and `AGENT_ENV_PREFIX = 'MT_AGENT_ENV_'`.

2. **The home default**, in `loadConfig`:

   ```ts
   const home = envString(env, 'MT_HOME') ?? join(homedir(), '.manus-team');
   ```

3. **The `passEnv` check** becomes:

   ```ts
       if (name.startsWith('MT_') || name.startsWith('LARK_')) {
   ```

   keeping its existing message.

4. **The guard.** Add this function near `agentEnv`:

   ```ts
   /**
    * The variables were `PGW_*` before the rename and are not read any more.
    *
    * One still set is refused rather than ignored: ignored, it is a setting
    * someone believes in that has quietly stopped applying. The message names the
    * variables and never their values, which may be secrets.
    */
   function refuseOldNames(env: Env): void {
     const old = Object.keys(env)
       .filter((key) => key.startsWith('PGW_') && env[key] !== undefined)
       .sort();
     if (old.length === 0) return;
     const renames = old.map((key) => `${key} → MT_${key.slice('PGW_'.length)}`).join(', ');
     throw new ConfigError(
       `${old.join(', ')} ${old.length === 1 ? 'is' : 'are'} no longer read: the variables were ` +
         `renamed to MT_* (${renames}).`,
     );
   }
   ```

   and call it as the **first line** of `loadConfig`:

   ```ts
     refuseOldNames(env);
   ```

- [ ] **Step 1.5: Run the config tests to verify they pass**

Run: `npx vitest run --project unit tests/config.test.ts`
Expected: all pass, including the 4 new ones.

- [ ] **Step 1.6: Only the guard still names the old prefix**

Run: `git grep -n "PGW_" -- src/config.ts`
Expected: only lines inside `refuseOldNames` (and its doc comment).

- [ ] **Step 1.7: Full suite and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: `Tests  403 passed (403)`, no typecheck output.

- [ ] **Step 1.8: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "Read configuration from MT_* and the ~/.manus-team home, and refuse PGW_*"
```

---

### Task 2: Docs and the identity comment

**Files:**
- Modify: `src/identity.ts`
- Modify: `README.md`
- Modify: `config.example.yaml`
- Modify: `docs/testing/durability.md`

- [ ] **Step 2.1: `src/identity.ts`.** Replace the doc comment above `PRODUCT_NAME` with:

```ts
/**
 * The product's name, as it identifies itself to the platforms and agents it
 * talks to. The environment variables (`MT_*`) and the home (`~/.manus-team`)
 * carry the same name.
 */
```

- [ ] **Step 2.2: `README.md`.** Replace every `PGW_` with `MT_`, and every `~/.prime-gateway` with `~/.manus-team` (lines 71, 75, 76, 93–108, 114). Then add the paragraph below directly after the paragraph that starts `` `MT_CONFIG` names the file `` (lines 75–78) — **not** near line 114, which is inside a bulleted list that a plain paragraph would split:

```markdown
Renamed from prime-gateway: the variables were `PGW_*` and are now `MT_*`, and the home moved
from `~/.prime-gateway` to `~/.manus-team`. The old names are not read; one left set stops the
gateway at startup with a message naming it.
```

- [ ] **Step 2.3: `config.example.yaml`.** Replace every `PGW_` with `MT_`, and `~/.prime-gateway` with `~/.manus-team` (lines 3, 4, 13, 23).

- [ ] **Step 2.4: `docs/testing/durability.md`.** `` `$PGW_HOME` `` → `` `$MT_HOME` `` (line 150).

- [ ] **Step 2.5: Verify**

```bash
git grep -n "PGW_\|prime-gateway" -- src README.md config.example.yaml docs/testing docs/architecture.md
```

Expected — exactly these, and nothing else:

| Where | What |
|---|---|
| `src/config.ts` | `refuseOldNames` and its doc comment |
| `README.md` | the "Renamed from prime-gateway" paragraph |
| `docs/architecture.md` | the "Formerly" note under the title |

- [ ] **Step 2.6: Full suite** — `npm test 2>&1 | tail -4` → `Tests  403 passed (403)`.

- [ ] **Step 2.7: Commit**

```bash
git add src/identity.ts README.md config.example.yaml docs/testing/durability.md
git commit -m "Document the MT_* names and the ~/.manus-team home"
```

---

### Task 3: Check against the moved home (read-only)

- [ ] **Step 3.1: Load the real config through the new code**

```bash
cd /Users/x/Develop/manus/prime-gateway-work
export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH
LARK_APP_SECRET=placeholder npx tsx -e "
import { loadConfig } from './src/config.ts';
const c = loadConfig();
console.log('db:', c.dbPath);
console.log('config:', c.configPath);
"
```

Expected: `db: /Users/x/.manus-team/gateway.db` and `config: /Users/x/.manus-team/config.yaml`. This reads files only; it opens no database. If the shell running it still exports a `PGW_*` variable, the new guard refuses with a message naming it — that is correct behaviour, not a bug: unset it and re-run.

- [ ] **Step 3.2: Report** — without merging. Merging into the main checkout is the controller's step, done with the gateway stopped.

---

## Done when

- `Tests  403 passed (403)` and typecheck clean, under Node 22, in the worktree.
- Step 2.5's grep shows exactly the three expected places.
- Step 3.1 resolves to `~/.manus-team`.
