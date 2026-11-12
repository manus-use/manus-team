import { describe, expect, it } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { LarkAdapter } from '../src/channel/lark/adapter.js';
import { LarkInbound, cardInput, clickUuid, mentionsOf } from '../src/channel/lark/inbound.js';
import type { InboundCardAction, Router } from '../src/core/router.js';
import type { InboundMessage } from '../src/types.js';

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

describe('clickUuid', () => {
  const press = (token: string): CardActionEvent => ({
    messageId: 'om_card',
    chatId: 'oc_dm',
    operator: { openId: 'ou_alice' },
    action: { value: { kind: 'kanban', act: 'block' }, tag: 'button' },
    raw: { token },
  });

  it("is the same for a re-delivered press, and differs for another press of the same button, or another box's text", () => {
    expect(clickUuid('cli_app', press('t1'), 'x')).toBe(clickUuid('cli_app', press('t1'), 'x'));
    expect(clickUuid('cli_app', press('t1'), 'x')).toHaveLength(50);
    expect(clickUuid('cli_app', press('t2'), 'x')).not.toBe(clickUuid('cli_app', press('t1'), 'x'));
    expect(clickUuid('cli_app', press('t1'), 'y')).not.toBe(clickUuid('cli_app', press('t1'), 'x'));
    expect(clickUuid('cli_app', press('t1'), undefined)).not.toBe(clickUuid('cli_app', press('t1'), 'x'));
  });
});

describe('LarkInbound, on a message', () => {
  it("gives a message in a thread the thread's root, as Lark's root_id, and one at chat scope none (spec §19.4)", async () => {
    let handlers: { message?: (msg: NormalizedMessage) => Promise<void> } = {};
    const routed: InboundMessage[] = [];
    const adapter = { raw: { on: (h: typeof handlers) => ((handlers = h), () => undefined) }, botOpenId: BOT } as unknown as LarkAdapter;
    const router = { onMessage: async (m: InboundMessage) => void routed.push(m) } as unknown as Router;
    new LarkInbound({ adapter, router, config: { appId: 'cli_app', downloadDir: '/nonexistent' } }).start();
    const msg = (over: Partial<NormalizedMessage>): NormalizedMessage =>
      ({
        messageId: 'om_2',
        chatId: 'oc_team',
        chatType: 'group',
        senderId: 'ou_owner',
        content: '/kanban task list',
        mentionedBot: true,
        mentionAll: false,
        resources: [],
        createTime: 0,
        raw: raw([]),
        ...over,
      }) as unknown as NormalizedMessage;
    await handlers.message?.(msg({ threadId: 'omt_topic', rootId: 'om_root' }));
    // A quoted reply at chat scope has a root_id too: it is no thread's.
    await handlers.message?.(msg({ rootId: 'om_quoted' }));
    expect(routed.map((m) => [m.threadId, m.rootId])).toEqual([
      ['omt_topic', 'om_root'],
      ['', undefined],
    ]);
  });

  it("gives the message that starts a topic, which Lark sends with a thread_id and no root_id, itself as its thread's root (spec §19.1)", async () => {
    let handlers: { message?: (msg: NormalizedMessage) => Promise<void> } = {};
    const routed: InboundMessage[] = [];
    const adapter = { raw: { on: (h: typeof handlers) => ((handlers = h), () => undefined) }, botOpenId: BOT } as unknown as LarkAdapter;
    const router = { onMessage: async (m: InboundMessage) => void routed.push(m) } as unknown as Router;
    new LarkInbound({ adapter, router, config: { appId: 'cli_app', downloadDir: '/nonexistent' } }).start();
    const starter = (over: Partial<NormalizedMessage>): NormalizedMessage =>
      ({
        messageId: 'om_starter',
        chatId: 'oc_team',
        chatType: 'group',
        senderId: 'ou_owner',
        content: '/kanban task new Check the links',
        mentionedBot: true,
        mentionAll: false,
        resources: [],
        createTime: 0,
        raw: raw([]),
        threadId: 'omt_topic',
        ...over,
      }) as unknown as NormalizedMessage;
    await handlers.message?.(starter({}));
    await handlers.message?.(starter({ rootId: '' }));
    expect(routed.map((m) => [m.threadId, m.rootId])).toEqual([
      ['omt_topic', 'om_starter'],
      ['omt_topic', 'om_starter'],
    ]);
  });
});

describe('LarkInbound, on a button press', () => {
  /** An inbound side over stand-ins: the SDK's channel captures its handlers, and nothing reaches Lark. */
  function inbound(answer: string | undefined): {
    press: (evt: CardActionEvent) => Promise<void>;
    sent: string[];
    release: () => void;
    inbound: LarkInbound;
  } {
    let handlers: { cardAction?: (evt: CardActionEvent) => Promise<void> } = {};
    const sent: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const adapter = {
      raw: { on: (h: typeof handlers) => ((handlers = h), () => undefined) },
      botOpenId: 'ou_bot',
      sendText: async (_target: unknown, text: string) => {
        await held;
        sent.push(text);
        return { messageId: 'om_ack', deduped: false };
      },
    } as unknown as LarkAdapter;
    const router = { onCardAction: async (_a: InboundCardAction) => answer } as unknown as Router;
    const i = new LarkInbound({ adapter, router, config: { appId: 'cli_app', downloadDir: '/nonexistent' } });
    i.start();
    return { press: (evt) => handlers.cardAction?.(evt) ?? Promise.resolve(), sent, release, inbound: i };
  }

  const evt: CardActionEvent = {
    messageId: 'om_card',
    chatId: 'oc_team',
    operator: { openId: 'ou_owner' },
    action: { value: { kind: 'approval' }, tag: 'button' },
  };

  it("returns before an approval's acknowledgement is sent, and is idle once it is", async () => {
    const i = inbound('Sent: Deny.');
    // Returns although the send is held: the SDK answers Lark's callback only once this has.
    await i.press(evt);
    expect(i.sent).toEqual([]);
    expect(await i.inbound.idle(20)).toBe(false);
    i.release();
    expect(await i.inbound.idle(1_000)).toBe(true);
    expect(i.sent).toEqual(['Sent: Deny.']);
  });

  it("never rejects an approval's acknowledgement, even when its send fails and so does the note of it", async () => {
    let handlers: { cardAction?: (evt: CardActionEvent) => Promise<void> } = {};
    const adapter = {
      raw: { on: (h: typeof handlers) => ((handlers = h), () => undefined) },
      botOpenId: 'ou_bot',
      sendText: async () => {
        throw new Error('network down');
      },
    } as unknown as LarkAdapter;
    const router = { onCardAction: async (_a: InboundCardAction) => 'Sent: Deny.' } as unknown as Router;
    const i = new LarkInbound({
      adapter,
      router,
      config: { appId: 'cli_app', downloadDir: '/nonexistent' },
      note: () => {
        throw new Error('the log is gone');
      },
    });
    i.start();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await handlers.cardAction?.(evt);
      expect(await i.idle(1_000)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it("sends nothing for a board card's press", async () => {
    const i = inbound(undefined);
    i.release();
    await i.press(evt);
    expect(await i.inbound.idle(1_000)).toBe(true);
    expect(i.sent).toEqual([]);
  });
});
