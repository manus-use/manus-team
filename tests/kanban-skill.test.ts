import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { installSkill, MARK, skillLine, skillPlan, skillTarget } from '../src/cli/skill-install.js';
import { loadTeamSettings } from '../src/config.js';
import { parseCommand } from '../src/core/commands.js';
import { migrate, openDb } from '../src/db/open.js';
import { parseKanban } from '../src/kanban/chat-parse.js';
import { KanbanService } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import { WORKER_COMMANDS, WorkerApi } from '../src/kanban/worker.js';
import { loadRoleDir } from '../src/roles.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam, type Team } from '../src/team.js';
import { ManualClock, SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, NOW, VIA } from './helpers/kanban.js';

/**
 * The board's skill, skills/mt-kanban/SKILL.md, kept true to the gateway: its
 * front matter passes the gateway's own skill checks, a role that lists it in
 * agent.skills loads it and one that does not, does not; every `mt …` and
 * `/kanban …` command it quotes is read by the real parsers, as
 * docs-examples.test.ts reads the docs; its JSON is taken by the worker API; and
 * the copy `mt update` makes (src/cli/skill-install.ts) installs it, replaces
 * only its own copy, and leaves anyone else's. Every home is a temporary
 * directory; nothing touches the real ~/.agents or ~/.manus-team.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(REPO, 'skills', 'mt-kanban');
const TEXT = readFileSync(join(SOURCE, 'SKILL.md'), 'utf8');
const AGENT = 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n';

const roots: string[] = [];
function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kanban-skill-')));
  roots.push(root);
  return root;
}
afterAll(() => {
  clearSecrets();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Reading the skill

/** The skill's text outside its fenced blocks, and the blocks, each with the prose line before it. */
function split(text: string): { prose: string; fences: { info: string; body: string; before: string }[] } {
  const lines = text.split('\n');
  const prose: string[] = [];
  const fences: { info: string; body: string; before: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^```(.*)$/.exec(lines[i] ?? '');
    if (open === null) {
      prose.push(lines[i] ?? '');
      continue;
    }
    let k = i - 1;
    while (k >= 0 && (lines[k] ?? '').trim() === '') k -= 1;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j] !== '```') body.push(lines[j++] ?? '');
    fences.push({ info: (open[1] ?? '').trim(), body: body.join('\n'), before: lines[k] ?? '' });
    i = j;
  }
  return { prose: prose.join('\n'), fences };
}

const { prose, fences } = split(TEXT);
/** Every inline code span of the prose, a span broken over two lines joined. */
const spans = [...prose.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? '').replace(/\s*\n\s*/g, ' '));

/** A quoted command with its placeholders filled, as someone would type it. */
function filled(command: string): string {
  return command
    .replace(/<id>/g, 'k_1')
    .replace(/<name>/g, 'weekly-report')
    .replace(/<comment>/g, 'the speaker is Ana Ruiz');
}

// ---------------------------------------------------------------------------

