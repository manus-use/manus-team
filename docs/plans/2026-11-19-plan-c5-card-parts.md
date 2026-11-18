# Plan C5: The reply card's parts. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Lark reply card typing its answer out again from the start on every tool event. The card becomes three markdown elements: the tool summary line, the answer, and the status (the error, the approval-wait line, the terminal line, the retry hint, the placeholder). A tool event rewrites the tool line alone; the answer only grows at its end while the turn streams, so Lark's client types only the new words. The adapter drives the reply card through Lark's card API with the SDK's own client, in place of the SDK's one-element streaming card. The card writer's design is unchanged.

**Architecture:**
- **The render** (Task 1): `renderCard` returns `parts: CardParts`, `{ tools, answer, status }`, beside `text`, which is now `cardText(parts)`, the parts joined as before, so the plain-message fallback and every test that reads the text are unchanged. The answer keeps `CARD_TEXT_BUDGET`; the tool line and the status get 2,000 characters each.
- **The port** (Task 2): `CardSession.set` and `.finish`, and `Channel.openCard`, take `CardParts`. The writer passes the render's parts; the fake channel records them beside the joined text; the sinks discard them. The adapter, for this one task, still joins them for the SDK's streaming card, so nothing a person sees changes yet.
- **The card** (Task 3): `replyCard(parts)`, a schema 2.0 streaming card of three markdown elements with the ids `tools`, `answer` and `status`, and `replySummary(parts)`, the finished card's chat-list preview. Pure.
- **The session** (Task 4): `openCard` makes the card with `cardkit.v1.card.create`, sends it by reference through the adapter's own one-message send with the uuid `reply_<card_id>`, and returns a session that writes each changed part with `cardkit.v1.cardElement.content` and the card's next sequence, and finishes with `cardkit.v1.card.settings`. Tested over a fake cardkit client, `tests/helpers/cardkit.ts`.
- **The replay** (Task 5): the card writer, the adapter and the fake cardkit client over one turn of interleaved tool events and answer chunks, a write after every event: every update the answer element is given starts with the one before.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`), vitest, `@larksuiteoapi/node-sdk` 1.73.0. No new dependency. No migration.

**Spec:** `docs/specs/2026-08-21-lark-channel-design.md` §4.5, "The reply card's parts", as written on 2026-11-19. Below, "§N" is that spec's.

---

## Ground rules

- **Where to work.**
  - Use the worktree beside the main checkout, `/Users/x/Develop/manus/prime-gateway-wt2`, on the branch `card-split`, which holds this plan and the spec section, on top of `62ec9c3`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`, nor `/Users/x/Develop/manus/prime-gateway-work`: the live gateway runs from the first.
  - Never start the gateway, never reach the real Lark or the network, and never read or write `~/.manus-team`. Every test here runs over a fake: the fake channel (`tests/helpers/channel.ts`) or the fake cardkit client (`tests/helpers/cardkit.ts`, Task 4).
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The letters `p`,`g`,`w` in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command. The default Node 23 breaks `better-sqlite3`.
- **Baseline.** `npx vitest run --project unit` gives `Tests  2667 passed (2667)`. `npx vitest run --project e2e` gives `Tests  173 passed (173)`. `npm run typecheck` reports no errors. The tests of `tests/update-run.test.ts` and the other `mt update` tests, which time detached children, can fail on a loaded or sleeping machine; run the file again alone before looking for a cause.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text is whole lines, and appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given. Every step of this plan was applied in that order, from `62ec9c3`, in a throwaway copy, and gave the counts and failures it states; the plan's own text was then applied in a second fresh copy, which reproduced the first copy's tree byte for byte at the end of every task.
- **Words a person sees** (the card, its preview, the log) do not use the long dash.
- **No real agent.** No test runs bytesec or any agent; the turns are events written into a log by the test.

## Decisions

Each has its reason. Where the code and the spec disagree, the code is the fact, and the decision says which reading keeps the spec's intent; those are listed again under "Where the code forced a reading" below.

1. **`CardParts` is `{ tools, answer, status }`** (Task 1), in `src/channel/types.ts`, the port, as `CardSession` takes it; each part already escaped and masked, `''` when it has nothing. `RenderedCard` keeps `text` as `cardText(parts)`: the non-empty parts in reading order, `\n\n` between, cut to `CARD_TEXT_BUDGET`, which is the text `renderCard` gave before for any answer under the budget. The plain-message fallback sends it, and the tests of `tests/render.test.ts`, which read it, pass as they are.
2. **The status is the third element** (Task 1): the error, the approval-wait line, the terminal line, the retry hint, and the placeholder, which shows, as before, only when the turn has no tool line, no answer and no other status. Not "only on finish", which hides the error and the approval line while the turn is open; not the answer, which would shrink when the approval line goes; not the tool line, which would put an error above its answer (§4.5).
3. **The budgets** (Task 1): the answer is cut at `CARD_TEXT_BUDGET`, 20,000, as the whole card was; `TOOLS_BUDGET` and `STATUS_BUDGET` are 2,000 each. The card's elements are at most 24,004 characters together, each under cardkit's 30,000, so the SDK's rollover is not needed; `text` stays within 20,000.
4. **The port takes parts** (Task 2): `openCard(target, initial: CardParts, uuid)`, `set(parts)`, `finish(parts)`. `FakeCard` keeps `sets`, `finishes` and `droppedSets` as joined text, with `cardText`, so every test that reads a card's text is unchanged, and adds `partSets` and `partFinishes`. `KanbanSink` and `SinkChannel` discard parts as they discarded text.
5. **`replyCard(parts)`** (Task 3): schema 2.0; `update_multi: true`, as every card of ours says; `streaming_mode: true`; the chat-list preview `REPLY_SUMMARY_OPEN`, "Working…"; the SDK's own streaming config, `print_frequency_ms: { default: 70 }`, `print_step: { default: 1 }`, `print_strategy: 'fast'`; three markdown elements, `element_id` `tools`, `answer` and `status` (`REPLY_ELEMENTS`). A part that is `''` is `EMPTY_PART`, a zero-width space, never an empty element.
6. **`replySummary(parts)`** (Task 3): the answer, else the status, else the tool line, whitespace collapsed to one space, cut to 50 code points with `…`, as the SDK cuts its preview at 50.
7. **`openCard`** (Task 4): reads `createdAt` first, makes the card with `rawClient.cardkit.v1.card.create` (`type: 'card_json'`), not retried, a code in the body refused as a `ChannelError`, then sends `{ type: 'card', data: { card_id } }` as `interactive` through `#post` under `#withRetry`, with the uuid `reply_<card_id>`, cut to 50. The SDK's `createCardInstance`, `sendCardByReference`, `updateCardElementContent` and `finishStreamingCard` are methods of `LarkChannel`'s private `sender`; `rawClient` is public, and the calls are the same.
8. **The session** (Task 4) holds `shown`, what each element was last given and Lark took, and `sequence`, one counter for the card. A write sends, in reading order and one at a time, each part whose content differs from `shown`, with the next sequence and the uuid `c_<card_id>_<sequence>`, and sets `shown` only once Lark answered `code` 0. A failure throws: thrown errors through `sendError`, a code in a 2xx body through `toChannelError`.
9. **`finish`** (Task 4): inert on a second call; marks the session finished, writes what changed, swallowing a failure, then calls `cardkit.v1.card.settings` with `{ config: { streaming_mode: false, summary: { content: replySummary(parts) } } }`, the next sequence and the uuid `s_<card_id>_<sequence>`, swallowing a failure too. It never throws, as before, so the writer's finish on every path is unchanged. `set` after it does nothing.
10. **The SDK's streaming card is no longer used**: `MarkdownStreamController` is not imported, and nothing calls `stream()`. The fake cardkit client has no `stream`, so an adapter that still went through it fails Task 4's tests.

## Known limitations

From §4.5, kept as it says: the tool line is still typed again on each tool event; a write can be three requests in the rare render that changes all three parts; the answer is typed again once when a held secret fragment starts being held at its fourth character, when a secret learnt during the turn masks text already shown, and when the answer crosses the budget. Besides:

- **Lark's client behaviour is not tested here.** The fake cardkit client records what each element is sent; whether Lark types only the tail of each, whether a zero-width space leaves no gap, and whether one sequence across elements is taken, are smoke items 1 to 4.
- **A turn past Lark's own streaming timeout** is not tested: the SDK's comments say Lark turns streaming off after ten minutes. What Lark refuses then reaches the writer, which sends the answer as a plain message after five failures (smoke item 5).
- **The card's send by reference is retried, its making is not** (Decision 7): a throttle on `card.create` fails the open, and the writer's next pass opens it again.

## Where the code forced a reading

- **"Each element's content with its own sequence" is one counter a card** (Decision 8): Lark's sequence orders a card's updates, the SDK's own streaming card draws its updates and its finish from one counter a card ("monotonically increasing per card", on `updateCardElementContent`), and counters an element would give two updates of one card the same number. Each update has its own number, from the card's counter.
- **`forMarkdown`'s escaping does not rewrite earlier text**: it doubles the backslashes in front of a `<` or `>`, so text that ended in backslashes still starts the escaped text. Task 1's test holds it.
- **Releasing a held tail does not rewrite earlier text, but starting to hold one does**: `withholdSecretPrefix` holds a fragment only from its fourth character (`MIN_PREFIX_LENGTH`, 4, in `src/secrets.ts`), so a render ending in one to three of a secret's first characters shows them and the next render holds them. Task 1's test holds both.
- **The send's uuid is the card's, not the writer's** (Decision 7): `sendUuid(seq)` is also the fallback's uuid at that seq, and a reopened card's, and Lark answers a repeated uuid with the first message (§4.2).
- **The SDK's `createCardInstance` does not read the code in the body**, only the card id; `openCard` refuses a non-zero code first, so a refusal is reported with Lark's code rather than as a missing card id.
- **The placeholder keeps today's rule**: it shows only when there is nothing else, which `parts.length === 0` said before.

## File map

