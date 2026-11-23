import { forDisplay, forMarkdown } from '../channel/escape.js';
import type { CardButton, CardView } from '../channel/types.js';
import { boardCardNonce } from '../core/ids.js';
import { formatWall, processZone } from '../cron/schedule.js';
import type { BoardEntry, BoardSummary, ReviewRequest, TaskView } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import { LIST_FILTERS, USAGE } from './chat-parse.js';
import { describeReported } from './commit.js';
import type { DisplayStatus } from './status.js';
import { DEFAULT_BOARD, type Assignee, type FailedGate, type GateRow, type KanbanEvent, type RunRow, type TaskRow, type Waiting } from './types.js';

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
 * a comment can hold one, and quoting splits lines on newlines only. A secret
 * split by a character that shows nothing (a zero-width or bidi character, a
 * direction mark) is masked whole, since masking reads past them; elsewhere they
 * are kept, as a joined emoji and right-to-left text need them.
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

/**
 * Who a principal is, by name, where the gateway knows one: what chat calls a
 * person. The gateway's is the people directory's `chatName`, which tells apart
 * two people of one name (spec §9.3).
 */
export type NameOf = (principal: string) => string | undefined;

/** How long a person's name may be in chat: a label's cut. */
const NAME_MAX = 80;

/** How long a shared name is kept before its tag, so the tag always shows within `NAME_MAX`. */
const SHARED_NAME_MAX = 60;

/**
 * A name another person in the people table shares (spec §9.3), as text before
 * it is escaped: the name, masked and cut first, then the start of the union_id
 * in parentheses, "Hemanth (on_8ba3…)", so the two can be told apart. The start
 * is seven characters, longer where another of the name's union_ids starts the
 * same way, and the whole id, unmarked, where nothing shorter tells them apart.
 */
export function sharedName(name: string, unionId: string, others: readonly string[]): string {
  let n = Math.min(7, unionId.length);
  while (n < unionId.length && others.some((o) => o.startsWith(unionId.slice(0, n)))) n += 1;
  const tag = n >= unionId.length ? unionId : `${unionId.slice(0, n)}…`;
  return `${head(masked(name).replace(/\s+/g, ' ').trim(), SHARED_NAME_MAX, '…')} (${tag})`;
}

/**
 * A principal as chat names it (spec §9.3): a person by the name `nameOf`
 * gives, else as recorded -- a principal, an operator's login, a run -- masked,
 * cut and escaped as a label, and never as a mention.
 */
export function personText(principal: string, nameOf: NameOf | undefined): string {
  return label(personName(principal, nameOf), NAME_MAX);
}

/** `personText` before it is labelled: for a piece that is labelled whole, as a block's reason is. */
function personName(principal: string, nameOf: NameOf | undefined): string {
  const name = principal.startsWith('lark:') ? nameOf?.(principal) : undefined;
  return name === undefined || name.trim() === '' ? principal : name;
}

/** A person's principal as a token in task text: `lark:` and a union_id. */
const PRINCIPAL_TOKEN = /lark:[A-Za-z0-9_-]+/g;

/**
 * Task text with each `lark:<union_id>` in it shown by chat name (spec §9.3),
 * falling back to the token: at render time, in chat only, so what is stored,
 * hashed and shown at the terminal stays as the start made it.
 */
export function named(text: string, nameOf: NameOf | undefined): string {
  if (nameOf === undefined) return text;
  return text.replace(PRINCIPAL_TOKEN, (token) => {
    const name = nameOf(token);
    return name === undefined || name.trim() === '' ? token : name;
  });
}

/** A task's title as chat labels it: its principals by name (`named`), then masked, cut and escaped. */
export function titleText(title: string, nameOf: NameOf | undefined, max = 200): string {
  return label(named(title, nameOf), max);
}

/** Nobody, a role as a role, or a person by name (`personText`). */
function who(a: Assignee | null, nameOf?: NameOf): string {
  if (a === null) return 'nobody';
  return a.kind === 'role' ? `role ${label(a.name)}` : personText(a.name, nameOf);
}

function id(taskId: string): string {
  return `\`${taskId}\``;
}

const LIST_MAX = 30;

/** The statuses `/kanban task list` shows with no filter: everything someone may still act on. */
const ACTIVE: readonly DisplayStatus[] = ['running', 'reviewing', 'review', 'ready', 'todo', 'blocked'];

/** A task too deep in woken turns to wake (wake spec §3.4): the note of a wake's answer, and its notice. */
export function tooDeepLine(taskId: string, depth: number): string {
  return `${id(taskId)} is ${depth} tasks deep in woken turns, so it stays notice-only`;
}

