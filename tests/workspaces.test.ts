import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspaces } from '../src/workspaces.js';

/**
 * A workspace is where an unsupervised agent writes, so the rules are about what
 * must never end up inside one: the gateway's home (every role's secrets, the
 * database) -- and about two names never sharing one checkout, which would give
 * the one-run-per-workspace limit two counters for one directory.
 */
let root: string;
let home: string;
let db: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-ws-')));
  home = join(root, 'home');
  mkdirSync(home);
  db = join(home, 'gateway.db');
  writeFileSync(db, '');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function dir(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function resolved(declared: Record<string, string>): ReadonlyMap<string, string> {
  const r = resolveWorkspaces(declared, home, db);
  if ('error' in r) throw new Error(r.error);
  return r.workspaces;
}

function refused(declared: Record<string, string>): string {
  const r = resolveWorkspaces(declared, home, db);
  if (!('error' in r)) throw new Error('expected an error');
  return r.error;
}

describe('resolveWorkspaces', () => {
  it('resolves each workspace to its real path', () => {
    const a = dir('repos', 'a');
    expect([...resolved({ default: a }).entries()]).toEqual([['default', a]]);
  });

  it('requires a workspace named default', () => {
    expect(refused({ docs: dir('d') })).toMatch(/workspace named default is required/);
  });

  it('refuses a name outside the grammar', () => {
    expect(refused({ default: dir('a'), '../roles': dir('b') })).toMatch(/must be lowercase/);
  });

  it('refuses a relative path', () => {
    expect(refused({ default: 'repos/a' })).toMatch(/must be an absolute path/);
  });

  it('refuses a directory that does not exist', () => {
    expect(refused({ default: join(root, 'missing') })).toMatch(/does not exist or is not a directory/);
  });

  it("refuses a workspace that is or contains the gateway's home", () => {
    expect(refused({ default: root })).toMatch(/contains the gateway's home/);
    expect(refused({ default: home })).toMatch(/contains the gateway's home/);
  });

  it('refuses a workspace containing the roles directory, when roles is a symlink out of the home', () => {
    // $MT_HOME/roles points elsewhere: a workspace that contains its target
    // would hold every role's .env, though it contains nothing of the home.
    const rolesReal = dir('elsewhere', 'roles');
    symlinkSync(rolesReal, join(home, 'roles'));
    expect(refused({ default: dir('elsewhere') })).toMatch(/contains the gateway's roles directory/);
    expect(refused({ default: rolesReal })).toMatch(/contains the gateway's roles directory/);
  });

  it('refuses a workspace containing a home that does not exist yet, through a symlink', () => {
    // A fresh install: the home is not created until the gateway starts. The
    // workspace is reached through a symlink, so only a real-path comparison sees it.
    const real = dir('real');
    const link = join(root, 'link');
    symlinkSync(real, link);
    const r = resolveWorkspaces({ default: link }, join(link, 'not-yet-home'), join(link, 'not-yet-home', 'gateway.db'));
    expect('error' in r && r.error).toMatch(/contains the gateway's home/);
  });

  it('refuses a workspace that contains the database, wherever it is', () => {
    const elsewhere = dir('data');
    const otherDb = join(elsewhere, 'gateway.db');
    writeFileSync(otherDb, '');
    const r = resolveWorkspaces({ default: elsewhere }, home, otherDb);
    expect('error' in r && r.error).toMatch(/contains the gateway's database/);
  });

  it('allows only workspaces/<name> inside the home', () => {
    const managed = join(home, 'workspaces', 'docs');
    mkdirSync(managed, { recursive: true });
    expect(resolved({ default: dir('a'), docs: managed }).get('docs')).toBe(managed);
    const roles = join(home, 'roles');
    mkdirSync(roles);
    expect(refused({ default: roles })).toMatch(/inside the gateway's home, only/);
  });

  it("refuses the rendered packages, or one of them, as a workspace: they are the home's (plan R)", () => {
    const pkg = join(home, 'rendered', 'implementer', 'a'.repeat(64));
    mkdirSync(pkg, { recursive: true });
    expect(refused({ default: join(home, 'rendered') })).toMatch(/inside the gateway's home, only/);
    expect(refused({ default: pkg })).toMatch(/inside the gateway's home, only/);
  });

  it('refuses two names for one directory', () => {
    const a = dir('a');
    expect(refused({ default: a, other: a })).toMatch(/are the same directory/);
  });

  it('refuses one workspace inside another', () => {
    expect(refused({ default: dir('a'), inner: dir('a', 'inner') })).toMatch(/are nested/);
  });
});
