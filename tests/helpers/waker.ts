import { bindSession, resolveBinding } from '../../src/db/bindings.js';
import { setWake } from '../../src/db/kanban.js';
import { eventsOf, getWake, subscriptionsOf } from '../../src/db/kanban-read.js';
import type { Db } from '../../src/db/open.js';
import { createSession, getSession } from '../../src/db/sessions.js';
import type { SubmitRequest } from '../../src/core/session-actor.js';
import { KanbanService } from '../../src/kanban/service.js';
import type { Role } from '../../src/roles.js';
import type { CreatedVia, TaskRow, WakeRow } from '../../src/kanban/types.js';
import { Waker, type WakeActor, type WakerDeps } from '../../src/kanban/waker.js';
import type { BindingKey, Principal, SessionRow, TurnTerminal } from '../../src/types.js';
import { FakeChannel } from './channel.js';
import { ManualClock, settle, testDb, type TestDb } from './db.js';
import { ALICE, NOW, WORKSPACES, newTask } from './kanban.js';

/**
 * The waker's tests' fakes (wake spec §14): an actor that answers a submit as
 * told, a registry over the real bindings, and a harness with a real board, a
 * fake channel and a fake clock.
 */

export const APP = 'cli_app';
export const BOB = 'lark:on_bob';

/** A thread's chat-made task: its subscription in the thread, with its root. */
export const IN_THREAD: Extract<CreatedVia, { kind: 'chat' }> = {
  kind: 'chat',
  channel: 'lark',
  appId: APP,
  conversationId: 'oc_chat',
  threadId: 'omt_1',
  rootId: 'om_root',
  chatType: 'group',
};

export const THREAD_KEY: BindingKey = { channel: 'lark', appId: APP, conversationId: 'oc_chat', threadId: 'omt_1' };

/**
 * How a submit is answered: the prompt delivered and the turn completed; found
 * made (`created: false`); the agent failing to start; the prompt delivered and
 * the turn held until `release`; the turn made and never prompted, until
 * `release`; the promise rejecting, before the turn is made or after its prompt;
 * or the turn ending at once after its prompt, as `endAfterPrompt` says.
 */
export type Answer =
  | 'prompt'
  | 'duplicate'
  | 'fail_start'
  | 'hold'
  | 'hang'
  | { reject: Error }
  | { rejectAfterPrompt: Error }
  | { endAfterPrompt: TurnTerminal };

export class FakeActor implements WakeActor {
  readonly submits: SubmitRequest[] = [];
  /** Answers for the next submits, in order; `prompt` once they run out. */
  readonly answers: Answer[] = [];
  queued = 0;
  readonly #held: Array<(terminal: TurnTerminal) => void> = [];

