import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ConfigError, loadConfig, type Env, type GatewayConfig } from './config.js';
import { loadGatewayEnv, type GatewayEnvFile } from './gateway-env.js';
import { loadTeam, teamSecrets, type Team } from './team.js';
import { SchemaTooNewError, migrate, openDb, type Db } from './db/open.js';
import { sweepSeen } from './db/dedup.js';
import { registerWorkspaces, worktreeOf } from './db/workspaces.js';
import { LarkAdapter } from './channel/lark/adapter.js';
import { LarkInbound } from './channel/lark/inbound.js';
import { buildRoleDrivers } from './driver/build.js';
import { buildEnv } from './driver/env.js';
import { Authorizer, tiersOf } from './policy/auth.js';
import { AuthChat } from './policy/auth-chat.js';
import { Router } from './core/router.js';
import { rolesReply } from './core/roles-chat.js';
import { DEFAULT_ROLE, DEFAULT_WORKSPACE, SessionRegistry, type BootFinding } from './core/registry.js';
import { NamedWorkspaces } from './core/workspace.js';
import { BOOT_ID, replyUuid } from './core/ids.js';
import type { BindingKey } from './types.js';
import { systemClock } from './time.js';
import { addSecrets, redactKnownSecrets } from './secrets.js';
import { KanbanChat } from './kanban/chat.js';
import { Dispatcher } from './kanban/dispatcher.js';
import { Notifier } from './kanban/notices.js';
import { UnblockRedraws } from './kanban/unblock-redraw.js';
import { KanbanService } from './kanban/service.js';
import { SESSION_MARKER } from './kanban/gates.js';
import { writeMtShim } from './kanban/shim.js';
import { CardPoster } from './kanban/cards.js';
import { PeopleDirectory } from './kanban/people.js';
import { KanbanSink } from './kanban/sink.js';
import { claimSocketPath, listenWorker, lockGateway, SocketHandler, workerSocketPath, type GatewayLock, type WorkerServer } from './kanban/socket.js';
import { WorkerApi } from './kanban/worker.js';
import { TaskDirectories } from './kanban/worktree.js';
import { listWorkflows, workflowLines } from './kanban/workflow.js';
import type { Channel } from './channel/types.js';
import { CronChat } from './cron/chat.js';
import { CronScheduler } from './cron/scheduler.js';
import { processZone } from './cron/schedule.js';
import { CronService } from './cron/service.js';
import { CronTokens } from './cron/tokens.js';
import { CronApi } from './cron/worker.js';
import { writeGatewayZone } from './cron/zone-file.js';
import { jobCounts } from './db/cron.js';
import { grantCounts, tierReader } from './db/grants.js';
import { deferredButtons, tasksWithWakeOn } from './db/kanban-read.js';
import type { KanbanEvent, SubscriptionRow } from './kanban/types.js';
import { Waker } from './kanban/waker.js';
import { WakeTokens } from './kanban/wake-tokens.js';
import { WakeApi } from './kanban/wake-api.js';
import { showJson, wokenShowText } from './cli/plain.js';
import type { WakeSettings } from './config.js';
import { lockDatabase } from './kanban/socket.js';
import { SinkChannel } from './kanban/sink.js';
import { PackagesInUse } from './render/native.js';

/**
 * Wiring, and the boot order.
 *
 * The order is the interesting part, and it is not arbitrary:
 *
 * 1. Open and migrate the database.
 * 2. **Reconcile** -- before the channel is connected. Reconciling after messages
 *    can arrive means racing a live turn against the code that decides what
 *    happened to the last one.
 * 3. Report what reconciliation found, to the chats that were affected. A finding
 *    nobody is told about is indistinguishable from a session that silently stopped.
 * 4. Connect.
 *
 * Shutdown runs it backwards, and drains: the last card write and the terminal
 * event both have to land, or the user is left looking at a partial answer with a
 * typing indicator on it.
 */

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly db: Db;
  /** The board's dispatcher, when `kanban.enabled` is set. */
  readonly dispatcher: Dispatcher | undefined;
  /** What delivers the board's notices to the chats that follow its tasks, when `kanban.enabled` is set. */
  readonly notifier: Notifier | undefined;
  /** What redraws a notice's message once a block it offered Unblock for is lifted, when `kanban.enabled` is set. */
  readonly unblockRedraws: UnblockRedraws | undefined;
  /** What sends people their task and review cards, when `kanban.enabled` is set. */
  readonly cards: CardPoster | undefined;
  /** `/kanban` and the board cards' buttons, when `kanban.enabled` is set. */
  readonly chat: KanbanChat | undefined;
  /** The cron scheduler, when `cron.enabled` is set. */
  readonly cron: CronScheduler | undefined;
  /** What wakes the agent for a task's outcomes, when `kanban.enabled` and `kanban.wake.enabled` are set (wake spec §5.1). */
  readonly waker: Waker | undefined;
}

/**
 * The wakes' startup line (wake spec §11), after the board's: the cap and the
 * depth with wakes on; with them off, how many tasks with wake on stay
 * notice-only; and nothing when off with none.
 */
