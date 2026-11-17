import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../src/channel/types.js';
import { cronUuid } from '../src/core/ids.js';
import { SessionRegistry } from '../src/core/registry.js';
import { Router } from '../src/core/router.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { CronChat } from '../src/cron/chat.js';
import { CronScheduler } from '../src/cron/scheduler.js';
import { CronService } from '../src/cron/service.js';
import { CronTokens } from '../src/cron/tokens.js';
import { CronApi } from '../src/cron/worker.js';
import { firesOf, getJob, listJobs } from '../src/db/cron.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { SinkChannel } from '../src/kanban/sink.js';
import { SocketHandler, listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * Cron end to end (the cron spec, §14): a fake chat whose fake CLI agent runs
 * `mt cron add` through the real socket, and the job's fire, run by the same
 * fake agent, posting its answer to the fake chat once, with its header; a fire
 * answering [nothing to report] posting nothing; and a gateway stopped mid-fire
 * and started again, its chat told once.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const START = Date.UTC(2026, 10, 17, 1, 0);

interface Stack {
  registry: SessionRegistry;
  scheduler: CronScheduler;
  router: Router;
  server: WorkerServer;
  lark: FakeChannel;
  stop(): Promise<void>;
}

let t: TestDb;
let dir: string;
let home: string;
let clock: ManualClock;
let seq = 0;
const stacks: Stack[] = [];

beforeEach(() => {
  clearSecrets();
  t = testDb();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-cron-e2e-')));
  home = join(dir, 'home');
  mkdirSync(join(dir, 'repo'), { recursive: true });
  mkdirSync(home);
  clock = new ManualClock(START);
});

afterEach(async () => {
  for (const s of stacks.splice(0)) await s.stop();
  clearSecrets();
  t.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One gateway's worth of cron over the shared database: the registry, the scheduler, the socket and chat. */
async function gateway(): Promise<Stack> {
  const roles = new Map([['default', role('default')]]);
  const agent = (): Driver => createCliDriver({ command: process.execPath, args: [AGENT], env: { FAKE_CLI_MODE: 'cron', FAKE_CLI_LOG: join(dir, 'log') } });
  const lark = new FakeChannel({ id: 'lark' });
  const socket = workerSocketPath(home);
  const access = { socket, mtDir: writeMtShim(home), path: process.env['PATH'] };
  const tokens = new CronTokens({ db: t.db, worker: access });
  let scheduler: CronScheduler | undefined;
  const registry = new SessionRegistry({
    db: t.db,
    drivers: new Map([['default', agent()]]),
    channels: new Map<string, Channel>([
      ['lark', lark],
      ['cron', new SinkChannel('cron', { subject: (jobId) => `cron job ${jobId}` })],
    ]),
    envFor: (sessionId, key) => scheduler?.envFor(sessionId) ?? tokens.envFor(sessionId, key),
    argsFor: (sessionId) => scheduler?.argsFor(sessionId),
    pinned: (sessionId) => scheduler?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(new Map([['default', join(dir, 'repo')]])),
    appId: 'cli_app',
  });
  const service = new CronService({ db: t.db, roles, workspaces: new Set(['default']), zone: 'Asia/Shanghai', clock });
  scheduler = new CronScheduler({
    db: t.db,
    service,
    sessions: registry,
    channels: new Map<string, Channel>([['lark', lark]]),
    appId: 'cli_app',
    settings: { maxRunning: 2, idleTimeoutS: 600 },
    clock,
    roles,
    workspaceDirs: new Map([['default', join(dir, 'repo')]]),
    worker: access,
    tokens,
  });
  const s = scheduler;
  const api = new CronApi({ db: t.db, service, tokens, appId: 'cli_app', changed: () => s.tick() });
  const handler = new SocketHandler({ cron: (request) => api.handle(request), nudged: () => s.tick() });
  const server = await listenWorker(socket, (request, signal) => handler.handle(request, signal));
  const authorizer = new Authorizer(defaultAuthConfig(OWNER.openId));
  const router = new Router({
    db: t.db,
    registry,
    authorizer,
    channel: lark,
    channelId: 'lark',
    appId: 'cli_app',
    cron: new CronChat({ db: t.db, service, hasTier: (p, tier) => authorizer.hasTier(p, tier), changed: () => s.tick() }),
    cronTurns: tokens,
  });
  const stack: Stack = {
    registry,
    scheduler: s,
    router,
    server,
    lark,
    async stop() {
      s.stop();
      await registry.closeAll();
      await s.idle(5_000);
      await server.close();
    },
  };
  stacks.push(stack);
  await s.boot();
  return stack;
}

function inChat(text: string): InboundMessage {
  return {
    messageId: `om_cron_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'p2p',
    threadId: '',
    sender: OWNER,
    senderIsBot: false,
    text,
    mentionedBot: true,
    mentionAll: false,
    mentions: [],
    attachments: [],
    createTime: Date.now(),
  };
}

/** Wait for `ok`, polling, for up to about 30 s: a loaded machine starts the fake agent slowly. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1200; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`gave up waiting for ${what}`);
}

describe('cron, end to end', () => {
  it("lets a chat agent add a job through the real socket, whose fire posts its answer to the chat once, with its header", async () => {
    const g = await gateway();
    await g.router.onMessage(inChat(`cron-add ${JSON.stringify({ schedule: 'every 1h', prompt: 'Count the open PRs.', name: 'PR count' })}`));
    await until('the job to be added', () => listJobs(t.db).length === 1);
    const [job] = listJobs(t.db);
    expect(job).toMatchObject({ name: 'PR count', role: 'default', createdBy: expect.stringMatching(/^session:s_/), delivery: { chat: 'oc_team' } });
    clock.advance(3_600_000);
    g.scheduler.tick();
    await until('the fire to be posted', () => firesOf(t.db, job?.jobId ?? '')[0]?.delivery === 'sent');
    const fire = firesOf(t.db, job?.jobId ?? '')[0];
    const posted = g.lark.texts.filter((m) => m.uuid === cronUuid('cli_app', job?.jobId ?? '', fire?.fireId ?? 0, 0));
    expect(posted).toHaveLength(1);
    expect(posted[0]?.text).toMatch(/^\*\*PR count\*\* · 2026-11-17 10:00 Asia\/Shanghai · \d+s\nFired: Count the open PRs\.$/);
  });

  it('posts nothing for a fire answering [nothing to report]', async () => {
    const g = await gateway();
    await g.router.onMessage(inChat('/cron add "every 1h" default QUIET please.'));
    const [job] = listJobs(t.db);
    clock.advance(3_600_000);
    g.scheduler.tick();
    await until('the fire to end', () => firesOf(t.db, job?.jobId ?? '')[0]?.outcome === 'nothing');
    expect(g.lark.texts.filter((m) => m.text.includes('Fired'))).toEqual([]);
    expect(g.lark.texts.map((m) => m.text)).toEqual([expect.stringMatching(/^Added `c_/)]);
  });

  it('tells the chat once of a fire a stop interrupted, at the next start', async () => {
    const first = await gateway();
    await first.router.onMessage(inChat('/cron add "every 1h" default SLOW work.'));
    const [job] = listJobs(t.db);
    clock.advance(3_600_000);
    first.scheduler.tick();
    await until('the agent to start', () => firesOf(t.db, job?.jobId ?? '')[0]?.sessionId !== null);
    await new Promise((r) => setTimeout(r, 300));
    await first.stop();
    stacks.splice(stacks.indexOf(first), 1);
    expect(firesOf(t.db, job?.jobId ?? '')[0]).toMatchObject({ outcome: null });

    const second = await gateway();
    expect(firesOf(t.db, job?.jobId ?? '')[0]).toMatchObject({ outcome: 'interrupted', delivery: 'pending' });
    second.scheduler.start();
    await until('the line to be sent', () => firesOf(t.db, job?.jobId ?? '')[0]?.delivery === 'sent');
    second.scheduler.tick();
    await second.scheduler.idle(2_000);
    const told = second.lark.texts.filter((m) => m.text.includes('interrupted by a gateway restart'));
    expect(told).toHaveLength(1);
    expect(told[0]?.text).toBe(`**${getJob(t.db, job?.jobId ?? '')?.name}** · 2026-11-17 10:00 Asia/Shanghai: interrupted by a gateway restart; it runs again at 2026-11-17 11:00`);
  });
});
