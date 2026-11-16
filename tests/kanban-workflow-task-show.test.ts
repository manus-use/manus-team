import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { createTask } from '../src/db/kanban.js';
import { taskView } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { renderShow } from '../src/kanban/chat-render.js';
import { KanbanService } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { VIA } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * `task show` of a member (spec §21.10): one line, its instance, step and item,
 * in chat and at the terminal, and `workflow` in `--json`; nothing for a task
 * that is no member, and `mt kanban task show` working on a database not yet
 * migrated to the workflows' tables.
 */

let f: MtFixture;
let db: Db;

beforeEach(() => {
  clearSecrets();
  f = mtFixture();
  for (const name of ['worker', 'reviewer']) {
    mkdirSync(join(f.home, 'roles', name), { recursive: true });
    writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  }
  mkdirSync(join(f.home, 'workflows'));
  writeFileSync(join(f.home, 'workflows', 'vendor-eval.yaml'), VENDOR_EVAL);
});
afterEach(() => {
  clearSecrets();
  db.close();
  f.cleanup();
});

async function mt(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['kanban', ...argv], { env: { ...f.env, HOME: f.root }, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('task show of a member', () => {
  it('says its instance, step and item, in chat, at the terminal and in --json', async () => {
    db = openDb(join(f.home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    const service = new KanbanService({
      db,
      roles: new Map([['worker', role('worker')], ['reviewer', role('reviewer')]]),
      workspaces: new Set(['default']),
      workflowsDir: join(f.home, 'workflows'),
    });
    const r = service.startWorkflow({
      workflow: 'vendor-eval',
      params: { from: 'json', params: { topic: 'logs', vendors: ['acme'] } },
      createdBy: 'operator:me',
      createdVia: { kind: 'operator' },
    });
    if (!r.ok) throw new Error(r.message);
    const member = r.tasks[1]?.taskId ?? '';
    const id = r.instance.instanceId;
    const view = taskView(db, member);
    if (view === undefined) throw new Error('no view');
    expect(renderShow(view, []).split('\n')).toContain(`workflow: \`${id}\` vendor-eval, step evaluate, item acme`);
    expect((await mt(['task', 'show', member])).out.split('\n')).toContain(`workflow: ${id} vendor-eval, step evaluate, item acme`);
    expect(JSON.parse((await mt(['task', 'show', member, '--json'])).out)).toMatchObject({
      task: { workflow: { instance_id: id, name: 'vendor-eval', step: 'evaluate', item: 'acme' } },
    });
    const plain = createTask(db, { title: 'Not a member', createdBy: 'operator:me', createdVia: VIA }, Date.now());
    if (!plain.ok) throw new Error(plain.message);
    expect((await mt(['task', 'show', plain.task.taskId])).out).not.toContain('workflow:');
    expect(JSON.parse((await mt(['task', 'show', plain.task.taskId, '--json'])).out)).toMatchObject({ task: { workflow: null } });
  });

  it('works on a database not yet migrated to the workflows', async () => {
    const dir = mkdtempSync(join(f.root, 'schema-'));
    for (const name of readdirSync(SCHEMA_DIR)) if (/^00[1-8]_.*\.sql$/.test(name)) copyFileSync(join(SCHEMA_DIR, name), join(dir, name));
    db = openDb(join(f.home, 'team.db'));
    migrate(db, dir);
    rmSync(dir, { recursive: true, force: true });
    const t = createTask(db, { title: 'From before', createdBy: 'operator:me', createdVia: VIA }, Date.now());
    if (!t.ok) throw new Error(t.message);
    const r = await mt(['task', 'show', t.task.taskId]);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[0]).toBe(`From before (${t.task.taskId}): ready`);
  });
});
