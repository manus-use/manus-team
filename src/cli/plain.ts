import type { BoardEntry, BoardSummary, TaskView } from '../db/kanban-read.js';
import { counted, listed, runState, waitingLine } from '../kanban/chat-render.js';
import type { DisplayStatus } from '../kanban/status.js';
import type { Assignee, GateRow } from '../kanban/types.js';
import { redactKnownSecrets } from '../secrets.js';
import { INVISIBLE, stripControl } from '../text.js';
import { table } from './args.js';

/**
 * What the operator's `mt kanban` prints (spec §2.6): the board as chat shows it
 * (`chat-render.ts`), as plain text for a terminal rather than Lark markdown.
 * Which tasks a list shows, in what order, and how a board's tasks are counted
 * are chat's own functions, so the two never disagree.
 *
 * Every piece is stripped of control characters and of the characters that
 * show nothing (`INVISIBLE`: the bidi controls, the zero-width characters and
 * the direction marks), then masked: a task's text is untrusted, an escape
 * sequence in a title would drive the terminal, an override would make a line
 * read as something it is not, and a secret split by any of them would read
 * whole on screen. Nothing is escaped, since a terminal renders no markdown.
 */

const LOW_SURROGATE = /^[\uDC00-\uDFFF]/;

/** Stripped, then masked, with every line break a newline: CR, CRLF, U+2028 and U+2029. */
function clean(text: string): string {
  return redactKnownSecrets(stripControl(text).replace(INVISIBLE, '')).replace(/\r\n?|[\u2028\u2029]/g, '\n');
}

/** The first `max` UTF-16 units at most, with `marker` when anything was cut, on a character boundary. */
function cut(text: string, max: number, marker: string): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - marker.length)).replace(/[\uD800-\uDBFF]$/, '') + marker;
}

/** One line: masked, its spaces collapsed, cut with a marker. */
export function line(text: string, max = 200): string {
  return cut(clean(text).replace(/\s+/g, ' ').trim(), max, '…');
}

/** Free text from its start, indented under its label. */
function indented(text: string, max: number, by = '    '): string[] {
  return cut(clean(text).trim(), max, '\n… (truncated)')
    .split('\n')
    .map((l) => `${by}${l}`.trimEnd());
}

/** Free text from its end, as an agent's output is read: masked whole, then its last `max` characters. */
function tailOf(text: string, max: number): string[] {
  const whole = clean(text).trim();
  const kept = whole.length <= max ? whole : `… (earlier output cut)\n${whole.slice(-max).replace(LOW_SURROGATE, '').trimStart()}`;
  return kept.split('\n').map((l) => `    ${l}`.trimEnd());
}

export function who(a: Assignee | null): string {
  if (a === null) return 'nobody';
  return a.kind === 'role' ? `role ${line(a.name, 80)}` : line(a.name, 80);
}

/** `mt kanban board list` (spec §16.3): each board, its tasks by phase, and its own settings. */
export function boardsText(summaries: readonly BoardSummary[]): string[] {
  return summaries.map((s) => {
    const b = s.board;
    const settings = [
      ...(b.maxRunning === null ? [] : [`max_running ${b.maxRunning}`]),
      ...(b.workspace === null ? [] : [`workspace ${line(b.workspace, 80)}`]),
    ];
    const archived = b.archivedAt === null ? '' : ' (archived)';
    return `${line(b.name, 80)}${archived}: ${counted(s)}${settings.map((x) => ` · ${x}`).join('')}`;
  });
}

/** `mt kanban task list` (spec §9.1): one board's tasks, as chat lists them, every one rather than the first 30. */
export function listText(
  entries: readonly BoardEntry[],
  filter: DisplayStatus | 'all' | undefined,
  board: string,
): string[] {
  const shown = listed(entries, filter);
  const on = `on board ${line(board, 80)}`;
  if (shown.length === 0) {
    return [
      filter === undefined
        ? `no open tasks ${on}; mt kanban task list all shows done and archived ones too`
        : `no ${filter === 'all' ? '' : `${filter} `}tasks ${on}`,
    ];
  }
  const rows = shown.map((e) => [e.task.taskId, e.status, who(e.task.assignee), line(e.task.title, 120)]);
  return table([['task', 'status', 'assignee', 'title'], ...rows]);
}

/** `mt kanban task show` (spec §9.1): what chat's shows, the task's board always named. */
export function showText(view: TaskView, gates: readonly GateRow[]): string[] {
  const { task } = view;
  const out: string[] = [
    `${line(task.title)} (${task.taskId}): ${view.status}`,
    `assignee: ${who(task.assignee)} · reviewer: ${who(task.reviewer)} · workspace: ${task.workspace === null ? 'not yet fixed' : line(task.workspace, 80)} · board: ${line(task.board, 80)}`,
  ];
  for (const w of view.waiting ?? []) out.push(waitingLine(w, (t) => line(t, 80)));
  if (task.phase === 'blocked' && task.blockKind !== null) {
    out.push(`blocked (${task.blockKind}): ${line(task.blockReason ?? '', 500)}`);
  }
  if (view.parents.length > 0) out.push(`parents: ${view.parents.map((p) => `${p.taskId} (${view.statuses.get(p.taskId) ?? p.phase})`).join(', ')}`);
  if (view.children.length > 0) out.push(`children: ${view.children.map((c) => `${c.taskId} (${view.statuses.get(c.taskId) ?? c.phase})`).join(', ')}`);
  if (task.body.trim() !== '') out.push('', ...indented(task.body, 4000), '');
  const contract = Object.entries(task.contract).filter(([, v]) => v !== undefined && v.trim() !== '');
  if (contract.length > 0) {
    out.push('contract:');
    for (const [field, value] of contract) out.push(`  ${field}: ${line(value ?? '', 400)}`);
  }
  if (gates.length > 0) {
    out.push('gates:');
    for (const g of gates) out.push(`  ${g.id}. ${line(g.command, 300)} (${g.timeoutS} s, by ${line(g.createdBy, 80)})`);
  }
  if (view.runs.length > 0) {
    out.push('runs:');
    for (const run of view.runs.slice(-5)) {
      const said = run.summary ?? run.error;
      const head = `  #${run.attempt} ${run.kind} · ${who(run.assignee)} · ${runState(run)}`;
      out.push(said === null || said === '' ? head : `${head}: ${line(said, 300)}`);
    }
    const output = view.runs.at(-1)?.lastOutput ?? null;
    if (output !== null && output.trim() !== '') out.push('latest output:', ...tailOf(output, 2000));
  }
  if (view.comments.length > 0) {
    const shown = view.comments.slice(-5);
    out.push(`comments (${shown.length} of ${view.comments.length}):`);
    for (const c of shown) out.push(`  ${line(c.author, 80)}:`, ...indented(c.body, 1000));
  }
  return out;
}
