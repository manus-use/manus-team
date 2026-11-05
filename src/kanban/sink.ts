import { getTask, subscriptionsOf } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import type {
  ApprovalCardSpec,
  ApprovalOutcomeView,
  CardSession,
  CardView,
  Channel,
  SendResult,
  SendTarget,
} from '../channel/types.js';

/**
 * The channel a kanban run's session posts through (spec §7.1): the `kanban`
 * entry of the registry's channel map, so a run's session never posts to Lark.
 *
 * Card output is discarded: the session log keeps every event, and `/kanban show`
 * reads it there. Nobody is watching a card for a run.
 *
 * An approval card, for a supervised agent, is forwarded to the task's first
 * subscription (spec §7.1): the chat, or thread, the task was created in, where
 * someone follows it. It names the task, and is answered as any approval card
 * is -- at operator tier, resolved through the approval's session, which the
 * router looks up by `approvalId`. A task nobody follows, or one followed on a
 * channel this gateway has not got, cannot have anyone asked: sending fails, and
 * the actor releases the request as cancelled, the honest outcome. Without
 * forwarding -- a sink built without it -- every approval card fails so.
 */
export const KANBAN_CHANNEL = 'kanban';

/** Where a run's approval cards go: its task's first subscription, on that subscription's channel. */
export interface ApprovalForwarding {
  db: Db;
  /** By a subscription's channel id: `lark` to the Lark adapter. */
  channels: ReadonlyMap<string, Channel>;
  /** This bot: only its subscriptions are posted to, as the notifier's are. */
  appId: string;
}

/** A task's title on an approval card, as one line, in characters. */
const TITLE_MAX = 200;
/** Forwarded cards remembered for their redraw; the oldest are forgotten past this. */
const FORWARDED_MAX = 1_000;

/** A title as one line, cut to `TITLE_MAX` characters on a code point, never half an emoji. */
function oneLine(title: string): string {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim());
  return chars.length <= TITLE_MAX ? chars.join('') : `${chars.slice(0, TITLE_MAX - 1).join('')}…`;
}

class DiscardedCard implements CardSession {
  readonly messageId: string;
  readonly createdAt: number;

  constructor(messageId: string, createdAt: number) {
    this.messageId = messageId;
    this.createdAt = createdAt;
  }

  async set(_text: string): Promise<void> {}

  async finish(_text: string): Promise<void> {}
}

export class KanbanSink implements Channel {
  readonly id = KANBAN_CHANNEL;
  readonly #now: () => number;
  readonly #forward: ApprovalForwarding | undefined;
  /** The channel each forwarded approval card went to, by its message, for its redraw. */
  readonly #forwarded = new Map<string, Channel>();

  constructor(now: () => number = Date.now, forward?: ApprovalForwarding) {
    this.#now = now;
    this.#forward = forward;
  }

  async sendText(_target: SendTarget, _text: string, uuid: string): Promise<SendResult> {
    return { messageId: `kanban:${uuid}`, deduped: false };
  }

  async openCard(_target: SendTarget, _initialText: string, uuid: string): Promise<CardSession> {
    return new DiscardedCard(`kanban:${uuid}`, this.#now());
  }

  /** A run's session is bound at (task, run), so the target's chat is the task. */
  async sendApprovalCard(target: SendTarget, spec: ApprovalCardSpec, uuid: string): Promise<SendResult> {
    const taskId = target.chatId;
    const forward = this.#forward;
    if (forward === undefined) {
      throw new Error(`task ${taskId} asked for approval, and this gateway forwards no approval card to a chat`);
    }
    const sub = subscriptionsOf(forward.db, taskId).find((s) => s.appId === forward.appId);
    if (sub === undefined) throw new Error(`task ${taskId} asked for approval, and no chat follows it to be asked`);
    const channel = forward.channels.get(sub.channel);
    if (channel === undefined) {
      throw new Error(`task ${taskId} asked for approval, and the chat that follows it is on channel ${sub.channel}, which this gateway has not got`);
    }
    // Named, so the chat knows which task's agent is asking: the card is rendered as plain text, masked.
    const title = oneLine(getTask(forward.db, taskId)?.title ?? '');
    const named = title === '' ? `Task ${taskId}` : `Task ${taskId}, ${title}`;
    const sent = await channel.sendApprovalCard(
      { chatId: sub.conversationId, threadId: sub.threadId },
      { ...spec, action: `${named}, asks: ${spec.action}` },
      uuid,
    );
    this.#forwarded.set(sent.messageId, channel);
    // Bounded: an approval never answered is never redrawn, and must not be held forever.
    for (const oldest of this.#forwarded.keys()) {
      if (this.#forwarded.size <= FORWARDED_MAX) break;
      this.#forwarded.delete(oldest);
    }
    return sent;
  }

  /**
   * A forwarded card is redrawn where it went, once, and then forgotten; one this
   * process did not forward, or has forgotten, is not its to redraw.
   */
  async updateApprovalCard(messageId: string, view: ApprovalOutcomeView): Promise<void> {
    const channel = this.#forwarded.get(messageId);
    this.#forwarded.delete(messageId);
    await channel?.updateApprovalCard(messageId, view);
  }

  /** A run's session posts no board card; one would be discarded, as its other cards are. */
  async sendCard(_target: SendTarget, _view: CardView, uuid: string): Promise<SendResult> {
    return { messageId: `kanban:${uuid}`, deduped: false };
  }

  async updateCard(_messageId: string, _view: CardView): Promise<void> {}

  async react(_messageId: string, _emoji: string): Promise<void> {}

  async unreact(_messageId: string, _emoji: string): Promise<void> {}
}
