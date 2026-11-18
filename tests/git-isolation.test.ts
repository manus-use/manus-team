import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No test starts git itself: each goes through tests/helpers/git.ts, which
 * refuses an environment that would read the user's global or system git
 * configuration, so no hook of theirs (core.hooksPath) runs under a test.
 */
const ROOT = join(import.meta.dirname, '..');
const TESTS = join(ROOT, 'tests');
const HELPER = 'tests/helpers/git.ts';
/** A call that starts git: spawn, spawnSync, exec, execSync, execFile or execFileSync, with git as the command. */
const STARTS_GIT = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"`]git\b/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

describe('git in tests', () => {
  it('is started only through the isolating helper', () => {
    const offenders = files(TESTS)
      .map((path) => relative(ROOT, path))
      .filter((path) => path !== HELPER && path !== 'tests/git-isolation.test.ts')
      .filter((path) => STARTS_GIT.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('catches each way of starting git', () => {
    for (const line of ["spawnSync('git', [])", 'execFileSync("git", [])', "spawn('git', args)", 'execSync(`git status`)']) {
      expect(STARTS_GIT.test(line), line).toBe(true);
    }
    expect(STARTS_GIT.test("spawn('mt', ['kanban'])")).toBe(false);
  });
});
