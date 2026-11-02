import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isMap, parseDocument, parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigError, loadTeamSettings, type AgentConfig, type Env } from '../config.js';
import { movedMessage, registrationsAt } from '../db/workspaces.js';
import { isReservedRoleName, nameProblem } from '../names.js';
import { discoverRoles } from '../roles.js';
import { loadTeam } from '../team.js';
import { refuse, table, type MtIo } from './mt.js';

/** `mt role list`: every role, its driver, where it comes from, and its description. */
export function roleList(io: MtIo): number {
  // Names only, so an unset agent.passEnv name is no reason to fail (Task 3).
  const settings = loadTeamSettings(io.env, undefined, { unsetPassEnv: [] });
  const rolesDir = join(settings.home, 'roles');
  const found = discoverRoles(rolesDir);
  const rows: string[][] = [];
  if (settings.agent !== undefined && !found.names.includes('default')) {
    rows.push(['default', settings.agent.driver, 'agent: block', '']);
  }
  for (const name of found.names) {
    const summary = summarize(join(rolesDir, name, 'config.yaml'));
    rows.push([name, summary.driver, `roles/${name}`, summary.description]);
  }
  if (rows.length === 0) io.out('no roles: create one with mt role create <name>');
  for (const line of table(rows)) io.out(line);
  for (const note of found.notes) io.out(`note: ${note}`);
  return 0;
}

/** Read loosely, so a broken role still gets a line; `mt role check` says what is wrong with it. */
function summarize(path: string): { driver: string; description: string } {
  try {
    const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    const agent = raw?.['agent'] as Record<string, unknown> | undefined;
    const driver = agent?.['driver'];
    const description = raw?.['description'];
    return {
      driver: typeof driver === 'string' ? driver : '?',
      description: typeof description === 'string' ? description : '',
    };
  } catch {
    return { driver: '?', description: '(unreadable config.yaml)' };
  }
}

const DEFAULT_ROLE = 'default';
const AGENT_OVERRIDES = ['MT_AGENT_COMMAND', 'MT_AGENT_ARGS', 'MT_AGENT_DRIVER', 'MT_AGENT_UNSUPERVISED'] as const;
const AGENT_ENV_PREFIX = 'MT_AGENT_ENV_';

function starterRoleMd(name: string): string {
  return (
    `<!-- Standing instructions for the ${name} role, given to its agent at every claim.\n` +
    '     Say what the role does, how it works, and what it must not do. -->\n'
  );
}

export interface CreateOptions {
  cloneFrom?: string | undefined;
  description?: string | undefined;
}

