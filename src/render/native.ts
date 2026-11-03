import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { NAME_PATTERN } from '../names.js';
import type { Role } from '../roles.js';
import { bytesecRenderer } from './bytesec.js';
import type { Launch, PackageFile, Renderer, SkillFiles } from './types.js';

/**
 * Writing a role's native package (plan R), and removing old ones.
 *
 * **Where.** `$MT_HOME/rendered/<role>/<hash>/`, which is itself the package:
 * inside the gateway's home, never in a workspace. A workspace may not contain
 * the home, and inside the home only `workspaces/<name>` may be one (spec §2.3),
 * so an agent's checkout never holds a rendered package, and no package is
 * written into a repository.
 *
 * **Content-addressed.** The hash is of the package's own files, so it covers
 * role.md, every skill file, and whatever the renderer writes around them. Two
 * runs on two versions of a role's files get two directories. One that exists
 * is used once it is checked against what would be written: an agent runs as
 * the same user and could edit it, so one whose files differ, or that has any
 * more or fewer, is staged afresh and swapped in for it.
 *
 * **Atomic.** A package is written in a dot-directory beside it and renamed into
 * place, so a directory with a hash name is always complete. When another
 * render put the same hash in place first, the staging is dropped and that
 * package used: the same hash is the same content.
 *
 * **Only regular files.** A skill's symlinks, FIFOs and sockets are not copied,
 * as `mt role create` copies none; nor is any `.env`, file or directory. Each
 * file is opened without following a link and checked on its descriptor, so
 * the file read is the one checked. A skill directory, or a SKILL.md, that is
 * not a real one fails the render: it may have been replaced since startup.
 * This holds for the skills a role imports by name as for its own: both are in
 * `role.skills`.
 *
 * **Bounded.** A package may hold at most MAX_PACKAGE_FILES files and
 * MAX_PACKAGE_BYTES bytes, counted while the skills are walked, so a skill that
 * is a whole checkout fails at the limit instead of being read first.
 *
 * **Private.** Directories are 0700, set even on one that already existed, and
 * files 0600.
 */

/** The renderers, in the order they are asked. */
const RENDERERS: readonly Renderer[] = [bytesecRenderer];

/** The most a package may hold: rendering reads it whole at each claim. */
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 2000;

const STAGING = '.stage-';
const READ_CHUNK = 1024 * 1024;

export type Native = { ok: true; renderer: Renderer } | { ok: false; reason: string };

/**
 * Whether a role's runs are rendered, and by which renderer, or why not. Read
 * from the role as loaded: rendering itself can still fail, and then the run's
 * role.md and skills go in its prompt.
 */
export function nativeFor(role: Role): Native {
  if (role.agent.native === false) return { ok: false, reason: 'agent.native is false' };
  if (role.roleMdPath === undefined && role.skills.length === 0) {
    return { ok: false, reason: 'it has no role.md and no skills' };
  }
  const renderer = RENDERERS.find((r) => r.handles(role));
  if (renderer === undefined) {
    return { ok: false, reason: `no renderer for its agent (${role.agent.driver}, ${basename(role.agent.command)})` };
  }
  const refused = renderer.refuses(role);
  return refused === undefined ? { ok: true, renderer } : { ok: false, reason: refused };
}

export interface Rendered extends Launch {
  /** The package directory. */
  dir: string;
  /** Its content hash, the directory's name: what a run records (plan R). */
  hash: string;
}

/**
 * Render a role's package under `root` from the role.md bytes the claim read,
 * and say how a run uses it. Throws when it cannot: the caller falls back to
 * the task prompt.
 */
