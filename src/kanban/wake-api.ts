import type { Channel } from '../channel/types.js';
import { replyUuid } from '../core/ids.js';
import { wakeOfShell, type ThreadAt } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { processZone } from '../cron/schedule.js';
import { redactKnownSecrets } from '../secrets.js';
import { systemClock, type Clock } from '../time.js';
import { NOTICE_SEND_MS } from './notices.js';
import type { KanbanService, WakeJudge } from './service.js';
import type { WakeLookup } from './wake-tokens.js';
import { targetOf } from './waker.js';
import type { GateRow, Refusal, WakeRow } from './types.js';
import type { NameOf, WakeShow } from './chat-render.js';
import type { TaskView } from '../db/kanban-read.js';

/**
 * The socket's `wake` envelope (wake spec §9.2): a woken turn's `mt kanban task
 * show` and `task unblock`, `{wake: 'show' | 'unblock', token, input}`, the
 * session the token's, never named by the request.
 *
 * Checked in §9.2's order: the board and wakes on, which the socket's handler
 * answers before this one is asked; the token, `unauthorized` for none or one
 * `WakeTokens` never held, a board run's, a chat turn's cron token and a fire's
 * among them; `not_woken` for a stale token, or a session whose running turn the
 * board did not wake (`wakeOfShell`), so the shell, with cron off, falls back to
 * the operator's command; then the service's checks of the task against that
 * wake (`showForWake`, `unblockForWake`).
 *
 * The show answers the operator's output, plain and `--json`, the plain people
 * named as the thread names them and quoted under its framing line; the shell
 * prints the one it was asked for. The unblock answers the operator's words and
 * nudges the dispatcher; its `woken_unblock_limit` refusal is also said once in
 * the wake's conversation, until the task next completes.
 */

export const NOT_WOKEN = 'this turn was not woken by the board';

export interface WakeApiDeps {
  db: Db;
  service: KanbanService;
  tokens: { lookup(token: string): WakeLookup | undefined };
  people: {
    canTalk(principal: string): boolean;
    canOperate(principal: string): boolean;
    chatNames(): (principal: string) => string | undefined;
  };
  blockRecurrenceLimit: number;
  /**
   * The operator's `mt kanban task show`, rendered: its plain lines quoted under
   * the framing line with people by `nameOf`, and its `--json`. Given by the
   * gateway from `src/cli/plain.ts` (`wokenShowText`, `showJson`), as no module of
   * the board imports the terminal's.
   */
  render: {
    lines(view: TaskView, gates: readonly GateRow[], wake: WakeShow, nameOf: NameOf): string[];
    json(view: TaskView, gates: readonly GateRow[]): unknown;
  };
  /** Where the woken-unblock limit's line goes: `lark` to the Lark adapter. */
  channels: ReadonlyMap<string, Channel>;
  appId: string;
  /** The gateway's zone, for the show's Wake line: `cron.tz`, else the process's. */
  zone?: string;
  /** A dispatcher pass, after an unblock. */
  nudge?: () => void;
  clock?: Clock;
  /** Ids and counts, never task text. */
  note?: (line: string) => void;
  sendTimeoutMs?: number;
}

function refusal(r: Refusal): Record<string, unknown> {
  return { ok: false, code: r.code, message: r.message };
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export class WakeApi {
  readonly #deps: WakeApiDeps;
  readonly #clock: Clock;
  /** The tasks the limit's line was said for, with the completion it was said after. */
  readonly #limitSaid = new Map<string, number>();

  constructor(deps: WakeApiDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /** One request of the envelope. Never throws: a failure is an answer. */
  handle(request: Record<string, unknown>): Record<string, unknown> {
    const verb = request['wake'];
    if (verb !== 'show' && verb !== 'unblock') {
      return { ok: false, code: 'bad_request', message: 'a wake request is show or unblock' };
    }
    const token = text(request['token']);
    const found = token === undefined ? undefined : this.#deps.tokens.lookup(token);
    if (found === undefined) return { ok: false, code: 'unauthorized', message: 'the wake token is not one this gateway holds' };
    if ('stale' in found) return { ok: false, code: 'not_woken', message: NOT_WOKEN };
    const wake = wakeOfShell(this.#deps.db, found.works.sessionId);
    if (wake === undefined) return { ok: false, code: 'not_woken', message: NOT_WOKEN };
    const input = request['input'];
    const fields = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const taskId = text(fields['task_id']) ?? '';
    return verb === 'show' ? this.#show(wake, taskId) : this.#unblock(wake, taskId, text(fields['comment']));
  }

  #judge(): WakeJudge {
    const { people } = this.#deps;
    const names = people.chatNames();
    return {
      canTalk: (p) => people.canTalk(p),
      canOperate: (p) => people.canOperate(p),
      nameOf: names,
      blockRecurrenceLimit: this.#deps.blockRecurrenceLimit,
    };
  }

  #show(wake: WakeRow, taskId: string): Record<string, unknown> {
    const judge = this.#judge();
    const r = this.#deps.service.showForWake(wake, taskId, judge);
    if (!r.ok) return refusal(r);
    const show = { enabled: true, zone: this.#deps.zone ?? processZone(), now: this.#clock.now() };
    const { render } = this.#deps;
    return { ok: true, lines: render.lines(r.view, r.gates, show, judge.nameOf), json: render.json(r.view, r.gates) };
  }

  #unblock(wake: WakeRow, taskId: string, comment: string | undefined): Record<string, unknown> {
    const r = this.#deps.service.unblockForWake(wake, taskId, comment, this.#judge());
    if (!r.ok) {
      if (r.code === 'woken_unblock_limit') this.#sayLimit(wake, taskId, r.message);
      return refusal(r);
    }
    try {
      this.#deps.nudge?.();
    } catch {
      // The dispatcher's own timer looks again.
    }
    return {
      ok: true,
      task_id: r.task.taskId,
      phase: r.task.phase,
      message: `\`${r.task.taskId}\` is unblocked, back to ${r.task.phase}, as ${r.setter} (woken by the board)`,
    };
  }

  /**
   * The woken-unblock limit's line, in the wake's conversation (§9.2): once a
   * task until it next completes, kept in memory, sent with the notifier's bound,
   * masked, never retried.
   */
  #sayLimit(wake: WakeRow, taskId: string, line: string): void {
    const completed =
      this.#deps.db
        .prepare<[string], { id: number | null }>("SELECT max(id) AS id FROM kanban_events WHERE task_id = ? AND kind = 'completed'")
        .get(taskId)?.id ?? 0;
    if (this.#limitSaid.get(taskId) === completed) return;
    this.#limitSaid.set(taskId, completed);
    const channel = this.#deps.channels.get(wake.channel);
    const note = this.#deps.note ?? (() => undefined);
    if (channel === undefined) {
      note(`kanban: the woken-unblock limit's line for ${taskId} was not sent: no channel ${wake.channel}`);
      return;
    }
    const at: ThreadAt = { channel: wake.channel, appId: wake.appId, conversationId: wake.conversationId, threadId: wake.threadId };
    const ms = this.#deps.sendTimeoutMs ?? NOTICE_SEND_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the send took too long')), ms);
    });
    const send = channel.sendText(targetOf(this.#deps.db, at), redactKnownSecrets(line), replyUuid(this.#deps.appId, `wake-limit:${taskId}`, String(completed)));
    send.catch(() => undefined);
    void Promise.race([send, late])
      .catch((err: unknown) => {
        note(`kanban: the woken-unblock limit's line for ${taskId} was not sent (${err instanceof Error ? err.message : String(err)})`);
      })
      .finally(() => clearTimeout(timer));
  }
}
