import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { KNOWN_DRIVERS, type KnownDriver } from './driver/registry.js';
import { BIDI } from './text.js';

/**
 * The migrations that ship with this build, found relative to this module rather
 * than to the working directory: a service manager picks the cwd, and migrations
 * belong to the code, not to wherever someone happened to launch it from.
 *
 * One level up holds for both layouts -- `src/config.ts` and `dist/config.js`.
 */
const BUNDLED_SCHEMA_DIR = fileURLToPath(new URL('../schema', import.meta.url));

/**
 * Configuration: a YAML file for settings, the environment for secrets.
 *
 * The split is a trust boundary, not a style preference. In this build the agent
 * runs as the same user as the gateway and is not sandboxed, so **anything on disk
 * it can read**. The environment is not airtight either -- a same-uid process can
 * read `/proc/<pid>/environ` on Linux -- but it does not persist, is not backed up,
 * cannot be copied into a worktree, and cannot be committed by accident. So the
 * file names credentials and never holds them, and a file that does hold one is
 * refused at boot rather than quietly accepted.
 *
 * The environment here is the gateway's process environment over its own
 * `$MT_HOME/.env` (`gateway-env.ts`), merged by the caller before `loadConfig`
 * sees it: a file of secrets alone, owner-only, in a role's `.env` syntax, which
 * no agent is given. `loadConfig` itself reads only what it is handed, so a test
 * never reads the real home.
 *
 * Four rules, all about failing safely:
 *
 * 1. **Everything is validated here, at boot.** A missing app secret discovered on
 *    the first inbound message is a bot that connects, looks healthy, does nothing.
 * 2. **Empty means closed.** An unset allowlist reads naturally as "no restrictions
 *    configured", which is the opposite of what a missing allowlist should mean.
 *    Nothing in here defaults to permissive.
 * 3. **An unrecognized key is an error.** A typo'd setting that silently takes its
 *    default is how a value someone deliberately changed turns out never to have
 *    applied -- and for the auth keys, that failure is silent *and* permissive.
 * 4. **The environment wins.** Every setting in the file is also settable by
 *    environment variable, so a container deploy needs no file and an emergency
 *    lockdown needs no edit. Lists are replaced, never merged: merging leaves no
 *    way to revoke.
 */

/** How to run a coding agent: the gateway's `agent:` block, or a role's (`roles.ts`). */
export interface AgentConfig {
  /** Which driver runs the agent. One of `KNOWN_DRIVERS`. */
  driver: KnownDriver;
  command: string;
  args: readonly string[];
  /** Extra environment for the agent process. Where credentials go. */
  env: Readonly<Record<string, string>>;
  /**
   * The operator has accepted that the agent acts without asking.
   *
   * Required by `structured-cli`, which has no permission protocol, and refused
   * by every driver that does. It is a written acknowledgement rather than a
   * switch: a driver that quietly stops showing approval cards is a security
   * posture nobody chose.
   */
  unsupervised: boolean;
  /** Variable names forwarded from the gateway's environment. */
  passEnv: readonly string[];
  /** The agent's tool names that only read (spec §2.1, §8.3). */
  readOnlyTools: readonly string[];
  /** Environment names whose values are not secret, so not masked (spec §10.1). */
  maskExempt: readonly string[];
  /**
   * A role directory's `agent.native`. Unset or true, a role whose agent has a
   * renderer runs as a native agent package; false keeps its role.md and skills
   * in the task prompt (spec §2.2, plan R). The `agent:` block has no such key:
   * its role has no role.md and no skills to render.
   */
  native?: boolean;
}

export interface GatewayConfig {
  /** SQLite path. Its directory holds the WAL, so it must be writable. */
  dbPath: string;
  schemaDir: string;
  /** Where inbound attachments land. Outside the workspace, deliberately. */
  downloadDir: string;
  /** The file the settings came from, or undefined if the environment alone. */
  configPath: string | undefined;
  /** The directory the config, database, downloads and roles live under. */
  home: string;

  lark: {
    appId: string;
    appSecret: string;
    domain?: string;
  };

  auth: {
    ownerOpenId: string;
    allowTalk: readonly string[];
    allowOperate: readonly string[];
    allowChats: readonly string[];
    allowDirectMessages: boolean;
    allowMentionAll: boolean;
  };

  /** The `agent:` block or `MT_AGENT_*` variables, if either is present. Absent means a role directory must supply the role `default` (`team.ts`). */
  agent: AgentConfig | undefined;

  /** Workspace name → declared absolute path; checked on disk by `workspaces.ts`. Always has `default`. */
  workspaces: Readonly<Record<string, string>>;
  /** The workspaces whose tasks each get their own directory (spec §18), by name; absent, none. */
  isolated?: Readonly<Record<string, IsolatedWorkspace>>;

  maxLiveSessions: number;

  /** The board's dispatcher and breaker (spec §6, §8). */
  kanban: KanbanSettings;
}

/**
 * A workspace written as `{ path, isolated: true }` (spec §18): each of its tasks
 * gets a directory of its own, so its tasks run side by side.
 */
export interface IsolatedWorkspace {
  /**
   * Where a task with no parents starts, in a git workspace: a branch, a tag or a
   * commit. Unset, whatever the workspace's directory has checked out when the
   * task's directory is made.
   */
  base?: string;
}