describe('the skill file', () => {
  it("passes the gateway's own skill checks, as a role's own skill and as one imported by agent.skills", () => {
    const root = tempRoot();
    const own = join(root, 'roles', 'worker');
    mkdirSync(join(own, 'skills'), { recursive: true });
    writeFileSync(join(own, 'config.yaml'), AGENT);
    cpSync(SOURCE, join(own, 'skills', 'mt-kanban'), { recursive: true });
    const loaded = loadRoleDir('worker', own, {}, new Set(['default'])).role;
    expect(loaded.skills.map((s) => s.name)).toEqual(['mt-kanban']);
    expect(loaded.skills[0]?.description).toMatch(/^Working on the manus-team task board/);

    const home = join(root, 'home');
    cpSync(SOURCE, join(home, '.agents', 'skills', 'mt-kanban'), { recursive: true });
    const listing = join(root, 'roles', 'listing');
    mkdirSync(listing, { recursive: true });
    writeFileSync(join(listing, 'config.yaml'), `${AGENT}  skills: [mt-kanban]\n`);
    const imported = loadRoleDir('listing', listing, { HOME: home }, new Set(['default'])).role;
    expect(imported.skills).toMatchObject([{ name: 'mt-kanban', dir: join(home, '.agents', 'skills', 'mt-kanban') }]);

    // A role that does not list it gets nothing, the skill installed or not.
    const plain = join(root, 'roles', 'plain');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'config.yaml'), AGENT);
    expect(loadRoleDir('plain', plain, { HOME: home }, new Set(['default'])).role.skills).toEqual([]);
  });

  it('is plain text of a reasonable length: no long dash, no ellipsis character', () => {
    const lines = TEXT.split('\n').length;
    expect(lines).toBeGreaterThanOrEqual(120);
    expect(lines).toBeLessThanOrEqual(200);
    expect(TEXT).not.toMatch(/[\u2014\u2026]/);
  });

  it('names only the reportable block kinds, and every one of them', () => {
    const kinds = ['needs_input', 'capability', 'transient', 'dependency'];
    for (const k of kinds) expect(TEXT).toContain(`- \`${k}\`:`);
    expect(TEXT).toContain('`gave_up` is the board\'s own');
  });
});

// ---------------------------------------------------------------------------
// The commands it quotes

describe('the commands the skill quotes', () => {
  let root: string;
  let env: Record<string, string | undefined>;
  let usage: string;
  const mt = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(argv, { env, out: (l) => out.push(l), err: (l) => err.push(l), agentVersion: () => '0.7.4' });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  beforeAll(async () => {
    root = tempRoot();
    const home = join(root, '.manus-team');
    const ws = join(root, 'ws');
    mkdirSync(ws, { recursive: true });
    mkdirSync(home);
    writeFileSync(join(home, 'config.yaml'), ['lark:', '  appId: cli_app', `workspace: ${ws}`, AGENT].join('\n'));
    for (const name of ['worker', 'reviewer']) {
      mkdirSync(join(home, 'roles', name), { recursive: true });
      writeFileSync(join(home, 'roles', name, 'config.yaml'), AGENT);
    }
    const db = openDb(join(home, 'team.db'));
    migrate(db, SCHEMA_DIR);
    db.close();
    env = { MT_HOME: home, HOME: root, PATH: process.env['PATH'] };
    usage = (await mt(['help'])).out;
  });

  it('quotes each mt command so that mt reads it: a worker command, an operator command, or a name its usage gives', async () => {
    const commands = spans.filter((s) => s.startsWith('mt '));
    expect(commands.length).toBeGreaterThanOrEqual(15);
    for (const c of commands) {
      const [line = '', input] = filled(c).split(' < ');
      const argv = line.split(' ').slice(1);
      const r = await mt(argv);
      const said = `${c}: exit ${r.code}\n${r.out}\n${r.err}`;
      expect(r.err, said).not.toMatch(/unknown command/);
      const worker = argv[0] === 'kanban' && (WORKER_COMMANDS as readonly string[]).includes(argv[1] ?? '');
      if (worker) {
        // Outside a run a worker's command says so, by name: a name mt does not know would be a usage error.
        expect(JSON.parse(r.out), said).toMatchObject({ ok: false, code: 'not_in_a_run' });
        // Its JSON on stdin, from a file, when the command is written in full; show takes none.
        if (input !== undefined) expect(input, c).toMatch(/^[a-z]+\.json$/);
        if (argv[1] === 'show') expect(input, c).toBeUndefined();
      } else if (r.code === 2) {
        // A command named without its arguments: its usage line is mt's own.
        expect(usage.split('\n').some((l) => l.startsWith(`  ${line}`)), said).toBe(true);
      } else {
        expect(input, c).toBeUndefined();
      }
    }
  });

  it('quotes each /kanban command so that chat parses it, and the other slash commands by a name chat knows', () => {
    const slash = spans.filter((s) => s.startsWith('/'));
    const blocks = fences.filter((f) => f.body.startsWith('/kanban ')).map((f) => f.body);
    expect(blocks).toHaveLength(1);
    let n = 0;
    for (const c of [...slash, ...blocks]) {
      const text = filled(c);
      const parsed = parseCommand(text);
      expect(parsed !== undefined && !('unknown' in parsed), c).toBe(true);
      if (!text.startsWith('/kanban ')) continue;
      const kanban = parseKanban(text.slice('/kanban '.length), []);
      n += 1;
      // A command named without its arguments is answered with its own usage line.
      if (!kanban.ok && kanban.usage.includes(`\`${text} <`)) continue;
      expect(kanban.ok ? 'ok' : kanban.usage, c).toBe('ok');
    }
    expect(n).toBeGreaterThanOrEqual(8);
    expect(slash).toContain('/role list');
  });

  it('quotes the woken turn and the chat shell as the gateway refuses and answers them', async () => {
    // With cron on, a chat shell refuses the operator's commands.
    const cronOn = { ...env, MT_AGENT_SESSION: 's_1', MT_CRON_TOKEN: 'x'.repeat(43) };
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(['kanban', 'task', 'new', 'A title', '--json'], { env: cronOn, out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, code: 'operator_command' });
    expect(TEXT).toContain('refused in your shell as `operator_command`');
  });
});

