import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import type { Channel } from '../src/channel/types.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { createGateway, type Gateway } from '../src/index.js';
import { AGENT_FIRST_LINE } from '../src/kanban/chat-render.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam } from '../src/team.js';
import { FakeChannel } from './helpers/channel.js';

/**
 * A role's wake through createGateway (wake spec §19.13, end to end): the
 * gateway's own waker, dispatcher and socket, with the fake chat standing in for
 * Lark and the fake CLI agent for both roles, the source task's `default` and
 * the wake's `vi-coordinator`. A task with `wake: vi-coordinator` completes: its
 * notice, then the role's marker naming the reaction task, then the reaction
 * task's own notice as its run completes it, in that order, in the thread; the
 * reaction task listed as any task, and named by its source's show. A block of
 * such a task: its notice sent without its button, the reaction run lifting it
 * with `mt kanban wake-unblock`, and the notice redrawn as woken by the board,
 * with no button card.
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
  // The wake's role: the same fake agent, in the same mode, its own run reading its body.
  const role = join(home, 'roles', 'vi-coordinator');
  mkdirSync(role, { recursive: true });
  writeFileSync(
    join(role, 'config.yaml'),
    `agent:\n  driver: structured-cli\n  command: ${JSON.stringify(process.execPath)}\n  args: [${JSON.stringify(AGENT)}]\n  unsupervised: true\n`,
  );
  writeFileSync(join(role, '.env'), `FAKE_CLI_MODE=wake\nFAKE_CLI_LOG=${log}\n`, { mode: 0o600 });
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

const texts = (): string[] => lark.texts.map((m) => m.text);

/** The task a "Created" reply named, the latest. */
function createdTask(): string {
  const id = [...texts()].reverse().map((t) => /^Created `(k_[0-9a-z]+)`/.exec(t)?.[1]).find((x) => x !== undefined);
  if (id === undefined) throw new Error('no task created');
  return id;
}

function phaseOf(taskId: string): string | undefined {
  return (gateway?.db.prepare('SELECT phase FROM kanban_tasks WHERE task_id = ?').get(taskId) as { phase: string } | undefined)?.phase;
}

/** The reaction runs the fake agent ran: each body, its wake-show's and wake-unblock's answers. */
function reactionRuns(): Array<{ body: string; shown: { status: number | null; answer: string } | null; unblocked: { status: number | null; answer: string } | null }> {
  try {
    return readFileSync(join(root, 'reaction.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { body: string; shown: { status: number | null; answer: string } | null; unblocked: { status: number | null; answer: string } | null });
  } catch {
    return [];
  }
}

/** The reaction tasks on the board, oldest first. */
function reactions(): Array<{ task_id: string; title: string; phase: string }> {
  return (gateway?.db.prepare('SELECT task_id, title, phase FROM kanban_tasks WHERE reaction_of IS NOT NULL ORDER BY rowid').all() ?? []) as Array<{
    task_id: string;
    title: string;
    phase: string;
  }>;
}

describe("a role's wake through createGateway", () => {
  it("sends the notice, then the role's marker naming the reaction task, then the reaction task's own notice, and lists the reaction task as any task", async () => {
    await start();
    const command = await say(OWNER, '/kanban task new Book the venue\nassignee: default\nwake: vi-coordinator');
    expect(texts().at(-1)).toMatch(/^Created `k_[0-9a-z]+`/);
    const taskId = createdTask();
    const thread = `omt_${command}`;
    await until('the reaction task to complete', () => reactions()[0]?.phase === 'done');
    const reaction = reactions()[0]?.task_id ?? '';
    await until("the reaction task's notice", () => lark.landed.some((l) => l.startsWith('text:Done: **React to board updates')));
    expect(reactions()[0]?.title).toBe(`React to board updates: ${taskId} completed`);
    const notice = lark.landed.findIndex((l) => l.startsWith('text:Done: **Book the venue**'));
    const marker = lark.landed.indexOf(`text:Waking vi-coordinator for 1 board update (${reaction}).`);
    const reacted = lark.landed.findIndex((l) => l.startsWith('text:Done: **React to board updates'));
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(notice);
    expect(reacted).toBeGreaterThan(marker);
    expect(lark.texts.find((m) => m.text.startsWith('Waking vi-coordinator'))?.target.threadId).toBe(thread);
    expect(lark.texts.find((m) => m.text.startsWith('Done: **React to board updates'))?.target.threadId).toBe(thread);
    // No session was woken, and no card streamed (wake spec §19.7).
    expect(lark.cardOpens).toEqual([]);
    expect(reactionRuns()[0]?.body).toMatch(/^Board update: you are this task's run because wake is on for the tasks below \(set by Alice\) and names role vi-coordinator\./);
    const wake = gateway?.db.prepare('SELECT state, target_role AS role, reaction_task AS task FROM kanban_wakes').all();
    expect(wake).toEqual([{ state: 'delivered', role: 'vi-coordinator', task: reaction }]);

    await say(OWNER, '/kanban task list all', { threadId: thread });
    expect(texts().at(-1)).toContain(`\`${reaction}\``);
    await say(OWNER, `/kanban task show ${taskId}`, { threadId: thread });
    expect(texts().at(-1)).toMatch(/Wake: on, set by Alice, for role vi-coordinator, depth 0; last woke \d\d:\d\d/);
    expect(texts().at(-1)).toContain(`Reactions: \`${reaction}\` (done)`);
  });

  it("holds a block's button for the reaction run, which lifts the block with wake-unblock, and redraws the notice as woken by the board", async () => {
    await start();
    await say(OWNER, '/kanban task new Draft the BLOCK agenda\nassignee: default\nwake: vi-coordinator');
    const taskId = createdTask();
    await until('the reaction run to lift the block', () => reactionRuns().some((r) => r.unblocked !== null));
    const run = reactionRuns().find((r) => r.unblocked !== null);
    expect(run?.shown?.status).toBe(0);
    expect(JSON.parse(run?.shown?.answer ?? '{}')).toMatchObject({ ok: true, task: { task_id: taskId } });
    expect(run?.unblocked?.status).toBe(0);
    expect(run?.unblocked?.answer).toContain(`\`${taskId}\` is unblocked, back to open, as Alice (woken by the board)`);

    const notice = lark.texts.find((m) => m.text.includes(`\`${taskId}\``) && m.text.endsWith(AGENT_FIRST_LINE));
    if (notice === undefined) throw new Error('no notice that defers its button');
    expect(notice.card).toBe(true);
    expect(notice.buttons).toBeUndefined();
    await until('the notice redrawn', () => lark.cardUpdates.length > 0);
    expect(lark.cardUpdates[0]?.view.buttons).toEqual([]);
    expect(lark.cardUpdates[0]?.view.markdown).toMatch(new RegExp(`\`${taskId}\`: Unblocked by Alice \\(woken by the board\\) at \\d\\d:\\d\\d$`));
    const db = gateway?.db;
    const lifted = db?.prepare("SELECT actor, json_extract(payload, '$.wake') AS wake FROM kanban_events WHERE task_id = ? AND kind = 'unblocked'").get(taskId);
    expect(lifted).toEqual({ actor: 'lark:on_owner', wake: 1 });
    await until('the task to complete', () => phaseOf(taskId) === 'done');
    await until('the deferred button settled', () => (db?.prepare('SELECT state FROM kanban_deferred_buttons WHERE task_id = ?').get(taskId) as { state: string } | undefined)?.state === 'lifted');
    expect(texts().some((t) => t.startsWith('The agent could not lift the block'))).toBe(false);
  });
});
