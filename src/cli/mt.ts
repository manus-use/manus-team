import { ConfigError, type Env } from '../config.js';
import { loadGatewayEnv, type GatewayEnvFile } from '../gateway-env.js';
import { redactKnownSecrets } from '../secrets.js';
import { parse, refuse, UsageError } from './args.js';
import { jsonLine } from './operator.js';
import { LIST_FILTERS } from '../kanban/chat-parse.js';
import { gateAdd, gateList, gateRemove, inBoardRun, runShellRefusal } from './gate.js';
import { WORKER_COMMANDS } from '../kanban/worker.js';
import { kanbanCommand, NOT_IN_A_RUN } from './kanban.js';
import { operatorCommand, TASK_COMMANDS } from './operator.js';
import { roleCheck, roleCreate, roleList } from './role.js';
import { workspaceAdd, workspaceList } from './workspace.js';

/**
 * `mt`: commands that create and check roles and workspaces (spec §2.6), and the
 * worker CLI a board run reports through (spec §7.3).
 *
 * The role and workspace commands only write files. They do not talk to the
 * gateway and take no authority from it, so they give an agent -- which runs as
 * the same user and could edit the same files by hand -- nothing it did not
 * already have. A change takes effect at the gateway's next start.
 *
 * `mt kanban <command>`, a name of its own, is the worker CLI a board run
 * reports through, which talks to the gateway through its socket, with the
 * authority of the run's token, from the run's environment (spec §7.3).
 *
 * `mt kanban task`, `board` and `gate` are the operator's (spec §2.6): chat's
 * `/kanban` commands, the exception to writing files only. They write the
 * board's database, through the board's own service, and after a change ask the
 * gateway for a dispatcher pass, a request that needs no token and does nothing
 * else. They refuse to run in a board run's shell.
 */

export type Git = (args: readonly string[]) => Promise<{ code: number; stderr: string }>;

export interface MtIo {
  /**
   * The shell's environment. The service's may differ, and output says so where it matters.
   * For a command that loads the gateway's settings, this shell's over the gateway's .env.
   */
  env: Env;
  /** The shell's own environment, without the gateway's .env: what a process mt starts is given. Set with gatewayEnv. */
  shellEnv?: Env;
  /** The gateway's .env, for a command that loads the gateway's settings (`withGatewayFile`). */
  gatewayEnv?: GatewayEnvFile;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Runs git; injectable so a failed clone can be tested. */
  git?: Git;
  /** All of stdin, or undefined once it passes `maxBytes`: `mt kanban`'s input. */
  stdin?: (maxBytes: number) => Promise<string | undefined>;
  /** Stdin is a terminal: `mt kanban` refuses rather than wait on one for input that never comes. */
  stdinIsTTY?: boolean;
  /** An agent command's version, from `<command> --version`; injectable so `mt role check` is tested without one. */
  agentVersion?: (command: string) => string | undefined;
}

const USAGE = [
  'usage:',
  '  mt role create <name> [--clone-from <role>] [--description "..."] [--own-workspace]',
  '  mt role list',
  '  mt role check [<name>]',
  '  mt workspace add <name> <absolute-path>',
  '  mt workspace add <name> --clone <git-url>',
  '  mt workspace list',
  '  mt kanban board list [all] [--json]',
  '  mt kanban board create <name> [--json]',
  '  mt kanban board set <name> max_running <number|none> [--json]',
  '  mt kanban board set <name> workspace <workspace|none> [--json]',
  '  mt kanban board archive <name> [--json]',
  '  mt kanban task new <title> [--board <name>] [--assignee <role>] [--reviewer <role>] [--workspace <name>]',
  '      [--parent <task>]... [--outcome "..."] [--verify "..."] [--constraints "..."] [--boundaries "..."]',
  '      [--stop-when "..."] [--body "..." | --body-file <path|->] [--json]',
  `  mt kanban task list [${LIST_FILTERS.join('|')}] [--board <name>] [--json]`,
  '  mt kanban task show <task_id> [--board <name>] [--json]',
  '  mt kanban task assign <task_id> <role> [--board <name>] [--json]',
  '  mt kanban task link <parent_id> <child_id> [--board <name>] [--json]',
  '  mt kanban task unblock <task_id> [comment...] [--board <name>] [--json]',
  '  mt kanban task stop <task_id> [--board <name>] [--json]',
  '  mt kanban task archive <task_id> [--board <name>] [--json]',
  '  mt kanban task comment <task_id> <text...> [--board <name>] [--json]',
  '  mt kanban gate add <task_id> [--timeout <s>] -- <command...>',
  '  mt kanban gate list <task_id>',
  '  mt kanban gate remove <task_id> <gate_id>',
  "the worker's commands, which work only in a board run's shell, where the gateway sets MT_KANBAN_RUN, MT_KANBAN_TOKEN and MT_KANBAN_SOCKET:",
  '  mt kanban <show|complete|review|changes|block|comment|create|link> < input.json',
].join('\n');

