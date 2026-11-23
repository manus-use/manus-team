import { cardText } from '../../src/channel/render.js';
import type {
  ApprovalCardSpec,
  ApprovalOutcomeView,
  CardButton,
  CardParts,
  CardSession,
  CardView,
  Channel,
  ChatMembers,
  SendResult,
  SendTarget,
} from '../../src/channel/types.js';
import type { Clock } from '../../src/time.js';
import { systemClock } from '../../src/time.js';

/**
 * A recording `Channel`.
 *
 * Two capabilities the real adapter cannot give a test:
 *
 * 1. **Call order**, as a flat list. Most of the outbound invariants in this
 *    codebase are ordering claims -- open before set, card frozen before the
 *    runtime is torn down, approval row written before the card -- and an
 *    assertion on a flat log states them directly.
 * 2. **Controllable completion.** `hold()` parks every call mid-flight, which is
 *    the only way to observe single-flight and latest-wins behaviour: both are
 *    defined entirely by what happens *while* a write is outstanding.
 */

type Method =
  | 'sendText'
  | 'openCard'
  | 'sendApprovalCard'
  | 'updateApprovalCard'
  | 'sendCard'
  | 'updateCard'
  | 'react'
  | 'unreact'
  | 'chatMembers'
  | 'set'
  | 'finish';

export interface ReactionCall {
  op: 'add' | 'remove';
  messageId: string;
  emoji: string;
}

export interface ApprovalUpdateCall {
  messageId: string;
  view: ApprovalOutcomeView;
}

export interface CardOpenCall {
  target: SendTarget;
  uuid: string;
}

export interface TextCall {
  target: SendTarget;
  text: string;
  uuid: string;
  /** The buttons under it, when it was sent with some. */
  buttons?: readonly CardButton[];
}

export interface BoardCardCall {
  target: SendTarget;
  view: CardView;
  uuid: string;
}

export interface CardUpdateCall {
  messageId: string;
  view: CardView;
}

export interface ApprovalCall {
  target: SendTarget;
  spec: ApprovalCardSpec;
  uuid: string;
}

export class FakeCard implements CardSession {
  readonly messageId: string;
  readonly createdAt: number;
  /** Each set's and finish's parts, joined as the plain message joins them (`cardText`). */
  readonly sets: string[] = [];
  readonly finishes: string[] = [];
  /** The parts themselves, index-aligned with `sets` and `finishes`. */
  readonly partSets: CardParts[] = [];
  readonly partFinishes: CardParts[] = [];
  /**
   * Writes the freeze swallowed.
   *
   * A frozen card accepts `set` and does nothing with it -- no update, no error.
   * This fake used to accept them like any other write, which made a whole class
   * of bug invisible: the writer kept one card for a whole session, and every
   * answer after the first went into a closed stream and was simply gone. Anything
   * landing here is a lost message.
   */
  readonly droppedSets: string[] = [];

  readonly #owner: FakeChannel;
  #frozen = false;

  constructor(owner: FakeChannel, messageId: string, createdAt: number) {
    this.#owner = owner;
    this.messageId = messageId;
    this.createdAt = createdAt;
  }

  async set(parts: CardParts): Promise<void> {
    this.#owner.calls.push('set');
    // Before the gate: on a card whose finish has landed, the real adapter
    // returns without reaching the network at all, so this cannot fail, and
    // cannot be held.
    if (this.#frozen) {
      this.droppedSets.push(cardText(parts));
      return;
    }
    await this.#owner.gate('set');
    this.sets.push(cardText(parts));
    this.partSets.push(parts);
  }

  async finish(parts: CardParts): Promise<void> {
    this.#owner.calls.push('finish');
    if (this.#frozen) return;
    // Set after the gate: the real adapter marks the session finished only once
    // the finish has landed. A finish that failed rejects, leaves the card open,
    // and is tried again by the writer's next pass.
    await this.#owner.gate('finish');
    this.#frozen = true;
    this.finishes.push(cardText(parts));
    this.partFinishes.push(parts);
  }

  /** Last content the card was told to display, whether by set or finish. */
  get text(): string | undefined {
    return this.finishes.at(-1) ?? this.sets.at(-1);
  }
}

export class FakeChannel implements Channel {
  readonly id: string;
  readonly calls: Method[] = [];
  readonly texts: TextCall[] = [];
  readonly approvalCards: ApprovalCall[] = [];
  readonly cards: FakeCard[] = [];
  /** Where each card was opened, index-aligned with `cards`. */
  readonly cardOpens: CardOpenCall[] = [];
  readonly reactions: ReactionCall[] = [];
  readonly approvalUpdates: ApprovalUpdateCall[] = [];
  /** Board cards posted (spec §9.2), and their redraws. */
  readonly boardCards: BoardCardCall[] = [];
  readonly cardUpdates: CardUpdateCall[] = [];
  /** Each group's members, by union_id, as Lark's chat members API answers (spec §19.3); a group not here has none. */
  readonly members = new Map<string, readonly string[]>();
  /** Groups whose lookup stops before its last page, as one past 2,000 members does. */
  readonly incomplete = new Set<string>();
  /** The groups whose members were asked for, in order. */
  readonly memberLookups: string[] = [];

  /**
   * Whether a reply that opens a thread is answered with that thread's id, as
   * Lark answers one (spec §19.4): `omt_` and the message replied to. Off, it is
   * answered with none, as a reply Lark did not thread.
   */
  replyThreads = true;

  /**
   * Sends of a text holding `match` that land only after `ms`, as a slow Lark
   * would answer them: what a test of the order of a thread's messages slows.
   */
  readonly slowTexts: Array<{ match: string; ms: number }> = [];

