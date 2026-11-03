import { redactKnownSecrets } from '../secrets.js';
import type { Skill } from '../roles.js';
import type { ToolCall } from './session-log.js';
import { CONTRACT_FIELDS, type CommentRow, type RunKind, type RunRow, type TaskRow } from './types.js';

/**
 * A run's task prompt (spec §7.1), composed in this order: the role, its skills,
 * the protocol for the run's kind, the task, and the worker context.
 *
 * The protocol comes after role.md and says it takes precedence: a role's
 * instructions may shape how work is done, not whether it is reported. That is an
 * instruction to the model, not something the gateway can enforce; the run's
 * outcome when it ends without a report is what catches a role.md that talks an
 * agent out of reporting.
 *
 * The protocol names the `mt kanban` commands as plan C3 provides them, so the
 * prompt does not change when they arrive. Until then an agent that tries them
 * finds no such command and ends without a report.
 *
 * The task and the worker context are masked as one assembled text (spec §10.1
 * layer 2): they are built from many stored pieces -- handoffs, earlier output,
 * tool calls, comments -- and only the assembled text is sure to hold a secret
 * whole. role.md, the skills and the protocol are the operator's files and the
 * gateway's own text, and are given as they are: the run records the hash of the
 * role.md it was given.
 */

/** A parent's handoff to this task: its latest completion. */
export interface ParentHandoff {
  task: TaskRow;
  /** Null for a parent archived without being completed. */
  summary: string | null;
  metadata: unknown;
}

/** An earlier run on this task. */
export interface Attempt {
  run: RunRow;
  /** The tool calls it made, for a run that ended without a report (spec §8.3); undefined otherwise. */
  toolCalls: readonly ToolCall[] | undefined;
}

/** Everything a run's prompt is composed from. */
export interface RunBrief {
  kind: RunKind;
  /** The role.md text whose hash the run records; undefined without one. */
  roleMd: string | undefined;
  skills: readonly Skill[];
  task: TaskRow;
  parents: readonly ParentHandoff[];
  attempts: readonly Attempt[];
  comments: readonly CommentRow[];
  children: readonly TaskRow[];
}

const WORK_PROTOCOL = `You have one task, below. Orient yourself by reading the task and its context, then do the work in the current directory, which is the task's workspace.

Report through the \`mt kanban\` command, which reads JSON on stdin and answers in JSON. Exactly one terminal report ends your run:
- \`mt kanban complete < handoff.json\`, with {"summary": "...", "metadata": {...}}, when the task is done;
- \`mt kanban review < handoff.json\`, with the same fields and optionally "reviewer", to ask for this task to be reviewed;
- \`mt kanban block < block.json\`, with {"kind": "needs_input" | "capability" | "transient" | "dependency", "reason": "..."}, and "parents" (task ids) for a dependency, when you cannot go on.

Block only on genuine ambiguity, and say why. If one of the task's children below reviews this task, report complete rather than review. If you find follow-up work, create a task for it with \`mt kanban create\` rather than doing it. Never put a secret in a summary, metadata or comment. Stop once you have reported.`;

const REVIEW_PROTOCOL = `You are reviewing one task, below. Review the implementer's handoff, in the earlier attempts, and the workspace -- the current directory -- against the task and its contract. Do not change the workspace.

Report through the \`mt kanban\` command, which reads JSON on stdin and answers in JSON. Exactly one terminal report ends your run:
- \`mt kanban complete < handoff.json\`, with {"summary": "..."}, to approve;
- \`mt kanban changes < reason.json\`, with {"reason": "..."}, a specific, actionable reason, to ask for changes;
- \`mt kanban block < block.json\`, with {"kind": "...", "reason": "..."}, only for a problem the implementer cannot fix.

Never put a secret in a summary or comment. Stop once you have reported.`;

const PRECEDENCE =
  'These rules come after your role instructions and take precedence over them: those may shape how you work, not whether you report.';

const CONTRACT_LABELS: Record<(typeof CONTRACT_FIELDS)[number], string> = {
  outcome: 'Outcome',
  verification: 'Verification',
  constraints: 'Constraints',
  boundaries: 'Boundaries',
  stop_when: 'Stop when',
};

