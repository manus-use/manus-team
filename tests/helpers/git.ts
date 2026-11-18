import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

/**
 * Real git in a test, never with the user's own configuration: no global or
 * system file, so no `core.hooksPath` of theirs runs a hook, and a made-up home.
 * Every test that starts git goes through here; tests/git-isolation.test.ts
 * fails on any test file that spawns git itself.
 */
export const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } as const;

/** git's environment for a test: the isolation, `home` as HOME, this PATH, and `extra`. */
export function gitEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, ...extra, ...GIT_ISOLATION };
}

/**
 * Throws unless `env` is isolated: a test's git must not read the real home.
 * A test of the global configuration itself may name a global file of its
 * own, inside its made-up home.
 */
function assertIsolated(env: Readonly<Record<string, string | undefined>>): void {
  const home = env['HOME'];
  if (home === undefined || home === process.env['HOME']) throw new Error('a test ran git with the real HOME');
  const global = env['GIT_CONFIG_GLOBAL'];
  if (global !== GIT_ISOLATION.GIT_CONFIG_GLOBAL && !(global !== undefined && global.startsWith(`${home}/`))) {
    throw new Error(`a test ran git without GIT_CONFIG_GLOBAL=${GIT_ISOLATION.GIT_CONFIG_GLOBAL}`);
  }
  if (env['GIT_CONFIG_NOSYSTEM'] !== GIT_ISOLATION.GIT_CONFIG_NOSYSTEM) throw new Error('a test ran git without GIT_CONFIG_NOSYSTEM=1');
}

/** Runs git and gives its whole result, whatever its exit. */
export function gitSpawn(cwd: string, env: Readonly<Record<string, string | undefined>>, args: readonly string[]): SpawnSyncReturns<string> {
  assertIsolated(env);
  return spawnSync('git', [...args], { cwd, env: { ...env }, encoding: 'utf8' });
}

/** Runs git, throwing on a non-zero exit, and gives its stdout trimmed. */
export function git(cwd: string, env: Readonly<Record<string, string | undefined>>, ...args: string[]): string {
  const r = gitSpawn(cwd, env, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
