import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { migrate, openDb } from '../src/db/open.js';
import { workflowRouting } from '../src/kanban/workflow.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VI_ROLES, VI_WORKFLOW, madeOf, viBoard, type ViBoard } from './helpers/routing.js';

/**
 * Conditions are workflow starts' only (workflow routing spec §13.5): `preview
 * --json` refused for a file using any routing key, outputs alone included,
 * naming the keys; `apply` and `apply --dry-run` refusing a DAG labelled with
 * such a file, after a repeat by key is answered, and checking nothing for a file
 * that cannot be read.
 */

const REFUSED = 'workflow vi-workflow uses outputs, when, for_each over an output, on_gave_up, handler, which a DAG cannot carry: start it with workflow start';
/** The vi file with nothing but its first step, and no routing key. */
const PLAIN = 'board: vi\nparams:\n  case: { required: true }\nsteps:\n  intake:\n    title: "{{case}} · intake"\n    assignee: vi-coordinator\n';

const DAG = {
  format: 1,
  workflow: 'vi-workflow',
  params: { case: 'CVE-1' },
  board: 'vi',
  tasks: [{ ref: 'intake', title: 'CVE-1 · intake', assignee: 'vi-coordinator' }],
};

describe('a DAG labelled with a routed file', () => {
  let h: TestDb;
  let b: ViBoard;
  beforeEach(() => {
    clearSecrets();
    h = testDb();
    b = viBoard(h);
  });
  afterEach(() => h.close());

  const apply = (dag: unknown, extra: Record<string, unknown> = {}) =>
    b.service.applyDag({ dag, createdBy: 'operator:me', createdVia: { kind: 'operator' }, ...extra });

  it('is refused by apply and apply --dry-run, and applied with no label', () => {
    expect(apply(DAG)).toEqual({ ok: false, code: 'invalid', message: REFUSED });
    expect(apply(DAG, { dryRun: true })).toEqual({ ok: false, code: 'invalid', message: REFUSED });
    const made = madeOf(apply({ ...DAG, workflow: null }));
    expect(made.instance.name).toBeNull();
    expect(made.tasks.map((t) => t.task.title)).toEqual(['CVE-1 · intake']);
  });

  it('answers a repeat by key first, and checks nothing for a file that cannot be read', () => {
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), PLAIN);
    const first = madeOf(apply(DAG, { idempotencyKey: 'k' }));
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), VI_WORKFLOW);
    expect(madeOf(apply(DAG, { idempotencyKey: 'k' }))).toMatchObject({ existing: true, instance: { instanceId: first.instance.instanceId } });
    expect(apply(DAG, { idempotencyKey: 'k2' })).toEqual({ ok: false, code: 'invalid', message: REFUSED });
    rmSync(join(b.dir, 'vi-workflow.yaml'));
    expect(madeOf(apply(DAG, { idempotencyKey: 'k3' })).existing).toBe(false);
  });

  it("reads a file's routing keys alone, outputs alone included", () => {
    expect(workflowRouting(b.dir, 'vi-workflow')).toEqual({ file: 'read', keys: ['outputs', 'when', 'for_each over an output', 'on_gave_up', 'handler'] });
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), PLAIN.replace('assignee: vi-coordinator\n', 'assignee: vi-coordinator\n    outputs: { verify: boolean }\n'));
    expect(workflowRouting(b.dir, 'vi-workflow')).toEqual({ file: 'read', keys: ['outputs'] });
    writeFileSync(join(b.dir, 'vi-workflow.yaml'), PLAIN);
    expect(workflowRouting(b.dir, 'vi-workflow')).toEqual({ file: 'read', keys: [] });
    expect(workflowRouting(b.dir, 'nope')).toEqual({ file: 'unreadable' });
  });
});

describe('mt kanban workflow preview --json of a routed file', () => {
  let f: MtFixture;
  beforeEach(() => {
    clearSecrets();
    f = mtFixture();
    for (const name of VI_ROLES) {
      mkdirSync(join(f.home, 'roles', name), { recursive: true });
      writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
    }
    mkdirSync(join(f.home, 'workflows'));
    writeFileSync(join(f.home, 'workflows', 'vi-workflow.yaml'), VI_WORKFLOW);
    const d = openDb(join(f.home, 'team.db'));
    migrate(d, SCHEMA_DIR);
    d.close();
  });
  afterEach(() => {
    clearSecrets();
    f.cleanup();
  });

  async function preview(...extra: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(['kanban', 'workflow', 'preview', 'vi-workflow', '--param', 'case=CVE-1', ...extra], {
      env: { ...f.env, HOME: f.root },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      stdinIsTTY: false,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('is refused, naming the keys the file uses, outputs alone included', async () => {
    expect(await preview('--json')).toEqual({ code: 1, out: '', err: `mt: ${REFUSED}` });
    writeFileSync(join(f.home, 'workflows', 'vi-workflow.yaml'), PLAIN.replace('assignee: vi-coordinator\n', 'assignee: vi-coordinator\n    outputs: { verify: boolean }\n'));
    expect(await preview('--json')).toEqual({
      code: 1,
      out: '',
      err: 'mt: workflow vi-workflow uses outputs, which a DAG cannot carry: start it with workflow start',
    });
  });
});
