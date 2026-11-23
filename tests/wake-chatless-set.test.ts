import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addComment, createTask, setWake } from '../src/db/kanban.js';
import { eventsOf, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, claimed, newTask } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * A role's wake with no chat (wake spec §19.16): it keeps its wake, read
 * through the task's own `wake_cursor`, which `setWake` sets to the task's
 * latest event; the terminal's `--wake-role` and `task wake <id> <role>` need
 * no `--chat`, nor a step's `wake: { role }`; the chat session's wake without
 * a chat stays refused, or notice-only for a start's steps; a chatless task's
 * follow-ups inherit it.
 */

const APP = 'cli_app';
const OWNER = 'lark:on_owner';
const OPERATOR = { kind: 'operator' } as const;

describe('setWake for a role, with no chat', () => {
  let h: TestDb;
  afterEach(() => h.close());

  it("keeps it, and sets the task's own cursor to its wake_set", () => {
    h = testDb();
    const task = newTask(h.db, { createdVia: OPERATOR });
    expect(subscriptionsOf(h.db, task.taskId)).toEqual([]);
    const r = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'worker' }, 'operator:x', APP, NOW + 1);
    expect(r).toMatchObject({ ok: true, changed: true, task: { wakeBy: ALICE, wakeRole: 'worker' } });
    const set = eventsOf(h.db, task.taskId).at(-1);
    expect(set?.kind).toBe('wake_set');
    expect(getTask(h.db, task.taskId)?.wakeCursor).toBe(set?.id);
  });

  it("still refuses the chat session's wake with no chat", () => {
    h = testDb();
    const task = newTask(h.db, { createdVia: OPERATOR });
    expect(setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5 }, 'operator:x', APP, NOW)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('makes a task with one at its latest event, and gives its follow-ups the same wake, with no chat either', () => {
    h = testDb();
    const parent = newTask(h.db, { createdVia: OPERATOR, wake: { by: ALICE, depth: 1, role: 'worker' } });
    expect(parent).toMatchObject({ wakeBy: ALICE, wakeRole: 'worker', wakeCursor: eventsOf(h.db, parent.taskId).at(-1)?.id });
    const run = claimed(h.db, parent.taskId);
    const r = createTask(h.db, { title: 'a follow-up', createdBy: `run:${run.runId}`, createdVia: { kind: 'run', runId: run.runId } }, NOW + 1);
    if (!r.ok) throw new Error(r.message);
    expect(r.task).toMatchObject({ wakeBy: ALICE, wakeRole: 'worker', wakeDepth: 1, wakeCursor: eventsOf(h.db, r.task.taskId).at(-1)?.id });
    expect(subscriptionsOf(h.db, r.task.taskId)).toEqual([]);
  });

  it("sets the task's own cursor beside its subscriptions', so a task followed only by another app's chat replays nothing", () => {
    h = testDb();
    const other = { kind: 'chat', channel: 'lark', appId: 'cli_other', conversationId: 'oc_x', threadId: '' } as const;
    const task = newTask(h.db, { createdVia: other });
    const comment = addComment(h.db, task.taskId, ALICE, 'an earlier event', NOW, false);
    if (!comment.ok) throw new Error(comment.message);
    const r = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'worker' }, 'operator:x', APP, NOW + 1);
    expect(r).toMatchObject({ ok: true, changed: true });
    const latest = eventsOf(h.db, task.taskId).at(-1)?.id ?? 0;
    expect(getTask(h.db, task.taskId)?.wakeCursor).toBe(latest);
    // The other app's chat keeps its own cursor; this bot reads the task as chatless, from its latest event.
    expect(subscriptionsOf(h.db, task.taskId).map((s) => s.appId)).toEqual(['cli_other']);
    const made = newTask(h.db, { createdVia: { ...other, conversationId: 'oc_y' }, wake: { by: ALICE, depth: 0, role: 'worker' } });
    expect(made.wakeCursor).toBe(eventsOf(h.db, made.taskId).at(-1)?.id);
    expect(made.wakeCursor).toBeGreaterThan(0);
  });
});

