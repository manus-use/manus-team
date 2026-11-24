import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardsAt } from '../src/db/boards-at.js';
import { archiveBoard, createBoard } from '../src/db/kanban.js';
import { migrate, openDb } from '../src/db/open.js';
import { SCHEMA_DIR } from './helpers/db.js';
import { loadStartup } from '../src/index.js';
import { KanbanChat } from '../src/kanban/chat.js';
import { PeopleDirectory } from '../src/kanban/people.js';
import { KanbanService } from '../src/kanban/service.js';
import type { BindingKey, InboundMessage, Principal } from '../src/types.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { runMt } from '../src/cli/mt.js';
import { clearSecrets } from '../src/secrets.js';
import { ALICE, NOW } from './helpers/kanban.js';

/**
 * A workflow's own board at the fronts (workflows spec §19.4, §19.5): the boards
 * read at a path, the startup, `mt workflow check`, the terminal and chat.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mt-wf-board-fronts-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('boardsAt', () => {
  it('gives default alone with no database, and for one from before migration 006', () => {
    expect(boardsAt(join(root, 'none.db'))).toEqual({ ok: true, boards: new Map([['default', false]]) });
    const old = new Database(join(root, 'old.db'));
    old.pragma('user_version = 5');
    old.close();
    expect(boardsAt(join(root, 'old.db'))).toEqual({ ok: true, boards: new Map([['default', false]]) });
  });

  it("gives a migrated database's boards, each with whether it is archived", () => {
    const db = openDb(join(root, 'team.db'));
    migrate(db, SCHEMA_DIR);
    createBoard(db, 'vi', ALICE, NOW);
    createBoard(db, 'old', ALICE, NOW);
    archiveBoard(db, 'old', ALICE, NOW);
    db.close();
    expect(boardsAt(join(root, 'team.db'))).toEqual({ ok: true, boards: new Map([['default', false], ['old', true], ['vi', false]]) });
  });

  it('says why when the database is held past the busy timeout', () => {
    const path = join(root, 'locked.db');
    const holder = new Database(path);
    holder.pragma('journal_mode = DELETE');
    holder.exec("CREATE TABLE kanban_boards (name TEXT, archived_at INTEGER); PRAGMA user_version = 6; BEGIN EXCLUSIVE; INSERT INTO kanban_boards VALUES ('vi', NULL);");
    try {
      const r = boardsAt(path);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.why).toMatch(/locked|busy/i);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});

/** A file of one step for `worker`, on these top lines. */
export const fileOn = (top: string): string => `${top}${top === '' ? '' : '\n'}steps:\n  sync:\n    title: Sync the team\n    assignee: worker\n`;

