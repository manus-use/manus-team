import { forDisplay } from '../channel/escape.js';
import type { BindingKey, InboundMessage, Principal, Tier } from '../types.js';
import { isPerson, parseKanban, type KanbanCommand, type LaterVerb, type NewTaskCommand } from './chat-parse.js';
import { label, renderGates, renderHelp, renderList, renderShow } from './chat-render.js';
import type { KanbanService } from './service.js';
import type { Refusal, RunRow } from './types.js';
import { WORKER_LIMITS } from './worker.js';

/**
 * `/kanban` in chat (spec §9.1): a parsed command, checked against the sender's
 * tier, done through `KanbanService` and nothing else, and answered as text the
 * router sends. It never touches the chat's session, so a busy session never
 * refuses it: it is control-plane, like `/status`.
 *
 * A person is recorded as `lark:<union_id>` (spec §3.1), the identity the board
 * knows people by; a sender whose union_id is unknown can read the board but not
 * change it. Until plan D2 the board gives work only to roles, so naming a
 * person is refused here, and the commands for people's own tasks are answered
 * with when they arrive -- "in a later update", in words a person in chat knows.
 *
 * Anyone at talk tier may comment, and everyone sees comments in `/kanban show`;
 * only an operator's may steer the task's agent (spec §9.1, §7.5).
 */

export interface KanbanChatDeps {
  service: KanbanService;
  /** The sender's tier, as the router's authorizer decides it. */
  hasTier(principal: Principal, tier: Tier): boolean;
  /** After a change that can make a task claimable: the dispatcher's pass. */
  changed?: () => void;
  /** After a change that decided an agent run: the dispatcher cancels its turn and closes it. */
  cancel?: (runId: string) => void;
}

/** Who may run each command (spec §9.1, §10). */
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
  later: 'talk',
};

/** The board's principal for a chat sender: `lark:<union_id>`, or undefined when Lark gave none. */
export function principalOf(sender: Principal): string | undefined {
  return sender.unionId === null || sender.unionId === '' ? undefined : `lark:${sender.unionId}`;
}

const PEOPLE_LATER =
  'Assigning a task to a person, or naming one as its reviewer, arrives in a later update. For now a task is given to a role: name it as a bare word, such as `implementer`.';

function later(name: LaterVerb): string {
  return (
    `\`/kanban ${name}\` is for a person's own task, and arrives in a later update, with people as assignees and reviewers. ` +
    'For now tasks go to roles, whose agents report for themselves.'
  );
}

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

/** A refusal, in words for chat: the board's message, escaped, with what D2 brings where that is the reason. */
function refused(r: Refusal): string {
  if (r.code === 'supervised_role') {
    return (
      `${forDisplay(r.message.replace(/;.*$/, ''))}; its approval requests cannot be forwarded to a chat yet. ` +
      'That arrives in a later update.'
    );
  }
  if (r.code === 'person_not_assignable') return PEOPLE_LATER;
  // One line: a refusal can quote what the sender typed, a name or a command.
  return `Not done: ${label(r.message, 600)}`;
}

/** The board's own ids are code; anything else the sender typed is escaped like any text. */
function id(taskId: string): string {
  return /^[kr]_[0-9a-z]+$/.test(taskId) ? `\`${taskId}\`` : forDisplay(taskId);
}

export class KanbanChat {
  readonly #deps: KanbanChatDeps;

  constructor(deps: KanbanChatDeps) {
    this.#deps = deps;
  }

  /** Run `/kanban <arg>` from this message, bound at `key`; the reply to send. */
  async run(arg: string, message: InboundMessage, key: BindingKey): Promise<string> {
    const parsed = parseKanban(arg);
    if (!parsed.ok) return parsed.usage;
    const command = parsed.command;
    const tier = TIERS[command.verb];
    if (tier === 'operate' && !this.#deps.hasTier(message.sender, 'operate')) {
      return `\`/kanban ${command.verb}\` changes the board, and needs operator permission.`;
    }
    switch (command.verb) {
      case 'help':
        return renderHelp();
      case 'later':
        return later(command.name);
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
    if (by === undefined) {
      return 'Lark did not say who you are (no union_id came with the message), and the board records who changes it. Ask the operator to check the app can read user ids.';
    }
    // A change is made, then its reply rendered. Should the render throw after the
    // change succeeded, the router answers that the board could not do it: the
    // change stands though the reply says it was not done, and `/kanban show` tells.
    return this.#change(command, by, message, key);
  }

  #change(command: KanbanCommand, by: string, message: InboundMessage, key: BindingKey): string {
    const service = this.#deps.service;
    switch (command.verb) {
      case 'new':
        return this.#create(command, by, message, key);
      case 'assign': {
        if (isPerson(command.assignee)) return PEOPLE_LATER;
        const now = service.show(command.taskId);
        const current = now.ok ? now.view.task.assignee : null;
        if (current?.kind === 'role' && current.name === command.assignee) {
          return `${id(command.taskId)} is already assigned to role ${forDisplay(command.assignee)}.`;
        }
        const r = service.assign(command.taskId, command.assignee, by);
        if (!r.ok) return refused(r);
        this.#decided(r.run);
        this.#changed();
        return `${id(command.taskId)} is now for role ${forDisplay(command.assignee)}${r.run === undefined ? '' : `; its run ${id(r.run.runId)} was ${forDisplay(r.run.outcome ?? 'ended')}`}.`;
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
        // Only an operator's comment may steer the task's agent; anyone's is shown to people (spec §9.1).
        const steers = this.#deps.hasTier(message.sender, 'operate');
        const r = service.comment(command.taskId, command.text, by, { steers });
        if (!r.ok) return refused(r);
        return steers
          ? `Comment added to ${id(command.taskId)}. An agent working on it gets it when its current turn ends; otherwise the next run reads it.`
          : `Comment added to ${id(command.taskId)}, for people: \`/kanban show\` shows it. Only an operator's comment is given to the task's agent.`;
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
      default:
        return renderHelp();
    }
  }

  /**
   * `/kanban new` (spec §9.1): created from this chat, which is subscribed to it.
   * The message id is the idempotency key, so a redelivery that got past the
   * router's own dedup still makes one task.
   */
  #create(command: NewTaskCommand, by: string, message: InboundMessage, key: BindingKey): string {
    for (const name of [command.assignee, command.reviewer]) {
      if (name !== undefined && isPerson(name)) return PEOPLE_LATER;
    }
    const tooBig = oversized(command);
    if (tooBig !== undefined) return tooBig;
    const r = this.#deps.service.create({
      title: command.title,
      ...(command.body === '' ? {} : { body: command.body }),
      contract: command.contract,
      ...(command.assignee === undefined ? {} : { assignee: command.assignee }),
      ...(command.reviewer === undefined ? {} : { reviewer: command.reviewer }),
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
        ? `nobody yet: \`/kanban assign ${task.taskId} <role>\` gives it to a role`
        : `role ${forDisplay(task.assignee.name)}`;
    return (
      `Created ${id(task.taskId)} — **${label(task.title)}**, for ${whom}` +
      `${task.workspace === null ? '' : `, in ${label(task.workspace)}`}. ` +
      'This chat hears when it is done, needs review, blocks, is retried after a failure, gives up or is stranded.'
    );
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
