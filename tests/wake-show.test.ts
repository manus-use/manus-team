import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { showText } from '../src/cli/plain.js';
import { advanceWake, recordWake, setWake } from '../src/db/kanban.js';
import { eventsOf, subscriptionsOf, taskView, type TaskView } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { renderShow, wakeLine } from '../src/kanban/chat-render.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import type { InboundMessage } from '../src/types.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `task show`'s Wake line (wake spec §10): in chat by chat name, at the terminal
 * by principal, with the depth and the time of the task's last delivered wake
 * in the gateway's zone, and `--json`'s `wake`.
 */

const ZONE = 'Asia/Shanghai';
// 2025-10-09 14:02 in Shanghai.
const WOKE = Date.UTC(2025, 9, 9, 6, 2);
const SAME_DAY = Date.UTC(2025, 9, 9, 9, 0);
const NEXT_DAY = Date.UTC(2025, 9, 10, 9, 0);
const nameOf = (p: string): string | undefined => (p === ALICE ? 'Zhixi Sun' : undefined);

let h: TestDb;
beforeEach(() => {
  clearSecrets();
  h = testDb();
});
afterEach(() => h.close());

/** A task set by ALICE at `depth`, woken once at WOKE when `woken`. */
function view(depth: number, woken: boolean): TaskView {
  const task = newTask(h.db, { wake: { by: ALICE, depth } });
  if (woken) {
    const sub = subscriptionsOf(h.db, task.taskId)[0];
    const event = eventsOf(h.db, task.taskId).at(-1);
    const r = recordWake(
      h.db,
      {
        uuid: `u-${task.taskId}`,
        channel: 'lark',
        appId: 'cli_app',
        conversationId: 'oc_chat',
        threadId: '',
        principal: ALICE,
        depth,
        events: [{ subscriptionId: sub?.id ?? 0, eventId: event?.id ?? 0, taskId: task.taskId }],
      },
      NOW,
    );
    if (!r.ok) throw new Error(r.message);
    advanceWake(h.db, r.wake.wakeId, WOKE);
  }
  const v = taskView(h.db, task.taskId);
  if (v === undefined) throw new Error('no view');
  return v;
}

describe('wakeLine', () => {
  it('says on, by whom, at what depth, and when it last woke, in the zone', () => {
    const v = view(1, true);
    expect(v.lastWoke).toBe(WOKE);
    expect(wakeLine(v.task, v.lastWoke, { enabled: true, zone: ZONE, now: SAME_DAY }, 'Zhixi Sun')).toBe('Wake: on, set by Zhixi Sun, depth 1; last woke 14:02');
    expect(wakeLine(v.task, v.lastWoke, { enabled: true, zone: ZONE, now: NEXT_DAY }, 'Zhixi Sun')).toBe('Wake: on, set by Zhixi Sun, depth 1; last woke 10-09 14:02');
  });

  it('says on with no last wake before its first, off, and on but off on the gateway', () => {
    const v = view(0, false);
    expect(v.lastWoke).toBeUndefined();
    expect(wakeLine(v.task, v.lastWoke, { enabled: true, zone: ZONE, now: SAME_DAY }, 'Zhixi Sun')).toBe('Wake: on, set by Zhixi Sun, depth 0');
    expect(wakeLine(v.task, v.lastWoke, { enabled: false, zone: ZONE, now: SAME_DAY }, 'Zhixi Sun')).toBe(
      'Wake: on, set by Zhixi Sun, but wakes are off on this gateway',
    );
    setWake(h.db, v.task.taskId, { on: false }, ALICE, 'cli_app', NOW);
    const off = taskView(h.db, v.task.taskId);
    expect(off === undefined ? '' : wakeLine(off.task, off.lastWoke, { enabled: true, zone: ZONE, now: SAME_DAY }, '')).toBe('Wake: off');
  });
});

describe("task show's Wake line", () => {
  it('stands after the board line in chat, by chat name, and at the terminal, by principal', () => {
    const v = view(1, true);
    const opts = { enabled: true, zone: ZONE, now: SAME_DAY };
    expect(renderShow(v, [], 'default', nameOf, opts).split('\n')[2]).toBe('Wake: on, set by Zhixi Sun, depth 1; last woke 14:02');
    expect(showText(v, [], opts)[2]).toBe(`Wake: on, set by ${ALICE}, depth 1; last woke 14:02`);
    const plain = newTask(h.db);
    const pv = taskView(h.db, plain.taskId);
    if (pv === undefined) throw new Error('no view');
    expect(renderShow(pv, [], 'default', nameOf, opts).split('\n')[2]).toBe('Wake: off');
    expect(showText(pv, [], opts)[2]).toBe('Wake: off');
  });
});

describe('/kanban task show', () => {
  it("says the gateway's switch, as the chat is given it", async () => {
    const task = newTask(h.db, { wake: { by: ALICE, depth: 0 } });
    const service = new KanbanService({ db: h.db, roles: new Map(), workspaces: new Set(['default']) });
    const people = new PeopleDirectory({ db: h.db, appId: 'cli_app', canTalk: () => true });
    const chat = new KanbanChat({ service, hasTier: () => true, people, appId: 'cli_app', wake: { enabled: false, zone: ZONE } });
    const message: InboundMessage = {
      messageId: 'om_1',
      appId: 'cli_app',
      chatId: 'oc_chat',
      chatType: 'group',
      threadId: '',
      sender: { openId: 'ou_alice', unionId: 'on_alice', displayName: 'Zhixi Sun' },
      senderIsBot: false,
      text: '',
      mentionedBot: true,
      mentionAll: false,
      mentions: [],
      attachments: [],
      createTime: 0,
    };
    const r = await chat.run(`task show ${task.taskId}`, message, { channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: '' });
    expect(r.text.split('\n')[2]).toBe('Wake: on, set by Zhixi Sun, but wakes are off on this gateway');
  });
});

describe('mt kanban task show --json', () => {
  let fx: MtFixture;
  let db: Db;
  afterEach(() => {
    db.close();
    fx.cleanup();
  });

  it("gains the task's wake, with its last wake in milliseconds, or null", async () => {
    fx = mtFixture((ws) => [`workspace: ${ws}`, 'kanban:', '  enabled: true', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
    db = openDb(join(fx.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    const task = newTask(db, { wake: { by: ALICE, depth: 2 } });
    const plain = newTask(db);
    const shown = async (id: string) => JSON.parse((await fx.run(['kanban', 'task', 'show', id, '--json'])).out).task.wake as unknown;
    expect(await shown(task.taskId)).toEqual({ on: true, by: ALICE, depth: 2, last_woke: null });
    expect(await shown(plain.taskId)).toEqual({ on: false, by: null, depth: 0, last_woke: null });
    const r = await fx.run(['kanban', 'task', 'show', task.taskId]);
    expect(r.out.split('\n')[2]).toBe(`Wake: on, set by ${ALICE}, depth 2`);
  });
});
