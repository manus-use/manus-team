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

  it('goes ahead with the write when turning streaming on ahead of time is refused, and tries again on the next', async () => {
    const { a, kit, ours } = adapter();
    const card = await a.openCard(CHAT, parts('a'), 'u');
    ours.advance(9.5 * MINUTE);
    kit.failNext('settings', refused(99991400, 429));
    await expect(card.set(parts('ab'))).resolves.toBeUndefined();
    await card.set(parts('abc'));
    expect(after(kit)).toEqual([
      ['settings', true, true],
      ['content', false, undefined],
      ['settings', false, true],
      ['content', false, undefined],
    ]);
    expect(kit.shown('card_1', 'answer')).toEqual(['a', 'ab', 'abc']);
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
