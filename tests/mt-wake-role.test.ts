import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { advanceWake, recordWake, wakeSubmitted } from '../src/db/kanban.js';
import { eventsOf, getTask } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn, setTurnState } from '../src/db/turns.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * A role as a wake's target at the terminal (wake spec §19.1): `--wake-role
 * <role>` on `task new` and `workflow start`, which implies `--wake`, and `mt
 * kanban task wake <task> <role>`, as the owner; in a woken turn's shell, as
 * its setter, who must have operate tier.
 */

let fx: MtFixture;
let db: Db;
let server: WorkerServer | undefined;
const OWNER = 'lark:on_owner';
const SETTER = 'lark:on_kevin';

afterEach(async () => {
  clearSecrets();
  await server?.close();
  server = undefined;
  db?.close();
  fx?.cleanup();
});

/** A home with the board on, the owner seen, a task in thread omt_topic of oc_team, and the workflow brief. */
async function setup(): Promise<string> {
  clearSecrets();
  fx = mtFixture((ws) =>
    [`workspace: ${ws}`, 'lark:', '  appId: cli_app', 'kanban:', '  enabled: true', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
  );
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  notePerson(db, { appId: 'cli_app', unionId: 'on_owner', openId: 'ou_owner', name: 'Zhixi Sun' }, NOW);
  const task = newTask(db, { createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' } });
  mkdirSync(join(fx.home, 'workflows'));
  writeFileSync(join(fx.home, 'workflows', 'brief.yaml'), 'steps:\n  a: { title: "Draft the brief", assignee: default }\n');
  server = await listenWorker(workerSocketPath(fx.home), () => ({ ok: true }));
  return task.taskId;
}

/** Session s_1's running turn t_1, a delivered wake of `taskId` by SETTER at depth 1. */
function woken(taskId: string): void {
  createSession(db, { id: 's_1', agentId: 'default', workspaceId: 'default', ownerPrincipal: SETTER }, NOW);
  createTurn(db, { sessionId: 's_1', turnId: 't_1', generation: 0, idempotencyKey: 'key-1' }, NOW);
  setTurnState(db, 's_1', 't_1', 'running');
  const event = eventsOf(db, taskId).at(-1);
  const sub = db.prepare<[string], { id: number }>('SELECT id FROM kanban_subscriptions WHERE task_id = ?').get(taskId);
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
      events: [{ subscriptionId: sub?.id ?? 0, eventId: event?.id ?? 0, taskId }],
    },
    NOW,
  );
  if (!r.ok) throw new Error(r.message);
  wakeSubmitted(db, r.wake.wakeId, 's_1', 'key-1', 'boot-1');
  advanceWake(db, r.wake.wakeId, NOW + 1);
}

const kanban = (argv: string[], env: Record<string, string> = {}) => fx.run(['kanban', ...argv], { env: { MT_OWNER_OPEN_ID: 'ou_owner', ...env } });
const created = (out: string): string => /^created (k_[0-9a-z]+)/.exec(out)?.[1] ?? '';

describe('--wake-role', () => {
  it('makes the task with wake on for the role, as the owner, without --wake, and says so', async () => {
    await setup();
    const r = await kanban(['task', 'new', 'Book the venue', '--chat', 'oc_team', '--wake-role', 'default']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('; its outcomes wake role default');
    expect(getTask(db, created(r.out))).toMatchObject({ wakeBy: OWNER, wakeRole: 'default' });
    const json = JSON.parse((await kanban(['task', 'new', 'Order food', '--chat', 'oc_team', '--wake-role', 'default', '--json'])).out);
    expect(json.wake).toEqual({ on: true, by: OWNER, depth: 0, role: 'default' });
  });

  it('refuses a role that is not configured, and makes nothing', async () => {
    await setup();
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--wake-role', 'nobody'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: role "nobody" is not configured',
    });
    expect((db.prepare('SELECT count(*) AS n FROM kanban_tasks').get() as { n: number }).n).toBe(1);
  });

  it('turns it on for every member of a start', async () => {
    await setup();
    const r = JSON.parse((await kanban(['workflow', 'start', 'brief', '--chat', 'oc_team', '--wake-role', 'default', '--json'])).out);
    expect(r.ok).toBe(true);
    const ids = (r.tasks as Array<{ task_id: string }>).map((t) => t.task_id);
    expect(ids.map((id) => getTask(db, id)?.wakeRole)).toEqual(['default']);
  });
});