  async submit(req: SubmitRequest): Promise<TurnTerminal> {
    this.submits.push(req);
    const answer = this.answers.shift() ?? 'prompt';
    await Promise.resolve();
    if (typeof answer === 'object' && 'reject' in answer) throw answer.reject;
    if (answer === 'duplicate') {
      req.onTurn?.({ created: false });
      return 'completed';
    }
    req.onTurn?.({ created: true });
    if (answer === 'fail_start') return 'failed';
    if (answer === 'hang') return new Promise<TurnTerminal>((resolve) => this.#held.push(resolve));
    req.onPrompted?.();
    if (typeof answer === 'object' && 'endAfterPrompt' in answer) return answer.endAfterPrompt;
    if (typeof answer === 'object') throw answer.rejectAfterPrompt;
    if (answer === 'hold') return new Promise<TurnTerminal>((resolve) => this.#held.push(resolve));
    return 'completed';
  }

  /** End the oldest held turn. */
  release(terminal: TurnTerminal = 'completed'): void {
    this.#held.shift()?.(terminal);
  }
}

/** A registry over the real bindings, one `FakeActor` a session. */
export class FakeRegistry {
  readonly actors = new Map<string, FakeActor>();
  readonly owners: Principal[] = [];
  readonly actorFors: string[] = [];
  #n = 0;

  constructor(readonly db: Db) {}

  bindOrCreate(key: BindingKey, owner: Principal): { session: SessionRow; created: boolean } {
    const bound = resolveBinding(this.db, key);
    const existing = bound === undefined ? undefined : getSession(this.db, bound.sessionId);
    if (existing !== undefined) return { session: existing, created: false };
    this.#n += 1;
    const id = `s_w${this.#n}`;
    createSession(this.db, { id, agentId: 'default', workspaceId: 'plain-dir:x', ownerPrincipal: owner.unionId ?? owner.openId }, NOW);
    bindSession(this.db, key, id, NOW);
    this.owners.push(owner);
    const session = getSession(this.db, id);
    if (session === undefined) throw new Error('no session');
    return { session, created: true };
  }

  async actorFor(sessionId: string, _key: BindingKey): Promise<FakeActor> {
    this.actorFors.push(sessionId);
    return this.actor(sessionId);
  }

  liveActor(sessionId: string): FakeActor | undefined {
    return this.actors.get(sessionId);
  }

  /** The session's actor, made if it has none yet. */
  actor(sessionId: string): FakeActor {
    let a = this.actors.get(sessionId);
    if (a === undefined) {
      a = new FakeActor();
      this.actors.set(sessionId, a);
    }
    return a;
  }

  /** Every submit, to any session, in order. */
  get submits(): SubmitRequest[] {
    return [...this.actors.values()].flatMap((a) => a.submits);
  }
}

export interface WakeHarness {
  t: TestDb;
  db: Db;
  clock: ManualClock;
  service: KanbanService;
  lark: FakeChannel;
  registry: FakeRegistry;
  notes: string[];
  turnsSubmitted: Array<{ sessionId: string; key: string; operate: boolean }>;
  /** Who has talk and operate tier; every principal has talk unless taken out. */
  talk: Set<string>;
  operate: Set<string>;
  names: Map<string, string>;
  waker: Waker;
  /** A waker built anew on the same deps, the old one stopped: as a second waker in the same process (§5.2 step 1). */
  rebuild(): Waker;
  /** A task in the thread, wake on as `by`, its notices sent. */
  woken(by?: string, extra?: Parameters<typeof newTask>[1]): TaskRow;
  /** An event on the task, as the board writes it, its notice sent unless `noticed` is false. */
  event(task: TaskRow, kind: string, actor: string, payload: Record<string, unknown>, noticed?: boolean): number;
  /** The task's notice cursors moved past its every event, as the notifier does once it has sent them. */
  noticed(task: TaskRow): void;
  /** One round, and the callbacks it set going. */
  round(): Promise<number>;
  wakes(): WakeRow[];
}

export function wakeHarness(extra: Partial<WakerDeps> = {}, opts: { roles?: ReadonlyMap<string, Role> } = {}): WakeHarness {
  const t = testDb();
  const db = t.db;
  const clock = new ManualClock(NOW);
  const service = new KanbanService({ db, roles: opts.roles ?? new Map(), workspaces: WORKSPACES, clock });
  const lark = new FakeChannel({ clock });
  const registry = new FakeRegistry(db);
  const notes: string[] = [];
  const turnsSubmitted: WakeHarness['turnsSubmitted'] = [];
  const talk = new Set<string>([ALICE, BOB]);
  const operate = new Set<string>([ALICE]);
  const names = new Map<string, string>([
    [ALICE, 'Alice'],
    [BOB, 'Bob'],
  ]);
  const deps: WakerDeps = {
    db,
    service,
    registry,
    channels: new Map([['lark', lark]]),
    appId: APP,
    people: {
      canTalk: (p) => talk.has(p),
      canOperate: (p) => talk.has(p) && operate.has(p),
      chatNames: () => (p) => names.get(p),
      principalOf: (p) =>
        p.startsWith('lark:') ? { openId: `ou_${p.slice('lark:on_'.length)}`, unionId: p.slice('lark:'.length), displayName: names.get(p) ?? null } : undefined,
    },
    admitsConversation: () => undefined,
    assignable: (role) => service.wakeRoleUsable(role),
    letGo: () => false,
    cronTurns: { turnSubmitted: (sessionId, key, op) => turnsSubmitted.push({ sessionId, key, operate: op }) },
    settings: { perHour: 6, maxDepth: 5 },
    blockRecurrenceLimit: 3,
    zone: 'UTC',
    clock,
    note: (line) => notes.push(line),
    ...extra,
  };
  const waker = new Waker(deps);
  const h: WakeHarness = {
    t,
    db,
    clock,
    service,
    lark,
    registry,
    notes,
    turnsSubmitted,
    talk,
    operate,
    names,
    waker,
    rebuild() {
      h.waker.stop();
      h.waker = new Waker(deps);
      return h.waker;
    },
    woken(by = ALICE, more = {}) {
      const task = newTask(db, { createdVia: IN_THREAD, ...more });
      const r = setWake(db, task.taskId, { on: true, as: by, maxDepth: 5 }, by, APP, NOW);
      if (!r.ok) throw new Error(r.message);
      h.noticed(task);
      return r.task;
    },
    event(task, kind, actor, payload, noticed = true) {
      db.prepare('INSERT INTO kanban_events (task_id, kind, actor, payload, created_at) VALUES (?, ?, ?, jsonb(?), ?)').run(
        task.taskId,
        kind,
        actor,
        JSON.stringify(payload),
        clock.now(),
      );
      const id = eventsOf(db, task.taskId).at(-1)?.id ?? 0;
      if (noticed) h.noticed(task);
      return id;
    },
    noticed(task) {
      const last = eventsOf(db, task.taskId).at(-1)?.id ?? 0;
      for (const s of subscriptionsOf(db, task.taskId)) {
        db.prepare('UPDATE kanban_subscriptions SET cursor = ? WHERE id = ? AND cursor < ?').run(last, s.id, last);
      }
    },
    async round() {
      const n = await h.waker.wake();
      await settle();
      return n;
    },
    wakes() {
      const ids = db.prepare<[], { wake_id: number }>('SELECT wake_id FROM kanban_wakes ORDER BY wake_id').all();
      return ids.map((r) => getWake(db, r.wake_id)).filter((w): w is WakeRow => w !== undefined);
    },
  };
  return h;
}
