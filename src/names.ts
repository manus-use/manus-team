import { KNOWN_DRIVERS } from './driver/registry.js';

/**
 * The grammar for role and workspace names.
 *
 * A name becomes a path (`roles/<name>/`, `workspaces/<name>/`), a value typed
 * in chat, and a key in the database, so it cannot contain `/`, `.` or `..`
 * (which would leave its directory), `:` (which would look like a person's
 * principal, `lark:…`), or upper case (two names differing only by case). It
 * may not end in `-`, so a role's name is also a valid bytesec package name
 * (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`), which native rendering needs.
 */
export const NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * bytesec's own rule for a skill's name, as bytesec 0.7.4 checks it: lowercase
 * letters, digits and single `-`, not at either end, at most 64 characters. A
 * skill a role imports by name (`agent.skills`) must follow it, and bytesec's
 * renderer refuses a role with one of its own that does not.
 */
export function isBytesecSkillName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) && !name.includes('--') && name.length <= 64;
}

/**
 * Board names the board commands read as words of their own: `none` clears a
 * board's setting, and `all` lists every board (spec §16.3).
 */
export const RESERVED_BOARD_NAMES: ReadonlySet<string> = new Set(['none', 'all']);

/** Why `name` is not a valid role, workspace or board name, or undefined if it is. */
export function nameProblem(kind: 'role' | 'workspace' | 'board', name: string): string | undefined {
  if (kind === 'board' && RESERVED_BOARD_NAMES.has(name)) {
    return `board name "${name}" is reserved: none clears a setting, and all lists every board`;
  }
  if (NAME_PATTERN.test(name)) return undefined;
  return (
    `${kind} name ${visible(JSON.stringify(name))} must be lowercase letters, digits and '-', ` +
    "start with a letter, not end with '-', and be at most 40 characters"
  );
}

/**
 * A name as a refusal quotes it, with every character that does not print --
 * controls, format characters such as a zero-width space, separators other than
 * a plain space -- written as `\uXXXX`, so a name that cannot be valid does not
 * look like one that is.
 */
export function visible(name: string): string {
  return name.replace(/[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu, (c) =>
    Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''),
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
