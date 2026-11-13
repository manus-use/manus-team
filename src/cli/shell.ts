import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

/**
 * Commands printed for a person to type, and the npm they name (spec §20.4,
 * §20.9): every path quoted as `install.sh` quotes one, and node and npm named
 * by their paths, never a bare `npm` or `mt`, which in another shell would be
 * another node's, or another home's or checkout's launcher.
 */

/** A word for sh, as install.sh's `quote` writes one: in single quotes, each `'` as `'\''`. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The npm beside `node`, else the first on `path`, as an absolute path; undefined when there is none. */
export function findNpm(node: string, path: string | undefined): string | undefined {
  const beside = join(dirname(node), 'npm');
  if (executable(beside)) return beside;
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    if (executable(join(dir, 'npm'))) return join(dir, 'npm');
  }
  return undefined;
}

/** `PATH='<node's directory>':"$PATH"`, put before a command so it, and what it starts, run that node. */
export function withNodeFirst(node: string): string {
  return `PATH=${shQuote(dirname(node))}:"$PATH"`;
}

/** `'<node>' '<checkout>/dist/mt.js'`, with the node's directory first on PATH: `mt` as every printed block names it. */
export function mtCommand(node: string, checkout: string): string {
  return `${withNodeFirst(node)} ${shQuote(node)} ${shQuote(join(checkout, 'dist', 'mt.js'))}`;
}

/** `'<npm>' <args>`, with the node's directory first on PATH. */
export function npmCommand(node: string, npm: string, args: string): string {
  return `${withNodeFirst(node)} ${shQuote(npm)} ${args}`;
}
