import { forDisplay, forMarkdown } from '../channel/escape.js';
import type { BoardEntry, TaskView } from '../db/kanban-read.js';
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import { LIST_FILTERS, USAGE } from './chat-parse.js';
import type { DisplayStatus } from './status.js';
import type { Assignee, GateRow, KanbanEvent, RunRow, TaskRow } from './types.js';

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
  ];
  return [
    '**The task board.** A task is any work -- research, a document, an operation in Lark, a chore, a change to code -- given to a role, whose agent runs it in a workspace.',
    ...lines.map(([usage, tier]) => `\`${usage}\` (${tier})`),
    'Assignees and reviewers are roles for now: naming a person, with an @-mention, arrives in a later update, with `/kanban done`, `block`, `review`, `approve` and `changes`.',
    'The chat a task is created in hears when it is done, needs review, blocks, is retried after a failure, gives up, or is stranded.',
  ].join('\n');
}

/** `/kanban list` (spec §9.1): the board by derived status, the active tasks unless a filter is given. */
export function renderList(entries: readonly BoardEntry[], filter: DisplayStatus | 'all' | undefined): string {
  const shown = entries.filter((e) =>
    filter === undefined ? ACTIVE.includes(e.status) : filter === 'all' || e.status === filter,
  );
  if (shown.length === 0) {
    return filter === undefined
      ? 'No open tasks. `/kanban list all` shows done and archived ones too.'
      : `No ${filter === 'all' ? '' : `${filter} `}tasks.`;
  }
  const ordered =
    filter === undefined ? ACTIVE.flatMap((status) => shown.filter((e) => e.status === status)) : [...shown];
  const lines = ordered
    .slice(0, LIST_MAX)
    .map((e) => `${id(e.task.taskId)} **${e.status}** — ${label(e.task.title, 120)} · ${who(e.task.assignee)}`);
  const more = ordered.length - LIST_MAX;
  if (more > 0) lines.push(`… and ${more} more. \`/kanban list <${LIST_FILTERS.join('|')}>\` narrows it.`);
  return lines.join('\n');
}

function runLine(run: RunRow): string {
  const outcome = run.outcome === null ? (run.endedAt === null ? 'working' : 'undecided') : run.outcome;
  const head = `#${run.attempt} ${run.kind} · ${who(run.assignee)} · ${forDisplay(outcome)}`;
  const said = run.summary ?? run.error;
  return said === null || said === '' ? head : `${head} — ${label(said, 300)}`;
}

/** `/kanban show` (spec §9.1): the task, its contract, gates, runs, latest output and comments. */
export function renderShow(view: TaskView, gates: readonly GateRow[]): string {
  const { task } = view;
  const out: string[] = [
    `**${label(task.title)}** ${id(task.taskId)} — ${view.status}`,
    `assignee: ${who(task.assignee)} · reviewer: ${who(task.reviewer)} · workspace: ${task.workspace === null ? 'not yet fixed' : label(task.workspace)}`,
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
  const head = `Blocked (${forDisplay(kind)}) — **${label(task.title)}** ${id(task.taskId)}: ${label(reason, 800)}`;
  if (recurrences >= limit) {
    return (
      `${head}\nIt keeps blocking for the same reason (${recurrences} times after an unblock); ` +
      'rewrite the task, or archive it and create a clearer one, rather than unblocking it again.'
    );
  }
  return `${head}\n\`/kanban unblock ${task.taskId} [comment]\` once it can go on.`;
}

/**
 * The notice a subscription hears of one event (spec §9.4), or undefined when
 * the event is none: completed, review requested, blocked with its kind and
 * reason, retrying after a failure, gave up, stranded. A dependency block is not
 * one, since nobody needs to act; a throttled run's cooldown is not either, as it
 * clears by itself, and blocks as transient at its limit, which is one.
 */
export function renderNotice(event: KanbanEvent, task: TaskRow, opts: { blockRecurrenceLimit: number }): string | undefined {
  const p = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
  const name = `**${label(task.title)}** ${id(task.taskId)}`;
  // As the event recorded it, not as the task is now: a notice delivered late tells what was true then.
  const recurrences = typeof p['blockRecurrences'] === 'number' ? p['blockRecurrences'] : 0;
  switch (event.kind) {
    case 'completed': {
      const summary = text(p, 'summary');
      return summary.trim() === '' ? `Done — ${name}.` : `Done — ${name}:\n${block(summary, 1200)}`;
    }
    case 'review_requested': {
      const reviewer = text(p, 'reviewer');
      const kind = p['reviewerKind'] === 'human' ? 'human' : 'role';
      return `Review requested — ${name}, from ${who(reviewer === '' ? null : { kind, name: reviewer })}.`;
    }
    case 'blocked': {
      const kind = text(p, 'kind');
      if (kind === '' || kind === 'dependency') return undefined;
      return blockedLine(task, kind, text(p, 'reason'), recurrences, opts.blockRecurrenceLimit);
    }
    case 'stopped':
      return blockedLine(task, 'needs_input', `stopped by ${event.actor}`, recurrences, opts.blockRecurrenceLimit);
    case 'run_ended': {
      const outcome = text(p, 'outcome');
      const error = text(p, 'error');
      if (p['next'] === 'retry' && RETRIED.has(outcome)) {
        const why = error === '' ? '' : `: ${label(error, 500)}`;
        return `Retrying — ${name}: the last attempt ended ${forDisplay(outcome)}${why}.`;
      }
      if (p['next'] !== 'blocked') return undefined;
      const kind = text(p, 'blockKind');
      const reason = text(p, 'blockReason');
      if (kind === 'gave_up') {
        return `Gave up — ${name}: ${label(reason, 800)}\n\`/kanban unblock ${task.taskId} [comment]\` gives it a fresh set of attempts.`;
      }
      return blockedLine(task, kind, reason, recurrences, opts.blockRecurrenceLimit);
    }
    case 'stranded':
      return `Stranded — ${name}: nobody can be given it: ${label(text(p, 'reason'), 500)}`;
    default:
      return undefined;
  }
}
