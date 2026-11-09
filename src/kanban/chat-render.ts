import { forDisplay, forMarkdown } from '../channel/escape.js';
import type { CardButton, CardView } from '../channel/types.js';
import { boardCardNonce } from '../core/ids.js';
import type { BoardEntry, BoardSummary, ReviewRequest, TaskView } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import { LIST_FILTERS, USAGE } from './chat-parse.js';
import { describeReported } from './commit.js';
import type { DisplayStatus } from './status.js';
import { DEFAULT_BOARD, type Assignee, type FailedGate, type GateRow, type KanbanEvent, type RunRow, type TaskRow } from './types.js';

/**
 * What `/kanban` says in chat (spec §9.3), and the notices a subscription hears
 * (spec §9.4). Pure, given the secret set.
 *
 * All task text is untrusted -- an agent wrote some of it, and a body can be
 * pasted from anywhere. A body, a summary, a comment and an agent's output keep
 * their markdown through `forMarkdown`, which neutralizes Feishu's tags; titles,
 * names, reasons and errors go through `forDisplay`, which escapes everything.
 * A piece is masked and cut before it is escaped, so a cut cannot leave the
 * start of a secret showing, nor split an escape. Gate commands are shown
 * masked too: a secret may have become known after the gate was defined (spec
 * §7.7). The router masks each whole reply once more.
 */

/**
 * Control characters stripped and known secrets masked: the first thing done to
 * any piece, before it is reshaped -- spaces collapsed, trimmed, cut -- since a
 * reshaped secret no longer matches. Then a CRLF or a lone CR becomes a newline,
 * which `stripControl` keeps: a body from the worker CLI, a summary, an output or
 * a comment can hold one, and quoting splits lines on newlines only.
 */
function masked(text: string): string {
  return redactKnownSecrets(stripControl(text)).replace(/\r\n?/g, '\n');
}

const HIGH_SURROGATE = /[\uD800-\uDBFF]$/;
const LOW_SURROGATE = /^[\uDC00-\uDFFF]/;

/**
 * The first `max` UTF-16 units at most, with `marker` when anything was cut: cut
 * on a character boundary, so an emoji at the cut is dropped whole, not halved.
 */
function head(text: string, max: number, marker: string): string {
  if (text.length <= max) return text;
  const kept = text.slice(0, Math.max(0, max - marker.length));
  return kept.replace(HIGH_SURROGATE, '') + marker;
}

/** The last `max` UTF-16 units, cut on a character boundary as `head` is. */
function end(text: string, max: number): string {
  return text.slice(-max).replace(LOW_SURROGATE, '');
}

/** A label: masked, then one line, cut with a one-line marker, and every markdown character escaped. */
export function label(text: string, max = 200): string {
  return forDisplay(head(masked(text).replace(/\s+/g, ' ').trim(), max, '…'));
}

/**
 * Free text that keeps its markdown, quoted under its label so none of its lines
 * starts a heading or a list. A line opening a code fence -- three or more
 * backticks or tildes -- has its first one escaped, so the text cannot open or
 * close a fence around what follows it.
 */
function quoted(text: string): string {
  return forMarkdown(text)
    .split('\n')
    .map((line) => `> ${line.replace(/^(\s*)([`~]{3,})/, (_all, space: string, run: string) => `${space}\\${run}`)}`)
    .join('\n');
}

/** Free text from its start: masked, then cut to `max` characters, then quoted. */
function block(text: string, max: number): string {
  return quoted(head(masked(text).trim(), max, '\n… (truncated)'));
}

/**
 * Free text from its end, as an agent's output is read: masked whole first, so
 * the cut cannot leave part of a secret, then its last `max` characters, marked.
 */
function tail(text: string, max: number): string {
  const whole = masked(text).trim();
  return quoted(whole.length <= max ? whole : `… (earlier output cut)\n${end(whole, max).trimStart()}`);
}

function who(a: Assignee | null): string {
  if (a === null) return 'nobody';
  return a.kind === 'role' ? `role ${label(a.name)}` : label(a.name);
}

function id(taskId: string): string {
  return `\`${taskId}\``;
}

const LIST_MAX = 30;

/** The statuses `/kanban list` shows with no filter: everything someone may still act on. */
const ACTIVE: readonly DisplayStatus[] = ['running', 'reviewing', 'review', 'ready', 'todo', 'blocked'];

