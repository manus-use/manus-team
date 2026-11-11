import { forDisplay } from '../channel/escape.js';
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import type { DisplayStatus } from './status.js';
import type { Contract } from './types.js';
import { WORKER_LIMITS } from './limits.js';

/**
 * `/kanban` as typed in chat (spec §9.1), parsed into what to do. Pure: no
 * board, no tiers, no identity -- those are `KanbanChat`'s. A parse that fails
 * carries the usage line to show, already escaped.
 */

/** The display statuses `/kanban task list` can filter by, and `all`. */
export const LIST_FILTERS: readonly (DisplayStatus | 'all')[] = [
  'todo',
  'ready',
  'running',
  'review',
  'reviewing',
  'blocked',
  'done',
  'archived',
  'all',
];

/**
 * A person's report on their own task (spec §9.1): `done` and `block` by its
 * assignee, `approve` and `changes` by its reviewer or an operator. The text is
 * the summary, the reason, or an approval's optional comment.
 */
export interface ReportCommand {
  verb: 'done' | 'block' | 'approve' | 'changes';
  taskId: string;
  text: string;
}

/** `/kanban task review`: the assignee asks for same-task review (spec §5.3), naming a reviewer on a `reviewer:` line, or not. */
export interface ReviewCommand {
  verb: 'review';
  taskId: string;
  summary: string;
  reviewer?: string;
}

export interface NewTaskCommand {
  verb: 'new';
  title: string;
  body: string;
  assignee?: string;
  reviewer?: string;
  workspace?: string;
  parents: string[];
  contract: Contract;
}

export type KanbanCommand =
  | { verb: 'help' }
  | NewTaskCommand
  | { verb: 'list'; filter: DisplayStatus | 'all' | undefined }
  | { verb: 'show'; taskId: string }
  | { verb: 'assign'; taskId: string; assignee: string }
  | { verb: 'link'; parentId: string; childId: string }
  | { verb: 'workspace'; taskId: string; workspace: string }
  | { verb: 'comment'; taskId: string; text: string }
  | { verb: 'unblock'; taskId: string; comment: string | undefined }
  | { verb: 'stop'; taskId: string }
  | { verb: 'archive'; taskId: string }
  | { verb: 'gate add'; taskId: string; command: string; timeoutS: number | undefined }
  | { verb: 'gate list'; taskId: string }
  | { verb: 'gate remove'; taskId: string; gateId: number }
  | ReportCommand
  | ReviewCommand
  | { verb: 'board list'; archived: boolean }
  | BoardCommand;

/** What `board set` changes (spec §16.6): a board's own max_running, or its workspace; null clears either. */
export interface BoardSetting {
  maxRunning?: number | null;
  workspace?: string | null;
}

/** `/kanban board …` (spec §16): a board's name as typed, which the service checks. */
export type BoardCommand =
  | { verb: 'board create' | 'board use' | 'board archive'; board: string }
  | { verb: 'board set'; board: string; change: BoardSetting };

export type ParsedKanban = { ok: true; command: KanbanCommand } | { ok: false; usage: string };

/**
 * The verbs of `/kanban task …` (spec §9.1), each a command on one task, or the
 * board's tasks. Every one is typed after `task`: `/kanban new`, without it, is an
 * unknown command, as any word that is not `help`, `task`, `board` or `gate` is.
 */
export const TASK_VERBS = [
  'new',
  'list',
  'show',
  'assign',
  'link',
  'workspace',
  'comment',
  'unblock',
  'stop',
  'archive',
  'done',
  'block',
  'review',
  'approve',
  'changes',
] as const;
export type TaskVerb = (typeof TASK_VERBS)[number];

/** A command's name as a person types it: `/kanban task new`, `/kanban board use`, `/kanban gate add`. */
export function typed(verb: KanbanCommand['verb']): string {
  return (TASK_VERBS as readonly string[]).includes(verb) ? `/kanban task ${verb}` : `/kanban ${verb}`;
}

