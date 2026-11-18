import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { Clock } from '../../src/time.js';
import { systemClock } from '../../src/time.js';

/**
 * A stand-in for the part of the Lark SDK the reply card uses (channel spec
 * §4.5): cardkit's card create, element content, element update and card
 * settings, and the message send that carries the card by reference. Every call
 * is recorded in order and answered as Lark answers: a card id, a message id,
 * `code: 0`, or a refusal, thrown as axios throws an HTTP error or returned in a
 * 2xx body. It has no `stream`, so an adapter that still went through the SDK's
 * streaming card fails here. Nothing here reaches Lark.
 *
 * It keeps Lark's rules for a card, so an adapter that breaks one is refused as
 * Lark would refuse it, with Lark's code:
 *
 * - a sequence not above the card's last one taken: 300317;
 * - a card it does not hold: 200740; an element the card has not got: 300313;
 * - empty content: 10002;
 * - content once streaming is off: 300309;
 * - content more than ten minutes after streaming was last turned on, by its own
 *   clock: 200850, and streaming is then off. Settings turning it on again start
 *   the ten minutes over.
 *
 * A refused call is recorded with `refused: true`.
 */

export type CardkitApi = 'create' | 'content' | 'update' | 'settings' | 'send';

export interface CardkitCall {
  api: CardkitApi;
  cardId?: string;
  elementId?: string;
  /** content: the text; update: the element's content. */
  content?: string;
  sequence?: number;
  uuid?: string;
  /** create: the card, parsed. update: the element, parsed. settings: the settings, parsed. send: the message's content, parsed. */
  body?: unknown;
  /** send: a new message or a reply. */
  kind?: 'create' | 'reply';
  /** send: the chat, or the message replied to. */
  to?: string;
  msgType?: string;
  replyInThread?: boolean;
  /** Set when Lark refused the call. */
  refused?: true;
}

/** A failure as Lark gives one: an Error is thrown, a code is answered in the body. */
export type CardkitFailure = Error | { code: number; msg: string };

/** How long Lark keeps a card streaming after it was last turned on. */
export const STREAMING_WINDOW_MS = 10 * 60 * 1000;

interface Answer {
  code?: number;
  msg?: string;
  data?: object;
}

interface SendPayload {
  params?: { receive_id_type: string };
  path?: { message_id: string };
  data: { receive_id?: string; msg_type: string; content: string; uuid: string; reply_in_thread?: boolean };
}

interface Card {
  elements: Map<string, string>;
  last: number;
  streaming: boolean;
  streamingSince: number;
}

/** An HTTP error as axios throws one: Lark's code in the response body. */
export function refused(code: number, status = 400): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { code, msg: `refused ${code}` }, headers: {} },
  });
}

function refusal(code: number): Answer {
  return { code, msg: `refused ${code}` };
}

const OK: Answer = { code: 0, msg: 'ok', data: {} };

export class FakeCardkit {
  readonly calls: CardkitCall[] = [];
  readonly #failures = new Map<CardkitApi, CardkitFailure[]>();
  readonly #cards = new Map<string, Card>();
  readonly #clock: Clock;
  #made = 0;
  #messages = 0;

  /** `clock` is Lark's: the ten minutes of streaming run on it. */
  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  /** Make the next call to `api` fail with `failure`, whatever the rules say. Queued, so N in a row work. */
  failNext(api: CardkitApi, failure: CardkitFailure): void {
    const queue = this.#failures.get(api) ?? [];
    queue.push(failure);
    this.#failures.set(api, queue);
  }

  /** Lose a card, as Lark loses one that has expired or been withdrawn. */
  forget(cardId: string): void {
    this.#cards.delete(cardId);
  }

  /** The content each update sent `elementId`, in order, those Lark refused among them. */
  contents(elementId: string): string[] {
    return this.calls.filter((c) => c.api === 'content' && c.elementId === elementId).map((c) => c.content ?? '');
  }

  /**
   * What `elementId` of `cardId` was given, in order, as Lark's client would
   * receive it: its content in the card as created, then each update Lark took.
   */
  shown(cardId: string, elementId: string): string[] {
    const created = this.calls.find((c) => c.api === 'create' && c.cardId === cardId && c.refused !== true);
    const card = created?.body as { body: { elements: Array<{ element_id: string; content: string }> } } | undefined;
    const initial = card?.body.elements.find((e) => e.element_id === elementId)?.content;
    const updates = this.calls
      .filter((c) => (c.api === 'content' || c.api === 'update') && c.cardId === cardId && c.elementId === elementId && c.refused !== true)
      .map((c) => c.content ?? '');
    return initial === undefined ? updates : [initial, ...updates];
  }

  /** Every sequence `cardId` was given, updates and settings alike, refused or not, in order. */
  sequences(cardId: string): number[] {
    return this.calls.filter((c) => c.cardId === cardId && c.sequence !== undefined).map((c) => c.sequence ?? 0);
  }

  /** Whether `cardId` is streaming, as Lark holds it now. */
  streaming(cardId: string): boolean {
    const card = this.#cards.get(cardId);
    return card !== undefined && card.streaming && this.#clock.now() - card.streamingSince <= STREAMING_WINDOW_MS;
  }