/** `mt role create` (spec §2.6). */
export function roleCreate(name: string, opts: CreateOptions, io: MtIo): number {
  const problem = nameProblem('role', name);
  if (problem !== undefined) return refuse(io, problem);
  if (isReservedRoleName(name)) return refuse(io, `role name ${name} is reserved: it is a driver id`);
  if (name === DEFAULT_ROLE && opts.cloneFrom !== undefined) {
    return refuse(io, 'the role default is always made from the agent: block; --clone-from cannot be used with it');
  }
  if (opts.cloneFrom !== undefined) {
    // A name, never a path: `--clone-from ../x` must not read outside roles/.
    const sourceProblem = nameProblem('role', opts.cloneFrom);
    if (sourceProblem !== undefined) return refuse(io, sourceProblem);
  }

  // Names and paths only; the agent's environment is never copied (Task 3).
  const settings = loadTeamSettings(io.env, undefined, { unsetPassEnv: [] });
  const rolesDir = join(settings.home, 'roles');
  const dir = join(rolesDir, name);
  // Only a real role directory is a source: discoverRoles skips a symlink, and so
  // does the gateway, so the copy cannot be pointed outside roles/ by one.
  const found = discoverRoles(rolesDir);
  // lstat, so a symlink -- even a dangling one -- counts as being there.
  if (lstatSync(dir, { throwIfNoEntry: false }) !== undefined) {
    if (name === DEFAULT_ROLE && !found.names.includes(name)) {
      return refuse(io, `${dir} exists but is not a role directory`);
    }
    return refuse(io, `${dir} already exists`);
  }

  const source = opts.cloneFrom ?? DEFAULT_ROLE;
  const sourceDir = join(rolesDir, source);
  let configText: string;
  let legacy = false;
  if (found.names.includes(source)) {
    const sourceConfig = join(sourceDir, 'config.yaml');
    const stat = lstatSync(sourceConfig, { throwIfNoEntry: false });
    if (stat === undefined) return refuse(io, `there is no role ${source} to copy from`);
    // Never followed: a link would copy whatever it points at, a secret included.
    if (!stat.isFile()) return refuse(io, `${source}'s config.yaml is not a regular file: ${sourceConfig}`);
    configText = readFileSync(sourceConfig, 'utf8');
  } else if (source === DEFAULT_ROLE && settings.agent !== undefined) {
    configText = renderAgentConfig(settings.agent);
    legacy = true;
  } else {
    return refuse(io, `there is no role ${source} to copy from`);
  }
  if (opts.description !== undefined) {
    const doc = parseDocument(configText);
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
      return refuse(io, `${source}'s config.yaml is not a valid role config; run mt role check ${source}`);
    }
    doc.set('description', opts.description);
    configText = String(doc);
  }
  // role.md and skills/ come with --clone-from; copying from default takes config.yaml only.
  const copyDir = opts.cloneFrom === undefined ? undefined : sourceDir;

  mkdirSync(rolesDir, { recursive: true, mode: 0o700 });
  // Dot-named, so discoverRoles ignores it until the rename puts it in place.
  const staging = mkdtempSync(join(rolesDir, `.${name}-`));
  try {
    writeFileSync(join(staging, 'config.yaml'), configText);
    // Symlinks are never followed, as discoverRoles and loadRoleDir never follow
    // them: a link would copy whatever it points at into the new role. config.yaml
    // was checked above; role.md and skills/ are checked here.
    const roleMd = copyDir === undefined ? undefined : join(copyDir, 'role.md');
    writeFileSync(
      join(staging, 'role.md'),
      roleMd !== undefined && lstatSync(roleMd, { throwIfNoEntry: false })?.isFile() === true
        ? readFileSync(roleMd, 'utf8')
        : starterRoleMd(name),
    );
    const skills = copyDir === undefined ? undefined : join(copyDir, 'skills');
    if (skills !== undefined && lstatSync(skills, { throwIfNoEntry: false })?.isDirectory() === true) {
      cpSync(skills, join(staging, 'skills'), {
        recursive: true,
        // Files and directories only: no symlink, and no FIFO or socket, which
        // cpSync cannot copy.
        filter: (src) => {
          const s = lstatSync(src);
          return s.isFile() || s.isDirectory();
        },
      });
    } else {
      mkdirSync(join(staging, 'skills'));
    }
    // Never cloned (spec §2.5): one credential with two owners is how a rotated
    // refresh token gets revoked for the other.
    writeFileSync(join(staging, '.env'), '', { mode: 0o600, flag: 'wx' });
    writeFileSync(join(staging, '.gitignore'), '.env\n');
    renameSync(staging, dir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  io.out(`created role ${name} at ${dir}, with config.yaml from ${legacy ? 'the agent: block' : `role ${source}`}`);
  if (legacy) reportLegacyCopy(dir, io);
  if (name === DEFAULT_ROLE) reportCutover(dir, settings.configPath, io);
  io.out(`check it with: mt role check ${name}`);
  return 0;
}

function renderAgentConfig(agent: AgentConfig): string {
  const block: Record<string, unknown> = {
    driver: agent.driver,
    command: agent.command,
    args: [...agent.args],
    unsupervised: agent.unsupervised,
  };
  if (agent.passEnv.length > 0) block['passEnv'] = [...agent.passEnv];
  if (agent.readOnlyTools.length > 0) block['readOnlyTools'] = [...agent.readOnlyTools];
  if (agent.maskExempt.length > 0) block['maskExempt'] = [...agent.maskExempt];
  // Names only. The agent block's env holds values, and none of them is written.
  return `# Written by mt role create from the gateway's agent: block.\n${stringifyYaml({ agent: block })}`;
}

function reportLegacyCopy(dir: string, io: MtIo): void {
  for (const key of AGENT_OVERRIDES) {
    const value = io.env[key];
    if (value !== undefined && value.trim() !== '') {
      io.out(`applied ${key} from this shell (the service's environment may differ)`);
    }
  }
  const secrets = Object.keys(io.env)
    .filter((key) => key.startsWith(AGENT_ENV_PREFIX) && key.length > AGENT_ENV_PREFIX.length)
    .sort();
  if (secrets.length > 0) {
    io.out(`not copied, because they are secrets: ${secrets.join(', ')}`);
    io.out(`put them in ${join(dir, '.env')} as:`);
    for (const key of secrets) {
      const secret = key.slice(AGENT_ENV_PREFIX.length);
      io.out(
        gatewayOwned(secret)
          ? `  ${secret} cannot go in a role's .env (it belongs to the gateway); this role will not get it`
          : `  ${secret}=...`,
      );
    }
  }
  // Always, even when this shell holds none: the service may hold some this shell does not.
  io.out("  (only this shell's MT_AGENT_ENV_* names are listed; check the service's environment for others)");
}

/** Names a role's .env cannot set: the gateway's own. */
function gatewayOwned(name: string): boolean {
  return name === 'PATH' || name.startsWith('MT_') || name.startsWith('LARK_');
}

function reportCutover(dir: string, configPath: string | undefined, io: MtIo): void {
  io.out('to make this the role default:');
  io.out(`  1. put the values listed above, if any, in ${join(dir, '.env')}`);
  io.out(
    `  2. remove the agent: block${configPath === undefined ? '' : ` from ${configPath}`}, ` +
      "and every MT_AGENT_* variable from the service's environment",
  );
  io.out('  3. run mt role check');
  io.out('  4. restart the gateway');
  io.out('until step 2 is done the gateway will not start: it refuses to run with the role default defined twice');
}

interface Attempt {
  error?: string;
  /** `role: NAME` for each passEnv name not set in the environment checked. */
  unset: string[];
  /** What startup would log: entries under roles/ that were ignored, and why. */
  notes: readonly string[];
}

/** One run of the startup validation against `env`. Never throws a ConfigError. */
function attempt(env: Env, only: string | undefined): Attempt {
  const result = attemptAll(env, only);
  // On every path, error or not: `mt role check nobody` names no other role's variables.
  if (only === undefined) return result;
  return { ...result, unset: result.unset.filter((u) => u.startsWith(`${only}: `)) };
}

function attemptAll(env: Env, only: string | undefined): Attempt {
  const unset: string[] = [];
  let notes: readonly string[] = [];
  try {
    // The same collector for the agent: block and the role directories, so an
    // unset name is reported, under the role that names it, whichever defines it.
    const settings = loadTeamSettings(env, undefined, { unsetPassEnv: unset });
    const team = loadTeam(settings, env, { unsetPassEnv: unset });
    notes = team.notes;
    if (only !== undefined && !team.roles.has(only)) return { error: `there is no role ${only}`, unset, notes };
    const recorded = registrationsAt(settings.dbPath);
    for (const [name, path] of team.workspaces) {
      const was = recorded.get(name);
      if (was !== undefined && was !== path) return { error: movedMessage(name, was, path), unset, notes };
    }
    return { unset, notes };
  } catch (err) {
    if (err instanceof ConfigError) return { error: err.message, unset, notes };
    throw err;
  }
}

function withoutAgentVariables(env: Env): Env {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('MT_AGENT_')) out[key] = value;
  }
  return out;
}

