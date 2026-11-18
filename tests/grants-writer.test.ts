import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeGrant,
  activeGrants,
  grantCounts,
  grantTier,
  revokeGrant,
  talkGrantsMadeBy,
  tierReader,
  type GrantRequest,
  type GrantRow,
  type GrantWrite,
  type RevokeWrite,
} from '../src/db/grants.js';
import { getTask } from '../src/db/kanban-read.js';
import { migrate, openDb } from '../src/db/open.js';
import { notePerson, personOf } from '../src/db/people.js';
import { SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { NOW, newTask } from './helpers/kanban.js';

/**
 * Migration 011 and its writer (the tier grants spec §3): every check, the one
 * active grant a person, a replace and a revoke each in one transaction, the
 * decision made on the reads inside it, and rows never deleted.
 */

let h: TestDb;
beforeEach(() => {
  h = testDb();
});
afterEach(() => h.close());

const APP = 'cli_app';
const OWNER = { by: 'operator:alice', via: 'terminal' as const, chat: null };

function row(extra: Record<string, unknown> = {}): void {
  const r = {
    app_id: APP,
    union_id: 'on_carol',
    open_id: 'ou_carol',
    tier: 'talk',
    granted_by: 'lark:on_alice',
    granted_via: 'chat',
    granted_chat: 'oc_team',
    granted_at: NOW,
    ...extra,
  };
  h.db.prepare(`INSERT INTO tier_grants (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r));
}

const always = <W extends GrantWrite | RevokeWrite>(write: W) => () => ({ write });

function grant(over: Partial<GrantRequest> = {}, write: GrantWrite = 'insert', at = NOW): GrantRow[] {
  return grantTier(h.db, { appId: APP, unionId: 'on_carol', openId: 'ou_carol', tier: 'talk', ...OWNER, ...over }, always(write), at).written;
}

const count = (): number => (h.db.prepare('SELECT count(*) AS n FROM tier_grants').get() as { n: number }).n;

describe('migration 011', () => {
  it('is version 11, STRICT, with its two indexes', () => {
    expect(Number(h.db.pragma('user_version', { simple: true }))).toBe(11);
    expect(h.db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'tier_grants'").get()).toEqual({ strict: 1 });
    const indexes = h.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tier_grants' AND name LIKE 'idx_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(['idx_tier_grants_active', 'idx_tier_grants_person']);
  });

  it('checks the tier, the via, the chat with each via, and an end written whole', () => {
    row();
    const ended = { revoked_at: NOW, revoked_by: 'lark:on_alice', revoked_via: 'chat', revoked_chat: 'oc_team', ended: 'revoked' };
    row({ union_id: 'on_a', ...ended });
    row({ union_id: 'on_b', granted_via: 'terminal', granted_chat: null, ...ended, revoked_via: 'terminal', revoked_chat: null });
    for (const bad of [
      { tier: 'admin' },
      { granted_via: 'phone' },
      { granted_chat: null },
      { granted_via: 'terminal' },
      { revoked_at: NOW },
      { ...ended, revoked_by: null },
      { ...ended, revoked_via: null, revoked_chat: null },
      { ...ended, ended: null },
      { ...ended, ended: 'expired' },
      { ...ended, revoked_chat: null },
      { ...ended, revoked_via: 'terminal' },
      { ended: 'revoked' },
    ]) {
      expect(() => row({ union_id: 'on_bad', ...bad }), JSON.stringify(bad)).toThrow(/CHECK constraint failed/);
    }
    expect(() => row({ union_id: 'on_bad', granted_at: 'now' })).toThrow(/cannot store TEXT value in INTEGER column/);
  });

  it('holds one active grant a person a bot, whatever writes it', () => {
    row();
    expect(() => row({ tier: 'operate' })).toThrow(/UNIQUE constraint failed/);
    row({ app_id: 'cli_other' });
    row({ union_id: 'on_dan' });
    row({ revoked_at: NOW, revoked_by: 'x', revoked_via: 'terminal', ended: 'revoked' });
  });

  it('migrates a database at version 10, with people and a board in it, as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-grants-schema-'));
    try {
      const only = mkdtempSync(join(dir, 'schema-'));
      for (const f of readdirSync(SCHEMA_DIR)) if (/^0(0[1-9]|10)_.*\.sql$/.test(f)) copyFileSync(join(SCHEMA_DIR, f), join(only, f));
      const d = openDb(join(dir, 'team.db'));
      try {
        expect(migrate(d, only)).toBe(10);
        const task = newTask(d);
        notePerson(d, { appId: APP, unionId: 'on_carol', openId: 'ou_carol', name: 'Carol' }, NOW);
        const before = { task: getTask(d, task.taskId), person: personOf(d, APP, 'on_carol') };
        expect(migrate(d, SCHEMA_DIR)).toBe(11);
        expect({ task: getTask(d, task.taskId), person: personOf(d, APP, 'on_carol') }).toEqual(before);
        expect(d.prepare('SELECT count(*) AS n FROM tier_grants').get()).toEqual({ n: 0 });
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('grantTier and revokeGrant', () => {
  it('inserts a grant as asked, and nothing for a decision that writes none', () => {
    expect(grant({}, 'none')).toEqual([]);
    expect(count()).toBe(0);
    const [made] = grant({ by: 'lark:on_alice', via: 'chat', chat: 'oc_team' });
    expect(made).toEqual({
      grantId: expect.any(Number),
      appId: APP,
      unionId: 'on_carol',
      openId: 'ou_carol',
      tier: 'talk',
      grantedBy: 'lark:on_alice',
      grantedVia: 'chat',
      grantedChat: 'oc_team',
      grantedAt: NOW,
      revokedAt: null,
      revokedBy: null,
      revokedVia: null,
      revokedChat: null,
      ended: null,
    });
    expect(activeGrant(h.db, APP, 'on_carol')).toEqual(made);
    expect(activeGrant(h.db, 'cli_other', 'on_carol')).toBeUndefined();
  });

  it('replaces a talk grant with an operate one in one transaction, the end taking the new grant\'s actor and time', () => {
    grant({ by: 'lark:on_bob', via: 'chat', chat: 'oc_team' });
    const written = grant({ tier: 'operate' }, 'replace', NOW + 5);
    expect(written.map((g) => [g.tier, g.ended, g.revokedAt, g.revokedBy, g.revokedVia, g.revokedChat])).toEqual([
      ['talk', 'replaced', NOW + 5, 'operator:alice', 'terminal', null],
      ['operate', null, null, null, null, null],
    ]);
    expect(written[1]?.grantedAt).toBe(NOW + 5);
    expect(activeGrant(h.db, APP, 'on_carol')?.tier).toBe('operate');
    // A replace with no talk grant to end writes nothing at all.
    expect(() => grant({ unionId: 'on_dan' }, 'replace')).toThrow(/needs an active talk grant/);
    expect(count()).toBe(2);
  });

  it('ends a grant once, and a second revoke finds nothing to end; rows are never deleted', () => {
    grant();
    const decided: Array<GrantRow | undefined> = [];
    const revoke = (write: RevokeWrite) =>
      revokeGrant(h.db, { appId: APP, unionId: 'on_carol', by: 'lark:on_bob', via: 'chat', chat: 'oc_x' }, (target) => {
        decided.push(target);
        return { write: target === undefined ? 'none' : write };
      }, NOW + 9);
    const first = revoke('end');
    expect(first.written).toEqual([expect.objectContaining({ ended: 'revoked', revokedAt: NOW + 9, revokedBy: 'lark:on_bob', revokedVia: 'chat', revokedChat: 'oc_x' })]);
    expect(revoke('end').written).toEqual([]);
    expect(decided.map((t) => t?.tier)).toEqual(['talk', undefined]);
    expect(activeGrant(h.db, APP, 'on_carol')).toBeUndefined();
    // Made again, a new row.
    grant();
    expect(count()).toBe(2);
    expect(h.db.prepare('SELECT grant_id FROM tier_grants ORDER BY grant_id').all()).toHaveLength(2);
  });

  it("decides on the reads made inside its transaction: a revoke another connection committed is seen", () => {
    grant({ unionId: 'on_bob', openId: 'ou_bob', tier: 'operate' });
    // The caller read the actor's grant before; another process revokes it.
    expect(activeGrant(h.db, APP, 'on_bob')?.tier).toBe('operate');
    const other = openDb(join(h.dir, 'team.db'));
    try {
      revokeGrant(other, { appId: APP, unionId: 'on_bob', ...OWNER }, always('end'), NOW + 1);
    } finally {
      other.close();
    }
    const seen: Array<[GrantRow | undefined, GrantRow | undefined]> = [];
    const r = grantTier(
      h.db,
      { appId: APP, unionId: 'on_carol', openId: 'ou_carol', tier: 'talk', by: 'lark:on_bob', via: 'chat', chat: 'oc_team' },
      (target, actor) => {
        seen.push([target, actor]);
        return { write: actor === undefined ? ('none' as const) : ('insert' as const) };
      },
      NOW + 2,
    );
    expect(seen).toEqual([[undefined, undefined]]);
    expect(r.written).toEqual([]);
    // An operator's login has no grant to read.
    grantTier(h.db, { appId: APP, unionId: 'on_carol', openId: 'ou_carol', tier: 'talk', ...OWNER }, (_t, actor) => {
      expect(actor).toBeUndefined();
      return { write: 'none' as const };
    }, NOW);
  });
});

describe('the reads', () => {
  it("give a grant's tier by the prepared reader, the active grants with names, the talk grants a person made, and the counts", () => {
    notePerson(h.db, { appId: APP, unionId: 'on_carol', openId: 'ou_carol', name: 'Carol' }, NOW);
    grant({ by: 'lark:on_dan' });
    grant({ unionId: 'on_erin', openId: 'ou_erin', by: 'lark:on_dan' });
    grant({ unionId: 'on_dan', openId: 'ou_dan', tier: 'operate' });
    grant({ appId: 'cli_old', unionId: 'on_x', openId: 'ou_x' });
    grant({ appId: 'cli_old', unionId: 'on_y', openId: 'ou_y', tier: 'operate' });
    revokeGrant(h.db, { appId: APP, unionId: 'on_erin', ...OWNER }, always('end'), NOW);

    const tierOf = tierReader(h.db, APP);
    expect([tierOf('on_carol'), tierOf('on_dan'), tierOf('on_erin'), tierOf('on_x')]).toEqual(['talk', 'operate', undefined, undefined]);
    expect(activeGrants(h.db, APP).map((g) => [g.unionId, g.tier, g.name])).toEqual([
      ['on_carol', 'talk', 'Carol'],
      ['on_dan', 'operate', null],
    ]);
    expect(talkGrantsMadeBy(h.db, APP, 'lark:on_dan')).toBe(1);
    expect(talkGrantsMadeBy(h.db, APP, 'lark:on_carol')).toBe(0);
    expect(grantCounts(h.db, APP)).toEqual({ talk: 1, operate: 1, otherApps: 2 });
    expect(grantCounts(h.db, 'cli_none')).toEqual({ talk: 0, operate: 0, otherApps: 4 });
  });

  it('are the only writer of tier_grants', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const writers = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && /(INSERT INTO|UPDATE|DELETE FROM) tier_grants/.test(readFileSync(join(src, f), 'utf8')),
    );
    expect(writers).toEqual([join('db', 'grants.ts')]);
    expect(readFileSync(new URL('../src/db/WRITERS.md', import.meta.url), 'utf8')).toMatch(/\| `tier_grants` \| `db\/grants\.ts` \|/);
  });
});
