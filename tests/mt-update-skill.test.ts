import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets } from '../src/secrets.js';
import { OLD, updateFake, type UpdateFake } from './helpers/update.js';

/**
 * `mt update` and the board's skill: after the backup, the new tree's
 * skills/mt-kanban/ is copied to ~/.agents/skills/mt-kanban/ under this shell's
 * HOME, by install.sh's rules; `--check` says what it would do and writes
 * nothing; a tree with no skill says nothing of it. HOME is the fake's.
 */

const SKILL = new URL('../skills/mt-kanban', import.meta.url).pathname;

let fx: UpdateFake;
afterEach(() => {
  clearSecrets();
  fx.cleanup();
});

const dest = (): string => join(fx.home, '.agents', 'skills', 'mt-kanban');
const withSkill = async (): Promise<UpdateFake> => {
  const f = await updateFake();
  cpSync(SKILL, join(f.checkout, 'skills', 'mt-kanban'), { recursive: true });
  return f;
};

describe("mt update and the board's skill", () => {
  it('installs it after the backup, before the restart', async () => {
    fx = await withSkill();
    const r = await fx.update(['--yes']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    const at = lines.indexOf(`installed the mt-kanban skill at ${dest()}`);
    expect(at).toBeGreaterThan(lines.findIndex((l) => l.startsWith('backed up the database to ')));
    expect(at).toBeLessThan(lines.findIndex((l) => l.startsWith('restarting ')));
    expect(readFileSync(join(dest(), 'SKILL.md'), 'utf8')).toBe(readFileSync(join(SKILL, 'SKILL.md'), 'utf8'));
  });

  it('replaces an old copy of its own', async () => {
    fx = await withSkill();
    await fx.update(['--yes']);
    writeFileSync(join(dest(), 'SKILL.md'), 'an old version');
    fx.repo.head = OLD;
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`replaced the mt-kanban skill at ${dest()}`);
    expect(readFileSync(join(dest(), 'SKILL.md'), 'utf8')).toBe(readFileSync(join(SKILL, 'SKILL.md'), 'utf8'));
  });

  it("says with --check what it would do, and writes nothing; it leaves someone else's as it is", async () => {
    fx = await withSkill();
    const check = await fx.update(['--check']);
    expect(check.code).toBe(0);
    expect(check.out).toContain(`the mt-kanban skill is installed at ${dest()}, after the backup`);
    expect(existsSync(dest())).toBe(false);
    mkdirSync(dest(), { recursive: true });
    writeFileSync(join(dest(), 'SKILL.md'), 'my own');
    expect((await fx.update(['--check'])).out).toContain(
      `the mt-kanban skill is not copied: ${dest()} is left as it is, as manus-team did not install it`,
    );
    const r = await fx.update(['--yes']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`warning: left ${dest()} as it is: manus-team did not install it`);
    expect(readFileSync(join(dest(), 'SKILL.md'), 'utf8')).toBe('my own');
  });

  it('copies it when the incoming commits add it, and says nothing of a tree without one', async () => {
    fx = await updateFake();
    const none = await fx.update(['--check']);
    expect(none.out).not.toMatch(/mt-kanban/);
    fx.repo.added = ['skills/mt-kanban/SKILL.md'];
    expect((await fx.update(['--check'])).out).toContain(`the mt-kanban skill is installed at ${dest()}, after the backup`);
  });
});
