import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { loadTeamSettings, type Env, type TeamSettings } from '../config.js';
import { openDb } from '../db/open.js';
import { peopleOf } from '../db/people.js';
import { PeopleDirectory } from '../kanban/people.js';
import { KanbanService } from '../kanban/service.js';
import type { GateRow } from '../kanban/types.js';
import { addSecrets, redactKnownSecrets } from '../secrets.js';
import { loadTeam, teamSecrets, type Team } from '../team.js';
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
 * **Not a security boundary.** They refuse an agent's environment (`inAgentRun`),
 * so an agent does not define gates by accident. An agent runs as the operator's
 * user and could unset those, as it could already edit config.yaml or a role's files.
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
 * An agent's shell: a board run's (spec §7.2), a chat turn's or a cron fire's
 * (the cron spec, §6.4, §7), known by the token in its environment. Every
 * operator's command refuses to run in one, and none reads the gateway's .env
 * there, so no agent acts as the operator by accident, or is handed the file's
 * secrets.
 */
export function inAgentRun(env: Env): boolean {
  return AGENT_VARIABLES.some((name) => env[name] !== undefined);
}

/**
 * A board run's shell alone: where `mt kanban <command>` is the worker CLI's,
 * sent to the socket, and where a run starts a workflow (spec §7.3, workflows spec §6). A
 * chat turn's or a fire's shell has no run to report for.
 */
export function hasBoardRun(env: Env): boolean {
  return env['MT_KANBAN_RUN'] !== undefined || env['MT_KANBAN_TOKEN'] !== undefined;
}

/**
 * The variables an agent's shell is known by, in the order a refusal names the
 * first it finds: a board run's (spec §7.2), then a chat turn's and a cron
 * fire's (the cron spec, §6.4, §7).
 */
export const AGENT_VARIABLES = ['MT_KANBAN_RUN', 'MT_KANBAN_TOKEN', 'MT_CRON_TOKEN', 'MT_CRON_FIRE'] as const;

/** What an operator's command, `what`, says in an agent's shell, naming the first of its variables `env` has set. */
export function runShellRefusal(what: string, env: Env): string {
  const found = AGENT_VARIABLES.find((name) => env[name] !== undefined) ?? AGENT_VARIABLES[0];
  return `${what} is an operator's command, not an agent's; this shell has ${found} set. Run it from your own shell`;
}

/** How an operator's command says it refused, and its exit code: on stderr, or as JSON for `--json`. */
export type Refuse = (code: string, message: string) => number;

/**
 * What this shell's settings lack for the terminal to check a person's talk
 * tier (kanban spec §22.2): the bot's app id, by which `people` keeps who it has
 * seen, or an owner, without which there is no talk allowlist.
 */
export type PeopleMissing = 'appId' | 'owner';

export interface BoardAccess {
  service: KanbanService;
  /** The gateway's home, where its socket is (spec §7.2). */
  home: string;
  /** `kanban.enabled` as the config sets it, undefined when it does not: the board runs only when it is true. */
  kanbanEnabled: boolean | undefined;
  /** Why the service has no people, so a person cannot be checked here; undefined when it has them. */
  peopleMissing: PeopleMissing | undefined;
  /**
   * The people this bot has seen, each with talk tier by this shell's allowlist,
   * none with an owner missing: `mt kanban people`'s (kanban spec §22.2).
   * Undefined with no app id, as there is no bot to list them for.
   */
  seen(): SeenPerson[] | undefined;
  close(): void;
}

/** A person as `mt kanban people` lists them. */
export interface SeenPerson {
  unionId: string;
  name: string | null;
  talk: boolean;
}

/** What `assignable` says of a person when the service has no talk check: right for a board not in Lark, wrong beside a gateway that is. */
const NO_PEOPLE = 'cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark';

/** What the terminal says in its place, naming the setting this shell lacks. */
const MISSING: Readonly<Record<PeopleMissing, string>> = {
  appId: 'cannot be checked for talk tier here: this shell finds no lark.appId or LARK_APP_ID, which the people this bot has seen are kept by',
  owner: 'cannot be checked for talk tier here: this shell finds no auth.owner or MT_OWNER_OPEN_ID, without which there is no talk allowlist to check against',
};

/** How a terminal finds a person's id, added to chat's words for a person it refused (kanban spec §22.2). */
export const PEOPLE_HINT = 'mt kanban people lists the people this gateway knows, with their union_ids and whether they have talk tier';

/**
 * A refusal's message as the terminal says it: for a person the service could
 * not check, the setting this shell lacks; for one it refused, chat's words and
 * how to find a person's id. Any other refusal as it is.
 */
