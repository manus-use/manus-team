import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import type { Channel } from '../src/channel/types.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/index.js';
import { mtCommand } from '../src/kanban/shim.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam } from '../src/team.js';
import { FakeChannel } from './helpers/channel.js';

/**
 * Wakes through createGateway (wake spec §14, end to end): the gateway's own
 * waker, wake tokens and socket, with the fake chat standing in for Lark and the
 * fake CLI agent for the default role's, both a board run's and a chat
 * session's. A completion's notice, then the marker, then the woken turn's
 * card, in that order, with the marker's send made slow; a message typed during
 * the woken turn queued; a block lifted by the woken agent's own `mt kanban task
 * unblock`, with its wake token, and its notice redrawn; a revoked grant's task
 * noticed and not woken; a direct message's task not woken with direct messages
 * off; and a pending wake woken once after a restart.
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
let lines: string[];
let seq = 0;

const CHANNEL_METHODS = ['sendText', 'openCard', 'sendApprovalCard', 'updateApprovalCard', 'sendCard', 'updateCard', 'react', 'unreact', 'chatMembers'] as const;

interface Person {
  openId: string;
  unionId: string;
  name: string;
}
const OWNER: Person = { openId: 'ou_owner', unionId: 'on_owner', name: 'Alice' };
const CAROL: Person = { openId: 'ou_carol', unionId: 'on_carol', name: 'Carol Wu' };

beforeEach(() => {
  clearSecrets();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-wake-gw-')));
  home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'repo'));
  log = join(root, 'agent.log');
  env = {
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
    MT_AGENT_ENV_FAKE_CLI_MODE: 'wake',
    MT_AGENT_ENV_FAKE_CLI_LOG: log,
  };
  // In the home's file, so the terminal's mt reads the board as on too, and nudges the gateway after a change.
  writeFileSync(join(home, 'config.yaml'), 'kanban:\n  enabled: true\n');
  config = loadConfig(env);
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

/** A message addressed to the bot, in the group or one of its threads, or in a direct message, as the SDK hands it on. */
async function say(sender: Person, text: string, at: { threadId?: string; dm?: boolean } = {}, mentions: Person[] = []): Promise<string> {
  if (handlers === undefined) throw new Error('the inbound side is not listening');
  const messageId = `om_wake_${++seq}`;
  await handlers.message({
    messageId,
    chatId: at.dm === true ? 'oc_alice_dm' : 'oc_team',
    chatType: at.dm === true ? 'p2p' : 'group',
    threadId: at.threadId,
    senderId: sender.openId,
    senderName: sender.name,
    content: text,
    mentionedBot: at.dm !== true,
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

/** Wait for `ok`, polling, for up to about 45 s: a loaded machine starts the fake agent slowly. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1800; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** The chat turns the fake agent ran: each prompt, whether it had a wake token, and its unblock's answer. */
function chatTurns(): Array<{ prompt: string; token: boolean; unblocked: { status: number | null; out: string; err: string } | null }> {
  try {
    return readFileSync(join(root, 'wake.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { prompt: string; token: boolean; unblocked: { status: number | null; out: string; err: string } | null });
  } catch {
    return [];
  }
}

const woken = (): ReturnType<typeof chatTurns> => chatTurns().filter((t) => t.prompt.startsWith('Board update'));

const texts = (): string[] => lark.texts.map((m) => m.text);

/** The task a "Created" reply named, the latest. */
function createdTask(): string {
  const id = [...texts()].reverse().map((t) => /^Created `(k_[0-9a-z]+)`/.exec(t)?.[1]).find((x) => x !== undefined);
  if (id === undefined) throw new Error('no task created');
  return id;
}

function wakes(): Array<{ state: string; attempt: number; principal: string }> {
  return (gateway?.db.prepare('SELECT state, attempt, principal FROM kanban_wakes ORDER BY wake_id').all() ?? []) as Array<{ state: string; attempt: number; principal: string }>;
}

function phaseOf(taskId: string): string | undefined {
  return (gateway?.db.prepare('SELECT phase FROM kanban_tasks WHERE task_id = ?').get(taskId) as { phase: string } | undefined)?.phase;
}

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

describe('wakes through createGateway', () => {
  it("sends the notice, then the marker, then the woken turn's card, and queues a message typed during the woken turn", async () => {
    await start();
    // Slow, but inside a send's bound: the turn waits for it all the same (wake spec §5.5 step 3).
    lark.slowTexts.push({ match: 'Waking the agent', ms: 1_500 });
    const command = await say(OWNER, '/kanban task new Book the SLOW venue\nassignee: default\nwake: on');
    expect(texts().at(-1)).toMatch(/^Created `k_[0-9a-z]+`.*Its outcomes wake the agent here\.$/s);
    const taskId = createdTask();
    const thread = `omt_${command}`;

    await until('the woken turn to start', () => lark.landed.includes('card'));
    const notice = lark.landed.findIndex((l) => l.startsWith('text:Done: **Book the SLOW venue**'));
    const marker = lark.landed.indexOf('text:Waking the agent for 1 board update.');
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(notice);
    expect(lark.landed.indexOf('card')).toBeGreaterThan(marker);
    expect(lark.texts.find((m) => m.text.startsWith('Waking the agent'))?.target.threadId).toBe(thread);
    expect(lark.cardOpens[0]?.target.threadId).toBe(thread);

    // A person's message during the woken turn waits behind it (wake spec §6.3).
    await say(OWNER, 'what is next?', { threadId: thread });
    await until('the queued reply', () => texts().some((t) => t.startsWith('Queued: 1 ahead of this one.')));
    writeFileSync(join(root, 'release'), '');
    await until('both turns to run', () => chatTurns().length === 2);
    const [first, second] = chatTurns();
    expect(first?.prompt).toMatch(/^Board update: you are woken because wake is on for these tasks \(set by Alice\)\./);
    expect(first?.prompt).toContain(`${taskId}: Book the SLOW venue`);
    expect(first?.token).toBe(true);
    expect(second?.prompt).toContain('what is next?');
    await until('the woken card to finish', () => (lark.cards[0]?.finishes.length ?? 0) > 0);
    expect(lark.cards[0]?.finishes[0]).toMatch(/^_\(woken by the board, as Alice\)_/);
    expect(wakes()).toEqual([{ state: 'delivered', attempt: 1, principal: 'lark:on_owner' }]);
  });

  it("lets the woken agent lift its block with its own mt kanban task unblock, and redraws the notice as woken by the board", async () => {
    await start();
    await say(OWNER, '/kanban task new Draft the BLOCK agenda\nassignee: default\nwake: on');
    const taskId = createdTask();
    await until('the woken unblock', () => woken().some((t) => t.unblocked !== null));
    const turn = woken().find((t) => t.unblocked !== null);
    expect(turn?.prompt).toContain(`lift it with mt kanban task unblock ${taskId} <comment>`);
    expect(turn?.unblocked).toMatchObject({ status: 0 });
    expect(turn?.unblocked?.out).toContain(`\`${taskId}\` is unblocked, back to open, as Alice (woken by the board)`);

    const notice = lark.texts.find((m) => m.text.includes(`\`${taskId}\``) && (m.buttons?.length ?? 0) > 0);
    if (notice === undefined) throw new Error('no notice with an Unblock button');
    await until('the notice redrawn', () => lark.cardUpdates.length > 0);
    expect(lark.cardUpdates[0]?.view.buttons).toEqual([]);
    expect(lark.cardUpdates[0]?.view.markdown).toMatch(new RegExp(`\`${taskId}\`: Unblocked by Alice \\(woken by the board\\) at \\d\\d:\\d\\d$`));

    const db = gateway?.db;
    const lifted = db?.prepare("SELECT actor, json_extract(payload, '$.wake') AS wake FROM kanban_events WHERE task_id = ? AND kind = 'unblocked'").get(taskId);
    expect(lifted).toEqual({ actor: 'lark:on_owner', wake: 1 });
    const comment = db?.prepare('SELECT author, body, steers FROM kanban_comments WHERE task_id = ?').get(taskId);
    expect(comment).toEqual({ author: 'lark:on_owner', body: '(woken by the board) Speaker two is confirmed.', steers: 1 });
    // The run after it reads the comment, and completes.
    await until('the task to complete', () => phaseOf(taskId) === 'done');
  });

  it("notices a revoked setter's next outcome without a wake, and says so once", async () => {
    await start();
    await say(OWNER, '/auth grant @Carol Wu talk', {}, [CAROL]);
    const command = await say(OWNER, '/kanban task new Check the BLOCK links\nassignee: default');
    const taskId = createdTask();
    const thread = `omt_${command}`;
    await until('the task to block', () => phaseOf(taskId) === 'blocked');
    await say(CAROL, `/kanban task wake ${taskId} on`, { threadId: thread });
    expect(texts().at(-1)).toBe(`Wake is on for \`${taskId}\`: its outcomes now start a turn of the agent where it is followed, run as Carol Wu.`);
    await say(OWNER, '/auth revoke lark:on_carol');
    await say(OWNER, `/kanban task unblock ${taskId}`, { threadId: thread });
    await until('the lapse line', () => texts().includes(`wake is off for \`${taskId}\`: Carol Wu no longer has talk tier`));
    expect(texts().some((t) => t.includes('Done: **Check the BLOCK links**'))).toBe(true);
    expect(wakes()).toEqual([]);
    expect(woken()).toEqual([]);
  });

  it("passes over a direct message's task with direct messages off, with a log line", async () => {
    await start();
    await say(OWNER, '/kanban task new Say hi\nwake: on', { dm: true });
    const taskId = createdTask();
    await gateway?.stop();
    gateway = undefined;
    await start({ auth: { ...config.auth, allowDirectMessages: false } });
    const assigned = await mt(['kanban', 'task', 'assign', taskId, 'default']);
    expect(assigned.status, assigned.err).toBe(0);
    const subscription = (): { cursor: number; wake: number } | undefined =>
      gateway?.db.prepare('SELECT cursor, wake_cursor AS wake FROM kanban_subscriptions WHERE task_id = ?').get(taskId) as { cursor: number; wake: number } | undefined;
    await until('the completion passed over', () => phaseOf(taskId) === 'done' && (subscription()?.wake ?? 0) > 0 && subscription()?.wake === subscription()?.cursor);
    expect(lines.some((l) => l.includes('kanban: oc_alice_dm is not admitted (dm_disabled); passing over its wakes until the gateway restarts'))).toBe(true);
    expect(wakes()).toEqual([]);
    expect(woken()).toEqual([]);
  });

  it('wakes a pending row once after a restart on the same database', async () => {
    await start();
    // Slower than the shutdown's drain: the stop comes while the marker is still being sent.
    lark.slowTexts.push({ match: 'Waking the agent', ms: 8_000 });
    await say(OWNER, '/kanban task new Pack the boxes\nassignee: default\nwake: on');
    await until('the wake to be recorded', () => wakes().length === 1);
    expect(wakes()).toEqual([{ state: 'pending', attempt: 1, principal: 'lark:on_owner' }]);
    await gateway?.stop();
    gateway = undefined;
    // The slow marker lands on the stopped gateway's channel; nothing more is written for it.
    await new Promise((r) => setTimeout(r, 4_000));
    lark = new FakeChannel({ id: 'lark' });
    await start();
    await until('the woken turn', () => woken().length === 1);
    await until('the wake delivered', () => wakes()[0]?.state === 'delivered');
    await new Promise((r) => setTimeout(r, 4_500));
    expect(woken()).toHaveLength(1);
    expect(wakes()).toEqual([{ state: 'delivered', attempt: 1, principal: 'lark:on_owner' }]);
    expect(texts().filter((t) => t === 'Waking the agent for 1 board update.').length).toBeLessThanOrEqual(1);
    expect(existsSync(join(home, 'team.db'))).toBe(true);
  });
});
