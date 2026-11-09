import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, type GatewayConfig } from '../src/config.js';
import { migrate, openDb } from '../src/db/open.js';
import { createGateway, findingUuid, findingsOn, registerConfiguredSecrets } from '../src/index.js';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import { LarkInbound } from '../src/channel/lark/inbound.js';
import { loadTeam, type Team } from '../src/team.js';
import { MASK, clearSecrets, redactKnownSecrets } from '../src/secrets.js';

/**
 * Startup, up to the point where the gateway would connect. `createGateway` opens
 * and migrates the database and registers the workspaces; nothing talks to Lark
 * until `start()`, which these tests call only with the channel stubbed, or to see
 * it refused before it connects.
 */
let root: string;
let config: GatewayConfig;
let team: Team;
let workspace: string;
let startupEnv: Record<string, string | undefined>;

beforeEach(() => {
  clearSecrets();
  // Not realpath'd on purpose: on macOS the temp dir is behind a symlink, so the
  // recorded path has to be the resolved one.
  root = mkdtempSync(join(tmpdir(), 'mt-startup-'));
  const home = join(root, 'home');
  workspace = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
  startupEnv = {
    MT_HOME: home,
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: workspace,
    MT_OWNER_OPEN_ID: 'ou_owner',
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: 'bytesec',
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
  };
  config = loadConfig(startupEnv, () => undefined);
  team = loadTeam(config, startupEnv);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function rows(): Array<{ id: string; root_path: string }> {
  const db = openDb(config.dbPath);
  try {
    return db.prepare<[], { id: string; root_path: string }>('SELECT id, root_path FROM workspaces ORDER BY id').all();
  } finally {
    db.close();
  }
}

describe('registerConfiguredSecrets', () => {
  // main() calls it before createGateway, so an error raised in between is masked too.
  it('knows the Lark app secret without a gateway being created', () => {
    registerConfiguredSecrets(config, team);
    expect(redactKnownSecrets(`x ${config.lark.appSecret} y`)).toBe(`x ${MASK} y`);
  });

  it("knows a role's .env values and the Lark app secret, but not a maskExempt value", () => {
    const dir = join(config.home, 'roles', 'reviewer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config.yaml'),
      'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n' +
        '  passEnv: [BASE_URL]\n  maskExempt: [BASE_URL]\n',
    );
    writeFileSync(join(dir, '.env'), 'API_KEY=sk-role-12345678\n');
    chmodSync(join(dir, '.env'), 0o600);
    const withRole = loadTeam(config, { ...startupEnv, BASE_URL: 'https://example.invalid/v1' });

    registerConfiguredSecrets(config, withRole);
    expect(redactKnownSecrets('key sk-role-12345678')).toBe(`key ${MASK}`);
    expect(redactKnownSecrets('url https://example.invalid/v1')).toBe('url https://example.invalid/v1');
    expect(redactKnownSecrets(`x ${config.lark.appSecret} y`)).toBe(`x ${MASK} y`);
  });
});

describe('createGateway', () => {
  it('knows the Lark app secret once it has started up', async () => {
    const gateway = await createGateway(config, team);
    try {
      expect(redactKnownSecrets(`x ${config.lark.appSecret} y`)).toBe(`x ${MASK} y`);
    } finally {
      await gateway.stop();
    }
  });

  it('refuses to start when a workspace name now points at another directory, and changes nothing', async () => {
    const db = openDb(config.dbPath);
    migrate(db, config.schemaDir);
    db.prepare(
      "INSERT INTO workspaces (id, kind, root_path, created_at) VALUES ('default','plain-dir','/elsewhere',0)",
    ).run();
    db.close();

    const started = createGateway(config, team);
    await expect(started).rejects.toBeInstanceOf(ConfigError);
    await expect(started).rejects.toThrow(/workspace default is \/elsewhere/);

    expect(rows()).toEqual([{ id: 'default', root_path: '/elsewhere' }]);
  });

  it('registers the workspace by its realpath on a first start', async () => {
    const gateway = await createGateway(config, team);
    try {
      const recorded = gateway.db
        .prepare<[], { id: string; root_path: string }>('SELECT id, root_path FROM workspaces')
        .all();
      expect(recorded).toEqual([{ id: 'default', root_path: realpathSync(workspace) }]);
    } finally {
      // Safe without start(): disconnecting a channel that never connected is a no-op.
      await gateway.stop();
    }
  });
});

describe('the board, at startup', () => {
  it('builds no dispatcher unless kanban.enabled is set: chat runs as it did', async () => {
    const gateway = await createGateway(config, team);
    try {
      expect(gateway.dispatcher).toBeUndefined();
      expect(gateway.notifier).toBeUndefined();
      expect(gateway.cards).toBeUndefined();
      expect(gateway.chat).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });

  it("starts delivering notices and people's cards once connected, and stops before it disconnects, waiting a few seconds at most, when kanban.enabled is set", async () => {
    vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
    const order: string[] = [];
    vi.spyOn(LarkAdapter.prototype, 'disconnect').mockImplementation(async () => {
      order.push('disconnect');
    });
    vi.spyOn(LarkInbound.prototype, 'start').mockImplementation(() => undefined);
    const gateway = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    const notifier = gateway.notifier;
    if (notifier === undefined) throw new Error('no notifier');
    const cards = gateway.cards;
    if (cards === undefined) throw new Error('no cards');
    vi.spyOn(notifier, 'start').mockImplementation(() => {
      order.push('notices start');
    });
    vi.spyOn(cards, 'start').mockImplementation(() => {
      order.push('cards start');
    });
    const bounds: Array<number | undefined> = [];
    vi.spyOn(notifier, 'idle').mockImplementation(async (boundMs) => {
      order.push('notices idle');
      bounds.push(boundMs);
      return true;
    });
    vi.spyOn(cards, 'idle').mockImplementation(async (boundMs) => {
      order.push('cards idle');
      bounds.push(boundMs);
      return true;
    });
    await gateway.start();
    await gateway.stop();
    expect(order).toEqual(['notices start', 'cards start', 'notices idle', 'cards idle', 'disconnect']);
    // Bounded by the shutdown's drain, not by a send's 30 s: a hung send never holds the stop.
    expect(bounds).toHaveLength(2);
    for (const bound of bounds) {
      expect(bound).toBeGreaterThan(0);
      expect(bound).toBeLessThanOrEqual(10_000);
    }
  });

  it("stops the gates of a report from chat before it waits for the card presses being worked on", async () => {
    const gateway = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    const chat = gateway.chat;
    if (chat === undefined) throw new Error('no chat');
    const order: string[] = [];
    vi.spyOn(chat, 'stop').mockImplementation(() => {
      order.push('stop');
    });
    vi.spyOn(chat, 'idle').mockImplementation(async () => {
      order.push('idle');
      return true;
    });
    await gateway.stop();
    expect(order).toEqual(['stop', 'idle']);
  });

  it("waits, for a few seconds at most, for the dispatcher's work before it closes the database", async () => {
    const gateway = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    const dispatcher = gateway.dispatcher;
    if (dispatcher === undefined) throw new Error('no dispatcher');
    const waited: Array<{ boundMs: number | undefined; dbOpen: boolean }> = [];
    vi.spyOn(dispatcher, 'idle').mockImplementation(async (boundMs) => {
      waited.push({ boundMs, dbOpen: gateway.db.open });
      return false;
    });

    await gateway.stop();
    expect(waited).toHaveLength(1);
    expect(waited[0]?.dbOpen).toBe(true);
    expect(waited[0]?.boundMs).toBeGreaterThan(0);
    expect(waited[0]?.boundMs).toBeLessThanOrEqual(10_000);
    expect(gateway.db.open).toBe(false);
  });

  it('writes the mt a run finds on its PATH at start, once the home is held, and only when kanban.enabled is set', async () => {
    // The channel stubbed: nothing here talks to Lark.
    vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(LarkAdapter.prototype, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(LarkInbound.prototype, 'start').mockImplementation(() => undefined);
    const off = await createGateway(config, team);
    await off.start();
    await off.stop();
    expect(existsSync(join(config.home, 'bin'))).toBe(false);
    const on = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    try {
      expect(existsSync(join(config.home, 'bin', 'mt'))).toBe(false);
      await on.start();
      expect(statSync(join(config.home, 'bin', 'mt')).mode & 0o777).toBe(0o700);
      expect(readFileSync(join(config.home, 'bin', 'mt'), 'utf8')).toContain(`exec '${process.execPath}'`);
    } finally {
      await on.stop();
    }
  });

  it("leaves the running gateway's mt alone when another gateway holds the home", async () => {
    const run = join(config.home, 'run');
    mkdirSync(run, { mode: 0o700 });
    // A live process other than this one: the lock is another gateway's.
    writeFileSync(join(run, 'gateway.pid'), `${process.ppid}\n`, { mode: 0o600 });
    const bin = join(config.home, 'bin');
    mkdirSync(bin, { mode: 0o700 });
    writeFileSync(join(bin, 'mt'), '#!/bin/sh\n# the running gateway\'s\n', { mode: 0o700 });
    const second = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    try {
      await expect(second.start()).rejects.toThrow(/another gateway \(pid \d+\) is running/);
      expect(readFileSync(join(bin, 'mt'), 'utf8')).toBe("#!/bin/sh\n# the running gateway's\n");
    } finally {
      await second.stop();
    }
  });

  it('builds the dispatcher when kanban.enabled is set', async () => {
    const gateway = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    try {
      expect(gateway.dispatcher).toBeDefined();
    } finally {
      await gateway.stop();
    }
  });

  it('gives a boot finding a uuid per binding and per boot, as Lark sends one message per uuid for an hour', () => {
    const a = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_a', threadId: '' };
    const b = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_b', threadId: '' };
    const uuids = [
      findingUuid('cli_app', 's_1', a, 'boot1'),
      findingUuid('cli_app', 's_1', b, 'boot1'),
      findingUuid('cli_app', 's_1', { ...a, threadId: 'omt_1' }, 'boot1'),
      findingUuid('cli_app', 's_1', a, 'boot2'),
    ];
    expect(new Set(uuids).size).toBe(4);
    expect(findingUuid('cli_app', 's_1', a, 'boot1')).toBe(uuids[0]);
  });

  it("posts boot findings to the chat channel's bindings only: a kanban binding's conversation is a task", () => {
    const lark = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: '' };
    const kanban = { channel: 'kanban', appId: 'cli_app', conversationId: 'k_task', threadId: 'r_run' };
    const findings = [
      { sessionId: 's_chat', message: 'chat', held: false, bindings: [lark] },
      { sessionId: 's_run', message: 'run', held: true, bindings: [kanban] },
      { sessionId: 's_both', message: 'both', held: false, bindings: [kanban, lark] },
    ];
    expect(findingsOn('lark', findings)).toEqual([
      { sessionId: 's_chat', message: 'chat', held: false, bindings: [lark] },
      { sessionId: 's_both', message: 'both', held: false, bindings: [lark] },
    ]);
  });
});
