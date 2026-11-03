import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf } from '../src/db/kanban-read.js';
import { createSession } from '../src/db/sessions.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { KanbanService, type CreateRequest, type KanbanServiceDeps } from '../src/kanban/service.js';
import type { AgentConfig } from '../src/config.js';
import type { Role } from '../src/roles.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

let h: TestDb;
let dir: string;
let clock: ManualClock;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  dir = mkdtempSync(join(tmpdir(), 'mt-kanban-'));
  clock = new ManualClock();
});

afterEach(() => {
  clearSecrets();
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

function role(name: string, extra: Partial<Role> = {}, agent: Partial<AgentConfig> = {}): Role {
  return {
    name,
    source: 'directory',
    dir: undefined,
    description: undefined,
    workspace: undefined,
    agent: {
      driver: 'structured-cli',
      command: 'bytesec',
      args: ['run', '-m', 'model-a'],
      env: { API_KEY: 'sk-role-12345678' },
      unsupervised: true,
      passEnv: [],
      readOnlyTools: [],
      maskExempt: [],
      ...agent,
    },
    roleMdPath: undefined,
    skills: [],
    secretValues: ['sk-role-12345678'],
    ...extra,
  };
}

const ROLES: ReadonlyMap<string, Role> = new Map([
  ['implementer', role('implementer')],
  ['reviewer', role('reviewer')],
  ['docs-writer', role('docs-writer', { workspace: 'docs' })],
  ['supervised', role('supervised', {}, { driver: 'acp', unsupervised: false })],
]);

function service(extra: Partial<KanbanServiceDeps> = {}): KanbanService {
  return new KanbanService({ db: h.db, roles: ROLES, workspaces: WORKSPACES, clock, ...extra });
}

function request(extra: Partial<CreateRequest> = {}): CreateRequest {
  return { title: 'Write the parser', assignee: 'implementer', createdBy: ALICE, createdVia: VIA, ...extra };
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

describe('KanbanService: who may be given work', () => {
  it('creates a task for a configured role, in a configured workspace', () => {
    const r = service().create(request({ workspace: 'web', reviewer: 'reviewer', contract: { outcome: 'it parses' } }));
    expect(r).toMatchObject({
      ok: true,
      existing: false,
      task: {
        assignee: { kind: 'role', name: 'implementer' },
        reviewer: { kind: 'role', name: 'reviewer' },
        workspace: 'web',
        contract: { outcome: 'it parses' },
        createdAt: clock.now(),
      },
    });
  });

  it('refuses an unknown role or workspace while the person is still looking', () => {
    const s = service();
    expect(s.create(request({ assignee: 'implementr' }))).toEqual({
      ok: false,
      code: 'unknown_role',
      message: 'role "implementr" is not configured',
    });
    expect(s.create(request({ reviewer: 'nobody' }))).toMatchObject({ ok: false, code: 'unknown_role' });
    expect(s.create(request({ workspace: 'wbe' }))).toEqual({
      ok: false,
      code: 'unknown_workspace',
      message: 'workspace "wbe" is not configured',
    });
  });

  it('refuses a role whose agent is supervised, until approvals can reach someone', () => {
    expect(service().create(request({ assignee: 'supervised' }))).toEqual({
      ok: false,
      code: 'supervised_role',
      message:
        'role "supervised" has a supervised agent; its approval requests would reach nobody until the board is in Lark',
    });
    expect(service({ supervisedRoles: true }).create(request({ assignee: 'supervised' })).ok).toBe(true);
  });

  it('refuses people as assignees and reviewers until they can be reached, then only with talk tier', () => {
    expect(service().create(request({ assignee: 'lark:on_bob' }))).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message:
        '"lark:on_bob" cannot be given work yet: ' +
        'nothing can deliver a task card to a person until the board is in Lark',
    });
    expect(service().create(request({ reviewer: 'lark:on_bob' }))).toMatchObject({ code: 'person_not_assignable' });
    const withPeople = service({ people: { canTalk: (p) => p === 'lark:on_bob' } });
    expect(withPeople.create(request({ assignee: 'lark:on_bob' }))).toMatchObject({
      ok: true,
      task: { assignee: { kind: 'human', name: 'lark:on_bob' } },
    });
    expect(withPeople.create(request({ assignee: 'lark:on_eve' }))).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: '"lark:on_eve" does not have talk tier, so cannot be given work',
    });
    expect(withPeople.create(request({ assignee: 'slack:U1' }))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses malformed input: no title, an unknown contract field, a limit below 1', () => {
    const s = service();
    expect(s.create(request({ title: '  ' }))).toEqual({ ok: false, code: 'invalid', message: 'a task needs a title' });
    expect(s.create(request({ contract: { done_when: 'x' } as never }))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'unknown contract field "done_when"',
    });
    expect(s.create(request({ contract: { outcome: 3 } as never }))).toMatchObject({ code: 'invalid' });
    expect(s.create(request({ failureLimit: 0 }))).toMatchObject({ code: 'invalid' });
    expect(s.create(request({ retryOnCrash: 'never' as never }))).toMatchObject({ code: 'invalid' });
  });
});

