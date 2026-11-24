import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkWorkflow,
  listWorkflows,
  startBoard,
  withBoards,
  workflowBoard,
  type Workflow,
  type WorkflowFacts,
} from '../src/kanban/workflow.js';
import { archiveBoard, createBoard } from '../src/db/kanban.js';
import { KanbanService, type StartRequest, type WorkflowMade } from '../src/kanban/service.js';
import type { CreatedVia, Result } from '../src/kanban/types.js';
import type { Role } from '../src/roles.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, claimed, newTask } from './helpers/kanban.js';

/**
 * A workflow's own board (workflows spec §19): the key, the routing of a start,
 * the light read of a file's board, and a list judged against the boards.
 */

const ROLES: ReadonlyMap<string, Role> = new Map([['worker', role('worker')]]);
const FACTS: WorkflowFacts = { roles: ROLES, workspaces: new Set(['default']), supervisedRoles: false };

/** A file of one step, with these top-level lines above it. */
const withTop = (top: string): string => `${top}${top === '' ? '' : '\n'}steps:\n  a:\n    title: A task\n    assignee: worker\n`;

function parsed(text: string): Workflow {
  const r = checkWorkflow('vi-sync', text, FACTS);
  if (!r.ok) throw new Error(r.problem);
  return r.workflow;
}

function problem(text: string): string | undefined {
  const r = checkWorkflow('vi-sync', text, FACTS);
  return r.ok ? undefined : r.problem;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mt-wf-board-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the board key', () => {
  it('reads board: vi, and takes an absent key or a bare board: as none', () => {
    expect(parsed(withTop('board: vi')).board).toBe('vi');
    expect(parsed(withTop('')).board).toBeUndefined();
    expect(parsed(withTop('board:')).board).toBeUndefined();
    expect(parsed(withTop('board: null')).board).toBeUndefined();
  });

  it('refuses an empty name, none, all, a reference and names outside the grammar, naming board', () => {
    expect(problem(withTop('board: ""'))).toMatch(/^board: board name "" must be lowercase letters/);
    expect(problem(withTop('board: none'))).toBe('board: board name "none" is reserved: none clears a setting, and all lists every board');
    expect(problem(withTop('board: all'))).toBe('board: board name "all" is reserved: none clears a setting, and all lists every board');
    expect(problem(withTop('board: "{{team}}"'))).toMatch(/^board: board name "\{\{team\}\}" must be lowercase letters/);
    expect(problem(withTop('board: Vi'))).toMatch(/^board: board name "Vi" must be/);
    expect(problem(withTop('board: vi-'))).toMatch(/^board: board name "vi-" must be/);
    expect(problem(withTop('board: 3'))).toBe('board is text');
    expect(problem(withTop('board: [vi]'))).toBe('board is text');
  });
});

describe('startBoard', () => {
  const vi = parsed(withTop('board: vi'));
  const none = parsed(withTop(''));

  it('routes a file naming a board as the table of §19.2 says', () => {
    expect(startBoard(vi, { kind: 'chat', board: 'default' })).toEqual({ ok: true, board: 'vi', fromFile: true });
    expect(startBoard(vi, { kind: 'chat', board: 'research' })).toEqual({ ok: true, board: 'vi', fromFile: true });
    expect(startBoard(vi, { kind: 'terminal', board: undefined })).toEqual({ ok: true, board: 'vi', fromFile: true });
    expect(startBoard(vi, { kind: 'terminal', board: 'vi' })).toEqual({ ok: true, board: 'vi', fromFile: true });
    expect(startBoard(vi, { kind: 'terminal', board: 'x' })).toEqual({ ok: false, code: 'other_board', message: 'workflow vi-sync puts its tasks on board vi, not x' });
    expect(startBoard(vi, { kind: 'run', board: 'vi' })).toEqual({ ok: true, board: 'vi', fromFile: true });
    expect(startBoard(vi, { kind: 'run', board: 'x' })).toEqual({
      ok: false,
      code: 'other_board',
      message: "workflow vi-sync puts its tasks on board vi, and a run's work stays on its task's board, x",
    });
  });

  it("leaves a file naming none on the path's own board, default at the terminal with no --board", () => {
    expect(startBoard(none, { kind: 'chat', board: 'research' })).toEqual({ ok: true, board: 'research', fromFile: false });
    expect(startBoard(none, { kind: 'terminal', board: undefined })).toEqual({ ok: true, board: 'default', fromFile: false });
    expect(startBoard(none, { kind: 'terminal', board: 'x' })).toEqual({ ok: true, board: 'x', fromFile: false });
    expect(startBoard(none, { kind: 'run', board: 'x' })).toEqual({ ok: true, board: 'x', fromFile: false });
  });
});

