import { createLarkChannel, type LarkChannel } from '@larksuiteoapi/node-sdk';
import {
  CARD_GONE_CODES,
  ChannelError,
  type ApprovalCardSpec,
  type ApprovalOutcomeView,
  type CardButton,
  type CardParts,
  type CardSession,
  type CardView,
  type Channel,
  type ChatMembers,
  type SendResult,
  type SendTarget,
  ONE_MESSAGE,
} from '../types.js';
import { forPlainText, truncate } from '../escape.js';
import { backoffMs, toChannelError } from './errors.js';
import type { Clock } from '../../time.js';
import { systemClock } from '../../time.js';
import { PRODUCT_NAME } from '../../identity.js';

/**
 * The Lark implementation of the outbound `Channel` port.
 *
 * Built on the SDK's high-level `Channel` module rather than raw API calls, for
 * the connection, inbound events and the longer text sends. The reply card is
 * the exception (channel spec §4.5): the SDK's streaming card has one element,
 * so a tool line above the answer made every tool event retype the whole
 * answer. The card is driven through Lark's card API instead, one element a
 * part, with the SDK's own client. Its rollover past 30,000 characters is not
 * needed: no part is let grow past `CARD_TEXT_BUDGET`, 20,000.
 *
 * **The uuid.** The SDK's high-level `send`/`stream` do not expose Feishu's
 * `uuid` field, so every message that goes out as one message -- a text of up to
 * `ONE_MESSAGE` characters, an approval card, a board card -- is sent through the
 * SDK's own client instead (`im.v1.message.create` or `reply`), with the uuid:
 * Feishu then sends one message for any number of sends with the same uuid
 * within an hour, so a retry, or a notice sent again after a restart, is one
 * message (spec §9.4). The reply card is sent so too, with a uuid of its own
 * (`openCard`). A longer text is split by the SDK into several messages, with
 * no uuid, so a retry of one can still post a second copy.
 */

export interface LarkChannelConfig {
  appId: string;
  appSecret: string;
  /**
   * Directories from which local files may be attached.
   *
   * Passed to the SDK's own path guard. Left unset, the SDK enforces only a
   * blocklist, which does not stop an agent from attaching an arbitrary readable
   * file outside its workspace.
   */
  allowedFileDirs?: readonly string[];
  domain?: string;
}

const MAX_SEND_ATTEMPTS = 4;
/** Lark's code for "the bot is not in the chat": a card refused so would be refused as text too. */
const NOT_IN_CHAT = 230002;
/** Feishu's text message ceiling, with headroom. */
const TEXT_BUDGET = 12_000;
/** The longest text sent as one message, with its uuid (see `ONE_MESSAGE` in `../types.ts`). */
export { ONE_MESSAGE };
/**
 * The codes on which a reply's message is taken as gone, so the reply goes to
 * its chat instead: Lark's documented code for a withdrawn message (230011),
 * and 230017, which the SDK's own send also falls back on, as it does on an
 * HTTP 404 (see `#post`).
 *
 * 230020 is deliberately not here, though the SDK falls back on it too. Lark
 * documents 230020 as the chat's rate limit, and `RETRYABLE_CODES` retries it
 * as one. The two readings cannot both win; the retry does, because it is the
 * safe one: a reply retried with its uuid is at worst late, while one moved to
 * the chat on a rate limit loses its thread and hits the same limit again.
 */
const WITHDRAWN_CODES: ReadonlySet<number> = new Set([230011, 230017]);
/** The HTTP status on which the SDK's own send takes a reply's message as gone. */
const NOT_FOUND_STATUS = 404;
/** Lark's code for content it will not take: a post refused so goes as plain text, as the SDK's own send does. */
const INVALID_CONTENT = 230001;
/** Members in one page of Lark's chat members API, its largest. */
const MEMBER_PAGE_SIZE = 100;
/** Pages of members read at most (spec §19.3): 2,000 members. */
export const MEMBER_PAGES = 20;

/**
 * What a test gives the adapter in place of Lark: the SDK's channel, and how a
 * retry waits. Absent, the real ones.
 */