/**
 * The `kanban:` section (spec §6, §8). Its keys are spelled as the spec spells
 * them, in snake_case -- `max_running`, `failure_limit` -- while the rest of the
 * file is camelCase. File only: `MT_KANBAN_*` names are a run's own environment
 * (spec §7.2), and a gateway setting under the same prefix would read as one of
 * them.
 */
export interface KanbanSettings {
  /** Run the dispatcher. Off until the board can be used (spec §12). */
  enabled: boolean;
  /** Open agent runs at once. Default `maxLiveSessions`, and never above it (spec §6.3). */
  maxRunning: number;
  /**
   * Open agent runs as any one role at once, for a role whose config.yaml sets
   * no `max_running` of its own; absent, such a role has no limit of its own.
   * Never above `maxRunning` (spec §6.3).
   */
  maxRunningPerRole?: number;
  /** Where `maxRunning` came from when the file does not set it: the session limit it defaults to. */
  maxRunningFrom?: SessionLimitSource;
  /** Counted failures that block a task as gave_up (spec §8.2). */
  failureLimit: number;
  /** Throttled runs in a row that block a task as transient (spec §8.2). */
  transientLimit: number;
  /** The first cooldown after a throttled run, doubling each time (spec §8.2). */
  transientCooldownS: number;
  /** A run's wall-clock limit, unless its task sets one (spec §8.5). */
  defaultMaxRuntimeS: number;
  /** How often the sweep runs: runtime limits, cooldowns, stranded tasks (spec §6.1). */
  sweepIntervalS: number;
  /** How long a task nobody can be given waits before it is reported stranded (spec §4.2). */
  strandedAfterS: number;
  /** Reminders sent to a run whose turn ended without a report, before it is a protocol violation (spec §7.5). */
  nudgeLimit: number;
  /**
   * Blocks of the same kind in a row, unblocked in between, at which a blocked
   * notice stops inviting another unblock and suggests rewriting the task (spec §5.4).
   */
  blockRecurrenceLimit: number;
}

/** The setting the session limit came from. */
export type SessionLimitSource = 'MT_MAX_LIVE_SESSIONS' | 'maxLiveSessions';

/**
 * The session limit and `kanban.max_running`, worked out once for `loadConfig`
 * and `teamSettingsFrom`: the session limit from MT_MAX_LIVE_SESSIONS, else the
 * file, else 8; `kanban.max_running` from the file, else the session limit.
 */
function runningLimits(
  env: Env,
  file: FileConfig,
): { maxLiveSessions: number; liveName: SessionLimitSource; maxRunning: number; maxRunningFrom: SessionLimitSource | undefined } {
  const liveFromEnv = envInteger(env, 'MT_MAX_LIVE_SESSIONS');
  const maxLiveSessions = liveFromEnv ?? file.maxLiveSessions ?? 8;
  const liveName = liveFromEnv === undefined ? 'maxLiveSessions' : 'MT_MAX_LIVE_SESSIONS';
  const own = file.kanban.maxRunning;
  return own === undefined
    ? { maxLiveSessions, liveName, maxRunning: maxLiveSessions, maxRunningFrom: liveName }
    : { maxLiveSessions, liveName, maxRunning: own, maxRunningFrom: undefined };
}

export const KANBAN_DEFAULTS: Omit<KanbanSettings, 'maxRunning' | 'maxRunningFrom'> = {
  enabled: false,
  failureLimit: 2,
  transientLimit: 10,
  transientCooldownS: 300,
  defaultMaxRuntimeS: 4 * 60 * 60,
  sweepIntervalS: 60,
  strandedAfterS: 30 * 60,
  nudgeLimit: 2,
  blockRecurrenceLimit: 2,
};

/** The section's numeric keys, as the file spells them, and the setting each sets. */
const KANBAN_NUMBERS = {
  max_running: 'maxRunning',
  max_running_per_role: 'maxRunningPerRole',
  failure_limit: 'failureLimit',
  transient_limit: 'transientLimit',
  transient_cooldown_s: 'transientCooldownS',
  default_max_runtime_s: 'defaultMaxRuntimeS',
  sweep_interval_s: 'sweepIntervalS',
  stranded_after_s: 'strandedAfterS',
  nudge_limit: 'nudgeLimit',
  block_recurrence_limit: 'blockRecurrenceLimit',
} as const;

/**
 * The most each numeric key may be. Two are bounds the code needs: above
 * setInterval's limit (about 24.8 days) Node fires the sweep's timer every
 * millisecond, and endRun caps a cooldown at an hour, so a longer first cooldown
 * would never apply. The rest are past any sane setting, so a slipped digit is an
 * error at startup rather than a board that never gives up or never notices.
 */
const KANBAN_MAXIMA: Readonly<Record<keyof typeof KANBAN_NUMBERS, number>> = {
  max_running: 256,
  max_running_per_role: 256,
  failure_limit: 100,
  transient_limit: 1000,
  transient_cooldown_s: 3600,
  default_max_runtime_s: 7 * 24 * 60 * 60,
  sweep_interval_s: 3600,
  stranded_after_s: 30 * 24 * 60 * 60,
  nudge_limit: 10,
  block_recurrence_limit: 100,
};

/** The numeric keys for which 0 is a setting: no reminder at all before a run that stopped without reporting is ended. */
const KANBAN_ZERO_ALLOWED: ReadonlySet<string> = new Set(['nudge_limit']);

