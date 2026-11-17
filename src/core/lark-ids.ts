/**
 * Lark's ids as a terminal names them (kanban spec §22.1, the cron spec §6.2):
 * a chat, `oc_…`, and a thread, `omt_…`, checked for shape only, as a terminal
 * has no Lark client to ask whether the bot is in the chat. `mt cron`, the
 * operator's `mt kanban` and the board's service all check them here, so
 * nothing in `src/kanban/` imports from `src/cli/`.
 */

/** A chat id as Lark gives one. */
export const CHAT_ID = /^oc_[A-Za-z0-9]{1,64}$/;

/** A thread id as Lark gives one. */
export const THREAD_ID = /^omt_[A-Za-z0-9]{1,64}$/;

/** What a terminal's `--chat` says when this shell's settings give the bot no app id. */
export const NEEDS_BOT = '--chat needs the bot: set lark.appId in the config file, or LARK_APP_ID';

/**
 * Why a terminal may not name `chat`: it is outside `chats`, `auth.chats` as
 * the settings give it, which is not empty, so the gateway admits no message
 * from it and nobody there could answer. Undefined when it may: an empty list
 * means any chat, as it does for the gateway.
 */
export function chatRefused(chat: string, chats: readonly string[]): string | undefined {
  if (chats.length === 0 || chats.includes(chat)) return undefined;
  return `${chat} is not in auth.chats, so this gateway does not act in it: add it there, or name a chat that is`;
}
