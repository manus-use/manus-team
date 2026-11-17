import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson, peopleOf } from '../src/db/people.js';
import { addSecrets, clearSecrets, MASK } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `mt kanban people` (kanban spec §22.2): the people this bot has seen, one a
 * line, sorted by name and then union_id, with the name masked and stripped,
 * the principal, and talk tier by the open_id last seen; `--json`; refused in an
 * agent's shell, and with no app id, no bot to list for.
 */

let fx: MtFixture;
let db: Db;

afterEach(() => {
  clearSecrets();
  db?.close();
  fx?.cleanup();
});

function setup(lines: string[] = ['lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', '  talk: [ou_bob]']): void {
  clearSecrets();
  fx = mtFixture((ws) => [`workspace: ${ws}`, ...lines, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  const seen: Array<[string, string, string | null]> = [
    ['on_zed', 'ou_zed', 'Bob Li'],
    ['on_bob', 'ou_bob', 'Bob Li'],
    ['on_ann', 'ou_ann', 'Ann\u202E Wu'],
    ['on_quiet', 'ou_quiet', null],
    ['on_owner', 'ou_owner', 'Owner sk-live-1234567890'],
  ];
  for (const [unionId, openId, name] of seen) notePerson(db, { appId: 'cli_app', unionId, openId, name }, 1);
  notePerson(db, { appId: 'cli_other', unionId: 'on_else', openId: 'ou_bob', name: 'Elsewhere' }, 1);
}

describe('peopleOf', () => {
  it("gives this bot's people, by name and then union_id, those with no name last", () => {
    setup();
    expect(peopleOf(db, 'cli_app').map((p) => p.unionId)).toEqual(['on_ann', 'on_bob', 'on_zed', 'on_owner', 'on_quiet']);
    expect(peopleOf(db, 'cli_other').map((p) => p.unionId)).toEqual(['on_else']);
    expect(peopleOf(db, 'cli_none')).toEqual([]);
  });
});

describe('mt kanban people', () => {
  it('lists them, masked and stripped, with the principal and talk or no', async () => {
    setup();
    addSecrets(['sk-live-1234567890']);
    const r = await fx.run(['kanban', 'people']);
    expect(r).toEqual({
      code: 0,
      out: [
        'name        person         talk',
        'Ann Wu      lark:on_ann    no',
        'Bob Li      lark:on_bob    talk',
        'Bob Li      lark:on_zed    no',
        `Owner ${MASK}  lark:on_owner  talk`,
        '(no name)   lark:on_quiet  no',
      ].join('\n'),
      err: '',
    });
  });

  it('gives --json', async () => {
    setup();
    const r = await fx.run(['kanban', 'people', '--json']);
    expect(JSON.parse(r.out)).toEqual({
      ok: true,
      people: [
        { principal: 'lark:on_ann', union_id: 'on_ann', name: 'Ann\u202E Wu', talk: false },
        { principal: 'lark:on_bob', union_id: 'on_bob', name: 'Bob Li', talk: true },
        { principal: 'lark:on_zed', union_id: 'on_zed', name: 'Bob Li', talk: false },
        { principal: 'lark:on_owner', union_id: 'on_owner', name: 'Owner sk-live-1234567890', talk: true },
        { principal: 'lark:on_quiet', union_id: 'on_quiet', name: null, talk: false },
      ],
    });
    expect(r.out).toContain('Ann\\u202e Wu');
  });

  it('says there is no bot to list for without an app id, and nobody has talk tier without an owner', async () => {
    setup(['auth:', '  owner: ou_owner']);
    expect(await fx.run(['kanban', 'people'])).toEqual({ code: 1, out: '', err: 'mt: there is no bot to list people for: this shell finds no lark.appId or LARK_APP_ID' });
    expect(JSON.parse((await fx.run(['kanban', 'people', '--json'])).out)).toMatchObject({ ok: false, code: 'no_bot' });
    const noOwner = await fx.run(['kanban', 'people'], { env: { LARK_APP_ID: 'cli_app', MT_OWNER_OPEN_ID: undefined } });
    expect(noOwner.code).toBe(0);
    fx.cleanup();
    db.close();
    setup(['lark:', '  appId: cli_app']);
    const r = await fx.run(['kanban', 'people']);
    expect(r.out.split('\n').slice(1).every((l) => l.endsWith(' no'))).toBe(true);
    expect(r.err).toBe('mt: this shell finds no auth.owner or MT_OWNER_OPEN_ID, so nobody is shown with talk tier');
  });

  it('says so when nobody is known, takes no arguments, and is refused in an agent\'s shell', async () => {
    setup();
    db.prepare('DELETE FROM people').run();
    expect(await fx.run(['kanban', 'people'])).toEqual({ code: 0, out: 'no people yet: the gateway learns a person once they have used /kanban, or been @-mentioned in it', err: '' });
    expect((await fx.run(['kanban', 'people', 'all'])).code).toBe(2);
    expect(await fx.run(['kanban', 'people'], { env: { MT_CRON_TOKEN: 't' } })).toEqual({
      code: 1,
      out: '',
      err: "mt: mt kanban people is an operator's command, not an agent's; this shell has MT_CRON_TOKEN set. Run it from your own shell",
    });
    expect(JSON.parse((await fx.run(['kanban', 'people', '--json'], { env: { MT_KANBAN_RUN: 'r_1' } })).out)).toMatchObject({ ok: false, code: 'operator_command' });
  });
});
