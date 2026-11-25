import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { loadConfig } from '../src/config.js';
import { createBoard } from '../src/db/kanban.js';
import { migrate, openDb } from '../src/db/open.js';
import { notePerson } from '../src/db/people.js';
import { parseKanban } from '../src/kanban/chat-parse.js';
import { clearSecrets } from '../src/secrets.js';
import { SCHEMA_DIR } from './helpers/db.js';

/**
 * The wakes in the docs (wake spec §13): the guide's section on them, the
 * README's commands and settings, and docs/examples.md's workflow started with
 * a wake, each read as the gateway reads it. Each example is found by the
 * `<!-- example: … -->` comment on the line above its fence.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const read = (doc: string): string => readFileSync(join(REPO, doc), 'utf8');

/** The fenced block under `<!-- example: <marker> -->` in `doc`. */
function example(doc: string, marker: string): string {
  const lines = read(doc).split('\n');
  const at = lines.findIndex((l) => l.trim() === `<!-- example: ${marker} -->`);
  if (at === -1) throw new Error(`${doc} has no example ${marker}`);
  let i = at + 1;
  while ((lines[i] ?? '').trim() === '') i += 1;
  const fence = /^(`{3,})/.exec(lines[i] ?? '')?.[1];
  if (fence === undefined) throw new Error(`${doc}: no fence under ${marker}`);
  const body: string[] = [];
  for (let j = i + 1; j < lines.length && (lines[j] ?? '').trim() !== fence; j += 1) body.push(lines[j] ?? '');
  return body.join('\n');
}

/** A section of a markdown file, from its heading to the next of its level or higher. */
function section(doc: string, heading: string): string {
  const lines = read(doc).split('\n');
  const at = lines.indexOf(heading);
  if (at === -1) throw new Error(`${doc} has no ${heading}`);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const end = lines.findIndex((l, i) => i > at && /^#+ /.test(l) && (/^#+/.exec(l)?.[0].length ?? 0) <= level);
  return lines.slice(at, end === -1 ? undefined : end).join('\n');
}

const roots: string[] = [];
afterEach(() => {
  clearSecrets();
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

describe("the guide's wakes", () => {
  it('has a section on them, with no long dash', () => {
    const text = section('docs/kanban-guide.md', '### Wakes');
    expect(text).toContain('Waking the agent for 1 board update.');
    expect(text.includes('\u2014')).toBe(false);
  });

  it("turns a new task's wake on with a field line, as chat parses it", () => {
    const parsed = parseKanban(example('docs/kanban-guide.md', 'wake task new').slice('/kanban '.length), []);
    expect(parsed).toMatchObject({ ok: true, command: { verb: 'new', wake: true } });
  });

  it("turns an existing task's wake on and off, as chat parses it", () => {
    const lines = example('docs/kanban-guide.md', 'wake task wake').split('\n');
    expect(lines.map((l) => parseKanban(l.slice('/kanban '.length), []))).toEqual([
      { ok: true, command: { verb: 'wake', taskId: 'k_7gq2', on: true } },
      { ok: true, command: { verb: 'wake', taskId: 'k_7gq2', on: false } },
    ]);
  });

  it('gives the settings with their defaults, as the configuration reads them', () => {
    const file = example('docs/kanban-guide.md', 'config wake');
    const config = loadConfig({ MT_HOME: '/nonexistent-home', LARK_APP_ID: 'cli_app', LARK_APP_SECRET: 's', MT_OWNER_OPEN_ID: 'ou_owner', MT_AGENT_COMMAND: 'bytesec', MT_WORKSPACE: REPO }, () => file);
    expect(config.kanban.wake).toEqual({ enabled: true, perHour: 6, maxDepth: 5, holdMinutes: 10 });
    expect(parseYaml(file)).toEqual({ kanban: { enabled: true, wake: { enabled: true, per_hour: 6, max_depth: 5, hold_minutes: 10 } } });
  });
});

describe("the guide's role wakes", () => {
  it("names a role on a new task's field line, as chat parses it, with no long dash", () => {
    const parsed = parseKanban(example('docs/kanban-guide.md', 'wake role task new').slice('/kanban '.length), []);
    expect(parsed).toMatchObject({ ok: true, command: { verb: 'new', wake: true, wakeRole: 'vi-coordinator' } });
    expect(section('docs/kanban-guide.md', '#### A role as a wake\'s target')).toContain('Waking vi-coordinator for 1 board update (k_…).');
    expect(section('docs/kanban-guide.md', '#### A role as a wake\'s target').includes('\u2014')).toBe(false);
  });

  it('says a role needs no chat, at the terminal, and that its reaction task then has no notices', () => {
    const text = section('docs/kanban-guide.md', '#### A role as a wake\'s target');
    expect(text).toContain('`--wake-role` needs no `--chat`');
    expect(text).toContain('no marker and no notices');
  });

  it('names the forms chat parses for an existing task and a start', () => {
    expect(parseKanban('task wake k_7gq2 vi-coordinator', [])).toMatchObject({ ok: true, command: { verb: 'wake', taskId: 'k_7gq2', on: true, role: 'vi-coordinator' } });
    expect(parseKanban('workflow start weekly-report wake:vi-coordinator', [])).toMatchObject({ ok: true, command: { verb: 'workflow start', wakeRole: 'vi-coordinator' } });
  });
});

describe("the README's wakes", () => {
  it('lists the chat command and the terminal commands', () => {
    const text = read('README.md');
    expect(text).toContain('| `/kanban task wake <task> on\\|off` | talk');
    expect(text).toContain('[--chat <chat_id> [--thread <thread_id>] [--wake]] [--wake-role <role>]');
    expect(text).toContain('mt kanban task wake <task_id> on|off|<role> [--board <name>]');
    expect(text).toContain('| `/kanban task wake <task> <role>` | operate');
    expect(text).toContain('start-workflow|apply-dag|wake-show|wake-unblock> < input.json');
  });

  it('leaves the settings to docs/configuration.md, which lists them', () => {
    const text = read('docs/configuration.md');
    for (const key of ['kanban.wake.enabled', 'kanban.wake.per_hour', 'kanban.wake.max_depth', 'kanban.wake.hold_minutes']) expect(text).toContain(`\`${key}\``);
  });
});

