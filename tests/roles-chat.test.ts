import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLES_MAX, renderRoles, rolesReply, type RolesView } from '../src/core/roles-chat.js';
import { KanbanService } from '../src/kanban/service.js';
import { ROLE_MD_PREFIX_BYTES, ROLE_MD_UNREADABLE, roleMdFirstLine, wholeUtf8, type Role } from '../src/roles.js';
import { MASK, addSecrets, clearSecrets, redactKnownSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW, VIA, WORKSPACES } from './helpers/kanban.js';

/**
 * `/roles` (the tier grants spec §13): `role.md`'s first line read from a
 * checked 8 KiB prefix, never a cut line; one line a role, by name, with what
 * it is for, whether it can be given work, its workspace and its open runs
 * against its limit; the 30-line cut; masking; and the count the dispatcher's
 * limit uses.
 */

let dir: string;
beforeEach(() => {
  clearSecrets();
  dir = mkdtempSync(join(tmpdir(), 'mt-roles-chat-'));
});
afterEach(() => {
  clearSecrets();
  rmSync(dir, { recursive: true, force: true });
});

function roleMd(text: string | Uint8Array, name = 'role.md'): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe('roleMdFirstLine', () => {
  it('gives the first line that is not empty, a heading as its words', () => {
    expect(roleMdFirstLine(roleMd('\n  \n## Writes the weekly notes\nthen more\n'))).toBe('Writes the weekly notes');
    expect(roleMdFirstLine(roleMd('#\n\r\nChecks a task before done'))).toBe('Checks a task before done');
    expect(roleMdFirstLine(roleMd(''))).toBeUndefined();
    expect(roleMdFirstLine(roleMd('\n\n'))).toBeUndefined();
  });

  it('is unreadable for a symbolic link, a directory or nothing there, as the start refuses them', () => {
    const real = roleMd('Real instructions', 'real.md');
    symlinkSync(real, join(dir, 'linked.md'));
    expect(roleMdFirstLine(join(dir, 'linked.md'))).toBe(ROLE_MD_UNREADABLE);
    mkdirSync(join(dir, 'folder.md'));
    expect(roleMdFirstLine(join(dir, 'folder.md'))).toBe(ROLE_MD_UNREADABLE);
    expect(roleMdFirstLine(join(dir, 'gone.md'))).toBe(ROLE_MD_UNREADABLE);
    expect(ROLE_MD_UNREADABLE).toBe('(role.md unreadable)');
  });

  it('never gives a line still going at 8 KiB, so a secret across the limit is never shown in part', () => {
    expect(ROLE_MD_PREFIX_BYTES).toBe(8192);
    expect(roleMdFirstLine(roleMd('x'.repeat(9000)))).toBeUndefined();
    // Ending exactly at the end of a file of 8 KiB is whole.
    expect(roleMdFirstLine(roleMd('y'.repeat(8192)))).toBe('y'.repeat(8192));
    const secret = 'sk-live-abcdefghijklmnop';
    addSecrets([secret]);
    const path = roleMd(`${'z'.repeat(8180)} ${secret} and on\n`);
    const reply = redactKnownSecrets(renderRoles([role('writer', { roleMdPath: path })], { firstLine: (r) => roleMdFirstLine(r.roleMdPath), running: () => ({ count: 0, limit: undefined }), boardOn: true }));
    expect(reply).toBe('**writer**: – · can be given work: yes · workspace any (default) · running 0');
    expect(reply).not.toContain('sk-');
  });

  it('drops a partial UTF-8 character at the prefix end whole, and reads only the prefix of a large file', () => {
    expect([...wholeUtf8(Buffer.from('ab日', 'utf8').subarray(0, 4))]).toEqual([0x61, 0x62]);
    expect([...wholeUtf8(Buffer.from('ab日', 'utf8'))]).toEqual([...Buffer.from('ab日', 'utf8')]);
    expect([...wholeUtf8(Buffer.from('a😀', 'utf8').subarray(0, 3))]).toEqual([0x61]);
    expect([...wholeUtf8(Buffer.from([]))]).toEqual([]);
    expect(roleMdFirstLine(roleMd(Buffer.concat([Buffer.from('\n'.repeat(8191)), Buffer.from('日本\n', 'utf8')])))).toBeUndefined();
    // 3 GiB, sparse: a whole read would not fit in a buffer at all.
    const big = roleMd('# The big one\n', 'big.md');
    truncateSync(big, 3 * 1024 ** 3);
    expect(roleMdFirstLine(big)).toBe('The big one');
  });
});