/**
 * `mt role check [name]` (spec §2.6): the startup validation, in two parts --
 * what the files say, and what this shell's environment adds. A problem that
 * goes away without this shell's MT_AGENT_* variables is the environment's.
 */
export function roleCheck(only: string | undefined, io: MtIo): number {
  const real = attempt(io.env, only);
  const files: string[] = [];
  const environment = real.unset.map((entry) => {
    const [role, key] = entry.split(': ');
    return `role ${role} names ${key} in agent.passEnv, and it is not set in this shell`;
  });
  if (real.error !== undefined) {
    // The files are at fault only when the error survives removing this shell's
    // MT_AGENT_* variables unchanged. A different error from the stripped run is
    // not a file problem either: an environment-only deployment, stripped, has
    // no role default at all.
    const stripped = attempt(withoutAgentVariables(io.env), only);
    if (stripped.error === real.error) files.push(real.error);
    else environment.push(real.error);
  }
  report('files', files, io);
  report("this shell's environment", environment, io);
  for (const note of real.notes) io.out(`note: ${note}`);
  io.out("note: the environment was checked in this shell; the service's environment may differ");
  return files.length + environment.length === 0 ? 0 : 1;
}

function report(what: string, problems: readonly string[], io: MtIo): void {
  if (problems.length === 0) {
    io.out(`${what}: ok`);
    return;
  }
  io.out(`${what}:`);
  for (const p of problems) io.out(`  ${p}`);
}
