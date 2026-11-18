# Plan C5: The reply card's parts. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Lark reply card typing its answer out again from the start on every tool event. The card becomes three markdown elements: the tool summary line, the answer, and the status (the error, the approval-wait line, the terminal line, the retry hint, the placeholder). A tool event rewrites the tool line alone; the answer only grows at its end while the turn streams, so Lark's client types only the new words. The adapter drives the reply card through Lark's card API with the SDK's own client, in place of the SDK's one-element streaming card, and keeps it streaming past Lark's ten-minute timeout. A finish whose last write fails is a failure the writer counts. The writer waits after a failure, lets throttles wait before they count, finishes a card it gives up on, and holds a write that changes only the tool line for two seconds.

**Architecture:**
- **The render** (Task 1): `renderCard` returns `parts: CardParts`, `{ tools, answer, status }`, beside `text`, which is now `cardText(parts)`, the parts joined as before, so the plain-message fallback and every test that reads the text are unchanged. The answer keeps `CARD_TEXT_BUDGET`; the tool line and the status get 2,000 characters each.
- **The port** (Task 2): `CardSession.set` and `.finish`, and `Channel.openCard`, take `CardParts`. The writer passes the render's parts; the fake channel records them beside the joined text; the sinks discard them. The adapter, for this one task, still joins them for the SDK's streaming card, so nothing a person sees changes yet.
- **The card** (Task 3): `replyCard(parts)`, a schema 2.0 streaming card of three markdown elements with the ids `tools`, `answer` and `status`, and `replySummary(parts)`, the finished card's chat-list preview. Pure.
- **The session** (Task 4): `openCard` makes the card with `cardkit.v1.card.create`, sends it by reference through the adapter's own one-message send with the uuid `reply_<card_id>`, and returns a session that writes each changed part with `cardkit.v1.cardElement.content` and the card's next sequence, turns streaming on again with `cardkit.v1.card.settings` when Lark refuses an update for it being off, and finishes with streaming off, throwing when the last write did not land. `CARD_GONE_CODES` gains 200740 and 300311. Tested over a fake cardkit client, `tests/helpers/cardkit.ts`, which keeps Lark's rules for a card and refuses with Lark's codes.
- **The timeout** (Task 5): a write past nine minutes since streaming was last turned on turns it on first; a finish whose streaming will not come back replaces its elements with `cardkit.v1.cardElement.update`.
- **The writer** (Tasks 6, 7): after a failure the next pass waits `retryAfterMs ?? backoffMs(attempts)`; a throttle counts against `CARD_FAILURE_LIMIT` only once 30 seconds of waiting on throttles is spent; the fallback finishes the card it gives up on; a write that changes only the tool line waits until two seconds after the last write, unless the turn is finishing.
- **The replay** (Task 8): the card writer, the adapter and the fake cardkit client over one turn of interleaved tool events and answer chunks, a pass a second after every event: every update the answer element is given starts with the one before, and Lark refuses none.

