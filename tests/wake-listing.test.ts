import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listText, showJson, showText } from '../src/cli/plain.js';
import { eventsOf, relatedTasks, subscriptionsOf } from '../src/db/kanban-read.js';
import { renderList, renderShow, wakeLine } from '../src/kanban/chat-render.js';
import { KanbanService } from '../src/kanban/service.js';
import type { CreatedVia, TaskRow } from '../src/kanban/types.js';
import type { Role } from '../src/roles.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, WORKSPACES, newTask } from './helpers/kanban.js';

/**
 * Reaction tasks listed as any other task (wake spec §19.9): every list and
 * filter shows them, the board's counts count them, no line is marked; the
 * terminal's `--json` gives `reacts_to`; a source task's show names its
 * reactions, at most five; a reaction task's show says what made it; a
 * workflow's related tasks include them (§19.3); and the Wake line names a role.
 */

const APP = 'cli_app';
const THREAD: CreatedVia = { kind: 'chat', channel: 'lark', appId: APP, conversationId: 'oc_team', threadId: 'omt_1', rootId: 'om_root', chatType: 'group' };
const ROLES: ReadonlyMap<string, Role> = new Map([
  ['implementer', role('implementer')],
  ['vi-coordinator', role('vi-coordinator')],
]);
const names = (p: string): string | undefined => (p === ALICE ? 'Zhixi Sun' : undefined);
const SHOW = { enabled: true, zone: 'UTC', now: NOW };

let t: TestDb;
let service: KanbanService;
let n: number;
beforeEach(() => {
  t = testDb();
  service = new KanbanService({ db: t.db, roles: ROLES, workspaces: WORKSPACES, clock: new ManualClock(NOW + 100) });
  n = 0;
});
afterEach(() => t.close());

/** A reaction task of a wake that carried each of `sources`' latest events, in that order. */
function reaction(sources: readonly TaskRow[]): TaskRow {
  n += 1;
  const events = sources.map((s) => {
    const event = eventsOf(t.db, s.taskId).at(-1)?.id ?? 0;
    return { subscriptionId: subscriptionsOf(t.db, s.taskId)[0]?.id ?? 0, eventId: event, taskId: s.taskId };
  });
  const made = service.recordRoleWake({
    uuid: `u-${n}`,
    channel: 'lark',
    appId: APP,
    conversationId: 'oc_team',
    threadId: 'omt_1',
    principal: ALICE,
    depth: 0,
    events,
    role: 'vi-coordinator',
    title: `React to board updates: ${sources.map((s) => `${s.taskId} completed`).join(', ')}`,
    body: 'Board update: …',
  });
  if (!made.ok || 'skipped' in made) throw new Error('no reaction task');
  return made.task;
}

describe('the lists', () => {
  it('list a reaction task as any task, its line its title, counted by its board', () => {
    const source = newTask(t.db, { createdVia: THREAD });
    const react = reaction([source]);
    const entries = service.list('default');
    expect(entries.map((e) => e.task.taskId)).toContain(react.taskId);
    expect(renderList(entries, undefined, 'default')).toContain('React to board updates: ');
    expect(listText(entries, undefined, 'default', { since: new Map(), now: NOW })).toEqual(
      expect.arrayContaining([expect.stringContaining(`React to board updates: ${source.taskId} completed`)]),
    );
    expect(service.boards({ archived: false })[0]?.counts).toMatchObject({ open: 2 });
  });

  it("gives reacts_to, the tasks its wake carried in event order, and null for a task that is none", () => {
    const a = newTask(t.db, { createdVia: THREAD });
    const b = newTask(t.db, { createdVia: THREAD });
    const react = reaction([a, b]);
    expect(service.reactsTo(react.taskId)).toEqual([a.taskId, b.taskId]);
    expect(service.reactsTo(a.taskId)).toBeNull();
  });
});