/** Each verb's usage line, as `/kanban help` shows it. */
export const USAGE = {
  help: '/kanban help',
  new: '/kanban task new <title>, then lines assignee:, reviewer:, workspace:, parent:, outcome:, verify:, constraints:, boundaries:, stop when:, and the body',
  list: `/kanban task list [${LIST_FILTERS.join('|')}]`,
  show: '/kanban task show <task>',
  assign: '/kanban task assign <task> <role or @person>',
  link: '/kanban task link <parent> <child>',
  workspace: '/kanban task workspace <task> <workspace>',
  comment: '/kanban task comment <task> <text>',
  unblock: '/kanban task unblock <task> [comment]',
  stop: '/kanban task stop <task>',
  archive: '/kanban task archive <task>',
  'gate add': '/kanban gate add <task> [--timeout <seconds>] <command>',
  'gate list': '/kanban gate list <task>',
  'gate remove': '/kanban gate remove <task> <gate>',
  done: '/kanban task done <task> [summary]',
  block: '/kanban task block <task> <reason>',
  review: '/kanban task review <task> [summary], and a line reviewer: <role or @person> unless the task names one',
  approve: '/kanban task approve <task> [comment]',
  changes: '/kanban task changes <task> <reason>',
  'board list': '/kanban board list [all]',
  'board create': '/kanban board create <name>',
  'board use': '/kanban board use <name>',
  'board set': '/kanban board set <name> max_running <number|none>, or workspace <workspace|none>',
  'board archive': '/kanban board archive <name>',
} as const;

/**
 * The lines of `/kanban task new` that fill a field (spec §9.1), by their label. A
 * label is matched at the start of a line, in any case, followed by a colon: a
 * body line that only mentions one, indented or mid-sentence, stays body.
 */
const FIELDS = {
  assignee: 'assignee',
  reviewer: 'reviewer',
  workspace: 'workspace',
  parent: 'parent',
  outcome: 'outcome',
  verify: 'verification',
  constraints: 'constraints',
  boundaries: 'boundaries',
  'stop when': 'stop_when',
} as const;
type FieldLabel = keyof typeof FIELDS;

/** Zero-width characters, which a paste from a rich editor can put where nobody sees them. */
const ZW = '\u200B-\u200D\u2060\uFEFF';

/** A field line; a zero-width character next to the colon is passed over, as the line start's is. */
const FIELD_LINE = new RegExp(
  `^(assignee|reviewer|workspace|parent|outcome|verify|constraints|boundaries|stop[ \\t]+when)[ \\t${ZW}]*:[ \\t${ZW}]*(.*)$`,
  'i',
);

/** Zero-width characters at the start of a line, after any indent. */
const LEADING_ZW = new RegExp(`^([ \\t]*)[${ZW}]+`, 'gm');

/** A word with zero-width characters in it: what comes before the first of them, and what follows them. */
const GROUP_ZW = new RegExp(`^([^${ZW}]*)[${ZW}]+([\\s\\S]*)$`);

/** Zero-width characters at the start of the text, after any spaces: before `task`'s verb, where they would hide it. */
const START_ZW = new RegExp(`^([ \\t]*)[${ZW}]+`);

/** `/kanban task review`'s reviewer line: its label at the start of a line, in any case, after any spaces, tabs or zero-width characters. */
const REVIEWER_LINE = new RegExp(`^[ \\t${ZW}]*reviewer[ \\t${ZW}]*:[ \\t${ZW}]*(.*)$`, 'i');

/**
 * A name that is a person, not a role: an @-mention, which Lark's text gives as
 * `@Name`, or a principal typed out. Roles are bare words (spec §9.1).
 */
export function isPerson(name: string): boolean {
  return name.startsWith('@') || name.toLowerCase().startsWith('lark:');
}

/**
 * A word as typed, to echo back: masked, then cut to `max` UTF-16 units with a
 * marker, on a character boundary, then escaped -- as `label` in
 * `chat-render.ts` does, which imports this module and so cannot be imported here.
 */
function echoed(word: string, max: number): string {
  const text = redactKnownSecrets(stripControl(word));
  if (text.length <= max) return forDisplay(text);
  return forDisplay(`${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`);
}

/**
 * `board set`'s setting and value, as typed, in chat or at a terminal (spec
 * §16.3): `max_running` a whole number from 1, or `none`; `workspace` a name, or
 * `none`, which the service checks. Undefined for anything else.
 */
export function boardSetting(setting: string, value: string): BoardSetting | undefined {
  const none = value.toLowerCase() === 'none';
  switch (setting.toLowerCase()) {
    case 'max_running': {
      const n = Number(value);
      if (!none && !(/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(n))) return undefined;
      return { maxRunning: none ? null : n };
    }
    case 'workspace':
      return { workspace: none ? null : value };
    default:
      return undefined;
  }
}

