# Plan F — Masking the secrets the gateway knows: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every secret value the gateway holds itself is shown as `••••` everywhere it would otherwise reach chat, the event log or the approvals table. Those secrets are the Lark app secret and the environment values it passes to agents.

**Architecture:**
- **The registry.** A process-wide registry of known secrets lives in `src/secrets.ts`. It ignores values shorter than 8 characters. Its one masking function is `redactKnownSecrets`.
- **Layer 1, the escapers.** `forDisplay`, `forMarkdown` and `forPlainText` mask before they escape. This is the authoritative layer for chat.
- **Streaming cards.** A card re-renders as an answer streams in, so a secret can arrive in two pieces. `renderCard` therefore masks the joined answer and drops any trailing text that is the start of a secret.
- **Layer 3, writes.** `appendEvents` and `createApproval` mask string values in their payloads before storing them. Identifying fields are left alone, and so is a person's `turn_submitted` input.
- **Startup.** The registry is filled when the gateway starts.

The registry is shaped so that plan C can add and remove worker tokens later.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest.

**Spec:** `docs/specs/2026-11-02-kanban-design.md` §10.1, and the F row of §12.

---

## Ground rules

- **Where to work.**
  - Use the worktree `/Users/x/Develop/manus/prime-gateway-work`, on branch `masking`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`: the live gateway runs there.
  - Never start the gateway, and never write to `~/.manus-team`.
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Secrets.** Never print secret values. Tests use made-up values only.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command.
- **Baseline.** `npm test` gives `Tests  541 passed (541)`. `npm run test:e2e` gives `Tests  49 passed (49)`. `npm run typecheck` prints nothing.
- **Finding edits.** Find each edit by its quoted text, not by line number.
- **The registry is process-wide state.** vitest isolates each test file in its own module graph, so state does not leak between files. Every test file that touches the registry calls `clearSecrets()` in a `beforeEach`.

## Out of scope (plan C)

- **Worker tokens.** C adds and removes them through `addSecrets` and `removeSecrets` when a run is claimed and when it closes.
- **Layer 2.** C masks the composed worker context and `last_output`.
- **Kanban writes.** C masks free text and `kanban_events` on write.
- **Gates.** C refuses gates whose command contains a known secret.

## File structure

| File | Responsibility |
|---|---|
| `src/secrets.ts` (create) | the registry, `redactKnownSecrets`, `withholdSecretPrefix`, `redactValues` |
| `src/channel/escape.ts` (modify) | the three escapers mask first |
| `src/channel/render.ts` (modify) | `renderCard` masks the joined answer and withholds a trailing secret prefix |
| `src/db/events.ts`, `src/db/approvals.ts` (modify) | mask payloads on write |
| `src/roles.ts`, `src/team.ts` (modify) | `Role.secretValues` honours `maskExempt` |
| `src/index.ts` (modify) | fill the registry at startup; the operator log is masked |
| `docs/architecture.md`, `README.md` (modify) | "pure given the secret set"; what is masked |
| `tests/secrets.test.ts` (create); `tests/escape.test.ts`, `tests/render.test.ts`, `tests/db.test.ts`, `tests/roles.test.ts`, `tests/team.test.ts`, `tests/gateway-startup.test.ts` (modify) | |

---

### Task 1: The registry and `redactKnownSecrets`

**Files:**
- Create: `src/secrets.ts`, `tests/secrets.test.ts`

- [ ] **Step 1.1: Write the failing tests.** Create `tests/secrets.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MASK,
  addSecrets,
  clearSecrets,
  redactKnownSecrets,
  redactValues,
  removeSecrets,
  withholdSecretPrefix,
} from '../src/secrets.js';

beforeEach(() => clearSecrets());

