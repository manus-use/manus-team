import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { advanceWake, createBoard, recordWake, wakeSubmitted } from '../src/db/kanban.js';
import { eventsOf, getTask } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn, endTurn, setTurnState } from '../src/db/turns.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * Setting a wake from an agent's shell (wake spec §3.2a, §9.1): in a shell with
 * `MT_AGENT_SESSION` and cron off, a wake is set only from a turn the board
 * woke, as its setter, in its own conversation, one level deeper; any other
 * agent shell makes tasks at depth 0, and sets no wake.
 */

let fx: MtFixture;
let db: Db;
let server: WorkerServer | undefined;
const SETTER = 'lark:on_kevin';
const OWNER = 'lark:on_owner';
const NONE = "a wake set from an agent's shell needs a turn the board woke, and session s_1 has none running";
const OWN = "a woken turn's tasks are followed by its own conversation: --chat oc_team --thread omt_topic";

afterEach(async () => {
  clearSecrets();
  await server?.close();
  server = undefined;
  db?.close();
  fx?.cleanup();
});

/**
 * A home with the board on and cron off; a task in thread omt_topic of oc_team,
 * and session s_1 bound to nothing in particular, its turn t_1 running. With
 * `woken`, that turn is a delivered wake of the task, by SETTER at depth 1.
 */
