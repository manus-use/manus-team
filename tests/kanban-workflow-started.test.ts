import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noticeBatchUuid } from '../src/core/ids.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { renderStarted, startedReply, WORKFLOW_REPLY_MAX } from '../src/kanban/chat-render.js';
import { Notifier } from '../src/kanban/notices.js';
import { KanbanService, type WorkflowMade } from '../src/kanban/service.js';
import type { CreatedVia, Follow, Result, TaskRow } from '../src/kanban/types.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, VIA } from './helpers/kanban.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * A workflow started or applied at a terminal with a chat to follow it
 * (workflows spec §18.1, §18.2): every member followed in the one transaction,
 * and the start's reply queued as `workflow_started` on the first member, which
 * the notifier renders from its payload alone, whole, before any member's
 * notice; never for chat's start or a run's.
 */

const SECRET = 'sk-live-1234567890';
const OPERATOR: CreatedVia = { kind: 'operator' };
const BY = 'operator:alice';
const CHAT: Follow = { appId: 'cli_app', chatId: 'oc_team', threadId: '', rootId: null };
const THREAD: Follow = { appId: 'cli_app', chatId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' };
const PARAMS = { from: 'json', params: { topic: 'log storage', vendors: ['acme', 'globex'] } } as const;
const HEARS = 'hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.';

let h: TestDb;
let clock: ManualClock;
let service: KanbanService;
let lark: FakeChannel;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  clock = new ManualClock();
  const dir = join(h.dir, 'workflows');
  mkdirSync(dir);
  writeFileSync(join(dir, 'vendor-eval.yaml'), VENDOR_EVAL);
  service = new KanbanService({
    db: h.db,
    roles: new Map(['worker', 'reviewer', 'implementer'].map((n) => [n, role(n)])),
    workspaces: new Set(['default']),
    people: { canTalk: (p) => p === ALICE },
    supervisedRoles: true,
    workflowsDir: dir,
    clock,
  });
  lark = new FakeChannel({ id: 'lark', clock });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

function made(r: Result<object>): WorkflowMade {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r as unknown as WorkflowMade;
}

function start(follow: Follow | undefined, over: Partial<Parameters<KanbanService['startWorkflow']>[0]> = {}) {
  return service.startWorkflow({ workflow: 'vendor-eval', params: PARAMS, createdBy: BY, createdVia: OPERATOR, ...(follow === undefined ? {} : { follow }), ...over });
}

/** A DAG of `n` tasks, each titled to `bytes` bytes, the first for a person. */
function dag(n: number, bytes = 20) {
  return {
    format: 1,
    tasks: Array.from({ length: n }, (_, i) => ({
      ref: `t${i}`,
      title: `${'T'.repeat(Math.max(0, bytes - String(i).length - 1))} ${i}`.slice(-bytes),
      assignee: i === 0 ? ALICE : 'worker',
    })),
  };
}

function notifier(): Notifier {
  return new Notifier({ db: h.db, service, channels: new Map([['lark', lark]]), appId: 'cli_app', blockRecurrenceLimit: 2, clock, note: () => undefined });
}

const kinds = (task: TaskRow) => eventsOf(h.db, task.taskId).map((e) => e.kind);

describe('a terminal start that names a chat', () => {
  it("follows every member from the chat, and writes one workflow_started on the first, after the member rows", () => {
    const r = made(start(CHAT));
    for (const t of r.tasks) {
      expect(subscriptionsOf(h.db, t.taskId)).toEqual([expect.objectContaining({ channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '', rootMessageId: null })]);
    }
    const [first, ...rest] = r.tasks;
    expect(kinds(first?.task as TaskRow)).toEqual(['created', 'workflow_started']);
    for (const t of rest) expect(kinds(t.task)).not.toContain('workflow_started');
    const event = eventsOf(h.db, first?.taskId ?? '').at(-1);
    const lastCreated = Math.max(...r.tasks.map((t) => eventsOf(h.db, t.taskId)[0]?.id ?? 0));
    expect(event?.id).toBeGreaterThan(lastCreated);
    expect(event).toMatchObject({ actor: BY });
    expect(event?.payload).toEqual({
      workflow: r.instance.instanceId,
      workflowName: 'vendor-eval',
      board: 'default',
      by: BY,
      count: 4,
      people: false,
      tasks: r.tasks.map((t) => ({ taskId: t.taskId, title: t.task.title, assignee: 'worker', assigneeKind: 'role' })),
    });
  });

  it('follows in a thread with its root, and holds no task_created_followed on any member', () => {
    const r = made(service.applyDag({ dag: dag(3), createdBy: BY, createdVia: OPERATOR, follow: THREAD }));
    for (const t of r.tasks) {
      expect(subscriptionsOf(h.db, t.taskId)).toEqual([expect.objectContaining({ threadId: 'omt_topic', rootMessageId: 'om_root' })]);
      expect(kinds(t.task)).not.toContain('task_created_followed');
    }
    expect(eventsOf(h.db, r.tasks[0]?.taskId ?? '').at(-1)?.payload).toMatchObject({ workflowName: null, count: 3, people: true });
  });

  it('keeps the first 30 tasks of 100 in the payload, masked', () => {
    addSecrets([SECRET]);
    const big = dag(100);
    big.tasks[1] = { ...big.tasks[1], title: `with ${SECRET}` } as (typeof big.tasks)[number];
    const r = made(service.applyDag({ dag: big, createdBy: BY, createdVia: OPERATOR, follow: CHAT }));
    const payload = eventsOf(h.db, r.tasks[0]?.taskId ?? '').at(-1)?.payload as { count: number; tasks: Array<{ taskId: string; title: string }> };
    expect(payload.count).toBe(100);
    expect(payload.tasks.map((t) => t.taskId)).toEqual(r.tasks.slice(0, 30).map((t) => t.taskId));
    expect(payload.tasks[1]?.title).toBe(`with ${MASK}`);
  });

  it("writes none without a chat, and refuses a follow from chat's start and from a run's", () => {
    const plain = made(start(undefined));
    expect(kinds(plain.tasks[0]?.task as TaskRow)).toEqual(['created']);
    expect(start(CHAT, { createdBy: ALICE, createdVia: VIA })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/^only the terminal names a chat/) });
    const planner = service.create({ title: 'Plan', assignee: 'implementer', createdBy: ALICE, createdVia: VIA });
    if (!planner.ok) throw new Error(planner.message);
    const run = service.claim(planner.task.taskId);
    if (!run.ok) throw new Error(run.message);
    const via: CreatedVia = { kind: 'run', runId: run.run.runId };
    expect(start(CHAT, { createdBy: `run:${run.run.runId}`, createdVia: via })).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.applyDag({ dag: dag(1), createdBy: `run:${run.run.runId}`, createdVia: via, follow: CHAT })).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.applyDag({ dag: dag(1), createdBy: BY, createdVia: OPERATOR, follow: { ...CHAT, chatId: 'team' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(service.applyDag({ dag: { ...dag(1), chat: 'oc_team' }, createdBy: BY, createdVia: OPERATOR })).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/takes no key "chat"/) });
  });

  it('adds no subscription and no second event for a repeat by key, and writes nothing for a dry run', () => {
    const first = made(start(CHAT, { idempotencyKey: 'weekly' }));
    const again = made(start({ ...CHAT, chatId: 'oc_other' }, { idempotencyKey: 'weekly' }));
    expect(again).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
    for (const t of first.tasks) expect(subscriptionsOf(h.db, t.taskId).map((s) => s.conversationId)).toEqual(['oc_team']);
    expect(eventsOf(h.db, first.tasks[0]?.taskId ?? '').filter((e) => e.kind === 'workflow_started')).toHaveLength(1);
    const count = () => h.db.prepare('SELECT count(*) AS n FROM kanban_subscriptions').get();
    const before = count();
    expect(service.applyDag({ dag: dag(2), createdBy: BY, createdVia: OPERATOR, follow: CHAT, dryRun: true })).toMatchObject({ ok: true, dryRun: true, existing: false });
    expect(count()).toEqual(before);
  });
});