describe('mt kanban task wake <task> <role>', () => {
  it('targets the role as the owner, names where, and switches back with on', async () => {
    const id = await setup();
    expect(await kanban(['task', 'wake', id, 'default'])).toEqual({
      code: 0,
      out: `wake on for ${id}: its outcomes make a task for role default in oc_team/omt_topic, as ${OWNER} (the owner)`,
      err: '',
    });
    expect(getTask(db, id)).toMatchObject({ wakeBy: OWNER, wakeRole: 'default' });
    expect(JSON.parse((await kanban(['task', 'wake', id, 'default', '--json'])).out)).toEqual({
      ok: true,
      task_id: id,
      wake: { on: true, by: OWNER, depth: 0, role: 'default' },
    });
    expect((await kanban(['task', 'wake', id, 'on'])).out).toContain('its outcomes start a turn');
    expect(getTask(db, id)).toMatchObject({ wakeBy: OWNER, wakeRole: null });
  });
});

describe("a woken turn's shell naming a role", () => {
  it("refuses it when the wake's setter does not have operate tier, and takes it when they do", async () => {
    const id = await setup();
    woken(id);
    const deeper = newTask(db, {
      createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' },
      wake: { by: null, depth: 2 },
    });
    const refusal = `a role as a wake's target gives the role work, which needs operate tier, and ${SETTER}, who set this woken turn's wake, does not have it`;
    const shell = { MT_AGENT_SESSION: 's_1' };
    expect(await kanban(['task', 'wake', deeper.taskId, 'default'], shell)).toEqual({ code: 1, out: '', err: `mt: ${refusal}` });
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--thread', 'omt_topic', '--wake-role', 'default'], shell)).toEqual({
      code: 1,
      out: '',
      err: `mt: ${refusal}`,
    });
    notePerson(db, { appId: 'cli_app', unionId: 'on_kevin', openId: 'ou_kevin', name: 'Kevin Tu' }, NOW);
    const operator = { ...shell, MT_ALLOW_TALK: 'ou_kevin', MT_ALLOW_OPERATE: 'ou_kevin' };
    const r = await kanban(['task', 'wake', deeper.taskId, 'default'], operator);
    expect(r.code, r.err).toBe(0);
    expect(getTask(db, deeper.taskId)).toMatchObject({ wakeBy: SETTER, wakeRole: 'default' });
  });

  it("refuses a start or an apply whose step names a role when the wake's setter does not have operate tier, and takes it when they do", async () => {
    const id = await setup();
    woken(id);
    writeFileSync(join(fx.home, 'workflows', 'react.yaml'), 'steps:\n  a: { title: "Draft the brief", assignee: default, wake: { role: default } }\n');
    const file = join(fx.home, 'react.json');
    writeFileSync(file, JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'A', wake: { role: 'default' } }] }));
    const refusal = `a role as a wake's target gives the role work, which needs operate tier, and ${SETTER}, who set this woken turn's wake, does not have it`;
    const shell = { MT_AGENT_SESSION: 's_1' };
    const at = ['--chat', 'oc_team', '--thread', 'omt_topic'];
    expect(await kanban(['workflow', 'start', 'react', ...at], shell)).toEqual({ code: 1, out: '', err: `mt: ${refusal}` });
    expect(await kanban(['workflow', 'apply', file, ...at], shell)).toEqual({ code: 1, out: '', err: `mt: ${refusal}` });
    notePerson(db, { appId: 'cli_app', unionId: 'on_kevin', openId: 'ou_kevin', name: 'Kevin Tu' }, NOW);
    const operator = { ...shell, MT_ALLOW_TALK: 'ou_kevin', MT_ALLOW_OPERATE: 'ou_kevin' };
    const started = await kanban(['workflow', 'start', 'react', ...at], operator);
    expect(started.code, started.err).toBe(0);
    const applied = await kanban(['workflow', 'apply', file, ...at], operator);
    expect(applied.code, applied.err).toBe(0);
  });
});