export function personHint(r: { code: string; message: string }, missing: PeopleMissing | undefined): string {
  if (r.code !== 'person_not_assignable') return r.message;
  if (missing !== undefined && r.message.includes(NO_PEOPLE)) return r.message.replace(NO_PEOPLE, MISSING[missing]);
  return `${r.message}; ${PEOPLE_HINT}`;
}

export interface OpenOptions {
  /** How a refusal is said; on stderr, as `mt: …`, unless given. */
  refuse?: Refuse;
  /** What a `passEnv` name unset in this shell means for the command; a gate's refusal of a secret, unless given. */
  unsetNote?: string;
  /** The workflow commands need the workflows' tables too (workflows spec §7): a database not migrated to them is refused. */
  workflows?: boolean;
}

/**
 * The gateway's settings and team, loaded as the gateway loads them, with the
 * secrets it would register, and the passEnv names this shell leaves unset said
 * on stderr; or why not, already said. What `openBoard` does before it opens the
 * database, and all the terminal's workflow preview does, which opens none (workflows spec §6).
 */
export function loadOperator(io: MtIo, what: string, opts: OpenOptions = {}): { settings: TeamSettings; team: Team } | number {
  const no = opts.refuse ?? ((_code: string, message: string) => refuse(io, message));
  if (inAgentRun(io.env)) {
    return no('operator_command', runShellRefusal(what, io.env));
  }
  const unset: string[] = [];
  const settings = loadTeamSettings(io.env, undefined, { unsetPassEnv: unset });
  const team = loadTeam(settings, io.env, { unsetPassEnv: unset });
  const lark = io.env['LARK_APP_SECRET'];
  addSecrets([...(lark === undefined || lark === '' ? [] : [lark]), ...teamSecrets(team)]);
  if (unset.length > 0) {
    io.err(`mt: ${unset.join(', ')} not set in this shell, so ${opts.unsetNote ?? 'a gate holding those values cannot be refused here'}`);
  }
  return { settings, team };
}

/** The board, as the gateway's own service over its database; or why not, already said. */
export function openBoard(io: MtIo, what: string, opts: OpenOptions = {}): BoardAccess | number {
  const no = opts.refuse ?? ((_code: string, message: string) => refuse(io, message));
  const loaded = loadOperator(io, what, opts);
  if (typeof loaded === 'number') return loaded;
  const { settings, team } = loaded;
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
  // The table the command needs: the board's, or for the workflow commands the workflows' (workflows spec §7).
  const table = opts.workflows === true ? 'kanban_workflow_instances' : 'kanban_gates';
  try {
    migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  } catch (err) {
    db.close();
    return no('failed', failed(err));
  }
  if (migrated === undefined) {
    db.close();
    const has = opts.workflows === true ? 'no workflows yet' : 'no board yet';
    return no('no_board', `the database at ${settings.dbPath} has ${has}: start the gateway once, so it is migrated`);
  }
  // Chat's own check of a person, against the same table (kanban spec §22.2): the people this bot has
  // seen, and the talk allowlist this shell's settings give, as the gateway's authorizer holds it.
  const { appId, talk } = settings;
  const peopleMissing: PeopleMissing | undefined = appId === undefined ? 'appId' : talk === undefined ? 'owner' : undefined;
  const people =
    appId === undefined || talk === undefined ? undefined : new PeopleDirectory({ db, appId, canTalk: (openId) => talk.includes(openId) });
  // As the gateway builds its own: a supervised role's approvals go to the chat that follows its task (spec §7.1).
  const service = new KanbanService({
    db,
    roles: team.roles,
    workspaces: new Set(team.workspaces.keys()),
    // As the gateway's: so show says where a task in one will work, and what it waits on (spec §18).
    isolated: new Set(Object.keys(settings.isolated ?? {})),
    supervisedRoles: true,
    // As the gateway's dispatcher holds to them: so mt kanban task show can say what a
    // task is waiting on (spec §6.3, §16), and a board's own max_running is held inside the gateway's.
    ...(settings.kanban === undefined ? {} : { maxRunning: settings.kanban.maxRunning }),
    ...(settings.kanban?.maxRunningPerRole === undefined ? {} : { maxRunningPerRole: settings.kanban.maxRunningPerRole }),
    // As the gateway's: the operator's files, read at each preview and start (workflows spec §1).
    workflowsDir: join(settings.home, 'workflows'),
    ...(people === undefined ? {} : { people }),
  });
  const seen = (): SeenPerson[] | undefined =>
    appId === undefined
      ? undefined
      : peopleOf(db, appId).map((p) => ({ unionId: p.unionId, name: p.name, talk: talk?.includes(p.openId) === true }));
  return { service, home: settings.home, kanbanEnabled: settings.kanbanEnabled, peopleMissing, seen, close: () => db.close() };
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
