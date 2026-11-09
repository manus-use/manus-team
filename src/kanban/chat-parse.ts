import { forDisplay } from '../channel/escape.js';
import { redactKnownSecrets } from '../secrets.js';
import { stripControl } from '../text.js';
import type { DisplayStatus } from './status.js';
import type { Contract } from './types.js';

/**
 * `/kanban` as typed in chat (spec §9.1), parsed into what to do. Pure: no
 * board, no tiers, no identity -- those are `KanbanChat`'s. A parse that fails
 * carries the usage line to show, already escaped.
 */

/** The display statuses `/kanban list` can filter by, and `all`. */
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

/** `/kanban review`: the assignee asks for same-task review (spec §5.3), naming a reviewer on a `reviewer:` line, or not. */
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

/** `/kanban board …` (spec §16): a board's name as typed, which the service checks. */
export type BoardCommand =
  | { verb: 'board create' | 'board use' | 'board archive'; board: string }
  | { verb: 'board set'; board: string; change: { maxRunning?: number | null; workspace?: string | null } };

export type ParsedKanban = { ok: true; command: KanbanCommand } | { ok: false; usage: string };

/** Each verb's usage line, as `/kanban help` shows it. */
export const USAGE = {
  new: '/kanban new <title>, then lines assignee:, reviewer:, workspace:, parent:, outcome:, verify:, constraints:, boundaries:, stop when:, and the body',
  list: `/kanban list [${LIST_FILTERS.join('|')}]`,
  show: '/kanban show <task>',
  assign: '/kanban assign <task> <role or @person>',
  link: '/kanban link <parent> <child>',
  workspace: '/kanban workspace <task> <workspace>',
  comment: '/kanban comment <task> <text>',
  unblock: '/kanban unblock <task> [comment]',
  stop: '/kanban stop <task>',
  archive: '/kanban archive <task>',
  'gate add': '/kanban gate add <task> [--timeout <seconds>] <command>',
  'gate list': '/kanban gate list <task>',
  'gate remove': '/kanban gate remove <task> <gate>',
  done: '/kanban done <task> [summary]',
  block: '/kanban block <task> <reason>',
  review: '/kanban review <task> [summary], and a line reviewer: <role or @person> unless the task names one',
  approve: '/kanban approve <task> [comment]',
  changes: '/kanban changes <task> <reason>',
  'board list': '/kanban board list [all]',
  'board create': '/kanban board create <name>',
  'board use': '/kanban board use <name>',
  'board set': '/kanban board set <name> max_running <number|none>, or workspace <workspace|none>',
  'board archive': '/kanban board archive <name>',
} as const;

/**
 * The lines of `/kanban new` that fill a field (spec §9.1), by their label. A
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

/** `/kanban review`'s reviewer line: its label at the start of a line, in any case, after any spaces, tabs or zero-width characters. */
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

/**
 * Parse what follows `/kanban`. The router gives the whole argument, newlines
 * kept: `/kanban new` and `/kanban comment` take several lines.
 */
export function parseKanban(arg: string): ParsedKanban {
  // One kind of line break from here on: a pasted CRLF, or a lone CR, is a newline.
  // And no zero-width character at a line's start, where it would hide a verb or a label.
  const [rawVerb, rest] = shift(arg.replace(/\r\n?/g, '\n').replace(LEADING_ZW, '$1'));
  const verb = rawVerb.toLowerCase();
  switch (verb) {
    case '':
    case 'help':
      return { ok: true, command: { verb: 'help' } };
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
    case 'gate':
      return parseGate(rest);
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
    case 'board':
      return parseBoard(rest);
    default:
      return { ok: false, usage: `Unknown \`/kanban\` command \`${echoed(rawVerb, 80)}\`. \`/kanban help\` lists them.` };
  }
}

/**
 * `/kanban review <task>`, then the summary; a `reviewer:` line anywhere in it
 * names the reviewer, as on `/kanban new`, since a name at the end of free text
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
    const none = value.toLowerCase() === 'none';
    switch (setting.toLowerCase()) {
      case 'max_running': {
        const n = Number(value);
        if (!none && !(/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(n))) return usage('board set');
        return { ok: true, command: { verb: 'board set', board, change: { maxRunning: none ? null : n } } };
      }
      case 'workspace':
        return { ok: true, command: { verb: 'board set', board, change: { workspace: none ? null : value } } };
      default:
        return usage('board set');
    }
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
  command = command.trim();
  // A timeout that could not be read, or a second one, is not the start of a command.
  if (/^--timeout/i.test(command)) return usage('gate add');
  if (taskId === '' || command === '') return usage('gate add');
  return { ok: true, command: { verb: 'gate add', taskId, command, timeoutS } };
}

/**
 * `/kanban new <title>`, then the field lines and the body, in any order
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
