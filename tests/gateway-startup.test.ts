import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type GatewayConfig } from '../src/config.js';
import { migrate, openDb } from '../src/db/open.js';
import { createGateway } from '../src/index.js';
import { loadTeam, type Team } from '../src/team.js';

/**
 * Startup, up to the point where the gateway would connect. `createGateway` opens
 * and migrates the database and registers the workspaces; nothing talks to Lark
 * until `start()`, which these tests never call.
 */
let root: string;
let config: GatewayConfig;
let team: Team;
let workspace: string;

beforeEach(() => {
  // Not realpath'd on purpose: on macOS the temp dir is behind a symlink, so the
  // recorded path has to be the resolved one.
  root = mkdtempSync(join(tmpdir(), 'mt-startup-'));
  const home = join(root, 'home');
  workspace = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
  const env: Record<string, string | undefined> = {
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
  config = loadConfig(env, () => undefined);
  team = loadTeam(config, env);
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

describe('createGateway', () => {
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