describe("docs/examples.md's workflow with a wake", () => {
  it("starts it from chat with the trailing word wake, as chat parses it", () => {
    const line = example('docs/examples.md', 'wake weekly-report chat');
    const parsed = parseKanban(line.slice('/kanban '.length), ['Bob Li']);
    expect(parsed).toMatchObject({ ok: true, command: { verb: 'workflow start', name: 'weekly-report', wake: true } });
  });

  it('starts it from the terminal with --wake, every member woken as the owner', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'docs-wake-')));
    roots.push(root);
    const home = join(root, '.manus-team');
    mkdirSync(join(root, 'ws'), { recursive: true });
    mkdirSync(home);
    writeFileSync(
      join(home, 'config.yaml'),
      ['lark:', '  appId: cli_app', 'auth:', '  owner: ou_owner', 'agent:', '  driver: structured-cli', '  command: bytesec', '  unsupervised: true', 'workspaces:', `  default: ${join(root, 'ws')}`, ''].join('\n'),
    );
    for (const role of ['worker', 'reviewer']) {
      mkdirSync(join(home, 'roles', role), { recursive: true });
      writeFileSync(join(home, 'roles', role, 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
    }
    mkdirSync(join(home, 'workflows'));
    writeFileSync(join(home, 'workflows', 'weekly-report.yaml'), example('docs/examples.md', 'workflow weekly-report'));
    const db = openDb(join(home, 'team.db'));
    try {
      migrate(db, SCHEMA_DIR);
      // weekly-report names its board, which the operator makes once (docs/examples.md).
      createBoard(db, 'reports', 'operator:me', 1);
      // The owner, as the gateway notes them once they have used /kanban in Lark (wake spec §3.2).
      notePerson(db, { appId: 'cli_app', unionId: 'on_owner', openId: 'ou_owner', name: 'Owner' }, 1);
      const command = example('docs/examples.md', 'wake weekly-report terminal').replace(/^\$ mt /, '').replace('<chat_id>', 'oc_team');
      const out: string[] = [];
      const err: string[] = [];
      const code = await runMt([...command.split(' '), '--json'], { env: { MT_HOME: home, HOME: root, PATH: process.env['PATH'] }, out: (l) => out.push(l), err: (l) => err.push(l) });
      expect(code, err.join('\n')).toBe(0);
      expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: true, existing: false, follows: { chat: 'oc_team', thread: null } });
      const members = db.prepare<[], { wake_by: string | null }>('SELECT wake_by FROM kanban_tasks').all();
      expect(members).toHaveLength(4);
      expect(new Set(members.map((m) => m.wake_by))).toEqual(new Set(['lark:on_owner']));
    } finally {
      db.close();
    }
  });
});
