# Plan B2 — The session layer: a driver per role, a workspace per session: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session runs as a role, in a named workspace, through the channel it is bound on. The role is recorded in `sessions.agent_id` and the workspace in `sessions.workspace_id`. Each role has its own driver, built from its own `agent` block and environment. A workspace name keeps the directory it was first seen with, and a session can be created seeded with another session's provider session id.

**Architecture:** The five session-layer changes of spec §2.4, plus the "never relocated" rule of §2.3:
- **Drivers:** the process-global driver registry becomes a pure `buildDriver(agent)`, and `SessionRegistry` holds a map from role name to driver.
- **Workspaces:** `WorkspaceProvider.acquire` takes the session's workspace name.
- **Environment:** `StartOptions` and `SessionActorDeps` gain `env`.
- **Channels:** the registry holds a map from binding channel id to channel.
- **Seeding:** a new public `create` accepts a role, a workspace and a seed.
- **Workspace table:** the `workspaces` table (schema `001`, unused until now) records each name's directory the first time it is seen, and startup refuses a name that moved.

Chat sessions keep running the role `default` in the workspace `default`. Every existing row keeps working without a migration:
- a driver id in `agent_id` (`acp`, `structured-cli`) or an empty value means the role `default`;
- an empty `workspace_id` means the workspace `default`.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest (`unit` and `e2e` projects), better-sqlite3.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §2.3 (the rule that a workspace's directory never moves), §2.4 (all five items), §12 (the B row).

---

## Ground rules

- **Work in the worktree `/Users/x/Develop/manus/prime-gateway-work`, branch `session-roles`.** Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there under `tsx watch`, and any source change restarts it. Never start the gateway.
- `node_modules` is symlinked into the worktree and shows as untracked; commit named files only — never `git add -A`.
- **Node 22:** `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Commit messages:** plain English, no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text. The letters `p`,`g`,`w` in that order, in any case, must not appear in anything written.
- **Never print secret values**, including when inspecting an environment.
- **Baseline:** `npm test` → `Tests  464 passed (464)`; `npm run test:e2e` → `Tests  47 passed (47)`; `npm run typecheck` prints nothing.
- **Find each edit by its quoted text, not by line number.**

## Out of scope (later plans)

- **Plan C (the dispatcher and the sink channel):**
  - the dispatcher that supplies `envFor`;
  - pinning an open run's actor against eviction, and ending a rebuilt run `interrupted`;
  - the `kanban` sink channel itself.

  This plan provides the hooks and the channel map, and nothing calls `create` with a non-default role yet.
- **Also for plan C:**
  - Lark's `allowedFileDirs` is only the workspace `default`, so a chat session in another workspace could not attach files. Chat sessions are all in `default` until plan D.
  - An ACP agent that rejects a seeded id makes `session/resume` or `session/load` throw, rather than starting fresh as §2.4 item 5 says. C's rework must start without the seed when that happens.
- **Plan B3:** the `mt` binary and its `mt role` and `mt workspace` commands.
- **Plan E:** native resume in the CLI driver. Until then a seed reaches the CLI driver and is ignored: it replays, and with no history it starts fresh.
- **Already done in B1:** the tool-policy check. A role declaring `tools` is a startup error, because no driver can enforce one (`TOOL_POLICY_DRIVERS = []` in `src/roles.ts`).

## File structure

| File | Responsibility |
|---|---|
| `src/db/workspaces.ts` (create) | sole writer of the `workspaces` table: register names, refuse a moved one |
| `src/db/WRITERS.md` (modify) | adds the `workspaces` row |
| `src/db/sessions.ts` (modify) | `createSession` takes an optional seeded `providerSessionId` |
| `src/driver/types.ts` (modify) | `StartOptions.env` |
| `src/driver/cli/driver.ts`, `src/driver/acp/driver.ts` (modify) | merge `StartOptions.env` over the configured env at spawn |
| `src/core/session-actor.ts` (modify) | `SessionActorDeps.env`, passed to every start |
| `src/driver/registry.ts` (modify) | keeps only `KNOWN_DRIVERS` / `KnownDriver` |
| `src/driver/build.ts` (create) | `buildDriver(agent)`, `buildRoleDrivers(roles)` |
| `src/core/workspace.ts` (modify) | `WorkspaceProvider.acquire(sessionId, workspaceId)` and `has`; `NamedWorkspaces` replaces `PlainDirWorkspaces` |
| `src/core/registry.ts` (modify) | the role → driver map, the channel map, `envFor`, `create`, the role and workspace of a session |
| `src/index.ts` (modify) | the wiring |
| `src/config.ts`, `src/roles.ts` (modify) | drop `workspaceDir`; one shared `agentArgs` |
| `tests/workspace-registry.test.ts`, `tests/driver-build.test.ts`, `tests/workspace.test.ts` (create) | new tests |
| `tests/db.test.ts`, `tests/session-actor.test.ts`, `tests/registry.test.ts`, `tests/router.test.ts`, `tests/config.test.ts`, `tests/cli-driver.e2e.ts`, `tests/acp-driver.e2e.ts` (modify) | |
| `README.md` (modify) | the rule that a workspace's directory never moves |

---

### Task 1: The `workspaces` table remembers each name's directory

**Files:**
- Create: `src/db/workspaces.ts`, `tests/workspace-registry.test.ts`
- Modify: `src/db/WRITERS.md`

The table exists since schema `001`:
```sql
CREATE TABLE workspaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL, root_path TEXT NOT NULL,
  repo_root TEXT, branch TEXT, lock_holder TEXT REFERENCES sessions(id), created_at INTEGER NOT NULL) STRICT;
```
How a row is used:
- `id` is the workspace name;
- `kind` is `plain-dir`;
- `root_path` is the realpath;
- `repo_root`, `branch` and `lock_holder` stay null until worktrees exist.

- [ ] **Step 1.1: Write the failing tests.** Create `tests/workspace-registry.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { registerWorkspaces } from '../src/db/workspaces.js';
import { testDb, type TestDb } from './helpers/db.js';

