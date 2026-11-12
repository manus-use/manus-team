import { createLarkChannel, type LarkChannel, type MarkdownStreamController } from '@larksuiteoapi/node-sdk';
import {
  ChannelError,
  type ApprovalCardSpec,
  type ApprovalOutcomeView,
  type CardButton,
  type CardSession,
  type CardView,
  type Channel,
  type SendResult,
  type SendTarget,
} from '../types.js';
import { forPlainText, truncate } from '../escape.js';
import { backoffMs, toChannelError } from './errors.js';
import type { Clock } from '../../time.js';
import { systemClock } from '../../time.js';
import { PRODUCT_NAME } from '../../identity.js';

/**
 * The Lark implementation of the outbound `Channel` port.
 *
 * Built on the SDK's high-level `Channel` module rather than raw API calls. That
 * is a deliberate bet: the module already owns per-chat queueing, the streaming
 * card lifecycle, and the 30,000-character element rollover, and reimplementing
 * those on top of `im.v1.*` means owning three pieces of fiddly behaviour whose
 * failure modes are all silent. The cost of the bet is that the card lifecycle is
 * shaped by its producer callback, which is why `CardSession` exists.
 *
 * **The uuid.** The SDK's high-level `send`/`stream` do not expose Feishu's
 * `uuid` field, so every message that goes out as one message -- a text of up to
 * `ONE_MESSAGE` characters, an approval card, a board card -- is sent through the
 * SDK's own client instead (`im.v1.message.create` or `reply`), with the uuid:
 * Feishu then sends one message for any number of sends with the same uuid
 * within an hour, so a retry, or a notice sent again after a restart, is one
 * message (spec §9.4). A longer text is split by the SDK into several messages,
 * and a streamed card is the SDK's to send; neither carries the uuid, so a retry
 * of those can still post a second copy.
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
/**
 * The longest text sent as one message, with its uuid. Every reply the router
 * sends (cut at 4,000) and every batch of notices (at most 3,800) fits; a longer
 * text is split by the SDK, at its own 3,500, without one.
 */
export const ONE_MESSAGE = 4_000;
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
    if (text.length <= ONE_MESSAGE) {
      return this.#withRetry(async () => {
        try {
          return await this.#post(target, 'post', postContent(text), uuid);
        } catch (err) {
          if (!(err instanceof ChannelError) || err.code !== INVALID_CONTENT) throw err;
          return this.#post(target, 'text', { text }, uuid);
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
   * Open a streaming card.
   *
   * `stream()` does not return until its producer resolves, so it cannot be
   * awaited here -- the card has to stay writable for the length of a turn. What
   * this does instead is start `stream()`, wait for the producer to hand over its
   * controller, and return a session that drives it.
   *
   * The producer is held open by a promise that `finish()` resolves. That is the
   * whole trick, and it has one hard requirement: **`finish()` must be reached on
   * every path**, including failure, or `stream()` never settles and the card
   * shows a typing indicator forever.
   */
  async openCard(target: SendTarget, initialText: string, _uuid: string): Promise<CardSession> {
    const clock = this.#clock;

    let onController: (c: MarkdownStreamController) => void;
    let onFailed: (e: unknown) => void;
    const ready = new Promise<MarkdownStreamController>((resolve, reject) => {
      onController = resolve;
      onFailed = reject;
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const streaming = this.#lark
      .stream(
        target.chatId,
        {
          markdown: async (controller) => {
            await controller.setContent(initialText);
            onController(controller);
            await held;
          },
        },
        this.#sendOptions(target),
      )
      .catch((err: unknown) => {
        // Surfaced to whichever side is waiting. Before handover this rejects
        // `openCard`; after it, the failure is reported through `set`/`finish`.
        onFailed(err);
        // Unblock the producer so a failed stream cannot leave `finish()` hanging.
        release();
        throw toChannelError(err);
      });
    // The rejection is consumed by whoever awaits `streaming`; this keeps it from
    // surfacing as an unhandled rejection in the meantime.
    void streaming.catch(() => undefined);

    let controller: MarkdownStreamController;
    try {
      controller = await ready;
    } catch (err) {
      throw toChannelError(err);
    }

    const createdAt = clock.now();
    let finished = false;

    return {
      messageId: controller.messageId,
      createdAt,
      async set(text: string): Promise<void> {
        if (finished) return;
        try {
          await controller.setContent(text);
        } catch (err) {
          throw toChannelError(err);
        }
      },
      async finish(text: string): Promise<void> {
        // Idempotent: teardown reaches this from the writer's normal terminal
        // path and again from its shutdown path, and a second call must be inert
        // rather than an error.
        if (finished) return;
        finished = true;
        try {
          await controller.setContent(text);
        } catch {
          // The content update failed, but the producer still has to be released.
          // Leaving it held would hang `stream()` and, with it, the card.
        }
        release();
        await streaming.catch(() => undefined);
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