/**
 * What `loadTeam` and the `mt` commands need: where the gateway's files are, the
 * workspaces, and the legacy agent block. No Lark settings and no owner, so an
 * operator can create a role from a shell that holds no gateway credentials.
 */
export interface TeamSettings {
  home: string;
  /** The file read, or undefined for an environment-only deployment. */
  configPath: string | undefined;
  dbPath: string;
  /**
   * `kanban.enabled` as the config sets it, absent when it does not (the board is
   * then off): so the operator's `mt kanban` can say the board is off, and why.
   */
  kanbanEnabled?: boolean;
  /** Workspace name → declared absolute path. Always has `default`. */
  workspaces: Readonly<Record<string, string>>;
  /** The isolated workspaces (spec §18), by name; absent when there are none. */
  isolated?: Readonly<Record<string, IsolatedWorkspace>>;
  agent: AgentConfig | undefined;
  /**
   * The limits a role's own `max_running` is checked against, and the default it
   * overrides (spec §6.3). Absent -- settings a test builds by hand -- a role's is
   * not bounded.
   */
  kanban?: RoleLimits;
}

/** What `loadTeam` and `mt role` need of the `kanban:` section: the gateway's limit, where it came from, and every role's default. */
export type RoleLimits = Pick<KanbanSettings, 'maxRunning' | 'maxRunningFrom' | 'maxRunningPerRole'>;

/**
 * `kanban.max_running` as a refusal names it: alone when the file sets it, else
 * with the session limit it defaulted to, `kanban.max_running (2, from MT_MAX_LIVE_SESSIONS)`.
 */
export function maxRunningText(limits: RoleLimits): string {
  const from = limits.maxRunningFrom === undefined ? '' : `, from ${limits.maxRunningFrom}`;
  return `kanban.max_running (${limits.maxRunning}${from})`;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads a config file, or reports that there isn't one.
 *
 * Injectable so the merge rules can be tested without a filesystem, and so a test
 * can assert *which* path was read -- the default location is derived, and a loader
 * that silently reads the wrong file is indistinguishable from one whose settings
 * are being ignored.
 */
export type FileReader = (path: string) => string | undefined;

const readIfPresent: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
};

export function loadConfig(
  env: Env = process.env,
  readFile: FileReader = readIfPresent,
): GatewayConfig {
  const located = locate(env, readFile);
  const { file } = located;

  const ownerOpenId =
    envString(env, 'MT_OWNER_OPEN_ID') ??
    file.auth.owner ??
    fail('an owner is required: set auth.owner in the config file, or MT_OWNER_OPEN_ID');
  const team = teamSettingsFrom(env, located);

  const allowTalk = envList(env, 'MT_ALLOW_TALK') ?? file.auth.talk;
  const allowOperate = envList(env, 'MT_ALLOW_OPERATE') ?? file.auth.operate;
  const { maxLiveSessions, liveName, maxRunning, maxRunningFrom } = runningLimits(env, file);
  if (maxRunning > maxLiveSessions) {
    // A run is a session, and its actor is pinned while it is open (spec §6.3):
    // more runs than live sessions would hold the gateway over its cap.
    throw new ConfigError(
      `${located.path}: kanban.max_running (${maxRunning}) is above ${liveName} (${maxLiveSessions}); ` +
        'a run is a live session, so the two limits must not disagree',
    );
  }

  return {
    dbPath: team.dbPath,
    // Not settable from the file: it locates the migrations that belong to this
    // build, which is a packaging concern rather than an operational one.
    schemaDir: envString(env, 'MT_SCHEMA_DIR') ?? BUNDLED_SCHEMA_DIR,
    downloadDir: envString(env, 'MT_DOWNLOAD_DIR') ?? file.downloads ?? join(located.home, 'downloads'),
    configPath: team.configPath,
    home: team.home,

    lark: {
      appId:
        envString(env, 'LARK_APP_ID') ??
        file.lark.appId ??
        fail('an app id is required: set lark.appId in the config file, or LARK_APP_ID'),
      // The environment or the gateway's .env, and refused in the config file.
      // See the note at the top.
      appSecret:
        envString(env, 'LARK_APP_SECRET') ??
        fail(`LARK_APP_SECRET is required: set it in ${join(located.home, '.env')} (mode 0600), or in the environment`),
      ...domainOf(envString(env, 'LARK_DOMAIN') ?? file.lark.domain),
    },

    auth: {
      ownerOpenId,
      // The owner is always included. An allowlist that excludes the owner locks
      // out the only person who can fix it, and it is not editable from chat.
      allowTalk: unique([ownerOpenId, ...allowTalk]),
      allowOperate: unique([ownerOpenId, ...allowOperate]),
      allowChats: envList(env, 'MT_ALLOW_CHATS') ?? file.auth.chats,
      allowDirectMessages: envFlag(env, 'MT_ALLOW_DM') ?? file.auth.directMessages ?? true,
      // Default false. `@all` is a room-wide notification, not an instruction, and
      // treating it as one makes the bot answer announcements.
      allowMentionAll: envFlag(env, 'MT_ALLOW_MENTION_ALL') ?? file.auth.mentionAll ?? false,
    },

    agent: team.agent,

    workspaces: team.workspaces,
    ...(team.isolated === undefined ? {} : { isolated: team.isolated }),
    maxLiveSessions,
    kanban: {
      enabled: file.kanban.enabled ?? KANBAN_DEFAULTS.enabled,
      maxRunning,
      ...(maxRunningFrom === undefined ? {} : { maxRunningFrom }),
      ...(file.kanban.maxRunningPerRole === undefined ? {} : { maxRunningPerRole: file.kanban.maxRunningPerRole }),
      failureLimit: file.kanban.failureLimit ?? KANBAN_DEFAULTS.failureLimit,
      transientLimit: file.kanban.transientLimit ?? KANBAN_DEFAULTS.transientLimit,
      transientCooldownS: file.kanban.transientCooldownS ?? KANBAN_DEFAULTS.transientCooldownS,
      defaultMaxRuntimeS: file.kanban.defaultMaxRuntimeS ?? KANBAN_DEFAULTS.defaultMaxRuntimeS,
      sweepIntervalS: file.kanban.sweepIntervalS ?? KANBAN_DEFAULTS.sweepIntervalS,
      strandedAfterS: file.kanban.strandedAfterS ?? KANBAN_DEFAULTS.strandedAfterS,
      nudgeLimit: file.kanban.nudgeLimit ?? KANBAN_DEFAULTS.nudgeLimit,
      blockRecurrenceLimit: file.kanban.blockRecurrenceLimit ?? KANBAN_DEFAULTS.blockRecurrenceLimit,
    },
  };
}