describe('redactKnownSecrets', () => {
  it('replaces every occurrence of a known secret', () => {
    addSecrets(['sk-test-123456']);
    expect(redactKnownSecrets('a sk-test-123456 b sk-test-123456')).toBe(`a ${MASK} b ${MASK}`);
  });

  it('ignores values shorter than 8 characters, which are not secrets', () => {
    addSecrets(['true', '1', 'short7!']);
    expect(redactKnownSecrets('true 1 short7!')).toBe('true 1 short7!');
  });

  it('masks the longer of two overlapping secrets whole', () => {
    addSecrets(['abcdefgh', 'abcdefgh-longer']);
    expect(redactKnownSecrets('x abcdefgh-longer y')).toBe(`x ${MASK} y`);
  });

  it('stops masking a secret once it is removed', () => {
    addSecrets(['token-abcdefgh']);
    removeSecrets(['token-abcdefgh']);
    expect(redactKnownSecrets('token-abcdefgh')).toBe('token-abcdefgh');
  });
});

describe('withholdSecretPrefix', () => {
  it('drops trailing text that is the start of a secret, four characters or longer', () => {
    addSecrets(['sk-test-123456']);
    expect(withholdSecretPrefix('the key is sk-te')).toBe('the key is ');
    expect(withholdSecretPrefix('the key is sk-')).toBe('the key is sk-');
    expect(withholdSecretPrefix('nothing here')).toBe('nothing here');
  });
});