describe('KanbanService: claims and the runs they open', () => {
  it("records the role's agent without its environment values, and the role.md it is given", () => {
    const md = join(dir, 'role.md');
    writeFileSync(md, 'You change code in this repository.\n');
    const s = service({ roles: new Map([['implementer', role('implementer', { roleMdPath: md })]]) });
    const task = ok(s.create(request())).task;
    const r = ok(s.claim(task.taskId, { tokenHash: 'hash-of-token' }));
    expect(r.run).toMatchObject({
      agentConfig: {
        driver: 'structured-cli',
        command: 'bytesec',
        args: ['run', '-m', 'model-a'],
        unsupervised: true,
        envNames: ['API_KEY'],
      },
      roleMdHash: createHash('sha256').update('You change code in this repository.\n').digest('hex'),
      tokenHash: 'hash-of-token',
      startedAt: clock.now(),
    });
    expect(r.roleMd).toBe('You change code in this repository.\n');
    expect(r.role?.name).toBe('implementer');
    expect(JSON.stringify(r.run)).not.toContain('sk-role-12345678');
  });

  it("works in the role's own workspace", () => {
    const s = service();
    const task = ok(s.create(request({ assignee: 'docs-writer' }))).task;
    expect(ok(s.claim(task.taskId)).run.workspace).toBe('docs');
  });

  it('leaves a task unassignable, noted once, when its role is gone or its files cannot be read', () => {
    const task = ok(service().create(request())).task;
    const without = service({ roles: new Map() });
    expect(without.claim(task.taskId)).toEqual({
      ok: false,
      code: 'unassignable',
      message: 'role "implementer" is not configured',
    });
    expect(without.claim(task.taskId)).toMatchObject({ code: 'unassignable' });
    expect(eventsOf(h.db, task.taskId).filter((e) => e.kind === 'skipped_unassignable')).toHaveLength(1);

    const md = join(dir, 'role.md');
    writeFileSync(md, 'instructions');
    unlinkSync(md);
    const unreadable = service({ roles: new Map([['implementer', role('implementer', { roleMdPath: md })]]) });
    expect(unreadable.claim(task.taskId)).toMatchObject({
      ok: false,
      code: 'unassignable',
      message: expect.stringMatching(/^the files of role "implementer" cannot be read: ENOENT/),
    });
  });

  it('hashes the bytes of role.md, which need not be UTF-8', () => {
    const md = join(dir, 'role.md');
    const bytes = Buffer.from([0x68, 0x69, 0xff, 0x0a]);
    writeFileSync(md, bytes);
    const implementer = role('implementer', { roleMdPath: md });
    const s = service({ roles: new Map([['implementer', implementer]]) });
    const r = ok(s.claim(ok(s.create(request())).task.taskId));
    expect(r.run.roleMdHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(r.roleMd).toBe('hi\uFFFD\n');
    expect(r.role).toBe(implementer);
  });

  it('leaves a task unassignable when role.md or a SKILL.md is a directory', () => {
    const task = ok(service().create(request())).task;
    const md = join(dir, 'role.md');
    mkdirSync(md);
    const mdIsDir = service({ roles: new Map([['implementer', role('implementer', { roleMdPath: md })]]) });
    expect(mdIsDir.claim(task.taskId)).toMatchObject({ ok: false, code: 'unassignable' });
    const skill = join(dir, 'skills', 'parse', 'SKILL.md');
    mkdirSync(skill, { recursive: true });
    const skills = [{ name: 'parse', description: 'parses', dir: dirname(skill), path: skill }];
    const skillIsDir = service({ roles: new Map([['implementer', role('implementer', { skills })]]) });
    expect(skillIsDir.claim(task.taskId)).toEqual({
      ok: false,
      code: 'unassignable',
      message: `the files of role "implementer" cannot be read: ${skill} is not a file`,
    });
  });

  it('notes a task unassignable only when it could otherwise be claimed', () => {
    const s = service();
    const parent = ok(s.create(request({ title: 'parent' }))).task;
    const todo = ok(s.create(request({ title: 'todo', parents: [parent.taskId] }))).task;
    const running = ok(s.create(request({ title: 'running' }))).task;
    ok(s.claim(running.taskId));
    const without = service({ roles: new Map() });
    expect(without.claim(todo.taskId)).toMatchObject({ ok: false, code: 'unassignable' });
    expect(without.claim(running.taskId)).toMatchObject({ ok: false, code: 'unassignable' });
    for (const t of [todo, running]) {
      expect(eventsOf(h.db, t.taskId).filter((e) => e.kind === 'skipped_unassignable')).toEqual([]);
    }
  });

  it("claims a person's task once people can be reached, with no agent", () => {
    const s = service({ people: { canTalk: () => true } });
    const task = ok(s.create(request({ assignee: 'lark:on_bob' }))).task;
    expect(ok(s.claim(task.taskId))).toMatchObject({
      run: { agentConfig: null, roleMdHash: null },
      roleMd: undefined,
      role: undefined,
    });
  });

  it('ends and closes runs with its limits', () => {
    const s = service({ limits: { failureLimit: 1, transientLimit: 10, transientCooldownS: 300 } });
    const task = ok(s.create(request())).task;
    const run = ok(s.claim(task.taskId)).run;
    expect(s.endRun(run.runId, { outcome: 'failed', error: 'exit 1' })).toMatchObject({
      ok: true,
      next: 'blocked',
      task: { blockKind: 'gave_up' },
    });
    expect(s.closeRun(run.runId)).toMatchObject({ ok: true, run: { endedAt: clock.now() } });
  });
});

describe('KanbanService: the rest of the board', () => {
  it('runs a task from claim to done, and shows it', () => {
    const s = service();
    const task = ok(s.create(request())).task;
    const run = ok(s.claim(task.taskId)).run;
    createSession(
      h.db,
      { id: 's_run', agentId: 'implementer', workspaceId: 'default', ownerPrincipal: ALICE },
      clock.now(),
    );
    ok(s.attachSession(run.runId, 's_run'));
    ok(s.comment(task.taskId, 'remember the empty file', ALICE));
    clock.advance(60_000);
    ok(s.complete(task.taskId, { kind: 'run', runId: run.runId }, { summary: 'parser written' }));
    ok(s.closeRun(run.runId));
    expect(ok(s.show(task.taskId)).view).toMatchObject({
      status: 'done',
      task: { phase: 'done', closedAt: clock.now() },
      runs: [
        { runId: run.runId, sessionId: 's_run', outcome: 'completed', summary: 'parser written', endedAt: clock.now() },
      ],
      comments: [{ author: ALICE, body: 'remember the empty file' }],
    });
    expect(s.show('k_missing')).toEqual({ ok: false, code: 'not_found', message: 'no task k_missing' });
  });

  it('checks a reviewer named in a review report like any assignee', () => {
    const s = service();
    const task = ok(s.create(request())).task;
    const by = { kind: 'run', runId: ok(s.claim(task.taskId)).run.runId } as const;
    expect(s.requestReview(task.taskId, by, { summary: 'v1', reviewer: 'lark:on_bob' })).toMatchObject({
      ok: false,
      code: 'person_not_assignable',
    });
    expect(s.requestReview(task.taskId, by, { summary: 'v1', reviewer: 'ghost' })).toMatchObject({
      ok: false,
      code: 'unknown_role',
    });
    expect(s.requestReview(task.taskId, by, { summary: 'v1', reviewer: 'reviewer' })).toMatchObject({
      ok: true,
      task: { phase: 'review', reviewer: { kind: 'role', name: 'reviewer' } },
    });
  });

  it('reassigns only to a name the board may give work to, and sets only a configured workspace', () => {
    const s = service();
    const task = ok(s.create(request())).task;
    expect(s.assign(task.taskId, 'supervised', ALICE)).toMatchObject({ ok: false, code: 'supervised_role' });
    expect(s.assignReviewer(task.taskId, 'lark:on_bob', ALICE)).toMatchObject({
      ok: false,
      code: 'person_not_assignable',
    });
    expect(s.assign(task.taskId, 'docs-writer', ALICE)).toMatchObject({
      ok: true,
      task: { assignee: { kind: 'role', name: 'docs-writer' } },
    });
    expect(s.setWorkspace(task.taskId, 'nowhere', ALICE)).toEqual({
      ok: false,
      code: 'unknown_workspace',
      message: 'workspace "nowhere" is not configured',
    });
    expect(s.setWorkspace(task.taskId, 'web', ALICE)).toMatchObject({ ok: true, task: { workspace: 'web' } });
  });

  it('refuses an empty comment, reason or change request, and a block kind nobody may report', () => {
    const s = service();
    const task = ok(s.create(request({ reviewer: 'reviewer' }))).task;
    const by = { kind: 'run', runId: ok(s.claim(task.taskId)).run.runId } as const;
    expect(s.comment(task.taskId, '  ', ALICE)).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a comment needs text',
    });
    expect(s.block(task.taskId, by, { kind: 'gave_up', reason: 'x' })).toEqual({
      ok: false,
      code: 'invalid',
      message: "gave_up is set by the board's breaker, never reported",
    });
    expect(s.block(task.taskId, by, { kind: 'bored', reason: 'x' })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'unknown block kind "bored" (one of dependency, needs_input, capability, transient)',
    });
    expect(s.block(task.taskId, by, { kind: 'needs_input', reason: '' })).toMatchObject({ code: 'invalid' });
    expect(s.requestChanges(task.taskId, by, ' ')).toMatchObject({ code: 'invalid' });
  });

  it('blocks, unblocks, stops and archives', () => {
    const s = service();
    const task = ok(s.create(request())).task;
    const first = ok(s.claim(task.taskId)).run;
    expect(
      s.block(task.taskId, { kind: 'run', runId: first.runId }, { kind: 'needs_input', reason: 'which db?' }),
    ).toMatchObject({
      ok: true,
      task: { phase: 'blocked' },
    });
    ok(s.closeRun(first.runId));
    expect(s.unblock(task.taskId, ALICE, 'postgres')).toMatchObject({ ok: true, task: { phase: 'open' } });
    const second = ok(s.claim(task.taskId)).run;
    expect(s.stop(task.taskId, ALICE)).toMatchObject({ ok: true, run: { runId: second.runId, outcome: 'cancelled' } });
    ok(s.closeRun(second.runId));
    expect(s.archive(task.taskId, ALICE)).toMatchObject({ ok: true, task: { phase: 'archived' } });
  });

  it('creates a follow-up for a done task instead of reopening it', () => {
    const s = service();
    const task = ok(s.create(request())).task;
    expect(s.followUp(task.taskId, request({ title: 'handle CRLF' }))).toEqual({
      ok: false,
      code: 'illegal_transition',
      message: `task ${task.taskId} is open; only a done task gets follow-ups`,
    });
    ok(s.complete(task.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' }));
    const follow = ok(s.followUp(task.taskId, request({ title: 'handle CRLF', body: 'CI log: ...' }))).task;
    expect(ok(s.show(follow.taskId)).view).toMatchObject({
      status: 'ready',
      parents: [{ taskId: task.taskId, phase: 'done' }],
      task: { body: 'CI log: ...' },
    });
    expect(ok(s.show(task.taskId)).view.task.phase).toBe('done');
  });

  it('links tasks, refusing a cycle', () => {
    const s = service();
    const a = ok(s.create(request({ title: 'a' }))).task;
    const b = ok(s.create(request({ title: 'b', parents: [a.taskId] }))).task;
    expect(s.link(b.taskId, a.taskId, ALICE)).toMatchObject({ ok: false, code: 'cycle' });
    const c = ok(s.create(request({ title: 'c' }))).task;
    expect(s.link(c.taskId, b.taskId, ALICE)).toEqual({ ok: true, added: true });
    expect(ok(s.show(b.taskId)).view.parents.map((t) => t.title)).toEqual(['a', 'c']);
  });
});

