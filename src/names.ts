import { KNOWN_DRIVERS } from './driver/registry.js';

/**
 * The grammar for role and workspace names.
 *
 * A name becomes a path (`roles/<name>/`, `workspaces/<name>/`), a value typed
 * in chat, and a key in the database, so it cannot contain `/`, `.` or `..`
 * (which would leave its directory), `:` (which would look like a person's
 * principal, `lark:…`), or upper case (two names differing only by case).
 */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** Why `name` is not a valid role or workspace name, or undefined if it is. */
export function nameProblem(kind: 'role' | 'workspace', name: string): string | undefined {
  if (NAME_PATTERN.test(name)) return undefined;
  return (
    `${kind} name ${JSON.stringify(name)} must be lowercase letters, digits and '-', ` +
    'start with a letter, and be at most 40 characters'
  );
}

/**
 * Driver ids cannot be role names. Sessions created before roles existed store
 * a driver id where a role name now goes, and read it as the role `default`; a
 * role called `acp` would make those rows ambiguous.
 */
export function isReservedRoleName(name: string): boolean {
  return (KNOWN_DRIVERS as readonly string[]).includes(name);
}