interface Located {
  home: string;
  path: string;
  text: string | undefined;
  file: FileConfig;
}

/** The directory the gateway's files live under: MT_HOME, else ~/.manus-team. */
export function gatewayHome(env: Env): string {
  return envString(env, 'MT_HOME') ?? join(homedir(), '.manus-team');
}

function locate(env: Env, readFile: FileReader): Located {
  const home = gatewayHome(env);
  const explicit = envString(env, 'MT_CONFIG');
  const path = explicit ?? join(home, 'config.yaml');

  const text = readFile(path);
  if (text === undefined && explicit !== undefined) {
    // A named file that is not there is a mistake; the default location being
    // absent is an ordinary environment-only deployment.
    throw new ConfigError(`MT_CONFIG points at ${path}, which does not exist`);
  }
  const file = text === undefined ? emptyFile() : parseFile(path, text);
  return { home, path, text, file };
}

function teamSettingsFrom(env: Env, { home, path, text, file }: Located, opts: LoadOptions = {}): TeamSettings {
  const single = envString(env, 'MT_WORKSPACE') ?? file.workspace;
  if (single !== undefined && file.workspaces['default'] !== undefined) {
    throw new ConfigError(
      'workspaces.default and workspace (or MT_WORKSPACE) are both set: keep only workspaces.default',
    );
  }
  const workspaces: Record<string, string> = {
    ...file.workspaces,
    ...(single === undefined ? {} : { default: single }),
  };
  const defaultWorkspace =
    workspaces['default'] ??
    fail('a workspace is required: set workspaces.default, or workspace in the config file, or MT_WORKSPACE');
  if (!isAbsolute(defaultWorkspace)) {
    // Relative resolves against the gateway's cwd, which is whatever the service
    // manager set. The workspace would then depend on how the process was launched.
    // A value from the environment is named, not quoted: errors from it never echo it.
    throw new ConfigError(
      envString(env, 'MT_WORKSPACE') !== undefined
        ? 'MT_WORKSPACE must be an absolute path, and is relative'
        : `the workspace must be an absolute path, got ${JSON.stringify(defaultWorkspace)}`,
    );
  }

  // The agent block is optional: a role directory may define the role default
  // instead (team.ts). An MT_AGENT_* variable alone counts as configuring it.
  const agentVariables = [
    ...AGENT_OVERRIDES.filter(
      (key) => envString(env, key) !== undefined,
    ),
    ...Object.keys(env)
      .filter(
        (key) => key.startsWith(AGENT_ENV_PREFIX) && key.length > AGENT_ENV_PREFIX.length && env[key] !== undefined,
      )
      .sort(),
  ];
  if (!file.agentPresent && agentVariables.length > 0 && envString(env, 'MT_AGENT_COMMAND') === undefined) {
    // Variables alone, and no command. Whether roles/default exists is not known
    // here, and the two cases need opposite advice: a stray variable next to a
    // role directory should go, while adding a command there only trades this
    // error for the "both define the role default" one. Names only, never values.
    throw new ConfigError(
      `${agentVariables.join(', ')} ${agentVariables.length === 1 ? 'is' : 'are'} set but MT_AGENT_COMMAND is not. ` +
        `MT_AGENT_* variables define the role default: if ${join(home, 'roles', 'default')} exists, ` +
        'unset them; otherwise also set MT_AGENT_COMMAND',
    );
  }
  const agent = file.agentPresent || agentVariables.length > 0 ? legacyAgent(env, file, opts) : undefined;
  const { maxRunning, maxRunningFrom } = runningLimits(env, file);
  const limits: RoleLimits = {
    maxRunning,
    ...(maxRunningFrom === undefined ? {} : { maxRunningFrom }),
    ...(file.kanban.maxRunningPerRole === undefined ? {} : { maxRunningPerRole: file.kanban.maxRunningPerRole }),
  };
  const perRole = limits.maxRunningPerRole;
  if (perRole !== undefined && perRole > maxRunning) {
    // As a board's own max_running is held inside the gateway's (spec §16.6).
    throw new ConfigError(
      `${path}: kanban.max_running_per_role (${perRole}) is above ${maxRunningText(limits)}; ` +
        "a role's runs are agent runs, so its limit is a whole number from 1 to the gateway's",
    );
  }
  return {
    home,
    configPath: text === undefined ? undefined : path,
    dbPath: envString(env, 'MT_DB') ?? file.db ?? join(home, 'team.db'),
    ...(file.kanban.enabled === undefined ? {} : { kanbanEnabled: file.kanban.enabled }),
    workspaces,
    ...(Object.keys(file.isolated).length === 0 ? {} : { isolated: file.isolated }),
    agent,
    kanban: limits,
  };
}