| File | Responsibility |
|---|---|
| `src/channel/types.ts` (modify) | `CardParts`; `CardSession.set` and `.finish`, `Channel.openCard` take parts; `CardSession`'s note (Tasks 1, 2, 4) |
| `src/channel/render.ts` (modify) | `RenderedCard.parts`, `cardText`, `TOOLS_BUDGET`, `STATUS_BUDGET` (Task 1) |
| `src/channel/card-writer.ts` (modify) | passes the render's parts (Task 2) |
| `src/kanban/sink.ts` (modify) | discards parts (Task 2) |
| `src/channel/lark/adapter.ts` (modify) | joins parts for the SDK's card (Task 2); `replyCard`, `replySummary`, `REPLY_ELEMENTS`, `EMPTY_PART`, `REPLY_SUMMARY_OPEN`, `partContent` (Task 3); `openCard` over the card API, `cardkitCall`, the class note (Task 4) |
| `tests/helpers/channel.ts` (modify) | `FakeCard.partSets`, `.partFinishes` (Task 2) |
| `tests/helpers/cardkit.ts` (create) | `FakeCardkit`, `refused` (Task 4) |
| `tests/render-parts.test.ts`, `tests/lark-reply-card.test.ts`, `tests/lark-reply-session.test.ts`, `tests/card-parts-replay.test.ts` (create) | Tasks 1, 3, 4, 5 |
| `tests/card-writer.test.ts`, `tests/kanban-sink.test.ts` (modify) | the parts handed over; the sinks' new argument (Task 2) |

Running counts, unit then end to end: Task 1 2676 / 173, Task 2 2677 / 173, Task 3 2682 / 173, Task 4 2692 / 173, Task 5 2694 / 173.

How §4.5's tests map to the tasks: the parts, their budgets, the answer growing over a turn and each case that does or does not re-type (Task 1); the card JSON and its preview (Task 3); the adapter over the fake cardkit client (Task 4); the bug replayed end to end (Task 5).

---

### Task 1: The render's three parts

**Files:**

- Create: `tests/render-parts.test.ts`
- Modify: `src/channel/types.ts`, `src/channel/render.ts`

§4.5. `renderCard` puts the tool line, the answer and the status each in a part of its own, with its own budget, and keeps `text` as the parts joined. Nothing calls the parts yet, so nothing else changes: every other test passes as it is.

- [ ] **Step 1.1: Write the tests.**

Create `tests/render-parts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CARD_TEXT_BUDGET,
  RETRY_AFTER_TOOLS_HINT,
  STATUS_BUDGET,
  TOOLS_BUDGET,
  cardText,
  renderCard,
} from '../src/channel/render.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { Event, EventType } from '../src/types.js';

/**
 * The reply card's parts (channel spec §4.5): the tool line, the answer and the
 * status, each its own element on a Lark card, so a tool event rewrites the tool
 * line alone and the answer only ever grows at its end. Lark's client types an
 * element's new text from where the old one ends only when the old text starts
 * the new one; anything else is typed again from the start.
 */

let seq = 0;
function ev(type: EventType, payload: unknown): Event {
  seq += 1;
  return {
    sessionId: 's_test',
    seq,
    ts: 1_760_000_000_000 + seq,
    generation: 0,
    brokerSeq: null,
    turnId: 't_1',
    type,
    actor: 'agent',
    payload,
  };
}

/** Each render of `events`, one event more each time, as the writer could see them. */
function everyRender(events: readonly Event[]): ReturnType<typeof renderCard>[] {
  return events.map((_e, i) => renderCard(events.slice(0, i + 1)));
}

/** A turn of answer chunks with tool calls and their updates between them, and an approval on the way. */
function interleaved(): Event[] {
  return [
    ev('turn_submitted', { text: 'fix the build' }),
    ev('agent_message_chunk', { text: 'Let me look ' }),
    ev('agent_message_chunk', { text: 'at the build first.' }),
    ev('tool_call', { toolCallId: 'c1', title: 'Bash', status: 'pending' }),
    ev('tool_call_update', { toolCallId: 'c1', status: 'in_progress' }),
    ev('tool_call_update', { toolCallId: 'c1', status: 'completed' }),
    ev('agent_message_chunk', { text: 'It fails in ' }),
    ev('tool_call', { toolCallId: 'c2', title: 'Read', status: 'in_progress' }),
    ev('agent_message_chunk', { text: '`main.ts`.' }),
    ev('tool_call_update', { toolCallId: 'c2', status: 'completed' }),
    ev('tool_call', { toolCallId: 'c3', title: 'Read', status: 'completed' }),
    ev('approval_requested', { approvalId: 'a1' }),
    ev('approval_resolved', { approvalId: 'a1' }),
    ev('tool_call', { toolCallId: 'c4', title: 'Edit', status: 'failed' }),
    ev('agent_message_chunk', { text: ' Fixed **it**.' }),
    ev('turn_ended', { terminal: 'completed' }),
  ];
}

describe('renderCard: the parts', () => {
  it('puts the tool line, the answer and the status each in its own part', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('tool_call', { toolCallId: 'c1', title: 'Bash', status: 'completed' }),
      ev('agent_message_chunk', { text: 'All **done**.' }),
      ev('agent_error', { message: 'provider blip', retryable: true }),
      ev('turn_ended', { terminal: 'failed' }),
    ]);
    expect(view.parts.tools).toBe('✅ Bash');
    expect(view.parts.answer).toBe('All **done**.');
    expect(view.parts.status).toBe(
      '**Error:** provider blip\n\n_Turn failed._\n\n_This is usually temporary, but the steps above already ran. Check them before sending your message again._',
    );
  });

  it('keeps the placeholder in the status, never in the answer', () => {
    const open = renderCard([ev('turn_submitted', { text: 'hi' })]);
    expect(open.parts).toEqual({ tools: '', answer: '', status: '_Working…_' });
    const empty = renderCard([ev('turn_submitted', { text: 'hi' }), ev('turn_ended', { terminal: 'completed' })]);
    expect(empty.parts).toEqual({ tools: '', answer: '', status: '_Finished with no output._' });
    const waiting = renderCard([ev('turn_submitted', { text: 'hi' }), ev('approval_requested', { approvalId: 'a1' })]);
    expect(waiting.parts).toEqual({ tools: '', answer: '', status: '_Waiting for your approval: see the card below._' });
  });

  it('is still one text, the parts joined, for the plain message and for anything that reads the card whole', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ev('tool_call', { toolCallId: 'c1', title: 'Bash', status: 'completed' }),
      ev('agent_message_chunk', { text: 'answer' }),
      ev('agent_error', { message: 'boom', retryable: true }),
      ev('turn_ended', { terminal: 'failed' }),
    ]);
    expect(view.text).toBe(cardText(view.parts));
    expect(view.text).toBe(`✅ Bash\n\nanswer\n\n**Error:** boom\n\n_Turn failed._\n\n${RETRY_AFTER_TOOLS_HINT}`);
  });

  it('gives each part its own budget, the answer the card budget', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ...Array.from({ length: 400 }, (_x, i) => ev('tool_call', { toolCallId: `c${i}`, title: `Read file${i}.ts`, status: 'completed' })),
      ev('agent_message_chunk', { text: 'x'.repeat(CARD_TEXT_BUDGET * 2) }),
      ev('agent_error', { message: 'e'.repeat(STATUS_BUDGET * 2), retryable: false }),
    ]);
    expect(view.parts.tools.length).toBeLessThanOrEqual(TOOLS_BUDGET);
    expect(view.parts.tools).toContain('truncated');
    expect(view.parts.answer.length).toBeLessThanOrEqual(CARD_TEXT_BUDGET);
    expect(view.parts.answer).toContain('truncated');
    expect(view.parts.status.length).toBeLessThanOrEqual(STATUS_BUDGET);
    expect(view.text.length).toBeLessThanOrEqual(CARD_TEXT_BUDGET);
  });
});

describe('renderCard: the answer only grows at its end', () => {
  beforeEach(() => clearSecrets());
  afterEach(() => clearSecrets());

  it('starts every answer with the one before it, through a turn of interleaved tool events and chunks', () => {
    const renders = everyRender(interleaved());
    const answers = renders.map((r) => r.parts.answer);
    for (let i = 1; i < answers.length; i += 1) {
      expect(answers[i]?.startsWith(answers[i - 1] ?? ''), `render ${i}: ${JSON.stringify(answers[i - 1])} then ${JSON.stringify(answers[i])}`).toBe(true);
    }
    expect(answers.at(-1)).toBe('Let me look at the build first.\n\nIt fails in \n\n`main.ts`.\n\n Fixed **it**.');
    // Broken on purpose, to show the check measures something: the card as one
    // text, the tool line first, is rewritten from the start by tool events.
    const texts = renders.map((r) => r.text);
    const rewrites = texts.filter((t, i) => i > 0 && !t.startsWith(texts[i - 1] ?? ''));
    expect(rewrites.length).toBeGreaterThan(3);
  });

  it('holds back the start of a secret and then masks it, still only growing', () => {
    addSecrets(['sk-test-123456']);
    const answers = everyRender([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'the key is sk-te' }),
      ev('agent_message_chunk', { text: 'st-12' }),
      ev('agent_message_chunk', { text: '3456 and that is all' }),
    ]).map((r) => r.parts.answer);
    expect(answers).toEqual(['', 'the key is', 'the key is', `the key is ${MASK} and that is all`]);
  });

  it('releases a held tail that turns out not to be a secret, still only growing', () => {
    addSecrets(['sk-test-123456']);
    const answers = everyRender([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'try sk-te' }),
      ev('agent_message_chunk', { text: 'mporary' }),
    ]).map((r) => r.parts.answer);
    expect(answers).toEqual(['', 'try', 'try sk-temporary']);
  });

  it("doubles a backslash before a bracket without changing what was shown, still only growing", () => {
    const answers = everyRender([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'a\\' }),
      ev('agent_message_chunk', { text: '<b' }),
    ]).map((r) => r.parts.answer);
    expect(answers).toEqual(['', 'a\\', 'a\\\\\\<b']);
  });

  it('rewrites earlier text only in the cases the spec lists: a held tail, a secret learnt late, and the budget', () => {
    // Each is a one-off: the element is typed again once, from the start.
    addSecrets(['sk-test-123456']);
    // Three characters of a secret's start are shown; the fourth makes them a
    // fragment worth holding, so the shown text gets shorter.
    const held = everyRender([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'see sk-' }),
      ev('agent_message_chunk', { text: 't' }),
    ]).map((r) => r.parts.answer);
    expect(held.slice(1)).toEqual(['see sk-', 'see']);

    const events = [ev('turn_submitted', { text: 'hi' }), ev('agent_message_chunk', { text: 'token tok-abcdefgh' })];
    const before = renderCard(events).parts.answer;
    addSecrets(['tok-abcdefgh']);
    const after = renderCard([...events, ev('agent_message_chunk', { text: ' ok' })]).parts.answer;
    expect([before, after]).toEqual(['token tok-abcdefgh', `token ${MASK} ok`]);

    clearSecrets();
    const cut = everyRender([
      ev('turn_submitted', { text: 'hi' }),
      ev('agent_message_chunk', { text: 'x'.repeat(CARD_TEXT_BUDGET - 5) }),
      ev('agent_message_chunk', { text: 'y'.repeat(100) }),
      ev('agent_message_chunk', { text: 'z'.repeat(100) }),
    ]).map((r) => r.parts.answer);
    expect(cut[2]?.startsWith(cut[1] ?? '')).toBe(false);
    // Past the budget the answer stops changing, so it is not typed again.
    expect(cut[3]).toBe(cut[2]);
  });
});
```

