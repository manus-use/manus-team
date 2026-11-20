import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { Clock } from '../../src/time.js';
import { systemClock } from '../../src/time.js';

/**
 * A stand-in for the part of the Lark SDK the reply card uses (channel spec
 * §4.5): cardkit's card create, card update and card settings, element add,
 * content, update and delete, and the message send that carries the card by
 * reference. Every call
 * is recorded in order and answered as Lark answers: a card id, a message id,
 * `code: 0`, or a refusal, thrown as axios throws an HTTP error or returned in a
 * 2xx body. It has no `stream`, so an adapter that still went through the SDK's
 * streaming card fails here. Nothing here reaches Lark.
 *
 * It keeps Lark's rules for a card, so an adapter that breaks one is refused as
 * Lark would refuse it, with Lark's code:
 *
 * - a card made with an element of empty content: 10002; with two elements of
 *   one id: 200621 (the code Lark gives a card JSON it will not take);
 * - a card sent by reference that it does not hold: 200740;
 * - a sequence not above the card's last one taken: 300317;
 * - a card it does not hold: 200740; an element the card has not got: 300313,
 *   whether updated, deleted or named as an add's target;
 * - an element added with an id the card already has: `DUPLICATE_ELEMENT_CODE`;
 * - empty content: 10002;
 * - content once streaming is off: 300309;
 * - content more than ten minutes after streaming was last turned on, by its own
 *   clock: 200850, and streaming is then off. Settings turning it on again start
 *   the ten minutes over;
 * - a card past 30 KB (`CARD_BYTES_MAX`), its elements' content in UTF-8, made
 *   so or grown so by an update, an add or a replace: 200860.
 *
 * Adds and deletes do not need streaming, here: Lark's documentation of them
 * does not say they do, and a live check is to settle it. A whole-card replace
 * (`card.update`) takes the new card's streaming mode, as a card made with it.
 *
 * It also stands in for the SDK's own split send of a long text (`send`),
 * recorded as `text`, so a reply that falls back to a plain message is seen.
 *
 * A refused call is recorded with `refused: true`. A call failed with
 * `{ landed: true }` is taken, as Lark takes a call whose answer is lost, and
 * then fails; it is recorded with `lost: true`, not `refused`.
 */

/**
 * The calls, by what they do: `create` makes a card, `replace` is `card.update`,
 * the whole card replaced; `add` is `cardElement.create`, `content`, `update`
 * and `delete` are the element calls of those names.
 */
export type CardkitApi = 'create' | 'replace' | 'add' | 'content' | 'update' | 'delete' | 'settings' | 'send' | 'text';

export interface CardkitCall {
  api: CardkitApi;
  cardId?: string;
  elementId?: string;
  /** content: the text; update and add: the element's content. */
  content?: string;
  /** add: where the element goes, and the element it goes by. */
  type?: 'insert_before' | 'insert_after' | 'append';
  target?: string;
  sequence?: number;
  uuid?: string;
  /** create and replace: the card, parsed. update and add: the element, parsed. settings: the settings, parsed. send: the message's content, parsed. */
  body?: unknown;
  /** send: a new message or a reply. */
  kind?: 'create' | 'reply';
  /** send: the chat, or the message replied to. */
  to?: string;
  msgType?: string;
  replyInThread?: boolean;
  /** Set when Lark refused the call. */
  refused?: true;
  /** Set when Lark took the call but its answer was lost (`failNext(…, { landed: true })`). */
  lost?: true;
}

/** A failure as Lark gives one: an Error is thrown, a code is answered in the body. */
export type CardkitFailure = Error | { code: number; msg: string };

/** How a queued failure is given. */
export interface FailOptions {
  /** Take the call first, as Lark took it, then fail: an answer lost on the way back. */
  landed?: boolean;
  /** Let this many calls to the api through first; the one after them fails. */
  skip?: number;
}

interface QueuedFailure {
  failure: CardkitFailure;
  landed: boolean;
  skip: number;
}

/** How long Lark keeps a card streaming after it was last turned on. */
export const STREAMING_WINDOW_MS = 10 * 60 * 1000;

/** Lark's limit on a card's size, in bytes: past it the card is refused with 200860. */
export const CARD_BYTES_MAX = 30 * 1024;

/** A card's size as the fake counts it: its elements' content, in UTF-8 bytes. */
function cardBytes(elements: Iterable<string>): number {
  let total = 0;
  for (const content of elements) total += Buffer.byteLength(content, 'utf8');
  return total;
}

/** The card's size were `elementId` given `content`, or added with it. */
function bytesWith(card: Card, elementId: string, content: string): number {
  const others = card.elements.filter((e) => e.id !== elementId).map((e) => e.content);
  return cardBytes([...others, content]);
}