/** The team half of the configuration, for `loadTeam` and the `mt` commands. */
export function loadTeamSettings(
  env: Env = process.env,
  readFile: FileReader = readIfPresent,
  opts: LoadOptions = {},
): TeamSettings {
  return teamSettingsFrom(env, locate(env, readFile), opts);
}

/** The legacy `agent:` block, with its `MT_AGENT_*` overrides applied. */
function legacyAgent(env: Env, file: FileConfig, opts: LoadOptions = {}): AgentConfig {
  const fromEnv = envString(env, 'MT_AGENT_COMMAND');
  const command =
    fromEnv ??
    file.agent.command ??
    fail('an agent command is required: set agent.command in the config file, or MT_AGENT_COMMAND');
  checkCommand(command, fromEnv === undefined ? undefined : 'MT_AGENT_COMMAND');
  const argsFromEnv = envString(env, 'MT_AGENT_ARGS');
  const args = argsFromEnv === undefined ? file.agent.args : shellWords(argsFromEnv);
  const driverFromEnv = envString(env, 'MT_AGENT_DRIVER');
  const driver =
    driverFromEnv === undefined ? driverOf(file.agent.driver ?? 'acp') : driverOf(driverFromEnv, 'MT_AGENT_DRIVER');
  const unsupervised = envFlag(env, 'MT_AGENT_UNSUPERVISED') ?? file.agent.unsupervised ?? false;
  requireSupervisionMatch(driver, unsupervised);
  return {
    driver,
    command,
    args,
    // The MT_/LARK_ refusal still applies to every name: passEnvValues checks it first.
    env: agentEnv(
      opts.unsetPassEnv === undefined
        ? env
        : withUnsetRecorded('default', env, file.agent.passEnv, opts.unsetPassEnv),
      file.agent.passEnv,
    ),
    unsupervised,
    passEnv: file.agent.passEnv,
    readOnlyTools: file.agent.readOnlyTools,
    maskExempt: file.agent.maskExempt,
  };
}

/**
 * `command: bytesec acp` is a subcommand written where the binary goes. The agent
 * is spawned with `shell: false`, so this asks for a file whose name contains a
 * space and fails as an ENOENT at the first prompt -- long after boot, and
 * reported as the agent not starting rather than as a typo here. Absolute paths
 * are exempt: `/Applications/My App/bin/agent` is a real thing.
 *
 * `variable` names the environment variable the command came from, which the
 * error then names instead of quoting the command: an error never echoes a
 * value read from the environment.
 */
export function checkCommand(command: string, variable?: string): void {
  if (!/\s/.test(command) || isAbsolute(command)) return;
  if (variable !== undefined) {
    throw new ConfigError(
      `${variable} contains a space, and is not a path. Arguments belong in MT_AGENT_ARGS. ` +
        'Use an absolute path if the binary really is named that.',
    );
  }
  const [first = '', ...rest] = command.split(/\s+/);
  throw new ConfigError(
    `the agent command ${JSON.stringify(command)} contains a space, and is not a path. ` +
      `Arguments belong in agent.args: command: ${first}, args: [${rest.join(', ')}]. ` +
      'Use an absolute path if the binary really is named that.',
  );
}

// ---------------------------------------------------------------------------
// Which driver, and on what terms
// ---------------------------------------------------------------------------

/** `variable`, when the value came from the environment, is named instead of the value. */
export function driverOf(value: string, variable?: string): KnownDriver {
  if ((KNOWN_DRIVERS as readonly string[]).includes(value)) return value as KnownDriver;
  throw new ConfigError(
    variable === undefined
      ? `agent.driver must be one of ${KNOWN_DRIVERS.join(', ')}, got ${JSON.stringify(value)}`
      : `${variable} must be one of ${KNOWN_DRIVERS.join(', ')}`,
  );
}

/**
 * Drivers that cannot ask before acting.
 *
 * Listed here rather than discovered from the driver, because this has to be
 * decided at boot and getting it wrong is not recoverable later: by the time a
 * driver could report "I have no permission protocol", the agent has already run.
 */
const UNSUPERVISED_DRIVERS: readonly KnownDriver[] = ['structured-cli'];

/**
 * The driver's supervision and the operator's acknowledgement have to agree.
 *
 * Both directions are errors. A driver with no approvals that nobody signed off on
 * would silently stop showing approval cards -- the `operate` tier would still read
 * as enforced in the config while enforcing nothing. And an acknowledgement next to
 * a driver that *does* ask describes a system that is not the one running, which is
 * how a config comes to be trusted for something it never said.
 */
