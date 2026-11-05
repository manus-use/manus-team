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
 * An approval card has nowhere to go until plan D forwards it to the task's first
 * subscription, so sending one fails, and the actor releases the request as
 * cancelled -- the honest outcome, since nobody could have been asked. Until then
 * the board refuses roles whose agent asks for approval (spec §12), so this is
 * the backstop.
 */
export const KANBAN_CHANNEL = 'kanban';

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

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async sendText(_target: SendTarget, _text: string, uuid: string): Promise<SendResult> {
    return { messageId: `kanban:${uuid}`, deduped: false };
  }

  async openCard(_target: SendTarget, _initialText: string, uuid: string): Promise<CardSession> {
    return new DiscardedCard(`kanban:${uuid}`, this.#now());
  }

  async sendApprovalCard(target: SendTarget, _spec: ApprovalCardSpec, _uuid: string): Promise<SendResult> {
    throw new Error(
      `task ${target.chatId} asked for approval, and nothing can reach a person for it until the board is in Lark`,
    );
  }

  async updateApprovalCard(_messageId: string, _view: ApprovalOutcomeView): Promise<void> {}

  /** A run's session posts no board card; one would be discarded, as its other cards are. */
  async sendCard(_target: SendTarget, _view: CardView, uuid: string): Promise<SendResult> {
    return { messageId: `kanban:${uuid}`, deduped: false };
  }

  async updateCard(_messageId: string, _view: CardView): Promise<void> {}

  async react(_messageId: string, _emoji: string): Promise<void> {}

  async unreact(_messageId: string, _emoji: string): Promise<void> {}
}