/**
 * The code the fake gives an element added with an id the card already has.
 * Lark's own code for it is not documented where we have looked; to be confirmed
 * live.
 */
export const DUPLICATE_ELEMENT_CODE = 300312;

/** An element of a card, as the fake holds it. */
export interface CardElement {
  id: string;
  content: string;
}

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
  /** In the card's order. */
  elements: CardElement[];
  last: number;
  streaming: boolean;
  streamingSince: number;
}

/** A card's JSON, as far as the fake reads it. */
interface CardJson {
  config?: { streaming_mode?: boolean };
  body: { elements: Array<{ element_id: string; content: string }> };
}

/** The rules a whole card keeps, made or replaced: no empty element, no id twice, 30 KB at most. */
function cardRule(elements: Array<{ element_id: string; content: string }>): Answer | undefined {
  if (elements.some((e) => e.content === '')) return refusal(10002);
  if (new Set(elements.map((e) => e.element_id)).size !== elements.length) return refusal(200621);
  if (cardBytes(elements.map((e) => e.content)) > CARD_BYTES_MAX) return refusal(200860);
  return undefined;
}

/** `elementId`'s content set, in its place. */
function setContent(card: Card, elementId: string, content: string): void {
  const element = card.elements.find((e) => e.id === elementId);
  if (element !== undefined) element.content = content;
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
  readonly #failures = new Map<CardkitApi, QueuedFailure[]>();
  readonly #holds = new Map<CardkitApi, Array<Promise<void>>>();
  readonly #cards = new Map<string, Card>();
  readonly #clock: Clock;
  #made = 0;
  #messages = 0;

  /** `clock` is Lark's: the ten minutes of streaming run on it. */
  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  /**
   * Make the next call to `api` fail with `failure`, whatever the rules say.
   * Queued, so N in a row work. `skip` lets that many calls through first;
   * `landed` applies the call, as Lark would take it, before failing it.
   */
  failNext(api: CardkitApi, failure: CardkitFailure, opts: FailOptions = {}): void {
    const queue = this.#failures.get(api) ?? [];
    queue.push({ failure, landed: opts.landed === true, skip: opts.skip ?? 0 });
    this.#failures.set(api, queue);
  }

  /**
   * Hold the next call to `api` before Lark sees it, until the returned release
   * is called: a request still on its way while others go out.
   */
  holdNext(api: CardkitApi): () => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = this.#holds.get(api) ?? [];
    queue.push(held);
    this.#holds.set(api, queue);
    return release;
  }

  /** Wait out a hold placed on `api`'s next call, if any. */
  async #gate(api: CardkitApi): Promise<void> {
    const held = this.#holds.get(api)?.shift();
    if (held !== undefined) await held;
  }

  /** The queued failure for this call of `api`, if it is the one to fail. */
  #failure(api: CardkitApi): QueuedFailure | undefined {
    const queue = this.#failures.get(api);
    const head = queue?.[0];
    if (head === undefined) return undefined;
    if (head.skip > 0) {
      head.skip -= 1;
      return undefined;
    }
    return queue?.shift();
  }

  /** Lose a card, as Lark loses one that has expired or been withdrawn. */
  forget(cardId: string): void {
    this.#cards.delete(cardId);
  }

  /** The content each update sent `elementId`, in order, those Lark refused among them. */
  contents(elementId: string): string[] {
    return this.calls.filter((c) => c.api === 'content' && c.elementId === elementId).map((c) => c.content ?? '');
  }

  /** The elements `cardId` has now, in its order, as Lark holds them: none for a card it does not hold. */
  shown(cardId: string): CardElement[];
  /**
   * What `elementId` of `cardId` was given, in order, as Lark's client would
   * receive it: its content in the card as created, then each add, update and
   * whole-card replace Lark took that gave it content.
   */
  shown(cardId: string, elementId: string): string[];
  shown(cardId: string, elementId?: string): CardElement[] | string[] {
    if (elementId === undefined) return (this.#cards.get(cardId)?.elements ?? []).map((e) => ({ ...e }));
    const given: string[] = [];
    for (const c of this.calls) {
      if (c.cardId !== cardId || c.refused === true) continue;
      if (c.api === 'create' || c.api === 'replace') {
        const card = c.body as { body: { elements: Array<{ element_id: string; content: string }> } };
        const element = card.body.elements.find((e) => e.element_id === elementId);
        if (element !== undefined) given.push(element.content);
      } else if ((c.api === 'add' || c.api === 'content' || c.api === 'update') && c.elementId === elementId) {
        given.push(c.content ?? '');
      }
    }
    return given;
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

  /**
   * Record `call`, then answer it: a queued failure, else `rule`'s refusal, else
   * `success`, once `apply` has taken the call. A failure queued as landed is
   * answered after the rules pass and `apply` has run.
   */
  #answer(call: CardkitCall, rule: () => Answer | undefined, success: Answer, apply: () => void): Answer {
    this.calls.push(call);
    const queued = this.#failure(call.api);
    if (queued !== undefined && !queued.landed) {
      call.refused = true;
      if (queued.failure instanceof Error) throw queued.failure;
      return queued.failure;
    }
    const broken = rule();
    if (broken !== undefined) {
      call.refused = true;
      return broken;
    }
    apply();
    if (queued !== undefined) {
      call.lost = true;
      if (queued.failure instanceof Error) throw queued.failure;
      return queued.failure;
    }
    return success;
  }

  /** The rules every update of a card keeps, before its own. */
  #sequenced(cardId: string, sequence: number, elementId?: string): Card | Answer {
    const card = this.#cards.get(cardId);
    if (card === undefined) return refusal(200740);
    if (elementId !== undefined && !card.elements.some((e) => e.id === elementId)) return refusal(300313);
    if (sequence <= card.last) return refusal(300317);
    return card;
  }

  readonly lark: LarkChannel = {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: async (p: { data: { type: string; data: string } }) => {
              await this.#gate('create');
              const cardId = `card_${this.#made + 1}`;
              const body = JSON.parse(p.data.data) as CardJson;
              const elements = body.body.elements;
              return this.#answer(
                { api: 'create', cardId, body },
                () => cardRule(elements),
                { code: 0, msg: 'ok', data: { card_id: cardId } },
                () => {
                  this.#made += 1;
                  this.#cards.set(cardId, {
                    elements: elements.map((e) => ({ id: e.element_id, content: e.content })),
                    last: 0,
                    streaming: body.config?.streaming_mode === true,
                    streamingSince: this.#clock.now(),
                  });
                },
              );
            },
            settings: async (p: { path: { card_id: string }; data: { settings: string; sequence: number; uuid?: string } }) => {
              await this.#gate('settings');
              const body = JSON.parse(p.data.settings) as { config?: { streaming_mode?: boolean } };
              const call: CardkitCall = {
                api: 'settings',
                cardId: p.path.card_id,
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
                body,
              };
              let card = undefined as Card | undefined;
              return this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence);
                  if (!('elements' in found)) return found;
                  card = found;
                  return undefined;
                },
                OK,
                () => {
                  if (card === undefined) return;
                  card.last = p.data.sequence;
                  const mode = body.config?.streaming_mode;
                  if (mode === true) {
                    card.streaming = true;
                    card.streamingSince = this.#clock.now();
                  } else if (mode === false) {
                    card.streaming = false;
                  }
                },
              );
            },
            update: async (p: { path: { card_id: string }; data: { card: { type: string; data: string }; sequence: number; uuid?: string } }) => {
              await this.#gate('replace');
              const body = JSON.parse(p.data.card.data) as CardJson;
              const elements = body.body.elements;
              const call: CardkitCall = {
                api: 'replace',
                cardId: p.path.card_id,
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
                body,
              };
              let card = undefined as Card | undefined;
              return this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence);
                  if (!('elements' in found)) return found;
                  const broken = cardRule(elements);
                  if (broken !== undefined) return broken;
                  card = found;
                  return undefined;
                },
                OK,
                () => {
                  if (card === undefined) return;
                  card.last = p.data.sequence;
                  card.elements = elements.map((e) => ({ id: e.element_id, content: e.content }));
                  card.streaming = body.config?.streaming_mode === true;
                  if (card.streaming) card.streamingSince = this.#clock.now();
                },
              );
            },
          },
          cardElement: {
            content: async (p: { path: { card_id: string; element_id: string }; data: { content: string; sequence: number; uuid?: string } }) => {
              await this.#gate('content');
              const call: CardkitCall = {
                api: 'content',
                cardId: p.path.card_id,
                elementId: p.path.element_id,
                content: p.data.content,
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
              };
              let card = undefined as Card | undefined;
              return this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence, p.path.element_id);
                  if (!('elements' in found)) return found;
                  if (p.data.content === '') return refusal(10002);
                  if (!found.streaming) return refusal(300309);
                  if (bytesWith(found, p.path.element_id, p.data.content) > CARD_BYTES_MAX) return refusal(200860);
                  if (this.#clock.now() - found.streamingSince > STREAMING_WINDOW_MS) {
                    found.streaming = false;
                    return refusal(200850);
                  }
                  card = found;
                  return undefined;
                },
                OK,
                () => {
                  if (card === undefined) return;
                  card.last = p.data.sequence;
                  setContent(card, p.path.element_id, p.data.content);
                },
              );
            },
            update: async (p: { path: { card_id: string; element_id: string }; data: { element: string; sequence: number; uuid?: string } }) => {
              await this.#gate('update');
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
              return this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence, p.path.element_id);
                  if (!('elements' in found)) return found;
                  if ((element.content ?? '') === '') return refusal(10002);
                  if (bytesWith(found, p.path.element_id, element.content ?? '') > CARD_BYTES_MAX) return refusal(200860);
                  card = found;
                  return undefined;
                },
                OK,
                () => {
                  if (card === undefined) return;
                  card.last = p.data.sequence;
                  setContent(card, p.path.element_id, element.content ?? '');
                },
              );
            },
            create: async (p: {
              path: { card_id: string };
              data: { type: 'insert_before' | 'insert_after' | 'append'; target_element_id?: string; elements: string; sequence: number; uuid?: string };
            }) => {
              await this.#gate('add');
              const added = JSON.parse(p.data.elements) as Array<{ element_id: string; content: string }>;
              const call: CardkitCall = {
                api: 'add',
                cardId: p.path.card_id,
                elementId: added.map((e) => e.element_id).join(','),
                content: added.map((e) => e.content).join(''),
                type: p.data.type,
                ...(p.data.target_element_id === undefined ? {} : { target: p.data.target_element_id }),
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
                body: added.length === 1 ? added[0] : added,
              };
              let card = undefined as Card | undefined;
              return this.#answer(
                call,
                () => {
                  const target = p.data.type === 'append' ? undefined : (p.data.target_element_id ?? '');
                  const found = this.#sequenced(p.path.card_id, p.data.sequence, target);
                  if (!('elements' in found)) return found;
                  if (added.some((e) => e.content === '')) return refusal(10002);
                  const ids = added.map((e) => e.element_id);
                  if (new Set(ids).size !== ids.length || found.elements.some((e) => ids.includes(e.id))) return refusal(DUPLICATE_ELEMENT_CODE);
                  if (cardBytes([...found.elements, ...added].map((e) => e.content)) > CARD_BYTES_MAX) return refusal(200860);
                  card = found;
                  return undefined;
                },
                OK,
                () => {
                  if (card === undefined) return;
                  card.last = p.data.sequence;
                  const fresh = added.map((e) => ({ id: e.element_id, content: e.content }));
                  const at = card.elements.findIndex((e) => e.id === p.data.target_element_id);
                  const index = p.data.type === 'append' ? card.elements.length : p.data.type === 'insert_before' ? at : at + 1;
                  card.elements.splice(index, 0, ...fresh);
                },
              );
            },
            delete: async (p: { path: { card_id: string; element_id: string }; data: { sequence: number; uuid?: string } }) => {
              await this.#gate('delete');
              const call: CardkitCall = {
                api: 'delete',
                cardId: p.path.card_id,
                elementId: p.path.element_id,
                sequence: p.data.sequence,
                ...(p.data.uuid === undefined ? {} : { uuid: p.data.uuid }),
              };
              let card = undefined as Card | undefined;
              return this.#answer(
                call,
                () => {
                  const found = this.#sequenced(p.path.card_id, p.data.sequence, p.path.element_id);
                  if (!('elements' in found)) return found;
                  card = found;
                  return undefined;
                },
                OK,
                () => {
                  if (card === undefined) return;
                  card.last = p.data.sequence;
                  card.elements = card.elements.filter((e) => e.id !== p.path.element_id);
                },
              );
            },
          },
        },
      },
      im: {
        v1: {
          message: {
            create: async (p: SendPayload) => {
              await this.#gate('send');
              return this.#send('create', p.data.receive_id ?? '', p);
            },
            reply: async (p: SendPayload) => {
              await this.#gate('send');
              return this.#send('reply', p.path?.message_id ?? '', p);
            },
          },
        },
      },
    },
    // The SDK's split send of a text longer than one message: no uuid, and a
    // failure thrown, as the SDK throws one.
    send: async (chatId: string, content: { markdown?: string }) => {
      await this.#gate('text');
      const answer = this.#answer(
        { api: 'text', to: chatId, content: content.markdown ?? '' },
        () => undefined,
        { code: 0, msg: 'ok' },
        () => {
          this.#messages += 1;
        },
      );
      if (answer.code !== 0) throw refused(answer.code ?? 0);
      return { messageId: `om_${this.#messages}` };
    },
  } as unknown as LarkChannel;

  #send(kind: 'create' | 'reply', to: string, p: SendPayload): Answer {
    const body = JSON.parse(p.data.content) as { data?: { card_id?: string } };
    const cardId = body.data?.card_id;
    return this.#answer(
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
      () => (cardId !== undefined && !this.#cards.has(cardId) ? refusal(200740) : undefined),
      { code: 0, msg: 'ok', data: { message_id: `om_${this.#messages + 1}` } },
      () => {
        this.#messages += 1;
      },
    );
  }
}