const NOW = 1_760_000_000_000;
const open: TestDb[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function db(): TestDb {
  const t = testDb();
  open.push(t);
  return t;
}

function rows(t: TestDb): Array<{ id: string; kind: string; root_path: string }> {
  return t.db
    .prepare<[], { id: string; kind: string; root_path: string }>('SELECT id, kind, root_path FROM workspaces ORDER BY id')
    .all();
}

/**
 * A workspace name is a durable identity, and its directory never moves (spec §2.3):
 * relocating one orphans the provider sessions opened in it and silently moves
 * every task fixed to it.
 */
describe('registerWorkspaces', () => {
  it('records each name the first time it is seen', () => {
    const t = db();
    const result = registerWorkspaces(t.db, new Map([['default', '/srv/a'], ['docs', '/srv/b']]), NOW);
    expect(result).toEqual({ ok: true, added: ['default', 'docs'] });
    expect(rows(t)).toEqual([
      { id: 'default', kind: 'plain-dir', root_path: '/srv/a' },
      { id: 'docs', kind: 'plain-dir', root_path: '/srv/b' },
    ]);
  });

  it('accepts the same directories again, adding nothing', () => {
    const t = db();
    registerWorkspaces(t.db, new Map([['default', '/srv/a']]), NOW);
    expect(registerWorkspaces(t.db, new Map([['default', '/srv/a']]), NOW + 1)).toEqual({ ok: true, added: [] });
    expect(rows(t)).toHaveLength(1);
  });

  it('refuses a known name pointed at a new directory, naming both', () => {
    const t = db();
    registerWorkspaces(t.db, new Map([['default', '/srv/a']]), NOW);
    const result = registerWorkspaces(t.db, new Map([['default', '/srv/moved']]), NOW + 1);
    expect('error' in result && result.error).toMatch(/workspace default is \/srv\/a .* \/srv\/moved/);
    expect('error' in result && result.error).toMatch(/new name/);
  });

  it('registers nothing when any name has moved', () => {
    // Checked before anything is written, so a refused start leaves the table as it was.
    const t = db();
    registerWorkspaces(t.db, new Map([['default', '/srv/a']]), NOW);
    // 'alpha' sorts before the moved name, so writing as it goes would insert it.
    registerWorkspaces(t.db, new Map([['alpha', '/srv/b'], ['default', '/srv/moved']]), NOW + 1);
    expect(rows(t).map((r) => r.id)).toEqual(['default']);
  });
});
```

- [ ] **Step 1.2: Run it to verify it fails.** Run: `npx vitest run --project unit tests/workspace-registry.test.ts`. Expected: FAIL, because `../src/db/workspaces.js` cannot be resolved.

- [ ] **Step 1.3: Implement.** Create `src/db/workspaces.ts`:

```ts
import type { Db } from './open.js';
import { txImmediate } from './open.js';

/**
 * The `workspaces` table: one row per workspace name, written the first time the
 * name is seen and never updated (spec §2.3).
 *
 * A name's directory never moves. Some agents look their sessions up by directory,
 * so pointing a known name somewhere else orphans every provider session opened in
 * it, and would silently move every task fixed to it. A new directory gets a new
 * name. This is architecture Appendix A's rule that a workspace is never relocated.
 *
 * Names removed from the config keep their rows: the name stays taken, so it can
 * never come back meaning a different directory.
 */

export type RegisterResult = { ok: true; added: string[] } | { error: string };

export function registerWorkspaces(
  db: Db,
  workspaces: ReadonlyMap<string, string>,
  now: number,
): RegisterResult {
  return txImmediate(db, (d) => {
    const find = d.prepare<[string], { root_path: string }>('SELECT root_path FROM workspaces WHERE id = ?');
    const names = [...workspaces.keys()].sort();

    // Every name is checked before any is written, so a refused start changes nothing.
    const fresh: string[] = [];
    for (const name of names) {
      const path = workspaces.get(name) ?? '';
      const row = find.get(name);
      if (row === undefined) {
        fresh.push(name);
      } else if (row.root_path !== path) {
        return {
          error:
            `workspace ${name} is ${row.root_path} (recorded when the name was first used), but the config ` +
            `now says ${path}. A workspace's directory never moves: the sessions opened in it would be ` +
            'orphaned. Give the new directory a new name.',
        };
      }
    }

    const insert = d.prepare(
      "INSERT INTO workspaces (id, kind, root_path, created_at) VALUES (?, 'plain-dir', ?, ?)",
    );
    for (const name of fresh) insert.run(name, workspaces.get(name) ?? '', now);
    return { ok: true, added: fresh };
  });
}
```

- [ ] **Step 1.4: Add the row to `src/db/WRITERS.md`.** Add it to the ownership table, after the `seen_messages` row:

```markdown
| `workspaces` | `db/workspaces.ts` | Rows are added, never updated: `root_path` is fixed the first time a name is seen (spec §2.3). `repo_root`, `branch` and `lock_holder` stay null until worktrees. |
```

- [ ] **Step 1.5: Run the tests.** Run: `npx vitest run --project unit tests/workspace-registry.test.ts`. Expected: `Tests  4 passed (4)`. Then `npm test 2>&1 | tail -4`. Expected: `Tests  468 passed (468)`.

- [ ] **Step 1.6: Commit.**

```bash
git add src/db/workspaces.ts src/db/WRITERS.md tests/workspace-registry.test.ts
git commit -m "Remember each workspace name's directory, and refuse one that moved"
```

---

### Task 2: A session can be created with a seeded provider session id

**Files:**
- Modify: `src/db/sessions.ts` (`createSession`), `tests/db.test.ts` (the `describe('sessions', …)` block)

Spec §2.4 item 5. The seed is an id *another* session observed. It is passed as a hint, and is the one deliberate exception to "the provider session id is observed, never assumed". It is written in the same transaction that creates the row.

- [ ] **Step 2.1: Write the failing test.** Add it inside `describe('sessions', …)` in `tests/db.test.ts`. That file's `h.db` and `NOW` are already in scope, and so is `getSession`; if it is not imported, add it to the `../src/db/sessions.js` import.

```ts
  it('records a seeded provider session id at creation, and none otherwise', () => {
    // Review rework resumes the implementer's conversation (spec §2.4 item 5):
    // the seed is a hint the driver may use, and the agent's own report replaces it.
    createSession(
      h.db,
      { id: 's_seeded', agentId: 'reviewer', workspaceId: 'default', ownerPrincipal: 'on_owner', providerSessionId: 'prov_impl' },
      NOW,
    );
    createSession(h.db, { id: 's_plain', agentId: 'default', workspaceId: 'default', ownerPrincipal: 'on_owner' }, NOW);
    expect(getSession(h.db, 's_seeded')?.providerSessionId).toBe('prov_impl');
    expect(getSession(h.db, 's_plain')?.providerSessionId).toBeNull();
  });
```

- [ ] **Step 2.2: Run it to verify it fails.** Run: `npx vitest run --project unit tests/db.test.ts`. Expected: a type error or FAIL, because `providerSessionId` is not accepted and the stored value is `null`. vitest does not typecheck, so the likely failure is `expected null to be 'prov_impl'`.

- [ ] **Step 2.3: Implement.** In `src/db/sessions.ts` `createSession`, add a field to the input type after `title?: string | null;`:

```ts
    /**
     * Seeded from another session's observed id (spec §2.4 item 5). A hint, not an
     * observation: whatever the agent reports at start replaces it.
     */
    providerSessionId?: string | undefined;
```

Then change the INSERT and its `.run`:

```ts
    d.prepare(
      `INSERT INTO sessions
         (id, agent_id, workspace_id, owner_principal, state, title, generation,
          provider_session_id, last_seq, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, 'initializing', ?, 0, ?, 0, ?, ?)`,
    ).run(s.id, s.agentId, s.workspaceId, s.ownerPrincipal, s.title ?? null, s.providerSessionId ?? null, now, now);
```

- [ ] **Step 2.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  469 passed (469)`.

- [ ] **Step 2.5: Commit.**

```bash
git add src/db/sessions.ts tests/db.test.ts
git commit -m "Let a session be created with a seeded provider session id"
```

---

### Task 3: `StartOptions.env` reaches the agent process

**Files:**
- Modify: `src/driver/types.ts` (`StartOptions`), `src/driver/cli/driver.ts` (`CliRuntime`), `src/driver/acp/driver.ts` (`startAcpSession`), `tests/cli-driver.e2e.ts`, `tests/acp-driver.e2e.ts`

Spec §2.4 item 3. The values are merged over the driver's configured `env`, so a session's own value wins. The result still goes through `buildEnv`'s allowlist and scrub.

- [ ] **Step 3.1: Write the failing CLI test.** In `tests/cli-driver.e2e.ts`, inside `describe('CLI driver: establishing a session', …)`, add:

```ts
  it('gives the agent the session environment over the configured one', async () => {
    // A run's MT_KANBAN_* variables arrive this way (spec §2.4 item 3); the
    // session's value wins, so the log lands where the start said, not the config.
    const dir = mkdtempSync(join(tmpdir(), 'mt-cli-env-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configured = join(dir, 'configured.log');
    const fromStart = join(dir, 'from-start.log');
    const driver = createCliDriver({
      command: process.execPath,
      args: [AGENT],
      env: { FAKE_CLI_MODE: 'basic', FAKE_CLI_LOG: configured },
    });
    const { runtime } = await driver.start({ cwd: dir, env: { FAKE_CLI_LOG: fromStart } });
    cleanups.push(() => runtime.close());
    await collect(runtime.prompt(said('hello')));
    expect(readFileSync(fromStart, 'utf8')).toContain('hello');
    expect(() => readFileSync(configured, 'utf8')).toThrow();
  });
```

- [ ] **Step 3.2: Write the failing ACP test.** In `tests/acp-driver.e2e.ts`, inside the first `describe`, the one containing `'returns a usable runtime and the id the agent minted'`, add:

```ts
  it('gives the agent the session environment over the configured one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-acp-env-'));
    const driver = createAcpDriver({
      command: process.execPath,
      args: [AGENT],
      env: { FAKE_AGENT_MODE: 'basic', FAKE_AGENT_SESSION_ID: 'sess_configured' },
    });
    const started = await driver.start({ cwd: dir, env: { FAKE_AGENT_SESSION_ID: 'sess_from_start' } });
    cleanups.push(async () => {
      await started.runtime.close();
      rmSync(dir, { recursive: true, force: true });
    });
    expect(started.result.providerSessionId).toBe('sess_from_start');
  });
```

- [ ] **Step 3.3: Run them to verify they fail.** Run: `npm run test:e2e 2>&1 | tail -15`. Expected: both new tests FAIL. The CLI test fails because `from-start.log` does not exist. The ACP test fails with `expected 'sess_configured' to be 'sess_from_start'`.

- [ ] **Step 3.4: Implement.** In `src/driver/types.ts`, add to `StartOptions` after `replay`:

```ts
  /**
   * Extra environment for this session's agent, merged over the driver's own
   * `env` (a session's value wins) and filtered like it (`../driver/env.ts`).
   * How a run's `MT_KANBAN_*` variables reach the agent (spec §2.4 item 3).
   */
  env?: Readonly<Record<string, string>> | undefined;
```

In `src/driver/cli/driver.ts` `CliRuntime`:
- add a field `#env: Readonly<Record<string, string>>;` next to `#cwd`;
- in the constructor, after `this.#cwd = opts.cwd;`, add `this.#env = opts.env ?? {};`;
- in the spawn call, change `env: buildEnv(process.env, this.#config.env ?? {}),` to:

```ts
      env: buildEnv(process.env, { ...(this.#config.env ?? {}), ...this.#env }),
```

In `src/driver/acp/driver.ts` `startAcpSession`, replace
```ts
    ...(config.env === undefined ? {} : { env: config.env }),
```
with
```ts
    env: { ...(config.env ?? {}), ...(opts.env ?? {}) },
```

- [ ] **Step 3.5: Run the tests.** `npm run test:e2e 2>&1 | tail -4` → `Tests  49 passed (49)`; `npm test 2>&1 | tail -4` → `Tests  469 passed (469)`; `npm run typecheck` → no output.

- [ ] **Step 3.6: Commit.**

```bash
git add src/driver/types.ts src/driver/cli/driver.ts src/driver/acp/driver.ts tests/cli-driver.e2e.ts tests/acp-driver.e2e.ts
git commit -m "Give an agent its session's environment over the configured one"
```

---

### Task 4: The actor passes its environment to every start

**Files:**
- Modify: `src/core/session-actor.ts` (`SessionActorDeps`, constructor, the `this.#driver.start({…})` call), `tests/session-actor.test.ts`

The one change to the actor (spec §2.4 item 3). The actor builds `StartOptions` itself, so it must carry the environment it was built with into every start, including a restart after a failed turn.

- [ ] **Step 4.1: Write the failing test.** Add a new `describe` at the end of `tests/session-actor.test.ts`. The file already imports `createSession`, `bindSession`, `SessionActor`, `FakeChannel`, `FakeDriver`, `ManualClock`, `testDb` and `KEY`/`NOW`, and has the `open` list; reuse them.

```ts
describe('environment', () => {
  it('passes its environment to every start, and none when it has none', async () => {
    const db = testDb();
    open.push(db);
    const clock = new ManualClock(NOW);
    createSession(db.db, { id: 's_env', agentId: 'default', workspaceId: '', ownerPrincipal: 'on_owner' }, NOW);
    bindSession(db.db, KEY, 's_env', NOW);
    const driver = new FakeDriver();
    const actor = new SessionActor({
      db: db.db,
      sessionId: 's_env',
      driver,
      channel: new FakeChannel({ clock }),
      key: KEY,
      target: { chatId: KEY.conversationId, threadId: KEY.threadId },
      cwd: '/tmp/workspace',
      env: { MT_KANBAN_RUN: 'r_1' },
      clock,
    });
    await actor.submit({ messageId: 'om_env', appId: KEY.appId, input: { text: 'hi', paths: [] } });
    expect(driver.starts[0]?.env).toEqual({ MT_KANBAN_RUN: 'r_1' });
    await actor.close();

    const h = harness();
    await h.actor.submit({ messageId: 'om_plain', appId: KEY.appId, input: { text: 'hi', paths: [] } });
    expect(h.driver.starts).toHaveLength(1);
    expect(h.driver.starts[0]?.env).toBeUndefined();
  });
});
```

If the harness's fields are named differently, check the `Harness` interface at the top of the file and adapt `h.actor` / `h.driver`; the assertions stay as written.

- [ ] **Step 4.2: Run it to verify it fails.** `npx vitest run --project unit tests/session-actor.test.ts`. Expected: FAIL, `expected undefined to deeply equal { MT_KANBAN_RUN: 'r_1' }`.

- [ ] **Step 4.3: Implement.** In `src/core/session-actor.ts`:
- **`SessionActorDeps`:** after `cwd: string;`, add:
  ```ts
  /** Extra environment for this session's agent, passed to every start (spec §2.4 item 3). */
  env?: Readonly<Record<string, string>> | undefined;
  ```
- **The field:** add `readonly #env: Readonly<Record<string, string>> | undefined;` next to `#cwd`.
- **The constructor:** after `this.#cwd = deps.cwd;`, add `this.#env = deps.env;`.
- **The start call:** in `this.#driver.start({ … })`, after `replay: …,`, add `env: this.#env,`.

- [ ] **Step 4.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  470 passed (470)`; `npm run typecheck` → no output.

- [ ] **Step 4.5: Commit.**

```bash
git add src/core/session-actor.ts tests/session-actor.test.ts
git commit -m "Pass a session's environment to every start of its agent"
```

---

### Task 5: A driver is built from a role's agent block

**Files:**
- Create: `src/driver/build.ts`, `tests/driver-build.test.ts`
- Modify: `src/driver/registry.ts`, `src/index.ts`

Spec §2.4 item 1. Today `src/driver/registry.ts` is a process-wide map from driver *kind* to a factory that closed over the one `agent` block, and it refuses a second registration. Two roles on `structured-cli` therefore cannot both exist. It becomes a pure function from an `AgentConfig` to a `Driver`. A `switch` over `KnownDriver` replaces the map: the compiler checks that it covers every kind, which is the job the map's "known but not implemented" message did by hand. The config already refuses an unknown driver at startup.

- [ ] **Step 5.1: Write the failing tests.** Create `tests/driver-build.test.ts`:

```ts
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import { buildDriver, buildRoleDrivers } from '../src/driver/build.js';
import type { Role } from '../src/roles.js';

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    driver: 'structured-cli',
    command: '/nonexistent/agent',
    args: [],
    env: {},
    unsupervised: true,
    passEnv: [],
    readOnlyTools: [],
    maskExempt: [],
    ...over,
  };
}

