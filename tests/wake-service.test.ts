import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf, getTask, getWake, subscriptionsOf } from '../src/db/kanban-read.js';
import { KanbanService, type CreateRequest, type KanbanServiceDeps } from '../src/kanban/service.js';
import type { Role } from '../src/roles.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * The service's wake (wake spec §3.1, §3.4, §13): `setWake` with its refusals,
 * `create` taking a wake, and the wake writes the waker goes through.
 */

const APP = 'cli_app';
const BOB = 'lark:on_bob';
const FOLLOW = { appId: APP, chatId: 'oc_team', threadId: '', rootId: null };

let h: TestDb;
let clock: ManualClock;
beforeEach(() => {
  h = testDb();
  clock = new ManualClock();
});
afterEach(() => h.close());

const ROLES: ReadonlyMap<string, Role> = new Map([
  [
    'implementer',
    {
      name: 'implementer',
      source: 'directory',
      dir: undefined,
      description: undefined,
      workspace: undefined,
      agent: {
        driver: 'structured-cli',
        command: 'bytesec',
        args: [],
        env: {},
        unsupervised: true,
        passEnv: [],
        readOnlyTools: [],
        maskExempt: [],
      },
      roleMdPath: undefined,
      skills: [],
      secretValues: [],
    },
  ],
]);

function service(extra: Partial<KanbanServiceDeps> = {}): KanbanService {
  return new KanbanService({ db: h.db, roles: ROLES, workspaces: WORKSPACES, clock, ...extra });
}

