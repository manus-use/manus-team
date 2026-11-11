import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ConfigError, loadConfig, loadTeamSettings, type FileReader } from '../src/config.js';

/**
 * Configuration is where a security property is easiest to lose by accident: a
 * default that reads as "nothing configured" and means "no restrictions", a typo'd
 * key that silently takes its default, or a credential that ends up in a file the
 * unsandboxed agent can read.
 *
 * `loadConfig` takes both the environment and the file reader as parameters, so all
 * of that is testable without touching `process.env` or the disk. One test at the
 * bottom uses the real reader, because the default path is derived and a loader
 * that reads the wrong file looks exactly like one whose settings are ignored.
 */

const OWNER = 'ou_owner';
const HOME = '/var/lib/prime';
const DEFAULT_PATH = join(HOME, 'config.yaml');

/** The minimum environment: the secret, which the file may never hold. */
const BASE: Record<string, string> = {
  MT_HOME: HOME,
  LARK_APP_SECRET: 'app-secret',
};

/** A complete file. Tests override the one section they are about. */
const BASE_FILE: Record<string, unknown> = {
  workspace: '/srv/repo',
  lark: { appId: 'cli_app' },
  auth: { owner: OWNER },
  agent: { command: 'claude-agent-acp' },
};

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The base file with `over` merged one level deep, serialized.
 *
 * Built from an object rather than by concatenating YAML text, because appending a
 * second `auth:` block produces a duplicate-key parse error instead of the setting
 * under test.
 */
function yamlFile(over: Record<string, unknown> = {}): string {
  const merged: Record<string, unknown> = { ...BASE_FILE };
  for (const [key, value] of Object.entries(over)) {
    const base = merged[key];
    merged[key] = isMapping(value) && isMapping(base) ? { ...base, ...value } : value;
  }
  return stringify(merged);
}

const FULL_FILE = yamlFile();

function reader(files: Record<string, string>): FileReader & { asked: string[] } {
  const asked: string[] = [];
  const fn = (path: string): string | undefined => {
    asked.push(path);
    return files[path];
  };
  return Object.assign(fn, { asked });
}

/** Load with the standard file at the default path. */
function load(env: Record<string, string | undefined> = {}, file: string = FULL_FILE) {
  return loadConfig({ ...BASE, ...env }, reader({ [DEFAULT_PATH]: file }));
}

/** Load with no file at all, so every value has to come from the environment. */
function loadEnvOnly(env: Record<string, string | undefined>) {
  return loadConfig({ ...BASE, ...env }, reader({}));
}

const ENV_ONLY: Record<string, string> = {
  MT_OWNER_OPEN_ID: OWNER,
  MT_WORKSPACE: '/srv/repo',
  MT_AGENT_COMMAND: 'claude-agent-acp',
  LARK_APP_ID: 'cli_app',
};

describe('loadConfig: where settings come from', () => {
  it('runs from the environment alone, with no file', () => {
    // The container deployment. A missing file at the default location is ordinary.
    const cfg = loadEnvOnly(ENV_ONLY);
    expect(cfg.workspaces['default']).toBe('/srv/repo');
    expect(cfg.auth.ownerOpenId).toBe(OWNER);
    expect(cfg.agent?.command).toBe('claude-agent-acp');
    expect(cfg.configPath).toBeUndefined();
  });

  it('runs from the file, with only the secret in the environment', () => {
    const cfg = load();
    expect(cfg.workspaces['default']).toBe('/srv/repo');
    expect(cfg.lark.appId).toBe('cli_app');
    expect(cfg.lark.appSecret).toBe('app-secret');
    expect(cfg.configPath).toBe(DEFAULT_PATH);
  });

  it('lets the environment win over every setting in the file', () => {
    // The emergency path: an override must not require editing a file, because the
    // reason for the override is often that the file is what is wrong.
    const cfg = load({
      MT_WORKSPACE: '/srv/other',
      MT_OWNER_OPEN_ID: 'ou_new_owner',
      MT_AGENT_COMMAND: 'gemini',
      MT_MAX_LIVE_SESSIONS: '2',
      LARK_APP_ID: 'cli_other',
      LARK_DOMAIN: 'https://open.larksuite.com',
    });
    expect(cfg.workspaces['default']).toBe('/srv/other');
    expect(cfg.auth.ownerOpenId).toBe('ou_new_owner');
    expect(cfg.agent?.command).toBe('gemini');
    expect(cfg.maxLiveSessions).toBe(2);
    expect(cfg.lark.appId).toBe('cli_other');
    expect(cfg.lark.domain).toBe('https://open.larksuite.com');
  });

  it('looks for the file under MT_HOME, and reads the one MT_CONFIG names', () => {
    const byDefault = reader({});
    loadConfig({ ...BASE, ...ENV_ONLY }, byDefault);
    expect(byDefault.asked).toEqual([DEFAULT_PATH]);

    const named = reader({ '/etc/prime/gw.yaml': FULL_FILE });
    const cfg = loadConfig({ ...BASE, MT_CONFIG: '/etc/prime/gw.yaml' }, named);
    expect(named.asked).toEqual(['/etc/prime/gw.yaml']);
    expect(cfg.configPath).toBe('/etc/prime/gw.yaml');
  });

  it('refuses a named file that is not there', () => {
    // Silently falling back to the environment would start a gateway with none of
    // the settings the operator believed they had written down.
    expect(() => loadConfig({ ...BASE, MT_CONFIG: '/etc/nope.yaml' }, reader({}))).toThrow(
      /MT_CONFIG points at \/etc\/nope\.yaml, which does not exist/,
    );
  });

  it('treats an empty file as no settings rather than as an error', () => {
    const cfg = loadConfig({ ...BASE, ...ENV_ONLY }, reader({ [DEFAULT_PATH]: '\n# nothing yet\n' }));
    expect(cfg.workspaces['default']).toBe('/srv/repo');
  });
});

