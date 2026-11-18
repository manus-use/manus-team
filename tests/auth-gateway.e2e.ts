import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import type { Channel } from '../src/channel/types.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { resolveBinding } from '../src/db/bindings.js';
import { createGateway, type Gateway } from '../src/index.js';
import { mtCommand } from '../src/kanban/shim.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam } from '../src/team.js';
import { FakeChannel } from './helpers/channel.js';

/**
 * Tier grants through createGateway (the tier grants spec §11, end to end),
 * with the fake chat standing in for Lark and the fake CLI agent for the
 * role's, the board and cron off: the owner grants talk in a group and the
 * person's next message runs a turn, whose agent has the session marker in
 * its environment; an operator's grant of operate is refused; and `mt auth
 * revoke`, run as another process while the gateway runs, refuses the
 * person's next message, with no restart.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));

let root: string;
let home: string;
let log: string;
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
const CAROL: Person = { openId: 'ou_carol', unionId: 'on_carol', name: 'Carol Wu' };
const DAN: Person = { openId: 'ou_dan', unionId: 'on_dan', name: 'Dan' };

beforeEach(() => {
  clearSecrets();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-auth-gw-')));
  home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'repo'));
  log = join(root, 'agent.log');
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
    MT_AGENT_ENV_FAKE_CLI_LOG: log,
  };
  config = loadConfig(env, () => undefined);
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
  const messageId = `om_auth_${++seq}`;
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

/** Wait for `ok`, polling, for up to about 30 s: a loaded machine starts the fake agent slowly. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1200; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** The turns the fake agent was given, in order: each prompt, and the session marker in its environment. */
function turns(): Array<{ prompt: string; marker: string | null }> {
  try {
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { prompt: string; marker: string | null });
  } catch {
    return [];
  }
}

const prompts = (): string[] => turns().map((t) => t.prompt);

const replies = (): string[] => lark.texts.map((m) => m.text);

/** `mt <args>` as another process: this build's, with the gateway's settings. */
function mt(args: string[]): Promise<{ status: number | null; out: string; err: string }> {
  const [command, ...rest] = mtCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command ?? process.execPath, [...rest, ...args], { env: { ...env, PATH: process.env['PATH'] ?? '', HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.on('data', (d: string) => (err += d));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, out: out.trim(), err: err.trim() }));
  });
}

function outcome(messageId: string): string | undefined {
  return (gateway?.db.prepare('SELECT outcome FROM seen_messages WHERE message_id = ?').get(messageId) as { outcome: string } | undefined)?.outcome;
}

describe('tier grants through createGateway', () => {
  it("lets a person granted talk in a group run a turn at once, refuses an operator's grant of operate, and takes a terminal's revoke at the next message", async () => {
    gateway = await createGateway(config, loadTeam(config, {}));
    await gateway.start();

    const before = await inGroup(CAROL, 'before the grant');
    expect(outcome(before)).toBe('rejected');

    await inGroup(OWNER, '/auth grant @Carol Wu talk', [CAROL]);
    expect(replies().at(-1)).toBe('Carol Wu now has talk tier, granted by Alice. `/auth revoke lark:on_carol` takes it back.');
    await inGroup(CAROL, 'hello after the grant');
    await until('the turn to run', () => prompts().some((p) => p.includes('hello after the grant')));
    // A chat session's agent, with cron off, is marked as an agent's shell all the same (tier grants spec §6.3).
    const session = resolveBinding(gateway.db, { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' })?.sessionId;
    expect(session).toMatch(/^s_/);
    expect(turns().find((t) => t.prompt.includes('hello after the grant'))?.marker).toBe(session);

    await inGroup(BOB, '/auth grant @Dan operate', [DAN]);
    expect(replies().at(-1)).toBe('Only the owner grants operate tier: an operator cannot make another operator.');

    const revoked = await mt(['auth', 'revoke', 'lark:on_carol', '--json']);
    expect(revoked.status, revoked.err).toBe(0);
    expect(JSON.parse(revoked.out)).toEqual({ ok: true, outcome: 'revoked', tier: null, principal: 'lark:on_carol' });
    const after = await inGroup(CAROL, 'hello after the revoke');
    expect(outcome(after)).toBe('rejected');
    expect(prompts().some((p) => p.includes('after the revoke'))).toBe(false);
  });
});
