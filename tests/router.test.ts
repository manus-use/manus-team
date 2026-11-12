import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACK_EMOJI, KANBAN_OFF, Router, continuityLine, type InboundCardAction, type KanbanCommands } from '../src/core/router.js';
import { CARD_COALESCE_MS } from '../src/channel/card-writer.js';
import { ChannelError } from '../src/channel/types.js';
import { SessionRegistry } from '../src/core/registry.js';
import { MAX_MAILBOX_DEPTH, type SessionActor } from '../src/core/session-actor.js';
import { approvalNonce, replyUuid } from '../src/core/ids.js';
import { Authorizer, defaultAuthConfig, type AuthConfig, type Decision } from '../src/policy/auth.js';
import { getApproval, pendingForSession } from '../src/db/approvals.js';
import { resolveBinding } from '../src/db/bindings.js';
import { lastSeq, readEvents } from '../src/db/events.js';
import { setState } from '../src/db/sessions.js';
import type { Db } from '../src/db/open.js';
import type { BindingKey, InboundMessage, PermissionOption, Principal } from '../src/types.js';
import type { Workspace, WorkspaceProvider } from '../src/core/workspace.js';
import { MASK, addSecrets, clearSecrets } from '../src/secrets.js';
import { FakeChannel } from './helpers/channel.js';
import { FakeDriver, type TurnControl } from './helpers/driver.js';
import { ManualClock, settle, testDb, type TestDb } from './helpers/db.js';

/**
 * The router's job is the boring-looking part where every mistake is expensive:
 * claim before policy, silence for refusals about *who* you are, an explanation
 * for refusals about *what* you asked, and a mutating verb that refuses rather
 * than races the actor.
 *
 * Every test here goes in through `onMessage`/`onCardAction` -- the two entry
 * points a real Lark event reaches -- because the invariants are about the order
 * those two do things in, not about any one step.
 */

const NOW = 1_760_000_000_000;
const APP = 'cli_app';
const CHAT = 'oc_chat';
const CHANNEL = 'lark';

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };

const OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow', name: 'Allow once' },
  { optionId: 'deny', name: 'Deny' },
];

class FakeWorkspaces implements WorkspaceProvider {
  readonly kind = 'plain-dir' as const;

  has(workspaceId: string): boolean {
    return workspaceId === 'default';
  }

  async acquire(sessionId: string, workspaceId: string): Promise<Workspace> {
    void sessionId;
    return { id: workspaceId, kind: this.kind, cwd: '/tmp/workspace' };
  }

  async release(sessionId: string): Promise<void> {
    void sessionId;
  }
}

interface Harness {
  db: Db;
  router: Router;
  registry: SessionRegistry;
  channel: FakeChannel;
  driver: FakeDriver;
  clock: ManualClock;
  notes: string[];
  authorizer: Authorizer;
}

const open: TestDb[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function harness(
  opts: { auth?: Partial<AuthConfig>; authorizer?: Authorizer; kanban?: KanbanCommands } = {},
): Harness {
  const t = testDb();
  open.push(t);
  const clock = new ManualClock(NOW);
  const channel = new FakeChannel({ clock });
  const driver = new FakeDriver();
  const notes: string[] = [];
  const authorizer =
    opts.authorizer ?? new Authorizer({ ...defaultAuthConfig(OWNER.openId), ...opts.auth });
  const registry = new SessionRegistry({
    db: t.db,
    drivers: new Map([['default', driver]]),
    channels: new Map([[CHANNEL, channel]]),
    workspaces: new FakeWorkspaces(),
    appId: APP,
    clock,
    note: (line) => notes.push(line),
  });
  const router = new Router({
    db: t.db,
    registry,
    authorizer,
    channel,
    channelId: CHANNEL,
    appId: APP,
    ...(opts.kanban === undefined ? {} : { kanban: opts.kanban }),
    clock,
    note: (line) => notes.push(line),
  });
  return { db: t.db, router, registry, channel, driver, clock, notes, authorizer };
}

let seq = 0;

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: `om_${++seq}`,
    appId: APP,
    chatId: CHAT,
    chatType: 'p2p',
    threadId: '',
    sender: OWNER,
    senderIsBot: false,
    text: 'do the thing',
    mentionedBot: false,
    mentionAll: false,
    attachments: [],
    createTime: NOW,
    ...over,
  };
}

/** Let the un-awaited submit chain, the driver script and the card writer run. */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await settle();
}

function lastReply(h: Harness): string {
  return h.channel.texts.at(-1)?.text ?? '';
}

