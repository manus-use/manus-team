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

  it('fails when Lark answers the making with no card id', async () => {
    const { a, kit } = adapter();
    kit.failNext('create', { code: 0, msg: 'ok' });
    await expect(a.openCard(CHAT, parts('Hi'), 'u')).rejects.toMatchObject({ code: 0, retryable: false });
    expect(kit.calls.map((c) => c.api)).toEqual(['create']);
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

  it("fails the write with Lark's code when turning streaming on again is refused", async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    kit.failNext('content', { code: 300309, msg: 'streaming is closed' });
    kit.failNext('settings', { code: 230020, msg: 'rate limited' });
    await expect(card.set(parts('ab'))).rejects.toMatchObject({ code: 230020 });
    expect(kit.calls.slice(2).map((c) => [c.api, c.refused === true])).toEqual([
      ['content', true],
      ['settings', true],
    ]);
  });

  it('writes again only the parts that did not land when one of three fails', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a', 't1', 's1'), 'u');
    kit.failNext('content', { code: 230020, msg: 'rate limited' }, { skip: 1 });
    await expect(card.set(parts('b', 't2', 's2'))).rejects.toMatchObject({ code: 230020 });
    await card.set(parts('b', 't2', 's2'));
    expect(updates(kit)).toEqual([
      ['tools', 't2', 1],
      ['answer', 'b', 2],
      ['answer', 'b', 3],
      ['status', 's2', 4],
    ]);
  });

  it('writes again an update whose answer was lost though Lark took it, and Lark takes the resend', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    kit.failNext('content', new Error('socket hang up'), { landed: true });
    await expect(card.set(parts('ab'))).rejects.toBeInstanceOf(ChannelError);
    await card.set(parts('ab'));
    expect(kit.calls.filter((c) => c.refused === true)).toEqual([]);
    expect(kit.sequences('card_1')).toEqual([1, 2]);
    expect(kit.shown('card_1', 'answer')).toEqual(['a', 'ab', 'ab']);
  });

  it('does not overlap a finish with a write still on its way, so nothing is refused and streaming ends off', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    const release = kit.holdNext('content');
    const writing = card.set(parts('ab'));
    const finishing = card.finish(parts('abc'));
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([writing, finishing]);
    expect(kit.calls.filter((c) => c.refused === true)).toEqual([]);
    expect(kit.calls.slice(2).map((c) => [c.api, c.sequence])).toEqual([
      ['content', 1],
      ['content', 2],
      ['settings', 3],
    ]);
    expect(kit.shown('card_1', 'answer')).toEqual(['a', 'ab', 'abc']);
    expect(kit.streaming('card_1')).toBe(false);
  });

  it('does not try to turn streaming off on a card Lark no longer holds', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    kit.forget('card_1');
    await expect(card.finish(parts('ab'))).rejects.toMatchObject({ code: 200740 });
    expect(kit.calls.slice(2).map((c) => c.api)).toEqual(['content']);
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

describe('the fake cardkit client', () => {
  // Its own rules, checked, as the tests above lean on them.
  type Raw = {
    cardkit: { v1: { card: { create: (p: object) => Promise<{ code?: number }> } } };
    im: { v1: { message: { create: (p: object) => Promise<{ code?: number }> } } };
  };
  const raw = (kit: FakeCardkit): Raw => kit.lark.rawClient as unknown as Raw;
  const make = (elements: Array<{ element_id: string; content: string }>): object => ({
    data: { type: 'card_json', data: JSON.stringify({ schema: '2.0', body: { elements } }) },
  });

  it('refuses a card with an empty element, or two elements of one id, as Lark does', async () => {
    const kit = new FakeCardkit(new ManualClock(NOW));
    await expect(raw(kit).cardkit.v1.card.create(make([{ element_id: 'a', content: '' }]))).resolves.toMatchObject({ code: 10002 });
    await expect(
      raw(kit).cardkit.v1.card.create(make([{ element_id: 'a', content: 'x' }, { element_id: 'a', content: 'y' }])),
    ).resolves.toMatchObject({ code: 200621 });
    await expect(raw(kit).cardkit.v1.card.create(make([{ element_id: 'a', content: EMPTY_PART }]))).resolves.toMatchObject({ code: 0 });
  });

  it('refuses to send a card by reference that it does not hold', async () => {
    const kit = new FakeCardkit(new ManualClock(NOW));
    const send = raw(kit).im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_team', msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: 'card_9' } }), uuid: 'u' },
    });
    await expect(send).resolves.toMatchObject({ code: 200740 });
  });
});
