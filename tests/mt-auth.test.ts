import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activeGrant, grantTier } from '../src/db/grants.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { operatorName } from '../src/cli/gate.js';
import { formatWall } from '../src/cron/schedule.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `mt auth` (the tier grants spec §6.2, §8.2): grant, revoke and list at the
 * terminal, as the owner, against a temporary home and database; `--json` on
 * each; every refusal and its code; and refused in an agent's shell.
 */

let fx: MtFixture;
let db: Db;
const ME = operatorName({ env: process.env, out: () => undefined, err: () => undefined });
const ZONE = 'Asia/Shanghai';

afterEach(() => {
  clearSecrets();
  db?.close();
  fx?.cleanup();
});

const AUTH = ['auth:', '  owner: ou_owner', '  talk: [ou_tess, ou_bob]', '  operate: [ou_bob, ou_olga]'];

/** A home with the bot's app id and the lists given, and people this bot has seen; its database migrated to `upTo`, or every migration. */
function setup(lines: string[] = ['lark:', '  appId: cli_app', ...AUTH], upTo?: number): void {
  clearSecrets();
  fx = mtFixture((ws) => [`workspace: ${ws}`, ...lines, 'cron:', `  tz: ${ZONE}`, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
  let schema = SCHEMA_DIR;
  if (upTo !== undefined) {
    schema = mkdtempSync(join(fx.root, 'schema-'));
    for (const f of readdirSync(SCHEMA_DIR)) if (Number(f.slice(0, 3)) <= upTo) copyFileSync(join(SCHEMA_DIR, f), join(schema, f));
  }
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, schema);
  for (const [id, name] of [['owner', 'Alice'], ['tess', 'Tess'], ['bob', 'Bob'], ['carol', 'Carol Wu'], ['olga', 'Olga'], ['dan', null]] as const) {
    notePerson(db, { appId: 'cli_app', unionId: `on_${id}`, openId: `ou_${id}`, name }, 1);
  }
}

const auth = (argv: string[], env: Record<string, string | undefined> = {}) => fx.run(['auth', ...argv], { env });
const json = async (argv: string[], env: Record<string, string | undefined> = {}): Promise<unknown> => JSON.parse((await auth([...argv, '--json'], env)).out);

describe('mt auth grant', () => {
  it('grants a person this bot has seen, as the operator, at the terminal, and says a tier already held', async () => {
    setup();
    expect(await auth(['grant', 'lark:on_carol', 'talk'])).toEqual({
      code: 0,
      out: `Carol Wu (lark:on_carol) now has talk tier, granted by ${ME}; mt auth revoke lark:on_carol takes it back`,
      err: '',
    });
    const g = activeGrant(db, 'cli_app', 'on_carol');
    expect(g).toMatchObject({ tier: 'talk', openId: 'ou_carol', grantedBy: ME, grantedVia: 'terminal', grantedChat: null });
    expect(await auth(['grant', 'lark:on_carol', 'TALK'])).toEqual({
      code: 0,
      out: `Carol Wu (lark:on_carol) already has talk tier, by a grant from ${ME} on ${formatWall(ZONE, g?.grantedAt ?? 0).slice(0, 10)}`,
      err: '',
    });
    expect(await json(['grant', 'lark:on_carol', 'operate'])).toEqual({ ok: true, outcome: 'replaced', tier: 'operate', principal: 'lark:on_carol' });
    expect(await json(['grant', 'lark:on_carol', 'talk'])).toEqual({ ok: true, outcome: 'already', tier: 'operate', principal: 'lark:on_carol' });
    expect(await json(['grant', 'lark:on_dan', 'operate'])).toEqual({ ok: true, outcome: 'granted', tier: 'operate', principal: 'lark:on_dan' });
    expect((await auth(['grant', 'lark:on_dan', 'talk'])).out).toMatch(/^lark:on_dan already has operate tier, by a grant from .+, which includes talk; to leave them talk alone/);
    // As the owner: talk to a person in auth.operate alone, which makes them an operator.
    expect(await json(['grant', 'lark:on_olga', 'talk'])).toEqual({ ok: true, outcome: 'granted', tier: 'operate', principal: 'lark:on_olga' });
    expect(await json(['grant', 'lark:on_owner', 'talk'])).toEqual({ ok: true, outcome: 'already', tier: 'operate', principal: 'lark:on_owner' });
  });

  it("refuses a person this bot has not seen, an open_id, an @-mention and anything else, in their words", async () => {
    setup();
    expect(await auth(['grant', 'lark:on_stranger', 'talk'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: lark:on_stranger is not someone this bot has seen: mt kanban people lists those it has, or grant them in chat with /auth grant @Name talk, which needs no id',
    });
    expect(await json(['grant', 'lark:on_stranger', 'talk'])).toMatchObject({ ok: false, code: 'unknown_person' });
    expect(await json(['grant', 'ou_carol', 'talk'])).toEqual({
      ok: false,
      code: 'open_id',
      message: 'ou_carol is an open_id, which is per app: a person is lark:<union_id>, which mt auth list and mt kanban people give',
    });
    expect(await json(['grant', '@Carol', 'talk'])).toEqual({
      ok: false,
      code: 'invalid',
      message: 'there are no @-mentions at the terminal: a person is lark:<union_id>, which mt kanban people lists',
    });
    expect(await json(['revoke', 'carol'])).toMatchObject({ ok: false, code: 'invalid', message: 'carol is not a person: a person is lark:<union_id>, which mt auth list and mt kanban people give' });
    expect(activeGrant(db, 'cli_app', 'on_carol')).toBeUndefined();
  });

  it('is refused with no app id, with no owner, and on a database not yet migrated to grants, or none', async () => {
    setup(AUTH);
    expect(await json(['list'])).toEqual({ ok: false, code: 'no_bot', message: 'there is no bot to grant for: this shell finds no lark.appId or LARK_APP_ID' });
    db.close();
    fx.cleanup();
    setup(['lark:', '  appId: cli_app']);
    const noOwner = 'this shell finds no auth.owner or MT_OWNER_OPEN_ID, so it cannot tell what the configuration gives';
    expect(await json(['grant', 'lark:on_carol', 'talk'])).toEqual({ ok: false, code: 'no_owner', message: noOwner });
    expect(await auth(['revoke', 'lark:on_carol'])).toEqual({ code: 1, out: '', err: `mt: ${noOwner}` });
    // The owner only the .env holds counts.
    expect((await auth(['grant', 'lark:on_carol', 'talk'], { MT_OWNER_OPEN_ID: 'ou_owner' })).code).toBe(0);
    db.close();
    fx.cleanup();
    setup(undefined, 10);
    const path = join(fx.home, 'team.db');
    expect(await json(['list'])).toEqual({ ok: false, code: 'not_migrated', message: `the database at ${path} has no tier grants yet: start the gateway once, so it is migrated` });
    db.close();
    rmSync(path);
    expect(await auth(['list'])).toEqual({ code: 1, out: '', err: `mt: there is no database at ${path}: the gateway creates it when it first starts` });
  });

  it('takes a person and a tier, and nothing else', async () => {
    setup();
    for (const argv of [[], ['grant'], ['grant', 'lark:on_carol'], ['grant', 'lark:on_carol', 'admin'], ['grant', 'lark:on_carol', 'talk', 'x'], ['revoke'], ['list', 'all'], ['frob'], ['grant', 'lark:on_carol', 'talk', '--force']]) {
      const r = await auth(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err, argv.join(' ')).toMatch(/^mt: /);
    }
  });
});

describe('mt auth revoke', () => {
  it('ends a grant, says what is left, counts the talk grants a revoked operator made, and is a no-op with none', async () => {
    setup();
    await auth(['grant', 'lark:on_tess', 'operate']);
    expect(await auth(['revoke', 'lark:on_tess'])).toEqual({
      code: 0,
      out: `Tess (lark:on_tess) no longer has operate tier: revoked by ${ME}; they keep talk tier from auth.talk in config.yaml`,
      err: '',
    });
    await auth(['grant', 'lark:on_dan', 'operate']);
    for (const id of ['carol', 'owner']) {
      grantTier(db, { appId: 'cli_app', unionId: `on_${id}`, openId: `ou_${id}`, tier: 'talk', by: 'lark:on_dan', via: 'chat', chat: 'oc_team' }, () => ({ write: 'insert' as const }), 1);
    }
    expect((await auth(['revoke', 'lark:on_dan'])).out).toBe(`lark:on_dan no longer has operate tier: revoked by ${ME}; they made 2 talk grants still in force; mt auth list shows them`);
    expect(await json(['revoke', 'lark:on_carol'])).toEqual({ ok: true, outcome: 'revoked', tier: null, principal: 'lark:on_carol' });
    expect(await json(['revoke', 'lark:on_carol'])).toEqual({ ok: true, outcome: 'no_grant', tier: null, principal: 'lark:on_carol' });
    // The owner's grant from before: ended, both tiers kept.
    expect(await json(['revoke', 'lark:on_owner'])).toEqual({ ok: true, outcome: 'revoked', tier: 'operate', principal: 'lark:on_owner' });
  });

  it('refuses the owner and a tier the configuration gives, naming the list in effect', async () => {
    setup();
    expect(await json(['revoke', 'lark:on_owner'])).toEqual({ ok: false, code: 'is_owner', message: 'Alice (lark:on_owner) is the owner, from auth.owner in config.yaml, and cannot be revoked' });
    expect(await auth(['revoke', 'lark:on_tess'])).toEqual({
      code: 1,
      out: '',
      err: 'mt: Tess (lark:on_tess) has talk tier from auth.talk in config.yaml, which mt auth cannot change: the operator edits it and restarts the gateway',
    });
    expect(await json(['revoke', 'lark:on_tess'], { MT_ALLOW_TALK: 'ou_tess' })).toMatchObject({ code: 'from_config', message: expect.stringContaining('has talk tier from MT_ALLOW_TALK, which') });
    expect(await json(['revoke', 'lark:on_bob'])).toMatchObject({ code: 'from_config', message: expect.stringContaining('has operate tier from auth.operate in config.yaml') });
  });
});

describe('mt auth list', () => {
  it('lists everyone with a tier, the owner first, with where each comes from, and gives --json', async () => {
    setup();
    await auth(['grant', 'lark:on_carol', 'talk']);
    grantTier(db, { appId: 'cli_app', unionId: 'on_dan', openId: 'ou_dan', tier: 'operate', by: 'lark:on_owner', via: 'chat', chat: 'oc_team' }, () => ({ write: 'insert' as const }), Date.UTC(2026, 10, 18, 2, 2));
    const carolAt = activeGrant(db, 'cli_app', 'on_carol')?.grantedAt ?? 0;
    const r = await auth(['list']);
    expect(r.code).toBe(0);
    expect(r.out.split('\n').map((l) => l.replace(/ +/g, ' '))).toEqual([
      'name person tier from',
      // The owner as chat's /auth list says them: from auth.owner, whatever lists they are also in.
      'Alice lark:on_owner operate owner',
      'Bob lark:on_bob operate auth.talk; auth.operate',
      '(no name) lark:on_dan operate operate grant by lark:on_owner in chat oc_team, 2026-11-18 10:02',
      `Carol Wu lark:on_carol talk talk grant by ${ME} at the terminal, ${formatWall(ZONE, carolAt)}`,
      'Tess lark:on_tess talk auth.talk',
      'Olga lark:on_olga none auth.operate',
    ]);
    const listed = (await json(['list'])) as { ok: boolean; config_known: boolean; people: unknown[] };
    expect(listed.ok).toBe(true);
    expect(listed.config_known).toBe(true);
    expect(listed.people).toContainEqual({
      principal: 'lark:on_dan',
      union_id: 'on_dan',
      open_id: 'ou_dan',
      name: null,
      tier: 'operate',
      owner: false,
      config: { talk: false, operate: false },
      grant: { tier: 'operate', by: 'lark:on_owner', via: 'chat', chat_id: 'oc_team', at: Date.UTC(2026, 10, 18, 2, 2) },
    });
    expect(listed.people).toContainEqual({
      principal: 'lark:on_bob',
      union_id: 'on_bob',
      open_id: 'ou_bob',
      name: 'Bob',
      tier: 'operate',
      owner: false,
      config: { talk: true, operate: true },
      grant: null,
    });
  });

  it('shows a configuration entry this bot has not seen by its open_id, and only the grants with no owner', async () => {
    setup(['lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', '  talk: [ou_ghost]']);
    expect((await auth(['list'])).out.split('\n').map((l) => l.replace(/ +/g, ' '))).toContain('(not seen) ou_ghost talk auth.talk');
    expect(await json(['list'])).toMatchObject({ people: expect.arrayContaining([{ principal: null, union_id: null, open_id: 'ou_ghost', name: null, tier: 'talk', owner: false, config: { talk: true, operate: false }, grant: null }]) });
    db.close();
    fx.cleanup();
    setup(['lark:', '  appId: cli_app']);
    grantTier(db, { appId: 'cli_app', unionId: 'on_carol', openId: 'ou_carol', tier: 'talk', by: ME, via: 'terminal', chat: null }, () => ({ write: 'insert' as const }), 1);
    const r = await auth(['list']);
    expect(r.err).toBe('mt: this shell finds no auth.owner or MT_OWNER_OPEN_ID, so only the grants are shown');
    expect(r.out.split('\n')).toHaveLength(2);
    // A script reading --json learns the same: the lists are unknown, so the people are the grants alone.
    expect(await json(['list'])).toMatchObject({ ok: true, config_known: false, people: [{ principal: 'lark:on_carol', config: { talk: false, operate: false } }] });
  });
});

describe("mt auth in an agent's shell", () => {
  it('is refused before its arguments are read, as JSON with --json', async () => {
    setup();
    expect(await auth(['grant', 'lark:on_carol', 'talk'], { MT_CRON_TOKEN: 't' })).toEqual({
      code: 1,
      out: '',
      err: "mt: mt auth grant is an operator's command, not an agent's; this shell has MT_CRON_TOKEN set. Run it from your own shell",
    });
    expect(await json(['bogus'], { MT_KANBAN_RUN: 'r_1' })).toEqual({
      ok: false,
      code: 'operator_command',
      message: "mt auth is an operator's command, not an agent's; this shell has MT_KANBAN_RUN set. Run it from your own shell",
    });
    expect(activeGrant(db, 'cli_app', 'on_carol')).toBeUndefined();
  });
});
