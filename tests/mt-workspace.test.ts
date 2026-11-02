import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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

  it('reports a config file the gateway would refuse as mt: <message>, exit 1', async () => {
    fx = mtFixture();
    appendFileSync(fx.configPath, 'bogus: 1\n');
    const r = await fx.run(['workspace', 'add', 'docs', docsDir()]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mt: .*unknown setting bogus/);
  });
});
