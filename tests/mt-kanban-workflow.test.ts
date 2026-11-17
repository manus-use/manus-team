import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { createBoard } from '../src/db/kanban.js';
import { getInstance, getTask, subscriptionsOf } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { MASK, clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { NOW } from './helpers/kanban.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * The operator's workflow commands (workflows spec §6, §10): `mt kanban workflow
 * preview`, with `--json` writing the DAG file, `start`, `apply` and `apply
 * --dry-run`, `list`, `instances`, `show` with `--dag`, and `archive`; their
 * plain and `--json` answers, the nudge, and an unmigrated database.
 */

const ME = `operator:${userInfo().username}`;
const SECRET = 'sk-live-1234567890';

let f: MtFixture;
let gateway: Db;
let server: WorkerServer | undefined;
let nudges: number;

function config(enabled: boolean): (workspace: string) => string {
  return (workspace) =>
    [
      `workspace: ${workspace}`,
      ...(enabled ? ['kanban:', '  enabled: true'] : []),
      'agent:',
      '  driver: structured-cli',
      '  command: bytesec',
      '  unsupervised: true',
      '',
    ].join('\n');
}

async function setUp(enabled = true): Promise<void> {
  clearSecrets();
  f = mtFixture(config(enabled));
  for (const name of ['worker', 'reviewer']) {
    mkdirSync(join(f.home, 'roles', name), { recursive: true });
    writeFileSync(join(f.home, 'roles', name, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  }
  mkdirSync(join(f.home, 'workflows'));
  writeFileSync(join(f.home, 'workflows', 'vendor-eval.yaml'), VENDOR_EVAL);
  writeFileSync(join(f.home, '.env'), `LARK_APP_SECRET=${SECRET}\n`, { mode: 0o600 });
  gateway = openDb(join(f.home, 'team.db'));
  migrate(gateway, SCHEMA_DIR);
  nudges = 0;
  server = await listenWorker(workerSocketPath(f.home), () => {
    nudges += 1;
    return { ok: true };
  });
}

beforeEach(async () => setUp());
afterEach(async () => {
  clearSecrets();
  await server?.close();
  server = undefined;
  gateway.close();
  f.cleanup();
});

async function mt(argv: string[], opts: { stdin?: string; env?: Record<string, string | undefined> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(['kanban', 'workflow', ...argv], {
    env: { ...f.env, HOME: f.root, ...opts.env },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdinIsTTY: false,
    stdin: async (max) => {
      const text = opts.stdin ?? '';
      return Buffer.byteLength(text) > max ? undefined : Buffer.from(text);
    },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const PARAMS = ['--param', 'topic=log storage', '--param', 'vendors=acme,globex'];
/** An instance's DAG hash, read from the table: what no answer may print. */
const hashOf = (id: string): string =>
  (gateway.prepare('SELECT dag_sha256 AS h FROM kanban_workflow_instances WHERE instance_id = ?').get(id) as { h: string } | undefined)?.h ?? 'none';
const count = (table: string): number => (gateway.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('mt kanban workflow preview', () => {
  it('prints the same summary as chat, and with --json the DAG file, byte for byte the same twice, every key written', async () => {
    const plain = await mt(['preview', 'vendor-eval', ...PARAMS]);
    expect(plain.code).toBe(0);
    expect(plain.out.split('\n')).toEqual([
      'vendor-eval would make 4 tasks, on board default:',
      '  shortlist   Shortlist vendors for log storage   role worker',
      '  evaluate:1  Evaluate acme for log storage       role worker  after shortlist               1 gate',
      '  evaluate:2  Evaluate globex for log storage     role worker  after shortlist               1 gate',
      '  recommend   Recommend a vendor for log storage  role worker  after evaluate:1, evaluate:2',
      'nothing was made: mt kanban workflow start vendor-eval, with these params, makes it',
    ]);
    const a = await mt(['preview', 'vendor-eval', ...PARAMS, '--json']);
    const b = await mt(['preview', 'vendor-eval', ...PARAMS, '--json']);
    expect(a).toEqual(b);
    const dag = JSON.parse(a.out) as { board: string; tasks: Array<Record<string, unknown>> };
    expect(dag.board).toBe('default');
    expect(Object.keys(dag.tasks[1] ?? {})).toEqual([
      'ref', 'step', 'item', 'title', 'body', 'assignee', 'reviewer', 'workspace', 'priority', 'contract', 'failure_limit', 'retry_on_crash', 'max_runtime_s', 'parents', 'gates',
    ]);
    expect(a.out).toBe(JSON.stringify(dag, null, 2));
    expect([count('kanban_tasks'), count('kanban_workflow_instances')]).toEqual([0, 0]);
  });

  it('writes a refusal on stderr and nothing on stdout, and leaves a person to the start, saying so', async () => {
    expect(await mt(['preview', 'vendor-eval', '--param', 'topic=x', '--json'])).toEqual({ code: 1, out: '', err: 'mt: workflow vendor-eval needs param vendors' });
    writeFileSync(join(f.home, 'workflows', 'ask.yaml'), 'params:\n  owner: { required: true }\nsteps:\n  ask: { title: Ask, assignee: "{{owner}}" }\n');
    expect((await mt(['preview', 'ask', '--param', 'owner=lark:on_bob'])).err).toBe(
      "mt: lark:on_bob is checked at the start, against the people this gateway knows; mt kanban workflow apply --dry-run on this preview's --json checks it now",
    );
    expect((await mt(['preview', 'nope'])).err).toMatch(/^mt: there is no workflow nope; the usable ones are /);
    expect((await mt(['preview', 'vendor-eval', '--param', 'topic'])).code).toBe(2);
  });

  it('opens no database: it works with none there', async () => {
    gateway.close();
    const { rmSync } = await import('node:fs');
    for (const name of readdirSync(f.home)) if (name.startsWith('team.db')) rmSync(join(f.home, name));
    expect((await mt(['preview', 'vendor-eval', ...PARAMS])).code).toBe(0);
    gateway = openDb(join(f.home, 'team.db'));
  });
});

describe('mt kanban workflow start', () => {
  it('starts it as the operator, answering every task, followed by no chat, and nudges the gateway', async () => {
    const r = await mt(['start', 'vendor-eval', ...PARAMS, '--key', 'ls-1']);
    expect(r.code).toBe(0);
    const [head, ...rows] = r.out.split('\n');
    expect(head).toMatch(/^started vendor-eval as w_[0-9a-z]+, on board default, 4 tasks$/);
    expect(rows.map((l) => l.trim().split(/\s{2,}/))).toEqual([
      [expect.stringMatching(/^k_/), 'shortlist', 'Shortlist vendors for log storage', 'role worker'],
      [expect.stringMatching(/^k_/), 'evaluate:1', 'Evaluate acme for log storage', 'role worker'],
      [expect.stringMatching(/^k_/), 'evaluate:2', 'Evaluate globex for log storage', 'role worker'],
      [expect.stringMatching(/^k_/), 'recommend', 'Recommend a vendor for log storage', 'role worker'],
    ]);
    expect(nudges).toBe(1);
    const id = /as (w_[0-9a-z]+)/.exec(head ?? '')?.[1] ?? '';
    const instance = getInstance(gateway, id);
    expect(instance).toMatchObject({ createdBy: ME, createdVia: { kind: 'operator' }, idempotencyKey: 'operator:ls-1' });
    const again = await mt(['start', 'vendor-eval', ...PARAMS, '--key', 'ls-1', '--json']);
    expect(JSON.parse(again.out)).toMatchObject({ ok: true, instance_id: id, existing: true, board: 'default', nudged: false });
    expect(nudges).toBe(1);
    const tasks = (JSON.parse(again.out) as { tasks: Array<{ task_id: string }> }).tasks;
    for (const t of tasks) expect(subscriptionsOf(gateway, t.task_id)).toEqual([]);
  });

  it("says the board is off when the config leaves kanban.enabled unset, and asks no gateway", async () => {
    await server?.close();
    server = undefined;
    gateway.close();
    f.cleanup();
    await setUp(false);
    const r = await mt(['start', 'vendor-eval', ...PARAMS, '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, existing: false, nudged: false });
    expect(r.err).toMatch(/^mt: the board is off on this gateway \(its config does not set kanban\.enabled\)/);
    expect(nudges).toBe(0);
  });

  it('puts it on --board, and refuses an unknown one', async () => {
    createBoard(gateway, 'research', ME, NOW);
    expect((await mt(['start', 'vendor-eval', ...PARAMS, '--board', 'research'])).out).toMatch(/on board research, 4 tasks/);
    expect(await mt(['start', 'vendor-eval', ...PARAMS, '--board', 'nowhere'])).toEqual({ code: 1, out: '', err: 'mt: there is no board nowhere' });
  });
});

describe('mt kanban workflow apply', () => {
  async function previewed(): Promise<string> {
    const path = join(f.root, 'dag.json');
    writeFileSync(path, (await mt(['preview', 'vendor-eval', ...PARAMS, '--json'])).out);
    return path;
  }

  it('with --dry-run makes every check, writes nothing, and lists each gate\'s command', async () => {
    const path = await previewed();
    const dry = await mt(['apply', path, '--dry-run']);
    expect(dry).toEqual({
      code: 0,
      out: [
        'would make 4 tasks, 4 links, 2 gates, on board default; nothing was made',
        '  shortlist   Shortlist vendors for log storage   role worker',
        '  evaluate:1  Evaluate acme for log storage       role worker  after shortlist               1 gate',
        '    gate: test -s evaluation.md (up to 30 s)',
        '  evaluate:2  Evaluate globex for log storage     role worker  after shortlist               1 gate',
        '    gate: test -s evaluation.md (up to 30 s)',
        '  recommend   Recommend a vendor for log storage  role worker  after evaluate:1, evaluate:2',
      ].join('\n'),
      err: '',
    });
    expect(JSON.parse((await mt(['apply', path, '--dry-run', '--json'])).out)).toMatchObject({ ok: true, dry_run: true, existing: false, board: 'default' });
    expect([count('kanban_tasks'), nudges]).toEqual([0, 0]);
  });

  it('makes exactly the DAG, a file edited since the preview changing nothing, a repeat by key existing', async () => {
    const path = await previewed();
    writeFileSync(join(f.home, 'workflows', 'vendor-eval.yaml'), 'steps: {}\n');
    const r = await mt(['apply', path, '--key', 'a-1', '--json']);
    const answer = JSON.parse(r.out) as { instance_id: string; existing: boolean; tasks: Array<{ ref: string }> };
    expect(answer).toMatchObject({ ok: true, existing: false, nudged: true });
    expect(answer.tasks.map((t) => t.ref)).toEqual(['shortlist', 'evaluate:1', 'evaluate:2', 'recommend']);
    expect((await mt(['apply', path, '--key', 'a-1'])).out.split('\n')[0]).toBe(
      `already made, as ${answer.instance_id}, on board default, 4 tasks; nothing new was made`,
    );
    expect(JSON.parse((await mt(['apply', path, '--key', 'a-1', '--dry-run', '--json'])).out)).toMatchObject({ dry_run: true, existing: true, instance_id: answer.instance_id });
  });

  it('reads stdin for -, refusing bytes that are not UTF-8, a byte order mark, and a file past 4 MiB', async () => {
    const dag = JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'A', assignee: 'worker' }] });
    expect((await mt(['apply', '-'], { stdin: dag })).out).toMatch(/^applied a DAG with no workflow as w_[0-9a-z]+, on board default, 1 task\n/);
    const broken = join(f.root, 'broken.json');
    writeFileSync(broken, Buffer.concat([Buffer.from('{"format": 1, "tasks": [{"ref": "a", "title": "'), Buffer.from([0xff]), Buffer.from('"}]}')]));
    expect(await mt(['apply', broken])).toEqual({ code: 1, out: '', err: `mt: the DAG in ${broken} is not UTF-8` });
    expect(await mt(['apply', '-'], { stdin: `\uFEFF${dag}` })).toEqual({ code: 1, out: '', err: 'mt: the DAG is not JSON' });
    const big = join(f.root, 'big.json');
    writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    expect(await mt(['apply', big])).toEqual({ code: 1, out: '', err: `mt: ${big} is ${4 * 1024 * 1024 + 1} bytes; a DAG file is read up to ${4 * 1024 * 1024}` });
  });
});

describe('mt kanban workflow list, instances, show and archive', () => {
  it('lists the files, the board\'s instances, shows one, its stored DAG masked with no hash, and archives it', async () => {
    writeFileSync(join(f.home, 'workflows', 'broken.yaml'), 'steps: {}\n');
    expect((await mt(['list'])).out.split('\n')).toEqual([
      'broken: not usable: the file needs steps, at least one',
      'vendor-eval: params topic (required), vendors (list, required), reviewer (default reviewer) · Shortlist vendors, evaluate each in parallel, then recommend one',
    ]);
    const started = JSON.parse((await mt(['start', 'vendor-eval', '--param', `topic=logs ${SECRET}`, '--param', 'vendors=acme', '--json'])).out) as { instance_id: string; tasks: Array<{ task_id: string }> };
    const id = started.instance_id;
    const listed = (await mt(['instances'])).out.split('\n');
    expect(listed[0]).toMatch(/^instance\s+workflow\s+status\s+members\s+by\s+when$/);
    expect(listed[1]).toMatch(new RegExp(`^${id}\\s+vendor-eval\\s+running\\s+0 of 3 done\\s+${ME}\\s+\\d{4}-`));
    const shown = (await mt(['show', id])).out.split('\n');
    expect(shown[0]).toBe(`vendor-eval (${id}): running, 0 of 3 done, on board default`);
    expect(shown).toContain(`params: reviewer: reviewer · topic: logs ${MASK} · vendors: acme`);
    const json = JSON.parse((await mt(['show', id, '--json'])).out) as { tasks: Array<{ phase: string; status: string }> };
    expect(json.tasks.map((t) => [t.phase, t.status])).toEqual([
      ['open', 'ready'],
      ['open', 'todo'],
      ['open', 'todo'],
    ]);
    const dag = (await mt(['show', id, '--dag'])).out;
    expect(JSON.parse(dag)).toMatchObject({ format: 1, workflow: 'vendor-eval', params: { topic: `logs ${MASK}` } });
    expect(dag).not.toContain(hashOf(id));
    createBoard(gateway, 'research', ME, NOW);
    expect(await mt(['show', id, '--board', 'research'])).toEqual({ code: 1, out: '', err: `mt: instance ${id} is on board default, not research` });
    expect(await mt(['show', id, '--board', 'nowhere'])).toEqual({ code: 1, out: '', err: 'mt: there is no board nowhere' });
    const before = nudges;
    expect((await mt(['archive', id])).out).toBe(`archived 3 tasks of ${id} (vendor-eval); its related tasks are left as they are`);
    expect(nudges).toBe(before + 1);
    for (const t of started.tasks) expect(getTask(gateway, t.task_id)?.phase).toBe('archived');
    expect((await mt(['archive', id])).out).toBe(`every task of ${id} is archived already; nothing changed`);
    expect((await mt(['instances'])).out).toBe('no running or blocked workflow instances on board default; mt kanban workflow instances all shows done and archived ones too');
    // An archived member counts as finished, not done: an archived instance says so.
    expect((await mt(['instances', 'all'])).out.split('\n')[1]).toMatch(new RegExp(`^${id}\\s+vendor-eval\\s+archived\\s+3 of 3 finished\\s+`));
    expect((await mt(['show', id])).out.split('\n')[0]).toBe(`vendor-eval (${id}): archived, 3 of 3 finished, on board default`);
  });

  it("prints the DAG's hash in no --json answer: start, apply, its dry run, show and instances", async () => {
    const path = join(f.root, 'dag.json');
    writeFileSync(path, (await mt(['preview', 'vendor-eval', ...PARAMS, '--json'])).out);
    const started = await mt(['start', 'vendor-eval', ...PARAMS, '--key', 's-1', '--json']);
    const id = (JSON.parse(started.out) as { instance_id: string }).instance_id;
    const applied = await mt(['apply', path, '--key', 'a-1', '--json']);
    const appliedId = (JSON.parse(applied.out) as { instance_id: string }).instance_id;
    const outs = [
      started,
      await mt(['start', 'vendor-eval', ...PARAMS, '--key', 's-1', '--json']),
      applied,
      await mt(['apply', path, '--key', 'a-1', '--json']),
      await mt(['apply', path, '--dry-run', '--json']),
      await mt(['apply', path, '--key', 'a-1', '--dry-run', '--json']),
      await mt(['show', id, '--json']),
      await mt(['show', appliedId, '--json']),
      await mt(['instances', '--json']),
      await mt(['instances', 'all', '--json']),
    ].map((r) => r.out);
    for (const out of outs) {
      expect(out).not.toMatch(/sha256/i);
      expect(out).not.toContain(hashOf(id));
      expect(out).not.toContain(hashOf(appliedId));
    }
  });

  it('re-applies a shown DAG to make a like instance', async () => {
    const id = (JSON.parse((await mt(['start', 'vendor-eval', ...PARAMS, '--json'])).out) as { instance_id: string }).instance_id;
    const path = join(f.root, 'again.json');
    writeFileSync(path, (await mt(['show', id, '--dag'])).out);
    const again = JSON.parse((await mt(['apply', path, '--json'])).out) as { instance_id: string; tasks: unknown[] };
    expect(again.instance_id).not.toBe(id);
    expect(again.tasks).toHaveLength(4);
  });
});

describe("mt's usage", () => {
  it('lists the workflow commands', async () => {
    const out: string[] = [];
    expect(await runMt(['help'], { env: f.env, out: (l) => out.push(l), err: () => undefined })).toBe(0);
    const usage = out.join('\n');
    expect(usage).toContain('  mt workflow check [<name>]');
    expect(usage).toContain('  mt kanban workflow preview <name> [--board <name>] [--param <key>=<value>]... [--json]');
    expect(usage).toContain('  mt kanban workflow apply <dag.json|-> [--key <key>] [--dry-run] [--chat <chat_id> [--thread <thread_id>]] [--json]');
    expect((await mt(['nonsense'])).err).toMatch(/^mt: kanban workflow takes list, instances, show, preview, start, apply or archive/);
  });
});

describe('an unmigrated database', () => {
  it('refuses the workflow commands no_board, changing nothing', async () => {
    gateway.close();
    const { rmSync } = await import('node:fs');
    for (const name of readdirSync(f.home)) if (name.startsWith('team.db')) rmSync(join(f.home, name));
    const dir = mkdtempSync(join(f.root, 'schema-'));
    for (const name of readdirSync(SCHEMA_DIR)) if (/^00[1-8]_.*\.sql$/.test(name)) copyFileSync(join(SCHEMA_DIR, name), join(dir, name));
    gateway = openDb(join(f.home, 'team.db'));
    migrate(gateway, dir);
    const db = join(f.home, 'team.db');
    for (const argv of [['list'], ['instances'], ['start', 'vendor-eval', ...PARAMS], ['show', 'w_x']]) {
      expect(await mt(argv)).toEqual({ code: 1, out: '', err: `mt: the database at ${db} has no workflows yet: start the gateway once, so it is migrated` });
    }
    expect(JSON.parse((await mt(['list', '--json'])).out)).toMatchObject({ ok: false, code: 'no_board' });
  });
});
