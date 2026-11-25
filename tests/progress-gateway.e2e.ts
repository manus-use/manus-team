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

/**
 * Progress cards through createGateway (progress cards spec §14): the fake
 * Lark channel and the fake CLI agent in its `staged` mode, a task in a
 * group's thread run by a role, its card sent in the thread, updated as its
 * tool completes, drawn final when it completes, above the notice; a Stop on
 * the card stops the run; a task at a group's chat scope gets none; and with
 * the switch off nothing is sent.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));
const CHANNEL_METHODS = ['sendText', 'openCard', 'sendApprovalCard', 'updateApprovalCard', 'sendCard', 'updateCard', 'react', 'unreact', 'chatMembers'] as const;

interface Person {
  openId: string;
  unionId: string;
  name: string;
}
const OWNER: Person = { openId: 'ou_owner', unionId: 'on_owner', name: 'Alice' };

let root: string;
let config: GatewayConfig;
let lark: FakeChannel;
let handlers: { message: (msg: unknown) => Promise<void>; cardAction: (evt: unknown) => Promise<void> } | undefined;
let gateway: Gateway | undefined;
let lines: string[];
let seq = 0;

beforeEach(() => {
  clearSecrets();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-cards-gw-')));
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'repo'));
  const env = {
    MT_HOME: home,
    MT_DB: join(home, 'team.db'),
    MT_WORKSPACE: join(root, 'repo'),
    MT_OWNER_OPEN_ID: OWNER.openId,
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: process.execPath,
    MT_AGENT_ARGS: AGENT,
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
    MT_AGENT_ENV_FAKE_CLI_MODE: 'staged',
    MT_AGENT_ENV_FAKE_CLI_LOG: join(root, 'agent.log'),
  };
  const loaded = loadConfig(env, () => undefined);
  config = { ...loaded, kanban: { ...loaded.kanban, enabled: true, progress: { enabled: true, minSeconds: 0 } } };
  lark = new FakeChannel({ id: 'lark' });
  lines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
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
    vi.spyOn(LarkAdapter.prototype as unknown as Channel, method).mockImplementation(((...args: unknown[]) =>
      (lark as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.apply(lark, args)) as never);
  }
});

afterEach(async () => {
  // Let a held agent finish, so the stop does not wait on it.
  writeFileSync(join(root, 'release-1'), '');
  writeFileSync(join(root, 'release-2'), '');
  await gateway?.stop();
  gateway = undefined;
  vi.restoreAllMocks();
  clearSecrets();
  rmSync(root, { recursive: true, force: true });
});

async function start(over: Partial<GatewayConfig> = {}): Promise<Gateway> {
  gateway = await createGateway({ ...config, ...over }, loadTeam(config, {}));
  await gateway.start();
  return gateway;
}

/** A message in the group, addressed to the bot, as the SDK hands it on. */
async function say(text: string, threadId?: string): Promise<string> {
  if (handlers === undefined) throw new Error('the inbound side is not listening');
  const messageId = `om_cards_${++seq}`;
  await handlers.message({
    messageId,
    chatId: 'oc_team',
    chatType: 'group',
    threadId,
    senderId: OWNER.openId,
    senderName: OWNER.name,
    content: text,
    mentionedBot: true,
    mentionAll: false,
    resources: [],
    createTime: Date.now(),
    raw: {
      sender: { sender_type: 'user', sender_id: { union_id: OWNER.unionId } },
      message: { mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: 'ou_bot' } }] },
    },
  });
  return messageId;
}

async function press(messageId: string, value: Readonly<Record<string, string>>): Promise<void> {
  if (handlers === undefined) throw new Error('the inbound side is not listening');
  await handlers.cardAction({
    messageId,
    chatId: 'oc_team',
    operator: { openId: OWNER.openId, name: OWNER.name },
    action: { value: { ...value }, tag: 'button' },
    raw: { operator: { union_id: OWNER.unionId } },
  });
}

