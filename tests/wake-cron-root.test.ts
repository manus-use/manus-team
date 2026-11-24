import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addComment, claim, createTask } from '../src/db/kanban.js';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { CronService } from '../src/cron/service.js';
import { CronTokens } from '../src/cron/tokens.js';
import { CronApi } from '../src/cron/worker.js';
import { KanbanService } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import { clearSecrets } from '../src/secrets.js';
import { NOW } from './helpers/cron.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, WORKSPACES, claimantFor, newTask } from './helpers/kanban.js';

/**
 * No cron jobs under a wake (wake spec §19.8): a run whose task has `wake_root`
 * set, a reaction task's and every task made from one, however deep, workflow
 * members of a start such a run made included, may not add a cron job: its `mt
 * cron add` is refused `needs_operator`, in the words a woken chat turn's
 * refusal uses. An ordinary board run's add is accepted, as before.
 */

const NEEDS_OPERATOR = 'this turn was asked by someone without operate tier, who cannot add cron jobs; an operator can, here or with /cron add';
const THREAD = { kind: 'chat' as const, channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root', chatType: 'group' as const };

let h: TestDb;
let api: CronApi;
let board: KanbanService;
const roles = new Map([['default', role('default')], ['worker', role('worker')], ['vi-coordinator', role('vi-coordinator')]]);

beforeEach(() => {
  clearSecrets();
  h = testDb();
  const clock = new ManualClock(NOW);
  const service = new CronService({ db: h.db, roles, workspaces: new Set(['default']), zone: 'Asia/Shanghai', clock });
  api = new CronApi({ db: h.db, service, tokens: new CronTokens({ db: h.db }), appId: 'cli_app' });
  board = new KanbanService({ db: h.db, roles, workspaces: WORKSPACES, clock });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

/** A claim of the task, with a token. */
function running(taskId: string): { runId: string; token: string } {
  const token = mintToken();
  const r = claim(h.db, { taskId, claimant: claimantFor(h.db, taskId), tokenHash: hashToken(token), workspaces: WORKSPACES }, NOW);
  if (!r.ok) throw new Error(r.message);
  return { runId: r.run.runId, token };
}

const add = (r: { runId: string; token: string }) =>
  api.handle({ cron: 'add', token: r.token, run: r.runId, input: { schedule: 'every day 09:00', prompt: 'Summarise the day.' } });

/** A reaction task, made by a role's wake of a task in thread omt_topic. */
function reaction(): string {
  const source = newTask(h.db, { createdVia: THREAD, wake: { by: ALICE, depth: 0, role: 'vi-coordinator' } });
  addComment(h.db, source.taskId, ALICE, 'an outcome stands in here', NOW, false);
  const r = board.recordRoleWake({
    uuid: 'u-1',
    channel: 'lark',
    appId: 'cli_app',
    conversationId: 'oc_team',
    threadId: 'omt_topic',
    principal: ALICE,
    depth: 0,
    events: [{ subscriptionId: subscriptionsOf(h.db, source.taskId)[0]?.id ?? 0, eventId: eventsOf(h.db, source.taskId).at(-1)?.id ?? 0, taskId: source.taskId }],
    role: 'vi-coordinator',
    title: 'React to board updates',
    body: 'Board update',
  });
  if (!r.ok || !('task' in r)) throw new Error('no reaction task');
  return r.task.taskId;
}

/** A follow-up made by `run`, assigned to worker, in its own workspace. */
function followUp(run: { runId: string }, workspace: string): string {
  const r = createTask(
    h.db,
    { title: 'a follow-up', assignee: { kind: 'role', name: 'worker' }, workspace, createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } },
    NOW,
  );
  if (!r.ok) throw new Error(r.message);
  return r.task.taskId;
}

describe("a run of work a wake put on the board", () => {
  it("refuses a reaction run's add, in a woken chat turn's words", async () => {
    expect(await add(running(reaction()))).toEqual({ ok: false, code: 'needs_operator', message: NEEDS_OPERATOR });
  });

  it("refuses the add of a follow-up's run, of its follow-up's, and of a workflow member's the reaction run started", async () => {
    const first = running(reaction());
    const child = followUp(first, 'web');
    const childRun = running(child);
    expect(await add(childRun)).toEqual({ ok: false, code: 'needs_operator', message: NEEDS_OPERATOR });
    const grandchild = followUp(childRun, 'api');
    expect(await add(running(grandchild))).toEqual({ ok: false, code: 'needs_operator', message: NEEDS_OPERATOR });
    const applied = board.applyDag({
      dag: { format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'worker', workspace: 'docs' }] },
      createdBy: `run:${first.runId}`,
      createdVia: { kind: 'run', runId: first.runId },
    });
    if (!applied.ok || !('instance' in applied)) throw new Error('not applied');
    const member = applied.tasks[0]?.taskId ?? '';
    expect(await add(running(member))).toEqual({ ok: false, code: 'needs_operator', message: NEEDS_OPERATOR });
  });

  it("still accepts an ordinary board run's add", async () => {
    const task = newTask(h.db, { assignee: { kind: 'role', name: 'worker' } });
    expect(await add(running(task.taskId))).toMatchObject({ ok: true });
  });
});