function sessionCount(h: Harness): number {
  return (h.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;
}

function boundSessionId(h: Harness, threadId = ''): string | undefined {
  return resolveBinding(h.db, {
    channel: CHANNEL,
    appId: APP,
    conversationId: CHAT,
    threadId,
  })?.sessionId;
}

/**
 * Wait for the card writer to open a card.
 *
 * Its coalesce delay is a real timer, so a fixed number of flushes is a guess --
 * and an assertion about a card that has not opened yet passes vacuously.
 */
async function cardOpened(h: Harness, count = 1): Promise<void> {
  await vi.waitFor(() => expect(h.channel.cardOpens.length).toBeGreaterThanOrEqual(count));
}

/** A session with a live actor and a turn that never ends. */
async function working(h: Harness): Promise<{ sessionId: string; actor: SessionActor }> {
  h.driver.scripts = [() => new Promise<void>(() => undefined)];
  await h.router.onMessage(msg({ text: 'long one' }));
  await flush();
  const sessionId = boundSessionId(h);
  if (sessionId === undefined) throw new Error('nothing bound');
  const actor = h.registry.liveActor(sessionId);
  if (actor === undefined) throw new Error('no live actor');
  return { sessionId, actor };
}

describe('Router: dedup', () => {
  it('turns a redelivery into one turn and says so', async () => {
    const h = harness();
    const message = msg({ text: 'once' });

    await h.router.onMessage(message);
    await flush();
    await h.router.onMessage(message);
    await flush();

    expect(h.driver.lastRuntime?.prompts.map((p) => p.text)).toEqual(['once']);
    expect(h.notes.some((n) => n.includes('duplicate delivery'))).toBe(true);
  });

  it('claims the message before policy runs, so a throwing check cannot loop', async () => {
    // Store-first is not an optimization. Checking policy first works right up
    // until the policy check itself throws -- and then Feishu's re-push ladder
    // delivers the same message four more times over six hours.
    class ThrowingAuth extends Authorizer {
      override admits(): Decision {
        throw new Error('policy exploded');
      }
    }
    const h = harness({ authorizer: new ThrowingAuth(defaultAuthConfig(OWNER.openId)) });
    const message = msg();

    await h.router.onMessage(message);
    await h.router.onMessage(message);

    expect(h.notes.filter((n) => n.includes('policy exploded'))).toHaveLength(1);
    expect(h.notes.some((n) => n.includes('duplicate delivery'))).toBe(true);
  });

  it('does not dedup card clicks, because two clicks are two intents', async () => {
    const h = harness();
    const { approvalId, nonce } = await ask(h);

    const first = await h.router.onCardAction(click(approvalId, 'allow', nonce));
    const second = await h.router.onCardAction(click(approvalId, 'allow', nonce));

    expect(first).toContain('Sent');
    // The second is refused by `resolveApproval`, not by `seen_messages`: the
    // first answer stands, and the user is told which one it was.
    expect(second).toContain('Already answered');
  });
});

describe('Router: refusals', () => {
  it('stays silent about who the sender is', async () => {
    const h = harness();
    await h.router.onMessage(msg({ sender: GUEST }));
    // Replying would confirm the bot is present and listening to someone who was
    // not supposed to have its attention.
    expect(h.channel.calls).toEqual([]);
  });

  it('stays silent in a group it was not addressed in', async () => {
    const h = harness();
    await h.router.onMessage(msg({ chatType: 'group', mentionedBot: false }));
    expect(h.channel.calls).toEqual([]);
  });

  it('explains a refusal about what was asked', async () => {
    const h = harness();
    await h.router.onMessage(
      msg({ chatType: 'group', mentionedBot: true, mentionAll: true }),
    );
    // This one goes to someone already allowed to talk, who otherwise sees the
    // bot ignore them for no visible reason.
    expect(lastReply(h)).toContain('@all');
  });

  it('explains a disabled direct message', async () => {
    const h = harness({ auth: { allowDirectMessages: false } });
    await h.router.onMessage(msg());
    expect(lastReply(h)).toContain('Direct messages are disabled');
  });

  it('never creates a session to have somewhere to log a refusal', async () => {
    const h = harness();
    await h.router.onMessage(msg({ sender: GUEST }));
    // Otherwise an unauthorized sender allocates sessions by being refused, which
    // is a denial-of-service with extra steps.
    expect(sessionCount(h)).toBe(0);
    // Naming the sender is the point of the line: the first-run failure is an owner
    // id that does not match, and the id needed to fix it is the one being refused.
    const note = h.notes.find((n) => n.includes('with no bound session'));
    expect(note).toBeDefined();
    expect(note).toContain(GUEST.openId);
  });

  it('logs a refusal into the session that already exists, sender only', async () => {
    const h = harness({ auth: { allowTalk: [OWNER.openId, GUEST.openId] } });
    await h.router.onMessage(msg({ text: 'hello' }));
    await flush();
    const sessionId = boundSessionId(h);
    expect(sessionId).toBeDefined();

    h.authorizer.reconfigure(defaultAuthConfig(OWNER.openId));
    await h.router.onMessage(msg({ sender: GUEST, text: 'secret plan' }));

    const events = readEvents(h.db, sessionId ?? '', 0, lastSeq(h.db, sessionId ?? ''));
    const rejected = events.filter((e) => e.type === 'policy_rejected');
    expect(rejected).toHaveLength(1);
    const payload = rejected[0]?.payload as { reason: string; sender: string };
    expect(payload.reason).toBe('sender_not_allowed');
    expect(payload.sender).toBe(GUEST.openId);
    // A rejected message was never accepted. Storing its body would keep exactly
    // the data we just declined to act on.
    expect(JSON.stringify(rejected[0]?.payload)).not.toContain('secret plan');
  });
});

describe('Router: commands', () => {
  it('refuses an unknown command instead of forwarding it as a prompt', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/statsu' }));
    expect(lastReply(h)).toContain('/statsu');
    expect(lastReply(h)).toContain('/help');
    expect(sessionCount(h)).toBe(0);
  });

  it('escapes the unknown command name it echoes back', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/no_such_thing' }));
    // The name is user-authored text on its way into a markdown render.
    expect(lastReply(h)).toContain('no\\_such\\_thing');
  });

  it('lists commands with their tier', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/help' }));
    expect(lastReply(h)).toContain('/new');
    expect(lastReply(h)).toContain('operator');
  });

  it('answers /status without a session rather than creating one', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/status' }));
    expect(lastReply(h)).toBe('No session here yet.');
    expect(sessionCount(h)).toBe(0);
  });

  it('reports the projected status, not a state name', async () => {
    const h = harness();
    await working(h);
    await h.router.onMessage(msg({ text: '/status' }));
    expect(lastReply(h)).toContain('**working**');
    expect(lastReply(h)).toContain('1 open turn(s)');
  });

  it('says which provider session the last turn ran in, and how it reached it', async () => {
    const h = harness();
    h.driver.scripts = [
      (ctl) => {
        ctl.emit({ kind: 'session-observed', providerSessionId: 'ses_abc', mode: 'replayed' });
        ctl.end('completed');
      },
      (ctl) => {
        ctl.emit({ kind: 'session-observed', providerSessionId: 'ses_abc', mode: 'resumed' });
        ctl.end('completed');
      },
    ];
    await h.router.onMessage(msg({ text: 'remember pickle' }));
    await flush();
    await h.router.onMessage(msg({ text: 'what did I say?' }));
    await flush();
    await h.router.onMessage(msg({ text: '/status' }));
    // The latest turn's, not the first's.
    expect(lastReply(h)).toMatch(/\nprovider session `ses_abc`: the last turn resumed it$/);
  });

  it('says nothing of a provider session no turn has reported', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'hello' }));
    await flush();
    await h.router.onMessage(msg({ text: '/status' }));
    expect(lastReply(h)).not.toContain('provider session');
  });

  it('says so when nothing is bound in the chat', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/sessions' }));
    expect(lastReply(h)).toBe('No sessions bound in this chat.');
  });

  it('marks which of the chat sessions is the one you are in', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'chat scope' }));
    await flush();
    await h.router.onMessage(msg({ text: 'in a thread', threadId: 'omt_1' }));
    await flush();

    await h.router.onMessage(msg({ text: '/sessions', threadId: 'omt_1' }));
    const reply = lastReply(h);
    expect(reply).toContain(boundSessionId(h, '') ?? 'missing');
    expect(reply).toContain(boundSessionId(h, 'omt_1') ?? 'missing');
    expect(reply.split('\n').filter((l) => l.includes('(here)'))).toHaveLength(1);
    expect(reply).toContain('thread `omt_1` (here)');
  });

  it('rotates on /new and says the old session is recoverable', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const before = boundSessionId(h);

    await h.router.onMessage(msg({ text: '/new' }));
    const after = boundSessionId(h);

    expect(after).not.toBe(before);
    expect(lastReply(h)).toContain(after ?? 'missing');
    expect(lastReply(h)).toContain('archived, not deleted');
  });

  it('shows usage for /attach with no argument', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/attach' }));
    expect(lastReply(h)).toContain('Usage:');
    expect(boundSessionId(h)).toBeUndefined();
  });

  it('passes an attach refusal straight through to the chat', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/attach s_nope' }));
    expect(lastReply(h)).toBe('No session s\\_nope.');
  });

  it('masks a known secret in an attach refusal', async () => {
    clearSecrets();
    addSecrets(['sk-test-123456']);
    try {
      const h = harness();
      await h.router.onMessage(msg({ text: '/attach sk-test-123456' }));
      expect(lastReply(h)).toContain(`No session ${MASK}.`);
    } finally {
      clearSecrets();
    }
  });

  it('rebinds the thread on a successful /attach', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const first = boundSessionId(h) ?? '';
    await h.router.onMessage(msg({ text: '/new' }));

    await h.router.onMessage(msg({ text: `/attach ${first}` }));

    expect(boundSessionId(h)).toBe(first);
    expect(lastReply(h)).toContain('History replays');
  });

  it('asks for a session before acting on one', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/stop' }));
    expect(lastReply(h)).toBe('Nothing is bound here yet. Send a message first.');
  });

  it('says nothing is running when the session has no runtime', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    await h.registry.release(boundSessionId(h) ?? '');

    await h.router.onMessage(msg({ text: '/stop' }));

    // A resumable session with nothing attached. Starting one just to cancel it
    // would be the opposite of what was asked.
    expect(lastReply(h)).toBe('Nothing is running.');
    expect(h.driver.starts).toHaveLength(1);
  });

  it('cancels a turn in flight and calls cancellation a terminal', async () => {
    const h = harness();
    const { actor } = await working(h);

    await h.router.onMessage(msg({ text: '/stop' }));

    expect(h.driver.lastRuntime?.cancels).toBe(1);
    expect(lastReply(h)).toContain('not a deletion');
    // `/stop` is not a mutating verb: refusing it mid-turn would refuse it in
    // exactly the situation it exists for.
    expect(actor.status().busy).toBe(true);
  });

  it('admits that /cd is unavailable instead of silently succeeding', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();

    await h.router.onMessage(msg({ text: '/cd /somewhere/else' }));

    expect(lastReply(h)).toContain('Not available in this build');
  });

  it('refuses an operate verb to a talk-tier sender, and changes nothing', async () => {
    const h = harness({
      auth: { allowTalk: [OWNER.openId, GUEST.openId], allowOperate: [OWNER.openId] },
    });
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const before = boundSessionId(h);

    await h.router.onMessage(msg({ text: '/new', sender: GUEST }));

    expect(lastReply(h)).toContain('operator permission');
    expect(boundSessionId(h)).toBe(before);
  });

  it('records a tier refusal with the command that was refused', async () => {
    const h = harness({
      auth: { allowTalk: [OWNER.openId, GUEST.openId], allowOperate: [OWNER.openId] },
    });
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const sessionId = boundSessionId(h) ?? '';

    await h.router.onMessage(msg({ text: '/new', sender: GUEST }));

    const events = readEvents(h.db, sessionId, 0, lastSeq(h.db, sessionId));
    const payload = events.filter((e) => e.type === 'policy_rejected').at(-1)?.payload as {
      reason: string;
      detail: string;
    };
    expect(payload.reason).toBe('insufficient_tier');
    expect(payload.detail).toContain('new:');
  });

  it('refuses a mutating verb mid-turn rather than racing the actor', async () => {
    const h = harness();
    await working(h);
    const before = boundSessionId(h);

    await h.router.onMessage(msg({ text: '/new' }));

    // Bypassing means two writers for one session, and the loser's write is the
    // one the user asked for.
    expect(lastReply(h)).toContain('Busy (working)');
    expect(boundSessionId(h)).toBe(before);
  });

  it('names the approval when that is what the user has to do', async () => {
    const h = harness();
    await ask(h);

    await h.router.onMessage(msg({ text: '/new' }));

    expect(lastReply(h)).toContain('pending approval');
  });

  it('lets a read-only verb through mid-turn', async () => {
    const h = harness();
    await working(h);
    await h.router.onMessage(msg({ text: '/sessions' }));
    expect(lastReply(h)).toContain('(here)');
  });

  it('allows a mutating verb once the actor is idle', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    expect(h.registry.liveActor(boundSessionId(h) ?? '')?.status().busy).toBe(false);

    await h.router.onMessage(msg({ text: '/new' }));

    expect(lastReply(h)).toContain('Fresh session');
  });
});