export interface LarkAdapterDeps {
  lark?: LarkChannel;
  sleep?: (ms: number) => Promise<void>;
}

export class LarkAdapter implements Channel {
  readonly id = 'lark';
  readonly #lark: LarkChannel;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  #botOpenId: string | undefined;

  constructor(config: LarkChannelConfig, clock: Clock = systemClock, deps: LarkAdapterDeps = {}) {
    this.#clock = clock;
    this.#sleep = deps.sleep ?? sleep;
    this.#lark = deps.lark ?? createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      transport: 'websocket',
      ...(config.domain === undefined ? {} : { domain: config.domain }),
      // The gateway does its own policy in `policy/auth.ts`, deliberately. Two
      // places deciding who may talk to the bot is two places to keep in sync,
      // and the SDK's policy cannot see our tiers.
      policy: { requireMention: false, dmMode: 'open', respondToMentionAll: true },
      outbound: {
        ssrfGuard: true,
        ...(config.allowedFileDirs === undefined
          ? {}
          : { allowedFileDirs: [...config.allowedFileDirs] }),
      },
      // Needed because the normalizer drops fields the gateway relies on --
      // notably the sender's union_id, which is the canonical human key.
      includeRawEvent: true,
      source: PRODUCT_NAME,
    });
  }

  /** The underlying channel, for the inbound side to attach listeners to. */
  get raw(): LarkChannel {
    return this.#lark;
  }

  async connect(): Promise<void> {
    await this.#lark.connect();
    this.#botOpenId = this.#lark.botIdentity?.openId;
  }

  async disconnect(): Promise<void> {
    await this.#lark.disconnect();
  }

  /**
   * The bot's own `open_id`.
   *
   * Needed by the inbound loop guard. Undefined before `connect()`, and the
   * caller must treat that as "cannot tell" rather than "not us" -- defaulting
   * the other way would let the bot process its own messages.
   */
  get botOpenId(): string | undefined {
    return this.#botOpenId;
  }

  async sendText(target: SendTarget, text: string, uuid: string, buttons?: readonly CardButton[]): Promise<SendResult> {
    if (buttons !== undefined && buttons.length > 0) {
      try {
        return await this.sendCard(target, { markdown: text, buttons }, uuid);
      } catch (err) {
        // A card Lark will not take, for a reason that is not the chat's, must not
        // hold back the text it carries: the text goes alone, without its buttons.
        if (!(err instanceof ChannelError) || err.code === 0 || err.retryable || err.code === NOT_IN_CHAT) throw err;
        return this.sendText(target, text, uuid);
      }
    }
    // A send that stays in its thread is always one message, cut to fit: the
    // SDK's split send knows neither its thread nor that it must stay there.
    if (text.length <= ONE_MESSAGE || target.stayInThread === true) {
      const one = truncate(text, ONE_MESSAGE);
      return this.#withRetry(async () => {
        try {
          return await this.#post(target, 'post', postContent(one), uuid);
        } catch (err) {
          if (!(err instanceof ChannelError) || err.code !== INVALID_CONTENT) throw err;
          return this.#post(target, 'text', { text: one }, uuid);
        }
      });
    }
    return this.#withRetry(async () => {
      const result = await this.#lark.send(
        target.chatId,
        { markdown: truncate(text, TEXT_BUDGET) },
        this.#sendOptions(target),
      );
      return { messageId: result.messageId, deduped: false };
    });
  }

  async sendCard(target: SendTarget, view: CardView, uuid: string): Promise<SendResult> {
    return this.#withRetry(() => this.#post(target, 'interactive', boardCard(view), uuid));
  }

  async updateCard(messageId: string, view: CardView): Promise<void> {
    try {
      await this.#lark.updateCard(messageId, boardCard(view));
    } catch (err) {
      throw toChannelError(err);
    }
  }

  /**
   * One message, sent through the SDK's client with its uuid, answered with the
   * thread Lark says it is in, if any. A reply whose message is gone -- refused
   * with one of `WITHDRAWN_CODES`, or with an HTTP 404 -- goes to the chat
   * instead, with the same uuid: the fallback the SDK's own send makes, less
   * 230020, which is retried as a rate limit instead. Not for a target that stays
   * in its thread (spec §19.2): the refusal is thrown.
   */
  async #post(target: SendTarget, msgType: 'post' | 'text' | 'interactive', content: object, uuid: string): Promise<SendResult> {
    const im = this.#lark.rawClient.im.v1.message;
    // The errors Lark answered with an HTTP 404, whatever their body's code.
    const notFound = new WeakSet<ChannelError>();
    const send = async (req: MessageRequest): Promise<SendResult> => {
      let r: {
        code?: number | undefined;
        msg?: string | undefined;
        data?: { message_id?: string | undefined; thread_id?: string | undefined } | undefined;
      };
      try {
        r = req.kind === 'create' ? await im.create({ params: req.params, data: req.data }) : await im.reply({ path: req.path, data: req.data });
      } catch (err) {
        const e = sendError(err);
        if (httpStatus(err) === NOT_FOUND_STATUS) notFound.add(e);
        throw e;
      }
      if (typeof r.code === 'number' && r.code !== 0) throw toChannelError(r);
      const messageId = r.data?.message_id;
      if (messageId === undefined || messageId === '') throw new ChannelError(0, 'Lark answered the send with no message id', false);
      // Lark's reply answers with "the topic the message belongs to"; a direct message has none.
      const threadId = r.data?.thread_id;
      return { messageId, deduped: false, ...(threadId === undefined || threadId === '' ? {} : { threadId }) };
    };
    const req = messageRequest(target, msgType, content, uuid);
    try {
      return await send(req);
    } catch (err) {
      const gone = err instanceof ChannelError && !err.retryable && (WITHDRAWN_CODES.has(err.code) || notFound.has(err));
      if (req.kind !== 'reply' || !gone || target.stayInThread === true) throw err;
      return send(messageRequest({ chatId: target.chatId, threadId: '' }, msgType, content, uuid));
    }
  }

  /**
   * Open the reply card (channel spec §4.5), over Lark's card API directly.
   *
   * The card is made first, as a card entity with its three elements, then sent
   * by reference, a message of its own: placed as `#post` places any message,
   * and retried as one, with a uuid. The uuid is the card's, not the writer's:
   * the writer's is also the uuid of the plain message it falls back to for the
   * same seq, and of a card it opens again at the same seq once one has gone,
   * and Lark would answer either with this card's message rather than send it.
   * A card is sent once; a retry of the send is the same card, so the same uuid.
   *
   * Making the card is not retried here: an entity never sent costs nothing,
   * and the writer retries the whole open with the newest render.
   *
   * `createdAt` is read before the card is made, as an entity's 14 days run
   * from its making.
   */
  async openCard(target: SendTarget, initial: CardParts, _uuid: string): Promise<CardSession> {
    const cardkit = this.#lark.rawClient.cardkit.v1;
    const createdAt = this.#clock.now();

    let made: { code?: number | undefined; msg?: string | undefined; data?: { card_id: string } | undefined };
    try {
      made = await cardkit.card.create({ data: { type: 'card_json', data: JSON.stringify(replyCard(initial)) } });
    } catch (err) {
      throw sendError(err);
    }
    if (typeof made.code === 'number' && made.code !== 0) throw toChannelError(made);
    const cardId = made.data?.card_id;
    if (cardId === undefined || cardId === '') throw new ChannelError(0, 'Lark made the card with no card id', false);

    const sent = await this.#withRetry(() =>
      this.#post(target, 'interactive', { type: 'card', data: { card_id: cardId } }, `reply_${cardId}`.slice(0, 50)),
    );

    // What each element shows, as far as Lark has said it took it: an update is
    // sent only for a part that differs, and a part whose update failed is sent
    // again by the next write.
    const shown: Record<keyof CardParts, string> = {
      tools: partContent(initial.tools),
      answer: partContent(initial.answer),
      status: partContent(initial.status),
    };
    // One sequence for the card, every update and the settings drawing the next:
    // Lark orders a card's updates by it, and refuses one not above the last.
    let sequence = 0;
    let finished = false;

    const settings = async (config: object): Promise<void> => {
      sequence += 1;
      const at = sequence;
      await cardkitCall(() =>
        cardkit.card.settings({
          path: { card_id: cardId },
          data: { settings: JSON.stringify({ config }), sequence: at, uuid: `s_${cardId}_${at}` },
        }),
      );
    };
    const content = async (part: keyof CardParts, text: string): Promise<void> => {
      sequence += 1;
      const at = sequence;
      await cardkitCall(() =>
        cardkit.cardElement.content({
          path: { card_id: cardId, element_id: REPLY_ELEMENTS[part] },
          data: { content: text, sequence: at, uuid: `c_${cardId}_${at}` },
        }),
      );
    };
    // Lark stops streaming a card by itself, and a finish that failed has
    // stopped it too; an update is then refused, and streaming is turned on again.
    const streamOn = (): Promise<void> => settings({ streaming_mode: true, summary: { content: REPLY_SUMMARY_OPEN } });

    const write = async (parts: CardParts): Promise<void> => {
      for (const part of REPLY_ORDER) {
        const text = partContent(parts[part]);
        if (text === shown[part]) continue;
        try {
          await content(part, text);
        } catch (err) {
          if (!(err instanceof ChannelError) || !STREAMING_OFF_CODES.has(err.code)) throw err;
          // Once, with a new sequence; a second refusal is thrown with Lark's code.
          await streamOn();
          await content(part, text);
        }
        shown[part] = text;
      }
    };

    // Every `set` and `finish` of the card, one after another: two at once would
    // draw interleaved sequences, so the earlier could land late and be refused,
    // or a write could turn streaming on again after the finish turned it off.
    let tail: Promise<void> = Promise.resolve();
    const serial = (f: () => Promise<void>): Promise<void> => {
      const p = tail.then(f, f);
      tail = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    };

    return {
      messageId: sent.messageId,
      createdAt,
      set(parts: CardParts): Promise<void> {
        return serial(async () => {
          // Inert once finished: streaming is off, and the card is done.
          if (finished) return;
          await write(parts);
        });
      },
      finish(parts: CardParts): Promise<void> {
        return serial(async () => {
          // Idempotent once it has landed: teardown reaches this from the writer's
          // normal terminal path and again from its shutdown path, and a second
          // call must be inert rather than an error.
          if (finished) return;
          let failed: unknown;
          try {
            await write(parts);
          } catch (err) {
            failed = err;
          }
          // Whether or not the write landed: a card left streaming shows its
          // typing cursor until Lark gives up on it. Not for a card Lark no
          // longer holds, which has no streaming to turn off.
          const gone = failed instanceof ChannelError && CARD_GONE_CODES.has(failed.code);
          if (!gone) {
            try {
              await settings({ streaming_mode: false, summary: { content: replySummary(parts) } });
            } catch {
              // Best effort. The card keeps what it shows.
            }
          }
          // Thrown, so the writer counts it, and finishes again or falls back: the
          // last content is the answer's end, and it must not be lost in silence.
          if (failed !== undefined) throw failed;
          finished = true;
        });
      },
    };
  }

  /**
   * Post an approval card.
   *
   * Two deliberate choices in the card body:
   *
   * - Agent-supplied text is a `plain_text` element. There is then no markup
   *   syntax to inject into, so *displaying* a request cannot itself become an
   *   @-mention-everyone notification. The escaping in `escape.ts` defends the
   *   markdown path; this removes the need for a defence at all.
   * - Buttons are generated from the agent's own option set. Hardcoding
   *   allow/deny would invent outcomes the agent never offered and silently drop
   *   ones it did.
   */
  async sendApprovalCard(
    target: SendTarget,
    spec: ApprovalCardSpec,
    uuid: string,
  ): Promise<SendResult> {
    return this.#withRetry(() => this.#post(target, 'interactive', approvalCard(spec), uuid));
  }

  async updateApprovalCard(messageId: string, view: ApprovalOutcomeView): Promise<void> {
    try {
      await this.#lark.updateCard(messageId, approvalOutcomeCard(view));
    } catch (err) {
      throw toChannelError(err);
    }
  }

  /**
   * Reactions are not retried. They are a signal that matters only while it is
   * timely, and a retry loop on one would spend the per-chat rate limit the answer
   * itself is about to need.
   */
  async react(messageId: string, emoji: string): Promise<void> {
    try {
      await this.#lark.addReaction(messageId, emoji);
    } catch (err) {
      throw toChannelError(err);
    }
  }

  /**
   * A group's members, by union_id (spec §19.3), from Lark's chat members API:
   * its pages read in turn, at most `MEMBER_PAGES` of `MEMBER_PAGE_SIZE`, so
   * 2,000 members, `complete` false when it stopped there. Lark lists no bots,
   * and asks for the bot to be in the group. Not retried: the card poster
   * remembers a failure, and sends a direct message meanwhile.
   */
  async chatMembers(chatId: string): Promise<ChatMembers> {
    const api = this.#lark.rawClient.im.v1.chatMembers;
    const unionIds = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MEMBER_PAGES; page += 1) {
      let r: {
        code?: number | undefined;
        msg?: string | undefined;
        data?:
          | { items?: Array<{ member_id?: string | undefined }> | undefined; page_token?: string | undefined; has_more?: boolean | undefined }
          | undefined;
      };
      try {
        r = await api.get({
          path: { chat_id: chatId },
          params: { member_id_type: 'union_id', page_size: MEMBER_PAGE_SIZE, ...(pageToken === undefined ? {} : { page_token: pageToken }) },
        });
      } catch (err) {
        throw sendError(err);
      }
      if (typeof r.code === 'number' && r.code !== 0) throw toChannelError(r);
      for (const m of r.data?.items ?? []) if (m.member_id !== undefined && m.member_id !== '') unionIds.add(m.member_id);
      const next = r.data?.page_token;
      if (r.data?.has_more !== true) return { unionIds, complete: true };
      // More, by Lark's word, but no way to ask for it: what was read is not all.
      if (next === undefined || next === '') return { unionIds, complete: false };
      pageToken = next;
    }
    return { unionIds, complete: false };
  }

  async unreact(messageId: string, emoji: string): Promise<void> {
    try {
      // By emoji rather than by reaction id, so nothing has to remember the id
      // across the turn -- or across a restart in the middle of one. Returns false
      // when there was nothing to remove, which is not a failure.
      await this.#lark.removeReactionByEmoji(messageId, emoji);
    } catch (err) {
      throw toChannelError(err);
    }
  }

  #sendOptions(target: SendTarget): { replyTo?: string; replyInThread?: boolean } {
    // Threading requires a message to reply to. When the target carries no anchor
    // the message goes to chat scope, which is the honest fallback: silently
    // dropping the thread association is better than replying under an unrelated
    // message.
    if (target.threadId === '') {
      if (target.replyTo === undefined) return {};
      // A quoted reply that stays in the main chat, unless asked to open a thread on it.
      return target.replyInThread === true ? { replyTo: target.replyTo, replyInThread: true } : { replyTo: target.replyTo };
    }
    return { replyTo: threadAnchor(target), replyInThread: true };
  }

  /**
   * Retry a send.
   *
   * Retries are only ever attempted for errors classified retryable. Retrying a
   * permanent failure burns the per-chat rate limit that the next real message
   * needs, and produces the same error four times instead of once.
   *
   * A retry of a one-message send -- a text up to `ONE_MESSAGE`, a board or an
   * approval card -- carries the same uuid, so Lark deduplicates it: one that did
   * land is still one message. Only a longer text, which the SDK splits and sends
   * without one, is not deduplicated platform-side (see the class note on `uuid`);
   * a streamed card is not retried here.
   */
  async #withRetry(attempt: () => Promise<SendResult>): Promise<SendResult> {
    let lastError: unknown;
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      try {
        return await attempt();
      } catch (raw) {
        const err = toChannelError(raw);
        lastError = err;
        if (!err.retryable || i === MAX_SEND_ATTEMPTS - 1) throw err;
        // The platform's own reset hint beats a guess -- a fixed backoff either
        // gives up too early or waits far longer than the window actually is.
        const wait = err.retryAfterMs ?? backoffMs(i);
        await this.#sleep(wait);
      }
    }
    throw toChannelError(lastError);
  }
}

