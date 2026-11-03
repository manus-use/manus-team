import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type AgentConfig,
  ConfigError,
  type Env,
  type LoadOptions,
  agentArgs,
  bool,
  checkCommand,
  driverOf,
  passEnvValues,
  reject,
  requireSupervisionMatch,
  section,
  str,
  strings,
  subsection,
  withUnsetRecorded,
} from './config.js';
import type { KnownDriver } from './driver/registry.js';
import { parseEnvFile } from './dotenv.js';
import { isBytesecSkillName, isReservedRoleName, nameProblem } from './names.js';

/**
 * Roles: who does a kind of work, and how it is run (spec §2.1–§2.2, §2.5).
 *
 * A role is a directory under `$MT_HOME/roles/`: `config.yaml` naming its coding
 * agent, an optional `role.md` of standing instructions, optional `skills/`, and
 * an optional `.env` for its own secrets. Everything wrong with one is found
 * here, at startup.
 */

export interface Skill {
  name: string;
  description: string;
  /** The skill's directory, `skills/<name>/`: its SKILL.md and anything beside it. */
  dir: string;
  /** Its SKILL.md. */
  path: string;
}

export interface Role {
  name: string;
  /** A role directory, or the gateway's `agent:` block standing in for `default`. */
  source: 'directory' | 'agent-block';
  dir: string | undefined;
  description: string | undefined;
  /** A workspace name the role always works in, or undefined (spec §2.3). */
  workspace: string | undefined;
  agent: AgentConfig;
  /** The path of `role.md` if the role has one; its contents are read at each claim. */
  roleMdPath: string | undefined;
  /** Its own `skills/`, then those it imports by name from the user's (`agent.skills`), in that order. */
  skills: readonly Skill[];
  /** Every value this role's agent is given from a secret source, except names in maskExempt, for masking (spec §10.1). */
  secretValues: readonly string[];
}

/** Drivers that can enforce a role's tool policy. None yet (spec §2.2). */
const TOOL_POLICY_DRIVERS: readonly KnownDriver[] = [];

