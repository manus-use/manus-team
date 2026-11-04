import { forDisplay } from '../channel/escape.js';
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

/** The commands for people's own tasks, which arrive with people in plan D2. */
export const LATER_VERBS = ['done', 'block', 'review', 'approve', 'changes'] as const;
export type LaterVerb = (typeof LATER_VERBS)[number];

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
  | { verb: 'later'; name: LaterVerb };

export type ParsedKanban = { ok: true; command: KanbanCommand } | { ok: false; usage: string };

/** Each verb's usage line, as `/kanban help` shows it. */
export const USAGE = {
  new: '/kanban new <title>, then lines assignee:, reviewer:, workspace:, parent:, outcome:, verify:, constraints:, boundaries:, stop when:, and the body',
  list: `/kanban list [${LIST_FILTERS.join('|')}]`,
  show: '/kanban show <task>',
  assign: '/kanban assign <task> <role>',
  link: '/kanban link <parent> <child>',
  workspace: '/kanban workspace <task> <workspace>',
  comment: '/kanban comment <task> <text>',
  unblock: '/kanban unblock <task> [comment]',
  stop: '/kanban stop <task>',
  archive: '/kanban archive <task>',
  'gate add': '/kanban gate add <task> [--timeout <seconds>] <command>',
  'gate list': '/kanban gate list <task>',
  'gate remove': '/kanban gate remove <task> <gate>',
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

/**
 * A name that is a person, not a role: an @-mention, which Lark's text gives as
 * `@Name`, or a principal typed out. Roles are bare words (spec §9.1).
 */
export function isPerson(name: string): boolean {
  return name.startsWith('@') || name.toLowerCase().startsWith('lark:');
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
    default: {
      const later = LATER_VERBS.find((v) => v === verb);
      if (later !== undefined) return { ok: true, command: { verb: 'later', name: later } };
      return { ok: false, usage: `Unknown \`/kanban\` command \`${forDisplay(rawVerb)}\`. \`/kanban help\` lists them.` };
    }
  }
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