- [ ] **Step 1.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/render-parts.test.ts`. Expected: `Tests  9 failed (9)`, the first as `TypeError: Cannot read properties of undefined (reading 'tools')`, and the third as `TypeError: (0 , cardText) is not a function`.

- [ ] **Step 1.3: Implement.**

In `src/channel/types.ts`, replace:

```ts
  threadId?: string;
```

with:

```ts
  threadId?: string;
}

/**
 * A reply card's three parts (channel spec §4.5), each already escaped and masked
 * by the renderer, and each '' when it has nothing to show.
 *
 * Three, not one text, because Lark's client animates an element by its diff: a
 * new text that starts with the old one has only its tail typed, and anything
 * else is typed again from the start. With the tool line first in one text,
 * every tool event rewrote the start of the card, and the whole answer was typed
 * out again each time.
 */
export interface CardParts {
  /** The turn's tool calls on one line. Rewritten as they change, on its own. */
  tools: string;
  /** The agent's answer. Only grows at its end while the turn streams, bar the cases §4.5 lists. */
  answer: string;
  /** The error, the approval wait, the terminal, the retry hint, or the placeholder: the lines that come and go. */
  status: string;
```

In `src/channel/render.ts`, replace:

```ts
import { forDisplay, forMarkdown, truncate } from './escape.js';
```

with:

```ts
import { forDisplay, forMarkdown, truncate } from './escape.js';
import type { CardParts } from './types.js';
```

In `src/channel/render.ts`, replace:

```ts
export interface RenderedCard {
  text: string;
```

with:

```ts
/**
 * The tool line's own budget, and the status's (spec §4.5). Each part is an
 * element of its own on the card, so each is bounded on its own: the answer by
 * `CARD_TEXT_BUDGET`, these two by far less, as a line of tools or an error is
 * never what a reader came for. The three together stay under cardkit's
 * 30,000-character element cap one by one, and far under the message ceiling.
 */
export const TOOLS_BUDGET = 2_000;
export const STATUS_BUDGET = 2_000;

export interface RenderedCard {
  /**
   * The card as one text: the parts joined, cut to `CARD_TEXT_BUDGET`
   * (`cardText`). What the plain-message fallback sends.
   */
  text: string;
  /** The card's three parts, each its own element on a Lark card (spec §4.5). */
  parts: CardParts;
```

In `src/channel/render.ts`, replace:

```ts
  const parts: string[] = [];

  const toolLine = toolSummary([...tools.values()]);
  if (toolLine !== '') parts.push(toolLine);
```

with:

```ts
  const toolLine = truncate(toolSummary([...tools.values()]), TOOLS_BUDGET);
```

In `src/channel/render.ts`, replace:

```ts
  if (body !== '') parts.push(forMarkdown(body));

  if (error !== undefined) parts.push(`**Error:** ${forDisplay(error)}`);

  // Only while the turn is open. After a terminal the approval is moot, and a
  // stale "waiting on you" line sends the user hunting for a button that no
  // longer does anything.
  const blocked = !finished && openApprovals.size > 0;
  if (blocked) parts.push('_Waiting for your approval: see the card below._');

  if (finished && terminal !== undefined && terminal !== 'completed') {
    parts.push(`_Turn ${forDisplay(terminal)}._`);
  }

  // `failed` only. An `ambiguous` turn may already have acted on the prompt, and
  // inviting a casual resend there is how one instruction runs twice.
  if (finished && terminal === 'failed' && errorRetryable) {
    parts.push(tools.size > 0 ? RETRY_AFTER_TOOLS_HINT : RETRY_HINT);
  }

  // Empty output is a legitimate terminal, not a bug to paper over -- but an
  // empty card is indistinguishable from a broken one, so say so explicitly.
  if (parts.length === 0) {
    parts.push(finished ? '_Finished with no output._' : '_Working…_');
  }

  return {
    text: truncate(parts.join('\n\n'), CARD_TEXT_BUDGET),
    throughSeq,
    finished,
    turnStartSeq,
    ...(replyTo === undefined ? {} : { replyTo }),
  };
```

with:

```ts
  const answer = body === '' ? '' : truncate(forMarkdown(body), CARD_TEXT_BUDGET);

  // The lines that come and go, below the answer, so the answer only grows at
  // its end (spec §4.5).
  const status: string[] = [];
  if (error !== undefined) status.push(`**Error:** ${forDisplay(error)}`);

  // Only while the turn is open. After a terminal the approval is moot, and a
  // stale "waiting on you" line sends the user hunting for a button that no
  // longer does anything.
  const blocked = !finished && openApprovals.size > 0;
  if (blocked) status.push('_Waiting for your approval: see the card below._');

  if (finished && terminal !== undefined && terminal !== 'completed') {
    status.push(`_Turn ${forDisplay(terminal)}._`);
  }

  // `failed` only. An `ambiguous` turn may already have acted on the prompt, and
  // inviting a casual resend there is how one instruction runs twice.
  if (finished && terminal === 'failed' && errorRetryable) {
    status.push(tools.size > 0 ? RETRY_AFTER_TOOLS_HINT : RETRY_HINT);
  }

  // Empty output is a legitimate terminal, not a bug to paper over -- but an
  // empty card is indistinguishable from a broken one, so say so explicitly. In
  // the status, not the answer: the first word would otherwise replace it, and
  // Lark would type the answer from the start.
  if (toolLine === '' && answer === '' && status.length === 0) {
    status.push(finished ? '_Finished with no output._' : '_Working…_');
  }

