import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ConfigError, type Env } from '../config.js';
import { roleCheck, roleCreate, roleList } from './role.js';

/**
 * `mt`: commands that create and check roles and workspaces (spec §2.6).
 *
 * They only write files. They do not talk to the gateway and take no authority
 * from it, so they give an agent -- which runs as the same user and could edit the
 * same files by hand -- nothing it did not already have. A change takes effect at
 * the gateway's next start.
 */

export type Git = (args: readonly string[]) => Promise<{ code: number; stderr: string }>;

export interface MtIo {
  /** The shell's environment. The service's may differ, and output says so where it matters. */
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Runs git; injectable so a failed clone can be tested. */
  git?: Git;
}

export const USAGE = [
  'usage:',
  '  mt role create <name> [--clone-from <role>] [--description "..."]',
  '  mt role list',
  '  mt role check [<name>]',
  '  mt workspace add <name> <absolute-path>',
  '  mt workspace add <name> --clone <git-url>',
  '  mt workspace list',
].join('\n');

export class UsageError extends Error {}

/** Strict: an unknown option is a usage error, not something to guess at. */
export function parse<T extends NonNullable<ParseArgsConfig['options']>>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function expectNothing(positionals: readonly string[], what: string): void {
  if (positionals.length > 0) throw new UsageError(`${what} takes no arguments`);
}

/** Prints a refusal and returns its exit code. */
export function refuse(io: MtIo, message: string): number {
  io.err(`mt: ${message}`);
  return 1;
}

/** Rows as aligned columns, for the list commands. */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
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
    // (later tasks add each command here)
    if (group === 'role' && command === 'list') {
      expectNothing(parse(rest, {}).positionals, 'role list');
      return roleList(io);
    }
    if (group === 'role' && command === 'create') {
      const { values, positionals } = parse(rest, {
        'clone-from': { type: 'string' },
        description: { type: 'string' },
      });
      const [name, extra] = positionals;
      if (name === undefined || extra !== undefined) throw new UsageError('role create takes one name');
      return roleCreate(name, { cloneFrom: values['clone-from'], description: values.description }, io);
    }
    if (group === 'role' && command === 'check') {
      const [name, extra] = parse(rest, {}).positionals;
      if (extra !== undefined) throw new UsageError('role check takes at most one name');
      return roleCheck(name, io);
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
