import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBoard } from '../../src/db/kanban.js';
import { getBoard } from '../../src/db/kanban-read.js';
import { KanbanService, type KanbanServiceDeps, type WorkflowMade } from '../../src/kanban/service.js';
import type { Result } from '../../src/kanban/types.js';
import type { Role } from '../../src/roles.js';
import type { TestDb } from './db.js';
import { role } from './dispatch.js';

/**
 * Building blocks for tests of workflow routing (workflow routing spec): the folded
 * vi assessment of its §1, as a file, and the roles it names.
 */

/** The file of workflow routing spec §1, as written there. */
export const VI_WORKFLOW = `description: CVE or supply-chain assessment, routed by its intake
board: vi
params:
  case: { required: true, description: "a CVE id, or the absolute path of a package CSV" }
steps:
  intake:
    title: "{{case}} · intake"
    assignee: vi-coordinator
    outputs:
      kind: { enum: [cve, supplychain] }
      verify: boolean
      patch: boolean
      bnpm: boolean
      packages: { list: string, max: 100 }
  va:
    title: "{{case}} · va"
    assignee: vulnerability-analyst
    parents: [intake]
    when:
      - { step: intake, output: kind, equals: cve }
    on_gave_up: { route: escalate }
    outputs:
      reachable: boolean
  escalate:
    title: "{{case}} · va, escalated"
    assignee: vi-coordinator
    handler: true
    stands_in_for: va
    outputs:
      reachable: boolean
  verify:
    title: "{{case}} · verify"
    assignee: verifier
    parents: [va]
    when:
      - { step: intake, output: verify, is: true }
      - { step: va, output: reachable, is: true }
  exposure:
    title: "{{case}} · exposure of {{item}}"
    assignee: exposure-analyst
    parents: [va]
    for_each: { step: intake, output: packages }
  registry:
    title: "{{case}} · registry"
    assignee: registry-analyst
    parents: [intake]
    when:
      - { step: intake, output: bnpm, is: true }
  report:
    title: "{{case}} · report"
    assignee: report-author
    reviewer: { role: assessment-reviewer }
    parents: [va, verify, exposure, registry]
  patch:
    title: "{{case}} · patch"
    assignee: patch-author
    parents: [report]
    when:
      - { step: intake, output: patch, is: true }
`;

/** The roles the file names, none with a workspace of its own. */
export const VI_ROLES: readonly string[] = [
  'vi-coordinator',
  'vulnerability-analyst',
  'verifier',
  'exposure-analyst',
  'registry-analyst',
  'report-author',
  'assessment-reviewer',
  'patch-author',
];

/** The roles, as a team holds them. */
export function viRoles(): Map<string, Role> {
  return new Map(VI_ROLES.map((name) => [name, role(name)]));
}

/** A service over a test database, reading a workflows directory that holds the vi file, on a board `vi` made for it. */
export interface ViBoard {
  service: KanbanService;
  dir: string;
  roles: Map<string, Role>;
  talks: Set<string>;
}

export function viBoard(h: TestDb, deps: Partial<KanbanServiceDeps> = {}): ViBoard {
  const dir = join(h.dir, 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'vi-workflow.yaml'), VI_WORKFLOW);
  if (getBoard(h.db, 'vi') === undefined) createBoard(h.db, 'vi', 'lark:on_alice', 1_760_000_000_000);
  const roles = viRoles();
  const talks = new Set<string>(['lark:on_bob']);
  const service = new KanbanService({
    db: h.db,
    roles,
    workspaces: new Set(['default', 'vi']),
    people: { canTalk: (p) => talks.has(p) },
    supervisedRoles: true,
    workflowsDir: dir,
    ...deps,
  });
  return { service, dir, roles, talks };
}

/** A start's answer, or a thrown refusal. */
export function madeOf(r: Result<object>): WorkflowMade {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r as unknown as WorkflowMade;
}
