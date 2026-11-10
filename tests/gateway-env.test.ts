import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, GATEWAY_ENV_NAMES } from '../src/config.js';
import { buildEnv } from '../src/driver/env.js';
import { loadGatewayEnv, readGatewayEnv } from '../src/gateway-env.js';
import { loadStartup } from '../src/index.js';
import { MASK, clearSecrets, redactKnownSecrets } from '../src/secrets.js';

/**
 * The gateway's own `.env`, at `$MT_HOME/.env`: its secrets and settings beside
 * its environment, which wins name by name. Every test has its own home; none
 * reads ~/.manus-team.
 */
let root: string;
let home: string;
let workspace: string;

const SECRET = 'lark-secret-from-file-1234';

beforeEach(() => {
  clearSecrets();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-gateway-env-')));
  home = join(root, 'home');
  workspace = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
});

afterEach(() => {
  clearSecrets();
  rmSync(root, { recursive: true, force: true });
});

function envFile(text: string, mode = 0o600): string {
  const path = join(home, '.env');
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

describe('readGatewayEnv', () => {
  it('is optional: a missing file sets nothing', () => {
    const file = readGatewayEnv({ MT_HOME: home });
    expect(file).toEqual({ path: join(home, '.env'), present: false, values: {} });
    expect(loadGatewayEnv({ MT_HOME: home, LARK_APP_ID: 'cli_x' }).env).toEqual({ MT_HOME: home, LARK_APP_ID: 'cli_x' });
  });

  it('reads a good file, in the syntax of a role\'s .env', () => {
    const path = envFile(`# the gateway's secret\nLARK_APP_SECRET="${SECRET}"\nMT_ALLOW_TALK=ou_a,ou_b\n\nMT_AGENT_ENV_API_KEY='sk-agent-0000'\n`);
    const file = readGatewayEnv({ MT_HOME: home });
    expect(file).toEqual({
      path,
      present: true,
      values: { LARK_APP_SECRET: SECRET, MT_ALLOW_TALK: 'ou_a,ou_b', MT_AGENT_ENV_API_KEY: 'sk-agent-0000' },
    });
  });

  it('refuses a file group or others can read, and leaves its mode alone', () => {
    const path = envFile(`LARK_APP_SECRET=${SECRET}\n`, 0o640);
    expect(() => readGatewayEnv({ MT_HOME: home })).toThrow(ConfigError);
    expect(() => readGatewayEnv({ MT_HOME: home })).toThrow(
      new RegExp(`^${path} can be read or written by other users \\(mode 640\\); it must be readable and writable only by its owner \\(for example 0600\\)`),
    );
    envFile(`LARK_APP_SECRET=${SECRET}\n`, 0o604);
    expect(() => readGatewayEnv({ MT_HOME: home })).toThrow(/mode 604/);
  });

  it('refuses a symlink, and a file that is not a regular file', () => {
    const elsewhere = join(root, 'elsewhere.env');
    writeFileSync(elsewhere, `LARK_APP_SECRET=${SECRET}\n`);
    chmodSync(elsewhere, 0o600);
    symlinkSync(elsewhere, join(home, '.env'));
    expect(() => readGatewayEnv({ MT_HOME: home })).toThrow(
      `${join(home, '.env')} is a symlink; the gateway's .env must be a regular file, so it cannot point anywhere else`,
    );
    rmSync(join(home, '.env'));
    mkdirSync(join(home, '.env'));
    expect(() => readGatewayEnv({ MT_HOME: home })).toThrow(/is not a regular file/);
  });

  it('refuses a name the gateway does not read, naming it and never a value', () => {
    for (const name of ['LARK_APP_SECRT', 'API_KEY', 'MT_KANBAN_TOKEN', 'PATH', 'MT_AGENT_ENV_']) {
      envFile(`LARK_APP_SECRET=${SECRET}\n${name}=value-not-for-printing\n`);
      let message = '';
      try {
        readGatewayEnv({ MT_HOME: home });
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        message = (err as Error).message;
      }
      expect(message).toContain(`${join(home, '.env')}:2: unknown variable ${name}`);
      expect(message).not.toContain('not-for-printing');
      expect(message).not.toContain(SECRET);
    }
  });

  it('accepts every name the gateway reads from its environment, and MT_AGENT_ENV_ with a name', () => {
    const names = GATEWAY_ENV_NAMES.filter((n) => !['MT_HOME', 'MT_CONFIG', 'MT_DB'].includes(n));
    expect(names).toContain('LARK_APP_SECRET');
    expect(names).toContain('MT_OWNER_OPEN_ID');
    expect(names).toContain('MT_AGENT_COMMAND');
    envFile([...names.map((n) => `${n}=v-${n}`), 'MT_AGENT_ENV_GH_TOKEN=ghp_x'].join('\n'));
    expect(Object.keys(readGatewayEnv({ MT_HOME: home }).values)).toHaveLength(names.length + 1);
  });

  it('knows every MT_ and LARK_ name config.ts reads', () => {
    const source = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    const read = new Set([...source.matchAll(/'((?:MT|LARK)_[A-Z_]*[A-Z])'/g)].map((m) => m[1] ?? ''));
    // Prefixes, not names: MT_AGENT_ENV_<NAME> is accepted by its prefix, MT_KANBAN_* is a run's own.
    for (const prefix of ['MT_AGENT_ENV', 'MT_KANBAN']) read.delete(prefix);
    expect([...read].filter((name) => !(GATEWAY_ENV_NAMES as readonly string[]).includes(name))).toEqual([]);
  });

  it('refuses MT_HOME, MT_CONFIG and MT_DB: they say where the files are', () => {
    for (const name of ['MT_HOME', 'MT_CONFIG', 'MT_DB']) {
      envFile(`${name}=/elsewhere\n`);
      expect(() => readGatewayEnv({ MT_HOME: home })).toThrow(
        new RegExp(`${join(home, '.env')}:1: ${name} cannot be set in the gateway's \\.env`),
      );
    }
  });

  it('names the variable on a malformed line, never the line', () => {
    envFile(`LARK_APP_SECRET="${SECRET}\n`);
    expect(() => readGatewayEnv({ MT_HOME: home })).toThrow(`${join(home, '.env')}:1: unterminated quote`);
  });

  it('masks every value it read, from the moment it is read', () => {
    envFile(`LARK_APP_SECRET=${SECRET}\nMT_AGENT_ENV_API_KEY=sk-agent-0000\n`);
    readGatewayEnv({ MT_HOME: home });
    expect(redactKnownSecrets(`a ${SECRET} b sk-agent-0000`)).toBe(`a ${MASK} b ${MASK}`);
  });
});

describe('loadGatewayEnv', () => {
  it('lets the environment win, name by name, an empty value included', () => {
    envFile(`LARK_APP_ID=cli_file\nLARK_APP_SECRET=${SECRET}\nMT_ALLOW_TALK=ou_file\n`);
    const shell = { MT_HOME: home, LARK_APP_ID: 'cli_shell', MT_ALLOW_TALK: '' };
    const { env } = loadGatewayEnv(shell);
    expect(env).toEqual({ MT_HOME: home, LARK_APP_ID: 'cli_shell', LARK_APP_SECRET: SECRET, MT_ALLOW_TALK: '' });
    // The environment it was given is left as it was.
    expect(shell).toEqual({ MT_HOME: home, LARK_APP_ID: 'cli_shell', MT_ALLOW_TALK: '' });
  });
});

describe('loadStartup', () => {
  function configFile(extra = ''): void {
    writeFileSync(
      join(home, 'config.yaml'),
      `workspace: ${workspace}\nlark:\n  appId: cli_app\nauth:\n  owner: ou_owner\n` +
        'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n' +
        extra,
    );
  }

  it('reads the Lark app secret from the file, and masks it', () => {
    configFile();
    envFile(`LARK_APP_SECRET=${SECRET}\n`);
    const { config, gatewayEnv } = loadStartup({ MT_HOME: home, MT_DB: join(home, 'team.db') });
    expect(config.lark.appSecret).toBe(SECRET);
    expect(gatewayEnv.present).toBe(true);
    expect(redactKnownSecrets(`x ${SECRET} y`)).toBe(`x ${MASK} y`);
  });

  it('takes the environment over the file', () => {
    configFile();
    envFile(`LARK_APP_SECRET=${SECRET}\nMT_OWNER_OPEN_ID=ou_file\n`);
    const { config } = loadStartup({ MT_HOME: home, LARK_APP_SECRET: 'lark-secret-from-env-99', MT_OWNER_OPEN_ID: 'ou_env' });
    expect(config.lark.appSecret).toBe('lark-secret-from-env-99');
    expect(config.auth.ownerOpenId).toBe('ou_env');
  });

  it('starts without the file when the environment holds the secret', () => {
    configFile();
    const { config, gatewayEnv } = loadStartup({ MT_HOME: home, LARK_APP_SECRET: 'lark-secret-from-env-99' });
    expect(gatewayEnv.present).toBe(false);
    expect(config.lark.appSecret).toBe('lark-secret-from-env-99');
  });

  it('says where the Lark app secret may go when neither has it', () => {
    configFile();
    expect(() => loadStartup({ MT_HOME: home })).toThrow(
      `LARK_APP_SECRET is required: set it in ${join(home, '.env')} (mode 0600), or in the environment`,
    );
  });

  it("never gives the file's values to an agent, but for MT_AGENT_ENV_*, which are the agent's by name", () => {
    configFile();
    envFile(`LARK_APP_SECRET=${SECRET}\nMT_OWNER_OPEN_ID=ou_owner_from_file\nMT_AGENT_ENV_API_KEY=sk-agent-0000\n`);
    mkdirSync(join(home, 'roles', 'reviewer'), { recursive: true });
    writeFileSync(
      join(home, 'roles', 'reviewer', 'config.yaml'),
      'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n',
    );
    const before = { ...process.env };
    const { team } = loadStartup({ MT_HOME: home, PATH: '/usr/bin:/bin', HOME: root });
    expect(process.env).toEqual(before);
    expect(team.roles.get('default')?.agent.env).toEqual({ API_KEY: 'sk-agent-0000' });
    expect(team.roles.get('reviewer')?.agent.env).toEqual({});
    for (const role of team.roles.values()) {
      // What a driver and a gate start an agent with: the gateway's own process environment, by allowlist.
      const values = Object.values(buildEnv(process.env, role.agent.env));
      expect(values).not.toContain(SECRET);
      expect(values).not.toContain('ou_owner_from_file');
    }
  });

  it('refuses to start on a loose file, before reading the config', () => {
    envFile(`LARK_APP_SECRET=${SECRET}\n`, 0o644);
    expect(() => loadStartup({ MT_HOME: home })).toThrow(/can be read or written by other users \(mode 644\)/);
  });
});