export function requireSupervisionMatch(driver: KnownDriver, unsupervised: boolean): void {
  const needed = UNSUPERVISED_DRIVERS.includes(driver);
  if (needed && !unsupervised) {
    throw new ConfigError(
      `the ${driver} driver runs the agent through its command line, which has no way to ` +
        'ask for permission: it will edit files and run commands without an approval card, ' +
        'and the operate allowlist will no longer gate tool use. Set agent.unsupervised: true ' +
        'to accept that, or use the acp driver, which asks.',
    );
  }
  if (!needed && unsupervised) {
    throw new ConfigError(
      `agent.unsupervised has no meaning for the ${driver} driver, which asks before acting. ` +
        'Remove it, so the file does not claim a posture the gateway is not in.',
    );
  }
}

// ---------------------------------------------------------------------------
// The agent's environment
// ---------------------------------------------------------------------------

/**
 * `MT_AGENT_ENV_FOO=bar` becomes `FOO=bar` for the agent.
 *
 * Opt-in by prefix rather than by pass-through, because forwarding the gateway's
 * whole environment would hand the agent the Feishu app secret -- the one
 * credential it must never hold, since an agent with it can post as the bot and
 * answer its own approval requests.
 */
export const AGENT_ENV_PREFIX = 'MT_AGENT_ENV_';

/** The `MT_AGENT_*` variables that override a field of the `agent:` block. */
export const AGENT_OVERRIDES = ['MT_AGENT_COMMAND', 'MT_AGENT_ARGS', 'MT_AGENT_DRIVER', 'MT_AGENT_UNSUPERVISED'] as const;

/**
 * Every variable the gateway reads its own settings from, but for the
 * `MT_AGENT_ENV_<NAME>` family: the names its `.env` may hold (`gateway-env.ts`),
 * less the three that say where its files are. A name read here and missing from
 * this list is refused in that file; tests/gateway-env.test.ts checks the two agree.
 */
export const GATEWAY_ENV_NAMES = [
  'MT_HOME',
  'MT_CONFIG',
  'MT_DB',
  'MT_SCHEMA_DIR',
  'MT_DOWNLOAD_DIR',
  'MT_WORKSPACE',
  'MT_OWNER_OPEN_ID',
  'MT_ALLOW_TALK',
  'MT_ALLOW_OPERATE',
  'MT_ALLOW_CHATS',
  'MT_ALLOW_DM',
  'MT_ALLOW_MENTION_ALL',
  'MT_MAX_LIVE_SESSIONS',
  ...AGENT_OVERRIDES,
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  'LARK_DOMAIN',
] as const;

/** Values for `passEnv` names, from the gateway's environment. `where` prefixes the errors. */
export function passEnvValues(
  env: Env,
  passEnv: readonly string[],
  where: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of passEnv) {
    if (name.startsWith('MT_') || name.startsWith('LARK_')) {
      // The gateway's own configuration, and in the Lark case its identity. An
      // agent holding those can reconfigure or impersonate the gateway.
      throw new ConfigError(`${where} must not forward ${name}: it belongs to the gateway`);
    }
    const value = env[name];
    if (value === undefined || value === '') {
      throw new ConfigError(`${where} names ${name}, which is not set in the environment`);
    }
    out[name] = value;
  }
  return out;
}

/** How strictly the team is loaded. */
export interface LoadOptions {
  /**
   * When given, a `passEnv` name that is not set is recorded here as `role: NAME`
   * instead of failing. `mt role check` reports this shell's environment apart
   * from the files (spec §2.6); the other `mt` commands need only names and paths.
   * The gateway itself never passes it.
   */
  unsetPassEnv?: string[];
}

/** `env`, with each unset `passEnv` name recorded in `unset` and given a placeholder. */
export function withUnsetRecorded(role: string, env: Env, passEnv: readonly string[], unset: string[]): Env {
  const filled: Record<string, string | undefined> = { ...env };
  for (const key of passEnv) {
    const value = env[key];
    if (value === undefined || value === '') {
      unset.push(`${role}: ${key}`);
      filled[key] = '(unset)';
    }
  }
  return filled;
}

/**
 * Names the gateway may forward verbatim, listed in the file as `agent.passEnv`.
 *
 * The file names the variable; the value still comes from the environment. This
 * exists because the prefixed spelling has to be typed twice -- once where the
 * credential already lives, once with the prefix -- and a typo in the second copy
 * forwards nothing at all, which surfaces much later as the agent failing to
 * authenticate. A declared name that is not set is therefore an error here.
 */
function agentEnv(env: Env, passEnv: readonly string[]): Record<string, string> {
  const out = passEnvValues(env, passEnv, 'agent.passEnv');

  // Prefixed values are applied second, so a variable set explicitly for the agent
  // overrides the one the gateway happens to be running with.
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(AGENT_ENV_PREFIX) || value === undefined) continue;
    const name = key.slice(AGENT_ENV_PREFIX.length);
    if (name === '') continue;
    out[name] = value;
  }

  return out;
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

interface FileConfig {
  workspace: string | undefined;
  workspaces: Record<string, string>;
  isolated: Record<string, IsolatedWorkspace>;
  db: string | undefined;
  downloads: string | undefined;
  maxLiveSessions: number | undefined;
  lark: { appId: string | undefined; domain: string | undefined };
  auth: {
    owner: string | undefined;
    talk: readonly string[];
    operate: readonly string[];
    chats: readonly string[];
    directMessages: boolean | undefined;
    mentionAll: boolean | undefined;
  };
  agentPresent: boolean;
  agent: {
    driver: string | undefined;
    command: string | undefined;
    args: readonly string[];
    passEnv: readonly string[];
    unsupervised: boolean | undefined;
    readOnlyTools: readonly string[];
    maskExempt: readonly string[];
  };
  kanban: { enabled?: boolean } & Partial<Record<(typeof KANBAN_NUMBERS)[keyof typeof KANBAN_NUMBERS], number>>;
}

