import { timingSafeEqual } from 'node:crypto';
import { forDisplay } from '../channel/escape.js';
import type { CardView } from '../channel/types.js';
import { boardCardNonce } from '../core/ids.js';
import type { InboundCardAction } from '../core/router.js';
import type { BindingKey, InboundMention, InboundMessage, Principal, Tier } from '../types.js';
import { isPerson, parseKanban, type KanbanCommand, type NewTaskCommand, type ReportCommand, type ReviewCommand } from './chat-parse.js';
import {
  label,
  renderCardOutcome,
  renderGateFailure,
  renderGates,
  renderHelp,
  renderList,
  renderReviewCard,
  renderShow,
  renderTaskCard,
  type CardFacts,
} from './chat-render.js';
import { redactKnownSecrets } from '../secrets.js';
import { personPrincipal, type PeopleDirectory } from './people.js';
import type { KanbanService } from './service.js';
import type { Assignee, PersonReportsAs, Refusal, Reporter, RunRow, TaskRow } from './types.js';
import { WORKER_LIMITS } from './worker.js';

/**
 * `/kanban` in chat (spec §9.1): a parsed command, checked against the sender's
 * tier, done through `KanbanService` and nothing else, and answered as text the
 * router sends. It never touches the chat's session, so a busy session never
 * refuses it: it is control-plane, like `/status`.
 *
 * A person is recorded as `lark:<union_id>` (spec §3.1), the identity the board
 * knows people by; a sender whose union_id is unknown can read the board but not
 * change it. A person is named by @-mention: the message carries the mentioned
 * people's ids, so there is no name to resolve or confuse. Each sender, and each
 * person a command mentions, is noted in the people directory, which is how a
 * person named later by principal alone is checked for talk tier (spec §4.2).
 *
 * Anyone at talk tier may comment, and everyone sees comments in `/kanban show`;
 * only an operator's, or the task's named assignee's or reviewer's, may steer
 * its agent (spec §9.1, §7.5). A named assignee reports on their own task, and a
 * named reviewer answers its review, with talk tier: being named is the
 * authorization. An operator may answer any review.
 *
 * The buttons of a person's cards (spec §9.2) arrive here too, from the router,
 * which dispatches on the card's `kind`: who pressed comes from the callback's
 * operator, never from the payload, and the action is re-checked against the
 * card's run inside the board's transaction.
 */

export interface KanbanChatDeps {
  service: KanbanService;
  /** The sender's tier, as the router's authorizer decides it. */
  hasTier(principal: Principal, tier: Tier): boolean;
  /** Who the gateway has seen: each sender, mention and card presser is noted here. */
  people: PeopleDirectory;
  /** This bot: a card's nonce is bound to it. */
  appId: string;
  /** Redraw a card once acted on, so its buttons stop working: the Lark adapter's. */
  redraw?: (messageId: string, view: CardView) => Promise<void>;
  /** Metadata, masked: a press whose work in the background failed. */
  note?: (line: string) => void;
  /** How long a redraw is waited for; `REDRAW_MS` unless a test says otherwise. */
  redrawTimeoutMs?: number;
  /** After a change that can make a task claimable: the dispatcher's pass. */
  changed?: () => void;
  /** After a change that decided an agent run: the dispatcher cancels its turn and closes it. */
  cancel?: (runId: string) => void;
}

/** Who may run each command (spec §9.1, §10); a person's own reports check who is named, below. */
const TIERS: Readonly<Record<KanbanCommand['verb'], Tier>> = {
  help: 'talk',
  new: 'operate',
  list: 'talk',
  show: 'talk',
  assign: 'operate',
  link: 'operate',
  workspace: 'operate',
  comment: 'talk',
  unblock: 'operate',
  stop: 'operate',
  archive: 'operate',
  'gate add': 'operate',
  'gate list': 'talk',
  'gate remove': 'operate',
  done: 'talk',
  block: 'talk',
  review: 'talk',
  approve: 'talk',
  changes: 'talk',
};

/** The board's principal for a chat sender: `lark:<union_id>`, or undefined when Lark gave none. */
export function principalOf(sender: Principal): string | undefined {
  return sender.unionId === null || sender.unionId === '' ? undefined : `lark:${sender.unionId}`;
}

