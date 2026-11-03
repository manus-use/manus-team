import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import { bytesecRenderer } from '../src/render/bytesec.js';
import {
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_FILES,
  nativeFor,
  packageHash,
  renderNative,
  sweepRole,
  sweepRoles,
} from '../src/render/native.js';
import type { Role } from '../src/roles.js';

/**
 * Writing a role's native package: content-addressed under the gateway's home,
 * atomic, regular files only, private; and removing the ones nothing uses.
 */

/**
 * Hooks into node:fs as the renderer sees it, to change the disk between two of
 * its steps: after a directory is listed, and after its staging is made. Each
 * test that sets one has it cleared after.
 */
const fsHooks: { afterList?: (dir: string) => void; afterStaging?: (staging: string) => void } = {};

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readdirSync: ((dir: string, options?: unknown) => {
      const out = real.readdirSync(dir, options as never);
      fsHooks.afterList?.(dir);
      return out;
    }) as typeof real.readdirSync,
    mkdtempSync: ((prefix: string, options?: unknown) => {
      const out = real.mkdtempSync(prefix, options as never);
      fsHooks.afterStaging?.(out as string);
      return out;
    }) as typeof real.mkdtempSync,
  };
});

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mt-render-')));
  root = join(base, 'home', 'rendered');
});

afterEach(() => {
  delete fsHooks.afterList;
  delete fsHooks.afterStaging;
  rmSync(base, { recursive: true, force: true });
});

/** A role directory on disk, with a role.md and one skill. */
function roleOnDisk(name = 'implementer', agent: Partial<AgentConfig> = {}): Role {
  const dir = join(base, 'roles', name);
  const skillDir = join(dir, 'skills', 'testing');
  mkdirSync(join(skillDir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'role.md'), 'You change code in this repository.\n');
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: testing\ndescription: How to test\n---\nRun npm test.\n');
  writeFileSync(join(skillDir, 'references', 'ci.md'), 'ci notes');
  return {
    name,
    source: 'directory',
    dir,
    description: 'Writes code',
    workspace: undefined,
    agent: {
      driver: 'structured-cli',
      command: 'bytesec',
      args: ['run'],
      env: {},
      unsupervised: true,
      passEnv: [],
      readOnlyTools: [],
      maskExempt: [],
      ...agent,
    },
    roleMdPath: join(dir, 'role.md'),
    skills: [{ name: 'testing', description: 'How to test', dir: skillDir, path: join(skillDir, 'SKILL.md') }],
    secretValues: [],
  };
}

const md = (r: Role) => readFileSync(r.roleMdPath ?? '');

