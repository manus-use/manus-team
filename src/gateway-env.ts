import { join } from 'node:path';
import { AGENT_ENV_PREFIX, ConfigError, GATEWAY_ENV_NAMES, gatewayHome, type Env } from './config.js';
import { parseEnvFile, readPrivateEnvFile } from './dotenv.js';
import { addSecrets } from './secrets.js';

/**
 * The gateway's own `.env`, at `$MT_HOME/.env`: its secrets, and any other
 * setting it reads from its environment, kept beside the environment rather than
 * in it (spec §2.5, §10). Optional: a missing file sets nothing.
 *
 * Read by the gateway at startup and by the `mt` commands that load its
 * settings, so `mt role check` and the operator's `mt kanban` see what it sees.
 * Never given to an agent: the merged environment goes only to `loadConfig` and
 * `loadTeam`, and an agent's process environment is built from the gateway's own
 * process environment, by allowlist (`driver/env.ts`), which this never changes.
 * The names it may hold are the gateway's, and those `agent.passEnv` refuses to
 * forward; an `MT_AGENT_ENV_<NAME>` value reaches the agent as `<NAME>`, as it
 * would from the environment, since that is what the name asks for.
 *
 * The rules are a role's `.env`'s: the same syntax and the same checks on the
 * file (owner-only, a regular file, not a symlink, owned by the gateway's user).
 * Its secrets (`isSecretName`) are known to the masker from the moment it is
 * read, so a refusal after this, from `loadConfig` say, is masked too. A name the gateway
 * does not read is refused, as an unknown config key is: a typo'd name would
 * otherwise be a setting that silently never applied.
 */

export interface GatewayEnvFile {
  path: string;
  /** False when there is no file, which is fine. */
  present: boolean;
  values: Readonly<Record<string, string>>;
}

/**
 * The names that say where the gateway's files are, refused in a file inside
 * one of them. MT_HOME says where this file is, so a value here would name a
 * different home from the one it was found in. MT_CONFIG and MT_DB are refused
 * with it so that where everything lives is decided in one place, by how the
 * gateway is started: a home whose .env pointed at another config file or
 * database would leave its own config.yaml or team.db silently unused. The
 * config file's `db:` remains for a database elsewhere.
 */
const LOCATING: ReadonlySet<string> = new Set(['MT_HOME', 'MT_CONFIG', 'MT_DB']);

const ACCEPTED: ReadonlySet<string> = new Set(GATEWAY_ENV_NAMES.filter((name) => !LOCATING.has(name)));

/**
 * The names in the file whose values are secrets, and masked: the Lark app
 * secret, and what is given to an agent, which a role's `.env` values are too.
 * The rest are paths, ids and limits, shown as written, as they are from the
 * config file: a masked workspace path or app id would hide where things are
 * in every line that names them, and stop a gate naming the workspace.
 */
export function isSecretName(name: string): boolean {
  return name === 'LARK_APP_SECRET' || (name.startsWith(AGENT_ENV_PREFIX) && name.length > AGENT_ENV_PREFIX.length);
}

/** Where the gateway's .env is: `$MT_HOME/.env`. */
export function gatewayEnvPath(env: Env): string {
  return join(gatewayHome(env), '.env');
}

/** The gateway's .env, checked, its values registered with the masker. Throws a ConfigError naming a line or a name, never a value. */
export function readGatewayEnv(env: Env): GatewayEnvFile {
  const path = gatewayEnvPath(env);
  const text = readPrivateEnvFile(path, "the gateway's .env");
  if (text === undefined) return { path, present: false, values: {} };
  const parsed = parseEnvFile(text, path);
  if ('error' in parsed) throw new ConfigError(parsed.error);
  // The secrets masked before any name is checked: the refusals below name no
  // value, but whatever is thrown next should find them known.
  addSecrets(
    Object.entries(parsed.values)
      .filter(([name, value]) => isSecretName(name) && value !== '')
      .map(([, value]) => value),
  );

  const lines = text.split(/\r?\n/);
  for (const name of Object.keys(parsed.values)) {
    if (ACCEPTED.has(name) || (name.startsWith(AGENT_ENV_PREFIX) && name.length > AGENT_ENV_PREFIX.length)) continue;
    const line = lines.findIndex((l) => lineKey(l) === name) + 1;
    const at = line > 0 ? `${path}:${line}` : path;
    if (LOCATING.has(name)) {
      throw new ConfigError(
        `${at}: ${name} cannot be set in the gateway's .env: it says where the gateway's files are, ` +
          'this one among them, so it is set in the environment the gateway starts with',
      );
    }
    throw new ConfigError(
      `${at}: unknown variable ${name} (known: ${[...ACCEPTED].join(', ')}, ${AGENT_ENV_PREFIX}<NAME>)`,
    );
  }
  return { path, present: true, values: parsed.values };
}

/** The name a line sets, as parseEnvFile reads it, or undefined for a blank line or a comment. */
function lineKey(line: string): string | undefined {
  const text = line.trim();
  const eq = text.indexOf('=');
  return text.startsWith('#') || eq <= 0 ? undefined : text.slice(0, eq).trim();
}

/** `env` over the file's values, name by name: a name the environment sets at all, even empty, is the environment's. */
export function withGatewayEnv(env: Env, file: GatewayEnvFile): Env {
  const out: Record<string, string | undefined> = { ...file.values };
  for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value;
  return out;
}

/** The environment the gateway's settings are loaded from, and the file that added to it. */
export function loadGatewayEnv(env: Env): { env: Env; file: GatewayEnvFile } {
  const file = readGatewayEnv(env);
  return { env: withGatewayEnv(env, file), file };
}