function expectNothing(positionals: readonly string[], what: string): void {
  if (positionals.length > 0) throw new UsageError(`${what} takes no arguments`);
}

/** `mt kanban gate …`: the operator's gate commands. A command's words are joined with spaces, as ssh joins them. */
function gate(argv: readonly string[], io: MtIo): number {
  const [sub, ...args] = argv;
  if (sub === 'add') {
    const { values, positionals } = parse(args, { timeout: { type: 'string' } });
    const [taskId, ...words] = positionals;
    if (taskId === undefined || words.length === 0) {
      throw new UsageError('kanban gate add takes a task id, then -- and the command');
    }
    const timeout = values.timeout;
    if (timeout !== undefined && !/^[0-9]+$/.test(timeout)) throw new UsageError('--timeout is a whole number of seconds');
    return gateAdd(taskId, words.join(' '), timeout === undefined ? undefined : Number(timeout), io);
  }
  if (sub === 'list') {
    const [taskId, extra] = parse(args, {}).positionals;
    if (taskId === undefined || extra !== undefined) throw new UsageError('kanban gate list takes a task id');
    return gateList(taskId, io);
  }
  if (sub === 'remove') {
    const [taskId, gateId, extra] = parse(args, {}).positionals;
    if (taskId === undefined || gateId === undefined || extra !== undefined || !/^[0-9]+$/.test(gateId)) {
      throw new UsageError('kanban gate remove takes a task id and a gate id');
    }
    return gateRemove(taskId, Number(gateId), io);
  }
  throw new UsageError('kanban gate takes add, list or remove');
}

/**
 * The operator's groups (spec §2.6), which refuse to run in a board run's shell.
 * Every other `mt kanban <command>` is the worker CLI's (spec §7.3).
 */
const OPERATOR_GROUPS: readonly string[] = ['task', 'board', 'gate'];

/** The subcommands whose name a run's refusal gives: `mt kanban board set`, not just `mt kanban board`. */
const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  task: TASK_COMMANDS,
  board: ['list', 'create', 'set', 'archive', 'use'],
  gate: ['add', 'list', 'remove'],
};

/**
 * The operator's command refused in a board run's shell, before its command
 * line is parsed or its stdin read: an agent gets the refusal, whatever it
 * typed, and nothing waits on its input. In JSON when `--json` is among the
 * words, as the command itself would answer.
 */
function refuseInRun(command: string | undefined, rest: readonly string[], io: MtIo): number {
  const sub = rest[0];
  const named = command !== undefined && sub !== undefined && SUBCOMMANDS[command]?.includes(sub) === true;
  const what = ['mt kanban', ...(command === undefined ? [] : [command]), ...(named ? [sub] : [])].join(' ');
  const message = runShellRefusal(what);
  if (command !== 'gate' && rest.includes('--json')) io.out(jsonLine({ ok: false, code: 'operator_command', message }));
  else refuse(io, message);
  return 1;
}

/**
 * Whose `mt kanban <command>` this is. `task`, `board` and `gate` are the
 * operator's, refused in a board run's shell. A worker's name is the worker
 * CLI's in any shell, so an agent's `show`, `comment` and `link` are always the
 * worker's; outside a run it says it needs one, before looking at its
 * arguments, and for those three that the operator's is under `task`. Any other
 * name is answered in the worker's JSON in a run's shell, which an agent acts
 * on, and with the usage elsewhere, which names `mt kanban task <name>` when
 * the name is a task verb: a hint, never an alias.
 */
