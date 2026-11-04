import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun, getTask, runsOf } from '../src/db/kanban-read.js';
import { loadRoleDir, type Role } from '../src/roles.js';
import { completes, dispatchHarness, holds, reportComplete, role, until, type DispatchHarness } from './helpers/dispatch.js';

/**
 * Native rendering in the dispatcher (plan R): a bytesec role with a role.md or
 * skills runs as its own agent package, given by `--agent` and
 * `BYTESEC_LOCAL_APM_PATH`, and its prompt leaves role.md and the skills out.
 */

const open: DispatchHarness[] = [];
let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mt-native-')));
  root = join(base, 'home', 'rendered');
});

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
  rmSync(base, { recursive: true, force: true });
});

function harness(...args: Parameters<typeof dispatchHarness>): DispatchHarness {
  const h = dispatchHarness(...args);
  open.push(h);
  return h;
}

/** The role implementer, on bytesec, with a role.md and a skill on disk. */
function implementer(extra: Partial<Role['agent']> = {}): Role {
  const dir = join(base, 'roles', 'implementer');
  const skillDir = join(dir, 'skills', 'testing');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(dir, 'role.md'), 'You change code in this repository.\n');
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: testing\ndescription: How to test\n---\nRun npm test.\n');
  const r = role('implementer', {
    dir,
    roleMdPath: join(dir, 'role.md'),
    skills: [{ name: 'testing', description: 'How to test', dir: skillDir, path: join(skillDir, 'SKILL.md') }],
  });
  return { ...r, agent: { ...r.agent, ...extra } };
}

const promptOf = (h: DispatchHarness, i: number) => h.driver('implementer').runtimes[i]?.prompts[0]?.text ?? '';
const packages = () => readdirSync(join(root, 'implementer')).sort();

