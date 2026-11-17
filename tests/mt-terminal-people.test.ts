import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { listenWorker, workerSocketPath, type WorkerServer } from '../src/kanban/socket.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * A person from the terminal (kanban spec §22.2, workflows spec §18.3):
 * `lark:<union_id>` taken by `task new`, `task assign`, a workflow's params and
 * an applied DAG, checked as chat checks one, refused in chat's words with how
 * to find ids; no @-mentions; and the preview leaving people to the start.
 */

let fx: MtFixture;
let db: Db;
let server: WorkerServer | undefined;

afterEach(async () => {
  clearSecrets();
  await server?.close();
  server = undefined;
  db?.close();
  fx?.cleanup();
});

/** A home with the config lines given, the board on and a gateway taking nudges, Alice and Bob seen by this bot, Alice at talk tier. */
async function setup(lines: string[] = ['lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', '  talk: [ou_alice]']): Promise<void> {
  clearSecrets();
  fx = mtFixture((ws) =>
    [`workspace: ${ws}`, ...lines, 'kanban:', '  enabled: true', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
  );
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  notePerson(db, { appId: 'cli_app', unionId: 'on_alice', openId: 'ou_alice', name: 'Alice Chen' }, 1);
  notePerson(db, { appId: 'cli_app', unionId: 'on_bob', openId: 'ou_bob', name: 'Bob Li' }, 1);
  mkdirSync(join(fx.home, 'workflows'));
  writeFileSync(
    join(fx.home, 'workflows', 'ask.yaml'),
    'params:\n  owner: { required: true }\n  note: { default: x }\nsteps:\n  ask: { title: "Ask {{note}}", assignee: "{{owner}}" }\n',
  );
  server = await listenWorker(workerSocketPath(fx.home), () => ({ ok: true }));
}

const kanban = (argv: string[], env: Record<string, string | undefined> = {}) => fx.run(['kanban', ...argv], { env });

const TALK =
  'cannot be given work: being assigned lets a person report on the task, which needs talk tier, and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it';
const HINT = 'mt kanban people lists the people this gateway knows, with their union_ids and whether they have talk tier';
const NO_MENTIONS = 'there are no @-mentions at the terminal: a person is lark:<union_id>, which mt kanban people lists';

describe('a person at task new and task assign', () => {
  it('takes a person known with talk tier, and refuses one unknown or without it in chat\'s words, with the hint', async () => {
    await setup();
    const made = await kanban(['task', 'new', 'Book the venue', '--assignee', 'lark:on_alice', '--reviewer', 'lark:on_alice', '--json']);
    expect(made.code, made.err).toBe(0);
    const id = JSON.parse(made.out).task_id as string;
    expect(getTask(db, id)).toMatchObject({ assignee: { kind: 'human', name: 'lark:on_alice' }, reviewer: { kind: 'human', name: 'lark:on_alice' } });
    expect((await kanban(['task', 'new', 'Book the venue', '--assignee', 'lark:on_alice'])).out).toMatch(/^created k_[0-9a-z]+: Book the venue, for lark:on_alice, on board default$/);
    for (const who of ['lark:on_bob', 'lark:on_carol']) {
      expect(await kanban(['task', 'new', 'x', '--assignee', who])).toEqual({ code: 1, out: '', err: `mt: "${who}" ${TALK}; ${HINT}` });
    }
    expect(JSON.parse((await kanban(['task', 'new', 'x', '--reviewer', 'lark:on_bob', '--json'])).out)).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: `"lark:on_bob" ${TALK}; ${HINT}`,
    });
  });

  it('counts an owner only the .env holds', async () => {
    await setup(['lark:', '  appId: cli_app']);
    expect((await kanban(['task', 'new', 'x', '--assignee', 'lark:on_alice'])).err).toMatch(/this shell finds no auth\.owner or MT_OWNER_OPEN_ID/);
    writeFileSync(join(fx.home, '.env'), 'MT_OWNER_OPEN_ID=ou_owner\nMT_ALLOW_TALK=ou_alice\n', { mode: 0o600 });
    expect((await kanban(['task', 'new', 'x', '--assignee', 'lark:on_alice'])).code).toBe(0);
  });

  it('names the setting this shell lacks, never "until the board is in Lark"', async () => {
    await setup(['auth:', '  owner: ou_owner', '  talk: [ou_alice]']);
    expect(await kanban(['task', 'new', 'x', '--assignee', 'lark:on_alice'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: "lark:on_alice" cannot be checked for talk tier here: this shell finds no lark.appId or LARK_APP_ID, which the people this bot has seen are kept by',
    });
    const owner = await kanban(['task', 'new', 'x', '--assignee', 'lark:on_alice'], { MT_OWNER_OPEN_ID: undefined, LARK_APP_ID: 'cli_app' });
    expect(owner.code).toBe(0);
    fx.cleanup();
    db.close();
    await server?.close();
    await setup(['lark:', '  appId: cli_app']);
    const r = await kanban(['task', 'new', 'x', '--assignee', 'lark:on_alice', '--json']);
    expect(JSON.parse(r.out)).toEqual({
      ok: false,
      code: 'person_not_assignable',
      message: '"lark:on_alice" cannot be checked for talk tier here: this shell finds no auth.owner or MT_OWNER_OPEN_ID, without which there is no talk allowlist to check against',
    });
    expect(r.out).not.toMatch(/until the board is in Lark/);
  });

  it('refuses an @-mention with its hint, as there are none at the terminal', async () => {
    await setup();
    for (const flag of ['--assignee', '--reviewer']) {
      expect(await kanban(['task', 'new', 'x', flag, '@Alice'])).toEqual({ code: 1, out: '', err: `mt: ${NO_MENTIONS}` });
    }
    const task = JSON.parse((await kanban(['task', 'new', 'x', '--assignee', 'default', '--json'])).out).task_id as string;
    expect(JSON.parse((await kanban(['task', 'assign', task, '@Alice Chen', '--json'])).out)).toEqual({ ok: false, code: 'invalid', message: NO_MENTIONS });
  });

  it('assigns a task to a person with talk tier, and refuses one without in the same words', async () => {
    await setup();
    const task = JSON.parse((await kanban(['task', 'new', 'x', '--assignee', 'default', '--json'])).out).task_id as string;
    expect(await kanban(['task', 'assign', task, 'lark:on_alice'])).toMatchObject({ code: 0, out: `${task} is now for lark:on_alice` });
    expect(getTask(db, task)?.assignee).toEqual({ kind: 'human', name: 'lark:on_alice' });
    expect(await kanban(['task', 'assign', task, 'lark:on_bob'])).toEqual({ code: 1, out: '', err: `mt: "lark:on_bob" ${TALK}; ${HINT}` });
    const usage = await kanban(['task', 'assign', task]);
    expect(usage.code).toBe(2);
    expect(usage.err.split('\n')[0]).toBe('mt: kanban task assign takes a task id, and a role or a person, lark:<union_id>');
  });
});