/**
 * An approval card, in Lark's card schema 2.0: the request, then one button per
 * offered option, side by side in one row (`buttonRow`), each value returned through a
 * callback behavior, as a board card's buttons are (`boardCard`).
 *
 * `value` round-trips through the client and Lark does not verify it. It is a
 * pointer, never a claim: identity comes from `operator.openId` on the callback,
 * and the nonce is re-checked against the log by a generation CAS before
 * anything happens. `kind` is how the router tells an approval's button from a
 * board card's (spec §9.2); a card posted before it had one is an approval's.
 */
export function approvalCard(spec: ApprovalCardSpec): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: forPlainText(spec.action) } },
        buttonRow(
          spec.options.map((option, i) => ({
            tag: 'button',
            name: `option_${i}`,
            text: { tag: 'plain_text', content: forPlainText(option.name) },
            type: buttonType(option.kind),
            behaviors: [
              {
                type: 'callback',
                value: { kind: 'approval', approvalId: spec.approvalId, optionId: option.optionId, nonce: spec.nonce },
              },
            ],
          })),
        ),
      ],
    },
  };
}

/**
 * The card an answered approval becomes.
 *
 * Every piece of text is `plain_text`, as on the card it replaces. The answerer's
 * display name is whatever they put in their profile, which makes it exactly as
 * untrusted as the agent's request.
 */