function emptyFile(): FileConfig {
  return {
    workspace: undefined,
    workspaces: {},
    isolated: {},
    db: undefined,
    downloads: undefined,
    maxLiveSessions: undefined,
    lark: { appId: undefined, domain: undefined },
    auth: {
      owner: undefined,
      talk: [],
      operate: [],
      chats: [],
      directMessages: undefined,
      mentionAll: undefined,
    },
    agentPresent: false,
    agent: {
      driver: undefined,
      command: undefined,
      args: [],
      passEnv: [],
      unsupervised: undefined,
      readOnlyTools: [],
      maskExempt: [],
    },
    kanban: {},
  };
}

/**
 * Keys that would mean a credential is sitting in the file.
 *
 * Matched on the name with separators removed, so `app_secret`, `appSecret` and
 * `APP-SECRET` are all caught. Refusing is the point: accepting the value would
 * work, which is exactly why nobody would notice the file had become a secret
 * store until it was in a backup or a commit.
 */
const SECRET_KEY = /secret|password|passwd|token|credential|apikey|privatekey/i;

function parseFile(path: string, text: string): FileConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${path} is not valid YAML: ${(err as Error).message}`);
  }
  // An empty file is a legitimate starting point, and YAML parses it as null.
  if (parsed === null || parsed === undefined) return emptyFile();
  const root = section(path, '', parsed);

  const out = emptyFile();
  const larkRaw = subsection(path, root, 'lark');
  const authRaw = subsection(path, root, 'auth');
  const agentRaw = subsection(path, root, 'agent');
  const kanbanRaw = subsection(path, root, 'kanban');

  reject(path, '', root, [
    'workspace',
    'workspaces',
    'db',
    'downloads',
    'maxLiveSessions',
    'lark',
    'auth',
    'agent',
    'kanban',
  ]);
  reject(path, 'lark', larkRaw, ['appId', 'domain']);
  reject(path, 'auth', authRaw, [
    'owner',
    'talk',
    'operate',
    'chats',
    'directMessages',
    'mentionAll',
  ]);
  reject(path, 'agent', agentRaw, [
    'driver',
    'command',
    'args',
    'passEnv',
    'unsupervised',
    'readOnlyTools',
    'maskExempt',
  ]);
  reject(path, 'kanban', kanbanRaw, ['enabled', ...Object.keys(KANBAN_NUMBERS)]);

  out.workspace = str(path, 'workspace', root['workspace']);
  const workspaces = workspaceEntries(path, root['workspaces']);
  out.workspaces = workspaces.paths;
  out.isolated = workspaces.isolated;
  out.agentPresent = root['agent'] !== undefined && root['agent'] !== null;
  out.db = str(path, 'db', root['db']);
  out.downloads = str(path, 'downloads', root['downloads']);
  out.maxLiveSessions = positiveInt(path, 'maxLiveSessions', root['maxLiveSessions']);

  out.lark = {
    appId: str(path, 'lark.appId', larkRaw['appId']),
    domain: str(path, 'lark.domain', larkRaw['domain']),
  };

  out.auth = {
    owner: str(path, 'auth.owner', authRaw['owner']),
    talk: strings(path, 'auth.talk', authRaw['talk']),
    operate: strings(path, 'auth.operate', authRaw['operate']),
    chats: strings(path, 'auth.chats', authRaw['chats']),
    directMessages: bool(path, 'auth.directMessages', authRaw['directMessages']),
    mentionAll: bool(path, 'auth.mentionAll', authRaw['mentionAll']),
  };

  out.agent = {
    driver: str(path, 'agent.driver', agentRaw['driver']),
    command: str(path, 'agent.command', agentRaw['command']),
    args: agentArgs(path, agentRaw['args']),
    passEnv: strings(path, 'agent.passEnv', agentRaw['passEnv']),
    unsupervised: bool(path, 'agent.unsupervised', agentRaw['unsupervised']),
    readOnlyTools: strings(path, 'agent.readOnlyTools', agentRaw['readOnlyTools']),
    maskExempt: strings(path, 'agent.maskExempt', agentRaw['maskExempt']),
  };

  const enabled = bool(path, 'kanban.enabled', kanbanRaw['enabled']);
  if (enabled !== undefined) out.kanban.enabled = enabled;
  for (const [key, setting] of Object.entries(KANBAN_NUMBERS)) {
    const n = KANBAN_ZERO_ALLOWED.has(key)
      ? wholeNumber(path, `kanban.${key}`, kanbanRaw[key])
      : positiveInt(path, `kanban.${key}`, kanbanRaw[key]);
    if (n === undefined) continue;
    const max = KANBAN_MAXIMA[key as keyof typeof KANBAN_NUMBERS];
    if (n > max) throw new ConfigError(`${path}: kanban.${key} must be at most ${max}, got ${n}`);
    out.kanban[setting] = n;
  }

  return out;
}

/** Reject unknown keys, and any key that means a credential is in the file. */
export function reject(
  path: string,
  prefix: string,
  values: Record<string, unknown>,
  known: readonly string[],
  hints: { secret: string; env: string } = {
    secret:
      'Set it in the environment instead (LARK_APP_SECRET for the app secret, ' +
      'MT_AGENT_ENV_* for the agent, or name it in agent.passEnv).',
    env: 'List the variable names in agent.passEnv, or set MT_AGENT_ENV_<NAME> in the environment.',
  },
): void {
  const flat = (key: string): string => (prefix === '' ? key : `${prefix}.${key}`);
  for (const key of Object.keys(values)) {
    if (SECRET_KEY.test(key.replace(/[-_]/g, ''))) {
      throw new ConfigError(
        `${path}: ${flat(key)} looks like a credential, and the config file must not hold one. ` +
          hints.secret,
      );
    }
    if (key === 'env') {
      throw new ConfigError(
        `${path}: ${flat(key)} would put values in the file. ${hints.env}`,
      );
    }
    if (!known.includes(key)) {
      throw new ConfigError(`${path}: unknown setting ${flat(key)} (known: ${known.join(', ')})`);
    }
  }
}

export function section(path: string, prefix: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path}: ${prefix === '' ? 'the file' : prefix} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

export function subsection(
  path: string,
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = root[key];
  if (value === undefined || value === null) return {};
  return section(path, key, value);
}

export function str(path: string, key: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${path}: ${key} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * A base as git names one: no leading `-`, which git would read as an option, and
 * no space, no control character (C0 or C1) and no bidi control, which would make
 * it read as other than it is.
 */
const BASE_REF = new RegExp(`^(?!-)(?:(?!${BIDI.source})[^\\s\\u0000-\\u001f\\u007f-\\u009f])+$`);

/**
 * `workspaces:`, each a path, or a mapping `{ path, isolated, base }` (spec §18):
 * the paths, and the workspaces whose tasks each get a directory of their own.
 * `isolated: false` is the same as the plain path; `base` needs `isolated: true`.
 */
function workspaceEntries(
  path: string,
  value: unknown,
): { paths: Record<string, string>; isolated: Record<string, IsolatedWorkspace> } {
  const paths: Record<string, string> = {};
  const isolated: Record<string, IsolatedWorkspace> = {};
  if (value === undefined || value === null) return { paths, isolated };
  for (const [name, entry] of Object.entries(section(path, 'workspaces', value))) {
    const key = `workspaces.${name}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      const text = str(path, key, entry);
      if (text !== undefined) paths[name] = text;
      continue;
    }
    const fields = section(path, key, entry);
    reject(path, key, fields, ['path', 'isolated', 'base']);
    const dir = str(path, `${key}.path`, fields['path']);
    if (dir === undefined) throw new ConfigError(`${path}: ${key}.path is required when the workspace is a mapping`);
    paths[name] = dir;
    const on = bool(path, `${key}.isolated`, fields['isolated']) ?? false;
    const base = str(path, `${key}.base`, fields['base']);
    if (base !== undefined && !on) {
      throw new ConfigError(`${path}: ${key}.base applies only to an isolated workspace: set ${key}.isolated to true, or remove it`);
    }
    if (base !== undefined && !BASE_REF.test(base)) {
      throw new ConfigError(`${path}: ${key}.base must be a branch, a tag or a commit, got ${JSON.stringify(base)}`);
    }
    if (on) isolated[name] = base === undefined ? {} : { base };
  }
  return { paths, isolated };
}

