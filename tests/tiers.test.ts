import { describe, expect, it } from 'vitest';
import { loadConfig, sourceText, type Env } from '../src/config.js';
import { Authorizer, defaultAuthConfig, tiersOf } from '../src/policy/auth.js';
import type { Tier } from '../src/types.js';

/**
 * `tiersOf` (the tier grants spec §2.1): one rule for a person's two tiers,
 * from the configuration's lists by open_id and their active grant; and
 * where each list came from (§5.1), as `loadConfig` records it.
 */

const LISTS = { allowTalk: ['ou_owner', 'ou_talk', 'ou_both'], allowOperate: ['ou_owner', 'ou_both', 'ou_op_only'] };

describe('tiersOf', () => {
  it('gives talk by the talk list or any grant, and operate by talk with the operate list or an operate grant', () => {
    const rows: Array<[string | null, Tier | undefined, boolean, boolean]> = [
      ['ou_owner', undefined, true, true],
      ['ou_talk', undefined, true, false],
      ['ou_talk', 'talk', true, false],
      ['ou_talk', 'operate', true, true],
      ['ou_both', undefined, true, true],
      ['ou_both', 'talk', true, true],
      // In auth.operate alone: no tier, until a grant of talk makes them an operator.
      ['ou_op_only', undefined, false, false],
      ['ou_op_only', 'talk', true, true],
      ['ou_op_only', 'operate', true, true],
      ['ou_none', undefined, false, false],
      ['ou_none', 'talk', true, false],
      ['ou_none', 'operate', true, true],
      // A person people does not hold matches no list, and is judged by the grant alone.
      [null, undefined, false, false],
      [null, 'talk', true, false],
      [null, 'operate', true, true],
    ];
    for (const [openId, grant, talk, operate] of rows) {
      expect(tiersOf(LISTS, openId, grant), JSON.stringify({ openId, grant })).toEqual({ talk, operate });
    }
  });

  it("is the Authorizer's rule, which has no grants yet", () => {
    const a = new Authorizer({ ...defaultAuthConfig('ou_owner'), ...LISTS });
    for (const openId of ['ou_owner', 'ou_talk', 'ou_both', 'ou_op_only', 'ou_none']) {
      const p = { openId, unionId: `on_${openId}`, displayName: null };
      expect({ talk: a.canTalk(p), operate: a.canOperate(p) }, openId).toEqual(tiersOf(LISTS, openId, undefined));
    }
  });
});

describe("where the configuration's lists came from", () => {
  const BASE: Env = { MT_HOME: '/var/lib/mt', MT_WORKSPACE: '/srv/repo', MT_AGENT_COMMAND: 'bytesec', LARK_APP_ID: 'cli_app', LARK_APP_SECRET: 's' };
  const file = (): string => 'auth:\n  owner: ou_owner\n  talk: [ou_a]\n  operate: [ou_a]\n';

  it('names the file key, or the variable that overrides it, an empty one included', () => {
    expect(loadConfig(BASE, file).auth.from).toEqual({ owner: 'auth.owner', talk: 'auth.talk', operate: 'auth.operate' });
    expect(loadConfig({ ...BASE, MT_OWNER_OPEN_ID: 'ou_boss', MT_ALLOW_TALK: '', MT_ALLOW_OPERATE: 'ou_b' }, file).auth.from).toEqual({
      owner: 'MT_OWNER_OPEN_ID',
      talk: 'MT_ALLOW_TALK',
      operate: 'MT_ALLOW_OPERATE',
    });
    // A blank owner variable is unset, as ownerOf reads it.
    expect(loadConfig({ ...BASE, MT_OWNER_OPEN_ID: ' ' }, file).auth.from.owner).toBe('auth.owner');
  });

  it('says a file key with the file, and a variable alone', () => {
    expect(sourceText('auth.talk')).toBe('from auth.talk in config.yaml');
    expect(sourceText('MT_ALLOW_TALK')).toBe('from MT_ALLOW_TALK');
    expect(sourceText('auth.owner')).toBe('from auth.owner in config.yaml');
  });
});