export function approvalOutcomeCard(view: ApprovalOutcomeView): object {
  const by = view.byOpenId === undefined ? undefined : byline(view.byOpenId);
  const answered = by === undefined ? `Answered: ${view.choice}, by ${view.answeredBy}` : `Answered: ${view.choice}`;
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: forPlainText(view.action) } },
        { tag: 'div', text: { tag: 'plain_text', content: forPlainText(answered) } },
        ...(by === undefined ? [] : [by]),
      ],
    },
  };
}

/** An open_id, as Lark gives one; anything else is never put in a person element. */
const OPEN_ID = /^ou_[0-9A-Za-z]+$/;

/**
 * "By" and Lark's own person element for `openId`, side by side: Lark draws the
 * person's name and avatar itself, so a card can name someone the gateway has no
 * name for, without showing their id and without a mention that notifies them.
 * Undefined for anything that is not an open_id.
 */
function byline(openId: string): object | undefined {
  if (!OPEN_ID.test(openId)) return undefined;
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '4px',
    columns: [
      { tag: 'column', width: 'auto', vertical_align: 'center', elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'By' } }] },
      {
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [{ tag: 'person', user_id: openId, size: 'small', show_avatar: true, show_name: true, style: 'normal' }],
      },
    ],
  };
}

/**
 * Lark's codes for an update refused because the card is not streaming: 200850,
 * streaming timed out, ten minutes after it was last turned on; 300309,
 * streaming is off. The session turns streaming on again and writes once more.
 */
