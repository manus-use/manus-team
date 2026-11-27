import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clauseText, stepCounts, stepWords, whenText, type StepShape } from '../src/kanban/routing.js';
import { clearSecrets } from '../src/secrets.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VI_ROLES, VI_WORKFLOW } from './helpers/routing.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * What a check says of each step (workflow routing spec §6): `mt workflow check
 * <name>`'s one line a step after the workflow's, the counts in its line with or
 * without a name, and the words, clause by clause; and a file using no routing
 * key said as before.
 */

const BOARDS_NOTE = 'note: the gateway checks the board when the workflow is used, not here: this check opens no database';

describe('mt workflow check, of a routed file', () => {
  let f: MtFixture;
  beforeEach(() => {
    clearSecrets();
    f = mtFixture();
    for (const name of [...VI_ROLES, 'worker', 'reviewer']) {
      mkdirSync(join(f.home, 'roles', name), { recursive: true });
      writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
    }
    mkdirSync(join(f.home, 'workflows'));
    writeFileSync(join(f.home, 'workflows', 'vi-workflow.yaml'), VI_WORKFLOW);
    writeFileSync(join(f.home, 'workflows', 'vendor-eval.yaml'), VENDOR_EVAL);
  });
  afterEach(() => {
    clearSecrets();
    f.cleanup();
  });

  it('prints, after its line, one line a step, in the words of §6', async () => {
    expect(await f.run(['workflow', 'check', 'vi-workflow'])).toEqual({
      code: 0,
      out: [
        'vi-workflow: ok, 8 steps (1 always, 6 on results, 1 handler); params: case (required); board vi',
        '  intake: always',
        '  va: when intake.kind is cve; on gave up, routed to escalate',
        '  escalate: handler for va, standing in',
        '  verify: when intake.verify is true and va.reachable is true',
        '  exposure: per item of intake.packages',
        '  registry: when intake.bnpm is true',
        '  report: when its parents are settled',
        '  patch: when intake.patch is true',
        BOARDS_NOTE,
      ].join('\n'),
      err: '',
    });
  });

  it('counts the steps in each line without a name, and says a file using no routing key as before', async () => {
    expect(await f.run(['workflow', 'check'])).toEqual({
      code: 0,
      out: [
        'vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)',
        'vi-workflow: ok, 8 steps (1 always, 6 on results, 1 handler); params: case (required); board vi',
        BOARDS_NOTE,
      ].join('\n'),
      err: '',
    });
    expect((await f.run(['workflow', 'check', 'vendor-eval'])).out).toBe('vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)');
  });
});

describe('the words of a step', () => {
  it('says each clause, and a when with its any group', () => {
    expect(clauseText({ step: 'va', output: 'reachable', is: true })).toBe('va.reachable is true');
    expect(clauseText({ step: 'va', output: 'reachable', is: false })).toBe('va.reachable is false');
    expect(clauseText({ step: 'intake', output: 'kind', equals: 'cve' })).toBe('intake.kind is cve');
    expect(clauseText({ step: 'va', output: 'score', equals: 7 })).toBe('va.score is 7');
    expect(clauseText({ step: 'intake', output: 'kind', in: ['cve', 'ghsa'] })).toBe('intake.kind is one of cve, ghsa');
    expect(clauseText({ step: 'va', output: 'score', at_least: 7 })).toBe('va.score is at least 7');
    expect(clauseText({ step: 'va', output: 'score', at_most: 9.5 })).toBe('va.score is at most 9.5');
    expect(clauseText({ step: 'va', state: 'gave_up' })).toBe('va gave up');
    expect(clauseText({ step: 'va', state: 'blocked' })).toBe('va blocked');
    expect(clauseText({ step: 'va', state: 'skipped' })).toBe('va is skipped');
    expect(clauseText({ step: 'va', state: 'done' })).toBe('va is done');
    expect(
      whenText([
        { step: 'va', state: 'done' },
        { any: [{ step: 'va', output: 'score', at_least: 9 }, { step: 'intake', output: 'kind', equals: 'ghsa' }] },
      ]),
    ).toBe('va is done and (va.score is at least 9 or intake.kind is ghsa)');
  });

  it("says a pending step over a list param, a fan-out's bound when asked, both routes, a helper, and counts", () => {
    const steps: StepShape[] = [
      { step: 'a', made: 'start', on_blocked: { route: 'h' }, on_gave_up: { route: 'h' } },
      { step: 'b', made: 'decide', for_each: { param: 'vendors' }, on_blocked: 'wait', on_gave_up: 'wait' },
      { step: 'c', made: 'decide', for_each: { step: 'a', output: 'list' }, when: [{ step: 'a', state: 'done' }], on_blocked: 'wait', on_gave_up: 'wait' },
      { step: 'h', made: 'route', handler: true, on_blocked: 'wait', on_gave_up: 'wait' },
    ];
    expect(steps.map((s) => stepWords(steps, s, () => 50))).toEqual([
      'always; on blocked, routed to h; on gave up, routed to h',
      'per item of vendors',
      'per item of a.list, at most 50, when a is done',
      'handler for a',
    ]);
    expect(stepCounts(steps)).toEqual({ always: 1, onResults: 2, handlers: 1 });
  });
});
