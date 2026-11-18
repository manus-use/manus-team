import { describe, expect, it, vi } from 'vitest';
import { CARD_FAILURE_LIMIT, CARD_MAX_AGE_MS, CARD_THROTTLE_BUDGET_MS, CardWriter, TOOL_LINE_DELAY_MS } from '../src/channel/card-writer.js';
import { ChannelError } from '../src/channel/types.js';
import type { Event, EventType } from '../src/types.js';
import { FakeChannel } from './helpers/channel.js';
import { ManualClock } from './helpers/db.js';

const NOW = 1_760_000_000_000;

function ev(seq: number, type: EventType, payload: unknown): Event {
  return {
    sessionId: 's_1',
    seq,
    type,
    actor: type === 'turn_submitted' ? 'user' : 'agent',
    generation: 0,
    payload,
    ts: NOW,
    brokerSeq: null,
    turnId: 't_1',
  };
}

interface Harness {
  writer: CardWriter;
  channel: FakeChannel;
  clock: ManualClock;
  log: Event[];
  /** Append one chunk and return the seq it landed at. */
  chunk(text: string): number;
  end(terminal: string): number;
  /** Append a prompt, which is what starts a new card. */
  submit(text: string): number;
  rendered: number[];
  cardChanges: Array<string | null>;
  notes: string[];
}

function harness(): Harness {
  const clock = new ManualClock(NOW);
  const channel = new FakeChannel({ clock });
  const log: Event[] = [];
  const rendered: number[] = [];
  const cardChanges: Array<string | null> = [];
  const notes: string[] = [];

  const writer = new CardWriter({
    channel,
    target: { chatId: 'oc_chat', threadId: '' },
    readEvents: (afterSeq, throughSeq) =>
      log.filter((e) => e.seq > afterSeq && e.seq <= throughSeq),
    onRendered: (seq) => rendered.push(seq),
    onCardChanged: (id) => cardChanges.push(id),
    sendUuid: (seq) => `uuid_${seq}`,
    clock,
    note: (line) => notes.push(line),
  });

  return {
    writer,
    channel,
    clock,
    log,
    rendered,
    cardChanges,
    notes,
    chunk(text: string): number {
      const seq = log.length + 1;
      log.push(ev(seq, 'agent_message_chunk', { text }));
      return seq;
    },
    end(terminal: string): number {
      const seq = log.length + 1;
      log.push(ev(seq, 'turn_ended', { terminal }));
      return seq;
    },
    submit(text: string): number {
      const seq = log.length + 1;
      log.push(ev(seq, 'turn_submitted', { text }));
      return seq;
    },
  };
}

