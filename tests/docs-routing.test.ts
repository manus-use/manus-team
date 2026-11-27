import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWorkflow } from '../src/kanban/workflow.js';
import { VI_WORKFLOW, viRoles } from './helpers/routing.js';

/**
 * The documents of workflow routing (workflow routing spec §16): the guide's
 * section on routing on results, its file the one the tests start, and checked;
 * the board's skill telling an agent to report its outputs; the README's
 * commands; and the workflows spec's notes that this one extends it.
 */

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function example(doc: string, marker: string): string {
  const lines = read(doc).split('\n');
  const at = lines.findIndex((l) => l.trim() === `<!-- example: ${marker} -->`);
  if (at === -1) throw new Error(`${doc} has no example ${marker}`);
  const end = lines.findIndex((l, i) => i > at + 1 && l.trim() === '```');
  return `${lines.slice(at + 2, end).join('\n')}\n`;
}

function section(doc: string, heading: string): string {
  const lines = read(doc).split('\n');
  const at = lines.indexOf(heading);
  if (at === -1) throw new Error(`${doc} has no ${heading}`);
  const end = lines.findIndex((l, i) => i > at && /^#{1,3} /.test(l));
  return lines.slice(at, end === -1 ? undefined : end).join('\n');
}

describe('the documents of workflow routing', () => {
  it("gives the guide's file, which is the folded vi file and passes the check", () => {
    const file = example('docs/kanban-guide.md', 'workflow vi-workflow');
    expect(file).toBe(VI_WORKFLOW);
    expect(checkWorkflow('vi-workflow', file, { roles: viRoles(), workspaces: new Set(['default']), supervisedRoles: false }).ok).toBe(true);
  });

  it('says in the guide how a step is shown, how a case is cancelled, reconcile, and what the directory line needs', () => {
    const text = section('docs/kanban-guide.md', '### Routing on results');
    for (const said of [
      '⏭ verify: skipped (intake.verify is false)',
      '/kanban workflow archive w_…',
      'mt kanban workflow reconcile w_…',
      'mt kanban workflow show w_… --plan',
      'helps only if its agent may read outside its own worktree',
    ]) {
      expect(text).toContain(said);
    }
  });

  it("tells an agent in the board's skill to report its outputs in its metadata", () => {
    expect(read('skills/mt-kanban/SKILL.md').replace(/\s*\n\s*/g, ' ')).toContain(
      'When your task\'s outcome names outputs, report each as a top-level key of "metadata", of the type it names; a completion without them is refused, and you report again in the same run.',
    );
  });

  it("lists the README's commands and the spec, and the workflows spec's notes", () => {
    const readme = read('README.md');
    expect(readme).toContain('mt kanban workflow reconcile <instance> [--board <name>]');
    expect(readme).toContain('mt kanban workflow show <instance> [--board <name>] [--dag | --plan]');
    expect(readme).toContain('[workflow routing](docs/specs/2026-11-26-workflow-routing-design.md)');
    const spec = read('docs/specs/2026-11-16-workflows-design.md');
    expect(spec.split('*Extended by docs/specs/2026-11-26-workflow-routing-design.md*').length).toBe(3);
  });
});