/** `/kanban help`: every command, with the tier it needs (spec §9.1). */
export function renderHelp(): string {
  const operate = 'operator';
  const talk = 'anyone allowed';
  const assignee = "the task's assignee";
  const reviewer = 'its reviewer, or an operator';
  const lines: Array<[string, string]> = [
    [USAGE.new, operate],
    [USAGE.list, talk],
    [USAGE.show, talk],
    [USAGE.assign, operate],
    [USAGE.link, operate],
    [USAGE.workspace, operate],
    [USAGE.comment, talk],
    [USAGE.unblock, operate],
    [USAGE.stop, operate],
    [USAGE.archive, operate],
    [USAGE['gate add'], operate],
    [USAGE['gate list'], talk],
    [USAGE['gate remove'], operate],
    [USAGE.done, assignee],
    [USAGE.block, assignee],
    [USAGE.review, assignee],
    [USAGE.approve, reviewer],
    [USAGE.changes, reviewer],
    [USAGE['board list'], talk],
    [USAGE['board create'], operate],
    [USAGE['board use'], operate],
    [USAGE['board set'], operate],
    [USAGE['board archive'], operate],
  ];
  return [
    '**The task board.** A task is any work -- research, a document, an operation in Lark, a chore, a change to code -- given to a role, whose agent runs it in a workspace, or to a person.',
    ...lines.map(([usage, tier]) => `\`${usage}\` (${tier})`),
    'Name a person with an @-mention: they are sent the task as a card in a direct message, with Done and Block, or a review with Approve and Request changes. A person named may comment on, and report on, their own task.',
    "A task with a `reviewer:` is reviewed before it is done: its assignee's done, or its agent's, goes to the reviewer. An operator may answer any review, ending a reviewer role's run.",
    'The chat a task is created in hears when it is done, needs review, blocks, is retried after a failure, gives up, or is stranded, and who a person was given it.',
    "A board is a queue of tasks of its own. Each chat is on one, `default` until `/kanban board use` moves it, and its `/kanban new` and `list` act on that board; a task's follow-ups and parents are on its board.",
  ].join('\n');
}

/**
 * `/kanban list` (spec §9.1): a board by derived status, the active tasks unless a
 * filter is given. A board other than `default` is named (spec §16).
 */
export function renderList(
  entries: readonly BoardEntry[],
  filter: DisplayStatus | 'all' | undefined,
  board: string = DEFAULT_BOARD,
): string {
  const on = board === DEFAULT_BOARD ? '' : ` on board ${label(board)}`;
  const shown = entries.filter((e) =>
    filter === undefined ? ACTIVE.includes(e.status) : filter === 'all' || e.status === filter,
  );
  if (shown.length === 0) {
    return filter === undefined
      ? `No open tasks${on}. \`/kanban list all\` shows done and archived ones too.`
      : `No ${filter === 'all' ? '' : `${filter} `}tasks${on}.`;
  }
  const ordered =
    filter === undefined ? ACTIVE.flatMap((status) => shown.filter((e) => e.status === status)) : [...shown];
  const lines = ordered
    .slice(0, LIST_MAX)
    .map((e) => `${id(e.task.taskId)} **${e.status}**: ${label(e.task.title, 120)} · ${who(e.task.assignee)}`);
  const more = ordered.length - LIST_MAX;
  if (more > 0) lines.push(`… and ${more} more. \`/kanban list <${LIST_FILTERS.join('|')}>\` narrows it.`);
  if (on !== '') lines.unshift(`Board **${label(board)}**:`);
  return lines.join('\n');
}