const NO_UNION_ID =
  'Lark did not say who you are (no union_id came with the message), and the board records who changes it. Ask the operator to check the app can read user ids.';

/**
 * What `/kanban new` may hold: the limits a worker's `mt kanban create` has
 * (C3's `WORKER_LIMITS`), so a task is the same size whoever made it.
 */
function oversized(command: NewTaskCommand): string | undefined {
  const size = (text: string) => Buffer.byteLength(text, 'utf8');
  if (size(command.title) > WORKER_LIMITS.title) {
    return `A title is at most ${WORKER_LIMITS.title} bytes; put the rest in the body.`;
  }
  if (size(command.body) > WORKER_LIMITS.body) return `A body is at most ${WORKER_LIMITS.body} bytes.`;
  for (const [field, value] of Object.entries(command.contract)) {
    if (value !== undefined && size(value) > WORKER_LIMITS.contractField) {
      return `The contract's ${forDisplay(field)} is at most ${WORKER_LIMITS.contractField} bytes.`;
    }
  }
  return undefined;
}

/** A refusal, in words for chat: the board's message, on one line, since it can quote what the sender typed. */
function refused(r: Refusal): string {
  if (r.code === 'gate_failed' && r.gate !== undefined) return renderGateFailure(r.gate);
  return `Not done: ${label(r.message, 600)}`;
}

/** A refusal as a card's note, which heads it "Not done." itself: said once. */
function cardNote(r: Refusal): string {
  const why = refused(r).replace(/^Not done: /, '');
  return why.charAt(0).toUpperCase() + why.slice(1);
}