describe('redactValues', () => {
  it('masks string values at any depth, value by value, and leaves identifying keys alone', () => {
    addSecrets(['secret-"quoted"-value']);
    const out = redactValues({
      approvalId: 'secret-"quoted"-value',
      message: 'got secret-"quoted"-value',
      nested: { list: ['secret-"quoted"-value', 3, true, null] },
    });
    expect(out).toEqual({
      approvalId: 'secret-"quoted"-value',
      message: `got ${MASK}`,
      nested: { list: [MASK, 3, true, null] },
    });
  });

  it('returns the input untouched when no secret is known', () => {
    const payload = { message: 'anything' };
    expect(redactValues(payload)).toBe(payload);
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/secrets.test.ts`. Expected: FAIL, because `../src/secrets.js` cannot be resolved.

- [ ] **Step 1.3: Implement.** Create `src/secrets.ts`:

```ts
/**
 * The secrets the gateway knows, masked wherever they would leave it (spec §10.1).
 *
 * What the registry holds:
 * - the Lark app secret;
 * - every environment value given to an agent, except names its role lists in
 *   maskExempt;
 * - from plan C, every live worker token.
 *
 * It is process-wide on purpose. The escapers and the renderer are pure functions,
 * and threading a secret set through every call site would put it at the mercy of
 * the one site that forgets. So the projection is pure *given the secret set*, and
 * tests set the set explicitly.
 *
 * Exact matches only. A secret the agent found by itself, a known secret encoded
 * or reformatted, and anything shorter than MIN_SECRET_LENGTH are not caught.
 *
 * This is not `mask()` in channel/escape.ts. That one shows a secret's prefix in a
 * render that means to show the secret.
 */

export const MASK = '••••';

/** Shorter values are not secrets: masking `1` or `true` would mangle ordinary text. */
export const MIN_SECRET_LENGTH = 8;

/** A trailing fragment shorter than this is too common to be worth withholding. */
const MIN_PREFIX_LENGTH = 4;

/**
 * Keys whose values identify rather than say something. They are left alone, as
 * identifying columns are: masking an id would break the lookups that use it.
 */
const IDENTIFYING_KEYS: ReadonlySet<string> = new Set([
  'approvalId',
  'toolCallId',
  'requestId',
  'optionId',
  'optionIds',
  'messageId',
  'replyTo',
  'turnId',
  'sessionId',
  'idempotencyKey',
]);

const secrets = new Set<string>();
/** Longest first, so a secret containing another is masked whole. Rebuilt on change. */
let ordered: string[] = [];

function reorder(): void {
  ordered = [...secrets].sort((a, b) => b.length - a.length);
}

export function addSecrets(values: Iterable<string>): void {
  for (const value of values) if (value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  reorder();
}

export function removeSecrets(values: Iterable<string>): void {
  for (const value of values) secrets.delete(value);
  reorder();
}

/** Test-only: the registry is process-wide. */
export function clearSecrets(): void {
  secrets.clear();
  reorder();
}

/** Every exact occurrence of a known secret, replaced with MASK. */
export function redactKnownSecrets(text: string): string {
  let out = text;
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  return out;
}

/**
 * Drop trailing text that is the start of a known secret.
 *
 * A card re-renders while an answer streams in, so a secret whose first chunk has
 * arrived would briefly show as a prefix. Mid-stream the fragment reappears,
 * masked, once the rest arrives. On a final render the turn ended part-way through
 * a secret, and dropping the fragment is the right outcome.
 *
 * Apply this to text that has already been through redactKnownSecrets. Otherwise
 * the tail of a complete secret could be cut, leaving it unmatched.
 */
export function withholdSecretPrefix(text: string): string {
  let cut = 0;
  for (const secret of ordered) {
    for (let n = Math.min(secret.length - 1, text.length); n >= MIN_PREFIX_LENGTH; n -= 1) {
      if (n > cut && text.endsWith(secret.slice(0, n))) {
        cut = n;
        break;
      }
    }
  }
  return cut === 0 ? text : text.slice(0, text.length - cut);
}

/**
 * Mask the string values of a JSON-shaped payload, value by value. Serialized
 * text is not masked, because JSON escaping changes a secret containing `"` or
 * `\` so that it no longer matches. Values under IDENTIFYING_KEYS are left alone.
 * Returns the input itself when there is nothing to mask.
 */
export function redactValues(value: unknown): unknown {
  if (ordered.length === 0) return value;
  return walk(value);
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return redactKnownSecrets(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = IDENTIFYING_KEYS.has(key) ? inner : walk(inner);
    }
    return out;
  }
  return value;
}
```

- [ ] **Step 1.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  548 passed (548)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 1.5: Commit.**

```bash
git add src/secrets.ts tests/secrets.test.ts
git commit -m "Keep a registry of the secrets the gateway knows, and mask them"
```

---

### Task 2: The escapers mask before they escape (layer 1)

**Files:**
- Modify: `src/channel/escape.ts`, `tests/escape.test.ts`

Every piece of text that reaches chat goes through one of the three escapers. Call sites escape each piece before joining it into a reply, so masking inside the escaper is the one place that always runs before escaping. That order matters: escaping rewrites `_` and other characters, and a secret that contains one would no longer match afterwards.

- [ ] **Step 2.1: Write the failing tests.** Add to `tests/escape.test.ts`:
  - imports: `beforeEach` from `vitest`, and `MASK`, `addSecrets` and `clearSecrets` from `../src/secrets.js`;
  - the `describe` below.

```ts
describe('the escapers mask known secrets before escaping', () => {
  beforeEach(() => {
    clearSecrets();
    addSecrets(['sk_live_abc123']);
  });

  it('forDisplay masks a secret that escaping would otherwise have changed', () => {
    // Escaping first would turn the `_` into `\_`, and the secret would no longer match.
    expect(forDisplay('key sk_live_abc123')).toBe(`key ${MASK}`);
  });

  it('forMarkdown masks and keeps the markdown', () => {
    expect(forMarkdown('**key** sk_live_abc123')).toBe(`**key** ${MASK}`);
  });

  it('forPlainText masks', () => {
    expect(forPlainText('sk_live_abc123')).toBe(MASK);
  });
});
```

- [ ] **Step 2.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/escape.test.ts`. Expected: the three new tests FAIL, for example `expected 'key sk\\_live\\_abc123' to be 'key ••••'`.

- [ ] **Step 2.3: Implement.** In `src/channel/escape.ts`:
  - add `import { redactKnownSecrets } from '../secrets.js';`;
  - change the three escapers:
    - `forDisplay` returns `escapeMd(stripControl(redactKnownSecrets(text)))`;
    - in `forMarkdown`, `stripControl(text)` becomes `stripControl(redactKnownSecrets(text))`;
    - `forPlainText` returns `stripControl(redactKnownSecrets(text))`;
  - add one sentence to each of their doc comments: "Known secrets are masked first (spec §10.1): escaping changes characters a secret may contain, so masking afterwards would miss it."

  Do not touch `mask()` or `escapeMd()`.

- [ ] **Step 2.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  551 passed (551)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 2.5: Commit.**

```bash
git add src/channel/escape.ts tests/escape.test.ts
git commit -m "Mask known secrets inside the escapers, before escaping"
```

---

### Task 3: A card never shows part of a secret

**Files:**
- Modify: `src/channel/render.ts` (`renderCard`), `tests/render.test.ts`

The actor stores an answer as one event per streamed chunk. A secret split across two chunks matches neither chunk, but appears whole on the card. `forMarkdown` masks the joined answer, so it catches that case. What remains is a secret whose first chunk has arrived and whose second has not yet.

- [ ] **Step 3.1: Write the failing tests.** Add to `tests/render.test.ts`:
  - imports: `beforeEach` from `vitest`, and `MASK`, `addSecrets` and `clearSecrets` from `../src/secrets.js`;
  - the `describe` below.

```ts
describe('renderCard: known secrets', () => {
  beforeEach(() => {
    clearSecrets();
    addSecrets(['sk-test-123456']);
  });

  it('masks a secret split across two chunks', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'the key is sk-te' }),
      ev('agent_message_chunk', { text: 'st-123456 ok' }),
      ev('turn_ended', { terminal: 'completed' }),
    ]);
    expect(view.text).toContain(`the key is ${MASK} ok`);
    expect(view.text).not.toContain('sk-te');
  });

  it('does not show the start of a secret while the rest has not arrived', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'the key is sk-te' }),
    ]);
    expect(view.text).toContain('the key is');
    expect(view.text).not.toContain('sk-te');
  });
});
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/render.test.ts`. Expected: the second test FAILS, because the card shows `sk-te`. The first may already pass because of Task 2; that is fine, and it guards the join.

- [ ] **Step 3.3: Implement.** In `src/channel/render.ts`:
  - add `import { redactKnownSecrets, withholdSecretPrefix } from '../secrets.js';`;
  - replace `const body = message.trim();` with:

```ts
  // Masked whole, then cut: the joined answer is the only text guaranteed to hold
  // a streamed secret whole. A trailing fragment of one is dropped, because this
  // render may be mid-stream (spec §10.1). Masking first means the tail of a
  // complete secret can never be mistaken for a fragment.
  const body = withholdSecretPrefix(redactKnownSecrets(message)).trim();
```

- [ ] **Step 3.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  553 passed (553)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 3.5: Commit.**

```bash
git add src/channel/render.ts tests/render.test.ts
git commit -m "Never show the start of a secret on a card that is still streaming"
```

---

### Task 4: Mask event and approval payloads on write (layer 3)

**Files:**
- Modify: `src/db/events.ts` (`appendEvents`), `src/db/approvals.ts` (`createApproval`), `tests/db.test.ts`

This layer is best effort: a secret split across chunks is stored in two halves, and neither matches. It reduces how much reaches the database, and layer 1 stays the authoritative one. Two things are deliberately not masked:
- **`turn_submitted`'s `input`.** It is what replay re-sends to the agent, and masking it would re-send `••••` in place of a value the person gave on purpose. Layer 1 still masks it wherever it is shown.
- **Identifying values.** See `IDENTIFYING_KEYS`.

- [ ] **Step 4.1: Write the failing tests.** Add to `tests/db.test.ts`:
  - imports: `MASK`, `addSecrets` and `clearSecrets` from `../src/secrets.js`;
  - the `describe` below. It uses the file's `h`, `NOW` and `newSession` helpers; check their names at the top of the file.

```ts
describe('masking on write', () => {
  beforeEach(() => {
    clearSecrets();
    addSecrets(['sk-test-123456']);
    newSession();
  });
  afterEach(() => clearSecrets());

  it('masks string values in an event payload and leaves identifying values alone', () => {
    appendEvent(
      h.db,
      's_1',
      { type: 'tool_call', actor: 'agent', payload: { toolCallId: 'sk-test-123456', title: 'cat sk-test-123456' } },
      NOW,
    );
    const [event] = readEvents(h.db, 's_1', 0, lastSeq(h.db, 's_1'));
    expect(event?.payload).toEqual({ toolCallId: 'sk-test-123456', title: `cat ${MASK}` });
  });

  it("keeps a person's turn_submitted input as given, since replay re-sends it", () => {
    const payload = { input: { text: 'use sk-test-123456', paths: [] }, messageId: 'om_1' };
    appendEvent(h.db, 's_1', { type: 'turn_submitted', actor: 'user', payload }, NOW);
    const [event] = readEvents(h.db, 's_1', 0, lastSeq(h.db, 's_1'));
    expect(event?.payload).toEqual(payload);
  });

  it('masks an approval payload and action, but not its ids', () => {
    createApproval(
      h.db,
      {
        approvalId: 'ap_1',
        sessionId: 's_1',
        turnId: 't_1',
        generation: 0,
        action: 'run with sk-test-123456',
        payload: { command: 'curl -H sk-test-123456' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
      NOW,
    );
    const row = getApproval(h.db, 'ap_1');
    expect(row?.action).toBe(`run with ${MASK}`);
    expect(row?.payload).toEqual({ command: `curl -H ${MASK}` });
  });
});
```

If `beforeEach` or `afterEach` is not yet imported from `vitest` in that file, add it. The `PermissionOption` shape, `turn_submitted`'s real payload keys, and the field names on the row `getApproval` returns may differ from the test above. Check `src/types.ts`, the `turn_submitted` producer in `src/core/session-actor.ts` and the `ApprovalRow` decoder, and adapt the test to the real names, keeping what each assertion checks.

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/db.test.ts`. Expected: the first and third tests FAIL because the values are stored unmasked. The second passes already; it guards the exception.

- [ ] **Step 4.3: Implement.** In `src/db/events.ts`:
  - add `import { redactValues } from '../secrets.js';`;
  - in `appendEvents`, replace `payload: e.payload,` in the `row` object with `payload: storedPayload(e),`;
  - add the helper below.

```ts
/**
 * Masked value by value, before it is stored (spec §10.1 layer 3). Best effort: a
 * secret streamed across two chunks matches neither, and layer 1, the escapers,
 * masks it when shown. A person's turn_submitted input is kept as given, because
 * replay re-sends it to the agent.
 */
function storedPayload(e: NewEvent): unknown {
  if (e.type !== 'turn_submitted' || e.payload === null || typeof e.payload !== 'object') {
    return redactValues(e.payload);
  }
  const { input, ...rest } = e.payload as Record<string, unknown>;
  return { ...(redactValues(rest) as Record<string, unknown>), ...(input === undefined ? {} : { input }) };
}
```

The returned `Event` then carries the masked payload, which is what is stored, so callers see the stored truth.

In `src/db/approvals.ts`:
- add `import { redactKnownSecrets, redactValues } from '../secrets.js';`;
- in `createApproval`'s `.run(...)`, replace `a.action,` with `redactKnownSecrets(a.action),`, and `JSON.stringify(a.payload ?? null),` with `JSON.stringify(redactValues(a.payload ?? null)),`.

Leave `options` as it is: option ids identify.

- [ ] **Step 4.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  556 passed (556)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 4.5: Commit.**

```bash
git add src/db/events.ts src/db/approvals.ts tests/db.test.ts
git commit -m "Mask known secrets in event and approval payloads before they are stored"
```

---

### Task 5: A role's secrets honour `maskExempt`, and startup fills the registry

**Files:**
- Modify: `src/roles.ts`, `src/team.ts`, `src/index.ts`, `tests/roles.test.ts`, `tests/team.test.ts`, `tests/gateway-startup.test.ts`

`Role.secretValues` exists since B1 but nothing uses it, and it ignores `maskExempt`. A role lists in `maskExempt` the names whose values are long but not secret, such as `ANTHROPIC_BASE_URL`. Masking those would hide a URL in every answer that mentions it.

- [ ] **Step 5.1: Write the failing tests.**

  In `tests/roles.test.ts`, add a test in the style of that file's existing `loadRoleDir` tests. Use its helpers for writing a role directory, a `.env` at mode 0600, and an env object:
  - the role's config has `passEnv: [BASE_URL]` and `maskExempt: [BASE_URL]`;
  - its `.env` holds `API_KEY=sk-role-12345678`;
  - the env passed has `BASE_URL: 'https://example.invalid/v1'`.

  Assert:

```ts
    expect(role.secretValues).toEqual(['sk-role-12345678']);
```

  In `tests/team.test.ts`, add:

```ts
  it("keeps the agent: block's maskExempt names out of the role default's secrets", () => {
    const e = env({ MT_AGENT_ENV_API_KEY: 'sk-agent-12345678', MT_AGENT_ENV_REGION: 'eu-west-1-region' });
    const config = loadConfig(e, () => undefined);
    const team = loadTeam({ ...config, agent: config.agent && { ...config.agent, maskExempt: ['REGION'] } }, e);
    expect(team.roles.get('default')?.secretValues).toEqual(['sk-agent-12345678']);
  });
```

  In `tests/gateway-startup.test.ts`:
  - import `MASK`, `clearSecrets` and `redactKnownSecrets` from `../src/secrets.js`;
  - call `clearSecrets()` at the start of `beforeEach`;
  - add the test below. It needs the config's `LARK_APP_SECRET` to be at least 8 characters; `app-secret` is 10.

```ts
  it('knows the Lark app secret once it has started up', async () => {
    const gateway = await createGateway(config, team);
    try {
      expect(redactKnownSecrets(`x ${config.lark.appSecret} y`)).toBe(`x ${MASK} y`);
    } finally {
      await gateway.stop();
    }
  });
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/roles.test.ts tests/team.test.ts tests/gateway-startup.test.ts`. Expected: three FAILs:
  - the role and team tests list the exempt value too;
  - the startup test leaves the secret unmasked.

- [ ] **Step 5.3: Implement.**

  In `src/roles.ts`, add an exported helper next to `gatewayOwnsVariable`:

```ts
/** The values a role's agent is given that are secrets: every one, except names in maskExempt. */
export function secretValuesOf(env: Readonly<Record<string, string>>, maskExempt: readonly string[]): string[] {
  return Object.entries(env)
    .filter(([name, value]) => !maskExempt.includes(name) && value !== '')
    .map(([, value]) => value);
}
```

  In `loadRoleDir`, compute `maskExempt` once as a local, and use the local in the `agent` object. Then replace the `secretValues:` expression and its comment with:

```ts
      // Empty values are not secrets, and the registry ignores short ones (spec §10.1).
      secretValues: secretValuesOf({ ...fromGateway, ...fromFile }, maskExempt),
```

  In `src/team.ts` `roleFromAgentBlock`, import `secretValuesOf`, and change `secretValues:` to `secretValuesOf(agent.env, agent.maskExempt),`.

  In `src/index.ts`:
  - import `addSecrets` and `redactKnownSecrets` from `./secrets.js`;
  - add the block below directly after `for (const line of team.notes) note(line);`;
  - change `note`'s body to write `redactKnownSecrets(line)`. Errors that `note` prints can carry an agent's stderr, which can carry a secret.

```ts
  // Every secret the gateway itself holds, masked wherever text leaves it (spec
  // §10.1). Before anything can print or store agent text. Plan C adds and removes
  // worker tokens as runs open and close.
  addSecrets([config.lark.appSecret, ...[...team.roles.values()].flatMap((role) => role.secretValues)]);
```

- [ ] **Step 5.4: Run the tests.** Run `npm test 2>&1 | tail -4`. Expected: `Tests  559 passed (559)`. Then run `npm run typecheck`. Expected: no output.

- [ ] **Step 5.5: Commit.**

```bash
git add src/roles.ts src/team.ts src/index.ts tests/roles.test.ts tests/team.test.ts tests/gateway-startup.test.ts
git commit -m "Register the gateway's own secrets at startup, leaving out maskExempt names"
```

---

### Task 6: No other path to chat, and the docs

**Files:**
- Modify: `docs/architecture.md`, `README.md`
- Possibly modify: any call site found in Step 6.1

- [ ] **Step 6.1: Audit what reaches chat without an escaper.** Run:

```bash
git grep -n -E "sendText\(|updateApproval|openCard|\.set\(|finish\(" -- src/channel src/core src/index.ts
```

For each call that sends text to Lark, check that every piece of that text comes from one of these:
- gateway-authored constants;
- ids;
- `forDisplay`, `forMarkdown` or `forPlainText`.

Pay particular attention to:
- command replies in `src/core/commands.ts` and `src/core/router.ts`;
- boot findings in `src/index.ts`;
- `src/channel/card-writer.ts`;
- approval cards in `src/channel/lark/`.

Wherever a piece of agent- or user-originated text is sent without one of the three escapers, wrap it in the right one, and add a test next to that file's existing tests showing that a registered secret comes out masked. If nothing is found, say so in the commit message of Step 6.2 and change no code.

- [ ] **Step 6.2: Docs.**
  - **`docs/architecture.md` §12:** find the sentence or sentences that call the projection or rendering *pure*, using `grep -n -i pure docs/architecture.md`. Amend them to say it is pure **given the secret set**: the escapers read the process-wide registry in `src/secrets.ts`, and tests set it explicitly (kanban spec §10.1).
  - **`README.md`:** directly after the credentials paragraph, the one that ends with the `.env` sentence, add:

```markdown
The gateway masks every secret it holds itself — the Lark app secret, and every value it gives
an agent from a role's `.env`, `passEnv` or `MT_AGENT_ENV_*`, except names the role lists in
`agent.maskExempt` — as `••••` in everything it shows in chat, and in what it stores in its event
log and approvals. Values shorter than 8 characters are not masked. A secret the agent finds by
itself, for instance in a file it reads, is not known to the gateway and is not masked.
```

  - **README table:** in the configuration table, change the `agent.maskExempt` row's description from "Checked at startup but not used in this build: nothing is masked yet." to "Variable names whose values are long but not secret, such as a base URL, so not masked."

Commit:

```bash
git add docs/architecture.md README.md   # and any file Step 6.1 changed, with its test
git commit -m "Say what is masked, and that rendering is pure given the secret set"
```

- [ ] **Step 6.3: Run everything.** Run:
  - `npm test 2>&1 | tail -4`: expect 559, plus any tests Step 6.1 added;
  - `npm run test:e2e 2>&1 | tail -4`: expect 49;
  - `npm run typecheck`: expect no output;
  - `git grep -n -i "p[g]w" -- . ':!package-lock.json'`: expect no output.

- [ ] **Step 6.4: Report, without merging.**

---

## Done when

- `npm test` gives `Tests  559 passed (559)` (more if Step 6.1 added tests). `npm run test:e2e` gives `Tests  49 passed (49)`. `npm run typecheck` prints nothing. All of these run under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing.
- No escaper is bypassed on the way to chat (Step 6.1).