/**
 * What a new task may hold, from chat or a terminal: the limits a worker's `mt
 * kanban create` has (`WORKER_LIMITS`), so a task is the same size whoever made
 * it. Undefined when it fits; otherwise why not, with a contract field's name
 * given through `name`, which chat escapes.
 */
export function tooBig(
  task: { title: string; body: string; contract: Contract },
  name: (field: string) => string = (field) => field,
): string | undefined {
  const size = (text: string) => Buffer.byteLength(text, 'utf8');
  if (size(task.title) > WORKER_LIMITS.title) {
    return `A title is at most ${WORKER_LIMITS.title} bytes; put the rest in the body.`;
  }
  if (size(task.body) > WORKER_LIMITS.body) return `A body is at most ${WORKER_LIMITS.body} bytes.`;
  for (const [field, value] of Object.entries(task.contract)) {
    if (value !== undefined && size(value) > WORKER_LIMITS.contractField) {
      return `The contract's ${name(field)} is at most ${WORKER_LIMITS.contractField} bytes.`;
    }
  }
  return undefined;
}

function usage(verb: keyof typeof USAGE): ParsedKanban {
  return { ok: false, usage: `Usage: \`${USAGE[verb]}\`` };
}

/** The next word, and what follows it with the spaces after the word, and one line break, removed. */
function shift(text: string): [string, string] {
  const m = /^\s*(\S+)[ \t]*(?:\r?\n)?([\s\S]*)$/.exec(text);
  return m === null ? ['', ''] : [m[1] ?? '', m[2] ?? ''];
}

/** Exactly `n` words, or undefined. */
function words(text: string, n: number): string[] | undefined {
  const all = text.trim() === '' ? [] : text.trim().split(/\s+/);
  return all.length === n ? all : undefined;
}

/** What `/kanban task` says with no verb, or one it does not take. */
const TASK_TAKES = `\`/kanban task\` takes ${TASK_VERBS.slice(0, -1).join(', ')} or ${TASK_VERBS.at(-1)}. \`/kanban help\` lists them.`;

/**
 * Parse what follows `/kanban`: `help`, or a group, `task`, `board` or `gate`,
 * and its verb. The router gives the whole argument, newlines kept: `/kanban
 * task new` and `/kanban task comment` take several lines.
 */
export function parseKanban(arg: string): ParsedKanban {
  // One kind of line break from here on: a pasted CRLF, or a lone CR, is a newline.
  // And no zero-width character at a line's start, where it would hide a verb or a label.
  const [word, after] = shift(arg.replace(/\r\n?/g, '\n').replace(LEADING_ZW, '$1'));
  // A zero-width character joined to the group word ends it, as a space would: `task\u200bnew` is `task new`.
  const joined = GROUP_ZW.exec(word);
  const rawGroup = joined === null ? word : (joined[1] ?? '');
  const tail = joined === null ? '' : (joined[2] ?? '');
  const rest = tail === '' ? after : `${tail} ${after}`;
  switch (rawGroup.toLowerCase()) {
    case '':
    case 'help':
      return { ok: true, command: { verb: 'help' } };
    case 'task':
      return parseTask(rest);
    case 'gate':
      return parseGate(rest);
    case 'board':
      return parseBoard(rest);
    default:
      return { ok: false, usage: `Unknown \`/kanban\` command \`${echoed(rawGroup, 80)}\`. \`/kanban help\` lists them.` };
  }
}