async function kanban(command: string | undefined, rest: readonly string[], io: MtIo): Promise<number> {
  if (command !== undefined && OPERATOR_GROUPS.includes(command)) {
    if (inBoardRun(io.env)) return refuseInRun(command, rest, io);
    const operator = withGatewayFile(io);
    return command === 'gate' ? gate(rest, operator) : await operatorCommand(command, rest, operator);
  }
  const workers = command !== undefined && (WORKER_COMMANDS as readonly string[]).includes(command);
  if (inBoardRun(io.env)) return await kanbanCommand(command, rest, io);
  // An operator's task command's name is the operator's hint: `mt kanban show k_1` needs `task`.
  const operators = command !== undefined && TASK_COMMANDS.includes(command);
  if (workers) {
    const hint = operators ? `; the operator's is mt kanban task ${command}` : '';
    io.out(JSON.stringify({ ok: false, code: 'not_in_a_run', message: `${NOT_IN_A_RUN}${hint}` }));
    return 1;
  }
  const hint = operators ? `; the operator's command is mt kanban task ${command}` : '';
  throw new UsageError(`unknown command: kanban${command === undefined ? '' : ` ${command}`}${hint}`);
}

/**
 * `io` for a command that loads the gateway's settings: its environment this
 * shell's over the gateway's .env, as the gateway's is over the file, so the
 * command sees what the gateway sees. The file's secrets are masked from here
 * on. A refused file is a ConfigError, as it stops the gateway. Never in a
 * board run's shell: that is an agent's, and gets nothing of the file, so
 * there the command sees that shell alone.
 */
export function withGatewayFile(io: MtIo): MtIo {
  if (inBoardRun(io.env)) return io;
  const loaded = loadGatewayEnv(io.env);
  return { ...io, env: loaded.env, shellEnv: io.env, gatewayEnv: loaded.file };
}

/** Exit codes: 0 done, 1 refused or a check failed, 2 the command line was wrong. */
export async function runMt(argv: readonly string[], io: MtIo): Promise<number> {
  const [group, command] = argv;
  const rest = argv.slice(2);
  try {
    if (group === undefined) {
      io.out(USAGE);
      return 2;
    }
    if (group === 'help' || group === '--help' || group === '-h') {
      io.out(USAGE);
      return 0;
    }
    if (group === 'role' && command === 'list') {
      expectNothing(parse(rest, {}).positionals, 'role list');
      return roleList(withGatewayFile(io));
    }
    if (group === 'role' && command === 'create') {
      const { values, positionals } = parse(rest, {
        'clone-from': { type: 'string' },
        description: { type: 'string' },
        'own-workspace': { type: 'boolean' },
      });
      const [name, extra] = positionals;
      if (name === undefined || extra !== undefined) throw new UsageError('role create takes one name');
      return roleCreate(name, {
          cloneFrom: values['clone-from'],
          description: values.description,
          ownWorkspace: values['own-workspace'],
        }, withGatewayFile(io));
    }
    if (group === 'role' && command === 'check') {
      const [name, extra] = parse(rest, {}).positionals;
      if (extra !== undefined) throw new UsageError('role check takes at most one name');
      return roleCheck(name, io);
    }
    if (group === 'workspace' && command === 'add') {
      const { values, positionals } = parse(rest, { clone: { type: 'string' } });
      const [name, path, extra] = positionals;
      if (name === undefined || extra !== undefined || (path === undefined) === (values.clone === undefined)) {
        throw new UsageError('workspace add takes a name and either an absolute path or --clone <git-url>');
      }
      // `await`, so a ConfigError from the async command is caught below and
      // reported as `mt: …` rather than escaping as a stack trace.
      return await workspaceAdd(name, path === undefined ? { cloneUrl: values.clone ?? '' } : { path }, withGatewayFile(io));
    }
    if (group === 'kanban') return await kanban(command, rest, io);
    if (group === 'workspace' && command === 'list') {
      expectNothing(parse(rest, {}).positionals, 'workspace list');
      return workspaceList(withGatewayFile(io));
    }
    throw new UsageError(`unknown command: ${[group, command].filter((s) => s !== undefined).join(' ')}`);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`mt: ${redactKnownSecrets(err.message)}`);
      io.err(USAGE);
      return 2;
    }
    if (err instanceof ConfigError) return refuse(io, err.message);
    throw err;
  }
}