export function renderNative(root: string, role: Role, renderer: Renderer, roleMd: Buffer | undefined): Rendered {
  const budget: Budget = { role: role.name, files: 0, bytes: 0 };
  const files = renderer.files(role, roleMd, role.skills.map((s) => readSkill(s, budget)));
  checkFiles(role, files);
  const roleDir = privateDir(privateDir(root), role.name);
  const hash = packageHash(files);
  const dir = join(roleDir, hash);
  const existing = lstatSync(dir, { throwIfNoEntry: false });
  if (existing === undefined) {
    const staging = stage(roleDir, files);
    try {
      renameSync(staging, dir);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      // A concurrent render of the same content got there first: use its package.
      const code = (err as NodeJS.ErrnoException).code;
      const raced = (code === 'ENOTEMPTY' || code === 'EEXIST') && lstatSync(dir, { throwIfNoEntry: false })?.isDirectory();
      if (raced !== true) throw err;
    }
  } else if (!existing.isDirectory()) {
    throw new Error(`${dir} is in the way: it is not a directory`);
  } else if (!holds(dir, files)) {
    // Changed since it was written: an agent runs as the same user, and could
    // edit it. A fresh copy is staged and swapped in for it.
    const staging = stage(roleDir, files);
    const aside = `${staging}-old`;
    try {
      renameSync(dir, aside);
      renameSync(staging, dir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(aside, { recursive: true, force: true });
    }
  }
  return { dir, hash, ...renderer.launch(role, dir) };
}

/**
 * Write `files` in a new staging directory under `roleDir`, and return it; on
 * a failure part way, remove it and throw.
 */
function stage(roleDir: string, files: readonly PackageFile[]): string {
  const staging = mkdtempSync(join(roleDir, STAGING));
  try {
    for (const f of files) {
      const path = join(staging, ...f.path.split('/'));
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, f.bytes, { mode: 0o600, flag: 'wx' });
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return staging;
}

/**
 * Whether the package at `dir` holds exactly `files`: the same paths, with
 * the same bytes, as regular files, and no other file, directory or link.
 * Each file is read no further than one byte past what it should hold.
 */
function holds(dir: string, files: readonly PackageFile[]): boolean {
  const want = new Map(files.map((f) => [f.path, f.bytes]));
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  const walk = (at: string, prefix: string): boolean => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (!dirs.delete(rel) || !realDir(path) || !walk(path, rel)) return false;
        continue;
      }
      const bytes = want.get(rel);
      if (bytes === undefined || !entry.isFile()) return false;
      want.delete(rel);
      const budget: Budget = { role: '', files: 0, bytes: MAX_PACKAGE_BYTES - bytes.length };
      let got: Buffer | undefined;
      try {
        got = readRegular(path, budget);
      } catch {
        return false;
      }
      if (got === undefined || !got.equals(bytes)) return false;
    }
    return true;
  };
  return walk(dir, '') && want.size === 0 && dirs.size === 0;
}

/**
 * Remove a role's packages other than those in `keep` -- the one just rendered,
 * and those of runs still open -- and any staging left by a process that died
 * mid-write. A role's newest package therefore stays until its next render.
 */
export function sweepRole(root: string, roleName: string, keep: ReadonlySet<string>): void {
  if (!NAME_PATTERN.test(roleName) || !realDir(root)) return;
  const roleDir = join(root, roleName);
  for (const entry of entries(roleDir)) {
    const path = join(roleDir, entry);
    if (!keep.has(path)) rmSync(path, { recursive: true, force: true });
  }
}

/**
 * At boot: remove the packages of roles no longer configured, and any staging
 * a process left behind. Nothing is open at boot, so nothing else is in use;
 * each role's other old packages go at its next render.
 */
export function sweepRoles(root: string, roles: ReadonlySet<string>): void {
  if (!realDir(root)) return;
  for (const entry of entries(root)) {
    const path = join(root, entry);
    if (!roles.has(entry)) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    for (const inner of entries(path)) {
      if (inner.startsWith(STAGING)) rmSync(join(path, inner), { recursive: true, force: true });
    }
  }
}