async function setup(woken: boolean): Promise<string> {
  clearSecrets();
  fx = mtFixture((ws) =>
    [`workspace: ${ws}`, 'lark:', '  appId: cli_app', 'kanban:', '  enabled: true', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
  );
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  notePerson(db, { appId: 'cli_app', unionId: 'on_owner', openId: 'ou_owner', name: 'Zhixi Sun' }, NOW);
  const via = { kind: 'chat' as const, channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' };
  const task = newTask(db, { createdVia: via, wake: { by: SETTER, depth: 1 } });
  createSession(db, { id: 's_1', agentId: 'default', workspaceId: 'default', ownerPrincipal: SETTER }, NOW);
  createTurn(db, { sessionId: 's_1', turnId: 't_1', generation: 0, idempotencyKey: 'key-1' }, NOW);
  setTurnState(db, 's_1', 't_1', 'running');
  if (woken) {
    const event = eventsOf(db, task.taskId).at(-1);
    const sub = db.prepare<[string], { id: number }>('SELECT id FROM kanban_subscriptions WHERE task_id = ?').get(task.taskId);
    const r = recordWake(
      db,
      {
        uuid: 'u-1',
        channel: 'lark',
        appId: 'cli_app',
        conversationId: 'oc_team',
        threadId: 'omt_topic',
        principal: SETTER,
        depth: 1,
        events: [{ subscriptionId: sub?.id ?? 0, eventId: event?.id ?? 0, taskId: task.taskId }],
      },
      NOW,
    );
    if (!r.ok) throw new Error(r.message);
    wakeSubmitted(db, r.wake.wakeId, 's_1', 'key-1', 'boot-1');
    advanceWake(db, r.wake.wakeId, NOW + 1);
  }
  mkdirSync(join(fx.home, 'workflows'));
  writeFileSync(
    join(fx.home, 'workflows', 'brief.yaml'),
    'steps:\n  a: { title: "Draft the brief", assignee: default }\n  b: { parents: [a], title: "Check the brief", assignee: default, wake: true }\n',
  );
  server = await listenWorker(workerSocketPath(fx.home), () => ({ ok: true }));
  return task.taskId;
}

const shell = (argv: string[], env: Record<string, string> = {}) =>
  fx.run(['kanban', ...argv], { env: { MT_OWNER_OPEN_ID: 'ou_owner', MT_AGENT_SESSION: 's_1', ...env } });
const json = async (argv: string[]) => JSON.parse((await shell([...argv, '--json'])).out) as Record<string, unknown>;
const count = () => (db.prepare('SELECT count(*) AS n FROM kanban_tasks').get() as { n: number }).n;
const made = (out: string) => /^created (k_[0-9a-z]+)/.exec(out)?.[1] ?? '';

describe('a woken turn\'s shell, cron off', () => {
  it('makes a task with --wake in its own conversation, as the wake\'s setter, one level deeper', async () => {
    await setup(true);
    const r = await shell(['task', 'new', 'Book the hall', '--chat', 'oc_team', '--thread', 'omt_topic', '--wake']);
    expect(r.code, r.err).toBe(0);
    expect(getTask(db, made(r.out))).toMatchObject({ wakeBy: SETTER, wakeDepth: 2 });
  });

  it('makes a task without a wake one level deeper too', async () => {
    await setup(true);
    expect(getTask(db, made((await shell(['task', 'new', 'Book the hall'])).out))).toMatchObject({ wakeBy: null, wakeDepth: 2 });
  });

  it('refuses --wake naming another chat, or another thread, and makes nothing', async () => {
    await setup(true);
    const before = count();
    for (const where of [['--chat', 'oc_other'], ['--chat', 'oc_team']]) {
      expect(await shell(['task', 'new', 'x', ...where, '--wake'])).toEqual({ code: 1, out: '', err: `mt: ${OWN}` });
    }
    expect(count()).toBe(before);
  });

  it('notes a task too deep, and makes it notice-only', async () => {
    const id = await setup(true);
    db.prepare('UPDATE kanban_wakes SET depth = 4').run();
    const r = await shell(['task', 'new', 'Book the hall', '--chat', 'oc_team', '--thread', 'omt_topic', '--wake']);
    expect(r.code, r.err).toBe(0);
    const made2 = made(r.out);
    expect(getTask(db, made2)).toMatchObject({ wakeBy: null, wakeDepth: 5 });
    expect(r.out.split('\n').at(-1)).toBe(`${made2} is 5 tasks deep in woken turns, so it stays notice-only`);
    expect(id).not.toBe(made2);
  });

  it('turns on the wake of a deeper task in its conversation as its setter, and refuses one not deeper, or elsewhere', async () => {
    const shallow = await setup(true);
    const deep = made((await shell(['task', 'new', 'Deeper', '--chat', 'oc_team', '--thread', 'omt_topic'])).out);
    expect(await shell(['task', 'wake', deep, 'on'])).toEqual({
      code: 0,
      out: `wake on for ${deep}: its outcomes start a turn in oc_team/omt_topic, as ${SETTER}, who set this woken turn's wake`,
      err: '',
    });
    expect(getTask(db, deep)?.wakeBy).toBe(SETTER);
    expect(await shell(['task', 'wake', shallow, 'on'])).toEqual({
      code: 1,
      out: '',
      err: `mt: \`${shallow}\` is not deeper than this woken turn (depth 1), so a woken turn cannot set its wake`,
    });
    const other = newTask(db, {
      createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_other', threadId: '' },
      wake: { by: null, depth: 3 },
    });
    expect(await shell(['task', 'wake', other.taskId, 'on'])).toEqual({ code: 1, out: '', err: `mt: ${OWN}` });
  });

  it('refuses a deeper task no chat follows, before any write', async () => {
    await setup(true);
    const alone = made((await shell(['task', 'new', 'Alone'])).out);
    const before = eventsOf(db, alone).length;
    expect(await shell(['task', 'wake', alone, 'on'])).toEqual({
      code: 1,
      out: '',
      err: `mt: a wake needs a chat that follows the task, and no chat follows ${alone}: a chat is chosen when a task is made`,
    });
    expect(eventsOf(db, alone)).toHaveLength(before);
  });

  it('refuses a task its own conversation follows when another chat follows it too', async () => {
    await setup(true);
    const deep = made((await shell(['task', 'new', 'Deeper', '--chat', 'oc_team', '--thread', 'omt_topic'])).out);
    db.prepare(
      `INSERT INTO kanban_subscriptions (task_id, channel, account_id, conversation_id, thread_id, created_at)
       VALUES (?, 'lark', 'cli_app', 'oc_other', '', ?)`,
    ).run(deep, NOW);
    expect(await shell(['task', 'wake', deep, 'on'])).toEqual({ code: 1, out: '', err: `mt: ${OWN}` });
    expect(getTask(db, deep)?.wakeBy).toBeNull();
  });

  it("starts a workflow with --wake in its own conversation as its setter, one level deeper", async () => {
    await setup(true);
    const r = await json(['workflow', 'start', 'brief', '--chat', 'oc_team', '--thread', 'omt_topic', '--wake']);
    expect((r['tasks'] as Array<{ task_id: string }>).map((t) => [getTask(db, t.task_id)?.wakeBy, getTask(db, t.task_id)?.wakeDepth])).toEqual([
      [SETTER, 2],
      [SETTER, 2],
    ]);
  });
});

describe("a woken turn's shell, and a file naming its board", () => {
  it('starts with no --board on the file\'s board, the wake of the step that asks for one set', async () => {
    await setup(true);
    createBoard(db, 'vi', SETTER, NOW);
    writeFileSync(
      join(fx.home, 'workflows', 'vi-brief.yaml'),
      'board: vi\nsteps:\n  a: { title: "Draft the brief", assignee: default }\n  b: { parents: [a], title: "Check the brief", assignee: default, wake: true }\n',
    );
    const r = await json(['workflow', 'start', 'vi-brief', '--chat', 'oc_team', '--thread', 'omt_topic']);
    expect(r['board']).toBe('vi');
    const [a, b] = (r['tasks'] as Array<{ task_id: string }>).map((t) => getTask(db, t.task_id));
    expect([a?.board, a?.wakeBy, b?.board, b?.wakeBy, b?.wakeDepth]).toEqual(['vi', null, 'vi', SETTER, 2]);
  });
});

describe('an agent shell with no woken turn, cron off', () => {
  it('refuses --wake, and task wake on', async () => {
    const id = await setup(false);
    expect(await shell(['task', 'new', 'x', '--chat', 'oc_team', '--thread', 'omt_topic', '--wake'])).toEqual({ code: 1, out: '', err: `mt: ${NONE}` });
    expect(await shell(['task', 'wake', id, 'on'])).toEqual({ code: 1, out: '', err: `mt: ${NONE}` });
  });

  it('makes a plain task as the operator, at depth 0', async () => {
    await setup(false);
    expect(getTask(db, made((await shell(['task', 'new', 'Book the hall'])).out))).toMatchObject({ wakeBy: null, wakeDepth: 0 });
  });

  it('refuses a start whose steps ask for a wake, and a DAG whose tasks do', async () => {
    await setup(false);
    const before = count();
    expect(await shell(['workflow', 'start', 'brief', '--chat', 'oc_team'])).toEqual({ code: 1, out: '', err: `mt: ${NONE}` });
    const file = join(fx.root, 'dag.json');
    writeFileSync(file, JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'A', wake: true }] }));
    expect(await shell(['workflow', 'apply', file, '--chat', 'oc_team'])).toEqual({ code: 1, out: '', err: `mt: ${NONE}` });
    expect(count()).toBe(before);
  });

  it('refuses a process left running after its woken turn ended', async () => {
    await setup(true);
    endTurn(db, 's_1', 't_1', 'completed', NOW + 2);
    expect(await shell(['task', 'new', 'x', '--chat', 'oc_team', '--thread', 'omt_topic', '--wake'])).toEqual({ code: 1, out: '', err: `mt: ${NONE}` });
  });

  it('never runs a wake as the owner', async () => {
    await setup(false);
    const r = await json(['task', 'new', 'x', '--chat', 'oc_team']);
    expect(r['wake']).toEqual({ on: false, by: null, depth: 0 });
    expect(OWNER).not.toBe(SETTER);
  });
});

describe('an agent shell with cron on', () => {
  it('refuses the operator\'s commands before their arguments, as today', async () => {
    await setup(true);
    const r = await shell(['task', 'new', 'x', '--wake'], { MT_CRON_TOKEN: 'tok' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('MT_CRON_TOKEN');
    expect(count()).toBe(1);
  });
});
