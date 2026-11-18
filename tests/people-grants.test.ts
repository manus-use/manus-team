import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grantTier, revokeGrant, tierReader } from '../src/db/grants.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import { Authorizer, defaultAuthConfig, tiersOf } from '../src/policy/auth.js';
import type { Role } from '../src/roles.js';
import type { Tier } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { ALICE, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * A person named by principal, with grants (the tier grants spec §4.3): the
 * board's people built as the gateway builds them, over the configuration's
 * lists and the Authorizer's grant read, so a granted person is given work
 * whether or not `people` holds them, and a revoked one is refused.
 */

let h: TestDb;
let service: KanbanService;
const CONFIG = { ...defaultAuthConfig('ou_owner'), allowTalk: ['ou_owner', 'ou_listed'] };
const ACTOR = { by: 'operator:alice', via: 'terminal' as const, chat: null };

const ROLE: Role = {
  name: 'implementer',
  source: 'directory',
  dir: undefined,
  description: undefined,
  workspace: undefined,
  agent: { driver: 'structured-cli', command: 'bytesec', args: [], env: {}, unsupervised: true, passEnv: [], readOnlyTools: [], maskExempt: [] },
  roleMdPath: undefined,
  skills: [],
  secretValues: [],
};

beforeEach(() => {
  h = testDb();
  const authorizer = new Authorizer(CONFIG, { grants: { tierOf: tierReader(h.db, 'cli_app') } });
  const people = new PeopleDirectory({
    db: h.db,
    appId: 'cli_app',
    canTalk: (person) => tiersOf(CONFIG, person.openId, authorizer.grantOf(person.unionId)).talk,
  });
  people.saw({ openId: 'ou_listed', unionId: 'on_listed', name: 'Listed' });
  people.saw({ openId: 'ou_seen', unionId: 'on_seen', name: 'Seen' });
  service = new KanbanService({ db: h.db, roles: new Map([['implementer', ROLE]]), workspaces: WORKSPACES, people });
});
afterEach(() => h.close());

function grant(unionId: string, tier: Tier): void {
  grantTier(h.db, { appId: 'cli_app', unionId, openId: `ou_${unionId.slice(3)}`, tier, ...ACTOR }, () => ({ write: 'insert' as const }), 1);
}

const assign = (principal: string) => service.create({ title: 'Write it up', assignee: principal, createdBy: ALICE, createdVia: VIA });

describe('the board, with grants', () => {
  it('gives work to a person in the talk list, and to one granted talk, seen or not', () => {
    expect(assign('lark:on_listed')).toMatchObject({ ok: true });
    expect(assign('lark:on_seen')).toMatchObject({ ok: false, code: 'person_not_assignable' });
    grant('on_seen', 'talk');
    grant('on_unseen', 'operate');
    expect(assign('lark:on_seen')).toMatchObject({ ok: true, task: { assignee: { kind: 'human', name: 'lark:on_seen' } } });
    expect(assign('lark:on_unseen')).toMatchObject({ ok: true });
  });

  it('refuses a person once their grant is revoked', () => {
    grant('on_seen', 'talk');
    expect(assign('lark:on_seen')).toMatchObject({ ok: true });
    revokeGrant(h.db, { appId: 'cli_app', unionId: 'on_seen', ...ACTOR }, () => ({ write: 'end' as const }), 2);
    expect(assign('lark:on_seen')).toMatchObject({ ok: false, code: 'person_not_assignable' });
  });
});