function role(name: string, a: AgentConfig): Role {
  return {
    name,
    source: 'directory',
    dir: undefined,
    description: undefined,
    workspace: undefined,
    agent: a,
    roleMdPath: undefined,
    skills: [],
    secretValues: [],
  };
}

describe('buildDriver', () => {
  it('builds the driver its kind names', () => {
    expect(buildDriver(agent({ driver: 'structured-cli' })).id).toBe('structured-cli');
    expect(buildDriver(agent({ driver: 'acp', unsupervised: false })).id).toBe('acp');
  });
});

describe('buildRoleDrivers', () => {
  it('gives two roles of one kind each their own driver, with their own command', async () => {
    // Impossible with the old process-wide registry, which refused a second
    // structured-cli. Each driver starts its own role's command, which a missing
    // binary makes visible without spawning anything.
    const drivers = buildRoleDrivers(
      new Map([
        ['implementer', role('implementer', agent({ command: '/nonexistent/implementer' }))],
        ['reviewer', role('reviewer', agent({ command: '/nonexistent/reviewer' }))],
      ]),
    );
    expect([...drivers.keys()].sort()).toEqual(['implementer', 'reviewer']);
    await expect(drivers.get('implementer')?.start({ cwd: tmpdir() })).rejects.toThrow(/implementer/);
    await expect(drivers.get('reviewer')?.start({ cwd: tmpdir() })).rejects.toThrow(/reviewer/);
  });

  it('builds a separate driver per role even when the agent blocks are equal', () => {
    const same = agent();
    const drivers = buildRoleDrivers(new Map([['a', role('a', same)], ['b', role('b', same)]]));
    expect(drivers.get('a')).not.toBe(drivers.get('b'));
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** `npx vitest run --project unit tests/driver-build.test.ts`. Expected: FAIL, because `../src/driver/build.js` cannot be resolved.

- [ ] **Step 5.3: Implement.** Create `src/driver/build.ts`:

```ts
import type { AgentConfig } from '../config.js';
import { PRODUCT_NAME } from '../identity.js';
import type { Role } from '../roles.js';
import { createAcpDriver } from './acp/driver.js';
import { createCliDriver } from './cli/driver.js';
import type { Driver } from './types.js';

/**
 * A driver per role (spec §2.4 item 1).
 *
 * Built from the role's own `agent` block -- its command, its args, and an
 * environment holding its `.env` and `passEnv` values -- so two roles on the same
 * kind of agent are two drivers that share nothing. A `switch` on the kind rather
 * than a registry: the compiler checks it covers every `KnownDriver`, and the
 * config has already refused any other value.
 */
export function buildDriver(agent: AgentConfig): Driver {
  switch (agent.driver) {
    case 'acp':
      return createAcpDriver({
        command: agent.command,
        args: agent.args,
        env: agent.env,
        clientName: PRODUCT_NAME,
      });
    case 'structured-cli':
      return createCliDriver({ command: agent.command, args: agent.args, env: agent.env });
  }
}

/** Role name → that role's driver. */
export function buildRoleDrivers(roles: ReadonlyMap<string, Role>): Map<string, Driver> {
  const out = new Map<string, Driver>();
  for (const [name, role] of roles) out.set(name, buildDriver(role.agent));
  return out;
}
```

Replace the whole of `src/driver/registry.ts` with:

```ts
/**
 * The driver kinds this gateway knows.
 *
 * Kept in its own module, with no imports, because the config, the role loader
 * and the name grammar all need the list, and none of them should load a driver
 * to get it. Building a driver is `./build.ts`.
 */
export const KNOWN_DRIVERS = ['acp', 'structured-cli'] as const;
export type KnownDriver = (typeof KNOWN_DRIVERS)[number];
```

In `src/index.ts`:
- **Imports:** remove `import { createAcpDriver } from './driver/acp/driver.js';`, `import { createCliDriver } from './driver/cli/driver.js';` and `import { getDriver, registerDriver } from './driver/registry.js';`, and add `import { buildDriver } from './driver/build.js';`. Also remove the `PRODUCT_NAME` import if nothing else in the file uses it (check with `grep -n PRODUCT_NAME src/index.ts`).
- **Registration:** replace the two `if (!getDriverSafely(…)) { registerDriver(…) }` blocks and `const driver = getDriver(agent.driver);`, together with the comment above them that begins "Registration is process-global", with:
  ```ts
  const driver = buildDriver(agent);
  ```
- **The helper:** delete `function getDriverSafely`.

- [ ] **Step 5.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  473 passed (473)`; `npm run typecheck` → no output; `git grep -n -E "registerDriver|getDriver|resetDrivers|registeredDrivers" -- src tests` → no output.

- [ ] **Step 5.5: Commit.**

```bash
git add src/driver/build.ts src/driver/registry.ts src/index.ts tests/driver-build.test.ts
git commit -m "Build a driver from a role's agent block, instead of one per kind per process"
```

---

### Task 6: A session works in the workspace it records

**Files:**
- Modify: `src/core/workspace.ts`, `src/core/registry.ts` (`actorFor`, `#create`), `src/index.ts`, `tests/registry.test.ts`, `tests/router.test.ts`
- Create: `tests/workspace.test.ts`

Spec §2.4 item 2. The provider is asked on every actor build, after an idle eviction or when a cold session comes back, so the workspace name must be durable. It is written to `sessions.workspace_id` when the session is created. An empty value, which every existing row holds, means `default`.

- [ ] **Step 6.1: Write the failing provider tests.** Create `tests/workspace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NamedWorkspaces } from '../src/core/workspace.js';

describe('NamedWorkspaces', () => {
  const provider = new NamedWorkspaces(new Map([['default', '/srv/a'], ['docs', '/srv/b']]));

  it('gives a session the directory its workspace name stands for', async () => {
    expect(await provider.acquire('s_1', 'docs')).toEqual({ id: 'docs', kind: 'plain-dir', cwd: '/srv/b' });
    expect(provider.has('docs')).toBe(true);
    expect(provider.has('gone')).toBe(false);
  });

  it('refuses a name that is no longer configured, rather than using another', async () => {
    // A workspace removed from config strands its sessions (spec §2.3); quietly
    // running them in `default` would point an agent at a different checkout.
    await expect(provider.acquire('s_1', 'gone')).rejects.toThrow(/workspace gone is not configured/);
  });
});
```

- [ ] **Step 6.2: Write the failing registry tests.** In `tests/registry.test.ts`, replace the `FakeWorkspaces` class with:

```ts
class FakeWorkspaces implements WorkspaceProvider {
  readonly kind = 'plain-dir' as const;
  readonly acquired: string[] = [];
  /** The workspace name of each acquire, in order. */
  readonly names: string[] = [];
  readonly released: string[] = [];
  readonly #known = new Set(['default', 'docs']);

  has(workspaceId: string): boolean {
    return this.#known.has(workspaceId);
  }

  async acquire(sessionId: string, workspaceId: string): Promise<Workspace> {
    this.acquired.push(sessionId);
    this.names.push(workspaceId);
    return {
      id: workspaceId,
      kind: this.kind,
      cwd: workspaceId === 'default' ? '/tmp/workspace' : `/tmp/${workspaceId}`,
    };
  }

  async release(sessionId: string): Promise<void> {
    this.released.push(sessionId);
  }
}
```

and add, inside `describe('actors', …)`:

```ts
  it('records a chat session in the workspace default, and works there', async () => {
    const h = harness();
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    expect(session.workspaceId).toBe('default');
    await h.registry.actorFor(session.id, key());
    expect(h.workspaces.names).toEqual(['default']);
  });

  it('reads the workspace from the session, with an empty one meaning default', async () => {
    // Rows written before this change hold '' (spec §2.4 item 2).
    const h = harness();
    createSession(h.db.db, { id: 's_old', agentId: 'default', workspaceId: '', ownerPrincipal: 'on_owner' }, NOW);
    createSession(h.db.db, { id: 's_docs', agentId: 'default', workspaceId: 'docs', ownerPrincipal: 'on_owner' }, NOW);
    await h.registry.actorFor('s_old', key({ conversationId: 'oc_old' }));
    await h.registry.actorFor('s_docs', key({ conversationId: 'oc_docs' }));
    expect(h.workspaces.names).toEqual(['default', 'docs']);
  });

  it('refuses a workspace that is not configured, without retiring anything to make room', async () => {
    const h = harness(1);
    const live = h.registry.bindOrCreate(key({ conversationId: 'oc_live' }), OWNER).session;
    await h.registry.actorFor(live.id, key({ conversationId: 'oc_live' }));
    createSession(h.db.db, { id: 's_nows', agentId: 'default', workspaceId: 'gone', ownerPrincipal: 'on_owner' }, NOW);
    await expect(h.registry.actorFor('s_nows', key({ conversationId: 'oc_nows' }))).rejects.toThrow(
      /works in workspace gone, which is not configured/,
    );
    expect(h.registry.liveActor(live.id)).toBeDefined();
  });
```

In `tests/router.test.ts`, change that file's `FakeWorkspaces` to the new interface:

```ts
class FakeWorkspaces implements WorkspaceProvider {
  readonly kind = 'plain-dir' as const;

  has(workspaceId: string): boolean {
    return workspaceId === 'default';
  }

  async acquire(sessionId: string, workspaceId: string): Promise<Workspace> {
    void sessionId;
    return { id: workspaceId, kind: this.kind, cwd: '/tmp/workspace' };
  }

  async release(sessionId: string): Promise<void> {
    void sessionId;
  }
}
```

- [ ] **Step 6.3: Run them to verify they fail.** Run: `npx vitest run --project unit tests/workspace.test.ts tests/registry.test.ts`. Expected:
  - `workspace.test.ts` FAILS, because `NamedWorkspaces` is not exported;
  - the three new registry tests FAIL: `expected '' to be 'default'`, `names` holding `undefined`, and the unconfigured workspace not refused.

- [ ] **Step 6.4: Implement the provider.** In `src/core/workspace.ts`:
  - **`Workspace.id`:** change the doc comment to `/** The workspace's name: its row in the workspaces table (spec §2.3). */`.
  - **`WorkspaceProvider`:** replace it with:

```ts
export interface WorkspaceProvider {
  readonly kind: Workspace['kind'];
  /** Whether a workspace of this name is configured. */
  has(workspaceId: string): boolean;
  /** The workspace a session recorded, by name. Throws for a name no longer configured. */
  acquire(sessionId: string, workspaceId: string): Promise<Workspace>;
  /** Idempotent, and must not throw. Nothing may depend on it having run. */
  release(sessionId: string): Promise<void>;
}
```

  - **The class:** replace `PlainDirWorkspaces` with `NamedWorkspaces`, keeping its "shared working tree" doc paragraph but saying "each session works in the named workspace it records, and a workspace is one configured directory", and keeping `release`'s comment as it is:

```ts
export class NamedWorkspaces implements WorkspaceProvider {
  readonly kind = 'plain-dir' as const;
  readonly #paths: ReadonlyMap<string, string>;

  /**
   * @param paths Workspace name → real path, as `loadTeam` resolved and checked
   *   them at startup. Resolved once, there: a symlink swapped in later cannot
   *   redirect an agent with write access to a different tree.
   */
  constructor(paths: ReadonlyMap<string, string>) {
    this.#paths = paths;
  }

  has(workspaceId: string): boolean {
    return this.#paths.has(workspaceId);
  }

  async acquire(_sessionId: string, workspaceId: string): Promise<Workspace> {
    const cwd = this.#paths.get(workspaceId);
    if (cwd === undefined) throw new Error(`workspace ${workspaceId} is not configured`);
    return { id: workspaceId, kind: this.kind, cwd };
  }

  async release(_sessionId: string): Promise<void> {
    // (keep the existing comment)
  }
}
```

  - **Imports:** remove those that are now unused (`realpath`, `stat`, `isAbsolute`, `createHash`).

- [ ] **Step 6.5: Implement the registry side.** In `src/core/registry.ts`:
  - **Imports:** add `KNOWN_DRIVERS` from `'../driver/registry.js'`. Below the `NON_TERMINAL` constant, add the two names and the two readers. The role reader is used in Task 7, and is added now so both rules sit together:

```ts
/** What a chat session runs as, and where (spec §2.4). */
export const DEFAULT_ROLE = 'default';
export const DEFAULT_WORKSPACE = 'default';

/**
 * A session's role, from `sessions.agent_id`. Rows written before roles existed
 * hold a driver id (`acp`, `structured-cli`) and mean the role default -- which is
 * why driver ids are reserved as role names.
 */
export function roleOfSession(agentId: string): string {
  return agentId === '' || (KNOWN_DRIVERS as readonly string[]).includes(agentId) ? DEFAULT_ROLE : agentId;
}

/** A session's workspace name, from `sessions.workspace_id`; rows written before hold ''. */
export function workspaceOfSession(workspaceId: string): string {
  return workspaceId === '' ? DEFAULT_WORKSPACE : workspaceId;
}
```

  - **`actorFor`:** replace `const workspace = await this.#deps.workspaces.acquire(sessionId);` with the code below. The session is read before `#makeRoom`, so that a refusal cannot evict another session's actor first. The `#makeRoom()` call itself stays where it is:

```ts
    const session = getSession(this.#deps.db, sessionId);
    if (session === undefined) throw new Error(`no session ${sessionId}`);
```

```ts
    const workspaceId = workspaceOfSession(session.workspaceId);
    if (!this.#deps.workspaces.has(workspaceId)) {
      throw new Error(`session ${sessionId} works in workspace ${workspaceId}, which is not configured`);
    }
```

    Place both before `await this.#makeRoom();`. Every refusal comes before room is made, so a session that cannot run never retires one that can. After `#makeRoom`:

```ts
    const workspace = await this.#deps.workspaces.acquire(sessionId, workspaceId);
```

  - **`#create`:** replace
    ```ts
        // The workspace id is filled in when the actor acquires one. Recording a
        // guess here would make the column lie for the window before first use.
        workspaceId: '',
    ```
    with
    ```ts
        // The name, recorded now: the provider is asked again on every actor
        // build, so the session must remember where it works (spec §2.4 item 2).
        workspaceId: DEFAULT_WORKSPACE,
    ```

In `src/index.ts`, change the import of `PlainDirWorkspaces` to `NamedWorkspaces`, and `workspaces: new PlainDirWorkspaces(defaultWorkspace),` to `workspaces: new NamedWorkspaces(team.workspaces),`.

- [ ] **Step 6.6: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  478 passed (478)`; `npm run typecheck` → no output.

- [ ] **Step 6.7: Commit.**

```bash
git add src/core/workspace.ts src/core/registry.ts src/index.ts tests/workspace.test.ts tests/registry.test.ts tests/router.test.ts
git commit -m "Record a session's workspace by name, and work in it on every rebuild"
```

---

### Task 7: A session runs as the role it records

**Files:**
- Modify: `src/core/registry.ts` (`SessionRegistryDeps`, `actorFor`, `#create`), `src/index.ts`, `tests/registry.test.ts`, `tests/router.test.ts`

Spec §2.4 item 1:
- `SessionRegistryDeps.driver` becomes `drivers`, a map from role name to driver, which must hold `default`;
- `sessions.agent_id` records the role name;
- a chat session records `default`, whether that role comes from `roles/default/` or from the `agent:` block.

- [ ] **Step 7.1: Update the harnesses and write the failing tests.** In `tests/registry.test.ts`:
  - **The `harness` signature:** change it to `function harness(maxLive = DEFAULT_MAX_LIVE, extra: { drivers?: Record<string, FakeDriver> } = {}): Harness`.
  - **The deps:** replace `driver,` in the `new SessionRegistry({…})` deps with:
    ```ts
    drivers: new Map<string, FakeDriver>([['default', driver], ...Object.entries(extra.drivers ?? {})]),
    ```
  - **The import:** add `import { roleOfSession } from '../src/core/registry.js';` to the existing registry import.

  Then add, inside `describe('actors', …)`:

```ts
  it('records a chat session as the role default', () => {
    const h = harness();
    expect(h.registry.bindOrCreate(key(), OWNER).session.agentId).toBe('default');
  });

  it('runs a session written before roles, under a driver id or none, as the role default', async () => {
    // The live database's one session says `acp` while the default role now runs
    // bytesec: a driver id means the role default, whatever that role runs today.
    expect(['acp', 'structured-cli', ''].map(roleOfSession)).toEqual(['default', 'default', 'default']);
    const h = harness();
    createSession(h.db.db, { id: 's_acp', agentId: 'acp', workspaceId: '', ownerPrincipal: 'on_owner' }, NOW);
    const actor = await h.registry.actorFor('s_acp', key({ conversationId: 'oc_acp' }));
    await actor.submit({ messageId: 'om_acp', appId: 'cli_app', input: { text: 'hi', paths: [] } });
    expect(h.driver.starts).toHaveLength(1);
  });

  it("starts a session with its own role's driver", async () => {
    const reviewer = new FakeDriver('reviewer');
    const h = harness(DEFAULT_MAX_LIVE, { drivers: { reviewer } });
    createSession(h.db.db, { id: 's_rev', agentId: 'reviewer', workspaceId: 'docs', ownerPrincipal: 'on_owner' }, NOW);
    const actor = await h.registry.actorFor('s_rev', key({ conversationId: 'oc_rev' }));
    await actor.submit({ messageId: 'om_rev', appId: 'cli_app', input: { text: 'hi', paths: [] } });
    expect(reviewer.starts.map((s) => s.cwd)).toEqual(['/tmp/docs']);
    expect(h.driver.starts).toHaveLength(0);
  });

  it('refuses a role that is not configured, without retiring anything to make room', async () => {
    // A role removed from config strands its sessions; running them as default
    // would hand one role's work to another role's agent and credentials.
    const h = harness(1);
    const live = h.registry.bindOrCreate(key({ conversationId: 'oc_live' }), OWNER).session;
    await h.registry.actorFor(live.id, key({ conversationId: 'oc_live' }));
    createSession(h.db.db, { id: 's_gone', agentId: 'gone', workspaceId: '', ownerPrincipal: 'on_owner' }, NOW);
    await expect(h.registry.actorFor('s_gone', key({ conversationId: 'oc_gone' }))).rejects.toThrow(
      /session s_gone runs as role gone, which is not configured/,
    );
    expect(h.registry.liveActor(live.id)).toBeDefined();
  });
```

In `tests/router.test.ts`, replace `driver,` in its `new SessionRegistry({…})` deps with `drivers: new Map([['default', driver]]),`.

- [ ] **Step 7.2: Run them to verify they fail.** `npx vitest run --project unit tests/registry.test.ts`. Expected: most of the file FAILS with `Cannot read properties of undefined (reading 'id')`, because `#create` still reads `this.#deps.driver` while the harness now passes `drivers`. The four new tests are among the failures.

- [ ] **Step 7.3: Implement.** In `src/core/registry.ts`:
  - **`SessionRegistryDeps`:** replace `driver: Driver;` with:

```ts
  /** Role name → that role's driver. Must hold `default` (spec §2.4 item 1). */
  drivers: ReadonlyMap<string, Driver>;
```

  - **`actorFor`:** after the `getSession` lookup added in Task 6, and still before `#makeRoom`, add:

```ts
    const role = roleOfSession(session.agentId);
    const driver = this.#deps.drivers.get(role);
    if (driver === undefined) {
      throw new Error(`session ${sessionId} runs as role ${role}, which is not configured`);
    }
```

    In the `new SessionActor({…})` deps, change `driver: this.#deps.driver,` to `driver,`.

  - **`#create`:** change `agentId: this.#deps.driver.id,` to:

```ts
        // The role, not the driver: the registry rebuilds this session's driver
        // from it (spec §2.4 item 1).
        agentId: DEFAULT_ROLE,
```

In `src/index.ts`:
- **Imports:** change the `buildDriver` import to `import { buildRoleDrivers } from './driver/build.js';`.
- **Building the drivers:** replace `const driver = buildDriver(agent);` with:
  ```ts
  const drivers = buildRoleDrivers(team.roles);
  ```
  Then replace the `if (agent.unsupervised) { … note(…) }` block with a loop over every role. It keeps the existing comment, and its wording now names the role:

```ts
  for (const [name, role] of [...team.roles].sort(([a], [b]) => a.localeCompare(b))) {
    if (!role.agent.unsupervised) continue;
    // (keep the existing comment)
    note(`role ${name} (${role.agent.driver}): the agent acts without approval cards (agent.unsupervised is set)`);
  }
```

- **The registry deps:** in `new SessionRegistry({…})`, replace `driver,` with `drivers,`.
- **The stale comment:** replace the comment above `const defaultRole` ("Until plan B2 gives each session its own role and workspace, …") with `// Chat sessions run the role default in the workspace default; loadTeam guarantees both exist.`
- **Unused bindings:** remove `const agent = defaultRole.agent;` if nothing else uses it. Keep the `defaultRole` check: it is what refuses to start without a role default.

- [ ] **Step 7.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  482 passed (482)`; `npm run typecheck` → no output.

- [ ] **Step 7.5: Commit.**

```bash
git add src/core/registry.ts src/index.ts tests/registry.test.ts tests/router.test.ts
git commit -m "Run each session as the role it records, with that role's own driver"
```

---

### Task 8: A channel per binding, a session's environment, and seeded creation

**Files:**
- Modify: `src/core/registry.ts`, `src/index.ts`, `tests/registry.test.ts`, `tests/router.test.ts`

Spec §2.4 items 3, 4 and 5:
- **Channels:** `channel` and `channelId` are replaced by `channels`, a map from a binding's `channel` id to the channel a session bound there posts through. `channelId` is not read anywhere in the registry today.
- **Environment:** a new optional `envFor(sessionId)` is asked on every actor build. Plan C's dispatcher answers it.
- **Creation:** a public `create(key, owner, { role, workspace, seedProviderSessionId })` makes a session that is not a chat's default. It refuses a role or workspace that is not configured.

- [ ] **Step 8.1: Update the harnesses and write the failing tests.** In `tests/registry.test.ts`:
  - **`extra`:** extend the harness's second parameter to `{ drivers?: Record<string, FakeDriver>; channels?: Record<string, FakeChannel>; envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined }`.
  - **The deps:** replace `channel,` and `channelId: 'lark',` with:
    ```ts
    channels: new Map<string, FakeChannel>([['lark', channel], ...Object.entries(extra.channels ?? {})]),
    ...(extra.envFor === undefined ? {} : { envFor: extra.envFor }),
    ```

  Then add a new `describe`:

```ts
describe('sessions beyond chat', () => {
  it('posts through the channel the session is bound on', async () => {
    // A run's session posts through the kanban sink, a chat's through Lark (spec §2.4 item 4).
    const kanban = new FakeChannel({ id: 'kanban' });
    const h = harness(DEFAULT_MAX_LIVE, { channels: { kanban } });
    const at = key({ channel: 'kanban', conversationId: 'run_1' });
    const session = h.registry.bindOrCreate(at, OWNER).session;
    const actor = await h.registry.actorFor(session.id, at);
    await actor.submit({ messageId: 'om_k', appId: 'cli_app', input: { text: 'hi', paths: [] } });
    // The card writer coalesces; flush so the write has happened before looking.
    await actor.flushCard();
    expect(kanban.calls.length).toBeGreaterThan(0);
    expect(h.channel.calls).toEqual([]);
  });

  it('refuses a binding on a channel this gateway does not run', async () => {
    const h = harness();
    const at = key({ channel: 'slack' });
    const session = h.registry.bindOrCreate(at, OWNER).session;
    await expect(h.registry.actorFor(session.id, at)).rejects.toThrow(
      /bound on channel slack, which this gateway does not run/,
    );
  });

  it('asks for the session environment on every build, and passes it to the start', async () => {
    const asked: string[] = [];
    const h = harness(DEFAULT_MAX_LIVE, {
      envFor: (sessionId) => {
        asked.push(sessionId);
        return { MT_KANBAN_RUN: 'r_1' };
      },
    });
    const session = h.registry.bindOrCreate(key(), OWNER).session;
    const actor = await h.registry.actorFor(session.id, key());
    await actor.submit({ messageId: 'om_e', appId: 'cli_app', input: { text: 'hi', paths: [] } });
    expect(asked).toEqual([session.id]);
    expect(h.driver.starts[0]?.env).toEqual({ MT_KANBAN_RUN: 'r_1' });
  });

  it('creates a session as a role, in a workspace, seeded from another session', async () => {
    // Review rework resumes the implementer's conversation (spec §2.4 item 5).
    const reviewer = new FakeDriver('reviewer');
    const h = harness(DEFAULT_MAX_LIVE, { drivers: { reviewer } });
    const at = key({ conversationId: 'oc_rework' });
    const session = h.registry.create(at, OWNER, {
      role: 'reviewer',
      workspace: 'docs',
      seedProviderSessionId: 'prov_impl',
    });
    expect([session.agentId, session.workspaceId, session.providerSessionId]).toEqual(['reviewer', 'docs', 'prov_impl']);
    expect(resolveBinding(h.db.db, at)?.sessionId).toBe(session.id);

    const actor = await h.registry.actorFor(session.id, at);
    await actor.submit({ messageId: 'om_r', appId: 'cli_app', input: { text: 'hi', paths: [] } });
    expect(reviewer.starts[0]).toMatchObject({ cwd: '/tmp/docs', providerSessionId: 'prov_impl' });
  });

  it('refuses to create a session as a role or in a workspace that is not configured', () => {
    const h = harness();
    expect(() => h.registry.create(key({ conversationId: 'oc_x' }), OWNER, { role: 'gone' })).toThrow(
      /role gone is not configured/,
    );
    expect(() => h.registry.create(key({ conversationId: 'oc_y' }), OWNER, { workspace: 'gone' })).toThrow(
      /workspace gone is not configured/,
    );
    expect(resolveBinding(h.db.db, key({ conversationId: 'oc_x' }))).toBeUndefined();
  });
});
```

If `FakeChannel`'s constructor takes `id` differently, check `tests/helpers/channel.ts` (`constructor(opts: { id?: string; clock?: Clock })`) and adapt.

In `tests/router.test.ts`, replace `channel,` and `channelId: CHANNEL,` in the **`SessionRegistry`** deps, and only there, with `channels: new Map([[CHANNEL, channel]]),`. The `Router` deps keep their own `channel` and `channelId`.

- [ ] **Step 8.2: Run them to verify they fail.** `npx vitest run --project unit tests/registry.test.ts`. Expected: FAIL, because `create` is not a function and the posting goes to the Lark fake.

- [ ] **Step 8.3: Implement.** In `src/core/registry.ts`:
  - **`SessionRegistryDeps`:** replace `channel: Channel;` and the `channelId` field and its comment with:

```ts
  /**
   * A binding's channel id → the channel a session bound there posts through:
   * `lark` for chat, `kanban` for a run's sink (spec §2.4 item 4).
   */
  channels: ReadonlyMap<string, Channel>;
  /**
   * Extra environment for a session's agent, asked on every actor build (spec
   * §2.4 item 3). Plan C's dispatcher holds a run's environment in memory only.
   */
  envFor?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
```

  - **The creation options:** add an exported interface above the class:

```ts
/** How a session other than a chat's default is created. */
export interface NewSession {
  /** Default `default`. */
  role?: string;
  /** Default `default`. */
  workspace?: string;
  /**
   * Another session's observed provider session id, passed as a hint (spec §2.4
   * item 5). The driver resumes from it if it can and otherwise starts fresh;
   * whatever the agent then reports replaces it.
   */
  seedProviderSessionId?: string;
}
```

  - **`actorFor`:** after the driver lookup, and still before `#makeRoom`, add:

```ts
    const channel = this.#deps.channels.get(key.channel);
    if (channel === undefined) {
      throw new Error(`session ${sessionId} is bound on channel ${key.channel}, which this gateway does not run`);
    }
```

    After the workspace is acquired, add `const env = this.#deps.envFor?.(sessionId);`. In the `SessionActor` deps, change `channel: this.#deps.channel,` to `channel,` and add `...(env === undefined ? {} : { env }),`.

  - **`create`:** add a public method after `attach`:

```ts
  /**
   * Create and bind a session as a role, in a workspace, optionally seeded.
   *
   * For sessions a chat does not create itself -- a run's, a rework's. Refuses a
   * role or workspace that is not configured before anything is written, so a
   * refused create leaves no session and no binding behind.
   */
  create(key: BindingKey, owner: Principal, opts: NewSession = {}): SessionRow {
    const role = opts.role ?? DEFAULT_ROLE;
    const workspace = opts.workspace ?? DEFAULT_WORKSPACE;
    if (!this.#deps.drivers.has(role)) throw new Error(`role ${role} is not configured`);
    if (!this.#deps.workspaces.has(workspace)) throw new Error(`workspace ${workspace} is not configured`);
    return this.#create(key, owner, this.#clock.now(), { role, workspace, seed: opts.seedProviderSessionId });
  }
```

  - **`#create`:** change it to take the options. Its two existing callers, `bindOrCreate` and `rotate`, pass `{ role: DEFAULT_ROLE, workspace: DEFAULT_WORKSPACE, seed: undefined }`:

```ts
  #create(
    key: BindingKey,
    owner: Principal,
    now: number,
    opts: { role: string; workspace: string; seed: string | undefined },
  ): SessionRow {
    const session = createSession(
      this.#deps.db,
      {
        id: newSessionId(),
        // (keep the Task 7 comment)
        agentId: opts.role,
        // (keep the Task 6 comment)
        workspaceId: opts.workspace,
        ownerPrincipal: owner.unionId ?? owner.openId,
        ...(opts.seed === undefined ? {} : { providerSessionId: opts.seed }),
      },
      now,
    );
```

    In its `session_created` event payload, add `role: opts.role, workspace: opts.workspace, seeded: opts.seed !== undefined,` after `owner: session.ownerPrincipal,`. The seed itself is left out: the log records that a session was seeded, and the session row holds the id.

In `src/index.ts`, replace `channel: adapter,` and `channelId: adapter.id,` in the `new SessionRegistry({…})` deps, and only there, with:

```ts
    // Lark only, until plan C adds the kanban sink.
    channels: new Map([[adapter.id, adapter]]),
```

- [ ] **Step 8.4: Run the tests.** `npm test 2>&1 | tail -4` → `Tests  487 passed (487)`; `npm run typecheck` → no output.

- [ ] **Step 8.5: Commit.**

```bash
git add src/core/registry.ts src/index.ts tests/registry.test.ts tests/router.test.ts
git commit -m "Post through the binding's channel, pass a session's environment, and create seeded sessions"
```

---

### Task 9: Startup registers the workspaces; cleanup from the B1 review

**Files:**
- Modify: `src/index.ts`, `src/config.ts`, `src/roles.ts`, `tests/config.test.ts`

Three changes:
- **Registration:** at startup each configured workspace is registered right after the migration. A moved name is a configuration error (exit 78). The database is closed before the error is thrown.
- **`workspaceDir`:** `GatewayConfig.workspaceDir` is only read by tests now, and it holds the *declared* path rather than the real one, so it goes.
- **Args parsing:** the list-or-string parsing of `agent.args` is duplicated in `config.ts` and `roles.ts`, and becomes one exported helper.

- [ ] **Step 9.1: Register at startup.** In `src/index.ts`:
  - **Imports:** add `import { registerWorkspaces } from './db/workspaces.js';`, and add `ConfigError` to the `./config.js` import: `import { ConfigError, loadConfig, type GatewayConfig } from './config.js';`.
  - **The registration:** after `note(\`schema at version ${version}\`);`, add:

```ts
  // Before anything can open a session in one. A name whose directory moved would
  // orphan the provider sessions opened there (spec §2.3).
  const registered = registerWorkspaces(db, team.workspaces, systemClock.now());
  if ('error' in registered) {
    db.close();
    throw new ConfigError(registered.error);
  }
  if (registered.added.length > 0) note(`workspaces registered: ${registered.added.join(', ')}`);
```

  There is no unit test for this wiring: `createGateway` connects to Lark. Task 1 covers `registerWorkspaces`, and Task 10's check exercises it against a copy of the live database.

- [ ] **Step 9.2: Drop `workspaceDir`.** Change these tests first, so the change is driven by them. In `tests/config.test.ts`, replace every `expect(cfg.workspaceDir).toBe(X)` (six places; `grep -n workspaceDir tests/config.test.ts`) with `expect(cfg.workspaces['default']).toBe(X)`. Then, in `src/config.ts`:
  - **The interface:** remove `workspaceDir: string;` and its comment from `GatewayConfig`.
  - **The local:** rename `const workspaceDir =` to `const defaultWorkspace =`. Keep its "a workspace is required" `fail(…)` and the absolute-path check, with their messages unchanged.
  - **The returned object:** remove `workspaceDir,` from it.

  Run `git grep -n workspaceDir -- src tests`. Expected: no output.

- [ ] **Step 9.3: One `agentArgs`.** In `src/config.ts`, add, next to `shellWords`:

```ts
/** `agent.args`: a list, or one string split like a shell would, because `args: --acp --debug` is what people write. */
export function agentArgs(path: string, raw: unknown): readonly string[] {
  return Array.isArray(raw) ? strings(path, 'agent.args', raw) : shellWords(str(path, 'agent.args', raw) ?? '');
}
```

Then make the two call sites use it:
- **In `config.ts`:** replace the comment `// A list or one string, because ...` and its `args: Array.isArray(agentRaw['args']) ? … : …,` expression with `args: agentArgs(path, agentRaw['args']),`.
- **In `roles.ts`:** replace the `const args = Array.isArray(agentRaw['args']) ? … : …;` expression with `const args = agentArgs(configPath, agentRaw['args']);`. Add `agentArgs` to its `./config.js` import, and drop `shellWords` from that import if nothing else in `roles.ts` uses it.

- [ ] **Step 9.4: Run everything.** `npm test 2>&1 | tail -4` → `Tests  487 passed (487)`; `npm run test:e2e 2>&1 | tail -4` → `Tests  49 passed (49)`; `npm run typecheck` → no output.

- [ ] **Step 9.5: Commit.**

```bash
git add src/index.ts src/config.ts src/roles.ts tests/config.test.ts
git commit -m "Register the workspaces at startup, and drop the declared-path setting"
```

---

### Task 10: README, and a read-only check against a copy of the live database

**Files:**
- Modify: `README.md` (the "### Roles and workspaces" section)

- [ ] **Step 10.1: README.** In "### Roles and workspaces", directly after the paragraph that ends "Everything here is checked at startup.", add:

```markdown
A workspace's name keeps the directory it was first used with: the gateway records it, and
if the config later points that name somewhere else it will not start. Sessions opened in a
directory belong to it, and moving them would orphan them. To use another directory, give
it a new name.
```

Then, in the sentence "In this build every chat session runs the role `default` in the workspace `default`; other roles are loaded and checked at startup, and run once tasks arrive.", keep it as written. It is still true.

Rewrap to the README's line width. Commit:

```bash
git add README.md
git commit -m "Say that a workspace name keeps its directory"
```

- [ ] **Step 10.2: Check against a copy of the live database (read-only).** This must not touch `~/.manus-team/gateway.db` itself. `.backup` takes a consistent copy even while the live gateway is writing.

```bash
cd /Users/x/Develop/manus/prime-gateway-work
export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH
CHECK=$(mktemp -d)
sqlite3 -readonly ~/.manus-team/gateway.db ".backup '$CHECK/gateway.db'"
LARK_APP_SECRET=placeholder CHECK="$CHECK" npx tsx -e "
import { loadConfig } from './src/config.ts';
import { loadTeam } from './src/team.ts';
import { openDb, migrate } from './src/db/open.ts';
import { registerWorkspaces } from './src/db/workspaces.ts';
import { roleOfSession, workspaceOfSession } from './src/core/registry.ts';
import { buildRoleDrivers } from './src/driver/build.ts';
const c = loadConfig();
const t = loadTeam(c, process.env);
const db = openDb(process.env.CHECK + '/gateway.db');
migrate(db, c.schemaDir);
console.log('first', JSON.stringify(registerWorkspaces(db, t.workspaces, Date.now())));
console.log('again', JSON.stringify(registerWorkspaces(db, t.workspaces, Date.now())));
const drivers = buildRoleDrivers(t.roles);
for (const s of db.prepare('SELECT id, agent_id, workspace_id FROM sessions').all()) {
  const role = roleOfSession(s.agent_id);
  console.log('session', s.id, JSON.stringify(s.agent_id), '->', role, drivers.get(role)?.id, workspaceOfSession(s.workspace_id), t.workspaces.get(workspaceOfSession(s.workspace_id)));
}
db.close();
"
rm -rf "$CHECK"
```

Expected (one session today):
```
first {"ok":true,"added":["default"]}
again {"ok":true,"added":[]}
session s_r0tygt878c9x1ts1 "acp" -> default structured-cli default /Users/x/Develop/manus/bytesec-agents
```

That is, the old `acp` session runs as the role `default`, today bytesec through `structured-cli`, in the `bytesec-agents` checkout. Nothing about the live database or the live gateway changes. When this branch is merged, the restarted gateway registers `default` in the real table, once.

- [ ] **Step 10.3: Report, without merging.** Merging into the main checkout restarts the live gateway. That is the controller's step, after asking the user, and only when no turn is open.

---

## Done when

- `npm test` → `Tests  487 passed (487)`, `npm run test:e2e` → `Tests  49 passed (49)`, and `npm run typecheck` prints nothing, all under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` → no output.
- `git grep -n -E "registerDriver|getDriver|PlainDirWorkspaces|workspaceDir" -- src tests` → no output.
- Task 10's check prints the expected three lines.