const STREAMING_OFF_CODES: ReadonlySet<number> = new Set([200850, 300309]);

/**
 * The reply card's element ids (channel spec §4.5): one markdown element a part,
 * named so each part's update goes to its own element.
 */
export const REPLY_ELEMENTS: Readonly<Record<keyof CardParts, string>> = { tools: 'tools', answer: 'answer', status: 'status' };

/** The parts in reading order: the tool line, the answer, the status. */
const REPLY_ORDER: ReadonlyArray<keyof CardParts> = ['tools', 'answer', 'status'];

/**
 * What a part with nothing to show is sent as: a zero-width space. Lark is never
 * given an empty element, which it may refuse, and draws this as nothing.
 */
export const EMPTY_PART = '\u200b';

/** The card's preview in the chat list while it streams. */
export const REPLY_SUMMARY_OPEN = 'Working…';

/** The longest preview a finished card is given, in characters, as the SDK's own streaming card cuts its. */
const SUMMARY_MAX = 50;

/** A part as an element's content: itself, or `EMPTY_PART`. */
export function partContent(part: string): string {
  return part === '' ? EMPTY_PART : part;
}

/**
 * The reply card, in Lark's card schema 2.0 (channel spec §4.5): streaming, so
 * Lark's client types each update, with the SDK's own streaming card's pace, one
 * character every 70 ms, `fast` showing what is buffered when a new update
 * comes; and three markdown elements, one a part, in reading order. The parts
 * were escaped and masked by the renderer.
 */
