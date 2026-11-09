import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardsText, line, listText, showText } from '../src/cli/plain.js';
import { KanbanService } from '../src/kanban/service.js';
import { addSecrets, clearSecrets } from '../src/secrets.js';
import { ManualClock, testDb, type TestDb } from './helpers/db.js';
import { DEFAULT_ROLES } from './helpers/dispatch.js';
import { claimed, WORKSPACES } from './helpers/kanban.js';

/** The operator's `mt kanban` output (spec §2.6): the board as chat shows it, in plain text, masked. */

const ME = 'operator:alice';
let t: TestDb;
let service: KanbanService;

beforeEach(() => {
  clearSecrets();
  t = testDb();
  service = new KanbanService({
    db: t.db,
    roles: new Map(DEFAULT_ROLES.map((r) => [r.name, r])),
    workspaces: WORKSPACES,
    clock: new ManualClock(),
  });
});

afterEach(() => {
  clearSecrets();
  t.close();
});

function create(title: string, extra: { board?: string; body?: string } = {}): string {
  const r = service.create({ title, assignee: 'implementer', workspace: 'web', createdBy: ME, createdVia: { kind: 'operator' }, ...extra });
  if (!r.ok) throw new Error(r.message);
  return r.task.taskId;
}

describe('line', () => {
  it('drops the characters that reorder text, as it drops control characters', () => {
    expect(line('evil\u202Etxt.exe\u202C and \u2066isolated\u2069\u0007')).toBe('eviltxt.exe and isolated');
  });
});

/** Each kind of character that shows nothing, which plain text drops before it masks. */
const INVISIBLES: Array<[string, string]> = [
  ['an embedding', '\u202A'],
  ['an override', '\u202E'],
  ['a pop', '\u202C'],
  ['an isolate', '\u2066'],
  ['a pop of an isolate', '\u2069'],
  ['a zero-width space', '\u200B'],
  ['a zero-width non-joiner', '\u200C'],
  ['a zero-width joiner', '\u200D'],
  ['a byte order mark', '\uFEFF'],
  ['a left-to-right mark', '\u200E'],
  ['a right-to-left mark', '\u200F'],
  ['an Arabic letter mark', '\u061C'],
];

describe('the invisible characters', () => {
  it.each(INVISIBLES)('masks a secret split by %s, in a line, a body and an output, and drops it', (_name, c) => {
    // Registered after the task is written, so the writer has not masked it already.
    const taskId = create('Deploy', { body: `key sk-live-12${c}34567890` });
    const run = claimed(t.db, taskId);
    addSecrets(['sk-live-1234567890']);
    expect(line(`key sk-live-12${c}34567890 a${c}b`)).toBe('key •••• ab');
    const shown = service.show(taskId);
    if (!shown.ok) throw new Error('not shown');
    const view = { ...shown.view, runs: [{ ...run, lastOutput: `out sk-live-1234${c}567890` }] };
    const text = showText(view, []).join('\n');
    expect(text).toContain('    key ••••');
    expect(text).toContain('latest output:\n    out ••••');
    expect(text).not.toContain('sk-live');
    expect(text).not.toContain(c);
  });

  it('makes U+2028 and U+2029 line breaks', () => {
    const taskId = create('Notes', { body: 'one\u2028two\u2029three' });
    const shown = service.show(taskId);
    if (!shown.ok) throw new Error('not shown');
    expect(showText(shown.view, [])).toEqual(expect.arrayContaining(['    one', '    two', '    three']));
    expect(line('one\u2028two')).toBe('one two');
  });
});

describe('boardsText', () => {
  it('gives each board a line: its tasks by phase, its own settings, and whether it is archived', () => {
    expect(service.createBoard('web-app', ME).ok).toBe(true);
    expect(service.setBoard('web-app', { maxRunning: 1, workspace: 'web' }, ME).ok).toBe(true);
    expect(service.createBoard('old', ME).ok).toBe(true);
    expect(service.archiveBoard('old', ME).ok).toBe(true);
    create('one', { board: 'web-app' });
    expect(boardsText(service.boards({ archived: true }))).toEqual([
      'default: no tasks',
      'old (archived): no tasks',
      'web-app: 1 open · max_running 1 · workspace web',
    ]);
  });
});

describe('listText', () => {
  it('lists the active tasks as a table, every one, and says when there are none', () => {
    expect(listText(service.list('default'), undefined, 'default')).toEqual([
      'no open tasks on board default; mt kanban list all shows done and archived ones too',
    ]);
    expect(listText(service.list('default'), 'done', 'default')).toEqual(['no done tasks on board default']);
    const ids = Array.from({ length: 31 }, (_, i) => create(`task ${i}`));
    const lines = listText(service.list('default'), undefined, 'default');
    expect(lines).toHaveLength(32);
    expect(lines[0]).toMatch(/^task\s+status\s+assignee\s+title$/);
    expect(lines[1]).toMatch(new RegExp(`^${ids[0]}\\s+ready\\s+role implementer\\s+task 0$`));
  });
});

describe('showText', () => {
  it('shows the task, its board, body, gates and comments, masked, with no control characters', () => {
    addSecrets(['sk-live-1234567890']);
    const taskId = create('Fix \u001b[31mthe\u001b[0m parser', { body: 'Line one\r\nkey sk-live-1234567890' });
    expect(service.addGate(taskId, { command: 'npm test', timeoutS: 120 }, ME).ok).toBe(true);
    expect(service.comment(taskId, 'look at the lexer', ME, { steers: true }).ok).toBe(true);
    const shown = service.show(taskId);
    const gates = service.listGates(taskId);
    if (!shown.ok || !gates.ok) throw new Error('not shown');
    expect(showText(shown.view, gates.gates)).toEqual([
      `Fix [31mthe[0m parser (${taskId}): ready`,
      'assignee: role implementer · reviewer: nobody · workspace: web · board: default',
      '',
      '    Line one',
      '    key ••••',
      '',
      'gates:',
      `  1. npm test (120 s, by ${ME})`,
      'comments (1 of 1):',
      `  ${ME}:`,
      '    look at the lexer',
    ]);
  });
});
