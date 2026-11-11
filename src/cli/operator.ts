import { readFileSync, statSync } from 'node:fs';
import { listed, whenMade } from '../kanban/chat-render.js';
import { boardSetting, isPerson, LIST_FILTERS, tooBig, type NewTaskCommand } from '../kanban/chat-parse.js';
import type { KanbanService } from '../kanban/service.js';
import { maskAll, workerSocketPath } from '../kanban/socket.js';
import { DEFAULT_BOARD, type BoardRow, type Contract, type Refusal, type Waiting } from '../kanban/types.js';
import { WORKER_LIMITS } from '../kanban/limits.js';
import { NUDGE } from '../kanban/worker.js';
import { visible } from '../names.js';
import { parse, UsageError } from './args.js';
import { operatorName, withBoard } from './gate.js';
import { ask } from './kanban.js';
import type { MtIo } from './mt.js';
import { BIDI, INVISIBLE } from '../text.js';
import { boardsText, line, listText, showText, who } from './plain.js';

/**
 * The operator's `mt kanban task …` and `mt kanban board …` (spec §2.6): chat's
 * `/kanban` commands at a terminal, with chat's semantics and an operator's authority -- whoever runs
 * them is the gateway's user, who could edit its files anyway. They write the
 * board's database beside a running gateway, through `KanbanService`, as `mt
 * kanban gate` does, and record who acted as `operator:<login>`.
 *
 * **Never the worker's.** These refuse to run in a board run's shell. The
 * worker's commands (spec §7.3), `mt kanban show`, `comment`, `link` and the
 * rest, are named without a group, take no arguments and read JSON on stdin;
 * these are under `task`, and take their task and text as arguments.
 * `src/cli/mt.ts` decides which a command line is.
 *
 * **Output** is plain text, masked, or with `--json` one line of JSON, as the
 * worker's is: `{"ok": true, ...}` or `{"ok": false, "code": ..., "message": ...}`.
 * Exit codes: 0 done, 1 refused, 2 the command line was wrong.
 *
 * **A nudge after a change.** A change that chat follows with a dispatcher pass
 * is followed here by a request for one, over the gateway's socket: the one
 * request that needs no token, and does nothing else (`NUDGE`). A gateway that
 * does not answer, stopped, loses nothing: the change stands, and its next
 * sweep, or its next start, acts on it. The command is never said to be worth
 * trying again: it has been made, and a second `new` would make a second task,
 * unless it has a `--key`, when it returns the first.
 * A gateway whose config does not set `kanban.enabled`, or sets it to false, is
 * not asked, and the command says nothing will run the change until the board
 * is turned on.
 */

/** How long a nudge waits for the gateway's answer: a pass is quick, and the change is made already. */
export const NUDGE_TIMEOUT_MS = 2_000;

/** What a command did: the lines to print, the JSON to print instead, and whether to nudge the gateway. */
interface Done {
  ok: true;
  lines: string[];
  json: Record<string, unknown>;
  nudge?: boolean;
  /** A `task new --key`: running it again returns the task, rather than making it twice. */
  keyed?: boolean;
}

type Outcome = Done | { ok: false; code: string; message: string };

/** A refusal as the board said it, masked and on one line: it may quote what was typed. */
function refused(r: Refusal | { code: string; message: string }): Outcome {
  return { ok: false, code: r.code, message: line(r.message, 600) };
}

/** `--json` on every command. */
const JSON_FLAG = { json: { type: 'boolean' } } as const;

/**
 * Characters JSON leaves as they are that a terminal or a reader may act on: DEL
 * and the C1 controls, the line and paragraph separators, and the bidi controls. Escaped
 * as `\uXXXX`, which every JSON reader reads back as the same string.
 */
