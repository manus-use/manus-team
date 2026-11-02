import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { loadTeamSettings } from '../config.js';
import { movedMessage, registrationsAt } from '../db/workspaces.js';
import { nameProblem } from '../names.js';
import { resolveWorkspaces } from '../workspaces.js';
import { refuse, type Git, type MtIo } from './mt.js';

export type AddTarget = { path: string } | { cloneUrl: string };

/** `mt workspace add` (spec §2.6). Refuses anything the next start would refuse. */
export async function workspaceAdd(name: string, target: AddTarget, io: MtIo): Promise<number> {
  // Names and paths only, so an unset agent.passEnv name is no reason to fail (Task 3).
  const settings = loadTeamSettings(io.env, undefined, { unsetPassEnv: [] });
  if (settings.configPath === undefined) {
    return refuse(
      io,
      `there is no config file (looked for ${io.env['MT_CONFIG'] ?? join(settings.home, 'config.yaml')}); ` +
        'create one, then add workspaces to it',
    );
  }
  const configPath = settings.configPath;
  const problem = nameProblem('workspace', name);
  if (problem !== undefined) return refuse(io, problem);

  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  if (settings.workspaces[name] !== undefined) {
    const single = name === 'default' && (doc.has('workspace') || (io.env['MT_WORKSPACE'] ?? '') !== '');
    return refuse(
      io,
      single
        ? "the workspace default is already set by workspace: in the config file, or by MT_WORKSPACE in this shell (the service's environment may differ)"
        : `workspace ${name} is already in ${configPath}`,
    );
  }
  const recorded = registrationsAt(settings.dbPath).get(name);

  let path: string;
  let cloned: string | undefined;
  if ('path' in target) {
    path = target.path;
  } else {
    const parent = join(settings.home, 'workspaces');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    path = join(realpathSync(parent), name);
    if (existsSync(path)) return refuse(io, `${path} already exists`);
    if (recorded !== undefined && recorded !== path) return refuse(io, movedMessage(name, recorded, path));
    // `--` so a URL starting with `-` cannot be read as an option. Any URL git
    // accepts is allowed: this runs as the operator, who could run git directly.
    const result = await (io.git ?? runGit)(['clone', '--', target.cloneUrl, path]);
    if (result.code !== 0) {
      rmSync(path, { recursive: true, force: true });
      const tail = result.stderr.trim().split('\n').slice(-3).join('\n');
      return refuse(io, `git clone failed (exit ${result.code})${tail === '' ? '' : `:\n${tail}`}`);
    }
    cloned = path;
  }
  const undo = (): void => {
    if (cloned !== undefined) rmSync(cloned, { recursive: true, force: true });
  };

  const resolved = resolveWorkspaces({ ...settings.workspaces, [name]: path }, settings.home, settings.dbPath);
  if ('error' in resolved) {
    undo();
    return refuse(io, resolved.error);
  }
  const real = resolved.workspaces.get(name) ?? path;
  if (recorded !== undefined && recorded !== real) {
    undo();
    return refuse(io, movedMessage(name, recorded, real));
  }

  // `workspaces:` with no value parses as null, and setIn cannot add to it. Any
  // other non-map was already refused by loadTeamSettings, so this replaces only
  // a missing or empty key.
  if (!isMap(doc.get('workspaces'))) doc.set('workspaces', doc.createNode({}));
  doc.setIn(['workspaces', name], path);
  try {
    writeInPlace(configPath, String(doc));
  } catch (err) {
    undo();
    throw err;
  }
  io.out(`added workspace ${name} (${real}) to ${configPath}; the gateway uses it from its next start`);
  return 0;
}

/** Through a temporary file beside it, with the same mode, so a failed write leaves the old file. */
function writeInPlace(path: string, text: string): void {
  const real = realpathSync(path);
  const tmp = `${real}.mt-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: statSync(real).mode & 0o777, flag: 'wx' });
    renameSync(tmp, real);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const runGit: Git = (args) =>
  new Promise((resolve) => {
    const child = spawn('git', [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => resolve({ code: 127, stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
