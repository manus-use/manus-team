import { describe, expect, it } from 'vitest';
import { parseKanban, parsePairs, typed } from '../src/kanban/chat-parse.js';
import { checkWorkflow, paramValues } from '../src/kanban/workflow.js';
import { role } from './helpers/dispatch.js';
import { VENDOR_EVAL } from './helpers/workflow.js';

/**
 * `/kanban workflow …` as typed in chat (spec §21.6, §21.10): its verbs, and a
 * preview's or a start's pairs, with quotes, lists, @-mentions whose names hold
 * spaces, a pair split at its first `=`, and a stray word refused.
 */

const pairs = (text: string, mentions: readonly string[] = []) => {
  const r = parsePairs(text, mentions);
  if (!r.ok) throw new Error(r.usage);
  return r.pairs.map((p) => [p.key, p.value, p.quoted]);
};
const refused = (text: string, mentions: readonly string[] = []) => {
  const r = parsePairs(text, mentions);
  if (r.ok) throw new Error('the pairs were taken');
  return r.usage;
};

describe('/kanban workflow', () => {
  it('reads each verb', () => {
    expect(parseKanban('workflow list')).toEqual({ ok: true, command: { verb: 'workflow list' } });
    expect(parseKanban('workflow instances')).toEqual({ ok: true, command: { verb: 'workflow instances', all: false } });
    expect(parseKanban('workflow instances ALL')).toEqual({ ok: true, command: { verb: 'workflow instances', all: true } });
    expect(parseKanban('workflow show w_abc')).toEqual({ ok: true, command: { verb: 'workflow show', instanceId: 'w_abc' } });
    expect(parseKanban('workflow archive w_abc')).toEqual({ ok: true, command: { verb: 'workflow archive', instanceId: 'w_abc' } });
    expect(parseKanban('workflow preview vendor-eval topic=logs')).toEqual({
      ok: true,
      command: { verb: 'workflow preview', name: 'vendor-eval', pairs: [{ key: 'topic', value: 'logs', quoted: false }] },
    });
    expect(parseKanban('workflow start vendor-eval\ntopic="log storage"\nvendors=acme,globex')).toEqual({
      ok: true,
      command: {
        verb: 'workflow start',
        name: 'vendor-eval',
        pairs: [
          { key: 'topic', value: 'log storage', quoted: true },
          { key: 'vendors', value: 'acme,globex', quoted: false },
        ],
      },
    });
    expect(typed('workflow start')).toBe('/kanban workflow start');
  });

  it('lists its verbs with none or an unknown one, and gives the usage of a verb missing its argument', () => {
    const takes =
      '`/kanban workflow` takes `/kanban workflow list`, `/kanban workflow instances [all]`, `/kanban workflow show <instance>`, ' +
      '`/kanban workflow preview <name> key=value ...`, `/kanban workflow start <name> key=value ...`, `/kanban workflow archive <instance>`.';
    expect(parseKanban('workflow')).toEqual({ ok: false, usage: takes });
    expect(parseKanban('workflow run x')).toEqual({ ok: false, usage: takes });
    expect(parseKanban('workflow start')).toEqual({ ok: false, usage: 'Usage: `/kanban workflow start <name> key=value ...`' });
    expect(parseKanban('workflow show')).toEqual({ ok: false, usage: 'Usage: `/kanban workflow show <instance>`' });
    expect(parseKanban('workflow instances some')).toEqual({ ok: false, usage: 'Usage: `/kanban workflow instances [all]`' });
    expect(parseKanban('workflow list x')).toEqual({ ok: false, usage: 'Usage: `/kanban workflow list`' });
  });
});

