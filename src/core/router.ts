import type { Db } from '../db/open.js';
import { appendEvent, lastEventOfType } from '../db/events.js';
import { claimMessage, recordOutcome } from '../db/dedup.js';
import { getApproval } from '../db/approvals.js';
import { bindingsInConversation, resolveBinding } from '../db/bindings.js';
import type { Channel, SendTarget } from '../channel/types.js';
import { forDisplay, truncate } from '../channel/escape.js';
import { redactKnownSecrets } from '../secrets.js';
import { isResumableProviderId } from '../provider-id.js';
import { label } from '../kanban/chat-render.js';
import type {
  BindingKey,
  InboundAttachment,
  InboundMessage,
  Principal,
  RejectReason,
} from '../types.js';
import type { Authorizer } from '../policy/auth.js';
import { parseCommand, renderHelp, type CommandSpec } from './commands.js';
import { replyUuid } from './ids.js';
import { LaneShed, Lanes } from './lane.js';
import { MailboxFull, SessionHeld, type SessionActor } from './session-actor.js';
import { canMutate } from './status.js';
import type { SessionRegistry } from './registry.js';
import type { Clock } from '../time.js';
import { systemClock } from '../time.js';

/**
 * Inbound routing: dedup, policy, commands, prompts.
 *
 * ### Ordering, in two lanes
 *
 * 1. A **chat-wide** lane, held across routing. It has to be chat-wide rather than
 *    per-thread because a topic's seed message carries no `thread_id` yet -- you
 *    cannot key a lane on a session you have not identified. Held only until the
 *    prompt is *queued*, never for the length of the turn, or one slow turn would
 *    stall every other thread in the chat.
 * 2. A **per-session** lane, which is the actor's own mailbox. There is no second
 *    `Lanes` instance for it, deliberately: the actor is already the single writer,
 *    and a lane in front of it would be a second queue with its own ordering to get
 *    wrong.
 *
 * ### Store first
 *
 * `claimMessage` runs before any policy check and before any reply. Feishu re-pushes
 * an unacknowledged event at 15s, 5min, 1h and 6h, so the durable claim is what
 * turns four deliveries into one turn. Checking policy first would work too, right
 * up until the policy check itself throws.
 */

export interface InboundCardAction {
  chatId: string;
  messageId: string;
  /** From `operator.openId`. Never from the card payload. */
  operator: Principal;
  /**
   * `action.value`, as it came back.
   *
   * Round-tripped through the client and **not verified by Lark**. Every field here
   * is untrusted: a pointer at most, never a claim about who clicked.
   */
  value: Record<string, unknown>;
  /** What was typed in the card's box, when the button submitted it with its form. */
  input?: string;
}

/**
 * The board's chat commands (spec §9.1): what follows `/kanban`, run for the
 * message that typed it, answered as the reply to send; and a press of a board
 * card's button (spec §9.2), answered the same way. `KanbanChat`.
 */
export interface KanbanCommands {
  run(arg: string, message: InboundMessage, key: BindingKey): Promise<string>;
  card(action: InboundCardAction): Promise<string>;
}

export interface RouterDeps {
  db: Db;
  registry: SessionRegistry;
  authorizer: Authorizer;
  channel: Channel;
  channelId: string;
  appId: string;
  /** The board's commands; absent when `kanban.enabled` is off, and `/kanban` says so. */
  kanban?: KanbanCommands;
  clock?: Clock;
  note?: (line: string) => void;
}

/** What `/kanban` says on a gateway whose board is off. */
export const KANBAN_OFF =
  'The task board is off on this gateway. An operator turns it on with `kanban.enabled: true` in config.yaml, and a restart.';

/** Reasons we stay silent rather than explain ourselves. See `#shouldExplain`. */
const SILENT_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  'sender_not_allowed',
  'chat_not_allowed',
  'bot_sender',
  'no_mention',
]);

export class Router {
  readonly #deps: RouterDeps;
  readonly #clock: Clock;
  readonly #note: (line: string) => void;
  readonly #ingress = new Lanes();