describe('Router: /kanban', () => {
  afterEach(() => clearSecrets());

  /** A board that records what it was asked, and answers with `answer`. */
  function board(answer: (arg: string) => Promise<string>): KanbanCommands & {
    calls: Array<{ arg: string; messageId: string; key: BindingKey }>;
  } {
    const calls: Array<{ arg: string; messageId: string; key: BindingKey }> = [];
    return {
      calls,
      run: async (arg, message, key) => {
        calls.push({ arg, messageId: message.messageId, key });
        return { text: await answer(arg) };
      },
      threaded: () => undefined,
      card: async () => answer('card'),
    };
  }

  /** A board that creates task `k_1` for a thread of its own (spec §19.7), and records where the router says its reply went. */
  function creating(): KanbanCommands & { threads: Array<[string, BindingKey, string, string | undefined]> } {
    const threads: Array<[string, BindingKey, string, string | undefined]> = [];
    return {
      threads,
      run: async () => ({ text: 'Created `k_1`. This thread hears sk-thread-12345678', quoted: 'Created `k_1`. This chat hears', thread: 'k_1' }),
      threaded: (taskId, key, messageId, threadId) => void threads.push([taskId, key, messageId, threadId]),
      card: async () => 'unused',
    };
  }
  const inGroup = (): InboundMessage => msg({ chatType: 'group', mentionedBot: true, text: '/kanban task new Check the links' });
  const KEY: BindingKey = { channel: CHANNEL, appId: APP, conversationId: CHAT, threadId: '' };

  it("answers a fresh task from a group at chat scope in a thread on the command, staying there, and tells the board the thread", async () => {
    addSecrets(['sk-thread-12345678']);
    const kanban = creating();
    const h = harness({ kanban });
    const message = inGroup();
    await h.router.onMessage(message);
    expect(h.channel.texts).toEqual([
      {
        target: { chatId: CHAT, threadId: '', replyTo: message.messageId, replyInThread: true, stayInThread: true },
        text: `Created \`k_1\`. This thread hears ${MASK}`,
        uuid: replyUuid(APP, message.messageId, 'kanban'),
      },
    ]);
    expect(kanban.threads).toEqual([['k_1', KEY, message.messageId, `omt_${message.messageId}`]]);
  });

  it('sends the quoted words, with the same uuid, when Lark refuses the thread: 230071, a withdrawn command, 230017 or an HTTP 404', async () => {
    for (const code of [230071, 230011, 230017, 404]) {
      const kanban = creating();
      const h = harness({ kanban });
      const message = inGroup();
      h.channel.failNext('sendText', new ChannelError(code, `refused ${code}`, false));
      await h.router.onMessage(message);
      expect(h.channel.texts).toEqual([
        { target: { chatId: CHAT, threadId: '', replyTo: message.messageId }, text: 'Created `k_1`. This chat hears', uuid: replyUuid(APP, message.messageId, 'kanban') },
      ]);
      expect(kanban.threads).toEqual([['k_1', KEY, message.messageId, undefined]]);
    }
  });

  it('leaves the task at chat scope when the reply never reached Lark, or came back with no thread', async () => {
    const lost = creating();
    const h = harness({ kanban: lost });
    h.channel.failNext('sendText', new ChannelError(0, 'socket hang up', true));
    const first = inGroup();
    await h.router.onMessage(first);
    // Given up, as any reply is: nothing quoted after it.
    expect(h.channel.texts).toEqual([]);
    expect(lost.threads).toEqual([['k_1', KEY, first.messageId, undefined]]);
    expect(h.notes.some((n) => n.startsWith('reply (kanban) failed'))).toBe(true);
    const unthreaded = creating();
    const g = harness({ kanban: unthreaded });
    g.channel.replyThreads = false;
    const second = inGroup();
    await g.router.onMessage(second);
    expect(g.channel.texts.map((m) => m.target.replyInThread)).toEqual([true]);
    expect(unthreaded.threads).toEqual([['k_1', KEY, second.messageId, undefined]]);
    expect(g.notes).toContain(`kanban: the reply to ${second.messageId} came back with no thread; task k_1 stays at chat scope`);
  });

  it('answers a fresh task anyway when the board cannot record where its reply went, and notes it', async () => {
    const kanban = creating();
    kanban.threaded = () => {
      throw new Error('database_locked');
    };
    const h = harness({ kanban });
    await h.router.onMessage(inGroup());
    expect(h.channel.texts).toHaveLength(1);
    expect(h.notes).toContain("kanban: where task k_1's reply went was not recorded: database_locked");
  });

  it('says the board is off when kanban.enabled is not set, and opens no session', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/kanban task list' }));
    expect(lastReply(h)).toBe(KANBAN_OFF);
    expect(sessionCount(h)).toBe(0);
  });

  it('hands the board the whole argument, lines kept, with the message and where it was said; the reply masked', async () => {
    addSecrets(['sk-board-12345678']);
    const kanban = board(async () => 'Created `k_1`, key sk-board-12345678');
    const h = harness({ kanban });
    const message = msg({ text: '/kanban task new Draft the notes\nassignee: docs-writer', threadId: 'omt_1' });
    await h.router.onMessage(message);
    expect(kanban.calls).toEqual([
      {
        arg: 'task new Draft the notes\nassignee: docs-writer',
        messageId: message.messageId,
        key: { channel: CHANNEL, appId: APP, conversationId: CHAT, threadId: 'omt_1' },
      },
    ]);
    expect(h.channel.texts.at(-1)).toMatchObject({
      text: `Created \`k_1\`, key ${MASK}`,
      uuid: replyUuid(APP, message.messageId, 'kanban'),
    });
    expect(sessionCount(h)).toBe(0);
  });

  it('answers while the chat session is busy: it never touches that session', async () => {
    const h = harness({ kanban: board(async () => 'the board') });
    await working(h);
    await h.router.onMessage(msg({ text: '/kanban task list' }));
    expect(lastReply(h)).toBe('the board');
  });

  it('answers a board that throws with the reason, escaped and masked, and notes it', async () => {
    addSecrets(['sk-thrown-12345678']);
    const h = harness({
      kanban: board(async () => {
        throw new Error('database_locked by sk-thrown-12345678');
      }),
    });
    await h.router.onMessage(msg({ text: '/kanban task list' }));
    expect(lastReply(h)).toBe(`The board could not do that: database\\_locked by ${MASK}`);
    expect(h.notes.some((n) => n.includes('kanban command in'))).toBe(true);
  });

  it('answers a board that throws a long, many-line error in one line, cut, and notes it masked', async () => {
    addSecrets(['sk-noted-12345678']);
    const h = harness({
      kanban: board(async () => {
        throw new Error(`first line with sk-noted-12345678\n# second line\n${'x'.repeat(2000)}`);
      }),
    });
    await h.router.onMessage(msg({ text: '/kanban task list' }));
    const reply = lastReply(h);
    expect(reply.split('\n')).toHaveLength(1);
    expect(reply.startsWith(`The board could not do that: first line with ${MASK} # second line x`)).toBe(true);
    expect(reply.endsWith('…')).toBe(true);
    expect(reply.length).toBeLessThan(700);
    const noted = h.notes.find((n) => n.includes('kanban command in')) ?? '';
    expect(noted).toContain(MASK);
    expect(noted).not.toContain('sk-noted');
  });
});