// ---------------------------------------------------------------------------
// The JSON it quotes

describe('the JSON the skill quotes', () => {
  let t: TestDb;
  let team: Team;
  let root: string;
  beforeAll(() => {
    t = testDb();
    root = tempRoot();
    const home = join(root, '.manus-team');
    mkdirSync(join(home, 'roles', 'worker'), { recursive: true });
    mkdirSync(join(root, 'ws'));
    writeFileSync(join(home, 'config.yaml'), [`workspace: ${join(root, 'ws')}`, AGENT].join('\n'));
    writeFileSync(join(home, 'roles', 'worker', 'config.yaml'), AGENT);
    const e = { MT_HOME: home, HOME: root };
    team = loadTeam(loadTeamSettings(e), e);
  });
  afterAll(() => t.close());

  /** A fresh run of a task for role worker, and how it asks the worker API. */
  function run(): (command: string, input: unknown) => Promise<Record<string, unknown>> {
    // A board of its own: a workspace has one open run at a time.
    t.close();
    t = testDb();
    const service = new KanbanService({
      db: t.db,
      roles: team.roles,
      workspaces: new Set(team.workspaces.keys()),
      supervisedRoles: true,
      people: { canTalk: () => true },
      clock: new ManualClock(NOW),
    });
    const api = new WorkerApi({ db: t.db, service });
    const task = service.create({ title: 'Draft the agenda', assignee: 'worker', createdBy: ALICE, createdVia: VIA });
    if (!task.ok) throw new Error(task.message);
    const token = mintToken();
    const claimed = service.claim(task.task.taskId, { tokenHash: hashToken(token) });
    if (!claimed.ok) throw new Error(claimed.message);
    return async (command, input) => (await api.handle({ run: claimed.run.runId, token, command, input })) as Record<string, unknown>;
  }

  it('gives each JSON example to the command it is for, and the worker API takes it', async () => {
    const examples = fences.filter((f) => f.info === 'json');
    expect(examples).toHaveLength(2);
    for (const f of examples) {
      const command = [...f.before.matchAll(/`mt kanban ([a-z-]+)`/g)].at(-1)?.[1] ?? '';
      expect(WORKER_COMMANDS as readonly string[], f.before).toContain(command);
      const r = await run()(command, JSON.parse(f.body));
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    }
  });

  it("names in its inline JSON only fields the command beside it takes", async () => {
    const lines = prose.split('\n\n').map((p) => p.replace(/\s*\n\s*/g, ' '));
    let n = 0;
    for (const p of lines) {
      for (const m of p.matchAll(/`(\{[^`]+\})`/g)) {
        const before = p.slice(0, m.index);
        const command = [...before.matchAll(/`mt kanban ([a-z-]+)/g)].at(-1)?.[1] ?? '';
        expect(WORKER_COMMANDS as readonly string[], p).toContain(command);
        const r = await run()(command, JSON.parse(m[1] ?? ''));
        // Refused or not, for what the run is: never for a field the command does not take.
        expect(String(r['message'] ?? ''), `${command} ${m[1]}`).not.toMatch(/takes no field|needs /);
        n += 1;
      }
    }
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// The copy mt update makes

