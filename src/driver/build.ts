import type { AgentConfig } from '../config.js';
import { PRODUCT_NAME } from '../identity.js';
import type { Role } from '../roles.js';
import { createAcpDriver } from './acp/driver.js';
import { createCliDriver } from './cli/driver.js';
import type { Driver } from './types.js';

/**
 * A driver per role (spec §2.4 item 1).
 *
 * Built from the role's own `agent` block -- its command, its args, and an
 * environment holding its `.env` and `passEnv` values -- so two roles on the same
 * kind of agent are two drivers that share nothing. A `switch` on the kind rather
 * than a registry: the compiler checks it covers every `KnownDriver`, and the
 * config has already refused any other value.
 */
export function buildDriver(agent: AgentConfig): Driver {
  switch (agent.driver) {
    case 'acp':
      return createAcpDriver({
        command: agent.command,
        args: agent.args,
        env: agent.env,
        clientName: PRODUCT_NAME,
      });
    case 'structured-cli':
      return createCliDriver({ command: agent.command, args: agent.args, env: agent.env });
  }
}

/** Role name → that role's driver. */
export function buildRoleDrivers(roles: ReadonlyMap<string, Role>): Map<string, Driver> {
  const out = new Map<string, Driver>();
  for (const [name, role] of roles) out.set(name, buildDriver(role.agent));
  return out;
}