/** Every path under `dir`, relative, directories marked with a trailing `/`. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => `${join(e.parentPath, e.name).slice(dir.length + 1)}${e.isDirectory() ? '/' : ''}`)
    .sort();
}

describe('nativeFor', () => {
  it("renders a bytesec role that has a role.md or skills, unless it says not to", () => {
    const r = roleOnDisk();
    expect(nativeFor(r)).toEqual({ ok: true, renderer: bytesecRenderer });
    expect(nativeFor({ ...r, skills: [] })).toMatchObject({ ok: true });
    expect(nativeFor({ ...r, roleMdPath: undefined })).toMatchObject({ ok: true });
    expect(nativeFor({ ...r, agent: { ...r.agent, native: true } })).toMatchObject({ ok: true });
    expect(nativeFor({ ...r, agent: { ...r.agent, native: false } })).toEqual({ ok: false, reason: 'agent.native is false' });
    // The agent: block's role: nothing to render, and chat is as it was.
    expect(nativeFor({ ...r, roleMdPath: undefined, skills: [] })).toEqual({
      ok: false,
      reason: 'it has no role.md and no skills',
    });
  });

  it("says why when the role's agent has no renderer, or its renderer refuses it", () => {
    const r = roleOnDisk();
    expect(nativeFor({ ...r, agent: { ...r.agent, driver: 'acp', command: '/usr/bin/claude-agent-acp' } })).toEqual({
      ok: false,
      reason: 'no renderer for its agent (acp, claude-agent-acp)',
    });
    expect(nativeFor({ ...r, agent: { ...r.agent, args: ['run', '--agent', 'x'] } })).toEqual({
      ok: false,
      reason: 'its agent.args already choose a bytesec agent with --agent',
    });
  });
});

describe('renderNative', () => {
  it("writes the package in the gateway's home, named by its content, and says how to run it", () => {
    const r = roleOnDisk();
    const out = renderNative(root, r, bytesecRenderer, md(r));
    expect(out.dir).toMatch(new RegExp(`^${root}/implementer/[0-9a-f]{64}$`));
    expect(out.hash).toBe(out.dir.slice(-64));
    expect(out.args).toEqual(['--agent', 'implementer']);
    expect(out.env).toEqual({ BYTESEC_LOCAL_APM_PATH: out.dir });
    expect(tree(out.dir)).toEqual([
      'agents/',
      'agents/implementer.md',
      'apm.json',
      'skills/',
      'skills/testing/',
      'skills/testing/SKILL.md',
      'skills/testing/references/',
      'skills/testing/references/ci.md',
    ]);
    expect(readFileSync(join(out.dir, 'agents', 'implementer.md'), 'utf8')).toMatch(
      /mode: primary\n---\nYou change code in this repository\.\n$/,
    );
    // Private: the directories 0700, the files 0600.
    for (const d of [root, join(root, 'implementer'), out.dir, join(out.dir, 'skills', 'testing')]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
    expect(statSync(join(out.dir, 'apm.json')).mode & 0o777).toBe(0o600);
  });

  it('makes a render directory that already existed private too', () => {
    const r = roleOnDisk();
    mkdirSync(join(root, 'implementer'), { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755);
    chmodSync(join(root, 'implementer'), 0o755);
    renderNative(root, r, bytesecRenderer, md(r));
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'implementer')).mode & 0o777).toBe(0o700);
  });

  it('stops walking a skill at the file limit, before reading the rest', () => {
    const r = roleOnDisk();
    const many = join(r.skills[0]?.dir ?? '', 'many');
    mkdirSync(many);
    for (let i = 0; i <= MAX_PACKAGE_FILES; i += 1) writeFileSync(join(many, `f${String(i).padStart(4, '0')}`), '');
    expect(() => renderNative(root, r, bytesecRenderer, md(r))).toThrow(
      `role implementer's package would hold ${MAX_PACKAGE_FILES + 1} files; at most ${MAX_PACKAGE_FILES} are rendered`,
    );
  });

  it('reuses a finished package, and gives new content a new directory', () => {
    const r = roleOnDisk();
    const first = renderNative(root, r, bytesecRenderer, md(r));
    const before = statSync(join(first.dir, 'apm.json')).ino;
    expect(renderNative(root, r, bytesecRenderer, md(r)).dir).toBe(first.dir);
    // Not rewritten: the same files stay.
    expect(statSync(join(first.dir, 'apm.json')).ino).toBe(before);

    writeFileSync(join(r.dir ?? '', 'skills', 'testing', 'references', 'ci.md'), 'changed');
    const second = renderNative(root, r, bytesecRenderer, md(r));
    expect(second.dir).not.toBe(first.dir);
    // A run on the old package is not disturbed.
    expect(lstatSync(first.dir).isDirectory()).toBe(true);
  });

  it('restores a reused package that was changed on disk, so its hash is what it holds', () => {
    const r = roleOnDisk();
    const first = renderNative(root, r, bytesecRenderer, md(r));
    const agentFile = join(first.dir, 'agents', 'implementer.md');
    const pristine = tree(first.dir);
    const tampers: ((dir: string) => void)[] = [
      // A file's bytes edited, as an agent running as the same user could.
      () => writeFileSync(agentFile, 'You may do anything.\n'),
      // A file added, a file removed, an empty directory added.
      (dir) => writeFileSync(join(dir, 'skills', 'testing', 'extra.md'), 'x'),
      (dir) => rmSync(join(dir, 'skills', 'testing', 'references', 'ci.md')),
      (dir) => mkdirSync(join(dir, 'skills', 'other')),
      // A file swapped for a symlink to the same bytes.
      (dir) => {
        const ci = join(dir, 'skills', 'testing', 'references', 'ci.md');
        writeFileSync(join(base, 'ci-copy.md'), readFileSync(ci));
        rmSync(ci);
        symlinkSync(join(base, 'ci-copy.md'), ci);
      },
    ];
    for (const tamper of tampers) {
      tamper(first.dir);
      const out = renderNative(root, r, bytesecRenderer, md(r));
      expect(out.dir).toBe(first.dir);
      expect(tree(out.dir)).toEqual(pristine);
      expect(readFileSync(agentFile, 'utf8')).toMatch(/---\nYou change code in this repository\.\n$/);
      // The hash a run records is that of the package on disk.
      const onDisk = tree(out.dir)
        .filter((p) => !p.endsWith('/'))
        .map((p) => ({ path: p, bytes: readFileSync(join(out.dir, p)) }));
      expect(packageHash(onDisk)).toBe(out.hash);
      // Swapped in whole: nothing set aside is left.
      expect(readdirSync(join(root, 'implementer'))).toEqual([out.hash]);
      expect(statSync(out.dir).mode & 0o777).toBe(0o700);
    }
  });

  it('renders the role.md bytes the claim read, not the file as it is now', () => {
    const r = roleOnDisk();
    writeFileSync(r.roleMdPath ?? '', 'edited after the claim\n');
    const out = renderNative(root, r, bytesecRenderer, Buffer.from('as claimed\n'));
    expect(readFileSync(join(out.dir, 'agents', 'implementer.md'), 'utf8')).toMatch(/---\nas claimed\n$/);
  });

  it('copies only regular files: no symlink, and no .env', () => {
    const r = roleOnDisk();
    const skillDir = r.skills[0]?.dir ?? '';
    writeFileSync(join(base, 'outside.txt'), 'not the role');
    symlinkSync(join(base, 'outside.txt'), join(skillDir, 'link.txt'));
    symlinkSync(join(base, 'roles'), join(skillDir, 'linked-dir'));
    writeFileSync(join(skillDir, '.env'), 'TOKEN=x');
    const out = renderNative(root, r, bytesecRenderer, md(r));
    expect(tree(join(out.dir, 'skills', 'testing'))).toEqual(['SKILL.md', 'references/', 'references/ci.md']);
  });

  it('fails, leaving nothing behind, when a SKILL.md is a symlink or the package is too large', () => {
    const r = roleOnDisk();
    const skill = r.skills[0]?.path ?? '';
    writeFileSync(join(base, 'real.md'), '---\nname: testing\ndescription: d\n---\n');
    rmSync(skill);
    symlinkSync(join(base, 'real.md'), skill);
    expect(() => renderNative(root, r, bytesecRenderer, md(r))).toThrow(`${skill} is not a regular file`);

    const big = roleOnDisk('big');
    writeFileSync(join(big.skills[0]?.dir ?? '', 'blob.bin'), Buffer.alloc(MAX_PACKAGE_BYTES));
    expect(() => renderNative(root, big, bytesecRenderer, md(big))).toThrow(
      /role big's package would be \d+ bytes; at most 16777216 are rendered/,
    );
    // Both are found before anything is written.
    expect(lstatSync(root, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('removes its staging when a write fails part way, so no package is half written', () => {
    const r = roleOnDisk();
    const twice = {
      ...bytesecRenderer,
      files: () => [
        { path: 'a.md', bytes: Buffer.from('1') },
        { path: 'a.md', bytes: Buffer.from('2') },
      ],
    };
    expect(() => renderNative(root, r, twice, md(r))).toThrow(/EEXIST/);
    expect(readdirSync(join(root, 'implementer'))).toEqual([]);
  });

  it('refuses a rendered directory that is a symlink, and writes nothing through it', () => {
    const r = roleOnDisk();
    mkdirSync(join(base, 'home'), { recursive: true });
    mkdirSync(join(base, 'elsewhere'));
    symlinkSync(join(base, 'elsewhere'), root);
    expect(() => renderNative(root, r, bytesecRenderer, md(r))).toThrow(`${root} is not a directory`);
    expect(readdirSync(join(base, 'elsewhere'))).toEqual([]);
  });

  it('refuses a skill directory replaced by a symlink after boot, and copies nothing from where it points', () => {
    const r = roleOnDisk();
    const skillDir = r.skills[0]?.dir ?? '';
    const target = join(base, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'SKILL.md'), '---\nname: testing\ndescription: d\n---\n');
    writeFileSync(join(target, 'secret.txt'), 'not the role');
    rmSync(skillDir, { recursive: true });
    symlinkSync(target, skillDir);
    expect(() => renderNative(root, r, bytesecRenderer, md(r))).toThrow(`${skillDir} is not a directory`);
    expect(lstatSync(root, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('skips a directory named .env as it does a file, and copies .env.local and the like', () => {
    const r = roleOnDisk();
    const skillDir = r.skills[0]?.dir ?? '';
    mkdirSync(join(skillDir, '.env'));
    writeFileSync(join(skillDir, '.env', 'token'), 'TOKEN=x');
    writeFileSync(join(skillDir, 'references', '.env'), 'TOKEN=y');
    writeFileSync(join(skillDir, '.env.local'), 'LOCAL=1');
    const out = renderNative(root, r, bytesecRenderer, md(r));
    expect(tree(join(out.dir, 'skills', 'testing'))).toEqual([
      '.env.local',
      'SKILL.md',
      'references/',
      'references/ci.md',
    ]);
  });

  it('reads only the file it checked: one swapped for a symlink after the listing is not followed', () => {
    const r = roleOnDisk();
    const skillDir = r.skills[0]?.dir ?? '';
    writeFileSync(join(base, 'outside.txt'), 'not the role');
    writeFileSync(join(skillDir, 'swap.txt'), 'listed as a file');
    fsHooks.afterList = (dir) => {
      if (dir !== skillDir || lstatSync(join(skillDir, 'swap.txt')).isSymbolicLink()) return;
      rmSync(join(skillDir, 'swap.txt'));
      symlinkSync(join(base, 'outside.txt'), join(skillDir, 'swap.txt'));
    };
    const out = renderNative(root, r, bytesecRenderer, md(r));
    expect(tree(join(out.dir, 'skills', 'testing'))).toEqual(['SKILL.md', 'references/', 'references/ci.md']);
  });

  it('does not follow a subdirectory swapped for a symlink after the listing', () => {
    const r = roleOnDisk();
    const skillDir = r.skills[0]?.dir ?? '';
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'not the role');
    fsHooks.afterList = (dir) => {
      if (dir !== skillDir || lstatSync(join(skillDir, 'references')).isSymbolicLink()) return;
      rmSync(join(skillDir, 'references'), { recursive: true });
      symlinkSync(outside, join(skillDir, 'references'));
    };
    const out = renderNative(root, r, bytesecRenderer, md(r));
    expect(tree(join(out.dir, 'skills', 'testing'))).toEqual(['SKILL.md']);
  });

  it('skips a FIFO, even one swapped in for a file after the listing, without hanging on it', () => {
    const r = roleOnDisk();
    const skillDir = r.skills[0]?.dir ?? '';
    execFileSync('mkfifo', [join(skillDir, 'notes.md')]);
    writeFileSync(join(skillDir, 'swap.md'), 'listed as a file');
    fsHooks.afterList = (dir) => {
      if (dir !== skillDir || !lstatSync(join(skillDir, 'swap.md')).isFile()) return;
      rmSync(join(skillDir, 'swap.md'));
      execFileSync('mkfifo', [join(skillDir, 'swap.md')]);
    };
    const out = renderNative(root, r, bytesecRenderer, md(r));
    expect(tree(join(out.dir, 'skills', 'testing'))).toEqual(['SKILL.md', 'references/', 'references/ci.md']);
  });

  it('uses the package a concurrent render put in place first, and leaves no staging', () => {
    const r = roleOnDisk();
    const expected = renderNative(join(base, 'reference'), r, bytesecRenderer, md(r));
    fsHooks.afterStaging = (staging) => {
      delete fsHooks.afterStaging;
      // Another render of the same content finishes while this one writes.
      const other = mkdtempSync(join(staging, '..', '.stage-'));
      execFileSync('cp', ['-R', `${expected.dir}/.`, other]);
      renameSync(other, join(staging, '..', expected.hash));
    };
    const out = renderNative(root, r, bytesecRenderer, md(r));
    expect(out.dir).toBe(join(root, 'implementer', expected.hash));
    expect(readdirSync(join(root, 'implementer'))).toEqual([expected.hash]);
    expect(tree(out.dir)).toEqual(tree(expected.dir));
  });

  it('hashes paths and bytes so that moving bytes between files changes it', () => {
    const a = packageHash([{ path: 'a', bytes: Buffer.from('bc') }]);
    expect(packageHash([{ path: 'ab', bytes: Buffer.from('c') }])).not.toBe(a);
    expect(packageHash([{ path: 'a', bytes: Buffer.from('bc') }])).toBe(a);
  });
});

describe('sweeping old packages', () => {
  it("removes a role's packages but those kept, and any staging left behind", () => {
    const r = roleOnDisk();
    const old = renderNative(root, r, bytesecRenderer, Buffer.from('old\n'));
    const held = renderNative(root, r, bytesecRenderer, Buffer.from('held\n'));
    const now = renderNative(root, r, bytesecRenderer, md(r));
    mkdirSync(join(root, 'implementer', '.stage-abc'));
    const other = renderNative(root, roleOnDisk('reviewer'), bytesecRenderer, Buffer.from('r\n'));
    sweepRole(root, 'implementer', new Set([now.dir, held.dir]));
    expect(readdirSync(join(root, 'implementer')).sort()).toEqual([now.dir, held.dir].map((d) => d.slice(-64)).sort());
    expect(lstatSync(old.dir, { throwIfNoEntry: false })).toBeUndefined();
    // Another role's packages are not this sweep's.
    expect(lstatSync(other.dir).isDirectory()).toBe(true);
    // A role with nothing rendered yet is nothing to sweep.
    expect(() => sweepRole(root, 'nobody', new Set())).not.toThrow();
  });

  it("at boot, removes the packages of roles no longer configured, and staging, and keeps each role's own", () => {
    const r = roleOnDisk();
    const kept = renderNative(root, r, bytesecRenderer, md(r));
    renderNative(root, roleOnDisk('retired'), bytesecRenderer, Buffer.from('r\n'));
    mkdirSync(join(root, 'implementer', '.stage-xyz'));
    mkdirSync(join(root, '.stray'));
    sweepRoles(root, new Set(['implementer', 'reviewer']));
    expect(readdirSync(root)).toEqual(['implementer']);
    expect(readdirSync(join(root, 'implementer'))).toEqual([kept.dir.slice(-64)]);
    // Before anything was ever rendered: nothing to do.
    expect(() => sweepRoles(join(base, 'absent'), new Set())).not.toThrow();
  });

  it('sweeps nothing through a render directory that is a symlink', () => {
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(join(elsewhere, 'implementer', 'old'), { recursive: true });
    mkdirSync(join(elsewhere, 'retired'));
    mkdirSync(join(base, 'home'), { recursive: true });
    symlinkSync(elsewhere, root);
    sweepRole(root, 'implementer', new Set());
    sweepRoles(root, new Set());
    expect(tree(elsewhere)).toEqual(['implementer/', 'implementer/old/', 'retired/']);
  });

  it('refuses a role name that is not one, so a sweep cannot leave the render directory', () => {
    renderNative(root, roleOnDisk(), bytesecRenderer, Buffer.from('x\n'));
    writeFileSync(join(base, 'home', 'config.yaml'), 'keep me');
    for (const name of ['..', '.', '', 'a/b', '../home']) sweepRole(root, name, new Set());
    expect(readdirSync(join(base, 'home')).sort()).toEqual(['config.yaml', 'rendered']);
    expect(readdirSync(root)).toEqual(['implementer']);
    expect(readdirSync(join(root, 'implementer'))).toHaveLength(1);
  });
});
