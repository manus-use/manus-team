import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMt } from '../src/cli/mt.js';
import { loadTeamSettings } from '../src/config.js';
import { CronChat, parseAdd } from '../src/cron/chat.js';
import { parseSchedule } from '../src/cron/schedule.js';
import { CronService } from '../src/cron/service.js';
import { CronTokens } from '../src/cron/tokens.js';
import { CronApi } from '../src/cron/worker.js';
import { bindSession } from '../src/db/bindings.js';
import { migrate, openDb, type Db } from '../src/db/open.js';
import { createSession } from '../src/db/sessions.js';
import { createTurn, setTurnState } from '../src/db/turns.js';
import { parseKanban } from '../src/kanban/chat-parse.js';
import { gateEnv } from '../src/kanban/gates.js';
import { KanbanService } from '../src/kanban/service.js';
import { hashToken, mintToken } from '../src/kanban/token.js';
import { WorkerApi } from '../src/kanban/worker.js';
import { checkWorkflow, type WorkflowFacts } from '../src/kanban/workflow.js';
import { clearSecrets } from '../src/secrets.js';
import { loadTeam, type Team } from '../src/team.js';
import type { BindingKey, InboundMessage } from '../src/types.js';
import { NOW } from './helpers/cron.js';
import { ManualClock, SCHEMA_DIR, testDb, type TestDb } from './helpers/db.js';
import { ALICE, VIA } from './helpers/kanban.js';

/**
 * The examples in the docs, kept correct: docs/examples.md, and the workflow
 * and cron examples of docs/kanban-guide.md and README.md. Each fenced block is
 * found by what it starts with, or by the `<!-- example: … -->` comment on the
 * line above it, and run through the gateway's own code: a workflow file
 * through the checker `mt workflow check` uses, a `/kanban workflow` line
 * through chat's parser and a real start, a `/cron add` through chat's `/cron`,
 * an `mt` command through `mt` itself, a cron script calling `mt` as a fire
 * runs it, and an agent's JSON through the handler it is sent to. Nothing here
 * touches ~/.manus-team: every home is a temporary directory.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DOCS = ['docs/examples.md', 'docs/kanban-guide.md', 'README.md'] as const;
type DocName = (typeof DOCS)[number];

/** Every example docs/examples.md must hold, by its marker. */
const EXPECTED_MARKERS = [
  'workflow weekly-report',
  'workflow content-pipeline',
  'workflow incident-followup',
  'workflow onboarding',
  'workflow multi-service-change',
  'workflow triage-and-route',
  'config services',
  'role.md triage',
  'kanban-agent start-workflow',
  'kanban-agent create',
  'cron daily-digest chat',
  'cron daily-digest terminal',
  'cron health-check chat',
  'cron health-check terminal',
  'cron board-review chat',
  'cron board-review terminal',
  'cron reminder-in chat',
  'cron reminder-at chat',
  'cron reminder-at terminal',
  'cron-agent add',
  'cron-agent answer',
  'cron weekly-workflow chat',
  'cron weekly-workflow terminal',
];

/** The launcher a cron script calls `mt` by (docs/examples.md, part 2). */
const LAUNCHER = '~/.manus-team/bin/mt';

// ---------------------------------------------------------------------------
// Reading the markdown

interface Block {
  doc: DocName;
  /** The line the fence opens on, 1-based. */
  line: number;
  info: string;
  body: string;
  /** What `<!-- example: … -->` on the line above says, if anything. */
  marker: string | undefined;
}

function where(b: Block): string {
  return `${b.doc}:${b.line}${b.marker === undefined ? '' : ` (${b.marker})`}`;
}

