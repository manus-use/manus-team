import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, type GatewayConfig } from '../src/config.js';
import { migrate, openDb } from '../src/db/open.js';
import { createGateway, findingsOn, registerConfiguredSecrets } from '../src/index.js';
import { loadTeam, type Team } from '../src/team.js';
import { MASK, clearSecrets, redactKnownSecrets } from '../src/secrets.js';

/**
 * Startup, up to the point where the gateway would connect. `createGateway` opens
 * and migrates the database and registers the workspaces; nothing talks to Lark
 * until `start()`, which these tests never call.
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
    MT_DB: join(home, 'gateway.db'),
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

afterEach(() => rmSync(root, { recursive: true, force: true }));

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
    } finally {
      await gateway.stop();
    }
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

  it('writes the mt a run finds on its PATH only when kanban.enabled is set', async () => {
    const off = await createGateway(config, team);
    await off.stop();
    expect(existsSync(join(config.home, 'bin'))).toBe(false);
    const on = await createGateway({ ...config, kanban: { ...config.kanban, enabled: true } }, team);
    try {
      expect(statSync(join(config.home, 'bin', 'mt')).mode & 0o777).toBe(0o700);
      expect(readFileSync(join(config.home, 'bin', 'mt'), 'utf8')).toContain(`exec '${process.execPath}'`);
    } finally {
      await on.stop();
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
