import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadTeamSettings, type Env } from '../config.js';
import { readGatewayEnv, withGatewayEnv } from '../gateway-env.js';
import { listWorkflows, paramsLine, readWorkflow, type Workflow, type WorkflowFacts } from '../kanban/workflow.js';
import { addSecrets, redactKnownSecrets } from '../secrets.js';
import { loadTeam, teamSecrets } from '../team.js';
import { refuse } from './args.js';
import { inBoardRun } from './gate.js';
import type { MtIo } from './mt.js';

/**
 * `mt workflow check [<name>]` (spec §2.6, §21.4): a workflow file's checks,
 * without starting it. It reads files only, and needs no authority, so it works
 * in any shell, a board run's included; it opens no database. It finds the home,
 * the config and the roles as the gateway does, this shell's environment over
 * the gateway's .env, and registers the secrets the gateway would, so a gate
 * holding one is refused here as at a start.
 *
 * Exit 0 when every workflow checked is usable, 1 otherwise, and 2 for a wrong
 * command line.
 */

function okLine(w: Workflow): string {
  return `${w.name}: ok, ${w.steps.length} step${w.steps.length === 1 ? '' : 's'}; params: ${paramsLine(w)}`;
}

export function workflowCheck(only: string | undefined, io: MtIo): number {
  // As roleCheck reads it (spec §2.6): never the gateway's .env in a board run's shell.
  const run = inBoardRun(io.env);
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
    io.out("note: this is a board run's shell, which reads neither the gateway's .env nor its secrets, so a gate holding one of them cannot be refused here");
  }
  const say = (line: string): void => io.out(redactKnownSecrets(line));
  if (only !== undefined) {
    if (lstatSync(join(dir, `${only}.yaml`), { throwIfNoEntry: false }) === undefined) {
      say(`${only}: no workflow file ${join(dir, `${only}.yaml`)}`);
      return 1;
    }
    const r = readWorkflow(dir, only, facts);
    if (r.ok) {
      say(okLine(r.workflow));
      return 0;
    }
    say(`${only}: not usable: ${r.message.replace(/^workflow \S+ is not usable: /, '').replace(/^there is no workflow \S+: /, '')}`);
    return 1;
  }
  const list = listWorkflows(dir, facts);
  const lines = [
    ...list.usable.map((w) => ({ name: w.name, line: okLine(w) })),
    ...list.broken.map((b) => ({ name: b.name, line: `${b.name}: not usable: ${b.problem}` })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (lines.length === 0 && list.ignored.length === 0) say(`no workflows: ${dir} is missing or empty`);
  for (const l of lines) say(l.line);
  for (const l of list.ignored) say(l);
  return list.broken.length === 0 ? 0 : 1;
}
