import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadTeamSettings, type Env } from '../config.js';
import { readGatewayEnv, withGatewayEnv } from '../gateway-env.js';
import { nameProblem } from '../names.js';
import { listWorkflows, paramsLine, readWorkflow, type Workflow, type WorkflowFacts, type WorkflowList } from '../kanban/workflow.js';
import { addSecrets, redactKnownSecrets } from '../secrets.js';
import { loadTeam, teamSecrets } from '../team.js';
import { refuse } from './args.js';
import { inAgentRun } from './gate.js';
import type { MtIo } from './mt.js';

/**
 * `mt workflow check [<name>]` (spec §2.6, workflows spec §4): a workflow file's checks,
 * without starting it. It reads files only, and needs no authority, so it works
 * in any shell, a board run's included; it opens no database. It finds the home,
 * the config and the roles as the gateway does, this shell's environment over
 * the gateway's .env, and registers the secrets the gateway would, so a gate
 * holding one is refused here as at a start.
 *
 * Exit 0 when every workflow checked is usable, 1 otherwise, and 2 for a wrong
 * command line.
 */

/** True only when the file is certainly missing; one whose lstat fails is read, and its read says why. */
function noFile(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

function okLine(w: Workflow): string {
  const board = w.board === undefined ? '' : `; board ${w.board}`;
  return `${w.name}: ok, ${w.steps.length} step${w.steps.length === 1 ? '' : 's'}; params: ${paramsLine(w)}${board}`;
}

/** Said once when a workflow checked names a board, which this check, opening no database, cannot see (workflows spec §19.4). */
export const BOARDS_NOTE = 'note: the gateway checks the board when the workflow is used, not here: this check opens no database';

export function workflowCheck(only: string | undefined, io: MtIo): number {
  // As roleCheck reads it (spec §2.6): never the gateway's .env in an agent's shell.
  const run = inAgentRun(io.env);
  let env: Env = io.env;
  const unset: string[] = [];
  let facts: WorkflowFacts;
  let dir: string;
  try {
    if (!run) env = withGatewayEnv(io.env, readGatewayEnv(io.env));
    const settings = loadTeamSettings(env, undefined, { unsetPassEnv: unset });
    const team = loadTeam(settings, env, { unsetPassEnv: unset });
    const lark = env['LARK_APP_SECRET'];
    addSecrets([...(lark === undefined || lark === '' ? [] : [lark]), ...teamSecrets(team)]);
    // As the gateway's own service judges a task: a supervised role's approvals reach the chat following it.
    facts = { roles: team.roles, workspaces: new Set(team.workspaces.keys()), supervisedRoles: true };
    dir = join(settings.home, 'workflows');
  } catch (err) {
    if (err instanceof ConfigError) return refuse(io, `the team does not load, so no workflow can be checked: ${err.message}`);
    throw err;
  }
  if (unset.length > 0) {
    io.err(`mt: ${[...new Set(unset)].join(', ')} not set in this shell, so a gate holding those values cannot be refused here`);
  }
  if (run) {
    io.out("note: this is an agent's shell, which reads neither the gateway's .env nor its secrets, so a gate holding one of them cannot be refused here");
  }
  const say = (line: string): void => io.out(redactKnownSecrets(line));
  if (only !== undefined) {
    // A name outside the grammar is no file of the directory: said so before any path is made of it.
    const bad = nameProblem('workflow', only);
    if (bad !== undefined) {
      say(bad);
      return 1;
    }
    if (noFile(join(dir, `${only}.yaml`))) {
      say(`${only}: no workflow file ${join(dir, `${only}.yaml`)}`);
      return 1;
    }
    const r = readWorkflow(dir, only, facts);
    if (r.ok) {
      say(okLine(r.workflow));
      if (r.workflow.board !== undefined) say(BOARDS_NOTE);
      return 0;
    }
    say(`${only}: not usable: ${r.message.replace(/^workflow \S+ is not usable: /, '').replace(/^there is no workflow \S+: /, '')}`);
    return 1;
  }
  let list: WorkflowList;
  try {
    list = listWorkflows(dir, facts);
  } catch (err) {
    // Only the directory itself throws; a file that cannot be read is one broken workflow.
    if (err instanceof ConfigError) return refuse(io, err.message.replace(`cannot read ${dir}: `, `workflows directory ${dir} cannot be read: `));
    throw err;
  }
  const lines = [
    ...list.usable.map((w) => ({ name: w.name, line: okLine(w) })),
    ...list.broken.map((b) => ({ name: b.name, line: `${b.name}: not usable: ${b.problem}` })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (lines.length === 0 && list.ignored.length === 0) say(`no workflows: ${dir} is missing or empty`);
  for (const l of lines) say(l.line);
  if (list.usable.some((w) => w.board !== undefined)) say(BOARDS_NOTE);
  for (const l of list.ignored) say(l);
  return list.broken.length === 0 ? 0 : 1;
}
