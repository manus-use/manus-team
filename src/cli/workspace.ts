import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isMap, parseDocument, type Document, type Node } from 'yaml';
import { loadTeamSettings, type Env, type TeamSettings } from '../config.js';
import { movedMessage, registrationsAt } from '../db/workspaces.js';
import { nameProblem } from '../names.js';
import { resolveWorkspaces } from '../workspaces.js';
import { refuse, table } from './args.js';
import type { Git, MtIo } from './mt.js';

export type AddTarget = { path: string } | { cloneUrl: string };

/** What the checks before any write found, for the checks and the write that follow. */
export interface NewWorkspace {
  name: string;
  settings: TeamSettings;
  configPath: string;
  /** The config file as read, to put back if a later step fails. */
  text: string;
  doc: Document;
  /** The directory the database recorded for the name, if any. */
  recorded: string | undefined;
}

/**
 * The checks `workspace add` makes before it touches anything: a config file to
 * add to, a name in the grammar, and a name not already among the workspaces.
 */
export function checkNewWorkspace(name: string, settings: TeamSettings, env: Env): NewWorkspace | { error: string } {
  if (settings.configPath === undefined) {
    const named = env['MT_CONFIG']?.trim() ?? '';
    return {
      error:
        `there is no config file (looked for ${named === '' ? join(settings.home, 'config.yaml') : named}); ` +
        'create one, then add workspaces to it',
    };
  }
  const configPath = settings.configPath;
  const problem = nameProblem('workspace', name);
  if (problem !== undefined) return { error: problem };

  const text = readFileSync(configPath, 'utf8');
  const doc = parseDocument(text);
  if (settings.workspaces[name] !== undefined) {
    const single = name === 'default' && (doc.has('workspace') || (env['MT_WORKSPACE'] ?? '') !== '');
    return {
      error: single
        ? "the workspace default is already set by workspace: in the config file, or by MT_WORKSPACE in this shell or the gateway's .env (the service's environment may differ)"
        : `workspace ${name} is already in ${configPath}`,
    };
  }
  const recorded = registrationsAt(settings.dbPath).get(name);
  return { name, settings, configPath, text, doc, recorded };
}

/**
 * The checks on the final set of workspaces, once `path` exists: everything the
 * next start would refuse (spec §2.3), and a name the database recorded for
 * another directory. Returns the real path.
 */
export function checkFinalWorkspace(ws: NewWorkspace, path: string): { real: string } | { error: string } {
  const { name, settings, recorded } = ws;
  const resolved = resolveWorkspaces({ ...settings.workspaces, [name]: path }, settings.home, settings.dbPath);
  if ('error' in resolved) return { error: resolved.error };
  const real = resolved.workspaces.get(name) ?? path;
  if (recorded !== undefined && recorded !== real) return { error: movedMessage(name, recorded, real) };
  return { real };
}

/**
 * Refuses `$MT_HOME/workspaces` when it is there and is not a real directory: a
 * symlink would put a new workspace, and the path recorded for it, outside the home.
 */
export function workspacesParentProblem(home: string): string | undefined {
  const parent = join(home, 'workspaces');
  const stat = lstatSync(parent, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink()) return `${parent} is a symlink; workspaces under the gateway's home must be real directories`;
  if (!stat.isDirectory()) return `${parent} is not a directory; workspaces under the gateway's home must be real directories`;
  return undefined;
}

/**
 * Where `$MT_HOME/workspaces/<name>` will be once made, as a real path, for a
 * check before anything is written.
 */
export function expectedWorkspacePath(home: string, name: string): string {
  for (const [dir, rest] of [
    [join(home, 'workspaces'), [name]],
    [home, ['workspaces', name]],
  ] as const) {
    try {
      return join(realpathSync(dir), ...rest);
    } catch {
      // Not there yet: try the directory above.
    }
  }
  return join(home, 'workspaces', name);
}

/**
 * Adds `name: path` under `workspaces:` -- `name: { path, isolated: true }` for an
 * isolated workspace (spec §18) -- and writes the config file in place, keeping
 * its comments and mode. Throws if the file cannot be written; the file is then
 * as it was.
 */
