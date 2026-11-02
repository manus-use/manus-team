# Plan A2 — Finish the rename: MT_* variables, ~/.manus-team, mt: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gateway reads its configuration from `MT_*` variables and lives in `~/.manus-team`. The old names are not read, and nothing in the repository mentions them.

**Architecture:** A rename inside `src/config.ts` — every variable key becomes `MT_*`, the home default becomes `~/.manus-team` — with the tests and docs following. No transition layer and no guard for the old names: the only deployment set none of them, and its home was moved before this change (spec §13).

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext), vitest.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §13, and §12's row for A2.

---

## Ground rules

- **Work in the worktree `/Users/x/Develop/manus/prime-gateway-work`, branch `full-rename`.** Never edit the main checkout: the gateway runs from there under `tsx watch`.
- `node_modules` is symlinked into the worktree and shows as untracked; commit named files only — never `git add -A`.
- **Node 22:** `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH`.
- **Commit messages:** no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.

---

### Task 1: Configuration reads MT_* — done (`80d2619`)

- [x] `src/config.ts`: every variable key, message and comment uses `MT_*`; `AGENT_ENV_PREFIX = 'MT_AGENT_ENV_'`; home default `envString(env, 'MT_HOME') ?? join(homedir(), '.manus-team')`; `passEnv` refuses names starting `MT_` or `LARK_`.
- [x] `tests/config.test.ts`: every variable renamed to `MT_*`; new tests for the `~/.manus-team` default home and for `passEnv` refusing `MT_DB` and `LARK_APP_SECRET`.

### Task 2: Docs and the identity comment — done (`919665f`)

- [x] `src/identity.ts`, `README.md`, `config.example.yaml`, `docs/testing/durability.md` use `MT_*` and `~/.manus-team`.

### Task 2b: Remove every mention of the old prefix

Task 1 first added a startup guard refusing the old variables, and Task 2 a README paragraph naming them. Both go: the old names are not read, so nothing in the repository refers to them.

- [x] Remove the guard from `src/config.ts` and its two tests from `tests/config.test.ts`.
- [x] Remove the README paragraph; shorten `docs/architecture.md`'s note to "*Formerly `prime-gateway`.*"; reword the spec (§11, §12, §13) and plan A so neither names the old prefix.
- [ ] **Verify:** `git grep -n -i "p[g]w" -- . ':!package-lock.json'` (the bracket keeps this line from matching itself) → no output. (`package-lock.json` is excluded because one dependency's base64 integrity hash happens to contain those letters.)
- [ ] **Full suite:** `npm test 2>&1 | tail -4 && npm run typecheck` → `Tests  401 passed (401)`, no typecheck output.
- [ ] **Commit** the changed files by name:

```bash
git add src/config.ts tests/config.test.ts README.md docs/architecture.md \
  docs/specs/2026-11-02-kanban-design.md docs/plans/2026-11-02-plan-a-rename-manus-team.md \
  docs/plans/2026-11-02-plan-a2-finish-rename.md
git commit -m "Remove every mention of the old variable prefix"
```

### Task 3: Check against the moved home (read-only)

- [ ] Load the real config through the new code:

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

Expected: `db: /Users/x/.manus-team/gateway.db` and `config: /Users/x/.manus-team/config.yaml`. This reads files only; it opens no database.

- [ ] Report, without merging. Merging into the main checkout is the controller's step, done with the gateway stopped.

---

## Done when

- `Tests  401 passed (401)` and typecheck clean, under Node 22, in the worktree.
- The verify grep above finds nothing outside `package-lock.json`'s hash.
- Task 3 resolves to `~/.manus-team`.
