import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commentsOf, eventsOf } from '../src/db/kanban-read.js';
import { briefFor } from '../src/kanban/brief.js';
import { clearSecrets } from '../src/secrets.js';
import { dispatchHarness, reportComplete, type DispatchHarness } from './helpers/dispatch.js';
import type { FakeDriver } from './helpers/driver.js';
import { ALICE } from './helpers/kanban.js';

/**
 * Which comments steer an agent (spec §7.5, §9.1): a run's and an operator's do;
 * a talk-tier person's, from chat, is stored and shown to people only -- never
 * forwarded to a run, never in a run's prompt.
 */

const BOB = 'lark:on_bob';
const open: DispatchHarness[] = [];

function harness(nudgeLimit = 1): DispatchHarness {
  const h = dispatchHarness({ settings: { nudgeLimit } });
  open.push(h);
  return h;
}

beforeEach(() => clearSecrets());
afterEach(() => {
  clearSecrets();
  while (open.length > 0) open.pop()?.close();
});

const prompts = (d: FakeDriver) => d.lastRuntime?.prompts.map((p) => p.text) ?? [];

describe('comments that steer', () => {
  it('stores a comment that may not steer, records so on its event, and keeps it from the steering reads', () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    expect(h.service.comment(task.taskId, 'use the 2024 list', ALICE, { steers: true }).ok).toBe(true);
    expect(h.service.comment(task.taskId, 'I think 2023 is better', BOB, { steers: false }).ok).toBe(true);
    expect(commentsOf(h.t.db, task.taskId).map((c) => c.body)).toEqual(['use the 2024 list', 'I think 2023 is better']);
    // Every caller says whether a comment steers.
    expect(h.service.comment(task.taskId, 'no say', ALICE, {} as never)).toEqual({
      ok: false,
      code: 'invalid',
      message: 'a comment says whether it steers',
    });
    expect(commentsOf(h.t.db, task.taskId, { steering: true }).map((c) => c.body)).toEqual(['use the 2024 list']);
    expect(eventsOf(h.t.db, task.taskId).filter((e) => e.kind === 'commented').map((e) => e.payload)).toEqual([
      { body: 'use the 2024 list' },
      { body: 'I think 2023 is better', steers: false },
    ]);
  });

  it("leaves a comment that may not steer out of a run's prompt", () => {
    const h = harness();
    const task = h.create({ workspace: 'web' });
    h.service.comment(task.taskId, 'from the operator', ALICE, { steers: true });
    h.service.comment(task.taskId, 'from a bystander', BOB, { steers: false });
    const claimed = h.service.claim(task.taskId);
    if (!claimed.ok) throw new Error(claimed.message);
    expect(briefFor(h.t.db, claimed).comments.map((c) => c.body)).toEqual(['from the operator']);
  });

  it('forwards only the comments that steer to a run whose turn ended without a report', async () => {
    const h = harness(1);
    const task = h.create({ workspace: 'web' });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      h.service.comment(task.taskId, 'a bystander says use v1', BOB, { steers: false });
      h.service.comment(task.taskId, 'the operator says use v2', ALICE, { steers: true });
      ctl.emit({ kind: 'message-chunk', text: 'Which API?' });
      ctl.end('completed');
    });
    implementer.scripts.push(async (ctl) => {
      await reportComplete(h, ctl.env?.['MT_KANBAN_RUN'] ?? '');
      ctl.end('completed');
    });
    h.dispatcher.pass();
    await h.dispatcher.idle();
    const [, forwarded] = prompts(implementer);
    expect(forwarded).toContain('the operator says use v2');
    expect(forwarded).not.toContain('bystander');
  });

  it('forwards nothing, and sends a nudge, when the only new comment may not steer', async () => {
    const h = harness(1);
    const task = h.create({ workspace: 'web', failureLimit: 1 });
    const implementer = h.driver('implementer');
    implementer.scripts.push((ctl) => {
      h.service.comment(task.taskId, 'just watching', BOB, { steers: false });
      ctl.end('completed');
    });
    implementer.scripts.push((ctl) => ctl.end('completed'));
    h.dispatcher.pass();
    await h.dispatcher.idle();
    const sent = prompts(implementer);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('(reminder 1 of 1)');
    expect(sent.join('\n')).not.toContain('just watching');
  });
});
