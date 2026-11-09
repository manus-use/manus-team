import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { MtIo } from './mt.js';

/**
 * The parts every `mt` command shares: reading its arguments, refusing, and
 * printing a table. Their own module, which imports nothing of `mt`'s at run
 * time, so the commands can use them without importing `mt.ts`, which imports
 * them.
 */

/** A wrong command line: said with the usage, exit 2. */
export class UsageError extends Error {}

/** Strict: an unknown option is a usage error, not something to guess at. */
export function parse<T extends NonNullable<ParseArgsConfig['options']>>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
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