/** How many of a board's tasks are where, leaving out what is none. */
function counted(s: BoardSummary): string {
  const parts = (
    [
      [s.counts.open, 'open'],
      [s.counts.review, 'in review'],
      [s.counts.blocked, 'blocked'],
      [s.counts.done, 'done'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`);
  return parts.length === 0 ? 'no tasks' : parts.join(', ');
}

/**
 * `/kanban board list` (spec §16): each board, its tasks by phase, its own
 * max_running and workspace where it sets them, and which one this chat is on.
 */
export function renderBoards(summaries: readonly BoardSummary[], current: string): string {
  const lines = summaries.map((s) => {
    const b = s.board;
    const settings = [
      ...(b.maxRunning === null ? [] : [`max\\_running ${b.maxRunning}`]),
      ...(b.workspace === null ? [] : [`workspace ${label(b.workspace)}`]),
    ];
    const marks = [...(b.archivedAt === null ? [] : ['archived']), ...(b.name === current ? ['this chat'] : [])];
    return (
      `**${label(b.name)}**${marks.length === 0 ? '' : ` (${marks.join(', ')})`}: ${counted(s)}` +
      settings.map((x) => ` · ${x}`).join('')
    );
  });
  return [
    ...lines,
    `\`/kanban board use <name>\` moves this chat to another board; \`/kanban board create <name>\` makes one.`,
  ].join('\n');
}

function runLine(run: RunRow): string {
  const outcome = run.outcome === null ? (run.endedAt === null ? 'working' : 'undecided') : run.outcome;
  const head = `#${run.attempt} ${run.kind} · ${who(run.assignee)} · ${forDisplay(outcome)}`;
  const said = run.summary ?? run.error;
  return said === null || said === '' ? head : `${head}: ${label(said, 300)}`;
}

/**
 * `/kanban show` (spec §9.1): the task, its contract, gates, runs, latest output
 * and comments. Its board is named once anything is on a board but `default`:
 * the task's, or the chat's it is shown in (spec §16).
 */
export function renderShow(view: TaskView, gates: readonly GateRow[], chatBoard: string = DEFAULT_BOARD): string {
  const { task } = view;
  const board = task.board === DEFAULT_BOARD && chatBoard === DEFAULT_BOARD ? '' : ` · board: ${label(task.board)}`;
  const out: string[] = [
    `**${label(task.title)}** ${id(task.taskId)}: ${view.status}`,
    `assignee: ${who(task.assignee)} · reviewer: ${who(task.reviewer)} · workspace: ${task.workspace === null ? 'not yet fixed' : label(task.workspace)}${board}`,
  ];
  if (task.phase === 'blocked' && task.blockKind !== null) {
    out.push(`blocked (${forDisplay(task.blockKind)}): ${label(task.blockReason ?? '', 500)}`);
  }
  if (view.parents.length > 0) {
    out.push(`parents: ${view.parents.map((p) => `${id(p.taskId)} (${p.phase})`).join(', ')}`);
  }
  if (view.children.length > 0) {
    out.push(`children: ${view.children.map((c) => `${id(c.taskId)} (${c.phase})`).join(', ')}`);
  }
  if (task.body.trim() !== '') out.push(block(task.body, 1500));
  const contract = Object.entries(task.contract).filter(([, v]) => v !== undefined && v.trim() !== '');
  if (contract.length > 0) {
    out.push('**Contract**');
    for (const [field, value] of contract) out.push(`${forDisplay(field)}: ${label(value ?? '', 400)}`);
  }
  if (gates.length > 0) {
    out.push('**Gates**');
    for (const g of gates) out.push(`${g.id}. ${label(g.command, 300)} (${g.timeoutS} s)`);
  }
  if (view.runs.length > 0) {
    out.push('**Runs**');
    for (const run of view.runs.slice(-5)) out.push(runLine(run));
    const last = view.runs.at(-1);
    const output = last?.lastOutput ?? null;
    if (output !== null && output.trim() !== '') out.push('Latest output:', tail(output, 800));
  }
  if (view.comments.length > 0) {
    const shown = view.comments.slice(-5);
    out.push(`**Comments** (${shown.length} of ${view.comments.length})`);
    for (const c of shown) out.push(`${label(c.author, 80)}:`, block(c.body, 400));
  }
  return out.join('\n');
}

/** `/kanban gate list` (spec §7.7): each gate's command masked, with its timeout and who defined it. */
export function renderGates(taskId: string, gates: readonly GateRow[]): string {
  if (gates.length === 0) return `Task ${id(taskId)} has no gates.`;
  return [
    `Gates of ${id(taskId)}, run in this order before it may complete or go to review:`,
    ...gates.map((g) => `${g.id}. ${label(g.command, 600)} (${g.timeoutS} s, by ${label(g.createdBy, 80)})`),
  ].join('\n');
}

/**
 * A person's report refused by a gate (spec §7.7): the gate, how it ended, and
 * the end of its output, masked whole before it is cut, as a run's output is.
 */
export function renderGateFailure(gate: FailedGate): string {
  const how = gate.timedOut
    ? 'ran past its timeout'
    : gate.exitCode !== null
      ? `exited ${gate.exitCode}`
      : gate.signal === null
        ? 'could not start'
        : `was ended by ${forDisplay(gate.signal)}`;
  const head = `Not done: the gate ${label(gate.command, 300)} ${how}, so the report was not applied. Fix it, then report again.`;
  return gate.output.trim() === '' ? head : `${head}\nIts output:\n${tail(gate.output, 1500)}`;
}

/**
 * The outcomes a retry follows that are failures to tell a subscriber of (spec
 * §9.4). Not `interrupted`: a run the gateway's restart ended is retried quietly,
 * as the task did nothing wrong.
 */
const RETRIED: ReadonlySet<string> = new Set(['failed', 'crashed', 'timed_out', 'protocol_violation']);

function text(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

function blockedLine(task: TaskRow, kind: string, reason: string, recurrences: number, limit: number): string {
  const head = `**${label(task.title)}** ${id(task.taskId)} is blocked (${forDisplay(kind)}): ${label(reason, 800)}`;
  if (recurrences >= limit) {
    return (
      `${head}\nIt keeps blocking for the same reason (${recurrences} times after an unblock); ` +
      'rewrite the task, or archive it and create a clearer one, rather than unblocking it again.'
    );
  }
  return `${head}\n\`/kanban unblock ${task.taskId} [comment]\` once it can go on.`;
}

/** Who a principal is, by name, where the gateway knows one: what a notice or a card calls a person. */
export type NameOf = (principal: string) => string | undefined;

/** Who stopped a task: a person by the name Lark last gave, else as the event recorded them. */
function stopper(actor: string, nameOf: NameOf | undefined): string {
  return actor.startsWith('lark:') ? (nameOf?.(actor) ?? actor) : actor;
}

/** A person, by the name Lark gave, else their principal; a role, as a role. */
function whom(a: Assignee | null, nameOf: NameOf | undefined): string {
  if (a?.kind !== 'human') return who(a);
  return label(nameOf?.(a.name) ?? a.name, 80);
}

function payloadOf(event: KanbanEvent): Record<string, unknown> {
  return (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
}

/**
 * Whether the event left the task blocked, so that its notice offers Unblock
 * (spec §9.2): a block of any kind but dependency, a stop, or a run whose end
 * blocked the task.
 */
export function blocksTask(event: KanbanEvent): boolean {
  const p = payloadOf(event);
  if (event.kind === 'blocked') return text(p, 'kind') !== '' && text(p, 'kind') !== 'dependency';
  if (event.kind === 'stopped') return true;
  return event.kind === 'run_ended' && p['next'] === 'blocked';
}

/**
 * The notice a subscription hears of one event (spec §9.4), or undefined when
 * the event is none: completed, review requested, blocked with its kind and
 * reason, retrying after a failure, gave up, stranded. A dependency block is not
 * one, since nobody needs to act; a throttled run's cooldown is not either, as it
 * clears by itself, and blocks as transient at its limit, which is one. For
 * people: the one line that says who a person's claim gave the task to (spec
 * §9.2), named in plain text, never mentioned, and a card that could not be sent.
 */
export function renderNotice(
  event: KanbanEvent,
  task: TaskRow,
  opts: { blockRecurrenceLimit: number; nameOf?: NameOf },
): string | undefined {
  const p = payloadOf(event);
  const name = `**${label(task.title)}** ${id(task.taskId)}`;
  // As the event recorded it, not as the task is now: a notice delivered late tells what was true then.
  const recurrences = typeof p['blockRecurrences'] === 'number' ? p['blockRecurrences'] : 0;
  switch (event.kind) {
    case 'completed': {
      const summary = text(p, 'summary');
      return summary.trim() === '' ? `Done: ${name}.` : `Done: ${name}\n${block(summary, 1200)}`;
    }
    case 'review_requested': {
      const reviewer = text(p, 'reviewer');
      const kind = p['reviewerKind'] === 'human' ? 'human' : 'role';
      return `Review requested for ${name}, from ${whom(reviewer === '' ? null : { kind, name: reviewer }, opts.nameOf)}.`;
    }
    case 'claimed': {
      // A role's claim is no notice: its outcome is. A person's is the group's one line.
      if (p['assigneeKind'] !== 'human') return undefined;
      const person = whom({ kind: 'human', name: text(p, 'assignee') }, opts.nameOf);
      return `📋 ${name}, ${p['kind'] === 'review' ? 'review ' : ''}assigned to ${person}`;
    }
    case 'card_failed': {
      const person = whom({ kind: 'human', name: text(p, 'to') }, opts.nameOf);
      const how =
        p['kind'] === 'review'
          ? `\`/kanban approve ${task.taskId}\` or \`/kanban changes ${task.taskId} <reason>\``
          : `\`/kanban done ${task.taskId} [summary]\` or \`/kanban block ${task.taskId} <reason>\``;
      return (
        `Could not send ${person} the card for ${name}: ${label(text(p, 'error'), 300)}\n` +
        `They can answer from any chat with the bot: ${how}.`
      );
    }
    case 'blocked': {
      const kind = text(p, 'kind');
      if (kind === '' || kind === 'dependency') return undefined;
      return blockedLine(task, kind, text(p, 'reason'), recurrences, opts.blockRecurrenceLimit);
    }
    case 'stopped':
      // A person's stop, not the task blocking again by itself: never the suggestion to rewrite it.
      return blockedLine(task, 'needs_input', `stopped by ${stopper(event.actor, opts.nameOf)}`, 0, Number.POSITIVE_INFINITY);
    case 'run_ended': {
      const outcome = text(p, 'outcome');
      const error = text(p, 'error');
      if (p['next'] === 'retry' && RETRIED.has(outcome)) {
        const why = error === '' ? '' : `: ${label(error, 500)}`;
        return `Retrying ${name}. The last attempt ended ${forDisplay(outcome)}${why}.`;
      }
      if (p['next'] !== 'blocked') return undefined;
      const kind = text(p, 'blockKind');
      const reason = text(p, 'blockReason');
      if (kind === 'gave_up') {
        return `Gave up on ${name}: ${label(reason, 800)}\n\`/kanban unblock ${task.taskId} [comment]\` gives it a fresh set of attempts.`;
      }
      return blockedLine(task, kind, reason, recurrences, opts.blockRecurrenceLimit);
    }
    case 'stranded':
      return `Stranded: ${name}. Nobody can be given it: ${label(text(p, 'reason'), 500)}`;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// A person's cards (spec §9.2)
// ---------------------------------------------------------------------------

/** What a person's card shows, as read from the board when it is sent. */
export interface CardFacts {
  task: TaskRow;
  /** The person's run the card is for: its buttons report on it, and on nothing later. */
  run: RunRow;
  /** Each parent's latest completion, as its children are given it (spec §4.4). */
  parents: ReadonlyArray<{ task: TaskRow; summary: string }>;
  /** For a work run after a review asked for changes: what was asked, and by whom (spec §5.3). */
  changes?: { reason: string; actor: string };
  /** For a review run: the handoff under review, with what its report recorded of the workspace (spec §7.8). */
  handoff?: ReviewRequest;
  nameOf?: NameOf;
  /**
   * How many times the card has been redrawn live after a press it refused --
   * an empty box, a gate. Its buttons carry it, so a press of the redrawn card is
   * not the press before it: the SDK drops a press it has seen, by the card, the
   * presser and the button's value, for twelve hours, whatever the box held.
   */
  attempt?: number;
  /** Why the last press did nothing, shown under the title, already escaped. */
  note?: string;
}

/**
 * The buttons' value: a pointer, with the nonce that binds it to the task and the
 * run (spec §9.2). The attempt goes first: the SDK keys a press on the value's
 * first 128 characters. It is not under the nonce, and needs no checking.
 */
function act(appId: string, run: RunRow, name: string, attempt: number | undefined): Readonly<Record<string, string>> {
  return {
    ...(attempt === undefined || attempt === 0 ? {} : { try: String(attempt) }),
    kind: 'kanban',
    act: name,
    task: run.taskId,
    run: run.runId,
    nonce: boardCardNonce(appId, run.taskId, run.runId),
  };
}

/** The task's own text, as a card shows it: the body, then the contract. */
function taskText(task: TaskRow, bodyMax: number): string[] {
  const out: string[] = [];
  if (task.body.trim() !== '') out.push(block(task.body, bodyMax));
  const contract = Object.entries(task.contract).filter(([, v]) => v !== undefined && v.trim() !== '');
  if (contract.length > 0) {
    out.push('**Contract**');
    for (const [field, value] of contract) out.push(`${forDisplay(field)}: ${label(value ?? '', 400)}`);
  }
  return out;
}

/**
 * A task card, sent to its assignee when it becomes ready (spec §9.2): the title,
 * the body, the contract, the parents' summaries, and Done and Block, which
 * submit what was typed in the box -- the summary, or the reason.
 */
export function renderTaskCard(f: CardFacts, appId: string): CardView {
  const { task, run } = f;
  const out = [`📋 For you to do: **${label(task.title)}** ${id(task.taskId)}`];
  if (f.note !== undefined) out.push(f.note);
  if (f.changes !== undefined) {
    out.push(`**Changes asked** by ${label(f.nameOf?.(f.changes.actor) ?? f.changes.actor, 80)}:`, block(f.changes.reason, 1200));
  }
  out.push(...taskText(task, 1500));
  const parents = f.parents.slice(0, 5);
  if (parents.length > 0) {
    out.push('**From its parents**');
    for (const p of parents) {
      out.push(`${id(p.task.taskId)} **${label(p.task.title, 120)}**:`, block(p.summary === '' ? '(no summary)' : p.summary, 600));
    }
    if (f.parents.length > parents.length) out.push(`… and ${f.parents.length - parents.length} more: \`/kanban show ${task.taskId}\``);
  }
  out.push(
    `Type a summary and press **Done**, or why it is blocked and press **Block**. ` +
      `In any chat with the bot, \`/kanban done ${task.taskId} [summary]\` and \`/kanban block ${task.taskId} <reason>\` do the same.`,
  );
  const buttons: CardButton[] = [
    { label: 'Done', style: 'primary', value: act(appId, run, 'done', f.attempt) },
    { label: 'Block', style: 'danger', value: act(appId, run, 'block', f.attempt) },
  ];
  return {
    markdown: out.join('\n'),
    input: { placeholder: 'A summary, or why it is blocked' },
    buttons,
    ...(f.attempt === undefined || f.attempt === 0 ? {} : { attempt: f.attempt }),
  };
}

/**
 * A review card, sent to its reviewer (spec §9.2): the handoff, what to review --
 * the reported commit, when one was recorded (spec §7.8) -- the task, and Approve
 * and Request changes, which submits the reason typed in the box.
 */
export function renderReviewCard(f: CardFacts, appId: string): CardView {
  const { task, run } = f;
  const out = [`🔎 For you to review: **${label(task.title)}** ${id(task.taskId)}`];
  if (f.note !== undefined) out.push(f.note);
  const h = f.handoff;
  if (h !== undefined) {
    // A run's report is its agent's; a person's, by name.
    const by = h.actor.startsWith('run:') ? 'its agent' : label(f.nameOf?.(h.actor) ?? h.actor, 80);
    out.push(`**The handoff**, from ${by}:`, block(h.summary === '' ? '(no summary)' : h.summary, 1500));
    const state = describeReported(h);
    if (state !== undefined) out.push(`To review: ${forDisplay(state)}.`);
  }
  out.push(...taskText(task, 1200));
  out.push(
    `Press **Approve**, or type what needs changing and press **Request changes**. ` +
      `In any chat with the bot, \`/kanban approve ${task.taskId}\` and \`/kanban changes ${task.taskId} <reason>\` do the same.`,
  );
  const buttons: CardButton[] = [
    { label: 'Approve', style: 'primary', value: act(appId, run, 'approve', f.attempt) },
    { label: 'Request changes', style: 'danger', value: act(appId, run, 'changes', f.attempt) },
  ];
  return {
    markdown: out.join('\n'),
    input: { placeholder: 'What needs changing' },
    buttons,
    ...(f.attempt === undefined || f.attempt === 0 ? {} : { attempt: f.attempt }),
  };
}

/**
 * A card once acted on, or found out of date (spec §9.2): its title and what
 * happened, with no buttons left to press.
 */
export function renderCardOutcome(task: { taskId: string; title: string }, outcome: string, byOpenId?: string): CardView {
  return {
    markdown: `**${label(task.title)}** ${id(task.taskId)}\n${outcome}`,
    buttons: [],
    ...(byOpenId === undefined ? {} : { byOpenId }),
  };
}

/** An Unblock under a notice of a block (spec §9.2), bound to the task and the event that blocked it. */
export function unblockButton(appId: string, event: KanbanEvent): CardButton {
  const ref = `event:${event.id}`;
  return {
    label: `Unblock ${event.taskId}`,
    style: 'primary',
    value: { kind: 'kanban', act: 'unblock', task: event.taskId, event: String(event.id), nonce: boardCardNonce(appId, event.taskId, ref) },
  };
}