describe('Router: prompts', () => {
  it('refuses an empty message instead of burning a turn on it', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '   ' }));
    expect(lastReply(h)).toBe('That message had nothing in it.');
    expect(sessionCount(h)).toBe(0);
  });

  it('submits an attachment-only message, passing the downloaded paths', async () => {
    const h = harness();
    await h.router.onMessage(
      msg({
        text: '',
        attachments: [
          { fileKey: 'f1', kind: 'image', name: 'a.png', localPath: '/tmp/a.png' },
          // Not downloaded. Attachments are injected as paths, so one without a
          // path is nothing the agent can open.
          { fileKey: 'f2', kind: 'file', name: 'b.pdf' },
        ],
      }),
    );
    await flush();

    expect(h.driver.lastRuntime?.prompts.at(0)?.paths).toEqual(['/tmp/a.png']);
  });

  it('keeps chat order across two messages arriving together', async () => {
    const h = harness();
    // The ingress lane is chat-wide because a topic's seed message carries no
    // thread_id yet: you cannot key a lane on a session you have not identified.
    await Promise.all([
      h.router.onMessage(msg({ text: 'one' })),
      h.router.onMessage(msg({ text: 'two' })),
    ]);
    await flush(20);

    expect(h.driver.lastRuntime?.prompts.map((p) => p.text)).toEqual(['one', 'two']);
  });

  it('tells the user when the mailbox is full', async () => {
    const h = harness();
    h.driver.scripts = [() => new Promise<void>(() => undefined)];
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const actor = h.registry.liveActor(boundSessionId(h) ?? '');
    if (actor === undefined) throw new Error('no actor');
    for (let i = 0; i < MAX_MAILBOX_DEPTH - 1; i += 1) {
      void actor
        .submit({ messageId: `om_fill_${i}`, appId: APP, input: { text: 'fill', paths: [] } })
        .catch(() => undefined);
    }

    const reactionsBefore = h.channel.reactions.length;
    await h.router.onMessage(msg({ text: 'one too many' }));
    await flush();

    expect(lastReply(h)).toContain('queue of prompts waiting');
    // A refused prompt is not queued, and must not be acknowledged as though it
    // were -- "Queued" followed by "queue full" contradicts itself.
    expect(h.channel.texts.some((t) => t.text.includes('Queued'))).toBe(false);
    expect(h.channel.reactions.length).toBe(reactionsBefore);
  });

  it('explains a held session rather than resuming it', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const sessionId = boundSessionId(h) ?? '';
    await h.registry.release(sessionId);
    setState(h.db, sessionId, 'quarantined', NOW);

    await h.router.onMessage(msg({ text: 'carry on' }));
    await flush();

    expect(lastReply(h)).toContain('held');
    expect(lastReply(h)).toContain('/new');
    // Held means held: the refusal happens before anything starts.
    expect(h.driver.starts).toHaveLength(1);
  });

  it('reports an unexpected submit failure with the reason', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    const actor = h.registry.liveActor(boundSessionId(h) ?? '');
    // Closed but still in the registry, which is what a shutdown race looks like.
    await actor?.close();

    await h.router.onMessage(msg({ text: 'after close' }));
    await flush();

    expect(lastReply(h)).toContain('Could not run that:');
    expect(lastReply(h)).toContain('is closed');
  });

  it('keys a control reply on the message and its purpose', async () => {
    const h = harness();
    const message = msg({ text: '/help' });
    await h.router.onMessage(message);

    // Feishu re-pushes an unacknowledged event four times over six hours. The
    // uuid is what turns those into one visible reply.
    expect(h.channel.texts.at(-1)?.uuid).toBe(replyUuid(APP, message.messageId, 'help'));
  });

  it('does not fail a message because its reply failed', async () => {
    const h = harness();
    h.channel.failNext('sendText', new Error('rate limited'));

    await h.router.onMessage(msg({ text: '/help' }));

    expect(h.notes.some((n) => n.includes('reply (help) failed'))).toBe(true);
  });
});

