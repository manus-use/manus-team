import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigError, loadConfig, type GatewayConfig } from './config.js';
import { loadTeam, teamSecrets, type Team } from './team.js';
import { migrate, openDb, type Db } from './db/open.js';
import { sweepSeen } from './db/dedup.js';
import { registerWorkspaces } from './db/workspaces.js';
import { LarkAdapter } from './channel/lark/adapter.js';
import { LarkInbound } from './channel/lark/inbound.js';
import { buildRoleDrivers } from './driver/build.js';
import { Authorizer } from './policy/auth.js';
import { Router } from './core/router.js';
import { DEFAULT_ROLE, DEFAULT_WORKSPACE, SessionRegistry, type BootFinding } from './core/registry.js';
import { NamedWorkspaces } from './core/workspace.js';
import { replyUuid } from './core/ids.js';
import { systemClock } from './time.js';
import { addSecrets, redactKnownSecrets } from './secrets.js';
import { KanbanChat } from './kanban/chat.js';
import { Dispatcher } from './kanban/dispatcher.js';
import { Notifier } from './kanban/notices.js';
import { KanbanService } from './kanban/service.js';
import { writeMtShim } from './kanban/shim.js';
import { KanbanSink } from './kanban/sink.js';
import { claimSocketPath, listenWorker, lockGateway, workerSocketPath, type GatewayLock, type WorkerServer } from './kanban/socket.js';
import { WorkerApi } from './kanban/worker.js';
import type { Channel } from './channel/types.js';

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
 * Register every secret the configuration and the team hold: the Lark app secret
 * and every role's environment values, less maskExempt names. Idempotent, so both
 * main() and createGateway call it.
 */
export function registerConfiguredSecrets(config: GatewayConfig, team: Team): void {
  addSecrets([config.lark.appSecret, ...teamSecrets(team)]);
}

/** How long a shutdown waits for the dispatcher's work before it closes the database. */
const SHUTDOWN_DRAIN_MS = 5_000;

