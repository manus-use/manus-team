import { join } from 'node:path';
import { type AgentConfig, ConfigError, type Env, type LoadOptions, type TeamSettings, maxRunningText } from './config.js';
import { nativeFor, rendererFor } from './render/native.js';
import { discoverRoles, loadRoleDir, secretValuesOf, type Role } from './roles.js';
import { resolveWorkspaces } from './workspaces.js';

/**
 * Everything about who works where, loaded and checked at startup.
 *
 * Separate from `loadConfig` because it reads the disk -- role directories,
 * `.env` files, workspace paths -- where `loadConfig` reads one file and the
 * environment. `mt role check` (plan B3) runs the same function.
 */

export interface Team {
  roles: ReadonlyMap<string, Role>;
  /** Workspace name → real path. */
  workspaces: ReadonlyMap<string, string>;
  /** For the operator's log: entries under roles/ that were ignored, and why. */
  notes: readonly string[];
}

/**
 * Every secret value the team gives its agents, for the masker (spec §10.1): each
 * role's, less its maskExempt names. The gateway adds its Lark secret to these.
 */
export function teamSecrets(team: Team): string[] {
  return [...team.roles.values()].flatMap((role) => role.secretValues);
}

export function loadTeam(config: TeamSettings, env: Env, opts: LoadOptions = {}): Team {
  const resolved = resolveWorkspaces(config.workspaces, config.home, config.dbPath);
  if ('error' in resolved) throw new ConfigError(resolved.error);
  const workspaceNames = new Set(resolved.workspaces.keys());

  const rolesDir = join(config.home, 'roles');
  const found = discoverRoles(rolesDir);
  const notes = [...found.notes];
  const roles = new Map<string, Role>();
  for (const name of found.names) {
    const loaded = loadRoleDir(name, join(rolesDir, name), env, workspaceNames, opts);
    const own = loaded.role.maxRunning;
    if (own !== undefined && config.kanban !== undefined && own > config.kanban.maxRunning) {
      // Refused, as a board's own above the gateway's is (spec §16.6): a limit
      // that could never bind is a mistake to fix, not one to run with.
      throw new ConfigError(
        `${join(rolesDir, name, 'config.yaml')}: max_running (${own}) is above the gateway's ` +
          `${maxRunningText(config.kanban)}; a role's max_running is a whole number from 1 to it`,
      );
    }
    const steps = maxStepsProblem(loaded.role);
    if (steps !== undefined) throw new ConfigError(`${join(rolesDir, name, 'config.yaml')}: agent.maxSteps: ${steps}`);
    roles.set(name, loaded.role);
    notes.push(...loaded.notes);
  }

  // Exactly one source for the role default (spec §2.1).
  const defaultDir = join(rolesDir, 'default');
  if (roles.has('default') && config.agent !== undefined) {
    throw new ConfigError(
      `both ${defaultDir} and the agent: block (or MT_AGENT_* variables) define the role default; keep one`,
    );
  }
  if (!roles.has('default')) {
    if (config.agent === undefined) {
      throw new ConfigError(
        `there is no role default: create ${defaultDir}, or set agent: in the config file (or MT_AGENT_COMMAND)`,
      );
    }
    roles.set('default', roleFromAgentBlock(config.agent));
  }

  return { roles, workspaces: resolved.workspaces, notes };
}

/**
 * Why a role's `agent.maxSteps` would not reach its agent, or undefined when it
 * would. The gateway has no step limit of its own: only a renderer that writes
 * one into the role's native package applies it, so a role not rendered, or
 * rendered by one that cannot, would have it silently dropped. Chat sessions
 * run the role default without rendering it, so it is refused there too.
 */
function maxStepsProblem(role: Role): string | undefined {
  if (role.agent.maxSteps === undefined) return undefined;
  if (rendererFor(role)?.maxSteps !== true) {
    return `this role's agent (${role.agent.command} over ${role.agent.driver}) has no step limit the gateway can set`;
  }
  const native = nativeFor(role);
  if (!native.ok) return `the gateway sets it in the role's native package, and this role is not rendered: ${native.reason}`;
  if (role.name === 'default') {
    return 'the role default runs chat sessions, which are not rendered, so it would not apply to them; set it on another role';
  }
  return undefined;
}

/** The gateway's `agent:` block, standing in for a roles/default directory. */
function roleFromAgentBlock(agent: AgentConfig): Role {
  return {
    name: 'default',
    source: 'agent-block',
    dir: undefined,
    description: undefined,
    workspace: undefined,
    agent,
    roleMdPath: undefined,
    skills: [],
    secretValues: secretValuesOf(agent.env, agent.maskExempt),
  };
}