  const parts: CardParts = { tools: toolLine, answer, status: truncate(status.join('\n\n'), STATUS_BUDGET) };
  return {
    text: cardText(parts),
    parts,
    throughSeq,
    finished,
    turnStartSeq,
    ...(replyTo === undefined ? {} : { replyTo }),
  };
}

/**
 * The card as one text: its parts that have something, in reading order, a
 * blank line between, cut to `CARD_TEXT_BUDGET`. The plain-message fallback
 * sends it, and so it reads as the card does.
 */
export function cardText(parts: CardParts): string {
  return truncate([parts.tools, parts.answer, parts.status].filter((p) => p !== '').join('\n\n'), CARD_TEXT_BUDGET);
```

- [ ] **Step 1.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2676 passed (2676)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 1.5: Commit.**

```bash
git add src/channel/types.ts src/channel/render.ts tests/render-parts.test.ts
git commit -m "Render the reply card as three parts, the tool line, the answer and the status, each with its own budget, keeping the parts joined as the card's text for the plain message, so a tool event no longer rewrites the start of the answer"
```

---

### Task 2: The port takes the parts

**Files:**

- Modify: `src/channel/types.ts`, `src/channel/card-writer.ts`, `src/kanban/sink.ts`, `src/channel/lark/adapter.ts`, `tests/helpers/channel.ts`, `tests/card-writer.test.ts`, `tests/kanban-sink.test.ts`

Decision 4. `CardSession.set`, `.finish` and `Channel.openCard` take `CardParts`, and the writer passes the render's. The adapter joins them with `cardText` for the SDK's streaming card until Task 4, so the card shows what it showed.

- [ ] **Step 2.1: Write the test.**

In `tests/card-writer.test.ts`, replace:

```ts

  it('reports a swallowed failure instead of retrying in silence', async () => {
```

with:

```ts

  it('hands the card its parts, so the adapter can write each to its own element', async () => {
    // Channel spec §4.5: the tool line and the answer are separate elements, so
    // the writer passes the render's parts, not one text.
    const h = harness();
    h.submit('ask');
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();

    const card = h.channel.lastCard;
    expect(card?.partSets).toEqual([
      { tools: '', answer: 'a', status: '' },
      { tools: '', answer: 'ab', status: '' },
    ]);
    expect(card?.partFinishes).toEqual([{ tools: '', answer: 'ab', status: '' }]);
    // And the fake keeps the joined text, which the other tests read.
    expect(card?.sets).toEqual(['a', 'ab']);
  });

  it('reports a swallowed failure instead of retrying in silence', async () => {
```

- [ ] **Step 2.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/card-writer.test.ts`. Expected: `Tests  1 failed | 31 passed (32)`, the new test as `AssertionError: expected undefined to deeply equal [ …(2) ]`.

- [ ] **Step 2.3: Implement.**

In `src/channel/types.ts`, replace:

```ts
   * Replace the card's content.
   *
   * Full replacement, not append. Renders are computed from the log and are
   * idempotent, so a retry after an ambiguous failure re-sends the same state
   * rather than appending it twice.
   */
  set(text: string): Promise<void>;
```

with:

```ts
   * Replace the card's content, part by part.
   *
   * Full replacement, not append. Renders are computed from the log and are
   * idempotent, so a retry after an ambiguous failure re-sends the same state
   * rather than appending it twice.
   */
  set(parts: CardParts): Promise<void>;
```

In `src/channel/types.ts`, replace:

```ts
  finish(text: string): Promise<void>;
```

with:

```ts
  finish(parts: CardParts): Promise<void>;
```

In `src/channel/types.ts`, replace:

```ts
  /** Open a streaming card. */
  openCard(target: SendTarget, initialText: string, uuid: string): Promise<CardSession>;
```

with:

```ts
  /** Open a streaming card, showing `initial`. */
  openCard(target: SendTarget, initial: CardParts, uuid: string): Promise<CardSession>;
```

In `src/channel/card-writer.ts`, replace:

```ts
    try {
      const view = renderCard(this.#deps.readEvents(0, target));
```

with:

```ts
    try {
      // The parts joined: the plain message reads as the card did.
      const view = renderCard(this.#deps.readEvents(0, target));
```

In `src/channel/card-writer.ts`, replace:

```ts
          await existing.finish(before.text);
```

with:

```ts
          await existing.finish(before.parts);
```

In `src/channel/card-writer.ts`, replace:

```ts
        view.replyTo === undefined ? this.#deps.target : { ...this.#deps.target, replyTo: view.replyTo },
        view.text,
```

with:

```ts
        view.replyTo === undefined ? this.#deps.target : { ...this.#deps.target, replyTo: view.replyTo },
        view.parts,
```

In `src/channel/card-writer.ts`, replace:

```ts
        await session.finish(view.text);
        this.#finished = true;
      }
      return;
    }

    if (view.finished) {
      await session.finish(view.text);
      this.#finished = true;
    } else {
      await session.set(view.text);
```

with:

```ts
        await session.finish(view.parts);
        this.#finished = true;
      }
      return;
    }

    if (view.finished) {
      await session.finish(view.parts);
      this.#finished = true;
    } else {
      await session.set(view.parts);
```

In `src/channel/card-writer.ts`, replace:

```ts
        await session.finish(view.text);
```

with:

```ts
        await session.finish(view.parts);
```

In `src/kanban/sink.ts`, replace:

```ts
  ApprovalOutcomeView,
```

with:

```ts
  ApprovalOutcomeView,
  CardParts,
```

In `src/kanban/sink.ts`, replace:

```ts
  async set(_text: string): Promise<void> {}

  async finish(_text: string): Promise<void> {}
```

with:

```ts
  async set(_parts: CardParts): Promise<void> {}

  async finish(_parts: CardParts): Promise<void> {}
```

In `src/kanban/sink.ts`, replace:

```ts
  async openCard(_target: SendTarget, _initialText: string, uuid: string): Promise<CardSession> {
```

with:

```ts
  async openCard(_target: SendTarget, _initial: CardParts, uuid: string): Promise<CardSession> {
```

In `src/channel/lark/adapter.ts`, replace:

```ts
  type CardButton,
```

with:

```ts
  type CardButton,
  type CardParts,
```

In `src/channel/lark/adapter.ts`, replace:

```ts
import { forPlainText, truncate } from '../escape.js';
```

with:

```ts
import { forPlainText, truncate } from '../escape.js';
import { cardText } from '../render.js';
```

In `src/channel/lark/adapter.ts`, replace:

```ts
  async openCard(target: SendTarget, initialText: string, _uuid: string): Promise<CardSession> {
```

with:

```ts
  async openCard(target: SendTarget, initial: CardParts, _uuid: string): Promise<CardSession> {
```

In `src/channel/lark/adapter.ts`, replace:

```ts
            await controller.setContent(initialText);
```

with:

```ts
            await controller.setContent(cardText(initial));
```

In `src/channel/lark/adapter.ts`, replace:

```ts
      async set(text: string): Promise<void> {
        if (finished) return;
        try {
          await controller.setContent(text);
        } catch (err) {
          throw toChannelError(err);
        }
      },
      async finish(text: string): Promise<void> {
        // Idempotent: teardown reaches this from the writer's normal terminal
        // path and again from its shutdown path, and a second call must be inert
        // rather than an error.
        if (finished) return;
        finished = true;
        try {
          await controller.setContent(text);
```

with:

```ts
      async set(parts: CardParts): Promise<void> {
        if (finished) return;
        try {
          await controller.setContent(cardText(parts));
        } catch (err) {
          throw toChannelError(err);
        }
      },
      async finish(parts: CardParts): Promise<void> {
        // Idempotent: teardown reaches this from the writer's normal terminal
        // path and again from its shutdown path, and a second call must be inert
        // rather than an error.
        if (finished) return;
        finished = true;
        try {
          await controller.setContent(cardText(parts));
```

In `tests/helpers/channel.ts`, replace:

```ts
import type {
  ApprovalCardSpec,
  ApprovalOutcomeView,
  CardButton,
```

with:

```ts
import { cardText } from '../../src/channel/render.js';
import type {
  ApprovalCardSpec,
  ApprovalOutcomeView,
  CardButton,
  CardParts,
```

In `tests/helpers/channel.ts`, replace:

```ts
  readonly sets: string[] = [];
  readonly finishes: string[] = [];
```

with:

```ts
  /** Each set's and finish's parts, joined as the plain message joins them (`cardText`). */
  readonly sets: string[] = [];
  readonly finishes: string[] = [];
  /** The parts themselves, index-aligned with `sets` and `finishes`. */
  readonly partSets: CardParts[] = [];
  readonly partFinishes: CardParts[] = [];
```

In `tests/helpers/channel.ts`, replace:

```ts
  async set(text: string): Promise<void> {
    this.#owner.calls.push('set');
    // Before the gate, because the real adapter returns without reaching the
    // network at all -- so this cannot fail, and cannot be held.
    if (this.#frozen) {
      this.droppedSets.push(text);
      return;
    }
    await this.#owner.gate('set');
    this.sets.push(text);
  }

  async finish(text: string): Promise<void> {
```

with:

```ts
  async set(parts: CardParts): Promise<void> {
    this.#owner.calls.push('set');
    // Before the gate, because the real adapter returns without reaching the
    // network at all -- so this cannot fail, and cannot be held.
    if (this.#frozen) {
      this.droppedSets.push(cardText(parts));
      return;
    }
    await this.#owner.gate('set');
    this.sets.push(cardText(parts));
    this.partSets.push(parts);
  }

  async finish(parts: CardParts): Promise<void> {
```

In `tests/helpers/channel.ts`, replace:

```ts
    this.finishes.push(text);
```

with:

```ts
    this.finishes.push(cardText(parts));
    this.partFinishes.push(parts);
```

In `tests/helpers/channel.ts`, replace:

```ts
  async openCard(target: SendTarget, initialText: string, uuid: string): Promise<CardSession> {
    this.calls.push('openCard');
    await this.gate('openCard');
    const card = new FakeCard(this, `om_card_${++this.#seq}`, this.#clock.now());
    // The real adapter delivers the initial text as part of opening, so record it
    // the same way -- a test asserting on card content must not have to know
    // whether the first render arrived via open or via set.
    card.sets.push(initialText);
```

with:

```ts
  async openCard(target: SendTarget, initial: CardParts, uuid: string): Promise<CardSession> {
    this.calls.push('openCard');
    await this.gate('openCard');
    const card = new FakeCard(this, `om_card_${++this.#seq}`, this.#clock.now());
    // The real adapter delivers the initial text as part of opening, so record it
    // the same way -- a test asserting on card content must not have to know
    // whether the first render arrived via open or via set.
    card.sets.push(cardText(initial));
    card.partSets.push(initial);
```

In `tests/kanban-sink.test.ts`, replace:

```ts
    const card = await sink.openCard({ chatId: 'k_1', threadId: 'r_1' }, 'starting', 'u2');
    expect(card).toMatchObject({ messageId: 'kanban:u2', createdAt: NOW });
    await card.set('more');
    await card.finish('done');
```

with:

```ts
    const card = await sink.openCard({ chatId: 'k_1', threadId: 'r_1' }, { tools: '', answer: '', status: 'starting' }, 'u2');
    expect(card).toMatchObject({ messageId: 'kanban:u2', createdAt: NOW });
    await card.set({ tools: '', answer: 'more', status: '' });
    await card.finish({ tools: '', answer: 'more', status: 'done' });
```

In `tests/kanban-sink.test.ts`, replace:

```ts
    expect(await sink.openCard({ chatId: 'c_1', threadId: '7' }, 'starting', 'u2')).toMatchObject({ messageId: 'cron:u2', createdAt: NOW });
```

with:

```ts
    expect(await sink.openCard({ chatId: 'c_1', threadId: '7' }, { tools: '', answer: '', status: 'starting' }, 'u2')).toMatchObject({ messageId: 'cron:u2', createdAt: NOW });
```

- [ ] **Step 2.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2677 passed (2677)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 2.5: Commit.**

```bash
git add src/channel/types.ts src/channel/card-writer.ts src/kanban/sink.ts src/channel/lark/adapter.ts tests/helpers/channel.ts tests/card-writer.test.ts tests/kanban-sink.test.ts
git commit -m "Pass the reply card its parts rather than one text, from the card writer to the channel, the fake channel recording both, with no change yet to what a card shows"
```

---

### Task 3: The reply card's JSON

**Files:**

- Create: `tests/lark-reply-card.test.ts`
- Modify: `src/channel/lark/adapter.ts`

Decisions 5 and 6. `replyCard` and `replySummary`, pure, beside the adapter's other card builders. Nothing calls them until Task 4.

- [ ] **Step 3.1: Write the tests.**

Create `tests/lark-reply-card.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_PART, REPLY_ELEMENTS, REPLY_SUMMARY_OPEN, replyCard, replySummary } from '../src/channel/lark/adapter.js';

/**
 * The reply card as Lark is given it (channel spec §4.5): a streaming card of
 * three markdown elements, one a part, in reading order, each with an element id
 * the updates name.
 */

describe('replyCard', () => {
  it('is a streaming card of three markdown elements, the tool line, the answer and the status, in that order', () => {
    expect(replyCard({ tools: '✅ Bash', answer: 'Hello', status: '_Working…_' })).toEqual({
      schema: '2.0',
      config: {
        update_multi: true,
        streaming_mode: true,
        summary: { content: REPLY_SUMMARY_OPEN },
        streaming_config: {
          print_frequency_ms: { default: 70 },
          print_step: { default: 1 },
          print_strategy: 'fast',
        },
      },
      body: {
        elements: [
          { tag: 'markdown', element_id: 'tools', content: '✅ Bash' },
          { tag: 'markdown', element_id: 'answer', content: 'Hello' },
          { tag: 'markdown', element_id: 'status', content: '_Working…_' },
        ],
      },
    });
    expect(REPLY_ELEMENTS).toEqual({ tools: 'tools', answer: 'answer', status: 'status' });
  });

  it('gives a part with nothing to show a zero-width space, never an empty element', () => {
    const card = replyCard({ tools: '', answer: '', status: '_Working…_' }) as { body: { elements: Array<{ content: string }> } };
    expect(card.body.elements.map((e) => e.content)).toEqual([EMPTY_PART, EMPTY_PART, '_Working…_']);
    expect(EMPTY_PART).toBe('\u200b');
  });
});

describe('replySummary', () => {
  it('previews the answer on one line, cut to 50 characters', () => {
    expect(replySummary({ tools: '✅ Bash', answer: 'Line one\n\nline   two', status: '' })).toBe('Line one line two');
    const long = replySummary({ tools: '', answer: 'word '.repeat(30), status: '' });
    expect(Array.from(long)).toHaveLength(50);
    expect(long.endsWith('…')).toBe(true);
  });

  it('previews the status when there is no answer, then the tool line', () => {
    expect(replySummary({ tools: '✅ Bash', answer: '', status: '_Turn failed._' })).toBe('_Turn failed._');
    expect(replySummary({ tools: '✅ Bash', answer: '', status: '' })).toBe('✅ Bash');
  });

  it('cuts on a character, never half an emoji', () => {
    const preview = replySummary({ tools: '', answer: `${'a'.repeat(48)}😀😀😀`, status: '' });
    expect(Array.from(preview)).toEqual([...'a'.repeat(48), '😀', '…']);
  });
});
```

- [ ] **Step 3.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/lark-reply-card.test.ts`. Expected: `Tests  5 failed (5)`, the first as `TypeError: (0 , replyCard) is not a function`.

- [ ] **Step 3.3: Implement.**

In `src/channel/lark/adapter.ts`, replace:

```ts

/** The HTTP status of an error axios threw, if Lark answered at all. */
```

with:

```ts

/**
 * The reply card's element ids (channel spec §4.5): one markdown element a part,
 * named so each part's update goes to its own element.
 */
export const REPLY_ELEMENTS: Readonly<Record<keyof CardParts, string>> = { tools: 'tools', answer: 'answer', status: 'status' };

/** The parts in reading order: the tool line, the answer, the status. */
const REPLY_ORDER: ReadonlyArray<keyof CardParts> = ['tools', 'answer', 'status'];

/**
 * What a part with nothing to show is sent as: a zero-width space. Lark is never
 * given an empty element, which it may refuse, and draws this as nothing.
 */
export const EMPTY_PART = '\u200b';

/** The card's preview in the chat list while it streams. */
export const REPLY_SUMMARY_OPEN = 'Working…';

/** The longest preview a finished card is given, in characters, as the SDK's own streaming card cuts its. */
const SUMMARY_MAX = 50;

/** A part as an element's content: itself, or `EMPTY_PART`. */
export function partContent(part: string): string {
  return part === '' ? EMPTY_PART : part;
}

/**
 * The reply card, in Lark's card schema 2.0 (channel spec §4.5): streaming, so
 * Lark's client types each update, with the SDK's own streaming card's pace, one
 * character every 70 ms, `fast` showing what is buffered when a new update
 * comes; and three markdown elements, one a part, in reading order. The parts
 * were escaped and masked by the renderer.
 */
export function replyCard(parts: CardParts): object {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: REPLY_SUMMARY_OPEN },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: 'fast',
      },
    },
    body: {
      elements: REPLY_ORDER.map((part) => ({ tag: 'markdown', element_id: REPLY_ELEMENTS[part], content: partContent(parts[part]) })),
    },
  };
}

/**
 * A finished card's preview in the chat list: the answer, else the status, else
 * the tool line, on one line, cut to `SUMMARY_MAX` characters on a code point.
 */
export function replySummary(parts: CardParts): string {
  const text = [parts.answer, parts.status, parts.tools].find((p) => p.trim() !== '') ?? '';
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= SUMMARY_MAX ? chars.join('') : `${chars.slice(0, SUMMARY_MAX - 1).join('')}…`;
}

/** The HTTP status of an error axios threw, if Lark answered at all. */
```

- [ ] **Step 3.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2682 passed (2682)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 3.5: Commit.**

```bash
git add src/channel/lark/adapter.ts tests/lark-reply-card.test.ts
git commit -m "Build the reply card as a streaming card of three markdown elements, tools, answer and status, with a zero-width space for an empty part and a one-line preview for a finished card"
```

---

### Task 4: The reply card over Lark's card API

**Files:**

- Create: `tests/helpers/cardkit.ts`, `tests/lark-reply-session.test.ts`
- Modify: `src/channel/lark/adapter.ts`, `src/channel/types.ts`

Decisions 7 to 10. `openCard` makes the card, sends it by reference, and returns a session that writes each changed part to its own element. The fake cardkit client stands in for the SDK's client: it records every call in order, answers as Lark answers, and fails a call on request, thrown or in the body.

- [ ] **Step 4.1: Write the fake and the tests.**

Create `tests/helpers/cardkit.ts`:

```ts
import type { LarkChannel } from '@larksuiteoapi/node-sdk';

/**
 * A stand-in for the part of the Lark SDK the reply card uses (channel spec
 * §4.5): cardkit's card create, element content and card settings, and the
 * message send that carries the card by reference. Every call is recorded in
 * order and answered as Lark answers: a card id, a message id, `code: 0`, or
 * the failure queued for that call, thrown as axios throws an HTTP error or
 * returned in a 2xx body. It has no `stream`, so an adapter that still went
 * through the SDK's streaming card fails here. Nothing here reaches Lark.
 */

export type CardkitApi = 'create' | 'content' | 'settings' | 'send';

export interface CardkitCall {
  api: CardkitApi;
  cardId?: string;
  elementId?: string;
  content?: string;
  sequence?: number;
  uuid?: string;
  /** create: the card, parsed. settings: the settings, parsed. send: the message's content, parsed. */
  body?: unknown;
  /** send: a new message or a reply. */
  kind?: 'create' | 'reply';
  /** send: the chat, or the message replied to. */
  to?: string;
  msgType?: string;
  replyInThread?: boolean;
}

/** A failure as Lark gives one: an Error is thrown, a code is answered in the body. */
export type CardkitFailure = Error | { code: number; msg: string };

interface Answer {
  code?: number;
  msg?: string;
  data?: object;
}

interface SendPayload {
  params?: { receive_id_type: string };
  path?: { message_id: string };
  data: { receive_id?: string; msg_type: string; content: string; uuid: string; reply_in_thread?: boolean };
}

/** An HTTP error as axios throws one: Lark's code in the response body. */
export function refused(code: number, status = 400): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { code, msg: `refused ${code}` }, headers: {} },
  });
}

export class FakeCardkit {
  readonly calls: CardkitCall[] = [];
  readonly #failures = new Map<CardkitApi, CardkitFailure[]>();
  #cards = 0;
  #messages = 0;

  /** Make the next call to `api` fail with `failure`. Queued, so N in a row work. */
  failNext(api: CardkitApi, failure: CardkitFailure): void {
    const queue = this.#failures.get(api) ?? [];
    queue.push(failure);
    this.#failures.set(api, queue);
  }

  /** The content each update sent `elementId`, in order, those Lark refused among them. */
  contents(elementId: string): string[] {
    return this.calls.filter((c) => c.api === 'content' && c.elementId === elementId).map((c) => c.content ?? '');
  }

  /**
   * What `elementId` of `cardId` was given, in order, as Lark's client would
   * receive it: its content in the card as created, then each update Lark took.
   */
  shown(cardId: string, elementId: string, refusedSequences: readonly number[] = []): string[] {
    const created = this.calls.findIndex((c) => c.api === 'create' && c.cardId === cardId);
    const card = this.calls[created]?.body as { body: { elements: Array<{ element_id: string; content: string }> } } | undefined;
    const initial = card?.body.elements.find((e) => e.element_id === elementId)?.content;
    const updates = this.calls
      .filter((c) => c.api === 'content' && c.cardId === cardId && c.elementId === elementId && !refusedSequences.includes(c.sequence ?? -1))
      .map((c) => c.content ?? '');
    return initial === undefined ? updates : [initial, ...updates];
  }

  /** Every sequence `cardId` was given, content updates and settings alike, in order. */
  sequences(cardId: string): number[] {
    return this.calls.filter((c) => c.cardId === cardId && c.sequence !== undefined).map((c) => c.sequence ?? 0);
  }

  #answer(call: CardkitCall, success: Answer): Answer {
    this.calls.push(call);
    const failure = this.#failures.get(call.api)?.shift();
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) return failure;
    return success;
  }

  readonly lark: LarkChannel = {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: async (p: { data: { type: string; data: string } }) => {
              const cardId = `card_${this.#cards + 1}`;
              const answer = this.#answer({ api: 'create', cardId, body: JSON.parse(p.data.data) }, { code: 0, msg: 'ok', data: { card_id: cardId } });
              if (answer.code === 0) this.#cards += 1;
              return answer;
            },
            settings: async (p: { path: { card_id: string }; data: { settings: string; sequence: number; uuid?: string } }) =>
              this.#answer(
                {
                  api: 'settings',
                  cardId: p.path.card_id,
                  sequence: p.data.sequence,
                  ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
                  body: JSON.parse(p.data.settings),
                },
                { code: 0, msg: 'ok', data: {} },
              ),
          },
          cardElement: {
            content: async (p: { path: { card_id: string; element_id: string }; data: { content: string; sequence: number; uuid?: string } }) =>
              this.#answer(
                {
                  api: 'content',
                  cardId: p.path.card_id,
                  elementId: p.path.element_id,
                  content: p.data.content,
                  sequence: p.data.sequence,
                  ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
                },
                { code: 0, msg: 'ok', data: {} },
              ),
          },
        },
      },
      im: {
        v1: {
          message: {
            create: async (p: SendPayload) => this.#send('create', p.data.receive_id ?? '', p),
            reply: async (p: SendPayload) => this.#send('reply', p.path?.message_id ?? '', p),
          },
        },
      },
    },
  } as unknown as LarkChannel;

