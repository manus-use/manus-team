import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import type { Role } from '../src/roles.js';
import { role } from './helpers/dispatch.js';

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
