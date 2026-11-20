import { describe, expect, it } from 'vitest';
import { EMPTY_PART, LarkAdapter, replyCard } from '../src/channel/lark/adapter.js';
import { CARD_GONE_CODES, ChannelError, type CardParts } from '../src/channel/types.js';
import { DUPLICATE_ELEMENT_CODE, FakeCardkit, LAST_ELEMENT_CODE, refused } from './helpers/cardkit.js';
import { ManualClock } from './helpers/db.js';

/**
 * The reply card's session over Lark's card API (channel spec §4.5): the card
 * is created with an element for each part with something to show and sent by
 * reference, each part that changed is written to its own element with the
 * card's next sequence, an element added when its part first has something and
 * taken out when it empties, and finishing turns streaming off. Over a stand-in for the SDK: nothing here
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

/** The element calls, adds, contents and deletes, as [api, element, sequence]. */
function elementCalls(kit: FakeCardkit): Array<[string, string | undefined, number | undefined]> {
  return kit.calls.filter((c) => ['add', 'content', 'update', 'delete'].includes(c.api)).map((c) => [c.api, c.elementId, c.sequence]);
}

/** The card's elements now, as [id, content], in its order. */
function elements(kit: FakeCardkit, cardId = 'card_1'): Array<[string, string]> {
  return kit.shown(cardId).map((e) => [e.id, e.content]);
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
    expect(elementCalls(kit)).toEqual([
      ['add', 'tools', 1],
      ['content', 'answer', 2],
      ['content', 'tools', 3],
      ['content', 'answer', 4],
    ]);
    expect(updates(kit)).toEqual([
      ['answer', 'Hello', 2],
      ['tools', '✅ Bash', 3],
      ['answer', 'Hello wor', 4],
    ]);
    expect(kit.calls.filter((c) => c.api === 'content').map((c) => c.uuid)).toEqual(['c_card_1_2', 'c_card_1_3', 'c_card_1_4']);
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

describe('the reply card holds only the parts with something to show', () => {
  const WORKING = '_Working…_';

  it('starts with only the status element', async () => {
    const { a, kit } = adapter();
    await a.openCard(CHAT, parts('', '', WORKING), 'u');
    expect(elements(kit)).toEqual([['status', WORKING]]);
    expect(kit.calls[0]?.body).toMatchObject({ body: { elements: [{ tag: 'markdown', element_id: 'status', content: WORKING }] } });
  });

  it('adds the tool line before the status at the first tool, then the answer between them at its first chunk, and takes the status out', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', WORKING), 'u');
    await card.set(parts('', '⏳ Bash'));
    expect(kit.calls.at(-2)).toMatchObject({ api: 'add', elementId: 'tools', type: 'insert_before', target: 'status', sequence: 1, uuid: 'a_card_1_1' });
    expect(kit.calls.at(-2)?.body).toEqual({ tag: 'markdown', element_id: 'tools', content: '⏳ Bash' });
    expect(kit.calls.at(-1)).toMatchObject({ api: 'delete', elementId: 'status', sequence: 2, uuid: 'd_card_1_2' });
    expect(elements(kit)).toEqual([['tools', '⏳ Bash']]);

    // The status back, below the tool line, then the answer between them.
    const other = adapter();
    const second = await other.a.openCard(CHAT, parts('', '', WORKING), 'u');
    await second.set(parts('', '⏳ Bash', WORKING));
    expect(elements(other.kit)).toEqual([
      ['tools', '⏳ Bash'],
      ['status', WORKING],
    ]);
    await second.set(parts('The build', '⏳ Bash'));
    expect(other.kit.calls.slice(2).map((c) => [c.api, c.elementId, c.type, c.target, c.sequence])).toEqual([
      ['add', 'tools', 'insert_before', 'status', 1],
      ['add', 'answer', 'insert_after', 'tools', 2],
      ['delete', 'status', undefined, undefined, 3],
    ]);
    expect(elements(other.kit)).toEqual([
      ['tools', '⏳ Bash'],
      ['answer', 'The build'],
    ]);
    // The status that comes later goes below the answer.
    await second.set(parts('The build', '⏳ Bash', '_Waiting for your approval: see the card below._'));
    expect(other.kit.calls.at(-1)).toMatchObject({ api: 'add', elementId: 'status', type: 'insert_after', target: 'answer', sequence: 4 });
    expect(elements(other.kit).map(([id]) => id)).toEqual(['tools', 'answer', 'status']);
    expect(other.kit.calls.filter((c) => c.refused === true)).toEqual([]);
  });

  it('never has a tool element in a turn with no tools, and the answer grows by content updates once added', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', WORKING), 'u');
    await card.set(parts('Hel'));
    expect(elements(kit)).toEqual([['answer', 'Hel']]);
    expect(kit.calls.at(-2)).toMatchObject({ api: 'add', elementId: 'answer', type: 'insert_before', target: 'status' });
    await card.set(parts('Hello'));
    await card.finish(parts('Hello there.'));
    expect(kit.calls.some((c) => c.elementId === 'tools')).toBe(false);
    expect(elementCalls(kit)).toEqual([
      ['add', 'answer', 1],
      ['delete', 'status', 2],
      ['content', 'answer', 3],
      ['content', 'answer', 4],
    ]);
    expect(kit.shown('card_1', 'answer')).toEqual(['Hel', 'Hello', 'Hello there.']);
    expect(elements(kit)).toEqual([['answer', 'Hello there.']]);
  });

  it('leaves no empty element once finished, and no zero-width space anywhere', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', WORKING), 'u');
    await card.set(parts('Done', '✅ Bash', '_Waiting for your approval: see the card below._'));
    await card.finish(parts('Done.', '✅ Bash'));
    expect(elements(kit)).toEqual([
      ['tools', '✅ Bash'],
      ['answer', 'Done.'],
    ]);
    expect(kit.streaming('card_1')).toBe(false);
    expect(kit.calls.filter((c) => c.refused === true)).toEqual([]);
    expect(JSON.stringify(kit.calls)).not.toContain(EMPTY_PART);
  });

  it('draws one sequence across adds, deletes, content and settings', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', WORKING), 'u');
    await card.set(parts('', '⏳ Bash', WORKING));
    await card.set(parts('a', '✅ Bash'));
    await card.set(parts('ab', '✅ Bash', '_Waiting for your approval: see the card below._'));
    await card.finish(parts('abc', '✅ Bash'));
    expect(kit.calls.slice(2).map((c) => [c.api, c.elementId, c.sequence])).toEqual([
      ['add', 'tools', 1],
      ['content', 'tools', 2],
      ['add', 'answer', 3],
      ['delete', 'status', 4],
      ['content', 'answer', 5],
      ['add', 'status', 6],
      ['content', 'answer', 7],
      ['delete', 'status', 8],
      ['settings', undefined, 9],
    ]);
    expect(kit.calls.filter((c) => c.refused === true)).toEqual([]);
  });

  it('falls back to one whole-card replace when Lark refuses an add, and goes on from there', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', WORKING), 'u');
    kit.failNext('add', { code: 300313, msg: 'element not found' });
    await expect(card.set(parts('First', '⏳ Bash'))).resolves.toBeUndefined();
    expect(kit.calls.slice(2).map((c) => [c.api, c.sequence, c.refused === true])).toEqual([
      ['add', 1, true],
      ['replace', 2, false],
    ]);
    expect(kit.calls.at(-1)).toMatchObject({ uuid: 'r_card_1_2', body: replyCard(parts('First', '⏳ Bash')) });
    expect(elements(kit)).toEqual([
      ['tools', '⏳ Bash'],
      ['answer', 'First'],
    ]);
    await card.set(parts('First words', '⏳ Bash'));
    expect(kit.calls.at(-1)).toMatchObject({ api: 'content', elementId: 'answer', content: 'First words', sequence: 3 });
    expect(kit.shown('card_1', 'answer')).toEqual(['First', 'First words']);
  });

  it('blanks the element when Lark refuses a delete, the answer untouched, and writes it again in place later', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', WORKING), 'u');
    kit.failNext('delete', refused(10002));
    await card.set(parts('First'));
    expect(kit.calls.slice(2).map((c) => [c.api, c.elementId, c.content, c.sequence, c.refused === true])).toEqual([
      ['add', 'answer', 'First', 1, false],
      ['delete', 'status', undefined, 2, true],
      ['update', 'status', EMPTY_PART, 3, false],
    ]);
    expect(elements(kit)).toEqual([
      ['answer', 'First'],
      ['status', EMPTY_PART],
    ]);
    // The blanked element is the part empty: not deleted again on every write.
    await card.set(parts('First words'));
    expect(kit.calls.at(-1)).toMatchObject({ api: 'content', elementId: 'answer', sequence: 4 });
    expect(kit.calls).toHaveLength(6);
    // The status back: written to its element, where it is.
    await card.set(parts('First words', '', '_Waiting for your approval: see the card below._'));
    expect(kit.calls.at(-1)).toMatchObject({ api: 'content', elementId: 'status', sequence: 5 });
    expect(kit.shown('card_1', 'answer')).toEqual(['First', 'First words']);
    expect(kit.calls.some((c) => c.api === 'replace')).toBe(false);
  });

  it('throws when the replace is refused too, and replaces the card whole on the next write', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', WORKING), 'u');
    kit.failNext('add', { code: 10002, msg: 'invalid' });
    kit.failNext('replace', refused(99991400, 429));
    await expect(card.set(parts('First'))).rejects.toMatchObject({ code: 99991400 });
    expect(elements(kit)).toEqual([['status', WORKING]]);
    await card.set(parts('First'));
    expect(kit.calls.slice(2).map((c) => [c.api, c.sequence, c.refused === true])).toEqual([
      ['add', 1, true],
      ['replace', 2, true],
      ['replace', 3, false],
    ]);
    expect(elements(kit)).toEqual([['answer', 'First']]);
    // Sure again once the replace lands: the next write is a content update.
    await card.set(parts('First words'));
    expect(kit.calls.at(-1)).toMatchObject({ api: 'content', elementId: 'answer', sequence: 4 });
  });

  it('throws a throttled add or delete with its code, no replace, and writes it again on the next write', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', WORKING), 'u');
    kit.failNext('add', refused(99991400, 429));
    await expect(card.set(parts('First'))).rejects.toMatchObject({ code: 99991400 });
    kit.failNext('delete', { code: 230020, msg: 'rate limited' });
    await expect(card.set(parts('First'))).rejects.toMatchObject({ code: 230020 });
    await card.set(parts('First'));
    expect(kit.calls.slice(2).map((c) => [c.api, c.sequence, c.refused === true])).toEqual([
      ['add', 1, true],
      ['add', 2, false],
      ['delete', 3, true],
      ['delete', 4, false],
    ]);
    expect(elements(kit)).toEqual([['answer', 'First']]);
  });

  it('throws an add or a delete on a card Lark no longer holds, with no replace', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', WORKING), 'u');
    kit.forget('card_1');
    await expect(card.set(parts('First'))).rejects.toMatchObject({ code: 200740 });
    await expect(card.finish(parts('First'))).rejects.toMatchObject({ code: 200740 });
    expect(kit.calls.slice(2).map((c) => c.api)).toEqual(['add', 'add']);
  });

  it('replaces the card while its elements are in doubt: an add lost on its way back, then a refused replace', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('', '', WORKING), 'u');
    kit.failNext('add', new Error('socket hang up'), { landed: true });
    kit.failNext('replace', refused(99991400, 429));
    await expect(card.set(parts('', '⏳ Bash', WORKING))).rejects.toMatchObject({ code: 99991400 });
    // Lark took the add: the card has the tool line the session could not count on.
    expect(elements(kit).map(([id]) => id)).toEqual(['tools', 'status']);
    // The tool line cleared again: nothing differs from what the session last
    // knew, but the card is replaced, so it has no tool element.
    await card.set(parts('', '', WORKING));
    expect(kit.calls.at(-1)?.api).toBe('replace');
    expect(kit.calls.at(-1)?.refused).toBeUndefined();
    expect(elements(kit)).toEqual([['status', WORKING]]);
  });

  it('replaces the card while its elements are in doubt: a delete lost on its way back, then a refused replace', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a', '', WORKING), 'u');
    kit.failNext('delete', new Error('socket hang up'), { landed: true });
    kit.failNext('replace', refused(99991400, 429));
    await expect(card.set(parts('a'))).rejects.toMatchObject({ code: 99991400 });
    // Lark took the delete, so blanking the element met 300313, and the replace was refused.
    expect(kit.calls.slice(2).map((c) => [c.api, c.refused === true])).toEqual([
      ['delete', false],
      ['update', true],
      ['replace', true],
    ]);
    expect(elements(kit)).toEqual([['answer', 'a']]);
    // The status back: nothing differs from what the session last knew, but
    // the card is replaced, so the status is there.
    await card.set(parts('a', '', WORKING));
    expect(elements(kit)).toEqual([
      ['answer', 'a'],
      ['status', WORKING],
    ]);
  });

  it('replaces the card whole when a content update finds its element missing', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('a', '✅ Bash'), 'u');
    kit.failNext('content', { code: 300313, msg: 'element not found' });
    await card.set(parts('ab', '✅ Bash'));
    expect(kit.calls.slice(2).map((c) => [c.api, c.sequence, c.refused === true])).toEqual([
      ['content', 1, true],
      ['replace', 2, false],
    ]);
    expect(elements(kit)).toEqual([
      ['tools', '✅ Bash'],
      ['answer', 'ab'],
    ]);
  });

  it('finishes with a finished whole card when a delete and its blanking are refused, then turns streaming off', async () => {
    const { a, kit } = adapter();
    const card = await a.openCard(CHAT, parts('Done', '', '_Waiting for your approval: see the card below._'), 'u');
    kit.failNext('delete', new Error('socket hang up'));
    kit.failNext('update', { code: 10002, msg: 'invalid' });
    await card.finish(parts('Done.'));
    expect(kit.calls.slice(2).map((c) => [c.api, c.refused === true])).toEqual([
      ['content', false],
      ['delete', true],
      ['update', true],
      ['replace', false],
      ['settings', false],
    ]);
    expect(kit.calls.at(-2)?.body).toMatchObject({ config: { streaming_mode: false, summary: { content: 'Done.' } } });
    expect(kit.calls.at(-2)?.body).toEqual(replyCard(parts('Done.'), true));
    expect(elements(kit)).toEqual([['answer', 'Done.']]);
    expect(kit.streaming('card_1')).toBe(false);
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

  type Elements = {
    create: (p: object) => Promise<{ code?: number }>;
    delete: (p: object) => Promise<{ code?: number }>;
  };
  const elementsOf = (kit: FakeCardkit): Elements => (kit.lark.rawClient as unknown as { cardkit: { v1: { cardElement: Elements } } }).cardkit.v1.cardElement;
  const add = (type: string, target: string | undefined, id: string, sequence: number): object => ({
    path: { card_id: 'card_1' },
    data: {
      type,
      ...(target === undefined ? {} : { target_element_id: target }),
      elements: JSON.stringify([{ tag: 'markdown', element_id: id, content: id }]),
      sequence,
    },
  });

  it("adds and deletes elements by Lark's rules, and shows the card's elements in order", async () => {
    const kit = new FakeCardkit(new ManualClock(NOW));
    await raw(kit).cardkit.v1.card.create(make([{ element_id: 'b', content: 'b' }]));
    const el = elementsOf(kit);
    await expect(el.create(add('insert_before', 'b', 'a', 1))).resolves.toMatchObject({ code: 0 });
    await expect(el.create(add('insert_after', 'b', 'c', 2))).resolves.toMatchObject({ code: 0 });
    await expect(el.create(add('append', undefined, 'd', 3))).resolves.toMatchObject({ code: 0 });
    expect(kit.shown('card_1').map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
    // An unknown target, an id the card has, a sequence not above the last.
    await expect(el.create(add('insert_before', 'zz', 'e', 4))).resolves.toMatchObject({ code: 300313 });
    await expect(el.create(add('insert_after', 'a', 'c', 4))).resolves.toMatchObject({ code: DUPLICATE_ELEMENT_CODE });
    await expect(el.create(add('append', undefined, 'e', 3))).resolves.toMatchObject({ code: 300317 });
    // Deleting: an unknown element, a stale sequence, then one Lark takes.
    await expect(el.delete({ path: { card_id: 'card_1', element_id: 'zz' }, data: { sequence: 4 } })).resolves.toMatchObject({ code: 300313 });
    await expect(el.delete({ path: { card_id: 'card_1', element_id: 'b' }, data: { sequence: 3 } })).resolves.toMatchObject({ code: 300317 });
    await expect(el.delete({ path: { card_id: 'card_1', element_id: 'b' }, data: { sequence: 4 } })).resolves.toMatchObject({ code: 0 });
    expect(kit.shown('card_1')).toEqual([
      { id: 'a', content: 'a' },
      { id: 'c', content: 'c' },
      { id: 'd', content: 'd' },
    ]);
    // Never the last element.
    await expect(el.delete({ path: { card_id: 'card_1', element_id: 'a' }, data: { sequence: 5 } })).resolves.toMatchObject({ code: 0 });
    await expect(el.delete({ path: { card_id: 'card_1', element_id: 'c' }, data: { sequence: 6 } })).resolves.toMatchObject({ code: 0 });
    await expect(el.delete({ path: { card_id: 'card_1', element_id: 'd' }, data: { sequence: 7 } })).resolves.toMatchObject({ code: LAST_ELEMENT_CODE });
    expect(kit.shown('card_1').map((e) => e.id)).toEqual(['d']);
  });
});