describe('KanbanService: malformed input', () => {
  const TABLES = ['kanban_tasks', 'kanban_runs', 'kanban_links', 'kanban_comments', 'kanban_events'];
  function counts(): number[] {
    return TABLES.map((t) => h.db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${t}`).get()?.n ?? -1);
  }
  /** A value of the wrong type, as an agent's JSON can carry one. */
  const bad = (v: unknown): never => v as never;

  it('refuses every wrong-typed field, at every entry point, as invalid, and writes nothing', () => {
    const s = service();
    const open = ok(s.create(request({ title: 'open', reviewer: 'reviewer' }))).task;
    const by = { kind: 'run', runId: ok(s.claim(open.taskId)).run.runId } as const;
    const done = ok(s.create(request({ title: 'done', assignee: 'docs-writer' }))).task;
    ok(s.complete(done.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' }));
    const { title: _title, ...untitled } = request();

    const cases: Array<[string, () => unknown]> = [
      ['create: title a number', () => s.create(request({ title: bad(3) }))],
      ['create: no title', () => s.create(bad(untitled))],
      ['create: title null', () => s.create(request({ title: bad(null) }))],
      ['create: body an object', () => s.create(request({ body: bad({}) }))],
      ['create: body a number', () => s.create(request({ body: bad(3) }))],
      ['create: assignee a number', () => s.create(request({ assignee: bad(3) }))],
      ['create: assignee null', () => s.create(request({ assignee: bad(null) }))],
      ['create: assignee empty', () => s.create(request({ assignee: '' }))],
      ['create: reviewer a number', () => s.create(request({ reviewer: bad(3) }))],
      ['create: reviewer null', () => s.create(request({ reviewer: bad(null) }))],
      ['create: workspace a number', () => s.create(request({ workspace: bad(3) }))],
      ['create: parents a string', () => s.create(request({ parents: bad(done.taskId) }))],
      ['create: parents not strings', () => s.create(request({ parents: bad([3]) }))],
      ['create: priority huge', () => s.create(request({ priority: 1e300 }))],
      ['create: priority a fraction', () => s.create(request({ priority: 1.5 }))],
      ['create: priority text', () => s.create(request({ priority: bad('1') }))],
      ['create: failure limit text', () => s.create(request({ failureLimit: bad('2') }))],
      ['create: runtime huge', () => s.create(request({ maxRuntimeS: 1e300 }))],
      ['create: retry a number', () => s.create(request({ retryOnCrash: bad(3) }))],
      ['create: key a number', () => s.create(request({ idempotencyKey: bad(3) }))],
      ['create: contract value a number', () => s.create(request({ contract: bad({ outcome: 3 }) }))],
      ['create: contract value null', () => s.create(request({ contract: bad({ outcome: null }) }))],
      ['create: contract text', () => s.create(request({ contract: bad('x') }))],
      ['create: contract a list', () => s.create(request({ contract: bad([]) }))],
      ['create: createdBy a number', () => s.create(request({ createdBy: bad(3) }))],
      ['create: createdBy missing', () => s.create(request({ createdBy: bad(undefined) }))],
      ['create: createdVia null', () => s.create(request({ createdVia: bad(null) }))],
      ['create: createdVia text', () => s.create(request({ createdVia: bad('chat') }))],
      ['create: createdVia a list', () => s.create(request({ createdVia: bad([]) }))],
      ['create: createdVia unknown kind', () => s.create(request({ createdVia: bad({ kind: 'email' }) }))],
      ['create: createdVia run id a number', () => s.create(request({ createdVia: bad({ kind: 'run', runId: 3 }) }))],
      [
        'create: createdVia chat channel a number',
        () => s.create(request({ createdVia: bad({ ...VIA, channel: 3 }) })),
      ],
      [
        'create: createdVia chat without a thread',
        () => s.create(request({ createdVia: bad({ ...VIA, threadId: undefined }) })),
      ],
      [
        'create: createdVia with a key and a run id a number',
        () => s.create(request({ idempotencyKey: 'k', createdVia: bad({ kind: 'run', runId: {} }) })),
      ],
      ['followUp: title a number', () => s.followUp(done.taskId, request({ title: bad(3) }))],
      ['followUp: parents a string', () => s.followUp(done.taskId, request({ parents: bad(open.taskId) }))],
      ['followUp: task id an object', () => s.followUp(bad({}), request())],
      ['assign: a number', () => s.assign(open.taskId, bad(3), ALICE)],
      ['assign: null', () => s.assign(open.taskId, bad(null), ALICE)],
      ['assign: empty', () => s.assign(open.taskId, '', ALICE)],
      ['assign: task id an object', () => s.assign(bad({}), 'implementer', ALICE)],
      ['assignReviewer: a number', () => s.assignReviewer(open.taskId, bad(3), ALICE)],
      ['assignReviewer: null', () => s.assignReviewer(open.taskId, bad(null), ALICE)],
      ['claim: task id an object', () => s.claim(bad({}))],
      ['comment: body a number', () => s.comment(open.taskId, bad(3), ALICE)],
      ['comment: body an object', () => s.comment(open.taskId, bad({}), ALICE)],
      ['comment: body null', () => s.comment(open.taskId, bad(null), ALICE)],
      ['comment: task id an object', () => s.comment(bad({}), 'hi', ALICE)],
      ['complete: summary a number', () => s.complete(open.taskId, by, { summary: bad(3) })],
      ['complete: summary null', () => s.complete(open.taskId, by, { summary: bad(null) })],
      ['complete: summary blank', () => s.complete(open.taskId, by, { summary: '  ' })],
      ['complete: no handoff', () => s.complete(open.taskId, by, bad(null))],
      ['complete: commit a number', () => s.complete(open.taskId, by, { summary: 'x', reportedCommit: bad(3) })],
      ['complete: dirty text', () => s.complete(open.taskId, by, { summary: 'x', reportedDirty: bad('yes') })],
      ['complete: commit not a commit id', () => s.complete(open.taskId, by, { summary: 'x', reportedCommit: 'HEAD' })],
      ['complete: commit too short', () => s.complete(open.taskId, by, { summary: 'x', reportedCommit: 'abc12' })],
      [
        'requestReview: commit upper case',
        () => s.requestReview(open.taskId, by, { summary: 'x', reportedCommit: 'ABCDEF1234567' }),
      ],
      ['requestReview: summary a number', () => s.requestReview(open.taskId, by, { summary: bad(3) })],
      ['requestReview: summary blank', () => s.requestReview(open.taskId, by, { summary: '\n' })],
      ['requestReview: reviewer a number', () => s.requestReview(open.taskId, by, { summary: 'x', reviewer: bad(3) })],
      ['requestReview: reviewer null', () => s.requestReview(open.taskId, by, { summary: 'x', reviewer: bad(null) })],
      ['requestReview: reviewer empty', () => s.requestReview(open.taskId, by, { summary: 'x', reviewer: '' })],
      ['requestChanges: reason a number', () => s.requestChanges(open.taskId, by, bad(3))],
      ['requestChanges: reason null', () => s.requestChanges(open.taskId, by, bad(null))],
      ['block: reason a number', () => s.block(open.taskId, by, { kind: 'needs_input', reason: bad(3) })],
      ['block: reason null', () => s.block(open.taskId, by, { kind: 'needs_input', reason: bad(null) })],
      ['block: kind a number', () => s.block(open.taskId, by, { kind: bad(3), reason: 'x' })],
      [
        'block: parents a string',
        () => s.block(open.taskId, by, { kind: 'dependency', reason: 'x', parents: bad(done.taskId) }),
      ],
      [
        'block: parents not strings',
        () => s.block(open.taskId, by, { kind: 'dependency', reason: 'x', parents: bad([3]) }),
      ],
      ['block: no report', () => s.block(open.taskId, by, bad(null))],
      [
        'block: parents on a needs_input block',
        () => s.block(open.taskId, by, { kind: 'needs_input', reason: 'x', parents: [done.taskId] }),
      ],
      [
        'block: parents on a capability block',
        () => s.block(open.taskId, by, { kind: 'capability', reason: 'x', parents: [] }),
      ],
      ['unblock: comment a number', () => s.unblock(open.taskId, ALICE, bad(3))],
      ['link: parent a number', () => s.link(bad(3), open.taskId, ALICE)],
      ['link: child an object', () => s.link(done.taskId, bad({}), ALICE)],
      ['setWorkspace: a number', () => s.setWorkspace(open.taskId, bad(3), ALICE)],
      ['setWorkspace: null', () => s.setWorkspace(open.taskId, bad(null), ALICE)],
      ['stop: task id an object', () => s.stop(bad({}), ALICE)],
      ['archive: task id an object', () => s.archive(bad({}), ALICE)],
      ['show: task id an object', () => s.show(bad({}))],
    ];

    const wrong: string[] = [];
    for (const [what, call] of cases) {
      const before = counts();
      let r: unknown;
      try {
        r = call();
      } catch (err) {
        r = { threw: (err as Error).message };
      }
      const { ok: passed, code } = (r ?? {}) as { ok?: unknown; code?: unknown };
      const refused = passed === false && code === 'invalid';
      if (!refused) wrong.push(`${what}: ${JSON.stringify(r)}`);
      else if (JSON.stringify(counts()) !== JSON.stringify(before)) wrong.push(`${what}: wrote something`);
    }
    expect(wrong).toEqual([]);
  });

  it("accepts a person's blank summary: an approval needs no words", () => {
    const s = service();
    const task = ok(s.create(request())).task;
    expect(s.complete(task.taskId, { kind: 'person', principal: ALICE }, { summary: '' })).toMatchObject({ ok: true });
  });
});

describe('KanbanService: idempotency keys', () => {
  /** A task with a run working on it, and how that run creates. */
  function working(s: KanbanService, workspace: string) {
    const task = ok(s.create(request({ title: `in ${workspace}`, workspace }))).task;
    const runId = ok(s.claim(task.taskId)).run.runId;
    return { task, runId, as: { createdBy: `run:${runId}`, createdVia: { kind: 'run', runId } as const } };
  }

  it("refuses a chat-shaped key from an agent, and a key shaped like a run's from anyone", () => {
    const s = service();
    const { as } = working(s, 'web');
    expect(s.create(request({ idempotencyKey: 'lark:om_1', ...as }))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'an idempotency key starting lark: is for chat',
    });
    expect(s.create(request({ idempotencyKey: 'run-task:k_x:step' }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(s.create(request({ idempotencyKey: 'lark:om_1' }))).toMatchObject({ ok: true, existing: false });
  });

  it("keeps two runs' keys apart, and gives a run its own task back", () => {
    const s = service();
    const one = working(s, 'web');
    const two = working(s, 'api');
    const a = ok(s.create(request({ title: 'from one', idempotencyKey: 'step-1', ...one.as }))).task;
    const b = ok(s.create(request({ title: 'from two', idempotencyKey: 'step-1', ...two.as }))).task;
    expect(b.taskId).not.toBe(a.taskId);
    expect(a.idempotencyKey).toBe(`run-task:${one.task.taskId}:step-1`);
    expect(b.idempotencyKey).toBe(`run-task:${two.task.taskId}:step-1`);
    expect(s.create(request({ title: 'from one again', idempotencyKey: 'step-1', ...one.as }))).toEqual({
      ok: true,
      task: a,
      existing: true,
    });
  });

  it('never returns a chat task to a run', () => {
    const s = service();
    const { as } = working(s, 'web');
    const chat = ok(s.create(request({ idempotencyKey: 'plain' }))).task;
    const r = ok(s.create(request({ idempotencyKey: 'plain', ...as })));
    expect(r.existing).toBe(false);
    expect(r.task.taskId).not.toBe(chat.taskId);
  });

  it('namespaces a follow-up from a run the same way', () => {
    const s = service();
    const done = ok(s.create(request({ title: 'done', assignee: 'docs-writer' }))).task;
    ok(s.complete(done.taskId, { kind: 'person', principal: ALICE }, { summary: 'done' }));
    const { task, as } = working(s, 'web');
    const first = ok(s.followUp(done.taskId, request({ idempotencyKey: 'more', ...as }))).task;
    expect(first.idempotencyKey).toBe(`run-task:${task.taskId}:more`);
    expect(s.followUp(done.taskId, request({ idempotencyKey: 'more', ...as }))).toMatchObject({
      ok: true,
      existing: true,
      task: { taskId: first.taskId },
    });
    expect(s.followUp(done.taskId, request({ idempotencyKey: 'lark:om_9', ...as }))).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});

describe('KanbanService: secrets in what a reporter or creator sends', () => {
  it('refuses a reported commit that is a secret, and stores a commit id', () => {
    addSecrets(['sk-test-123456']);
    const s = service();
    const task = ok(s.create(request())).task;
    const by = { kind: 'run', runId: ok(s.claim(task.taskId)).run.runId } as const;
    expect(s.complete(task.taskId, by, { summary: 'done', reportedCommit: 'sk-test-123456' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(ok(s.complete(task.taskId, by, { summary: 'done', reportedCommit: sha })).run?.reportedCommit).toBe(sha);
  });

  it('refuses an idempotency key that holds a known secret, and writes nothing', () => {
    addSecrets(['sk-test-123456']);
    const s = service();
    expect(s.create(request({ idempotencyKey: 'step-sk-test-123456' }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(h.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM kanban_tasks').get()?.n).toBe(0);
    expect(s.create(request({ idempotencyKey: 'step-1' }))).toMatchObject({ ok: true, existing: false });
  });
});

describe('the board has one writer', () => {
  it('is reached only through the service: nothing else in src imports db/kanban.js', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const writer = join(src, 'db', 'kanban.js');
    const importers = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
        [...readFileSync(join(src, f), 'utf8').matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].some(
          (m) => m[1] !== undefined && resolve(dirname(join(src, f)), m[1]) === writer,
        ),
      );
    expect(importers).toEqual([join('kanban', 'service.ts')]);
  });
});
