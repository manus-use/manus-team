import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CardActionEvent, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { LarkAdapter } from './adapter.js';
import type { InboundAttachment, InboundMention, InboundMessage, Principal } from '../../types.js';
import type { InboundCardAction, Router } from '../../core/router.js';

/**
 * Turn Lark events into the gateway's own vocabulary.
 *
 * Everything vendor-shaped stops here. The router below it sees `InboundMessage`
 * and `InboundCardAction` and nothing else, which is what keeps Feishu's quirks --
 * `root_id` versus `thread_id`, app-scoped versus tenant-scoped ids, the re-push
 * ladder -- from becoming gateway vocabulary.
 */

/** Attachment cap. Beyond this the file is skipped, and the router tells the user. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface LarkInboundConfig {
  appId: string;
  /** Directory attachments are written to. Must not be inside the workspace. */
  downloadDir: string;
}

export interface LarkInboundDeps {
  adapter: LarkAdapter;
  router: Router;
  config: LarkInboundConfig;
  note?: (line: string) => void;
}

export class LarkInbound {
  readonly #deps: LarkInboundDeps;
  readonly #note: (line: string) => void;
  #unsubscribe: (() => void) | undefined;
  /** Approvals' acknowledgements being sent. */
  readonly #acks = new Set<Promise<void>>();

  constructor(deps: LarkInboundDeps) {
    this.#deps = deps;
    this.#note = deps.note ?? (() => undefined);
  }

