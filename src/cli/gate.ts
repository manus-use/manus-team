import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { loadTeamSettings, type Env } from '../config.js';
import { openDb } from '../db/open.js';
import { KanbanService } from '../kanban/service.js';
import type { GateRow } from '../kanban/types.js';
import { addSecrets, redactKnownSecrets } from '../secrets.js';
import { loadTeam, teamSecrets } from '../team.js';
import { refuse, table } from './args.js';
import type { MtIo } from './mt.js';

/**
 * `mt kanban gate add|list|remove` (spec §2.6, §7.7): an operator defining a
 * task's gates, from a shell, before the board is in chat.
 *
 * The one exception to "mt only writes files": these write the board's database,
 * as a second process beside a running gateway, and always through
 * `KanbanService`, the same calls chat's `/kanban gate` makes (plan D), so every
 * rule holds -- the limits, and the refusal of a command holding a known secret.
 * SQLite in WAL mode lets the two share the file: the gateway's reads never wait
 * on this, and a write that meets the gateway's waits and retries, as the
 * gateway's own writers do (`txImmediate`).
 *
 * The secrets checked are the ones this shell can know, registered as the
 * gateway registers them: every role's environment values, every value in the
 * gateway's .env, and the Lark app secret when `LARK_APP_SECRET` is set here or
 * there. A `passEnv` name unset in this shell
 * is said to be unchecked.
 *
 * **Not a security boundary.** They refuse a board run's environment
 * (`MT_KANBAN_RUN`, `MT_KANBAN_TOKEN`), so an agent does not define gates by
 * accident. An agent runs as the operator's user and could unset those, as it
 * could already edit config.yaml or a role's files.
 */

/** Who defined a gate from a shell: the operator, by their login. */
export function operatorName(io: MtIo): string {
  let login: string | undefined;
  try {
    login = userInfo().username;
  } catch {
    login = io.env['USER'];
  }
  return `operator:${login === undefined || login === '' ? 'unknown' : login}`;
}

/**
 * A board run's shell: the environment the gateway gives a run's agent (spec
 * §7.2). The operator's commands, `mt kanban task`, `board` and `gate`, refuse
 * to run in one.
 */
export function inBoardRun(env: Env): boolean {
  return env['MT_KANBAN_RUN'] !== undefined || env['MT_KANBAN_TOKEN'] !== undefined;
}

/** What an operator's command, `what`, says in a board run's shell. */
export function runShellRefusal(what: string): string {
  return (
    `${what} is an operator's command, not a board run's: this shell has MT_KANBAN_RUN or MT_KANBAN_TOKEN set. ` +
    'Run it from your own shell'
  );
}

/** How an operator's command says it refused, and its exit code: on stderr, or as JSON for `--json`. */
export type Refuse = (code: string, message: string) => number;

export interface BoardAccess {
  service: KanbanService;
  /** The gateway's home, where its socket is (spec §7.2). */
  home: string;
  /** `kanban.enabled` as the config sets it, undefined when it does not: the board runs only when it is true. */
  kanbanEnabled: boolean | undefined;
  close(): void;
}

export interface OpenOptions {
  /** How a refusal is said; on stderr, as `mt: …`, unless given. */
  refuse?: Refuse;
  /** What a `passEnv` name unset in this shell means for the command; a gate's refusal of a secret, unless given. */
  unsetNote?: string;
}