describe("a source task's show", () => {
  it('names its reaction tasks after its Wake line, newest first, with their statuses', () => {
    const source = newTask(t.db, { createdVia: THREAD, wake: { by: ALICE, depth: 0, role: 'vi-coordinator' } });
    const first = reaction([source]);
    const second = reaction([source]);
    const shown = service.show(source.taskId);
    if (!shown.ok) throw new Error(shown.message);
    const chat = renderShow(shown.view, [], 'default', names, SHOW).split('\n');
    expect(chat[2]).toMatch(/^Wake: on, set by Zhixi Sun, for role vi-coordinator, depth 0; last woke \d\d:\d\d$/);
    expect(chat[3]).toBe(`Reactions: \`${second.taskId}\` (ready), \`${first.taskId}\` (ready)`);
    const terminal = showText(shown.view, [], SHOW);
    expect(terminal[2]).toMatch(/^Wake: on, set by lark:on_alice, for role vi-coordinator, depth 0; last woke /);
    expect(terminal[3]).toBe(`Reactions: ${second.taskId} (ready), ${first.taskId} (ready)`);
    expect((showJson(shown.view, []).task as Record<string, unknown>)['reactions']).toEqual([
      { task_id: second.taskId, status: 'ready' },
      { task_id: first.taskId, status: 'ready' },
    ]);
  });

  it('names at most five, and counts the rest', () => {
    const source = newTask(t.db, { createdVia: THREAD });
    for (let i = 0; i < 7; i += 1) reaction([source]);
    const shown = service.show(source.taskId);
    if (!shown.ok) throw new Error(shown.message);
    const line = renderShow(shown.view, [], 'default', names, SHOW).split('\n')[3] ?? '';
    expect(line.match(/`k_/g)).toHaveLength(5);
    expect(line).toMatch(/, and 2 more: \/kanban task list$/);
    expect(showText(shown.view, [], SHOW)[3]).toMatch(/, and 2 more: mt kanban task list$/);
  });

  it('has no Reactions line, and an empty list in --json, with none', () => {
    const plain = newTask(t.db, { createdVia: THREAD });
    const shown = service.show(plain.taskId);
    if (!shown.ok) throw new Error(shown.message);
    expect(renderShow(shown.view, [], 'default', names, SHOW)).not.toContain('Reactions:');
    expect((showJson(shown.view, []).task as Record<string, unknown>)['reactions']).toEqual([]);
  });
});

describe("a reaction task's show", () => {
  it('says what made it: the tasks its wake carried, its role and its setter', () => {
    const a = newTask(t.db, { createdVia: THREAD });
    const b = newTask(t.db, { createdVia: THREAD });
    const react = reaction([a, b]);
    const shown = service.show(react.taskId);
    if (!shown.ok) throw new Error(shown.message);
    expect(renderShow(shown.view, [], 'default', names, SHOW).split('\n')).toContain(
      `Made by a wake of \`${a.taskId}\`, \`${b.taskId}\`, for role vi-coordinator, set by Zhixi Sun.`,
    );
    expect(showText(shown.view, [], SHOW)).toContain(`Made by a wake of ${a.taskId}, ${b.taskId}, for role vi-coordinator, set by ${ALICE}.`);
  });
});

describe('the Wake line', () => {
  it('names a role as the target, also with wakes off', () => {
    const task = newTask(t.db, { createdVia: THREAD, wake: { by: ALICE, depth: 1, role: 'vi-coordinator' } });
    expect(wakeLine(task, undefined, { ...SHOW, enabled: false }, 'Zhixi Sun')).toBe('Wake: on, set by Zhixi Sun, for role vi-coordinator, but wakes are off on this gateway');
  });
});

describe("a workflow's related tasks", () => {
  it("include a reaction task made from a member's outcomes", () => {
    const r = service.applyDag({
      dag: { format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'implementer' }] },
      createdBy: ALICE,
      createdVia: { kind: 'operator' },
      follow: { appId: APP, chatId: 'oc_team', threadId: 'omt_1', rootId: 'om_root' },
    });
    if (!r.ok || 'dryRun' in r) throw new Error('no instance');
    const member = r.tasks[0];
    if (member === undefined) throw new Error('no member');
    const react = reaction([member.task]);
    expect(relatedTasks(t.db, r.instance.instanceId).map((x) => x.taskId)).toEqual([react.taskId]);
  });
});
