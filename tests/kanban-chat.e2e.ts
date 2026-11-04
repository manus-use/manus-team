import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { Router } from '../src/core/router.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { getTask, runsOf } from '../src/db/kanban-read.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { Notifier } from '../src/kanban/notices.js';
import { KanbanService } from '../src/kanban/service.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver } from './helpers/driver.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * The board from Lark, end to end (spec §9, §11): a person types `/kanban new`
 * in a group thread; the router hands it to the board's chat commands; the real
 * dispatcher runs the task as a session whose agent is a real process -- the
 * fake CLI agent, through the real CLI driver -- which reports through `mt
 * kanban` and the real socket; and the thread hears of it, once, from its
 * subscription.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };

interface Stack {
  t: TestDb;
  lark: FakeChannel;
  router: Router;
  dispatcher: Dispatcher;
  notifier: () => Notifier;
  server: WorkerServer;
  registry: SessionRegistry;
  dir: string;
}

let stack: Stack | undefined;
let seq = 0;

beforeEach(() => clearSecrets());
afterEach(async () => {
  clearSecrets();
  if (stack === undefined) return;
  await stack.registry.closeAll();
  await stack.dispatcher.idle(5_000);
  await stack.server.close();
  stack.t.close();
  rmSync(stack.dir, { recursive: true, force: true });
  stack = undefined;
});

async function build(mode: string): Promise<Stack> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-chat-e2e-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'work');
  mkdirSync(home);
  mkdirSync(workspace);
  const t = testDb();
  const roles = new Map([['implementer', role('implementer')]]);
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']) });
  const lark = new FakeChannel({ id: 'lark' });
  const drivers = new Map<string, Driver>([
    ['default', new FakeDriver()],
    [
      'implementer',
      createCliDriver({
        command: process.execPath,
        args: [AGENT],
        env: { FAKE_CLI_MODE: mode, FAKE_CLI_LOG: join(dir, 'invocations.log') },
      }),
    ],
  ]);
  let dispatcher: Dispatcher | undefined;
  const registry = new SessionRegistry({
    db: t.db,
    drivers,
    channels: new Map<string, Channel>([
      ['lark', lark],
      ['kanban', new KanbanSink()],
    ]),
    envFor: (sessionId) => dispatcher?.envFor(sessionId),
    argsFor: (sessionId) => dispatcher?.argsFor(sessionId),
    pinned: (sessionId) => dispatcher?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(new Map([['default', workspace]])),
    appId: 'cli_app',
    maxLive: 4,
  });
  const socket = workerSocketPath(home);
  dispatcher = new Dispatcher({
    db: t.db,
    service,
    sessions: registry,
    roles,
    appId: 'cli_app',
    settings: { maxRunning: 2, defaultMaxRuntimeS: 600, strandedAfterS: 1800, sweepIntervalS: 60, nudgeLimit: 0 },
    worker: { socket, mtDir: writeMtShim(home), path: process.env['PATH'] },
  });
  const d = dispatcher;
  const api = new WorkerApi({ db: t.db, service, changed: () => d.pass() });
  const server = await listenWorker(socket, (request, signal) => api.handle(request, { signal }));
  const authorizer = new Authorizer(defaultAuthConfig(OWNER.openId));
  const router = new Router({
    db: t.db,
    registry,
    authorizer,
    channel: lark,
    channelId: 'lark',
    appId: 'cli_app',
    kanban: new KanbanChat({
      service,
      hasTier: (principal, tier) => authorizer.hasTier(principal, tier),
      changed: () => d.pass(),
      cancel: (runId) => {
        d.cancel(runId);
      },
    }),
  });
  stack = {
    t,
    lark,
    router,
    dispatcher,
    // A new one is a new process: it knows only what the database does.
    notifier: () =>
      new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2 }),
    server,
    registry,
    dir,
  };
  return stack;
}

/** A message in the team's group, in a topic thread, mentioning the bot. */
function said(text: string): InboundMessage {
  return {
    messageId: `om_e2e_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: 'omt_topic',
    sender: OWNER,
    senderIsBot: false,
    text,
    mentionedBot: true,
    mentionAll: false,
    attachments: [],
    createTime: Date.now(),
  };
}

/** The task id the router's reply to /kanban new names. */
function createdIn(lark: FakeChannel): string {
  const reply = lark.texts.at(-1)?.text ?? '';
  const id = /^Created `(k_[0-9a-z]+)`/.exec(reply)?.[1];
  if (id === undefined) throw new Error(`no task created: ${reply}`);
  return id;
}

describe('the board from Lark, end to end', () => {
  it('/kanban new runs the task on a role, and the thread it was created in hears it is done, once', async () => {
    const s = await build('kanban');
    await s.router.onMessage(said('/kanban new Write the parser\nassignee: implementer\nworkspace: default\nIt reads CSV.'));
    const taskId = createdIn(s.lark);
    expect(s.lark.texts.at(-1)?.target).toEqual({ chatId: 'oc_team', threadId: 'omt_topic' });

    // The reply looked for work: the run started without waiting for a sweep.
    await s.dispatcher.idle();
    expect(getTask(s.t.db, taskId)?.phase).toBe('done');
    expect(runsOf(s.t.db, taskId)[0]).toMatchObject({ outcome: 'completed', summary: 'did: Write the parser' });

    const replies = s.lark.texts.length;
    expect(await s.notifier().deliver()).toBe(1);
    expect(s.lark.texts.slice(replies)).toEqual([
      {
        target: { chatId: 'oc_team', threadId: 'omt_topic' },
        text: `Done — **Write the parser** \`${taskId}\`:\n> did: Write the parser`,
        uuid: expect.any(String) as string,
      },
    ]);
    // Delivered is delivered: again, and after a restart, nothing more is sent.
    expect(await s.notifier().deliver()).toBe(0);
    expect(s.lark.texts).toHaveLength(replies + 1);

    // And /kanban show tells the same story.
    await s.router.onMessage(said(`/kanban show ${taskId}`));
    expect(s.lark.texts.at(-1)?.text).toContain('#1 work · role implementer · completed — did: Write the parser');
  });

  it("an agent that crashes is retried, then given up on, and the thread hears both", async () => {
    const s = await build('crash');
    await s.router.onMessage(said('/kanban new Flaky job\nassignee: implementer\nworkspace: default'));
    const taskId = createdIn(s.lark);
    await s.dispatcher.idle();
    expect(getTask(s.t.db, taskId)).toMatchObject({ phase: 'blocked', blockKind: 'gave_up' });

    const replies = s.lark.texts.length;
    // Both in one message to the thread: a round sends a conversation one batch.
    expect(await s.notifier().deliver()).toBe(2);
    expect(s.lark.texts.slice(replies)).toHaveLength(1);
    const [retry, gaveUp] = (s.lark.texts.at(-1)?.text ?? '').split('\n\n');
    expect(retry).toMatch(new RegExp(`^Retrying — \\*\\*Flaky job\\*\\* \`${taskId}\`: the last attempt ended crashed`));
    expect(gaveUp).toMatch(new RegExp(`^Gave up — \\*\\*Flaky job\\*\\* \`${taskId}\`: failed 2 times; last crashed`));
  });
});
