import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import type { Channel } from '../src/channel/types.js';
import { Router } from '../src/core/router.js';
import { SessionRegistry } from '../src/core/registry.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { getInstance, getTask, membersOf, runsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { createCliDriver } from '../src/driver/cli/driver.js';
import type { Driver } from '../src/driver/types.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { Dispatcher } from '../src/kanban/dispatcher.js';
import { Notifier } from '../src/kanban/notices.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { writeMtShim } from '../src/kanban/shim.js';
import { KanbanSink } from '../src/kanban/sink.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';

/**
 * Workflows end to end (spec §21.16): a workflow started from a fake chat in a
 * group, its steps run by the fake CLI agent through the real socket in their
 * order, its notices in the instance's thread; a deciding step starting a second
 * workflow through `mt kanban start-workflow`; a planner applying a graph with
 * `mt kanban apply-dag`; and a terminal's preview, edit, dry run and apply.
 */

const AGENT = fileURLToPath(new URL('./fakes/cli-agent.mjs', import.meta.url));
const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };

const RESEARCH = `description: Shortlist, evaluate each, then recommend one
params:
  topic: { required: true }
  vendors: { list: true, required: true }
steps:
  shortlist: { title: "Shortlist vendors for {{topic}}", assignee: worker }
  evaluate: { title: "Evaluate {{item}} for {{topic}}", assignee: worker, for_each: vendors, parents: [shortlist] }
  recommend: { title: "Recommend a vendor for {{topic}}", assignee: worker, parents: [evaluate] }
`;

