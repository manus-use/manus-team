import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRun } from '../src/db/kanban.js';
import { getRun, getTask } from '../src/db/kanban-read.js';
import { checkOutputs, type OutputBounds } from '../src/kanban/routing.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * A run's completion against its step's outputs (workflow routing spec §2.2):
 * each type's refusal, word for word, the first in the declared order; a list
 * a fan-out reads held to a list param's rules; checked on a work report, not
 * on an approval; a person's done refused; before the gates; and the run left
 * undecided, so its next report is taken.
 */

const SECRET = 'sk-live-1234567890';
const NONE: OutputBounds = { fanned: new Set(), titledItems: new Set(), titled: new Set() };

describe('checkOutputs', () => {
  it("refuses each type's wrong value, word for word, and a missing output", () => {
    expect(checkOutputs({ reachable: 'boolean' }, {}, NONE)).toBe('output reachable is missing');
    expect(checkOutputs({ reachable: 'boolean' }, undefined, NONE)).toBe('output reachable is missing');
    expect(checkOutputs({ reachable: 'boolean' }, { reachable: 'yes' }, NONE)).toBe('output reachable must be true or false; got "yes"');
    expect(checkOutputs({ score: 'number' }, { score: '7' }, NONE)).toBe('output score must be a number; got "7"');
    expect(checkOutputs({ note: 'string' }, { note: 3 }, NONE)).toBe('output note must be text; got 3');
    expect(checkOutputs({ note: 'string' }, { note: 'n'.repeat(9120) }, NONE)).toBe('output note is 9120 bytes; at most 8192');
    expect(checkOutputs({ kind: { enum: ['cve', 'supplychain'] } }, { kind: 'library' }, NONE)).toBe('output kind must be one of cve, supplychain; got "library"');
    const list = { packages: { list: 'string', max: 50 } } as const;
    expect(checkOutputs(list, { packages: Array.from({ length: 63 }, (_, i) => `p${i}`) }, NONE)).toBe('output packages must be a list of at most 50 strings; got 63');
    expect(checkOutputs(list, { packages: 'lodash' }, NONE)).toBe('output packages must be a list of at most 50 strings; got a string');
    expect(checkOutputs(list, { packages: ['a', 'b', 'c', 7] }, NONE)).toBe('item 4 of output packages must be text; got 7');
    expect(checkOutputs({ reachable: 'boolean', score: 'number' }, { score: 'x', reachable: 'y' }, NONE)).toBe('output reachable must be true or false; got "y"');
    expect(checkOutputs({ reachable: 'boolean', packages: list.packages }, { reachable: false, packages: [], other: { free: true } }, NONE)).toBeUndefined();
  });

  it('holds a list a fan-out reads to a list param\'s rules, and its items and a titled text to one line', () => {
    clearSecrets();
    addSecrets([SECRET]);
    try {
      const fanned: OutputBounds = { fanned: new Set(['packages']), titledItems: new Set(['packages']), titled: new Set(['note']) };
      const list = { packages: { list: 'string', max: 50 } } as const;
      expect(checkOutputs(list, { packages: ['lodash', ' '] }, fanned)).toBe('item 2 of output packages is empty');
      expect(checkOutputs(list, { packages: ['lodash', 'qs', 'lodash '] }, fanned)).toBe('output packages names "lodash" twice; each item labels its task');
      expect(checkOutputs(list, { packages: [`x ${SECRET}`] }, fanned)).toBe('an item of output packages holds a known secret');
      expect(checkOutputs(list, { packages: ['a', 'b', 'c', 'd', 'two\nlines'] }, fanned)).toBe(
        'item 5 of output packages holds a line break, a control character or a bidi control, and an item lands in a title',
      );
      expect(checkOutputs(list, { packages: ['a', 'a'] }, NONE)).toBeUndefined();
      expect(checkOutputs({ note: 'string' }, { note: 'two\nlines' }, fanned)).toBe('output note holds a line break, a control character or a bidi control, and it lands in a title');
      expect(checkOutputs({ note: 'string' }, { note: 'two\nlines' }, NONE)).toBeUndefined();
    } finally {
      clearSecrets();
    }
  });
});

describe('a completion checked against its outputs', () => {
  let h: TestDb;
  let b: ViBoard;
  beforeEach(() => {
    clearSecrets();
    h = testDb();
    b = viBoard(h);
  });
  afterEach(() => {
    clearSecrets();
    h.close();
  });

  const OUTPUTS = { kind: 'cve', verify: false, patch: false, bnpm: false, packages: ['lodash', 'minimist', 'qs'] };

  function intake() {
    const r = madeOf(b.service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
    return r.tasks[0]?.task.taskId ?? '';
  }

  it('refuses a work report missing an output before its gates run, the run left undecided, and takes the next', async () => {
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    assignee: vi-coordinator\n    outputs:', '    assignee: vi-coordinator\n    gates:\n      - { command: "true", timeout_s: 5 }\n    outputs:'));
    const taskId = intake();
    const run = claimed(h.db, taskId);
    const { packages: _packages, ...rest } = OUTPUTS;
    // With no checks configured, a task with gates is refused gates_cannot_run: invalid means no gate ran.
    expect(await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'triaged', metadata: rest })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'output packages is missing',
    });
    expect(getRun(h.db, run.runId)?.outcome).toBeNull();
    expect(await b.service.complete(taskId, { kind: 'run', runId: run.runId }, { summary: 'triaged', metadata: OUTPUTS })).toMatchObject({ ok: false, code: 'gates_cannot_run' });
  });

  it('checks a complete from open and a review, and not an approval, nor a step with no outputs', async () => {
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW.replace('    assignee: vi-coordinator\n    outputs:', '    assignee: vi-coordinator\n    reviewer: verifier\n    outputs:'));
    const taskId = intake();
    const run = claimed(h.db, taskId);
    const by = { kind: 'run', runId: run.runId } as const;
    expect(await b.service.requestReview(taskId, by, { summary: 'x', metadata: { ...OUTPUTS, kind: 'library' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await b.service.complete(taskId, by, { summary: 'x', metadata: { ...OUTPUTS, kind: 'library' } })).toEqual({
      ok: false,
      code: 'invalid',
      message: 'output kind must be one of cve, supplychain; got "library"',
    });
    expect(await b.service.complete(taskId, by, { summary: 'x', metadata: OUTPUTS })).toMatchObject({ ok: true, task: { phase: 'review' } });
    closeRun(h.db, run.runId, NOW);
    const review = claimed(h.db, taskId);
    expect(await b.service.complete(taskId, { kind: 'run', runId: review.runId }, { summary: 'LGTM' })).toMatchObject({ ok: true, task: { phase: 'done' } });
  });

  it("refuses a person's done on a step with outputs, as it carries no metadata", async () => {
    const taskId = intake();
    const r = await b.service.complete(taskId, { kind: 'person', principal: ALICE }, { summary: 'done by hand' });
    expect(r).toEqual({ ok: false, code: 'invalid', message: 'output kind is missing' });
    expect(getTask(h.db, taskId)?.phase).toBe('open');
  });
});