describe('workflowBoard', () => {
  it('is unreadable for no file, a symlink, a directory, a file too large, YAML that does not parse, and a name outside the grammar', () => {
    expect(workflowBoard(dir, 'gone')).toEqual({ file: 'unreadable' });
    writeFileSync(join(dir, 'real.yaml'), withTop('board: vi'));
    symlinkSync(join(dir, 'real.yaml'), join(dir, 'linked.yaml'));
    expect(workflowBoard(dir, 'linked')).toEqual({ file: 'unreadable' });
    mkdirSync(join(dir, 'adir.yaml'));
    expect(workflowBoard(dir, 'adir')).toEqual({ file: 'unreadable' });
    writeFileSync(join(dir, 'big.yaml'), `board: vi\n# ${'x'.repeat(70 * 1024)}\n`);
    expect(workflowBoard(dir, 'big')).toEqual({ file: 'unreadable' });
    writeFileSync(join(dir, 'broken.yaml'), 'board: vi\nsteps: [unclosed\n');
    expect(workflowBoard(dir, 'broken')).toEqual({ file: 'unreadable' });
    expect(workflowBoard(dir, '../real')).toEqual({ file: 'unreadable' });
  });

  it('is read with no board for no key, a root that is no mapping, and a board outside the grammar', () => {
    writeFileSync(join(dir, 'plain.yaml'), withTop(''));
    expect(workflowBoard(dir, 'plain')).toEqual({ file: 'read', board: undefined });
    writeFileSync(join(dir, 'listed.yaml'), '- board: vi\n');
    expect(workflowBoard(dir, 'listed')).toEqual({ file: 'read', board: undefined });
    writeFileSync(join(dir, 'reserved.yaml'), withTop('board: none'));
    expect(workflowBoard(dir, 'reserved')).toEqual({ file: 'read', board: undefined });
  });

  it('reads the board of a file broken otherwise, as no team check is made', () => {
    writeFileSync(join(dir, 'vi-sync.yaml'), 'board: vi\nsteps:\n  a:\n    title: A task\n    assignee: nobody-here\n');
    expect(checkWorkflow('vi-sync', 'board: vi\nsteps:\n  a:\n    title: A task\n    assignee: nobody-here\n', FACTS).ok).toBe(false);
    expect(workflowBoard(dir, 'vi-sync')).toEqual({ file: 'read', board: 'vi' });
  });
});

describe('withBoards', () => {
  it('moves a workflow on a missing or an archived board to broken, keeping the others', () => {
    writeFileSync(join(dir, 'a-missing.yaml'), withTop('board: vi'));
    writeFileSync(join(dir, 'b-archived.yaml'), withTop('board: old'));
    writeFileSync(join(dir, 'c-plain.yaml'), withTop(''));
    writeFileSync(join(dir, 'd-default.yaml'), withTop('board: default'));
    writeFileSync(join(dir, 'e-live.yaml'), withTop('board: research'));
    const list = withBoards(listWorkflows(dir, FACTS), new Map([['default', false], ['old', true], ['research', false]]));
    expect(list.usable.map((w) => w.name)).toEqual(['c-plain', 'd-default', 'e-live']);
    expect(list.broken).toEqual([
      { name: 'a-missing', problem: 'its board vi does not exist (create it with /kanban board create vi, or mt kanban board create vi)' },
      { name: 'b-archived', problem: 'its board old is archived, and nothing is added to it (name another board in its file)' },
    ]);
  });

  it('keeps a workflow naming default usable when only default is known, as with no database', () => {
    writeFileSync(join(dir, 'd-default.yaml'), withTop('board: default'));
    expect(withBoards(listWorkflows(dir, FACTS), new Map([['default', false]])).usable.map((w) => w.name)).toEqual(['d-default']);
  });
});