export async function createGateway(config: GatewayConfig, team: Team): Promise<Gateway> {
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

  await mkdir(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  await mkdir(config.downloadDir, { recursive: true, mode: 0o700 });

  const db = openDb(config.dbPath);
  const version = migrate(db, config.schemaDir);
  note(`schema at version ${version}`);

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
  });

  // The registry asks the dispatcher, which needs the registry, so it is read late.
  let dispatcher: Dispatcher | undefined;
  const registry = new SessionRegistry({
    db,
    drivers,
    // A chat's session posts to Lark; a kanban run's into the sink (spec §2.4 item 4).
    channels: new Map<string, Channel>([
      [adapter.id, adapter],
      ['kanban', new KanbanSink()],
    ]),
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    argsFor: (sessionId) => dispatcher?.argsFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(team.workspaces),
    appId: config.lark.appId,
    maxLive: config.maxLiveSessions,
    note,
  });

  // Opt in: off unless kanban.enabled is set (spec §12). Chat runs as it always did
  // without it, and `/kanban` says the board is off.
  let worker: { api: WorkerApi; socket: string } | undefined;
  let kanbanChat: KanbanChat | undefined;
  let notifier: Notifier | undefined;
  let workerServer: WorkerServer | undefined;
  let lock: GatewayLock | undefined;
  if (config.kanban.enabled) {
    const { failureLimit, transientLimit, transientCooldownS } = config.kanban;
    const service = new KanbanService({
      db,
      roles: team.roles,
      workspaces: new Set(team.workspaces.keys()),
      limits: { failureLimit, transientLimit, transientCooldownS },
      // A report runs its task's gates in the workspace, and reads the commit there
      // (spec §7.7, §7.8). They get only what an agent gets of this environment.
      checks: { workspaceDirs: team.workspaces, env: process.env },
    });
    const socket = workerSocketPath(config.home);
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
      // How a run reports (spec §7.2): through the socket, with this build's mt
      // first on its PATH. Both are in the home too.
      // Written in start(), once the home is held: a refused second gateway must not rewrite the first one's.
      worker: { socket, mtDir: join(config.home, 'bin'), path: process.env['PATH'] },
    });
    // A worker's create, link or report can make a task claimable.
    worker = { api: new WorkerApi({ db, service, changed: () => dispatcher?.pass() }), socket };
    // /kanban in chat (spec §9.1): through the same service, with the router's tiers.
    kanbanChat = new KanbanChat({
      service,
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
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
      note,
    });
    note(`kanban: dispatching up to ${config.kanban.maxRunning} agent run(s) at once`);
  }

  const router = new Router({
    db,
    registry,
    authorizer,
    channel: adapter,
    channelId: adapter.id,
    appId: config.lark.appId,
    ...(kanbanChat === undefined ? {} : { kanban: kanbanChat }),
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

    async start(): Promise<void> {
      // First, the home's lock and then the worker socket's path: a second gateway
      // on this home fails here, before its reconcile or its boot touches the first
      // one's sessions and runs. The lock decides it: a busy gateway's socket can
      // refuse a probe as a dead one's does.
      if (worker !== undefined) {
        lock = lockGateway(config.home);
        try {
          await claimSocketPath(worker.socket);
          // Only once the home is this gateway's: the mt a run finds on its PATH (spec §7.2).
          writeMtShim(config.home);
        } catch (err) {
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
      // Then the socket, before the first pass can start a run that would report to it.
      if (worker !== undefined) {
        const { api, socket } = worker;
        // A report still running its gates when the gateway stops is told so, and answered.
        workerServer = await listenWorker(socket, (request, signal) => api.handle(request, { signal }), { note });
        note(`kanban: runs report through ${socket}`);
      }

      await adapter.connect();
      inbound.start();
      note(`connected as ${adapter.botOpenId ?? 'unknown bot identity'}`);
      // Once connected: its first round catches up on what the chats missed while the gateway was down.
      notifier?.start();

      // Only now, because saying it requires a connection. Failing to deliver a
      // finding must not prevent the gateway from starting -- the session is
      // already held, and refusing to start would remove the only way to look at it.
      for (const finding of findingsOn(adapter.id, findings)) {
        for (const key of finding.bindings) {
          try {
            await adapter.sendText(
              { chatId: key.conversationId, threadId: key.threadId },
              finding.message,
              replyUuid(config.lark.appId, `boot:${finding.sessionId}`, 'reconcile'),
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
      // No more notices; what was not sent is sent by the next boot, from the cursors.
      notifier?.stop();
      // Stop taking work before draining it, or the drain never finishes.
      inbound.stop();
      // Then the worker socket: a report still running its gates is stopped and
      // answered, applying nothing, while its agent is still there to be told --
      // before the sessions close and their turns end. The dispatcher, stopped
      // above, decides no run whose turn ends from here on: the next boot ends
      // them (spec §8.4), so the stop itself never fails a run.
      await workerServer?.close();
      // A notice being sent finishes while the channel is still connected; bounded by the drain, not a
      // send's 30 s, so a hung send never holds the stop: its batch goes again after the next boot.
      if ((await notifier?.idle(SHUTDOWN_DRAIN_MS)) === false) note('kanban: stopped with a notice still being sent; the next boot sends it again');
      await adapter.disconnect().catch((err: unknown) => {
        note(`disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      // Actors last. Each close awaits its final card write, which needs the
      // channel -- so this runs after disconnect only because the SDK's send path
      // survives it; a failed final write is logged, not fatal.
      await registry.closeAll();
      // Then what the dispatcher still has running -- an archive, a close -- so
      // none of it touches the database after it is closed. Bounded: a start that
      // never returns is never drained, and must not hold the shutdown.
      if ((await dispatcher?.idle(SHUTDOWN_DRAIN_MS)) === false) {
        note('kanban: stopped with run work still pending; the next boot ends those runs');
      }
      db.close();
      // Last: until here, this gateway still had the home's sessions and runs.
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
  const config = loadConfig();
  // Read and checked before anything starts: a broken role or workspace found
  // later strands work; found here it is a line in the startup error.
  const team = loadTeam(config, process.env);
  // Registered here, before anything else can fail, so an error raised between
  // loadTeam and the gateway starting is masked whatever createGateway does first.
  registerConfiguredSecrets(config, team);
  const gateway = await createGateway(config, team);
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