export function replyCard(parts: CardParts): object {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: REPLY_SUMMARY_OPEN },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: 'fast',
      },
    },
    body: {
      elements: REPLY_ORDER.map((part) => ({ tag: 'markdown', element_id: REPLY_ELEMENTS[part], content: partContent(parts[part]) })),
    },
  };
}

/**
 * A finished card's preview in the chat list: the answer, else the status, else
 * the tool line, on one line, cut to `SUMMARY_MAX` characters on a code point.
 * The preview is plain text, so simple emphasis and backslash escapes are taken
 * out first: `_Turn failed._` previews as `Turn failed.`.
 */
export function replySummary(parts: CardParts): string {
  const text = [parts.answer, parts.status, parts.tools].find((p) => p.trim() !== '') ?? '';
  const chars = Array.from(plainPreview(text).replace(/\s+/g, ' ').trim());
  return chars.length <= SUMMARY_MAX ? chars.join('') : `${chars.slice(0, SUMMARY_MAX - 1).join('')}…`;
}

/**
 * Markdown's simple emphasis taken out of `text`, a marker pair at a time (`**`,
 * `~~`, `__`, then `*`, `` ` ``, `_`), an escaped marker left alone, and an
 * underscore only at a word's edge, so `snake_case` keeps its own; then each
 * backslash escape replaced by the character it escapes.
 */
