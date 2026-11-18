import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig, loadTeamSettings, type FileReader } from '../src/config.js';
import { grantTier, revokeGrant } from '../src/db/grants.js';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { Authorizer, defaultAuthConfig, sourcesOf } from '../src/policy/auth.js';
import { clearSecrets } from '../src/secrets.js';
import type { Tier } from '../src/types.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * The terminal's reading of the tiers (the tier grants spec §4.3, §5.1):
 * `TeamSettings.owner`, `.operate` and `.from`, read as `loadConfig` reads
 * them, the terminal's `sourcesOf` agreeing with the Authorizer's, and the
 * board's talk check at the terminal counting grants, in a database migrated
 * to them and, as having none, in one that is not.
 */

const HOME = '/var/lib/mt';
const PATH = join(HOME, 'config.yaml');
const BASE = { MT_HOME: HOME, LARK_APP_SECRET: 'app-secret' };

function file(auth: Record<string, unknown>): FileReader {
  const text = stringify({ workspace: '/srv/repo', lark: { appId: 'cli_app' }, agent: { command: 'bytesec' }, auth });
  return (path) => (path === PATH ? text : undefined);
}

describe('TeamSettings.owner, .operate and .from', () => {
  it("equal loadConfig's for each mix of the environment and the file, and agree on sourcesOf", () => {
    const files = [{ owner: 'ou_owner' }, { owner: 'ou_owner', talk: ['ou_a'], operate: ['ou_a', 'ou_b'] }];
    const envs: Array<Record<string, string>> = [
      {},
      { MT_OWNER_OPEN_ID: 'ou_boss' },
      { MT_ALLOW_OPERATE: 'ou_c, ou_d' },
      { MT_ALLOW_OPERATE: '' },
      { MT_OWNER_OPEN_ID: 'ou_boss', MT_ALLOW_TALK: 'ou_a', MT_ALLOW_OPERATE: 'ou_a' },
    ];
    for (const auth of files) {
      for (const over of envs) {
        const env = { ...BASE, ...over };
        const gateway = loadConfig(env, file(auth));
        const team = loadTeamSettings(env, file(auth));
        const at = JSON.stringify({ auth, over });
        expect(team.owner, at).toBe(gateway.auth.ownerOpenId);
        expect(team.operate, at).toEqual(gateway.auth.allowOperate);
        expect(team.from, at).toEqual(gateway.auth.from);
        const authorizer = new Authorizer({ ...defaultAuthConfig(gateway.auth.ownerOpenId), allowTalk: gateway.auth.allowTalk, allowOperate: gateway.auth.allowOperate });
        const terminal = { ownerOpenId: team.owner ?? '', allowTalk: team.talk ?? [], allowOperate: team.operate ?? [] };
        for (const openId of ['ou_owner', 'ou_boss', 'ou_a', 'ou_b', 'ou_c', 'ou_none']) {
          expect(sourcesOf(terminal, openId), `${at} ${openId}`).toEqual(authorizer.sourcesOf(openId));
        }
      }
    }
  });

  it('has no owner or operate list without an owner, and always says where the lists came from', () => {
    const team = loadTeamSettings({ ...BASE, MT_ALLOW_OPERATE: 'ou_a' }, () => stringify({ workspace: '/srv/repo', agent: { command: 'bytesec' } }));
    expect(team.owner).toBeUndefined();
    expect(team.operate).toBeUndefined();
    expect(team.from).toEqual({ owner: 'auth.owner', talk: 'auth.talk', operate: 'MT_ALLOW_OPERATE' });
  });
});

describe("the terminal's talk check, with grants", () => {
  let fx: MtFixture;
  let db: Db;

  afterEach(() => {
    clearSecrets();
    db?.close();
    fx?.cleanup();
  });

  /** A home with the board off, Bob seen without talk tier, and its database migrated to `upTo` (every migration when undefined). */
  function setup(upTo?: number): void {
    clearSecrets();
    fx = mtFixture((ws) =>
      [`workspace: ${ws}`, 'lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', ''].join('\n'),
    );
    let schema = SCHEMA_DIR;
    if (upTo !== undefined) {
      schema = mkdtempSync(join(fx.root, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) if (Number(f.slice(0, 3)) <= upTo) copyFileSync(join(SCHEMA_DIR, f), join(schema, f));
    }
    db = openDb(join(fx.home, 'team.db'));
    migrate(db, schema);
    notePerson(db, { appId: 'cli_app', unionId: 'on_bob', openId: 'ou_bob', name: 'Bob Li' }, 1);
  }

  function grant(unionId: string, tier: Tier): void {
    grantTier(db, { appId: 'cli_app', unionId, openId: `ou_${unionId.slice(3)}`, tier, by: 'operator:alice', via: 'terminal', chat: null }, () => ({ write: 'insert' as const }), 1);
  }

  const assign = async (who: string) => fx.run(['kanban', 'task', 'new', 'Book the venue', '--assignee', who, '--json']);

  it('gives work to a person granted talk, seen or not, and refuses them once revoked', async () => {
    setup();
    expect(JSON.parse((await assign('lark:on_bob')).out)).toMatchObject({ ok: false, code: 'person_not_assignable' });
    grant('on_bob', 'talk');
    grant('on_unseen', 'operate');
    const made = JSON.parse((await assign('lark:on_bob')).out) as { ok: boolean; task_id: string };
    expect(made.ok).toBe(true);
    expect(getTask(db, made.task_id)?.assignee).toEqual({ kind: 'human', name: 'lark:on_bob' });
    expect(JSON.parse((await assign('lark:on_unseen')).out)).toMatchObject({ ok: true });
    // Another bot's grant counts for nothing here.
    grantTier(db, { appId: 'cli_old', unionId: 'on_old', openId: 'ou_old', tier: 'talk', by: 'operator:alice', via: 'terminal', chat: null }, () => ({ write: 'insert' as const }), 1);
    expect(JSON.parse((await assign('lark:on_old')).out)).toMatchObject({ ok: false, code: 'person_not_assignable' });
    revokeGrant(db, { appId: 'cli_app', unionId: 'on_bob', by: 'operator:alice', via: 'terminal', chat: null }, () => ({ write: 'end' as const }), 2);
    expect(JSON.parse((await assign('lark:on_bob')).out)).toMatchObject({ ok: false, code: 'person_not_assignable' });
  });

  it('reads a database not yet migrated to 011 as having no grants', async () => {
    setup(10);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tier_grants'").get()).toBeUndefined();
    expect(JSON.parse((await assign('lark:on_bob')).out)).toMatchObject({ ok: false, code: 'person_not_assignable' });
    expect(JSON.parse((await assign('default')).out)).toMatchObject({ ok: true });
    expect((await fx.run(['kanban', 'people'])).code).toBe(0);
  });
});