describe('loadConfig: required values', () => {
  it('names both sources for a value it cannot find', () => {
    expect(() => loadEnvOnly({ ...ENV_ONLY, MT_OWNER_OPEN_ID: undefined })).toThrow(
      /auth\.owner in the config file, or MT_OWNER_OPEN_ID/,
    );
    expect(() => loadEnvOnly({ ...ENV_ONLY, MT_WORKSPACE: undefined })).toThrow(
      /workspace in the config file, or MT_WORKSPACE/,
    );
    expect(() => loadEnvOnly({ ...ENV_ONLY, LARK_APP_ID: undefined })).toThrow(
      /lark\.appId in the config file, or LARK_APP_ID/,
    );
  });

  it('requires the app secret from the environment and nowhere else', () => {
    expect(() => load({ LARK_APP_SECRET: undefined })).toThrow('LARK_APP_SECRET is required');
    // An unset variable and one set to the empty string are the same mistake, and
    // an empty app secret produces a bot that connects and then does nothing.
    expect(() => load({ LARK_APP_SECRET: '' })).toThrow(ConfigError);
  });

  it('refuses a relative workspace, from either source', () => {
    // Relative resolves against whatever cwd the service manager set, so the
    // workspace would depend on how the process was launched.
    expect(() => load({ MT_WORKSPACE: './repo' })).toThrow('must be an absolute path');
    expect(() => load({}, yamlFile({ workspace: './repo' }))).toThrow('must be an absolute path');
  });

  it('derives the paths that are not set from MT_HOME', () => {
    const cfg = load();
    expect(cfg.dbPath).toBe(join(HOME, 'team.db'));
    expect(cfg.downloadDir).toBe(join(HOME, 'downloads'));
  });

  it('lets each derived path be overridden from either source', () => {
    const fromFile = load({}, yamlFile({ db: '/tmp/db.sqlite', downloads: '/tmp/dl' }));
    expect(fromFile.dbPath).toBe('/tmp/db.sqlite');
    expect(fromFile.downloadDir).toBe('/tmp/dl');

    const fromEnv = load({ MT_DB: '/tmp/env.sqlite', MT_DOWNLOAD_DIR: '/tmp/env-dl' });
    expect(fromEnv.dbPath).toBe('/tmp/env.sqlite');
    expect(fromEnv.downloadDir).toBe('/tmp/env-dl');
  });

  it('finds the bundled migrations without help from the working directory', () => {
    // The service manager chooses the cwd. Resolving migrations against it means a
    // gateway that boots from one directory and fails to find its schema from
    // another -- and an unmigrated database is a first-message failure, not a
    // start-up one.
    const cfg = load();
    expect(isAbsolute(cfg.schemaDir)).toBe(true);
    expect(existsSync(join(cfg.schemaDir, '001_initial.sql'))).toBe(true);
    expect(load({ MT_SCHEMA_DIR: '/tmp/schema' }).schemaDir).toBe('/tmp/schema');
    // Not a file setting: it points at migrations belonging to this build, which is
    // packaging rather than operations.
    expect(() => load({}, yamlFile({ schemaDir: '/tmp/schema' }))).toThrow('unknown setting');
  });

  it('omits the Lark domain rather than guessing one', () => {
    expect('domain' in load().lark).toBe(false);
    expect(load({}, yamlFile({ lark: { domain: 'https://open.larksuite.com' } })).lark.domain).toBe(
      'https://open.larksuite.com',
    );
  });
});

describe('loadConfig: the file must not become a secret store', () => {
  it('refuses a credential-shaped key and says where it belongs', () => {
    // The agent is not sandboxed and runs as the same user, so anything on disk it
    // can read. Accepting these would work, which is why nobody would notice the
    // file had become a secret store until it was in a backup or a commit.
    for (const key of ['appSecret', 'app_secret', 'APP-SECRET', 'apiKey', 'token', 'password']) {
      expect(() => load({}, yamlFile({ lark: { [key]: 'oops' } }))).toThrow(
        /looks like a credential/,
      );
    }
    expect(() => load({}, yamlFile({ lark: { appSecret: 'oops' } }))).toThrow(/LARK_APP_SECRET/);
  });

  it('refuses agent.env, pointing at the two ways to pass a value', () => {
    expect(() => load({}, yamlFile({ agent: { env: { ANTHROPIC_API_KEY: 'sk-oops' } } }))).toThrow(
      /agent\.passEnv, or set MT_AGENT_ENV_/,
    );
  });
});