export function addToConfig(ws: NewWorkspace, path: string, opts: { isolated?: boolean } = {}): void {
  const { doc } = ws;
  // `workspaces:` with no value parses as null, and setIn cannot add to it. Any
  // other non-map was already refused by loadTeamSettings, so this replaces only
  // a missing or empty key.
  if (!isMap(doc.get('workspaces'))) {
    const empty = doc.get('workspaces', true) as Node | undefined;
    const map = doc.createNode({});
    // `workspaces:  # note` hangs the note on the null value; keep it, above the
    // entries, where it still reads as the key's.
    const notes = [empty?.commentBefore, empty?.comment].filter((c): c is string => c != null && c !== '');
    if (notes.length > 0) map.commentBefore = notes.join('\n');
    doc.set('workspaces', map);
  }
  doc.setIn(['workspaces', ws.name], opts.isolated === true ? doc.createNode({ path, isolated: true }) : path);
  writeInPlace(ws.configPath, String(doc));
}

/** Puts back the config file `addToConfig` changed. */
export function restoreConfig(ws: NewWorkspace): void {
  writeInPlace(ws.configPath, ws.text);
}

/** `mt workspace add` (spec §2.6). Refuses anything the next start would refuse. `isolated`: each task gets its own directory (spec §18). */
export async function workspaceAdd(
  name: string,
  target: AddTarget,
  io: MtIo,
  opts: { isolated?: boolean } = {},
): Promise<number> {
  // Names and paths only, so an unset agent.passEnv name is no reason to fail
  // (see LoadOptions.unsetPassEnv).
  const settings = loadTeamSettings(io.env, undefined, { unsetPassEnv: [] });
  const ws = checkNewWorkspace(name, settings, io.env);
  if ('error' in ws) return refuse(io, ws.error);
  const { configPath, recorded } = ws;

  let path: string;
  let cloned: string | undefined;
  if ('path' in target) {
    path = target.path;
  } else {
    const parent = join(settings.home, 'workspaces');
    const before = workspacesParentProblem(settings.home);
    if (before !== undefined) return refuse(io, before);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    // Again once it exists: one put there since the check above is refused too.
    const after = workspacesParentProblem(settings.home);
    if (after !== undefined) return refuse(io, after);
    path = join(realpathSync(parent), name);
    // lstat, so a symlink -- even a dangling one -- counts as being there.
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) return refuse(io, `${path} already exists`);
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

  const final = checkFinalWorkspace(ws, path);
  if ('error' in final) {
    undo();
    return refuse(io, final.error);
  }
  try {
    addToConfig(ws, path, opts);
  } catch (err) {
    undo();
    return refuse(io, `cannot write ${configPath}: ${(err as Error).message}`);
  }
  io.out(addedMessage(name, final.real, configPath, opts.isolated === true));
  return 0;
}

export function addedMessage(name: string, real: string, configPath: string, isolated = false): string {
  const own = isolated ? ', each of its tasks in a directory of its own,' : '';
  return `added workspace ${name} (${real}) to ${configPath}; the gateway uses it${own} from its next start`;
}

/** `mt workspace list`: each workspace, and whether the gateway has registered it. */
export function workspaceList(io: MtIo): number {
  // Names and paths only, so an unset agent.passEnv name is no reason to fail
  // (see LoadOptions.unsetPassEnv).
  const settings = loadTeamSettings(io.env, undefined, { unsetPassEnv: [] });
  const recorded = registrationsAt(settings.dbPath);
  const rows: string[][] = [];
  for (const name of Object.keys(settings.workspaces).sort()) {
    const declared = settings.workspaces[name] ?? '';
    const was = recorded.get(name);
    let real: string | undefined;
    try {
      real = realpathSync(declared);
    } catch {
      real = undefined;
    }
    const status =
      was === undefined
        ? 'not registered yet'
        : was === real
          ? 'registered'
          : `registered at ${was}: the gateway will refuse to start`;
    rows.push([name, declared, settings.isolated?.[name] === undefined ? status : `${status}, isolated`]);
  }
  for (const [name, path] of [...recorded].sort(([a], [b]) => a.localeCompare(b))) {
    if (settings.workspaces[name] === undefined) rows.push([name, path, 'registered, not in the config']);
  }
  for (const line of table(rows)) io.out(line);
  return 0;
}

/** Through a temporary file beside it, with the same mode, so a failed write leaves the old file. */
function writeInPlace(path: string, text: string): void {
  const real = realpathSync(path);
  const tmp = `${real}.mt-${process.pid}.tmp`;
  const mode = statSync(real).mode & 0o777;
  let created = false;
  try {
    const fd = openSync(tmp, 'wx', mode);
    created = true;
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    // The umask narrows the mode given to open; this puts the original back.
    chmodSync(tmp, mode);
    renameSync(tmp, real);
  } catch (err) {
    // Only this run's file: an EEXIST from `wx` means the one there is another's.
    if (created) rmSync(tmp, { force: true });
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