/** The board's own ids are code; anything else the sender typed is escaped like any text. */
function id(taskId: string): string {
  return /^[kr]_[0-9a-z]+$/.test(taskId) ? `\`${taskId}\`` : forDisplay(taskId);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function field(value: Record<string, unknown>, name: string): string | undefined {
  const raw = value[name];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

function seen(p: Principal | InboundMention): { openId: string | null; unionId: string | null; name: string | null } {
  return 'key' in p
    ? { openId: p.openId, unionId: p.unionId, name: p.name }
    : { openId: p.openId, unionId: p.unionId, name: p.displayName };
}

/** Whether this principal is the person named here. */
function isNamed(a: Assignee | null, principal: string): boolean {
  return a?.kind === 'human' && a.name === principal;
}

type Named = { ok: true; name: string } | { ok: false; reply: string };

/** The longest a card's redraw is waited for. */
export const REDRAW_MS = 10_000;

function outOfDate(taskId: string): string {
  return `That card is out of date: ${id(taskId)} has moved on. \`/kanban show ${taskId}\` says where it is.`;
}

/** A press being acted on: the card's message, its run, and the attempt its redraw gets. */
interface Press {
  messageId: string;
  run: RunRow;
  attempt: number;
}

export class KanbanChat {
  readonly #deps: KanbanChatDeps;
  /** Presses being worked on in the background. */
  readonly #pending = new Set<Promise<void>>();
  /** The cards a press is being worked on for, by message: a second press waits for the first. */
  readonly #busy = new Set<string>();
  /** Aborted when the gateway stops: a report's gates are killed, and nothing is applied (spec §7.7). */
  readonly #stopping = new AbortController();

  constructor(deps: KanbanChatDeps) {
    this.#deps = deps;
  }

  #note(line: string): void {
    try {
      this.#deps.note?.(line);
    } catch {
      // Nowhere left to say it.
    }
  }

  /** Run `/kanban <arg>` from this message, bound at `key`; the reply to send. */
  async run(arg: string, message: InboundMessage, key: BindingKey): Promise<string> {
    const parsed = parseKanban(arg);
    if (!parsed.ok) return parsed.usage;
    const command = parsed.command;
    // Noted first: an @-mention in this very command is checked for talk tier through it.
    this.#deps.people.saw(seen(message.sender));
    for (const m of message.mentions ?? []) this.#deps.people.saw(seen(m));
    const tier = TIERS[command.verb];
    if (tier === 'operate' && !this.#deps.hasTier(message.sender, 'operate')) {
      return `\`/kanban ${command.verb}\` changes the board, and needs operator permission.`;
    }
    switch (command.verb) {
      case 'help':
        return renderHelp();
      case 'list':
        return renderList(this.#deps.service.list(), command.filter);
      case 'show': {
        const r = this.#deps.service.show(command.taskId);
        if (!r.ok) return refused(r);
        const gates = this.#deps.service.listGates(command.taskId);
        return renderShow(r.view, gates.ok ? gates.gates : []);
      }
      case 'gate list': {
        const r = this.#deps.service.listGates(command.taskId);
        return r.ok ? renderGates(command.taskId, r.gates) : refused(r);
      }
      default:
        break;
    }
    // Everything below records who acted.
    const by = principalOf(message.sender);
    if (by === undefined) return NO_UNION_ID;
    // A change is made, then its reply rendered. Should the render throw after the
    // change succeeded, the router answers that the board could not do it: the
    // change stands though the reply says it was not done, and `/kanban show` tells.
    return this.#change(command, by, message, key);
  }

  async #change(command: KanbanCommand, by: string, message: InboundMessage, key: BindingKey): Promise<string> {
    const service = this.#deps.service;
    switch (command.verb) {
      case 'new':
        return this.#create(command, by, message, key);
      case 'assign': {
        const named = this.#named(command.assignee, message);
        if (!named.ok) return named.reply;
        const now = service.show(command.taskId);
        const current = now.ok ? now.view.task.assignee : null;
        if (current !== null && current.name === named.name) {
          return `${id(command.taskId)} is already assigned to ${this.#whom(current)}.`;
        }
        const r = service.assign(command.taskId, named.name, by);
        if (!r.ok) return refused(r);
        this.#decided(r.run);
        this.#changed();
        const whom = r.task.assignee === null ? 'nobody' : this.#whom(r.task.assignee);
        return `${id(command.taskId)} is now for ${whom}${r.run === undefined ? '' : `; its run ${id(r.run.runId)} was ${forDisplay(r.run.outcome ?? 'ended')}`}.`;
      }
      case 'link': {
        const r = service.link(command.parentId, command.childId, by);
        if (!r.ok) return refused(r);
        return r.added
          ? `${id(command.childId)} now waits for ${id(command.parentId)}.`
          : `${id(command.childId)} already waits for ${id(command.parentId)}.`;
      }
      case 'workspace': {
        const r = service.setWorkspace(command.taskId, command.workspace, by);
        if (!r.ok) return refused(r);
        this.#changed();
        return `${id(command.taskId)} works in ${label(command.workspace)}.`;
      }
      case 'comment': {
        // An operator's comment, and the named assignee's or reviewer's, may steer the
        // task's agent; anyone's is shown to people (spec §9.1, §7.5).
        const shown = service.show(command.taskId);
        const named = shown.ok && (isNamed(shown.view.task.assignee, by) || isNamed(shown.view.task.reviewer, by));
        const steers = named || this.#deps.hasTier(message.sender, 'operate');
        const r = service.comment(command.taskId, command.text, by, { steers });
        if (!r.ok) return refused(r);
        return steers
          ? `Comment added to ${id(command.taskId)}. An agent working on it gets it when its current turn ends; otherwise the next run reads it.`
          : `Comment added to ${id(command.taskId)}, for people: \`/kanban show\` shows it. Only an operator's comment, or its assignee's or reviewer's, is given to the task's agent.`;
      }
      case 'unblock': {
        const r = service.unblock(command.taskId, by, command.comment);
        if (!r.ok) return refused(r);
        this.#changed();
        return `${id(command.taskId)} is unblocked, back to ${r.task.phase}.`;
      }
      case 'stop': {
        const r = service.stop(command.taskId, by);
        if (!r.ok) return refused(r);
        this.#decided(r.run);
        this.#changed();
        return r.run.outcome === 'cancelled'
          ? `Stopped ${id(command.taskId)}: its run was cancelled, and the task is blocked (needs\\_input). \`/kanban unblock ${command.taskId}\` runs it again.`
          : `${id(command.taskId)}'s run had already reported (${forDisplay(r.run.outcome ?? 'undecided')}); it is being closed, and the task keeps that outcome.`;
      }
      case 'archive': {
        const r = service.archive(command.taskId, by);
        if (!r.ok) return refused(r);
        this.#decided(r.run);
        this.#changed();
        return `Archived ${id(command.taskId)}.`;
      }
      case 'gate add': {
        const r = service.addGate(
          command.taskId,
          { command: command.command, ...(command.timeoutS === undefined ? {} : { timeoutS: command.timeoutS }) },
          by,
        );
        if (!r.ok) return refused(r);
        return `Gate ${r.gate.id} added to ${id(command.taskId)} (${r.gate.timeoutS} s): ${label(r.gate.command, 600)}`;
      }
      case 'gate remove': {
        const r = service.removeGate(command.taskId, command.gateId, by);
        if (!r.ok) return refused(r);
        return `Gate ${r.gate.id} removed from ${id(command.taskId)}: ${label(r.gate.command, 600)}`;
      }
      case 'done':
      case 'block':
      case 'approve':
      case 'changes':
        return this.#report(command, by, message.sender);
      case 'review':
        return this.#review(command, by, message);
      default:
        return renderHelp();
    }
  }

  /**
   * A person's report on their own task (spec §9.1): `done` and `block` by its
   * assignee while the work is open, `approve` and `changes` by its reviewer, or an
   * operator, while it waits for review. The board decides the person's open run.
   */
  async #report(command: ReportCommand, by: string, sender: Principal): Promise<string> {
    const shown = this.#deps.service.show(command.taskId);
    if (!shown.ok) return refused(shown);
    const task = shown.view.task;
    const allowed = this.#mayReport(command.verb, task, by, sender);
    if (allowed !== undefined) return allowed;
    const as = command.verb === 'done' || command.verb === 'block' ? 'assignee' : this.#answersAs(task, by);
    const r = await this.#apply(command.verb, task.taskId, this.#reporter(by, as, shown.view.runs), command.text);
    if (!r.ok) return refused(r);
    this.#changed();
    return this.#reported(command.verb, task.taskId);
  }

  /** `/kanban review`: the assignee asks for same-task review (spec §5.3), of a reviewer named here or on the task. */
  async #review(command: ReviewCommand, by: string, message: InboundMessage): Promise<string> {
    const shown = this.#deps.service.show(command.taskId);
    if (!shown.ok) return refused(shown);
    const task = shown.view.task;
    const allowed = this.#mayReport('review', task, by, message.sender);
    if (allowed !== undefined) return allowed;
    let reviewer: string | undefined;
    if (command.reviewer !== undefined) {
      const named = this.#named(command.reviewer, message);
      if (!named.ok) return named.reply;
      reviewer = named.name;
    }
    const r = await this.#deps.service.requestReview(
      task.taskId,
      this.#reporter(by, 'assignee', shown.view.runs),
      { summary: command.summary, ...(reviewer === undefined ? {} : { reviewer }) },
      { signal: this.#stopping.signal },
    );
    if (!r.ok) {
      return r.code === 'no_reviewer'
        ? `Nobody is named to review ${id(task.taskId)}: add a line \`reviewer: <role or @person>\`.`
        : refused(r);
    }
    this.#changed();
    return `${id(task.taskId)} is waiting for review, by ${r.task.reviewer === null ? 'nobody' : this.#whom(r.task.reviewer)}.`;
  }

  /**
   * A person reporting as they type it, bound to what was checked: the task's open
   * run as it was then, or none, and what they report as. Should either change
   * while the report's gates run -- the task reassigned, a run opened, the review
   * given to someone else -- the board refuses the report rather than decide work
   * that is no longer theirs (spec §9.2's re-check, for a typed report too).
   */
  #reporter(by: string, as: PersonReportsAs, runs: readonly RunRow[]): Reporter {
    const open = runs.find((r) => r.endedAt === null);
    return { kind: 'person', principal: by, runId: open?.runId ?? null, as };
  }

  /** Who answers a review: its named reviewer, or else an operator (checked before this). */
  #answersAs(task: TaskRow, by: string): PersonReportsAs {
    return isNamed(task.reviewer, by) ? 'reviewer' : 'operator';
  }

  /** Undefined when this person may make this report on this task now; otherwise why not. */
  #mayReport(verb: ReportCommand['verb'] | 'review', task: TaskRow, by: string, sender: Principal): string | undefined {
    if (verb === 'approve' || verb === 'changes') {
      if (!isNamed(task.reviewer, by) && !this.#deps.hasTier(sender, 'operate')) {
        return `\`/kanban ${verb}\` answers a review, and is for ${id(task.taskId)}'s reviewer (${task.reviewer === null ? 'nobody' : this.#whom(task.reviewer)}) or an operator.`;
      }
      if (task.phase !== 'review') return `${id(task.taskId)} is not waiting for review: it is ${forDisplay(task.phase)}.`;
      return undefined;
    }
    if (!isNamed(task.assignee, by)) {
      return `\`/kanban ${verb}\` is for the person a task is assigned to; ${id(task.taskId)} is for ${task.assignee === null ? 'nobody' : this.#whom(task.assignee)}.`;
    }
    // Its assignee reports on the work; once it is in review, the reviewer answers.
    if (task.phase !== 'open') return `${id(task.taskId)} is ${forDisplay(task.phase)}: \`/kanban ${verb}\` reports on work being done.`;
    return undefined;
  }

  /** The report, through the board: on the person's open run, or the card's when `by` names one. */
  async #apply(
    verb: ReportCommand['verb'],
    taskId: string,
    by: Reporter,
    text: string,
  ): Promise<{ ok: true; task: TaskRow } | Refusal> {
    const service = this.#deps.service;
    switch (verb) {
      case 'done':
      case 'approve':
        return service.complete(taskId, by, { summary: text }, { signal: this.#stopping.signal });
      case 'block':
        // A person's block on their own task needs their input (spec §5.4).
        return service.block(taskId, by, { kind: 'needs_input', reason: text });
      case 'changes':
        return service.requestChanges(taskId, by, text);
    }
  }

  #reported(verb: ReportCommand['verb'], taskId: string): string {
    switch (verb) {
      case 'done':
        return `Done: ${id(taskId)} is complete.`;
      case 'approve':
        return `Approved: ${id(taskId)} is complete.`;
      case 'block':
        return `Blocked ${id(taskId)} (needs\\_input). An operator unblocks it with \`/kanban unblock ${taskId} [comment]\`.`;
      case 'changes':
        return `Changes requested on ${id(taskId)}: it goes back to its assignee, with your reason.`;
    }
  }

  /**
   * A press of one of a person's card's buttons (spec §9.2), or of a notice's
   * Unblock: the board's answer, which the router notes in the log -- the chat is
   * told nothing, and the card shows what happened. The nonce must match the task and what
   * the card was for; who pressed is the callback's operator; the run is
   * re-checked in the board's transaction.
   *
   * **Answered at once.** Lark waits about three seconds for a callback's answer,
   * and the SDK answers only once this returns, so a report -- whose gates may
   * run for minutes -- is made in the background: the card is redrawn as being
   * worked on, and then with what happened. `idle()` waits for that work.
   *
   * **A card refused stays pressable.** The SDK drops a press it has seen -- the
   * same card, presser and button value -- for twelve hours, whatever the box
   * held. So a press this person may make that is refused for what it carried --
   * an empty box, a gate, a busy workspace -- redraws the card live, saying why,
   * with buttons whose value carries the next attempt. A card acted on, or out of
   * date, is redrawn without buttons. A press by the wrong person, or one whose
   * payload does not match, changes nothing.
   */
  async card(action: InboundCardAction): Promise<string> {
    const v = action.value;
    const verb = field(v, 'act');
    const taskId = field(v, 'task');
    const nonce = field(v, 'nonce');
    const event = field(v, 'event');
    // What the card is for: its run, or for an Unblock, the event that blocked the task.
    const ref = verb === 'unblock' ? (event === undefined ? undefined : `event:${event}`) : field(v, 'run');
    if (verb === undefined || taskId === undefined || nonce === undefined || ref === undefined) {
      return 'That button is missing its payload.';
    }
    if (!constantTimeEqual(boardCardNonce(this.#deps.appId, taskId, ref), nonce)) {
      return 'That button does not match the card it is on.';
    }
    const presser = action.operator;
    if (!this.#deps.hasTier(presser, 'talk')) return 'You are not on the allowlist.';
    this.#deps.people.saw(seen(presser));
    const by = principalOf(presser);
    if (by === undefined) return NO_UNION_ID;
    if (verb === 'unblock') {
      if (!this.#deps.hasTier(presser, 'operate')) return 'Unblock changes the board, and needs operator permission.';
      const r = this.#deps.service.unblock(taskId, by, undefined, { blockedAt: Number(event) });
      if (!r.ok) {
        return r.code === 'stale' || r.code === 'illegal_transition'
          ? `${id(taskId)} is not blocked as that notice said any more: \`/kanban show ${taskId}\` says where it is.`
          : refused(r);
      }
      this.#changed();
      return `${id(taskId)} is unblocked, back to ${r.task.phase}.`;
    }
    if (verb !== 'done' && verb !== 'block' && verb !== 'approve' && verb !== 'changes') {
      return 'That button is not one the board knows.';
    }
    const shown = this.#deps.service.show(taskId);
    if (!shown.ok) return refused(shown);
    const { task } = shown.view;
    const run = shown.view.runs.find((r) => r.runId === ref);
    if (run === undefined) return 'That button is not for a run of this task.';
    const allowed = this.#mayPress(verb, run, by, presser);
    if (allowed !== undefined) return allowed;
    const tried = Number(field(v, 'try') ?? '0');
    const press: Press = { messageId: action.messageId, run, attempt: Number.isSafeInteger(tried) && tried >= 0 ? tried + 1 : 1 };
    // Redraws go in the background, each bounded: Lark waits about three seconds for this answer.
    if (run.endedAt !== null) {
      this.#track(this.#outOfDate(press, task).then(() => undefined));
      return outOfDate(task.taskId);
    }
    // A press while one is being worked on for this card would redraw over it.
    if (this.#busy.has(action.messageId)) return 'That card is being worked on: it shows the outcome when it is done.';
    const text = (action.input ?? '').trim();
    const empty =
      verb === 'block' && text === ''
        ? 'Type why it is blocked in the box, then press Block.'
        : verb === 'changes' && text === ''
          ? 'Type what needs changing in the box, then press Request changes.'
          : undefined;
    if (empty !== undefined) {
      this.#track(this.#redrawLive(press, empty));
      return empty;
    }
    const name = label(presser.displayName ?? by, 80);
    this.#busy.add(press.messageId);
    this.#track(this.#press(verb, press, by, name, text).finally(() => this.#busy.delete(press.messageId)));
    return `${{ done: 'Completing', block: 'Blocking', approve: 'Approving', changes: 'Asking for changes on' }[verb]} ${id(taskId)}: the card shows how it goes.`;
  }

  /**
   * The report a press asked for, in the background: the card redrawn as worked
   * on while the report is made -- never holding it back -- then with the outcome,
   * once the first redraw has settled or been given up on, so the outcome is
   * always drawn after it.
   */
  async #press(verb: ReportCommand['verb'], press: Press, by: string, name: string, text: string): Promise<void> {
    const shown = this.#deps.service.show(press.run.taskId);
    const task = shown.ok ? shown.view.task : { taskId: press.run.taskId, title: '' };
    const working = this.#redraw(press.messageId, renderCardOutcome(task, 'Working on it…'));
    let r: { ok: true; task: TaskRow } | Refusal;
    try {
      const as = verb === 'done' || verb === 'block' ? 'assignee' : press.run.assignee.name === by ? 'reviewer' : 'operator';
      r = await this.#apply(verb, press.run.taskId, { kind: 'person', principal: by, runId: press.run.runId, as }, text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#note(`kanban: a press on card ${press.messageId} failed: ${redactKnownSecrets(detail)}`);
      await working;
      await this.#redrawLive(press, `The board could not do that: ${label(detail, 600)}`);
      return;
    }
    await working;
    if (!r.ok) {
      if (r.code === 'run_superseded') await this.#outOfDate(press, task);
      else await this.#redrawLive(press, cardNote(r));
      return;
    }
    this.#changed();
    const outcome = {
      done: `Done — by ${name}.`,
      approve: `Approved — by ${name}.`,
      block: `Blocked — by ${name}: ${label(text, 300)}`,
      changes: `Changes requested — by ${name}: ${label(text, 300)}`,
    }[verb];
    await this.#redraw(press.messageId, renderCardOutcome(task, outcome));
  }

  /** A card for a run that is over: redrawn so, and said so. */
  async #outOfDate(press: Press, task: { taskId: string; title: string }): Promise<string> {
    await this.#redraw(press.messageId, renderCardOutcome(task, 'This card is out of date: the task has moved on since it was sent.'));
    return outOfDate(task.taskId);
  }

  /** The card redrawn as it was, from the board as it is, with why the press did nothing, and buttons of the next attempt. */
  async #redrawLive(press: Press, note: string): Promise<void> {
    const reading = this.#deps.service.cardReading(press.run.runId);
    if (reading === undefined) return;
    // A run that ended meanwhile -- typed, stopped, reassigned -- has no card to press again.
    if (reading.run.endedAt !== null) {
      await this.#outOfDate(press, reading.task);
      return;
    }
    const facts: CardFacts = {
      ...reading,
      attempt: press.attempt,
      note: `**Not done.** ${note}`,
      nameOf: (p) => this.#deps.people.nameOf(p),
    };
    const view = press.run.kind === 'review' ? renderReviewCard(facts, this.#deps.appId) : renderTaskCard(facts, this.#deps.appId);
    await this.#redraw(press.messageId, { ...view, markdown: redactKnownSecrets(view.markdown) });
  }

  /** Background work, tracked so `idle()` -- and the gateway's stop -- can wait for it. */
  #track(work: Promise<void>): void {
    const tracked = work.catch((err: unknown) => this.#note(`kanban: ${redactKnownSecrets(err instanceof Error ? err.message : String(err))}`));
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  /**
   * The gateway is stopping: the gates of a report being made -- from a press or
   * typed -- are killed, and nothing is applied, as the worker socket's are; the
   * next report after a restart runs them again.
   */
  stop(): void {
    this.#stopping.abort();
  }

  /** Once no press is being worked on, or `boundMs` has passed: true once drained. */
  async idle(boundMs?: number): Promise<boolean> {
    const drained = (async () => {
      while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
      return true;
    })();
    if (boundMs === undefined) return drained;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), boundMs);
    });
    try {
      return await Promise.race([drained, bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Undefined when this person may press this button of this run's card; otherwise why not. */
  #mayPress(verb: ReportCommand['verb'], run: RunRow, by: string, presser: Principal): string | undefined {
    // Only a person's run is sent a card; an agent's is decided by its agent.
    if (run.assignee.kind !== 'human') return "That button is not for a person's card.";
    const forWork = verb === 'done' || verb === 'block';
    if (forWork !== (run.kind === 'work')) return 'That button is not for this kind of card.';
    if (run.assignee.name === by) return undefined;
    if (!forWork && this.#deps.hasTier(presser, 'operate')) return undefined;
    return `This card is for ${this.#whom(run.assignee)}.`;
  }

  /**
   * Best effort: the board has the decision already, and the card is only a
   * picture of it. Bounded by `redrawTimeoutMs`: the SDK's card update has no
   * timeout of its own, and a redraw that never answered would hold the press
   * that waits for it -- and so its card, as being worked on -- until a restart.
   */
  async #redraw(messageId: string, view: CardView): Promise<void> {
    const redraw = this.#deps.redraw;
    if (redraw === undefined) return;
    const ms = this.#deps.redrawTimeoutMs ?? REDRAW_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), ms);
    });
    // A redraw that throws at once is a failed redraw, not a failed press.
    const sent = Promise.resolve().then(() => redraw(messageId, view));
    try {
      if ((await Promise.race([sent.then(() => 'drawn' as const), late])) === 'late') {
        this.#note(`kanban: redrawing card ${messageId} took longer than ${ms} ms; going on without it`);
      }
    } catch (err) {
      this.#note(`kanban: redrawing card ${messageId} failed: ${redactKnownSecrets(err instanceof Error ? err.message : String(err))}`);
    } finally {
      clearTimeout(timer);
      sent.catch(() => undefined);
    }
  }

  /**
   * `/kanban new` (spec §9.1): created from this chat, which is subscribed to it.
   * The message id is the idempotency key, so a redelivery that got past the
   * router's own dedup still makes one task.
   */
  #create(command: NewTaskCommand, by: string, message: InboundMessage, key: BindingKey): string {
    const named: { assignee?: string; reviewer?: string } = {};
    for (const role of ['assignee', 'reviewer'] as const) {
      const name = command[role];
      if (name === undefined) continue;
      const n = this.#named(name, message);
      if (!n.ok) return n.reply;
      named[role] = n.name;
    }
    const tooBig = oversized(command);
    if (tooBig !== undefined) return tooBig;
    const r = this.#deps.service.create({
      title: command.title,
      ...(command.body === '' ? {} : { body: command.body }),
      contract: command.contract,
      ...named,
      ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
      ...(command.parents.length === 0 ? {} : { parents: command.parents }),
      idempotencyKey: `lark:${message.messageId}`,
      createdBy: by,
      createdVia: {
        kind: 'chat',
        channel: key.channel,
        appId: key.appId,
        conversationId: key.conversationId,
        threadId: key.threadId,
      },
    });
    if (!r.ok) return refused(r);
    const { task } = r;
    if (r.existing) return `Already created, as ${id(task.taskId)}.`;
    this.#changed();
    const whom =
      task.assignee === null
        ? 'nobody yet: `/kanban assign ' + task.taskId + ' <role or @person>` gives it to someone'
        : this.#whom(task.assignee);
    const card =
      task.assignee?.kind === 'human' ? ' They are sent it as a card, in a direct message, once it is ready.' : '';
    return (
      `Created ${id(task.taskId)} — **${label(task.title)}**, for ${whom}` +
      `${task.workspace === null ? '' : `, in ${label(task.workspace)}`}.${card} ` +
      'This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.'
    );
  }

  /**
   * The principal a name in chat stands for: an @-mention, found among the
   * message's mentions by the name Lark's text shows, or a principal typed out.
   * A bare word is a role, as typed. A person without talk tier is refused here,
   * by the name typed (spec §4.2); the service refuses them too, for its other
   * callers.
   */
  #named(name: string, message: InboundMessage): Named {
    if (!isPerson(name)) return { ok: true, name };
    const found = this.#mentioned(name, message);
    if (!found.ok) return found;
    if (!this.#deps.people.canTalk(found.name)) {
      return {
        ok: false,
        reply: `${label(name, 80)} cannot be given work: being assigned lets a person report on the task, which needs talk tier, and the gateway does not know them to have it.`,
      };
    }
    return found;
  }

  /** A person's principal: typed out, or the @-mention's, by the ids Lark sent with the message. */
  #mentioned(name: string, message: InboundMessage): Named {
    if (!name.startsWith('@')) return { ok: true, name: `lark:${name.slice('lark:'.length)}` };
    const shown = name.slice(1).trim();
    const found = (message.mentions ?? []).filter((m) => m.name === shown || m.key === name);
    const unionIds = [...new Set(found.map((m) => m.unionId).filter((u): u is string => u !== null))];
    if (found.length === 0) {
      return {
        ok: false,
        reply: `${label(name, 80)} is not someone this message mentions: type @ and pick them, so Lark says who they are.`,
      };
    }
    if (unionIds.length === 0) {
      return {
        ok: false,
        reply: `Lark did not say who ${label(name, 80)} is (no union_id came with the mention). Ask the operator to check the app can read user ids.`,
      };
    }
    if (unionIds.length > 1) {
      return { ok: false, reply: `More than one person mentioned is called ${label(name, 80)}; say which with \`lark:<union_id>\`.` };
    }
    return { ok: true, name: personPrincipal(unionIds[0] ?? '') };
  }

  /** A role, as a role; a person, by the name Lark last gave, with their principal. */
  #whom(a: Assignee): string {
    if (a.kind === 'role') return `role ${forDisplay(a.name)}`;
    const name = this.#deps.people.nameOf(a.name);
    return name === undefined ? label(a.name, 80) : `${label(name, 80)} (${label(a.name, 80)})`;
  }

  /** An agent run the change decided: its turn is cancelled, and it closes when the turn ends. */
  #decided(run: RunRow | undefined): void {
    if (run === undefined || run.endedAt !== null || run.agentConfig === null) return;
    this.#tell(() => this.#deps.cancel?.(run.runId));
  }

  #changed(): void {
    this.#tell(() => this.#deps.changed?.());
  }

  /** The dispatcher is told, never relied on: its failure is not the command's. */
  #tell(fn: () => void): void {
    try {
      fn();
    } catch {
      // The sweep finds the work within a minute.
    }
  }
}
