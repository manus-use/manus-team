import { afterEach, describe, expect, it } from 'vitest';
import { MailboxFull, SessionHeld } from '../src/core/session-actor.js';
import { subscriptionsOf, wakeEventsOf } from '../src/db/kanban-read.js';
import { WAKE_BACKOFF_MAX_MS, WAKE_REFUSALS } from '../src/kanban/waker.js';
import type { TaskRow } from '../src/kanban/types.js';
import { THREAD_KEY, wakeHarness, type Answer, type WakeHarness } from './helpers/waker.js';

/**
 * The session refuses (wake spec §5.5 steps 6 to 8, §5.6): a refused attempt
 * moves no cursor, adds one to its attempt and clears its pair in one write,
 * and its conversation is tried again after 2 s, doubling to five minutes; the
 * tenth refusal in a row drops the batch, with a line in the conversation and
 * one in the log; and anything that throws before the submit is a refusal.
 */

let h: WakeHarness;
afterEach(() => {
  h.waker.stop();
  h.t.close();
});

function completed(task: TaskRow, summary = 'Booked.'): number {
  return h.event(task, 'completed', 'run:r_1', { summary });
}

function actor(): ReturnType<WakeHarness['registry']['actor']> {
  return h.registry.actor(h.registry.bindOrCreate(THREAD_KEY, { openId: 'ou_alice', unionId: 'on_alice', displayName: null }).session.id);
}

const HELD = new SessionHeld('s_w1');

describe('a refused attempt', () => {
  it.each<[string, Answer, string]>([
    ['the actor closed', { reject: new Error('session s_w1 is closed') }, 'session s_w1 is closed'],
    ['its mailbox full', { reject: new MailboxFull('s_w1', 32) }, 'session s_w1 has 32 prompts queued; refusing more'],
    ['the session held', { reject: HELD }, 'session s_w1 is quarantined and will not be resumed automatically'],
    ['a start that failed', 'fail_start', 'the turn ended failed before its prompt reached the agent'],
  ])('when %s: no cursor moves, the attempt is the next, its pair cleared, its reason kept', async (_what, answer, error) => {
    h = wakeHarness();
    const task = h.woken();
    completed(task);
    const a = actor();
    a.answers.push(answer);
    const before = subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor;
    expect(await h.round()).toBe(1);
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2, sessionId: null, turnKey: null, submitBoot: null, error });
    expect(subscriptionsOf(h.db, task.taskId)[0]?.wakeCursor).toBe(before);
  });

  it('when a newer generation took the session before delivery', async () => {
    h = wakeHarness();
    const task = h.woken();
    completed(task);
    const a = actor();
    a.answers.push('hang');
    await h.round();
    a.release('cancelled');
    await new Promise((r) => setImmediate(r));
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2, sessionId: null, error: 'the turn ended cancelled before its prompt reached the agent' });
  });

  it('is tried again after 2 s, then 4 s, doubling to five minutes, each under a new attempt and message id', async () => {
    h = wakeHarness();
    const task = h.woken();
    completed(task);
    const a = actor();
    for (let i = 0; i < 9; i += 1) a.answers.push({ reject: HELD });
    await h.round();
    const waits = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000];
    for (const wait of waits) {
      await h.clock.delay(wait - 1);
      const tried = a.submits.length;
      await h.round();
      expect(a.submits.length).toBe(tried);
      await h.clock.delay(1);
      await h.round();
      expect(a.submits.length).toBe(tried + 1);
    }
    expect(WAKE_BACKOFF_MAX_MS).toBe(300_000);
    await h.clock.delay(WAKE_BACKOFF_MAX_MS - 1);
    await h.round();
    expect(a.submits).toHaveLength(9);
    await h.clock.delay(1);
    await h.round();
    const uuid = h.wakes()[0]?.uuid;
    expect(a.submits.map((r) => r.messageId)).toEqual([`wake:${uuid}`, ...Array.from({ length: 9 }, (_x, i) => `wake:${uuid}:${i + 2}`)]);
    expect(h.wakes()[0]?.state).toBe('delivered');
  });

  it(`is dropped at the ${WAKE_REFUSALS}th in a row, its cursors moved, with a line in the conversation and one in the log`, async () => {
    h = wakeHarness();
    const one = h.woken();
    const two = h.woken();
    completed(one);
    const last = completed(two);
    const a = actor();
    for (let i = 0; i < WAKE_REFUSALS; i += 1) a.answers.push({ reject: HELD });
    for (let i = 0; i < WAKE_REFUSALS; i += 1) {
      await h.round();
      await h.clock.delay(WAKE_BACKOFF_MAX_MS);
    }
    const [wake] = h.wakes();
    expect(wake).toMatchObject({ state: 'dropped', attempt: WAKE_REFUSALS + 1 });
    expect(wake?.error).toBe('session s_w1 is quarantined and will not be resumed automatically');
    expect(subscriptionsOf(h.db, two.taskId)[0]?.wakeCursor).toBe(last);
    expect(h.lark.texts.map((t) => t.text).slice(1)).toEqual([
      `the agent could not be woken for \`${one.taskId}\`, \`${two.taskId}\`: its session refused 10 times (session s_w1 is quarantined and will not be resumed automatically), so those updates are dropped`,
    ]);
    expect(h.notes.filter((n) => n.includes('dropped after'))).toEqual([
      `kanban: wake ${wake?.wakeId} for oc_chat/omt_1 (tasks ${one.taskId}, ${two.taskId}) dropped after 10 refusals: session s_w1 is quarantined and will not be resumed automatically`,
    ]);
    // The next outcome tries again, in a batch of its own.
    completed(one, 'later');
    await h.round();
    expect(h.wakes()).toHaveLength(2);
    expect(wakeEventsOf(h.db, h.wakes()[1]?.wakeId ?? 0)).toHaveLength(1);
  });

  it('leaves the pause of one conversation to it: another thread goes on', async () => {
    h = wakeHarness();
    const task = h.woken();
    completed(task);
    actor().answers.push({ reject: HELD });
    await h.round();
    const other = h.woken(undefined, { createdVia: { kind: 'chat', channel: 'lark', appId: 'cli_app', conversationId: 'oc_chat', threadId: 'omt_2', rootId: 'om_r2', chatType: 'group' } });
    completed(other);
    expect(await h.round()).toBe(1);
    expect(h.wakes().map((w) => w.threadId)).toEqual(['omt_1', 'omt_2']);
  });
});