  /** Record `call`, then answer it: a queued failure, else `rule`'s refusal, else `success`. */
  #answer(call: CardkitCall, rule: () => Answer | undefined, success: Answer): Answer {
    this.calls.push(call);
    const failure = this.#failures.get(call.api)?.shift();
    if (failure !== undefined) {
      call.refused = true;
      if (failure instanceof Error) throw failure;
      return failure;
    }
    const broken = rule();
    if (broken !== undefined) {
      call.refused = true;
      return broken;
    }
    return success;
  }

  /** The rules every update of a card keeps, before its own. */
  #sequenced(cardId: string, sequence: number, elementId?: string): Card | Answer {
    const card = this.#cards.get(cardId);
    if (card === undefined) return refusal(200740);
    if (elementId !== undefined && !card.elements.has(elementId)) return refusal(300313);
    if (sequence <= card.last) return refusal(300317);
    return card;
  }

  readonly lark: LarkChannel = {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: async (p: { data: { type: string; data: string } }) => {
              const cardId = `card_${this.#made + 1}`;
              const body = JSON.parse(p.data.data) as { config?: { streaming_mode?: boolean }; body: { elements: Array<{ element_id: string; content: string }> } };
              const answer = this.#answer({ api: 'create', cardId, body }, () => undefined, { code: 0, msg: 'ok', data: { card_id: cardId } });
              if (answer.code === 0) {
                this.#made += 1;
                this.#cards.set(cardId, {
                  elements: new Map(body.body.elements.map((e) => [e.element_id, e.content])),
                  last: 0,
                  streaming: body.config?.streaming_mode === true,
                  streamingSince: this.#clock.now(),
                });
              }
              return answer;
            },
            settings: async (p: { path: { card_id: string }; data: { settings: string; sequence: number; uuid?: string } }) => {
              const body = JSON.parse(p.data.settings) as { config?: { streaming_mode?: boolean } };
              const call: CardkitCall = {
                api: 'settings',
                cardId: p.path.card_id,
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
                body,
              };
              let card = undefined as Card | undefined;
              const answer = this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence);
                  if (!('elements' in found)) return found;
                  card = found;
                  return undefined;
                },
                OK,
              );
              if (card !== undefined && answer.code === 0) {
                card.last = p.data.sequence;
                const mode = body.config?.streaming_mode;
                if (mode === true) {
                  card.streaming = true;
                  card.streamingSince = this.#clock.now();
                } else if (mode === false) {
                  card.streaming = false;
                }
              }
              return answer;
            },
          },
          cardElement: {
            content: async (p: { path: { card_id: string; element_id: string }; data: { content: string; sequence: number; uuid?: string } }) => {
              const call: CardkitCall = {
                api: 'content',
                cardId: p.path.card_id,
                elementId: p.path.element_id,
                content: p.data.content,
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
              };
              let card = undefined as Card | undefined;
              const answer = this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence, p.path.element_id);
                  if (!('elements' in found)) return found;
                  if (p.data.content === '') return refusal(10002);
                  if (!found.streaming) return refusal(300309);
                  if (this.#clock.now() - found.streamingSince > STREAMING_WINDOW_MS) {
                    found.streaming = false;
                    return refusal(200850);
                  }
                  card = found;
                  return undefined;
                },
                OK,
              );
              if (card !== undefined && answer.code === 0) {
                card.last = p.data.sequence;
                card.elements.set(p.path.element_id, p.data.content);
              }
              return answer;
            },
            update: async (p: { path: { card_id: string; element_id: string }; data: { element: string; sequence: number; uuid?: string } }) => {
              const element = JSON.parse(p.data.element) as { content?: string };
              const call: CardkitCall = {
                api: 'update',
                cardId: p.path.card_id,
                elementId: p.path.element_id,
                content: element.content ?? '',
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
                body: element,
              };
              let card = undefined as Card | undefined;
              const answer = this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence, p.path.element_id);
                  if (!('elements' in found)) return found;
                  if ((element.content ?? '') === '') return refusal(10002);
                  card = found;
                  return undefined;
                },
                OK,
              );
              if (card !== undefined && answer.code === 0) {
                card.last = p.data.sequence;
                card.elements.set(p.path.element_id, element.content ?? '');
              }
              return answer;
            },
          },
        },
      },
      im: {
        v1: {
          message: {
            create: async (p: SendPayload) => this.#send('create', p.data.receive_id ?? '', p),
            reply: async (p: SendPayload) => this.#send('reply', p.path?.message_id ?? '', p),
          },
        },
      },
    },
  } as unknown as LarkChannel;

  #send(kind: 'create' | 'reply', to: string, p: SendPayload): Answer {
    const body = JSON.parse(p.data.content) as { data?: { card_id?: string } };
    const answer = this.#answer(
      {
        api: 'send',
        kind,
        to,
        msgType: p.data.msg_type,
        uuid: p.data.uuid,
        body,
        ...(body.data?.card_id === undefined ? {} : { cardId: body.data.card_id }),
        ...(p.data.reply_in_thread === undefined ? {} : { replyInThread: p.data.reply_in_thread }),
      },
      () => undefined,
      { code: 0, msg: 'ok', data: { message_id: `om_${this.#messages + 1}` } },
    );
    if (answer.code === 0) this.#messages += 1;
    return answer;
  }
}
