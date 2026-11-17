import type { BoardEntry, BoardSummary, TaskView } from '../db/kanban-read.js';
import { counted, listed, memberLine, membersDone, runState, waitingLine, workdirLine, type PreviewLine } from '../kanban/chat-render.js';
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

/** `mt kanban people` (kanban spec §22.2): each person this bot has seen, by name, with their principal and talk tier. */
export function peopleText(seen: readonly { unionId: string; name: string | null; talk: boolean }[]): string[] {
  if (seen.length === 0) return ['no people yet: the gateway learns a person once they have used /kanban, or been @-mentioned in it'];
  const rows = seen.map((p) => [p.name === null ? '(no name)' : line(p.name, 80), `lark:${line(p.unionId, 80)}`, p.talk ? 'talk' : 'no']);
  return table([['name', 'person', 'talk'], ...rows]);
}

/** `mt kanban task show` (spec §9.1): what chat's shows, the task's board always named. */
export function showText(view: TaskView, gates: readonly GateRow[]): string[] {
  const { task } = view;
  const out: string[] = [
    `${line(task.title)} (${task.taskId}): ${view.status}`,
    `assignee: ${who(task.assignee)} · reviewer: ${who(task.reviewer)} · workspace: ${task.workspace === null ? 'not yet fixed' : line(task.workspace, 80)} · board: ${line(task.board, 80)}`,
  ];
  if (view.member !== undefined) out.push(memberLine(view.member, (t) => line(t, 200)));
  for (const w of view.waiting ?? []) out.push(waitingLine(w, (t) => line(t, 80)));
  if (task.phase === 'blocked' && task.blockKind !== null) {
    out.push(`blocked (${task.blockKind}): ${line(task.blockReason ?? '', 500)}`);
  }
  if (view.parents.length > 0) out.push(`parents: ${view.parents.map((p) => `${p.taskId} (${view.statuses.get(p.taskId) ?? p.phase})`).join(', ')}`);
  if (view.children.length > 0) out.push(`children: ${view.children.map((c) => `${c.taskId} (${view.statuses.get(c.taskId) ?? c.phase})`).join(', ')}`);
  if (view.workdir !== undefined) out.push(workdirLine(view.workdir, (t) => line(t, 4096)));
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

// ---------------------------------------------------------------------------
// Workflows (workflows spec §6, §10)
// ---------------------------------------------------------------------------

/** A role or a person, as a DAG names them. */
function named(name: string | null): string {
  if (name === null) return 'nobody';
  return name.includes(':') ? line(name, 80) : `role ${line(name, 80)}`;
}

/**
 * `mt kanban workflow preview` (workflows spec §6): what a start would make, as chat's
 * preview says it, a line a task with its ref, its title, its assignee, its
 * parents' refs and how many gates it has, and that nothing was made.
 */
export function previewText(name: string, board: string, lines: readonly PreviewLine[]): string[] {
  const n = lines.length;
  const rows = lines.map((t) => [
    line(t.ref, 64),
    line(t.title, 120),
    named(t.assignee),
    t.parents.length === 0 ? '' : `after ${t.parents.map((p) => line(p, 64)).join(', ')}`,
    t.gates === 0 ? '' : `${t.gates} gate${t.gates === 1 ? '' : 's'}`,
  ]);
  return [
    `${line(name, 80)} would make ${n} task${n === 1 ? '' : 's'}, on board ${line(board, 80)}:`,
    ...table(rows).map((r) => `  ${r}`),
    `nothing was made: mt kanban workflow start ${line(name, 80)}, with these params, makes it`,
  ];
}

/** A start's or an apply's answer (workflows spec §6): the instance, then every task, uncut, with its ref, title and assignee. */
export function madeText(
  made: { instance: { instanceId: string; name: string | null; board: string; source: string }; tasks: readonly { taskId: string; ref: string; task: { title: string; assignee: Assignee | null } }[]; existing: boolean },
): string[] {
  const { instance } = made;
  const n = made.tasks.length;
  const what = instance.source === 'start' ? `started ${line(instance.name ?? '', 80)}` : instance.name === null ? 'applied a DAG with no workflow' : `applied ${line(instance.name, 80)}`;
  const head = made.existing
    ? `already made, as ${instance.instanceId}, on board ${line(instance.board, 80)}, ${n} task${n === 1 ? '' : 's'}; nothing new was made`
    : `${what} as ${instance.instanceId}, on board ${line(instance.board, 80)}, ${n} task${n === 1 ? '' : 's'}`;
  const rows = made.tasks.map((t) => [t.taskId, line(t.ref, 64), line(t.task.title, 200), who(t.task.assignee)]);
  return [head, ...table(rows).map((r) => `  ${r}`)];
}

/** `apply --dry-run`'s answer (workflows spec §6): what the apply would make, a line a task in preview's columns, each followed by its gates' commands, masked; or the instance its key made. */
export function dryRunText(
  dry: { existing: boolean; instanceId: string | null; board: string; tasks: readonly { ref: string; title: string; assignee: string | null; parents: readonly string[]; gates: readonly { command: string; timeout_s: number }[] }[] },
): string[] {
  if (dry.existing) return [`already made, as ${dry.instanceId ?? ''}: the apply would make nothing new`];
  const tasks = dry.tasks.length;
  const links = dry.tasks.reduce((sum, t) => sum + t.parents.length, 0);
  const gates = dry.tasks.reduce((sum, t) => sum + t.gates.length, 0);
  const s = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const out = [`would make ${s(tasks, 'task')}, ${s(links, 'link')}, ${s(gates, 'gate')}, on board ${line(dry.board, 80)}; nothing was made`];
  // The columns are preview's, aligned over every task, each task's gates' commands below it.
  const rows = table(
    dry.tasks.map((t) => [
      line(t.ref, 64),
      line(t.title, 200),
      named(t.assignee),
      t.parents.length === 0 ? '' : `after ${t.parents.map((p) => line(p, 64)).join(', ')}`,
      t.gates.length === 0 ? '' : s(t.gates.length, 'gate'),
    ]),
  );
  for (const [i, t] of dry.tasks.entries()) {
    out.push(`  ${rows[i] ?? ''}`);
    for (const g of t.gates) out.push(`    gate: ${line(g.command, 4096)} (up to ${g.timeout_s} s)`);
  }
  return out;
}

/** `mt kanban workflow list` (workflows spec §10): every usable workflow with its params and description, and each broken one with why. */
export function workflowsText(
  list: { usable: readonly { name: string; description: string | undefined }[]; broken: readonly { name: string; problem: string }[] },
  params: (name: string) => string,
): string[] {
  const rows = [
    ...list.usable.map((w) => ({ name: w.name, text: `${line(w.name, 80)}: params ${line(params(w.name), 400)}${w.description === undefined ? '' : ` · ${line(w.description, 200)}`}` })),
    ...list.broken.map((b) => ({ name: b.name, text: `${line(b.name, 80)}: not usable: ${line(b.problem, 600)}` })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows.length === 0 ? ['no workflows: a workflow is a file, $MT_HOME/workflows/<name>.yaml'] : rows.map((r) => r.text);
}

/** A time as a terminal line says it, to the minute, in UTC. */
function when(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `mt kanban workflow instances [all]` (workflows spec §10): a board's instances, newest first, every one rather than 30. */
export function instancesText(
  summaries: readonly { instance: { instanceId: string; name: string | null; createdBy: string; createdAt: number }; status: string; done: number; total: number; blocked: number }[],
  opts: { board: string; all: boolean; total: number; read: number },
): string[] {
  const on = `on board ${line(opts.board, 80)}`;
  const past = opts.total > opts.read ? [`only the ${opts.read} newest are read; an older instance is shown by its id, with mt kanban workflow show`] : [];
  if (summaries.length === 0) {
    return [opts.all ? `no workflow instances ${on}` : `no running or blocked workflow instances ${on}; mt kanban workflow instances all shows done and archived ones too`, ...past];
  }
  const rows = summaries.map((s) => [
    s.instance.instanceId,
    line(s.instance.name ?? '(no workflow)', 80),
    s.status === 'blocked' ? `blocked (${s.blocked})` : s.status,
    membersDone(s),
    line(s.instance.createdBy, 80),
    when(s.instance.createdAt),
  ]);
  return [...table([['instance', 'workflow', 'status', 'members', 'by', 'when'], ...rows]), ...past];
}

/** `mt kanban workflow show` (workflows spec §10): the instance, every member by step, and its related tasks apart, uncut. */
export function instanceText(view: {
  instance: { instanceId: string; name: string | null; board: string; createdBy: string; createdVia: { kind: string }; createdAt: number; dag: { params: Readonly<Record<string, string | readonly string[]>> } };
  description: string | undefined;
  members: readonly { step: string; item: string | null; task: { taskId: string; phase: string; blockKind: string | null; blockReason: string | null; assignee: Assignee | null; createdFromTask: string | null }; status: string }[];
  related: readonly { task: { taskId: string; title: string }; status: string }[];
  relatedInstances: readonly { instanceId: string; name: string | null; tasks: number }[];
  status: string;
  done: number;
  total: number;
  blocked: number;
}): string[] {
  const { instance } = view;
  const how =
    instance.createdVia.kind === 'chat'
      ? 'in chat'
      : instance.createdVia.kind === 'operator'
        ? 'at the terminal'
        : `by a run of ${view.members[0]?.task.createdFromTask ?? 'a task'}`;
  const out = [
    `${line(instance.name ?? '(no workflow)', 80)} (${instance.instanceId}): ${view.status === 'blocked' ? `blocked (${view.blocked})` : view.status}, ${membersDone(view)}, on board ${line(instance.board, 80)}`,
    ...(view.description === undefined ? [] : [line(view.description, 400)]),
    `started by ${line(instance.createdBy, 80)}, ${how}, ${when(instance.createdAt)}`,
  ];
  const params = Object.entries(instance.dag.params);
  if (params.length > 0) out.push(`params: ${params.map(([k, v]) => `${line(k, 40)}: ${line(typeof v === 'string' ? v : v.join(', '), 400)}`).join(' · ')}`);
  let step: string | undefined;
  for (const m of view.members) {
    if (m.step !== step) {
      step = m.step;
      out.push(`${line(m.step, 64)}:`);
    }
    const item = m.item === null ? '' : ` ${line(m.item, 200)}:`;
    const why = m.task.phase === 'blocked' && m.task.blockKind !== null ? ` (${m.task.blockKind}): ${line(m.task.blockReason ?? '', 500)}` : '';
    out.push(`  ${m.task.taskId}${item} ${m.status}${why} · ${who(m.task.assignee)}`);
  }
  if (view.related.length > 0 || view.relatedInstances.length > 0) {
    out.push('related, not members:');
    for (const r of view.related) out.push(`  ${r.task.taskId} ${line(r.task.title, 200)}: ${r.status}`);
    for (const o of view.relatedInstances) out.push(`  ${o.instanceId} ${line(o.name ?? '(no workflow)', 80)}, ${o.tasks} task${o.tasks === 1 ? '' : 's'}`);
  }
  return out;
}