describe('Router: acknowledgement', () => {
  it('reacts to a prompt as soon as it is accepted', async () => {
    // The first card waits out the coalesce window and the agent's start. Without
    // something sooner, the user cannot tell "working" from "ignored".
    const h = harness();
    const message = msg({ text: 'hello' });
    await h.router.onMessage(message);

    expect(h.channel.reactions.at(0)).toEqual({
      op: 'add',
      messageId: message.messageId,
      emoji: ACK_EMOJI,
    });
  });

  it('takes the reaction back once the turn ends', async () => {
    const h = harness();
    const message = msg({ text: 'hello' });
    await h.router.onMessage(message);
    await flush();

    expect(h.channel.reactions.at(-1)).toEqual({
      op: 'remove',
      messageId: message.messageId,
      emoji: ACK_EMOJI,
    });
  });

  it('keeps the reaction while the turn is still running', async () => {
    const h = harness();
    await working(h);
    expect(h.channel.reactions.map((r) => r.op)).toEqual(['add']);
  });

  it('does not react to commands, which answer for themselves', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '/help' }));
    expect(h.channel.reactions).toEqual([]);
  });

  it('does not react to a refusal', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: '   ' }));
    expect(h.channel.reactions).toEqual([]);
  });

  it('still runs the prompt when the reaction cannot be added', async () => {
    const h = harness();
    h.channel.failNext('react', new Error('no permission for reactions'));
    await h.router.onMessage(msg({ text: 'regardless' }));
    await flush();

    expect(h.driver.lastRuntime?.prompts.map((p) => p.text)).toEqual(['regardless']);
    expect(h.notes.some((n) => n.includes('reaction'))).toBe(true);
  });

  it('says a prompt is queued, and how many are ahead of it', async () => {
    // Queued prompts produce nothing until they start: `turn_submitted` is written
    // when a turn runs, not when it is accepted. Silence there is what makes
    // people send the same thing again.
    const h = harness();
    await working(h);

    await h.router.onMessage(msg({ text: 'next' }));
    await flush();

    expect(lastReply(h)).toContain('Queued');
    expect(lastReply(h)).toContain('1 ahead');
  });

  it('counts every prompt ahead, not just the running one', async () => {
    const h = harness();
    await working(h);
    await h.router.onMessage(msg({ text: 'second' }));
    await h.router.onMessage(msg({ text: 'third' }));
    await flush();

    expect(lastReply(h)).toContain('2 ahead');
  });

  it('says nothing about a queue when the session is free', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'first' }));
    await flush();
    expect(h.channel.texts.filter((t) => t.text.includes('Queued'))).toEqual([]);
  });
});

