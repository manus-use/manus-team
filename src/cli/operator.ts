import { boardSetting } from '../kanban/chat-parse.js';
import type { KanbanService } from '../kanban/service.js';
import { maskAll, workerSocketPath } from '../kanban/socket.js';
import type { BoardRow, Refusal } from '../kanban/types.js';
import { NUDGE } from '../kanban/worker.js';
import { parse, UsageError } from './args.js';
import { operatorName, withBoard } from './gate.js';
import { ask, why } from './kanban.js';
import type { MtIo } from './mt.js';
import { BIDI, boardsText, line } from './plain.js';

/**
 * The operator's `mt kanban` (spec §2.6): chat's `/kanban` commands at a
 * terminal, with chat's semantics and an operator's authority -- whoever runs
 * them is the gateway's user, who could edit its files anyway. They write the
 * board's database beside a running gateway, through `KanbanService`, as `mt
 * kanban gate` does, and record who acted as `operator:<login>`.
 *
 * **Never the worker's.** These refuse to run in a board run's shell, and there
 * `show`, `comment` and `link` are the worker's commands (spec §7.3); the
 * worker's take no arguments and read JSON on stdin, these take their task and
 * text as arguments. `src/cli/mt.ts` decides which a command line is.
 *
 * **Output** is plain text, masked, or with `--json` one line of JSON, as the
 * worker's is: `{"ok": true, ...}` or `{"ok": false, "code": ..., "message": ...}`.
 * Exit codes: 0 done, 1 refused, 2 the command line was wrong.
 *
 * **A nudge after a change.** A change that chat follows with a dispatcher pass
 * is followed here by a request for one, over the gateway's socket: the one
 * request that needs no token, and does nothing else (`NUDGE`). A gateway that
 * does not answer, stopped, loses nothing: the change stands, and its next
 * sweep, or its next start, acts on it. A gateway whose config does not set
 * `kanban.enabled` is not asked, and the command says nothing will run the
 * change until the board is turned on.
 */

/** How long a nudge waits for the gateway's answer: a pass is quick, and the change is made already. */
export const NUDGE_TIMEOUT_MS = 2_000;

/** What a command did: the lines to print, the JSON to print instead, and whether to nudge the gateway. */
interface Done {
  ok: true;
  lines: string[];
  json: Record<string, unknown>;
  nudge?: boolean;
}

type Outcome = Done | { ok: false; code: string; message: string };

/** A refusal as the board said it, masked and on one line: it may quote what was typed. */
function refused(r: Refusal | { code: string; message: string }): Outcome {
  return { ok: false, code: r.code, message: line(r.message, 600) };
}

/** `--json` on every command. */
const JSON_FLAG = { json: { type: 'boolean' } } as const;

/**
 * Characters JSON leaves as they are that a terminal or a reader may act on: C1
 * controls, the line and paragraph separators, and the bidi controls. Escaped
 * as `\uXXXX`, which every JSON reader reads back as the same string.
 */