describe('a person in a workflow at the terminal', () => {
  it('takes one in a param with talk tier, and refuses one without, naming the ref, with the hint', async () => {
    await setup();
    const r = await kanban(['workflow', 'start', 'ask', '--param', 'owner=lark:on_alice', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(getTask(db, JSON.parse(r.out).tasks[0].task_id)?.assignee).toEqual({ kind: 'human', name: 'lark:on_alice' });
    expect(await kanban(['workflow', 'start', 'ask', '--param', 'owner=lark:on_bob'])).toEqual({ code: 1, out: '', err: `mt: ask: "lark:on_bob" ${TALK}; ${HINT}` });
  });

  it("refuses @ in a person field at the terminal, with the hint, and keeps it in a text field", async () => {
    await setup();
    expect(await kanban(['workflow', 'start', 'ask', '--param', 'owner=@Alice Chen'])).toEqual({ code: 1, out: '', err: `mt: ${NO_MENTIONS}` });
    const kept = await kanban(['workflow', 'start', 'ask', '--param', 'owner=default', '--param', 'note=@Bob', '--json']);
    expect(getTask(db, JSON.parse(kept.out).tasks[0].task_id)?.title).toBe('Ask @Bob');
  });

  it('checks a DAG\'s person at apply and apply --dry-run, and refuses an @ there', async () => {
    await setup();
    const dag = (assignee: string) => {
      const path = join(fx.root, `dag-${assignee.replace(/\W/g, '')}.json`);
      writeFileSync(path, JSON.stringify({ format: 1, tasks: [{ ref: 'a', title: 'Ask', assignee }] }));
      return path;
    };
    expect(await kanban(['workflow', 'apply', dag('lark:on_bob'), '--dry-run'])).toEqual({ code: 1, out: '', err: `mt: a: "lark:on_bob" ${TALK}; ${HINT}` });
    expect((await kanban(['workflow', 'apply', dag('lark:on_alice'), '--dry-run'])).code).toBe(0);
    expect((await kanban(['workflow', 'apply', dag('lark:on_alice')])).code).toBe(0);
    expect(await kanban(['workflow', 'apply', dag('@Alice')])).toEqual({ code: 1, out: '', err: `mt: a: ${NO_MENTIONS}` });
  });

  it('previews a person unchecked, saying on stderr that the start checks it', async () => {
    await setup(['auth:', '  owner: ou_owner']);
    const r = await kanban(['workflow', 'preview', 'ask', '--param', 'owner=lark:on_bob']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ask would make 1 task, on board default:\n {2}ask {2}Ask x {2}lark:on_bob/);
    expect(r.err).toBe("mt: lark:on_bob is checked at the start, against the people this gateway knows; mt kanban workflow apply --dry-run on this preview's --json checks it now");
    const json = await kanban(['workflow', 'preview', 'ask', '--param', 'owner=lark:on_bob', '--json']);
    expect(JSON.parse(json.out).tasks[0].assignee).toBe('lark:on_bob');
    expect(json.err).toBe(r.err);
    expect(await kanban(['workflow', 'preview', 'ask', '--param', 'owner=@Bob'])).toEqual({ code: 1, out: '', err: `mt: ${NO_MENTIONS}` });
  });
});