describe('Router: reply placement', () => {
  // In a busy group, an answer posted at chat scope says nothing about which
  // question it answers. Quoting the asking message is what ties the two together.
  const inGroup = (over: Partial<InboundMessage> = {}): InboundMessage =>
    msg({ chatType: 'group', mentionedBot: true, ...over });

  it("posts a group chat's card as a reply to the message that asked", async () => {
    const h = harness();
    const message = inGroup({ text: 'what changed?' });
    await h.router.onMessage(message);
    await cardOpened(h);

    expect(h.channel.cardOpens.at(-1)?.target.replyTo).toBe(message.messageId);
  });

  it("quotes each turn's own question, not the first one", async () => {
    const h = harness();
    const first = inGroup({ text: 'one' });
    const second = inGroup({ text: 'two' });
    await h.router.onMessage(first);
    // The first card has to be frozen before the clock moves: its last write
    // stamps the coalesce window, and one landing after the advance would push the
    // second card a real second out.
    await vi.waitFor(() => expect(h.channel.cards.at(0)?.finishes).toHaveLength(1));
    // Past the card writer's coalesce window, which it measures on this clock.
    h.clock.advance(CARD_COALESCE_MS);
    await h.router.onMessage(second);
    // The writer's delay is measured on the manual clock but waited out on a real
    // timer, so poll for the second card rather than guessing a flush count.
    await cardOpened(h, 2);

    expect(h.channel.cardOpens.map((c) => c.target.replyTo)).toEqual([
      first.messageId,
      second.messageId,
    ]);
  });

  it('quotes the message a command reply answers, in a group', async () => {
    const h = harness();
    const message = inGroup({ text: '/help' });
    await h.router.onMessage(message);
    expect(h.channel.texts.at(-1)?.target.replyTo).toBe(message.messageId);
  });

  it('does not quote in a direct message, where there is only one conversation', async () => {
    const h = harness();
    await h.router.onMessage(msg({ text: 'hi' }));
    await cardOpened(h);
    await h.router.onMessage(msg({ text: '/help' }));

    expect(h.channel.cardOpens.at(-1)?.target.replyTo).toBeUndefined();
    expect(h.channel.texts.at(-1)?.target.replyTo).toBeUndefined();
  });

  it('does not quote inside a thread, which already groups the conversation', async () => {
    const h = harness();
    await h.router.onMessage(inGroup({ text: 'hi', threadId: 'omt_1' }));
    await cardOpened(h);
    expect(h.channel.cardOpens.at(-1)?.target.replyTo).toBeUndefined();
  });
});