const UNSAFE_IN_JSON = /[\u0080-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/** One line of JSON, masked, with nothing in it a terminal acts on. */
export function jsonLine(value: unknown): string {
  return JSON.stringify(maskAll(value)).replace(UNSAFE_IN_JSON, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** `--board <name>`, trimmed; a blank one is a wrong command line. */
export function boardFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value.trim();
  if (name === '') throw new UsageError('--board needs a board name');
  return name;
}

function boardJson(b: BoardRow): Record<string, unknown> {
  return { name: b.name, max_running: b.maxRunning, workspace: b.workspace, archived: b.archivedAt !== null };
}

/**
 * Ask the gateway at `home` for a dispatcher pass, at the socket it listens on:
 * `failed` says why not, in a few words, when it did not answer.
 */
export async function nudgeGateway(home: string, timeoutMs = NUDGE_TIMEOUT_MS): Promise<{ socket: string; failed?: string }> {
  let socket: string;
  try {
    socket = workerSocketPath(home);
  } catch (err) {
    return { socket: home, failed: err instanceof Error ? err.message : String(err) };
  }
  try {
    const answer: unknown = JSON.parse(await ask(socket, `${JSON.stringify(NUDGE)}\n`, timeoutMs));
    if ((answer as { ok?: unknown } | null)?.ok === true) return { socket };
    return { socket, failed: 'it did not take the nudge' };
  } catch (err) {
    return { socket, failed: err instanceof SyntaxError ? 'it gave no answer' : why(err) };
  }
}

/**
 * Run `fn` on the board, as the operator, then print what it did -- in JSON for
 * `--json` -- and nudge the gateway after a change that asks for it.
 */
async function act(
  io: MtIo,
  json: boolean,
  what: string,
  fn: (service: KanbanService, by: string) => Outcome,
): Promise<number> {
  const no = (code: string, message: string): number => {
    if (json) io.out(jsonLine({ ok: false, code, message }));
    else io.err(`mt: ${message.replace(BIDI, '')}`);
    return 1;
  };
  let outcome: Outcome | undefined;
  let home = '';
  let enabled = true;
  const code = withBoard(
    io,
    what,
    (board) => {
      home = board.home;
      enabled = board.kanbanEnabled;
      outcome = fn(board.service, operatorName(io));
      return 0;
    },
    { refuse: no, unsetNote: 'those values are not masked here' },
  );
  if (outcome === undefined) return code;
  if (!outcome.ok) return no(outcome.code, outcome.message);
  const done: Done = outcome;
  let nudged: boolean | undefined;
  if (done.nudge === true && !enabled) {
    nudged = false;
    io.err(
      "mt: the board is off on this gateway (its config does not set kanban.enabled): the change is recorded, " +
        'and nothing runs it until the board is turned on and the gateway restarted',
    );
  } else if (done.nudge === true) {
    const r = await nudgeGateway(home);
    nudged = r.failed === undefined;
    if (r.failed !== undefined) {
      io.err(
        `mt: no gateway answered at ${r.socket} (${r.failed}); the change stands: a running gateway acts on it ` +
          'at its next sweep, and a stopped one when it next starts',
      );
    }
  }
  if (json) io.out(jsonLine({ ok: true, ...done.json, ...(nudged === undefined ? {} : { nudged }) }));
  else for (const l of done.lines) io.out(l);
  return 0;
}

/** `mt kanban board list|create|set|archive` (spec §16.3). There is no `use`: a terminal is no chat. */
async function board(args: readonly string[], io: MtIo): Promise<number> {
  const [sub, ...rest] = args;
  const { values, positionals } = parse(rest, JSON_FLAG);
  const json = values.json === true;
  switch (sub) {
    case 'list': {
      const [word, extra] = positionals;
      const all = word?.toLowerCase();
      if (extra !== undefined || (all !== undefined && all !== 'all')) throw new UsageError('kanban board list takes at most all');
      return act(io, json, 'mt kanban board list', (service) => {
        const summaries = service.boards({ archived: all === 'all' });
        return {
          ok: true,
          lines: boardsText(summaries),
          json: { boards: summaries.map((s) => ({ ...boardJson(s.board), counts: s.counts })) },
        };
      });
    }
    case 'create':
    case 'archive': {
      const [name, extra] = positionals;
      if (name === undefined || extra !== undefined) throw new UsageError(`kanban board ${sub} takes one name`);
      return act(io, json, `mt kanban board ${sub}`, (service, by) => {
        const r = sub === 'create' ? service.createBoard(name, by) : service.archiveBoard(name, by);
        if (!r.ok) return refused(r);
        const lines =
          sub === 'create'
            ? [`created board ${line(r.board.name, 80)}; mt kanban new --board ${line(r.board.name, 80)} adds a task to it`]
            : [`archived board ${line(r.board.name, 80)}: its tasks stay, and mt kanban show still shows them; nothing more is added to it`];
        return { ok: true, lines, json: { board: boardJson(r.board) } };
      });
    }
    case 'set': {
      const [name, setting, value, extra] = positionals;
      const change = setting === undefined || value === undefined ? undefined : boardSetting(setting, value);
      if (name === undefined || change === undefined || extra !== undefined) {
        throw new UsageError('kanban board set takes a name, then max_running <number|none> or workspace <workspace|none>');
      }
      return act(io, json, 'mt kanban board set', (service, by) => {
        const r = service.setBoard(name, change, by);
        if (!r.ok) return refused(r);
        const b = r.board;
        const said =
          change.maxRunning !== undefined
            ? b.maxRunning === null
              ? `board ${line(b.name, 80)} has no max_running of its own now: the gateway's kanban.max_running holds`
              : `board ${line(b.name, 80)} runs at most ${b.maxRunning} agent${b.maxRunning === 1 ? '' : 's'} at once now`
            : `board ${line(b.name, 80)}'s tasks work in ${line(b.workspace ?? 'default', 80)} now, unless their own workspace, their role's or their parents' says otherwise`;
        // A higher limit, or a workspace, can make a task claimable.
        return { ok: true, lines: [said], json: { board: boardJson(b) }, nudge: true };
      });
    }
    case 'use':
      throw new UsageError('kanban board use moves a chat, and a terminal has none: give new and list --board <name>');
    default:
      throw new UsageError('kanban board takes list, create, set or archive');
  }
}

/** `mt kanban <command>` outside a board run: the operator's. */
export async function operatorCommand(command: string | undefined, rest: readonly string[], io: MtIo): Promise<number> {
  switch (command) {
    case 'board':
      return board(rest, io);
    default:
      throw new UsageError(`unknown command: kanban${command === undefined ? '' : ` ${command}`}`);
  }
}