/** The board, as the gateway's own service over its database; or why not, already said. */
export function openBoard(io: MtIo, what: string, opts: OpenOptions = {}): BoardAccess | number {
  const no = opts.refuse ?? ((_code: string, message: string) => refuse(io, message));
  if (inBoardRun(io.env)) {
    return no('operator_command', runShellRefusal(what));
  }
  const unset: string[] = [];
  const settings = loadTeamSettings(io.env, undefined, { unsetPassEnv: unset });
  const team = loadTeam(settings, io.env, { unsetPassEnv: unset });
  const lark = io.env['LARK_APP_SECRET'];
  addSecrets([...(lark === undefined || lark === '' ? [] : [lark]), ...teamSecrets(team)]);
  if (unset.length > 0) {
    io.err(`mt: ${unset.join(', ')} not set in this shell, so ${opts.unsetNote ?? 'a gate holding those values cannot be refused here'}`);
  }
  if (!existsSync(settings.dbPath)) {
    return no('no_board', `there is no board at ${settings.dbPath}: the gateway creates its database when it first starts`);
  }
  let db: ReturnType<typeof openDb>;
  let migrated: unknown;
  try {
    db = openDb(settings.dbPath);
  } catch (err) {
    return no('failed', failed(err));
  }
  try {
    migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_gates'").get();
  } catch (err) {
    db.close();
    return no('failed', failed(err));
  }
  if (migrated === undefined) {
    db.close();
    return no('no_board', `the database at ${settings.dbPath} has no board yet: start the gateway once, so it is migrated`);
  }
  // As the gateway builds its own: a supervised role's approvals go to the chat that follows its task (spec §7.1).
  const service = new KanbanService({
    db,
    roles: team.roles,
    workspaces: new Set(team.workspaces.keys()),
    supervisedRoles: true,
    // As the gateway's dispatcher holds to them: so mt kanban task show can say what a
    // task is waiting on (spec §6.3, §16), and a board's own max_running is held inside the gateway's.
    ...(settings.kanban === undefined ? {} : { maxRunning: settings.kanban.maxRunning }),
    ...(settings.kanban?.maxRunningPerRole === undefined ? {} : { maxRunningPerRole: settings.kanban.maxRunningPerRole }),
  });
  return { service, home: settings.home, kanbanEnabled: settings.kanbanEnabled, close: () => db.close() };
}

/** A write the gateway held the lock through, every retry: not this command's fault. */
function busy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || (err instanceof Error && err.message.startsWith('write contention'));
}

/** Any other failure, said in a line and masked: a stack would print what the masker never saw. */
function failed(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `the board's database failed: ${redactKnownSecrets(message)}`;
}

/** `fn` on the board, which is closed after it; a failure of the database's is said, masked, as a refusal. */
export function withBoard(io: MtIo, what: string, fn: (b: BoardAccess) => number, opts: OpenOptions = {}): number {
  const no = opts.refuse ?? ((_code: string, message: string) => refuse(io, message));
  const board = openBoard(io, what, opts);
  if (typeof board === 'number') return board;
  try {
    return fn(board);
  } catch (err) {
    if (busy(err)) return no('busy', 'the board is busy: the gateway kept its database locked; try again');
    return no('failed', failed(err));
  } finally {
    board.close();
  }
}

/** Masked: a gate defined before a secret was known may hold it. */
function describe(g: GateRow): string {
  return `gate ${g.id}: ${redactKnownSecrets(g.command)} (up to ${g.timeoutS} s)`;
}

/** `mt kanban gate add <task_id> [--timeout <s>] -- <command…>`. */
export function gateAdd(taskId: string, command: string, timeoutS: number | undefined, io: MtIo): number {
  return withBoard(io, 'mt kanban gate add', ({ service }) => {
    const r = service.addGate(taskId, { command, ...(timeoutS === undefined ? {} : { timeoutS }) }, operatorName(io));
    if (!r.ok) return refuse(io, r.message);
    io.out(`added ${describe(r.gate)} to task ${taskId}`);
    return 0;
  });
}

/** `mt kanban gate list <task_id>`. */
export function gateList(taskId: string, io: MtIo): number {
  return withBoard(io, 'mt kanban gate list', ({ service }) => {
    const r = service.listGates(taskId);
    if (!r.ok) return refuse(io, r.message);
    if (r.gates.length === 0) {
      io.out(`task ${taskId} has no gates`);
      return 0;
    }
    const rows = r.gates.map((g) => [String(g.id), `${g.timeoutS} s`, g.createdBy, redactKnownSecrets(g.command)]);
    for (const line of table([['id', 'timeout', 'defined by', 'command'], ...rows])) io.out(line);
    return 0;
  });
}

/** `mt kanban gate remove <task_id> <gate_id>`. */
export function gateRemove(taskId: string, gateId: number, io: MtIo): number {
  return withBoard(io, 'mt kanban gate remove', ({ service }) => {
    const r = service.removeGate(taskId, gateId, operatorName(io));
    if (!r.ok) return refuse(io, r.message);
    io.out(`removed ${describe(r.gate)} from task ${taskId}`);
    return 0;
  });
}