describe('Router: attachments', () => {
  it('tells the user about a file the agent will not see', async () => {
    // A skipped file used to reach only the operator log. The user believed the
    // agent had read it; the agent never got the path.
    const h = harness();
    await h.router.onMessage(
      msg({
        text: 'summarize these',
        attachments: [
          { fileKey: 'f1', kind: 'image', name: 'ok.png', localPath: '/tmp/ok.png' },
          { fileKey: 'f2', kind: 'file', name: 'huge.zip', skipped: 'too_large' },
          { fileKey: 'f3', kind: 'file', name: 'lost.pdf', skipped: 'download_failed' },
        ],
      }),
    );
    await flush();

    const notice = h.channel.texts.find((t) => t.text.includes('huge.zip'))?.text ?? '';
    expect(notice).toContain('too large');
    expect(notice).toContain('lost.pdf');
    expect(notice).toContain('could not be downloaded');
    expect(notice).not.toContain('ok.png');
    // The rest of the message still goes through.
    expect(h.driver.lastRuntime?.prompts.at(0)?.paths).toEqual(['/tmp/ok.png']);
  });

  it('escapes the file name it echoes back', async () => {
    const h = harness();
    await h.router.onMessage(
      msg({
        attachments: [{ fileKey: 'f1', kind: 'file', name: '<at user_id="all"></at>', skipped: 'too_large' }],
      }),
    );
    await flush();
    expect(h.channel.texts.some((t) => t.text.includes('<at user_id="all">'))).toBe(false);
  });

  it('refuses a message whose only content was a file that did not arrive', async () => {
    const h = harness();
    await h.router.onMessage(
      msg({
        text: '',
        attachments: [{ fileKey: 'f1', kind: 'file', name: 'huge.zip', skipped: 'too_large' }],
      }),
    );
    await flush();

    // Nothing reached the agent, so there is nothing to burn a turn on.
    expect(sessionCount(h)).toBe(0);
    expect(lastReply(h)).toContain('huge.zip');
  });
});

