import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { isMap, parseDocument, parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  AGENT_ENV_PREFIX,
  AGENT_OVERRIDES,
  ConfigError,
  loadTeamSettings,
  type AgentConfig,
  type Env,
} from '../config.js';
import { movedMessage, registrationsAt } from '../db/workspaces.js';
import { RESUME_MIN_VERSION } from '../driver/cli/driver.js';
import { isReservedRoleName, nameProblem } from '../names.js';
import { nativeFor } from '../render/native.js';
import { discoverRoles, gatewayOwnsVariable, type Role } from '../roles.js';
import { loadTeam } from '../team.js';
import { refuse, table, type MtIo } from './mt.js';
import {
  addedMessage,
  addToConfig,
  checkFinalWorkspace,
  checkNewWorkspace,
  expectedWorkspacePath,
  restoreConfig,
  workspacesParentProblem,
  type NewWorkspace,
} from './workspace.js';

/** `mt role list`: every role, its driver, where it comes from, and its description. */
export function roleList(io: MtIo): number {
  // Names only, so an unset agent.passEnv name is no reason to fail (see
  // LoadOptions.unsetPassEnv).
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

function starterRoleMd(name: string): string {
  return (
    `<!-- Standing instructions for the ${name} role, given to its agent at every claim.\n` +
    '     Say what the role does, how it works, and what it must not do. -->\n'
  );
}

export interface CreateOptions {
  cloneFrom?: string | undefined;
  description?: string | undefined;
  /** Give the role a workspace of its own, `$MT_HOME/workspaces/<name>`. */
  ownWorkspace?: boolean | undefined;
}

/** `mt role create` (spec §2.6). */
export function roleCreate(name: string, opts: CreateOptions, io: MtIo): number {
  const problem = nameProblem('role', name);
  if (problem !== undefined) return refuse(io, problem);
  if (isReservedRoleName(name)) return refuse(io, `role name ${name} is reserved: it is a driver id`);
  if (name === DEFAULT_ROLE && opts.cloneFrom !== undefined) {
    return refuse(io, 'the role default is always made from the agent: block; --clone-from cannot be used with it');
  }
  if (name === DEFAULT_ROLE && opts.ownWorkspace === true) {
    return refuse(io, 'the role default works in the workspace default; --own-workspace cannot be used with it');
  }
  if (opts.cloneFrom !== undefined) {
    // A name, never a path: `--clone-from ../x` must not read outside roles/.
    const sourceProblem = nameProblem('role', opts.cloneFrom);
    if (sourceProblem !== undefined) return refuse(io, sourceProblem);
  }

  // The collector is there so an unset agent.passEnv name does not stop a command
  // that only needs names (see LoadOptions.unsetPassEnv).
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
  if (opts.description !== undefined || opts.ownWorkspace === true) {
    const doc = parseDocument(configText);
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
      return refuse(io, `${source}'s config.yaml is not a valid role config; run mt role check ${source}`);
    }
    if (opts.description !== undefined) doc.set('description', opts.description);
    else if (opts.cloneFrom === undefined && !legacy) doc.delete('description');
    if (opts.ownWorkspace === true) doc.set('workspace', name);
    configText = String(doc);
  } else if (opts.cloneFrom === undefined && !legacy) {
    // A description says what one role is for, so a role made from default does
    // not take default's; --clone-from keeps the source's. A config that is not a
    // map is copied as it is, as before, for mt role check to report.
    const doc = parseDocument(configText);
    if (doc.errors.length === 0 && isMap(doc.contents) && doc.has('description')) {
      doc.delete('description');
      configText = String(doc);
    }
  }
  // role.md and skills/ come with --clone-from; copying from default takes config.yaml only.
  const copyDir = opts.cloneFrom === undefined ? undefined : sourceDir;

  // Every check that needs nothing written, before anything is.
  let own: OwnWorkspace | undefined;
  if (opts.ownWorkspace === true) {
    const ws = checkNewWorkspace(name, settings, io.env);
    if ('error' in ws) return refuse(io, ws.error);
    const parentProblem = workspacesParentProblem(settings.home);
    if (parentProblem !== undefined) return refuse(io, parentProblem);
    const expected = expectedWorkspacePath(settings.home, name);
    if (ws.recorded !== undefined && ws.recorded !== expected) {
      return refuse(io, movedMessage(name, ws.recorded, expected));
    }
    const path = join(settings.home, 'workspaces', name);
    // lstat, so a symlink -- even a dangling one -- counts as being there.
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) return refuse(io, `${path} already exists`);
    own = { ws, real: path };
  }

  // Each step is undone, newest first, if a later one fails; only what this run made.
  const undo: (() => void)[] = [];
  // Every step is tried, so one that fails does not leave the others' work behind.
  const undoAll = (): void => {
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (err) {
        io.err(`mt: could not undo a step: ${(err as Error).message}`);
      }
    }
  };
  const madeRoles = mkdirSync(rolesDir, { recursive: true, mode: 0o700 });
  if (madeRoles !== undefined && own !== undefined) undo.push(() => rmSync(madeRoles, { recursive: true, force: true }));
  try {
    // Dot-named, so discoverRoles ignores it until the rename puts it in place.
    // Inside the try, so a failure here still undoes a roles/ made above.
    const staging = mkdtempSync(join(rolesDir, `.${name}-`));
    undo.push(() => rmSync(staging, { recursive: true, force: true }));
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
        // cpSync cannot copy. No .env either, wherever it is: a credential is never
        // cloned (spec §2.5).
        filter: (src) => {
          if (basename(src) === '.env') return false;
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
    if (own !== undefined) {
      const problem = addOwnWorkspace(own, undo);
      if (problem !== undefined) {
        undoAll();
        return refuse(io, problem);
      }
    }
    renameSync(staging, dir);
  } catch (err) {
    undoAll();
    throw err;
  }

  io.out(`created role ${name} at ${dir}, with config.yaml from ${legacy ? 'the agent: block' : `role ${source}`}`);
  if (legacy) reportLegacyCopy(dir, io);
  if (name === DEFAULT_ROLE) reportCutover(dir, settings.configPath, io);
  if (own !== undefined) {
    io.out(addedMessage(name, own.real, own.ws.configPath));
    io.out(`note: tasks assigned to role ${name} will run in its own workspace, not in their parents' checkout`);
  }
  io.out(`check it with: mt role check ${name}`);
  return 0;
}

