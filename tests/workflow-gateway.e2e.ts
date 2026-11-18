import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import type { Channel } from '../src/channel/types.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam } from '../src/team.js';
import { FakeChannel } from './helpers/channel.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * Workflows in chat through createGateway (workflows spec §10): the board the
 * gateway builds reads $MT_HOME/workflows, so `/kanban workflow list` lists a
 * file put there while the gateway runs, as `mt kanban workflow list` does.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

let root: string;
let home: string;
let env: Record<string, string>;
let config: GatewayConfig;
let lark: FakeChannel;
let handlers: { message: (msg: unknown) => Promise<void> } | undefined;
let gateway: Gateway | undefined;
let seq = 0;

const CHANNEL_METHODS = ['sendText', 'openCard', 'sendApprovalCard', 'updateApprovalCard', 'sendCard', 'updateCard', 'react', 'unreact', 'chatMembers'] as const;

interface Person {
  openId: string;
  unionId: string;
  name: string;
}
const OWNER: Person = { openId: 'ou_owner', unionId: 'on_owner', name: 'Alice' };
const BOB: Person = { openId: 'ou_bob', unionId: 'on_bob', name: 'Bob' };

beforeEach(() => {
  clearSecrets();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-wf-gw-')));
  home = join(root, 'home');
  mkdirSync(home);
  for (const role of ['worker', 'reviewer']) {
    mkdirSync(join(home, 'roles', role), { recursive: true });
    writeFileSync(join(home, 'roles', role, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  }
  mkdirSync(join(root, 'repo'));
  env = {
    MT_HOME: home,
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: join(root, 'repo'),
    MT_OWNER_OPEN_ID: OWNER.openId,
    MT_ALLOW_TALK: BOB.openId,
    MT_ALLOW_OPERATE: BOB.openId,
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: process.execPath,
    MT_AGENT_ARGS: AGENT,
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
  };
  const loaded = loadConfig(env, () => undefined);
  config = { ...loaded, kanban: { ...loaded.kanban, enabled: true } };
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

/** A message in the group, addressed to the bot, mentioning `mentions`, as the SDK hands it to the inbound side. */
async function inGroup(sender: Person, text: string, mentions: Person[] = []): Promise<string> {
  if (handlers === undefined) throw new Error('the inbound side is not listening');
  const messageId = `om_wf_${++seq}`;
  await handlers.message({
    messageId,
    chatId: 'oc_team',
    chatType: 'group',
    threadId: undefined,
    senderId: sender.openId,
    senderName: sender.name,
    content: text,
    mentionedBot: true,
    mentionAll: false,
    resources: [],
    createTime: Date.now(),
    raw: {
      sender: { sender_type: 'user', sender_id: { union_id: sender.unionId } },
      message: {
        mentions: [
          { key: '@_user_1', name: 'Bot', id: { open_id: 'ou_bot' } },
          ...mentions.map((m, i) => ({ key: `@_user_${i + 2}`, name: m.name, id: { open_id: m.openId, union_id: m.unionId } })),
        ],
      },
    },
  });
  return messageId;
}

const replies = (): string[] => lark.texts.map((m) => m.text);

describe('workflows in chat through createGateway', () => {
  it('lists a workflow file put in $MT_HOME/workflows after the gateway started', async () => {
    gateway = await createGateway(config, loadTeam(config, {}));
    await gateway.start();

    await inGroup(OWNER, '/kanban workflow list');
    expect(replies().at(-1)).toMatch(/^No workflows/);

    mkdirSync(join(home, 'workflows'));
    writeFileSync(join(home, 'workflows', 'vendor-eval.yaml'), VENDOR_EVAL);
    await inGroup(OWNER, '/kanban workflow list');
    expect(replies().at(-1)).toContain('**vendor-eval**');
  });
});