function request(extra: Partial<CreateRequest> = {}): CreateRequest {
  return { title: 'Book the venue', assignee: 'implementer', createdBy: ALICE, createdVia: VIA, ...extra };
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

const WAKES_OFF =
  'wakes are off on this gateway: an operator turns them on with kanban.wake.enabled: true in config.yaml, and a restart';

describe('KanbanService.create with a wake', () => {
  it('makes a task with wake on, as its setter, at its depth', () => {
    const { task } = ok(service().create(request({ wake: { by: ALICE, depth: 2 } })));
    expect(task).toMatchObject({ wakeBy: ALICE, wakeDepth: 2 });
    expect(eventsOf(h.db, task.taskId).map((e) => e.kind)).toEqual(['created', 'wake_set']);
  });

  it('keeps a depth without a wake', () => {
    const { task } = ok(service().create(request({ wake: { by: null, depth: 1 } })));
    expect(task).toMatchObject({ wakeBy: null, wakeDepth: 1 });
  });

  it('refuses a wake while wakes are off, and makes nothing', () => {
    const r = service({ wake: { enabled: false, maxDepth: 5 } }).create(request({ wake: { by: ALICE, depth: 0 } }));
    expect(r).toEqual({ ok: false, code: 'wake_off', message: WAKES_OFF });
    expect(h.db.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual({ n: 0 });
  });

  it("makes a task asked with no wake while wakes are off", () => {
    expect(service({ wake: { enabled: false, maxDepth: 5 } }).create(request()).ok).toBe(true);
  });

  it("refuses a terminal's wake with no chat to follow the task", () => {
    const r = service().create(request({ createdVia: { kind: 'operator' }, wake: { by: ALICE, depth: 0 } }));
    expect(r).toEqual({ ok: false, code: 'invalid', message: 'a wake needs a chat that follows the task: add --chat' });
    const followed = ok(service().create(request({ createdVia: { kind: 'operator' }, follow: FOLLOW, wake: { by: ALICE, depth: 0 } })));
    expect(followed.task.wakeBy).toBe(ALICE);
  });

  it('makes a task at max_depth or more with wake off, recording why', () => {
    const { task } = ok(service({ wake: { enabled: true, maxDepth: 5 } }).create(request({ wake: { by: ALICE, depth: 5 } })));
    expect(task).toMatchObject({ wakeBy: null, wakeDepth: 5 });
    expect(eventsOf(h.db, task.taskId).find((e) => e.kind === 'wake_set')?.payload).toEqual({ on: false, refused: 'too_deep', depth: 5 });
    const shallow = ok(service({ wake: { enabled: true, maxDepth: 5 } }).create(request({ wake: { by: ALICE, depth: 4 } })));
    expect(shallow.task.wakeBy).toBe(ALICE);
  });

  it('refuses a wake that is not a principal and a depth', () => {
    for (const wake of [{ by: 'alice', depth: 0 }, { by: ALICE, depth: -1 }, { by: ALICE, depth: 1.5 }]) {
      expect(service().create(request({ wake })).ok).toBe(false);
    }
  });
});

describe('KanbanService.setWake', () => {
  it('turns wake on and off, and says when it was already so', () => {
    const s = service();
    const { task } = ok(s.create(request()));
    expect(ok(s.setWake(task.taskId, { on: true, as: ALICE }, ALICE, APP))).toMatchObject({ changed: true, tooDeep: false, task: { wakeBy: ALICE } });
    expect(ok(s.setWake(task.taskId, { on: true, as: ALICE }, ALICE, APP)).changed).toBe(false);
    expect(ok(s.setWake(task.taskId, { on: true, as: BOB }, BOB, APP)).task.wakeBy).toBe(BOB);
    expect(ok(s.setWake(task.taskId, { on: false }, ALICE, APP))).toMatchObject({ changed: true, task: { wakeBy: null } });
    expect(ok(s.setWake(task.taskId, { on: false }, ALICE, APP)).changed).toBe(false);
  });

  it('refuses wake on while wakes are off, and still turns it off', () => {
    const on = service();
    const { task } = ok(on.create(request()));
    ok(on.setWake(task.taskId, { on: true, as: ALICE }, ALICE, APP));
    const off = service({ wake: { enabled: false, maxDepth: 5 } });
    expect(off.setWake(task.taskId, { on: true, as: BOB }, BOB, APP)).toEqual({ ok: false, code: 'wake_off', message: WAKES_OFF });
    expect(ok(off.setWake(task.taskId, { on: false }, ALICE, APP)).task.wakeBy).toBeNull();
  });

  it('refuses a task no chat of this bot follows', () => {
    const s = service();
    const { task } = ok(s.create(request({ createdVia: { kind: 'operator' } })));
    expect(s.setWake(task.taskId, { on: true, as: ALICE }, ALICE, APP)).toEqual({
      ok: false,
      code: 'invalid',
      message: `a wake needs a chat that follows the task, and no chat follows ${task.taskId}: a chat is chosen when a task is made`,
    });
  });

  it('leaves a task too deep with wake off, as a note', () => {
    const s = service({ wake: { enabled: true, maxDepth: 2 } });
    const { task } = ok(s.create(request({ wake: { by: null, depth: 2 } })));
    expect(ok(s.setWake(task.taskId, { on: true, as: ALICE }, ALICE, APP))).toMatchObject({ changed: false, tooDeep: true, task: { wakeBy: null } });
  });

  it('refuses ids that are not text, and a task that is not there', () => {
    const s = service();
    expect(s.setWake(7 as unknown as string, { on: false }, ALICE, APP)).toMatchObject({ ok: false, code: 'invalid' });
    expect(s.setWake('k_none', { on: true, as: ALICE }, ALICE, APP)).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe("the waker's writes through the service", () => {
  it('records, stamps, refuses, delivers and passes a wake', () => {
    const s = service();
    const { task } = ok(s.create(request({ wake: { by: ALICE, depth: 0 } })));
    const sub = subscriptionsOf(h.db, task.taskId)[0];
    if (sub === undefined) throw new Error('no subscription');
    const event = eventsOf(h.db, task.taskId).at(-1);
    if (event === undefined) throw new Error('no event');
    const { wake } = ok(
      s.recordWake({
        uuid: 'u-1',
        channel: 'lark',
        appId: APP,
        conversationId: sub.conversationId,
        threadId: sub.threadId,
        principal: ALICE,
        depth: 0,
        events: [{ subscriptionId: sub.id, eventId: event.id, taskId: task.taskId }],
      }),
    );
    expect(ok(s.wakeMarked(wake.wakeId)).marked).toBe(true);
    expect(ok(s.wakeSubmitted(wake.wakeId, 's_one', 'key-1', 'boot-1')).submitted).toBe(true);
    expect(ok(s.wakeRefused(wake.wakeId, 'session s_one is closed'))).toMatchObject({ refused: true, attempt: 2 });
    clock.advance(1_000);
    expect(ok(s.advanceWake(wake.wakeId)).delivered).toBe(true);
    expect(getWake(h.db, wake.wakeId)).toMatchObject({ state: 'delivered', deliveredAt: clock.now() });
    expect(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor).toBe(event.id);
    expect(ok(s.dropWake(wake.wakeId, 'late')).dropped).toBe(false);
    expect(ok(s.liftedWake(wake.wakeId)).lifted).toBe(false);
    expect(ok(s.passWake(sub.id, event.id + 1)).advanced).toBe(true);
    expect(getTask(h.db, task.taskId)?.wakeBy).toBe(ALICE);
  });
});
