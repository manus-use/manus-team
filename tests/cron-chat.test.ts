import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRegistry } from '../src/core/registry.js';
import { CRON_OFF, Router } from '../src/core/router.js';
import { NamedWorkspaces } from '../src/core/workspace.js';
import { getJob, listJobs } from '../src/db/cron.js';
import { CronChat, parseAdd } from '../src/cron/chat.js';
import { CronService } from '../src/cron/service.js';
import { notePerson } from '../src/db/people.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import type { InboundMessage, Principal } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { NOW } from './helpers/cron.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { FakeDriver } from './helpers/driver.js';

/**
 * `/cron` in chat (the cron spec, §6.1): add's quotes and field lines, each
 * command's tier, a sender with no union_id, another chat's jobs unknown, and
 * cron off.
 */

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const TALKER: Principal = { openId: 'ou_talk', unionId: 'on_talk', displayName: 'Talker' };
let h: TestDb;
let lark: FakeChannel;
let seq = 0;

beforeEach(() => {
  clearSecrets();
  h = testDb();
  lark = new FakeChannel({ id: 'lark' });
});
afterEach(() => {
  clearSecrets();
  h.close();
});

function router(cronOn = true, withPeople = false): Router {
  const config = defaultAuthConfig(OWNER.openId);
  const authorizer = new Authorizer({ ...config, allowTalk: [OWNER.openId, TALKER.openId] });
  const service = new CronService({ db: h.db, roles: new Map([['worker', role('worker')]]), workspaces: new Set(['default']), zone: 'Asia/Shanghai', clock: new ManualClock(NOW) });
  const registry = new SessionRegistry({
    db: h.db,
    drivers: new Map([['default', new FakeDriver()]]),
    channels: new Map([['lark', lark]]),
    workspaces: new NamedWorkspaces(new Map([['default', '/tmp/ws']])),
    appId: 'cli_app',
  });
  return new Router({
    db: h.db,
    registry,
    authorizer,
    channel: lark,
    channelId: 'lark',
    appId: 'cli_app',
    // The people directory, as the gateway gives it: a sender is noted, and named by it.
    ...(cronOn
      ? {
          cron: new CronChat({
            db: h.db,
            service,
            hasTier: (p, tier) => authorizer.hasTier(p, tier),
            ...(withPeople ? { people: new PeopleDirectory({ db: h.db, appId: 'cli_app', canTalk: () => true }) } : {}),
          }),
        }
      : {}),
  });
}