  start(): void {
    if (this.#unsubscribe !== undefined) return;
    this.#unsubscribe = this.#deps.adapter.raw.on({
      message: (msg) => this.#onMessage(msg),
      cardAction: (evt) => this.#onCardAction(evt),
      // The SDK's own policy layer rejects before we see the message. Ours is the
      // one that decides, so this is only ever a log line -- but a silent
      // divergence between the two policies is worth being able to see.
      reject: (evt) => this.#note(`sdk rejected ${evt.messageId}: ${evt.reason}`),
      error: (err) => this.#note(`channel error: ${err.message}`),
      // A revoked token and a network blip look identical under infinite retry, so
      // reconnect churn has to be visible rather than merely survived.
      reconnecting: () => this.#note('websocket reconnecting'),
      reconnected: () => this.#note('websocket reconnected'),
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async #onMessage(msg: NormalizedMessage): Promise<void> {
    // Loop guard. `undefined` means we could not tell, and "cannot tell" must not
    // resolve to "not us": a bot processing its own output loops until someone
    // notices the bill.
    const botOpenId = this.#deps.adapter.botOpenId;
    if (botOpenId === undefined) {
      this.#note(`dropping ${msg.messageId}: bot identity not yet known`);
      return;
    }
    if (msg.senderId === botOpenId) return;

    const raw = asRawMessage(msg.raw);
    const senderType = raw?.sender?.sender_type;

    const sender: Principal = {
      openId: msg.senderId,
      // The canonical human key, and the reason `includeRawEvent` is on. The
      // normalizer drops it, and `open_id` is app-scoped -- correct as a per-bot
      // handle, wrong as a durable identity.
      unionId: raw?.sender?.sender_id?.union_id ?? null,
      displayName: msg.senderName ?? null,
    };

    const message: InboundMessage = {
      messageId: msg.messageId,
      appId: this.#deps.config.appId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      // `thread_id` only, never `root_id`. Every reply in a chat carries a
      // `root_id`, so keying a session on it forks one session per reply chain --
      // and a topic group's real thread would never be found.
      threadId: msg.threadId ?? '',
      sender,
      senderIsBot: senderType === 'app' || senderType === 'bot',
      text: msg.content,
      mentionedBot: msg.mentionedBot,
      mentionAll: msg.mentionAll,
      // From the raw event: the normalizer keeps a mention's open_id and drops its
      // union_id, which is how the board knows a person (spec §9.1).
      mentions: mentionsOf(msg.raw, botOpenId),
      attachments: await this.#download(msg),
      createTime: msg.createTime,
    };

    await this.#deps.router.onMessage(message);
  }

  /**
   * Fetch attachments to disk and hand the agent paths.
   *
   * Paths, never inline bytes: a 10 MB upload inlined into a prompt spends the
   * context window on data the agent can read on demand.
   *
   * A failed download is reported and skipped rather than failing the message. The
   * text a user wrote alongside a file is usually the instruction, and losing the
   * whole message because one image would not fetch is the wrong trade.
   */
  async #download(msg: NormalizedMessage): Promise<InboundAttachment[]> {
    if (msg.resources.length === 0) return [];

    const dir = join(this.#deps.config.downloadDir, msg.messageId);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const out: InboundAttachment[] = [];
    for (const resource of msg.resources) {
      const attachment: InboundAttachment = {
        fileKey: resource.fileKey,
        kind: resource.type,
        name: resource.fileName ?? null,
      };
      try {
        // The SDK's download surface has two types, not five. Anything that is not
        // an image goes down the `file` path, which is what the API itself expects.
        const buffer = await this.#deps.adapter.raw.downloadResource(
          resource.fileKey,
          resource.type === 'image' ? 'image' : 'file',
        );
        if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
          this.#note(`skipping ${resource.fileKey}: ${buffer.byteLength} bytes`);
          out.push({ ...attachment, skipped: 'too_large' });
          continue;
        }
        const path = join(dir, safeName(resource.fileKey, resource.fileName));
        await writeFile(path, buffer, { mode: 0o600 });
        out.push({ ...attachment, localPath: path });
      } catch (err) {
        this.#note(
          `download ${resource.fileKey} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        out.push({ ...attachment, skipped: 'download_failed' });
      }
    }
    return out;
  }

  /**
   * Handle a button click.
   *
   * **The callback waits for this.** The SDK answers Lark's callback only once
   * this handler returns, and Lark waits about three seconds for the answer. So
   * the handler returns as soon as the router has: a board card's press is shown
   * on its card, and posts nothing (spec §9.2); an approval's acknowledgement is a
   * message of its own, sent after, unawaited, and tracked so `idle()` can wait
   * for it at shutdown.
   *
   * **Known gap.** The SDK discards this handler's return value, so a toast -- a
   * callback's own response body -- is unreachable from here; an approval's
   * outcome is posted as a message in the chat instead, durable and visible to
   * everyone who can see the card.
   */
  async #onCardAction(evt: CardActionEvent): Promise<void> {
    const action: InboundCardAction = {
      chatId: evt.chatId,
      messageId: evt.messageId,
      operator: {
        // Identity comes from here and only from here. `action.value` round-trips
        // through the client and Lark does not verify it.
        openId: evt.operator.openId,
        unionId: asRawCardAction(evt.raw)?.operator?.union_id ?? null,
        displayName: evt.operator.name ?? null,
      },
      value: isRecord(evt.action.value) ? evt.action.value : {},
      ...cardInput(evt.raw),
    };

    const outcome = await this.#deps.router.onCardAction(action);
    // A board card's press is acknowledged by its card, not in the chat (spec §9.2).
    if (outcome === undefined) return;
    const ack = this.#acknowledge(evt, action, outcome);
    this.#acks.add(ack);
    void ack.finally(() => this.#acks.delete(ack));
  }

  /**
   * Once every acknowledgement being sent has been, or `boundMs` has passed: for
   * shutdown, before the channel disconnects. True once drained.
   */
  async idle(boundMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), boundMs);
    });
    try {
      return await Promise.race([Promise.allSettled([...this.#acks]).then(() => true), bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** An approval's acknowledgement; never rejects. */
  async #acknowledge(evt: CardActionEvent, action: InboundCardAction, outcome: string): Promise<void> {
    try {
      await this.#deps.adapter.sendText(
        // Chat scope: the card is already the anchor, and threading the
        // acknowledgement under it needs a thread id the callback does not carry.
        { chatId: evt.chatId, threadId: '' },
        outcome,
        // Keyed on the click, not on the outcome. Feishu's own re-delivery of the
        // same click then collapses to one acknowledgement.
        clickUuid(this.#deps.config.appId, evt, action.input),
      );
    } catch (err) {
      this.#note(
        `acknowledging click on ${evt.messageId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

interface RawMessageShape {
  sender?: { sender_id?: { union_id?: string }; sender_type?: string };
}

function asRawMessage(raw: unknown): RawMessageShape | undefined {
  return isRecord(raw) ? (raw as RawMessageShape) : undefined;
}

/** The ids Lark sends with a message's mentions, in its raw event. */
interface RawMentionsShape {
  message?: { mentions?: unknown };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The people a message @-mentions, from its raw event: each mention's key, the
 * name the text shows, and the open_id and union_id Lark gave. `@all` is not a
 * person, and the bot's own mention is how a group addresses it, so both are
 * left out. Anything not shaped like a mention is skipped.
 */
export function mentionsOf(raw: unknown, botOpenId: string): InboundMention[] {
  const list = isRecord(raw) ? (raw as RawMentionsShape).message?.mentions : undefined;
  if (!Array.isArray(list)) return [];
  const out: InboundMention[] = [];
  for (const m of list) {
    if (!isRecord(m)) continue;
    const key = text(m['key']);
    if (key === null || key === '@_all') continue;
    const ids = isRecord(m['id']) ? m['id'] : {};
    const openId = text(ids['open_id']);
    if (openId !== null && openId === botOpenId) continue;
    out.push({ key, name: text(m['name']), openId, unionId: text(ids['union_id']) });
  }
  return out;
}

interface RawCardActionShape {
  operator?: { union_id?: string };
  /** Lark's token for this one callback: a new press has a new one, a re-delivery the same. */
  token?: string;
}

/** What a card's input box held, sent with the button that submitted its form. */
interface RawFormShape {
  action?: { form_value?: unknown };
}

/**
 * The text typed in a card's box (spec §9.2: Done and Block take a summary or a
 * reason, Request changes a reason), from the raw callback's `form_value`, where
 * the box is named `text`. Absent when the button submitted no form.
 */
export function cardInput(raw: unknown): { input?: string } {
  const form = isRecord(raw) ? (raw as RawFormShape).action?.form_value : undefined;
  if (!isRecord(form)) return {};
  const value = form['text'];
  return typeof value === 'string' ? { input: value } : {};
}

function asRawCardAction(raw: unknown): RawCardActionShape | undefined {
  return isRecord(raw) ? (raw as RawCardActionShape) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The uuid of a click's acknowledgement. Lark sends one message per uuid for an
 * hour, so two presses of one button -- a Block refused for an empty box, then
 * pressed with a reason -- must not share one: the callback's own token, which a
 * re-delivery of the same press keeps, and what the box held, are part of it.
 */
export function clickUuid(appId: string, evt: CardActionEvent, input: string | undefined): string {
  const token = asRawCardAction(evt.raw)?.token ?? '';
  const canonical = [appId, evt.messageId, evt.operator.openId, JSON.stringify(evt.action.value ?? null), token, input ?? ''].join(
    '\u0000',
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 50);
}

/**
 * A filename that cannot escape its directory.
 *
 * The file key is hashed in rather than trusted, and the user-supplied name is
 * reduced to a suffix. A name arriving as `../../.ssh/authorized_keys` is not a
 * hypothetical: the field is whatever the sender's client put in it.
 */
function safeName(fileKey: string, fileName: string | undefined): string {
  const digest = createHash('sha256').update(fileKey, 'utf8').digest('hex').slice(0, 12);
  const cleaned = (fileName ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  const suffix = cleaned === '' ? 'bin' : cleaned.slice(-64);
  return `${digest}-${suffix}`;
}