describe('the reply, as the notifier sends it', () => {
  it("is posted once, in the chat's words, naming who started it from a terminal, before a member's first notice", async () => {
    const r = made(start(CHAT));
    const [shortlist] = r.tasks;
    expect(service.block(r.tasks[1]?.taskId ?? '', { kind: 'person', principal: ALICE }, { kind: 'needs_input', reason: 'which acme?' }).ok).toBe(true);
    const n = notifier();
    expect(await n.deliver()).toBe(2);
    expect(lark.texts).toHaveLength(1);
    const [reply, blocked] = lark.texts[0]?.text.split('\n\n') ?? [];
    expect(reply).toBe(
      [
        `operator:alice started vendor-eval from a terminal as \`${r.instance.instanceId}\`, 4 tasks:`,
        `- \`${shortlist?.taskId}\` Shortlist vendors for log storage, for role worker`,
        `- \`${r.tasks[1]?.taskId}\` Evaluate acme for log storage, for role worker`,
        `- \`${r.tasks[2]?.taskId}\` Evaluate globex for log storage, for role worker`,
        `- \`${r.tasks[3]?.taskId}\` Recommend a vendor for log storage, for role worker`,
        `This chat ${HEARS}`,
      ].join('\n'),
    );
    expect(blocked).toMatch(/is blocked \(needs\\_input\): which acme\?/);
    expect(await n.deliver()).toBe(0);
    expect(lark.texts).toHaveLength(1);
  });

  it("is in the thread's words in a thread, saying where a person's card comes", async () => {
    made(service.applyDag({ dag: dag(2), createdBy: BY, createdVia: OPERATOR, follow: THREAD }));
    await notifier().deliver();
    expect(lark.texts[0]?.target).toEqual({ chatId: 'oc_team', threadId: 'omt_topic', root: 'om_root' });
    expect(lark.texts[0]?.text.split('\n')[0]).toMatch(/^operator:alice started \\\(no workflow\\\) from a terminal as `w_[0-9a-z]+`, 2 tasks:$/);
    expect(lark.texts[0]?.text.split('\n').at(-1)).toBe(
      `This thread ${HEARS} A person's card comes in this thread when their task is ready, or by direct message if they are not in this group.`,
    );
  });

  it('is never cut, and under 3,800 characters for 100 tasks of 512-byte titles', async () => {
    const r = made(service.applyDag({ dag: dag(100, 512), createdBy: BY, createdVia: OPERATOR, follow: CHAT }));
    expect(await notifier().deliver()).toBe(1);
    const text = lark.texts[0]?.text ?? '';
    expect(text.length).toBeLessThan(WORKFLOW_REPLY_MAX);
    const lines = text.split('\n');
    const listed = lines.filter((l) => l.startsWith('- '));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThanOrEqual(30);
    expect(lines.at(-2)).toBe(`… and ${100 - listed.length} more: \`/kanban workflow show ${r.instance.instanceId}\` lists them all.`);
    expect(lines.at(-1)).toMatch(/^This chat hears/);
  });

  it('is sent again after a restart with the same uuid, and read without the workflow tables', async () => {
    const r = made(start(CHAT));
    lark.failNext('sendText', new Error('socket hang up'));
    await notifier().deliver();
    const prepare = vi.spyOn(h.db, 'prepare');
    expect(await notifier().deliver()).toBe(1);
    expect(prepare.mock.calls.map((c) => String(c[0])).filter((sql) => /kanban_workflow/.test(sql))).toEqual([]);
    prepare.mockRestore();
    const first = r.tasks[0]?.taskId ?? '';
    const sub = subscriptionsOf(h.db, first)[0]?.id ?? 0;
    const event = eventsOf(h.db, first).find((e) => e.kind === 'workflow_started')?.id ?? 0;
    expect(lark.texts[0]?.uuid).toBe(noticeBatchUuid('cli_app', [[sub, event]]));
  });
});

describe('renderStarted', () => {
  it("is chat's own reply, built from the rows, with no one named as the starter", () => {
    const r = made(start(undefined));
    const text = renderStarted(startedReply(r), 'chat', (a) => `role ${a.name}`);
    expect(text.split('\n')[0]).toBe(`Started vendor-eval as \`${r.instance.instanceId}\`, 4 tasks:`);
  });
});
