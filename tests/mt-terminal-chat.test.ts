import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eventsOf, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `--chat oc_… [--thread omt_…]` on `mt kanban task new`, `workflow start` and
 * `workflow apply` (kanban spec §22.1, workflows spec §18.1): the shapes, the
 * app id and auth.chats checked before the board is opened, a repeat by key
 * included; then the key; then, for what is not made yet, the thread's root.
 * The answer says who follows, a repeat its stored subscription.
 */

let fx: MtFixture;
let db: Db;
let server: WorkerServer | undefined;

afterEach(async () => {
  clearSecrets();
  await server?.close();
  server = undefined;
  db?.close();
  fx?.cleanup();
});

/** A home with an app id, the board on and a gateway taking nudges; a thread omt_topic in oc_team whose root a chat's task recorded. */
async function setup(lines: string[] = ['lark:', '  appId: cli_app', 'kanban:', '  enabled: true']): Promise<void> {
  clearSecrets();
  fx = mtFixture((ws) => [`workspace: ${ws}`, ...lines, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  newTask(db, { createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: 'omt_topic', rootId: 'om_root' } });
  mkdirSync(join(fx.home, 'workflows'));
  writeFileSync(
    join(fx.home, 'workflows', 'brief.yaml'),
    'params:\n  topic: { required: true }\nsteps:\n  a: { title: "Brief on {{topic}}", assignee: default }\n  b: { parents: [a], title: "Check the brief on {{topic}}", assignee: default }\n',
  );
  server = await listenWorker(workerSocketPath(fx.home), () => ({ ok: true }));
}

const kanban = (argv: string[], env: Record<string, string | undefined> = {}) => fx.run(['kanban', ...argv], { env });
const subs = (taskId: string) => subscriptionsOf(db, taskId).map((s) => [s.channel, s.appId, s.conversationId, s.threadId, s.rootMessageId]);
const OUTSIDE = 'oc_team is not in auth.chats, so this gateway does not act in it: add it there, or name a chat that is';

describe('mt kanban task new --chat', () => {
  it('follows the new task from the chat, and says so', async () => {
    await setup();
    const r = await kanban(['task', 'new', 'Book the venue', '--assignee', 'default', '--chat', 'oc_team']);
    expect(r.code, r.err).toBe(0);
    const id = /^created (k_[0-9a-z]+): /.exec(r.out)?.[1] ?? '';
    expect(r.out).toBe(`created ${id}: Book the venue, for role default, on board default; chat oc_team follows it`);
    expect(subs(id)).toEqual([['lark', 'cli_app', 'oc_team', '', null]]);
    expect(eventsOf(db, id).map((e) => e.kind)).toEqual(['created', 'task_created_followed']);
    const json = JSON.parse((await kanban(['task', 'new', 'Order food', '--chat', 'oc_team', '--json'])).out);
    expect(json).toMatchObject({ ok: true, existing: false, follows: { chat: 'oc_team', thread: null } });
    expect(JSON.parse((await kanban(['task', 'new', 'Alone', '--json'])).out)).toMatchObject({ ok: true, follows: null });
  });

  it("follows in a thread with the root the board knows, and refuses a thread it has none for", async () => {
    await setup();
    const r = await kanban(['task', 'new', 'Book the venue', '--chat', 'oc_team', '--thread', 'omt_topic', '--json']);
    const id = JSON.parse(r.out).task_id as string;
    expect(JSON.parse(r.out)).toMatchObject({ follows: { chat: 'oc_team', thread: 'omt_topic' } });
    expect(subs(id)).toEqual([['lark', 'cli_app', 'oc_team', 'omt_topic', 'om_root']]);
    expect((await kanban(['task', 'new', 'Again', '--chat', 'oc_team', '--thread', 'omt_topic'])).out).toMatch(/; chat oc_team follows it, in thread omt_topic$/);
    const before = db.prepare('SELECT count(*) AS n FROM kanban_tasks').get();
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--thread', 'omt_other'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: no root is known for thread omt_other in oc_team: the board learns a thread\'s root when a task is made in it from chat; give --chat alone to follow from the chat',
    });
    expect(db.prepare('SELECT count(*) AS n FROM kanban_tasks').get()).toEqual(before);
  });

  it('refuses a malformed chat or thread, and --thread without --chat, as a wrong command line', async () => {
    await setup();
    const usage = async (argv: string[]) => {
      const r = await kanban(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      return r.err.split('\n')[0];
    };
    expect(await usage(['task', 'new', 'x', '--chat', 'team'])).toBe('mt: --chat takes a chat id as Lark gives one, oc_…, not "team"');
    expect(await usage(['task', 'new', 'x', '--chat', 'oc_team', '--thread', 'topic'])).toBe('mt: --thread takes a thread id as Lark gives one, omt_…, not "topic"');
    expect(await usage(['task', 'new', 'x', '--thread', 'omt_topic'])).toBe('mt: --thread needs --chat: it names a thread of that chat');
  });

  it('refuses before the board is opened with no app id, or a chat outside a non-empty auth.chats; any chat with an empty one', async () => {
    await setup(['kanban:', '  enabled: true']);
    const nowhere = { MT_DB: join(fx.root, 'none.db') };
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team'], nowhere)).toEqual({ code: 1, out: '', err: 'mt: --chat needs the bot: set lark.appId in the config file, or LARK_APP_ID' });
    const app = { ...nowhere, LARK_APP_ID: 'cli_app', MT_ALLOW_CHATS: 'oc_other' };
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team'], app)).toEqual({ code: 1, out: '', err: `mt: ${OUTSIDE}` });
    expect(JSON.parse((await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--json'], app)).out)).toEqual({ ok: false, code: 'invalid', message: OUTSIDE });
    expect((await kanban(['task', 'new', 'x', '--chat', 'oc_team'], { ...app, MT_DB: undefined, MT_ALLOW_CHATS: 'oc_team,oc_other' })).code).toBe(0);
    expect((await kanban(['task', 'new', 'x', '--chat', 'oc_anywhere'], { LARK_APP_ID: 'cli_app' })).code).toBe(0);
  });

  it('answers a repeat by key with the first task and its stored chat, adding nothing, and refuses one whose chat has left auth.chats', async () => {
    await setup();
    const first = JSON.parse((await kanban(['task', 'new', 'Weekly', '--chat', 'oc_team', '--thread', 'omt_topic', '--key', 'w47', '--json'])).out);
    // The thread's root is lost: a repeat is answered all the same, as the root is looked up only for a task not yet made.
    db.prepare('UPDATE kanban_subscriptions SET root_message_id = NULL').run();
    const again = await kanban(['task', 'new', 'Weekly', '--chat', 'oc_other', '--thread', 'omt_topic', '--key', 'w47', '--json']);
    expect(JSON.parse(again.out)).toEqual({ ok: true, task_id: first.task_id, board: 'default', existing: true, nudged: false, follows: { chat: 'oc_team', thread: 'omt_topic' } });
    expect((await kanban(['task', 'new', 'Weekly', '--key', 'w47'])).out).toMatch(/; nothing new was created; chat oc_team follows it, in thread omt_topic$/);
    expect(subscriptionsOf(db, first.task_id)).toHaveLength(1);
    expect(eventsOf(db, first.task_id).filter((e) => e.kind === 'task_created_followed')).toHaveLength(1);
    expect((await kanban(['task', 'new', 'Weekly', '--chat', 'oc_team', '--key', 'w47'], { MT_ALLOW_CHATS: 'oc_other' })).err).toBe(`mt: ${OUTSIDE}`);
    const plain = JSON.parse((await kanban(['task', 'new', 'Plain', '--key', 'p1', '--json'])).out);
    expect(JSON.parse((await kanban(['task', 'new', 'Plain', '--key', 'p1', '--json'])).out)).toMatchObject({ task_id: plain.task_id, existing: true, follows: null });
  });

  it('writes the subscription and its event with the board off, and is refused in an agent\'s shell', async () => {
    await setup(['lark:', '  appId: cli_app']);
    const r = await kanban(['task', 'new', 'x', '--chat', 'oc_team', '--json']);
    expect(r.err).toMatch(/^mt: the board is off on this gateway/);
    expect(subs(JSON.parse(r.out).task_id)).toHaveLength(1);
    expect(await kanban(['task', 'new', 'x', '--chat', 'oc_team'], { MT_KANBAN_RUN: 'r_1' })).toMatchObject({ code: 1, err: expect.stringMatching(/is an operator's command, not an agent's/) });
  });
});

describe('mt kanban workflow start and apply --chat', () => {
  it('follows every member and says the chat is sent the reply; a repeat its stored chat', async () => {
    await setup();
    const r = await kanban(['workflow', 'start', 'brief', '--param', 'topic=logs', '--chat', 'oc_team', '--key', 'b1']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n').at(-1)).toBe("chat oc_team follows its tasks, and is sent the start's reply");
    const json = JSON.parse((await kanban(['workflow', 'start', 'brief', '--param', 'topic=logs', '--chat', 'oc_other', '--key', 'b1', '--json'])).out);
    expect(json).toMatchObject({ ok: true, existing: true, follows: { chat: 'oc_team', thread: null } });
    for (const t of json.tasks as Array<{ task_id: string }>) expect(subs(t.task_id)).toEqual([['lark', 'cli_app', 'oc_team', '', null]]);
    expect((await kanban(['workflow', 'start', 'brief', '--param', 'topic=logs', '--key', 'b1'])).out.split('\n').at(-1)).toBe('chat oc_team follows its tasks');
    const none = JSON.parse((await kanban(['workflow', 'start', 'brief', '--param', 'topic=db', '--json'])).out);
    expect(none.follows).toBeNull();
  });

  it('applies with a thread, refuses a thread with no root, and checks before the board is opened', async () => {
    await setup();
    const file = join(fx.root, 'dag.json');
    writeFileSync(file, JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'default' }] }));
    const r = JSON.parse((await kanban(['workflow', 'apply', file, '--chat', 'oc_team', '--thread', 'omt_topic', '--json'])).out);
    expect(r).toMatchObject({ ok: true, existing: false, follows: { chat: 'oc_team', thread: 'omt_topic' } });
    expect(subs(r.tasks[0].task_id)).toEqual([['lark', 'cli_app', 'oc_team', 'omt_topic', 'om_root']]);
    expect((await kanban(['workflow', 'apply', file, '--chat', 'oc_team', '--thread', 'omt_lost'])).err).toMatch(/^mt: no root is known for thread omt_lost in oc_team/);
    expect(await kanban(['workflow', 'start', 'brief', '--param', 'topic=x', '--chat', 'oc_team'], { MT_ALLOW_CHATS: 'oc_other', MT_DB: join(fx.root, 'none.db') })).toEqual({ code: 1, out: '', err: `mt: ${OUTSIDE}` });
    expect((await kanban(['workflow', 'apply', file, '--chat', 'nope'])).code).toBe(2);
  });

  it('dry-runs with the flags, writing nothing and saying who would follow; refuses them on a preview', async () => {
    await setup();
    const file = join(fx.root, 'dag.json');
    writeFileSync(file, JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'default' }] }));
    const count = () => db.prepare('SELECT count(*) AS n FROM kanban_subscriptions').get();
    const before = count();
    const dry = await kanban(['workflow', 'apply', file, '--dry-run', '--chat', 'oc_team']);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out.split('\n').at(-1)).toBe("chat oc_team would follow its tasks, and be sent the start's reply");
    expect(JSON.parse((await kanban(['workflow', 'apply', file, '--dry-run', '--chat', 'oc_team', '--json'])).out)).toMatchObject({ dry_run: true, follows: { chat: 'oc_team', thread: null } });
    expect((await kanban(['workflow', 'apply', file, '--dry-run', '--chat', 'oc_team', '--thread', 'omt_lost'])).err).toMatch(/^mt: no root is known/);
    expect(count()).toEqual(before);
    for (const flags of [['--chat', 'oc_team'], ['--thread', 'omt_topic']]) {
      const r = await kanban(['workflow', 'preview', 'brief', '--param', 'topic=x', ...flags]);
      expect(r.code).toBe(2);
      expect(r.err.split('\n')[0]).toBe("mt: --chat is start's and apply's: a preview makes nothing to follow");
    }
  });
});