/** Whether `dir` is a directory itself, not a symlink to one. */
function realDir(dir: string): boolean {
  return lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** A directory's entries, or none when it is missing. Never follows a symlink. */
function entries(dir: string): string[] {
  return realDir(dir) ? readdirSync(dir).sort() : [];
}

/**
 * `parent/name` as a real directory, made if missing; a symlink or a file is
 * refused. Then 0700, whatever it was: one made before, by hand or by an older
 * build, is made private too.
 */
function privateDir(parent: string, name?: string): string {
  const dir = name === undefined ? parent : join(parent, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  chmodSync(dir, 0o700);
  return dir;
}

/** What a package has taken so far, counted as its skills are walked. */
interface Budget {
  role: string;
  files: number;
  bytes: number;
}

function tooMany(b: Budget): Error {
  return new Error(`role ${b.role}'s package would hold ${b.files} files; at most ${MAX_PACKAGE_FILES} are rendered`);
}

function tooBig(b: Budget): Error {
  return new Error(`role ${b.role}'s package would be ${b.bytes} bytes; at most ${MAX_PACKAGE_BYTES} are rendered`);
}

/**
 * Every regular file under a skill's directory, but any `.env`; the directory
 * must be a real one, and its SKILL.md a regular file. Each file is counted
 * against the budget as it is read, and the walk stops at the first that
 * passes either limit.
 */
function readSkill(skill: Role['skills'][number], budget: Budget): SkillFiles {
  if (!realDir(skill.dir)) throw new Error(`${skill.dir} is not a directory`);
  if (lstatSync(skill.path, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error(`${skill.path} is not a regular file`);
  }
  const files: PackageFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.env') continue;
      const path = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        // Checked again: it may have been swapped for a symlink since the listing.
        if (realDir(path)) walk(path, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readRegular(path, budget);
      if (bytes !== undefined) files.push({ path: rel, bytes });
    }
  };
  walk(skill.dir, '');
  return { name: skill.name, files };
}

/**
 * A regular file's bytes, counted against the budget, or undefined when it is
 * no longer one: the Dirent said it was, but it may have been swapped since.
 * Opened once without following a link, and checked and read on that
 * descriptor (as roles.ts reads a .env); O_NONBLOCK keeps a FIFO from hanging
 * the open. At most the bytes left in the budget plus one are read, so a file
 * that grows cannot take more.
 */
function readRegular(path: string, budget: Budget): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOENT' || code === 'ENXIO') return undefined;
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    budget.files += 1;
    if (budget.files > MAX_PACKAGE_FILES) throw tooMany(budget);
    const cap = MAX_PACKAGE_BYTES - budget.bytes + 1;
    const chunks: Buffer[] = [];
    let got = 0;
    while (got < cap) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, cap - got));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      chunks.push(chunk.subarray(0, n));
      got += n;
    }
    budget.bytes += got;
    if (budget.bytes > MAX_PACKAGE_BYTES) throw tooBig(budget);
    return Buffer.concat(chunks, got);
  } finally {
    closeSync(fd);
  }
}

/** The whole package, with what the renderer adds around the skills, against the same limits. */
function checkFiles(role: Role, files: readonly PackageFile[]): void {
  const total: Budget = { role: role.name, files: files.length, bytes: files.reduce((n, f) => n + f.bytes.length, 0) };
  if (total.files > MAX_PACKAGE_FILES) throw tooMany(total);
  if (total.bytes > MAX_PACKAGE_BYTES) throw tooBig(total);
  for (const f of files) {
    const parts = f.path.split('/');
    if (f.path.startsWith('/') || parts.some((p) => p === '' || p === '.' || p === '..')) {
      throw new Error(`a package file may not be at ${JSON.stringify(f.path)}`);
    }
  }
}

/** sha256 of every file's path and bytes, in path order, each length-prefixed so no two packages hash alike. */
export function packageHash(files: readonly PackageFile[]): string {
  const hash = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${Buffer.byteLength(f.path)}:${f.path}:${f.bytes.length}:`);
    hash.update(f.bytes);
  }
  return hash.digest('hex');
}