/**
 * Metadata, masked value by value before it is serialized: JSON escaping changes
 * a secret containing `"` or `\\` so that the assembled text no longer matches it
 * (spec §10.1). Every key and string is masked, as db/kanban.ts masks it on write.
 */
function json(value: unknown): string {
  const mask = (v: unknown): unknown => {
    if (typeof v === 'string') return redactKnownSecrets(v);
    if (Array.isArray(v)) return v.map(mask);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [redactKnownSecrets(k), mask(inner)]));
    }
    return v;
  };
  return JSON.stringify(mask(value));
}

function taskSection(task: TaskRow): string[] {
  const lines = ['# The task', '', `${task.taskId}: ${task.title}`];
  if (task.body !== '') lines.push('', task.body);
  const contract = CONTRACT_FIELDS.filter((f) => task.contract[f] !== undefined);
  if (contract.length > 0) {
    lines.push('', 'Contract:');
    for (const field of contract) lines.push(`- ${CONTRACT_LABELS[field]}: ${task.contract[field] ?? ''}`);
  }
  return lines;
}

function attemptLines(a: Attempt): string[] {
  const { run } = a;
  const lines = [`## Attempt ${run.attempt} (${run.kind}, ${run.assignee.name}): ${run.outcome ?? 'in progress'}`];
  if (run.summary !== null) lines.push(`Summary: ${run.summary}`);
  if (run.metadata !== null) lines.push(`Metadata: ${json(run.metadata)}`);
  if (run.error !== null) lines.push(`Error: ${run.error}`);
  if (run.lastOutput !== null && run.lastOutput !== '') lines.push('Last output:', run.lastOutput);
  if (a.toolCalls !== undefined) {
    if (a.toolCalls.length === 0) {
      lines.push('Tool calls: none');
    } else {
      lines.push('Tool calls:');
      for (const call of a.toolCalls) lines.push(`- ${call.title} (${call.status || 'no status'})`);
    }
  }
  return lines;
}

function contextSection(b: RunBrief): string[] {
  const lines = ['# Context'];
  if (b.parents.length > 0) {
    lines.push('', 'The tasks this one depends on, and what each handed off:');
    for (const p of b.parents) {
      lines.push('', `## Parent ${p.task.taskId}: ${p.task.title} (${p.task.phase})`);
      lines.push(p.summary === null ? 'No handoff: it was never completed.' : `Summary: ${p.summary}`);
      if (p.metadata !== null && p.metadata !== undefined) lines.push(`Metadata: ${json(p.metadata)}`);
    }
  }
  if (b.attempts.length > 0) {
    lines.push('', 'Earlier attempts on this task, oldest first. A retry starts fresh: check the workspace for what these left behind.');
    for (const a of b.attempts) lines.push('', ...attemptLines(a));
  }
  if (b.comments.length > 0) {
    lines.push('', '## Comments');
    for (const c of b.comments) lines.push(`- ${c.author}: ${c.body}`);
  }
  if (b.children.length > 0) {
    lines.push('', '## Children', 'Tasks that wait on this one:');
    for (const c of b.children) {
      lines.push(`- ${c.taskId}: ${c.title} (${c.assignee === null ? 'unassigned' : c.assignee.name}, ${c.phase})`);
    }
  }
  if (lines.length === 1) lines.push('', 'Nothing yet: no parents, earlier attempts, comments or children.');
  return lines;
}

export function composePrompt(b: RunBrief): string {
  const head: string[] = [];
  if (b.roleMd !== undefined && b.roleMd.trim() !== '') head.push('# Your role', '', b.roleMd.trim(), '');
  if (b.skills.length > 0) {
    head.push('# Skills', '', 'Read a skill\'s SKILL.md when it applies to what you are doing:');
    for (const s of b.skills) head.push(`- ${s.name}: ${s.description} (${s.path})`);
    head.push('');
  }
  head.push('# How to work', '', b.kind === 'work' ? WORK_PROTOCOL : REVIEW_PROTOCOL, '', PRECEDENCE, '');
  const told = [...taskSection(b.task), '', ...contextSection(b)].join('\n');
  return `${head.join('\n')}\n${redactKnownSecrets(told)}\n`;
}