describe('renderRoles', () => {
  const view = (over: Partial<RolesView> = {}): RolesView => ({ firstLine: () => undefined, running: () => ({ count: 0, limit: undefined }), boardOn: true, ...over });

  it("says what a role is for by its description, else its role.md's first line, else –", () => {
    const roles = [
      role('worker', { description: 'general research and writing', roleMdPath: '/r/worker/role.md' }),
      role('reviewer', { roleMdPath: '/r/reviewer/role.md' }),
      // A role.md added after the start: roleMdPath was fixed when the role loaded.
      role('late'),
    ];
    const lines = renderRoles(roles, view({ firstLine: (r) => `${r.name}'s first line` })).split('\n');
    expect(lines).toEqual([
      "**late**: – · can be given work: yes · workspace any (default) · running 0",
      "**reviewer**: reviewer's first line · can be given work: yes · workspace any (default) · running 0",
      '**worker**: general research and writing · can be given work: yes · workspace any (default) · running 0',
    ]);
  });

  it('says supervised roles go to the board only, and nowhere with it off; a workspace set or any; the runs against the limit', () => {
    const roles = [
      role('worker', { workspace: 'worker', maxRunning: 2 }),
      role('watched', { agent: { ...role('x').agent, unsupervised: false } }),
      role('free'),
    ];
    const running = (name: string) => (name === 'worker' ? { count: 1, limit: 2 } : name === 'free' ? { count: 3, limit: undefined } : { count: 0, limit: 1 });
    expect(renderRoles(roles, view({ running })).split('\n')).toEqual([
      '**free**: – · can be given work: yes · workspace any (default) · running 3',
      '**watched**: – · can be given work: board only (supervised) · workspace any (default) · running 0 of 1',
      '**worker**: – · can be given work: yes · workspace worker · running 1 of 2',
    ]);
    expect(renderRoles(roles, view({ running, boardOn: false })).split('\n')).toEqual([
      '**free**: – · can be given work: yes · workspace any (default) · running –',
      '**watched**: – · can be given work: no (supervised; the board is off) · workspace any (default) · running –',
      '**worker**: – · can be given work: yes · workspace worker · running –',
    ]);
  });

  it('sorts by localeCompare, cuts at 30 lines with exactly its last line, masks a description, and never shows the agent', () => {
    addSecrets(['sk-desc-12345678']);
    const roles: Role[] = Array.from({ length: 33 }, (_, i) => role(`r${String(i).padStart(2, '0')}`));
    roles.push(role('Alpha', { description: 'holds sk-desc-12345678', agent: { ...role('x').agent, command: '/opt/secret-host/bin/agent', args: ['--model', 'm-1'] } }));
    const lines = renderRoles(roles, view()).split('\n');
    expect(lines).toHaveLength(ROLES_MAX + 1);
    expect(lines[0]).toBe(`**Alpha**: holds ${MASK} · can be given work: yes · workspace any (default) · running 0`);
    expect(lines[1]?.startsWith('**r00**')).toBe(true);
    expect(lines.at(-1)).toBe('… and 4 more; mt role list shows all');
    expect(lines.join('\n')).not.toMatch(/secret-host|m-1|bytesec/);
  });
});

describe('rolesReply', () => {
  let t: TestDb;
  afterEach(() => t?.close());

  it("counts a role's work and review runs, a decided one until it closes, and not a person's run or a cron fire", async () => {
    t = testDb();
    const roles = new Map([
      ['worker', role('worker', { maxRunning: 2 })],
      ['reviewer', role('reviewer')],
    ]);
    const service = new KanbanService({ db: t.db, roles, workspaces: WORKSPACES, people: { canTalk: () => true } });
    const create = (title: string, extra: { assignee?: string; reviewer?: string; workspace?: string } = {}) => {
      const r = service.create({ title, assignee: extra.assignee ?? 'worker', createdBy: ALICE, createdVia: VIA, ...(extra.reviewer === undefined ? {} : { reviewer: extra.reviewer }), workspace: extra.workspace ?? 'web' });
      if (!r.ok) throw new Error(r.message);
      return r.task.taskId;
    };
    const claim = (taskId: string) => {
      const r = service.claim(taskId);
      if (!r.ok) throw new Error(r.message);
      return r.run.runId;
    };
    const reply = (): string[] => rolesReply(t.db, roles, { enabled: true, maxRunningPerRole: 1 }).split('\n');
    claim(create('one'));
    const reviewed = create('two', { reviewer: 'reviewer', workspace: 'api' });
    const work = claim(reviewed);
    claim(create('a person', { assignee: 'lark:on_alice', workspace: 'docs' }));
    t.db
      .prepare(
        `INSERT INTO cron_jobs (job_id, name, schedule, tz, role, workspace, prompt, state, next_run_at, created_by, created_via, created_at, updated_at)
         VALUES ('c_1', 'n', 'every 1h', 'UTC', 'worker', 'default', 'p', 'active', ?, 'operator:x', '{"kind":"operator"}', ?, ?)`,
      )
      .run(NOW, NOW, NOW);
    t.db.prepare("INSERT INTO cron_fires (job_id, scheduled_at, trigger, started_at) VALUES ('c_1', ?, 'schedule', ?)").run(NOW, NOW);
    expect(reply()).toEqual([
      '**reviewer**: – · can be given work: yes · workspace any (default) · running 0 of 1',
      '**worker**: – · can be given work: yes · workspace any (default) · running 2 of 2',
    ]);
    // Decided, still open: counted until it closes; then the review run counts against the reviewer.
    expect((await service.requestReview(reviewed, { kind: 'run', runId: work }, { summary: 'look' })).ok).toBe(true);
    expect(reply()[1]).toMatch(/running 2 of 2$/);
    expect(service.closeRun(work).ok).toBe(true);
    expect(reply()[1]).toMatch(/running 1 of 2$/);
    claim(reviewed);
    expect(reply()[0]).toMatch(/running 1 of 1$/);
    expect(rolesReply(t.db, roles, { enabled: false }).split('\n').every((l) => l.endsWith('running –'))).toBe(true);
  });
});