function plainPreview(text: string): string {
  return text
    .replace(/(?<!\\)(\*\*|~~)(?=\S)(.+?)(?<=\S)(?<!\\)\1/g, '$2')
    .replace(/(?<![\w\\])__(?=\S)(.+?)(?<=\S)(?<!\\)__(?!\w)/g, '$1')
    .replace(/(?<!\\)([*`])(?=\S)(.+?)(?<=\S)(?<!\\)\1/g, '$2')
    .replace(/(?<![\w\\])_(?=\S)(.+?)(?<=\S)(?<!\\)_(?!\w)/g, '$1')
    .replace(/\\(.)/g, '$1');
}

/**
 * One call to Lark's card API, answered with `code` 0 or failed with Lark's code:
 * thrown, as axios throws an HTTP error, or in the body of a 2xx.
 */
async function cardkitCall(request: () => Promise<{ code?: number | undefined; msg?: string | undefined }>): Promise<void> {
  let r: { code?: number | undefined; msg?: string | undefined };
  try {
    r = await request();
  } catch (err) {
    throw sendError(err);
  }
  if (typeof r.code === 'number' && r.code !== 0) throw toChannelError(r);
}

/** The HTTP status of an error axios threw, if Lark answered at all. */
function httpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { response?: { status?: unknown } }).response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * A send's failure, as the channel reports it. One that never reached Lark -- no
 * response, so no status and no code: a reset connection, a timeout -- is worth
 * retrying, as the SDK's own send retried it; the uuid makes a retry of a send
 * that did land one message.
 */
export function sendError(err: unknown): ChannelError {
  const e = toChannelError(err);
  const answered = typeof err === 'object' && err !== null && (err as { response?: unknown }).response !== undefined;
  if (e.code !== 0 || e.retryable || answered) return e;
  return new ChannelError(0, err instanceof Error && err.message !== '' ? err.message : 'lark request failed', true);
}

/** One message, as `#post` sends it: a reply where the target threads or quotes, otherwise a new message. */
export type MessageRequest =
  | {
      kind: 'create';
      params: { receive_id_type: 'chat_id' | 'union_id' };
      data: { receive_id: string; msg_type: string; content: string; uuid: string };
    }
  | {
      kind: 'reply';
      path: { message_id: string };
      data: { msg_type: string; content: string; reply_in_thread?: boolean; uuid: string };
    };

/**
 * The message a send in a thread replies to: the thread's root when it is known
 * (spec §19.4), as Lark documents its reply API; else the thread's own id, as
 * every thread reply was sent before.
 */
function threadAnchor(target: SendTarget): string {
  return target.root === undefined || target.root === '' ? target.threadId : target.root;
}

/**
 * The request for one message to `target`, as `#sendOptions` places a message:
 * in its thread, as a quoted reply or one that opens a thread on its message, or
 * new in the chat -- or, for a person, as a direct message by union_id. The uuid
 * goes with it either way.
 */
export function messageRequest(target: SendTarget, msgType: string, content: object, uuid: string): MessageRequest {
  const body = { msg_type: msgType, content: JSON.stringify(content), uuid };
  if (target.receiveIdType !== 'union_id') {
    if (target.threadId !== '') return { kind: 'reply', path: { message_id: threadAnchor(target) }, data: { ...body, reply_in_thread: true } };
    if (target.replyTo !== undefined) {
      const data = target.replyInThread === true ? { ...body, reply_in_thread: true } : body;
      return { kind: 'reply', path: { message_id: target.replyTo }, data };
    }
  }
  return {
    kind: 'create',
    params: { receive_id_type: target.receiveIdType ?? 'chat_id' },
    data: { receive_id: target.chatId, ...body },
  };
}

/**
 * A text as a post of one markdown element, as the SDK's own markdown send makes
 * one: Feishu renders the markdown.
 */
export function postContent(text: string): object {
  return { zh_cn: { title: '', content: [[{ tag: 'md', text }]] } };
}

/**
 * Buttons side by side. Schema 2.0 stacks a body's (or a form's) elements one
 * above the other, so a row of buttons is a column_set of auto-width columns,
 * one button each; `flex_mode: 'none'` keeps them on one line, left-aligned.
 */
function buttonRow(buttons: object[]): object {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: buttons.map((button) => ({ tag: 'column', width: 'auto', elements: [button] })),
  };
}

/**
 * A board card (spec §9.2), in Lark's card schema 2.0: its markdown, then its
 * buttons in one row (`buttonRow`) -- in a form with the box, named `text`, when the card has one, so
 * each button submits what was typed (the inbound side reads it as
 * `form_value.text`). Each button's value goes back through a callback behavior.
 * Button labels and the box's placeholder are `plain_text`, as on an approval
 * card; the markdown was escaped by whoever rendered it. Updatable, so it can be
 * redrawn once acted on.
 */
export function boardCard(view: CardView): object {
  const buttons = view.buttons.map((b, i) => ({
    tag: 'button',
    // The attempt in the name: the SDK keys a press on the button's name, whole,
    // and on only the start of its value, however Lark orders the value's keys.
    name: `button_${i}_${view.attempt ?? 0}`,
    text: { tag: 'plain_text', content: forPlainText(b.label) },
    type: b.style,
    behaviors: [{ type: 'callback', value: { ...b.value } }],
    ...(view.input === undefined ? {} : { form_action_type: 'submit' }),
  }));
  const elements: object[] = [{ tag: 'markdown', content: view.markdown }];
  const by = view.byOpenId === undefined ? undefined : byline(view.byOpenId);
  if (by !== undefined) elements.push(by);
  if (buttons.length > 0 && view.input !== undefined) {
    elements.push({
      tag: 'form',
      name: 'board',
      elements: [
        {
          tag: 'input',
          name: 'text',
          width: 'fill',
          max_length: 1000,
          placeholder: { tag: 'plain_text', content: forPlainText(view.input.placeholder) },
        },
        buttonRow(buttons),
      ],
    });
  } else if (buttons.length > 0) {
    elements.push(buttonRow(buttons));
  }
  return { schema: '2.0', config: { update_multi: true }, body: { elements } };
}

function buttonType(kind: string | undefined): string {
  switch (kind) {
    case 'allow_once':
    case 'allow_always':
      return 'primary';
    case 'reject_once':
    case 'reject_always':
      return 'danger';
    default:
      return 'default';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
