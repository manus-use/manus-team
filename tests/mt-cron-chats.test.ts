import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getJob, listJobs } from '../src/db/cron.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

/**
 * `mt cron add --chat` and `mt cron edit --chat` against `auth.chats` (the
 * cron spec, §6.2, kanban spec §22.1): a chat outside a non-empty list is
 * refused, in the board's words; an empty list takes any chat; a job made
 * before the check is left as it is.
 */

let fx: MtFixture;
let db: Db;

afterEach(() => {
  clearSecrets();
  db?.close();
  fx?.cleanup();
});

function setup(auth: string[]): void {
  clearSecrets();
  fx = mtFixture((ws) =>
    [`workspace: ${ws}`, 'lark:', '  appId: cli_app', ...auth, 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', 'cron:', '  tz: Asia/Shanghai', ''].join('\n'),
  );
  db = openDb(join(fx.home, 'team.db'));
  migrate(db, SCHEMA_DIR);
}

const OUTSIDE = 'oc_other is not in auth.chats, so this gateway does not act in it: add it there, or name a chat that is';

describe('mt cron --chat and auth.chats', () => {
  it('refuses on add and on edit a chat not in a non-empty auth.chats, before the add, a repeated key included', async () => {
    setup(['auth:', '  chats: [oc_team]']);
    expect(await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_other'])).toEqual({ code: 1, out: '', err: `mt: ${OUTSIDE}` });
    expect(JSON.parse((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_other', '--json'])).out)).toEqual({ ok: false, code: 'invalid', message: OUTSIDE });
    expect(listJobs(db)).toEqual([]);
    const made = JSON.parse((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_team', '--key', 'k1', '--json'])).out);
    expect(made).toMatchObject({ ok: true, existing: false, job: { delivery: { chat: 'oc_team' } } });
    const id = made.job.job_id as string;
    expect(await fx.run(['cron', 'edit', id, '--chat', 'oc_other'])).toEqual({ code: 1, out: '', err: `mt: ${OUTSIDE}` });
    expect(getJob(db, id)?.delivery?.chat).toBe('oc_team');
    // The same key, and a chat the list no longer holds: refused, not answered with the key's job.
    expect(await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_other', '--key', 'k1'])).toMatchObject({ code: 1, err: `mt: ${OUTSIDE}` });
  });

  it('takes any chat when auth.chats is empty, and MT_ALLOW_CHATS over the file', async () => {
    setup([]);
    expect((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_anywhere'])).code).toBe(0);
    expect(await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_other'], { env: { MT_ALLOW_CHATS: 'oc_team' } })).toMatchObject({ code: 1, err: `mt: ${OUTSIDE}` });
    expect((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_team'], { env: { MT_ALLOW_CHATS: 'oc_team' } })).code).toBe(0);
  });

  it('leaves a job delivering to a chat outside the list as it is, and edits its other fields', async () => {
    setup([]);
    const id = JSON.parse((await fx.run(['cron', 'add', 'every 2h', 'default', 'Check.', '--chat', 'oc_other', '--json'])).out).job.job_id as string;
    const r = await fx.run(['cron', 'edit', id, '--prompt', 'Check again.'], { env: { MT_ALLOW_CHATS: 'oc_team' } });
    expect(r.code, r.err).toBe(0);
    expect(getJob(db, id)).toMatchObject({ prompt: 'Check again.', delivery: { chat: 'oc_other' } });
  });
});