  #send(kind: 'create' | 'reply', to: string, p: SendPayload): Answer {
    const body = JSON.parse(p.data.content) as { data?: { card_id?: string } };
    const answer = this.#answer(
      {
        api: 'send',
        kind,
        to,
        msgType: p.data.msg_type,
        uuid: p.data.uuid,
        body,
        ...(body.data?.card_id === undefined ? {} : { cardId: body.data.card_id }),
        ...(p.data.reply_in_thread === undefined ? {} : { replyInThread: p.data.reply_in_thread }),
      },
      { code: 0, msg: 'ok', data: { message_id: `om_${this.#messages + 1}` } },
    );
    if (answer.code === 0) this.#messages += 1;
    return answer;
  }
}
```

Create `tests/lark-reply-session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_PART, LarkAdapter, replyCard } from '../src/channel/lark/adapter.js';
import { CARD_GONE_CODES, ChannelError, type CardParts } from '../src/channel/types.js';
import { FakeCardkit, refused } from './helpers/cardkit.js';
import { ManualClock } from './helpers/db.js';

/**
 * The reply card's session over Lark's card API (channel spec §4.5): the card
 * is created with its three elements and sent by reference, each part that
 * changed is written to its own element with the card's next sequence, and
 * finishing turns streaming off. Over a stand-in for the SDK: nothing here
 * reaches Lark.
 */

