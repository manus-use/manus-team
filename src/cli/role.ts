import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadTeamSettings } from '../config.js';
import { discoverRoles } from '../roles.js';
import { table, type MtIo } from './mt.js';

/** `mt role list`: every role, its driver, where it comes from, and its description. */
export function roleList(io: MtIo): number {
  // Names only, so an unset agent.passEnv name is no reason to fail (Task 3).
  const settings = loadTeamSettings(io.env, undefined, { unsetPassEnv: [] });
  const rolesDir = join(settings.home, 'roles');
  const found = discoverRoles(rolesDir);
  const rows: string[][] = [];
  if (settings.agent !== undefined && !found.names.includes('default')) {
    rows.push(['default', settings.agent.driver, 'agent: block', '']);
  }
  for (const name of found.names) {
    const summary = summarize(join(rolesDir, name, 'config.yaml'));
    rows.push([name, summary.driver, `roles/${name}`, summary.description]);
  }
  if (rows.length === 0) io.out('no roles: create one with mt role create <name>');
  for (const line of table(rows)) io.out(line);
  for (const note of found.notes) io.out(`note: ${note}`);
  return 0;
}

/** Read loosely, so a broken role still gets a line; `mt role check` says what is wrong with it. */
function summarize(path: string): { driver: string; description: string } {
  try {
    const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    const agent = raw?.['agent'] as Record<string, unknown> | undefined;
    const driver = agent?.['driver'];
    const description = raw?.['description'];
    return {
      driver: typeof driver === 'string' ? driver : '?',
      description: typeof description === 'string' ? description : '',
    };
  } catch {
    return { driver: '?', description: '(unreadable config.yaml)' };
  }
}