**Tech Stack:** TypeScript (Node 22, ESM/NodeNext, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`), vitest, `@larksuiteoapi/node-sdk` 1.73.0. No new dependency. No migration.

**Spec:** `docs/specs/2026-08-21-lark-channel-design.md` §4.5, "The reply card's parts", as revised after review on 2026-11-19. Below, "§N" is that spec's.

---

## Ground rules

- **Where to work.**
  - Use the worktree beside the main checkout, `/Users/x/Develop/manus/prime-gateway-wt2`, on the branch `card-split`, which holds this plan and the spec section, on top of `62ec9c3`.
  - Never edit the main checkout `/Users/x/Develop/manus/prime-gateway`, nor `/Users/x/Develop/manus/prime-gateway-work`: the live gateway runs from the first.
  - Never start the gateway, never reach the real Lark or the network, and never read or write `~/.manus-team`. Every test here runs over a fake: the fake channel (`tests/helpers/channel.ts`) or the fake cardkit client (`tests/helpers/cardkit.ts`, Task 4).
- **Commits.**
  - Commit named files only; never `git add -A`. `node_modules` is an untracked symlink to the main checkout's; create it with `ln -s /Users/x/Develop/manus/prime-gateway/node_modules node_modules` if it is missing.
  - Write plain-English commit messages: no mention of Claude or AI, no `Co-Authored-By` trailer, no Chinese text.
  - The three-letter string made of `p`, `g` and `w`, in that order, in any case, must not appear in anything you write.
- **Node 22.** Run `export PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH` before every command. The default Node 23 breaks `better-sqlite3`.
- **Baseline.** `npx vitest run --project unit` gives `Tests  2667 passed (2667)`. `npx vitest run --project e2e` gives `Tests  173 passed (173)`. `npm run typecheck` reports no errors. The tests of `tests/update-run.test.ts` and the other `mt update` tests, which time detached children, can fail on a loaded or sleeping machine; run the file again alone before looking for a cause.
- **Finding edits.** Find each edit by its quoted text, not by line number. Every quoted text is whole lines, and appears exactly once in its file at the point the step applies it. Apply a step's edits in the order given. Every step of this plan was applied in that order, from `62ec9c3`, in a throwaway copy, and gave the counts and failures it states; the plan's own text was then applied in a second fresh copy, which reproduced the first copy's tree byte for byte at the end of every task.
- **Words a person sees** (the card, its preview, the log) do not use the long dash.
- **No real agent.** No test runs bytesec or any agent; the turns are events written into a log by the test.

## Decisions

Each has its reason. Where the code and the spec disagree, the code is the fact, and the decision says which reading keeps the spec's intent; those are listed again under "Where the code forced a reading" below.

1. **`CardParts` is `{ tools, answer, status }`** (Task 1), in `src/channel/types.ts`, the port, as `CardSession` takes it; each part already escaped and masked, `''` when it has nothing. `RenderedCard` keeps `text` as `cardText(parts)`: the non-empty parts in reading order, `\n\n` between, cut to `CARD_TEXT_BUDGET`, which is the text `renderCard` gave before for any answer under the budget. The plain-message fallback sends it, and the tests of `tests/render.test.ts`, which read it, pass as they are.
2. **The status is the third element** (Task 1): the error, the approval-wait line, the terminal line, the retry hint, and the placeholder, which shows, as before, only when the turn has no tool line, no answer and no other status. Not "only on finish", which hides the error and the approval line while the turn is open; not the answer, which would shrink when the approval line goes; not the tool line, which would put an error above its answer (§4.5).
3. **The budgets** (Task 1): the answer is cut at `CARD_TEXT_BUDGET`, 20,000, as the whole card was; `TOOLS_BUDGET` and `STATUS_BUDGET` are 2,000 each. The card's elements are at most 24,004 characters together, each under cardkit's 30,000, so the SDK's rollover is not needed; `text` stays within 20,000. Lark's 30 KB card limit (200860) is in bytes, which a CJK answer can pass inside the budget; that is left to the fallback and a follow-up (§4.5).
4. **The port takes parts** (Task 2): `openCard(target, initial: CardParts, uuid)`, `set(parts)`, `finish(parts)`. `FakeCard` keeps `sets`, `finishes` and `droppedSets` as joined text, with `cardText`, so every test that reads a card's text is unchanged, and adds `partSets` and `partFinishes`. `KanbanSink` and `SinkChannel` discard parts as they discarded text.
5. **`replyCard(parts)`** (Task 3): schema 2.0; `update_multi: true`, as every card of ours says; `streaming_mode: true`; the chat-list preview `REPLY_SUMMARY_OPEN`, "Working…"; the SDK's own streaming config, `print_frequency_ms: { default: 70 }`, `print_step: { default: 1 }`, `print_strategy: 'fast'`; three markdown elements, `element_id` `tools`, `answer` and `status` (`REPLY_ELEMENTS`). A part that is `''` is `EMPTY_PART`, a zero-width space, never an empty element, which Lark refuses with 10002.
6. **`replySummary(parts)`** (Task 3): the answer, else the status, else the tool line, whitespace collapsed to one space, cut to 50 code points with `…`, as the SDK cuts its preview at 50.
7. **`openCard`** (Task 4): reads `createdAt` first, makes the card with `rawClient.cardkit.v1.card.create` (`type: 'card_json'`), not retried, a code in the body refused as a `ChannelError`, then sends `{ type: 'card', data: { card_id } }` as `interactive` through `#post` under `#withRetry`, with the uuid `reply_<card_id>`, cut to 50. The SDK's `createCardInstance`, `sendCardByReference`, `updateCardElementContent` and `finishStreamingCard` are methods of `LarkChannel`'s private `sender`; `rawClient` is public, and the calls are the same.
8. **The session** (Task 4) holds `shown`, what each element was last given and Lark took, and `sequence`, one counter for the card. A write sends, in reading order and one at a time, each part whose content differs from `shown`, with the next sequence and the uuid `c_<card_id>_<sequence>`, and sets `shown` only once Lark answered `code` 0. An update refused with 200850 or 300309 (`STREAMING_OFF_CODES`) turns streaming on, `card.settings` with `{ config: { streaming_mode: true, summary: { content: 'Working…' } } }` and the uuid `s_<card_id>_<sequence>`, and is sent once more with a new sequence. Any other failure, or a second refusal, throws: thrown errors through `sendError`, a code in a 2xx body through `toChannelError`.
9. **`finish`** (Task 4): writes what changed first; then, whether or not that landed, `card.settings` with `{ config: { streaming_mode: false, summary: { content: replySummary(parts) } } }`, best effort; then, if the write failed, rethrows its error, so the writer counts it and finishes again or falls back. `finished` is set only once a finish has landed; after that `finish` and `set` do nothing. A finish tried again meets streaming off, and Decision 8 turns it on to write. The writer's other two finishes, leaving a card for a new turn and at `close`, already catch.
10. **`CARD_GONE_CODES` gains 200740 and 300311** (Task 4): cardkit's codes for a card entity Lark does not hold, and one it will no longer update. On either the writer drops the session and opens a new card.
11. **The timeout** (Task 5): `streamingSince` starts at `createdAt` and is reset each time streaming is turned on; a write that has something to send, past `STREAMING_REFRESH_MS` (nine minutes) of it, turns streaming on first. While finishing, a refused turning on (ahead of time or after a refusal) does not throw: the parts still to send go by `cardElement.update`, `{ tag: 'markdown', element_id, content }` with the uuid `u_<card_id>_<sequence>`, and the finish then turns streaming off as usual.
12. **The writer's wait** (Task 6): after a failure, `#notBefore = now + (retryAfterMs ?? backoffMs(attempts))`, where `attempts` counts consecutive failed writes of every kind and is reset by a write that lands; `#schedule` waits for the later of the coalescing window and `#notBefore`. A throttle, `ChannelError` code 99991400 or 429 (an HTTP 429 without a body code), adds its wait to `#throttledMs` and is noted as `throttled, waiting Ns` instead of counting, until `#throttledMs` reaches `CARD_THROTTLE_BUDGET_MS`, 30,000; then it counts. A write that lands resets it. `backoffMs` comes from `./lark/errors.js`, as the adapter's does.
13. **The fallback finishes the card it gives up on** (Task 6), with the render it sent as text, after sending it, best effort, its failure noted.
14. **A tool-line-only write waits** (Task 7): the writer keeps `#shownParts`, the parts the open card last took; a render that is not finished and differs from them in the tool line alone, less than `TOOL_LINE_DELAY_MS` (2,000) after the last write, is held, `#notBefore` set to two seconds after the last write, with no failure counted; the next pass renders the newest state.
15. **The SDK's streaming card is no longer used**: `MarkdownStreamController` is not imported, and nothing calls `stream()`. The fake cardkit client has no `stream`, so an adapter that still went through it fails Task 4's tests.

## Known limitations

From §4.5, kept as it says: the tool line is still typed again on each tool event; the answer is typed again once when a held secret fragment starts being held at its fourth character, when a secret learnt during the turn masks text already shown, and when the answer crosses the budget; nothing bounds the app's cardkit calls across cards (an app-wide token bucket is a follow-up); a CJK answer can pass Lark's 30 KB inside the budget (a budget in bytes is a follow-up); a fallback in the middle of a turn shows the answer's start twice. Besides:

- **Lark's client behaviour is not tested here.** The fake cardkit client keeps Lark's rules as documented and observed; whether Lark types only the tail of each element, whether a zero-width space leaves no gap, whether one sequence across elements is taken, and whether turning streaming on again keeps a long card moving, are smoke items 1 to 5.
- **The replace of Task 5 is not reachable by a smoke test**: no smoke test can make Lark refuse to turn streaming on (§4.5 point 7).
- **The card's send by reference is retried, its making is not** (Decision 7): a throttle on `card.create` fails the open, and the writer's next pass, after its wait, opens it again.
- **The writer's waits run on real timers.** Its tests that need them use vitest's fake timers for `setTimeout` alone; the others drive passes with `flushNow`, which does not wait.

## Where the code forced a reading

- **"Each element's content with its own sequence" is one counter a card** (Decision 8): Lark's sequence orders a card's updates, the SDK's own streaming card draws its updates and its finish from one counter a card ("monotonically increasing per card", on `updateCardElementContent`), and counters an element would give two updates of one card the same number. Each update has its own number, from the card's counter.
- **A finish tried again needs streaming turned on again**, because the failed finish turned it off; so the refusal handling of the timeout (Decision 8) is in Task 4, with the finish that needs it, and Task 5 adds the step ahead of time and the replace.
- **`forMarkdown`'s escaping does not rewrite earlier text**: it doubles the backslashes in front of a `<` or `>`, so text that ended in backslashes still starts the escaped text. Task 1's test holds it.
- **Releasing a held tail does not rewrite earlier text, but starting to hold one does**: `withholdSecretPrefix` holds a fragment only from its fourth character (`MIN_PREFIX_LENGTH`, 4, in `src/secrets.ts`), so a render ending in one to three of a secret's first characters shows them and the next render holds them. Task 1's test holds both.
- **The send's uuid is the card's, not the writer's** (Decision 7): `sendUuid(seq)` is also the fallback's uuid at that seq, and a reopened card's, and Lark answers a repeated uuid with the first message (§4.2).
- **The SDK's `createCardInstance` does not read the code in the body**, only the card id; `openCard` refuses a non-zero code first, so a refusal is reported with Lark's code rather than as a missing card id.
- **A bare HTTP 429 is code 429** to the writer: `toChannelError` takes the status as the code when the body has none, so the throttle set is `{ 99991400, 429 }`.
- **The placeholder keeps today's rule**: it shows only when there is nothing else, which `parts.length === 0` said before.
- **The replay advances the writer's clock a second an event** (Task 8): with the clock still, Task 7 would hold every tool-line-only write for good, as no time would pass.

## File map

| File | Responsibility |
|---|---|
| `src/channel/types.ts` (modify) | `CardParts`; `CardSession.set` and `.finish`, `Channel.openCard` take parts; `CardSession`'s note; `CARD_GONE_CODES` (Tasks 1, 2, 4) |
| `src/channel/render.ts` (modify) | `RenderedCard.parts`, `cardText`, `TOOLS_BUDGET`, `STATUS_BUDGET` (Task 1) |
| `src/channel/card-writer.ts` (modify) | passes the render's parts (Task 2); the wait after a failure, `CARD_THROTTLE_BUDGET_MS`, the fallback's finish (Task 6); `TOOL_LINE_DELAY_MS` (Task 7) |
| `src/kanban/sink.ts` (modify) | discards parts (Task 2) |
| `src/channel/lark/adapter.ts` (modify) | joins parts for the SDK's card (Task 2); `replyCard`, `replySummary`, `REPLY_ELEMENTS`, `EMPTY_PART`, `REPLY_SUMMARY_OPEN`, `partContent` (Task 3); `openCard` over the card API, `STREAMING_OFF_CODES`, `cardkitCall`, the class note (Task 4); `STREAMING_REFRESH_MS`, the replace (Task 5) |
| `tests/helpers/channel.ts` (modify) | `FakeCard.partSets`, `.partFinishes` (Task 2) |
| `tests/helpers/cardkit.ts` (create) | `FakeCardkit`, `refused`, `STREAMING_WINDOW_MS` (Task 4) |
| `tests/render-parts.test.ts`, `tests/lark-reply-card.test.ts`, `tests/lark-reply-session.test.ts`, `tests/lark-reply-timeout.test.ts`, `tests/card-parts-replay.test.ts` (create) | Tasks 1, 3, 4, 5, 8 |
| `tests/card-writer.test.ts` (modify) | the parts handed over (Task 2); the wait, the throttle budget, the fallback's finish (Task 6); the tool-line hold (Task 7) |
| `tests/kanban-sink.test.ts` (modify) | the sinks' new argument (Task 2) |

Running counts, unit then end to end: Task 1 2676 / 173, Task 2 2677 / 173, Task 3 2682 / 173, Task 4 2695 / 173, Task 5 2699 / 173, Task 6 2702 / 173, Task 7 2703 / 173, Task 8 2705 / 173.

How §4.5's tests map to the tasks: the parts, their budgets, the answer growing over a turn and each case that does or does not re-type (Task 1); the card JSON and its preview (Task 3); the adapter over the fake cardkit client, its rules, the finish that fails (Task 4); the timeout (Task 5); the writer's wait, throttle budget and fallback finish (Task 6) and its tool-line hold (Task 7); the bug replayed end to end (Task 8).

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

Decisions 7 to 10 and 15. `openCard` makes the card, sends it by reference, and returns a session that writes each changed part to its own element, turns streaming on again when Lark refuses an update for it being off, and fails a finish whose last write did not land. The fake cardkit client stands in for the SDK's client: it records every call in order, keeps Lark's rules for a card, refusing with Lark's codes and marking the call `refused`, and fails a call on request, thrown or in the body.

- [ ] **Step 4.1: Write the fake and the tests.**

Create `tests/helpers/cardkit.ts`:

```ts
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { Clock } from '../../src/time.js';
import { systemClock } from '../../src/time.js';

/**
 * A stand-in for the part of the Lark SDK the reply card uses (channel spec
 * §4.5): cardkit's card create, element content, element update and card
 * settings, and the message send that carries the card by reference. Every call
 * is recorded in order and answered as Lark answers: a card id, a message id,
 * `code: 0`, or a refusal, thrown as axios throws an HTTP error or returned in a
 * 2xx body. It has no `stream`, so an adapter that still went through the SDK's
 * streaming card fails here. Nothing here reaches Lark.
 *
 * It keeps Lark's rules for a card, so an adapter that breaks one is refused as
 * Lark would refuse it, with Lark's code:
 *
 * - a sequence not above the card's last one taken: 300317;
 * - a card it does not hold: 200740; an element the card has not got: 300313;
 * - empty content: 10002;
 * - content once streaming is off: 300309;
 * - content more than ten minutes after streaming was last turned on, by its own
 *   clock: 200850, and streaming is then off. Settings turning it on again start
 *   the ten minutes over.
 *
 * A refused call is recorded with `refused: true`.
 */

export type CardkitApi = 'create' | 'content' | 'update' | 'settings' | 'send';

export interface CardkitCall {
  api: CardkitApi;
  cardId?: string;
  elementId?: string;
  /** content: the text; update: the element's content. */
  content?: string;
  sequence?: number;
  uuid?: string;
  /** create: the card, parsed. update: the element, parsed. settings: the settings, parsed. send: the message's content, parsed. */
  body?: unknown;
  /** send: a new message or a reply. */
  kind?: 'create' | 'reply';
  /** send: the chat, or the message replied to. */
  to?: string;
  msgType?: string;
  replyInThread?: boolean;
  /** Set when Lark refused the call. */
  refused?: true;
}

/** A failure as Lark gives one: an Error is thrown, a code is answered in the body. */
export type CardkitFailure = Error | { code: number; msg: string };

/** How long Lark keeps a card streaming after it was last turned on. */
export const STREAMING_WINDOW_MS = 10 * 60 * 1000;

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

interface Card {
  elements: Map<string, string>;
  last: number;
  streaming: boolean;
  streamingSince: number;
}

/** An HTTP error as axios throws one: Lark's code in the response body. */
export function refused(code: number, status = 400): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { code, msg: `refused ${code}` }, headers: {} },
  });
}

function refusal(code: number): Answer {
  return { code, msg: `refused ${code}` };
}

const OK: Answer = { code: 0, msg: 'ok', data: {} };

export class FakeCardkit {
  readonly calls: CardkitCall[] = [];
  readonly #failures = new Map<CardkitApi, CardkitFailure[]>();
  readonly #cards = new Map<string, Card>();
  readonly #clock: Clock;
  #made = 0;
  #messages = 0;

  /** `clock` is Lark's: the ten minutes of streaming run on it. */
  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  /** Make the next call to `api` fail with `failure`, whatever the rules say. Queued, so N in a row work. */
  failNext(api: CardkitApi, failure: CardkitFailure): void {
    const queue = this.#failures.get(api) ?? [];
    queue.push(failure);
    this.#failures.set(api, queue);
  }

  /** Lose a card, as Lark loses one that has expired or been withdrawn. */
  forget(cardId: string): void {
    this.#cards.delete(cardId);
  }

  /** The content each update sent `elementId`, in order, those Lark refused among them. */
  contents(elementId: string): string[] {
    return this.calls.filter((c) => c.api === 'content' && c.elementId === elementId).map((c) => c.content ?? '');
  }

  /**
   * What `elementId` of `cardId` was given, in order, as Lark's client would
   * receive it: its content in the card as created, then each update Lark took.
   */
  shown(cardId: string, elementId: string): string[] {
    const created = this.calls.find((c) => c.api === 'create' && c.cardId === cardId && c.refused !== true);
    const card = created?.body as { body: { elements: Array<{ element_id: string; content: string }> } } | undefined;
    const initial = card?.body.elements.find((e) => e.element_id === elementId)?.content;
    const updates = this.calls
      .filter((c) => (c.api === 'content' || c.api === 'update') && c.cardId === cardId && c.elementId === elementId && c.refused !== true)
      .map((c) => c.content ?? '');
    return initial === undefined ? updates : [initial, ...updates];
  }

  /** Every sequence `cardId` was given, updates and settings alike, refused or not, in order. */
  sequences(cardId: string): number[] {
    return this.calls.filter((c) => c.cardId === cardId && c.sequence !== undefined).map((c) => c.sequence ?? 0);
  }

  /** Whether `cardId` is streaming, as Lark holds it now. */
  streaming(cardId: string): boolean {
    const card = this.#cards.get(cardId);
    return card !== undefined && card.streaming && this.#clock.now() - card.streamingSince <= STREAMING_WINDOW_MS;
  }

  /** Record `call`, then answer it: a queued failure, else `rule`'s refusal, else `success`. */
  #answer(call: CardkitCall, rule: () => Answer | undefined, success: Answer): Answer {
    this.calls.push(call);
    const failure = this.#failures.get(call.api)?.shift();
    if (failure !== undefined) {
      call.refused = true;
      if (failure instanceof Error) throw failure;
      return failure;
    }
    const broken = rule();
    if (broken !== undefined) {
      call.refused = true;
      return broken;
    }
    return success;
  }

  /** The rules every update of a card keeps, before its own. */
  #sequenced(cardId: string, sequence: number, elementId?: string): Card | Answer {
    const card = this.#cards.get(cardId);
    if (card === undefined) return refusal(200740);
    if (elementId !== undefined && !card.elements.has(elementId)) return refusal(300313);
    if (sequence <= card.last) return refusal(300317);
    return card;
  }

  readonly lark: LarkChannel = {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: async (p: { data: { type: string; data: string } }) => {
              const cardId = `card_${this.#made + 1}`;
              const body = JSON.parse(p.data.data) as { config?: { streaming_mode?: boolean }; body: { elements: Array<{ element_id: string; content: string }> } };
              const answer = this.#answer({ api: 'create', cardId, body }, () => undefined, { code: 0, msg: 'ok', data: { card_id: cardId } });
              if (answer.code === 0) {
                this.#made += 1;
                this.#cards.set(cardId, {
                  elements: new Map(body.body.elements.map((e) => [e.element_id, e.content])),
                  last: 0,
                  streaming: body.config?.streaming_mode === true,
                  streamingSince: this.#clock.now(),
                });
              }
              return answer;
            },
            settings: async (p: { path: { card_id: string }; data: { settings: string; sequence: number; uuid?: string } }) => {
              const body = JSON.parse(p.data.settings) as { config?: { streaming_mode?: boolean } };
              const call: CardkitCall = {
                api: 'settings',
                cardId: p.path.card_id,
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
                body,
              };
              let card = undefined as Card | undefined;
              const answer = this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence);
                  if (!('elements' in found)) return found;
                  card = found;
                  return undefined;
                },
                OK,
              );
              if (card !== undefined && answer.code === 0) {
                card.last = p.data.sequence;
                const mode = body.config?.streaming_mode;
                if (mode === true) {
                  card.streaming = true;
                  card.streamingSince = this.#clock.now();
                } else if (mode === false) {
                  card.streaming = false;
                }
              }
              return answer;
            },
          },
          cardElement: {
            content: async (p: { path: { card_id: string; element_id: string }; data: { content: string; sequence: number; uuid?: string } }) => {
              const call: CardkitCall = {
                api: 'content',
                cardId: p.path.card_id,
                elementId: p.path.element_id,
                content: p.data.content,
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
              };
              let card = undefined as Card | undefined;
              const answer = this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence, p.path.element_id);
                  if (!('elements' in found)) return found;
                  if (p.data.content === '') return refusal(10002);
                  if (!found.streaming) return refusal(300309);
                  if (this.#clock.now() - found.streamingSince > STREAMING_WINDOW_MS) {
                    found.streaming = false;
                    return refusal(200850);
                  }
                  card = found;
                  return undefined;
                },
                OK,
              );
              if (card !== undefined && answer.code === 0) {
                card.last = p.data.sequence;
                card.elements.set(p.path.element_id, p.data.content);
              }
              return answer;
            },
            update: async (p: { path: { card_id: string; element_id: string }; data: { element: string; sequence: number; uuid?: string } }) => {
              const element = JSON.parse(p.data.element) as { content?: string };
              const call: CardkitCall = {
                api: 'update',
                cardId: p.path.card_id,
                elementId: p.path.element_id,
                content: element.content ?? '',
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
                body: element,
              };
              let card = undefined as Card | undefined;
              const answer = this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence, p.path.element_id);
                  if (!('elements' in found)) return found;
                  if ((element.content ?? '') === '') return refusal(10002);
                  card = found;
                  return undefined;
                },
                OK,
              );
              if (card !== undefined && answer.code === 0) {
                card.last = p.data.sequence;
                card.elements.set(p.path.element_id, element.content ?? '');
              }
              return answer;
            },
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
      () => undefined,
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

