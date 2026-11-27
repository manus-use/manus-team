import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/index.js';
import { loadTeam } from '../src/team.js';
import { closeRun, createBoard } from '../src/db/kanban.js';
import { eventsOf, getInstance, membersOf, routingDue } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { KanbanService } from '../src/kanban/service.js';
import { clearSecrets } from '../src/secrets.js';
import { ManualClock, SCHEMA_DIR } from './helpers/db.js';
import { ALICE, NOW, VIA, claimed } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VI_ROLES, VI_WORKFLOW, madeOf, viRoles } from './helpers/routing.js';

/**
 * Reconciliation (workflow routing spec §11): `mt kanban workflow reconcile`,
 * its answers, `--json`, its refusals and its nudge; and the service's startup
 * reconciliation of every instance with something due, nothing for one with
 * nothing, a handler never making one due, nor a blocked member with no route
 * due; and a reconciliation's fault marked and said once, mt's error a line.
 */

let f: MtFixture;
let db: Db;
let service: KanbanService;
beforeEach(() => {
  clearSecrets();
  f = mtFixture((workspace) => `workspace: ${workspace}\nkanban:\n  enabled: true\nagent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n`);
  for (const name of VI_ROLES) {
    mkdirSync(join(f.home, 'roles', name), { recursive: true });
    writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  }
  mkdirSync(join(f.home, 'workflows'));
  writeFileSync(join(f.home, 'workflows', 'vi-workflow.yaml'), VI_WORKFLOW);
  db = openDb(join(f.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  createBoard(db, 'vi', ALICE, NOW);
  service = new KanbanService({ db, roles: viRoles(), workspaces: new Set(['default']), supervisedRoles: true, workflowsDir: join(f.home, 'workflows'), clock: new ManualClock(NOW) });
});
afterEach(() => {
  clearSecrets();
  db.close();
  f.cleanup();
});

/** An instance whose intake's completion faulted in its routing, the fault gone since: va is due. */
async function faulted(): Promise<string> {
  const w = madeOf(service.startWorkflow({ workflow: 'vi-workflow', params: { from: 'json', params: { case: 'CVE-1' } }, createdBy: ALICE, createdVia: VIA }));
  const intake = w.tasks[0]?.taskId ?? '';
  db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON kanban_workflow_settled BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const run = claimed(db, intake);
  await service.complete(intake, { kind: 'run', runId: run.runId }, { summary: 'x', metadata: { kind: 'cve', verify: false, patch: false, bnpm: false, packages: ['lodash', 'qs'] } });
  closeRun(db, run.runId, NOW);
  db.exec('DROP TRIGGER boom');
  return w.instance.instanceId;
}

async function mt(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['kanban', 'workflow', 'reconcile', ...argv], { env: { ...f.env, HOME: f.root }, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('mt kanban workflow reconcile', () => {
  it('decides what is due, answering each decision, then nothing the second time', async () => {
    const id = await faulted();
    const first = await mt(id);
    expect(first.code).toBe(0);
    expect(first.out).toBe(
      `reconciled ${id}: va made; verify skipped (intake.verify is false); registry skipped (intake.bnpm is false); patch skipped (intake.patch is false)`,
    );
    expect(first.err).toMatch(/^mt: no gateway answered at /);
    expect(getInstance(db, id)?.routingFailedAt).toBeNull();
    expect(await mt(id)).toEqual({ code: 0, out: `${id}: nothing was due`, err: '' });
  });

  it('answers a fault in one line, the instance marked and the fault said once', async () => {
    const id = await faulted();
    db.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = NULL').run();
    // Not a temporary trigger: mt opens the database on a connection of its own.
    db.exec("CREATE TRIGGER made BEFORE INSERT ON kanban_tasks BEGIN SELECT RAISE(ABORT, 'no task can be made'); END;");
    expect(await mt(id)).toEqual({ code: 1, out: '', err: `mt: the routing of ${id} failed: no task can be made; the gateway tries again` });
    expect(getInstance(db, id)?.routingFailedAt).not.toBeNull();
    expect(await mt(id)).toMatchObject({ code: 1 });
    db.exec('DROP TRIGGER made');
    const intake = membersOf(db, id)[0]?.taskId ?? '';
    const failed = eventsOf(db, intake).filter((e) => e.kind === 'workflow_route_failed').map((e) => e.payload);
    expect(failed.at(-1)).toEqual({ workflow: id, workflowName: 'vi-workflow', error: 'no task can be made', first: true });
    expect(failed.filter((p) => (p as { first: boolean }).first).length).toBe(2);
  });

  it('answers --json with each decision and its tasks, and refuses an unknown instance and another board', async () => {
    const id = await faulted();
    const r = JSON.parse((await mt(id, '--json')).out) as { ok: boolean; instance_id: string; decisions: Array<{ step: string; outcome: string; task_ids: string[] }> };
    const va = membersOf(db, id).find((m) => m.step === 'va')?.taskId;
    expect(r).toMatchObject({ ok: true, instance_id: id });
    expect(r.decisions[0]).toEqual({ step: 'va', outcome: 'made', task_ids: [va] });
    expect(await mt('w_nope')).toEqual({ code: 1, out: '', err: 'mt: no workflow instance w_nope' });
    expect((await mt(id, '--board', 'default')).err).toBe(`mt: instance ${id} is on board vi, not default`);
  });
});

describe("the startup's reconciliation", () => {
  it('reconciles every instance with something due, and says nothing for one with nothing', async () => {
    await faulted();
    expect(service.reconcileAll()).toEqual({ instances: 1, steps: 4 });
    expect(service.reconcileAll()).toEqual({ instances: 0, steps: 0 });
  });

  it('marks an instance whose reconciliation faults, and says it once', async () => {
    const id = await faulted();
    db.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = NULL').run();
    db.exec("CREATE TEMP TRIGGER made BEFORE INSERT ON kanban_tasks BEGIN SELECT RAISE(ABORT, 'no task can be made'); END;");
    expect(service.reconcileAll()).toEqual({ instances: 0, steps: 0 });
    expect(getInstance(db, id)?.routingFailedAt).toBe(NOW);
    expect(service.retryRouting()).toBe(0);
    const intake = membersOf(db, id)[0]?.taskId ?? '';
    expect(eventsOf(db, intake).filter((e) => e.kind === 'workflow_route_failed' && (e.payload as { error: string }).error === 'no task can be made').length).toBe(1);
  });

  it('marks nothing when a reconciliation finds the database busy past its retries', async () => {
    const id = await faulted();
    db.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = NULL').run();
    // Every commit of the reconciliation's 16 attempts finds the database busy; a fault's own transaction would commit.
    const exec = db.exec.bind(db);
    let busy = 16;
    const spy = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (sql === 'COMMIT' && busy-- > 0) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return exec(sql);
    });
    try {
      expect(() => service.reconcileWorkflow(id)).toThrow('database is locked');
    } finally {
      spy.mockRestore();
    }
    expect(busy).toBe(0);
    expect(getInstance(db, id)?.routingFailedAt).toBeNull();
    const intake = membersOf(db, id)[0]?.taskId ?? '';
    expect(eventsOf(db, intake).filter((e) => e.kind === 'workflow_route_failed' && (e.payload as { error: string }).error === 'database is locked')).toEqual([]);
    expect(service.reconcileAll()).toEqual({ instances: 1, steps: 4 });
  });

  it('counts a blocked member only when its step routes and a route is due', () => {
    writeFileSync(
      join(f.home, 'workflows', 'blocks.yaml'),
      `board: vi
steps:
  a:
    title: a
    assignee: vi-coordinator
  b:
    title: b
    assignee: verifier
    on_blocked: { route: h }
  h:
    title: h
    assignee: vi-coordinator
    handler: true
`,
    );
    const w = madeOf(service.startWorkflow({ workflow: 'blocks', params: { from: 'json', params: {} }, createdBy: ALICE, createdVia: VIA }));
    const [a, bb] = [w.tasks[0]?.taskId ?? '', w.tasks[1]?.taskId ?? ''];
    const block = (taskId: string) => {
      const run = claimed(db, taskId);
      expect(service.block(taskId, { kind: 'run', runId: run.runId }, { kind: 'capability', reason: 'no network' }).ok).toBe(true);
      closeRun(db, run.runId, NOW);
    };
    block(a);
    expect(routingDue(db)).toEqual([]);
    db.exec("CREATE TEMP TRIGGER noroute BEFORE INSERT ON kanban_workflow_routes BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    block(bb);
    db.exec('DROP TRIGGER noroute');
    db.prepare('UPDATE kanban_workflow_instances SET routing_failed_at = NULL').run();
    expect(routingDue(db)).toEqual([w.instance.instanceId]);
    expect(service.reconcileAll()).toEqual({ instances: 1, steps: 1 });
    expect(routingDue(db)).toEqual([]);
  });

  it('says a plan it cannot read, and reconciles nothing, never throwing', async () => {
    await faulted();
    // A plan no JSON reader takes, as only a damaged file could hold.
    db.pragma('ignore_check_constraints = ON');
    db.prepare("UPDATE kanban_workflow_instances SET plan = 'not json'").run();
    db.pragma('ignore_check_constraints = OFF');
    const notes: string[] = [];
    expect(service.reconcileAll((l) => notes.push(l))).toEqual({ instances: 0, steps: 0 });
    expect(notes).toEqual([expect.stringMatching(/^workflows: reading the instances to reconcile failed: /)]);
  });

  it("is said in one note at the gateway's start, before its dispatcher's first pass", async () => {
    const id = await faulted();
    db.close();
    const env = {
      MT_HOME: f.home,
      MT_DB: join(f.home, 'team.db'),
      MT_WORKSPACE: f.workspace,
      MT_OWNER_OPEN_ID: 'ou_owner',
      LARK_APP_ID: 'cli_app',
      LARK_APP_SECRET: 'app-secret',
      MT_AGENT_COMMAND: 'bytesec',
      MT_AGENT_DRIVER: 'structured-cli',
      MT_AGENT_UNSUPERVISED: 'true',
    };
    const loaded = loadConfig(env, () => undefined);
    const config = { ...loaded, kanban: { ...loaded.kanban, enabled: true } };
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const gateway = await createGateway(config, loadTeam(config, env));
    try {
      expect(lines.filter((l) => l.includes('workflows: reconciled')).map((l) => l.replace(/^.*?workflows:/, 'workflows:'))).toEqual(['workflows: reconciled 1 instance, 4 steps decided\n']);
    } finally {
      await gateway.stop();
      vi.restoreAllMocks();
    }
    db = openDb(join(f.home, 'team.db'));
    expect(getInstance(db, id)?.routingFailedAt).toBeNull();
  });
});