const HINTS = {
  secret: "Put it in the role's .env instead.",
  env: "Put the values in the role's .env, or name them in agent.passEnv.",
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface Discovered {
  names: string[];
  notes: string[];
}

/**
 * The role directories under `rolesDir`.
 *
 * Dot-entries are ignored, so the directory can be under version control.
 * Anything else that is not a valid role -- a file, a badly named directory --
 * is reported once and ignored. A directory named like a driver is an error.
 *
 * Symlinks are not followed: a symlinked role directory is reported as not a
 * directory, and a symlinked `role.md` or `.env` is refused. That is stricter
 * than the spec requires, deliberately -- a role is meant to be self-contained,
 * and a link is how it quietly stops being.
 */
export function discoverRoles(rolesDir: string): Discovered {
  let entries;
  try {
    entries = readdirSync(rolesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { names: [], notes: [] };
    throw new ConfigError(`cannot read ${rolesDir}: ${(err as Error).message}`);
  }

  const names: string[] = [];
  const notes: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const where = join(rolesDir, entry.name);
    if (!entry.isDirectory()) {
      notes.push(`ignoring ${where}: not a directory, so not a role`);
      continue;
    }
    if (isReservedRoleName(entry.name)) {
      throw new ConfigError(`${where}: role name ${JSON.stringify(entry.name)} is reserved: it is a driver id`);
    }
    const problem = nameProblem('role', entry.name);
    if (problem !== undefined) {
      notes.push(`ignoring ${where}: ${problem}`);
      continue;
    }
    names.push(entry.name);
  }
  return { names, notes };
}

// ---------------------------------------------------------------------------
// One role
// ---------------------------------------------------------------------------

export function loadRoleDir(
  name: string,
  dir: string,
  env: Env,
  workspaceNames: ReadonlySet<string>,
  opts: LoadOptions = {},
): { role: Role; notes: string[] } {
  const configPath = join(dir, 'config.yaml');
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new ConfigError(`role ${name}: cannot read ${configPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${configPath} is not valid YAML: ${(err as Error).message}`);
  }
  const root = section(configPath, '', parsed ?? {});
  const agentRaw = subsection(configPath, root, 'agent');
  reject(configPath, '', root, ['description', 'workspace', 'tools', 'agent'], HINTS);
  reject(
    configPath,
    'agent',
    agentRaw,
    ['driver', 'command', 'args', 'unsupervised', 'passEnv', 'readOnlyTools', 'maskExempt', 'native', 'skills'],
    HINTS,
  );
  if (root['agent'] === undefined || root['agent'] === null) {
    throw new ConfigError(`${configPath}: agent is required`);
  }

  const workspace = str(configPath, 'workspace', root['workspace']);
  if (workspace !== undefined && !workspaceNames.has(workspace)) {
    throw new ConfigError(
      `${configPath}: workspace ${JSON.stringify(workspace)} is not configured (known: ${[...workspaceNames].join(', ')})`,
    );
  }

  const driver = driverOf(str(configPath, 'agent.driver', agentRaw['driver']) ?? 'acp');
  if (root['tools'] !== undefined && root['tools'] !== null && !TOOL_POLICY_DRIVERS.includes(driver)) {
    // Silently accepting it would leave a role believed to be restricted that is not.
    throw new ConfigError(
      `${configPath}: role ${name} declares a tools policy, but its agent's driver (${driver}) ` +
        'cannot enforce one. Remove tools, or use an agent that can enforce it.',
    );
  }
  const command = str(configPath, 'agent.command', agentRaw['command']);
  if (command === undefined) throw new ConfigError(`${configPath}: agent.command is required`);
  checkCommand(command);
  const args = agentArgs(configPath, agentRaw['args']);
  const unsupervised = bool(configPath, 'agent.unsupervised', agentRaw['unsupervised']) ?? false;
  requireSupervisionMatch(driver, unsupervised);

  const passEnv = strings(configPath, 'agent.passEnv', agentRaw['passEnv']);
  // The MT_/LARK_ refusal still applies to every name: passEnvValues checks it first.
  const lookup = opts.unsetPassEnv === undefined ? env : withUnsetRecorded(name, env, passEnv, opts.unsetPassEnv);
  const fromGateway = passEnvValues(lookup, passEnv, `${configPath}: agent.passEnv`);
  const fromFile = readRoleEnv(dir);
  for (const key of Object.keys(fromFile)) {
    if (passEnv.includes(key)) {
      throw new ConfigError(`role ${name}: ${key} is set in .env and named in agent.passEnv; keep one`);
    }
  }

  const { skills: own, notes } = readSkills(dir);
  const imported = importSkills(name, configPath, strings(configPath, 'agent.skills', agentRaw['skills']), own, env);
  const skills = [...own, ...imported];
  const maskExempt = strings(configPath, 'agent.maskExempt', agentRaw['maskExempt']);
  const native = bool(configPath, 'agent.native', agentRaw['native']);
  return {
    role: {
      name,
      source: 'directory',
      dir,
      description: str(configPath, 'description', root['description']),
      workspace,
      agent: {
        driver,
        command,
        args,
        env: { ...fromGateway, ...fromFile },
        unsupervised,
        passEnv,
        readOnlyTools: strings(configPath, 'agent.readOnlyTools', agentRaw['readOnlyTools']),
        maskExempt,
        ...(native === undefined ? {} : { native }),
      },
      roleMdPath: readRoleMd(dir),
      skills,
      // Empty values are not secrets, and the registry ignores short ones (spec §10.1).
      secretValues: secretValuesOf({ ...fromGateway, ...fromFile }, maskExempt),
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// .env, role.md, skills
// ---------------------------------------------------------------------------

/**
 * A role's own secrets (spec §2.5). The one file the gateway reads secrets from,
 * so it is checked at every point where it could leak or travel: it must be a
 * regular file (a symlink could point anywhere), owned by the gateway's user,
 * and readable by nobody else. A loose mode is refused, not fixed: a file that
 * was readable may already have been read, and tightening it quietly hides that.
 */
function readRoleEnv(dir: string): Record<string, string> {
  const path = join(dir, '.env');
  // Opened once and checked on that descriptor, so the file that passes the
  // checks is the file that is read. O_NOFOLLOW refuses a symlink at the open
  // itself; O_NONBLOCK keeps a FIFO from hanging the open before fstat sees it.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    if (code === 'ELOOP') {
      throw new ConfigError(`${path} is a symlink; a role's .env must be a regular file, so it cannot point anywhere else`);
    }
    throw new ConfigError(`cannot inspect ${path}: ${(err as Error).message}`);
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ConfigError(`${path} is not a regular file`);
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new ConfigError(`${path} is owned by another user; it must belong to the user the gateway runs as`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new ConfigError(
        `${path} can be read or written by other users (mode ${(stat.mode & 0o777).toString(8)}); ` +
          'it must be readable and writable only by its owner (for example 0600). The gateway does not change it itself: a file that was readable may already have been read.',
      );
    }
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }

  const parsed = parseEnvFile(text, path);
  if ('error' in parsed) throw new ConfigError(parsed.error);
  for (const key of Object.keys(parsed.values)) {
    if (!gatewayOwnsVariable(key)) continue;
    throw new ConfigError(
      key === 'PATH'
        ? `${path}: PATH may not be set in a role's .env: the gateway sets it for every run`
        : `${path}: ${key} may not be set in a role's .env: it belongs to the gateway`,
    );
  }
  return parsed.values;
}

/** Names a role's .env cannot set: the gateway's own. */
export function gatewayOwnsVariable(name: string): boolean {
  return name === 'PATH' || name.startsWith('MT_') || name.startsWith('LARK_');
}

/** The values a role's agent is given that are secrets: every one, except names in maskExempt. */
export function secretValuesOf(env: Readonly<Record<string, string>>, maskExempt: readonly string[]): string[] {
  return Object.entries(env)
    .filter(([name, value]) => !maskExempt.includes(name) && value !== '')
    .map(([, value]) => value);
}

/** `role.md` is optional; present, it must be a readable regular file. */
function readRoleMd(dir: string): string | undefined {
  const path = join(dir, 'role.md');
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(`cannot inspect ${path}: ${(err as Error).message}`);
  }
  if (!stat.isFile()) throw new ConfigError(`${path} is not a regular file`);
  try {
    readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`${path} cannot be read: ${(err as Error).message}`);
  }
  return path;
}