/** Every fenced block of a file, an indented one in a list included, with its marker. */
function blocksOf(doc: DocName): Block[] {
  const lines = readFileSync(join(REPO, doc), 'utf8').split('\n');
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(\s*)(`{3,})(.*)$/.exec(lines[i] ?? '');
    if (open === null) continue;
    const indent = open[1] ?? '';
    const fence = open[2] ?? '```';
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${fence}\\s*$`).test(lines[j] ?? '')) {
      const l = lines[j] ?? '';
      body.push(l.startsWith(indent) ? l.slice(indent.length) : l.trimStart());
      j += 1;
    }
    let k = i - 1;
    while (k >= 0 && (lines[k] ?? '').trim() === '') k -= 1;
    const marker = /^\s*<!-- example: (.+?) -->\s*$/.exec(lines[k] ?? '')?.[1];
    out.push({ doc, line: i + 1, info: (open[3] ?? '').trim(), body: body.join('\n'), marker });
    i = j;
  }
  return out;
}

/**
 * The `/kanban workflow start|preview` commands written in running text, as
 * inline code, each as a block of its own; a usage line, with <placeholders> or
 * an ellipsis, is no example.
 */
function inlineCommands(doc: DocName): Block[] {
  const text = readFileSync(join(REPO, doc), 'utf8');
  const out: Block[] = [];
  for (const m of text.matchAll(/`(\/kanban workflow (?:start|preview) [^`]+)`/g)) {
    const body = (m[1] ?? '').replace(/\s*\n\s*/g, ' ');
    if (/[<…]|\.\.\./.test(body)) continue;
    out.push({ doc, line: text.slice(0, m.index).split('\n').length, info: 'inline', body, marker: undefined });
  }
  return out;
}

/** A block's lines as commands: a `\` at a line's end joins the next, and a leading `$ ` is dropped. */
function commandsOf(body: string): { command: string; output: string[] }[] {
  const out: { command: string; output: string[] }[] = [];
  const joined = body.replace(/\\\n/g, ' ');
  for (const line of joined.split('\n')) {
    const m = /^(\$ )?(mt .*)$/.exec(line);
    // A usage line, with <placeholders>, [options] or …, is no command to run.
    if (m !== null && /<[a-z_|-]+>|\[-|\[<|…/.test(m[2] ?? '')) out.push({ command: '', output: [] });
    else if (m !== null) out.push({ command: m[2] ?? '', output: [] });
    else if (line.trim() !== '' && out.length > 0) out.at(-1)?.output.push(line);
  }
  return out;
}

/** A shell command line's words, as sh splits them: quotes, backslashes, nothing expanded. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\n') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      i += 1;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new Error(`an unclosed ' in ${text}`);
      word += text.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i += 1;
      while (text[i] !== '"') {
        if (i >= text.length) throw new Error(`an unclosed " in ${text}`);
        const d = text[i] ?? '';
        if (d === '\\' && '"\\$`'.includes(text[i + 1] ?? '')) {
          word += text[i + 1];
          i += 2;
        } else if (d === '$' || d === '`') {
          throw new Error(`the test reads no expansion inside double quotes: ${text}`);
        } else {
          word += d;
          i += 1;
        }
      }
      i += 1;
    } else if (c === '\\') {
      word += text[i + 1] ?? '';
      i += 2;
    } else if ('|&;<>()$`'.includes(c)) {
      throw new Error(`the test runs no ${c} of the shell: ${text}`);
    } else {
      word += c;
      i += 1;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** The ISO week of an instant, as `date +%G` and `date +%V` print it, in UTC. */
function isoWeek(at: number): { year: number; week: number } {
  const d = new Date(at);
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  return { year, week: Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7) };
}

/** A script with each `$(date +…)` put in as the shell would at NOW: %G, %V, %Y, %m, %d. */
function withDates(script: string): string {
  const { year, week } = isoWeek(NOW);
  const d = new Date(NOW);
  const two = (n: number): string => String(n).padStart(2, '0');
  const parts: Record<string, string> = {
    G: String(year),
    V: two(week),
    Y: String(d.getUTCFullYear()),
    m: two(d.getUTCMonth() + 1),
    d: two(d.getUTCDate()),
  };
  return script.replace(/\$\(date \+([^)]*)\)/g, (_m, fmt: string) =>
    fmt.replace(/%([A-Za-z])/g, (_p, c: string) => {
      const v = parts[c];
      if (v === undefined) throw new Error(`the test fills in no %${c}`);
      return v;
    }),
  );
}

// ---------------------------------------------------------------------------
// A home for each document: the team its examples name

interface Home {
  root: string;
  home: string;
  db: Db;
  team: Team;
  /** The isolated workspaces' names, as the config gives them. */
  isolated: ReadonlySet<string>;
  facts: WorkflowFacts;
  env: Record<string, string | undefined>;
  mt(argv: string[], env?: Record<string, string | undefined>): Promise<{ code: number; out: string; err: string }>;
}

const homes: Home[] = [];

/**
 * A gateway home at `<root>/.manus-team`, so a cron script's `~/.manus-team/bin/mt`
 * finds it with HOME at `<root>`: the roles worker, reviewer and triage, the
 * default role from the agent block, and the workspaces the examples name, two
 * of them isolated; its database migrated, and the boards the docs name.
 */
async function makeHome(): Promise<Home> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'docs-examples-')));
  const home = join(root, '.manus-team');
  const ws = (name: string): string => {
    const dir = join(root, 'ws', name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  mkdirSync(home);
  writeFileSync(
    join(home, 'config.yaml'),
    [
      'lark:',
      '  appId: cli_app',
      'agent:',
      '  driver: structured-cli',
      '  command: bytesec',
      '  unsupervised: true',
      'workspaces:',
      `  default: ${ws('default')}`,
      `  worker: ${ws('worker')}`,
      `  triage: ${ws('triage')}`,
      `  services: { path: ${ws('services')}, isolated: true }`,
      `  research: { path: ${ws('research')}, isolated: true }`,
      'cron:',
      '  tz: Asia/Shanghai',
      '',
    ].join('\n'),
  );
  const roles: Record<string, string> = { worker: 'workspace: worker\n', reviewer: '', triage: 'workspace: triage\n' };
  for (const [name, extra] of Object.entries(roles)) {
    mkdirSync(join(home, 'roles', name), { recursive: true });
    writeFileSync(join(home, 'roles', name, 'config.yaml'), `${extra}agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n`);
  }
  mkdirSync(join(home, 'workflows'));
  const db = openDb(join(home, 'team.db'));
  migrate(db, SCHEMA_DIR);
  const env = { MT_HOME: home, HOME: root, PATH: process.env['PATH'] };
  const settings = loadTeamSettings(env);
  const team = loadTeam(settings, env);
  const facts: WorkflowFacts = { roles: team.roles, workspaces: new Set(team.workspaces.keys()), supervisedRoles: true };
  const mt = async (argv: string[], over: Record<string, string | undefined> = env) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMt(argv, { env: over, out: (l) => out.push(l), err: (l) => err.push(l), agentVersion: () => '0.7.4' });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const h: Home = { root, home, db, team, isolated: new Set(Object.keys(settings.isolated ?? {})), facts, env, mt };
  for (const board of ['reports', 'web-app']) {
    const r = await mt(['kanban', 'board', 'create', board]);
    if (r.code !== 0) throw new Error(r.err);
  }
  homes.push(h);
  return h;
}

/** The board's service over a home, as the gateway builds it, with people who all have talk tier. */
function boardService(h: Home, db: Db = h.db): KanbanService {
  return new KanbanService({
    db,
    roles: h.team.roles,
    workspaces: new Set(h.team.workspaces.keys()),
    isolated: h.isolated,
    supervisedRoles: true,
    people: { canTalk: () => true },
    clock: new ManualClock(NOW),
    workflowsDir: join(h.home, 'workflows'),
  });
}

/** `@Bob Li` as the principal a mention of him would give. */
function principalOf(mention: string): string {
  return `lark:on_${mention.slice(1).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

/** The names a message's @-mentions would show, as chat's parser is given them. */
function mentionsIn(text: string): string[] {
  return [...text.matchAll(/@([A-Z][a-z]+(?: [A-Z][a-z]+)*)/g)].map((m) => m[1] ?? '');
}

// ---------------------------------------------------------------------------

const blocks = new Map<DocName, Block[]>(DOCS.map((d) => [d, blocksOf(d)]));
const docHome = new Map<DocName, Home>();

/** The workflow blocks of a document, by name: a yaml block with `steps:` at its top level. */
function workflowsOf(doc: DocName): { name: string; block: Block }[] {
  return (blocks.get(doc) ?? [])
    .filter((b) => b.info === 'yaml' && /^steps:/m.test(b.body))
    .map((b) => ({ name: /^workflow (\S+)$/.exec(b.marker ?? '')?.[1] ?? '', block: b }));
}

beforeAll(async () => {
  clearSecrets();
  for (const doc of DOCS) {
    const h = await makeHome();
    docHome.set(doc, h);
    for (const w of workflowsOf(doc)) if (w.name !== '') writeFileSync(join(h.home, 'workflows', `${w.name}.yaml`), w.block.body);
  }
});
afterAll(() => {
  clearSecrets();
  for (const h of homes) {
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the examples are all there, and marked', () => {
  it('docs/examples.md holds every example, each marked once', () => {
    const markers = (blocks.get('docs/examples.md') ?? []).flatMap((b) => (b.marker === undefined ? [] : [b.marker]));
    for (const m of EXPECTED_MARKERS) expect(markers.filter((x) => x === m), m).toHaveLength(1);
  });

  it('marks every workflow file in the docs with its name', () => {
    const found = DOCS.flatMap((d) => workflowsOf(d));
    expect(found.length).toBeGreaterThanOrEqual(9);
    for (const w of found) expect(w.name, `${where(w.block)}: a workflow needs <!-- example: workflow <name> --> above it`).not.toBe('');
  });

  it('writes no long dash in docs/examples.md', () => {
    const text = readFileSync(join(REPO, 'docs/examples.md'), 'utf8');
    expect(text.includes('\u2014')).toBe(false);
  });

  it('links docs/examples.md from the guide, twice, and the README', () => {
    const guide = readFileSync(join(REPO, 'docs/kanban-guide.md'), 'utf8');
    expect(guide.match(/\(examples\.md(#[^)]*)?\)/g)?.length).toBe(2);
    expect(readFileSync(join(REPO, 'README.md'), 'utf8')).toMatch(/\(docs\/examples\.md\)/);
  });
});

describe('the workflow files', () => {
  for (const doc of DOCS) {
    for (const w of workflowsOf(doc)) {
      it(`${where(w.block)} passes the check mt workflow check makes`, () => {
        const h = docHome.get(doc) as Home;
        const r = checkWorkflow(w.name, w.block.body, h.facts);
        expect(r.ok ? 'ok' : r.problem).toBe('ok');
      });
    }
  }

  it('says what each documented mt workflow check says', async () => {
    let checked = 0;
    for (const doc of DOCS) {
      const h = docHome.get(doc) as Home;
      for (const b of blocks.get(doc) ?? []) {
        for (const c of commandsOf(b.body).filter((x) => x.command.startsWith('mt workflow check'))) {
          const r = await h.mt(shellWords(c.command).slice(1));
          expect(r.code, `${where(b)}: ${r.out}`).toBe(0);
          const lines = r.out.split('\n');
          // A check of every file prints a line for each: the documented ones are among them.
          if (shellWords(c.command).length > 3) expect(lines, where(b)).toEqual(c.output);
          else for (const l of c.output) expect(lines, where(b)).toContain(l);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("isolates the services workspace as the config lines say", () => {
    const b = (blocks.get('docs/examples.md') ?? []).find((x) => x.marker === 'config services') as Block;
    expect(parseYaml(b.body)).toEqual({ workspaces: { services: { path: '/srv/repos/services', isolated: true, base: 'main' } } });
  });
});

describe('/kanban workflow start and preview', () => {
  it("each line parses as chat parses it, and starts or previews on the gateway's board", () => {
    let n = 0;
    for (const doc of DOCS) {
      const h = docHome.get(doc) as Home;
      const service = boardService(h);
      const fenced = (blocks.get(doc) ?? []).filter((x) => /^\/kanban workflow (start|preview) /.test(x.body));
      for (const b of [...fenced, ...inlineCommands(doc)]) {
        const text = b.body.slice('/kanban '.length);
        const parsed = parseKanban(text, mentionsIn(text));
        if (!parsed.ok) throw new Error(`${where(b)}: ${parsed.usage}`);
        const command = parsed.command as { verb: string; name: string; pairs: { key: string; value: string; quoted: boolean }[] };
        const req = {
          workflow: command.name,
          params: { from: 'chat' as const, pairs: command.pairs },
          personOf: (value: string) => ({ ok: true as const, principal: principalOf(value) }),
          idempotencyKey: `lark:om_docs_${doc}_${b.line}`,
          createdBy: ALICE,
          createdVia: VIA,
          board: 'default',
        };
        const r = command.verb === 'workflow start' ? service.startWorkflow(req) : service.previewWorkflow(req);
        expect(r.ok ? 'ok' : r.message, where(b)).toBe('ok');
        n += 1;
      }
    }
    // Six in docs/examples.md, two in the guide and one in the README.
    expect(n).toBeGreaterThanOrEqual(9);
  });

  it('each terminal start in docs/examples.md is made by mt, and a second with its key makes nothing', async () => {
    const h = docHome.get('docs/examples.md') as Home;
    let n = 0;
    for (const b of blocks.get('docs/examples.md') ?? []) {
      for (const c of commandsOf(b.body).filter((x) => /^mt kanban workflow (start|preview) /.test(x.command))) {
        const argv = [...shellWords(c.command).slice(1), '--json'];
        const first = await h.mt(argv);
        expect(first.code, `${where(b)}: ${first.out}${first.err}`).toBe(0);
        const again = await h.mt(argv);
        expect(JSON.parse(again.out), where(b)).toMatchObject({ ok: true, existing: true, instance_id: JSON.parse(first.out).instance_id });
        n += 1;
      }
    }
    expect(n).toBe(2);
  });
});

describe('/cron add and mt cron add', () => {
  const KEY: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };
  const message = (text: string, n: number): InboundMessage => ({
    messageId: `om_cron_docs_${n}`,
    appId: 'cli_app',
    chatId: 'oc_team',
    chatType: 'group',
    threadId: '',
    sender: { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' },
    senderIsBot: false,
    text,
    mentionedBot: true,
    mentionAll: false,
    attachments: [],
    createTime: NOW,
  });

  it("each /cron add is added by chat's /cron, its schedule read by the schedule's parser", async () => {
    let n = 0;
    for (const doc of DOCS) {
      const h = docHome.get(doc) as Home;
      const service = new CronService({ db: h.db, roles: h.team.roles, workspaces: new Set(h.team.workspaces.keys()), zone: 'Asia/Shanghai', clock: new ManualClock(NOW) });
      const chat = new CronChat({ db: h.db, service, hasTier: () => true });
      for (const b of (blocks.get(doc) ?? []).filter((x) => x.body.startsWith('/cron add '))) {
        const rest = b.body.slice('/cron add '.length);
        const parsed = parseAdd(rest);
        if (!parsed.ok) throw new Error(`${where(b)}: ${parsed.reply}`);
        const schedule = parseSchedule(parsed.command.schedule);
        expect(schedule.ok ? 'ok' : schedule.message, where(b)).toBe('ok');
        const reply = await chat.run(b.body.slice('/cron '.length), message(b.body, n), KEY);
        expect(reply, where(b)).toMatch(/^Added `c_[0-9a-z]+`, /);
        n += 1;
      }
    }
    // Six in docs/examples.md, two in the guide, one in the README.
    expect(n).toBeGreaterThanOrEqual(9);
  });

  it('each mt cron add is added by mt, on the day the examples were written', async () => {
    // A one-off's date is in the future only from then.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    let n = 0;
    for (const doc of DOCS) {
      const h = docHome.get(doc) as Home;
      for (const b of blocks.get(doc) ?? []) {
        for (const c of commandsOf(b.body).filter((x) => x.command.startsWith('mt cron add '))) {
          const r = await h.mt(shellWords(c.command).slice(1));
          expect(r.code, `${where(b)}: ${r.err}`).toBe(0);
          expect(r.out, where(b)).toMatch(/^added c_[0-9a-z]+: next /);
          n += 1;
        }
      }
    }
    // Five in docs/examples.md, one in the README.
    expect(n).toBeGreaterThanOrEqual(6);
  });

  it("each script calling mt runs as a fire runs it: with no agent's variables, mt found by HOME alone, and allowed", async () => {
    // A home of its own: a start the other tests made with the same key would be answered before any check.
    const h = await makeHome();
    for (const w of workflowsOf('docs/examples.md')) writeFileSync(join(h.home, 'workflows', `${w.name}.yaml`), w.block.body);
    const scripts: { block: Block; script: string }[] = [];
    for (const b of blocks.get('docs/examples.md') ?? []) {
      if (b.body.startsWith('/cron add ')) {
        const parsed = parseAdd(b.body.slice('/cron add '.length));
        if (parsed.ok && parsed.command.fields.script !== undefined) scripts.push({ block: b, script: parsed.command.fields.script });
      }
      for (const c of commandsOf(b.body).filter((x) => x.command.startsWith('mt cron add '))) {
        const words = shellWords(c.command);
        const at = words.indexOf('--script');
        if (at !== -1) scripts.push({ block: b, script: words[at + 1] ?? '' });
      }
    }
    const withMt = scripts.filter((s) => s.script.startsWith(`${LAUNCHER} `));
    // The board review and the weekly workflow, each in chat and at the terminal.
    expect(withMt).toHaveLength(4);
    // A fire's script gets the role's environment from the gateway's, which, inside the gateway, has these too.
    const gateway = { PATH: process.env['PATH'], HOME: h.root, MT_KANBAN_RUN: 'r_x', MT_KANBAN_TOKEN: 't', MT_KANBAN_SOCKET: '/s', MT_CRON_TOKEN: 'c', MT_CRON_FIRE: '1' };
    const env = gateEnv(h.team.roles.get('worker') as NonNullable<ReturnType<Team['roles']['get']>>, gateway);
    expect(Object.keys(env).filter((k) => k.startsWith('MT_'))).toEqual([]);
    vi.stubEnv('HOME', h.root);
    // Never the real home: mt finds ~/.manus-team by HOME, here the temporary one.
    expect(homedir()).toBe(h.root);
    const instances = new Map<string, string>();
    for (const s of withMt) {
      const words = shellWords(withDates(s.script));
      const r = await h.mt(words.slice(1), env);
      expect(r.code, `${where(s.block)}: ${r.out}${r.err}`).toBe(0);
      const answer = JSON.parse(r.out) as { ok: boolean; instance_id?: string; existing?: boolean };
      expect(answer.ok, where(s.block)).toBe(true);
      if (words.includes('start')) {
        // The same week's key: the second start makes nothing, and answers with the first's instance.
        const key = words[words.indexOf('--key') + 1] ?? '';
        expect(key).toBe(`weekly-${isoWeek(NOW).year}-${String(isoWeek(NOW).week).padStart(2, '0')}`);
        const before = instances.get(key);
        if (before === undefined) instances.set(key, answer.instance_id ?? '');
        else expect(answer, where(s.block)).toMatchObject({ existing: true, instance_id: before });
      }
    }
    expect(instances.size).toBe(1);
  });
});

describe("an agent's JSON", () => {
  let t: TestDb;
  beforeAll(() => {
    t = testDb();
  });
  afterAll(() => t.close());

  const json = (marker: string): Record<string, unknown> => {
    const b = (blocks.get('docs/examples.md') ?? []).find((x) => x.marker === marker) as Block;
    return JSON.parse(b.body) as Record<string, unknown>;
  };

  it("mt cron add's job.json is added by the handler, in an operator's chat turn, answered as documented", async () => {
    const h = docHome.get('docs/examples.md') as Home;
    const service = new CronService({ db: t.db, roles: h.team.roles, workspaces: new Set(h.team.workspaces.keys()), zone: 'Asia/Shanghai', clock: new ManualClock(NOW) });
    const tokens = new CronTokens({ db: t.db });
    const api = new CronApi({ db: t.db, service, tokens, appId: 'cli_app' });
    const key: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_team', threadId: '' };
    createSession(t.db, { id: 's_docs', agentId: 'default', workspaceId: 'default', ownerPrincipal: 'on_dana' }, NOW);
    bindSession(t.db, key, 's_docs', NOW);
    const token = tokens.envFor('s_docs', key)?.['MT_CRON_TOKEN'] ?? '';
    createTurn(t.db, { sessionId: 's_docs', turnId: 't_1', generation: 0, idempotencyKey: 'k1' }, NOW);
    setTurnState(t.db, 's_docs', 't_1', 'running');
    tokens.turnSubmitted('s_docs', 'k1', true);
    const r = (await api.handle({ cron: 'add', token, input: json('cron-agent add') })) as Record<string, unknown>;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const documented = json('cron-agent answer');
    expect(Object.keys(r).sort()).toEqual(Object.keys(documented).sort());
    for (const [k, v] of Object.entries(documented)) {
      // `c_…` and `session:…` stand for ids the gateway makes.
      if (typeof v === 'string' && v.endsWith('…')) expect(String(r[k]), k).toMatch(new RegExp(`^${v.slice(0, -1)}`));
      else expect(r[k], k).toEqual(v);
    }
  });

  it("the triage agent's start.json and task.json are taken by the worker API, from a triage run", async () => {
    const h = docHome.get('docs/examples.md') as Home;
    const service = boardService(h, t.db);
    const api = new WorkerApi({ db: t.db, service });
    const task = service.create({ title: 'Triage: a request', assignee: 'triage', createdBy: ALICE, createdVia: VIA });
    if (!task.ok) throw new Error(task.message);
    const token = mintToken();
    const claimed = service.claim(task.task.taskId, { tokenHash: hashToken(token) });
    if (!claimed.ok) throw new Error(claimed.message);
    const ask = (command: string, input: unknown) => api.handle({ run: claimed.run.runId, token, command, input });
    const started = await ask('start-workflow', json('kanban-agent start-workflow'));
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true, existing: false, instance_id: expect.stringMatching(/^w_/) });
    const created = await ask('create', json('kanban-agent create'));
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
  });
});
