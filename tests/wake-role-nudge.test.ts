import { afterEach, describe, expect, it } from 'vitest';
import { setWake } from '../src/db/kanban.js';
import type { TaskRow } from '../src/kanban/types.js';
import type { Role } from '../src/roles.js';
import { role } from './helpers/dispatch.js';
import { ALICE, NOW } from './helpers/kanban.js';
import { APP, wakeHarness, type WakeHarness } from './helpers/waker.js';

/**
 * The waker's nudge (wake spec §19.3, §19.12): a reaction task it has just
 * made is handed to the dispatcher at once, by one dispatcher pass; a task
 * found made already is not nudged for again; and a nudge that throws changes
 * nothing of the wake.
 */

const ROLES: ReadonlyMap<string, Role> = new Map([['vi-coordinator', role('vi-coordinator')]]);

let h: WakeHarness;
afterEach(() => {
  h.waker.stop();
  h.t.close();
});

function forRole(): TaskRow {
  const task = h.woken(ALICE);
  const r = setWake(h.db, task.taskId, { on: true, as: ALICE, maxDepth: 5, role: 'vi-coordinator' }, ALICE, APP, NOW);
  if (!r.ok) throw new Error(r.message);
  h.noticed(task);
  return r.task;
}

describe("the waker's nudge", () => {
  it('nudges the dispatcher once when it makes a reaction task', async () => {
    let nudges = 0;
    h = wakeHarness({ nudge: () => (nudges += 1) }, { roles: ROLES });
    const task = forRole();
    h.event(task, 'completed', ALICE, { summary: 'Booked.' });
    expect(await h.round()).toBe(1);
    expect(nudges).toBe(1);
    expect(await h.round()).toBe(0);
    expect(nudges).toBe(1);
  });

  it('does not nudge for a reaction task found made already', async () => {
    let nudges = 0;
    h = wakeHarness({ nudge: () => (nudges += 1) }, { roles: ROLES });
    const real = h.service.recordRoleWake.bind(h.service);
    h.service.recordRoleWake = (batch) => {
      const r = real(batch);
      return r.ok && 'wake' in r ? { ...r, existing: true } : r;
    };
    const task = forRole();
    h.event(task, 'completed', ALICE, { summary: 'Booked.' });
    expect(await h.round()).toBe(1);
    expect(nudges).toBe(0);
  });

  it('swallows a nudge that throws: the task stands, and its marker goes', async () => {
    h = wakeHarness(
      {
        nudge: () => {
          throw new Error('the dispatcher is stopped');
        },
      },
      { roles: ROLES },
    );
    const task = forRole();
    h.event(task, 'completed', ALICE, { summary: 'Booked.' });
    expect(await h.round()).toBe(1);
    expect(h.wakes()).toMatchObject([{ state: 'delivered', targetRole: 'vi-coordinator' }]);
    expect(h.lark.texts.map((t) => t.text)).toEqual([expect.stringMatching(/^Waking vi-coordinator for 1 board update \(k_[0-9a-z]+\)\.$/)]);
  });
});
