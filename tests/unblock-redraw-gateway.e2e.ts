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
import { until } from './helpers/dispatch.js';

/**
 * The unblock redraw through createGateway (kanban spec §9.2, amended): a
 * notice's Unblock pressed in chat redraws its message, the button replaced by
 * who unblocked it, and a block lifted by `/kanban task unblock` is redrawn by
 * the gateway's loop.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

let root: string;
let home: string;
let env: Record<string, string>;
let config: GatewayConfig;
let lark: FakeChannel;
let handlers: { message: (msg: unknown) => Promise<void>; cardAction: (evt: unknown) => Promise<void> } | undefined;
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-unblock-gw-')));
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
  const messageId = `om_ub_${++seq}`;
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

/** A press of a button under `messageId`, by `who`, as the SDK hands it to the inbound side. */
async function press(who: Person, messageId: string, value: Readonly<Record<string, string>>): Promise<void> {
  if (handlers === undefined) throw new Error('the inbound side is not listening');
  await handlers.cardAction({
    messageId,
    chatId: 'oc_team',
    operator: { openId: who.openId, name: who.name },
    action: { value: { ...value }, tag: 'button' },
    raw: { operator: { union_id: who.unionId } },
  });
}

function taskIds(): string[] {
  if (gateway === undefined) throw new Error('no gateway');
  return gateway.db
    .prepare<[], { task_id: string }>('SELECT task_id FROM kanban_tasks ORDER BY created_at, task_id')
    .all()
    .map((r) => r.task_id);
}

/** The notice sent with an Unblock for `taskId`, once the notifier has sent it. */
async function noticeFor(taskId: string): Promise<{ messageId: string; text: string; value: Readonly<Record<string, string>> }> {
  await gateway?.notifier?.deliver();
  const i = lark.texts.findIndex((m) => m.buttons?.some((b) => b.value['task'] === taskId) === true);
  const sent = lark.texts[i];
  const button = sent?.buttons?.find((b) => b.value['task'] === taskId);
  if (sent === undefined || button === undefined) throw new Error(`no Unblock for ${taskId}`);
  const row = gateway?.db
    .prepare<[string], { message_id: string }>('SELECT message_id FROM kanban_unblock_buttons WHERE task_id = ?')
    .get(taskId);
  if (row === undefined) throw new Error(`no record of the Unblock for ${taskId}`);
  return { messageId: row.message_id, text: sent.text, value: button.value };
}

describe('the unblock redraw through createGateway', () => {
  it("redraws a notice once its Unblock is pressed, and once a block is lifted by /kanban task unblock", async () => {
    gateway = await createGateway(config, loadTeam(config, {}));
    await gateway.start();

    await inGroup(OWNER, '/kanban task new Check the links\nassignee: @Bob', [BOB]);
    await inGroup(OWNER, '/kanban task new Draft the notes\nassignee: @Bob', [BOB]);
    const [a, b] = taskIds();
    if (a === undefined || b === undefined) throw new Error('two tasks were not created');
    await inGroup(OWNER, `/kanban task stop ${a}`);

    // A press of the notice's Unblock: the message redrawn, the button gone, by the presser's chat name.
    const first = await noticeFor(a);
    await press(OWNER, first.messageId, first.value);
    await until(() => lark.cardUpdates.some((u) => u.messageId === first.messageId), 'the pressed notice redrawn');
    const drawn = lark.cardUpdates.find((u) => u.messageId === first.messageId);
    expect(drawn?.view.buttons).toEqual([]);
    expect(drawn?.view.markdown).toMatch(new RegExp(`^${escape(first.text)}\n\n\`${a}\`: Unblocked by Alice at \\d\\d:\\d\\d$`));

    // Lifted by a command, not a press: the gateway's loop redraws it.
    await inGroup(OWNER, `/kanban task stop ${b}`);
    const second = await noticeFor(b);
    await inGroup(OWNER, `/kanban task unblock ${b}`);
    // Its own round, or the one the loop has under way.
    await gateway.unblockRedraws?.redrawDue();
    await until(() => lark.cardUpdates.some((u) => u.messageId === second.messageId), 'the unblocked notice redrawn');
    const redrawn = lark.cardUpdates.find((u) => u.messageId === second.messageId);
    expect(redrawn?.view.buttons).toEqual([]);
    expect(redrawn?.view.markdown).toContain(`\`${b}\`: Unblocked by Alice at `);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
