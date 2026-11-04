import { join } from 'node:path';
import { type AgentConfig, ConfigError, type Env, type LoadOptions, type TeamSettings } from './config.js';
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