/**
 * Skills: each `skills/<name>/` directory holding a `SKILL.md` whose front matter
 * gives a `name` (its directory's) and a one-line `description`, with anything else
 * the skill needs beside it -- the format bytesec agent packages and Claude Code
 * both use, so a skill works with either and can be rendered natively later
 * (spec §2.2, plan R). Anything else in `skills/` is reported and ignored.
 */
/**
 * The user-level skill directories bytesec 0.7.4 loads for an agent that is not
 * a package's, in the order a role's `agent.skills` are looked up: the first
 * that holds a name wins. bytesec scans `~/.claude`, `~/.agents`, `~/.coco` and
 * `~/.trae` (each one's `skills/`) and then its config directory
 * (`$XDG_CONFIG_HOME/bytesec`, else `~/.config/bytesec`: `skill/`, then
 * `skills/`), and a later skill of the same name replaces an earlier one, so
 * this is that order reversed: the skill bytesec itself would have used.
 * `~/.bytesec/skills` is not here: bytesec reads it only under
 * `--expose-user-skills`. HOME and XDG_CONFIG_HOME come from the environment the
 * gateway was given, which tests replace.
 */
export function userSkillDirs(env: Env): string[] {
  const home = env['HOME'] === '' ? undefined : env['HOME'];
  const xdg = env['XDG_CONFIG_HOME'] === '' ? undefined : env['XDG_CONFIG_HOME'];
  const config = xdg ?? (home === undefined ? undefined : join(home, '.config'));
  const dirs: string[] = [];
  if (config !== undefined) dirs.push(join(config, 'bytesec', 'skills'), join(config, 'bytesec', 'skill'));
  if (home !== undefined) for (const root of ['.trae', '.coco', '.agents', '.claude']) dirs.push(join(home, root, 'skills'));
  return dirs;
}