/**
 * The adapter over a fake cardkit client. Lark's clock is the adapter's unless
 * `larkClock` is given, so a test can let Lark's ten minutes pass unseen.
 */
function adapter(larkClock?: ManualClock): { a: LarkAdapter; kit: FakeCardkit; waits: number[]; clock: ManualClock } {
  const waits: number[] = [];
  const clock = new ManualClock(NOW);
  const kit = new FakeCardkit(larkClock ?? clock);
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
    expect(kit.shown('card_1', 'answer')).toEqual(['a', 'ab']);
  });

  it('reports a card Lark no longer holds as gone, so the writer opens a new one', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    kit.forget('card_1');
    await expect(card.set(parts('ab'))).rejects.toMatchObject({ code: 200740 });
    expect(CARD_GONE_CODES.has(200740)).toBe(true);
    expect(CARD_GONE_CODES.has(300311)).toBe(true);
  });

  it('turns streaming on again when Lark refuses an update for streaming being off, and writes it once more', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    kit.failNext('content', { code: 300309, msg: 'streaming is closed' });
    await card.set(parts('ab'));
    expect(kit.calls.slice(2).map((c) => [c.api, c.sequence, c.refused === true])).toEqual([
      ['content', 1, true],
      ['settings', 2, false],
      ['content', 3, false],
    ]);
    expect(kit.calls[3]?.body).toEqual({ config: { streaming_mode: true, summary: { content: 'Working…' } } });
    // Refused again after that: thrown with Lark's code.
    kit.failNext('content', { code: 300309, msg: 'streaming is closed' });
    kit.failNext('content', { code: 300309, msg: 'streaming is closed' });
    await expect(card.set(parts('abc'))).rejects.toMatchObject({ code: 300309 });
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

  it("fails a finish whose last write did not land, with Lark's code, turning streaming off all the same", async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    kit.failNext('content', refused(230020));
    await expect(card.finish(parts('ab'))).rejects.toMatchObject({ code: 230020 });
    expect(kit.calls.slice(2).map((c) => [c.api, c.refused === true])).toEqual([
      ['content', true],
      ['settings', false],
    ]);
    expect(kit.streaming('card_1')).toBe(false);

    // The writer finishes again: streaming goes back on for the write, and off once it lands.
    await card.finish(parts('ab'));
    expect(kit.calls.slice(4).map((c) => [c.api, c.refused === true])).toEqual([
      ['content', true],
      ['settings', false],
      ['content', false],
      ['settings', false],
    ]);
    expect(kit.shown('card_1', 'answer')).toEqual(['a', 'ab']);
    expect(kit.streaming('card_1')).toBe(false);
    // Inert once it has landed.
    await card.finish(parts('abc'));
    await card.set(parts('abc'));
    expect(kit.calls).toHaveLength(8);
  });

  it('fails a finish when even streaming off is refused, and a later set writes the content', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    kit.failNext('content', new Error('socket hang up'));
    kit.failNext('settings', new Error('socket hang up'));
    await expect(card.finish(parts('ab'))).rejects.toBeInstanceOf(ChannelError);
    await card.set(parts('ab'));
    expect(kit.shown('card_1', 'answer')).toEqual(['a', 'ab']);
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

- [ ] **Step 4.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/lark-reply-session.test.ts`. Expected: `Tests  13 failed (13)`, each as `TypeError: this[#lark].stream is not a function`, the fourth as the error its `rejects` matched against `{ code: 200621, retryable: false }`: the adapter still opens the SDK's streaming card, which the fake has not got.

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

    const settings = async (config: object): Promise<void> => {
      sequence += 1;
      const at = sequence;
      await cardkitCall(() =>
        cardkit.card.settings({
          path: { card_id: cardId },
          data: { settings: JSON.stringify({ config }), sequence: at, uuid: `s_${cardId}_${at}` },
        }),
      );
    };
    const content = async (part: keyof CardParts, text: string): Promise<void> => {
      sequence += 1;
      const at = sequence;
      await cardkitCall(() =>
        cardkit.cardElement.content({
          path: { card_id: cardId, element_id: REPLY_ELEMENTS[part] },
          data: { content: text, sequence: at, uuid: `c_${cardId}_${at}` },
        }),
      );
    };
    // Lark stops streaming a card by itself, and a finish that failed has
    // stopped it too; an update is then refused, and streaming is turned on again.
    const streamOn = (): Promise<void> => settings({ streaming_mode: true, summary: { content: REPLY_SUMMARY_OPEN } });

    const write = async (parts: CardParts): Promise<void> => {
      for (const part of REPLY_ORDER) {
        const text = partContent(parts[part]);
        if (text === shown[part]) continue;
        try {
          await content(part, text);
        } catch (err) {
          if (!(err instanceof ChannelError) || !STREAMING_OFF_CODES.has(err.code)) throw err;
          // Once, with a new sequence; a second refusal is thrown with Lark's code.
          await streamOn();
          await content(part, text);
        }
        shown[part] = text;
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
        // Idempotent once it has landed: teardown reaches this from the writer's
        // normal terminal path and again from its shutdown path, and a second
        // call must be inert rather than an error.
        if (finished) return;
        let failed: unknown;
        try {
          await write(parts);
        } catch (err) {
          failed = err;
        }
        // Whether or not the write landed: a card left streaming shows its
        // typing cursor until Lark gives up on it.
        try {
          await settings({ streaming_mode: false, summary: { content: replySummary(parts) } });
        } catch {
          // Best effort. The card keeps what it shows.
        }
        // Thrown, so the writer counts it, and finishes again or falls back: the
        // last content is the answer's end, and it must not be lost in silence.
        if (failed !== undefined) throw failed;
        finished = true;
```

In `src/channel/lark/adapter.ts`, replace:

```ts
/**
 * The reply card's element ids (channel spec §4.5): one markdown element a part,
```

with:

```ts
/**
 * Lark's codes for an update refused because the card is not streaming: 200850,
 * streaming timed out, ten minutes after it was last turned on; 300309,
 * streaming is off. The session turns streaming on again and writes once more.
 */
const STREAMING_OFF_CODES: ReadonlySet<number> = new Set([200850, 300309]);

/**
 * The reply card's element ids (channel spec §4.5): one markdown element a part,
```

In `src/channel/lark/adapter.ts`, replace:

```ts
  return chars.length <= SUMMARY_MAX ? chars.join('') : `${chars.slice(0, SUMMARY_MAX - 1).join('')}…`;
```

with:

```ts
  return chars.length <= SUMMARY_MAX ? chars.join('') : `${chars.slice(0, SUMMARY_MAX - 1).join('')}…`;
}

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

In `src/channel/types.ts`, replace:

```ts
  200750, // card entity expired or not found
```

with:

```ts
  200750, // card entity expired or not found
  200740, // card entity not found
  300311, // card entity no longer updatable
```

- [ ] **Step 4.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2695 passed (2695)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors. `grep -rn "\.stream(\|MarkdownStreamController" src` prints nothing.

- [ ] **Step 4.5: Commit.**

```bash
git add src/channel/lark/adapter.ts src/channel/types.ts tests/helpers/cardkit.ts tests/lark-reply-session.test.ts
git commit -m "Drive the reply card through Lark's card API: make it, send it by reference with its own uuid, write each changed part to its own element with the card's next sequence, turn streaming on again when Lark refuses an update for it being off, and fail a finish whose last write did not land; count cardkit's lost-card codes as gone; test it over a fake cardkit client that keeps Lark's rules"
```

---

### Task 5: Lark's streaming timeout

**Files:**

- Create: `tests/lark-reply-timeout.test.ts`
- Modify: `src/channel/lark/adapter.ts`

Decision 11. Lark turns streaming off ten minutes after it was last turned on. A write past nine minutes turns it on first, so the writer never meets the refusal; a finish whose streaming will not come back replaces its elements, so the answer's end lands. The fake keeps Lark's ten minutes on its own clock, which a test can let run ahead of the adapter's.

- [ ] **Step 5.1: Write the tests.**

Create `tests/lark-reply-timeout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LarkAdapter, STREAMING_REFRESH_MS } from '../src/channel/lark/adapter.js';
import type { CardParts } from '../src/channel/types.js';
import { FakeCardkit, refused } from './helpers/cardkit.js';
import { ManualClock } from './helpers/db.js';

/**
 * Lark's streaming timeout (channel spec §4.5): Lark turns a card's streaming off
 * ten minutes after it was last turned on, and refuses its updates after that
 * with 200850, or 300309 once it is off. The session turns streaming on again
 * ahead of time, past nine minutes, and on such a refusal; the writer never sees
 * one. Over the fake cardkit client, which keeps Lark's ten minutes on its own
 * clock.
 */

const NOW = 1_760_000_000_000;
const MINUTE = 60 * 1000;
const CHAT = { chatId: 'oc_team', threadId: '' };

function parts(answer: string): CardParts {
  return { tools: '', answer, status: '' };
}

/** `ours` is the adapter's clock, `lark` the fake's; the same one unless a test parts them. */
function adapter(shared = true): { a: LarkAdapter; kit: FakeCardkit; ours: ManualClock; lark: ManualClock } {
  const ours = new ManualClock(NOW);
  const lark = shared ? ours : new ManualClock(NOW);
  const kit = new FakeCardkit(lark);
  const a = new LarkAdapter({ appId: 'cli_app', appSecret: 'not-a-secret' }, ours, { lark: kit.lark, sleep: async () => undefined });
  return { a, kit, ours, lark };
}

/** The calls after the card's making and sending, as [api, refused, streaming_mode when set]. */
function after(kit: FakeCardkit): Array<[string, boolean, boolean | undefined]> {
  return kit.calls
    .slice(2)
    .map((c) => [c.api, c.refused === true, (c.body as { config?: { streaming_mode?: boolean } } | undefined)?.config?.streaming_mode]);
}

describe('the reply card past Lark streaming timeout', () => {
  it('turns streaming on again before a write past nine minutes, so nothing is refused', async () => {
    expect(STREAMING_REFRESH_MS).toBe(9 * MINUTE);
    const { a, kit, ours } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    ours.advance(9.5 * MINUTE);
    await card.set(parts('ab'));
    // And again past nineteen, counted from the last turn on, not the making.
    ours.advance(5 * MINUTE);
    await card.set(parts('abc'));
    ours.advance(5 * MINUTE);
    await card.set(parts('abcd'));
    expect(after(kit)).toEqual([
      ['settings', false, true],
      ['content', false, undefined],
      ['content', false, undefined],
      ['settings', false, true],
      ['content', false, undefined],
    ]);
    expect(kit.calls[2]?.body).toEqual({ config: { streaming_mode: true, summary: { content: 'Working…' } } });
    expect(kit.streaming('card_1')).toBe(true);
  });

  it('turns streaming on again when Lark has timed it out unseen, and the write lands', async () => {
    const { a, kit, lark } = adapter(false);
    const card = await a.openCard(CHAT, parts('a'), 'u');
    lark.advance(11 * MINUTE);
    await expect(card.set(parts('ab'))).resolves.toBeUndefined();
    expect(after(kit)).toEqual([
      ['content', true, undefined],
      ['settings', false, true],
      ['content', false, undefined],
    ]);
    expect(kit.shown('card_1', 'answer')).toEqual(['a', 'ab']);
  });

  it("fails the write with Lark's code when turning streaming on is refused", async () => {
    const { a, kit, lark } = adapter(false);
    const card = await a.openCard(CHAT, parts('a'), 'u');
    lark.advance(11 * MINUTE);
    kit.failNext('settings', refused(99991400, 429));
    await expect(card.set(parts('ab'))).rejects.toMatchObject({ code: 99991400 });
  });

  it('still finishes with streaming off past the timeout, and replaces the answer when streaming will not come back', async () => {
    const back = adapter(false);
    const card = await back.a.openCard(CHAT, parts('a'), 'u');
    back.lark.advance(11 * MINUTE);
    await card.finish(parts('ab'));
    expect(after(back.kit)).toEqual([
      ['content', true, undefined],
      ['settings', false, true],
      ['content', false, undefined],
      ['settings', false, false],
    ]);

    const refusing = adapter(false);
    const other = await refusing.a.openCard(CHAT, parts('a'), 'u');
    refusing.lark.advance(11 * MINUTE);
    refusing.kit.failNext('settings', refused(99991400, 429));
    await expect(other.finish(parts('ab'))).resolves.toBeUndefined();
    expect(after(refusing.kit)).toEqual([
      ['content', true, undefined],
      ['settings', true, true],
      ['update', false, undefined],
      ['settings', false, false],
    ]);
    expect(refusing.kit.shown('card_1', 'answer')).toEqual(['a', 'ab']);
    expect(refusing.kit.calls.at(-1)?.body).toEqual({ config: { streaming_mode: false, summary: { content: 'ab' } } });
  });
});
```

- [ ] **Step 5.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/lark-reply-timeout.test.ts`. Expected: `Tests  2 failed | 2 passed (4)`: the first as `AssertionError: expected undefined to be 540000`, and the last as `AssertionError: promise rejected "ChannelError: refused 99991400 (code 9999… { …(3) }" instead of resolving`. The two that pass are Task 4's turning on after a refusal.

- [ ] **Step 5.3: Implement.**

In `src/channel/lark/adapter.ts`, replace:

```ts
    const createdAt = this.#clock.now();
```

with:

```ts
    const clock = this.#clock;
    const createdAt = clock.now();
```

In `src/channel/lark/adapter.ts`, replace:

```ts
    let finished = false;
```

with:

```ts
    let finished = false;
    // When streaming was last turned on, by our clock: at the card's making,
    // and at each `streamOn`. Read before the card was made, so never late.
    let streamingSince = createdAt;
```

In `src/channel/lark/adapter.ts`, replace:

```ts
    const streamOn = (): Promise<void> => settings({ streaming_mode: true, summary: { content: REPLY_SUMMARY_OPEN } });

    const write = async (parts: CardParts): Promise<void> => {
      for (const part of REPLY_ORDER) {
        const text = partContent(parts[part]);
        if (text === shown[part]) continue;
        try {
          await content(part, text);
        } catch (err) {
          if (!(err instanceof ChannelError) || !STREAMING_OFF_CODES.has(err.code)) throw err;
          // Once, with a new sequence; a second refusal is thrown with Lark's code.
          await streamOn();
          await content(part, text);
```

with:

```ts
    const streamOn = async (): Promise<void> => {
      await settings({ streaming_mode: true, summary: { content: REPLY_SUMMARY_OPEN } });
      streamingSince = clock.now();
    };
    // Streaming turned on again: true once it is. While finishing, a refusal is
    // false, and the parts are written without streaming instead (`replace`);
    // otherwise it is thrown with Lark's code.
    const turnOn = async (finishing: boolean): Promise<boolean> => {
      try {
        await streamOn();
        return true;
      } catch (err) {
        if (finishing) return false;
        throw err;
      }
    };
    // A plain replace of the element, which needs no streaming: the last resort
    // of a finish, so the answer's end still lands.
    const replace = async (part: keyof CardParts, text: string): Promise<void> => {
      sequence += 1;
      const at = sequence;
      await cardkitCall(() =>
        cardkit.cardElement.update({
          path: { card_id: cardId, element_id: REPLY_ELEMENTS[part] },
          data: {
            element: JSON.stringify({ tag: 'markdown', element_id: REPLY_ELEMENTS[part], content: text }),
            sequence: at,
            uuid: `u_${cardId}_${at}`,
          },
        }),
      );
    };

    const write = async (parts: CardParts, finishing = false): Promise<void> => {
      const changed = REPLY_ORDER.filter((part) => partContent(parts[part]) !== shown[part]);
      if (changed.length === 0) return;
      // Ahead of Lark's ten minutes, so the writer never meets them.
      let replacing = false;
      if (clock.now() - streamingSince >= STREAMING_REFRESH_MS) replacing = !(await turnOn(finishing));
      for (const part of changed) {
        const text = partContent(parts[part]);
        if (replacing) {
          await replace(part, text);
        } else {
          try {
            await content(part, text);
          } catch (err) {
            if (!(err instanceof ChannelError) || !STREAMING_OFF_CODES.has(err.code)) throw err;
            // Once, with a new sequence; a second refusal is thrown with Lark's code.
            if (await turnOn(finishing)) {
              await content(part, text);
            } else {
              replacing = true;
              await replace(part, text);
            }
          }
```

In `src/channel/lark/adapter.ts`, replace:

```ts
          await write(parts);
```

with:

```ts
          await write(parts, true);
```

In `src/channel/lark/adapter.ts`, replace:

```ts
/**
 * The reply card's element ids (channel spec §4.5): one markdown element a part,
```

with:

```ts
/**
 * How long after streaming was last turned on a write turns it on again first:
 * nine minutes, a minute inside Lark's ten, so a long turn's card keeps
 * streaming and its writes are not refused.
 */
export const STREAMING_REFRESH_MS = 9 * 60 * 1000;

/**
 * The reply card's element ids (channel spec §4.5): one markdown element a part,
```

- [ ] **Step 5.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2699 passed (2699)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 5.5: Commit.**

```bash
git add src/channel/lark/adapter.ts tests/lark-reply-timeout.test.ts
git commit -m "Turn the reply card's streaming on again before Lark's ten minutes run out, and when finishing a card whose streaming will not come back, replace its elements so the answer's end still lands"
```

---

### Task 6: The writer waits after a failure

**Files:**

- Modify: `src/channel/card-writer.ts`, `tests/card-writer.test.ts`

Decisions 12 and 13. The next pass after a failure waits what Lark said, else a backoff; a throttle counts against the limit only once 30 seconds of waiting on throttles is spent; the fallback finishes the card it gives up on.

- [ ] **Step 6.1: Write the tests.**

In `tests/card-writer.test.ts`, replace:

```ts
import { describe, expect, it } from 'vitest';
import { CARD_FAILURE_LIMIT, CARD_MAX_AGE_MS, CardWriter } from '../src/channel/card-writer.js';
```

with:

```ts
import { describe, expect, it, vi } from 'vitest';
import { CARD_FAILURE_LIMIT, CARD_MAX_AGE_MS, CARD_THROTTLE_BUDGET_MS, CardWriter } from '../src/channel/card-writer.js';
```

In `tests/card-writer.test.ts`, replace:

```ts

  it('gives up rather than loop when the plain path fails too', async () => {
```

with:

```ts

  it('waits before it writes again after a failure: the wait Lark gave, else a backoff', async () => {
    // Retried at once, a throttle is only met again, and five failures spend
    // the limit inside five seconds.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = harness();
      h.writer.want(h.chunk('a'));
      await h.writer.flushNow();
      h.channel.failNext('set', new ChannelError(230020, 'chat rate limit', true, 5_000));
      h.writer.want(h.chunk('b'));
      await h.writer.flushNow();
      expect(h.channel.calls).toEqual(['openCard', 'set']);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(h.channel.calls).toEqual(['openCard', 'set']);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.channel.calls).toEqual(['openCard', 'set', 'set']);

      // No wait given: a backoff, 250 to 500 ms after a first failure, here
      // where the coalescing window is long past.
      h.clock.advance(10_000);
      h.channel.failNext('set', new ChannelError(230020, 'chat rate limit', true));
      h.writer.want(h.chunk('c'));
      await h.writer.flushNow();
      await vi.advanceTimersByTimeAsync(240);
      expect(h.channel.calls).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(270);
      expect(h.channel.calls).toHaveLength(5);
      expect(h.channel.lastCard?.text).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count a throttle against the limit until 30 s of waiting on throttles is spent', async () => {
    const h = harness();
    h.writer.want(h.chunk('the answer'));
    expect(CARD_THROTTLE_BUDGET_MS).toBe(30_000);
    // Three of 10 s spend the budget; Lark's code or a bare HTTP 429, alike.
    const throttles = [429, 99991400, 99991400].map((code) => new ChannelError(code, 'throttled', true, 10_000));
    for (const err of throttles) {
      h.channel.failNext('openCard', err);
      await h.writer.flushNow();
    }
    // Then they count, as any failure does.
    for (let i = 0; i < CARD_FAILURE_LIMIT - 1; i += 1) {
      h.channel.failNext('openCard', new ChannelError(99991400, 'throttled', true, 10_000));
      await h.writer.flushNow();
    }
    expect(h.channel.texts).toEqual([]);
    expect(h.notes.filter((n) => n.includes('throttled, waiting 10s'))).toHaveLength(3);
    h.channel.failNext('openCard', new ChannelError(99991400, 'throttled', true, 10_000));
    await h.writer.flushNow();
    expect(h.channel.texts).toHaveLength(1);
  });

  it('finishes the card it gives up on, so it does not stream on', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    const card = h.channel.lastCard;
    h.writer.want(h.chunk('b'));
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) {
      h.channel.failNext('set', new ChannelError(230099, 'refused', false));
      await h.writer.flushNow();
    }
    expect(h.channel.texts).toHaveLength(1);
    expect(h.channel.calls.slice(-2)).toEqual(['sendText', 'finish']);
    expect(card?.partFinishes).toEqual([{ tools: '', answer: 'ab', status: '' }]);
  });

  it('gives up rather than loop when the plain path fails too', async () => {
```

- [ ] **Step 6.2: Run them to verify they fail.** Run `npx vitest run --project unit tests/card-writer.test.ts`. Expected: `Tests  3 failed | 32 passed (35)`: the wait as `AssertionError: expected [ 'openCard', 'set', 'set' ] to deeply equal [ 'openCard', 'set' ]`, the budget as `AssertionError: expected undefined to be 30000`, and the fallback's finish as `AssertionError: expected [ 'set', 'sendText' ] to deeply equal [ 'sendText', 'finish' ]`.

- [ ] **Step 6.3: Implement.**

In `src/channel/card-writer.ts`, replace:

```ts
import { renderCard } from './render.js';
```

with:

```ts
import { renderCard, type RenderedCard } from './render.js';
import { backoffMs } from './lark/errors.js';
```

In `src/channel/card-writer.ts`, replace:

```ts
/**
 * Card entities expire after 14 days. We rotate before the edge rather than at
```

with:

```ts
/**
 * How long throttles may hold the card back before they count against
 * `CARD_FAILURE_LIMIT`: 30 seconds of waiting, summed. A throttle says the card
 * is fine and the platform is busy; five of them in a row, each answered at
 * once, used to end a working card inside a few seconds and send the answer a
 * second time as a plain message.
 */
export const CARD_THROTTLE_BUDGET_MS = 30_000;

/** Lark's throttles: its rate-limit code, and HTTP 429 with no code of its own. */
const THROTTLE_CODES: ReadonlySet<number> = new Set([99991400, 429]);

/**
 * Card entities expire after 14 days. We rotate before the edge rather than at
```

In `src/channel/card-writer.ts`, replace:

```ts
  #failures = 0;
```

with:

```ts
  #failures = 0;
  /** Consecutive failed writes of any kind, throttles among them: the backoff's attempt. */
  #attempts = 0;
  /** Waiting spent on throttles since the last write that landed, against `CARD_THROTTLE_BUDGET_MS`. */
  #throttledMs = 0;
  /** No pass starts before this, by the clock: the wait after a failure. */
  #notBefore = 0;
```

In `src/channel/card-writer.ts`, replace:

```ts
    const elapsed = this.#clock.now() - this.#lastWriteAt;
    const delay = Math.max(0, CARD_COALESCE_MS - elapsed);
```

with:

```ts
    const now = this.#clock.now();
    const elapsed = now - this.#lastWriteAt;
    const delay = Math.max(0, CARD_COALESCE_MS - elapsed, this.#notBefore - now);
```

In `src/channel/card-writer.ts`, replace:

```ts
      this.#deps.onRendered(target);
    } catch (err) {
      this.#failures += 1;
      this.#note(`card write through ${target} failed (${this.#failures}): ${describe(err)}`);
```

with:

```ts
      this.#attempts = 0;
      this.#throttledMs = 0;
      this.#deps.onRendered(target);
    } catch (err) {
      // The next pass waits: what the platform said, else a backoff. Retried at
      // once, a throttle is only met again, and a failing card spends the
      // limit in five seconds.
      this.#attempts += 1;
      const wait = (err instanceof ChannelError ? err.retryAfterMs : undefined) ?? backoffMs(this.#attempts);
      this.#notBefore = this.#clock.now() + wait;
      const throttle = err instanceof ChannelError && THROTTLE_CODES.has(err.code);
      if (throttle && this.#throttledMs < CARD_THROTTLE_BUDGET_MS) {
        this.#throttledMs += wait;
        this.#note(`card write through ${target} throttled, waiting ${Math.ceil(wait / 1000)}s: ${describe(err)}`);
      } else {
        this.#failures += 1;
        this.#note(`card write through ${target} failed (${this.#failures}): ${describe(err)}`);
      }
```

In `src/channel/card-writer.ts`, replace:

```ts
    this.#rendered = target;
    this.#lastWriteAt = this.#clock.now();

    try {
      // The parts joined: the plain message reads as the card did.
      const view = renderCard(this.#deps.readEvents(0, target));
```

with:

```ts
    this.#attempts = 0;
    this.#throttledMs = 0;
    this.#notBefore = 0;
    this.#rendered = target;
    this.#lastWriteAt = this.#clock.now();

    let view: RenderedCard | undefined;
    try {
      // The parts joined: the plain message reads as the card did.
      view = renderCard(this.#deps.readEvents(0, target));
```

In `src/channel/card-writer.ts`, replace:

```ts
      this.#note(`card and plain message both failed through ${target}: ${describe(err)}`);
```

with:

```ts
      this.#note(`card and plain message both failed through ${target}: ${describe(err)}`);
    }

    // The card given up on is finished, as every card is: left streaming, it
    // shows its typing cursor until Lark gives up on it. Best effort; it may
    // be what was failing.
    if (had !== undefined && view !== undefined && !this.#finished) {
      await had.finish(view.parts).catch((e: unknown) => this.#note(`finishing the card given up on through ${target} failed: ${describe(e)}`));
```

- [ ] **Step 6.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2702 passed (2702)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6.5: Commit.**

```bash
git add src/channel/card-writer.ts tests/card-writer.test.ts
git commit -m "Wait before the card writer writes again after a failure, as long as Lark said or a backoff, count throttles against the failure limit only after 30 seconds of waiting on them, and finish the card it gives up on"
```

---

### Task 7: A tool-line-only write waits

**Files:**

- Modify: `src/channel/card-writer.ts`, `tests/card-writer.test.ts`

Decision 14, and §4.5's rate limits. Tool events come in bursts, each a request to Lark; a write that changes only the tool line waits until two seconds after the last write, unless the turn is finishing.

- [ ] **Step 7.1: Write the test.**

In `tests/card-writer.test.ts`, replace:

```ts
import { CARD_FAILURE_LIMIT, CARD_MAX_AGE_MS, CARD_THROTTLE_BUDGET_MS, CardWriter } from '../src/channel/card-writer.js';
```

with:

```ts
import { CARD_FAILURE_LIMIT, CARD_MAX_AGE_MS, CARD_THROTTLE_BUDGET_MS, CardWriter, TOOL_LINE_DELAY_MS } from '../src/channel/card-writer.js';
```

In `tests/card-writer.test.ts`, replace:

```ts

  it('reports a swallowed failure instead of retrying in silence', async () => {
```

with:

```ts

  it('holds a write that changes only the tool line until 2 s after the last one, but not one to the answer, nor the finish', async () => {
    // Channel spec §4.5: tool events come in bursts, each a request to Lark.
    const h = harness();
    const tool = (status: string): number => {
      const seq = h.log.length + 1;
      h.log.push(ev(seq, 'tool_call', { toolCallId: 'c1', title: 'Bash', status }));
      return seq;
    };
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.writer.want(tool('in_progress'));
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual(['openCard']);
    expect(h.rendered).toEqual([1]);

    h.clock.advance(TOOL_LINE_DELAY_MS);
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual(['openCard', 'set']);
    expect(h.channel.lastCard?.partSets.at(-1)?.tools).toBe('⏳ Bash');

    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();
    h.writer.want(tool('completed'));
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual(['openCard', 'set', 'set', 'finish']);
    expect(h.channel.lastCard?.partFinishes).toEqual([{ tools: '✅ Bash', answer: 'a\n\nb', status: '' }]);
  });

  it('reports a swallowed failure instead of retrying in silence', async () => {
```

- [ ] **Step 7.2: Run it to verify it fails.** Run `npx vitest run --project unit tests/card-writer.test.ts`. Expected: `Tests  1 failed | 35 passed (36)`, the new test as `AssertionError: expected [ 'openCard', 'set' ] to deeply equal [ 'openCard' ]`.

- [ ] **Step 7.3: Implement.**

In `src/channel/card-writer.ts`, replace:

```ts
import type { CardSession, Channel, SendTarget } from './types.js';
```

with:

```ts
import type { CardParts, CardSession, Channel, SendTarget } from './types.js';
```

In `src/channel/card-writer.ts`, replace:

```ts
/**
 * Card entities expire after 14 days. We rotate before the edge rather than at
```

with:

```ts
/**
 * How long after the last write one that changes only the tool line waits,
 * unless the turn is finishing: two seconds. Tool events come in bursts, each
 * a request to Lark, and the tool line is the part a reader needs least soon;
 * held, a burst is one write, and the card's request rate stays inside Lark's
 * limits for the answer (channel spec §4.5).
 */
export const TOOL_LINE_DELAY_MS = 2_000;

/**
 * Card entities expire after 14 days. We rotate before the edge rather than at
```

In `src/channel/card-writer.ts`, replace:

```ts
  #cardTurn = 0;
```

with:

```ts
  #cardTurn = 0;
  /** The parts the open card was last given and took. Unset with no card. */
  #shownParts: CardParts | undefined;
```

In `src/channel/card-writer.ts`, replace:

```ts
      await this.#write(target);
```

with:

```ts
      // Held, not failed: the pass that follows renders the newest state.
      if (!(await this.#write(target))) return;
```

In `src/channel/card-writer.ts`, replace:

```ts
  async #write(target: number): Promise<void> {
```

with:

```ts
  /** Write the render through `target`; false when it was held (`TOOL_LINE_DELAY_MS`). */
  async #write(target: number): Promise<boolean> {
```

In `src/channel/card-writer.ts`, replace:

```ts
      this.#cardTurn = view.turnStartSeq;
```

with:

```ts
      this.#cardTurn = view.turnStartSeq;
      this.#shownParts = view.parts;
```

In `src/channel/card-writer.ts`, replace:

```ts
      return;
```

with:

```ts
      return true;
    }

    if (!view.finished && toolLineOnly(this.#shownParts, view.parts) && this.#clock.now() - this.#lastWriteAt < TOOL_LINE_DELAY_MS) {
      this.#notBefore = this.#lastWriteAt + TOOL_LINE_DELAY_MS;
      return false;
```

In `src/channel/card-writer.ts`, replace:

```ts
      await session.set(view.parts);
    }
  }
```

with:

```ts
      await session.set(view.parts);
    }
    this.#shownParts = view.parts;
    return true;
  }
```

In `src/channel/card-writer.ts`, replace:

```ts
}

/**
 * One line of operational detail about a failure.
```

with:

```ts
}

/** Whether `next` differs from `shown` in its tool line alone. */
function toolLineOnly(shown: CardParts | undefined, next: CardParts): boolean {
  return shown !== undefined && shown.answer === next.answer && shown.status === next.status && shown.tools !== next.tools;
}

/**
 * One line of operational detail about a failure.
```

- [ ] **Step 7.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2703 passed (2703)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 7.5: Commit.**

```bash
git add src/channel/card-writer.ts tests/card-writer.test.ts
git commit -m "Hold a reply card write that changes only the tool line until two seconds after the last write, unless the turn is finishing, to keep a burst of tool events inside Lark's rate limits"
```

---

### Task 8: The bug, replayed end to end

**Files:**

- Create: `tests/card-parts-replay.test.ts`

§4.5's last test. The card writer, the adapter and the fake cardkit client over one turn of interleaved tool events, answer chunks and an approval, a pass of the writer a second after every event. It passes once written, because Tasks 1 to 7 built what it checks; Step 8.3 breaks the adapter on purpose to show it measures that.

- [ ] **Step 8.1: Write the test.**

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
 * writer through the Lark adapter to a stand-in for Lark's card API, a pass of
 * the writer a second after every event. Lark's client types an element's new text from where the
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
  const clock = new ManualClock(NOW);
  const kit = new FakeCardkit(clock);
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
    clock.advance(1_000);
    await writer.flushNow();
  }
  await writer.close();
  return { kit, log };
}

describe('the reply card, a turn replayed', () => {
  it('only ever grows the answer element at its end, while tool events rewrite the tool line on its own', async () => {
    const { kit } = await replay();
    expect(kit.calls.filter((c) => c.api === 'create')).toHaveLength(1);

    // The zero-width spaces before the first words are dropped, and only those:
    // an answer that emptied later would fail here.
    const given = kit.shown('card_1', REPLY_ELEMENTS.answer);
    const answer = given.slice(given.findIndex((c) => c !== EMPTY_PART));
    expect(given[0]).toBe(EMPTY_PART);
    expect(answer.length).toBeGreaterThan(3);
    for (let i = 1; i < answer.length; i += 1) {
      expect(answer[i]?.startsWith(answer[i - 1] ?? ''), `update ${i}: ${JSON.stringify(answer[i - 1])} then ${JSON.stringify(answer[i])}`).toBe(true);
    }
    // A tool call between two chunks starts a new paragraph (see `renderCard`).
    expect(answer.at(-1)).toBe('The build fails \n\nin `main.ts`.\n\nLine 12 \n\nhad a typo. \n\nFixed, and the build passes.');

    // The tool line moved on its own, none of its updates to the answer, and
    // none refused by Lark's rules.
    const tools = kit.contents(REPLY_ELEMENTS.tools);
    expect(tools.length).toBeGreaterThan(3);
    expect(kit.calls.filter((c) => c.refused === true)).toEqual([]);
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

- [ ] **Step 8.2: Run it.** Run `npx vitest run --project unit tests/card-parts-replay.test.ts`. Expected: `Tests  2 passed (2)`.

- [ ] **Step 8.3: See it measure.** In `src/channel/lark/adapter.ts`, change the line `        const text = partContent(parts[part]);` to `        const text = partContent(part === 'answer' ? [parts.tools, parts.answer].join('\n\n') : parts[part]);`, which puts the tool line back at the start of the answer element. Run `npx vitest run --project unit tests/card-parts-replay.test.ts`. Expected: `Tests  1 failed | 1 passed (2)`, as `AssertionError: update 1: "⏳ Bash\n\nThe build fails" then "✅ Bash\n\nThe build fails \n\nin `main.ts`.": expected false to be true`. Run `git checkout src/channel/lark/adapter.ts` to undo it, and `git diff --stat` shows nothing.

- [ ] **Step 8.4: Run everything.** Run `npx vitest run --project unit`. Expected: `Tests  2705 passed (2705)`. Run `npx vitest run --project e2e`. Expected: `Tests  173 passed (173)`. Run `npm run typecheck`. Expected: no errors. Run `npm run build`. Expected: no errors.

- [ ] **Step 8.5: Commit.**

```bash
git add tests/card-parts-replay.test.ts
git commit -m "Replay a turn of interleaved tool events and answer chunks through the card writer and the Lark adapter, and check that every update the answer element is given starts with the one before"
```

---

## Done when

- `npx vitest run --project unit` gives `Tests  2705 passed (2705)`, run twice. `npx vitest run --project e2e` gives `Tests  173 passed (173)`. `npm run typecheck` and `npm run build` report no errors. All under Node 22, in the worktree.
- `git grep -n -i "p[g]w" -- . ':!package-lock.json'` prints nothing, and `git diff 62ec9c3 -- 'src/*.ts' 'src/**/*.ts' | grep "^+" | grep -c "—"` prints `0`.
- Over every render of a turn, the answer part starts with the one before, but in the cases §4.5 names (`tests/render-parts.test.ts`); over a turn replayed through the writer and the adapter, every update the answer element is given starts with the one before, and Lark's rules refuse none (`tests/card-parts-replay.test.ts`).
- The reply card is made, sent by reference with its own uuid, written part by part with one strictly increasing sequence, kept streaming past Lark's ten minutes, and finished with streaming off; a finish whose write fails rejects with Lark's code; no call goes to the SDK's streaming card (`tests/lark-reply-session.test.ts`, `tests/lark-reply-timeout.test.ts`).
- The writer waits after a failure, lets throttles wait 30 seconds before they count, finishes a card it gives up on, and holds a tool-line-only write (`tests/card-writer.test.ts`).
- Approval cards, board cards and notices are unchanged: their tests pass as they are.

## Before relying on it: the smoke checklist

For the user, once the plan is built and merged, on the Mac with the real Lark tenant. Run each command as the gateway's user. `<node>` is `~/.nvm/versions/node/v22.15.0/bin/node`, and `<mt>` is `<node> <checkout>/dist/mt.js`: never a bare `node`, `npm` or `mt`. Every build runs under the same Node 22.15: `cd <checkout> && PATH=~/.nvm/versions/node/v22.15.0/bin:$PATH npm run build`, then `<mt> service restart`. No migration, so no backup is needed; going back is building the commit before this plan and restarting. Items 1 to 6 settle the points 1 to 6 of §4.5's "Only a live check can confirm", and item 9 its point 8.

1. **The answer types only its new words** (point 1). In a direct message, ask the agent for something that takes several tool calls and a long answer, such as "Read three files of this repo, one at a time, and explain each in a paragraph". Watch the card while it works: the tool line on top changes as calls start and end, and the answer below it never disappears; each new sentence is typed after the last. Before this plan the whole answer vanished and was typed again after nearly every tool call.
2. **The tool line on its own** (point 2). In the same turn, watch the tool line when a call's icon changes, `⏳` to `✅`: note whether the line is typed again from its start or changes at once. Either is acceptable; it is the line alone either way, and it changes at most every two seconds.
3. **The empty parts** (point 3). Right after you send, before any answer, the card shows `Working…` with no blank band above it worth noticing; the first words then appear at once, and the ones after them are typed; there is no gap between the tool line and the answer, nor below the answer when there is no status.
4. **The sequence** (point 4). `<mt> service logs -n 200` shows no `card write through … failed` line, nor `throttled`, for the turns above. A line with a code there means Lark refused an update: note its code.
5. **A long turn** (point 5). Ask for work that runs past twenty minutes and says something as it goes, such as "Run `sleep 600` three times, one after another, and after each one tell me how many are done". The card keeps updating past ten minutes and past twenty; when the answer comes it is typed on the card, not sent as a plain message; `<mt> service logs -n 300` shows no `card write through … failed` line for the turn; and the chat list's preview reads "Working…" until the turn ends.
6. **The preview** (point 6). While a card streams, the chat list shows the bot's last message as "Working…"; once the turn ends, the answer's first words.
7. **The status lines.** Ask for something that needs an approval: `_Waiting for your approval: see the card below._` shows under the answer, not above it, and goes once you answer; the answer above it does not re-type. A turn you stop with `@bot /stop` ends with its `_Turn …._` line under the answer.
8. **Where the card goes.** In a group, `@bot` a question outside a thread: the card quotes your message, as before. In a thread: the card is in the thread.
9. **A long CJK answer** (point 8). Ask for a long answer in Chinese: write to the agent, in Chinese, asking it to explain every directory of this repo in at least ten thousand characters. Note how far the card gets. If Lark refuses it, `<mt> service logs -n 300` shows `card write through … failed` lines with code 200860, and the whole answer then arrives as a plain message; note the length it stopped at.
