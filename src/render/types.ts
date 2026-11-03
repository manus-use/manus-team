import type { Role } from '../roles.js';

/**
 * Native rendering (plan R): a role delivered to its coding agent in the
 * agent's own format -- role.md as its system prompt, the skills through its
 * own skill loading -- instead of in the task prompt (spec §2.2, §7.1).
 *
 * A renderer is one coding agent's format. It decides which roles it takes, and
 * says, as files and launch arguments, what a role becomes; `./native.ts` reads
 * the role's files, writes the package and says where it is. Only bytesec has a
 * renderer; Claude Code's is a later one behind the same interface.
 */

/** One file of a rendered package: its path inside the package, `/`-separated, and its bytes. */
export interface PackageFile {
  path: string;
  bytes: Buffer;
}

/** A skill as rendering reads it: its name, and every regular file under its directory. */
export interface SkillFiles {
  name: string;
  /** Paths relative to the skill's directory. */
  files: readonly PackageFile[];
}

/** What a run is given to use a package: arguments after its agent's own, and environment. */
export interface Launch {
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

export interface Renderer {
  /** Its name in notes and in `mt role check`. */
  readonly id: string;
  /** Whether the role's agent is this renderer's. */
  handles(role: Role): boolean;
  /** Why a role it handles cannot be rendered, or undefined when it can. */
  refuses(role: Role): string | undefined;
  /** The package's files, from the role.md bytes the claim read and the skills as read now. */
  files(role: Role, roleMd: Buffer | undefined, skills: readonly SkillFiles[]): PackageFile[];
  /** How a run uses the package written at `dir`. */
  launch(role: Role, dir: string): Launch;
}