const NOW = 1_760_000_000_000;

function adapter(): { a: LarkAdapter; kit: FakeCardkit; waits: number[]; clock: ManualClock } {
  const kit = new FakeCardkit();
  const waits: number[] = [];
  const clock = new ManualClock(NOW);
  const a = new LarkAdapter({ appId: 'cli_app', appSecret: 'not-a-secret' }, clock, {
    lark: kit.lark,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  // Before anything is sent: an adapter that built its own SDK channel would reach Lark.
  if (a.raw !== kit.lark) throw new Error('the adapter did not take the stand-in for the SDK');
  return { a, kit, waits, clock };
}

const CHAT = { chatId: 'oc_team', threadId: '' };

function parts(answer: string, tools = '', status = ''): CardParts {
  return { tools, answer, status };
}

/** The content updates, as [element, content, sequence]. */
function updates(kit: FakeCardkit): Array<[string | undefined, string | undefined, number | undefined]> {
  return kit.calls.filter((c) => c.api === 'content').map((c) => [c.elementId, c.content, c.sequence]);
}

describe('LarkAdapter.openCard', () => {
  it('creates the card with its parts, then sends it by reference, with a uuid of its own', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('Hi', '• Bash'), 'u_7');
    expect(kit.calls.map((c) => c.api)).toEqual(['create', 'send']);
    expect(kit.calls[0]?.body).toEqual(replyCard(parts('Hi', '• Bash')));
    expect(kit.calls[1]).toMatchObject({
      api: 'send',
      kind: 'create',
      to: 'oc_team',
      msgType: 'interactive',
      body: { type: 'card', data: { card_id: 'card_1' } },
      uuid: 'reply_card_1',
    });
    expect(card).toMatchObject({ messageId: 'om_1', createdAt: NOW });
  });

  it('sends the card where the target says: a quoted reply, or in its thread', async () => {
    const quoted = adapter();
    await quoted.a.openCard({ ...CHAT, replyTo: 'om_ask' }, parts('Hi'), 'u');
    expect(quoted.kit.calls[1]).toMatchObject({ kind: 'reply', to: 'om_ask' });
    expect(quoted.kit.calls[1]?.replyInThread).toBeUndefined();
    const thread = adapter();
    await thread.a.openCard({ chatId: 'oc_team', threadId: 'omt_1', root: 'om_root' }, parts('Hi'), 'u');
    expect(thread.kit.calls[1]).toMatchObject({ kind: 'reply', to: 'om_root', replyInThread: true });
  });

  it('retries a send Lark throttled with the same uuid, and creates the card once', async () => {
    const { a, kit, waits } = adapter();
    kit.failNext('send', refused(230020));
    const card = await a.openCard(CHAT, parts('Hi'), 'u');
    expect(kit.calls.map((c) => [c.api, c.uuid])).toEqual([
      ['create', undefined],
      ['send', 'reply_card_1'],
      ['send', 'reply_card_1'],
    ]);
    expect(waits).toHaveLength(1);
    expect(card.messageId).toBe('om_1');
  });

  it('fails with the code Lark gave when the card cannot be made or sent', async () => {
    const made = adapter();
    made.kit.failNext('create', { code: 200621, msg: 'card content invalid' });
    await expect(made.a.openCard(CHAT, parts('Hi'), 'u')).rejects.toMatchObject({ code: 200621, retryable: false });
    expect(made.kit.calls.map((c) => c.api)).toEqual(['create']);
    const thrown = adapter();
    thrown.kit.failNext('create', refused(99991400, 429));
    await expect(thrown.a.openCard(CHAT, parts('Hi'), 'u')).rejects.toBeInstanceOf(ChannelError);
    const sent = adapter();
    sent.kit.failNext('send', refused(230002));
    await expect(sent.a.openCard(CHAT, parts('Hi'), 'u')).rejects.toMatchObject({ code: 230002 });
  });
});

