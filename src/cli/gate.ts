import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { loadTeamSettings } from '../config.js';
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
 * gateway registers them: every role's environment values, and the Lark app
 * secret when `LARK_APP_SECRET` is set here. A `passEnv` name unset in this shell
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

interface Board {
  service: KanbanService;
  close(): void;
}

/** The board, as the gateway's own service over its database; or why not, already said. */
function openBoard(io: MtIo, what: string): Board | number {
  if (io.env['MT_KANBAN_RUN'] !== undefined || io.env['MT_KANBAN_TOKEN'] !== undefined) {
    return refuse(
      io,
      `${what} is an operator's command, not a board run's: this shell has MT_KANBAN_RUN or MT_KANBAN_TOKEN set. ` +
        'Run it from your own shell',
    );
  }
  const unset: string[] = [];
  const settings = loadTeamSettings(io.env, undefined, { unsetPassEnv: unset });
  const team = loadTeam(settings, io.env, { unsetPassEnv: unset });
  const lark = io.env['LARK_APP_SECRET'];
  addSecrets([...(lark === undefined || lark === '' ? [] : [lark]), ...teamSecrets(team)]);
  if (unset.length > 0) {
    io.err(`mt: ${unset.join(', ')} not set in this shell, so a gate holding those values cannot be refused here`);
  }
  if (!existsSync(settings.dbPath)) {
    return refuse(io, `there is no board at ${settings.dbPath}: the gateway creates its database when it first starts`);
  }
  let db: ReturnType<typeof openDb>;
  let migrated: unknown;
  try {
    db = openDb(settings.dbPath);
  } catch (err) {
    return refuse(io, failed(err));
  }
  try {
    migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kanban_gates'").get();
  } catch (err) {
    db.close();
    return refuse(io, failed(err));
  }
  if (migrated === undefined) {
    db.close();
    return refuse(io, `the database at ${settings.dbPath} has no board yet: start the gateway once, so it is migrated`);
  }
  const service = new KanbanService({ db, roles: team.roles, workspaces: new Set(team.workspaces.keys()) });
  return { service, close: () => db.close() };
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

function withBoard(io: MtIo, what: string, fn: (b: Board) => number): number {
  const board = openBoard(io, what);
  if (typeof board === 'number') return board;
  try {
    return fn(board);
  } catch (err) {
    if (busy(err)) return refuse(io, 'the board is busy: the gateway kept its database locked; try again');
    return refuse(io, failed(err));
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