describe('the pairs', () => {
  it('splits a pair at its first =, separated by spaces, tabs or line breaks', () => {
    expect(pairs('query=a=b\tnote=x\n\nempty=')).toEqual([
      ['query', 'a=b', false],
      ['note', 'x', false],
      ['empty', '', false],
    ]);
  });

  it('takes "…" and “…” as quotes, with no escape, a quoted value one item whatever its commas', () => {
    expect(pairs('vendors="Acme, Inc" vendors=globex')).toEqual([
      ['vendors', 'Acme, Inc', true],
      ['vendors', 'globex', false],
    ]);
    expect(pairs('topic=“log storage” note=”x y” other=”a"')).toEqual([
      ['topic', 'log storage', true],
      ['note', 'x y', true],
      ['other', 'a', true],
    ]);
    expect(refused('note=”')).toBe('The value of `note` opens a quote it does not close. Usage: `/kanban workflow start <name> key=value ...`');
    expect(pairs('topic="two\nlines"')).toEqual([['topic', 'two\nlines', true]]);
    expect(refused('topic="open')).toBe('The value of `topic` opens a quote it does not close. Usage: `/kanban workflow start <name> key=value ...`');
    expect(refused('topic="a"b')).toBe(
      'The quoted value of `topic` ends at its closing quote: put a space after it. Usage: `/kanban workflow start <name> key=value ...`',
    );
  });

  it('takes an @-mention whose name holds a space whole, the longest first, and leaves any other @ to the next space', () => {
    expect(pairs('owner=@Alice Smith note=x', ['Alice', 'Alice Smith'])).toEqual([
      ['owner', '@Alice Smith', false],
      ['note', 'x', false],
    ]);
    expect(pairs('owner=@Alice note=x', ['Alice', 'Alice Smith'])).toEqual([
      ['owner', '@Alice', false],
      ['note', 'x', false],
    ]);
    expect(refused('owner=@Bob Jones', ['Alice Smith'])).toMatch(/^`Jones` is not a `key=value` pair\./);
  });

  it('continues a list after a mention name and a comma, each item a mention or not', () => {
    const names = ['Alice Smith', 'Bob Jones'];
    expect(pairs('owners=@Alice Smith,@Bob Jones note=x', names)).toEqual([
      ['owners', '@Alice Smith,@Bob Jones', false],
      ['note', 'x', false],
    ]);
    expect(pairs('owners=@Alice Smith,worker,@Bob Jones', names)).toEqual([['owners', '@Alice Smith,worker,@Bob Jones', false]]);
    expect(pairs('owners=@Alice Smith,', names)).toEqual([['owners', '@Alice Smith,', false]]);
  });

  it('refuses a stray word with the usage, and with a hint after a value ending in a comma', () => {
    expect(refused('topic=logs please')).toBe('`please` is not a `key=value` pair. Usage: `/kanban workflow start <name> key=value ...`');
    expect(refused('vendors=acme, globex')).toBe(
      '`globex` is not a `key=value` pair. Leave no space after a list\'s commas, as `vendors=acme,globex`, or quote a value that holds spaces, as `topic="log storage"`. ' +
        'Usage: `/kanban workflow start <name> key=value ...`',
    );
    // The hint's examples do what it says: the list's two items, and the quoted value whole.
    const facts = { roles: new Map([['worker', role('worker')], ['reviewer', role('reviewer')]]), workspaces: new Set(['default']), supervisedRoles: false };
    const w = checkWorkflow('vendor-eval', VENDOR_EVAL, facts);
    if (!w.ok) throw new Error(w.problem);
    const given = parsePairs('vendors=acme,globex topic="log storage"', []);
    if (!given.ok) throw new Error(given.usage);
    const values = paramValues(w.workflow, { from: 'chat', pairs: given.pairs });
    if (!values.ok) throw new Error(values.message);
    expect(values.values.get('vendors')).toEqual(['acme', 'globex']);
    expect(values.values.get('topic')).toBe('log storage');
    expect(refused('Topic=x')).toBe('`Topic` is not a param name. Usage: `/kanban workflow start <name> key=value ...`');
    expect(parseKanban('workflow preview vendor-eval oops')).toEqual({
      ok: false,
      usage: '`oops` is not a `key=value` pair. Usage: `/kanban workflow preview <name> key=value ...`',
    });
  });
});