/** `/kanban help`: every command, with the tier it needs (spec §9.1). */
export function renderHelp(): string {
  const operate = 'operator';
  const talk = 'anyone allowed';
  const assignee = "the task's assignee";
  const reviewer = 'its reviewer, or an operator';
  const lines: Array<[string, string]> = [
    [USAGE.help, talk],
    [USAGE.new, operate],
    [USAGE.list, talk],
    [USAGE.show, talk],
    [USAGE.assign, operate],
    [USAGE.link, operate],
    [USAGE.workspace, operate],
    [USAGE.comment, talk],
    [USAGE.unblock, operate],
    [USAGE.wake, talk],
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
    [USAGE['workflow list'], talk],
    [USAGE['workflow instances'], talk],
    [USAGE['workflow show'], talk],
    [USAGE['workflow preview'], talk],
    [USAGE['workflow start'], operate],
    [USAGE['workflow archive'], operate],
  ];
  return [
    '**The task board.** A task is any work -- research, a document, an operation in Lark, a chore, a change to code -- given to a role, whose agent runs it in a workspace, or to a person.',
    ...lines.map(([usage, tier]) => `\`${usage}\` (${tier})`),
    "Name a person with an @-mention: they are sent the task as a card, in the task's thread when they are in its group, else by direct message, with Done and Block, or a review with Approve and Request changes. A person named may comment on, and report on, their own task.",
    "A task with a `reviewer:` is reviewed before it is done: its assignee's done, or its agent's, goes to the reviewer. An operator may answer any review, ending a reviewer role's run.",
    'The chat a task is created in hears when it is done, needs review, has changes requested, blocks, is retried after a failure, gives up, or is stranded, and who a person was given it.',
    "A board is a queue of tasks of its own. Each chat is on one, `default` until `/kanban board use` moves it, and its `/kanban task new` and `/kanban task list` act on that board; a task's follow-ups and parents are on its board.",
    "A workflow is a graph of tasks written once, in a file the operator keeps; a start makes all of its tasks at once, on this chat's board, and this chat hears each of them.",
  ].join('\n');
}

/**
 * The tasks `list` shows, in chat or at a terminal (spec §9.1): the active ones,
 * grouped by status in that order, unless a filter is given; with one, those of
 * that status, or every one for `all`, in the board's order.
 */
export function listed(entries: readonly BoardEntry[], filter: DisplayStatus | 'all' | undefined): BoardEntry[] {
  const shown = entries.filter((e) =>
    filter === undefined ? ACTIVE.includes(e.status) : filter === 'all' || e.status === filter,
  );
  return filter === undefined ? ACTIVE.flatMap((status) => shown.filter((e) => e.status === status)) : shown;
}

/**
 * `/kanban task list` (spec §9.1): a board by derived status, the active tasks unless a
 * filter is given. A board other than `default` is named (spec §16).
 */
export function renderList(
  entries: readonly BoardEntry[],
  filter: DisplayStatus | 'all' | undefined,
  board: string = DEFAULT_BOARD,
  nameOf?: NameOf,
): string {
  const on = board === DEFAULT_BOARD ? '' : ` on board ${label(board)}`;
  const ordered = listed(entries, filter);
  if (ordered.length === 0) {
    return filter === undefined
      ? `No open tasks${on}. \`/kanban task list all\` shows done and archived ones too.`
      : `No ${filter === 'all' ? '' : `${filter} `}tasks${on}.`;
  }
  const lines = ordered
    .slice(0, LIST_MAX)
    .map((e) => `${id(e.task.taskId)} **${e.status}**: ${titleText(e.task.title, nameOf, 120)} · ${who(e.task.assignee, nameOf)}`);
  const more = ordered.length - LIST_MAX;
  if (more > 0) lines.push(`… and ${more} more. \`/kanban task list <${LIST_FILTERS.join('|')}>\` narrows it.`);
  if (on !== '') lines.unshift(`Board **${label(board)}**:`);
  return lines.join('\n');
}

