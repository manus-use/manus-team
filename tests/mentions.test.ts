import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mentionedPerson } from '../src/channel/mentions.js';
import type { InboundMention, InboundMessage } from '../src/types.js';

/**
 * `mentionedPerson` (the tier grants spec §6.1): the `@` half of the board's
 * mention resolution, moved out of `KanbanChat` so `/auth` resolves a mention
 * as `/kanban` does, with the same three refusals in the same words, and the
 * mention's open_id beside its union_id.
 */

function message(mentions: InboundMention[] | undefined): InboundMessage {
  return {
    messageId: 'om_1',
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: '',
    sender: { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' },
    senderIsBot: false,
    text: '/kanban task new x',
    mentionedBot: true,
    mentionAll: false,
    ...(mentions === undefined ? {} : { mentions }),
    attachments: [],
    createTime: 1,
  };
}

const CAROL: InboundMention = { key: '@_user_1', name: 'Carol Wu', openId: 'ou_carol', unionId: 'on_carol' };

describe('mentionedPerson', () => {
  it('finds the person by the name the text shows, or by the key, with both ids', () => {
    expect(mentionedPerson('@Carol Wu', message([CAROL]))).toEqual({ ok: true, unionId: 'on_carol', openId: 'ou_carol', name: 'Carol Wu' });
    expect(mentionedPerson('@_user_1', message([CAROL]))).toEqual({ ok: true, unionId: 'on_carol', openId: 'ou_carol', name: 'Carol Wu' });
    // The same person mentioned twice is one person.
    expect(mentionedPerson('@Carol Wu', message([CAROL, { ...CAROL, key: '@_user_2' }]))).toMatchObject({ ok: true, unionId: 'on_carol' });
  });

  it('refuses someone the message does not mention, a mention with no union_id, and two people of one name', () => {
    expect(mentionedPerson('@Dan', message([CAROL]))).toEqual({
      ok: false,
      reason: 'not_mentioned',
      reply: '@Dan is not someone this message mentions: type @ and pick them, so Lark says who they are.',
    });
    expect(mentionedPerson('@Dan', message(undefined))).toMatchObject({ ok: false, reason: 'not_mentioned' });
    expect(mentionedPerson('@Carol Wu', message([{ ...CAROL, unionId: null }]))).toEqual({
      ok: false,
      reason: 'no_union_id',
      reply: 'Lark did not say who @Carol Wu is (no union_id came with the mention). Ask the operator to check the app can read user ids.',
    });
    expect(mentionedPerson('@Carol Wu', message([CAROL, { ...CAROL, key: '@_user_2', unionId: 'on_other' }]))).toEqual({
      ok: false,
      reason: 'ambiguous',
      reply: 'More than one person mentioned is called @Carol Wu; say which with `lark:<union_id>`.',
    });
  });

  it("refuses a bot's mention, by Lark's mentioned_type, and judges one without the field as before", () => {
    expect(mentionedPerson('@Helper', message([{ key: '@_user_1', name: 'Helper', openId: 'ou_helper', unionId: null, isBot: true }]))).toEqual({
      ok: false,
      reason: 'bot',
      reply: "@Helper is a bot, and a bot's tier is configuration's.",
    });
    expect(mentionedPerson('@Carol Wu', message([{ ...CAROL, isBot: false }]))).toMatchObject({ ok: true, unionId: 'on_carol' });
  });

  it('escapes the name it quotes, and the board calls it rather than keeping a copy', () => {
    expect(mentionedPerson('@a_b*', message([]))).toMatchObject({ reply: expect.stringContaining('@a\\_b\\*') });
    const chat = readFileSync(new URL('../src/kanban/chat.ts', import.meta.url), 'utf8');
    expect(chat).toContain("from '../channel/mentions.js'");
    expect(chat).not.toContain('is not someone this message mentions: type @ and pick them, so Lark says who they are.`');
  });
});