export function strings(path: string, key: string, value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${path}: ${key} must be a list`);
  return unique(
    value.map((entry, i) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new ConfigError(`${path}: ${key}[${i}] must be a non-empty string`);
      }
      return entry.trim();
    }),
  );
}

export function bool(path: string, key: string, value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${path}: ${key} must be true or false, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function positiveInt(path: string, key: string, value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${path}: ${key} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function wholeNumber(path: string, key: string, value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${path}: ${key} must be a whole number, 0 or more, got ${JSON.stringify(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

/** Absent and empty are the same mistake: an empty app secret connects and hangs. */
function envString(env: Env, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

/**
 * A comma-separated list, replacing whatever the file said.
 *
 * `MT_ALLOW_TALK=` -- set but empty -- is a deliberate "nobody but the owner",
 * which is why it returns an empty list rather than falling through to the file.
 */
function envList(env: Env, key: string): readonly string[] | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  return unique(
    raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== ''),
  );
}

function envFlag(env: Env, key: string): boolean | undefined {
  const value = envString(env, key);
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  // Not defaulted. A typo'd flag silently taking its default is how a setting
  // someone deliberately changed turns out never to have applied.
  throw new ConfigError(`${key}: expected a boolean (true or false, 1 or 0, yes or no, on or off)`);
}

function envInteger(env: Env, key: string): number | undefined {
  const value = envString(env, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${key} must be a positive integer`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------

function domainOf(domain: string | undefined): { domain?: string } {
  return domain === undefined ? {} : { domain };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function fail(message: string): never {
  throw new ConfigError(message);
}

/** `agent.args`: a list, or one string split like a shell would, because `args: --acp --debug` is what people write. */
export function agentArgs(path: string, raw: unknown): readonly string[] {
  return Array.isArray(raw) ? strings(path, 'agent.args', raw) : shellWords(str(path, 'agent.args', raw) ?? '');
}

/**
 * Split an argument string on whitespace, honouring quotes.
 *
 * Not a shell. The agent is spawned with `shell: false`, so this must not pretend
 * to support expansion -- accepting `$(...)` here and dropping it there is the kind
 * of half-support that looks like it works until it silently does not.
 */
export function shellWords(value: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return out;
}