/** Wait for `ok`, polling, for up to about 45 s: a loaded machine starts the fake agent slowly. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1800; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`gave up waiting for ${what}`);
}

const updates = (): string[] => lark.cardUpdates.map((u) => u.view.markdown);

describe('progress cards through createGateway', () => {
  it('sends a run in a thread one card there, updates it as its tool completes, and draws it final above the notice', async () => {
    await start();
    expect(lines.some((l) => l.includes('kanban: progress cards on, for agent runs past 0 s'))).toBe(true);
    const command = await say('/kanban task new Find the files\nassignee: default');
    const thread = `omt_${command}`;

    await until('the card', () => lark.boardCards.length > 0);
    const card = lark.boardCards[0]!;
    expect(card.target.threadId).toBe(thread);
    expect(card.view.markdown).toContain('**Find the files**');
    expect(card.view.buttons.map((b) => b.label)).toEqual(['Stop']);
    // With min_seconds 0 the card may go before the agent's first event: its tool shows by an update if not.
    await until('the tool running', () => [card.view.markdown, ...updates()].some((m) => m.includes(' Glob') && !m.includes('✅ Glob')));

    writeFileSync(join(root, 'release-1'), '');
    await until('the card updated', () => updates().some((m) => m.includes('✅ Glob') && m.includes('Found the two files.')));

    writeFileSync(join(root, 'release-2'), '');
    await until('the final card', () => updates().some((m) => m.includes('✓ completed after')));
    const final = lark.cardUpdates.at(-1);
    expect(final?.view.buttons).toEqual([]);
    expect(final?.view.markdown).toContain('✅ Glob');
    await until('the notice', () => lark.texts.some((m) => m.text.startsWith('Done: **Find the files**')));
    expect(lark.boardCards).toHaveLength(1);
    // The card was sent before the notice, so it is above it in the thread.
    const noticeAt = lark.texts.findIndex((m) => m.text.startsWith('Done: **Find the files**'));
    const sendTexts = lark.calls.flatMap((c, i) => (c === 'sendText' ? [i] : []));
    expect(lark.calls.indexOf('sendCard')).toBeLessThan(sendTexts[noticeAt] ?? -1);
    expect(lark.texts[noticeAt]?.target.threadId).toBe(thread);
  });

  it('stops the run from the card, and draws it final as stopped', async () => {
    await start();
    await say('/kanban task new Find the files\nassignee: default');
    await until('the card', () => lark.boardCards.length > 0);
    const stop = lark.boardCards[0]?.view.buttons[0]?.value;
    if (stop === undefined) throw new Error('no Stop');
    const task = gateway?.db.prepare<[], { task_id: string }>('SELECT task_id FROM kanban_tasks').get()?.task_id;
    const messageId = gateway?.db.prepare<[], { message_id: string }>('SELECT message_id FROM kanban_progress_cards').get()?.message_id;
    await press(messageId ?? '', stop);
    await until('the task stopped', () => gateway?.db.prepare<[string], { phase: string }>('SELECT phase FROM kanban_tasks WHERE task_id = ?').get(task ?? '')?.phase === 'blocked');
    await until('the card final', () => updates().some((m) => m.includes('⏸ stopped after')));
    expect(lark.cardUpdates.every((u) => u.messageId === lark.cardUpdates[0]?.messageId)).toBe(true);
  });

  it("sends no card for a task at a group's chat scope, and its notice still goes there", async () => {
    await start();
    // Lark answers the "Created" reply with no thread: the task stays at the group's chat scope.
    lark.replyThreads = false;
    await say('/kanban task new Find the files\nassignee: default');
    const working = (): boolean =>
      gateway?.db.prepare('SELECT 1 FROM kanban_runs WHERE ended_at IS NULL AND session_id IS NOT NULL').get() !== undefined;
    await until('the run to be working', working);
    // A round while the run is open, past min_seconds: nothing for the group.
    await gateway?.progress?.round();
    expect(lark.boardCards).toEqual([]);
    writeFileSync(join(root, 'release-1'), '');
    writeFileSync(join(root, 'release-2'), '');
    await until('the notice', () => lark.texts.some((m) => m.text.startsWith('Done: **Find the files**')));
    await gateway?.progress?.round();
    expect(lark.boardCards).toEqual([]);
    expect(lark.texts.find((m) => m.text.startsWith('Done: **Find the files**'))?.target.threadId).toBe('');
  });

  it('sends nothing with the switch off', async () => {
    await start({ kanban: { ...config.kanban, progress: { enabled: false, minSeconds: 0 } } });
    expect(gateway?.progress).toBeUndefined();
    await say('/kanban task new Find the files\nassignee: default');
    writeFileSync(join(root, 'release-1'), '');
    writeFileSync(join(root, 'release-2'), '');
    await until('the notice', () => lark.texts.some((m) => m.text.startsWith('Done: **Find the files**')));
    expect(lark.boardCards).toEqual([]);
    expect(lines.some((l) => l.includes('progress cards'))).toBe(false);
  });
});
