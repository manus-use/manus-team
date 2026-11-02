import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadTeam } from '../src/team.js';

/**
 * The role default runs chat sessions, so there must be exactly one source for
 * it: a roles/default directory, or the gateway's agent: block. Both would be a
 * silent override -- a deployment running a command nobody can find in its
 * config -- and neither would leave chat with nothing to run.
 */
let root: string;
let home: string;
let workspace: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mt-team-')));
  home = join(root, 'home');
  workspace = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(workspace);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    MT_HOME: home,
    MT_WORKSPACE: workspace,
    MT_OWNER_OPEN_ID: 'ou_owner',
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret',
    MT_AGENT_COMMAND: 'claude-agent-acp',
    ...extra,
  };
}

function teamFor(e: Record<string, string | undefined>) {
  return loadTeam(loadConfig(e, () => undefined), e);
}

function roleDir(name: string, config: string): void {
  const dir = join(home, 'roles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), config);
}

const ROLE_AGENT = 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n';

describe('loadTeam', () => {
  it("makes the gateway's agent block the role default when there is no roles/default", () => {
    const team = teamFor(env());
    const role = team.roles.get('default');
    expect(role?.source).toBe('agent-block');
    expect(role?.agent.command).toBe('claude-agent-acp');
    expect(team.workspaces.get('default')).toBe(workspace);
  });

  it('uses roles/default when it exists and nothing else defines the default', () => {
    roleDir('default', ROLE_AGENT);
    const team = teamFor(env({ MT_AGENT_COMMAND: undefined }));
    expect(team.roles.get('default')?.source).toBe('directory');
    expect(team.roles.get('default')?.agent.command).toBe('bytesec');
  });

  it('refuses a role default defined twice', () => {
    roleDir('default', ROLE_AGENT);
    expect(() => teamFor(env())).toThrow(/define the role default; keep one/);
  });

  it('refuses to start with no role default at all', () => {
    expect(() => teamFor(env({ MT_AGENT_COMMAND: undefined }))).toThrow(/there is no role default/);
  });

  it('loads other roles beside the default, and passes on what it ignored', () => {
    roleDir('reviewer', ROLE_AGENT);
    writeFileSync(join(home, 'roles', 'notes.txt'), 'x');
    const team = teamFor(env());
    expect([...team.roles.keys()].sort()).toEqual(['default', 'reviewer']);
    expect(team.notes.some((n) => n.includes('notes.txt'))).toBe(true);
  });

  it('refuses a workspace that breaks the rules, before reading any role', () => {
    expect(() => teamFor(env({ MT_WORKSPACE: home }))).toThrow(/contains the gateway's home/);
  });

  it('can record unset passEnv names instead of failing, for mt role check', () => {
    roleDir('reviewer', `${ROLE_AGENT}  passEnv: [REVIEW_TOKEN]\n`);
    const e = env();
    expect(() => teamFor(e)).toThrow(/REVIEW_TOKEN, which is not set/);
    const unset: string[] = [];
    const team = loadTeam(loadConfig(e, () => undefined), e, { unsetPassEnv: unset });
    expect(unset).toEqual(['reviewer: REVIEW_TOKEN']);
    expect(team.roles.has('reviewer')).toBe(true);
  });
});
