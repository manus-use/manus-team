# Plan A — Rename prime-gateway to manus-team: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the product from `prime-gateway` to `manus-team` everywhere it is a *name*, while every path, environment variable and identifier that a running deployment depends on stays exactly as it is.

**Architecture:** One constant, `PRODUCT_NAME`, becomes the single source of the name inside the code, guarded by a test against `package.json`. Docs and comments are edited by hand. The GitHub repository is renamed last, by the user or with their explicit go-ahead, because it is outward-facing. The local checkout directory is **not** renamed by this plan (see "Out of scope").

**Tech Stack:** TypeScript (Node 22, ESM), vitest, git, the GitHub CLI (`gh`).

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §12 (plan A) and §13 (the rename).

---

## Ground rules for whoever executes this

- **Run everything under Node 22.** The default `node` on this machine is 23.11, and `better-sqlite3` is built for Node 22 — under 23, ~170 tests fail for that reason alone. Prefix every command with:
  ```bash
  export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH
  ```
- **Line numbers are as of `kanban-design`.** On another base they move (on `main`, for example, the `architecture.md` lines are ~13 lower, and on `lark-interaction-fixes` the adapter's `source:` is line 79). Every step quotes the exact text — **find each edit by its text, not its number.**
- **Baseline first.** Before Task 1, `npm test` must report all tests passing and `npm run typecheck` must print nothing. If not, stop: the failure is not yours to fix in this plan.
- **What changes and what does not.** This table is the whole decision; do not widen it.

| Occurrence | Decision | Why |
|---|---|---|
| `package.json` / `package-lock.json` `"name"` | → `manus-team` | the product name |
| README title and prose naming the product | → `manus-team` | the product name |
| `config.example.yaml` header line | → `manus-team` | the product name |
| `docs/architecture.md` title, "prime concept", "prime's opaque durable ID" | → `manus-team` / "gateway" | the product name |
| `docs/testing/durability.md` prose | → `manus-team` | the product name |
| `schema/001_initial.sql`, `schema/002_lark_channel.sql` header comments | → `manus-team` | comments only; the SQL is untouched |
| Lark SDK `source: 'prime-gateway'` (`src/channel/lark/adapter.ts`) | → `PRODUCT_NAME` | how the gateway identifies itself to Lark |
| ACP client name (`src/driver/acp/driver.ts`, `src/index.ts`) | → `PRODUCT_NAME` | how the gateway identifies itself to an agent |
| `architecture.md` unbuilt design identifiers: `prime/` handle prefix, tmux/container/systemd names, `prime/ses_…` branch, `refs/prime/checkpoints` | → `pgw` | nothing has been built with them; `pgw` matches the `PGW_` prefix that stays, so there is no third name later |
| `config.example.yaml` example paths `/var/lib/prime/…` | → `/var/lib/manus-team/…` | examples a reader copies |
| `~/.prime-gateway` (README, `config.example.yaml`, `src/config.ts`, the spec) | **unchanged** | a running deployment's config, database and secrets live there (spec §13) |
| `PGW_*`, `PGW_HOME`, the `pgw` CLI name | **unchanged** | same reason |
| Test temp-dir prefixes (`prime-cli-`, `prime-gw-test-`, …) and test fixture paths (`/var/lib/prime`, `/etc/prime/gw.yaml`) | **unchanged** | internal to tests; renaming them proves nothing |
| `docs/specs/*`, `docs/plans/*` text that *describes* the rename | **unchanged** | they record the decision, including the old name |

## Prerequisite: which branch

The kanban design is committed on `kanban-design` (based on `main`), and `lark-interaction-fixes` is pushed but unmerged. This plan edits `docs/architecture.md`, which `kanban-design` also changed, and `src/channel/lark/adapter.ts`, which `lark-interaction-fixes` also changed.

- [ ] **Step 0.1: Ask the user which base to use**, and do not guess:
  - **(a)** both branches merged to `main` first (cleanest — then branch from `main`), or
  - **(b)** branch from `kanban-design` now, and accept one small conflict in `adapter.ts` line ~78 (`source:`) when `lark-interaction-fixes` merges later.
- [ ] **Step 0.2: Create the branch** from the chosen base:
  ```bash
  git switch -c rename-manus-team <base>
  ```
- [ ] **Step 0.3: Baseline**
  ```bash
  export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH
  npm test 2>&1 | tail -4 && npm run typecheck
  ```
  Expected: `Tests  N passed (N)` with no failures, and no typecheck output.

---

## File structure

| File | Responsibility |
|---|---|
| `src/identity.ts` (create) | `PRODUCT_NAME` — the one place the name lives in code |
| `tests/identity.test.ts` (create) | keeps `PRODUCT_NAME` and `package.json` from drifting apart |
| `src/channel/lark/adapter.ts`, `src/driver/acp/driver.ts`, `src/index.ts` (modify) | use `PRODUCT_NAME` instead of the literal |
| `package.json`, `package-lock.json` (modify) | the package name |
| `README.md`, `config.example.yaml`, `docs/architecture.md`, `docs/testing/durability.md`, `schema/001_initial.sql`, `schema/002_lark_channel.sql` (modify) | prose and comments |

---

### Task 1: One name in code, guarded by a test

**Files:**
- Create: `src/identity.ts`
- Create: `tests/identity.test.ts`
- Modify: `package.json:2`, `package-lock.json:2` and `:8`

- [ ] **Step 1.1: Write the failing test**

Create `tests/identity.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '../src/identity.js';

/**
 * The product's name lives in one constant, and the package name must agree
 * with it. Two copies of a name drift: the old one kept surviving in the
 * strings the gateway sends to Lark and to agents after the docs had moved on.
 */
describe('product identity', () => {
  it('is manus-team', () => {
    expect(PRODUCT_NAME).toBe('manus-team');
  });

  it('matches the package name', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string;
    };
    expect(pkg.name).toBe(PRODUCT_NAME);
  });
});
```

- [ ] **Step 1.2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/identity.test.ts`
Expected: FAIL because `../src/identity.js` cannot be resolved — `src/identity.ts` does not exist yet. (The exact wording depends on the vitest version.)

- [ ] **Step 1.3: Create the constant**

Create `src/identity.ts`:

```ts
/**
 * The product's name, as it identifies itself to the platforms and agents it
 * talks to.
 *
 * Deliberately *not* the name of anything on disk or in the environment: the
 * `PGW_*` variables, `PGW_HOME` and the `~/.prime-gateway` default home keep
 * their names, because a running deployment's configuration, database and
 * secrets live under them. See docs/specs/2026-11-02-kanban-design.md §13.
 */
export const PRODUCT_NAME = 'manus-team';
```

- [ ] **Step 1.4: Run the test — the first case passes, the second still fails**

Run: `npx vitest run --project unit tests/identity.test.ts`
Expected: `is manus-team` PASS; `matches the package name` FAIL with `expected 'prime-gateway' to be 'manus-team'`.

- [ ] **Step 1.5: Rename the package**

In `package.json`, line 2:

```json
  "name": "manus-team",
```

In `package-lock.json`, line 2 **and** line 8 (the root package entry under `"packages": { "": … }`):

```json
  "name": "manus-team",
```

```json
      "name": "manus-team",
```

Do **not** run `npm install` to regenerate the lockfile — it would also re-resolve dependencies. The two edits are the whole change.

- [ ] **Step 1.6: Run the test to verify it passes**

Run: `npx vitest run --project unit tests/identity.test.ts`
Expected: `Tests  2 passed (2)`.

- [ ] **Step 1.7: Commit**

```bash
git add src/identity.ts tests/identity.test.ts package.json package-lock.json
git commit -m "Give the product one name in code, and check it against the package"
```

---

### Task 2: Identify as manus-team to Lark and to agents

**Files:**
- Modify: `src/channel/lark/adapter.ts:78`
- Modify: `src/driver/acp/driver.ts:194`
- Modify: `src/index.ts:78`

There is no unit test of these strings that would not just restate the constant; Task 1's test guards the constant, and Step 2.4's grep guards against a literal surviving.

- [ ] **Step 2.1: Lark adapter**

In `src/channel/lark/adapter.ts`, add to the imports at the top:

```ts
import { PRODUCT_NAME } from '../../identity.js';
```

and change line 78 from

```ts
      source: 'prime-gateway',
```

to

```ts
      source: PRODUCT_NAME,
```

- [ ] **Step 2.2: ACP driver default**

In `src/driver/acp/driver.ts`, add to the imports:

```ts
import { PRODUCT_NAME } from '../../identity.js';
```

and change line 194 from

```ts
    const app = client({ name: config.clientName ?? 'prime-gateway' })
```

to

```ts
    const app = client({ name: config.clientName ?? PRODUCT_NAME })
```

- [ ] **Step 2.3: Gateway wiring**

In `src/index.ts`, add to the imports:

```ts
import { PRODUCT_NAME } from './identity.js';
```

and change line 78 from

```ts
        clientName: 'prime-gateway',
```

to

```ts
        clientName: PRODUCT_NAME,
```

- [ ] **Step 2.4: No literal left in code**

Run: `git grep -n "prime-gateway" -- src tests`
Expected: exactly one line — `src/config.ts:124`, the `~/.prime-gateway` default home, which stays. Anything else is a missed literal.

- [ ] **Step 2.5: Full suite and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all tests pass (the baseline count + 2), no typecheck output.

- [ ] **Step 2.6: Commit**

```bash
git add src/channel/lark/adapter.ts src/driver/acp/driver.ts src/index.ts
git commit -m "Identify to Lark and to agents by the product name"
```

---

### Task 3: Docs, example config and schema comments

**Files:**
- Modify: `README.md:1`, `README.md:17`
- Modify: `config.example.yaml:1`, `:24`, `:25`
- Modify: `docs/architecture.md:1`, `:692`, `:832`, `:835`–`:837`, `:937`, `:948`, `:1238`
- Modify: `docs/testing/durability.md:9`
- Modify: `schema/001_initial.sql:1`, `schema/002_lark_channel.sql:1`

- [ ] **Step 3.1: README**

Line 1: `# prime-gateway` → `# manus-team`

Line 17: `prime-gateway does not implement an agent loop.` → `manus-team does not implement an agent loop.`

Leave lines 71, 76 and 108 (`~/.prime-gateway`) exactly as they are.

- [ ] **Step 3.2: `config.example.yaml`**

Line 1: `# prime-gateway configuration.` → `# manus-team configuration.`

Lines 24–25:

```yaml
# db: /var/lib/manus-team/gateway.db
# downloads: /var/lib/manus-team/downloads
```

Leave line 3 (`~/.prime-gateway/config.yaml`) as it is.

- [ ] **Step 3.3: `docs/architecture.md`**

| Line (text) | Change to |
|---|---|
| `# prime-gateway — Architecture Design` | `# manus-team — Architecture Design` |
| `\| prime concept \| ACP mechanism \|` | `\| gateway concept \| ACP mechanism \|` |
| `handle = "prime/" + session_id + "/" + generation` | `handle = "pgw/" + session_id + "/" + generation` |
| `- **tmux** → session name \`prime/ses_8f72/42\`` | `- **tmux** → session name \`pgw/ses_8f72/42\`` |
| `- **container** → container name \`prime-ses_8f72-42\`` | `- **container** → container name \`pgw-ses_8f72-42\`` |
| `- **systemd scope** → \`prime-ses_8f72-42.scope\`` | `- **systemd scope** → \`pgw-ses_8f72-42.scope\`` |
| `$PGW_HOME/workspaces/ws_42/      # worktree, branch prime/ses_8f72` | `$PGW_HOME/workspaces/ws_42/      # worktree, branch pgw/ses_8f72` |
| `` `refs/prime/checkpoints/<session_id>` `` | `` `refs/pgw/checkpoints/<session_id>` `` |
| `\| \`session_id\` \| prime's opaque durable ID \|` | `\| \`session_id\` \| the gateway's opaque durable ID \|` |

Then add one line directly under the title, so a reader meeting the old name in history knows they are the same thing:

```markdown
*Formerly `prime-gateway`. The `PGW_*` variables, `PGW_HOME` and the `~/.prime-gateway` home keep their names.*
```

- [ ] **Step 3.4: `docs/testing/durability.md`**

Line 9: `…differentiating part of prime-gateway works.` → `…differentiating part of manus-team works.`

- [ ] **Step 3.5: Schema header comments**

`schema/001_initial.sql` line 1: `-- prime-gateway initial schema` → `-- manus-team initial schema`

`schema/002_lark_channel.sql` line 1: `-- prime-gateway migration 002: Lark channel` → `-- manus-team migration 002: Lark channel`

Comments only. Do not touch any SQL statement: these files are applied to existing databases.

- [ ] **Step 3.6: Verify nothing was missed, and nothing extra changed**

Run:

```bash
git grep -n -i "prime-gateway" -- . ':!docs/specs' ':!docs/plans'
```

Expected — matches in exactly these places and no others, every one of them the kept `~/.prime-gateway` home or the "Formerly" note:

| File | Line(s) | What matches |
|---|---|---|
| `README.md` | 71, 76, 108 | `~/.prime-gateway` |
| `config.example.yaml` | 3 | `~/.prime-gateway/config.yaml` |
| `docs/architecture.md` | the line under the title | the "Formerly `prime-gateway`" note |
| `src/config.ts` | 124 | `'.prime-gateway'` |

Six lines in total. A seventh is a missed rename; fewer means a kept path was changed — revert it.

Then check the design identifiers were all renamed:

```bash
git grep -n -w "prime" -- docs/architecture.md | grep -v "Formerly"
```

Expected: no output. (`-w` treats `-` as a word boundary, so `prime` also matches inside
`prime-gateway` in the "Formerly" note — which is why that line is filtered out.)

- [ ] **Step 3.7: Schema files still apply cleanly**

Run: `npm test 2>&1 | tail -4`
Expected: all tests pass — the suite opens a fresh database with every migration, so a damaged schema file fails here.

- [ ] **Step 3.8: Commit**

```bash
git add README.md config.example.yaml docs/architecture.md docs/testing/durability.md schema/001_initial.sql schema/002_lark_channel.sql
git commit -m "Rename the product to manus-team in docs and comments"
```

---

### Task 4: Rename the GitHub repository (outward-facing — needs the user)

Renaming the remote repository changes a public URL. **Do not run Step 4.2 without the user's explicit go-ahead in this conversation**, even if earlier steps were approved.

- [ ] **Step 4.1: Ask the user**: "Rename `manus-use/prime-gateway` to `manus-use/manus-team` on GitHub now? GitHub redirects the old URL, but anything pinned to it by name (CI, webhooks, other clones) should be checked."

- [ ] **Step 4.2: Rename, once approved.** The `gh` CLI has two accounts here, and the active one (`manus-pi`) is not the repository's owner, so pass the owner's token for this one command:

```bash
GH_TOKEN="$(gh auth token --user manus-use)" gh repo rename manus-team -R manus-use/prime-gateway --yes
```

Expected: `✓ Renamed repository manus-use/manus-team`

- [ ] **Step 4.3: Point the local remote at the new name**

```bash
git remote set-url origin https://manus-use@github.com/manus-use/manus-team.git
git remote -v
```

Expected: both lines show `.../manus-use/manus-team.git`.

- [ ] **Step 4.4: Push the branch**, with the same per-command credential used before (the active `gh` account is not the owner):

```bash
git -c credential.helper= -c 'credential.helper=!f() { echo username=manus-use; echo "password=$(gh auth token --user manus-use)"; }; f' push -u origin rename-manus-team
```

---

## Out of scope, deliberately

- **Renaming the local checkout directory** (`~/Develop/manus/prime-gateway`). Nothing in the code depends on it, and moving it has costs this plan cannot see: a service definition (launchd/systemd) may start the gateway from that path, and Claude Code keys this project's saved memory by the directory path, so a move orphans it unless the memory directory is moved too. If the user wants it, it is a separate, manual step: stop the gateway, move the directory, update the service definition, and move `~/.claude/projects/-Users-x-Develop-manus-prime-gateway` to the matching new name.
- **`~/.prime-gateway`, `PGW_*`, `PGW_HOME`** — kept by the spec (§13).
- **Any behaviour change.** After this plan the gateway does exactly what it did, and says `manus-team` where it used to say `prime-gateway`.

## Done when

- `npm test` passes (baseline + 2 tests) and `npm run typecheck` is clean, under Node 22.
- Step 3.6's grep shows only the kept home-directory references and the "Formerly" note.
- The branch is pushed; and, if the user approved Task 4, the repository is `manus-use/manus-team` and `origin` points at it.