describe('LarkAdapter card session', () => {
  it('writes only the parts that changed, each to its own element, with the card\'s next sequence', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('Hel'), 'u');
    await card.set(parts('Hello', '⏳ Bash'));
    await card.set(parts('Hello', '✅ Bash'));
    await card.set(parts('Hello wor', '✅ Bash'));
    await card.set(parts('Hello wor', '✅ Bash'));
    expect(updates(kit)).toEqual([
      ['tools', '⏳ Bash', 1],
      ['answer', 'Hello', 2],
      ['tools', '✅ Bash', 3],
      ['answer', 'Hello wor', 4],
    ]);
    expect(kit.calls.filter((c) => c.api === 'content').map((c) => c.uuid)).toEqual(['c_card_1_1', 'c_card_1_2', 'c_card_1_3', 'c_card_1_4']);
  });

  it('sends a part that has emptied as a zero-width space', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', '_Working…_'), 'u');
    await card.set(parts('First words'));
    expect(updates(kit)).toEqual([
      ['answer', 'First words', 1],
      ['status', EMPTY_PART, 2],
    ]);
  });

  it('fails with the code Lark gave, and writes again what did not land, with a new sequence', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    kit.failNext('content', { code: 200750, msg: 'card not found' });
    const gone = await card.set(parts('ab')).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(ChannelError);
    expect(CARD_GONE_CODES.has((gone as ChannelError).code)).toBe(true);
    kit.failNext('content', refused(99991400, 429));
    await expect(card.set(parts('ab'))).rejects.toMatchObject({ code: 99991400, retryable: true });
    await card.set(parts('ab'));
    expect(updates(kit)).toEqual([
      ['answer', 'ab', 1],
      ['answer', 'ab', 2],
      ['answer', 'ab', 3],
    ]);
  });

  it('finishes with the parts that changed, then turns streaming off with a preview, once', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('Done', '✅ Bash'), 'u');
    await card.finish(parts('Done.', '✅ Bash'));
    await card.finish(parts('Done. Again', '✅ Bash'));
    await card.set(parts('Done. Later', '✅ Bash'));
    expect(kit.calls.slice(2).map((c) => [c.api, c.elementId, c.sequence])).toEqual([
      ['content', 'answer', 1],
      ['settings', undefined, 2],
    ]);
    expect(kit.calls.at(-1)).toMatchObject({
      uuid: 's_card_1_2',
      body: { config: { streaming_mode: false, summary: { content: 'Done.' } } },
    });
  });

  it('still turns streaming off when the last update fails, and does not throw', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    kit.failNext('content', refused(230020));
    kit.failNext('settings', new Error('socket hang up'));
    await expect(card.finish(parts('ab'))).resolves.toBeUndefined();
    expect(kit.calls.slice(2).map((c) => c.api)).toEqual(['content', 'settings']);
    // Inert afterwards, as a finished card is.
    await card.set(parts('abc'));
    expect(kit.calls).toHaveLength(4);
  });

  it('keeps one sequence for the whole card, strictly increasing over every call', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a', '• Read'), 'u');
    await card.set(parts('ab', '✅ Read', '_Waiting for your approval: see the card below._'));
    await card.set(parts('abc', '✅ Read'));
    await card.finish(parts('abcd', '✅ Read ×2', '_Turn cancelled._'));
    expect(kit.sequences('card_1')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
```

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/lark-reply-session.test.ts`. Expected: `Tests  10 failed (10)`, each as `TypeError: this[#lark].stream is not a function`, the fourth as the error its `rejects` matched against `{ code: 200621, retryable: false }`: the adapter still opens the SDK's streaming card, which the fake has not got.

- [ ] **Step 4.3: Implement.**

In `src/channel/lark/adapter.ts`, replace:

```ts
import { createLarkChannel, type LarkChannel, type MarkdownStreamController } from '@larksuiteoapi/node-sdk';
import {
  ChannelError,
  type ApprovalCardSpec,
  type ApprovalOutcomeView,
  type CardButton,
  type CardParts,
  type CardSession,
  type CardView,
  type Channel,
  type ChatMembers,
  type SendResult,
  type SendTarget,
  ONE_MESSAGE,
} from '../types.js';
import { forPlainText, truncate } from '../escape.js';
import { cardText } from '../render.js';
import { backoffMs, toChannelError } from './errors.js';
import type { Clock } from '../../time.js';
import { systemClock } from '../../time.js';
import { PRODUCT_NAME } from '../../identity.js';

/**
 * The Lark implementation of the outbound `Channel` port.
 *
 * Built on the SDK's high-level `Channel` module rather than raw API calls. That
 * is a deliberate bet: the module already owns per-chat queueing, the streaming
 * card lifecycle, and the 30,000-character element rollover, and reimplementing
 * those on top of `im.v1.*` means owning three pieces of fiddly behaviour whose
 * failure modes are all silent. The cost of the bet is that the card lifecycle is
 * shaped by its producer callback, which is why `CardSession` exists.
 *
 * **The uuid.** The SDK's high-level `send`/`stream` do not expose Feishu's
 * `uuid` field, so every message that goes out as one message -- a text of up to
 * `ONE_MESSAGE` characters, an approval card, a board card -- is sent through the
 * SDK's own client instead (`im.v1.message.create` or `reply`), with the uuid:
 * Feishu then sends one message for any number of sends with the same uuid
 * within an hour, so a retry, or a notice sent again after a restart, is one
 * message (spec §9.4). A longer text is split by the SDK into several messages,
 * and a streamed card is the SDK's to send; neither carries the uuid, so a retry
 * of those can still post a second copy.
```

with:

```ts
import { createLarkChannel, type LarkChannel } from '@larksuiteoapi/node-sdk';
import {
  ChannelError,
  type ApprovalCardSpec,
  type ApprovalOutcomeView,
  type CardButton,
  type CardParts,
  type CardSession,
  type CardView,
  type Channel,
  type ChatMembers,
  type SendResult,
  type SendTarget,
  ONE_MESSAGE,
} from '../types.js';
import { forPlainText, truncate } from '../escape.js';
import { backoffMs, toChannelError } from './errors.js';
import type { Clock } from '../../time.js';
import { systemClock } from '../../time.js';
import { PRODUCT_NAME } from '../../identity.js';

/**
 * The Lark implementation of the outbound `Channel` port.
 *
 * Built on the SDK's high-level `Channel` module rather than raw API calls, for
 * the connection, inbound events and the longer text sends. The reply card is
 * the exception (channel spec §4.5): the SDK's streaming card has one element,
 * so a tool line above the answer made every tool event retype the whole
 * answer. The card is driven through Lark's card API instead, one element a
 * part, with the SDK's own client. Its rollover past 30,000 characters is not
 * needed: no part is let grow past `CARD_TEXT_BUDGET`, 20,000.
 *
 * **The uuid.** The SDK's high-level `send`/`stream` do not expose Feishu's
 * `uuid` field, so every message that goes out as one message -- a text of up to
 * `ONE_MESSAGE` characters, an approval card, a board card -- is sent through the
 * SDK's own client instead (`im.v1.message.create` or `reply`), with the uuid:
 * Feishu then sends one message for any number of sends with the same uuid
 * within an hour, so a retry, or a notice sent again after a restart, is one
 * message (spec §9.4). The reply card is sent so too, with a uuid of its own
 * (`openCard`). A longer text is split by the SDK into several messages, with
 * no uuid, so a retry of one can still post a second copy.
```

In `src/channel/lark/adapter.ts`, replace:

```ts
   * Open a streaming card.
   *
   * `stream()` does not return until its producer resolves, so it cannot be
   * awaited here -- the card has to stay writable for the length of a turn. What
   * this does instead is start `stream()`, wait for the producer to hand over its
   * controller, and return a session that drives it.
   *
   * The producer is held open by a promise that `finish()` resolves. That is the
   * whole trick, and it has one hard requirement: **`finish()` must be reached on
   * every path**, including failure, or `stream()` never settles and the card
   * shows a typing indicator forever.
   */
  async openCard(target: SendTarget, initial: CardParts, _uuid: string): Promise<CardSession> {
    const clock = this.#clock;

    let onController: (c: MarkdownStreamController) => void;
    let onFailed: (e: unknown) => void;
    const ready = new Promise<MarkdownStreamController>((resolve, reject) => {
      onController = resolve;
      onFailed = reject;
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const streaming = this.#lark
      .stream(
        target.chatId,
        {
          markdown: async (controller) => {
            await controller.setContent(cardText(initial));
            onController(controller);
            await held;
          },
        },
        this.#sendOptions(target),
      )
      .catch((err: unknown) => {
        // Surfaced to whichever side is waiting. Before handover this rejects
        // `openCard`; after it, the failure is reported through `set`/`finish`.
        onFailed(err);
        // Unblock the producer so a failed stream cannot leave `finish()` hanging.
        release();
        throw toChannelError(err);
      });
    // The rejection is consumed by whoever awaits `streaming`; this keeps it from
    // surfacing as an unhandled rejection in the meantime.
    void streaming.catch(() => undefined);

    let controller: MarkdownStreamController;
    try {
      controller = await ready;
    } catch (err) {
      throw toChannelError(err);
    }

    const createdAt = clock.now();
    let finished = false;

    return {
      messageId: controller.messageId,
      createdAt,
      async set(parts: CardParts): Promise<void> {
        if (finished) return;
        try {
          await controller.setContent(cardText(parts));
        } catch (err) {
          throw toChannelError(err);
        }
      },
      async finish(parts: CardParts): Promise<void> {
        // Idempotent: teardown reaches this from the writer's normal terminal
        // path and again from its shutdown path, and a second call must be inert
        // rather than an error.
        if (finished) return;
        finished = true;
        try {
          await controller.setContent(cardText(parts));
        } catch {
          // The content update failed, but the producer still has to be released.
          // Leaving it held would hang `stream()` and, with it, the card.
        }
        release();
        await streaming.catch(() => undefined);
      },
    };
  }

```

with:

```ts
   * Open the reply card (channel spec §4.5), over Lark's card API directly.
   *
   * The card is made first, as a card entity with its three elements, then sent
   * by reference, a message of its own: placed as `#post` places any message,
   * and retried as one, with a uuid. The uuid is the card's, not the writer's:
   * the writer's is also the uuid of the plain message it falls back to for the
   * same seq, and of a card it opens again at the same seq once one has gone,
   * and Lark would answer either with this card's message rather than send it.
   * A card is sent once; a retry of the send is the same card, so the same uuid.
   *
   * Making the card is not retried here: an entity never sent costs nothing,
   * and the writer retries the whole open with the newest render.
   *
   * `createdAt` is read before the card is made, as an entity's 14 days run
   * from its making.
   */
  async openCard(target: SendTarget, initial: CardParts, _uuid: string): Promise<CardSession> {
    const cardkit = this.#lark.rawClient.cardkit.v1;
    const createdAt = this.#clock.now();

    let made: { code?: number | undefined; msg?: string | undefined; data?: { card_id: string } | undefined };
    try {
      made = await cardkit.card.create({ data: { type: 'card_json', data: JSON.stringify(replyCard(initial)) } });
    } catch (err) {
      throw sendError(err);
    }
    if (typeof made.code === 'number' && made.code !== 0) throw toChannelError(made);
    const cardId = made.data?.card_id;
    if (cardId === undefined || cardId === '') throw new ChannelError(0, 'Lark made the card with no card id', false);

    const sent = await this.#withRetry(() =>
      this.#post(target, 'interactive', { type: 'card', data: { card_id: cardId } }, `reply_${cardId}`.slice(0, 50)),
    );

    // What each element shows, as far as Lark has said it took it: an update is
    // sent only for a part that differs, and a part whose update failed is sent
    // again by the next write.
    const shown: Record<keyof CardParts, string> = {
      tools: partContent(initial.tools),
      answer: partContent(initial.answer),
      status: partContent(initial.status),
    };
    // One sequence for the card, every update and the settings drawing the next:
    // Lark orders a card's updates by it, and refuses one not above the last.
    let sequence = 0;
    let finished = false;

    const write = async (parts: CardParts): Promise<void> => {
      for (const part of REPLY_ORDER) {
        const content = partContent(parts[part]);
        if (content === shown[part]) continue;
        sequence += 1;
        const at = sequence;
        await cardkitCall(() =>
          cardkit.cardElement.content({
            path: { card_id: cardId, element_id: REPLY_ELEMENTS[part] },
            data: { content, sequence: at, uuid: `c_${cardId}_${at}` },
          }),
        );
        shown[part] = content;
      }
    };

    return {
      messageId: sent.messageId,
      createdAt,
      async set(parts: CardParts): Promise<void> {
        // Inert once finished: streaming is off, and the card is done.
        if (finished) return;
        await write(parts);
      },
      async finish(parts: CardParts): Promise<void> {
        // Idempotent: teardown reaches this from the writer's normal terminal
        // path and again from its shutdown path, and a second call must be inert
        // rather than an error.
        if (finished) return;
        finished = true;
        try {
          await write(parts);
        } catch {
          // The last content did not land, but streaming still has to be turned
          // off, or the card shows its typing cursor until Lark gives up on it.
        }
        sequence += 1;
        const at = sequence;
        try {
          await cardkitCall(() =>
            cardkit.card.settings({
              path: { card_id: cardId },
              data: {
                settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: replySummary(parts) } } }),
                sequence: at,
                uuid: `s_${cardId}_${at}`,
              },
            }),
          );
        } catch {
          // Best effort, as finishing has always been: the card keeps what it
          // shows, and nothing writes to it again.
        }
      },
    };
  }
```

In `src/channel/lark/adapter.ts`, replace:

```ts

/** The HTTP status of an error axios threw, if Lark answered at all. */
```

with:

```ts

/**
 * One call to Lark's card API, answered with `code` 0 or failed with Lark's code:
 * thrown, as axios throws an HTTP error, or in the body of a 2xx.
 */
async function cardkitCall(request: () => Promise<{ code?: number | undefined; msg?: string | undefined }>): Promise<void> {
  let r: { code?: number | undefined; msg?: string | undefined };
  try {
    r = await request();
  } catch (err) {
    throw sendError(err);
  }
  if (typeof r.code === 'number' && r.code !== 0) throw toChannelError(r);
}

/** The HTTP status of an error axios threw, if Lark answered at all. */
```

In `src/channel/types.ts`, replace:

```ts
 * This shape is dictated by what the platform actually offers. Feishu's streaming
 * card API is a *producer*: you hand it a callback and it owns the card's
 * lifecycle for the duration, handling throttling and the 30,000-character
 * element rollover itself. A create/update/close triple would either reimplement
 * that or fight it.
```

with:

```ts
 * The session holds what the card's updates need and nothing persists: the
 * card's next sequence, and what each element was last given, so only a part
 * that changed is written (channel spec §4.5).
```

- [ ] **Step 4.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2692 passed (2692)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors. `grep -rn "\.stream(\|MarkdownStreamController" src` prints nothing.

- [ ] **Step 4.5: Commit.**

```bash
git add src/channel/lark/adapter.ts src/channel/types.ts tests/helpers/cardkit.ts tests/lark-reply-session.test.ts
git commit -m "Drive the reply card through Lark's card API: make it, send it by reference with its own uuid, write each changed part to its own element with the card's next sequence, and finish by turning streaming off, tested over a fake cardkit client"
```

---

### Task 5: The bug, replayed end to end

**Files:**

- Create: `tests/card-parts-replay.test.ts`

§4.5's last test. The card writer, the adapter and the fake cardkit client over one turn of interleaved tool events, answer chunks and an approval, a write after every event. It passes once written, because Tasks 1 to 4 built what it checks; Step 5.3 breaks the adapter on purpose to show it measures that.

- [ ] **Step 5.1: Write the test.**

Create `tests/card-parts-replay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CardWriter } from '../src/channel/card-writer.js';
import { EMPTY_PART, LarkAdapter, REPLY_ELEMENTS } from '../src/channel/lark/adapter.js';
import { renderCard } from '../src/channel/render.js';
import type { Event, EventType } from '../src/types.js';
import { FakeCardkit } from './helpers/cardkit.js';
import { ManualClock } from './helpers/db.js';