interface Stack {
  t: TestDb;
  dir: string;
  home: string;
  lark: FakeChannel;
  router: Router;
  service: KanbanService;
  dispatcher: Dispatcher;
  notifier: Notifier;
  registry: SessionRegistry;
  server: WorkerServer;
  asked(): unknown[];
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

async function build(): Promise<Stack> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mt-wf-e2e-')));
  const home = join(dir, 'home');
  const workspace = join(dir, 'repo');
  mkdirSync(join(home, 'workflows'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(home, 'workflows', 'research.yaml'), RESEARCH);
  const log = join(dir, 'invocations.log');
  const t = testDb();
  const authorizer = new Authorizer(defaultAuthConfig(OWNER.openId));
  const people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: (openId) => authorizer.canTalk({ openId, unionId: null, displayName: null }) });
  const roles = new Map(['worker', 'planner', 'decider'].map((n) => [n, role(n)]));
  const service = new KanbanService({ db: t.db, roles, workspaces: new Set(['default']), people, supervisedRoles: true, workflowsDir: join(home, 'workflows') });
  const agent = (): Driver => createCliDriver({ command: process.execPath, args: [AGENT], env: { FAKE_CLI_MODE: 'kanban-body', FAKE_CLI_LOG: log } });
  const drivers = new Map<string, Driver>([...roles.keys()].map((n) => [n, agent()]));
  const lark = new FakeChannel({ id: 'lark' });
  let dispatcher: Dispatcher | undefined;
  const registry = new SessionRegistry({
    db: t.db,
    drivers,
    channels: new Map<string, Channel>([
      ['lark', lark],
      ['kanban', new KanbanSink(undefined, { db: t.db, channels: new Map<string, Channel>([['lark', lark]]), appId: 'cli_app' })],
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
  const chat = new KanbanChat({ service, hasTier: (p, tier) => authorizer.hasTier(p, tier), people, appId: 'cli_app', changed: () => d.pass() });
  const router = new Router({ db: t.db, registry, authorizer, channel: lark, channelId: 'lark', appId: 'cli_app', kanban: chat });
  const notifier = new Notifier({ db: t.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2, nameOf: (p) => people.nameOf(p) });
  const askedLog = join(dir, 'asked.log');
  stack = {
    t,
    dir,
    home,
    lark,
    router,
    service,
    dispatcher,
    notifier,
    registry,
    server,
    asked: () => (existsSync(askedLog) ? readFileSync(askedLog, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as unknown) : []),
  };
  return stack;
}

function inGroup(text: string): InboundMessage {
  return {
    messageId: `om_wf_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
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

/** Pass after pass until every task on the board is done, or give up. */
async function runAll(s: Stack, tasks: () => string[]): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (tasks().length > 0 && tasks().every((id) => getTask(s.t.db, id)?.phase === 'done')) return;
    s.dispatcher.pass();
    await s.dispatcher.idle();
  }
  throw new Error(`not every task is done: ${tasks().map((id) => `${id} ${getTask(s.t.db, id)?.phase}`).join(', ')}`);
}

const allTasks = (s: Stack): string[] =>
  s.t.db.prepare<[], { task_id: string }>('SELECT task_id FROM kanban_tasks ORDER BY rowid').all().map((r) => r.task_id);

/** When a task's first run started, and when its completion was recorded, by event id. */
function order(s: Stack, taskId: string): { claimed: number; completed: number } {
  const rows = s.t.db.prepare<[string], { id: number; kind: string }>('SELECT id, kind FROM kanban_events WHERE task_id = ? ORDER BY id').all(taskId);
  return { claimed: rows.find((r) => r.kind === 'claimed')?.id ?? -1, completed: rows.find((r) => r.kind === 'completed')?.id ?? -1 };
}

describe('workflows, end to end', () => {
  it('starts the example from a group, runs its steps in order through the real socket, and its notices land in its thread', async () => {
    const s = await build();
    const command = inGroup('/kanban workflow start research topic=logs vendors=acme,globex');
    await s.router.onMessage(command);
    const reply = s.lark.texts[0];
    expect(reply?.target).toMatchObject({ replyTo: command.messageId, replyInThread: true });
    const id = /as `(w_[0-9a-z]+)`/.exec(reply?.text ?? '')?.[1] ?? '';
    const members = membersOf(s.t.db, id);
    expect(members.map((m) => m.ref)).toEqual(['shortlist', 'evaluate:1', 'evaluate:2', 'recommend']);
    for (const m of members) expect(subscriptionsOf(s.t.db, m.taskId).map((x) => x.threadId)).toEqual([`omt_${command.messageId}`]);

    await runAll(s, () => members.map((m) => m.taskId));
    const [shortlist, e1, e2, recommend] = members.map((m) => order(s, m.taskId));
    expect(e1?.claimed).toBeGreaterThan(shortlist?.completed ?? Infinity);
    expect(e2?.claimed).toBeGreaterThan(shortlist?.completed ?? Infinity);
    expect(recommend?.claimed).toBeGreaterThan(Math.max(e1?.completed ?? Infinity, e2?.completed ?? Infinity));

    await s.notifier.deliver();
    const notices = s.lark.texts.slice(1);
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) expect(n.target).toMatchObject({ chatId: 'oc_team', threadId: `omt_${command.messageId}` });
    expect(notices.map((n) => n.text).join('\n')).toContain('Done: **Recommend a vendor for logs**');
  });

  it("lets a deciding step's agent start a second workflow, whose tasks follow the first's thread", async () => {
    const s = await build();
    writeFileSync(
      join(s.home, 'workflows', 'decide.yaml'),
      `steps:\n  decide:\n    title: Decide what to research\n    assignee: decider\n    body: 'start-workflow {"workflow": "research", "params": {"topic": "queues", "vendors": ["initech"]}, "idempotency_key": "d-1"}'\n`,
    );
    const command = inGroup('/kanban workflow start decide');
    await s.router.onMessage(command);
    const first = /as `(w_[0-9a-z]+)`/.exec(s.lark.texts[0]?.text ?? '')?.[1] ?? '';
    const decide = membersOf(s.t.db, first)[0]?.taskId ?? '';
    await runAll(s, () => allTasks(s));
    const [answer] = s.asked() as Array<{ ok: boolean; instance_id: string; tasks: Array<{ task_id: string }> }>;
    expect(answer).toMatchObject({ ok: true, existing: false, board: 'default' });
    expect(getInstance(s.t.db, answer?.instance_id ?? '')?.createdBy).toMatch(/^run:r_/);
    for (const t of answer?.tasks ?? []) {
      expect(getTask(s.t.db, t.task_id)?.createdFromTask).toBe(decide);
      expect(subscriptionsOf(s.t.db, t.task_id).map((x) => [x.threadId, x.rootMessageId])).toEqual([[`omt_${command.messageId}`, command.messageId]]);
    }
    const shown = s.service.instance(first);
    expect(shown.ok && shown.view.relatedInstances).toEqual([{ instanceId: answer?.instance_id, name: 'research', tasks: 3 }]);
  });

  it("lets a planner's agent apply a graph of five tasks, all made before any is claimed, following the planner's chat", async () => {
    const s = await build();
    const graph = {
      format: 1,
      tasks: [
        { ref: 'research', title: 'Research the options', assignee: 'worker' },
        { ref: 'a', title: 'Try A', assignee: 'worker', parents: ['research'] },
        { ref: 'b', title: 'Try B', assignee: 'worker', parents: ['research'] },
        { ref: 'compare', title: 'Compare A and B', assignee: 'worker', parents: ['a', 'b'] },
        { ref: 'write', title: 'Write it up', assignee: 'worker', parents: ['compare'] },
      ],
      idempotency_key: 'plan-1',
    };
    await s.router.onMessage(inGroup(`/kanban task new Plan the work\nassignee: planner\napply-dag ${JSON.stringify(graph)}`));
    const planner = allTasks(s)[0] ?? '';
    await runAll(s, () => allTasks(s));
    const [answer] = s.asked() as Array<{ ok: boolean; instance_id: string; tasks: Array<{ task_id: string; ref: string }> }>;
    expect(answer?.tasks.map((t) => t.ref)).toEqual(['research', 'a', 'b', 'compare', 'write']);
    const made = answer?.tasks.map((t) => getTask(s.t.db, t.task_id)) ?? [];
    // One transaction: every one made at the same moment, before any of them was claimed.
    expect(new Set(made.map((t) => t?.createdAt)).size).toBe(1);
    const rootRun = runsOf(s.t.db, answer?.tasks[0]?.task_id ?? '')[0];
    expect(rootRun?.startedAt).toBeGreaterThanOrEqual(made[0]?.createdAt ?? Infinity);
    for (const t of made) {
      expect(t?.createdFromTask).toBe(planner);
      expect(subscriptionsOf(s.t.db, t?.taskId ?? '').map((x) => x.conversationId)).toEqual(['oc_team']);
    }
  });

  it("previews at the terminal as a file, which is edited, checked with a dry run and applied, run by the gateway and followed by no chat", async () => {
    const s = await build();
    // The terminal's database is the gateway's, so the gateway's dispatcher runs what the apply made.
    writeFileSync(
      join(s.home, 'config.yaml'),
      [`workspace: ${join(s.dir, 'repo')}`, `db: ${join(s.t.dir, 'team.db')}`, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
    );
    mkdirSync(join(s.home, 'roles', 'worker'), { recursive: true });
    writeFileSync(join(s.home, 'roles', 'worker', 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
    const mt = async (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runMt(['kanban', 'workflow', ...argv], { env: { MT_HOME: s.home, PATH: process.env['PATH'], HOME: s.dir }, out: (l) => out.push(l), err: (l) => err.push(l) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    const preview = await mt(['preview', 'research', '--param', 'topic=logs', '--param', 'vendors=acme', '--json']);
    expect(preview.code).toBe(0);
    const dag = JSON.parse(preview.out) as { tasks: Array<{ title: string }> };
    dag.tasks[2]!.title = 'Recommend one vendor for logs, in a page';
    const file = join(s.dir, 'dag.json');
    writeFileSync(file, JSON.stringify(dag, null, 2));
    const dry = await mt(['apply', file, '--dry-run']);
    expect(dry.out.split('\n')[0]).toBe('would make 3 tasks, 2 links, 0 gates, on board default; nothing was made');
    expect(allTasks(s)).toEqual([]);
    // Every call to the fake Lark, a text, a card or a reaction, from here on would be chat following the apply.
    const sent = s.lark.calls.length;
    const applied = JSON.parse((await mt(['apply', file, '--key', 'e2e', '--json'])).out) as { instance_id: string; tasks: Array<{ task_id: string }> };
    expect(applied.tasks).toHaveLength(3);
    const ids = applied.tasks.map((t) => t.task_id);
    for (const id of ids) expect(subscriptionsOf(s.t.db, id)).toEqual([]);
    expect(getTask(s.t.db, ids[2] ?? '')?.title).toBe('Recommend one vendor for logs, in a page');

    await runAll(s, () => ids);
    for (const id of ids) {
      expect(order(s, id).claimed).toBeGreaterThan(0);
      expect(getTask(s.t.db, id)?.phase).toBe('done');
    }
    await s.notifier.deliver();
    expect(s.lark.calls).toHaveLength(sent);
  });
});