describe('loadConfig: the file is validated, not trusted', () => {
  it('reports invalid YAML against the file it came from', () => {
    expect(() => load({}, 'workspace: [unclosed\n')).toThrow(
      new RegExp(`${DEFAULT_PATH.replace(/\//g, '\\/')} is not valid YAML`),
    );
  });

  it('refuses a file that is not a mapping', () => {
    expect(() => load({}, '- one\n- two\n')).toThrow('the file must be a mapping');
    expect(() => load({}, 'auth: not-a-mapping\n')).toThrow('auth must be a mapping');
  });

  it('refuses an unknown setting instead of ignoring it', () => {
    // A typo'd key silently taking its default is how a setting someone
    // deliberately changed turns out never to have applied. For the auth keys that
    // failure is silent *and* permissive.
    expect(() => load({}, yamlFile({ workspce: '/srv/repo' }))).toThrow(
      /unknown setting workspce \(known: workspace, /,
    );
    expect(() => load({}, yamlFile({ auth: { talkk: ['ou_a'] } }))).toThrow(
      'unknown setting auth.talkk',
    );
  });

  it("refuses agent.native and agent.skills in the agent: block, whose role has no role.md or skills to render", () => {
    expect(() => load({}, yamlFile({ agent: { native: false } }))).toThrow(/unknown setting agent\.native \(known: driver, /);
    expect(() => load({}, yamlFile({ agent: { skills: ['lark-doc'] } }))).toThrow(/unknown setting agent\.skills \(known: driver, /);
  });

  it('refuses a value of the wrong type', () => {
    expect(() => load({}, yamlFile({ auth: { talk: 'ou_a' } }))).toThrow('auth.talk must be a list');
    expect(() => load({}, yamlFile({ auth: { talk: ['ou_a', ''] } }))).toThrow(
      'auth.talk[1] must be a non-empty string',
    );
    expect(() => load({}, yamlFile({ auth: { mentionAll: 'yes' } }))).toThrow(
      'auth.mentionAll must be true or false',
    );
    expect(() => load({}, yamlFile({ maxLiveSessions: 0 }))).toThrow(
      'maxLiveSessions must be a positive integer',
    );
    expect(() => load({}, yamlFile({ maxLiveSessions: 2.5 }))).toThrow('positive integer');
    expect(() => load({}, yamlFile({ workspace: 12 }))).toThrow(
      'workspace must be a non-empty string',
    );
  });
});

describe('loadConfig: allowlists', () => {
  it('always includes the owner, in both tiers', () => {
    const cfg = load({}, yamlFile({ auth: { talk: ['ou_a'], operate: ['ou_a'] } }));
    // An allowlist that excludes the owner locks out the only person who can fix
    // it, and it is not editable from chat.
    expect(cfg.auth.allowTalk).toEqual([OWNER, 'ou_a']);
    expect(cfg.auth.allowOperate).toEqual([OWNER, 'ou_a']);
  });

  it('is closed when nothing is listed', () => {
    const cfg = load();
    // Empty means closed, not unrestricted -- everyone except the owner.
    expect(cfg.auth.allowTalk).toEqual([OWNER]);
    expect(cfg.auth.allowChats).toEqual([]);
  });

  it('trims, drops blanks and de-duplicates, from either source', () => {
    const fromFile = load({}, yamlFile({ auth: { talk: [' ou_a ', 'ou_b', 'ou_a'] } }));
    expect(fromFile.auth.allowTalk).toEqual([OWNER, 'ou_a', 'ou_b']);

    const fromEnv = load({ MT_ALLOW_TALK: ' ou_a , ,ou_b,ou_a ' });
    expect(fromEnv.auth.allowTalk).toEqual([OWNER, 'ou_a', 'ou_b']);
  });

  it('replaces a list from the environment instead of merging it', () => {
    // Merging would leave no way to revoke: the removed id stays in the file and
    // there is no spelling of "not these" for an emergency lockdown.
    const cfg = load({ MT_ALLOW_TALK: 'ou_c' }, yamlFile({ auth: { talk: ['ou_a', 'ou_b'] } }));
    expect(cfg.auth.allowTalk).toEqual([OWNER, 'ou_c']);
  });

  it('reads a set-but-empty list as owner-only, deliberately', () => {
    const cfg = load({ MT_ALLOW_TALK: '' }, yamlFile({ auth: { talk: ['ou_a'] } }));
    expect(cfg.auth.allowTalk).toEqual([OWNER]);
  });

  it('reads an empty chat allowlist as any chat, which is the documented meaning', () => {
    expect(load().auth.allowChats).toEqual([]);
    expect(load({ MT_ALLOW_CHATS: 'oc_1,oc_2' }).auth.allowChats).toEqual(['oc_1', 'oc_2']);
    expect(load({}, yamlFile({ auth: { chats: ['oc_1'] } })).auth.allowChats).toEqual(['oc_1']);
  });
});

describe('loadConfig: flags and numbers', () => {
  it('defaults @all to off and direct messages to on', () => {
    const cfg = load();
    // `@all` is a room-wide notification, not an instruction.
    expect(cfg.auth.allowMentionAll).toBe(false);
    expect(cfg.auth.allowDirectMessages).toBe(true);
  });

  it('takes booleans from the file as booleans', () => {
    const cfg = load({}, yamlFile({ auth: { mentionAll: true, directMessages: false } }));
    expect(cfg.auth.allowMentionAll).toBe(true);
    expect(cfg.auth.allowDirectMessages).toBe(false);
  });

  it('accepts the spellings people actually type in the environment', () => {
    for (const yes of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(load({ MT_ALLOW_MENTION_ALL: yes }).auth.allowMentionAll).toBe(true);
    }
    for (const no of ['0', 'false', 'No', 'off']) {
      expect(load({ MT_ALLOW_DM: no }).auth.allowDirectMessages).toBe(false);
    }
  });

  it('refuses a flag it cannot read instead of defaulting it', () => {
    expect(() => load({ MT_ALLOW_MENTION_ALL: 'ture' })).toThrow('expected a boolean');
  });

  it('refuses a session cap that is not a positive integer', () => {
    expect(load().maxLiveSessions).toBe(8);
    expect(load({}, yamlFile({ maxLiveSessions: 3 })).maxLiveSessions).toBe(3);
    for (const bad of ['0', '-1', '2.5', 'many']) {
      expect(() => load({ MT_MAX_LIVE_SESSIONS: bad })).toThrow('positive integer');
    }
  });
});

describe('loadConfig: the agent process', () => {
  it('forwards a variable the file names, taking the value from the environment', () => {
    const cfg = load(
      { ANTHROPIC_API_KEY: 'sk-test' },
      yamlFile({ agent: { passEnv: ['ANTHROPIC_API_KEY'] } }),
    );
    expect(cfg.agent?.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
  });

  it('refuses to forward a name that is not set, because that is the typo case', () => {
    // Forwarding nothing surfaces much later as the agent failing to authenticate,
    // which reads as a credential problem rather than a configuration one.
    expect(() => load({}, yamlFile({ agent: { passEnv: ['ANTHROPIC_API_KEY'] } }))).toThrow(
      /passEnv names ANTHROPIC_API_KEY, which is not set/,
    );
  });

  it('refuses to forward the gateway its own configuration or identity', () => {
    // An agent holding the Feishu secret can post as the bot and answer its own
    // approval requests.
    expect(() => load({}, yamlFile({ agent: { passEnv: ['LARK_APP_SECRET'] } }))).toThrow(
      /must not forward LARK_APP_SECRET/,
    );
    expect(() => load({}, yamlFile({ agent: { passEnv: ['MT_HOME'] } }))).toThrow(
      /must not forward MT_HOME/,
    );
  });

  it('forwards only environment variables that opted in by prefix', () => {
    const cfg = load({
      MT_AGENT_ENV_ANTHROPIC_API_KEY: 'sk-test',
      MT_AGENT_ENV_: 'nameless',
      SOME_OTHER_SECRET: 'nope',
    });
    // Forwarding the whole environment would hand the agent the Feishu app secret.
    expect(cfg.agent?.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(Object.values(cfg.agent?.env ?? {})).not.toContain('app-secret');
  });

  it('lets a prefixed variable override one passed through by name', () => {
    const cfg = load(
      { ANTHROPIC_API_KEY: 'sk-ambient', MT_AGENT_ENV_ANTHROPIC_API_KEY: 'sk-for-the-agent' },
      yamlFile({ agent: { passEnv: ['ANTHROPIC_API_KEY'] } }),
    );
    // The prefixed spelling exists to say "this value is for the agent", so it wins
    // over whatever the gateway happens to be running with.
    expect(cfg.agent?.env).toEqual({ ANTHROPIC_API_KEY: 'sk-for-the-agent' });
  });

  it('refuses a subcommand written into the command, from either source', () => {
    // `command: bytesec acp` asks for a file whose name contains a space, because
    // the agent is spawned with `shell: false`. It fails as an ENOENT at the first
    // prompt -- long after boot, and reported as the agent not starting.
    // From the file it says what to write instead, since the fix is not obvious from the symptom.
    expect(() => load({}, yamlFile({ agent: { command: 'bytesec acp' } }))).toThrow(
      /contains a space, and is not a path\. Arguments belong in agent\.args: command: bytesec, args: \[acp\]/,
    );
    // From the environment it names the variable and never echoes the value.
    expect(() => load({ MT_AGENT_COMMAND: 'bytesec acp' })).toThrow(
      /^MT_AGENT_COMMAND contains a space, and is not a path\. Arguments belong in MT_AGENT_ARGS\./,
    );
    expect(() => load({ MT_AGENT_COMMAND: 'bytesec acp' })).not.toThrow(/acp/);
  });

  it('allows a space in an absolute path, which is a real binary name', () => {
    const cfg = load({ MT_AGENT_COMMAND: '/Applications/My App/bin/agent' });
    expect(cfg.agent?.command).toBe('/Applications/My App/bin/agent');
  });

  it('accepts arguments as a list or as one string', () => {
    expect(load({}, yamlFile({ agent: { args: ['--acp', '--debug'] } })).agent?.args).toEqual([
      '--acp',
      '--debug',
    ]);
    expect(
      load({}, yamlFile({ agent: { args: '--acp --flag "two words"' } })).agent?.args,
    ).toEqual(['--acp', '--flag', 'two words']);
    expect(load({ MT_AGENT_ARGS: '--acp --one' }).agent?.args).toEqual(['--acp', '--one']);
  });

  it('does not pretend to be a shell', () => {
    // The agent is spawned with `shell: false`. Accepting expansion here and
    // dropping it there is the half-support that looks like it works.
    expect(load({ MT_AGENT_ARGS: '$(whoami) $HOME' }).agent?.args).toEqual(['$(whoami)', '$HOME']);
  });

  it('defaults to no arguments rather than to a guess', () => {
    expect(load().agent?.args).toEqual([]);
    expect(load({ MT_AGENT_ARGS: '   ' }).agent?.args).toEqual([]);
  });
});

describe('loadConfig: which driver, and on what terms', () => {
  it('defaults to the driver that can ask before acting', () => {
    // ACP is primary. The CLI driver exists for when an agent's ACP server is
    // broken, and defaulting to it would trade the approval flow away by accident.
    expect(load().agent?.driver).toBe('acp');
    expect(load().agent?.unsupervised).toBe(false);
  });

  it('selects a driver from the file or the environment', () => {
    const file = yamlFile({ agent: { driver: 'structured-cli', unsupervised: true } });
    expect(load({}, file).agent?.driver).toBe('structured-cli');
    expect(
      load({ MT_AGENT_DRIVER: 'structured-cli', MT_AGENT_UNSUPERVISED: '1' }).agent?.driver,
    ).toBe('structured-cli');
  });

  it('names the drivers it has rather than accepting one it does not', () => {
    expect(() => load({ MT_AGENT_DRIVER: 'acp2' })).toThrow(
      /must be one of acp, structured-cli/,
    );
  });

  it('refuses a driver that cannot ask until someone writes down that they know', () => {
    // The gateway's whole security story is that touching the workspace takes a
    // click. Under this driver it does not, and a config that switched drivers
    // without saying so would leave the `operate` tier reading as enforced while
    // enforcing nothing.
    expect(() => load({}, yamlFile({ agent: { driver: 'structured-cli' } }))).toThrow(
      /no way to ask for permission/,
    );
    // And says what to write, since "use the other driver" is also a valid answer.
    expect(() => load({ MT_AGENT_DRIVER: 'structured-cli' })).toThrow(
      /Set agent\.unsupervised: true to accept that, or use the acp driver/,
    );
  });

  it('refuses an acknowledgement next to a driver that does ask', () => {
    // Harmless in effect and dangerous as a document: it describes a system that is
    // not the one running, which is how a config comes to be trusted for something
    // it never said.
    expect(() => load({}, yamlFile({ agent: { unsupervised: true } }))).toThrow(
      /has no meaning for the acp driver/,
    );
  });

  it('lets the environment turn supervision back on over a file that gave it up', () => {
    // The emergency direction. Switching back to acp without also finding and
    // deleting the file's acknowledgement would fail on the mismatch, which would
    // make the safer setting the harder one to reach.
    const file = yamlFile({ agent: { driver: 'structured-cli', unsupervised: true } });
    const cfg = load({ MT_AGENT_DRIVER: 'acp', MT_AGENT_UNSUPERVISED: '0' }, file);
    expect(cfg.agent?.driver).toBe('acp');
    expect(cfg.agent?.unsupervised).toBe(false);
  });
});

describe('loadConfig: against a real file', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it('reads config.yaml from MT_HOME with the default reader', () => {
    // The one test that exercises path derivation and the reader together. The
    // default location is computed, and a loader reading the wrong file is
    // indistinguishable from one whose settings are being ignored.
    const dir = mkdtempSync(join(tmpdir(), 'prime-config-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'config.yaml'), FULL_FILE);

    const cfg = loadConfig({ MT_HOME: dir, LARK_APP_SECRET: 'app-secret' });
    expect(cfg.configPath).toBe(join(dir, 'config.yaml'));
    expect(cfg.workspaces['default']).toBe('/srv/repo');
    expect(cfg.dbPath).toBe(join(dir, 'team.db'));
  });

  it('loads the example file the README tells people to copy', () => {
    // The example is documentation that can rot into a file that does not load: a key
    // renamed here, or one of this loader's own refusals tripped by a comment example.
    const dir = mkdtempSync(join(tmpdir(), 'prime-config-'));
    dirs.push(dir);
    copyFileSync(
      fileURLToPath(new URL('../config.example.yaml', import.meta.url)),
      join(dir, 'config.yaml'),
    );

    // Nothing in the environment but the secret, which is the whole point: an
    // example that only loads once you have also guessed at some variable is an
    // example that fails on the first copy.
    const cfg = loadConfig({ MT_HOME: dir, LARK_APP_SECRET: 'app-secret' });
    expect(cfg.auth.ownerOpenId).toMatch(/^ou_/);
    expect(cfg.agent?.env).toEqual({});
    expect(cfg.maxLiveSessions).toBe(8);
  });

  it('starts without a file when the environment carries everything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-config-'));
    dirs.push(dir);
    const cfg = loadConfig({ MT_HOME: dir, LARK_APP_SECRET: 'app-secret', ...ENV_ONLY });
    expect(cfg.configPath).toBeUndefined();
  });
});

describe('loadConfig: after the rename', () => {
  it('looks for its home in ~/.manus-team by default', () => {
    const files = reader({});
    loadConfig({ ...ENV_ONLY, LARK_APP_SECRET: 'app-secret' }, files);
    expect(files.asked).toEqual([join(homedir(), '.manus-team', 'config.yaml')]);
  });

  it('refuses to forward the gateway\'s own variables through passEnv', () => {
    for (const name of ['MT_DB', 'LARK_APP_SECRET']) {
      const file = yamlFile({ agent: { command: 'claude-agent-acp', passEnv: [name] } });
      expect(() => load({ [name]: 'x' }, file)).toThrow('belongs to the gateway');
    }
  });
});

describe('loadConfig: roles and workspaces', () => {
  it('reads named workspaces from the file', () => {
    const cfg = load({}, yamlFile({ workspace: undefined, workspaces: { default: '/srv/a', docs: '/srv/b' } }));
    expect(cfg.workspaces).toEqual({ default: '/srv/a', docs: '/srv/b' });
    expect(cfg.workspaces['default']).toBe('/srv/a');
  });

  it('makes the single workspace setting the workspace named default', () => {
    expect(load().workspaces).toEqual({ default: '/srv/repo' });
    expect(load({ MT_WORKSPACE: '/srv/env' }).workspaces).toEqual({ default: '/srv/env' });
  });

  it('refuses a default workspace set both ways', () => {
    const file = yamlFile({ workspaces: { default: '/srv/a' } });
    expect(() => load({}, file)).toThrow(/workspaces\.default and workspace/);
  });

  it('reads a workspace written as a mapping, isolated or not, beside the plain form', () => {
    const cfg = load(
      {},
      yamlFile({
        workspace: undefined,
        workspaces: {
          default: '/srv/a',
          web: { path: '/srv/web', isolated: true },
          api: { path: '/srv/api', isolated: true, base: 'main' },
          docs: { path: '/srv/docs', isolated: false },
        },
      }),
    );
    expect(cfg.workspaces).toEqual({ default: '/srv/a', web: '/srv/web', api: '/srv/api', docs: '/srv/docs' });
    expect(cfg.isolated).toEqual({ web: {}, api: { base: 'main' } });
    // No isolated workspace, no setting: as before.
    expect(load().isolated).toBeUndefined();
  });

  it('refuses a mapping without a path, with an unknown key, with base but not isolated, or with a base git would misread', () => {
    const bad = (entry: unknown) => () => load({}, yamlFile({ workspace: undefined, workspaces: { default: '/srv/a', web: entry } }));
    expect(bad({ isolated: true })).toThrow('workspaces.web.path is required when the workspace is a mapping');
    expect(bad({ path: '/srv/web', shared: true })).toThrow(/unknown setting workspaces\.web\.shared/);
    expect(bad({ path: '/srv/web', isolated: 'yes' })).toThrow('workspaces.web.isolated must be true or false');
    expect(bad({ path: '/srv/web', base: 'main' })).toThrow('workspaces.web.base applies only to an isolated workspace');
    expect(bad({ path: '/srv/web', isolated: true, base: '--upload-pack=x' })).toThrow(
      'workspaces.web.base must be a branch, a tag or a commit',
    );
    expect(bad({ path: '/srv/web', isolated: true, base: 'two words' })).toThrow('workspaces.web.base must be');
    // Nor one that shows other than it is: a bidi control, or a C1 control.
    expect(bad({ path: '/srv/web', isolated: true, base: 'main\u202e' })).toThrow('workspaces.web.base must be');
    expect(bad({ path: '/srv/web', isolated: true, base: 'ma\u2066in' })).toThrow('workspaces.web.base must be');
    expect(bad({ path: '/srv/web', isolated: true, base: 'main\u0085' })).toThrow('workspaces.web.base must be');
    expect(bad({ path: '/srv/web', isolated: true, base: 'ma\u009bin' })).toThrow('workspaces.web.base must be');
  });

  it('leaves the agent undefined when nothing configures one', () => {
    expect(loadEnvOnly({ ...ENV_ONLY, MT_AGENT_COMMAND: undefined }).agent).toBeUndefined();
  });

  it('treats an agent variable alone as configuring the agent, which then needs a command', () => {
    // The variables define the role default, so the error says which ones are set
    // and both ways out: a stray variable next to roles/default should be unset,
    // and adding a command there only trades this error for a "both define" one.
    const run = () =>
      loadEnvOnly({
        ...ENV_ONLY,
        MT_AGENT_COMMAND: undefined,
        MT_AGENT_ARGS: '--verbose',
        MT_AGENT_ENV_TOKEN: 'secret-value',
      });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/MT_AGENT_ARGS, MT_AGENT_ENV_TOKEN are set but MT_AGENT_COMMAND is not/);
    expect(run).toThrow(/define the role default/);
    expect(run).toThrow(
      `if ${join(HOME, 'roles', 'default')} exists, unset them; otherwise also set MT_AGENT_COMMAND`,
    );
    // Names only: a value set for the agent may be a credential.
    expect(run).not.toThrow(/secret-value|--verbose/);
  });

  it('keeps the agent.command advice for a file agent block with no command', () => {
    const file = yamlFile({ agent: { command: undefined, args: ['acp'] } });
    expect(() => load({ MT_AGENT_ARGS: '--verbose' }, file)).toThrow(
      'an agent command is required: set agent.command in the config file, or MT_AGENT_COMMAND',
    );
  });

  it('reads readOnlyTools and maskExempt in the agent block', () => {
    const file = yamlFile({
      agent: { command: 'claude-agent-acp', readOnlyTools: ['read'], maskExempt: ['API_URL'] },
    });
    const cfg = load({}, file);
    expect(cfg.agent?.readOnlyTools).toEqual(['read']);
    expect(cfg.agent?.maskExempt).toEqual(['API_URL']);
  });

  it('exposes the home it settled on', () => {
    expect(load().home).toBe(HOME);
  });
});

describe('loadTeamSettings', () => {
  it('reads where things are, the workspaces and the agent, without Lark settings or an owner', () => {
    const s = loadTeamSettings(
      { MT_HOME: '/srv/mt', MT_WORKSPACE: '/srv/repo', MT_AGENT_COMMAND: 'claude-agent-acp' },
      () => undefined,
    );
    expect(s).toMatchObject({
      home: '/srv/mt',
      configPath: undefined,
      dbPath: '/srv/mt/team.db',
      workspaces: { default: '/srv/repo' },
    });
    expect(s.agent?.command).toBe('claude-agent-acp');
  });

  it('agrees with loadConfig on everything they share', () => {
    const env = {
      MT_HOME: '/srv/mt',
      MT_WORKSPACE: '/srv/repo',
      MT_AGENT_COMMAND: 'claude-agent-acp',
      MT_OWNER_OPEN_ID: 'ou_owner',
      LARK_APP_ID: 'cli_app',
      LARK_APP_SECRET: 'app-secret',
    };
    const c = loadConfig(env, () => undefined);
    const s = loadTeamSettings(env, () => undefined);
    expect(s).toEqual({
      home: c.home,
      configPath: c.configPath,
      dbPath: c.dbPath,
      workspaces: c.workspaces,
      agent: c.agent,
      kanban: { maxRunning: c.kanban.maxRunning, maxRunningFrom: 'maxLiveSessions' },
    });
    // kanban.enabled is unset: absent here, off there.
    expect(s.kanbanEnabled).toBeUndefined();
    expect(c.kanban.enabled).toBe(false);
  });
});

describe('loadConfig: the kanban section', () => {
  it('defaults to the spec values, off, with max_running at maxLiveSessions', () => {
    expect(load().kanban).toEqual({
      enabled: false,
      maxRunning: 8,
      maxRunningFrom: 'maxLiveSessions',
      failureLimit: 2,
      transientLimit: 10,
      transientCooldownS: 300,
      defaultMaxRuntimeS: 14_400,
      sweepIntervalS: 60,
      strandedAfterS: 1_800,
      nudgeLimit: 2,
      blockRecurrenceLimit: 2,
    });
    expect(load({ MT_MAX_LIVE_SESSIONS: '3' }).kanban.maxRunning).toBe(3);
  });

  it('reads every setting from the file, spelled as the spec spells it', () => {
    const cfg = load(
      {},
      yamlFile({
        kanban: {
          enabled: true,
          max_running: 4,
          failure_limit: 3,
          transient_limit: 5,
          transient_cooldown_s: 60,
          default_max_runtime_s: 600,
          sweep_interval_s: 30,
          stranded_after_s: 120,
          nudge_limit: 1,
          block_recurrence_limit: 3,
        },
      }),
    );
    expect(cfg.kanban).toEqual({
      enabled: true,
      maxRunning: 4,
      failureLimit: 3,
      transientLimit: 5,
      transientCooldownS: 60,
      defaultMaxRuntimeS: 600,
      sweepIntervalS: 30,
      strandedAfterS: 120,
      nudgeLimit: 1,
      blockRecurrenceLimit: 3,
    });
  });

  it('refuses an unknown key, naming the known ones', () => {
    // camelCase, as the rest of the file is, is not this section's spelling.
    expect(() => load({}, yamlFile({ kanban: { failureLimit: 3 } }))).toThrow(
      'unknown setting kanban.failureLimit (known: enabled, max_running, max_running_per_role, failure_limit',
    );
  });

  it('refuses a value that is not a positive whole number, or a flag that is not a boolean', () => {
    expect(() => load({}, yamlFile({ kanban: { failure_limit: 0 } }))).toThrow(
      'kanban.failure_limit must be a positive integer',
    );
    expect(() => load({}, yamlFile({ kanban: { sweep_interval_s: 1.5 } }))).toThrow('positive integer');
    expect(() => load({}, yamlFile({ kanban: { enabled: 'yes' } }))).toThrow('kanban.enabled must be true or false');
    expect(() => load({}, yamlFile({ kanban: [] }))).toThrow('kanban must be a mapping');
  });

  it('refuses max_running above maxLiveSessions: a run is a live session', () => {
    expect(() => load({}, yamlFile({ maxLiveSessions: 4, kanban: { max_running: 5 } }))).toThrow(
      `${DEFAULT_PATH}: kanban.max_running (5) is above maxLiveSessions (4)`,
    );
    expect(load({}, yamlFile({ maxLiveSessions: 4, kanban: { max_running: 4 } })).kanban.maxRunning).toBe(4);
  });

  it("reads max_running_per_role, every role's limit unless the role sets its own", () => {
    expect(load().kanban.maxRunningPerRole).toBeUndefined();
    const cfg = load({}, yamlFile({ kanban: { max_running: 4, max_running_per_role: 2 } }));
    expect(cfg.kanban.maxRunningPerRole).toBe(2);
    // As far as the role limits go, loadTeamSettings sees what loadConfig does.
    expect(loadTeamSettings({ MT_HOME: HOME }, () => yamlFile({ kanban: { max_running: 4, max_running_per_role: 2 } })).kanban).toEqual({
      maxRunning: 4,
      maxRunningPerRole: 2,
    });
  });

  it('refuses a max_running_per_role that is not a positive whole number, or is above max_running', () => {
    expect(() => load({}, yamlFile({ kanban: { max_running_per_role: 0 } }))).toThrow(
      'kanban.max_running_per_role must be a positive integer',
    );
    expect(() => load({}, yamlFile({ kanban: { max_running_per_role: 1.5 } }))).toThrow('positive integer');
    expect(() => load({}, yamlFile({ kanban: { max_running: 3, max_running_per_role: 4 } }))).toThrow(
      `${DEFAULT_PATH}: kanban.max_running_per_role (4) is above kanban.max_running (3)`,
    );
    // max_running's own default, the session limit, bounds it too, and is named.
    expect(() => load({}, yamlFile({ maxLiveSessions: 2, kanban: { max_running_per_role: 3 } }))).toThrow(
      `${DEFAULT_PATH}: kanban.max_running_per_role (3) is above kanban.max_running (2, from maxLiveSessions)`,
    );
    expect(() => load({ MT_MAX_LIVE_SESSIONS: '2' }, yamlFile({ kanban: { max_running_per_role: 3 } }))).toThrow(
      `${DEFAULT_PATH}: kanban.max_running_per_role (3) is above kanban.max_running (2, from MT_MAX_LIVE_SESSIONS)`,
    );
    expect(() => load({}, yamlFile({ maxLiveSessions: undefined, kanban: { max_running_per_role: 9 } }))).toThrow(
      `${DEFAULT_PATH}: kanban.max_running_per_role (9) is above kanban.max_running (8, from maxLiveSessions)`,
    );
    expect(() => loadTeamSettings({ MT_HOME: HOME }, () => yamlFile({ kanban: { max_running: 3, max_running_per_role: 4 } }))).toThrow(
      'kanban.max_running_per_role (4) is above kanban.max_running (3)',
    );
    expect(load({}, yamlFile({ kanban: { max_running: 3, max_running_per_role: 3 } })).kanban.maxRunningPerRole).toBe(3);
    // Set in the file, it is named alone.
    expect(() => load({ MT_MAX_LIVE_SESSIONS: '5' }, yamlFile({ kanban: { max_running: 3, max_running_per_role: 4 } }))).toThrow(
      /is above kanban\.max_running \(3\); /,
    );
  });

  it('names MT_MAX_LIVE_SESSIONS when that is where the session limit came from', () => {
    expect(() => load({ MT_MAX_LIVE_SESSIONS: '2' }, yamlFile({ maxLiveSessions: 8, kanban: { max_running: 5 } }))).toThrow(
      `${DEFAULT_PATH}: kanban.max_running (5) is above MT_MAX_LIVE_SESSIONS (2)`,
    );
  });

  it('refuses a value above its bound, naming the bound', () => {
    // Above setInterval's limit Node runs the timer every millisecond: the sweep would never stop.
    expect(() => load({}, yamlFile({ kanban: { sweep_interval_s: 2_147_484 } }))).toThrow(
      'kanban.sweep_interval_s must be at most 3600, got 2147484',
    );
    // endRun caps a cooldown at an hour, so a longer first cooldown would never apply.
    expect(() => load({}, yamlFile({ kanban: { transient_cooldown_s: 3601 } }))).toThrow(
      'kanban.transient_cooldown_s must be at most 3600',
    );
    expect(() => load({}, yamlFile({ maxLiveSessions: 300, kanban: { max_running: 257 } }))).toThrow(
      'kanban.max_running must be at most 256',
    );
    expect(() => load({}, yamlFile({ kanban: { failure_limit: 101 } }))).toThrow('kanban.failure_limit must be at most 100');
    expect(() => load({}, yamlFile({ kanban: { transient_limit: 1001 } }))).toThrow(
      'kanban.transient_limit must be at most 1000',
    );
    expect(() => load({}, yamlFile({ kanban: { default_max_runtime_s: 7 * 86_400 + 1 } }))).toThrow(
      'kanban.default_max_runtime_s must be at most 604800',
    );
    expect(() => load({}, yamlFile({ kanban: { stranded_after_s: 30 * 86_400 + 1 } }))).toThrow(
      'kanban.stranded_after_s must be at most 2592000',
    );
  });

  it('accepts every bound itself', () => {
    const cfg = load(
      {},
      yamlFile({
        maxLiveSessions: 256,
        kanban: {
          max_running: 256,
          failure_limit: 100,
          transient_limit: 1000,
          transient_cooldown_s: 3600,
          default_max_runtime_s: 7 * 86_400,
          sweep_interval_s: 3600,
          stranded_after_s: 30 * 86_400,
        },
      }),
    );
    expect(cfg.kanban.sweepIntervalS).toBe(3600);
    expect(cfg.kanban.maxRunning).toBe(256);
  });
});

describe('loadConfig: kanban.block_recurrence_limit', () => {
  it('is a positive whole number, at most 100, and is file only', () => {
    expect(load({}, yamlFile({ kanban: { block_recurrence_limit: 1 } })).kanban.blockRecurrenceLimit).toBe(1);
    expect(() => load({}, yamlFile({ kanban: { block_recurrence_limit: 0 } }))).toThrow(
      'kanban.block_recurrence_limit must be a positive integer',
    );
    expect(() => load({}, yamlFile({ kanban: { block_recurrence_limit: 101 } }))).toThrow(
      'kanban.block_recurrence_limit must be at most 100, got 101',
    );
    expect(load({ MT_KANBAN_BLOCK_RECURRENCE_LIMIT: '5' }).kanban.blockRecurrenceLimit).toBe(2);
  });
});

describe('loadConfig: kanban.nudge_limit', () => {
  it('takes 0, meaning no reminder, and refuses a negative or a fraction', () => {
    expect(load({}, yamlFile({ kanban: { nudge_limit: 0 } })).kanban.nudgeLimit).toBe(0);
    expect(() => load({}, yamlFile({ kanban: { nudge_limit: -1 } }))).toThrow(
      'kanban.nudge_limit must be a whole number, 0 or more, got -1',
    );
    expect(() => load({}, yamlFile({ kanban: { nudge_limit: 1.5 } }))).toThrow('kanban.nudge_limit must be a whole number');
  });

  it('refuses more than 10 reminders, and is file only', () => {
    expect(() => load({}, yamlFile({ kanban: { nudge_limit: 11 } }))).toThrow('kanban.nudge_limit must be at most 10, got 11');
    expect(load({}, yamlFile({ kanban: { nudge_limit: 10 } })).kanban.nudgeLimit).toBe(10);
    expect(load({ MT_KANBAN_NUDGE_LIMIT: '5' }).kanban.nudgeLimit).toBe(2);
  });
});