export function wakeLine(wake: WakeSettings, withWakeOn: number): string | undefined {
  if (!wake.enabled) {
    return withWakeOn === 0 ? undefined : `kanban: wakes off (kanban.wake.enabled is false); ${withWakeOn} task(s) with wake on stay notice-only`;
  }
  return `kanban: wakes on; at most ${wake.perHour} woken turns a conversation an hour, tasks up to ${wake.maxDepth - 1} woken turns deep`;
}

/**
 * A chat session's environment (wake spec §13): the cron token's and the wake
 * token's merged, the socket and `PATH` being the same in both; nothing when
 * neither is given.
 */
export function chatEnv(
  cron: Readonly<Record<string, string>> | undefined,
  wake: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (cron === undefined && wake === undefined) return undefined;
  return { ...cron, ...wake };
}

/**
 * The cron startup line (the cron spec, §10), after the board's, or none: cron
 * off with no jobs says nothing.
 */
export function cronLine(cron: { enabled: boolean; maxRunning: number; idleTimeoutS: number; tz?: string }, counts: { active: number; paused: number }, zone: string): string | undefined {
  if (!cron.enabled) return counts.active === 0 ? undefined : `cron: off (cron.enabled is unset); ${counts.active} active job(s) do not fire`;
  return (
    `cron: ${counts.active} active job(s), ${counts.paused} paused; up to ${cron.maxRunning} fire(s) at once, ` +
    `each stopped after ${cron.idleTimeoutS} s with no activity; new jobs in ${zone} (from ${cron.tz === undefined ? "this process's zone" : 'cron.tz'}), ` +
    'and every job keeps its own zone'
  );
}

/**
 * The grants' startup lines (tier grants spec §8.4), after the schema's: how
 * many people this bot's active grants let in, by tier, and how many active
 * grants are another app id's, which count for nothing here; none of either
 * says nothing.
 */
export function grantLines(counts: { talk: number; operate: number; otherApps: number }): string[] {
  const out: string[] = [];
  if (counts.talk + counts.operate > 0) {
    out.push(`auth: ${counts.talk} person(s) granted talk and ${counts.operate} operate, beside the configuration's; mt auth list shows who`);
  }
  if (counts.otherApps > 0) out.push(`auth: ${counts.otherApps} grant(s) are for another app id than lark.appId, and count for nothing here`);
  return out;
}

/**
 * An agent session's environment as the registry is given it (tier grants spec
 * §6.3): what the dispatcher, the scheduler or the cron tokens give, with the
 * session marker, `MT_AGENT_SESSION=<session id>`, beside it, or alone when
 * none gives anything. So every agent's shell, a chat session's with cron off
 * included, is one `mt auth` refuses.
 */
export function sessionEnv(sessionId: string, env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return { ...env, [SESSION_MARKER]: sessionId };
}

/**
 * The boot findings to post on one channel, each with only its bindings there
 * (spec §8.4 step 2). A finding for a kanban run's session is bound on the
 * `kanban` channel, whose conversation id is a task id, not a chat: the
 * dispatcher handles those sessions instead.
 */
export function findingsOn(channelId: string, findings: readonly BootFinding[]): BootFinding[] {
  return findings
    .map((f) => ({ ...f, bindings: f.bindings.filter((key) => key.channel === channelId) }))
    .filter((f) => f.bindings.length > 0);
}

/**
 * The uuid of a boot finding's message to one binding. Lark sends one message
 * per uuid for an hour, across receivers, so it is keyed on the binding, and on
 * this boot: two chats bound to one session each hear it, and a second restart
 * within the hour is said again.
 */
export function findingUuid(appId: string, sessionId: string, key: BindingKey, boot: string = BOOT_ID): string {
  return replyUuid(appId, `boot:${boot}:${sessionId}`, `reconcile:${key.conversationId}:${key.threadId}`);
}

/**
 * Register every secret the configuration and the team hold: the Lark app secret
 * and every role's environment values, less maskExempt names. Idempotent, so both
 * main() and createGateway call it.
 */
export function registerConfiguredSecrets(config: GatewayConfig, team: Team): void {
  addSecrets([config.lark.appSecret, ...teamSecrets(team)]);
}

/**
 * What startup reads, in order: the gateway's .env, then the config and the team,
 * from `env` over that file. Every secret is registered as soon as it is known --
 * the file's secrets as it is read -- so an error raised on the way is masked.
 * `env` itself is left as it was: an agent's environment is built from the
 * process environment, which the file never enters.
 *
 * `mt service check` relies on it, with no unit installed (spec §20.5): it imports
 * this module from the build it checks and calls `loadStartup(env)` by this name,
 * with one argument, the environment, and takes a `ConfigError` thrown as the
 * reason the gateway would not start. Change its name, its argument or what it
 * throws knowing that `mt update`'s preflight runs that check.
 */
export function loadStartup(env: Env = process.env): { config: GatewayConfig; team: Team; gatewayEnv: GatewayEnvFile; workflows: string[] } {
  const loaded = loadGatewayEnv(env);
  const config = loadConfig(loaded.env);
  // Read and checked before anything starts: a broken role or workspace found
  // later strands work; found here it is a line in the startup error.
  const team = loadTeam(config, loaded.env);
  registerConfiguredSecrets(config, team);
  return { config, team, gatewayEnv: loaded.file, workflows: startupWorkflows(config, team) };
}