  constructor(deps: RouterDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#note = deps.note ?? (() => undefined);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async onMessage(message: InboundMessage): Promise<void> {
    try {
      await this.#ingress.run(message.chatId, () => this.#route(message));
    } catch (err) {
      if (err instanceof LaneShed) {
        // Shedding must be visible. A refusal the user never sees is the same
        // silent loss the depth cap exists to prevent, moved one level up.
        this.#note(`shed message ${message.messageId}: ${err.message}`);
        await this.#reply(
          this.#targetFor(message),
          message,
          'too-busy',
          'Too many messages queued in this chat. Send that again in a moment.',
        );
        return;
      }
      this.#note(
        `routing ${message.messageId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async #route(message: InboundMessage): Promise<void> {
    const now = this.#clock.now();

    // Durable, before anything else. A redelivery loses the race here and is
    // dropped without a second reply.
    if (!claimMessage(this.#deps.db, message.messageId, message.chatId, now)) {
      this.#note(`duplicate delivery of ${message.messageId}`);
      return;
    }

    const key = this.#keyFor(message);
    const target = this.#targetFor(message);

    const admitted = this.#deps.authorizer.admits(message);
    if (!admitted.ok) {
      recordOutcome(this.#deps.db, message.messageId, 'rejected');
      this.#recordRejection(key, message, admitted.reason, admitted.detail);
      if (this.#shouldExplain(admitted.reason)) {
        await this.#reply(target, message, 'rejected', admitted.detail);
      }
      return;
    }

    const parsed = parseCommand(message.text);
    if (parsed !== undefined && 'unknown' in parsed) {
      await this.#reply(
        target,
        message,
        'unknown-command',
        `Unknown command \`/${forDisplay(parsed.unknown)}\`. Try \`/help\`.`,
      );
      return;
    }

    if (parsed !== undefined) {
      await this.#runCommand(parsed.spec, parsed.arg, message, key, target);
      return;
    }

    // Said before anything else about the prompt, including a refusal of it: the
    // user is the only one who can resend the file, and is otherwise the one
    // person who does not know it never arrived.
    const skipped = message.attachments.filter((a) => a.skipped !== undefined);
    if (skipped.length > 0) {
      await this.#reply(target, message, 'attachments-skipped', describeSkipped(skipped));
    }

    // Not a command: a prompt. Nothing the agent could read is nothing to send --
    // an empty prompt burns a turn and confuses the agent. A file that did not
    // arrive counts as nothing, which the notice above has already explained.
    if (message.text.trim() === '' && pathsOf(message).length === 0) {
      if (skipped.length === 0) {
        await this.#reply(target, message, 'empty', 'That message had nothing in it.');
      }
      return;
    }

    await this.#submit(message, key, target);
  }

  async #submit(message: InboundMessage, key: BindingKey, target: SendTarget): Promise<void> {
    const { session, created } = this.#deps.registry.bindOrCreate(key, message.sender);
    if (created) this.#note(`created session ${session.id} for ${key.conversationId}/${key.threadId}`);

    const actor = await this.#deps.registry.actorFor(session.id, key);
    // Read before the submit, which counts itself in.
    const ahead = actor.queued;

    let queued: Promise<unknown>;
    try {
      queued = actor.submit({
        messageId: message.messageId,
        appId: message.appId,
        input: { text: message.text, paths: pathsOf(message) },
        ...(target.replyTo === undefined ? {} : { replyTo: target.replyTo }),
      });
    } catch (err) {
      await this.#reportSubmitFailure(err, message, target);
      return;
    }

    // A refusal (full mailbox, closed actor) comes back as a rejected promise, not
    // a throw, and is reported below. The depth is what tells them apart now: only
    // an accepted prompt is counted. Acknowledging a refused one as "Queued" and
    // then reporting it refused contradicts itself.
    const accepted = actor.queued > ahead;

    // Not awaited, for the same reason the turn is not: a slow reactions endpoint
    // must not hold the chat-wide lane.
    const acked = accepted ? this.#acknowledge(message.messageId) : Promise.resolve(false);

    if (accepted && ahead > 0) {
      await this.#reply(
        target,
        message,
        'queued',
        `Queued: ${ahead} ahead of this one. It starts when ${ahead === 1 ? 'that finishes' : 'they finish'}; \`/stop\` cancels the running one.`,
      );
    }

    // Deliberately not awaited. The chat-wide ingress lane is still held; holding
    // it for the length of a turn would stall every other thread in this chat
    // behind one long-running agent.
    queued
      .catch((err: unknown) => {
        void this.#reportSubmitFailure(err, message, target);
      })
      .finally(() => {
        void acked.then((ok) => (ok ? this.#unacknowledge(message.messageId) : undefined));
      });
  }

  /**
   * React to an accepted prompt. Resolves to whether the reaction landed.
   *
   * The first card waits out the coalesce window and the agent's start; this is
   * what the user sees in the meantime. Best effort throughout: a bot without the
   * reactions scope still answers, it just answers without the early signal.
   */
  async #acknowledge(messageId: string): Promise<boolean> {
    try {
      await this.#deps.channel.react(messageId, ACK_EMOJI);
      return true;
    } catch (err) {
      this.#note(`reaction on ${messageId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async #unacknowledge(messageId: string): Promise<void> {
    try {
      await this.#deps.channel.unreact(messageId, ACK_EMOJI);
    } catch (err) {
      // A reaction left behind is cosmetic. The card already says the turn ended.
      this.#note(
        `removing reaction on ${messageId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async #reportSubmitFailure(
    err: unknown,
    message: InboundMessage,
    target: SendTarget,
  ): Promise<void> {
    if (err instanceof MailboxFull) {
      await this.#reply(
        target,
        message,
        'mailbox-full',
        'This session already has a queue of prompts waiting. Let it catch up, or /stop.',
      );
      return;
    }
    if (err instanceof SessionHeld) {
      await this.#reply(
        target,
        message,
        'held',
        'This session is held: a prompt was in flight when the gateway restarted and may or may not have been delivered. ' +
          'Check what changed, then `/new` to start fresh or `/attach` to take it back.',
      );
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    this.#note(`submit failed for ${message.messageId}: ${detail}`);
    await this.#reply(target, message, 'submit-failed', `Could not run that: ${forDisplay(detail)}`);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async #runCommand(
    spec: CommandSpec,
    arg: string,
    message: InboundMessage,
    key: BindingKey,
    target: SendTarget,
  ): Promise<void> {
    const tier = this.#deps.authorizer.admitsTier(message.sender, spec.tier);
    if (!tier.ok) {
      this.#recordRejection(key, message, tier.reason, `${spec.name}: ${tier.detail}`);
      await this.#reply(target, message, `tier-${spec.name}`, tier.detail);
      return;
    }

    const binding = resolveBinding(this.#deps.db, key);
    if (spec.needsSession && binding === undefined) {
      await this.#reply(
        target,
        message,
        `no-session-${spec.name}`,
        'Nothing is bound here yet. Send a message first.',
      );
      return;
    }

    // Mutating verbs refuse mid-turn rather than bypass. Bypassing means racing the
    // actor for the same session, and the loser's write is the one the user asked
    // for.
    if (spec.mutating && binding !== undefined) {
      const actor = this.#deps.registry.liveActor(binding.sessionId);
      if (actor !== undefined) {
        const allowed = canMutate(actor.status());
        if (!allowed.ok) {
          await this.#reply(target, message, `busy-${spec.name}`, allowed.reason);
          return;
        }
      }
    }

    const actorFor = async (sessionId: string): Promise<SessionActor> =>
      this.#deps.registry.actorFor(sessionId, key);

    switch (spec.name) {
      case 'help':
        await this.#reply(target, message, 'help', renderHelp());
        return;

      case 'status': {
        if (binding === undefined) {
          await this.#reply(target, message, 'status', 'No session here yet.');
          return;
        }
        const actor = await actorFor(binding.sessionId);
        const view = actor.status();
        await this.#reply(
          target,
          message,
          'status',
          `**${view.label}**: ${forDisplay(view.detail)}\n` +
            `session \`${binding.sessionId}\` · generation ${view.generation} · ` +
            `${view.openTurns} open turn(s) · ${view.pendingApprovals} pending approval(s)` +
            continuityLine(lastEventOfType(this.#deps.db, binding.sessionId, 'provider_session_observed')?.payload),
        );
        return;
      }

      case 'sessions': {
        const rows = bindingsInConversation(
          this.#deps.db,
          this.#deps.channelId,
          this.#deps.appId,
          message.chatId,
        );
        if (rows.length === 0) {
          await this.#reply(target, message, 'sessions', 'No sessions bound in this chat.');
          return;
        }
        const lines = rows.map(
          (b) =>
            `\`${b.sessionId}\`: ${b.threadId === '' ? 'chat scope' : `thread \`${b.threadId}\``}` +
            `${b.sessionId === binding?.sessionId ? ' (here)' : ''}`,
        );
        await this.#reply(target, message, 'sessions', lines.join('\n'));
        return;
      }

      case 'new': {
        const session = await this.#deps.registry.rotate(key, message.sender);
        await this.#reply(
          target,
          message,
          'new',
          `Fresh session \`${session.id}\`. The previous one is archived, not deleted. ` +
            '`/sessions` lists it and `/attach` brings it back.',
        );
        return;
      }

      case 'attach': {
        if (arg === '') {
          await this.#reply(target, message, 'attach', 'Usage: `/attach <session-id>`');
          return;
        }
        const result = await this.#deps.registry.attach(key, arg);
        await this.#reply(
          target,
          message,
          `attach-${arg}`,
          result.ok
            ? `Attached \`${result.session.id}\`. History replays into this thread on the next message.`
            : forDisplay(result.reason),
        );
        return;
      }

      case 'stop': {
        if (binding === undefined) return;
        const actor = this.#deps.registry.liveActor(binding.sessionId);
        if (actor === undefined) {
          await this.#reply(target, message, 'stop', 'Nothing is running.');
          return;
        }
        await actor.cancel();
        await this.#reply(
          target,
          message,
          'stop',
          'Cancelling. Cancellation is a terminal, not a deletion. The log keeps everything up to here.',
        );
        return;
      }

      case 'kanban': {
        let text: string;
        const kanban = this.#deps.kanban;
        if (kanban === undefined) {
          text = KANBAN_OFF;
        } else {
          try {
            text = await kanban.run(arg, message, key);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            this.#note(`kanban command in ${message.messageId} failed: ${redactKnownSecrets(detail)}`);
            // One line, masked and cut, as a refusal is: an error can quote anything.
            text = `The board could not do that: ${label(detail, 600)}`;
          }
        }
        // Each piece was escaped, and masked, as it was put in; the whole reply is
        // masked once more, for what was not: ids, names, the board's own words.
        await this.#reply(target, message, 'kanban', redactKnownSecrets(text));
        return;
      }

      case 'cd': {
        // Declared in the registry but not wired in this build: every session shares
        // one configured directory, so there is no per-session path to repoint.
        // Saying so is the point -- a `/cd` that silently succeeded and changed
        // nothing is worse than one that is honestly unavailable.
        await this.#reply(
          target,
          message,
          'cd',
          'Not available in this build: all sessions run in the single configured workspace directory.',
        );
        return;
      }

      default:
        await this.#reply(
          target,
          message,
          `todo-${spec.name}`,
          `\`/${spec.name}\` is declared but not implemented.`,
        );
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Card actions
  // -------------------------------------------------------------------------

  /**
   * Handle a button click. Returns the text to acknowledge it with in the chat,
   * or undefined for a board card's, whose card shows the outcome itself (spec §9.2).
   *
   * Not deduplicated by message id, deliberately. `seen_messages` claims a
   * *delivery*; two clicks of the same button are two intents that legitimately
   * repeat. Idempotency comes from `resolveApproval`, which returns `already`
   * instead of overwriting the first answer.
   */
  async onCardAction(action: InboundCardAction): Promise<string | undefined> {
    // The card's kind first (spec §9.2), then that kind's authorization: the board's
    // rules for a board card, under which a named assignee at talk tier may press
    // Done; operator tier for an approval. A card posted before cards said which
    // they are is an approval's.
    const kind = action.value['kind'];
    if (kind === 'kanban') return this.#boardCard(action);
    if (kind !== undefined && kind !== 'approval') return 'That button is not one this gateway knows.';

    const approvalId = stringField(action.value, 'approvalId');
    const optionId = stringField(action.value, 'optionId');
    const nonce = stringField(action.value, 'nonce');
    if (approvalId === undefined || optionId === undefined || nonce === undefined) {
      return 'That button is missing its payload.';
    }

    // Answering an approval authorizes an action, so it needs operator tier -- the
    // same tier the equivalent command would need. A card is a different input
    // surface, not a different permission model.
    const tier = this.#deps.authorizer.admitsTier(action.operator, 'operate');
    if (!tier.ok) return tier.detail;

    const approval = getApproval(this.#deps.db, approvalId);
    if (approval === undefined) return 'That request no longer exists.';

    const actor = await this.#deps.registry.actorForBoundSession(approval.sessionId);
    if (actor === undefined) {
      return 'That session is no longer bound to a chat. Start a new one with /new.';
    }

    const report = actor.resolveFromCard({
      approvalId,
      optionId,
      nonce,
      principal: action.operator,
      via: this.#deps.channelId,
    });
    return report.message;
  }

  /**
   * A board card's button, for the board to authorize and act on. Nothing is
   * posted in the chat: the card shows what happened -- "Working on it…", then the
   * outcome, or why the press did nothing -- and the board's answer is noted,
   * masked, for a press the card cannot show, such as someone else's.
   */
  async #boardCard(action: InboundCardAction): Promise<undefined> {
    const kanban = this.#deps.kanban;
    if (kanban === undefined) {
      this.#note(`kanban card on ${action.messageId} pressed with the board off`);
      return undefined;
    }
    try {
      const answer = Array.from(redactKnownSecrets(await kanban.card(action)).replace(/\s+/g, ' ').trim()).slice(0, 300).join('');
      this.#note(`kanban card on ${action.messageId}: ${answer}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#note(`kanban card on ${action.messageId} failed: ${redactKnownSecrets(detail)}`);
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #keyFor(message: InboundMessage): BindingKey {
    return {
      channel: this.#deps.channelId,
      appId: message.appId,
      conversationId: message.chatId,
      // Never `root_id`. A reply to any message in the chat carries a root_id, so
      // keying on it would fork a session per reply chain.
      threadId: message.threadId,
    };
  }

  /**
   * Where replies to `message` go.
   *
   * Quoted only in a group at chat scope. A direct message is one conversation, so
   * quoting there is noise; a thread already says what it belongs to.
   */
  #targetFor(message: InboundMessage): SendTarget {
    const target = { chatId: message.chatId, threadId: message.threadId };
    if (message.chatType === 'group' && message.threadId === '') {
      return { ...target, replyTo: message.messageId };
    }
    return target;
  }

  /**
   * Whether a refusal is explained or met with silence.
   *
   * Silence for anything about *who* the sender is or *where* they are: replying
   * confirms the bot is present and listening to an audience that was not supposed
   * to have its attention. Explanations for refusals about *what* was asked --
   * those go to someone already allowed to talk, who needs to know why nothing
   * happened.
   */
  #shouldExplain(reason: RejectReason): boolean {
    return !SILENT_REASONS.has(reason);
  }

  /**
   * Record a refusal in the log when there is a log to record it in.
   *
   * Bounded to sessions that already exist: creating one so a rejection has
   * somewhere to live would let an unauthorized sender allocate sessions, which is
   * a denial-of-service with extra steps.
   */
  #recordRejection(
    key: BindingKey,
    message: InboundMessage,
    reason: RejectReason,
    detail: string,
  ): void {
    const binding = resolveBinding(this.#deps.db, key);
    if (binding === undefined) {
      // The sender's open_id, because without it this line cannot be acted on: the
      // first-run failure is an owner id that does not match, and the id needed to
      // fix it is the one being refused. It is the same field the event payload
      // below records, and metadata rather than content either way.
      this.#note(
        `rejected ${message.messageId} from ${message.sender.openId} ` +
          `in ${key.conversationId} (${reason}) with no bound session`,
      );
      return;
    }
    appendEvent(
      this.#deps.db,
      binding.sessionId,
      {
        type: 'policy_rejected',
        actor: 'policy',
        payload: {
          reason,
          detail,
          messageId: message.messageId,
          // open_id only. The message body is not recorded: a rejected message was
          // never accepted, and storing its contents would keep exactly the data we
          // just declined to act on.
          sender: message.sender.openId,
        },
      },
      this.#clock.now(),
    );
  }

  async #reply(
    target: SendTarget,
    message: InboundMessage,
    purpose: string,
    text: string,
  ): Promise<void> {
    try {
      await this.#deps.channel.sendText(
        target,
        truncate(text, 4000),
        replyUuid(this.#deps.appId, message.messageId, purpose),
      );
    } catch (err) {
      // A failed reply is not worth failing the message over: the interesting
      // outcome already happened, or already didn't.
      this.#note(`reply (${purpose}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The reaction that means "accepted, working on it".
 *
 * A Feishu `emoji_type`. Held for the length of the turn and removed at its
 * terminal, so a reaction that is still there means the turn is still open.
 */
export const ACK_EMOJI = 'Typing';

/** The paths the agent will actually be given. */
function pathsOf(message: InboundMessage): string[] {
  return message.attachments
    .map((a) => a.localPath)
    .filter((p): p is string => typeof p === 'string' && p !== '');
}

function describeSkipped(attachments: readonly InboundAttachment[]): string {
  const lines = attachments.map((a) => {
    const name = forDisplay(a.name ?? a.kind);
    const why = a.skipped === 'too_large' ? 'too large to fetch' : 'could not be downloaded';
    return `• ${name}: ${why}`;
  });
  return `The agent will not see ${attachments.length === 1 ? 'this file' : 'these files'}:\n${lines.join('\n')}`;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const raw = value[field];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/** How each way a turn reached its provider session reads in `/status`. */
const CONTINUITY: ReadonlyMap<unknown, string> = new Map([
  ['resumed', 'the last turn resumed it'],
  ['replayed', 'the last turn replayed the conversation into it'],
  ['fresh', 'the last turn started it'],
]);

/**
 * `/status`'s line for the provider session the last turn ran in, from its
 * `provider_session_observed` event; nothing when no turn has reported one. "The
 * last turn" is the last turn that reported one: a turn that reports nothing --
 * a resumed run that printed no event, or an ACP turn -- leaves the line as the
 * turn before it left it. The
 * id is no secret (plan E): it names a session in the agent's own store on this
 * host, which only this host's user can read. Shown only when it is an id a
 * driver would pass back (`isResumableProviderId`), so nothing in it can break
 * the line, and an old `cli:` runtime id is not taken for a provider session.
 */
export function continuityLine(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const { providerSessionId: id, mode } = payload as { providerSessionId?: unknown; mode?: unknown };
  if (!isResumableProviderId(id)) return '';
  // A Map, so no inherited key (`constructor`, `__proto__`) can read as a mode.
  const how = CONTINUITY.get(mode);
  return `\nprovider session \`${id}\`${how === undefined ? '' : `: ${how}`}`;
}
