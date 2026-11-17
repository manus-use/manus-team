import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBoard, personHint, type BoardAccess } from '../src/cli/gate.js';
import { withGatewayFile, type MtIo } from '../src/cli/mt.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The terminal's board knows people (kanban spec §22.2): `openBoard` gives its
 * service chat's `PeopleDirectory` over the database it opened, with this
 * bot's app id and the talk allowlist the settings give, so a person named by
 * principal is checked by chat's own code; and says what this shell lacked when
 * it cannot, which `personHint` words for the terminal.
 */

let fx: MtFixture;
let db: Db;
const boards: BoardAccess[] = [];

afterEach(() => {
  clearSecrets();
  while (boards.length > 0) boards.pop()?.close();
  db?.close();
  fx?.cleanup();
});

/** A home whose config has the lines given, its database migrated, and three people this bot has seen. */
function setup(lines: string[]): void {
  clearSecrets();
  fx = mtFixture((ws) => [`workspace: ${ws}`, ...lines, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'));
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  for (const [unionId, openId, name] of [['on_alice', 'ou_alice', 'Alice Chen'], ['on_bob', 'ou_bob', 'Bob Li'], ['on_owner', 'ou_owner', 'Owner']] as const) {
    notePerson(db, { appId: 'cli_app', unionId, openId, name }, 1);
  }
}

function open(env: Record<string, string | undefined> = {}): BoardAccess {
  const err: string[] = [];
  const io: MtIo = { env: { ...fx.env, ...env }, out: () => undefined, err: (l) => err.push(l) };
  const board = openBoard(withGatewayFile(io), 'mt kanban task new');
  if (typeof board === 'number') throw new Error(`refused: ${err.join('\n')}`);
  boards.push(board);
  return board;
}

function assign(board: BoardAccess, assignee: string) {
  return board.service.create({ title: 'Book the venue', assignee, createdBy: 'operator:me', createdVia: { kind: 'operator' } });
}

const UNKNOWN_TALK =
  'cannot be given work: being assigned lets a person report on the task, which needs talk tier, and this gateway does not know them to have it -- a person is known once they have used /kanban, or been @-mentioned in it';

describe("openBoard's people", () => {
  it('checks a person as chat does: seen by this bot, and at talk tier by the open_id last seen', () => {
    setup(['lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', '  talk: [ou_alice]']);
    const board = open();
    expect(board.peopleMissing).toBeUndefined();
    expect(assign(board, 'lark:on_alice')).toMatchObject({ ok: true, task: { assignee: { kind: 'human', name: 'lark:on_alice' } } });
    expect(assign(board, 'lark:on_owner')).toMatchObject({ ok: true });
    expect(assign(board, 'lark:on_bob')).toEqual({ ok: false, code: 'person_not_assignable', message: `"lark:on_bob" ${UNKNOWN_TALK}` });
    expect(assign(board, 'lark:on_carol')).toEqual({ ok: false, code: 'person_not_assignable', message: `"lark:on_carol" ${UNKNOWN_TALK}` });
    // Another bot's people are not this one's.
    notePerson(db, { appId: 'cli_other', unionId: 'on_dana', openId: 'ou_alice', name: 'Dana' }, 2);
    expect(assign(board, 'lark:on_dana')).toMatchObject({ ok: false, code: 'person_not_assignable' });
  });

  it("counts an owner, a talk list and an app id the gateway's .env holds, and MT_ALLOW_TALK over the file", () => {
    setup([]);
    writeFileSync(join(fx.home, '.env'), 'LARK_APP_ID=cli_app\nMT_OWNER_OPEN_ID=ou_owner\nMT_ALLOW_TALK=ou_bob\n', { mode: 0o600 });
    const board = open();
    expect(board.peopleMissing).toBeUndefined();
    expect(assign(board, 'lark:on_bob')).toMatchObject({ ok: true });
    expect(assign(board, 'lark:on_alice')).toMatchObject({ ok: false, code: 'person_not_assignable' });
    expect(assign(open({ MT_ALLOW_TALK: 'ou_alice' }), 'lark:on_alice')).toMatchObject({ ok: true });
  });

  it('says which setting this shell lacks, the app id first, and still takes a role', () => {
    setup(['auth:', '  owner: ou_owner']);
    const noApp = open();
    expect(noApp.peopleMissing).toBe('appId');
    expect(assign(noApp, 'worker')).toMatchObject({ ok: false, code: 'unknown_role' });
    expect(assign(noApp, 'default')).toMatchObject({ ok: true });
    expect(assign(noApp, 'lark:on_alice')).toMatchObject({ ok: false, code: 'person_not_assignable', message: expect.stringMatching(/until the board is in Lark$/) });
    expect(open({ LARK_APP_ID: 'cli_app' }).peopleMissing).toBeUndefined();
    fx.cleanup();
    db.close();
    setup(['lark:', '  appId: cli_app']);
    expect(open().peopleMissing).toBe('owner');
    expect(open({ MT_OWNER_OPEN_ID: 'ou_owner' }).peopleMissing).toBeUndefined();
  });
});

describe('personHint', () => {
  it("adds to chat's words where to find a person's id, and leaves other refusals alone", () => {
    const talk = `"lark:on_bob" ${UNKNOWN_TALK}`;
    expect(personHint({ code: 'person_not_assignable', message: talk }, undefined)).toBe(
      `${talk}; mt kanban people lists the people this gateway knows, with their union_ids and whether they have talk tier`,
    );
    expect(personHint({ code: 'person_not_assignable', message: `ask: ${talk}` }, undefined)).toMatch(/^ask: "lark:on_bob" cannot be given work: .*; mt kanban people lists/);
    expect(personHint({ code: 'unknown_role', message: 'role "x" is not configured' }, undefined)).toBe('role "x" is not configured');
  });

  it('names what this shell lacks in place of "until the board is in Lark", never the hint', () => {
    const none = '"lark:on_bob" cannot be given work yet: nothing can deliver a task card to a person until the board is in Lark';
    expect(personHint({ code: 'person_not_assignable', message: none }, 'appId')).toBe(
      '"lark:on_bob" cannot be checked for talk tier here: this shell finds no lark.appId or LARK_APP_ID, which the people this bot has seen are kept by',
    );
    expect(personHint({ code: 'person_not_assignable', message: `a: ${none}` }, 'owner')).toBe(
      'a: "lark:on_bob" cannot be checked for talk tier here: this shell finds no auth.owner or MT_OWNER_OPEN_ID, without which there is no talk allowlist to check against',
    );
  });
});
