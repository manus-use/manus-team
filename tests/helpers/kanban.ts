import type { Db } from '../../src/db/open.js';
import { claim, createTask, type Claimant, type NewTask } from '../../src/db/kanban.js';
import { getTask } from '../../src/db/kanban-read.js';
import type { AgentSnapshot, CreatedVia, RunRow, TaskRow } from '../../src/kanban/types.js';

/** Building blocks for tests of the board: real rows, written through db/kanban.ts. */

export const NOW = 1_760_000_000_000;

export const VIA: CreatedVia = {
  kind: 'chat',
  channel: 'lark',
  appId: 'cli_app',
  conversationId: 'oc_chat',
  threadId: '',
};

export const AGENT: AgentSnapshot = {
  driver: 'structured-cli',
  command: 'bytesec',
  args: ['run', '-m', 'model-a'],
  unsupervised: true,
  envNames: ['API_KEY'],
};

export const WORKSPACES: ReadonlySet<string> = new Set(['default', 'web', 'api', 'docs']);

export const ALICE = 'lark:on_alice';

export function newTask(db: Db, t: Partial<NewTask> = {}, now = NOW): TaskRow {
  const r = createTask(
    db,
    { title: 'a task', assignee: { kind: 'role', name: 'implementer' }, createdBy: ALICE, createdVia: VIA, ...t },
    now,
  );
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.task;
}

/** The claimant for the task's next claim: its assignee in open, its reviewer in review. */
export function claimantFor(db: Db, taskId: string, extra: Partial<Claimant> = {}): Claimant {
  const task = getTask(db, taskId);
  const who = task?.phase === 'review' ? task.reviewer : task?.assignee;
  if (who === null || who === undefined) throw new Error(`task ${taskId} has nobody to claim it`);
  return {
    assignee: who,
    agentConfig: who.kind === 'role' ? AGENT : null,
    roleWorkspace: undefined,
    roleMdHash: who.kind === 'role' ? 'hash-of-role-md' : null,
    ...extra,
  };
}

export function claimed(db: Db, taskId: string, extra: Partial<Claimant> = {}, now = NOW): RunRow {
  const r = claim(db, { taskId, claimant: claimantFor(db, taskId, extra), workspaces: WORKSPACES }, now);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.run;
}