const UNSAFE_IN_JSON = /[\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

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

/** The socket refused, or dropped the connection: a gateway that is too busy, or one that stopped and left its socket. */
const DEAD = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'];

/**
 * Why the nudge was not answered, in a few words. Never "try again", as the
 * worker CLI's `why` says of a request it did not make: this change was made.
 */
function unanswered(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'ENOENT; is the gateway running?';
  if (code !== undefined && DEAD.includes(code)) return `${code}; it may be busy, or stopped`;
  return code ?? (err instanceof Error ? err.message : String(err));
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
    return { socket, failed: err instanceof SyntaxError ? 'it gave no answer' : unanswered(err) };
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
    else io.err(`mt: ${message.replace(INVISIBLE, '')}`);
    return 1;
  };
  let outcome: Outcome | undefined;
  let home = '';
  let enabled: boolean | undefined = true;
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
  if (done.nudge === true && enabled !== true) {
    nudged = false;
    const config = enabled === false ? 'sets kanban.enabled to false' : 'does not set kanban.enabled';
    io.err(
      `mt: the board is off on this gateway (its config ${config}): the change is recorded, ` +
        'and nothing runs it until the board is turned on and the gateway restarted',
    );
  } else if (done.nudge === true) {
    const r = await nudgeGateway(home);
    nudged = r.failed === undefined;
    if (r.failed !== undefined) {
      io.err(
        `mt: no gateway answered at ${r.socket} (${r.failed}); the change stands, and running the command again ` +
          `${done.keyed === true ? 'with the same --key returns this task' : 'would make it twice'}: ` +
          'a running gateway acts on it at its next sweep, and a stopped one when it next starts',
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
            ? [`created board ${line(r.board.name, 80)}; mt kanban task new --board ${line(r.board.name, 80)} adds a task to it`]
            : [`archived board ${line(r.board.name, 80)}: its tasks stay, and mt kanban task show still shows them; nothing more is added to it`];
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
      throw new UsageError('kanban board use moves a chat, and a terminal has none: give task new and task list --board <name>');
    default:
      throw new UsageError('kanban board takes list, create, set or archive');
  }
}

/** A refusal made before the board is opened: a body that cannot be read, or is too big. */
function early(io: MtIo, json: boolean, code: string, message: string): number {
  if (json) io.out(jsonLine({ ok: false, code, message }));
  else io.err(`mt: ${line(message, 600)}`);
  return 1;
}

/**
 * A person is given work from chat, by @-mention, where the gateway can check
 * they have talk tier (spec §4.2): a terminal has no allowlist to check against.
 */
function personRefused(name: string): Outcome | undefined {
  if (!isPerson(name)) return undefined;
  return refused({
    code: 'person_not_assignable',
    message: `${JSON.stringify(name)} is a person: give a person work from chat, by @-mention, where the gateway can check they have talk tier`,
  });
}

/** One task id, and nothing else. */
function oneTask(positionals: readonly string[], what: string): string {
  const [taskId, extra] = positionals;
  if (taskId === undefined || extra !== undefined) throw new UsageError(`kanban task ${what} takes a task id`);
  return taskId;
}

/** `--board` on a command that takes it, with `--json`. */
const BOARD_FLAGS = { ...JSON_FLAG, board: { type: 'string' } } as const;

/** A refusal unless a board of this name exists, archived or not. */
function noSuchBoard(service: KanbanService, board: string): Outcome | undefined {
  if (service.boards({ archived: true }).some((s) => s.board.name === board)) return undefined;
  return refused({ code: 'unknown_board', message: `there is no board ${visible(board)}` });
}

/**
 * With `--board`, a refusal unless the board exists and every task named is on
 * it (spec §16.4); without, nothing: a task id names its task on any board, as in chat.
 */
function offBoard(service: KanbanService, board: string | undefined, ...taskIds: string[]): Outcome | undefined {
  if (board === undefined) return undefined;
  const missing = noSuchBoard(service, board);
  if (missing !== undefined) return missing;
  for (const taskId of taskIds) {
    const r = service.show(taskId);
    if (!r.ok) return refused(r);
    const task = r.view.task;
    if (task.board !== board) {
      return refused({ code: 'other_board', message: `task ${task.taskId} is on board ${visible(task.board)}, not ${visible(board)}` });
    }
  }
  return undefined;
}

/** The new task's body: `--body`, or `--body-file`, `-` for stdin; or why not, already said. */
async function bodyOf(values: { body?: string | undefined; 'body-file'?: string | undefined }, io: MtIo, json: boolean): Promise<string | number> {
  const file = values['body-file'];
  if (values.body !== undefined && file !== undefined) throw new UsageError('kanban task new takes --body or --body-file, not both');
  if (file === undefined) return values.body ?? '';
  const max = WORKER_LIMITS.body;
  if (file === '-') {
    if (io.stdinIsTTY === true) {
      return early(io, json, 'invalid', '--body-file - reads the body on stdin; stdin is a terminal: redirect a file or pipe it');
    }
    const text = await (io.stdin?.(max) ?? Promise.resolve(''));
    return text ?? early(io, json, 'too_large', `A body is at most ${max} bytes.`);
  }
  try {
    // A regular file only: a FIFO or a device could block, or never end.
    const st = statSync(file);
    if (!st.isFile()) return early(io, json, 'invalid', `${file} is not a regular file: give a file, or - for stdin`);
    if (st.size > max) return early(io, json, 'too_large', `A body is at most ${max} bytes.`);
    return readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    return early(io, json, 'invalid', `cannot read the body from ${file}: ${code}`);
  }
}

/** The flags of `mt kanban task new`, and the contract field each fills (spec §4.3). */
const CONTRACT_FLAGS = {
  outcome: 'outcome',
  verify: 'verification',
  constraints: 'constraints',
  boundaries: 'boundaries',
  'stop-when': 'stop_when',
} as const;

/** `mt kanban task new <title> [--board …] [--assignee …] …` (spec §9.1): `/kanban task new`'s fields as flags. */
async function create(rest: readonly string[], io: MtIo): Promise<number> {
  const text = { type: 'string' } as const;
  const { values, positionals } = parse(rest, {
    ...JSON_FLAG,
    board: text,
    assignee: text,
    reviewer: text,
    workspace: text,
    parent: { type: 'string', multiple: true },
    outcome: text,
    verify: text,
    constraints: text,
    boundaries: text,
    'stop-when': text,
    body: text,
    'body-file': text,
    key: text,
  });
  const json = values.json === true;
  const words = positionals.join(' ');
  // One line, as chat's title is: a line break, a control character or a bidi
  // control is refused, not silently changed. Checked before trimming, so a
  // trailing newline or a leading tab is refused too.
  if (/[\p{Cc}\u2028\u2029]/u.test(words) || new RegExp(BIDI.source).test(words)) {
    throw new UsageError('a title is one line, with no control characters and no bidi controls');
  }
  const title = words.trim();
  if (title === '') throw new UsageError('kanban task new takes a title');
  for (const flag of ['board', 'assignee', 'reviewer', 'workspace', 'key', ...Object.keys(CONTRACT_FLAGS)] as const) {
    const v = values[flag as keyof typeof values];
    if (typeof v === 'string' && v.trim() === '') throw new UsageError(`--${flag} needs a value`);
  }
  const parents = (values.parent ?? []).flatMap((p) => p.split(/[\s,]+/)).filter((p) => p !== '');
  if (values.parent !== undefined && parents.length === 0) throw new UsageError('--parent needs a value');
  const body = await bodyOf(values, io, json);
  if (typeof body === 'number') return body;
  const contract: Contract = {};
  for (const [flag, field] of Object.entries(CONTRACT_FLAGS)) {
    const v = values[flag as keyof typeof CONTRACT_FLAGS];
    if (v !== undefined) contract[field] = v.trim();
  }
  const command: NewTaskCommand = {
    verb: 'new',
    title,
    body: body.replace(/\r\n?/g, '\n').trimEnd(),
    parents,
    contract,
    ...(values.assignee === undefined ? {} : { assignee: values.assignee.trim() }),
    ...(values.reviewer === undefined ? {} : { reviewer: values.reviewer.trim() }),
    ...(values.workspace === undefined ? {} : { workspace: values.workspace.trim() }),
  };
  const big = tooBig(command);
  if (big !== undefined) return early(io, json, 'too_large', big);
  const board = boardFlag(values.board) ?? DEFAULT_BOARD;
  // One line, as a title is: a control character or a bidi control is refused, not changed.
  if (values.key !== undefined && (/[\p{Cc}\u2028\u2029]/u.test(values.key) || new RegExp(BIDI.source).test(values.key))) {
    throw new UsageError('a key is one line, with no control characters and no bidi controls');
  }
  const key = values.key?.trim();
  return act(io, json, 'mt kanban task new', (service, by) => {
    for (const name of [command.assignee, command.reviewer]) {
      const person = name === undefined ? undefined : personRefused(name);
      if (person !== undefined) return person;
    }
    const r = service.create({
      board,
      title: command.title,
      ...(command.body === '' ? {} : { body: command.body }),
      contract: command.contract,
      ...(command.assignee === undefined ? {} : { assignee: command.assignee }),
      ...(command.reviewer === undefined ? {} : { reviewer: command.reviewer }),
      ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
      ...(command.parents.length === 0 ? {} : { parents: command.parents }),
      ...(key === undefined ? {} : { idempotencyKey: key }),
      createdBy: by,
      createdVia: { kind: 'operator' },
    });
    if (!r.ok) return refused(r);
    const { task } = r;
    // The key's task, made by an earlier run of the command: nothing changed, so no nudge.
    if (r.existing) {
      return {
        ok: true,
        lines: [
          `task ${task.taskId} already exists with key ${line(key ?? '', 80)}: ${line(task.title)}` +
            `${task.phase === 'archived' ? ' (archived)' : ''}, on board ${line(task.board, 80)}; nothing new was created`,
        ],
        // Nothing changed, so the gateway was not asked to look.
        json: { task_id: task.taskId, board: task.board, existing: true, nudged: false },
      };
    }
    const whom = task.assignee === null ? `nobody yet (mt kanban task assign ${task.taskId} <role> gives it to someone)` : who(task.assignee);
    const where = task.workspace === null ? '' : `, in ${line(task.workspace, 80)}`;
    return {
      ok: true,
      lines: [`created ${task.taskId}: ${line(task.title)}, for ${whom}${where}, on board ${line(task.board, 80)}`],
      json: { task_id: task.taskId, board: task.board, existing: false },
      nudge: true,
      ...(key === undefined ? {} : { keyed: true }),
    };
  });
}

/** `mt kanban task list [<status>|all] [--board <name>]` (spec §9.1): one board's tasks, `default`'s unless named. */
function list(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [word, extra] = positionals;
  const filter = word === undefined ? undefined : LIST_FILTERS.find((f) => f === word.toLowerCase());
  if (extra !== undefined || (word !== undefined && filter === undefined)) {
    throw new UsageError(`kanban task list takes at most one of ${LIST_FILTERS.join(', ')}`);
  }
  const board = boardFlag(values.board) ?? DEFAULT_BOARD;
  return act(io, values.json === true, 'mt kanban task list', (service) => {
    const missing = noSuchBoard(service, board);
    if (missing !== undefined) return missing;
    const entries = service.list(board);
    const tasks = listed(entries, filter).map((e) => ({
      task_id: e.task.taskId,
      status: e.status,
      title: e.task.title,
      assignee: e.task.assignee?.name ?? null,
      assignee_kind: e.task.assignee?.kind ?? null,
    }));
    return { ok: true, lines: listText(entries, filter, board), json: { board, tasks } };
  });
}

/** One reason a task waits, as `--json` gives it: snake_case, as the rest of the output is. */
function waitingJson(w: Waiting): Record<string, unknown> {
  switch (w.kind) {
    case 'gateway':
      return { reason: 'gateway', max_running: w.maxRunning };
    case 'board':
      return { reason: 'board', board: w.board, max_running: w.maxRunning };
    case 'role':
      return { reason: 'role', role: w.role, max_running: w.maxRunning };
    case 'workspace':
      return { reason: 'workspace', workspace: w.workspace, task_id: w.taskId, run_id: w.runId };
  }
}

/** `mt kanban task show <task> [--board <name>]`: a task on any board, by id, or on the one named (spec §16.4). */
function show(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const taskId = oneTask(positionals, 'show');
  const board = boardFlag(values.board);
  return act(io, values.json === true, 'mt kanban task show', (service) => {
    const guard = offBoard(service, board, taskId);
    if (guard !== undefined) return guard;
    const r = service.show(taskId);
    if (!r.ok) return refused(r);
    const gates = service.listGates(taskId);
    const g = gates.ok ? gates.gates : [];
    const { task } = r.view;
    const roleWait = r.view.waiting?.find((w) => w.kind === 'role');
    return {
      ok: true,
      lines: showText(r.view, g),
      json: {
        task: {
          task_id: task.taskId,
          title: task.title,
          body: task.body,
          contract: task.contract,
          assignee: task.assignee?.name ?? null,
          reviewer: task.reviewer?.name ?? null,
          workspace: task.workspace,
          // Its own directory (spec §18), or null in the workspace's shared one: its path and branch are null until
          // made, and first says no agent has taken it up yet, so its first agent claim makes it, not its next.
          worktree:
            r.view.workdir === undefined
              ? null
              : {
                  path: r.view.workdir.path,
                  branch: r.view.workdir.branch,
                  made: r.view.workdir.path !== null,
                  first: r.view.workdir.first === true,
                },
          phase: task.phase,
          status: r.view.status,
          board: task.board,
          block_kind: task.blockKind,
          block_reason: task.blockReason,
          // The role whose max_running the task is waiting on (spec §6.3), or null.
          waiting_on_role: roleWait === undefined ? null : { role: roleWait.role, max_running: roleWait.maxRunning },
          // Every reason a pass skips it, in the order the pass checks them; empty for none.
          waiting: (r.view.waiting ?? []).map(waitingJson),
        },
        parents: r.view.parents.map((p) => ({ task_id: p.taskId, phase: p.phase, status: r.view.statuses.get(p.taskId) ?? null })),
        children: r.view.children.map((c) => ({ task_id: c.taskId, phase: c.phase, status: r.view.statuses.get(c.taskId) ?? null })),
        gates: g.map((x) => ({ gate_id: x.id, command: x.command, timeout_s: x.timeoutS, by: x.createdBy })),
        runs: r.view.runs.map((run) => ({
          run_id: run.runId,
          attempt: run.attempt,
          kind: run.kind,
          assignee: run.assignee.name,
          outcome: run.outcome,
          summary: run.summary,
          error: run.error,
        })),
        comments: r.view.comments.map((c) => ({ author: c.author, body: c.body, created_at: c.createdAt })),
      },
    };
  });
}

/** `mt kanban task assign <task> <role>`: an undecided run ends `superseded`, and the gateway's pass cancels its turn. */
function assign(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [taskId, role, extra] = positionals;
  const name = role?.trim();
  if (taskId === undefined || name === undefined || name === '' || extra !== undefined) {
    throw new UsageError('kanban task assign takes a task id and a role');
  }
  const board = boardFlag(values.board);
  return act(io, values.json === true, 'mt kanban task assign', (service, by) => {
    const person = personRefused(name);
    if (person !== undefined) return person;
    const guard = offBoard(service, board, taskId);
    if (guard !== undefined) return guard;
    const now = service.show(taskId);
    if (now.ok && now.view.task.assignee !== null && now.view.task.assignee.name === name) {
      const task = now.view.task;
      return { ok: true, lines: [`${task.taskId} is already assigned to ${who(task.assignee)}`], json: { task_id: task.taskId, changed: false } };
    }
    const r = service.assign(taskId, name, by);
    if (!r.ok) return refused(r);
    const ended = r.run === undefined ? '' : `; its run ${r.run.runId} was ${r.run.outcome ?? 'ended'}`;
    return {
      ok: true,
      lines: [`${r.task.taskId} is now for ${who(r.task.assignee)}${ended}`],
      json: { task_id: r.task.taskId, changed: true, run_id: r.run?.runId ?? null, run_outcome: r.run?.outcome ?? null },
      nudge: true,
    };
  });
}

/** `mt kanban task link <parent> <child>`. */
function link(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [parentId, childId, extra] = positionals;
  if (parentId === undefined || childId === undefined || extra !== undefined) {
    throw new UsageError('kanban task link takes a parent task id and a child task id');
  }
  const board = boardFlag(values.board);
  return act(io, values.json === true, 'mt kanban task link', (service, by) => {
    const guard = offBoard(service, board, parentId, childId);
    if (guard !== undefined) return guard;
    const r = service.link(parentId, childId, by);
    if (!r.ok) return refused(r);
    const [p, c] = [line(parentId, 80), line(childId, 80)];
    return { ok: true, lines: [r.added ? `${c} now waits for ${p}` : `${c} already waits for ${p}`], json: { added: r.added } };
  });
}

/** `mt kanban task unblock <task> [comment]`, `stop <task>` and `archive <task>`: chat's, with the same outcomes. */
function decide(verb: 'unblock' | 'stop' | 'archive', rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [taskId, ...words] = positionals;
  if (taskId === undefined || (verb !== 'unblock' && words.length > 0)) {
    throw new UsageError(`kanban task ${verb} takes a task id${verb === 'unblock' ? ', and a comment if you like' : ''}`);
  }
  const comment = words.join(' ').trim();
  const board = boardFlag(values.board);
  return act(io, values.json === true, `mt kanban task ${verb}`, (service, by) => {
    const guard = offBoard(service, board, taskId);
    if (guard !== undefined) return guard;
    switch (verb) {
      case 'unblock': {
        const r = service.unblock(taskId, by, comment === '' ? undefined : comment);
        if (!r.ok) return refused(r);
        const t = r.task;
        return { ok: true, lines: [`${t.taskId} is unblocked, back to ${t.phase}`], json: { task_id: t.taskId, phase: t.phase }, nudge: true };
      }
      case 'stop': {
        const r = service.stop(taskId, by);
        if (!r.ok) return refused(r);
        const id = r.task.taskId;
        const said =
          r.run.outcome === 'cancelled'
            ? `stopped ${id}: its run was cancelled, and the task is blocked (needs_input); mt kanban task unblock ${id} runs it again`
            : `${id}'s run had already reported (${r.run.outcome ?? 'undecided'}); it closes when its agent's turn ends, and the task keeps that outcome`;
        return { ok: true, lines: [said], json: { task_id: id, run_id: r.run.runId, run_outcome: r.run.outcome }, nudge: true };
      }
      case 'archive': {
        const r = service.archive(taskId, by);
        if (!r.ok) return refused(r);
        return { ok: true, lines: [`archived ${r.task.taskId}`], json: { task_id: r.task.taskId }, nudge: true };
      }
    }
  });
}

/** `mt kanban task comment <task> <text>`: an operator's comment, which steers the task's agent (spec §7.5). */
function comment(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const [taskId, ...words] = positionals;
  const text = words.join(' ').trim();
  if (taskId === undefined || text === '') throw new UsageError('kanban task comment takes a task id and the comment');
  const board = boardFlag(values.board);
  if (Buffer.byteLength(text, 'utf8') > WORKER_LIMITS.comment) {
    return Promise.resolve(early(io, values.json === true, 'too_large', `A comment is at most ${WORKER_LIMITS.comment} bytes.`));
  }
  return act(io, values.json === true, 'mt kanban task comment', (service, by) => {
    const guard = offBoard(service, board, taskId);
    if (guard !== undefined) return guard;
    const r = service.comment(taskId, text, by, { steers: true });
    if (!r.ok) return refused(r);
    const id = r.comment.taskId;
    return {
      ok: true,
      lines: [`comment added to ${id}: an agent working on it gets it when its current turn ends; otherwise the next run reads it`],
      json: { task_id: id, comment_id: r.comment.id },
    };
  });
}

/**
 * `mt kanban task worktree <task> [--board <name>]`: a task's own directory
 * (spec §18), alone on its line, so a person can `cd "$(mt kanban task worktree k_…)"`
 * to resolve a merge there. Refused for a task in a shared directory.
 */
function worktree(rest: readonly string[], io: MtIo): Promise<number> {
  const { values, positionals } = parse(rest, BOARD_FLAGS);
  const taskId = oneTask(positionals, 'worktree');
  const board = boardFlag(values.board);
  return act(io, values.json === true, 'mt kanban task worktree', (service) => {
    const guard = offBoard(service, board, taskId);
    if (guard !== undefined) return guard;
    const r = service.show(taskId);
    if (!r.ok) return refused(r);
    const { task, workdir } = r.view;
    if (workdir === undefined) {
      const where = task.workspace === null ? 'has no workspace yet' : `works in the shared directory of workspace ${task.workspace}`;
      return refused({ code: 'no_worktree', message: `task ${taskId} ${where}, not a directory of its own` });
    }
    if (workdir.path === null) {
      return refused({ code: 'no_worktree', message: `task ${taskId}'s own directory is not made yet: ${whenMade(workdir)}` });
    }
    return {
      ok: true,
      lines: [line(workdir.path, 4096)],
      json: { task_id: taskId, workspace: task.workspace, path: workdir.path, branch: workdir.branch },
    };
  });
}

/** The verbs of `mt kanban task`: chat's task commands that a terminal has (spec §2.6), and `worktree`. */
export const TASK_COMMANDS: readonly string[] = ['new', 'list', 'show', 'assign', 'link', 'unblock', 'stop', 'archive', 'comment', 'worktree'];

/** `mt kanban task <verb> …`. */
function task(args: readonly string[], io: MtIo): Promise<number> {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'new':
      return create(rest, io);
    case 'list':
      return list(rest, io);
    case 'show':
      return show(rest, io);
    case 'assign':
      return assign(rest, io);
    case 'link':
      return link(rest, io);
    case 'unblock':
    case 'stop':
    case 'archive':
      return decide(verb, rest, io);
    case 'comment':
      return comment(rest, io);
    case 'worktree':
      return worktree(rest, io);
    default:
      throw new UsageError(`kanban task takes ${TASK_COMMANDS.slice(0, -1).join(', ')} or ${TASK_COMMANDS.at(-1)}`);
  }
}

/** `mt kanban task …` and `mt kanban board …`, outside a board run: the operator's. */
export async function operatorCommand(command: string, rest: readonly string[], io: MtIo): Promise<number> {
  if (command === 'board') return board(rest, io);
  if (command === 'task') return task(rest, io);
  throw new UsageError(`unknown command: kanban ${command}`);
}