function msg(text: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: `om_cron_${++seq}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: '',
    sender: OWNER,
    senderIsBot: false,
    text,
    mentionedBot: true,
    mentionAll: false,
    mentions: [],
    attachments: [],
    createTime: Date.now(),
    ...extra,
  };
}

async function say(r: Router, text: string, extra: Partial<InboundMessage> = {}): Promise<string> {
  const before = lark.texts.length;
  await r.onMessage(msg(text, extra));
  return lark.texts.slice(before).map((t) => t.text).join('\n');
}

describe('parseAdd', () => {
  it('reads the quoted schedule, curly quotes too, the role, and the prompt across lines with field lines among them', () => {
    expect(parseAdd('“every weekday 09:00” worker List the PRs\nthat are open\nname: Daily PRs\nTZ: UTC\nand how old they are\nscript: gh pr list')).toEqual({
      ok: true,
      command: {
        schedule: 'every weekday 09:00',
        role: 'worker',
        prompt: 'List the PRs\nthat are open\nand how old they are',
        fields: { name: 'Daily PRs', tz: 'UTC', script: 'gh pr list' },
      },
    });
    expect(parseAdd('"0 9 * * 1-5" worker "Say hello."')).toMatchObject({ ok: true, command: { schedule: '0 9 * * 1-5', prompt: 'Say hello.' } });
  });

  it('refuses an unquoted schedule, a field twice, and a workspace line', () => {
    expect(parseAdd('every 2h worker x')).toMatchObject({ ok: false, reply: expect.stringMatching(/^The schedule is quoted/) });
    expect(parseAdd('"every 2h worker x')).toMatchObject({ ok: false, reply: expect.stringMatching(/^The schedule's quotes are not closed/) });
    expect(parseAdd('"every 2h" worker x\nname: a\nname: b')).toEqual({ ok: false, reply: '`name:` is given twice; give each field once.' });
    expect(parseAdd('"every 2h" worker x\nworkspace: docs')).toMatchObject({ ok: false, reply: expect.stringMatching(/^`workspace:` is not a field of `\/cron add`/) });
  });
});

describe('/cron', () => {
  it("adds a job posting to this chat, answering with its schedule, zone and next run, and a redelivered message adds none", async () => {
    const r = router();
    const reply = await say(r, '/cron add "every weekday 09:00" worker List the open PRs.\nname: Daily PRs');
    expect(reply).toMatch(/^Added `c_[0-9a-z]+`, \*Daily PRs\*: every weekday 09:00 \(Asia\/Shanghai\), next 2026-11-18 09:00, as worker, posting here\.$/);
    const [job] = listJobs(h.db);
    expect(job).toMatchObject({ createdBy: 'lark:on_owner', delivery: { chat: 'oc_team', thread: '' }, idempotencyKey: expect.stringMatching(/^lark:om_cron_/) });
    expect(await say(r, '/cron list')).toMatch(/^`c_[0-9a-z]+` \*Daily PRs\*: every weekday 09:00 \(Asia\/Shanghai\), active, next 2026-11-18 09:00, last none yet$/);
  });

  it('posts a job made in a thread to that thread, replying to its root', async () => {
    const r = router();
    await say(r, '/cron add "every 2h" worker Check.', { threadId: 'omt_1', rootId: 'om_root' });
    expect(listJobs(h.db)[0]?.delivery).toEqual({ channel: 'lark', account: 'cli_app', chat: 'oc_team', thread: 'omt_1', root: 'om_root' });
  });

  it('shows a script masked, and refuses one holding a known secret', async () => {
    addSecrets(['sk-live-1234567890']);
    const r = router();
    expect(await say(r, '/cron add "every 2h" worker Check.\nscript: echo sk-live-1234567890')).toMatch(/^Not done: the script holds a known secret/);
    const reply = await say(r, '/cron add "every 2h" worker Check with sk-live-1234567890.\nscript: gh pr list');
    expect(reply).toMatch(/\nScript: `gh pr list`$/);
    expect(getJob(h.db, listJobs(h.db)[0]?.jobId ?? '')?.prompt).toBe(`Check with ${MASK}.`);
  });

  it("names a job's maker in show by the name Lark gave, noted from the sender, else by principal, two of one name told apart", async () => {
    const r = router(true, true);
    await say(r, '/cron add "every 2h" worker Check.');
    const jobId = listJobs(h.db)[0]?.jobId ?? '';
    expect(await say(r, `/cron show ${jobId}`, { sender: TALKER })).toContain(', made by Owner, ');
    notePerson(h.db, { appId: 'cli_app', unionId: 'on_owner2', openId: 'ou_owner2', name: 'Owner' }, NOW);
    expect(await say(r, `/cron show ${jobId}`, { sender: TALKER })).toContain(', made by Owner \\(on\\_owner\\), ');
    // Without the directory, the principal, as before.
    const plain = router();
    expect(await say(plain, `/cron show ${jobId}`)).toContain(', made by lark:on\\_owner, ');
  });

  it('lets talk tier list, show and see the help, and refuses the rest; a sender with no union_id changes nothing', async () => {
    const r = router();
    await say(r, '/cron add "every 2h" worker Check.');
    const jobId = listJobs(h.db)[0]?.jobId ?? '';
    expect(await say(r, '/cron list', { sender: TALKER })).toMatch(/^`c_/);
    expect(await say(r, `/cron show ${jobId}`, { sender: TALKER })).toMatch(/^`c_.*\nrole worker, workspace default/);
    expect(await say(r, '/cron help', { sender: TALKER })).toMatch(/^`\/cron add/);
    for (const v of ['pause', 'resume', 'run', 'remove']) {
      expect(await say(r, `/cron ${v} ${jobId}`, { sender: TALKER })).toBe(`\`/cron ${v}\` changes a cron job, and needs operator permission.`);
    }
    expect(await say(r, '/cron add "every 2h" worker x', { sender: TALKER })).toBe('`/cron add` changes a cron job, and needs operator permission.');
    expect(await say(r, `/cron pause ${jobId}`, { sender: { ...OWNER, unionId: null } })).toMatch(/^Lark did not say who you are/);
    expect(await say(r, '/cron list', { sender: { ...OWNER, unionId: null } })).toMatch(/^`c_/);
  });

  it("answers another chat's job as unknown, and pauses, resumes, runs and removes this chat's", async () => {
    const r = router();
    await say(r, '/cron add "every 2h" worker Check.');
    const jobId = listJobs(h.db)[0]?.jobId ?? '';
    expect(await say(r, `/cron show ${jobId}`, { chatId: 'oc_other' })).toBe(`Not done: there is no cron job ${jobId.replace('_', '\\_')}`);
    expect(await say(r, `/cron pause ${jobId}`, { chatId: 'oc_other' })).toBe(`Not done: there is no cron job ${jobId.replace('_', '\\_')}`);
    expect(await say(r, `/cron pause ${jobId}`)).toBe(`Paused \`${jobId}\`. \`/cron resume ${jobId}\` starts it again.`);
    expect(await say(r, `/cron resume ${jobId}`)).toBe(`Resumed \`${jobId}\`, next 2026-11-17 11:00.`);
    expect(await say(r, `/cron run ${jobId}`)).toBe(`Running \`${jobId}\` now; its answer is posted here.`);
    expect(await say(r, `/cron remove ${jobId}`)).toBe(`Removed \`${jobId}\`; a fire under way is stopped.`);
  });

  it('reads a newline after the verb as a space, and a job id from the first line only', async () => {
    const r = router();
    expect(await say(r, '/cron add\n"every 2h" worker Check.\nname: Checks')).toMatch(/^Added `c_[0-9a-z]+`, \*Checks\*: every 2h/);
    const jobId = listJobs(h.db)[0]?.jobId ?? '';
    expect(await say(r, `/cron show ${jobId}\nplease`)).toMatch(/^`c_.*\nrole worker, workspace default/);
    expect(await say(r, `/cron pause\n${jobId}`)).toBe(`Paused \`${jobId}\`. \`/cron resume ${jobId}\` starts it again.`);
  });

  it('answers /cron edit and an unknown command, and says cron is off when it is', async () => {
    const r = router();
    expect(await say(r, '/cron edit c_1 --prompt x')).toMatch(/^There is no `\/cron edit`/);
    expect(await say(r, '/cron frobnicate')).toMatch(/^Unknown `\/cron` command `frobnicate`\./);
    expect(await say(router(false), '/cron list')).toBe(CRON_OFF);
  });
});
