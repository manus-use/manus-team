import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Git } from '../src/cli/mt.js';
import { loadTeamSettings } from '../src/config.js';
import { migrate, openDb } from '../src/db/open.js';
import { registerWorkspaces } from '../src/db/workspaces.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';

let fx: MtFixture;
afterEach(() => fx.cleanup());

function docsDir(): string {
  const dir = join(fx.root, 'docs');
  mkdirSync(dir);
  return dir;
}

describe('mt workspace add', () => {
  it('adds a workspace to the config file, keeping its comments', async () => {
    fx = mtFixture();
    const docs = docsDir();
    const r = await fx.run(['workspace', 'add', 'docs', docs]);
    expect(r.code).toBe(0);
    const text = readFileSync(fx.configPath, 'utf8');
    expect(text).toMatch(/# test config/);
    expect((parseYaml(text) as { workspaces: Record<string, string> }).workspaces['docs']).toBe(docs);
    expect(loadTeamSettings(fx.env).workspaces['docs']).toBe(docs);
  });

  it('refuses when there is no config file', async () => {
    fx = mtFixture();
    rmSync(fx.configPath);
    const r = await fx.run(['workspace', 'add', 'docs', docsDir()], { env: { MT_WORKSPACE: fx.workspace } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no config file/);
  });

  it('names the file it looked for when MT_CONFIG is set but empty', async () => {
    fx = mtFixture();
    rmSync(fx.configPath);
    const r = await fx.run(['workspace', 'add', 'docs', docsDir()], { env: { MT_CONFIG: ' ', MT_WORKSPACE: fx.workspace } });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`(looked for ${fx.configPath})`);
  });

  it('refuses a name already in the workspaces, and default while workspace: sets it', async () => {
    fx = mtFixture();
    const docs = docsDir();
    expect((await fx.run(['workspace', 'add', 'docs', docs])).code).toBe(0);
    expect((await fx.run(['workspace', 'add', 'docs', docs])).err).toMatch(/already/);
    expect((await fx.run(['workspace', 'add', 'default', docs])).err).toMatch(/workspace: in the config file/);
  });

  it('refuses what the next start would refuse, and leaves the file as it was', async () => {
    fx = mtFixture();
    const before = readFileSync(fx.configPath, 'utf8');
    for (const path of ['docs', join(fx.root, 'missing'), fx.home, join(fx.workspace, 'inner')]) {
      if (path.endsWith('inner')) mkdirSync(path);
      const r = await fx.run(['workspace', 'add', 'docs', path]);
      expect(r.code, path).toBe(1);
    }
    expect(readFileSync(fx.configPath, 'utf8')).toBe(before);
  });

  it('refuses a name the database recorded for a different directory', async () => {
    fx = mtFixture();
    const db = openDb(join(fx.home, 'gateway.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['docs', '/elsewhere']]), 0);
    db.close();
    const r = await fx.run(['workspace', 'add', 'docs', docsDir()]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/workspace docs is \/elsewhere/);
  });

  it('refuses a name outside the grammar, and a wrong command line', async () => {
    fx = mtFixture();
    expect((await fx.run(['workspace', 'add', 'Docs', docsDir()])).code).toBe(1);
    expect((await fx.run(['workspace', 'add', 'docs'])).code).toBe(2);
  });

  it.skipIf(process.getuid?.() === 0)('reports a config file it cannot write as mt: <message>, exit 1', async () => {
    fx = mtFixture();
    const docs = docsDir();
    const before = readFileSync(fx.configPath, 'utf8');
    chmodSync(fx.home, 0o500);
    try {
      const r = await fx.run(['workspace', 'add', 'docs', docs]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/^mt: cannot write/);
    } finally {
      chmodSync(fx.home, 0o700);
    }
    expect(readFileSync(fx.configPath, 'utf8')).toBe(before);
  });

  it('keeps the comment on an empty workspaces: key', async () => {
    fx = mtFixture((ws) => `workspace: ${ws}\nworkspaces:  # extra repos\n`);
    const docs = docsDir();
    const r = await fx.run(['workspace', 'add', 'docs', docs]);
    expect(r.code, r.err).toBe(0);
    const text = readFileSync(fx.configPath, 'utf8');
    expect(text).toMatch(/# extra repos/);
    expect((parseYaml(text) as { workspaces: Record<string, string> }).workspaces['docs']).toBe(docs);
  });

  it('keeps the mode of the config file whatever the umask', async () => {
    fx = mtFixture();
    chmodSync(fx.configPath, 0o664);
    const old = process.umask(0o077);
    try {
      expect((await fx.run(['workspace', 'add', 'docs', docsDir()])).code).toBe(0);
    } finally {
      process.umask(old);
    }
    expect(statSync(fx.configPath).mode & 0o777).toBe(0o664);
  });

  it('leaves a temporary file it did not create', async () => {
    fx = mtFixture();
    const stray = `${fx.configPath}.mt-${process.pid}.tmp`;
    writeFileSync(stray, 'another run');
    const r = await fx.run(['workspace', 'add', 'docs', docsDir()]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: cannot write/);
    expect(readFileSync(stray, 'utf8')).toBe('another run');
    expect(readdirSync(fx.home)).toContain('config.yaml');
  });

  it('reports a config file the gateway would refuse as mt: <message>, exit 1', async () => {
    fx = mtFixture();
    appendFileSync(fx.configPath, 'bogus: 1\n');
    const r = await fx.run(['workspace', 'add', 'docs', docsDir()]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: .*unknown setting bogus/);
  });
});

describe('mt workspace add --clone', () => {
  it('clones into the home and adds it', async () => {
    fx = mtFixture();
    const source = join(fx.root, 'source');
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-q', '-m', 'init']);
    const r = await fx.run(['workspace', 'add', 'docs', '--clone', source]);
    expect(r.code, r.err).toBe(0);
    const target = join(fx.home, 'workspaces', 'docs');
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(loadTeamSettings(fx.env).workspaces['docs']).toBe(target);
  });

  it('removes a failed clone and leaves the config file alone', async () => {
    fx = mtFixture();
    const before = readFileSync(fx.configPath, 'utf8');
    const git: Git = async (args) => {
      const target = args[3] ?? '';
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'partial'), 'x');
      return { code: 128, stderr: 'fatal: repository not found' };
    };
    const r = await fx.run(['workspace', 'add', 'docs', '--clone', 'https://example.invalid/x.git'], { git });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/git clone failed \(exit 128\)/);
    expect(r.err).toMatch(/repository not found/);
    expect(existsSync(join(fx.home, 'workspaces', 'docs'))).toBe(false);
    expect(readFileSync(fx.configPath, 'utf8')).toBe(before);
  });

  it('refuses when the clone directory exists, without running git', async () => {
    fx = mtFixture();
    mkdirSync(join(fx.home, 'workspaces', 'docs'), { recursive: true });
    let ran = false;
    const git: Git = async () => {
      ran = true;
      return { code: 0, stderr: '' };
    };
    const r = await fx.run(['workspace', 'add', 'docs', '--clone', 'https://example.invalid/x.git'], { git });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already exists/);
    expect(ran).toBe(false);
  });

  it('refuses a dangling symlink at the clone directory, without running git, and leaves it', async () => {
    fx = mtFixture();
    const parent = join(fx.home, 'workspaces');
    mkdirSync(parent, { recursive: true });
    const link = join(parent, 'docs');
    symlinkSync(join(fx.root, 'nowhere'), link);
    const calls: (readonly string[])[] = [];
    const git: Git = async (args) => {
      calls.push(args);
      return { code: 128, stderr: 'fatal: no' };
    };
    const r = await fx.run(['workspace', 'add', 'docs', '--clone', 'https://example.invalid/x.git'], { git });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already exists/);
    expect(calls).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe('mt workspace list', () => {
  it('lists each workspace and whether the gateway has registered it', async () => {
    fx = mtFixture();
    const db = openDb(join(fx.home, 'gateway.db'));
    migrate(db, SCHEMA_DIR);
    registerWorkspaces(db, new Map([['default', fx.workspace], ['old', '/srv/old']]), 0);
    db.close();
    const r = await fx.run(['workspace', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`^default\\s+${fx.workspace}\\s+registered$`, 'm'));
    expect(r.out).toMatch(/^old\s+\/srv\/old\s+registered, not in the config$/m);
  });
});