/**
 * The skills a role imports by name (`agent.skills`), found where bytesec finds
 * a user's skills (`userSkillDirs`), each checked as the role's own are. A name
 * must follow bytesec's skill-name rule, and may not also be one of the role's
 * own skills: two sources for one skill is a mistake. A name listed twice counts
 * once, as in every list in the file. A
 * skill directory, or its SKILL.md, that is a symlink is not followed, and the
 * next directory is tried. Not found anywhere is a startup error naming the role.
 */
function importSkills(role: string, configPath: string, names: readonly string[], own: readonly Skill[], env: Env): Skill[] {
  const roots = userSkillDirs(env);
  const out: Skill[] = [];
  for (const name of names) {
    if (!isBytesecSkillName(name)) {
      throw new ConfigError(
        `${configPath}: agent.skills: ${JSON.stringify(name)} is not a skill name bytesec loads: lowercase ` +
          "letters, digits and single '-', not at either end, at most 64 characters",
      );
    }
    if (own.some((s) => s.name === name)) {
      throw new ConfigError(`role ${role}: skill ${name} is in its skills/ and in agent.skills; keep one`);
    }
    if (roots.length === 0) {
      throw new ConfigError(`role ${role}: agent.skills names ${name}, but HOME is not set, so there is nowhere to look`);
    }
    const dir = roots
      .map((root) => join(root, name))
      .find(
        (d) =>
          lstatSync(d, { throwIfNoEntry: false })?.isDirectory() === true &&
          lstatSync(join(d, 'SKILL.md'), { throwIfNoEntry: false })?.isFile() === true,
      );
    if (dir === undefined) {
      throw new ConfigError(
        `role ${role}: agent.skills names ${name}, which is in none of ${roots.join(', ')} ` +
          '(a symlinked skill directory is not followed)',
      );
    }
    out.push(readSkillDir(dir, name));
  }
  return out;
}

function readSkills(dir: string): { skills: Skill[]; notes: string[] } {
  const skillsDir = join(dir, 'skills');
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { skills: [], notes: [] };
    throw new ConfigError(`cannot read ${skillsDir}: ${(err as Error).message}`);
  }

  const skills: Skill[] = [];
  const notes: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const dir = join(skillsDir, entry.name);
    if (!entry.isDirectory()) {
      notes.push(`ignoring ${dir}: a skill is a directory holding a SKILL.md`);
      continue;
    }
    skills.push(readSkillDir(dir, entry.name));
  }
  return { skills, notes };
}

/** One skill directory: its SKILL.md's front matter, whose name must be the directory's. */
function readSkillDir(dir: string, dirName: string): Skill {
  const path = join(dir, 'SKILL.md');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`${dir}: a skill directory needs a SKILL.md`);
    }
    throw new ConfigError(`${path} cannot be read: ${(err as Error).message}`);
  }
  const matter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (matter === undefined) {
    throw new ConfigError(`${path}: a skill must start with front matter (--- name: … description: … ---)`);
  }
  let fields: unknown;
  try {
    fields = parseYaml(matter);
  } catch (err) {
    throw new ConfigError(`${path}: its front matter is not valid YAML: ${(err as Error).message}`);
  }
  const meta = section(path, 'front matter', fields ?? {});
  const name = str(path, 'name', meta['name']);
  const description = str(path, 'description', meta['description']);
  if (name === undefined || description === undefined) {
    throw new ConfigError(`${path}: its front matter needs a name and a description`);
  }
  if (name !== dirName) {
    throw new ConfigError(
      `${path}: its name ${JSON.stringify(name)} does not match its directory ${JSON.stringify(dirName)}`,
    );
  }
  return { name, description, dir, path };
}
