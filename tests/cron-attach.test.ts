import { afterEach, describe, expect, it } from 'vitest';
import { Router } from '../src/core/router.js';
import { firesOf } from '../src/db/cron.js';
import { createSession } from '../src/db/sessions.js';
import { Authorizer, defaultAuthConfig } from '../src/policy/auth.js';
import type { InboundMessage } from '../src/types.js';
import { NOW, answers, cronHarness, type CronHarness } from './helpers/cron.js';

/** `registry.attach` refuses a cron fire's session (the cron spec, §3.2), directly and through /attach. */

let h: CronHarness | undefined;
afterEach(() => h?.close());

const KEY = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };

describe("a cron fire's session", () => {
  it('is refused attach, naming the job from its fire, through the registry and /attach', async () => {
    h = cronHarness();
    const job = h.add();
    answers(h.driver, 'done');
    h.clock.advance(3_600_000);
    await h.tick();
    await h.scheduler.idle();
    const sessionId = firesOf(h.t.db, job.jobId)[0]?.sessionId ?? '';
    expect(await h.registry.attach(KEY, sessionId)).toEqual({ ok: false, reason: `Session ${sessionId} is a cron fire's; /cron show ${job.jobId} in its chat, or mt cron show ${job.jobId}, has what it did.` });
    const router = new Router({ db: h.t.db, registry: h.registry, authorizer: new Authorizer(defaultAuthConfig('ou_owner')), channel: h.lark, channelId: 'lark', appId: 'cli_app' });
    const message: InboundMessage = {
      messageId: 'om_attach',
      appId: 'cli_app',
      chatId: 'oc_team',
      chatType: 'p2p',
      threadId: '',
      sender: { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' },
      senderIsBot: false,
      text: `/attach ${sessionId}`,
      mentionedBot: true,
      mentionAll: false,
      mentions: [],
      attachments: [],
      createTime: NOW,
    };
    await router.onMessage(message);
    expect(h.lark.texts.at(-1)?.text).toMatch(/is a cron fire's; \/cron show c\\_[0-9a-z]+ in its chat, or mt cron show c\\_[0-9a-z]+, has what it did\.$/);
  });

  it('says only that it is a cron fire’s when no fire row is left, and a chat session is attached as before', async () => {
    h = cronHarness();
    createSession(h.t.db, { id: 's_orphan', agentId: 'worker', workspaceId: 'default', ownerPrincipal: 'cron' }, NOW);
    expect(await h.registry.attach(KEY, 's_orphan')).toEqual({ ok: false, reason: "Session s_orphan is a cron fire's." });
    createSession(h.t.db, { id: 's_chat', agentId: 'default', workspaceId: 'default', ownerPrincipal: 'on_alice' }, NOW);
    expect(await h.registry.attach(KEY, 's_chat')).toMatchObject({ ok: true });
  });
});
