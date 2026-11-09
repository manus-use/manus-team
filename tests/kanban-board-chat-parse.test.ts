import { describe, expect, it } from 'vitest';
import { parseKanban, USAGE } from '../src/kanban/chat-parse.js';

/** `/kanban boards` and `/kanban board …` as typed (spec §16). */

describe('parseKanban: boards', () => {
  it('reads /kanban boards, with all for the archived ones too', () => {
    expect(parseKanban('boards')).toEqual({ ok: true, command: { verb: 'boards', archived: false } });
    expect(parseKanban('Boards ALL')).toEqual({ ok: true, command: { verb: 'boards', archived: true } });
    expect(parseKanban('boards web-app')).toEqual({ ok: false, usage: `Usage: \`${USAGE.boards}\`` });
  });

  it('reads create, use and archive, each with one name, kept as typed', () => {
    for (const sub of ['create', 'use', 'archive'] as const) {
      expect(parseKanban(`board ${sub} web-app`)).toEqual({ ok: true, command: { verb: `board ${sub}`, board: 'web-app' } });
      expect(parseKanban(`board ${sub.toUpperCase()} Web`)).toEqual({ ok: true, command: { verb: `board ${sub}`, board: 'Web' } });
      expect(parseKanban(`board ${sub}`)).toEqual({ ok: false, usage: `Usage: \`${USAGE[`board ${sub}`]}\`` });
      expect(parseKanban(`board ${sub} a b`)).toEqual({ ok: false, usage: `Usage: \`${USAGE[`board ${sub}`]}\`` });
    }
  });

  it('reads set: max_running a number or none, workspace a name or none', () => {
    const set = (change: object) => ({ ok: true, command: { verb: 'board set', board: 'web-app', change } });
    expect(parseKanban('board set web-app max_running 2')).toEqual(set({ maxRunning: 2 }));
    expect(parseKanban('board set web-app MAX_RUNNING None')).toEqual(set({ maxRunning: null }));
    expect(parseKanban('board set web-app workspace web')).toEqual(set({ workspace: 'web' }));
    expect(parseKanban('board set web-app workspace none')).toEqual(set({ workspace: null }));
    const refused = { ok: false, usage: `Usage: \`${USAGE['board set']}\`` };
    for (const bad of [
      'board set web-app max_running 0',
      'board set web-app max_running two',
      'board set web-app max_running 99999999999999999999',
      'board set web-app max_running',
      'board set web-app colour blue',
      'board set web-app',
      'board set web-app workspace web extra',
    ]) {
      expect(parseKanban(bad)).toEqual(refused);
    }
  });

  it('names every board command for one it does not know', () => {
    const r = parseKanban('board rename web-app site');
    expect(r.ok).toBe(false);
    for (const verb of ['board create', 'board use', 'board set', 'board archive'] as const) {
      expect(r.ok ? '' : r.usage).toContain(USAGE[verb]);
    }
  });
});
