import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdsSecret } from '../src/kanban/gate-command.js';
import { KanbanService } from '../src/kanban/service.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { testDb, type TestDb } from './helpers/db.js';
import { role } from './helpers/dispatch.js';
import { ALICE, WORKSPACES, newTask } from './helpers/kanban.js';

/**
 * `holdsSecret`, in a module of its own that the service and a workflow's checks
 * both import (workflows spec §15): the forms a shell would run as the secret, and
 * `addGate`'s refusal through it, unchanged.
 */

const SECRET = 'sk-live-1234567890';

let h: TestDb;
beforeEach(() => {
  clearSecrets();
  addSecrets([SECRET]);
  h = testDb();
});
afterEach(() => {
  clearSecrets();
  h.close();
});

describe('holdsSecret', () => {
  it('finds a secret as written, split by a control character, quoted, escaped or continued', () => {
    expect(holdsSecret('npm test')).toBe(false);
    expect(holdsSecret('test -s notes.md && grep -q $TOKEN notes.md')).toBe(false);
    expect(holdsSecret(`curl -H "Authorization: ${SECRET}" x`)).toBe(true);
    expect(holdsSecret('curl sk-live-12345\u000767890')).toBe(true);
    expect(holdsSecret("curl 'sk-live-12345''67890'")).toBe(true);
    expect(holdsSecret('curl sk-live-12345\\67890')).toBe(true);
    expect(holdsSecret('curl sk-live-12345\\\n67890')).toBe(true);
    expect(holdsSecret('curl sk-live-12345\\\r\n\u000767890')).toBe(true);
  });
});

describe('addGate', () => {
  it('still refuses a command that holds a known secret, through it', () => {
    const service = new KanbanService({ db: h.db, roles: new Map([['implementer', role('implementer')]]), workspaces: WORKSPACES });
    const task = newTask(h.db);
    expect(service.addGate(task.taskId, { command: "echo 'sk-live-12345''67890'" }, ALICE)).toEqual({
      ok: false,
      code: 'invalid',
      message:
        "the gate's command holds a known secret, and a gate is stored and run as written; " +
        "pass the value through the agent's environment instead -- the role's .env, or agent.passEnv -- " +
        'and name it in the command, as $NAME',
    });
    expect(service.addGate(task.taskId, { command: 'npm test' }, ALICE)).toMatchObject({ ok: true, gate: { command: 'npm test' } });
  });
});