/** How many of a board's tasks are where, leaving out what is none: chat's and the terminal's board list. */
export function counted(s: BoardSummary): string {
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

/** A run's outcome, or `working` while it is open and undecided, or `undecided` once closed without one. */
export function runState(run: RunRow): string {
  return run.outcome === null ? (run.endedAt === null ? 'working' : 'undecided') : run.outcome;
}

function runLine(run: RunRow, nameOf: NameOf | undefined): string {
  const outcome = runState(run);
  const head = `#${run.attempt} ${run.kind} · ${who(run.assignee, nameOf)} · ${forDisplay(outcome)}`;
  const said = run.summary ?? run.error;
  return said === null || said === '' ? head : `${head}: ${label(said, 300)}`;
}

/**
 * Why the dispatcher skips a claimable task (spec §6.2, §6.3, §16):
 * `/kanban task show` and `mt kanban task show` say so, in the same words, one
 * line for each reason. `escape` is a label's, and `taskId` a task id's, as the
 * line is shown.
 */
export function waitingLine(
  w: Waiting,
  escape: (text: string) => string = (t) => t,
  taskId: (id: string) => string = (t) => t,
): string {
  if (w.kind === 'workspace') {
    return `waiting: workspace ${escape(w.workspace)} is busy with task ${taskId(w.taskId)}'s agent run; it is claimed when that run ends`;
  }
  const runs = `${w.maxRunning} agent run${w.maxRunning === 1 ? '' : 's'} at once; it is claimed when one of them ends`;
  if (w.kind === 'gateway') return `waiting: the gateway is at its ${escape('kanban.max_running')}, ${runs}`;
  const whose = w.kind === 'board' ? `board ${escape(w.board)}` : `role ${escape(w.role)}`;
  return `waiting: ${whose} is at its ${escape('max_running')}, ${runs}`;
}

/** What a Wake line needs of the gateway (wake spec §10): its switch, its zone, and now, for the day. */
export interface WakeShow {
  enabled: boolean;
  /** `cron.tz`, else the process's. */
  zone: string;
  now: number;
}

/** A Wake line when the caller says nothing of the gateway: wakes on, in the process's zone, now. */
export function defaultWakeShow(): WakeShow {
  return { enabled: true, zone: processZone(), now: Date.now() };
}

/**
 * `task show`'s Wake line (wake spec §10), chat's and the terminal's in the same
 * words, the setter named as the caller names people: off; on, by whom and at
 * what depth, with the time of the task's last delivered wake, HH:MM in the
 * zone, MM-DD HH:MM on another day; or on, but wakes off on the gateway.
 */
export function wakeLine(task: TaskRow, lastWoke: number | undefined, show: WakeShow, setter: string): string {
  if (task.wakeBy === null) return 'Wake: off';
  if (!show.enabled) return `Wake: on, set by ${setter}, but wakes are off on this gateway`;
  const head = `Wake: on, set by ${setter}, depth ${task.wakeDepth}`;
  if (lastWoke === undefined) return head;
  const at = formatWall(show.zone, lastWoke);
  const day = at.slice(0, 10) === formatWall(show.zone, show.now).slice(0, 10);
  return `${head}; last woke ${day ? at.slice(11) : at.slice(5)}`;
}

/**
 * `/kanban task show` (spec §9.1): the task, its contract, gates, runs, latest output
 * and comments. Its board is named once anything is on a board but `default`:
 * the task's, or the chat's it is shown in (spec §16).
 */
export function renderShow(view: TaskView, gates: readonly GateRow[], chatBoard: string = DEFAULT_BOARD, nameOf?: NameOf, wake: WakeShow = defaultWakeShow()): string {
  const { task } = view;
  const board = task.board === DEFAULT_BOARD && chatBoard === DEFAULT_BOARD ? '' : ` · board: ${label(task.board)}`;
  const out: string[] = [
    `**${titleText(task.title, nameOf)}** ${id(task.taskId)}: ${view.status}`,
    `assignee: ${who(task.assignee, nameOf)} · reviewer: ${who(task.reviewer, nameOf)} · workspace: ${task.workspace === null ? 'not yet fixed' : label(task.workspace)}${board}`,
    wakeLine(task, view.lastWoke, wake, task.wakeBy === null ? '' : personText(task.wakeBy, nameOf)),
  ];
  if (view.member !== undefined) out.push(memberLine(view.member, label, id));
  for (const w of view.waiting ?? []) out.push(waitingLine(w, label, id));
  if (task.phase === 'blocked' && task.blockKind !== null) {
    out.push(`blocked (${forDisplay(task.blockKind)}): ${label(task.blockReason ?? '', 500)}`);
  }
  if (view.parents.length > 0) {
    out.push(`parents: ${view.parents.map((p) => `${id(p.taskId)} (${view.statuses.get(p.taskId) ?? p.phase})`).join(', ')}`);
  }
  if (view.children.length > 0) {
    out.push(`children: ${view.children.map((c) => `${id(c.taskId)} (${view.statuses.get(c.taskId) ?? c.phase})`).join(', ')}`);
  }
  if (view.workdir !== undefined) out.push(workdirLine(view.workdir, label));
  if (task.body.trim() !== '') out.push(block(named(task.body, nameOf), 1500));
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
    for (const run of view.runs.slice(-5)) out.push(runLine(run, nameOf));
    const last = view.runs.at(-1);
    const output = last?.lastOutput ?? null;
    if (output !== null && output.trim() !== '') out.push('Latest output:', tail(output, 800));
  }
  if (view.comments.length > 0) {
    const shown = view.comments.slice(-5);
    out.push(`**Comments** (${shown.length} of ${view.comments.length})`);
    for (const c of shown) out.push(`${personText(c.author, nameOf)}:`, block(c.body, 400));
  }
  return out.join('\n');
}

/**
 * A member's line in `task show` (workflows spec §10): its instance, its step and its
 * item, in chat and at the terminal in the same words.
 */
export function memberLine(
  m: { instanceId: string; name: string | null; step: string; item: string | null },
  escape: (text: string) => string = (t) => t,
  code: (id: string) => string = (t) => t,
): string {
  return `workflow: ${code(m.instanceId)} ${escape(m.name ?? '(no workflow)')}, step ${escape(m.step)}${m.item === null ? '' : `, item ${escape(m.item)}`}`;
}

/**
 * Where a task with a directory of its own works (spec §18): `/kanban task show`
 * and `mt kanban task show` say so, in the same words.
 */
export function workdirLine(
  w: { path: string | null; branch: string | null; first?: true },
  escape: (text: string) => string = (t) => t,
): string {
  if (w.path === null) return `directory: its own, not made yet: ${whenMade(w)}`;
  return `directory: ${escape(w.path)}${w.branch === null ? '' : ` · branch ${escape(w.branch)}`}`;
}

/** When a task's own directory that is not made yet will be: at the agent claim that gives it one, or the next. */
export function whenMade(w: { first?: true }): string {
  return `it is made when an agent ${w.first === true ? 'first' : 'next'} takes the task up`;
}

