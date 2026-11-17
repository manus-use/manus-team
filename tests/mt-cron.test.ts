import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { getJob, listJobs } from '../src/db/cron.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { writeGatewayZone } from '../src/cron/zone-file.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `mt cron` at the terminal (the cron spec, §6.2) and in an agent's shell
 * (§6.3, §6.4): the operator's commands writing beside the gateway, its flags,
 * its zone, `--json`, an unmigrated database; the agent's through the socket.
 */

let fx: MtFixture;
let db: Db;

function config(extra: string[] = []): (ws: string) => string {
  return (ws) =>
    [`workspace: ${ws}`, 'lark:', '  appId: cli_app', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ...extra, ''].join('\n');
}

beforeEach(() => {
  clearSecrets();
});
afterEach(() => {
  clearSecrets();
  db?.close();
  fx?.cleanup();
});

function setup(extra: string[] = ['cron:', '  tz: Asia/Shanghai'], migrated = true): void {
  fx = mtFixture(config(extra));
  db = openDb(join(fx.home, 'team.db'));
  if (migrated) migrate(db, SCHEMA_DIR);
}

describe('mt cron, the operator', () => {
  it("adds a job delivering to --chat in cron.tz, says cron is off, and lists and shows it", async () => {
    setup();
    const r = await fx.run(['cron', 'add', 'every weekday 09:00', 'default', 'List the open PRs.', '--chat', 'oc_team', '--name', 'Daily PRs']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^added (c_[0-9a-z]+): next \d{4}-\d\d-\d\d 09:00\nc_[0-9a-z]+ Daily PRs\n {2}schedule: every weekday 09:00 \(Asia\/Shanghai\), active/);
    expect(r.err).toBe('mt: cron is off on this gateway (its config does not set cron.enabled to true): the change is recorded, and nothing fires until cron is turned on and the gateway restarted');
    const [job] = listJobs(db);
    expect(job).toMatchObject({ tz: 'Asia/Shanghai', role: 'default', createdBy: expect.stringMatching(/^operator:/), delivery: { channel: 'lark', account: 'cli_app', chat: 'oc_team', thread: '', root: null } });
    expect((await fx.run(['cron', 'list'])).out).toMatch(/^id\s+name\s+schedule\s+zone\s+state\s+next\s+posts to\n(c_[0-9a-z]+)\s+Daily PRs\s+every weekday 09:00\s+Asia\/Shanghai\s+active/);
    const shown = JSON.parse((await fx.run(['cron', 'show', job?.jobId ?? '', '--json'])).out);
    expect(shown).toMatchObject({ ok: true, job: { job_id: job?.jobId, next_run_at: expect.stringMatching(/T09:00:00\+08:00$/) }, fires: [] });
  });

  it("takes the zone gateway.tz records, else this shell's, which it says", async () => {
    setup([]);
    await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.']);
    const shell = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r = await fx.run(['cron', 'add', 'every 3h', 'default', 'Check.']);
    expect(r.err.split('\n')[0]).toBe(`mt: times in ${shell}, this shell's zone, as no gateway has recorded its own; --tz names another`);
    writeGatewayZone(fx.home, 'America/New_York');
    const recorded = await fx.run(['cron', 'add', 'every 4h', 'default', 'Check.', '--json']);
    expect(JSON.parse(recorded.out)).toMatchObject({ ok: true, job: { tz: 'America/New_York' }, nudged: false });
    expect((await fx.run(['cron', 'add', 'every 5h', 'default', 'Check.', '--tz', 'UTC', '--json'])).out).toMatch(/"tz":"UTC"/);
  });

  it("says in --json where an add's zone came from: cron.tz, the gateway's record, or this shell; none for --tz or a retried key", async () => {
    setup([]);
    const source = async (...extra: string[]) => JSON.parse((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--json', ...extra])).out).zone_source;
    expect(await source()).toBe('shell');
    writeGatewayZone(fx.home, 'America/New_York');
    expect(await source('--key', 'k1')).toBe('gateway');
    expect(await source('--key', 'k1')).toBeUndefined();
    expect(await source('--tz', 'UTC')).toBeUndefined();
    fx.cleanup();
    db.close();
    setup();
    expect(await source()).toBe('cron.tz');
  });

  it('edits, with --no-script and --no-chat, pauses, resumes, runs and removes', async () => {
    setup();
    addSecrets(['sk-live-1234567890']);
    const add = JSON.parse((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--script', 'gh pr list', '--chat', 'oc_team', '--json'])).out);
    const id = add.job.job_id as string;
    expect((await fx.run(['cron', 'edit', id, '--script', 'echo sk-live-1234567890'])).err).toMatch(/^mt: the script holds a known secret/);
    expect((await fx.run(['cron', 'edit', id, '--no-script', '--no-chat', '--prompt', 'Other.'])).code).toBe(0);
    expect(getJob(db, id)).toMatchObject({ script: null, delivery: null, prompt: 'Other.' });
    for (const [verb, state] of [['pause', 'paused'], ['resume', 'active'], ['run', 'active'], ['remove', 'removed']] as const) {
      const r = await fx.run(['cron', verb, id, '--json']);
      expect(JSON.parse(r.out), verb).toMatchObject({ ok: true, job: { state } });
    }
    expect(JSON.parse((await fx.run(['cron', 'show', id, '--json'])).out)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await fx.run(['cron', 'edit', id, '--no-script', '--script', 'x'])).toMatchObject({ code: 2 });
    expect(await fx.run(['cron', 'add', 'every 2h', 'default', 'x', '--chat', 'not-a-chat'])).toMatchObject({ code: 2 });
  });

  it("refuses a database not migrated to the cron tables, and says the JSON form is an agent's", async () => {
    setup(undefined, false);
    db.pragma('user_version = 9');
    expect(await fx.run(['cron', 'list'])).toEqual({ code: 1, out: '', err: 'mt: the database is at version 9; start the gateway of this build once to migrate it' });
    const r = await fx.run(['cron', 'add']);
    expect(r.code).toBe(2);
    expect(r.err.split('\n')[0]).toBe("mt: cron add takes a schedule, a role and a prompt; the JSON form, mt cron add < job.json, works only in an agent's shell");
  });
});

describe("mt cron in an agent's shell", () => {
  let server: WorkerServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("refuses the operator's commands before their arguments are read, naming the variable", async () => {
    setup();
    const env = { MT_CRON_TOKEN: 'x'.repeat(43), MT_KANBAN_SOCKET: '/nowhere.sock' };
    expect(await fx.run(['cron', 'edit', 'c_1', '--prompt', 'x'], { env })).toEqual({
      code: 1,
      out: '',
      err: "mt: mt cron edit is an operator's command, not an agent's; this shell has MT_CRON_TOKEN set. Run it from your own shell",
    });
    expect((await fx.run(['cron', 'show', 'c_1'], { env })).err).toMatch(/^mt: mt cron show is an operator's command/);
    // One of the agent's four, with words after it: the agent's, which takes none.
    const listed = await fx.run(['cron', 'list', '--json'], { env });
    expect(listed.code).toBe(2);
    expect(JSON.parse(listed.out)).toEqual({ ok: false, code: 'bad_request', message: 'mt cron list takes no arguments here: its input is JSON on stdin' });
    expect(JSON.parse((await fx.run(['cron', 'add', 'every 2h', 'default', 'x'], { env })).out)).toMatchObject({ ok: false, code: 'bad_request' });
    expect((await fx.run(['cron', 'list'], { env: { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 't' } })).out).toMatch(/"code":"(unreachable|not_in_a_run)"/);
  });

  it("sends an agent's add to the socket with its token, and a board run's with its run", async () => {
    setup();
    const seen: unknown[] = [];
    mkdirSync(join(fx.home, 'run'), { recursive: true, mode: 0o700 });
    server = await listenWorker(workerSocketPath(fx.home), (request) => {
      seen.push(request);
      return { ok: true, job_id: 'c_1' };
    });
    const token = 'y'.repeat(43);
    const out: string[] = [];
    const code = await runMt(['cron', 'add'], {
      env: { ...fx.env, MT_CRON_TOKEN: token, MT_KANBAN_SOCKET: server.path },
      out: (l) => out.push(l),
      err: () => undefined,
      stdinIsTTY: false,
      stdin: async () => Buffer.from('{"schedule":"every 2h","prompt":"x"}'),
    });
    expect({ code, out }).toEqual({ code: 0, out: ['{"ok":true,"job_id":"c_1"}'] });
    await runMt(['cron', 'list'], {
      env: { ...fx.env, MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: token, MT_KANBAN_SOCKET: server.path },
      out: () => undefined,
      err: () => undefined,
      stdinIsTTY: false,
      stdin: async () => Buffer.from(''),
    });
    expect(seen).toEqual([
      { cron: 'add', token, input: { schedule: 'every 2h', prompt: 'x' } },
      { cron: 'list', token, input: {}, run: 'r_1' },
    ]);
  });
});