/**
 * The workflow check's lines (workflows spec §4): notes, as a broken workflow does not
 * stop the gateway; only it is unusable. With the team as the gateway's service
 * judges it, supervised roles accepted. `mt service check` prints them too.
 */
function startupWorkflows(config: GatewayConfig, team: Team): string[] {
  const dir = join(config.home, 'workflows');
  try {
    return workflowLines(
      listWorkflows(dir, { roles: team.roles, workspaces: new Set(team.workspaces.keys()), supervisedRoles: true }),
    );
  } catch (err) {
    // Only the directory itself throws, a ConfigError; a file that cannot be read is one broken workflow.
    if (!(err instanceof ConfigError)) throw err;
    // Two lines, so mt service check warns of the first and leaves the summary to the gateway's note.
    const why = err.message.replace(`cannot read ${dir}: `, '');
    return [`workflows directory ${dir} cannot be read: ${why}`, 'workflows: none'];
  }
}

/** How long a shutdown waits for the dispatcher's work before it closes the database. */
const SHUTDOWN_DRAIN_MS = 5_000;

/** What `loadStartup` found beside the config and the team: the workflow check's lines, noted after the roles' (workflows spec §4). */
export interface StartupNotes {
  workflows?: readonly string[];
}

export async function createGateway(config: GatewayConfig, team: Team, startup: StartupNotes = {}): Promise<Gateway> {
  // Every secret the gateway itself holds, masked wherever text leaves it (spec
  // §10.1). Before anything can print, the notes below included, or store agent
  // text. The dispatcher adds each run's token when it is claimed and removes it
  // when the run ends.
  registerConfiguredSecrets(config, team);

  const note = (line: string): void => {
    // Metadata only. No message bodies, no agent text -- the log is operational,
    // and a log that quotes user content is a second copy of the data with none of
    // the retention rules. The line is still masked, because an error in it can
    // carry an agent's stderr.
    process.stderr.write(`${new Date().toISOString()} ${redactKnownSecrets(line)}\n`);
  };

  // Which file the settings came from, first thing: the default location is derived,
  // and a gateway reading a file the operator did not mean is indistinguishable from
  // one whose settings are being ignored.
  note(
    config.configPath === undefined
      ? 'no config file; settings from the environment alone'
      : `settings from ${config.configPath}, environment overrides applied`,
  );

  for (const line of team.notes) note(line);

  // Chat sessions run the role default in the workspace default; loadTeam guarantees both exist.
  const defaultRole = team.roles.get(DEFAULT_ROLE);
  const defaultWorkspace = team.workspaces.get(DEFAULT_WORKSPACE);
  if (defaultRole === undefined || defaultWorkspace === undefined) {
    throw new Error('loadTeam returned no role or workspace named default');
  }
  note(
    `roles: ${[...team.roles.keys()].sort().join(', ')}; ` +
      `workspaces: ${[...team.workspaces.keys()].sort().join(', ')}`,
  );
  for (const line of startup.workflows ?? []) note(line);

  await mkdir(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  await mkdir(config.downloadDir, { recursive: true, mode: 0o700 });

  const db = openDb(config.dbPath);
  let version: number;
  try {
    version = migrate(db, config.schemaDir);
  } catch (err) {
    db.close();
    if (!(err instanceof SchemaTooNewError)) throw err;
    // migrate knows no home: the message is completed here, with where the backups are (spec §20.6).
    throw new SchemaTooNewError(
      `the database at ${config.dbPath} is at schema version ${err.dbVersion}, and this build knows only up to ${err.buildVersion}: ` +
        `it was migrated by a newer build. Run that build, or restore a backup of version ${err.buildVersion} ` +
        `from ${join(config.home, 'backups')}`,
      err.dbVersion,
      err.buildVersion,
      err,
    );
  }
  note(`schema at version ${version} (${config.dbPath})`);
  for (const line of grantLines(grantCounts(db, config.lark.appId))) note(line);
  // The zone new jobs get (the cron spec, §2.2): cron.tz, else this process's.
  const zone = config.cron.tz ?? processZone();

  // Before anything can open a session in one. A name whose directory moved would
  // orphan the provider sessions opened there (spec §2.3).
  const registered = registerWorkspaces(db, team.workspaces, systemClock.now());
  if ('error' in registered) {
    db.close();
    throw new ConfigError(registered.error);
  }
  if (registered.added.length > 0) note(`workspaces registered: ${registered.added.join(', ')}`);

  const drivers = buildRoleDrivers(team.roles);
  for (const [name, role] of [...team.roles].sort(([a], [b]) => a.localeCompare(b))) {
    if (!role.agent.unsupervised) continue;
    // Loud, and every boot. The gateway's whole security story is that operating
    // on the workspace requires a click, and under this driver it does not; an
    // operator reading the log should not have to remember which driver implies
    // that.
    note(`role ${name} (${role.agent.driver}): the agent acts without approval cards (agent.unsupervised is set)`);
  }

  const adapter = new LarkAdapter({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    // The agent may only attach files from its own workspace. Without this the
    // SDK enforces a blocklist only, which does not stop it reading elsewhere.
    allowedFileDirs: [defaultWorkspace],
    ...(config.lark.domain === undefined ? {} : { domain: config.lark.domain }),
  });

  const authorizer = new Authorizer({
    allowTalk: config.auth.allowTalk,
    allowOperate: config.auth.allowOperate,
    ownerOpenId: config.auth.ownerOpenId,
    allowChats: config.auth.allowChats,
    allowBots: [],
    allowDirectMessages: config.auth.allowDirectMessages,
    allowMentionAll: config.auth.allowMentionAll,
  }, {
    // A grant made in chat or at the terminal counts at the next check, read from the database (tier grants spec §4.1).
    grants: { tierOf: tierReader(db, config.lark.appId) },
    note,
  });

  // The registry asks the dispatcher and the scheduler, which need the registry, so they are read late.
  let dispatcher: Dispatcher | undefined;
  let scheduler: CronScheduler | undefined;
  let tokens: CronTokens | undefined;
  let wakeTokens: WakeTokens | undefined;
  const registry = new SessionRegistry({
    db,
    drivers,
    // A chat's session posts to Lark; a kanban run's into the sink (spec §2.4 item 4),
    // which forwards a supervised agent's approval cards to the chat following its task (spec §7.1);
    // a cron fire's into a sink of its own, which forwards nothing (the cron spec, §5.2).
    channels: new Map<string, Channel>([
      [adapter.id, adapter],
      ['kanban', new KanbanSink(undefined, { db, channels: new Map<string, Channel>([[adapter.id, adapter]]), appId: config.lark.appId })],
      ['cron', new SinkChannel('cron', { subject: (jobId) => `cron job ${jobId}` })],
    ]),
    // A run's, else a fire's, else a chat session's cron token and wake token (the cron spec, §7; wake spec §9.2, §13);
    // and the session marker, always (tier grants spec §6.3).
    envFor: (sessionId, key) =>
      sessionEnv(
        sessionId,
        dispatcher?.envFor(sessionId) ?? scheduler?.envFor(sessionId) ?? chatEnv(tokens?.envFor(sessionId, key), wakeTokens?.envFor(sessionId, key)),
      ),
    argsFor: (sessionId) => dispatcher?.argsFor(sessionId) ?? scheduler?.argsFor(sessionId),
    pinned: (sessionId) => (dispatcher?.pinned(sessionId) ?? false) || (scheduler?.pinned(sessionId) ?? false),
    // A kanban run in a task's own directory works there, as recorded when it was made (spec §18).
    workspaces: new NamedWorkspaces(team.workspaces, (id) => worktreeOf(db, id)),
    appId: config.lark.appId,
    maxLive: config.maxLiveSessions,
    note,
  });

  // Opt in: off unless kanban.enabled is set (spec §12). Chat runs as it always did
  // without it, and `/kanban` says the board is off.
  let worker: { handler: SocketHandler; socket: string } | undefined;
  let kanbanChat: KanbanChat | undefined;
  let notifier: Notifier | undefined;
  let waker: Waker | undefined;
  let boardService: KanbanService | undefined;
  let wakeApi: WakeApi | undefined;
  let unblockRedraws: UnblockRedraws | undefined;
  let cards: CardPoster | undefined;
  let workerServer: WorkerServer | undefined;
  let lock: GatewayLock | undefined;
  let dbLock: GatewayLock | undefined;
  // The socket and the shim, for a run's agent and a cron agent alike (spec §7.2, the cron spec §7).
  // Resolved, as a script runs in a workspace: a relative MT_HOME never gives it a relative PATH entry or home.
  const home = resolve(config.home);
  const socket = workerSocketPath(home);
  const access = { socket, mtDir: join(home, 'bin'), path: process.env['PATH'] };
  // One set of the rendered packages in use, the dispatcher's runs' and the scheduler's fires' (the cron spec, §5.2).
  const packages = new PackagesInUse();
  let boardApi: WorkerApi | undefined;
  // Who the gateway has seen in Lark: how a person named by principal is checked for talk tier (spec §4.2),
  // and named in /auth's lists, the board on or off (tier grants spec §6.1).
  const people = new PeopleDirectory({
    db,
    appId: config.lark.appId,
    // The configuration's lists and the grant, as the authorizer holds them, for a person named by principal (tier grants spec §4.3).
    canTalk: (person) => tiersOf(config.auth, person.openId, authorizer.grantOf(person.unionId)).talk,
    // Operate as the authorizer judges it, a grant counting and operate still needing talk (wake spec §13).
    canOperate: (person) => tiersOf(config.auth, person.openId, authorizer.grantOf(person.unionId)).operate,
    ownerOpenId: config.auth.ownerOpenId,
  });
  // /auth, always on: the tiers are the gateway's, whatever kanban.enabled and cron.enabled say (tier grants spec §6.1).
  const authChat = new AuthChat({ db, appId: config.lark.appId, authorizer, auth: config.auth, people, zone, note });
  if (config.kanban.enabled) {
    const { failureLimit, transientLimit, transientCooldownS } = config.kanban;
    const service = new KanbanService({
      db,
      roles: team.roles,
      workspaces: new Set(team.workspaces.keys()),
      // Each task in one of these gets a directory of its own (spec §18).
      isolated: new Set(Object.keys(config.isolated ?? {})),
      limits: { failureLimit, transientLimit, transientCooldownS },
      // People are given work, and sent cards for it (spec §9.2); a supervised role's
      // approval cards go to the chat that follows its task (spec §7.1).
      people,
      supervisedRoles: true,
      // A report runs its task's gates in the workspace, and reads the commit there
      // (spec §7.7, §7.8). They get only what an agent gets of this environment.
      checks: { workspaceDirs: team.workspaces, env: process.env },
      // A board's own max_running is held inside the gateway's (spec §16).
      maxRunning: config.kanban.maxRunning,
      // So /kanban task show can say a task is waiting on its role's limit (spec §6.3).
      ...(config.kanban.maxRunningPerRole === undefined ? {} : { maxRunningPerRole: config.kanban.maxRunningPerRole }),
      // Read at each use, as the startup's check and the terminal's read them (workflows spec §4, §10).
      workflowsDir: join(config.home, 'workflows'),
      // The switch and the depth, for a wake asked for (wake spec §3.4, §5.4).
      wake: { enabled: config.kanban.wake.enabled, maxDepth: config.kanban.wake.maxDepth },
    });
    boardService = service;
    dispatcher = new Dispatcher({
      db,
      service,
      sessions: registry,
      roles: team.roles,
      appId: config.lark.appId,
      settings: config.kanban,
      note,
      // Outside every workspace: none may contain the home (spec §2.3).
      renderRoot: join(config.home, 'rendered'),
      packages,
      // How a run reports (spec §7.2): through the socket, with this build's mt
      // first on its PATH. Both are in the home too.
      // Written in start(), once the home is held: a refused second gateway must not rewrite the first one's.
      worker: access,
      nameOf: (principal) => people.nameOf(principal),
      // In the home too, outside every workspace's repository (spec §18). Git gets what an agent gets.
      workdirs: new TaskDirectories({
        db,
        root: join(config.home, 'worktrees'),
        workspaceDirs: team.workspaces,
        isolated: config.isolated ?? {},
        env: buildEnv(process.env),
      }),
    });
    // A worker's create, link or report can make a task claimable.
    boardApi = new WorkerApi({ db, service, changed: () => dispatcher?.pass(), nameOf: (principal) => people.nameOf(principal) });
    // A notice's message redrawn once a block it offered Unblock for is lifted, by any path,
    // the terminal's and an agent's mt included (spec §9.2, amended by the unblock redraw).
    const redraws = new UnblockRedraws({
      db,
      service,
      channels: new Map<string, Channel>([[adapter.id, adapter]]),
      appId: config.lark.appId,
      nameOf: (principal) => people.chatName(principal),
      zone,
      note,
    });
    unblockRedraws = redraws;
    // /kanban in chat (spec §9.1): through the same service, with the router's tiers.
    kanbanChat = new KanbanChat({
      service,
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
      people,
      appId: config.lark.appId,
      redraw: (messageId, view) => adapter.updateCard(messageId, view),
      liftedNotice: (messageId) => redraws.redrawMessage(messageId),
      // task show's Wake line, in the gateway's zone (wake spec §10).
      wake: { enabled: config.kanban.wake.enabled, zone },
      note,
      changed: () => dispatcher?.pass(),
      cancel: (runId) => {
        dispatcher?.cancel(runId);
      },
    });
    // What the chats following a task hear (spec §9.4), sent through Lark.
    notifier = new Notifier({
      db,
      service,
      channels: new Map<string, Channel>([[adapter.id, adapter]]),
      appId: config.lark.appId,
      blockRecurrenceLimit: config.kanban.blockRecurrenceLimit,
      // By name, two of one name told apart (spec §9.3); the agent's prompts keep nameOf.
      nameOf: (principal) => people.chatName(principal),
      // With wakes on, a block's Unblock button may wait for the agent (wake spec §5.9); the waker answers.
      ...(config.kanban.wake.enabled ? { wouldDefer: (sub: SubscriptionRow, event: KanbanEvent) => waker?.wouldDefer(sub, event) ?? false } : {}),
      note,
    });
    // A person's run is sent its card: in its task's thread when they are in the group, else as a
    // direct message (spec §9.2, §19.2), never while the task's "Created" reply is under way (§19.4).
    const chat = kanbanChat;
    cards = new CardPoster({
      db,
      service,
      channel: adapter,
      appId: config.lark.appId,
      nameOf: (principal) => people.chatName(principal),
      canTalk: (principal) => people.canTalk(principal),
      held: (taskId) => chat.held(taskId),
      note,
    });
    note(`kanban: dispatching up to ${config.kanban.maxRunning} agent run(s) at once`);
    const wakeNote = wakeLine(config.kanban.wake, tasksWithWakeOn(db));
    if (wakeNote !== undefined) note(wakeNote);
    const isolated = Object.keys(config.isolated ?? {}).sort();
    if (isolated.length > 0) note(`kanban: each task in ${isolated.join(', ')} gets a directory of its own`);
  }

  // Opt in: off unless cron.enabled is set (the cron spec, §10). Chat runs as before
  // without it: no token, no changed PATH, and `/cron` says cron is off.
  let cronApi: CronApi | undefined;
  let cronChat: CronChat | undefined;
  if (config.cron.enabled) {
    const cronService = new CronService({ db, roles: team.roles, workspaces: new Set(team.workspaces.keys()), zone });
    tokens = new CronTokens({ db, worker: access, roles: team.roles });
    scheduler = new CronScheduler({
      db,
      service: cronService,
      sessions: registry,
      channels: new Map<string, Channel>([[adapter.id, adapter]]),
      appId: config.lark.appId,
      settings: config.cron,
      note,
      roles: team.roles,
      workspaceDirs: team.workspaces,
      renderRoot: join(config.home, 'rendered'),
      packages,
      // With the board off, its dispatcher's boot does not sweep the rendered packages.
      sweepRendersAtBoot: !config.kanban.enabled,
      worker: access,
      // A script's plain mt opens exactly the gateway's files, resolved, as the script runs in a workspace (§5.1).
      scriptHome: {
        home,
        configPath: config.configPath === undefined ? undefined : resolve(config.configPath),
        dbPath: resolve(config.dbPath),
      },
      tokens,
    });
    const s = scheduler;
    cronApi = new CronApi({ db, service: cronService, tokens, appId: config.lark.appId, changed: () => s.tick() });
    cronChat = new CronChat({ db, service: cronService, hasTier: (principal, tier) => authorizer.hasTier(principal, tier), changed: () => s.tick(), people });
  }
  const cronNote = cronLine(config.cron, jobCounts(db), zone);
  if (cronNote !== undefined) note(cronNote);

  // Wakes (wake spec §5.1, §9.2): with the board on and kanban.wake.enabled, a waker beside the notifier, and a
  // wake token in every Lark chat session's environment, cron on or off. With them off there is no waker:
  // a wake's pending rows wait, and a wake asked for is refused.
  if (config.kanban.wake.enabled && boardService !== undefined && notifier !== undefined) {
    const service = boardService;
    const notices = notifier;
    wakeTokens = new WakeTokens({ db, worker: access, roles: team.roles });
    waker = new Waker({
      db,
      service,
      registry,
      channels: new Map<string, Channel>([[adapter.id, adapter]]),
      appId: config.lark.appId,
      people,
      admitsConversation: (chatId, chatType) => authorizer.admitsConversation(chatId, chatType),
      letGo: (at) => notices.letGo(at),
      assignable: (role) => service.wakeRoleUsable(role),
      // A woken turn is recorded without operate tier, so its mt cron add is refused (wake spec §5.5 step 7).
      ...(tokens === undefined ? {} : { cronTurns: tokens }),
      settings: config.kanban.wake,
      blockRecurrenceLimit: config.kanban.blockRecurrenceLimit,
      zone,
      // A due button's card sent, its notice redrawn (wake spec §5.9).
      redrawNotice: (messageId) => unblockRedraws?.redrawMessage(messageId) ?? Promise.resolve(),
      note,
    });
    wakeApi = new WakeApi({
      db,
      service,
      tokens: wakeTokens,
      people,
      blockRecurrenceLimit: config.kanban.blockRecurrenceLimit,
      render: { lines: wokenShowText, json: showJson },
      channels: new Map<string, Channel>([[adapter.id, adapter]]),
      appId: config.lark.appId,
      zone,
      nudge: () => dispatcher?.pass(),
      note,
    });
  }

  // Release mode (wake spec §5.9): with wakes off, deferred buttons left from before are made due and sent,
  // by a waker that forms no wakes; with none left, no waker at all.
  if (!config.kanban.wake.enabled && boardService !== undefined && notifier !== undefined && deferredButtons(db, config.lark.appId).length > 0) {
    const notices = notifier;
    const releasing = boardService;
    waker = new Waker({
      db,
      service: releasing,
      registry,
      channels: new Map<string, Channel>([[adapter.id, adapter]]),
      appId: config.lark.appId,
      people,
      admitsConversation: (chatId, chatType) => authorizer.admitsConversation(chatId, chatType),
      letGo: (at) => notices.letGo(at),
      assignable: (role) => releasing.wakeRoleUsable(role),
      settings: config.kanban.wake,
      blockRecurrenceLimit: config.kanban.blockRecurrenceLimit,
      zone,
      redrawNotice: (messageId) => unblockRedraws?.redrawMessage(messageId) ?? Promise.resolve(),
      releaseOnly: true,
      note,
    });
  }

  // One handler, by envelope; a nudge's throttle is its own, and asks for both (the cron spec, §7.4).
  if (boardApi !== undefined || cronApi !== undefined) {
    const board = boardApi;
    const cron = cronApi;
    const wakes = wakeApi;
    worker = {
      handler: new SocketHandler({
        ...(board === undefined ? {} : { board: (request, signal) => board.handle(request, signal === undefined ? {} : { signal }) }),
        ...(cron === undefined ? {} : { cron: (request) => cron.handle(request) }),
        ...(wakes === undefined ? {} : { wake: (request) => wakes.handle(request) }),
        nudged: () => {
          dispatcher?.pass();
          scheduler?.tick();
        },
      }),
      socket,
    };
  }

  const router = new Router({
    db,
    registry,
    authorizer,
    channel: adapter,
    channelId: adapter.id,
    appId: config.lark.appId,
    ...(kanbanChat === undefined ? {} : { kanban: kanbanChat }),
    ...(cronChat === undefined ? {} : { cron: cronChat }),
    auth: authChat,
    // The gateway's roles, read at each /role list or /roles, the board on or off (tier grants spec §13).
    roles: () => rolesReply(db, team.roles, config.kanban),
    // Each turn's sender's tier, against its session's cron token (the cron spec, §7.1).
    ...(tokens === undefined ? {} : { cronTurns: tokens }),
    note,
  });

  const inbound = new LarkInbound({
    adapter,
    router,
    config: { appId: config.lark.appId, downloadDir: config.downloadDir },
    note,
  });

  let housekeeping: NodeJS.Timeout | undefined;
  let stopped = false;

  return {
    db,
    dispatcher,
    notifier,
    unblockRedraws,
    cards,
    get chat() {
      return kanbanChat;
    },
    cron: scheduler,
    waker,

    async start(): Promise<void> {
      // First, the home's lock and then the worker socket's path: a second gateway
      // on this home fails here, before its reconcile or its boot touches the first
      // one's sessions and runs. The lock decides it: a busy gateway's socket can
      // refuse a probe as a dead one's does.
      if (worker !== undefined) {
        lock = lockGateway(config.home);
        try {
          // With cron on, the database's own lock too: a database two homes name is ticked by one (the cron spec, §4.1).
          if (scheduler !== undefined) dbLock = lockDatabase(config.dbPath);
          await claimSocketPath(worker.socket);
          // Only once the home is this gateway's: the mt a run finds on its PATH (spec §7.2).
          writeMtShim(config.home);
          // And the zone it gives new jobs, for the terminal's mt cron (the cron spec, §2.2).
          if (scheduler !== undefined) writeGatewayZone(config.home, zone);
        } catch (err) {
          dbLock?.release();
          lock.release();
          throw err;
        }
      }

      // Before connecting. Reconciling against a channel that is already delivering
      // means deciding what happened to the last turn while the next one runs.
      const findings = registry.reconcileBoot();
      note(`reconciled ${findings.length} session(s) needing attention`);
      // Then every run the restart killed is closed, before anything can claim (spec §8.4).
      await dispatcher?.boot();
      // Then every fire the restart left open, after the board's boot (the cron spec, §4.4).
      await scheduler?.boot();
      // Then the socket, before the first pass can start a run that would report to it.
      if (worker !== undefined) {
        const { handler, socket } = worker;
        // A report still running its gates when the gateway stops is told so, and answered.
        workerServer = await listenWorker(socket, (request, signal) => handler.handle(request, signal), { note });
        // Named by what is on: a board's runs report through it, a cron agent reaches the gateway through it.
        note(boardApi === undefined ? `cron: agents reach the gateway through ${socket}` : `kanban: runs report through ${socket}`);
      }

      await adapter.connect();
      inbound.start();
      note(`connected as ${adapter.botOpenId ?? 'unknown bot identity'}`);
      // Once connected: its first round catches up on what the chats missed while the gateway was down.
      notifier?.start();
      // And wakes the agent for what came while down, its notices first (wake spec §5.7, §5.8).
      waker?.start();
      // And redraws the notices whose blocks were lifted while it was down.
      unblockRedraws?.start();
      // And the first tick, which sends what is pending and fires what came due while down.
      scheduler?.start();
      // And sends the cards of people's runs that a stop left unsent.
      cards?.start();

      // Only now, because saying it requires a connection. Failing to deliver a
      // finding must not prevent the gateway from starting -- the session is
      // already held, and refusing to start would remove the only way to look at it.
      for (const finding of findingsOn(adapter.id, findings)) {
        for (const key of finding.bindings) {
          try {
            await adapter.sendText(
              { chatId: key.conversationId, threadId: key.threadId },
              finding.message,
              findingUuid(config.lark.appId, finding.sessionId, key),
            );
          } catch (err) {
            note(
              `reporting ${finding.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      housekeeping = setInterval(
        () => {
          try {
            // Parking is a visibility change, never a decision. There is no
            // timeout-to-default: a parked approval stays answerable forever.
            const parked = registry.park();
            const swept = sweepSeen(db, systemClock.now());
            if (parked > 0 || swept > 0) note(`housekeeping: parked ${parked}, swept ${swept}`);
          } catch (err) {
            note(`housekeeping failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
        60_000,
      );
      housekeeping.unref();
      dispatcher?.start();
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;

      if (housekeeping !== undefined) clearInterval(housekeeping);
      // No more claims; the runs still open are ended by the next boot.
      dispatcher?.stop();
      // No more fires, and the running ones marked stopping before the actors close: the next boot ends them interrupted.
      scheduler?.stop();
      // No more notices, nor cards; what was not sent is sent by the next boot, from the board.
      notifier?.stop();
      // No more wakes; a turn already submitted runs on until the registry closes it (wake spec §5.5).
      waker?.stop();
      unblockRedraws?.stop();
      cards?.stop();
      // And the gates of a report from chat, a press's or typed: killed, nothing applied,
      // as the worker socket's are below; the next report after a restart runs them again.
      kanbanChat?.stop();
      // Stop taking work before draining it, or the drain never finishes.
      inbound.stop();
      // Then the worker socket: a report still running its gates is stopped and
      // answered, applying nothing, while its agent is still there to be told --
      // before the sessions close and their turns end. The dispatcher, stopped
      // above, decides no run whose turn ends from here on: the next boot ends
      // them (spec §8.4), so the stop itself never fails a run.
      await workerServer?.close();
      // And a pass a nudge asked for, still waiting for its window: the dispatcher is stopped.
      worker?.handler.stop();
      // A notice being sent finishes while the channel is still connected; bounded by the drain, not a
      // send's 30 s, so a hung send never holds the stop: its batch goes again after the next boot.
      // Together, under one bound: the notices, the cards, the card presses being
      // worked on, whose redraws need the channel, and a cron fire's message being
      // posted, which a send failed by the disconnect leaves pending for the next boot.
      const [notices, sent, pressed, , posted, redrawn, woken] = await Promise.all([
        notifier?.idle(SHUTDOWN_DRAIN_MS),
        cards?.idle(SHUTDOWN_DRAIN_MS),
        kanbanChat?.idle(SHUTDOWN_DRAIN_MS),
        inbound.idle(SHUTDOWN_DRAIN_MS),
        scheduler?.idle(SHUTDOWN_DRAIN_MS),
        // A notice being redrawn: best effort, and one the stop cuts short before it is marked is tried again by the next boot.
        unblockRedraws?.idle(SHUTDOWN_DRAIN_MS),
        // A wake's marker being sent, or its actor being made: never the turns it started (wake spec §5.5).
        waker?.idle(SHUTDOWN_DRAIN_MS),
      ]);
      // Past the bound, the database closes under whatever is still in flight: its write is dropped.
      if (notices === false) {
        note('kanban: stopped with a notice still being sent; should it land, its cursor is not moved, and the next boot sends it again');
      }
      if (sent === false) {
        note('kanban: stopped with a card still being sent; should it land, it is not recorded, and the next boot sends it again with the same uuid');
      }
      if (pressed === false) {
        note('kanban: stopped with a card press still being worked on; anything it still writes is dropped, and its card may not show the outcome');
      }
      if (redrawn === false) {
        note('kanban: stopped with a notice still being redrawn; the next boot tries it again');
      }
      if (woken === false) {
        note('kanban: stopped with a wake still being sent; its batch stays pending, and the next boot goes on with it');
      }
      if (posted === false) {
        note('cron: stopped with a fire\'s message still being posted; it stays pending, and the next boot posts it again with the same uuids');
      }
      await adapter.disconnect().catch((err: unknown) => {
        note(`disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      // Actors last. Each close awaits its final card write, which needs the
      // channel -- so this runs after disconnect only because the SDK's send path
      // survives it; a failed final write is logged, not fatal.
      await registry.closeAll();
      // Then what the dispatcher and the scheduler still have running -- an archive, a
      // close -- so none of it touches the database after it is closed. Together, under
      // one bound: a start that never returns is never drained, and must not hold the shutdown.
      const [runs, fires] = await Promise.all([dispatcher?.idle(SHUTDOWN_DRAIN_MS), scheduler?.idle(SHUTDOWN_DRAIN_MS)]);
      if (runs === false) {
        note('kanban: stopped with run work still pending; anything it still writes is dropped, and the next boot ends those runs');
      }
      if (fires === false) {
        note('cron: stopped with a fire\'s archive still pending; the next boot ends the fire interrupted');
      }
      db.close();
      // Last: until here, this gateway still had the home's sessions and runs, and the database's fires.
      dbLock?.release();
      lock?.release();
    },
  };
}

/**
 * Entry point.
 *
 * Shutdown is wired to both SIGINT and SIGTERM, and is idempotent. A second signal
 * during a drain exits immediately: an operator sending it twice means "stop now",
 * and a shutdown that ignores that is one they have to `kill -9`.
 */
export async function main(): Promise<void> {
  // Secrets registered inside, before anything else can fail, so an error raised
  // between loadTeam and the gateway starting is masked whatever createGateway does first.
  const { config, team, gatewayEnv, workflows } = loadStartup();
  if (gatewayEnv.present) {
    // Names only, as mt role check gives them.
    process.stderr.write(`gateway .env: ${gatewayEnv.path} sets ${Object.keys(gatewayEnv.values).sort().join(', ') || 'nothing'}\n`);
  }
  const gateway = await createGateway(config, team, { workflows });
  await gateway.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      process.stderr.write(`${signal} again; exiting immediately\n`);
      process.exit(1);
    }
    shuttingDown = true;
    process.stderr.write(`${signal}; draining\n`);
    gateway
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`shutdown failed: ${redactKnownSecrets(String(err))}\n`);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
