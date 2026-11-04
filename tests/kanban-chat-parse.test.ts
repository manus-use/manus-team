import { describe, expect, it } from 'vitest';
import { parseKanban } from '../src/kanban/chat-parse.js';

/** `/kanban` as typed in chat (spec §9.1): what follows the command, parsed. */

describe('/kanban new', () => {
  it('takes the title from the first line, fields from labelled lines in any order, and the rest as the body', () => {
    const r = parseKanban(
      [
        'new  Write the release notes ',
        'assignee: docs-writer',
        'The notes cover 0.4.',
        'Workspace: docs',
        'parent: k_a, k_b',
        'parent: k_c',
        'outcome: notes merged',
        'verify: a reviewer reads them',
        'constraints: no marketing words',
        'boundaries: docs/ only',
        'stop when: the changelog is missing',
        '  outcome: an indented line stays body',
        'reviewer: reviewer',
      ].join('\n'),
    );
    expect(r).toEqual({
      ok: true,
      command: {
        verb: 'new',
        title: 'Write the release notes',
        body: 'The notes cover 0.4.\n  outcome: an indented line stays body',
        assignee: 'docs-writer',
        reviewer: 'reviewer',
        workspace: 'docs',
        parents: ['k_a', 'k_b', 'k_c'],
        contract: {
          outcome: 'notes merged',
          verification: 'a reviewer reads them',
          constraints: 'no marketing words',
          boundaries: 'docs/ only',
          stop_when: 'the changelog is missing',
        },
      },
    });
  });

  it('takes a title alone, and a title on the line after the verb', () => {
    expect(parseKanban('new Tidy the wiki')).toEqual({
      ok: true,
      command: { verb: 'new', title: 'Tidy the wiki', body: '', parents: [], contract: {} },
    });
    expect(parseKanban('NEW\nTidy the wiki\n\n\nWhat it is about.')).toMatchObject({
      ok: true,
      command: { title: 'Tidy the wiki', body: 'What it is about.' },
    });
  });

  it('reads a CRLF or a lone CR as a line break', () => {
    expect(parseKanban('new Notes\r\nassignee: docs-writer\rThe body.')).toMatchObject({
      ok: true,
      command: { title: 'Notes', assignee: 'docs-writer', body: 'The body.' },
    });
  });

  it('refuses no title, a field line where the title goes, a field given twice, and a field with no value', () => {
    expect(parseKanban('new')).toMatchObject({ ok: false, usage: expect.stringContaining('Put the title on the first line') });
    expect(parseKanban('new\nassignee: docs-writer\nWrite it')).toMatchObject({
      ok: false,
      usage: expect.stringContaining('The first line is the title, before any field line.'),
    });
    expect(parseKanban('new t\nassignee: a\nassignee: b')).toEqual({ ok: false, usage: '`assignee:` is given twice.' });
    expect(parseKanban('new t\nverify:')).toEqual({ ok: false, usage: '`verify:` needs a value.' });
  });
});

describe('the other /kanban commands', () => {
  it('parses each, with its task ids and text', () => {
    expect(parseKanban('')).toEqual({ ok: true, command: { verb: 'help' } });
    expect(parseKanban('help')).toEqual({ ok: true, command: { verb: 'help' } });
    expect(parseKanban('list')).toEqual({ ok: true, command: { verb: 'list', filter: undefined } });
    expect(parseKanban('list Blocked')).toEqual({ ok: true, command: { verb: 'list', filter: 'blocked' } });
    expect(parseKanban('list all')).toEqual({ ok: true, command: { verb: 'list', filter: 'all' } });
    expect(parseKanban('show k_1')).toEqual({ ok: true, command: { verb: 'show', taskId: 'k_1' } });
    expect(parseKanban('stop k_1')).toEqual({ ok: true, command: { verb: 'stop', taskId: 'k_1' } });
    expect(parseKanban('archive k_1')).toEqual({ ok: true, command: { verb: 'archive', taskId: 'k_1' } });
    expect(parseKanban('assign k_1 reviewer')).toEqual({
      ok: true,
      command: { verb: 'assign', taskId: 'k_1', assignee: 'reviewer' },
    });
    // A person, whose name may hold a space, is kept whole for the refusal that says it arrives later.
    expect(parseKanban('assign k_1 @Alice Smith')).toEqual({
      ok: true,
      command: { verb: 'assign', taskId: 'k_1', assignee: '@Alice Smith' },
    });
    expect(parseKanban('link k_1 k_2')).toEqual({ ok: true, command: { verb: 'link', parentId: 'k_1', childId: 'k_2' } });
    expect(parseKanban('workspace k_1 docs')).toEqual({
      ok: true,
      command: { verb: 'workspace', taskId: 'k_1', workspace: 'docs' },
    });
    expect(parseKanban('comment k_1 use the 2024 numbers\nnot 2023')).toEqual({
      ok: true,
      command: { verb: 'comment', taskId: 'k_1', text: 'use the 2024 numbers\nnot 2023' },
    });
    expect(parseKanban('unblock k_1')).toEqual({ ok: true, command: { verb: 'unblock', taskId: 'k_1', comment: undefined } });
    expect(parseKanban('unblock k_1 the key is in the vault now')).toEqual({
      ok: true,
      command: { verb: 'unblock', taskId: 'k_1', comment: 'the key is in the vault now' },
    });
  });

  it('keeps a gate command as written, after an optional timeout', () => {
    expect(parseKanban("gate add k_1 test -f notes.md && grep -q '0.4' notes.md")).toEqual({
      ok: true,
      command: { verb: 'gate add', taskId: 'k_1', command: "test -f notes.md && grep -q '0.4' notes.md", timeoutS: undefined },
    });
    expect(parseKanban('gate add k_1 --timeout 60 curl -fsS https://example.invalid/health')).toEqual({
      ok: true,
      command: { verb: 'gate add', taskId: 'k_1', command: 'curl -fsS https://example.invalid/health', timeoutS: 60 },
    });
    expect(parseKanban('gate list k_1')).toEqual({ ok: true, command: { verb: 'gate list', taskId: 'k_1' } });
    expect(parseKanban('gate remove k_1 3')).toEqual({ ok: true, command: { verb: 'gate remove', taskId: 'k_1', gateId: 3 } });
  });

  it("names the people's commands, which arrive in a later update", () => {
    for (const name of ['done', 'block', 'review', 'approve', 'changes']) {
      expect(parseKanban(`${name} k_1 looks good`)).toEqual({ ok: true, command: { verb: 'later', name } });
    }
  });

  it('answers a wrong command line with its usage, and an unknown one escaped', () => {
    for (const text of [
      'show',
      'show k_1 k_2',
      'assign k_1',
      'link k_1',
      'workspace k_1',
      'comment k_1',
      'unblock',
      'list soon',
      'list ready now',
      'gate',
      'gate add k_1',
      'gate add k_1 --timeout 0 true',
      'gate add k_1 --timeout x true',
      'gate remove k_1 one',
      'gate remove k_1 0',
    ]) {
      expect([text, parseKanban(text)]).toEqual([text, { ok: false, usage: expect.stringMatching(/^Usage: `\/kanban /) }]);
    }
    expect(parseKanban('frob_nicate k_1')).toEqual({
      ok: false,
      usage: 'Unknown `/kanban` command `frob\\_nicate`. `/kanban help` lists them.',
    });
  });
});
