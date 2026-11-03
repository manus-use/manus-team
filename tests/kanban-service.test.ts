import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventsOf } from '../src/db/kanban-read.js';
import { KanbanService, type CreateRequest, type KanbanServiceDeps } from '../src/kanban/service.js';
import type { AgentConfig } from '../src/config.js';
import type { Role } from '../src/roles.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

let h: TestDb;
let dir: string;
let clock: ManualClock;

beforeEach(() => {
  h = testDb();
  dir = mkdtempSync(join(tmpdir(), 'mt-kanban-'));
  clock = new ManualClock();
});

afterEach(() => {
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
      message: 'role implementr is not configured',
    });
    expect(s.create(request({ reviewer: 'nobody' }))).toMatchObject({ ok: false, code: 'unknown_role' });
    expect(s.create(request({ workspace: 'wbe' }))).toEqual({
      ok: false,
      code: 'unknown_workspace',
      message: 'workspace wbe is not configured',
    });
  });

  it('refuses a role whose agent is supervised, until approvals can reach someone', () => {
    expect(service().create(request({ assignee: 'supervised' }))).toEqual({
      ok: false,
      code: 'supervised_role',
      message:
        "role supervised's agent is supervised; its approval requests would reach nobody until the board is in Lark",
    });
    expect(service({ supervisedRoles: true }).create(request({ assignee: 'supervised' })).ok).toBe(true);
  });

  it('refuses people as assignees and reviewers until they can be reached, then only with talk tier', () => {
    expect(service().create(request({ assignee: 'lark:on_bob' }))).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message:
        'lark:on_bob cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark',
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
      message: 'lark:on_eve does not have talk tier, so cannot be given work',
    });
    expect(withPeople.create(request({ assignee: 'slack:U1' }))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('refuses malformed input: no title, an unknown contract field, a limit below 1', () => {
    const s = service();
    expect(s.create(request({ title: '  ' }))).toEqual({ ok: false, code: 'invalid', message: 'a task needs a title' });
    expect(s.create(request({ contract: { done_when: 'x' } as never }))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'unknown contract field done_when',
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
      message: 'role implementer is not configured',
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
      message: expect.stringMatching(/^role implementer's files cannot be read: ENOENT/),
    });
  });

  it("claims a person's task once people can be reached, with no agent", () => {
    const s = service({ people: { canTalk: () => true } });
    const task = ok(s.create(request({ assignee: 'lark:on_bob' }))).task;
    expect(ok(s.claim(task.taskId))).toMatchObject({ run: { agentConfig: null, roleMdHash: null }, roleMd: undefined });
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
