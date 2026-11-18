import { openAgentRunCountAs } from '../db/kanban-read.js';
import type { Db } from '../db/open.js';
import { label } from '../kanban/chat-render.js';
import { roleLimit, roleMdFirstLine, type Role } from '../roles.js';

/**
 * `/role list`, or `/roles`, in chat (the tier grants spec §13): one line a role, sorted by
 * name, with what it is for, whether it can be given work, where it works and
 * its open agent runs against its `max_running`, in the layout of the
 * gateway's other chat lists. Nothing of how a role runs: its command, driver,
 * model, args, environment, secrets and skills are the terminal's. Each field
 * goes through `label`, masked, and the router masks the whole reply again.
 */

/** At most this many roles, then how many more: `/kanban task list`'s number. */
export const ROLES_MAX = 30;

/** A role's open agent runs, and the limit they are held to, if any. */
export interface Running {
  count: number;
  limit: number | undefined;
}

export interface RolesView {
  /** The first line of `role.md`, as read now, for a role that had one at the start; undefined for none. */
  firstLine: (role: Role & { roleMdPath: string }) => string | undefined;
  /** A role's open agent runs and its limit, by name. */
  running: (name: string) => Running;
  /** Whether the board runs: with it off no dispatcher runs, so no limit applies. */
  boardOn: boolean;
}

/** One role's line: `**name**: what · can be given work: … · workspace … · running …`. */
function roleLine(role: Role, view: RolesView): string {
  // A role.md added since the start is not seen: roleMdPath was fixed when the role loaded.
  const line = role.description ?? (role.roleMdPath === undefined ? undefined : view.firstLine({ ...role, roleMdPath: role.roleMdPath }));
  const what = line === undefined || line === '' ? '–' : label(line, 80);
  const work = role.agent.unsupervised ? 'yes' : view.boardOn ? 'board only (supervised)' : 'no (supervised; the board is off)';
  const workspace = role.workspace === undefined ? 'any (default)' : label(role.workspace, 80);
  let running = '–';
  if (view.boardOn) {
    const r = view.running(role.name);
    running = r.limit === undefined ? String(r.count) : `${r.count} of ${r.limit}`;
  }
  return `**${label(role.name, 80)}**: ${what} · can be given work: ${work} · workspace ${workspace} · running ${running}`;
}

/** The reply to `/role list` and `/roles`: the roles given, by name, at most `ROLES_MAX` lines and then how many more. */
export function renderRoles(roles: Iterable<Role>, view: RolesView): string {
  const sorted = [...roles].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.slice(0, ROLES_MAX).map((r) => roleLine(r, view));
  const more = sorted.length - ROLES_MAX;
  if (more > 0) lines.push(`… and ${more} more; mt role list shows all`);
  return lines.join('\n');
}

/**
 * `/role list` over the gateway's roles and database: `role.md` read now, the
 * open runs as the dispatcher's limit counts them, and the limit `roleLimit`
 * gives, the role's own or `kanban.max_running_per_role`.
 */
export function rolesReply(db: Db, roles: ReadonlyMap<string, Role>, kanban: { enabled: boolean; maxRunningPerRole?: number }): string {
  return renderRoles(roles.values(), {
    firstLine: (role) => roleMdFirstLine(role.roleMdPath),
    running: (name) => {
      const role = roles.get(name);
      return { count: openAgentRunCountAs(db, name), limit: role === undefined ? undefined : roleLimit(role, kanban.maxRunningPerRole)?.limit };
    },
    boardOn: kanban.enabled,
  });
}
