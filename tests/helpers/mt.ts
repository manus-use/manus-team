import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMt, type Git } from '../../src/cli/mt.js';

/**
 * A temporary gateway home with a config file and a workspace, and a runner that
 * captures what `mt` prints. Every test gets its own; nothing touches ~/.manus-team.
 */
export interface MtFixture {
  root: string;
  home: string;
  workspace: string;
  configPath: string;
  env: Record<string, string | undefined>;
  run(
    argv: string[],
    opts?: { env?: Record<string, string | undefined>; git?: Git },
  ): Promise<{ code: number; out: string; err: string }>;
  cleanup(): void;
}

export function mtFixture(config?: (workspace: string) => string): MtFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-cli-')));
  const home = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
  const configPath = join(home, 'config.yaml');
  writeFileSync(
    configPath,
    config?.(workspace) ??
      [
        '# test config',
        `workspace: ${workspace}`,
        'agent:',
        '  driver: structured-cli',
        '  command: bytesec',
        '  args: [run, -m, test-model]',
        '  unsupervised: true',
        '',
      ].join('\n'),
  );
  const env = { MT_HOME: home, PATH: process.env['PATH'], HOME: process.env['HOME'] };
  return {
    root,
    home,
    workspace,
    configPath,
    env,
    async run(argv, opts = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runMt(argv, {
        env: { ...env, ...opts.env },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        ...(opts.git === undefined ? {} : { git: opts.git }),
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