/** A home at `<root>/home` with the role worker and these workflow files, and the env the startup reads. */
function home(files: Record<string, string>): Record<string, string | undefined> {
  const h = join(root, 'home');
  mkdirSync(join(h, 'roles', 'worker'), { recursive: true });
  writeFileSync(join(h, 'roles', 'worker', 'config.yaml'), 'agent:\n  driver: structured-cli\n  command: bytesec\n  unsupervised: true\n');
  mkdirSync(join(h, 'workflows'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(h, 'workflows', name), text);
  mkdirSync(join(root, 'repo'), { recursive: true });
  return {
    MT_HOME: h,
    MT_WORKSPACE: join(root, 'repo'),
    MT_OWNER_OPEN_ID: 'ou_owner',
    LARK_APP_ID: 'cli_app',
    LARK_APP_SECRET: 'app-secret-123456',
    MT_AGENT_COMMAND: 'bytesec',
    MT_AGENT_DRIVER: 'structured-cli',
    MT_AGENT_UNSUPERVISED: 'true',
  };
}

/** The home's database, migrated, with these boards made and these archived. */
function boards(made: readonly string[], archived: readonly string[] = []): void {
  const db = openDb(join(root, 'home', 'team.db'));
  migrate(db, SCHEMA_DIR);
  for (const b of made) createBoard(db, b, ALICE, NOW);
  for (const b of archived) archiveBoard(db, b, ALICE, NOW);
  db.close();
}

const MISSING = 'workflow vi-sync is not usable: its board vi does not exist (create it with /kanban board create vi, or mt kanban board create vi)';

describe('the startup', () => {
  beforeEach(() => clearSecrets());
  afterEach(() => clearSecrets());

  it('says a workflow on a missing board is not usable, with no database, and lists one naming default as usable', () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi'), 'home-sync.yaml': fileOn('board: default') });
    expect(loadStartup(env).workflows).toEqual([MISSING, 'workflows: home-sync; not usable: vi-sync']);
  });

  it('says the archived words for an archived board, and lists a live one as usable', () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi') });
    boards(['vi'], ['vi']);
    expect(loadStartup(env).workflows).toEqual([
      'workflow vi-sync is not usable: its board vi is archived, and nothing is added to it (name another board in its file)',
      'workflows: none; not usable: vi-sync',
    ]);
    rmSync(join(root, 'home', 'team.db'));
    boards(['vi']);
    expect(loadStartup(env).workflows).toEqual(['workflows: vi-sync']);
  });

  it('says once when the database cannot be read, and judges the files alone', () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi') });
    const holder = new Database(join(root, 'home', 'team.db'));
    holder.pragma('journal_mode = DELETE');
    holder.exec('CREATE TABLE kanban_boards (name TEXT, archived_at INTEGER); PRAGMA user_version = 6; BEGIN EXCLUSIVE; INSERT INTO kanban_boards VALUES (1, NULL);');
    try {
      const lines = loadStartup(env).workflows;
      expect(lines[0]).toMatch(/^workflow boards are not checked: the database cannot be read: .*(locked|busy)/i);
      expect(lines.slice(1)).toEqual(['workflows: vi-sync']);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});

/** `mt` over the home `home()` made, its output joined. */
async function mt(env: Record<string, string | undefined>, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMt(argv, { env: { ...env, PATH: process.env['PATH'], HOME: root }, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const NOTE = 'note: the gateway checks the board when the workflow is used, not here: this check opens no database';

describe('mt workflow check', () => {
  beforeEach(() => clearSecrets());
  afterEach(() => clearSecrets());

  it("names a workflow's board and says once that the gateway checks it, exit 0 with no such board", async () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi') });
    expect(await mt(env, ['workflow', 'check', 'vi-sync'])).toMatchObject({ code: 0, out: ['vi-sync: ok, 1 step; params: none; board vi', NOTE].join('\n') });
  });

  it('says the note once for several workflows naming boards, and not at all when none does', async () => {
    const env = home({ 'a-sync.yaml': fileOn('board: vi'), 'b-sync.yaml': fileOn('board: research'), 'c-sync.yaml': fileOn(''), 'notes.txt': 'x' });
    const all = await mt(env, ['workflow', 'check']);
    expect(all.code).toBe(0);
    expect(all.out.split('\n')).toEqual([
      'a-sync: ok, 1 step; params: none; board vi',
      'b-sync: ok, 1 step; params: none; board research',
      'c-sync: ok, 1 step; params: none',
      NOTE,
      `ignoring ${join(root, 'home', 'workflows', 'notes.txt')}: not a .yaml file, so not a workflow`,
    ]);
    expect((await mt(env, ['workflow', 'check', 'c-sync'])).out).toBe('c-sync: ok, 1 step; params: none');
  });
});

describe('the terminal', () => {
  beforeEach(() => clearSecrets());
  afterEach(() => clearSecrets());

  it("starts on the file's board with no --board or the same one, refusing another", async () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi') });
    boards(['vi']);
    expect(JSON.parse((await mt(env, ['kanban', 'workflow', 'start', 'vi-sync', '--json'])).out)).toMatchObject({ ok: true, board: 'vi' });
    expect(JSON.parse((await mt(env, ['kanban', 'workflow', 'start', 'vi-sync', '--board', 'vi', '--json'])).out)).toMatchObject({ ok: true, board: 'vi' });
    expect(await mt(env, ['kanban', 'workflow', 'start', 'vi-sync', '--board', 'x'])).toMatchObject({ code: 1, err: 'mt: workflow vi-sync puts its tasks on board vi, not x' });
  });

  it("previews on the file's board, refusing a missing one on stderr with nothing on stdout, and leaving a file naming none as today", async () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi'), 'plain.yaml': fileOn('') });
    expect(await mt(env, ['kanban', 'workflow', 'preview', 'vi-sync', '--json'])).toEqual({ code: 1, out: '', err: `mt: ${MISSING}` });
    boards(['vi']);
    const r = await mt(env, ['kanban', 'workflow', 'preview', 'vi-sync', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ board: 'vi' });
    expect(await mt(env, ['kanban', 'workflow', 'preview', 'vi-sync', '--board', 'x'])).toMatchObject({ code: 1, err: 'mt: workflow vi-sync puts its tasks on board vi, not x' });
    const plain = await mt(env, ['kanban', 'workflow', 'preview', 'plain', '--board', 'nowhere', '--json']);
    expect(plain.code).toBe(0);
    expect(JSON.parse(plain.out)).toMatchObject({ board: 'nowhere' });
  });

  it('refuses an archived board, and says on stderr, going on, when the database cannot be read', async () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi') });
    boards(['vi'], ['vi']);
    expect((await mt(env, ['kanban', 'workflow', 'preview', 'vi-sync'])).err).toBe(
      'mt: workflow vi-sync is not usable: its board vi is archived, and nothing is added to it (name another board in its file)',
    );
    rmSync(join(root, 'home', 'team.db'));
    const holder = new Database(join(root, 'home', 'team.db'));
    holder.pragma('journal_mode = DELETE');
    holder.exec('CREATE TABLE kanban_boards (name TEXT, archived_at INTEGER); PRAGMA user_version = 6; BEGIN EXCLUSIVE; INSERT INTO kanban_boards VALUES (1, NULL);');
    try {
      const r = await mt(env, ['kanban', 'workflow', 'preview', 'vi-sync', '--json']);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/^mt: the boards are not checked: the database cannot be read: .*(locked|busy)/i);
      expect(JSON.parse(r.out)).toMatchObject({ board: 'vi' });
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it("leaves a workflow on a missing board out of a preview's unknown_workflow message", async () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi'), 'plain.yaml': fileOn('') });
    const r = await mt(env, ['kanban', 'workflow', 'preview', 'nowhere']);
    expect(r.err).toMatch(/the usable ones are plain;/);
  });

  it("names a workflow's board in the list, and in its --json", async () => {
    const env = home({ 'vi-sync.yaml': fileOn('board: vi'), 'plain.yaml': fileOn('') });
    boards(['vi']);
    expect((await mt(env, ['kanban', 'workflow', 'list'])).out.split('\n')).toEqual(['plain: params none', 'vi-sync: params none · board vi']);
    const json = JSON.parse((await mt(env, ['kanban', 'workflow', 'list', '--json'])).out) as { workflows: { name: string; board: string | null }[] };
    expect(json.workflows.map((w) => [w.name, w.board])).toEqual([['plain', null], ['vi-sync', 'vi']]);
  });
});

// ---------------------------------------------------------------------------
// Chat (workflows spec §19.2, §19.3, §19.5)

const OWNER: Principal = { openId: 'ou_owner', unionId: 'on_owner', displayName: 'Owner' };
const GUEST: Principal = { openId: 'ou_guest', unionId: 'on_guest', displayName: 'Guest' };
const DM: BindingKey = { channel: 'lark', appId: 'cli_app', conversationId: 'oc_dm', threadId: '' };
const HEARS = 'This chat hears when each task is done, needs review, has changes requested, blocks, is retried after a failure, gives up or is stranded.';

describe('chat', () => {
  let t: TestDb;
  let service: KanbanService;
  let chat: KanbanChat;
  let seq = 0;
  beforeEach(() => {
    t = testDb();
    const dir = join(t.dir, 'workflows');
    mkdirSync(dir);
    writeFileSync(join(dir, 'vi-sync.yaml'), fileOn('board: vi'));
    writeFileSync(join(dir, 'home-sync.yaml'), fileOn('board: default'));
    writeFileSync(join(dir, 'plain.yaml'), fileOn(''));
    const people = new PeopleDirectory({ db: t.db, appId: 'cli_app', canTalk: () => true });
    service = new KanbanService({ db: t.db, roles: new Map([['worker', role('worker')]]), workspaces: new Set(['default']), people, supervisedRoles: true, workflowsDir: dir });
    chat = new KanbanChat({ service, hasTier: (p, tier) => tier === 'talk' || p.openId === OWNER.openId, people, appId: 'cli_app', changed: () => {} });
    createBoard(t.db, 'vi', ALICE, NOW);
  });
  afterEach(() => t.close());

  const say = async (text: string, sender: Principal = OWNER): Promise<string> => {
    const m: InboundMessage = {
      messageId: `om_${++seq}`,
      appId: 'cli_app',
      chatId: DM.conversationId,
      chatType: 'p2p',
      threadId: '',
      sender,
      senderIsBot: false,
      text,
      mentionedBot: true,
      mentionAll: false,
      mentions: [],
      attachments: [],
      createTime: 0,
    };
    const r = await chat.run(text, m, DM);
    return typeof r === 'string' ? r : r.text;
  };
  const ids = (text: string): string[] => [...text.matchAll(/`(k_[0-9a-z]+)`/g)].map((m) => m[1] ?? '');

  it("names the file's board in the reply and points to its task list, from a chat on another board", async () => {
    const r = await say('workflow start vi-sync');
    const lines = r.split('\n');
    expect(lines[0]).toMatch(/^Started vi-sync as `w_[0-9a-z]+`, 1 task, on board \*\*vi\*\*:$/);
    expect(lines.slice(2)).toEqual(['Its tasks are on board **vi**: `/kanban task list board:vi` lists that board.', HEARS]);
    expect(service.show(ids(r)[0] ?? '')).toMatchObject({ ok: true, view: { task: { board: 'vi' } } });
  });

  it('gives no pointer from a chat on the board, and names default with the pointer from a chat on another', async () => {
    expect(await say('board use vi')).toMatch(/board \*\*vi\*\*/);
    const onVi = await say('workflow start vi-sync');
    expect(onVi.split('\n')[0]).toMatch(/, on board \*\*vi\*\*:$/);
    expect(onVi).not.toMatch(/Its tasks are on board/);
    const home = await say('workflow start home-sync');
    expect(home.split('\n')[0]).toMatch(/, on board \*\*default\*\*:$/);
    expect(home).toMatch(/Its tasks are on board \*\*default\*\*: `\/kanban task list board:default` lists that board\./);
  });

  it("starts a file naming its board from a chat on an archived board, a file naming none refused in today's sentence", async () => {
    createBoard(t.db, 'old', ALICE, NOW);
    await say('board use old');
    archiveBoard(t.db, 'old', ALICE, NOW);
    expect(await say('workflow start vi-sync')).toMatch(/^Started vi-sync as /);
    expect(await say('workflow start plain')).toBe('This chat is on board **old**, which is archived: `/kanban board use <board>` moves it to another first.');
  });

  it("names the board in a preview as the reply does, and in the workflow list", async () => {
    expect((await say('workflow preview vi-sync')).split('\n')[0]).toBe('vi-sync would make 1 task, on board **vi**:');
    expect((await say('workflow preview plain')).split('\n')[0]).toBe('plain would make 1 task:');
    const list = await say('workflow list');
    expect(list).toContain('- **vi-sync** · params: none · board **vi**');
    expect(list).toContain('- **plain** · params: none');
    expect(list).not.toContain('- **plain** · params: none · board');
  });

  describe('task list board:', () => {
    it("lists a named board's tasks under its header from a chat on another, the chat's board unchanged", async () => {
      const started = await say('workflow start vi-sync');
      const id = ids(started)[0] ?? '';
      const r = await say('task list board:vi');
      expect(r.split('\n')[0]).toBe('Board **vi**:');
      expect(r).toContain(id);
      expect(await say('task list blocked board:vi')).toBe('No blocked tasks on board vi.');
      expect(await say('task list board:vi all')).toContain(id);
      expect(await say('task list')).toBe('No open tasks. `/kanban task list all` shows done and archived ones too.');
    });

    it('refuses a board that does not exist, and names default when given', async () => {
      expect(await say('task list board:nowhere')).toBe('Not done: there is no board nowhere');
      expect(await say('task list board:default')).toBe('No open tasks on board default. `/kanban task list all board:default` shows done and archived ones too.');
    });

    it('lists an archived board under its archived line, and gives its empty answer after it', async () => {
      createBoard(t.db, 'old', ALICE, NOW);
      archiveBoard(t.db, 'old', ALICE, NOW);
      expect(await say('task list board:old')).toBe(
        ['Board **old** is archived: nothing is added to it.', 'No open tasks on board old. `/kanban task list all board:old` shows done and archived ones too.'].join('\n'),
      );
    });

    it('is talk tier, as the list is: a sender without operator tier is answered, where a start is refused', async () => {
      expect(await say('task list board:vi', GUEST)).toBe('No open tasks on board vi. `/kanban task list all board:vi` shows done and archived ones too.');
      expect(await say('workflow start vi-sync', GUEST)).toMatch(/needs operator permission/);
    });
  });
});