describe('Dispatcher: native rendering', () => {
  it("runs a bytesec role as its own package: --agent, the package in its environment, and a prompt without its files", async () => {
    const h = harness({ roles: [implementer()], renderRoot: root });
    const task = h.create({ title: 'Write the parser', workspace: 'web' });
    completes(h, h.driver('implementer'));
    h.dispatcher.pass();
    await h.dispatcher.idle();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(getTask(h.t.db, task.taskId)?.phase).toBe('done');
    const start = h.driver('implementer').starts[0];
    expect(start?.args).toEqual(['--agent', 'implementer']);
    const dir = start?.env?.['BYTESEC_LOCAL_APM_PATH'] ?? '';
    expect(dir).toMatch(new RegExp(`^${root}/implementer/[0-9a-f]{64}$`));
    expect(start?.env?.['MT_KANBAN_RUN']).toBe(run?.runId);
    expect(readFileSync(join(dir, 'agents', 'implementer.md'), 'utf8')).toMatch(/---\nYou change code in this repository\.\n$/);
    expect(readFileSync(join(dir, 'skills', 'testing', 'SKILL.md'), 'utf8')).toContain('Run npm test.');

    const prompt = promptOf(h, 0);
    expect(prompt).not.toContain('# Your role');
    expect(prompt).not.toContain('# Skills');
    expect(prompt.startsWith('# How to work')).toBe(true);
    expect(prompt).toContain(`${task.taskId}: Write the parser`);
    expect(h.notes).toContain(`kanban: run ${run?.runId} runs role implementer as a native bytesec agent`);
    // Recorded on the run, by the package it ran.
    expect(getRun(h.t.db, run?.runId ?? '')?.agentConfig).toMatchObject({ native: true, packageHash: dir.slice(-64) });
  });

  it('keeps role.md and the skills in the prompt for a role that opts out, or with no render root', async () => {
    for (const opts of [{ roles: [implementer({ native: false })], renderRoot: root }, { roles: [implementer()] }]) {
      const h = harness(opts);
      const task = h.create({ workspace: 'web' });
      completes(h, h.driver('implementer'));
      h.dispatcher.pass();
      await h.dispatcher.idle();
      const start = h.driver('implementer').starts[0];
      expect(start?.args).toBeUndefined();
      expect(start?.env).toEqual({ MT_KANBAN_RUN: expect.any(String), MT_KANBAN_TOKEN: expect.any(String) });
      const prompt = promptOf(h, 0);
      expect(prompt).toContain('# Your role\n\nYou change code in this repository.');
      expect(prompt).toContain(`- testing: How to test (${join(base, 'roles', 'implementer', 'skills', 'testing', 'SKILL.md')})`);
      const [run] = runsOf(h.t.db, task.taskId);
      expect(run?.agentConfig).toMatchObject({ native: false });
      expect(run?.agentConfig).not.toHaveProperty('packageHash');
    }
    expect(readdirSync(base)).toEqual(['roles']);
  });

  it('puts role.md and the skills in the prompt when rendering fails, and says so', async () => {
    mkdirSync(join(base, 'home'));
    writeFileSync(root, 'not a directory');
    const h = harness({ roles: [implementer()], renderRoot: root });
    const task = h.create({ workspace: 'web' });
    completes(h, h.driver('implementer'));
    h.dispatcher.pass();
    await h.dispatcher.idle();

    const [run] = runsOf(h.t.db, task.taskId);
    expect(run?.outcome).toBe('completed');
    expect(h.driver('implementer').starts[0]?.args).toBeUndefined();
    expect(promptOf(h, 0)).toContain('# Your role');
    expect(run?.agentConfig).toMatchObject({ native: false });
    expect(h.notes.join('\n')).toContain(
      `kanban: run ${run?.runId}: rendering role implementer for bytesec failed, so its role.md and skills go in the prompt: `,
    );
  });

  it('gives runs on two versions of role.md their own packages, and removes one once nothing uses it', async () => {
    const r = implementer();
    const h = harness({ roles: [r], renderRoot: root });
    const agent = h.driver('implementer');
    const first = h.create({ title: 'first', workspace: 'web' });
    const held = holds(agent);
    h.dispatcher.pass();
    await until(() => held.started, 'the first run to be working');

    // Edited while the first run works: the next claim reads the new text.
    writeFileSync(r.roleMdPath ?? '', 'You change code, and you test it.\n');
    const second = h.create({ title: 'second', workspace: 'api' });
    completes(h, agent);
    h.dispatcher.pass();
    await until(() => getTask(h.t.db, second.taskId)?.phase === 'done', 'the second task to be done');

    const dirs = agent.starts.map((s) => s.env?.['BYTESEC_LOCAL_APM_PATH'] ?? '');
    const a = dirs[0] ?? '';
    const b = dirs[1] ?? '';
    expect(a).not.toBe(b);
    // The first run is still open, so its package was kept.
    expect(packages()).toEqual([a, b].map((d) => d.slice(-64)).sort());
    expect(readFileSync(join(b, 'agents', 'implementer.md'), 'utf8')).toMatch(/you test it\.\n$/);

    const firstRun = runsOf(h.t.db, first.taskId)[0]?.runId ?? '';
    held.end('completed', () => reportComplete(h, firstRun));
    await h.dispatcher.idle();
    // The next render sweeps: the first package is no longer in use.
    h.create({ title: 'third', workspace: 'web' });
    completes(h, agent);
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(agent.starts[2]?.env?.['BYTESEC_LOCAL_APM_PATH']).toBe(b);
    expect(packages()).toEqual([b.slice(-64)]);
  });

  it("copies a role's imported skills into its package, or lists them in the prompt when it is not rendered", async () => {
    // A made-up home's user skill, imported by name, as startup would load it.
    const home = join(base, 'user');
    const userSkill = join(home, '.agents', 'skills', 'lark-doc');
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, 'SKILL.md'), '---\nname: lark-doc\ndescription: Lark docs\n---\nRead docs.\n');
    const dir = join(base, 'roles', 'writer');
    mkdirSync(dir, { recursive: true });
    const config = (native: boolean) =>
      `agent:\n  driver: structured-cli\n  command: bytesec\n  args: [run]\n  unsupervised: true\n  native: ${native}\n  skills: [lark-doc]\n`;
    writeFileSync(join(dir, 'config.yaml'), config(true));
    const writer = loadRoleDir('writer', dir, { HOME: home }, new Set(['default', 'web'])).role;

    const h = harness({ roles: [writer], renderRoot: root });
    h.create({ assignee: 'writer', workspace: 'web' });
    completes(h, h.driver('writer'));
    h.dispatcher.pass();
    await h.dispatcher.idle();
    const pkg = h.driver('writer').starts[0]?.env?.['BYTESEC_LOCAL_APM_PATH'] ?? '';
    expect(readFileSync(join(pkg, 'skills', 'lark-doc', 'SKILL.md'), 'utf8')).toContain('Read docs.');

    // A changed user skill is a new package.
    writeFileSync(join(userSkill, 'SKILL.md'), '---\nname: lark-doc\ndescription: Lark docs\n---\nRead them well.\n');
    h.create({ assignee: 'writer', workspace: 'web' });
    completes(h, h.driver('writer'));
    h.dispatcher.pass();
    await h.dispatcher.idle();
    expect(h.driver('writer').starts[1]?.env?.['BYTESEC_LOCAL_APM_PATH']).not.toBe(pkg);

    // Not rendered, the same setting lists the skill where the agent can read it.
    writeFileSync(join(dir, 'config.yaml'), config(false));
    const injected = loadRoleDir('writer', dir, { HOME: home }, new Set(['default', 'web'])).role;
    const h2 = harness({ roles: [injected], renderRoot: root });
    h2.create({ assignee: 'writer', workspace: 'web' });
    completes(h2, h2.driver('writer'));
    h2.dispatcher.pass();
    await h2.dispatcher.idle();
    expect(h2.driver('writer').runtimes[0]?.prompts[0]?.text).toContain(`- lark-doc: Lark docs (${join(userSkill, 'SKILL.md')})`);
  });

  it('at boot, removes the packages of roles no longer configured, and any left half written', async () => {
    const h = harness({ roles: [implementer()], renderRoot: root });
    mkdirSync(join(root, 'retired', 'a'.repeat(64)), { recursive: true });
    mkdirSync(join(root, 'implementer', 'b'.repeat(64)), { recursive: true });
    mkdirSync(join(root, 'implementer', '.stage-x1'));
    await h.dispatcher.boot();
    expect(readdirSync(root)).toEqual(['implementer']);
    expect(packages()).toEqual(['b'.repeat(64)]);
  });
});