interface OwnWorkspace {
  ws: NewWorkspace;
  /** `$MT_HOME/workspaces/<name>`, real once it has been made. */
  real: string;
}

/**
 * Makes the role's workspace directory, checks the final set of workspaces and
 * writes the config file, pushing an undo for each step done. Returns a refusal,
 * or undefined when all of it was done.
 */
function addOwnWorkspace(own: OwnWorkspace, undo: (() => void)[]): string | undefined {
  const { ws } = own;
  const parent = join(ws.settings.home, 'workspaces');
  let path: string;
  try {
    const madeParent = mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (madeParent !== undefined) undo.push(() => rmSync(madeParent, { recursive: true, force: true }));
    // Again once it exists: one put there since the check before any write is refused too.
    const parentProblem = workspacesParentProblem(ws.settings.home);
    if (parentProblem !== undefined) return parentProblem;
    path = join(realpathSync(parent), ws.name);
    // Not recursive, so one made since the check above is refused, not taken over.
    mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    return `cannot create ${join(parent, ws.name)}: ${(err as Error).message}`;
  }
  undo.push(() => rmSync(path, { recursive: true, force: true }));
  // The umask narrows the mode given to mkdir.
  chmodSync(path, 0o700);
  const final = checkFinalWorkspace(ws, path);
  if ('error' in final) return final.error;
  try {
    addToConfig(ws, path);
  } catch (err) {
    return `cannot write ${ws.configPath}: ${(err as Error).message}`;
  }
  undo.push(() => restoreConfig(ws));
  own.real = final.real;
  return undefined;
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
        gatewayOwnsVariable(secret)
          ? `  ${secret} cannot go in a role's .env (it belongs to the gateway); this role will not get it`
          : `  ${secret}=...`,
      );
    }
  }
  // Always, even when this shell holds none: the service may hold some this shell does not.
  io.out("  (only this shell's MT_AGENT_ENV_* names are listed; check the service's environment for others)");
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
  /** The roles checked, when the check passed: whether each is rendered natively is reported. */
  roles?: readonly Role[];
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
    const roles = [...team.roles.values()].filter((r) => only === undefined || r.name === only);
    return { unset, notes, roles: roles.sort((a, b) => a.name.localeCompare(b.name)) };
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
  // One line a role: whether its runs get role.md and skills natively (plan R).
  for (const role of real.roles ?? []) {
    const native = nativeFor(role);
    io.out(
      native.ok
        ? `native: role ${role.name} runs as a ${native.renderer.id} agent package`
        : `native: role ${role.name} does not: ${native.reason}`,
    );
  }
  resumeVersions(real.roles ?? [], io);
  for (const note of real.notes) io.out(`note: ${note}`);
  io.out("note: the environment was checked in this shell; the service's environment may differ");
  return files.length + environment.length === 0 ? 0 : 1;
}

/**
 * A line for each bytesec role whose bytesec is older than `RESUME_MIN_VERSION`,
 * the oldest measured to resume a session (native resume), or whose version cannot be
 * read. A warning, not a failure: how an older bytesec takes the driver's flags
 * was never measured, so it may work, or not. Each command is asked once.
 */
function resumeVersions(roles: readonly Role[], io: MtIo): void {
  const ask = io.agentVersion ?? ((command: string) => readAgentVersion(command, io.env));
  const versions = new Map<string, string | undefined>();
  for (const role of roles) {
    const { driver, command } = role.agent;
    if (driver !== 'structured-cli' || basename(command) !== 'bytesec') continue;
    if (!versions.has(command)) versions.set(command, ask(command));
    const version = versions.get(command);
    if (version === undefined) {
      io.out(`note: role ${role.name}: ${command} --version gave no version; native resume needs bytesec ${RESUME_MIN_VERSION} or later`);
    } else if (versionBelow(version, RESUME_MIN_VERSION)) {
      io.out(
        `warning: role ${role.name} runs bytesec ${version}, older than ${RESUME_MIN_VERSION}, the oldest ` +
          'measured to resume a session; with it, native resume is unmeasured and its turns may not work',
      );
    }
  }
}

/** The first `x.y.z` that `<command> --version` prints, or undefined when it cannot be run or prints none. */
export function readAgentVersion(command: string, env: Env): string | undefined {
  const r = spawnSync(command, ['--version'], { encoding: 'utf8', env, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error !== undefined || r.status !== 0) return undefined;
  return /\d+\.\d+\.\d+/.exec(r.stdout)?.[0];
}

/** Whether `x.y.z` is older than `min`, comparing each part as a number. */
export function versionBelow(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function report(what: string, problems: readonly string[], io: MtIo): void {
  if (problems.length === 0) {
    io.out(`${what}: ok`);
    return;
  }
  io.out(`${what}:`);
  for (const p of problems) io.out(`  ${p}`);
}
