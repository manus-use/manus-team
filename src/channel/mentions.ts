import { label } from '../kanban/chat-render.js';
import type { InboundMessage } from '../types.js';

/**
 * A person named in chat by @-mention (kanban spec §9.1, the tier grants spec
 * §6.1): found among the message's mentions by the name Lark's text shows, or
 * by the mention's key, so there is no name to resolve or confuse. `/kanban`
 * and `/auth` both resolve a mention here, so the two cannot come to read one
 * differently; a typed `lark:<union_id>` stays with each caller.
 */

/** Why a mention named no one person. */
export type MentionRefusal = 'not_mentioned' | 'bot' | 'no_union_id' | 'ambiguous';

/** The person an `@Name` stands for, as Lark gave them with the message; or a refusal, in words for chat. */
export type Mentioned =
  | { ok: true; unionId: string; openId: string | null; name: string | null }
  | { ok: false; reason: MentionRefusal; reply: string };

/**
 * The person `name`, an `@Name`, stands for: the one person among the
 * message's mentions shown by that name, with the union_id and open_id Lark
 * sent. Refused when the message mentions no one by it, when the mention is
 * of a bot, when Lark gave no union_id with the mention, and when more than
 * one person is shown by it.
 */
export function mentionedPerson(name: string, message: InboundMessage): Mentioned {
  const shown = name.slice(1).trim();
  const found = (message.mentions ?? []).filter((m) => m.name === shown || m.key === name);
  const unionIds = [...new Set(found.map((m) => m.unionId).filter((u): u is string => u !== null))];
  if (found.length === 0) {
    return {
      ok: false,
      reason: 'not_mentioned',
      reply: `${label(name, 80)} is not someone this message mentions: type @ and pick them, so Lark says who they are.`,
    };
  }
  if (found.some((m) => m.isBot === true)) {
    return { ok: false, reason: 'bot', reply: `${label(name, 80)} is a bot, and a bot's tier is configuration's.` };
  }
  const unionId = unionIds[0];
  if (unionId === undefined) {
    return {
      ok: false,
      reason: 'no_union_id',
      reply: `Lark did not say who ${label(name, 80)} is (no union_id came with the mention). Ask the operator to check the app can read user ids.`,
    };
  }
  if (unionIds.length > 1) {
    return { ok: false, reason: 'ambiguous', reply: `More than one person mentioned is called ${label(name, 80)}; say which with \`lark:<union_id>\`.` };
  }
  const mention = found.find((m) => m.unionId === unionId);
  return { ok: true, unionId, openId: mention?.openId ?? null, name: mention?.name ?? null };
}