/** `/kanban task <verb> …` (spec §9.1). */
function parseTask(text: string): ParsedKanban {
  const [rawVerb, rest] = shift(text.replace(START_ZW, '$1'));
  const verb = rawVerb.toLowerCase();
  switch (verb) {
    case 'new':
      return parseNew(rest);
    case 'list': {
      const w = words(rest, 0) ?? words(rest, 1);
      const filter = w?.[0]?.toLowerCase();
      if (w === undefined) return usage('list');
      if (filter === undefined) return { ok: true, command: { verb: 'list', filter: undefined } };
      const known = LIST_FILTERS.find((f) => f === filter);
      return known === undefined ? usage('list') : { ok: true, command: { verb: 'list', filter: known } };
    }
    case 'show':
    case 'stop':
    case 'archive': {
      const w = words(rest, 1);
      return w?.[0] === undefined ? usage(verb) : { ok: true, command: { verb, taskId: w[0] } };
    }
    case 'assign': {
      // A person's name may hold spaces (`@Alice Smith`): kept whole, for the refusal that names what arrives later.
      const [taskId, who] = shift(rest);
      if (taskId !== '' && isPerson(who.trim())) {
        return { ok: true, command: { verb: 'assign', taskId, assignee: who.trim() } };
      }
      const w = words(rest, 2);
      if (w?.[0] === undefined || w[1] === undefined) return usage('assign');
      return { ok: true, command: { verb: 'assign', taskId: w[0], assignee: w[1] } };
    }
    case 'link': {
      const w = words(rest, 2);
      if (w?.[0] === undefined || w[1] === undefined) return usage('link');
      return { ok: true, command: { verb: 'link', parentId: w[0], childId: w[1] } };
    }
    case 'workspace': {
      const w = words(rest, 2);
      if (w?.[0] === undefined || w[1] === undefined) return usage('workspace');
      return { ok: true, command: { verb: 'workspace', taskId: w[0], workspace: w[1] } };
    }
    case 'comment': {
      const [taskId, text] = shift(rest);
      if (taskId === '' || text.trim() === '') return usage('comment');
      return { ok: true, command: { verb: 'comment', taskId, text: text.trim() } };
    }
    case 'unblock': {
      const [taskId, text] = shift(rest);
      if (taskId === '') return usage('unblock');
      const comment = text.trim();
      return { ok: true, command: { verb: 'unblock', taskId, comment: comment === '' ? undefined : comment } };
    }
    case 'done':
    case 'approve': {
      // A person finishing, or approving, may say nothing more.
      const [taskId, text] = shift(rest);
      if (taskId === '') return usage(verb);
      return { ok: true, command: { verb, taskId, text: text.trim() } };
    }
    case 'block':
    case 'changes': {
      // A block, and changes, need a reason someone can act on.
      const [taskId, text] = shift(rest);
      if (taskId === '' || text.trim() === '') return usage(verb);
      return { ok: true, command: { verb, taskId, text: text.trim() } };
    }
    case 'review':
      return parseReview(rest);
    default:
      return { ok: false, usage: TASK_TAKES };
  }
}

/**
 * `/kanban task review <task>`, then the summary; a `reviewer:` line anywhere in it
 * names the reviewer, as on `/kanban task new`, since a name at the end of free text
 * could be the summary's last word. Given once, with a value.
 */
function parseReview(text: string): ParsedKanban {
  const [taskId, rest] = shift(text);
  if (taskId === '') return usage('review');
  let reviewer: string | undefined;
  const lines: string[] = [];
  for (const line of rest.split('\n')) {
    const m = REVIEWER_LINE.exec(line);
    if (m === null) {
      lines.push(line);
      continue;
    }
    const value = (m[1] ?? '').trim();
    if (value === '') return { ok: false, usage: '`reviewer:` needs a value.' };
    if (reviewer !== undefined) return { ok: false, usage: '`reviewer:` is given twice.' };
    reviewer = value;
  }
  const summary = lines.join('\n').trim();
  return { ok: true, command: { verb: 'review', taskId, summary, ...(reviewer === undefined ? {} : { reviewer }) } };
}

/**
 * `/kanban board list [all]`, `/kanban board create|use|archive <name>`, and
 * `/kanban board set <name>` with `max_running <number|none>` or
 * `workspace <workspace|none>` (spec §16).
 */
function parseBoard(text: string): ParsedKanban {
  const [rawSub, rest] = shift(text);
  const sub = rawSub.toLowerCase();
  if (sub === 'list') {
    const w = words(rest, 0) ?? words(rest, 1);
    const all = w?.[0]?.toLowerCase();
    if (w === undefined || (all !== undefined && all !== 'all')) return usage('board list');
    return { ok: true, command: { verb: 'board list', archived: all === 'all' } };
  }
  if (sub === 'create' || sub === 'use' || sub === 'archive') {
    const verb = `board ${sub}` as const;
    const w = words(rest, 1);
    return w?.[0] === undefined ? usage(verb) : { ok: true, command: { verb, board: w[0] } };
  }
  if (sub === 'set') {
    const [board, setting, value] = words(rest, 3) ?? [];
    if (board === undefined || setting === undefined || value === undefined) return usage('board set');
    const change = boardSetting(setting, value);
    return change === undefined ? usage('board set') : { ok: true, command: { verb: 'board set', board, change } };
  }
  const verbs = (['board list', 'board create', 'board use', 'board set', 'board archive'] as const).map((v) => `\`${USAGE[v]}\``);
  return { ok: false, usage: `Usage: ${verbs.join(', ')}` };
}

