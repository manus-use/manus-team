import { basename } from 'node:path';
import { isBytesecSkillName } from '../names.js';
import type { Role } from '../roles.js';
import type { Launch, PackageFile, Renderer, SkillFiles } from './types.js';

/**
 * bytesec's renderer (plan R): a role becomes a bytesec agent package.
 *
 * Verified against bytesec 0.7.4 by a spike, not inferred:
 * - `BYTESEC_LOCAL_APM_PATH=<package dir>` in the agent's environment, with
 *   `bytesec run --agent <name>`, loads the package's agent `agents/<name>.md`.
 *   The package directory is the one holding `apm.json`. Pointed at a directory
 *   of packages instead, bytesec exits 1 and prints nothing, so each run is
 *   pointed at its own role's one package.
 * - The agent file's body becomes the agent's system prompt, in place of the
 *   default agent's identity paragraph; bytesec still adds its provider prompt
 *   and its tool and workspace guidelines around it. Its skills are loaded as
 *   the package's own. An agent from this path wins over a project package of
 *   the same name.
 * - A package's agent may use only the package's own skills: bytesec gives it
 *   the skill permission `{"*": "deny", <its skills>: "allow"}` and shows it
 *   only skills inside the package. The user's and the workspace's skills are
 *   out of its reach, so a role brings a user skill in by naming it in
 *   `agent.skills`, and it is copied into the package. `BYTESEC_NO_GLOBAL_APM`
 *   is not set: it changes what bytesec loads, not what the agent may use.
 */

const COMMAND = 'bytesec';
/** bytesec's own pattern for an agent package's name. */
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** Agent names bytesec keeps for itself: `--agent bytesec-agent` runs its built-in agent, not a package. */
const RESERVED = ['bytesec-agent'];
/** The variable naming the package, and the older name bytesec also reads. */
const APM_PATH = 'BYTESEC_LOCAL_APM_PATH';
const APM_PATH_OLD = 'OPENCODE_LOCAL_APM_PATH';

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export const bytesecRenderer: Renderer = {
  id: 'bytesec',

  /**
   * The structured-CLI driver speaks bytesec's `run --format json` and nothing
   * else, so a role on it whose command is bytesec is a bytesec agent. The
   * basename, not the whole path, so `/opt/bin/bytesec` counts; a wrapper script
   * with another name does not, since it may not pass `--agent` or the
   * environment on.
   */
  handles(role) {
    return role.agent.driver === 'structured-cli' && basename(role.agent.command) === COMMAND;
  },

  refuses(role) {
    if (!PACKAGE_NAME.test(role.name)) return `bytesec cannot name an agent ${JSON.stringify(role.name)}`;
    if (RESERVED.includes(role.name)) return `bytesec keeps the agent name ${role.name} for its own agent`;
    if (role.agent.args.some((a) => a === '--agent' || a.startsWith('--agent='))) {
      return 'its agent.args already choose a bytesec agent with --agent';
    }
    for (const key of [APM_PATH, APM_PATH_OLD]) {
      if (role.agent.env[key] !== undefined || role.agent.passEnv.includes(key)) {
        return `its environment already sets ${key}`;
      }
    }
    for (const skill of role.skills) {
      if (!isBytesecSkillName(skill.name)) {
        return (
          `bytesec cannot load its skill ${JSON.stringify(skill.name)}: a bytesec skill name is lowercase ` +
          "letters, digits and single '-', not at either end, and at most 64 characters"
        );
      }
    }
    return undefined;
  },

  files(role: Role, roleMd: Buffer | undefined, skills: readonly SkillFiles[]): PackageFile[] {
    const description = oneLine(role.description ?? '') || `the ${role.name} role`;
    const apm = { name: role.name, description, source: 'default', path: '' };
    // JSON strings are YAML double-quoted scalars, so a description holding a
    // colon or a quote cannot break the front matter.
    const matter = [
      '---',
      // Quoted too, so a role named `true` or `null` is still a string.
      `name: ${JSON.stringify(role.name)}`,
      `description: ${JSON.stringify(description)}`,
      'mode: primary',
      '---',
      '',
    ];
    const files: PackageFile[] = [
      { path: 'apm.json', bytes: Buffer.from(`${JSON.stringify(apm, null, 2)}\n`) },
      // role.md as the claim read it, byte for byte: the run records its hash.
      { path: `agents/${role.name}.md`, bytes: Buffer.concat([Buffer.from(matter.join('\n')), roleMd ?? Buffer.alloc(0)]) },
    ];
    for (const skill of skills) {
      for (const f of skill.files) files.push({ path: `skills/${skill.name}/${f.path}`, bytes: f.bytes });
    }
    return files;
  },

  launch(role: Role, dir: string): Launch {
    return { args: ['--agent', role.name], env: { [APM_PATH]: dir } };
  },
};
