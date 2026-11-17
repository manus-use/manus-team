import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import type { Channel } from '../src/channel/types.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { cronUuid } from '../src/core/ids.js';
import { firesOf, listJobs } from '../src/db/cron.js';
import { createGateway, type Gateway } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam } from '../src/team.js';
import { FakeChannel } from './helpers/channel.js';

/**
 * A cron job fired through createGateway (the cron spec, §5, §7): the gateway's
 * own composition of envFor, argsFor and pinned, its cron sink channel and the
 * router's cronTurns, with the fake chat standing in for Lark and the fake CLI
 * agent for the role's. A chat agent adds a job with `mt cron add`, a `/cron
 * run` fires it, and its answer is posted once; the chat turn and the fire
 * both find mt first on PATH, then the role's own PATH.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));
const ROLE_PATH = `/opt/role-only/bin${delimiter}${process.env['PATH'] ?? ''}`;

let root: string;
let home: string;
let log: string;
let config: GatewayConfig;
let lark: FakeChannel;
let handlers: { message: (msg: unknown) => Promise<void> } | undefined;
let gateway: Gateway | undefined;
let seq = 0;

/** Every Channel method of the Lark adapter, answered by the fake chat. */
const CHANNEL_METHODS = ['sendText', 'openCard', 'sendApprovalCard', 'updateApprovalCard', 'sendCard', 'updateCard', 'react', 'unreact', 'chatMembers'] as const;

beforeEach(() => {
  clearSecrets();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-cron-gw-')));
  home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'repo'));
  log = join(root, 'agent.log');
  const env = {
    MT_HOME: home,
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: join(root, 'repo'),
    MT_OWNER_OPEN_ID: 'ou_owner',
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: process.execPath,
    MT_AGENT_ARGS: AGENT,
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
    MT_AGENT_ENV_PATH: ROLE_PATH,
    MT_AGENT_ENV_FAKE_CLI_MODE: 'cron',
    MT_AGENT_ENV_FAKE_CLI_LOG: log,
  };
  config = { ...loadConfig(env, () => undefined), cron: { enabled: true, maxRunning: 2, idleTimeoutS: 600, tz: 'Asia/Shanghai' } };
  lark = new FakeChannel({ id: 'lark' });
  vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(LarkAdapter.prototype, 'disconnect').mockResolvedValue(undefined);
  vi.spyOn(LarkAdapter.prototype, 'botOpenId', 'get').mockReturnValue('ou_bot');
  vi.spyOn(LarkAdapter.prototype, 'raw', 'get').mockReturnValue({
    on: (h: typeof handlers) => {
      handlers = h;
      return () => {
        handlers = undefined;
      };
    },
  } as never);
  for (const method of CHANNEL_METHODS) {
    const fake = (lark as unknown as Record<string, (...args: unknown[]) => unknown>)[method] as (...args: unknown[]) => unknown;
    vi.spyOn(LarkAdapter.prototype as unknown as Channel, method).mockImplementation(((...args: unknown[]) => fake.apply(lark, args)) as never);
  }
});

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  vi.restoreAllMocks();
  clearSecrets();
  rmSync(root, { recursive: true, force: true });
});

/** A direct message from the owner, as the SDK hands it to the inbound side. */
async function say(text: string): Promise<void> {
  if (handlers === undefined) throw new Error('the inbound side is not listening');
  await handlers.message({
    messageId: `om_gw_${++seq}`,
    chatId: 'oc_owner_dm',
    chatType: 'p2p',
    threadId: undefined,
    senderId: 'ou_owner',
    senderName: 'Owner',
    content: text,
    mentionedBot: false,
    mentionAll: false,
    resources: [],
    createTime: Date.now(),
    raw: { sender: { sender_type: 'user', sender_id: { union_id: 'on_owner' } } },
  });
}

/** Wait for `ok`, polling, for up to about 30 s: a loaded machine starts the fake agent slowly. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1200; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`gave up waiting for ${what}`);
}

function turnsSeen(): Array<{ fire: string | null; path: string | null }> {
  try {
    return readFileSync(join(root, 'cron-env.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { fire: string | null; path: string | null });
  } catch {
    return [];
  }
}

describe('a cron job fired through createGateway', () => {
  it("posts its fire once, and gives the chat turn and the fire mt first, then the role's PATH", async () => {
    const team = loadTeam(config, {});
    gateway = await createGateway(config, team);
    await gateway.start();
    const db = gateway.db;
    const shimFirst = `${join(home, 'bin')}${delimiter}${ROLE_PATH}`;

    await say(`cron-add ${JSON.stringify({ schedule: 'every 1h', prompt: 'Count the open PRs.', name: 'PR count' })}`);
    await until('the job to be added', () => listJobs(db).length === 1);
    const [job] = listJobs(db);
    expect(job).toMatchObject({ name: 'PR count', role: 'default', createdBy: expect.stringMatching(/^session:s_/), delivery: { chat: 'oc_owner_dm' } });
    // The chat turn's agent: the shim's directory, then the role's own PATH, not the gateway's.
    expect(turnsSeen()).toEqual([{ fire: null, path: shimFirst }]);

    await say(`/cron run ${job?.jobId ?? ''}`);
    await until('the fire to be posted', () => firesOf(db, job?.jobId ?? '')[0]?.delivery === 'sent');
    const fire = firesOf(db, job?.jobId ?? '')[0];
    expect(fire).toMatchObject({ trigger: 'run', outcome: 'posted' });
    const posted = lark.texts.filter((m) => m.uuid === cronUuid('cli_app', job?.jobId ?? '', fire?.fireId ?? 0, 0));
    expect(posted).toHaveLength(1);
    expect(posted[0]?.text).toMatch(/^\*\*PR count\*\* · run now · \d+s\nFired: Count the open PRs\.$/);
    expect(lark.texts.filter((m) => m.text.includes('Fired:'))).toHaveLength(1);
    expect(turnsSeen()).toEqual([
      { fire: null, path: shimFirst },
      { fire: String(fire?.fireId), path: shimFirst },
    ]);
  });
});
