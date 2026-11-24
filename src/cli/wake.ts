import { parseArgs } from 'node:util';
import { visible } from '../names.js';
import { INVISIBLE } from '../text.js';
import { hasBoardRun } from './gate.js';
import { ask } from './kanban.js';
import type { MtIo } from './mt.js';
import { jsonLine } from './operator.js';

/**
 * A woken turn's `mt kanban task show` and `task unblock` (wake spec §9.2): in a
 * shell with `MT_WAKE_TOKEN` and no board run's variables, asked of the gateway
 * first, `{wake, token, input}`, before any refusal and before the command's
 * other arguments are acted on. The token says whether the turn is woken, and
 * only the gateway can read it.
 *
 * The gateway answers the show or the unblock, a refusal, or `not_woken`. On
 * `not_woken` this answers nothing (`undefined`), and the caller goes on as
 * before wakes: an agent run's shell (cron on) gets today's refusal, any other
 * the operator's command. A socket that cannot be reached, or does not answer
 * in its time, is refused `unreachable`, with no fallback.
 */

/** How long the gateway is waited for. */
export const WAKE_ANSWER_MS = 30_000;

const FLAGS = { json: { type: 'boolean' }, board: { type: 'string' } } as const;

/** Whether this shell asks the gateway first for `mt kanban task <verb>`. */
export function asksWake(env: MtIo['env'], verb: string | undefined): verb is 'show' | 'unblock' {
  const token = env['MT_WAKE_TOKEN'];
  if (token === undefined || token === '') return false;
  if (hasBoardRun(env)) return false;
  return verb === 'show' || verb === 'unblock';
}

type Answer = { ok: true } & Record<string, unknown>;

/**
 * The command's arguments, read leniently: the gateway is asked before any
 * refusal (§9.2), so an option this form does not know, or a word too many, is
 * no usage error here; on `not_woken` the operator's command reads them strictly.
 */
function lenient(rest: readonly string[]): { taskId: string; words: string[]; json: boolean; board: string | undefined } {
  const { values, positionals } = parseArgs({ args: [...rest], options: FLAGS, allowPositionals: true, strict: false });
  const [taskId = '', ...words] = positionals;
  return { taskId, words, json: values.json === true, board: typeof values.board === 'string' ? values.board : undefined };
}

export async function wokenTask(verb: 'show' | 'unblock', rest: readonly string[], io: MtIo): Promise<number | undefined> {
  const { taskId, words, json, board: asked } = lenient(rest);
  const no = (code: string, message: string): number => {
    if (json) io.out(jsonLine({ ok: false, code, message }));
    else io.err(`mt: ${message.replace(INVISIBLE, '')}`);
    return 1;
  };
  const comment = words.join(' ').trim();
  const input = verb === 'show' ? { task_id: taskId } : { task_id: taskId, ...(comment === '' ? {} : { comment }) };
  const unreachable = `the gateway cannot be reached at MT_KANBAN_SOCKET, so nothing was ${verb === 'show' ? 'shown' : 'unblocked'}`;
  const socket = io.env['MT_KANBAN_SOCKET'];
  if (socket === undefined || socket === '') return no('unreachable', unreachable);
  let answer: unknown;
  try {
    const line = await ask(socket, `${JSON.stringify({ wake: verb, token: io.env['MT_WAKE_TOKEN'], input })}\n`, WAKE_ANSWER_MS);
    answer = JSON.parse(line);
  } catch {
    return no('unreachable', unreachable);
  }
  if (typeof answer !== 'object' || answer === null || typeof (answer as { ok?: unknown }).ok !== 'boolean') {
    return no('unreachable', unreachable);
  }
  const a = answer as { ok: boolean; code?: unknown; message?: unknown };
  if (!a.ok) {
    if (a.code === 'not_woken') return undefined;
    return no(typeof a.code === 'string' ? a.code : 'refused', typeof a.message === 'string' ? a.message : 'the gateway refused');
  }
  const ok = answer as Answer;
  if (verb === 'unblock') {
    if (json) io.out(jsonLine({ ok: true, task_id: ok['task_id'], phase: ok['phase'] }));
    else io.out(String(ok['message']));
    return 0;
  }
  // `--board` is checked against the task's board, as the operator's show checks it.
  const shown = ok['json'] as { task?: { board?: unknown } } | undefined;
  const board = asked?.trim();
  const on = shown?.task?.board;
  if (board !== undefined && board !== '' && typeof on === 'string' && on !== board) {
    return no('other_board', `task ${taskId} is on board ${visible(on)}, not ${visible(board)}`);
  }
  if (json) io.out(jsonLine({ ok: true, ...(shown ?? {}) }));
  else for (const l of (ok['lines'] as unknown[] | undefined) ?? []) io.out(String(l));
  return 0;
}
