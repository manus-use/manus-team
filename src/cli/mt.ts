import { ConfigError, type Env } from '../config.js';
import { parse, refuse, UsageError } from './args.js';
import { gateAdd, gateList, gateRemove, inBoardRun } from './gate.js';
import { kanbanCommand } from './kanban.js';
import { operatorCommand } from './operator.js';
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
 * In a board run's shell, `mt kanban` is the worker CLI, which talks to the
 * gateway through its socket, with the authority of the run's token, from the
 * run's environment (spec §7.3).
 *
 * Elsewhere it is the operator's (spec §2.6): chat's `/kanban` commands, and `mt
 * kanban gate`, the exception to writing files only. They write the board's
 * database, through the board's own service, and after a change ask the gateway
 * for a dispatcher pass, a request that needs no token and does nothing else.
 */

export type Git = (args: readonly string[]) => Promise<{ code: number; stderr: string }>;

export interface MtIo {
  /** The shell's environment. The service's may differ, and output says so where it matters. */
  env: Env;
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
  '  mt kanban gate add <task_id> [--timeout <s>] -- <command...>',
  '  mt kanban gate list <task_id>',
  '  mt kanban gate remove <task_id> <gate_id>',
  "in a board run's shell, where the gateway sets MT_KANBAN_RUN, MT_KANBAN_TOKEN and MT_KANBAN_SOCKET:",
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

/** The worker CLI's commands that no operator's has: the worker's wherever they are typed. */
const WORKER_ONLY: readonly string[] = ['complete', 'review', 'changes', 'block', 'create'];
/** The operator's commands that the worker CLI has not got: the operator's wherever they are typed. */
const OPERATOR_ONLY: readonly string[] = ['gate', 'board'];

/**
 * Whose `mt kanban <command>` this is: the worker CLI's (spec §7.3) or the
 * operator's (spec §2.6). In a board run's shell, every name both have, and any
 * name neither has, is the worker's, so an agent always gets the worker's JSON
 * answer; the operator's commands refuse to run there. Elsewhere they are the
 * operator's, and the worker's own names say they work only inside a run.
 */
function isWorkers(command: string | undefined, io: MtIo): boolean {
  if (command !== undefined && WORKER_ONLY.includes(command)) return true;
  if (command !== undefined && OPERATOR_ONLY.includes(command)) return false;
  return inBoardRun(io.env);
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
      return roleList(io);
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
        }, io);
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
      return await workspaceAdd(name, path === undefined ? { cloneUrl: values.clone ?? '' } : { path }, io);
    }
    if (group === 'kanban' && isWorkers(command, io)) return await kanbanCommand(command, rest, io);
    if (group === 'kanban' && command === 'gate') return gate(rest, io);
    if (group === 'kanban') return await operatorCommand(command, rest, io);
    if (group === 'workspace' && command === 'list') {
      expectNothing(parse(rest, {}).positionals, 'workspace list');
      return workspaceList(io);
    }
    throw new UsageError(`unknown command: ${[group, command].filter((s) => s !== undefined).join(' ')}`);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`mt: ${err.message}`);
      io.err(USAGE);
      return 2;
    }
    if (err instanceof ConfigError) return refuse(io, err.message);
    throw err;
  }
}
