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