describe('CardWriter', () => {
  it('opens the card on the first render and reports the message id once', async () => {
    const h = harness();
    h.writer.want(h.chunk('hello'));
    await h.writer.flushNow();

    expect(h.channel.calls).toEqual(['openCard']);
    expect(h.cardChanges).toEqual([h.channel.lastCard?.messageId]);
    expect(h.channel.lastCard?.text).toContain('hello');
    expect(h.writer.messageId).toBe(h.channel.lastCard?.messageId);
  });

  it('does not re-set content the open call already delivered', async () => {
    // The initial text goes out with `openCard`; a `set` right behind it is a
    // second round-trip for a card that already shows the right thing.
    const h = harness();
    h.writer.want(h.chunk('hello'));
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual(['openCard']);
  });

  it('reuses the open card for later renders', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.channel.calls).toEqual(['openCard', 'set']);
    expect(h.channel.cards).toHaveLength(1);
    expect(h.channel.lastCard?.text).toContain('ab');
  });

  it('ignores a request for a seq it has already been asked for', async () => {
    const h = harness();
    h.chunk('a');
    h.chunk('b');
    h.writer.want(2);
    h.writer.want(1);
    await h.writer.flushNow();
    expect(h.rendered).toEqual([2]);
  });

  it('keeps exactly one write in flight', async () => {
    // Feishu's write ordering does not decide which render is current. Two
    // concurrent writes means the loser can land last.
    const h = harness();
    h.writer.want(h.chunk('a'));
    h.channel.hold();
    const first = h.writer.flushNow();
    h.writer.want(h.chunk('b'));
    const second = h.writer.flushNow();

    expect(h.channel.calls).toEqual(['openCard']);
    h.channel.release();
    await Promise.all([first, second]);
    expect(h.channel.calls.filter((c) => c === 'openCard')).toHaveLength(1);
  });

  it('collapses everything queued during a write into one later render', async () => {
    // The queue is a single integer, so three chunks arriving mid-write cost one
    // extra write, not three.
    const h = harness();
    h.writer.want(h.chunk('a'));
    h.channel.hold();
    const inFlight = h.writer.flushNow();

    h.writer.want(h.chunk('b'));
    h.writer.want(h.chunk('c'));
    h.writer.want(h.chunk('d'));

    h.channel.release();
    await inFlight;
    await h.writer.flushNow();

    expect(h.channel.calls).toEqual(['openCard', 'set']);
    expect(h.channel.lastCard?.text).toContain('abcd');
    expect(h.rendered).toEqual([1, 4]);
  });

  it('renders the newest state after a failure, not the state that failed', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();

    h.channel.failNext('set', new ChannelError(99991400, 'throttled', true));
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();
    expect(h.rendered).toEqual([1]);

    h.writer.want(h.chunk('c'));
    await h.writer.flushNow();
    expect(h.rendered).toEqual([1, 3]);
    expect(h.channel.lastCard?.text).toContain('abc');
  });

  it('does not advance the cursor for a write that failed', async () => {
    // Advancing it would make the next render start after content that was never
    // displayed, so the failure becomes a silent hole in the transcript.
    const h = harness();
    h.channel.failNext('openCard', new ChannelError(99991400, 'throttled', true));
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();

    expect(h.rendered).toEqual([]);
    expect(h.writer.renderedThrough).toBe(0);
  });

  it('opens a fresh card when the old one is gone, and clears the stored id', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    const firstId = h.channel.lastCard?.messageId;

    h.channel.failNext('set', new ChannelError(230011, 'message withdrawn', false));
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.cardChanges).toEqual([firstId, null]);

    await h.writer.flushNow();
    expect(h.channel.cards).toHaveLength(2);
    // Re-rendered from the log, so nothing that happened before the withdrawal is
    // lost.
    expect(h.channel.lastCard?.text).toContain('ab');
    expect(h.cardChanges.at(-1)).toBe(h.channel.lastCard?.messageId);
  });

  it('keeps the card on a failure that is not a gone-card code', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.channel.failNext('set', new ChannelError(99991400, 'throttled', true));
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    await h.writer.flushNow();
    expect(h.channel.cards).toHaveLength(1);
  });

  it('treats a non-ChannelError as a plain failure rather than a lost card', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.channel.failNext('set', new Error('socket hang up'));
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.cardChanges).toHaveLength(1);
  });

  it('rotates a card before the entity expires rather than at the edge', async () => {
    // An expired entity fails as an update that silently stops landing, which is
    // indistinguishable from an idle agent.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();

    h.clock.advance(CARD_MAX_AGE_MS + 1);
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(2);
    expect(h.channel.lastCard?.text).toContain('ab');
  });

  it('freezes the card when the render reports a terminal', async () => {
    const h = harness();
    h.chunk('done');
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();

    // Opened and frozen in the same pass: a card that is already final when first
    // written must not be left streaming.
    expect(h.channel.calls).toEqual(['openCard', 'finish']);
    expect(h.channel.lastCard?.finishes).toHaveLength(1);
  });

  it('freezes an already-open card on the terminal render', async () => {
    const h = harness();
    h.writer.want(h.chunk('working'));
    await h.writer.flushNow();
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();

    expect(h.channel.calls).toEqual(['openCard', 'finish']);
  });

  it('opens a new card for the next turn instead of writing to the frozen one', async () => {
    // The failure this exists for, observed in production: the first prompt was
    // answered and the next three looked unanswered. `set` on a frozen card is
    // accepted and discarded, so nothing failed, the cursor advanced, and three
    // real answers were gone with no error anywhere.
    const h = harness();
    h.chunk('first answer');
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();
    const firstCard = h.channel.lastCard;

    h.submit('second ask');
    h.writer.want(h.chunk('second answer'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(2);
    expect(h.channel.lastCard).not.toBe(firstCard);
    expect(h.channel.lastCard?.text).toContain('second answer');
    // The whole point: nothing was written into the closed stream.
    expect(firstCard?.droppedSets).toEqual([]);
    expect(firstCard?.text).toContain('first answer');
  });

  it('shows the new reply on its own card, not under the previous answer', async () => {
    const h = harness();
    h.submit('first ask');
    h.chunk('first answer');
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();

    h.submit('second ask');
    h.writer.want(h.chunk('second answer'));
    await h.writer.flushNow();

    expect(h.channel.lastCard?.text).not.toContain('first answer');
  });

  it('freezes the card it is leaving behind', async () => {
    // Coalescing can put the terminal and the next turn's first chunk in one
    // render. Nothing will ever write to the old card again, so a card left
    // streaming here keeps its typing indicator forever.
    const h = harness();
    h.writer.want(h.chunk('an answer'));
    await h.writer.flushNow();
    const first = h.channel.lastCard;

    h.end('completed');
    h.submit('next ask');
    h.writer.want(h.chunk('the next answer'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(2);
    expect(first?.finishes).toHaveLength(1);
    // Frozen showing its own turn, not a preview of the next one.
    expect(first?.text).toContain('an answer');
    expect(first?.text).not.toContain('the next answer');
  });

  it('still opens the next card when tidying the old one fails', async () => {
    // The old card is cosmetic; the new one carries the answer.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();

    h.channel.failNext('finish', new ChannelError(230011, 'withdrawn', false));
    h.submit('next');
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(2);
    expect(h.channel.lastCard?.text).toContain('b');
  });

  it('keeps one card for the whole of one turn', async () => {
    const h = harness();
    h.submit('ask');
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(1);
    expect(h.channel.calls).toEqual(['openCard', 'set', 'finish']);
  });

  it('hands the card its parts, so the adapter can write each to its own element', async () => {
    // Channel spec §4.5: the tool line and the answer are separate elements, so
    // the writer passes the render's parts, not one text.
    const h = harness();
    h.submit('ask');
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();

    const card = h.channel.lastCard;
    expect(card?.partSets).toEqual([
      { tools: '', answer: 'a', status: '' },
      { tools: '', answer: 'ab', status: '' },
    ]);
    expect(card?.partFinishes).toEqual([{ tools: '', answer: 'ab', status: '' }]);
    // And the fake keeps the joined text, which the other tests read.
    expect(card?.sets).toEqual(['a', 'ab']);
  });

  it('holds a write that changes only the tool line until 2 s after the last one, but not one to the answer, nor the finish', async () => {
    // Channel spec §4.5: tool events come in bursts, each a request to Lark.
    const h = harness();
    const tool = (status: string): number => {
      const seq = h.log.length + 1;
      h.log.push(ev(seq, 'tool_call', { toolCallId: 'c1', title: 'Bash', status }));
      return seq;
    };
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.writer.want(tool('in_progress'));
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual(['openCard']);
    expect(h.rendered).toEqual([1]);

    h.clock.advance(TOOL_LINE_DELAY_MS);
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual(['openCard', 'set']);
    expect(h.channel.lastCard?.partSets.at(-1)?.tools).toBe('⏳ Bash');

    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();
    h.writer.want(tool('completed'));
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual(['openCard', 'set', 'set', 'finish']);
    expect(h.channel.lastCard?.partFinishes).toEqual([{ tools: '✅ Bash', answer: 'a\n\nb', status: '' }]);
  });

  it('does not hold the tool line on the way out', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    const seq = h.log.length + 1;
    h.log.push(ev(seq, 'tool_call', { toolCallId: 'c1', title: 'Bash', status: 'completed' }));
    h.writer.want(seq);
    await h.writer.close();
    expect(h.channel.calls).toEqual(['openCard', 'set', 'finish']);
    expect(h.channel.lastCard?.partFinishes).toEqual([{ tools: '✅ Bash', answer: 'a', status: '' }]);
  });

  it('reports a swallowed failure instead of retrying in silence', async () => {
    const h = harness();
    h.writer.want(h.chunk('an answer nobody should log'));
    h.channel.failNext('openCard', new ChannelError(99991400, 'throttled', true));
    await h.writer.flushNow();

    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain('99991400');
    expect(h.notes[0]).toContain('retryable');
    // Operational metadata only: the log must not become a second copy of the
    // conversation, with none of the retention rules that apply to the first.
    expect(h.notes[0]).not.toContain('an answer nobody should log');
  });

  it('sends the answer as a plain message once the card is hopeless', async () => {
    // A card can fail permanently -- an entity the platform will not accept, a
    // payload it rejects. Retrying that every second forever is how a real answer
    // ends up hostage to a broken card.
    const h = harness();
    h.writer.want(h.chunk('the answer'));
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) {
      h.channel.failNext('openCard', new ChannelError(230025, 'card too large', false));
    }
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) await h.writer.flushNow();

    expect(h.channel.texts).toHaveLength(1);
    expect(h.channel.texts[0]?.text).toContain('the answer');
    expect(h.notes.at(-1)).toContain('plain message');
  });

  it('stops attempting the card it gave up on', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) {
      h.channel.failNext('openCard', new ChannelError(230025, 'card too large', false));
    }
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) await h.writer.flushNow();
    const after = h.channel.calls.length;

    await h.writer.flushNow();
    await h.writer.flushNow();
    expect(h.channel.calls).toHaveLength(after);
    // The cursor moves, because the content was delivered -- by another route.
    expect(h.rendered).toEqual([1]);
  });

  it('tries a card again on the next turn', async () => {
    // Giving up is about one card, not about cards. The next prompt gets the
    // normal treatment.
    const h = harness();
    h.writer.want(h.chunk('a'));
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) {
      h.channel.failNext('openCard', new ChannelError(230025, 'card too large', false));
    }
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) await h.writer.flushNow();

    h.submit('next ask');
    h.writer.want(h.chunk('b'));
    await h.writer.flushNow();

    expect(h.channel.cards).toHaveLength(1);
    expect(h.channel.lastCard?.text).toContain('b');
    expect(h.cardChanges.at(-1)).toBe(h.channel.lastCard?.messageId);
  });

  it('keeps its patience for the card while writes are still landing', async () => {
    // The bound is on *consecutive* failures. A throttle every other second is a
    // working card, not a hopeless one.
    const h = harness();
    for (let i = 0; i < CARD_FAILURE_LIMIT * 2; i += 1) {
      h.writer.want(h.chunk('x'));
      if (i % 2 === 0) h.channel.failNext('set', new ChannelError(99991400, 'throttled', true));
      await h.writer.flushNow();
    }
    expect(h.channel.texts).toEqual([]);
  });

  it('waits before it writes again after a failure: the wait Lark gave, else a backoff', async () => {
    // Retried at once, a throttle is only met again, and five failures spend
    // the limit inside five seconds.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = harness();
      h.writer.want(h.chunk('a'));
      await h.writer.flushNow();
      h.channel.failNext('set', new ChannelError(230020, 'chat rate limit', true, 5_000));
      h.writer.want(h.chunk('b'));
      await h.writer.flushNow();
      expect(h.channel.calls).toEqual(['openCard', 'set']);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(h.channel.calls).toEqual(['openCard', 'set']);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.channel.calls).toEqual(['openCard', 'set', 'set']);

      // No wait given: a backoff, 250 to 500 ms after a first failure, here
      // where the coalescing window is long past.
      h.clock.advance(10_000);
      h.channel.failNext('set', new ChannelError(230020, 'chat rate limit', true));
      h.writer.want(h.chunk('c'));
      await h.writer.flushNow();
      await vi.advanceTimersByTimeAsync(240);
      expect(h.channel.calls).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(270);
      expect(h.channel.calls).toHaveLength(5);
      expect(h.channel.lastCard?.text).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count a throttle against the limit until 30 s of waiting on throttles is spent', async () => {
    const h = harness();
    h.writer.want(h.chunk('the answer'));
    expect(CARD_THROTTLE_BUDGET_MS).toBe(30_000);
    // Three of 10 s spend the budget; Lark's code or a bare HTTP 429, alike.
    const throttles = [429, 99991400, 99991400].map((code) => new ChannelError(code, 'throttled', true, 10_000));
    for (const err of throttles) {
      h.channel.failNext('openCard', err);
      await h.writer.flushNow();
    }
    // Then they count, as any failure does.
    for (let i = 0; i < CARD_FAILURE_LIMIT - 1; i += 1) {
      h.channel.failNext('openCard', new ChannelError(99991400, 'throttled', true, 10_000));
      await h.writer.flushNow();
    }
    expect(h.channel.texts).toEqual([]);
    expect(h.notes.filter((n) => n.includes('throttled, waiting 10s'))).toHaveLength(3);
    h.channel.failNext('openCard', new ChannelError(99991400, 'throttled', true, 10_000));
    await h.writer.flushNow();
    expect(h.channel.texts).toHaveLength(1);
  });

  it('finishes the card it gives up on, so it does not stream on', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    const card = h.channel.lastCard;
    h.writer.want(h.chunk('b'));
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) {
      h.channel.failNext('set', new ChannelError(230099, 'refused', false));
      await h.writer.flushNow();
    }
    expect(h.channel.texts).toHaveLength(1);
    expect(h.channel.calls.slice(-2)).toEqual(['sendText', 'finish']);
    expect(card?.partFinishes).toEqual([{ tools: '', answer: 'ab', status: '' }]);
  });

  it('finishes the card it gives up on when finishing was what kept failing', async () => {
    // A failed finish leaves the card open, so the fallback's finish still has a card to stop.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    const card = h.channel.lastCard;
    h.writer.want(h.end('completed'));
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) {
      h.channel.failNext('finish', new ChannelError(230099, 'refused', false));
      await h.writer.flushNow();
    }
    expect(h.channel.texts).toHaveLength(1);
    expect(h.channel.calls.slice(-3)).toEqual(['finish', 'sendText', 'finish']);
    expect(card?.partFinishes).toEqual([{ tools: '', answer: 'a', status: '' }]);
  });

  it('gives up rather than loop when the plain path fails too', async () => {
    // Nothing left to try. Holding the cursor back would re-attempt both failures
    // every second for the life of the process, which is the behaviour being fixed.
    const h = harness();
    h.writer.want(h.chunk('a'));
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) {
      h.channel.failNext('openCard', new ChannelError(230025, 'card too large', false));
    }
    h.channel.failNext('sendText', new ChannelError(230025, 'too large either way', false));
    for (let i = 0; i < CARD_FAILURE_LIMIT; i += 1) await h.writer.flushNow();

    expect(h.notes.at(-1)).toContain('both failed');
    expect(h.rendered).toEqual([1]);
    const after = h.channel.calls.length;
    await h.writer.flushNow();
    expect(h.channel.calls).toHaveLength(after);
  });

  it('flushes what is outstanding before closing', async () => {
    // A teardown that returns before the last write lands leaves the user looking
    // at a partial answer with no sign more was coming.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.close();
    expect(h.rendered).toEqual([1]);
  });

  it('waits for the write in flight before it finishes the card on the way out', async () => {
    // Otherwise the finish overlaps the write on the same card.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.writer.want(h.chunk('b'));
    h.channel.hold();
    const pass = h.writer.flushNow();
    const closing = h.writer.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.channel.calls).toEqual(['openCard', 'set']);
    h.channel.release();
    await Promise.all([pass, closing]);
    expect(h.channel.calls).toEqual(['openCard', 'set', 'finish']);
    expect(h.channel.lastCard?.partFinishes).toEqual([{ tools: '', answer: 'ab', status: '' }]);
  });

  it('finishes again on the next pass when a finish fails, the card still open', async () => {
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.channel.failNext('finish', new ChannelError(230020, 'chat rate limit', true));
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual(['openCard', 'finish', 'finish']);
    expect(h.channel.lastCard?.partFinishes).toEqual([{ tools: '', answer: 'a', status: '' }]);
    expect(h.channel.lastCard?.droppedSets).toEqual([]);
  });

  it('freezes an un-frozen card on the way out', async () => {
    // Otherwise the typing indicator spins forever on a session nothing is running.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    await h.writer.close();

    expect(h.channel.lastCard?.finishes).toHaveLength(1);
    expect(h.channel.lastCard?.text).toContain('a');
  });

  it('does not freeze twice', async () => {
    const h = harness();
    h.chunk('a');
    h.writer.want(h.end('completed'));
    await h.writer.flushNow();
    await h.writer.close();
    expect(h.channel.lastCard?.finishes).toHaveLength(1);
  });

  it('survives a failure while freezing during teardown', async () => {
    // Shutdown is best-effort; a cosmetic card defect must not abort the rest of it.
    const h = harness();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    h.channel.failNext('finish', new ChannelError(230011, 'withdrawn', false));
    await expect(h.writer.close()).resolves.toBeUndefined();
  });

  it('ignores requests after close', async () => {
    const h = harness();
    await h.writer.close();
    h.writer.want(h.chunk('a'));
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual([]);
  });

  it('adopts only the cursor on resume, never a card', async () => {
    // The previous card session died with the process that owned it, so the next
    // render has to open a new card -- and re-render from the cursor, not from 0.
    const h = harness();
    h.chunk('before restart');
    h.writer.resumeFrom(1);
    expect(h.writer.renderedThrough).toBe(1);
    expect(h.writer.messageId).toBeUndefined();

    h.writer.want(1);
    await h.writer.flushNow();
    expect(h.channel.calls).toEqual([]);

    h.writer.want(h.chunk('after'));
    await h.writer.flushNow();
    // Rendered from 0 regardless of the cursor: a render is a full replacement of
    // the card, so the new card shows the whole turn.
    expect(h.channel.lastCard?.text).toContain('before restart');
    expect(h.channel.lastCard?.text).toContain('after');
  });
});