/**
 * The bug this fixes, replayed end to end (channel spec §4.5): a turn of answer
 * chunks with tool calls and their updates between them, written by the card
 * writer through the Lark adapter to a stand-in for Lark's card API, a write
 * after every event. Lark's client types an element's new text from where the
 * old one ends only when the old text starts the new one, so every update the
 * answer element is given must start with what it was given before.
 */

const NOW = 1_760_000_000_000;

function ev(seq: number, type: EventType, payload: unknown): Event {
  return {
    sessionId: 's_1',
    seq,
    type,
    actor: type === 'turn_submitted' ? 'user' : 'agent',
    generation: 0,
    payload,
    ts: NOW,
    brokerSeq: null,
    turnId: 't_1',
  };
}

const TURN: Array<[EventType, unknown]> = [
  ['turn_submitted', { text: 'fix the build' }],
  ['tool_call', { toolCallId: 'c1', title: 'Bash', status: 'pending' }],
  ['tool_call_update', { toolCallId: 'c1', status: 'in_progress' }],
  ['agent_message_chunk', { text: 'The build fails ' }],
  ['tool_call_update', { toolCallId: 'c1', status: 'completed' }],
  ['agent_message_chunk', { text: 'in `main.ts`.' }],
  ['tool_call', { toolCallId: 'c2', title: 'Read', status: 'in_progress' }],
  ['tool_call', { toolCallId: 'c3', title: 'Read', status: 'in_progress' }],
  ['tool_call_update', { toolCallId: 'c2', status: 'completed' }],
  ['agent_message_chunk', { text: 'Line 12 ' }],
  ['tool_call_update', { toolCallId: 'c3', status: 'completed' }],
  ['approval_requested', { approvalId: 'a1' }],
  ['approval_resolved', { approvalId: 'a1' }],
  ['tool_call', { toolCallId: 'c4', title: 'Edit', status: 'completed' }],
  ['agent_message_chunk', { text: 'had a typo. ' }],
  ['tool_call', { toolCallId: 'c5', title: 'Bash', status: 'completed' }],
  ['agent_message_chunk', { text: 'Fixed, and the build passes.' }],
  ['turn_ended', { terminal: 'completed' }],
];

async function replay(): Promise<{ kit: FakeCardkit; log: Event[] }> {
  const kit = new FakeCardkit();
  const clock = new ManualClock(NOW);
  const adapter = new LarkAdapter({ appId: 'cli_app', appSecret: 'not-a-secret' }, clock, { lark: kit.lark, sleep: async () => undefined });
  const log: Event[] = [];
  const writer = new CardWriter({
    channel: adapter,
    target: { chatId: 'oc_chat', threadId: '' },
    readEvents: (afterSeq, throughSeq) => log.filter((e) => e.seq > afterSeq && e.seq <= throughSeq),
    onRendered: () => undefined,
    onCardChanged: () => undefined,
    sendUuid: (seq) => `uuid_${seq}`,
    clock,
  });
  for (const [type, payload] of TURN) {
    log.push(ev(log.length + 1, type, payload));
    writer.want(log.length);
    await writer.flushNow();
  }
  await writer.close();
  return { kit, log };
}

describe('the reply card, a turn replayed', () => {
  it('only ever grows the answer element at its end, while tool events rewrite the tool line on its own', async () => {
    const { kit } = await replay();
    expect(kit.calls.filter((c) => c.api === 'create')).toHaveLength(1);

    const answer = kit.shown('card_1', REPLY_ELEMENTS.answer).filter((c) => c !== EMPTY_PART);
    expect(answer.length).toBeGreaterThan(3);
    for (let i = 1; i < answer.length; i += 1) {
      expect(answer[i]?.startsWith(answer[i - 1] ?? ''), `update ${i}: ${JSON.stringify(answer[i - 1])} then ${JSON.stringify(answer[i])}`).toBe(true);
    }
    // A tool call between two chunks starts a new paragraph (see `renderCard`).
    expect(answer.at(-1)).toBe('The build fails \n\nin `main.ts`.\n\nLine 12 \n\nhad a typo. \n\nFixed, and the build passes.');

    // The tool line moved on its own: more updates than the answer had, none of them to the answer.
    const tools = kit.contents(REPLY_ELEMENTS.tools);
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.at(-1)).toBe('✅ Bash ×2 · ✅ Read ×2 · ✅ Edit');
    // The approval's wait line came and went below the answer, not in it.
    expect(kit.contents(REPLY_ELEMENTS.status)).toContain('_Waiting for your approval: see the card below._');

    // One sequence for the card, strictly increasing, ending with streaming turned off.
    const sequences = kit.sequences('card_1');
    expect(sequences).toEqual(sequences.map((_s, i) => i + 1));
    expect(kit.calls.at(-1)).toMatchObject({ api: 'settings', body: { config: { streaming_mode: false } } });
  });

  it('is the case the old card failed: the same turn as one text is rewritten from its start', async () => {
    // Broken on purpose, to show the replay measures something: the renders the
    // writer sent, as the single text the old card was given.
    const { log } = await replay();
    const texts = log.map((_e, i) => renderCard(log.slice(0, i + 1)).text);
    const rewrites = texts.filter((t, i) => i > 0 && !t.startsWith(texts[i - 1] ?? ''));
    expect(rewrites.length).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 5.2: Run it.** Run `npx vitest run --project unit tests/card-parts-replay.test.ts`. Expected: `Tests  2 passed (2)`.

- [ ] **Step 5.3: See it measure.** In `src/channel/lark/adapter.ts`, change the line `        const content = partContent(parts[part]);` to `        const content = partContent(part === 'answer' ? [parts.tools, parts.answer].join('\n\n') : parts[part]);`, which puts the tool line back at the start of the answer element. Run `npx vitest run --project unit tests/card-parts-replay.test.ts`. Expected: `Tests  1 failed | 1 passed (2)`, as `AssertionError: update 1: "• Bash\n\n" then "⏳ Bash\n\n": expected false to be true`. Run `git checkout src/channel/lark/adapter.ts` to undo it, and `git diff --stat` shows nothing.

- [ ] **Step 5.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2694 passed (2694)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors. Run `npm run build`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add tests/card-parts-replay.test.ts
git commit -m "Replay a turn of interleaved tool events and answer chunks through the card writer and the Lark adapter, and check that every update the answer element is given starts with the one before"
```

---

## Done when

- `npx vitest run --project unit` gives `Tests  2694 passed (2694)`, run twice. `npx vitest run --project e2e` gives `Tests  173 passed (173)`. `npm run typecheck` and `npm run build` report no errors. All under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing, and `git diff 62ec9c3 -- 'src/*.ts' 'src/**/*.ts' | grep "^+" | grep -c "—"` prints `0`.
- Over every render of a turn, the answer part starts with the one before, but in the cases §4.5 names (`tests/render-parts.test.ts`); over a turn replayed through the writer and the adapter, every update the answer element is given starts with the one before (`tests/card-parts-replay.test.ts`).
- The reply card is made, sent by reference with its own uuid, written part by part with one strictly increasing sequence, and finished with streaming off, with no call to the SDK's streaming card (`tests/lark-reply-session.test.ts`).
- Approval cards, board cards and notices are unchanged: their tests pass as they are.

## Before relying on it: the smoke checklist

For the user, once the plan is built and merged, on the Mac with the real Lark tenant. Run each command as the gateway's user. `<node>` is `~/.nvm/versions/node/v22.15.0/bin/node`, and `<mt>` is `<node> <checkout>/dist/mt.js`: never a bare `node`, `npm` or `mt`. Every build runs under the same Node 22.15: `cd <checkout> && PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH npm run build`, then `<mt> service restart`. No migration, so no backup is needed; going back is building the commit before this plan and restarting. Each item names the point of §4.5's "Only a live check can confirm" it settles.

1. **The answer types only its new words** (point 1). In a direct message, ask the agent for something that takes several tool calls and a long answer, such as "Read three files of this repo, one at a time, and explain each in a paragraph". Watch the card while it works: the tool line on top changes as each call starts and ends, and the answer below it never disappears; each new sentence is typed after the last. Before this plan the whole answer vanished and was typed again after nearly every tool call.
2. **The tool line on its own** (point 2). In the same turn, watch the tool line when a call's icon changes, `⏳` to `✅`: note whether the line is typed again from its start or changes at once. Either is acceptable; it is the line alone either way.
3. **The empty parts** (point 3). Right after you send, before any answer, the card shows `Working…` with no blank band above it worth noticing; when the answer starts there is no gap between the tool line and the answer, nor below the answer when there is no status.
4. **The sequence** (point 4). `<mt> service logs -n 200` shows no `card write through … failed` line for the turns above. A line with a code there, such as one about the sequence, means Lark refused an update: note its code.
5. **A long turn** (point 5). Ask for work that runs past ten minutes, such as "Run `sleep 700`, then tell me it finished". Note whether the card keeps updating after ten minutes. If it does not, the answer still arrives at the end as a plain message, and `<mt> service logs -n 200` shows five `card write through … failed` lines with Lark's code, then `gave up on the card through …; sent it as a plain message`.
6. **The preview** (point 6). While a card streams, the chat list shows the bot's last message as "Working…"; once the turn ends, the answer's first words.
7. **The status lines.** Ask for something that needs an approval: `_Waiting for your approval: see the card below._` shows under the answer, not above it, and goes once you answer; the answer above it does not re-type. A turn you stop with `@bot /stop` ends with its `_Turn …._` line under the answer.
8. **Where the card goes.** In a group, `@bot` a question outside a thread: the card quotes your message, as before. In a thread: the card is in the thread.
