import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Env } from '../config.js';

/**
 * The board's skill, `skills/mt-kanban/` in the checkout, copied to
 * `~/.agents/skills/mt-kanban/`, one of the user skill folders a role's
 * `agent.skills` is looked up in (`userSkillDirs`, src/roles.ts). install.sh
 * does the same in bash, by the same rules; `mt update` does it with this.
 *
 * **Only our own copy is replaced.** A copy we wrote holds `MARK`, the list of
 * the files we put there. A target that is a symlink, is not a directory, or is
 * a directory without the list is someone else's, and is left as it is, said
 * as a warning: it may be a skill of the same name they wrote, or a link to a
 * checkout they work on.
 *
 * **Only our own files are touched.** In our copy, the files the new source
 * holds are written, each to a temporary name beside it and renamed over the
 * old one, and the files the old list named that the source no longer holds
 * are removed. Any other file there is kept, and named: someone added it, and
 * the skill's loaders read SKILL.md, so it does no harm, while removing it would
 * lose their work. The list is written last, so a copy cut short is replaced
 * whole at the next install.
 */

export const SKILL_NAME = 'mt-kanban';

/** The list of the files a copy of ours holds, one path a line under a comment. */
export const MARK = '.installed-by-manus-team';

/** The skill's source in a checkout. */
export function skillSource(checkout: string): string {
  return join(checkout, 'skills', SKILL_NAME);
}

/** Where it is copied, under the user's HOME; undefined without one. */
export function skillTarget(env: Env): string | undefined {
  const home = env['HOME'];
  return home === undefined || home === '' ? undefined : join(home, '.agents', 'skills', SKILL_NAME);
}

export type SkillPlan =
  | { kind: 'install' }
  | { kind: 'replace' }
  /** Someone else's: left as it is, for this reason. */
  | { kind: 'foreign'; why: string };

/** What an install would do at `target`, changing nothing. */
export function skillPlan(target: string): SkillPlan {
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (st === undefined) return { kind: 'install' };
  if (st.isSymbolicLink()) return { kind: 'foreign', why: 'it is a symlink, not a copy manus-team made' };
  if (!st.isDirectory()) return { kind: 'foreign', why: 'it is not a directory' };
  if (lstatSync(join(target, MARK), { throwIfNoEntry: false })?.isFile() !== true) {
    return { kind: 'foreign', why: `manus-team did not install it (it has no ${MARK}); move it aside to have the skill installed` };
  }
  return { kind: 'replace' };
}

/** The regular files under `dir`, as paths relative to it with `/`, sorted; the list itself left out. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  // A staging file a copy cut short left behind is neither ours nor someone's.
  return out.filter((p) => p !== MARK && !p.includes('.mt-install.')).sort();
}

/** The paths an old list names, each one inside the copy: a line that would reach outside it is passed over. */
function listed(target: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(target, MARK), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('/') && !l.split('/').includes('..') && l !== MARK);
}

export type SkillResult =
  | { done: 'installed' | 'replaced'; target: string; kept: string[] }
  | { done: 'left'; target: string; why: string };

/** Copy the skill from `source` to `target`, by the rules above. Throws when a file cannot be written. */
export function installSkill(source: string, target: string): SkillResult {
  const plan = skillPlan(target);
  if (plan.kind === 'foreign') return { done: 'left', target, why: plan.why };
  const files = filesUnder(source).filter((p) => lstatSync(join(source, p)).isFile());
  const old = plan.kind === 'replace' ? listed(target) : [];
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    const to = join(target, file);
    mkdirSync(dirname(to), { recursive: true });
    const staging = `${to}.mt-install.${process.pid}`;
    copyFileSync(join(source, file), staging);
    renameSync(staging, to);
  }
  for (const file of old) {
    if (files.includes(file)) continue;
    const at = join(target, file);
    if (lstatSync(at, { throwIfNoEntry: false })?.isFile() === true) rmSync(at);
  }
  const mark = join(target, MARK);
  const staging = `${mark}.mt-install.${process.pid}`;
  writeFileSync(
    staging,
    `# Installed by manus-team. These files are replaced at each install and mt update; any other file here is kept.\n${files.map((f) => `${f}\n`).join('')}`,
  );
  renameSync(staging, mark);
  const kept = filesUnder(target).filter((p) => !files.includes(p));
  return { done: plan.kind === 'install' ? 'installed' : 'replaced', target, kept };
}

/** What an install did, in a line. */
export function skillLine(r: SkillResult): string {
  if (r.done === 'left') return `warning: left ${r.target} as it is: ${r.why}`;
  const kept = r.kept.length === 0 ? '' : `; kept ${r.kept.length === 1 ? 'a file' : `${r.kept.length} files`} not from manus-team: ${r.kept.join(', ')}`;
  return `${r.done} the ${SKILL_NAME} skill at ${r.target}${kept}`;
}
