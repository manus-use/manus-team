import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkAdapter } from '../src/channel/lark/adapter.js';
import { LarkInbound } from '../src/channel/lark/inbound.js';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { tasksWithWakeOn } from '../src/db/kanban-read.js';
import { notePerson } from '../src/db/people.js';
import { openDb } from '../src/db/open.js';
import { chatEnv, createGateway, wakeLine } from '../src/index.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam, type Team } from '../src/team.js';
import { testDb, type TestDb } from './helpers/db.js';
import { newTask } from './helpers/kanban.js';

/**
 * The gateway's wakes (wake spec §11, §13): the startup line, a chat session's
 * environment with both tokens, the setter as a session's owner, and the waker
 * built with the board and wakes on, started once connected and drained before
 * the channel disconnects.
 */

const ON = { enabled: true, perHour: 6, maxDepth: 5, holdMinutes: 10 };

describe('wakeLine', () => {
  it('says the cap and the depth when wakes are on', () => {
    expect(wakeLine(ON, 0)).toBe('kanban: wakes on; at most 6 woken turns a conversation an hour, tasks up to 4 woken turns deep');
    expect(wakeLine({ ...ON, perHour: 10, maxDepth: 2 }, 3)).toBe('kanban: wakes on; at most 10 woken turns a conversation an hour, tasks up to 1 woken turns deep');
  });

  it('says how many tasks stay notice-only when wakes are off, and nothing when none has wake on', () => {
    expect(wakeLine({ ...ON, enabled: false }, 3)).toBe('kanban: wakes off (kanban.wake.enabled is false); 3 task(s) with wake on stay notice-only');
    expect(wakeLine({ ...ON, enabled: false }, 0)).toBeUndefined();
  });
});

describe('chatEnv', () => {
  it("is nothing when neither token is given, and their union otherwise", () => {
    expect(chatEnv(undefined, undefined)).toBeUndefined();
    const access = { MT_KANBAN_SOCKET: '/s', PATH: '/home/bin:/usr/bin' };
    expect(chatEnv({ ...access, MT_CRON_TOKEN: 'c' }, undefined)).toEqual({ ...access, MT_CRON_TOKEN: 'c' });
    expect(chatEnv(undefined, { ...access, MT_WAKE_TOKEN: 'w' })).toEqual({ ...access, MT_WAKE_TOKEN: 'w' });
    expect(chatEnv({ ...access, MT_CRON_TOKEN: 'c' }, { ...access, MT_WAKE_TOKEN: 'w' })).toEqual({ ...access, MT_CRON_TOKEN: 'c', MT_WAKE_TOKEN: 'w' });
  });
});

describe('tasksWithWakeOn and PeopleDirectory.principalOf', () => {
  let h: TestDb;
  beforeEach(() => {
    h = testDb();
  });
  afterEach(() => h.close());

  it('counts the tasks with wake on', () => {
    newTask(h.db);
    expect(tasksWithWakeOn(h.db)).toBe(0);
    newTask(h.db, { wake: { by: 'lark:on_alice', depth: 0 } });
    newTask(h.db, { wake: { by: 'lark:on_alice', depth: 1 } });
    expect(tasksWithWakeOn(h.db)).toBe(2);
  });

  it("gives a setter as a session's owner, by the open_id and name people holds for them, and nothing for one it does not hold", () => {
    notePerson(h.db, { appId: 'cli_app', unionId: 'on_zhixi', openId: 'ou_zhixi', name: 'Zhixi Sun' }, 1);
    const people = new PeopleDirectory({ db: h.db, appId: 'cli_app', canTalk: () => true });
    expect(people.principalOf('lark:on_zhixi')).toEqual({ openId: 'ou_zhixi', unionId: 'on_zhixi', displayName: 'Zhixi Sun' });
    expect(people.principalOf('lark:on_nobody')).toBeUndefined();
    expect(people.principalOf('operator:alice')).toBeUndefined();
    expect(new PeopleDirectory({ db: h.db, appId: 'cli_other', canTalk: () => true }).principalOf('lark:on_zhixi')).toBeUndefined();
  });

  it("gives the owner the configuration's open_id, matched to the setter through personByOpenId", () => {
    // The owner was seen under the open_id the configuration names; their union_id row says the same person.
    notePerson(h.db, { appId: 'cli_app', unionId: 'on_owner', openId: 'ou_owner', name: 'Olive Owner' }, 1);
    const people = new PeopleDirectory({ db: h.db, appId: 'cli_app', canTalk: () => true, ownerOpenId: 'ou_owner' });
    expect(people.principalOf('lark:on_owner')).toEqual({ openId: 'ou_owner', unionId: 'on_owner', displayName: 'Olive Owner' });
    // An owner the bot has not seen under that open_id is matched to nobody, and judged as anyone else.
    const unseen = new PeopleDirectory({ db: h.db, appId: 'cli_app', canTalk: () => true, ownerOpenId: 'ou_elsewhere' });
    expect(unseen.principalOf('lark:on_owner')).toEqual({ openId: 'ou_owner', unionId: 'on_owner', displayName: 'Olive Owner' });
    expect(unseen.principalOf('lark:on_nobody')).toBeUndefined();
  });
});

