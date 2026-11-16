import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { loadConfig } from '../src/config.js';
import { createGateway, loadStartup } from '../src/index.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam } from '../src/team.js';
import { serviceFake, type ServiceFake } from './helpers/service.js';
import { mtFixture, type MtFixture } from './helpers/mt.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * The checks' output (spec §21.4): `mt workflow check`, with and without a
 * name, its exit codes, in a run's shell; the startup's lines, which a broken
 * workflow does not stop; and `mt service check`'s warnings, which pass.
 */

const BROKEN = 'steps:\n  welcome:\n    title: Welcome\n    gates:\n      - command: "echo {{name}}"\n';
const BROKEN_PROBLEM = 'steps.welcome.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead';

/** A config whose default role is the agent block's, so the example's `worker` and `reviewer` need role directories. */
function roles(home: string, names: readonly string[], extra = ''): void {
  for (const name of names) {
    mkdirSync(join(home, 'roles', name), { recursive: true });
    writeFileSync(join(home, 'roles', name, 'config.yaml'), `agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n${extra}`);
  }
}

function workflows(home: string, files: Record<string, string>): string {
  const dir = join(home, 'workflows');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('mt workflow check', () => {
  let f: MtFixture;
  beforeEach(() => {
    clearSecrets();
    f = mtFixture();
    roles(f.home, ['worker', 'reviewer']);
  });
  afterEach(() => {
    clearSecrets();
    f.cleanup();
  });

  it('prints a line a workflow, then what it ignored; exit 0 when all are usable, 1 when one is not', async () => {
    const dir = workflows(f.home, { 'vendor-eval.yaml': VENDOR_EVAL, 'notes.txt': 'x' });
    const ok = await f.run(['workflow', 'check']);
    expect(ok).toEqual({
      code: 0,
      out: [
        'vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)',
        `ignoring ${join(dir, 'notes.txt')}: not a .yaml file, so not a workflow`,
      ].join('\n'),
      err: '',
    });
    workflows(f.home, { 'onboarding.yaml': BROKEN });
    const broken = await f.run(['workflow', 'check']);
    expect(broken.code).toBe(1);
    expect(broken.out.split('\n')).toEqual([
      `onboarding: not usable: ${BROKEN_PROBLEM}`,
      'vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)',
      `ignoring ${join(dir, 'notes.txt')}: not a .yaml file, so not a workflow`,
    ]);
  });

  it('checks one workflow by name: 0 usable, 1 not, 1 for a name with no file, 2 for two names', async () => {
    const dir = workflows(f.home, { 'vendor-eval.yaml': VENDOR_EVAL, 'onboarding.yaml': BROKEN });
    expect(await f.run(['workflow', 'check', 'vendor-eval'])).toMatchObject({ code: 0, out: expect.stringMatching(/^vendor-eval: ok, 3 steps; /) });
    expect(await f.run(['workflow', 'check', 'onboarding'])).toEqual({ code: 1, out: `onboarding: not usable: ${BROKEN_PROBLEM}`, err: '' });
    expect(await f.run(['workflow', 'check', 'release'])).toEqual({ code: 1, out: `release: no workflow file ${join(dir, 'release.yaml')}`, err: '' });
    const bad = "workflow name \"../roles\" must be lowercase letters, digits and '-', start with a letter, not end with '-', and be at most 40 characters";
    expect(await f.run(['workflow', 'check', '../roles'])).toEqual({ code: 1, out: bad, err: '' });
    expect((await f.run(['workflow', 'check', 'Vendor-Eval'])).out).toMatch(/^workflow name "Vendor-Eval" must be lowercase letters/);
    const two = await f.run(['workflow', 'check', 'a', 'b']);
    expect(two.code).toBe(2);
    expect(two.err).toMatch(/^mt: workflow check takes at most one name/);
  });

  it('says a file that cannot be read is not usable, never crashing, and checks the others', async () => {
    const dir = workflows(f.home, { 'vendor-eval.yaml': VENDOR_EVAL, 'locked.yaml': VENDOR_EVAL });
    chmodSync(join(dir, 'locked.yaml'), 0o000);
    expect(await f.run(['workflow', 'check'])).toEqual({
      code: 1,
      out: [
        'locked: not usable: the file cannot be read: EACCES',
        'vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)',
      ].join('\n'),
      err: '',
    });
    expect(await f.run(['workflow', 'check', 'locked'])).toEqual({ code: 1, out: 'locked: not usable: the file cannot be read: EACCES', err: '' });
    expect(await f.run(['workflow', 'check', 'vendor-eval'])).toMatchObject({ code: 0 });
  });

  it('says a workflows directory that cannot be read, exit 1, with no stack trace', async () => {
    writeFileSync(join(f.home, 'workflows'), 'not a directory\n');
    const all = await f.run(['workflow', 'check']);
    expect(all).toMatchObject({ code: 1, out: '' });
    expect(all.err).toMatch(new RegExp(`^mt: workflows directory ${join(f.home, 'workflows')} cannot be read: ENOTDIR`));
    expect(all.err).not.toMatch(/\n\s+at /);
    const one = await f.run(['workflow', 'check', 'vendor-eval']);
    expect(one).toEqual({ code: 1, out: 'vendor-eval: not usable: the file cannot be read: ENOTDIR', err: '' });
  });

  it('says so when there is no workflow', async () => {
    expect(await f.run(['workflow', 'check'])).toEqual({ code: 0, out: `no workflows: ${join(f.home, 'workflows')} is missing or empty`, err: '' });
  });

  it("refuses a gate holding a secret of the gateway's .env, and says which passEnv names this shell leaves unset", async () => {
    writeFileSync(join(f.home, '.env'), 'LARK_APP_SECRET=lark-secret-123456\n', { mode: 0o600 });
    roles(f.home, ['needs-token'], '  passEnv: [GH_TOKEN]\n');
    workflows(f.home, { 'leaky.yaml': 'steps:\n  a:\n    title: A\n    gates:\n      - command: "curl lark-secret-123456"\n' });
    const r = await f.run(['workflow', 'check']);
    expect(r.code).toBe(1);
    expect(r.out).toBe(
      "leaky: not usable: steps.a.gates[0].command holds a known secret, and a gate is stored and run as written: pass the value through the role's environment and name it in the command, as $NAME",
    );
    expect(r.err).toBe('mt: needs-token: GH_TOKEN not set in this shell, so a gate holding those values cannot be refused here');
  });

  it("works in a board run's shell, saying its secret check is weaker there", async () => {
    workflows(f.home, { 'vendor-eval.yaml': VENDOR_EVAL });
    const r = await f.run(['workflow', 'check'], { env: { MT_KANBAN_RUN: 'r_1', MT_KANBAN_TOKEN: 'tok' } });
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toEqual([
      "note: this is a board run's shell, which reads neither the gateway's .env nor its secrets, so a gate holding one of them cannot be refused here",
      'vendor-eval: ok, 3 steps; params: topic (required), vendors (list, required), reviewer (default reviewer)',
    ]);
  });
});

describe('the startup', () => {
  let root: string;
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    clearSecrets();
    root = mkdtempSync(join(tmpdir(), 'mt-wf-startup-'));
    const home = join(root, 'home');
    mkdirSync(join(root, 'repo'), { recursive: true });
    mkdirSync(home);
    roles(home, ['worker', 'reviewer']);
    env = {
      MT_HOME: home,
      MT_WORKSPACE: join(root, 'repo'),
      MT_OWNER_OPEN_ID: 'ou_owner',
      LARK_APP_ID: 'cli_app',
      LARK_APP_SECRET: 'app-secret-123456',
      MT_AGENT_COMMAND: 'bytesec',
      MT_AGENT_DRIVER: 'structured-cli',
      MT_AGENT_UNSUPERVISED: 'true',
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearSecrets();
    rmSync(root, { recursive: true, force: true });
  });

  it('says workflows: none for no directory, and lists the usable and the broken without stopping', () => {
    expect(loadStartup(env).workflows).toEqual(['workflows: none']);
    workflows(join(root, 'home'), { 'vendor-eval.yaml': VENDOR_EVAL, 'onboarding.yaml': BROKEN });
    expect(loadStartup(env).workflows).toEqual([`workflow onboarding is not usable: ${BROKEN_PROBLEM}`, 'workflows: vendor-eval; not usable: onboarding']);
  });

  it('says a file that cannot be read is not usable, the others still listed', () => {
    const dir = workflows(join(root, 'home'), { 'vendor-eval.yaml': VENDOR_EVAL, 'locked.yaml': VENDOR_EVAL });
    chmodSync(join(dir, 'locked.yaml'), 0o000);
    expect(loadStartup(env).workflows).toEqual(['workflow locked is not usable: the file cannot be read: EACCES', 'workflows: vendor-eval; not usable: locked']);
  });

  it('says a directory that cannot be read, and that there are no workflows, without stopping', () => {
    writeFileSync(join(root, 'home', 'workflows'), 'not a directory\n');
    const lines = loadStartup(env).workflows;
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^workflows directory ${join(root, 'home', 'workflows')} cannot be read: ENOTDIR`)), 'workflows: none']);
  });

  it("notes the lines after the roles' line", async () => {
    workflows(join(root, 'home'), { 'vendor-eval.yaml': VENDOR_EVAL, 'onboarding.yaml': BROKEN });
    const started = loadStartup(env);
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk).replace(/^\S+ /, '').trimEnd());
      return true;
    });
    const config = loadConfig(env, () => undefined);
    const gateway = await createGateway(config, loadTeam(config, env), { workflows: started.workflows });
    try {
      const roles = lines.findIndex((l) => l.startsWith('roles: '));
      expect(roles).toBeGreaterThan(-1);
      expect(lines.slice(roles + 1, roles + 3)).toEqual([`workflow onboarding is not usable: ${BROKEN_PROBLEM}`, 'workflows: vendor-eval; not usable: onboarding']);
    } finally {
      await gateway.stop();
    }
  });
});

describe("mt service check's warnings", () => {
  let fx: ServiceFake;
  afterEach(() => {
    clearSecrets();
    fx.cleanup();
  });

  async function check(): Promise<{ code: number; out: string[]; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(['service', 'check'], {
      env: { PATH: '/usr/bin:/bin', HOME: fx.home },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      service: fx.deps(),
    });
    return { code, out, err: err.join('\n') };
  }

  it('warns of a workflows directory that cannot be read, and passes', async () => {
    fx = await serviceFake();
    writeFileSync(join(fx.mtHome, 'workflows'), 'not a directory\n');
    const r = await check();
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith('warning: '))).toEqual([
      expect.stringMatching(new RegExp(`^warning: workflows directory ${join(fx.mtHome, 'workflows')} cannot be read: ENOTDIR`)),
    ]);
  });

  for (const unit of [true, false]) {
    it(`prints the build's unusable workflows as warnings, and passes, ${unit ? 'with a unit' : 'with no unit'}`, async () => {
      fx = await serviceFake();
      workflows(fx.mtHome, { 'onboarding.yaml': BROKEN, 'leaky.yaml': 'steps:\n  a:\n    title: A\n    gates:\n      - command: "echo {{x}}"\n' });
      if (unit) fx.install();
      const r = await check();
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out.filter((l) => l.startsWith('warning: '))).toEqual([
        'warning: workflow leaky is not usable: steps.a.gates[0].command holds {{, and a gate is a shell command: name the value as an environment variable instead',
        `warning: workflow onboarding is not usable: ${BROKEN_PROBLEM}`,
      ]);
      expect(r.out.at(-1)).toMatch(/^ok: this build would start as /);
    });
  }
});