describe('Router: card actions', () => {
  it('refuses a button with no payload', async () => {
    const h = harness();
    expect(await h.router.onCardAction(click('', '', ''))).toContain('missing its payload');
  });

  it("hands a board card's button to the board, whatever the presser's tier, posting nothing and noting its answer masked", async () => {
    addSecrets(['sk-card-12345678']);
    const pressed: InboundCardAction[] = [];
    const h = harness({
      auth: { allowTalk: [OWNER.openId, GUEST.openId], allowOperate: [OWNER.openId] },
      kanban: {
        run: async () => ({ text: 'unused' }),
        threaded: () => undefined,
        card: async (action) => {
          pressed.push(action);
          return 'Done: `k_1` is complete, sk-card-12345678';
        },
      },
    });
    const action = { chatId: CHAT, messageId: 'om_card', operator: GUEST, value: { kind: 'kanban', act: 'done' }, input: 'all fine' };
    // A named assignee at talk tier may press Done: the board's rules, not operator tier, decide (spec §9.2).
    // The card shows the outcome: nothing is said in the chat.
    expect(await h.router.onCardAction(action)).toBeUndefined();
    expect(pressed).toEqual([action]);
    expect(h.notes).toContain(`kanban card on om_card: Done: \`k_1\` is complete, ${MASK}`);
    clearSecrets();
  });

  it('notes a board card pressed with the board off, posting nothing, and refuses a kind it does not know', async () => {
    const h = harness();
    const value = { kind: 'kanban', act: 'done' };
    expect(await h.router.onCardAction({ chatId: CHAT, messageId: 'om_card', operator: OWNER, value })).toBeUndefined();
    expect(h.notes).toContain('kanban card on om_card pressed with the board off');
    expect(await h.router.onCardAction({ chatId: CHAT, messageId: 'om_card', operator: OWNER, value: { kind: 'poll' } })).toBe(
      'That button is not one this gateway knows.',
    );
  });

  it("notes a board card's button that throws, masked, and posts nothing", async () => {
    const h = harness({
      kanban: {
        run: async () => ({ text: 'unused' }),
        threaded: () => undefined,
        card: async () => {
          throw new Error('database_locked\nsecond line');
        },
      },
    });
    const reply = await h.router.onCardAction({ chatId: CHAT, messageId: 'om_card', operator: OWNER, value: { kind: 'kanban' } });
    expect(reply).toBeUndefined();
    expect(h.notes.some((n) => n.includes('kanban card on om_card failed'))).toBe(true);
  });

  it("answers an approval's button that says it is one, as one without a kind", async () => {
    const h = harness();
    const state = await ask(h);
    const reply = await h.router.onCardAction({ ...click(state.approvalId, 'deny', state.nonce), value: { kind: 'approval', approvalId: state.approvalId, optionId: 'deny', nonce: state.nonce } });
    expect(reply).toBe('Sent: Deny.');
  });

  it('requires operator tier to answer, the same as the equivalent command', async () => {
    const h = harness({
      auth: { allowTalk: [OWNER.openId, GUEST.openId], allowOperate: [OWNER.openId] },
    });
    const { approvalId, nonce } = await ask(h);

    const reply = await h.router.onCardAction({
      ...click(approvalId, 'allow', nonce),
      operator: GUEST,
    });

    // A card is a different input surface, not a different permission model.
    expect(reply).toContain('operator permission');
    expect(pendingForSession(h.db, boundSessionId(h) ?? '')).toHaveLength(1);
  });

  it('refuses an approval id it has never seen', async () => {
    const h = harness();
    await ask(h);
    expect(await h.router.onCardAction(click('a_nope', 'allow', 'n'))).toContain(
      'no longer exists',
    );
  });

  it('refuses a click on a session no chat points at any more', async () => {
    const h = harness();
    const { approvalId, nonce } = await ask(h);
    // `/new` revokes the binding. Inventing one to satisfy the click would
    // resurrect a session the user retired.
    await h.registry.rotate(
      { channel: CHANNEL, appId: APP, conversationId: CHAT, threadId: '' },
      OWNER,
    );

    expect(await h.router.onCardAction(click(approvalId, 'allow', nonce))).toContain(
      'no longer bound',
    );
  });

  it('releases the agent with the option that was clicked', async () => {
    const h = harness();
    const state = await ask(h);

    const reply = await h.router.onCardAction(click(state.approvalId, 'deny', state.nonce));
    await flush();

    expect(reply).toBe('Sent: Deny.');
    expect(state.outcome()).toEqual({ kind: 'selected', optionId: 'deny' });
    const row = getApproval(h.db, state.approvalId);
    expect(row?.state).toBe('resolved');
    // Identity comes from `operator.openId` on the callback, never from the card
    // payload, which Lark does not verify.
    expect(row?.resolvedBy).toBe(OWNER.unionId);
    expect(row?.resolvedVia).toBe(CHANNEL);
  });

  it('refuses an option the agent did not offer', async () => {
    const h = harness();
    const { approvalId, nonce } = await ask(h);
    expect(await h.router.onCardAction(click(approvalId, 'allow_everything', nonce))).toContain(
      'not one of the offered options',
    );
  });

  it('refuses a button from an earlier run of the session', async () => {
    const h = harness();
    const { approvalId } = await ask(h);
    expect(await h.router.onCardAction(click(approvalId, 'allow', 'not-the-nonce'))).toContain(
      'earlier run',
    );
  });
});

// ---------------------------------------------------------------------------
// Approval helpers
// ---------------------------------------------------------------------------

interface AskState {
  sessionId: string;
  approvalId: string;
  nonce: string;
  outcome: () => unknown;
}

/** Drive a turn to a pending permission request and return what a card would carry. */
async function ask(h: Harness): Promise<AskState> {
  let outcome: unknown;
  h.driver.scripts = [
    async (ctl: TurnControl) => {
      outcome = await ctl.ask('rm -rf /', OPTIONS);
      ctl.end('completed');
    },
  ];
  await h.router.onMessage(msg({ text: 'please delete everything' }));

  const sessionId = boundSessionId(h) ?? '';
  let row = pendingForSession(h.db, sessionId).at(0);
  for (let i = 0; i < 40 && row === undefined; i += 1) {
    await settle();
    row = pendingForSession(h.db, sessionId).at(0);
  }
  if (row === undefined) throw new Error('no approval was requested');

  return {
    sessionId,
    approvalId: row.approvalId,
    nonce: approvalNonce(sessionId, row.approvalId, row.generation),
    outcome: () => outcome,
  };
}

function click(
  approvalId: string,
  optionId: string,
  nonce: string,
): { chatId: string; messageId: string; operator: Principal; value: Record<string, unknown> } {
  return {
    chatId: CHAT,
    messageId: 'om_click',
    operator: OWNER,
    value: { approvalId, optionId, nonce },
  };
}

describe('continuityLine', () => {
  it('reads each mode, and drops an id that is not one argv word', () => {
    expect(continuityLine({ providerSessionId: 'ses_1', mode: 'fresh' })).toBe('\nprovider session `ses_1`: the last turn started it');
    expect(continuityLine({ providerSessionId: 'ses_1', mode: 'replayed' })).toBe(
      '\nprovider session `ses_1`: the last turn replayed the conversation into it',
    );
    expect(continuityLine({ providerSessionId: 'ses_1', mode: 'later' })).toBe('\nprovider session `ses_1`');
    expect(continuityLine({ providerSessionId: 'ses_1', mode: 'constructor' })).toBe('\nprovider session `ses_1`');
    expect(continuityLine({ providerSessionId: 'a`b', mode: 'fresh' })).toBe('');
    expect(continuityLine({ providerSessionId: '-x', mode: 'fresh' })).toBe('');
    expect(continuityLine({ providerSessionId: 'cli:1a2b3c4d', mode: 'fresh' })).toBe('');
    expect(continuityLine(null)).toBe('');
  });
});
