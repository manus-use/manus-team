import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { nameProblem } from './names.js';

/**
 * Checking the declared workspaces against the disk (spec §2.3).
 *
 * A workspace is a directory an unsupervised agent writes in, so it must never
 * hold the gateway's home -- every role's `.env`, the database -- and two names
 * must never share one checkout, or the one-run-per-workspace limit would count
 * the same directory twice. Every rule here is checked at startup, so a typo
 * fails the start instead of the first task.
 *
 * Returns an error rather than throwing, so it needs nothing from `config.ts`.
 */

export type WorkspacesResult = { workspaces: ReadonlyMap<string, string> } | { error: string };

export function resolveWorkspaces(
  declared: Readonly<Record<string, string>>,
  home: string,
  dbPath: string,
): WorkspacesResult {
  if (declared['default'] === undefined) {
    return { error: 'a workspace named default is required: chat sessions and the role default use it' };
  }
  const homeReal = realOrResolved(home);
  const dbReal = realOrResolved(dbPath);
  const out = new Map<string, string>();

  for (const name of Object.keys(declared).sort()) {
    const path = declared[name] ?? '';
    const problem = nameProblem('workspace', name);
    if (problem !== undefined) return { error: problem };
    if (!isAbsolute(path)) return { error: `workspace ${name}: ${JSON.stringify(path)} must be an absolute path` };
    if (!isDirectory(path)) return { error: `workspace ${name}: ${path} does not exist or is not a directory` };
    const real = realpathSync(path);

    if (within(homeReal, real)) {
      return { error: `workspace ${name}: ${real} contains the gateway's home ${homeReal}, which holds every role's secrets` };
    }
    if (within(dbReal, real)) {
      return { error: `workspace ${name}: ${real} contains the gateway's database ${dbReal}` };
    }
    const managed = join(homeReal, 'workspaces', name);
    if (within(real, homeReal) && real !== managed) {
      return { error: `workspace ${name}: inside the gateway's home, only ${managed} may be a workspace` };
    }
    for (const [other, otherReal] of out) {
      if (real === otherReal) {
        return { error: `workspaces ${other} and ${name} are the same directory (${real})` };
      }
      if (within(real, otherReal) || within(otherReal, real)) {
        return { error: `workspaces ${other} and ${name} are nested (${otherReal}, ${real}): a workspace may not contain another` };
      }
    }
    out.set(name, real);
  }
  return { workspaces: out };
}

/** True when `inner` is `outer` or lies inside it. */
function within(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The real path, even for a path that does not exist yet.
 *
 * On a fresh install the home and the database do not exist, so they cannot be
 * realpath'd directly -- but the workspace can, and comparing a resolved path
 * with a real one misses containment through any symlink (on macOS, `/tmp` is
 * `/private/tmp`). So the nearest existing ancestor is realpath'd and the rest
 * of the path appended to it.
 */
function realOrResolved(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}
