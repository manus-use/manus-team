import { mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eventsOf, getTask } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * Wake at the terminal (wake spec §3.1, §3.2, §3.4): `--wake` on `mt kanban task
 * new` and `workflow start`, a DAG's `"wake": true` on `workflow apply`, and `mt
 * kanban task wake <task> on|off`, each run as the owner, found in `people` by
 * the owner's open_id, and set by the terminal's operator.
 */

let fx: MtFixture;
let db: Db;
let server: WorkerServer | undefined;
const ME = `operator:${userInfo().username}`;
const OWNER = 'lark:on_owner';
const WAKES_OFF =
  'wakes are off on this gateway: an operator turns them on with kanban.wake.enabled: true in config.yaml, and a restart';
const UNSEEN =
  'a wake set from the terminal runs as the owner, whom this gateway has not seen yet: the owner is known once they have used /kanban in Lark';
const NO_APP_ID =
  'a wake set from the terminal runs as the owner, who cannot be checked for talk tier here: this shell finds no lark.appId or LARK_APP_ID, which the people this bot has seen are kept by';
const NO_OWNER =
  'a wake set from the terminal runs as the owner, who cannot be checked for talk tier here: this shell finds no auth.owner or MT_OWNER_OPEN_ID, without which there is no talk allowlist to check against';

afterEach(async () => {
  clearSecrets();
  await server?.close();
  server = undefined;
  db?.close();
  fx?.cleanup();
});

/** A home with an app id and an owner, the board on, the owner seen by the bot, and a thread omt_topic in oc_team. */
async function setup(opts: { lines?: string[]; seen?: boolean } = {}): Promise<string> {
  clearSecrets();
  const lines = opts.lines ?? ['lark:', '  appId: cli_app', 'kanban:', '  enabled: true'];
  fx = mtFixture((ws) => [`workspace: ${ws}`, ...lines, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  if (opts.seen !== false) notePerson(db, { appId: 'cli_app', unionId: 'on_owner', openId: 'ou_owner', name: 'Zhixi Sun' }, NOW);
  const threaded = newTask(db, { createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' } });
  mkdirSync(join(fx.home, 'workflows'));
  writeFileSync(
    join(fx.home, 'workflows', 'brief.yaml'),
    'steps:\n  a: { title: "Draft the brief", assignee: default }\n  b: { parents: [a], title: "Check the brief", assignee: default, wake: true }\n',
  );
  server = await listenWorker(workerSocketPath(fx.home), () => ({ ok: true }));
  return threaded.taskId;
}

const kanban = (argv: string[]) => fx.run(['kanban', ...argv], { env: { MT_OWNER_OPEN_ID: 'ou_owner' } });
const count = () => (db.prepare('SELECT count(*) AS n FROM kanban_tasks').get() as { n: number }).n;

describe('mt kanban task new --wake', () => {
  it('makes the task with wake on, as the owner, set by the operator, and says so', async () => {
    await setup();
    const r = await kanban(['task', 'new', 'Book the venue', '--assignee', 'default', '--chat', 'oc_team', '--wake']);
    expect(r.code, r.err).toBe(0);
    const id = /^created (k_[0-9a-z]+): /.exec(r.out)?.[1] ?? '';
    expect(r.out).toBe(`created ${id}: Book the venue, for role default, on board default; chat oc_team follows it; its outcomes wake the agent`);
    expect(getTask(db, id)).toMatchObject({ wakeBy: OWNER, wakeDepth: 0 });
    expect(eventsOf(db, id).find((e) => e.kind === 'wake_set')).toMatchObject({ actor: ME, payload: { on: true, as: OWNER, depth: 0 } });
    const json = JSON.parse((await kanban(['task', 'new', 'Order food', '--chat', 'oc_team', '--wake', '--json'])).out);
    expect(json).toMatchObject({ ok: true, existing: false, wake: { on: true, by: OWNER, depth: 0 } });
    expect(JSON.parse((await kanban(['task', 'new', 'Alone', '--json'])).out).wake).toEqual({ on: false, by: null, depth: 0 });
  });

  it('refuses --wake with no --chat, and makes nothing', async () => {
    await setup();
    const before = count();
    expect(await kanban(['task', 'new', 'x', '--wake'])).toEqual({ code: 1, out: '', err: 'mt: a wake needs a chat that follows the task: add --chat' });
    expect(count()).toBe(before);
  });

  it('refuses an owner this gateway has not seen', async () => {
    await setup({ seen: false });
    const before = count();
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--wake'])).toEqual({ code: 1, out: '', err: `mt: ${UNSEEN}` });
    expect(count()).toBe(before);
  });

  it('refuses --wake while wakes are off', async () => {
    await setup({ lines: ['lark:', '  appId: cli_app', 'kanban:', '  enabled: true', '  wake:', '    enabled: false'] });
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--wake'])).toEqual({ code: 1, out: '', err: `mt: ${WAKES_OFF}` });
    expect(JSON.parse((await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--wake', '--json'])).out)).toEqual({ ok: false, code: 'wake_off', message: WAKES_OFF });
  });
});

describe('mt kanban task wake', () => {
  it('turns wake on as the owner, naming where it wakes, and off', async () => {
    const id = await setup();
    expect(await kanban(['task', 'wake', id, 'on'])).toEqual({
      code: 0,
      out: `wake on for ${id}: its outcomes start a turn in oc_team/omt_topic, as ${OWNER} (the owner)`,
      err: '',
    });
    expect(getTask(db, id)?.wakeBy).toBe(OWNER);
    expect(eventsOf(db, id).filter((e) => e.kind === 'wake_set').at(-1)).toMatchObject({ actor: ME });
    expect(JSON.parse((await kanban(['task', 'wake', id, 'on', '--json'])).out)).toEqual({ ok: true, task_id: id, wake: { on: true, by: OWNER, depth: 0 } });
    expect(await kanban(['task', 'wake', id, 'off'])).toEqual({ code: 0, out: `wake off for ${id}`, err: '' });
    expect(JSON.parse((await kanban(['task', 'wake', id, 'off', '--json'])).out)).toEqual({ ok: true, task_id: id, wake: { on: false, by: null, depth: 0 } });
  });

  it('names a chat-scope task by its chat alone', async () => {
    await setup();
    const id = /^created (k_[0-9a-z]+)/.exec((await kanban(['task', 'new', 'x', '--chat', 'oc_team'])).out)?.[1] ?? '';
    expect((await kanban(['task', 'wake', id, 'on'])).out).toBe(`wake on for ${id}: its outcomes start a turn in oc_team, as ${OWNER} (the owner)`);
  });

  it('refuses a task no chat follows, and a task too deep is a note', async () => {
    await setup();
    const alone = newTask(db, { createdVia: { kind: 'operator' } });
    expect(await kanban(['task', 'wake', alone.taskId, 'on'])).toEqual({
      code: 1,
      out: '',
      err: `mt: a wake needs a chat that follows the task, and no chat follows ${alone.taskId}: a chat is chosen when a task is made`,
    });
    const deep = newTask(db, { wake: { by: null, depth: 5 } });
    expect(await kanban(['task', 'wake', deep.taskId, 'on'])).toEqual({ code: 0, out: `${deep.taskId} is 5 tasks deep in woken turns, so it stays notice-only`, err: '' });
    expect(getTask(db, deep.taskId)?.wakeBy).toBeNull();
  });

  it('refuses an owner not seen for on, and turns it off all the same', async () => {
    const id = await setup({ seen: false });
    expect(await kanban(['task', 'wake', id, 'on'])).toEqual({ code: 1, out: '', err: `mt: ${UNSEEN}` });
    expect((await kanban(['task', 'wake', id, 'off'])).code).toBe(0);
  });

  it('keeps a wake already on past a max_depth lowered since, and says it stays on, as its setter', async () => {
    await setup();
    const kept = newTask(db, {
      createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' },
      wake: { by: 'lark:on_kevin', depth: 5 },
    });
    expect(await kanban(['task', 'wake', kept.taskId, 'on'])).toEqual({
      code: 0,
      out: `wake stays on for ${kept.taskId}, run as lark:on_kevin: it is 5 tasks deep, so it cannot be set again`,
      err: '',
    });
    expect(getTask(db, kept.taskId)?.wakeBy).toBe('lark:on_kevin');
  });

  it('refuses on with no app id, naming the setting this shell lacks', async () => {
    const id = await setup({ lines: ['kanban:', '  enabled: true'] });
    expect(await kanban(['task', 'wake', id, 'on'])).toEqual({ code: 1, out: '', err: `mt: ${NO_APP_ID}` });
  });

  it('refuses on with no owner, naming the setting this shell lacks', async () => {
    const id = await setup();
    expect(await fx.run(['kanban', 'task', 'wake', id, 'on'], { env: {} })).toEqual({ code: 1, out: '', err: `mt: ${NO_OWNER}` });
  });

  it('takes on or off, and nothing else', async () => {
    const id = await setup();
    for (const argv of [['task', 'wake', id], ['task', 'wake', id, 'maybe'], ['task', 'wake', id, 'on', 'now']]) {
      const r = await kanban(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err.split('\n')[0]).toBe('mt: kanban task wake takes a task id, and on or off');
    }
  });
});

describe('a workflow at the terminal', () => {
  it('turns wake on for every member with --wake, as the owner', async () => {
    await setup();
    const r = JSON.parse((await kanban(['workflow', 'start', 'brief', '--chat', 'oc_team', '--wake', '--json'])).out);
    expect(r.ok).toBe(true);
    const ids = (r.tasks as Array<{ task_id: string }>).map((t) => t.task_id);
    expect(ids.map((id) => getTask(db, id)?.wakeBy)).toEqual([OWNER, OWNER]);
  });

  it('turns it on for the steps that ask without --wake, and refuses --wake with no --chat', async () => {
    await setup();
    const r = JSON.parse((await kanban(['workflow', 'start', 'brief', '--chat', 'oc_team', '--json'])).out);
    expect((r.tasks as Array<{ task_id: string }>).map((t) => getTask(db, t.task_id)?.wakeBy)).toEqual([null, OWNER]);
    expect(await kanban(['workflow', 'start', 'brief', '--wake'])).toEqual({ code: 1, out: '', err: 'mt: a wake needs a chat that follows the task: add --chat' });
  });

  it("ends a start whose steps ask for a wake with the note while wakes are off", async () => {
    await setup({ lines: ['lark:', '  appId: cli_app', 'kanban:', '  enabled: true', '  wake:', '    enabled: false'] });
    const r = await kanban(['workflow', 'start', 'brief', '--chat', 'oc_team']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n').at(-1)).toBe('wakes are off on this gateway (kanban.wake.enabled), so the steps that ask for one are notice-only');
    expect(JSON.parse((await kanban(['workflow', 'start', 'brief', '--chat', 'oc_team', '--key', 'k2', '--json'])).out).wake_note).toBe(
      'wakes are off on this gateway (kanban.wake.enabled), so the steps that ask for one are notice-only',
    );
  });

  it("ends a start with no --chat whose steps ask for the chat session's wake with its note, those members notice-only", async () => {
    await setup();
    const r = await kanban(['workflow', 'start', 'brief', '--json']);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect((j.tasks as Array<{ task_id: string }>).map((t) => getTask(db, t.task_id)?.wakeBy)).toEqual([null, null]);
    expect(j.wake_note).toBe('no chat follows this start (add --chat), so the steps that wake the chat session are notice-only');
  });

  it('ends a start whose steps ask for a wake with one note when the owner is not yet known, those members notice-only', async () => {
    await setup({ seen: false });
    const r = await kanban(['workflow', 'start', 'brief', '--chat', 'oc_team']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n').at(-1)).toBe('the owner has not used /kanban in Lark yet, so the steps that ask for a wake are notice-only');
    const file = join(fx.root, 'dag.json');
    writeFileSync(file, JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'A', wake: true }] }));
    const j = JSON.parse((await kanban(['workflow', 'apply', file, '--chat', 'oc_team', '--json'])).out);
    expect((j.tasks as Array<{ task_id: string }>).map((t) => getTask(db, t.task_id)?.wakeBy)).toEqual([null]);
    expect(j.wake_note).toBe('the owner has not used /kanban in Lark yet, so the steps that ask for a wake are notice-only');
  });

  it("ends a start whose steps ask for a wake with the setting the shell lacks when it cannot name the owner, those members notice-only", async () => {
    await setup();
    const r = await fx.run(['kanban', 'workflow', 'start', 'brief', '--chat', 'oc_team', '--json'], { env: {} });
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect((j.tasks as Array<{ task_id: string }>).map((t) => getTask(db, t.task_id)?.wakeBy)).toEqual([null, null]);
    expect(j.wake_note).toBe(`${NO_OWNER}, so the steps that ask for a wake are notice-only`);
  });

  it('says the owner note alone when the owner is not yet known and no chat follows the start', async () => {
    await setup({ seen: false });
    const r = await kanban(['workflow', 'start', 'brief', '--json']);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect((j.tasks as Array<{ task_id: string }>).map((t) => getTask(db, t.task_id)?.wakeBy)).toEqual([null, null]);
    expect(j.wake_note).toBe('the owner has not used /kanban in Lark yet, so the steps that ask for a wake are notice-only');
  });

  it("applies a DAG's \"wake\": true as the owner", async () => {
    await setup();
    const file = join(fx.root, 'dag.json');
    writeFileSync(file, JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'A', wake: true }, { ref: 'b', title: 'B' }] }));
    const r = JSON.parse((await kanban(['workflow', 'apply', file, '--chat', 'oc_team', '--json'])).out);
    expect((r.tasks as Array<{ task_id: string }>).map((t) => getTask(db, t.task_id)?.wakeBy)).toEqual([OWNER, null]);
  });
});