  /**
   * What landed, in the order it landed: `text:<the text>` for a send once it is
   * answered, `card` for a card once it is opened.
   */
  readonly landed: string[] = [];

  readonly #clock: Clock;
  readonly #failures = new Map<Method, unknown[]>();
  readonly #answers = new Map<Method, SendResult[]>();
  #held: Promise<void> | undefined;
  #release: (() => void) | undefined;
  #seq = 0;

  constructor(opts: { id?: string; clock?: Clock } = {}) {
    this.id = opts.id ?? 'fake';
    this.#clock = opts.clock ?? systemClock;
  }

  // -- test controls ---------------------------------------------------------

  /** Park every subsequent call until `release()`. */
  hold(): void {
    if (this.#held !== undefined) return;
    this.#held = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    const release = this.#release;
    this.#held = undefined;
    this.#release = undefined;
    release?.();
  }

  /** Make the next call to `method` reject with `err`. Queued, so N in a row work. */
  failNext(method: Method, err: unknown): void {
    const queue = this.#failures.get(method) ?? [];
    queue.push(err);
    this.#failures.set(method, queue);
  }

  /**
   * Make the next call to `method` that succeeds answer with `result`, as Lark
   * answers a send it deduplicated against an earlier one: queued, as failures are.
   */
  answerNext(method: Method, result: SendResult): void {
    const queue = this.#answers.get(method) ?? [];
    queue.push(result);
    this.#answers.set(method, queue);
  }

  /** Awaited by every call site, after it has been recorded and before it succeeds. */
  async gate(method: Method): Promise<void> {
    const held = this.#held;
    if (held !== undefined) await held;
    const queue = this.#failures.get(method);
    const err = queue?.shift();
    if (err !== undefined) throw err;
  }

  get lastCard(): FakeCard | undefined {
    return this.cards.at(-1);
  }

  /** The thread a send to `target` lands in, as Lark answers: none for a direct message, or a message in no thread. */
  threadOf(target: SendTarget): string | undefined {
    if (target.receiveIdType === 'union_id') return undefined;
    if (target.threadId !== '') return target.threadId;
    if (target.replyTo !== undefined && target.replyInThread === true && this.replyThreads) return `omt_${target.replyTo}`;
    return undefined;
  }

  #result(messageId: string, target: SendTarget): SendResult {
    const threadId = this.threadOf(target);
    return { messageId, deduped: false, ...(threadId === undefined ? {} : { threadId }) };
  }

  // -- Channel ---------------------------------------------------------------

  async sendText(target: SendTarget, text: string, uuid: string, buttons?: readonly CardButton[]): Promise<SendResult> {
    this.calls.push('sendText');
    await this.gate('sendText');
    const slow = this.slowTexts.find((s) => text.includes(s.match));
    if (slow !== undefined) await new Promise((resolve) => setTimeout(resolve, slow.ms));
    this.texts.push({ target, text, uuid, ...(buttons === undefined ? {} : { buttons }) });
    this.landed.push(`text:${text}`);
    const result = this.#result(`om_text_${++this.#seq}`, target);
    return this.#answers.get('sendText')?.shift() ?? result;
  }

  async openCard(target: SendTarget, initial: CardParts, uuid: string): Promise<CardSession> {
    this.calls.push('openCard');
    await this.gate('openCard');
    const card = new FakeCard(this, `om_card_${++this.#seq}`, this.#clock.now());
    // The real adapter delivers the initial text as part of opening, so record it
    // the same way -- a test asserting on card content must not have to know
    // whether the first render arrived via open or via set.
    card.sets.push(cardText(initial));
    card.partSets.push(initial);
    this.cards.push(card);
    this.cardOpens.push({ target, uuid });
    this.landed.push('card');
    return card;
  }

  async sendApprovalCard(
    target: SendTarget,
    spec: ApprovalCardSpec,
    uuid: string,
  ): Promise<SendResult> {
    this.calls.push('sendApprovalCard');
    await this.gate('sendApprovalCard');
    this.approvalCards.push({ target, spec, uuid });
    return this.#result(`om_approval_${++this.#seq}`, target);
  }

  async updateApprovalCard(messageId: string, view: ApprovalOutcomeView): Promise<void> {
    this.calls.push('updateApprovalCard');
    await this.gate('updateApprovalCard');
    this.approvalUpdates.push({ messageId, view });
  }

  async sendCard(target: SendTarget, view: CardView, uuid: string): Promise<SendResult> {
    this.calls.push('sendCard');
    await this.gate('sendCard');
    this.boardCards.push({ target, view, uuid });
    const result = this.#result(`om_board_${++this.#seq}`, target);
    return this.#answers.get('sendCard')?.shift() ?? result;
  }

  async updateCard(messageId: string, view: CardView): Promise<void> {
    this.calls.push('updateCard');
    await this.gate('updateCard');
    this.cardUpdates.push({ messageId, view });
  }

  async react(messageId: string, emoji: string): Promise<void> {
    this.calls.push('react');
    await this.gate('react');
    this.reactions.push({ op: 'add', messageId, emoji });
  }

  async unreact(messageId: string, emoji: string): Promise<void> {
    this.calls.push('unreact');
    await this.gate('unreact');
    this.reactions.push({ op: 'remove', messageId, emoji });
  }

  async chatMembers(chatId: string): Promise<ChatMembers> {
    this.calls.push('chatMembers');
    this.memberLookups.push(chatId);
    await this.gate('chatMembers');
    return { unionIds: new Set(this.members.get(chatId) ?? []), complete: !this.incomplete.has(chatId) };
  }
}