function parseGate(text: string): ParsedKanban {
  const [rawSub, rest] = shift(text);
  const sub = rawSub.toLowerCase();
  if (sub === 'list') {
    const w = words(rest, 1);
    return w?.[0] === undefined ? usage('gate list') : { ok: true, command: { verb: 'gate list', taskId: w[0] } };
  }
  if (sub === 'remove') {
    const w = words(rest, 2);
    const gateId = Number(w?.[1]);
    if (w?.[0] === undefined || !/^[1-9][0-9]*$/.test(w[1] ?? '') || !Number.isSafeInteger(gateId)) {
      return usage('gate remove');
    }
    return { ok: true, command: { verb: 'gate remove', taskId: w[0], gateId } };
  }
  if (sub !== 'add') return usage('gate add');
  const [taskId, after] = shift(rest);
  // `gate add --timeout 30 x`: the timeout where the task goes is no task id.
  if (taskId.startsWith('--')) return usage('gate add');
  let command = after;
  let timeoutS: number | undefined;
  const timed = /^[ \t]*--timeout(?:=|[ \t]+)(\S+)([\s\S]*)$/.exec(command);
  if (timed !== null) {
    if (!/^[1-9][0-9]*$/.test(timed[1] ?? '')) return usage('gate add');
    timeoutS = Number(timed[1]);
    command = (timed[2] ?? '').replace(/^[ \t]+/, '');
  }
  // `gate add k_1 -- npm test`, as the terminal's form is written: the `--` is
  // no part of the command. Only the first one: a later `--` is the command's.
  // It may stand on a line of its own, after the timeout's.
  const separated = /^\s*--(?:\s+|$)([\s\S]*)$/.exec(command);
  if (separated !== null) command = separated[1] ?? '';
  command = command.trim();
  // A timeout that could not be read, a second one, or one after the `--`, is not the start of a command.
  if (/^--timeout/i.test(command)) return usage('gate add');
  if (taskId === '' || command === '') return usage('gate add');
  return { ok: true, command: { verb: 'gate add', taskId, command, timeoutS } };
}

/**
 * `/kanban task new <title>`, then the field lines and the body, in any order
 * (spec §9.1). A field may be given once, `parent:` as often as needed, each
 * line one or more task ids.
 */
function parseNew(text: string): ParsedKanban {
  const [first = '', ...lines] = text.split('\n');
  const title = first.trim();
  if (title === '') return { ok: false, usage: `Put the title on the first line. Usage: \`${USAGE.new}\`` };
  if (FIELD_LINE.test(title)) {
    return { ok: false, usage: `The first line is the title, before any field line. Usage: \`${USAGE.new}\`` };
  }
  const seen = new Set<FieldLabel>();
  const out: NewTaskCommand = { verb: 'new', title, body: '', parents: [], contract: {} };
  const body: string[] = [];
  for (const line of lines) {
    const m = FIELD_LINE.exec(line);
    if (m === null) {
      body.push(line);
      continue;
    }
    const label = (m[1] ?? '').toLowerCase().replace(/[ \t]+/, ' ') as FieldLabel;
    const value = (m[2] ?? '').trim();
    if (value === '') return { ok: false, usage: `\`${label}:\` needs a value.` };
    if (label === 'parent') {
      const ids = value.split(/[\s,]+/).filter((id) => id !== '');
      if (ids.length === 0) return { ok: false, usage: '`parent:` needs a value.' };
      out.parents.push(...ids);
      continue;
    }
    if (seen.has(label)) return { ok: false, usage: `\`${label}:\` is given twice.` };
    seen.add(label);
    const field = FIELDS[label];
    if (field === 'assignee' || field === 'reviewer' || field === 'workspace') out[field] = value;
    else out.contract[field] = value;
  }
  out.body = body.join('\n').replace(/^\s*\n/, '').trimEnd();
  return { ok: true, command: out };
}
