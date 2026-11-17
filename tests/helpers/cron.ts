import { newCronJobId } from '../../src/core/ids.js';
import { addJob, type CronDelivery, type JobRow, type NewJob } from '../../src/db/cron.js';
import type { Db } from '../../src/db/open.js';
import type { Channel } from '../../src/channel/types.js';
import { SessionRegistry } from '../../src/core/registry.js';
import { NamedWorkspaces } from '../../src/core/workspace.js';
import { CronScheduler, type CronSchedulerDeps, type CronSettings } from '../../src/cron/scheduler.js';
import { CronService } from '../../src/cron/service.js';
import { SinkChannel } from '../../src/kanban/sink.js';
import type { Role } from '../../src/roles.js';
import type { TurnTerminal } from '../../src/types.js';
import { FakeChannel } from './channel.js';
import { ManualClock, settle, testDb, type TestDb } from './db.js';
import { role } from './dispatch.js';
import { FakeDriver, type TurnControl } from './driver.js';

/** A cron job's fixtures: a chat's delivery, and an add through the writer. */

export const NOW = Date.UTC(2026, 10, 17, 1, 0);
export const APP = 'cli_app';
export const TEAM: CronDelivery = { channel: 'lark', account: APP, chat: 'oc_team', thread: '', root: null };

export function newJob(db: Db, extra: Partial<NewJob> = {}, now = NOW): JobRow {
  const r = addJob(db, jobInput(extra, now), now);
  if (!r.ok) throw new Error(r.message);
  return r.job;
}

/** A job to add, by default an hourly one delivering to the team's chat. */
export function jobInput(extra: Partial<NewJob> = {}, now = NOW): NewJob {
  return {
    jobId: newCronJobId(),
    name: 'Daily PRs',
    schedule: 'every 1h',
    tz: 'Asia/Shanghai',
    role: 'worker',
    workspace: 'default',
    prompt: 'List the open PRs.',
    script: null,
    delivery: TEAM,
    nextRunAt: now + 3_600_000,
    createdBy: 'operator:alice',
    createdVia: { kind: 'operator' },
    idempotencyKey: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The scheduler, over the real writer, registry and actors, a fake driver and the fake chat.

export interface CronHarness {
  t: TestDb;
  clock: ManualClock;
  service: CronService;
  registry: SessionRegistry;
  scheduler: CronScheduler;
  lark: FakeChannel;
  driver: FakeDriver;
  notes: string[];
  /** Every archive the registry was asked for, by the key's thread: the fire's id. */
  archives: string[];
  /** Fail the next archive the registry is asked for. */
  failNextArchive(): void;
  add(extra?: Partial<Parameters<CronService['add']>[0]>): JobRow;
  /** Tick, then let the fires' work run. */
  tick(): Promise<void>;
  close(): void;
}

export interface CronHarnessOptions {
  t?: TestDb;
  clock?: ManualClock;
  roles?: readonly Role[];
  settings?: Partial<CronSettings>;
  deps?: Partial<CronSchedulerDeps>;
  workspaces?: ReadonlyMap<string, string>;
}

export function cronHarness(opts: CronHarnessOptions = {}): CronHarness {
  const t = opts.t ?? testDb();
  const clock = opts.clock ?? new ManualClock(NOW);
  const roles = new Map((opts.roles ?? [role('worker')]).map((r) => [r.name, r]));
  const driver = new FakeDriver('worker');
  const drivers = new Map([...roles.keys(), 'default'].map((n) => [n, n === 'worker' ? driver : new FakeDriver(n)]));
  const workspaces = opts.workspaces ?? new Map([['default', '/tmp/ws-default']]);
  const lark = new FakeChannel({ id: 'lark', clock });
  const notes: string[] = [];
  const archives: string[] = [];
  let failArchive = false;
  let scheduler: CronScheduler | undefined;
  const registry = new SessionRegistry({
    db: t.db,
    drivers,
    channels: new Map<string, Channel>([
      ['lark', lark],
      ['cron', new SinkChannel('cron', { now: () => clock.now(), subject: (jobId) => `cron job ${jobId}` })],
    ]),
    envFor: (sessionId) => scheduler?.envFor(sessionId),
    argsFor: (sessionId) => scheduler?.argsFor(sessionId),
    pinned: (sessionId) => scheduler?.pinned(sessionId) ?? false,
    workspaces: new NamedWorkspaces(workspaces),
    appId: APP,
    clock,
    note: (line) => notes.push(line),
  });
  const archive = registry.archive.bind(registry);
  registry.archive = async (key, reason) => {
    if (key.channel === 'cron') archives.push(key.threadId);
    if (failArchive) {
      failArchive = false;
      await archive(key, reason).catch(() => undefined);
      throw new Error('the agent would not close');
    }
    return archive(key, reason);
  };
  const service = new CronService({ db: t.db, roles, workspaces: new Set(workspaces.keys()), zone: 'Asia/Shanghai', clock });
  scheduler = new CronScheduler({
    db: t.db,
    service,
    sessions: registry,
    channels: new Map<string, Channel>([['lark', lark]]),
    appId: APP,
    settings: { maxRunning: 2, idleTimeoutS: 600, ...opts.settings },
    clock,
    note: (line) => notes.push(line),
    ...opts.deps,
  });
  const s = scheduler;
  return {
    t,
    clock,
    service,
    registry,
    scheduler: s,
    lark,
    driver,
    notes,
    archives,
    failNextArchive: () => {
      failArchive = true;
    },
    add(extra = {}) {
      const r = service.add({
        schedule: 'every 1h',
        role: 'worker',
        prompt: 'List the open PRs.',
        name: 'Daily PRs',
        delivery: TEAM,
        createdBy: 'operator:alice',
        createdVia: { kind: 'operator' },
        ...extra,
      });
      if (!r.ok) throw new Error(r.message);
      return r.job;
    },
    async tick() {
      s.tick();
      for (let i = 0; i < 20; i += 1) await settle();
    },
    close() {
      s.stop();
      t.close();
    },
  };
}

/** A turn that answers `text` and completes. */
export function answers(driver: FakeDriver, ...chunks: string[]): void {
  driver.scripts.push((ctl) => {
    for (const text of chunks) ctl.emit({ kind: 'message-chunk', text });
    ctl.end('completed');
  });
}

/** A turn held open until the test ends it; `cancelEnds` ends it when the gateway cancels. */
export interface HeldTurn {
  started: boolean;
  ctl: TurnControl | undefined;
  end(terminal: TurnTerminal): void;
}

export function holdsTurn(driver: FakeDriver): HeldTurn {
  let over = (): void => undefined;
  const held: HeldTurn = {
    started: false,
    ctl: undefined,
    end(terminal) {
      held.ctl?.end(terminal);
      over();
    },
  };
  driver.scripts.push(
    (ctl) =>
      new Promise<void>((resolve) => {
        held.started = true;
        held.ctl = ctl;
        over = resolve;
      }),
  );
  return held;
}