/** `/kanban gate list` (spec §7.7): each gate's command masked, with its timeout and who defined it. */
export function renderGates(taskId: string, gates: readonly GateRow[], nameOf?: NameOf): string {
  if (gates.length === 0) return `Task ${id(taskId)} has no gates.`;
  return [
    `Gates of ${id(taskId)}, run in this order before it may complete or go to review:`,
    ...gates.map((g) => `${g.id}. ${label(g.command, 600)} (${g.timeoutS} s, by ${personText(g.createdBy, nameOf)})`),
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

function blockedLine(task: TaskRow, kind: string, reason: string, recurrences: number, limit: number, nameOf: NameOf | undefined): string {
  const head = `**${titleText(task.title, nameOf)}** ${id(task.taskId)} is blocked (${forDisplay(kind)}): ${label(reason, 800)}`;
  if (recurrences >= limit) {
    return (
      `${head}\nIt keeps blocking for the same reason (${recurrences} times after an unblock); ` +
      'rewrite the task, or archive it and create a clearer one, rather than unblocking it again.'
    );
  }
  return `${head}\n\`/kanban task unblock ${task.taskId} [comment]\` once it can go on.`;
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
 * the event is none: completed, review requested, changes requested with who
 * asked and the reason, blocked with its kind and reason, retrying after a
 * failure, gave up, stranded. A dependency block is not
 * one, since nobody needs to act; a throttled run's cooldown is not either, as it
 * clears by itself, and blocks as transient at its limit, which is one. For
 * people: the one line that says who a person's card went to, when it went by
 * direct message (spec §19.5), named in plain text, never mentioned -- a card in
 * the task's thread says it itself, and a claim is no notice, as only the send
 * knows where the card went -- and a card that could not be sent. A task a
 * terminal made for a chat to follow is announced there by its "Created" line,
 * and a workflow a terminal started by its start's reply.
 */
export function renderNotice(
  event: KanbanEvent,
  task: TaskRow,
  opts: {
    blockRecurrenceLimit: number;
    nameOf?: NameOf;
    /** A run's assignee, for an event from before its reviewer was recorded in it; undefined once the run is gone. */
    runAssignee?: (runId: string) => Assignee | undefined;
    /** Whether the notice goes to a thread with a root or to the chat, for a start's reply's words; the chat's unless given. */
    where?: 'thread' | 'chat';
  },
): string | undefined {
  const p = payloadOf(event);
  const name = `**${titleText(task.title, opts.nameOf)}** ${id(task.taskId)}`;
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
      return `Review requested for ${name}, from ${who(reviewer === '' ? null : { kind, name: reviewer }, opts.nameOf)}.`;
    }
    case 'card_sent': {
      // The group's one line, for a card it does not see. One with no `in`, from before threads, was told at its claim.
      if (p['in'] !== 'dm') return undefined;
      const person = who({ kind: 'human', name: text(p, 'to') }, opts.nameOf);
      return `📋 ${name}, ${p['kind'] === 'review' ? 'review ' : ''}assigned to ${person}`;
    }
    case 'card_failed': {
      const person = who({ kind: 'human', name: text(p, 'to') }, opts.nameOf);
      const how =
        p['kind'] === 'review'
          ? `\`/kanban task approve ${task.taskId}\` or \`/kanban task changes ${task.taskId} <reason>\``
          : `\`/kanban task done ${task.taskId} [summary]\` or \`/kanban task block ${task.taskId} <reason>\``;
      return (
        `Could not send ${person} the card for ${name}: ${label(text(p, 'error'), 300)}\n` +
        `They can answer from any chat with the bot: ${how}.`
      );
    }
    case 'blocked': {
      const kind = text(p, 'kind');
      if (kind === '' || kind === 'dependency') return undefined;
      return blockedLine(task, kind, text(p, 'reason'), recurrences, opts.blockRecurrenceLimit, opts.nameOf);
    }
    case 'stopped':
      // A person's stop, not the task blocking again by itself: never the suggestion to rewrite it.
      return blockedLine(task, 'needs_input', `stopped by ${head(masked(personName(event.actor, opts.nameOf)).replace(/\s+/g, ' ').trim(), NAME_MAX, '…')}`, 0, Number.POSITIVE_INFINITY, opts.nameOf);
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
        return `Gave up on ${name}: ${label(reason, 800)}\n\`/kanban task unblock ${task.taskId} [comment]\` gives it a fresh set of attempts.`;
      }
      return blockedLine(task, kind, reason, recurrences, opts.blockRecurrenceLimit, opts.nameOf);
    }
    case 'changes_requested': {
      // A run's reviewer as the event recorded it; a person by the name Lark last gave; anyone else as recorded.
      const reviewer = text(p, 'reviewer');
      const run = reviewer === '' && event.actor.startsWith('run:') ? opts.runAssignee?.(event.actor.slice(4)) : undefined;
      const by =
        reviewer !== ''
          ? who({ kind: p['reviewerKind'] === 'human' ? 'human' : 'role', name: reviewer }, opts.nameOf)
          : run !== undefined
            ? who(run, opts.nameOf)
            : personText(event.actor, opts.nameOf);
      return `Changes requested on ${name} by ${by}: ${label(text(p, 'reason'), 500)}`;
    }
    case 'stranded':
      return `Stranded: ${name}. Nobody can be given it: ${label(text(p, 'reason'), 500)}`;
    case 'task_created_followed': {
      // The "Created" line of a task a terminal made (kanban spec §22.1), from the task as it is now, as every notice.
      const whose = task.assignee === null ? 'nobody yet' : who(task.assignee, opts.nameOf);
      return `Created ${id(task.taskId)} **${titleText(task.title, opts.nameOf)}**, for ${whose}, by ${label(text(p, 'by'), 80)} from a terminal.`;
    }
    case 'workflow_started':
      // A terminal start's reply (workflows spec §18.2), on its first member, whole: it may run to 3,800 characters.
      return renderStarted(startedOf(p), opts.where ?? 'chat', (a) => who(a, opts.nameOf), opts.nameOf);
    case 'wake_set':
      // Only a wake refused as too deep is a notice (wake spec §3.4, §4.4): every other change is the command's answer.
      if (p['refused'] !== 'too_deep') return undefined;
      return tooDeepLine(task.taskId, typeof p['depth'] === 'number' ? p['depth'] : task.wakeDepth);
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
  /**
   * The person's open_id, for a card sent in a task's thread (spec §19.2): the
   * card starts with an @-mention of them. Absent for a direct message, and for
   * every redraw, which would notify them of their own press.
   */
  mention?: string;
}

