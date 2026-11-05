import { describe, expect, it } from 'vitest';
import { cardInput, mentionsOf } from '../src/channel/lark/inbound.js';

/**
 * What the Lark side reads from a raw event that the SDK's normalizer drops: the
 * union_ids of the people a message mentions, which is how the board knows a
 * person (spec §9.1), and the text a card's box held when its button was pressed.
 */

const BOT = 'ou_bot';

function raw(mentions: unknown): unknown {
  return { sender: { sender_id: { union_id: 'on_sender' } }, message: { message_id: 'om_1', mentions } };
}

describe('mentionsOf', () => {
  it("gives each person's key, name and ids, leaving out the bot and @all", () => {
    expect(
      mentionsOf(
        raw([
          { key: '@_user_1', name: 'Bot', id: { open_id: BOT, union_id: 'on_bot' } },
          { key: '@_user_2', name: 'Alice Smith', id: { open_id: 'ou_alice', union_id: 'on_alice' } },
          { key: '@_all', name: 'Everyone', id: {} },
          { key: '@_user_3', id: { open_id: 'ou_bob' } },
        ]),
        BOT,
      ),
    ).toEqual([
      { key: '@_user_2', name: 'Alice Smith', openId: 'ou_alice', unionId: 'on_alice' },
      { key: '@_user_3', name: null, openId: 'ou_bob', unionId: null },
    ]);
  });

  it('is empty for an event without mentions, or with anything else in their place', () => {
    expect(mentionsOf(raw(undefined), BOT)).toEqual([]);
    expect(mentionsOf(undefined, BOT)).toEqual([]);
    expect(mentionsOf(raw('@_user_1'), BOT)).toEqual([]);
    expect(mentionsOf(raw([null, 'x', { name: 'no key' }]), BOT)).toEqual([]);
  });
});

describe('cardInput', () => {
  it("is what the card's box named text held", () => {
    expect(cardInput({ action: { value: {}, form_value: { text: 'shipped it' } } })).toEqual({ input: 'shipped it' });
    expect(cardInput({ action: { form_value: { text: '' } } })).toEqual({ input: '' });
  });

  it('is nothing for a button that submitted no form', () => {
    expect(cardInput({ action: { value: {} } })).toEqual({});
    expect(cardInput({ action: { form_value: { other: 'x' } } })).toEqual({});
    expect(cardInput(undefined)).toEqual({});
  });
});