describe('the terminal, with no --chat', () => {
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

  async function setup(opts: { seen?: boolean } = {}): Promise<void> {
    clearSecrets();
    fx = mtFixture((ws) =>
      [`workspace: ${ws}`, 'lark:', '  appId: cli_app', 'kanban:', '  enabled: true', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
    );
    db = openDb(join(fx.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    if (opts.seen !== false) notePerson(db, { appId: APP, unionId: 'on_owner', openId: 'ou_owner', name: 'Zhixi Sun' }, NOW);
    mkdirSync(join(fx.home, 'workflows'));
    writeFileSync(
      join(fx.home, 'workflows', 'mixed.yaml'),
      'steps:\n  a: { title: "Draft the brief", assignee: default, wake: { role: default } }\n  b: { title: "Review it", assignee: default, wake: true }\n',
    );
    writeFileSync(join(fx.home, 'workflows', 'brief.yaml'), 'steps:\n  a: { title: "Draft the brief", assignee: default }\n');
    server = await listenWorker(workerSocketPath(fx.home), () => ({ ok: true }));
  }

  const kanban = (argv: string[]) => fx.run(['kanban', ...argv], { env: { MT_OWNER_OPEN_ID: 'ou_owner' } });
  const created = (out: string): string => /^created (k_[0-9a-z]+)/.exec(out)?.[1] ?? '';

  it('makes a task with --wake-role, as the owner, and still refuses --wake', async () => {
    await setup();
    const r = await kanban(['task', 'new', 'Book the venue', '--wake-role', 'default']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('; its outcomes wake role default');
    const id = created(r.out);
    expect(getTask(db, id)).toMatchObject({ wakeBy: OWNER, wakeRole: 'default', wakeCursor: eventsOf(db, id).at(-1)?.id });
    expect(subscriptionsOf(db, id)).toEqual([]);
    expect(await kanban(['task', 'new', 'x', '--wake'])).toEqual({ code: 1, out: '', err: 'mt: a wake needs a chat that follows the task: add --chat' });
  });

  it('turns a role on for a task no chat follows, and refuses on', async () => {
    await setup();
    const id = created((await kanban(['task', 'new', 'Book the venue'])).out);
    const r = await kanban(['task', 'wake', id, 'default']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`wake on for ${id}: its outcomes make a task for role default, as ${OWNER} (the owner)`);
    expect(getTask(db, id)?.wakeCursor).toBe(eventsOf(db, id).at(-1)?.id);
    expect((await kanban(['task', 'wake', id, 'on'])).err).toBe(
      `mt: a wake needs a chat that follows the task, and no chat follows ${id}: a chat is chosen when a task is made`,
    );
  });

  it('keeps the wake of every member of a start with --wake-role', async () => {
    await setup();
    const r = JSON.parse((await kanban(['workflow', 'start', 'brief', '--wake-role', 'default', '--json'])).out);
    expect(r.ok).toBe(true);
    const ids = (r.tasks as Array<{ task_id: string }>).map((t) => t.task_id);
    expect(ids.map((id) => getTask(db, id)?.wakeRole)).toEqual(['default']);
    expect(r.wake_note).toBeUndefined();
  });

  it("keeps a role step's wake, and makes a chat-session step notice-only, with the note", async () => {
    await setup();
    const r = JSON.parse((await kanban(['workflow', 'start', 'mixed', '--json'])).out);
    expect(r.ok).toBe(true);
    const [a, b] = (r.tasks as Array<{ task_id: string }>).map((t) => getTask(db, t.task_id));
    expect(a).toMatchObject({ wakeBy: OWNER, wakeRole: 'default' });
    expect(b).toMatchObject({ wakeBy: null, wakeRole: null });
    expect(r.wake_note).toBe('no chat follows this start (add --chat), so the steps that wake the chat session are notice-only');
  });

  it('makes a role step notice-only too when the owner is not yet known, with the owner note alone', async () => {
    await setup({ seen: false });
    const r = JSON.parse((await kanban(['workflow', 'start', 'mixed', '--json'])).out);
    expect(r.ok).toBe(true);
    const [a, b] = (r.tasks as Array<{ task_id: string }>).map((t) => getTask(db, t.task_id));
    expect(a).toMatchObject({ wakeBy: null, wakeRole: null });
    expect(b).toMatchObject({ wakeBy: null, wakeRole: null });
    expect(r.wake_note).toBe('the owner has not used /kanban in Lark yet, so the steps that ask for a wake are notice-only');
  });
});