/** An open_id, as Lark gives one: the only thing a card mentions anyone by. */
const OPEN_ID = /^ou_[0-9A-Za-z]+$/;

/**
 * A card's first line, after an @-mention of its person when it has one (spec
 * §19.2), as Lark's markdown writes one. Put in after the line was escaped and
 * masked, so an `<at` in task text is still escaped, and only this one, made
 * from an id the gateway holds, mentions anyone.
 */
function mentioning(f: CardFacts, line: string): string {
  return f.mention !== undefined && OPEN_ID.test(f.mention) ? `<at id=${f.mention}></at> ${line}` : line;
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
function taskText(task: TaskRow, bodyMax: number, nameOf: NameOf | undefined): string[] {
  const out: string[] = [];
  if (task.body.trim() !== '') out.push(block(named(task.body, nameOf), bodyMax));
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
  const out = [mentioning(f, `📋 For you to do: **${titleText(task.title, f.nameOf)}** ${id(task.taskId)}`)];
  if (f.note !== undefined) out.push(f.note);
  if (f.changes !== undefined) {
    out.push(`**Changes asked** by ${personText(f.changes.actor, f.nameOf)}:`, block(f.changes.reason, 1200));
  }
  out.push(...taskText(task, 1500, f.nameOf));
  const parents = f.parents.slice(0, 5);
  if (parents.length > 0) {
    out.push('**From its parents**');
    for (const p of parents) {
      out.push(`${id(p.task.taskId)} **${titleText(p.task.title, f.nameOf, 120)}**:`, block(p.summary === '' ? '(no summary)' : p.summary, 600));
    }
    if (f.parents.length > parents.length) out.push(`… and ${f.parents.length - parents.length} more: \`/kanban task show ${task.taskId}\``);
  }
  out.push(
    `Type a summary and press **Done**, or why it is blocked and press **Block**. ` +
      `In any chat with the bot, \`/kanban task done ${task.taskId} [summary]\` and \`/kanban task block ${task.taskId} <reason>\` do the same.`,
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
  const out = [mentioning(f, `🔎 For you to review: **${titleText(task.title, f.nameOf)}** ${id(task.taskId)}`)];
  if (f.note !== undefined) out.push(f.note);
  const h = f.handoff;
  if (h !== undefined) {
    // A run's report is its agent's; a person's, by name.
    const by = h.actor.startsWith('run:') ? 'its agent' : personText(h.actor, f.nameOf);
    out.push(`**The handoff**, from ${by}:`, block(h.summary === '' ? '(no summary)' : h.summary, 1500));
    const state = describeReported(h);
    if (state !== undefined) out.push(`To review: ${forDisplay(state)}.`);
  }
  out.push(...taskText(task, 1200, f.nameOf));
  out.push(
    `Press **Approve**, or type what needs changing and press **Request changes**. ` +
      `In any chat with the bot, \`/kanban task approve ${task.taskId}\` and \`/kanban task changes ${task.taskId} <reason>\` do the same.`,
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
export function renderCardOutcome(task: { taskId: string; title: string }, outcome: string, byOpenId?: string, nameOf?: NameOf): CardView {
  return {
    markdown: `**${titleText(task.title, nameOf)}** ${id(task.taskId)}\n${outcome}`,
    buttons: [],
    ...(byOpenId === undefined ? {} : { byOpenId }),
  };
}

/** An Unblock under a notice of a block (spec §9.2), bound to the task and the event that blocked it. */
export function unblockButton(appId: string, event: Pick<KanbanEvent, 'id' | 'taskId'>): CardButton {
  const ref = `event:${event.id}`;
  return {
    label: `Unblock ${event.taskId}`,
    style: 'primary',
    value: { kind: 'kanban', act: 'unblock', task: event.taskId, event: String(event.id), nonce: boardCardNonce(appId, event.taskId, ref) },
  };
}

/** One Unblock of a recorded message, as its redraw shows it: still a button, or lifted by someone at a time. */
export interface UnblockShown {
  taskId: string;
  blockEvent: number;
  /** `woken`: lifted by a woken turn, on its setter's authority (wake spec §9.3). */
  lift?: { kind: 'unblocked' | 'archived'; actor: string; at: number; woken?: boolean };
}

/**
 * A message of notices redrawn once a block it offered Unblock for has been
 * lifted (spec §9.2, amended by the unblock redraw): its text as it was sent,
 * then a line for each lifted block, "`<task>`: Unblocked by <name> at HH:MM",
 * "Unblocked by <name> (woken by the board)" for a woken turn's (wake spec §9.3),
 * or "Archived by" for a task archived while blocked, at the time `when` says,
 * the person by chat name, else as recorded; and the buttons
 * of the blocks not yet lifted, as they were.
 */
export function renderUnblockRedraw(
  appId: string,
  markdown: string,
  buttons: readonly UnblockShown[],
  when: (ms: number) => string,
  nameOf?: NameOf,
): CardView {
  const lines = buttons.flatMap((b) =>
    b.lift === undefined
      ? []
      : [
          `${id(b.taskId)}: ${b.lift.kind === 'archived' ? 'Archived' : 'Unblocked'} by ${personText(b.lift.actor, nameOf)}${b.lift.woken === true ? ' (woken by the board)' : ''} at ${when(b.lift.at)}`,
        ],
  );
  return {
    markdown: lines.length === 0 ? markdown : `${markdown}\n\n${lines.join('\n')}`,
    buttons: buttons.filter((b) => b.lift === undefined).map((b) => unblockButton(appId, { id: b.blockEvent, taskId: b.taskId })),
  };
}

// ---------------------------------------------------------------------------
// Workflows (workflows spec §9, §10)
// ---------------------------------------------------------------------------

/** How long a reply about a workflow may be: under 3,800 characters, the notices' own bound, as Lark takes 4,000 in one message. */
export const WORKFLOW_REPLY_MAX = 3_800;

/** A reply lists at most 30 tasks, as `/kanban task list` lists 30 lines. */
export const WORKFLOW_REPLY_TASKS = 30;

/** A title in a reply's line, cut at 80 characters. */
const WORKFLOW_TITLE_MAX = 80;

/**
 * `head` and as many of `lines` as fit, then `more(n)` for the `n` left out,
 * then `tail`: at most `WORKFLOW_REPLY_TASKS` lines, dropped from the end until
 * the whole is under `WORKFLOW_REPLY_MAX` (workflows spec §9).
 */
export function fitted(
  head: readonly string[],
  lines: readonly string[],
  tail: readonly string[],
  more: (n: number) => string,
  total = lines.length,
): string {
  let kept = Math.min(lines.length, WORKFLOW_REPLY_TASKS);
  // `total` counts what `lines` left out already: a start's payload holds its first 30 members of more.
  const render = (n: number): string => [...head, ...lines.slice(0, n), ...(n < total ? [more(total - n)] : []), ...tail].join('\n');
  while (kept > 0 && render(kept).length >= WORKFLOW_REPLY_MAX) kept -= 1;
  return render(kept);
}

/** One task of a DAG, as a preview says it, in chat and at the terminal alike (workflows spec §6). */
export interface PreviewLine {
  ref: string;
  title: string;
  assignee: string | null;
  parents: readonly string[];
  gates: number;
}

/** A DAG's tasks, as a preview lists them: its ref, its title, its assignee, its parents' refs, and how many gates it has. */
export function previewLines(dag: { tasks: readonly { ref: string; title: string; assignee: string | null; parents: readonly string[]; gates: readonly unknown[] }[] }): PreviewLine[] {
  return dag.tasks.map((t) => ({ ref: t.ref, title: t.title, assignee: t.assignee, parents: t.parents, gates: t.gates.length }));
}

/** A DAG's name as a reply says it: its workflow's, or "(no workflow)" for one with none (workflows spec §10). */
export function workflowName(name: string | null): string {
  return name ?? '(no workflow)';
}

/** `/kanban workflow preview` (workflows spec §9): what a start would make, one line a task, and that nothing was made. */
export function renderPreview(
  name: string,
  dag: { board: string | null; tasks: readonly { ref: string; title: string; assignee: string | null; parents: readonly string[]; gates: readonly unknown[] }[] },
  whom: (name: string) => string,
  nameOf?: NameOf,
): string {
  const board = dag.board === null || dag.board === DEFAULT_BOARD ? '' : `, on board **${label(dag.board)}**`;
  const n = dag.tasks.length;
  const lines = previewLines(dag).map((t) => {
    const after = t.parents.length === 0 ? '' : `, after ${t.parents.map((p) => `\`${label(p, 64)}\``).join(', ')}`;
    const gates = t.gates === 0 ? '' : `, ${t.gates} gate${t.gates === 1 ? '' : 's'}`;
    return `- \`${label(t.ref, 64)}\` ${titleText(t.title, nameOf, WORKFLOW_TITLE_MAX)}, for ${t.assignee === null ? 'nobody yet' : whom(t.assignee)}${after}${gates}`;
  });
  return fitted(
    [`${label(name)} would make ${n} task${n === 1 ? '' : 's'}${board}:`],
    lines,
    [`Nothing was made: \`/kanban workflow start ${label(name)}\`, with these params, makes it.`],
    (more) => `… and ${more} more.`,
  );
}

/** A member as a start's reply lists it: flat, as a task row keeps it, and as `workflow_started`'s payload holds it. */
export interface StartedTask {
  taskId: string;
  title: string;
  assignee: string | null;
  assigneeKind: 'role' | 'human' | null;
}

/** What a start's reply says (workflows spec §9, §18.2): from chat's rows, or from a terminal start's `workflow_started`. */
export interface StartedReply {
  instance: { instanceId: string; name: string | null; board: string };
  /** The members in position order: all of them from chat's rows, the first 30 from a payload. */
  tasks: readonly StartedTask[];
  /** How many members the instance has. */
  count: number;
  /** Whether any member names a person, as assignee or reviewer. */
  people: boolean;
  /** Who started it at a terminal, as nobody in the chat typed it; absent for a chat's own start. */
  by?: string;
}

/** A start's reply from what the start made, as chat's start builds it. */
export function startedReply(made: { instance: { instanceId: string; name: string | null; board: string }; tasks: readonly { task: TaskRow }[] }): StartedReply {
  return {
    instance: made.instance,
    tasks: made.tasks.map(({ task }) => ({ taskId: task.taskId, title: task.title, assignee: task.assignee?.name ?? null, assigneeKind: task.assignee?.kind ?? null })),
    count: made.tasks.length,
    people: made.tasks.some(({ task }) => task.assignee?.kind === 'human' || task.reviewer?.kind === 'human'),
  };
}

/** A `workflow_started` payload as a reply, read from the payload alone: the notifier reads no workflow table (workflows spec §18.2). */
function startedOf(p: Record<string, unknown>): StartedReply {
  const tasks = (Array.isArray(p['tasks']) ? p['tasks'] : []).flatMap((raw): StartedTask[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const t = raw as Record<string, unknown>;
    const kind = t['assigneeKind'] === 'human' || t['assigneeKind'] === 'role' ? t['assigneeKind'] : null;
    return [{ taskId: text(t, 'taskId'), title: text(t, 'title'), assignee: typeof t['assignee'] === 'string' ? t['assignee'] : null, assigneeKind: kind }];
  });
  return {
    instance: { instanceId: text(p, 'workflow'), name: typeof p['workflowName'] === 'string' ? p['workflowName'] : null, board: text(p, 'board') || DEFAULT_BOARD },
    tasks,
    count: typeof p['count'] === 'number' ? p['count'] : tasks.length,
    people: p['people'] === true,
    by: text(p, 'by') || 'the operator',
  };
}

/**
 * A start's reply (workflows spec §9): the instance, one line a task in position order
 * with its id, its title and its assignee, and who hears, in the words of the
 * thread or of the chat. A terminal's names who started it (§18.2).
 */
export function renderStarted(reply: StartedReply, where: 'thread' | 'chat', whom: (a: Assignee) => string, nameOf?: NameOf): string {
  const { instance, tasks, count: n } = reply;
  const board = instance.board === DEFAULT_BOARD ? '' : `, on board **${label(instance.board)}**`;
  const lines = tasks.map((t) => {
    const assignee = t.assignee === null ? 'nobody yet' : whom({ kind: t.assigneeKind === 'human' ? 'human' : 'role', name: t.assignee });
    return `- ${id(t.taskId)} ${titleText(t.title, nameOf, WORKFLOW_TITLE_MAX)}, for ${assignee}`;
  });
  const started = `${label(workflowName(instance.name))} ${reply.by === undefined ? 'as' : 'from a terminal as'} ${id(instance.instanceId)}`;
  const head = reply.by === undefined ? `Started ${started}` : `${label(reply.by, 80)} started ${started}`;
  const cards =
    !reply.people
      ? ''
      : where === 'thread'
        ? " A person's card comes in this thread when their task is ready, or by direct message if they are not in this group."
        : ' A person is sent their card by direct message once their task is ready.';
  return fitted(
    [`${head}, ${n} task${n === 1 ? '' : 's'}${board}:`],
    lines,
    [
      `${where === 'thread' ? 'This thread' : 'This chat'} hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.${cards}`,
    ],
    (more) => `… and ${more} more: \`/kanban workflow show ${instance.instanceId}\` lists them all.`,
    n,
  );
}

/** `/kanban workflow list` (workflows spec §10): each usable workflow with its description and params, and each that is not with why. */
export function renderWorkflows(list: {
  usable: readonly { name: string; description: string | undefined }[];
  broken: readonly { name: string; problem: string }[];
}, params: (name: string) => string): string {
  const lines = [
    ...list.usable.map((w) => ({
      name: w.name,
      line: `- **${label(w.name)}**${w.description === undefined ? '' : `: ${label(w.description, 200)}`} · params: ${label(params(w.name), 400)}`,
    })),
    ...list.broken.map((b) => ({ name: b.name, line: `- **${label(b.name)}** is not usable: ${label(b.problem, 300)}` })),
  ]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((l) => l.line);
  if (lines.length === 0) return 'No workflows: a workflow is a file, `$MT_HOME/workflows/<name>.yaml`, which the operator writes.';
  return fitted(['**Workflows**'], lines, ['`/kanban workflow preview <name> key=value ...` shows what a start would make.'], (more) => `… and ${more} more.`);
}

/** A time as a reply says it, to the minute, in UTC. */
export function whenText(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Who made an instance, as a reply names them: a person by the name Lark last gave, the operator by login, a run by its id. */
export function makerText(createdBy: string, nameOf: NameOf): string {
  if (createdBy.startsWith('operator:')) return `the operator ${label(createdBy.slice('operator:'.length), 80)}`;
  if (createdBy.startsWith('run:')) return `run ${id(createdBy.slice('run:'.length))}`;
  return personText(createdBy, nameOf);
}

/**
 * An instance's members done of its total (workflows spec §10), as chat and the terminal
 * say it. An archived member counts as finished, so an archived instance's are
 * "finished", never "done", which its members are not.
 */
export function membersDone(s: { status: string; done: number; total: number }): string {
  return `${s.done} of ${s.total} ${s.status === 'archived' ? 'finished' : 'done'}`;
}

/** `/kanban workflow instances [all]` (workflows spec §10): the board's instances, newest first, at most 30 lines. */
export function renderInstances(
  summaries: readonly { instance: { instanceId: string; name: string | null; createdBy: string; createdAt: number }; status: string; done: number; total: number; blocked: number }[],
  opts: { board: string; all: boolean; total: number; read: number; nameOf: (principal: string) => string | undefined },
): string {
  const on = opts.board === DEFAULT_BOARD ? '' : ` on board **${label(opts.board)}**`;
  const past = opts.total > opts.read ? [`Only the ${opts.read} newest are read; an older instance is shown by its id, with \`/kanban workflow show\`.`] : [];
  if (summaries.length === 0) {
    return [
      opts.all ? `No workflow instances${on}.` : `No running or blocked workflow instances${on}. \`/kanban workflow instances all\` shows done and archived ones too.`,
      ...past,
    ].join('\n');
  }
  const lines = summaries.map((s) => {
    const status = s.status === 'blocked' ? `blocked (${s.blocked})` : s.status;
    return `- ${id(s.instance.instanceId)} **${label(workflowName(s.instance.name))}** ${status}, ${membersDone(s)} · by ${makerText(s.instance.createdBy, opts.nameOf)}, ${whenText(s.instance.createdAt)}`;
  });
  return fitted([`Workflow instances${on}:`], lines, past, (more) => `… and ${more} more.`);
}

/** How an instance was made, as `show` says it: in chat, at the terminal, or by a run, by its task. */
function howMade(via: { kind: string }, fromTask: string | null): string {
  if (via.kind === 'chat') return 'in chat';
  if (via.kind === 'operator') return 'at the terminal';
  return fromTask === null ? 'by a run' : `by a run of ${id(fromTask)}`;
}

/** A param's value, as `show` says it: a list's items joined, a person's principal by name (spec §9.3). */
function paramText(value: string | readonly string[], nameOf: NameOf | undefined): string {
  return (typeof value === 'string' ? [value] : value).map((v) => personName(v, nameOf)).join(', ');
}

/** How long `show`'s Params line may be, as a whole: with the head's other lines, a reply keeps room for its tasks. */
const PARAMS_LINE_MAX = 1_200;

/** `show`'s Params line: each param, as many as fit in PARAMS_LINE_MAX, then how many were left out. */
function paramsLine(params: ReadonlyArray<readonly [string, string | readonly string[]]>, nameOf: NameOf | undefined): string {
  const parts = params.map(([k, v]) => `${label(k, 40)}: ${label(paramText(v, nameOf), 200)}`);
  const more = (n: number): string => ` · … and ${n} more param${n === 1 ? '' : 's'}`;
  let line = 'Params:';
  for (const [n, part] of parts.entries()) {
    const next = `${line}${n === 0 ? ' ' : ' · '}${part}`;
    const left = parts.length - n - 1;
    // Room is kept for the count of those left out, unless this is the last.
    if (next.length + (left > 0 ? more(left).length : 0) > PARAMS_LINE_MAX) return `${line}${n === 0 ? ' …' : ''}${more(parts.length - n)}`;
    line = next;
  }
  return line;
}

/** `/kanban workflow show` (workflows spec §10): the instance, its steps' tasks in position order, its related tasks apart, cut to fit. */
export function renderInstance(
  view: {
    instance: { instanceId: string; name: string | null; board: string; createdBy: string; createdVia: { kind: string }; createdAt: number; dag: { params: Readonly<Record<string, string | readonly string[]>> } };
    description: string | undefined;
    members: readonly { step: string; item: string | null; task: TaskRow; status: DisplayStatus }[];
    related: readonly { task: TaskRow; status: DisplayStatus }[];
    relatedInstances: readonly { instanceId: string; name: string | null; tasks: number }[];
    status: string;
    done: number;
    total: number;
    blocked: number;
  },
  chatBoard: string,
  whom: (a: Assignee | null) => string,
  nameOf: (principal: string) => string | undefined,
): string {
  const { instance } = view;
  const board = instance.board === chatBoard && chatBoard === DEFAULT_BOARD ? '' : ` · board: **${label(instance.board)}**`;
  const status = view.status === 'blocked' ? `blocked (${view.blocked})` : view.status;
  const head = [
    `**${label(workflowName(instance.name))}** ${id(instance.instanceId)}: ${status}, ${membersDone(view)}${board}`,
    ...(view.description === undefined ? [] : [label(view.description, 300)]),
    `Started by ${makerText(instance.createdBy, nameOf)}, ${howMade(instance.createdVia, view.members[0]?.task.createdFromTask ?? null)}, ${whenText(instance.createdAt)}`,
  ];
  const params = Object.entries(instance.dag.params);
  if (params.length > 0) head.push(paramsLine(params, nameOf));
  const lines: string[] = [];
  let step: string | undefined;
  for (const m of view.members) {
    if (m.step !== step) {
      step = m.step;
      lines.push(`**${label(m.step, 64)}**`);
    }
    const item = m.item === null ? '' : ` ${label(m.item, 80)}:`;
    const why = m.task.phase === 'blocked' && m.task.blockKind !== null ? ` (${forDisplay(m.task.blockKind)}): ${label(m.task.blockReason ?? '', 200)}` : '';
    lines.push(`- ${id(m.task.taskId)}${item} ${m.status}${why} · ${whom(m.task.assignee)}`);
  }
  if (view.related.length > 0 || view.relatedInstances.length > 0) {
    lines.push('**Related**, not members:');
    for (const r of view.related) lines.push(`- ${id(r.task.taskId)} ${titleText(r.task.title, nameOf, WORKFLOW_TITLE_MAX)}: ${r.status}`);
    for (const o of view.relatedInstances) {
      lines.push(`- ${id(o.instanceId)} ${label(workflowName(o.name))}, ${o.tasks} task${o.tasks === 1 ? '' : 's'}: \`/kanban workflow show ${o.instanceId}\``);
    }
  }
  // Every line counts here, not only the tasks': as many as fit, then what was cut.
  let kept = lines.length;
  const render = (n: number): string =>
    [...head, ...lines.slice(0, n), ...(n < lines.length ? [`… and ${lines.length - n} more lines: \`mt kanban workflow show ${instance.instanceId}\` at the terminal gives every one.`] : [])].join('\n');
  while (kept > 0 && render(kept).length >= WORKFLOW_REPLY_MAX) kept -= 1;
  return render(kept);
}