// ---------------------------------------------------------------------------
// The service (workflows spec §19.2 to §19.4)

const OPERATOR: CreatedVia = { kind: 'operator' };
const VI_SYNC = 'board: vi\nsteps:\n  sync:\n    title: Sync the vi team\n    assignee: worker\n';
const PLAIN = 'steps:\n  sync:\n    title: Sync anyone\n    assignee: worker\n';

describe('the service', () => {
  let h: TestDb;
  let wf: string;
  let service: KanbanService;
  beforeEach(() => {
    h = testDb();
    wf = join(h.dir, 'workflows');
    mkdirSync(wf);
    writeFileSync(join(wf, 'vi-sync.yaml'), VI_SYNC);
    writeFileSync(join(wf, 'plain.yaml'), PLAIN);
    service = new KanbanService({
      db: h.db,
      roles: new Map([['worker', role('worker')], ['implementer', role('implementer')]]),
      workspaces: new Set(['default']),
      people: { canTalk: () => true },
      supervisedRoles: true,
      workflowsDir: wf,
    });
  });
  afterEach(() => h.close());

  const tasks = (): number => (h.db.prepare('SELECT count(*) AS n FROM kanban_tasks').get() as { n: number }).n;
  /** A start; `board: null` gives none, as the terminal with no --board and a run. */
  const start = (over: Omit<Partial<StartRequest>, 'board'> & { board?: string | null } = {}): Result<WorkflowMade> => {
    const { board, ...rest } = over;
    const req: StartRequest = { workflow: 'vi-sync', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA, ...rest };
    return service.startWorkflow(board === null ? req : { ...req, board: board ?? 'default' });
  };
  function made(r: Result<WorkflowMade>): WorkflowMade {
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return r;
  }

  describe('a start and a preview', () => {
    it("puts a chat's start on the file's board, from any chat board, the chat following its tasks", () => {
      createBoard(h.db, 'vi', ALICE, NOW);
      createBoard(h.db, 'research', ALICE, NOW);
      const r = made(start());
      expect(r.instance.board).toBe('vi');
      for (const t of r.tasks) expect(t.task.board).toBe('vi');
      const subs = h.db.prepare<[string], { conversation_id: string }>('SELECT conversation_id FROM kanban_subscriptions WHERE task_id = ?').all(r.tasks[0]?.taskId ?? '');
      expect(subs.map((x) => x.conversation_id)).toEqual(['oc_chat']);
      expect(made(start({ board: 'research', idempotencyKey: 'lark:om_2' })).instance.board).toBe('vi');
      expect(made(start({ workflow: 'plain', board: 'research', idempotencyKey: 'lark:om_3' })).instance.board).toBe('research');
    });

    it('puts a terminal start on the file\'s board with no --board or the same one, refusing another', () => {
      createBoard(h.db, 'vi', ALICE, NOW);
      const op = { createdBy: 'operator:me', createdVia: OPERATOR };
      expect(made(start({ ...op, board: null })).instance.board).toBe('vi');
      expect(made(start({ ...op, board: 'vi' })).instance.board).toBe('vi');
      const before = tasks();
      expect(start({ ...op, board: 'x' })).toEqual({ ok: false, code: 'other_board', message: 'workflow vi-sync puts its tasks on board vi, not x' });
      expect(tasks()).toBe(before);
      expect(made(start({ ...op, workflow: 'plain', board: null })).instance.board).toBe('default');
    });

    it("makes a run's start on its task's board when the file names it, and refuses it from another board", () => {
      createBoard(h.db, 'vi', ALICE, NOW);
      const onVi = newTask(h.db, { board: 'vi' });
      const run = claimed(h.db, onVi.taskId);
      expect(made(start({ createdVia: { kind: 'run', runId: run.runId }, createdBy: `run:${run.runId}`, board: null })).instance.board).toBe('vi');
      const onDefault = newTask(h.db, { workspace: 'web' });
      const other = claimed(h.db, onDefault.taskId);
      expect(start({ createdVia: { kind: 'run', runId: other.runId }, createdBy: `run:${other.runId}`, board: null })).toEqual({
        ok: false,
        code: 'other_board',
        message: "workflow vi-sync puts its tasks on board vi, and a run's work stays on its task's board, default",
      });
    });

    it("refuses a missing and an archived file's board naming the workflow, a file naming none keeping today's words", () => {
      const missing = { ok: false, code: 'unknown_board', message: 'workflow vi-sync is not usable: its board vi does not exist (create it with /kanban board create vi, or mt kanban board create vi)' };
      expect(start()).toEqual(missing);
      expect(service.previewWorkflow({ workflow: 'vi-sync', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA, board: 'default' })).toEqual(missing);
      createBoard(h.db, 'vi', ALICE, NOW);
      archiveBoard(h.db, 'vi', ALICE, NOW);
      expect(start()).toEqual({ ok: false, code: 'board_archived', message: 'workflow vi-sync is not usable: its board vi is archived, and nothing is added to it (name another board in its file)' });
      expect(tasks()).toBe(0);
      createBoard(h.db, 'old', ALICE, NOW);
      archiveBoard(h.db, 'old', ALICE, NOW);
      expect(start({ workflow: 'plain', board: 'old' })).toEqual({ ok: false, code: 'board_archived', message: 'board old is archived; nothing is added to it' });
    });

    it("writes the file's board into the preview's DAG", () => {
      createBoard(h.db, 'vi', ALICE, NOW);
      const r = service.previewWorkflow({ workflow: 'vi-sync', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA, board: 'default' });
      if (!r.ok) throw new Error(r.message);
      expect(r.dag.board).toBe('vi');
    });
  });

  describe('step 0', () => {
    beforeEach(() => {
      createBoard(h.db, 'vi', ALICE, NOW);
      createBoard(h.db, 'research', ALICE, NOW);
    });

    it("answers a chat start's redelivery on the file's board, also once the file cannot be read, and refuses it once the file names another or none", () => {
      const first = made(start({ idempotencyKey: 'lark:om_1' }));
      expect(made(start({ idempotencyKey: 'lark:om_1' }))).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
      unlinkSync(join(wf, 'vi-sync.yaml'));
      expect(made(start({ idempotencyKey: 'lark:om_1' })).existing).toBe(true);
      writeFileSync(join(wf, 'vi-sync.yaml'), 'board: vi\nsteps: [unclosed\n');
      expect(made(start({ idempotencyKey: 'lark:om_1' })).existing).toBe(true);
      writeFileSync(join(wf, 'vi-sync.yaml'), VI_SYNC.replace('board: vi', 'board: research'));
      expect(start({ idempotencyKey: 'lark:om_1' })).toMatchObject({ ok: false, code: 'other_board' });
      writeFileSync(join(wf, 'vi-sync.yaml'), VI_SYNC.replace('board: vi\n', ''));
      expect(start({ idempotencyKey: 'lark:om_1' })).toMatchObject({ ok: false, code: 'other_board' });
    });

    it('answers a terminal start with --key and no --board the same way, and compares one with --board as today', () => {
      const op = { createdBy: 'operator:me', createdVia: OPERATOR, idempotencyKey: 'weekly' };
      made(start({ ...op, board: null }));
      expect(made(start({ ...op, board: null })).existing).toBe(true);
      unlinkSync(join(wf, 'vi-sync.yaml'));
      expect(made(start({ ...op, board: null })).existing).toBe(true);
      expect(start({ ...op, board: 'default' })).toMatchObject({ ok: false, code: 'other_board' });
    });

    it('refuses invalid a key reused for another workflow whose file is missing, its instance on another board', () => {
      made(start({ idempotencyKey: 'lark:om_9' }));
      expect(start({ workflow: 'gone', idempotencyKey: 'lark:om_9' })).toMatchObject({ ok: false, code: 'invalid' });
    });
  });

  describe('an apply, the lists and the reads', () => {
    const preview = () => {
      const r = service.previewWorkflow({ workflow: 'vi-sync', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA, board: 'default' });
      if (!r.ok) throw new Error(r.message);
      return JSON.parse(JSON.stringify(r.dag)) as Record<string, unknown>;
    };
    const apply = (dag: unknown, over: { idempotencyKey?: string; dryRun?: boolean } = {}) =>
      service.applyDag({ dag, createdBy: 'operator:me', createdVia: OPERATOR, ...over });

    it("makes a preview's DAG on the file's board, and refuses one whose board was edited or deleted, a dry run too", () => {
      createBoard(h.db, 'vi', ALICE, NOW);
      const dag = preview();
      const edited = { ...dag, board: 'default' };
      const { board: _gone, ...deleted } = dag;
      const refusal = { ok: false, code: 'other_board', message: 'the DAG names workflow vi-sync, which puts its tasks on board vi, not default' };
      expect(apply(edited)).toEqual(refusal);
      expect(apply(deleted)).toEqual(refusal);
      expect(apply(edited, { dryRun: true })).toEqual(refusal);
      expect(tasks()).toBe(0);
      const r = apply(dag);
      expect(r.ok && 'instance' in r ? r.instance.board : r).toBe('vi');
    });

    it('makes the edited DAG once its workflow is null, or its file is gone, and answers a repeat before the check', () => {
      createBoard(h.db, 'vi', ALICE, NOW);
      const dag = preview();
      const first = apply(dag, { idempotencyKey: 'k1' });
      expect(first.ok).toBe(true);
      writeFileSync(join(wf, 'vi-sync.yaml'), VI_SYNC.replace('board: vi', 'board: research'));
      expect(apply(dag, { idempotencyKey: 'k1' })).toMatchObject({ ok: true, existing: true });
      const r = apply({ ...dag, board: 'default', workflow: null });
      expect(r.ok && 'instance' in r ? [r.instance.board, r.instance.name] : r).toEqual(['default', null]);
      unlinkSync(join(wf, 'vi-sync.yaml'));
      const gone = apply({ ...dag, board: 'default' });
      expect(gone.ok && 'instance' in gone ? gone.instance.board : gone).toBe('default');
    });

    it("refuses an apply on its file's archived board naming the workflow", () => {
      createBoard(h.db, 'vi', ALICE, NOW);
      const dag = preview();
      archiveBoard(h.db, 'vi', ALICE, NOW);
      expect(apply(dag)).toEqual({
        ok: false,
        code: 'board_archived',
        message: 'workflow vi-sync is not usable: its board vi is archived, and nothing is added to it (name another board in its file)',
      });
    });

    it("lists a workflow on a missing board as not usable, leaving it out of unknown_workflow's usable ones", () => {
      const list = service.workflows();
      expect(list.usable.map((w) => w.name)).toEqual(['plain']);
      expect(list.broken).toEqual([{ name: 'vi-sync', problem: 'its board vi does not exist (create it with /kanban board create vi, or mt kanban board create vi)' }]);
      const r = start({ workflow: 'nowhere' });
      expect(r.ok ? '' : r.message).toMatch(/the usable ones are plain;/);
      createBoard(h.db, 'vi', ALICE, NOW);
      expect(service.workflows().usable.map((w) => w.name)).toEqual(['plain', 'vi-sync']);
    });

    it("reads a file's board and a board by name for chat", () => {
      expect(service.workflowBoard('vi-sync')).toEqual({ file: 'read', board: 'vi' });
      expect(service.workflowBoard('plain')).toEqual({ file: 'read', board: undefined });
      expect(service.workflowBoard('gone')).toEqual({ file: 'unreadable' });
      expect(service.boardNamed('vi')).toBeUndefined();
      createBoard(h.db, 'vi', ALICE, NOW);
      archiveBoard(h.db, 'vi', ALICE, NOW);
      expect(service.boardNamed('vi')).toMatchObject({ name: 'vi' });
      expect(service.boardNamed('vi')?.archivedAt).not.toBeNull();
    });
  });
});