describe('a throw before the submit', () => {
  it('in cronTurns.turnSubmitted is a refusal: the row unstamped, its attempt the next, tried again after its pause', async () => {
    let throws = 1;
    h = wakeHarness({
      cronTurns: {
        turnSubmitted: () => {
          if (throws-- > 0) throw new Error('the cron tokens are gone');
        },
      },
    });
    const task = h.woken();
    completed(task);
    const a = actor();
    await h.round();
    expect(a.submits).toEqual([]);
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2, sessionId: null, turnKey: null, submitBoot: null, error: 'the cron tokens are gone' });
    await h.clock.delay(2_000);
    await h.round();
    expect(a.submits).toHaveLength(1);
    expect(h.wakes()[0]?.state).toBe('delivered');
  });

  it('in wakeSubmitted is a refusal: no stamp written, nothing submitted, tried again after its pause', async () => {
    h = wakeHarness();
    const task = h.woken();
    completed(task);
    const a = actor();
    const stamp = h.service.wakeSubmitted.bind(h.service);
    let throws = 1;
    h.service.wakeSubmitted = (...args: Parameters<typeof stamp>) => {
      if (throws-- > 0) throw new Error('the database is locked');
      return stamp(...args);
    };
    await h.round();
    expect(a.submits).toEqual([]);
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2, sessionId: null, turnKey: null, submitBoot: null, error: 'the database is locked' });
    await h.round();
    expect(a.submits).toEqual([]);
    await h.clock.delay(2_000);
    await h.round();
    expect(a.submits.map((r) => r.messageId)).toEqual([`wake:${h.wakes()[0]?.uuid}:2`]);
    expect(h.wakes()[0]?.state).toBe('delivered');
  });

  it('in actorFor is a refusal', async () => {
    h = wakeHarness();
    const task = h.woken();
    completed(task);
    h.registry.actorFor = async () => {
      throw new Error('there is no role gone');
    };
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2, error: 'there is no role gone' });
  });

  it('for a setter who cannot be made a session owner is a refusal', async () => {
    h = wakeHarness({ people: { canTalk: () => true, canOperate: () => true, chatNames: () => () => undefined, principalOf: () => undefined } });
    const task = h.woken();
    completed(task);
    await h.round();
    expect(h.wakes()[0]).toMatchObject({ state: 'pending', attempt: 2, error: 'the setter lark:on_alice is not known to the gateway' });
    expect(h.registry.submits).toEqual([]);
  });
});