describe('createGateway, with the board on', () => {
  let root: string;
  let config: GatewayConfig;
  let team: Team;
  let lines: string[];

  beforeEach(() => {
    clearSecrets();
    root = mkdtempSync(join(tmpdir(), 'mt-wake-gw-'));
    const home = join(root, 'home');
    mkdirSync(home);
    mkdirSync(join(root, 'repo'));
    const env = {
      MT_HOME: home,
      MT_DB: join(home, 'team.db'),
      MT_WORKSPACE: join(root, 'repo'),
      MT_OWNER_OPEN_ID: 'ou_owner',
      LARK_APP_ID: 'cli_app',
      LARK_APP_SECRET: 'app-secret',
      MT_AGENT_COMMAND: 'bytesec',
      MT_AGENT_DRIVER: 'structured-cli',
      MT_AGENT_UNSUPERVISED: 'true',
    };
    const loaded = loadConfig(env, () => undefined);
    config = { ...loaded, kanban: { ...loaded.kanban, enabled: true } };
    team = loadTeam(config, env);
    lines = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk).replace(/^\S+ /, '').replace(/\n$/, ''));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('builds the waker with wakes on, and says so after the board\'s line', async () => {
    const gateway = await createGateway(config, team);
    try {
      expect(gateway.waker).toBeDefined();
      const board = lines.findIndex((l) => l.startsWith('kanban: dispatching up to '));
      expect(board).toBeGreaterThanOrEqual(0);
      expect(lines.slice(board + 1)).toContain('kanban: wakes on; at most 6 woken turns a conversation an hour, tasks up to 4 woken turns deep');
    } finally {
      await gateway.stop();
    }
  });

  it('builds no waker with wakes off, and says how many tasks stay notice-only', async () => {
    const quiet = await createGateway({ ...config, kanban: { ...config.kanban, wake: { ...config.kanban.wake, enabled: false } } }, team);
    expect(quiet.waker).toBeUndefined();
    await quiet.stop();
    expect(lines.filter((l) => l.startsWith('kanban: wakes'))).toEqual([]);
    const db = openDb(config.dbPath);
    try {
      newTask(db, { wake: { by: 'lark:on_alice', depth: 0 } });
    } finally {
      db.close();
    }
    const gateway = await createGateway({ ...config, kanban: { ...config.kanban, wake: { ...config.kanban.wake, enabled: false } } }, team);
    try {
      expect(gateway.waker).toBeUndefined();
      expect(lines).toContain('kanban: wakes off (kanban.wake.enabled is false); 1 task(s) with wake on stay notice-only');
    } finally {
      await gateway.stop();
    }
  });

  it('builds no waker with the board off, whatever kanban.wake says', async () => {
    const gateway = await createGateway({ ...config, kanban: { ...config.kanban, enabled: false } }, team);
    try {
      expect(gateway.waker).toBeUndefined();
      expect(lines.filter((l) => l.startsWith('kanban: wakes'))).toEqual([]);
    } finally {
      await gateway.stop();
    }
  });

  it('starts the waker after the notices once connected, and waits for its round, a few seconds at most, before it disconnects', async () => {
    vi.spyOn(LarkAdapter.prototype, 'connect').mockResolvedValue(undefined);
    const order: string[] = [];
    vi.spyOn(LarkAdapter.prototype, 'disconnect').mockImplementation(async () => {
      order.push('disconnect');
    });
    vi.spyOn(LarkInbound.prototype, 'start').mockImplementation(() => undefined);
    const gateway = await createGateway(config, team);
    const { notifier, waker } = gateway;
    if (notifier === undefined || waker === undefined) throw new Error('no notifier or waker');
    vi.spyOn(notifier, 'start').mockImplementation(() => {
      order.push('notices start');
    });
    vi.spyOn(waker, 'start').mockImplementation(() => {
      order.push('wakes start');
    });
    vi.spyOn(waker, 'stop').mockImplementation(() => {
      order.push('wakes stop');
    });
    const bounds: Array<number | undefined> = [];
    vi.spyOn(waker, 'idle').mockImplementation(async (boundMs) => {
      order.push('wakes idle');
      bounds.push(boundMs);
      return true;
    });
    await gateway.start();
    await gateway.stop();
    expect(order).toEqual(['notices start', 'wakes start', 'wakes stop', 'wakes idle', 'disconnect']);
    expect(bounds).toHaveLength(1);
    expect(bounds[0]).toBeGreaterThan(0);
    expect(bounds[0]).toBeLessThanOrEqual(10_000);
  });
});
