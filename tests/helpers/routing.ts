import type { Role } from '../../src/roles.js';
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
