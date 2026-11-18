import { describe, expect, it } from 'vitest';
import { CARD_FAILURE_LIMIT, CardWriter } from '../src/channel/card-writer.js';
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

describe('the reply card, a turn too large for a card', () => {
  it('falls back once when Lark refuses the card past 30 KB, keeps the turn plain, and sends the rest once at its end', async () => {
    // A long CJK answer: three bytes a character, so past Lark's 30 KB inside the
    // character budget (channel spec §4.5).
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
    const pass = async (type: EventType, payload: unknown): Promise<void> => {
      log.push(ev(log.length + 1, type, payload));
      writer.want(log.length);
      clock.advance(1_000);
      await writer.flushNow();
    };
    await pass('turn_submitted', { text: 'explain it all' });
    for (let i = 0; i < 40; i += 1) await pass('agent_message_chunk', { text: `[${i}]${'中'.repeat(400)}` });
    await pass('turn_ended', { terminal: 'completed' });
    await writer.close();

    expect(kit.calls.filter((c) => c.api === 'create')).toHaveLength(1);
    const refusedSize = kit.calls.filter((c) => c.refused === true);
    expect(refusedSize.length).toBeGreaterThan(0);
    expect(refusedSize.every((c) => c.api === 'content')).toBe(true);
    // Five refusals give the card up; the fallback's finish may meet a sixth.
    expect(refusedSize.length).toBeLessThanOrEqual(CARD_FAILURE_LIMIT + 1);
    expect(kit.streaming('card_1')).toBe(false);

    const plain = kit.calls.filter((c) => c.api === 'text' || (c.api === 'send' && c.msgType !== 'interactive'));
    expect(plain).toHaveLength(2);
    // The second carries the rest only: the answer's start is not sent again.
    const text = (c: (typeof plain)[number] | undefined): string => c?.content ?? JSON.stringify(c?.body);
    expect(text(plain[0])).toContain('[0]');
    expect(text(plain[1])).not.toContain('[0]');
    expect(text(plain[1])).toContain('[39]');
  });
});
