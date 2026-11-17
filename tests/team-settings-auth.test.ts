import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig, loadTeamSettings, type FileReader } from '../src/config.js';

/**
 * The talk allowlist and the chats as a terminal reads them (kanban spec
 * §22.1, §22.2): `TeamSettings.talk` and `TeamSettings.chats`, read by the
 * same helpers as `loadConfig`'s `auth.allowTalk` and `auth.allowChats`, so the
 * two cannot drift. `talk` is there only with an owner, the owner always in it.
 */

const HOME = '/var/lib/mt';
const PATH = join(HOME, 'config.yaml');
const BASE = { MT_HOME: HOME, LARK_APP_SECRET: 'app-secret' };

function file(auth: Record<string, unknown> | undefined): FileReader {
  const text = stringify({ workspace: '/srv/repo', lark: { appId: 'cli_app' }, agent: { command: 'bytesec' }, ...(auth === undefined ? {} : { auth }) });
  return (path) => (path === PATH ? text : undefined);
}

describe('TeamSettings.talk and TeamSettings.chats', () => {
  it("equal loadConfig's allowTalk and allowChats for each mix of the environment and the file", () => {
    const files = [
      { owner: 'ou_owner' },
      { owner: 'ou_owner', talk: ['ou_a', 'ou_b'], chats: ['oc_team'] },
      { owner: 'ou_owner', talk: ['ou_owner', 'ou_a'], chats: [] },
    ];
    const envs: Array<Record<string, string>> = [
      {},
      { MT_OWNER_OPEN_ID: 'ou_boss' },
      { MT_ALLOW_TALK: 'ou_c, ou_d,ou_c' },
      { MT_ALLOW_TALK: '' },
      { MT_ALLOW_CHATS: 'oc_x,oc_y' },
      { MT_ALLOW_CHATS: '' },
      { MT_OWNER_OPEN_ID: 'ou_boss', MT_ALLOW_TALK: 'ou_a', MT_ALLOW_CHATS: 'oc_z' },
    ];
    for (const auth of files) {
      for (const over of envs) {
        const env = { ...BASE, ...over };
        const gateway = loadConfig(env, file(auth));
        const team = loadTeamSettings(env, file(auth));
        const at = JSON.stringify({ auth, over });
        expect(team.talk, at).toEqual(gateway.auth.allowTalk);
        expect(team.chats, at).toEqual(gateway.auth.allowChats);
      }
    }
  });

  it('has no talk without an owner, and chats empty when neither sets any', () => {
    const team = loadTeamSettings(BASE, file(undefined));
    expect(team.talk).toBeUndefined();
    expect(team.chats).toEqual([]);
    expect(loadTeamSettings({ ...BASE, MT_ALLOW_TALK: 'ou_a', MT_ALLOW_CHATS: 'oc_a' }, file(undefined))).toMatchObject({ chats: ['oc_a'] });
    expect(loadTeamSettings({ ...BASE, MT_ALLOW_TALK: 'ou_a' }, file(undefined)).talk).toBeUndefined();
    expect(loadTeamSettings({ ...BASE, MT_OWNER_OPEN_ID: 'ou_boss', MT_ALLOW_TALK: 'ou_a' }, file(undefined)).talk).toEqual(['ou_boss', 'ou_a']);
  });
});
