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
    expect(view.parts.tools.endsWith('…')).toBe(true);
    expect(view.parts.tools).not.toContain('\n');
    expect(view.parts.answer.length).toBeLessThanOrEqual(CARD_TEXT_BUDGET);
    expect(view.parts.answer).toContain('truncated');
    expect(view.parts.status.length).toBeLessThanOrEqual(STATUS_BUDGET);
    expect(view.parts.status.endsWith('…')).toBe(true);
    expect(view.text.length).toBeLessThanOrEqual(CARD_TEXT_BUDGET);
  });
});

describe('renderCard: a cut part', () => {
  it('cuts the tool line and the status with a bare ellipsis, so the tool line stays one line', () => {
    const view = renderCard([
      ev('turn_submitted', { text: 'hi' }),
      ...Array.from({ length: 400 }, (_x, i) => ev('tool_call', { toolCallId: `c${i}`, title: `Read file${i}.ts`, status: 'completed' })),
      ev('agent_error', { message: 'e'.repeat(STATUS_BUDGET * 2), retryable: false }),
    ]);
    expect(view.parts.tools).toHaveLength(TOOLS_BUDGET);
    expect(view.parts.tools.split('\n')).toHaveLength(1);
    expect(view.parts.tools.endsWith('…')).toBe(true);
    expect(view.parts.status).toHaveLength(STATUS_BUDGET);
    expect(view.parts.status.endsWith('e…')).toBe(true);
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