describe("mt update's copy of the skill", () => {
  const target = (home: string): string => join(home, '.agents', 'skills', 'mt-kanban');

  it('goes under HOME, to ~/.agents/skills/mt-kanban, a folder agent.skills is looked up in', () => {
    expect(skillTarget({ HOME: '/home/u' })).toBe('/home/u/.agents/skills/mt-kanban');
    expect(skillTarget({})).toBeUndefined();
  });

  it('installs a fresh copy with its list, and a role listing it loads it from there', () => {
    const home = tempRoot();
    const r = installSkill(SOURCE, target(home));
    expect(r).toEqual({ done: 'installed', target: target(home), kept: [] });
    expect(readFileSync(join(target(home), 'SKILL.md'), 'utf8')).toBe(TEXT);
    expect(readFileSync(join(target(home), MARK), 'utf8').split('\n').slice(1)).toEqual(['SKILL.md', '']);
    const dir = join(home, 'role');
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.yaml'), `${AGENT}  skills: [mt-kanban]\n`);
    expect(loadRoleDir('r', dir, { HOME: home }, new Set(['default'])).role.skills[0]?.dir).toBe(target(home));
  });

  it("replaces its own copy: writes the source's files, removes the ones it dropped, and keeps someone's own", () => {
    const home = tempRoot();
    installSkill(SOURCE, target(home));
    writeFileSync(join(target(home), 'SKILL.md'), 'an old version');
    writeFileSync(join(target(home), 'old.md'), 'a file an older version shipped');
    writeFileSync(join(target(home), MARK), '# list\nSKILL.md\nold.md\n../outside.md\n');
    writeFileSync(join(home, '.agents', 'skills', 'outside.md'), 'not ours to remove');
    writeFileSync(join(target(home), 'notes.md'), 'my own notes');
    const r = installSkill(SOURCE, target(home));
    expect(r).toEqual({ done: 'replaced', target: target(home), kept: ['notes.md'] });
    expect(skillLine(r)).toBe(`replaced the mt-kanban skill at ${target(home)}; kept a file not from manus-team: notes.md`);
    expect(readFileSync(join(target(home), 'SKILL.md'), 'utf8')).toBe(TEXT);
    expect(existsSync(join(target(home), 'old.md'))).toBe(false);
    expect(readFileSync(join(target(home), 'notes.md'), 'utf8')).toBe('my own notes');
    expect(existsSync(join(home, '.agents', 'skills', 'outside.md'))).toBe(true);
  });

  it("leaves a directory it did not make, a symlink and a file as they are, saying why", () => {
    const home = tempRoot();
    mkdirSync(target(home), { recursive: true });
    writeFileSync(join(target(home), 'SKILL.md'), '---\nname: mt-kanban\ndescription: my own\n---\n');
    const r = installSkill(SOURCE, target(home));
    expect(r.done).toBe('left');
    expect(skillLine(r)).toMatch(/^warning: left .* as it is: manus-team did not install it \(it has no \.installed-by-manus-team\)/);
    expect(readFileSync(join(target(home), 'SKILL.md'), 'utf8')).toContain('my own');

    const linked = tempRoot();
    mkdirSync(join(linked, '.agents', 'skills'), { recursive: true });
    symlinkSync(SOURCE, target(linked));
    expect(skillPlan(target(linked))).toEqual({ kind: 'foreign', why: 'it is a symlink, not a copy manus-team made' });
    expect(installSkill(SOURCE, target(linked)).done).toBe('left');

    const file = tempRoot();
    mkdirSync(join(file, '.agents', 'skills'), { recursive: true });
    writeFileSync(target(file), 'a file');
    expect(skillPlan(target(file))).toEqual({ kind: 'foreign', why: 'it is not a directory' });
  });
});
