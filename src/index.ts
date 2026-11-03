import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConfigError, loadConfig, type GatewayConfig } from './config.js';
import { loadTeam, type Team } from './team.js';
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
import { Dispatcher } from './kanban/dispatcher.js';
import { KanbanService } from './kanban/service.js';
import { KanbanSink } from './kanban/sink.js';
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
  addSecrets([config.lark.appSecret, ...[...team.roles.values()].flatMap((role) => role.secretValues)]);
}

export async function createGateway(config: GatewayConfig, team: Team): Promise<Gateway> {
  // Every secret the gateway itself holds, masked wherever text leaves it (spec
  // §10.1). Before anything can print, the notes below included, or store agent
  // text. Plan C adds and removes worker tokens as runs open and close.
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
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(team.workspaces),
    appId: config.lark.appId,
    maxLive: config.maxLiveSessions,
    note,
  });

  // Off until the board can be used: nothing can create a task before plan D,
  // and no agent can report before plan C3 (spec §12).
  if (config.kanban.enabled) {
    const { failureLimit, transientLimit, transientCooldownS } = config.kanban;
    const service = new KanbanService({
      db,
      roles: team.roles,
      workspaces: new Set(team.workspaces.keys()),
      limits: { failureLimit, transientLimit, transientCooldownS },
    });
    dispatcher = new Dispatcher({
      db,
      service,
      sessions: registry,
      roles: team.roles,
      appId: config.lark.appId,
      settings: config.kanban,
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

    async start(): Promise<void> {
      // Before connecting. Reconciling against a channel that is already delivering
      // means deciding what happened to the last turn while the next one runs.
      const findings = registry.reconcileBoot();
      note(`reconciled ${findings.length} session(s) needing attention`);
      // Then every run the restart killed is closed, before anything can claim (spec §8.4).
      await dispatcher?.boot();

      await adapter.connect();
      inbound.start();
      note(`connected as ${adapter.botOpenId ?? 'unknown bot identity'}`);

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
      // Stop taking work before draining it, or the drain never finishes.
      inbound.stop();
      await adapter.disconnect().catch((err: unknown) => {
        note(`disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      // Actors last. Each close awaits its final card write, which needs the
      // channel -- so this runs after disconnect only because the SDK's send path
      // survives it; a failed final write is logged, not fatal.
      await registry.closeAll();
      db.close();
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
